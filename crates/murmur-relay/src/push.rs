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
use base64::engine::general_purpose::STANDARD as BASE64;

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

        // Derive uncompressed public key (SEC1: 0x04 || X || Y, 65 bytes).
        // Per RFC 8292 (VAPID) the public key is sent in uncompressed SEC1 form.
        let public_uncompressed = key_pair.public_key().public_key().to_bytes_uncompressed();

        let private_b64url = base64_url_encode(pem.as_bytes());
        let public_b64url = base64_url_encode(&public_uncompressed);

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

    /// Insert (or replace) a subscription by its endpoint URL. If a record
    /// already exists with the same endpoint, it is removed first and the
    /// new one takes its place — otherwise repeated "tap to subscribe"
    /// retries pile up duplicate records (Lesson #131.12).
    pub fn upsert_by_endpoint(&self, sub: PushSubscription) -> anyhow::Result<()> {
        let mut g = self.inner.lock();
        g.retain(|_, existing| existing.endpoint != sub.endpoint);
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
    /// Recipient npub (routing key). Kept the field name `alias` in the JSON
    /// so existing client SW code stays compatible.
    pub alias: String,
    pub from_npub: String,
    pub ts: u64,
    pub envelope_hash_hex: String,
    /// Short app-style title (e.g. "Murmur"). On iOS this becomes the bold top
    /// line of the notification. We intentionally keep it short and app-y, not
    /// the sender name — sender goes into `subtitle`.
    pub title: String,
    /// Subtitle slot on iOS (= sender alias, e.g. "Ирина"). Setting this stops
    /// iOS from auto-injecting "from murmur" between title and body. Other
    /// platforms ignore the field.
    pub subtitle: String,
    pub body: String,
}

impl PushPayload {
    /// Build payload from a pending envelope entry.
    ///
    /// v149: npub-only. Sender display names живут на устройстве получателя
    /// (from_name в зашифрованном payload), поэтому push всегда показывает
    /// нейтральное "Murmur" + generic body. Никакого alias-resolve — на ролее
    /// нет таблицы имён.
    ///
    /// The body is intentionally generic — relay never sees plaintext (end-to-end
    /// encryption), so we cannot show the message text here. Client decrypts
    /// when user opens the chat.
    pub fn from_entry(entry: &crate::pending::PendingEntry, _store: Option<&crate::storage::MessageStore>) -> Self {
        Self {
            alias: entry.to_npub.clone(),
            from_npub: entry.from_npub.clone(),
            ts: entry.ts,
            envelope_hash_hex: entry.envelope_hash_hex.clone(),
            // "Murmur" == manifest.name → iOS не вставляет auto-line
            // "from murmur" (Олег 2026-08-24 11:55 MSK). С реальными именами
            // отправителя на ролее больше не работаем (npub-only).
            title: "Murmur".to_string(),
            subtitle: short_npub(&entry.from_npub),
            // Body is intentionally generic — relay never sees plaintext
            // (end-to-end encryption), so we cannot show the message text.
            // We phrase it as an action ("Откройте, чтобы прочитать") so iOS
            // Web Push does NOT prepend "from murmur" (which it does for
            // very short bodies that look like notifications from the app
            // itself).
            body: "Откройте murmur, чтобы прочитать сообщение".to_string(),
        }
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string())
    }

    /// Public, JSON-friendly value (used over WebSocket).
    pub fn to_json_value(&self) -> serde_json::Value {
        serde_json::to_value(self).unwrap_or(serde_json::json!({}))
    }
}

/// HTTP server that accepts push-subscriptions + delivers pushes on envelope receive.
pub struct PushServer {
    bind: String,
    pub store: PushStore,
    pub vapid: VapidKeys,
    delivered: Arc<Mutex<u64>>,
    static_dir: Option<PathBuf>,
    /// Pending store (shared with iroh + ws server). Set after construction
    /// via `with_pending_hub` once the relay wires everything together.
    pub(crate) pending: crate::PendingStore,
    pub(crate) hub: crate::SubscriberHub,
    /// SQLite message store (contacts, history, unread).
    pub(crate) store_db: Option<crate::storage::MessageStore>,
}

impl Clone for PushServer {
    fn clone(&self) -> Self {
        Self {
            bind: self.bind.clone(),
            store: self.store.clone_handle(),
            vapid: self.vapid.clone(),
            delivered: Arc::clone(&self.delivered),
            static_dir: self.static_dir.clone(),
            pending: self.pending.clone(),
            hub: self.hub.clone(),
            store_db: self.store_db.clone(),
        }
    }
}

