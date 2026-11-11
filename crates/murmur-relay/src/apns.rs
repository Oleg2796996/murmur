//! APNs delivery for the native iOS client (MurmurApp).
//!
//! Architecture mirrors `push.rs` (Web Push for PWA) but speaks Apple's
//! provider API: HTTP/2 `POST /3/device/<token>` with an ES256 JWT signed by
//! the `AuthKey_*.p8` token key.
//!
//! - Registration: `POST /apns/register` on the push HTTP server.
//!   Body: `{ npub, token, kind: "alert"|"voip", challenge_sig }` where
//!   `challenge_sig = sign_envelope("apns-register")` (proof-of-key, same
//!   scheme as push-register). One token per (npub, kind) — newest wins.
//! - Delivery: on envelope for an offline npub, alongside Web Push.
//! - Payload contains NO message content (privacy principle): generic text +
//!   badge only.
//!
//! ## Config (murmur-relay.toml)
//!
//! ```toml
//! [apns]
//! enabled = true
//! key_id = "ABC123DEF"
//! team_id = "TEAM456GHI"
//! key_p8_b64 = "<base64 of AuthKey_*.p8 contents>"
//! # or key_path = "/etc/murmur/AuthKey_ABC123DEF.p8"
//! topic = "org.murmurchat.app"   # = app bundle id
//! ```

use anyhow::Context;
use base64::Engine;
use jwt_simple::prelude::{ES256KeyPair, ECDSAP256KeyPairLike};
use parking_lot::Mutex;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tracing::{info, warn};

/// APNs provider config, loaded from murmur-relay.toml.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ApnsConfig {
    #[serde(default)]
    pub enabled: bool,
    /// Key id from the Apple developer account (10 chars, e.g. ABC123DEF).
    #[serde(default)]
    pub key_id: String,
    /// Team id (10 chars).
    #[serde(default)]
    pub team_id: String,
    /// App bundle id — the APNs topic.
    #[serde(default = "default_topic")]
    pub topic: String,
    /// Path to AuthKey_<key_id>.p8 on disk (optional).
    #[serde(default)]
    pub key_path: Option<PathBuf>,
    /// AuthKey contents as base64 (alternative to key_path, secrets stay out
    /// of the toml plaintext only if the toml itself is protected).
    #[serde(default)]
    pub key_p8_b64: Option<String>,
    /// Use sandbox APNs (development builds). Production URL by default.
    #[serde(default)]
    pub sandbox: bool,
}

fn default_topic() -> String {
    "org.murmurchat.app".to_string()
}

impl ApnsConfig {
    pub fn is_configured(&self) -> bool {
        self.enabled
            && !self.key_id.is_empty()
            && !self.team_id.is_empty()
            && (self.key_path.is_some() || self.key_p8_b64.is_some())
    }
}

/// ES256 token key loaded from the .p8 file.
pub struct ApnsKey {
    key_pair: ES256KeyPair,
    key_id: String,
    team_id: String,
    /// Cached provider JWT + its mint time. Apple rate-limits provider token
    /// refreshes (APNs 429 TooManyProviderTokenUpdates); a fresh JWT per
    /// send gets throttled after a few pushes ("works every other time").
    /// Reuse one token for ~50 minutes (Apple validity is 1 hour).
    cached_token: Mutex<Option<(String, u64)>>,
}

impl ApnsKey {
    pub fn from_config(cfg: &ApnsConfig) -> anyhow::Result<Option<Self>> {
        if !cfg.is_configured() {
            return Ok(None);
        }
        let pem = if let Some(path) = &cfg.key_path {
            std::fs::read_to_string(path)
                .with_context(|| format!("read APNs key {}", path.display()))?
        } else {
            let b64 = cfg.key_p8_b64.as_deref().unwrap_or_default();
            base64::engine::general_purpose::STANDARD
                .decode(b64.trim())
                .map(|raw| String::from_utf8_lossy(&raw).to_string())
                .with_context(|| "decode key_p8_b64")?
        };
        let key_pair = ES256KeyPair::from_pem(pem.trim())
            .with_context(|| "parse APNs .p8 key (expected EC PRIVATE KEY PEM)")?
            .with_key_id(&cfg.key_id);
        Ok(Some(Self {
            key_pair,
            key_id: cfg.key_id.clone(),
            team_id: cfg.team_id.clone(),
            cached_token: Mutex::new(None),
        }))
    }

