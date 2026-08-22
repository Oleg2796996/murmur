//! Shared envelope acceptance logic.
//!
//! Used by both the iroh-direct server (`iroh_server.rs`) and the HTTP
//! `/envelope` endpoint (in `push.rs`) so the validation/persistence/fanout
//! pipeline is identical for any sender transport.

use crate::pending::{PendingEntry, PendingStore};
use crate::push::PushServer;
use crate::storage::MessageStore;
use crate::subscriber::SubscriberHub;
use murmur_id::IdentityPublic;
use murmur_transport::Envelope;
use sha3::{Digest, Sha3_256};
use std::sync::Arc;
use tracing::{error, info, warn};

/// Internal parsed envelope: carries sender npub, the payload that was
/// signed, and the signature.
struct ParsedEnv {
    sender_npub: String,
    payload: Vec<u8>,
    signature: Vec<u8>,
    /// True when the envelope came from the JSON path.
    json_path: bool,
}

fn parse_env(bytes: &[u8]) -> Result<ParsedEnv, String> {
    if bytes.first() == Some(&b'{') {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(bytes) {
            let payload_obj = if v.get("_kind").and_then(|k| k.as_str()) == Some("json_envelope") {
                v.get("payload").cloned().unwrap_or(serde_json::json!({}))
            } else {
                v.clone()
            };
            let from = payload_obj
                .get("from")
                .and_then(|s| s.as_str())
                .ok_or_else(|| "json envelope: missing 'from'".to_string())?
                .to_string();
            let sig_hex = payload_obj
                .get("sig")
                .and_then(|s| s.as_str())
                .unwrap_or("");
            let signature = hex::decode(sig_hex).unwrap_or_default();
            let payload = serde_json::to_vec(&payload_obj)
                .unwrap_or_else(|_| b"{}".to_vec());
            return Ok(ParsedEnv { sender_npub: from, payload, signature, json_path: true });
        }
    }
    if let Ok(env) = postcard::from_bytes::<Envelope>(bytes) {
        return Ok(ParsedEnv {
            sender_npub: env.sender_npub.clone(),
            payload: env.payload.clone(),
            signature: env.signature.clone(),
            json_path: false,
        });
    }
    Err("not a recognised envelope (postcard or json_envelope)".to_string())
}

/// Process a raw envelope payload for a given recipient alias.
///
/// Validates signature, persists to file + SQLite, broadcasts to WS clients,
/// and fires web-push delivery.
///
/// Returns `(envelope_hash_hex, broadcast_count)` on success.
pub fn accept_envelope(
    alias: String,
    env_bytes: Vec<u8>,
    pending: &PendingStore,
    hub: &SubscriberHub,
    push: Option<&Arc<PushServer>>,
    store: Option<&MessageStore>,
) -> Result<(String, usize), String> {
    // 1. Parse envelope.
    let parsed = parse_env(&env_bytes)?;

    // 2. Verify signature when present (postcard path).
    if !parsed.json_path && !parsed.signature.is_empty() {
        let claimed_sender = IdentityPublic::from_npub(&parsed.sender_npub)
            .map_err(|e| format!("bad sender_npub: {e}"))?;
        let env = Envelope {
            sender_npub: parsed.sender_npub.clone(),
            payload: parsed.payload.clone(),
            signature: parsed.signature.clone(),
        };
        env.verify(&claimed_sender)
            .map_err(|_| "signature invalid".to_string())?;
    }

    // 3. Hash the inner payload.
    let mut hasher = Sha3_256::new();
    hasher.update(&parsed.payload);
    let hash_hex = hex::encode(hasher.finalize());

    // 4. Persist to file.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let entry = PendingEntry {
        to_alias: alias.clone(),
        from_npub: parsed.sender_npub.clone(),
        ts,
        envelope_bytes: env_bytes.clone(),
        envelope_hash_hex: hash_hex.clone(),
    };
    if let Err(e) = pending.append(&entry) {
        error!(err=%e, "pending.append failed");
        return Err(format!("pending.append: {e}"));
    }

    // 5. Persist to SQLite (idempotent via envelope_hash PK).
    if let Some(store) = store {
        let ts_ms = ts as i64;
        let expires_at_ms = ts_ms + 86400; // 24 hours TTL
        let inserted = match store.upsert_envelope(&hash_hex, &parsed.sender_npub, &alias, &parsed.payload, &parsed.signature, ts_ms, expires_at_ms) {
            Ok(v) => v,
            Err(e) => {
                warn!(err=%e, "sqlite upsert failed");
                false
            }
        };
        if inserted {
            // Increment unread count for the recipient alias.
            if let Err(e) = store.increment_unread(&alias) {
                warn!(err=%e, "increment_unread failed");
            }
        } else {
            // Duplicate envelope — skip.
            let n = hub.broadcast(&entry);
            return Ok((hash_hex, n));
        }
    }

    // 6. Broadcast to WS subscribers.
    let n = hub.broadcast(&entry);
    info!(alias=%alias, hash=%hash_hex, subs=n, "envelope accepted + fanout");

    // Lesson #131: honest relay — после broadcast/envelope сокращаем TTL до 5 минут.
    // Peer через WS уже получил. Cron снесёт через 5 мин. Если peer был
    // offline — он зайдёт через /api/history в течение 5 мин (iPhone
    // обычно просыпается раньше), в котором тоже пометим на удаление.
    // 5 мин — компромисс между приватностью (cron не держит plaintext)
    // и доставкой (peer успеет зайти).
    if let Some(store) = store {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let short_ttl = now + 300; // 5 minutes

        if let Err(e) = store.shorten_expires_at(&hash_hex, short_ttl) {
            warn!(err=%e, "shorten_expires_at failed");
        }
    }

    // 7. Push delivery.
    if let Some(push) = push {
        let push = push.clone();
        let payload = crate::push::PushPayload::from_entry(&entry);
        let alias_for_log = alias.clone();
        tokio::spawn(async move {
            match push.deliver(&payload).await {
                Ok(n) if n > 0 => info!(alias=%alias_for_log, delivered=n, "push delivered"),
                Ok(_) => {}
                Err(e) => warn!(err=%e, "push deliver failed"),
            }
        });
    }

    Ok((hash_hex, n))
}
