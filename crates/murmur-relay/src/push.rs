//! Web Push delivery (VAPID) for PWA clients.
//!
//! ## Architecture
//!
//! ```text
//! ┌──────────────┐  POST /push/register_subscribe  ┌─────────────────┐
//! │ PWA (phone)  │ ───────────────────────────────► │                 │
//! │              │  { alias, subscription_json }   │  murmur-relay   │
//! │              │ ◄────────────────────────────── │  (VPS)          │
//! │              │  200 OK { ok: true }            │                 │
//! └──────────────┘                                 │                 │
//!                                                  │                 │
//! ┌──────────────┐   iroh-direct envelope          │                 │
//! │ murmur       │ ───────────────────────────────►│                 │
//! │ sender (HP)  │                                 │                 │
//! └──────────────┘                                 │                 │
//!                                                  │                 │
//!                                                  │ on envelope:    │
//!                                                  │  - persist      │
//!                                                  │  - WS fanout    │
//!                                                  │  - Web Push ────┼──► push service
//!                                                  │    (web-push)   │     (FCM/APNS)
//!                                                  └─────────────────┘
//! ```
//!
//! ## Files
//!
//! - `<home>/vapid_keys.json` — server's VAPID keypair (created lazily on first
//!   start, persists across restarts).
//! - `<home>/subscriptions.json` — list of `PushSubscription` records, keyed by
//!   random UUID. Each record binds an alias to a push endpoint (FCM/APNS/etc).
//!
//! ## Privacy
//!
//! - The relay needs only the **push endpoint URL** (FCM/APNS) and the
//!   per-subscription ECDH keys. It does NOT need to know the user's email
//!   or any PII.
//! - VAPID identifies the relay (the operator) to push services, not the user.
//!
//! ## Auth
//!
//! For MVP-01 there's no auth on `POST /push/register_subscribe`. The push
//! subscripton is treated as a bearer credential — whoever presents it can
//! receive push for that alias. This is OK for an MVP we'll harden later.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::{info, warn};
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, Urgency, VapidSignatureBuilder,
    WebPushClient, WebPushError, WebPushMessageBuilder,
};
use hyper::{StatusCode, body::Bytes, body::Incoming, server::conn::http1, service::service_fn, Method, Request, Response};
use hyper_util::rt::TokioIo;
use http_body_util::{BodyExt, Full};
use serde_json::Value as JsonValue;
use base64::Engine;
use jwt_simple::prelude::{ES256KeyPair, ECDSAP256PublicKeyLike};

/// Server-owned VAPID keypair. Persisted to disk on first generation.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VapidKeys {
    /// The 32-byte private key (as base64url). Used to sign VAPID auth.
    pub private_b64url: String,
    /// The 32-byte public key (raw bytes, base64url).
    pub public_b64url: String,
    /// Subject — typically "mailto:admin@example.com" or "https://example.com/contact".
    pub subject: String,
}

impl VapidKeys {
    /// Load from `<home>/vapid_keys.json` or generate fresh ones.
    pub fn load_or_generate(home: &Path, subject: String) -> anyhow::Result<Self> {
        let path = home.join("vapid_keys.json");
        if path.exists() {
            let text = std::fs::read_to_string(&path)?;
            let k: Self = serde_json::from_str(&text)?;
            return Ok(k);
        }

        // Generate via jwt-simple's ES256KeyPair.
        let key_pair = ES256KeyPair::generate();
        let pem = key_pair.to_pem()?;

        // Derive uncompressed public key (64 bytes) for the client.
        let uncompressed = key_pair.public_key().public_key().to_bytes_uncompressed();
        let public_uncompressed = if uncompressed.len() == 65 {
            &uncompressed[1..] // strip 0x04 prefix
        } else {
            &uncompressed[..]
        };

        let private_b64url = base64_url_encode(pem.as_bytes());
        let public_b64url = base64_url_encode(public_uncompressed);

        let k = VapidKeys {
            private_b64url,
            public_b64url,
            subject,
        };
        std::fs::write(&path, serde_json::to_string_pretty(&k)?)?;
        info!(path = %path.display(), "generated new VAPID keys");
        Ok(k)
    }

    /// Build a `VapidSignature` for an endpoint URL.
    pub fn sign(&self, _endpoint: &str, sub_info: &SubscriptionInfo) -> anyhow::Result<web_push::VapidSignature> {
        let pem_bytes = base64_url_decode(&self.private_b64url)?;
        let pem = std::str::from_utf8(&pem_bytes)?;
        let partial = VapidSignatureBuilder::from_pem_no_sub(pem.as_bytes())?;
        let mut builder = partial.add_sub_info(sub_info);
        builder.add_claim("sub", self.subject.as_str());
        let sig = builder.build()?;
        Ok(sig)
    }