impl PushServer {
    pub fn new(home: &Path, bind: String, vapid: VapidKeys) -> anyhow::Result<Self> {
        let store = PushStore::new(home)?;
        let home_dir = home.to_path_buf();
        let db_path = home_dir.join("messages.db");
        let db = crate::storage::MessageStore::new(&db_path).map_err(|e| {
            anyhow::anyhow!("failed to open message store: {}", e)
        })?;
        Ok(Self {
            bind,
            store,
            vapid,
            delivered: Arc::new(Mutex::new(0)),
            static_dir: None,
            pending: crate::PendingStore::new(&home_dir)?,
            hub: crate::SubscriberHub::new(),
            store_db: Some(db),
        })
    }

    pub fn with_static_dir(mut self, dir: Option<PathBuf>) -> Self {
        self.static_dir = dir;
        self
    }

    /// Wire the pending store + subscriber hub so this HTTP server can accept
    /// `POST /envelope` and broadcast through the same path as iroh-direct.
    pub fn with_pending_hub(
        mut self,
        pending: crate::PendingStore,
        hub: crate::SubscriberHub,
    ) -> Self {
        self.pending = pending;
        self.hub = hub;
        self
    }

    pub fn vapid_public_b64url(&self) -> &str {
        self.vapid.public_b64url()
    }

