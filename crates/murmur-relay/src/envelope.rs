//! Shared envelope acceptance logic.
//!
//! Used by both the iroh-direct server (`iroh_server.rs`) and the HTTP
//! `/envelope` endpoint (in `push.rs`) so the validation/persistence/fanout
//! pipeline is identical for any sender transport.
//!
//! Олег 2026-08-24 11:00 MSK (E2E шифрование):
//! Wire format (JSON path):
//! ```json
//! {
//!   "from": "npub1...",
//!   "to": "npub1... (recipient full npub, v149)",
//!   "ct":   "<base64 sealed envelope [ephem32|nonce12|ct+tag]>",
//!   "ts":   1234567,
//!   "sig":  "<hex ed25519 sig over (from|to|ts|ct)>",
//!   "attachments_meta": [{"name": "...", "mime": "...", "size": 4891234}]
//! }
//! ```
//! Relay видит только метаданные (`from`, `to`, `ts`, `attachments_meta`),
//! но НЕ видит `ct` (зашифрован для recipient, relay не имеет ключа).
//! Signature покрывает `ct`, чтобы relay не мог подменить ciphertext.

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
    /// Opaque signed bytes — JSON envelope OR postcard envelope. For E2E JSON
    /// path this includes the `ct` field which is base64 sealed envelope.
    payload: Vec<u8>,
    signature: Vec<u8>,
    /// True when the envelope came from the JSON path.
    json_path: bool,
    /// Sealed ciphertext (E2E) for the recipient. Empty on postcard path.
    /// Relay stores this opaque; never reads it.
    sealed: Vec<u8>,
    /// Attachment metadata (public, optional). Names/mime/size only —
    /// NOT the file contents (those are inside `sealed`).
    attachments_meta: Vec<serde_json::Value>,
    /// Canonical signed bytes (from JSON `signed_payload` field, or postcard
    /// envelope payload). Relay verifies sig over THESE bytes, not the
    /// re-serialized JSON (which would change byte-order).
    signed_payload: Vec<u8>,
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
            // sealed = decoded `ct` field (если есть). Relay никогда не
            // использует это содержимое — хранит opaque.
            let sealed = payload_obj
                .get("ct")
                .and_then(|s| s.as_str())
                .and_then(|b64| base64_decode_bytes(b64).ok())
                .unwrap_or_default();
            let attachments_meta = payload_obj
                .get("attachments_meta")
                .and_then(|a| a.as_array())
                .cloned()
                .unwrap_or_default();
            // E2E: `signed_payload` — canonical bytes that were signed.
            // Sig covers (from|to|ts|ct) — guarantees relay didn't swap
            // ciphertext to/from another peer.
            let signed_payload = payload_obj
                .get("signed_payload")
                .and_then(|s| s.as_str())
                .and_then(|b64| base64_decode_bytes(b64).ok())
                .unwrap_or_else(|| serde_json::to_vec(&payload_obj).unwrap_or_else(|_| b"{}".to_vec()));
            let payload = serde_json::to_vec(&payload_obj)
                .unwrap_or_else(|_| b"{}".to_vec());
            return Ok(ParsedEnv {
                sender_npub: from,
                payload,
                signature,
                json_path: true,
                sealed,
                attachments_meta,
                signed_payload,
            });
        }
    }
    if let Ok(env) = postcard::from_bytes::<Envelope>(bytes) {
        return Ok(ParsedEnv {
            sender_npub: env.sender_npub.clone(),
            payload: env.payload.clone(),
            signature: env.signature.clone(),
            json_path: false,
            sealed: Vec::new(),
            attachments_meta: Vec::new(),
            signed_payload: env.payload.clone(),
        });
    }
    Err("not a recognised envelope (postcard or json_envelope)".to_string())
}