    pub fn public_b64url(&self) -> &str {
        &self.public_b64url
    }
}

/// A registered push subscription: an alias + a `SubscriptionInfo` from the browser.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushSubscription {
    pub id: String, // UUID
    pub alias: String,
    pub endpoint: String,
    pub p256dh_b64url: String,
    pub auth_b64url: String,
    /// Server timestamp (ISO 8601) of registration.
    pub registered_at: String,
}

impl PushSubscription {
    /// Build a `SubscriptionInfo` (web-push type) for VAPID signing + POST.
    pub fn to_info(&self) -> anyhow::Result<SubscriptionInfo> {
        // web-push's SubscriptionInfo takes the raw base64url strings as-is,
        // so we don't even need to decode them.
        Ok(SubscriptionInfo::new(
            self.endpoint.clone(),
            self.p256dh_b64url.clone(),
            self.auth_b64url.clone(),
        ))
    }
}

/// On-disk persistent store of subscriptions.
pub struct PushStore {
    path: PathBuf,
    inner: Arc<Mutex<HashMap<String, PushSubscription>>>,
}

impl PushStore {
    pub fn new(home: &Path) -> anyhow::Result<Self> {
        let path = home.join("subscriptions.json");
        let inner: HashMap<String, PushSubscription> = if path.exists() {
            let text = std::fs::read_to_string(&path)?;
            serde_json::from_str(&text).unwrap_or_default()
        } else {
            HashMap::new()
        };
        Ok(Self {
            path,
            inner: Arc::new(Mutex::new(inner)),
        })
    }

    pub fn insert(&self, sub: PushSubscription) -> anyhow::Result<()> {
        let mut g = self.inner.lock();
        g.insert(sub.id.clone(), sub);
        self.persist_locked(&g)
    }

    pub fn delete(&self, id: &str) -> anyhow::Result<()> {
        let mut g = self.inner.lock();
        g.remove(id);
        self.persist_locked(&g)
    }

    pub fn for_alias(&self, alias: &str) -> Vec<PushSubscription> {
        let g = self.inner.lock();
        g.values().filter(|s| s.alias == alias).cloned().collect()
    }

    pub fn count(&self) -> usize {
        self.inner.lock().len()
    }

    fn persist_locked(&self, g: &HashMap<String, PushSubscription>) -> anyhow::Result<()> {
        let text = serde_json::to_string_pretty(g)?;
        std::fs::write(&self.path, text)?;
        Ok(())
    }

    /// Cheap clone for sharing across async tasks.
    pub fn clone_handle(&self) -> Self {
        Self {
            path: self.path.clone(),
            inner: self.inner.clone(),
        }
    }
}

/// The payload we send as a push notification.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushPayload {
    pub alias: String,
    pub from_npub: String,
    pub ts: u64,
    pub envelope_hash_hex: String,
    pub title: String,
    pub body: String,
}

impl PushPayload {
    pub fn from_entry(entry: &crate::pending::PendingEntry) -> Self {
        let body = format!(
            "new encrypted message ({} bytes)",
            entry.envelope_bytes.len()
        );
        Self {
            alias: entry.to_alias.clone(),
            from_npub: entry.from_npub.clone(),
            ts: entry.ts,
            envelope_hash_hex: entry.envelope_hash_hex.clone(),
            title: format!("murmur: {}", entry.to_alias),
            body,
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }
}

/// HTTP server that accepts push-subscriptions + delivers pushes on envelope receive.
pub struct PushServer {
    bind: String,
    pub store: PushStore,
    vapid: VapidKeys,
    delivered: Arc<Mutex<u64>>,
}

impl PushServer {
    pub fn new(home: &Path, bind: String, vapid: VapidKeys) -> anyhow::Result<Self> {
        let store = PushStore::new(home)?;
        Ok(Self {
            bind,
            store,
            vapid,
            delivered: Arc::new(Mutex::new(0)),
        })
    }

    pub fn vapid_public_b64url(&self) -> &str {
        self.vapid.public_b64url()
    }