    /// Deliver a push payload to all registered subscriptions for the npub.
    ///
    /// v149: npub-only — direct match by `alias == npub` (поля JSON осталось
    /// `alias` для совместимости с SW). Никаких sibling-алиасов.
    pub async fn deliver(&self, payload: &PushPayload) -> anyhow::Result<usize> {
        let mut subs = self.store.for_alias(&payload.alias);
        if subs.is_empty() {
            return Ok(0);
        }
        // Safety net: endpoint can appear twice if the user has multiple
        // registrations against the same browser instance (see 3-4 duplicate
        // push records after several "tap to subscribe" retries —
        // Lesson #131.12). Dedup by endpoint before sending.
        let mut seen_endpoints: std::collections::HashSet<String> = std::collections::HashSet::new();
        subs.retain(|s| seen_endpoints.insert(s.endpoint.clone()));
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
    pub async fn serve(self) -> anyhow::Result<()> {
        let listener = tokio::net::TcpListener::bind(&self.bind).await?;
        info!(bind = %self.bind, "push HTTP server listening");
        let store_db = self.store_db.clone();
        let static_dir = self.static_dir.clone();
        let pending = self.pending.clone();
        let hub = self.hub.clone();
        let push_self = Arc::new(self);
        loop {
            let (stream, _addr) = listener.accept().await?;
            let io = TokioIo::new(stream);
            let store = push_self.store.clone_handle();
            let vapid_pub = push_self.vapid.public_b64url().to_string();
            let static_dir = static_dir.clone();
            let pending = pending.clone();
            let hub = hub.clone();
            let push_arc = Arc::clone(&push_self);
            let db_for_handle = store_db.clone();
            tokio::spawn(async move {
                let svc = service_fn(move |req: Request<Incoming>| {
                    let store = store.clone_handle();
                    let vapid_pub = vapid_pub.clone();
                    let static_dir = static_dir.clone();
                    let pending = pending.clone();
                    let hub = hub.clone();
                    let push_self = Arc::clone(&push_arc);
                    let db = db_for_handle.clone();
                    async move {
                        let method = req.method().clone();
                        let path = req.uri().path().to_string();
                        match (method.clone(), path.as_str()) {
                            (Method::GET, "/healthz") => Ok::<_, std::convert::Infallible>(
                                Response::builder()
                                    .status(StatusCode::OK)
                                    .header("content-type", "text/plain")
                                    .body(Full::new(Bytes::from("ok")))
                                    .unwrap(),
                            ),
                            (Method::OPTIONS, _) => Ok(
                                Response::builder()
                                    .status(StatusCode::NO_CONTENT)
                                    .header("access-control-allow-origin", "*")
                                    .header("access-control-allow-methods", "GET, POST, OPTIONS")
                                    .header("access-control-allow-headers", "content-type")
                                    .body(Full::new(Bytes::new()))
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
                            (Method::GET, "/api/contacts") => {
                                handle_api_contacts(req, db.clone()).await
                            }
                            // v160f: манифест с start_url?invite=... — iOS запоминает его
                            // в момент «На экран Домой» → PWA стартует сразу с чатом.
                            (Method::GET, "/manifest.json") => {
                                handle_manifest(req, &static_dir).await
                            }
                            (Method::GET, "/api/history") => {
                                handle_api_history(req, db.clone()).await
                            }
                            (Method::POST, "/push/register_subscribe") => {
                                handle_register_subscribe(req, store.clone_handle()).await
                            }
                            (Method::GET, "/push/status") => {
                                handle_push_status(req, store.clone_handle(), db.clone()).await
                            }
                            (Method::POST, "/push/unsubscribe") => {
                                handle_unsubscribe(req, store).await
                            }
                            (Method::POST, "/envelope") => {
                                let push: &PushServer = &push_self;
                                handle_post_envelope(req, pending.clone(), hub.clone(), push, db.clone()).await
                            }
                            (Method::POST, "/api/upload") => {
                                handle_api_upload(req, db.clone(), pending.clone()).await
                            }
                            // v160f: identity transfer (перенос личности Safari → PWA)
                            (Method::POST, "/api/transfer/create") => {
                                handle_transfer_create(req, db.clone()).await
                            }
                            (Method::POST, "/api/transfer/redeem") => {
                                handle_transfer_redeem(req, db.clone()).await
                            }
                            (Method::GET, path) if path.starts_with("/api/blob/") => {
                                handle_api_blob_download(req, db.clone()).await
                            }
                            (Method::GET | Method::HEAD, _) => {
                                if let Some(resp) = serve_static(&path, &static_dir, method == Method::HEAD) {
                                    Ok(resp)
                                } else {
                                    Ok(
                                        Response::builder()
                                            .status(StatusCode::NOT_FOUND)
                                            .body(Full::new(Bytes::from("not found")))
                                            .unwrap(),
                                    )
                                }
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

/// Try to serve a static file from `static_dir`. Returns `None` if no static
/// dir is configured or the file does not exist (or the path is unsafe).
fn serve_static(path: &str, static_dir: &Option<PathBuf>, head_only: bool) -> Option<Response<Full<Bytes>>> {
    let dir = static_dir.as_ref()?;
    if !dir.is_dir() {
        return None;
    }
    // Strip query string if any (hyper already separated, but be safe).
    let clean = path.split('?').next().unwrap_or(path);
    // Resolve to a relative path under dir, no leading slash.
    let rel = clean.trim_start_matches('/');
    if rel.is_empty() {
        // "/" -> index.html
        return try_file(dir, "index.html", head_only);
    }
    // Reject path traversal attempts.
    if rel.contains("..") {
        return None;
    }
    let candidate = dir.join(rel);
    if candidate.is_file() {
        return serve_file(&candidate, head_only);
    }
    // SPA fallback: if path doesn't end in a file extension and the dir
    // has an index.html, serve that. (Keeps PWA UX simple.)
    if !rel.contains('.') {
        return try_file(dir, "index.html", head_only);
    }
    None
}

fn try_file(dir: &Path, name: &str, head_only: bool) -> Option<Response<Full<Bytes>>> {
    let p = dir.join(name);
    if p.is_file() { serve_file(&p, head_only) } else { None }
}

fn serve_file(path: &Path, head_only: bool) -> Option<Response<Full<Bytes>>> {
    let bytes = std::fs::read(path).ok()?;
    let body = if head_only { Full::new(Bytes::new()) } else { Full::new(Bytes::from(bytes)) };
    let mime = mime_from_ext(path.extension().and_then(|s| s.to_str()).unwrap_or(""));
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("");
    // HTML/JS/CSS: must-revalidate to bypass Cloudflare edge cache.
    // WASM/icons: immutable, can cache.
    let cc = if matches!(ext, "html" | "htm" | "js" | "mjs" | "css" | "json" | "webmanifest") {
        "no-cache, no-store, must-revalidate"
    } else {
        "public, max-age=86400"
    };
    Some(
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", mime)
            .header("cache-control", cc)
            .header("access-control-allow-origin", "*")
            .header("cross-origin-embedder-policy", "require-corp")
            .header("cross-origin-resource-policy", "cross-origin")
            .body(body)
            .unwrap(),
    )
}

/// Shorten an npub for display in push notifications: `npub1abc…xyz`.
/// If the string is already short (<16 chars), return it as-is.
fn short_npub(npub: &str) -> String {
    if npub.len() <= 16 {
        return npub.to_string();
    }
    let head = &npub[..12];
    let tail = &npub[npub.len() - 4..];
    format!("{head}…{tail}")
}

fn mime_from_ext(ext: &str) -> &'static str {
    match ext.to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "application/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "webmanifest" => "application/manifest+json",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "wasm" => "application/wasm",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
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
    // v149: npub-only. Prefer `npub` key; legacy `alias` key accepted for one
    // release (PWA sends alias = npub anyway).
    let alias = match json
        .get("npub")
        .and_then(|v| v.as_str())
        .or_else(|| json.get("alias").and_then(|v| v.as_str()))
    {
        Some(s) => s.to_string(),
        None => return Ok(json_error(StatusCode::BAD_REQUEST, "missing npub")),
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
    if let Err(e) = store.upsert_by_endpoint(entry) {
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

async fn handle_push_status(
    req: Request<Incoming>,
    store: PushStore,
    _db: Option<crate::storage::MessageStore>,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let uri = req.uri().to_string();
    // Parse `?alias=...` (значение = npub; имя параметра оставлено для
    // совместимости с клиентом) or `?npub=...` — both work in v149.
    let qs = uri.split('?').nth(1).unwrap_or_default();
    let raw = qs
        .split('&')
        .find_map(|kv| {
            if let Some(v) = kv.strip_prefix("npub=") { Some(v) }
            else if let Some(v) = kv.strip_prefix("alias=") { Some(v) }
            else { None }
        })
        .unwrap_or_default();
    let alias = match urlencoding_decode(raw) {
        Some(s) if !s.is_empty() => s,
        _ => return Ok(json_error(StatusCode::BAD_REQUEST, "missing npub")),
    };
    // v149: direct npub match only, no sibling-alias fallback.
    let subs = store.for_alias(&alias);
    let body = serde_json::json!({
        "alias": alias,
        "subscribed": !subs.is_empty(),
        "count": subs.len(),
    });
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .body(Full::new(Bytes::from(body.to_string())))
        .unwrap())
}

// Tiny URL-decoder (we don't pull in a dep just for one percent-encoded
// query param).
fn urlencoding_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'+' {
            out.push(b' ');
            i += 1;
        } else if b == b'%' && i + 2 < bytes.len() {
            let h = (hex_val(bytes[i + 1])? << 4) | hex_val(bytes[i + 2])?;
            out.push(h);
            i += 3;
        } else {
            out.push(b);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
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
    // Accept either {id: "..."} (precise removal) or {npub: "..."} /
    // {alias: "..." (v149: значение = npub; ключ alias оставлен для
    // совместимости со старыми клиентами) — remove all subscriptions for it.
    let mut removed = 0usize;
    if let Some(id) = json.get("id").and_then(|v| v.as_str()) {
        store.delete(id);
        removed = 1;
    } else if let Some(alias) = json
        .get("npub")
        .and_then(|v| v.as_str())
        .or_else(|| json.get("alias").and_then(|v| v.as_str()))
    {
        for s in store.for_alias(alias) {
            store.delete(&s.id);
            removed += 1;
        }
    } else {
        return Ok(json_error(StatusCode::BAD_REQUEST, "missing id or alias"));
    }
    let body = serde_json::json!({ "ok": true, "removed": removed }).to_string();
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .body(Full::new(Bytes::from(body)))
        .unwrap())
}

/// `POST /envelope?to=<npub>` — accept a signed envelope from a PWA
/// (or any HTTP client) and route it through the same persistence+fanout
/// pipeline as the iroh-direct path.
///
/// Body: either `application/octet-stream` (raw postcard-encoded `Envelope`)
/// or `application/json` (browser-friendly shortcut; the JSON bytes are
/// wrapped verbatim and the from_npub is read from the JSON object).
/// Query: `?to=<recipient_npub>` — required. Param name `to` kept (value is
/// the full recipient npub since v149; the old client already sent npub).
async fn handle_post_envelope(
    req: Request<Incoming>,
    pending: crate::PendingStore,
    hub: crate::SubscriberHub,
    push: &PushServer,
    store: Option<crate::storage::MessageStore>,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    // 1. Extract `?to=<npub>` from query string.
    let to_npub = match req
        .uri()
        .query()
        .and_then(|q| {
            q.split('&')
                .find_map(|kv| kv.strip_prefix("to=").map(|s| s.to_string()))
        }) {
        Some(a) if !a.is_empty() => a,
        _ => {
            return Ok(json_error(
                StatusCode::BAD_REQUEST,
                "missing or empty ?to=<npub> query param",
            ));
        }
    };
    // URL-decode to_npub (hyper doesn't decode query params).
    let to_npub = percent_decode(&to_npub);

    let ct = req
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    // 2. Read raw body.
    let body = match req.collect().await {
        Ok(c) => c.to_bytes(),
        Err(e) => {
            return Ok(json_error(
                StatusCode::BAD_REQUEST,
                &format!("body read: {e}"),
            ));
        }
    };

    let env_bytes: Vec<u8>;
    let from_npub_hint: Option<String>;
    if ct.starts_with("application/json") {
        let parsed: serde_json::Value = match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => {
                return Ok(json_error(
                    StatusCode::BAD_REQUEST,
                    &format!("bad json: {e}"),
                ));
            }
        };
        from_npub_hint = parsed
            .get("from")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        // Wrap as {"_kind":"json_envelope","to":<npub>,"payload":<orig>}
        let wrapper = serde_json::json!({
            "_kind": "json_envelope",
            "to": to_npub,
            "payload": parsed,
        });
        env_bytes = serde_json::to_vec(&wrapper).unwrap_or_else(|_| b"{}_".to_vec());
    } else {
        env_bytes = body.to_vec();
        from_npub_hint = None;
    }

    // 4. Hand off to shared envelope logic.
    let push_arc = Arc::new(push.clone());
    match crate::envelope::accept_envelope(
        to_npub.clone(),
        env_bytes,
        &pending,
        &hub,
        Some(&push_arc),
        store.as_ref(),
    ) {
        Ok((hash, n)) => {
            let mut resp = serde_json::json!({
                "ok": true,
                "hash": hash,
                "broadcast": n,
                "to": to_npub,
            });
            if let Some(from) = from_npub_hint {
                resp["from"] = serde_json::Value::String(from);
            }
            let resp = resp.to_string();
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/json")
                .header("access-control-allow-origin", "*")
                .body(Full::new(Bytes::from(resp)))
                .unwrap())
        }
        Err(e) => Ok(json_error(StatusCode::BAD_REQUEST, &e)),
    }
}

async fn handle_api_contacts(
    req: Request<Incoming>,
    store: Option<crate::storage::MessageStore>,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let db = match &store {
        Some(db) => db,
        None => {
            return Ok(json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "message store not initialised",
            ));
        }
    };

    let query = req.uri().query().unwrap_or("");
    let mut npub: Option<String> = None;
    for kv in query.split('&') {
        if let Some(v) = kv.strip_prefix("npub=") { npub = Some(v.to_string()); }
    }
    let npub = match npub {
        Some(n) if !n.is_empty() => n,
        _ => {
            return Ok(json_error(
                StatusCode::BAD_REQUEST,
                "missing ?npub=<npub> query param",
            ));
        }
    };

    // Опциональный side-effect: пометить входящие от peer'а как прочитанные.
    // Нужен чтобы badge после reload отражал реальное состояние, а
    // не счётчик всех входящих за всё время.
    // Cloudflare Worker проксирует /api/contacts, поэтому вкладываемся
    // сюда, а не выделяем отдельный endpoint.
    let contacts = match db.get_contacts(&npub) {
        Ok(c) => c,
        Err(e) => {
            return Ok(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("get_contacts: {e}"),
            ));
        }
    };

    let resp = serde_json::json!({ "contacts": contacts });
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .body(Full::new(Bytes::from(resp.to_string())))
        .unwrap())
}

// ── API: history ────────────────────────────────────────────────────────────

async fn handle_api_history(
    req: Request<Incoming>,
    store: Option<crate::storage::MessageStore>,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let db = match &store {
        Some(db) => db,
        None => {
            return Ok(json_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "message store not initialised",
            ));
        }
    };

    let npub = match req
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("npub=").map(|s| s.to_string())))
    {
        Some(n) if !n.is_empty() => n,
        _ => {
            return Ok(json_error(
                StatusCode::BAD_REQUEST,
                "missing ?npub=<npub> query param",
            ));
        }
    };

    let peer = match req
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("peer=").map(|s| s.to_string())))
    {
        Some(p) if !p.is_empty() => p,
        _ => {
            return Ok(json_error(
                StatusCode::BAD_REQUEST,
                "missing ?peer=<npub> query param",
            ));
        }
    };

    let limit: i64 = req
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("limit=").and_then(|v| v.parse().ok())))
        .unwrap_or(100);