    /// Build the provider JWT (ES256 with kid header).
    /// Apple: iss = team id, iat = now. Token valid ~1 hour.
    /// v-apns-cache (2026-11-09): mint at most once per 50 min. Minting per
    /// send tripped Apple's provider-token-update rate limit (429
    /// TooManyProviderTokenUpdates) — pushes worked "every other time".
    fn provider_token(&self) -> anyhow::Result<String> {
        const TOKEN_TTL: u64 = 50 * 60; // 50 min (Apple honors ~1h)
        let now = SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs();
        let mut cache = self.cached_token.lock();
        if let Some((token, minted_at)) = cache.as_ref() {
            if now.saturating_sub(*minted_at) < TOKEN_TTL {
                return Ok(token.clone());
            }
        }
        let mut claims = jwt_simple::prelude::Claims::with_custom_claims(
            json!({}),
            jwt_simple::prelude::Duration::from_secs(3600),
        );
        claims.issuer = Some(self.team_id.clone());
        claims.issued_at = Some(jwt_simple::prelude::UnixTimeStamp::from_secs(now));
        let token = self.key_pair.sign(claims)?;
        *cache = Some((token.clone(), now));
        Ok(token)
    }
}

/// One registered device token.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApnsRegistration {
    pub npub: String,
    pub token: String,
    /// "alert" (regular) or "voip" (PushKit, later for calls).
    pub kind: String,
    pub registered_at: String,
}

/// Token store: messages.db, table apns_tokens (npub, kind) unique.
pub struct ApnsStore {
    conn: Mutex<rusqlite::Connection>,
}

