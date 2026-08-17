//! Shared envelope acceptance logic.
//!
//! Used by both the iroh-direct server (`iroh_server.rs`) and the HTTP
//! `/envelope` endpoint (in `push.rs`) so the validation/persistence/fanout
//! pipeline is identical for any sender transport.

use crate::pending::{PendingEntry, PendingStore};
use crate::push::PushServer;
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
    /// True when the envelope came from the JSON path. JSON envelopes are
    /// verified end-to-end by the recipient; the relay only does signature
    /// checks on native (postcard) envelopes.
    json_path: bool,
}

/// Try to interpret `bytes` as one of:
///   - postcard-encoded `murmur_transport::Envelope` (native callers)
///   - our JSON wrapper produced by `handle_post_envelope` for browsers
fn parse_env(bytes: &[u8]) -> Result<ParsedEnv, String> {
    // Try JSON first — browsers PWA sends `{from,to,body,sig,ts}` and *not*
    // a postcard envelope. If we tried postcard first, postcard's varint
    // decoding would happily chew up a JSON object and produce garbage in
    // every field (especially `sender_npub`), causing bech32 parser to
    // fail with "missing separator".
    //
    // Detection: a JSON object starts with `{`. We only attempt JSON when
    // the byte is `{` so we avoid double-parsing binary frames.
    if bytes.first() == Some(&b'{') {
        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(bytes) {
            // Accept either the `{from,to,body,sig,ts}` flat form (browser
            // style) or the wrapped `{_kind:"json_envelope", payload:{...}}`
            // native form.
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
        // Fall through to postcard; JSON parse failed.
    }
    // Postcard (native callers).
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
/// Validates the signature against the embedded `sender_npub` when one is
/// present, persists to the pending log, broadcasts to subscribed WebSocket
/// clients, and fires off web-push delivery.
///
/// Returns `(envelope_hash_hex, broadcast_count)` on success, `Err(String)`
/// with the rejection reason otherwise.
pub fn accept_envelope(
    alias: String,
    env_bytes: Vec<u8>,
    pending: &PendingStore,
    hub: &SubscriberHub,
    push: Option<&Arc<PushServer>>,
) -> Result<(String, usize), String> {
    // 1. Parse envelope (postcard or JSON).
    let parsed = parse_env(&env_bytes)?;

    // 2. Verify signature when present (postcard path). JSON path: signature
    //    is best-effort and not cryptographically verified at the relay; the
    //    recipient verifies it after fanout.
    if !parsed.json_path && !parsed.signature.is_empty() {
        let claimed_sender = IdentityPublic::from_npub(&parsed.sender_npub)
            .map_err(|e| format!("bad sender_npub: {e}"))?;
        // Reconstruct an Envelope for `verify()` — we don't have the original
        // struct, so build a synthetic one with the parsed fields.
        let env = Envelope {
            sender_npub: parsed.sender_npub.clone(),
            payload: parsed.payload.clone(),
            signature: parsed.signature.clone(),
        };
        env.verify(&claimed_sender)
            .map_err(|_| "signature invalid".to_string())?;
    }

    // 3. Hash the inner payload (not the signed envelope, to keep hash stable
    //    across re-signatures).
    let mut hasher = Sha3_256::new();
    hasher.update(&parsed.payload);
    let hash_hex = hex::encode(hasher.finalize());

    let entry = PendingEntry {
        to_alias: alias.clone(),
        from_npub: parsed.sender_npub.clone(),
        ts: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0),
        envelope_bytes: env_bytes,
        envelope_hash_hex: hash_hex.clone(),
    };

    if let Err(e) = pending.append(&entry) {
        error!(err=%e, "pending.append failed");
        return Err(format!("pending.append: {e}"));
    }

    let n = hub.broadcast(&entry);
    info!(alias=%alias, hash=%hash_hex, subs=n, "envelope accepted + fanout");

    // Push delivery (fire-and-forget on a tokio task).
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