    let before_ts: Option<i64> = req
        .uri()
        .query()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("before_ts=").and_then(|v| v.parse().ok())));

    let resp = match db.get_history(&npub, &peer, limit, before_ts) {
        Ok(h) => {
            // Convert raw body bytes to base64 and build response rows.
            let messages: Vec<serde_json::Value> = h.messages.iter().map(|m| {
                let direction = if m.from_npub == npub { "out" } else { "in" };
                let atts: Vec<serde_json::Value> = m.attachments.iter().map(|a| {
                    serde_json::json!({
                        "blob_id": a.blob_id,
                        "wrapped_key": a.wrapped_key,
                        "iv": a.iv,
                        "name": a.name,
                        "mime": a.mime,
                        "size": a.size,
                        "position": a.position,
                    })
                }).collect();
                serde_json::json!({
                    "from": m.from_npub,
                    "to": m.to_npub,
                    "body_base64": BASE64.encode(&m.body),
                    "sig_base64": "",
                    "ts": m.ts,
                    "direction": direction,
                    // Lesson #128: добавляем hash для надёжного дедупа на клиенте
                    // (сервер может переписать ts, тогда дедуп по myNpub+ts ломается).
                    "envelope_hash": m.envelope_hash,
                    // Phase 2 (Variant Б): attachments_meta with blob_id + wrapped_key.
                    "attachments": atts,
                })
            }).collect();

            // Lesson #131: honest relay — помечаем все отданные envelope'ы к удалению
            // через 5 мин. Peer offline зашёл за ними — мы больше не помним.
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let short_ttl = now + 300; // 5 minutes
            for m in &h.messages {
                if let Err(e) = db.shorten_expires_at(&m.envelope_hash, short_ttl) {
                    warn!(err=%e, "shorten_expires_at failed on /api/history");
                }
            }

            let mut out = serde_json::Map::new();
            out.insert("messages".into(), serde_json::Value::Array(messages));
            if let Some(nbt) = h.next_before_ts {
                out.insert("next_before_ts".into(), serde_json::Value::Number(serde_json::Number::from(nbt)));
            }
            serde_json::Value::Object(out)
        }
        Err(e) => {
            return Ok(json_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                &format!("get_history: {e}"),
            ));
        }
    };

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/json")
        .header("access-control-allow-origin", "*")
        .body(Full::new(Bytes::from(resp.to_string())))
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