    /// Deliver a push payload to all registered subscriptions for the alias.
    pub async fn deliver(&self, payload: &PushPayload) -> anyhow::Result<usize> {
        let subs = self.store.for_alias(&payload.alias);
        if subs.is_empty() {
            return Ok(0);
        }
        let client = IsahcWebPushClient::new()?;
        let body = payload.to_json();
        let mut delivered = 0usize;
        for sub in subs {
            let info = match sub.to_info() {
                Ok(i) => i,
                Err(e) => {
                    warn!(err=%e, sub=%sub.id, "bad subscription info, skipping");
                    continue;
                }
            };
            let sig = match self.vapid.sign(&sub.endpoint, &info) {
                Ok(s) => s,
                Err(e) => {
                    warn!(err=%e, sub=%sub.id, "VAPID sign failed");
                    continue;
                }
            };
            let mut builder = WebPushMessageBuilder::new(&info);
            builder.set_payload(ContentEncoding::Aes128Gcm, body.as_bytes());
            builder.set_vapid_signature(sig);
            builder.set_ttl(60 * 60); // 1 hour
            builder.set_urgency(Urgency::Normal);
            let msg = builder.build()?;
            match client.send(msg).await {
                Ok(_) => {
                    delivered += 1;
                    info!(sub=%sub.id, alias=%payload.alias, "push delivered");
                }
                Err(WebPushError::EndpointNotFound) | Err(WebPushError::EndpointNotValid) => {
                    warn!(sub=%sub.id, "endpoint gone, removing");
                    let _ = self.store.delete(&sub.id);
                }
                Err(e) => {
                    warn!(err=%e, sub=%sub.id, "push delivery failed");
                }
            }
        }
        *self.delivered.lock() += delivered as u64;
        Ok(delivered)
    }

    /// Run the HTTP server forever.
    pub async fn serve(&self) -> anyhow::Result<()> {
        let listener = tokio::net::TcpListener::bind(&self.bind).await?;
        info!(bind = %self.bind, "push HTTP server listening");
        loop {
            let (stream, _addr) = listener.accept().await?;
            let io = TokioIo::new(stream);
            let store = self.store.clone_handle();
            let vapid_pub = self.vapid.public_b64url().to_string();
            tokio::spawn(async move {
                let svc = service_fn(move |req: Request<Incoming>| {
                    let store = store.clone_handle();
                    let vapid_pub = vapid_pub.clone();
                    async move {
                        let method = req.method().clone();
                        let path = req.uri().path().to_string();
                        match (method, path.as_str()) {
                            (Method::GET, "/healthz") => Ok::<_, std::convert::Infallible>(
                                Response::builder()
                                    .status(StatusCode::OK)
                                    .header("content-type", "text/plain")
                                    .body(Full::new(Bytes::from("ok")))
                                    .unwrap(),
                            ),
                            (Method::GET, "/vapid_public_key") => Ok(
                                Response::builder()
                                    .status(StatusCode::OK)
                                    .header("content-type", "text/plain")
                                    .header("access-control-allow-origin", "*")
                                    .body(Full::new(Bytes::from(vapid_pub)))
                                    .unwrap(),
                            ),
                            (Method::POST, "/push/register_subscribe") => {
                                handle_register_subscribe(req, store).await
                            }
                            (Method::POST, "/push/unsubscribe") => {
                                handle_unsubscribe(req, store).await
                            }
                            _ => Ok(
                                Response::builder()
                                    .status(StatusCode::NOT_FOUND)
                                    .body(Full::new(Bytes::from("not found")))
                                    .unwrap(),
                            ),
                        }
                    }
                });
                let _ = http1::Builder::new()
                    .serve_connection(io, svc)
                    .await;
            });
        }
    }
}

async fn handle_register_subscribe(
    req: Request<Incoming>,
    store: PushStore,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let body = req.collect().await.unwrap().to_bytes();
    let json: JsonValue = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return Ok(json_error(StatusCode::BAD_REQUEST, &format!("bad json: {e}")));
        }
    };
    let alias = match json.get("alias").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Ok(json_error(StatusCode::BAD_REQUEST, "missing alias")),
    };
    let sub = match json.get("subscription") {
        Some(v) => v,
        None => return Ok(json_error(StatusCode::BAD_REQUEST, "missing subscription")),
    };
    let endpoint = match sub.get("endpoint").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Ok(json_error(StatusCode::BAD_REQUEST, "missing endpoint")),
    };
    let keys = match sub.get("keys") {
        Some(v) => v,
        None => return Ok(json_error(StatusCode::BAD_REQUEST, "missing keys")),
    };
    let p256dh_b64url = match keys.get("p256dh").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Ok(json_error(StatusCode::BAD_REQUEST, "missing p256dh")),
    };
    let auth_b64url = match keys.get("auth").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Ok(json_error(StatusCode::BAD_REQUEST, "missing auth")),
    };

    let entry = PushSubscription {
        id: uuid::Uuid::new_v4().to_string(),
        alias,
        endpoint,
        p256dh_b64url,
        auth_b64url,
        registered_at: chrono::Utc::now().to_rfc3339(),
    };
    let id = entry.id.clone();
    if let Err(e) = store.insert(entry) {
        return Ok(json_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("store: {e}")));
    }
    let body = serde_json::json!({ "ok": true, "id": id }).to_string();
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .body(Full::new(Bytes::from(body)))
        .unwrap())
}