/// Minimal RFC 4648 base64 decoder for opaque ciphertext.
fn base64_decode_bytes(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u32, String> {
        match c {
            b'A'..=b'Z' => Ok((c - b'A') as u32),
            b'a'..=b'z' => Ok(26 + (c - b'a') as u32),
            b'0'..=b'9' => Ok(52 + (c - b'0') as u32),
            b'+' => Ok(62),
            b'/' => Ok(63),
            b'=' => Ok(0),
            _ => Err(format!("invalid base64 char: {:?}", c as char)),
        }
    }
    let bytes = s.as_bytes();
    if bytes.len() % 4 != 0 {
        return Err(format!("base64 length not multiple of 4: {}", bytes.len()));
    }
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    let mut i = 0;
    while i < bytes.len() {
        let a = val(bytes[i])?;
        let b = val(bytes[i + 1])?;
        let c = val(bytes[i + 2])?;
        let d = val(bytes[i + 3])?;
        let n = (a << 18) | (b << 12) | (c << 6) | d;
        out.push(((n >> 16) & 0xff) as u8);
        if bytes[i + 2] != b'=' { out.push(((n >> 8) & 0xff) as u8); }
        if bytes[i + 3] != b'=' { out.push((n & 0xff) as u8); }
        i += 4;
    }
    Ok(out)
}

/// Process a raw envelope payload for a given recipient (v149: npub-only).
///
/// Validates signature, persists to file + SQLite, broadcasts to WS clients,
/// and fires web-push delivery.
///
/// Returns `(envelope_hash_hex, broadcast_count)` on success.
pub fn accept_envelope(
    recipient_npub: String,
    env_bytes: Vec<u8>,
    pending: &PendingStore,
    hub: &SubscriberHub,
    push: Option<&Arc<PushServer>>,
    store: Option<&MessageStore>,
) -> Result<(String, usize), String> {
    // 1. Parse envelope.
    let parsed = parse_env(&env_bytes)?;

    // 2. Verify signature (postcard path AND JSON path).
    //    E2E JSON: sig covers (from|to|ts|signed_payload) — гарантирует что
    //    relay не подменил `ct` или `attachments_meta`.
    if !parsed.signature.is_empty() {
        let claimed_sender = IdentityPublic::from_npub(&parsed.sender_npub)
            .map_err(|e| format!("bad sender_npub: {e}"))?;
        let env = Envelope {
            sender_npub: parsed.sender_npub.clone(),
            payload: parsed.signed_payload.clone(),
            signature: parsed.signature.clone(),
        };
        env.verify(&claimed_sender)
            .map_err(|_| "signature invalid".to_string())?;
    }
    // If sig is empty AND json_path → reject (unsigned JSON envelopes not allowed).
    if parsed.json_path && parsed.signature.is_empty() {
        return Err("json envelope: missing 'sig' field".to_string());
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
        to_npub: recipient_npub.clone(),
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
        let inserted = match store.upsert_envelope_with_attachments(&hash_hex, &parsed.sender_npub, &recipient_npub, &parsed.payload, &parsed.signature, ts_ms, expires_at_ms, &parsed.attachments_meta) {
            Ok(v) => v,
            Err(e) => {
                warn!(err=%e, "sqlite upsert failed");
                false
            }
        };
        if inserted {
            // v149: серверный unread удалён (клиент считает сам, lesson #125).
        } else {
            // Duplicate envelope — skip.
            let n = hub.broadcast(&entry, Some(store));
            return Ok((hash_hex, n));
        }
    }

    // 6. Broadcast to WS subscribers.
    let n = hub.broadcast(&entry, store);
    info!(to=%recipient_npub, hash=%hash_hex, subs=n, "envelope accepted + fanout");

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
        let payload = crate::push::PushPayload::from_entry(&entry, store);
        let npub_for_log = recipient_npub.clone();
        tokio::spawn(async move {
            match push.deliver(&payload).await {
                Ok(n) if n > 0 => info!(to=%npub_for_log, delivered=n, "push delivered"),
                Ok(_) => {}
                Err(e) => warn!(err=%e, "push deliver failed"),
            }
        });
    }

    Ok((hash_hex, n))
}