// ── v160f: /manifest.json с start_url из ?invite= ──────────────────────────
// iOS читает манифест В МОМЕНТ «На экран Домой» и запоминает start_url.
// Свапаем link[rel=manifest] на ?invite=<npub> (app.js), тут отдаём копию
// с start_url="/?invite=<npub>" → PWA стартует с чатом приглашённого.
async fn handle_manifest(
    req: Request<Incoming>,
    static_dir: &Option<PathBuf>,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    // Базовый манифест со диска (не кэшируем в памяти — файл может меняться).
    let Some(bytes) = static_dir.as_ref().and_then(|d| {
        let p = d.join("manifest.json");
        std::fs::read(p).ok()
    }) else {
        return Ok(json_error(StatusCode::NOT_FOUND, "manifest not found"));
    };
    let mut json: JsonValue = match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => return Ok(json_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("manifest parse: {e}"))),
    };
    // ?invite=npub1… → подменяем start_url (и scope остаётся "/").
    if let Some(q) = req.uri().query() {
        for kv in q.split('&') {
            if let Some(inv) = kv.strip_prefix("invite=") {
                let inv = percent_decode(inv);
                if inv.starts_with("npub1") && inv.len() < 100 && inv.chars().all(|c| c.is_ascii_alphanumeric()) {
                    if let Some(obj) = json.as_object_mut() {
                        obj.insert(
                            "start_url".to_string(),
                            JsonValue::String(format!("/?invite={}", inv)),
                        );
                    }
                }
            }
        }
    }
    let body = json.to_string();
    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", "application/manifest+json")
        .header("cache-control", "no-cache, no-store, must-revalidate")
        .header("access-control-allow-origin", "*")
        .body(Full::new(Bytes::from(body)))
        .unwrap())
}