async fn handle_unsubscribe(
    req: Request<Incoming>,
    store: PushStore,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let body = req.collect().await.unwrap().to_bytes();
    let json: JsonValue = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => {
            return Ok(json_error(StatusCode::BAD_REQUEST, &format!("bad json: {e}")));
        }
    };
    let id = match json.get("id").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => return Ok(json_error(StatusCode::BAD_REQUEST, "missing id")),
    };
    if let Err(e) = store.delete(&id) {
        return Ok(json_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("store: {e}")));
    }
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .body(Full::new(Bytes::from(r#"{"ok":true}"#)))
        .unwrap())
}

fn json_error(status: StatusCode, msg: &str) -> Response<Full<Bytes>> {
    let body = serde_json::json!({ "ok": false, "error": msg }).to_string();
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .body(Full::new(Bytes::from(body)))
        .unwrap()
}

// --- base64url helpers (no padding) ---

fn base64_url_encode(bytes: &[u8]) -> String {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    URL_SAFE_NO_PAD.encode(bytes)
}

fn base64_url_decode(s: &str) -> anyhow::Result<Vec<u8>> {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| anyhow::anyhow!("base64url decode: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("murmur-push-test-{}-{}", std::process::id(), name));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn base64url_roundtrip() {
        let bytes = [42u8; 32];
        let s = base64_url_encode(&bytes);
        let back = base64_url_decode(&s).unwrap();
        assert_eq!(back, bytes);
    }

    #[test]
    fn push_store_insert_delete() {
        let home = tmp("s1").join("s1");
        std::fs::create_dir_all(&home).unwrap();
        let store = PushStore::new(&home).unwrap();
        let sub = PushSubscription {
            id: "abc".into(),
            alias: "oleg-hp".into(),
            endpoint: "https://fcm.googleapis.com/fcm/send/123".into(),
            p256dh_b64url: "BNcRdreALRFXTkOOUHK1EtD2".into(),
            auth_b64url: "tBHItJI5svbV7qUbM".into(),
            registered_at: chrono::Utc::now().to_rfc3339(),
        };
        store.insert(sub.clone()).unwrap();
        let for_alias = store.for_alias("oleg-hp");
        assert_eq!(for_alias.len(), 1);
        assert_eq!(for_alias[0].id, "abc");
        store.delete("abc").unwrap();
        assert_eq!(store.count(), 0);
    }

    #[test]
    fn push_payload_serde() {
        let p = PushPayload {
            alias: "oleg-hp".into(),
            from_npub: "npub1abc".into(),
            ts: 1700000000,
            envelope_hash_hex: "deadbeef".into(),
            title: "murmur: oleg-hp".into(),
            body: "new encrypted message (210 bytes)".into(),
        };
        let s = p.to_json();
        let back: PushPayload = serde_json::from_str(&s).unwrap();
        assert_eq!(back.alias, "oleg-hp");
    }

    #[test]
    fn vapid_load_or_generate_persists() {
        let home = tmp("v1").join("v1");
        std::fs::create_dir_all(&home).unwrap();
        let k1 = VapidKeys::load_or_generate(&home, "mailto:test@example.com".into()).unwrap();
        let k2 = VapidKeys::load_or_generate(&home, "mailto:test@example.com".into()).unwrap();
        assert_eq!(k1.private_b64url, k2.private_b64url);
        assert_eq!(k1.public_b64url, k2.public_b64url);
        // public key must be 64 bytes (32 X + 32 Y) -> 86 base64url chars (no padding)
        let pub_bytes = base64_url_decode(&k1.public_b64url).unwrap();
        assert_eq!(pub_bytes.len(), 64);
    }

    #[test]
    fn vapid_sign_produces_signature() {
        let home = tmp("v2").join("v2");
        std::fs::create_dir_all(&home).unwrap();
        let k = VapidKeys::load_or_generate(&home, "mailto:test@example.com".into()).unwrap();
        let info = SubscriptionInfo::new(
            "https://fcm.googleapis.com/fcm/send/abc123",
            "BNcRdreALRFXTkOOUHK1EtD2",
            "tBHItJI5svbV7qUbM",
        );
        let sig = k.sign("https://fcm.googleapis.com/fcm/send/abc123", &info).unwrap();
        // auth_t is the signed JWT (header.payload.signature) — must be non-empty
        // and contain at least 2 dots (3 JWT parts).
        assert!(!sig.auth_t.is_empty(), "VAPID token should not be empty");
        assert!(sig.auth_t.split('.').count() >= 3, "should be a JWT with 3 parts");
        // auth_k is the public key (65 bytes uncompressed with 0x04 prefix).
        assert_eq!(sig.auth_k.len(), 65);
    }
}