impl ApnsStore {
    pub fn new(db_path: &Path) -> anyhow::Result<Self> {
        let conn = rusqlite::Connection::open(db_path)
            .with_context(|| format!("open apns store {}", db_path.display()))?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS apns_tokens (
                npub          TEXT NOT NULL,
                kind          TEXT NOT NULL,
                token         TEXT NOT NULL,
                registered_at TEXT NOT NULL,
                PRIMARY KEY (npub, kind)
            );
            ",
        )?;
        Ok(Self { conn: Mutex::new(conn) })
    }

    pub fn upsert(&self, reg: &ApnsRegistration) -> anyhow::Result<()> {
        self.conn.lock().execute(
            "INSERT INTO apns_tokens (npub, kind, token, registered_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (npub, kind) DO UPDATE SET token = excluded.token,
                                                    registered_at = excluded.registered_at",
            params![reg.npub, reg.kind, reg.token, reg.registered_at],
        )?;
        Ok(())
    }

    pub fn remove(&self, npub: &str, kind: &str) -> anyhow::Result<usize> {
        Ok(self.conn.lock().execute(
            "DELETE FROM apns_tokens WHERE npub = ?1 AND kind = ?2",
            params![npub, kind],
        )?)
    }

    pub fn tokens_for(&self, npub: &str, kind: &str) -> Vec<ApnsRegistration> {
        self.conn
            .lock()
            .prepare_cached("SELECT npub, kind, token, registered_at FROM apns_tokens WHERE npub = ?1 AND kind = ?2")
            .and_then(|mut st| {
                st.query_map(params![npub, kind], |r| {
                    Ok(ApnsRegistration {
                        npub: r.get(0)?,
                        kind: r.get(1)?,
                        token: r.get(2)?,
                        registered_at: r.get(3)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
            })
            .unwrap_or_default()
    }
}

/// Push notification content for APNs.
pub struct ApnsAlert {
    pub body: String,
    pub badge: Option<u32>,
    /// For the (future) VoIP path: custom JSON passed next to `aps`.
    pub custom: serde_json::Value,
}

/// Delivery client.
pub struct ApnsClient {
    key: ApnsKey,
    topic: String,
    base_url: String,
    http: reqwest::Client,
}

impl ApnsClient {
    pub fn from_config(cfg: &ApnsConfig) -> anyhow::Result<Option<Self>> {
        let Some(key) = ApnsKey::from_config(cfg)? else {
            return Ok(None);
        };
        let base_url = if cfg.sandbox {
            "https://api.sandbox.push.apple.com".to_string()
        } else {
            "https://api.push.apple.com".to_string()
        };
        let http = reqwest::Client::builder()
            .http2_prior_knowledge()
            .build()?;
        Ok(Some(Self {
            key,
            topic: cfg.topic.clone(),
            base_url,
            http,
        }))
    }

    /// Send one alert push. Returns Ok(false) when Apple said the token is
    /// gone (caller should unregister it).
    pub async fn send(&self, token: &str, alert: &ApnsAlert) -> anyhow::Result<bool> {
        let jwt = self.key.provider_token()?;
        let url = format!("{}/3/device/{}", self.base_url, token);
        let mut aps = json!({
            "alert": { "title": "MurMur", "body": alert.body },
            "sound": "default",
        });
        // 2026-11-09: badge is managed by the iOS app itself (unreadByPeer).
        // The server-side count (live envelopes) disagrees with the device's
        // unread map and the aps.badge write visibly "flickers" the sticker
        // (correct N → 1). Only stamp badge when explicitly requested.
        if let Some(b) = alert.badge {
            aps["badge"] = json!(b);
        }
        if alert.custom.get("content_available") == Some(&json!(1)) {
            aps["content-available"] = json!(1);
        }
        let mut body = json!({ "aps": aps });
        if let Some(obj) = alert.custom.as_object() {
            for (k, v) in obj {
                if k != "content_available" {
                    body[k.clone()] = v.clone();
                }
            }
        }
        let resp = self
            .http
            .post(&url)
            .header("authorization", format!("bearer {jwt}"))
            .header("apns-topic", &self.topic)
            .header("apns-push-type", "alert")
            .header("apns-priority", "10")
            .json(&body)
            .timeout(Duration::from_secs(15))
            .send()
            .await?;
        match resp.status().as_u16() {
            200 => Ok(true),
            403 | 404 | 410 => Ok(false), // token gone / topic wrong → drop it
            status => {
                let text = resp.text().await.unwrap_or_default();
                anyhow::bail!("APNs {status}: {text}")
            }
        }
    }

    /// v160z25: VoIP push — apns-push-type: voip, без alert/sound в aps
    /// (Apple: PushKit-клиент должен получать voip-пуш без визуального alert,
    /// иначе push не доставляется в PKPushRegistry).
    pub async fn send_voip(&self, token: &str, body: &serde_json::Value) -> anyhow::Result<bool> {
        let jwt = self.key.provider_token()?;
        let url = format!("{}/3/device/{}", self.base_url, token);
        let resp = self
            .http
            .post(&url)
            .header("authorization", format!("bearer {jwt}"))
            .header("apns-topic", &self.topic)
            .header("apns-push-type", "voip")
            .header("apns-priority", "10")
            .json(body)
            .timeout(Duration::from_secs(15))
            .send()
            .await?;
        match resp.status().as_u16() {
            200 => Ok(true),
            403 | 404 | 410 => Ok(false),
            status => {
                let text = resp.text().await.unwrap_or_default();
                anyhow::bail!("APNs voip {status}: {text}")
            }
        }
    }
}

/// Shared handle wired into the relay (None when APNs not configured).
#[derive(Clone)]
pub struct ApnsHandle {
    pub client: Option<Arc<ApnsClient>>,
    pub store: Option<Arc<ApnsStore>>,
}

impl ApnsHandle {
    pub fn disabled() -> Self {
        Self { client: None, store: None }
    }

    /// Register a token after proof-of-key verification (done by caller).
    pub fn register(&self, reg: &ApnsRegistration) -> anyhow::Result<()> {
        match &self.store {
            Some(s) => s.upsert(reg),
            None => anyhow::bail!("APNs not configured"),
        }
    }

    pub fn unregister(&self, npub: &str, kind: &str) {
        if let Some(s) = &self.store {
            let _ = s.remove(npub, kind);
        }
    }

    pub fn is_registered(&self, npub: &str) -> bool {
        self.store
            .as_ref()
            .map(|s| !s.tokens_for(npub, "alert").is_empty())
            .unwrap_or(false)
    }

    /// Deliver a generic "new message" alert to every registered alert token.
    /// Fire-and-forget semantics; errors are logged, never fatal.
    pub async fn deliver_message_alert(&self, npub: &str, body: &str, badge: u32) {
        let Some(client) = &self.client else { return };
        let Some(store) = &self.store else { return };
        let _ = badge; // 2026-11-09: badge managed by the iOS app itself; aps.badge omitted.
        for reg in store.tokens_for(npub, "alert") {
            let alert = ApnsAlert {
                body: body.to_string(),
                badge: None,
                custom: json!({}),
            };
            match client.send(&reg.token, &alert).await {
                Ok(true) => info!(npub = %npub, "APNs alert delivered (no aps.badge)"),
                Ok(false) => {
                    warn!(npub = %npub, "APNs token rejected, unregistering");
                    store.remove(npub, "alert");
                }
                Err(e) => warn!(npub = %npub, err = %e, "APNs send failed"),
            }
        }
    }

    /// v160z25 (Олег 2026-11-11 «наивный звонок на iOS как обычный звонок»):
    /// VoIP push (PushKit) для входящего звонка. Требования Apple:
    /// apns-push-type = voip, apns-priority = 10, полезная нагрузка БЕЗ alert
    /// (иначе PushKit-клиент игнорирует). Payload несёт только kind/from/mode
    /// — релей по-прежнему не видит ни SDP, ни имён.
    pub async fn deliver_call_voip(&self, npub: &str, from_npub: &str, call_mode: &str) {
        let Some(client) = &self.client else { return };
        let Some(store) = &self.store else { return };
        for reg in store.tokens_for(npub, "voip") {
            let body = json!({
                "aps": {},
                "kind": "incoming_call",
                "from": from_npub,
                "mode": call_mode,
            });
            match client.send_voip(&reg.token, &body).await {
                Ok(true) => info!(npub = %npub, "APNs voip call push delivered"),
                Ok(false) => {
                    warn!(npub = %npub, "APNs voip token rejected, unregistering");
                    store.remove(npub, "voip");
                }
                Err(e) => warn!(npub = %npub, err = %e, "APNs voip send failed"),
            }
        }
    }
}

// --- HTTP handlers (wired into push.rs router) ---

#[derive(Deserialize)]
pub struct RegisterBody {
    pub npub: String,
    pub token: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub challenge_sig: String,
}

fn default_kind() -> String {
    "alert".to_string()
}

/// Verify the proof-of-key: `challenge_sig` must be a valid ed25519 signature
/// of the canonical envelope payload over b"apns-register" by `npub`.
/// Signature scheme identical to `push-register` in push.rs.
pub fn verify_register_proof(
    npub: &str,
    challenge_sig_hex: &str,
) -> anyhow::Result<()> {
    use murmur_transport::Envelope;
    let claimed = murmur_id::IdentityPublic::from_npub(npub)
        .map_err(|e| anyhow::anyhow!("bad npub: {e}"))?;
    let sig_bytes = hex::decode(challenge_sig_hex)
        .map_err(|_| anyhow::anyhow!("bad challenge_sig format"))?;
    if sig_bytes.len() != 64 {
        anyhow::bail!("bad challenge_sig format");
    }
    let env = Envelope {
        payload: b"apns-register".to_vec(),
        signature: sig_bytes,
        sender_npub: npub.to_string(),
    };
    env.verify(&claimed)
        .map_err(|e| anyhow::anyhow!("proof-of-key failed: {e}"))
}

/// Handle `POST /apns/register`.
pub async fn handle_register(
    body_bytes: &[u8],
    apns: &ApnsHandle,
) -> Result<(u16, String), std::convert::Infallible> {
    let parsed: Result<RegisterBody, _> = serde_json::from_slice(body_bytes);
    let Ok(body) = parsed else {
        return Ok((400, r#"{"error":"bad json"}"#.into()));
    };
    if body.token.len() < 16 || body.token.len() > 512 {
        return Ok((400, r#"{"error":"bad token"}"#.into()));
    }
    if body.kind != "alert" && body.kind != "voip" {
        return Ok((400, r#"{"error":"kind must be alert|voip"}"#.into()));
    }
    if let Err(e) = verify_register_proof(&body.npub, &body.challenge_sig) {
        return Ok((403, json!({ "error": e.to_string() }).to_string()));
    }
    let reg = ApnsRegistration {
        npub: body.npub.clone(),
        token: body.token.clone(),
        kind: body.kind.clone(),
        registered_at: chrono::Utc::now().to_rfc3339(),
    };
    match apns.register(&reg) {
        Ok(()) => Ok((200, json!({ "ok": true }).to_string())),
        Err(e) => Ok((500, json!({ "error": e.to_string() }).to_string())),
    }
}

/// Handle `POST /apns/unregister`.
pub async fn handle_unregister(
    body_bytes: &[u8],
    apns: &ApnsHandle,
) -> Result<(u16, String), std::convert::Infallible> {
    let parsed: Result<RegisterBody, _> = serde_json::from_slice(body_bytes);
    let Ok(body) = parsed else {
        return Ok((400, r#"{"error":"bad json"}"#.into()));
    };
    if let Err(e) = verify_register_proof(&body.npub, &body.challenge_sig) {
        return Ok((403, json!({ "error": e.to_string() }).to_string()));
    }
    apns.unregister(&body.npub, &body.kind);
    Ok((200, json!({ "ok": true }).to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn register_rejects_bad_proof() {
        // Random 64-byte hex sig must fail verification (real identity sig
        // requires the private key; here we assert the negative path).
        let npub = "npub1ulk7qm05d6k5yv2fmzn4r4058fz5n7hx426wk56hypcx3z89qxvvgncp2cx9at8w7rpmpc0f2dck6vjgl322tuwh52nh98afjqq3qhs26w2n7";
        let bad_sig = "00".repeat(64);
        assert!(verify_register_proof(npub, &bad_sig).is_err());
    }

    #[test]
    fn register_rejects_bad_npub() {
        assert!(verify_register_proof("npub1garbage", &"00".repeat(64)).is_err());
    }

    #[test]
    fn apns_store_roundtrip() {
        let dir = std::env::temp_dir().join(format!("murmur-apns-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = ApnsStore::new(&dir.join("messages.db")).unwrap();
        let reg = ApnsRegistration {
            npub: "npub1test".into(),
            token: "a".repeat(64),
            kind: "alert".into(),
            registered_at: chrono::Utc::now().to_rfc3339(),
        };
        store.upsert(&reg).unwrap();
        assert_eq!(store.tokens_for("npub1test", "alert").len(), 1);
        // Upsert replaces (newest wins).
        let reg2 = ApnsRegistration { token: "b".repeat(64), ..reg.clone() };
        store.upsert(&reg2).unwrap();
        let got = store.tokens_for("npub1test", "alert");
        assert_eq!(got.len(), 1);
        assert!(got[0].token.starts_with('b'));
        store.remove("npub1test", "alert").unwrap();
        assert!(store.tokens_for("npub1test", "alert").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