// ── v160f: identity transfer (перенос личности Safari → PWA) ────────────────
// Сервер хранит ТОЛЬКО ct_b64 = AES-GCM(ключ_личности, код) под hash(код).
// Код (6+2 симв) существует только на клиентах; hash нельзя обратить.

fn sha256_hex(input: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    Digest::update(&mut h, input.as_bytes());
    hex::encode(Digest::finalize(h))
}

const TRANSFER_TTL_SECS: i64 = 600; // 10 минут
const TRANSFER_MAX_CT: usize = 8 * 1024; // шифротекст ключа — пара сотен байт

async fn handle_transfer_create(
    req: Request<Incoming>,
    store: Option<crate::storage::MessageStore>,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let Some(db) = store else {
        return Ok(json_error(StatusCode::SERVICE_UNAVAILABLE, "message store not initialised"));
    };
    let body = match req.collect().await {
        Ok(c) => c.to_bytes(),
        Err(e) => return Ok(json_error(StatusCode::BAD_REQUEST, &format!("body read: {e}"))),
    };
    if body.len() > TRANSFER_MAX_CT {
        return Ok(json_error(StatusCode::PAYLOAD_TOO_LARGE, "ct too large"));
    }
    let json: JsonValue = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return Ok(json_error(StatusCode::BAD_REQUEST, &format!("bad json: {e}"))),
    };
    let Some(code) = json.get("code").and_then(|v| v.as_str()) else {
        return Ok(json_error(StatusCode::BAD_REQUEST, "missing code"));
    };
    let Some(ct_b64) = json.get("ct_b64").and_then(|v| v.as_str()) else {
        return Ok(json_error(StatusCode::BAD_REQUEST, "missing ct_b64"));
    };
    // Базовая валидация кода: 7-8 алфанит. символов (клиент генерит сам,
    // сервер не должен уметь их перебирать — hash уникализирует запись).
    let code = code.trim().to_uppercase();
    if code.len() < 6 || code.len() > 10 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Ok(json_error(StatusCode::BAD_REQUEST, "bad code format"));
    }
    if ct_b64.len() == 0 || ct_b64.len() > TRANSFER_MAX_CT {
        return Ok(json_error(StatusCode::BAD_REQUEST, "bad ct_b64 size"));
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let code_hash = sha256_hex(&code);
    match db.create_identity_transfer(&code_hash, ct_b64, now, TRANSFER_TTL_SECS) {
        Ok(expires_at) => {
            let resp = serde_json::json!({ "ok": true, "expires_at": expires_at });
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/json")
                .header("access-control-allow-origin", "*")
                .body(Full::new(Bytes::from(resp.to_string())))
                .unwrap())
        }
        Err(e) => Ok(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("create transfer: {e}"),
        )),
    }
}

async fn handle_transfer_redeem(
    req: Request<Incoming>,
    store: Option<crate::storage::MessageStore>,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let Some(db) = store else {
        return Ok(json_error(StatusCode::SERVICE_UNAVAILABLE, "message store not initialised"));
    };
    let body = match req.collect().await {
        Ok(c) => c.to_bytes(),
        Err(e) => return Ok(json_error(StatusCode::BAD_REQUEST, &format!("body read: {e}"))),
    };
    let json: JsonValue = match serde_json::from_slice(&body) {
        Ok(v) => v,
        Err(e) => return Ok(json_error(StatusCode::BAD_REQUEST, &format!("bad json: {e}"))),
    };
    let Some(code) = json.get("code").and_then(|v| v.as_str()) else {
        return Ok(json_error(StatusCode::BAD_REQUEST, "missing code"));
    };
    let code = code.trim().to_uppercase();
    if code.len() < 7 || code.len() > 9 || !code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
        return Ok(json_error(StatusCode::BAD_REQUEST, "bad code format"));
    }
    let code_hash = sha256_hex(&code.replace('-', ""));
    match db.consume_identity_transfer(&code_hash) {
        Ok(Some(ct_b64)) => {
            let resp = serde_json::json!({ "ok": true, "ct_b64": ct_b64 });
            Ok(Response::builder()
                .status(StatusCode::OK)
                .header("content-type", "application/json")
                .header("access-control-allow-origin", "*")
                .body(Full::new(Bytes::from(resp.to_string())))
                .unwrap())
        }
        Ok(None) => Ok(json_error(StatusCode::NOT_FOUND, "code not found, expired or already used")),
        Err(e) => Ok(json_error(
            StatusCode::INTERNAL_SERVER_ERROR,
            &format!("redeem transfer: {e}"),
        )),
    }
}

// --- /api/upload + /api/blob/{id} (Phase 1 attachments, Variant B) ---

use crate::upload::{handle_download as upload_handle_download, handle_upload as upload_handle_upload, UploadRequest};

async fn handle_api_upload(
    req: Request<Incoming>,
    store: Option<crate::storage::MessageStore>,
    pending: crate::PendingStore,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let db = match &store {
        Some(db) => db,
        None => return Ok(json_error(StatusCode::SERVICE_UNAVAILABLE, "message store not initialised")),
    };

    // 1. Parse query params (metadata: sha256, mime, name, size, wrapped_key).
    let query = req.uri().query().unwrap_or("");
    let mut sha256: Option<String> = None;
    let mut mime: Option<String> = None;
    let mut name: Option<String> = None;
    let mut size: Option<u64> = None;
    let mut wrapped_key: Option<String> = None;
    for kv in query.split('&') {
        if let Some(rest) = kv.strip_prefix("sha256=") {
            sha256 = Some(url_decode(rest));
        } else if let Some(rest) = kv.strip_prefix("mime=") {
            mime = Some(url_decode(rest));
        } else if let Some(rest) = kv.strip_prefix("name=") {
            name = Some(url_decode(rest));
        } else if let Some(rest) = kv.strip_prefix("size=") {
            size = rest.parse().ok();
        } else if let Some(rest) = kv.strip_prefix("wrapped_key=") {
            wrapped_key = Some(url_decode(rest));
        }
    }

    let (sha256, mime, name, size, wrapped_key) = match (sha256, mime, name, size, wrapped_key) {
        (Some(s), Some(m), Some(n), Some(sz), Some(wk)) => (s, m, n, sz, wk),
        _ => return Ok(json_error(StatusCode::BAD_REQUEST, "missing required query params: sha256, mime, name, size, wrapped_key")),
    };

    // 2. Read body (binary).
    let body = match http_body_util::BodyExt::collect(req).await {
        Ok(b) => b.to_bytes(),
        Err(e) => return Ok(json_error(StatusCode::BAD_REQUEST, &format!("body collect: {e}"))),
    };

    // 3. Derive home_dir from pending's pending_dir parent.
    // pending_dir = `<home>/pending` → parent = home_dir.
    let home_dir = pending.pending_dir().parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| PathBuf::from("."));

    let upload_req = UploadRequest {
        body,
        wrapped_key,
        mime,
        name,
        sha256,
        size,
    };

    match upload_handle_upload(db, &home_dir, upload_req) {
        Ok(meta) => {
            let resp = serde_json::json!({
                "ok": true,
                "blob_id": meta.blob_id,
                "sha256": meta.sha256,
                "size": meta.size,
                "mime": meta.mime,
            });
            Ok(Response::builder()
                .status(StatusCode::CREATED)
                .header("content-type", "application/json")
                .header("access-control-allow-origin", "*")
                .body(Full::new(Bytes::from(resp.to_string())))
                .unwrap())
        }
        Err(e) => Ok(json_error(e.status(), &e.message())),
    }
}

async fn handle_api_blob_download(
    req: Request<Incoming>,
    store: Option<crate::storage::MessageStore>,
) -> Result<Response<Full<Bytes>>, std::convert::Infallible> {
    let db = match &store {
        Some(db) => db,
        None => return Ok(json_error(StatusCode::SERVICE_UNAVAILABLE, "message store not initialised")),
    };

    let blob_id = req.uri().path().trim_start_matches("/api/blob/");
    if blob_id.is_empty() || blob_id.contains('/') {
        return Ok(json_error(StatusCode::BAD_REQUEST, "invalid blob_id"));
    }

    let (path, meta) = match upload_handle_download(db, blob_id) {
        Ok(p) => p,
        Err(e) => return Ok(json_error(e.status(), &e.message())),
    };

    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => return Ok(json_error(StatusCode::INTERNAL_SERVER_ERROR, &format!("read blob: {e}"))),
    };

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("content-type", &meta.mime)
        .header("content-length", meta.size)
        .header("x-blob-id", &meta.blob_id)
        .header("x-blob-sha256", &meta.sha256)
        .header("access-control-allow-origin", "*")
        .header("cache-control", "private, max-age=31536000, immutable")
        .body(Full::new(Bytes::from(bytes)))
        .unwrap())
}

fn url_decode(s: &str) -> String {
    use std::str;
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex_val(bytes[i+1]), hex_val(bytes[i+2])) {
                out.push((h << 4) | l);
                i += 3;
                continue;
            }
        } else if bytes[i] == b'+' {
            out.push(b' ');
            i += 1;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    str::from_utf8(&out).unwrap_or(s).to_string()
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

fn percent_decode(s: &str) -> String {
    // hyper doesn't decode percent-encoded query params, so we do it here.
    // Replace %XX with the actual byte (keeping UTF-8).
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i+1] as char).to_digit(16);
            let lo = (bytes[i+2] as char).to_digit(16);
            if let (Some(h), Some(l)) = (hi, lo) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
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
            title: "Murmur".into(),
            subtitle: "Ирина".into(),
            body: "new encrypted message (210 bytes)".into(),
        };
        let s = p.to_json();
        let back: PushPayload = serde_json::from_str(&s).unwrap();
        assert_eq!(back.alias, "oleg-hp");
        assert_eq!(back.subtitle, "Ирина");
    }

    #[test]
    fn from_entry_push_is_neutral_npub_only() {
        use crate::storage::MessageStore;
        use crate::pending::PendingEntry;

        let dir = std::env::temp_dir().join(format!("murmur-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("msgs.db");
        std::fs::remove_file(&db_path).ok();
        let store = MessageStore::new(&db_path).unwrap();

        let sender_npub = "npub1s3ux2m28x30d7sr5qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq";
        let entry = PendingEntry {
            to_npub: "oleg-hp".into(),
            from_npub: sender_npub.into(),
            ts: 1700000000,
            envelope_bytes: vec![1, 2, 3, 4],
            envelope_hash_hex: "abc".into(),
        };
        let payload = PushPayload::from_entry(&entry, Some(&store));
        // v149: no alias resolution — title always "Murmur" (suppresses iOS
        // auto-line), subtitle = short npub of sender.
        assert_eq!(payload.title, "Murmur");
        assert!(payload.subtitle.starts_with("npub1"), "subtitle should be short npub: {}", payload.subtitle);
        assert!(payload.subtitle.contains("…"), "subtitle should be shortened: {}", payload.subtitle);
        assert!(!payload.subtitle.contains(&sender_npub), "full npub must not leak into subtitle");
        assert_eq!(payload.body, "Откройте murmur, чтобы прочитать сообщение");
        // JSON field `alias` carries the recipient npub (routing key).
        assert_eq!(payload.alias, "oleg-hp");

        std::fs::remove_file(&db_path).ok();
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
        assert_eq!(pub_bytes.len(), 65);
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
