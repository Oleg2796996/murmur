//! murmur-id-wasm — WASM bindings for murmur-id.
//!
//! Exposes the same envelope the Tauri commands use (`{ ok, data, error }`)
//! so the PWA frontend and the Tauri desktop share one calling convention.
//!
//! Private keys live in a `RefCell<Option<Vec<u8>>>` inside the wasm module.
//! They are produced by `identity_new()` and consumed by `sign_message`.
//!
//! Build:
//!   wasm-pack build crates/murmur-id-wasm --target web --release
//!
//! Outputs `pkg/murmur_id_wasm.js` + `pkg/murmur_id_wasm_bg.wasm`.

use serde::Serialize;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

use murmur_id::{Identity, IdentityPublic, SealedEnvelope};

/// JS-friendly result envelope, mirrors `murmur_mobile_lib::CmdResult<T>`.
#[derive(Debug, Serialize)]
pub struct JsCmdResult<T: Serialize> {
    pub ok: bool,
    pub data: Option<T>,
    pub error: Option<String>,
}

impl<T: Serialize> JsCmdResult<T> {
    pub fn ok(data: T) -> Self {
        Self { ok: true, data: Some(data), error: None }
    }
    pub fn err(e: impl std::fmt::Display) -> Self {
        Self { ok: false, data: None, error: Some(e.to_string()) }
    }
}

/// Convert a `JsCmdResult<T>` into a `JsValue` (raw string via linear memory).
/// We return a plain string (which wasm-bindgen marshals via the i32+length
/// path, NOT via externref) so the result works on browsers / runtimes where
/// the externref shim is broken (notably some iOS Safari builds). The JS
/// side does `JSON.parse(raw)`.
fn to_js<T: Serialize>(r: &JsCmdResult<T>) -> JsValue {
    #[derive(Serialize)]
    struct Out<'a, T: Serialize> {
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<&'a T>,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<&'a String>,
    }
    let out = Out { ok: r.ok, data: r.data.as_ref(), error: r.error.as_ref() };
    let s = serde_json::to_string(&out)
        .unwrap_or_else(|e| format!("{{\"ok\":false,\"error\":\"serialize: {e}\"}}"));
    // Allocate the string on the WASM linear heap and return an i32
    // pointer + length instead of using the externref path. The JS glue
    // produced by wasm-bindgen for String params uses i32 (pointer to
    // utf-8 bytes), which is universally supported.
    let bytes = s.into_bytes();
    let len = bytes.len() as u32;
    let ptr = bytes.as_ptr() as u32;
    std::mem::forget(bytes);
    let arr = js_sys::Array::new_with_length(2);
    arr.set(0, JsValue::from_f64(ptr as f64));
    arr.set(1, JsValue::from_f64(len as f64));
    arr.into()
}

/// Bundle of public-key material returned by `identity_new()`.
#[derive(Debug, Serialize)]
pub struct IdentityInfo {
    pub npub: String,
    pub signing_pubkey_hex: String,
    pub agreement_pubkey_hex: String,
    /// 32-byte seed, hex. Required for persistence across reloads via localStorage.
    /// Note: only safe in browser-only contexts. Production-grade crypto would
    /// use a hardware-backed keystore; PWA localStorage is "good enough" for this
    /// prototype.
    pub signing_sk_hex: String,
}

/// Private-key slot. Once `identity_new()` is called, the 32-byte seed
/// (sufficient to reconstruct an `Identity`) lives here until the page reloads.
/// Browser tab = wallet; closing the tab = losing the key.
thread_local! {
    static PRIVATE_KEY_BYTES: RefCell<Option<Vec<u8>>> = const { RefCell::new(None) };
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes { s.push_str(&format!("{:02x}", b)); }
    s
}

/// Generate a new murmur identity. Stores the postcard-serialized secret
/// internally so subsequent `sign_message` calls can use it.
#[wasm_bindgen]
pub fn identity_new() -> JsValue {
    // Generate a fresh identity using the OS RNG (getrandom on wasm32-unknown-unknown).
    let id = Identity::generate(&mut rand_core::OsRng);
    // Persist the postcard-serialized secret so sign_message can rebuild Identity.
    let secret_bytes = match id.to_bytes() {
        Ok(b) => b,
        Err(e) => return to_js(&JsCmdResult::<IdentityInfo>::err(format!("to_bytes: {e}"))),
    };
    let sk_hex = hex_lower(&secret_bytes);
    PRIVATE_KEY_BYTES.with(|cell| *cell.borrow_mut() = Some(secret_bytes));
    let pubkey = id.public();
    let info = IdentityInfo {
        npub: pubkey.npub(),
        signing_pubkey_hex: hex_lower(&pubkey.signing_pubkey()),
        agreement_pubkey_hex: hex_lower(&pubkey.agreement_pubkey()),
        signing_sk_hex: sk_hex,
    };
    to_js(&JsCmdResult::ok(info))
}

/// Restore a previously-generated identity from its full postcard-serialized bytes (hex-encoded).
/// Use the `signing_sk_hex` field returned by `identity_new()` — it contains the entire
/// private state (signing + agreement keys) needed to reconstruct the Identity.
/// Returns the same IdentityInfo as identity_new(), and primes the in-memory key
/// for subsequent sign_message calls.
#[wasm_bindgen]
pub fn identity_restore(sk_hex: String) -> JsValue {
    let bytes_vec: Vec<u8> = (0..sk_hex.len()).step_by(2)
        .filter_map(|i| u8::from_str_radix(&sk_hex[i..i + 2], 16).ok())
        .collect();
    if bytes_vec.is_empty() || sk_hex.len() % 2 != 0 {
        return to_js(&JsCmdResult::<IdentityInfo>::err(format!(
            "sk_hex must be valid hex, got {} chars", sk_hex.len()
        )));
    }
    let id = match Identity::from_bytes(&bytes_vec) {
        Ok(i) => i,
        Err(e) => return to_js(&JsCmdResult::<IdentityInfo>::err(format!("from_bytes: {e}"))),
    };
    PRIVATE_KEY_BYTES.with(|cell| *cell.borrow_mut() = Some(bytes_vec));
    let pubkey = id.public();
    let info = IdentityInfo {
        npub: pubkey.npub(),
        signing_pubkey_hex: hex_lower(&pubkey.signing_pubkey()),
        agreement_pubkey_hex: hex_lower(&pubkey.agreement_pubkey()),
        signing_sk_hex: sk_hex,
    };
    to_js(&JsCmdResult::ok(info))
}

/// Return the package version, used for cache-busting.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Smoke-test roundtrip: takes a UTF-8 string and returns it wrapped in a
/// `JsCmdResult<String>` so the JS side can verify the WASM module is wired
/// correctly. Cheap and useful for "is the IPC alive?" checks.
#[wasm_bindgen]
pub fn ping(msg: String) -> JsValue {
    to_js(&JsCmdResult::ok(msg))
}

/// Sign a UTF-8 message with the in-memory private key. Returns the 64-byte
/// Schnorr signature as a hex string.
#[wasm_bindgen]
pub fn sign_message(msg: String) -> JsValue {
    let seed_opt = PRIVATE_KEY_BYTES.with(|cell| cell.borrow().clone());
    let seed = match seed_opt {
        Some(s) => s,
        None => return to_js(&JsCmdResult::<String>::err("no identity — call identity_new() first")),
    };
    let id = match Identity::from_bytes(&seed) {
        Ok(i) => i,
        Err(e) => return to_js(&JsCmdResult::<String>::err(format!("from_bytes: {e}"))),
    };
    let sig = id.sign(msg.as_bytes());
    to_js(&JsCmdResult::ok(hex_lower(&sig)))
}

/// Sign a canonical envelope payload the way the relay's `Envelope::verify`
/// expects: SHA3-256(domain || npub_len || npub || payload_len || payload)
/// then ed25519 over that digest. PWA passes the JSON bytes it actually sent
/// (e.g. the `from|to|ts|ct` string), relay re-derives the same digest and
/// verifies — so the server can never tamper with `ct` without breaking the
/// signature.
#[wasm_bindgen]
pub fn sign_envelope(sender_npub: String, payload: Vec<u8>) -> JsValue {
    let seed_opt = PRIVATE_KEY_BYTES.with(|cell| cell.borrow().clone());
    let seed = match seed_opt {
        Some(s) => s,
        None => return to_js(&JsCmdResult::<String>::err("no identity — call identity_new() first")),
    };
    let id = match Identity::from_bytes(&seed) {
        Ok(i) => i,
        Err(e) => return to_js(&JsCmdResult::<String>::err(format!("from_bytes: {e}"))),
    };
    let input = murmur_transport::signature_input(&sender_npub, &payload);
    let sig = id.sign(&input);
    to_js(&JsCmdResult::ok(hex_lower(&sig)))
}

/// Resolve an npub to its 64-byte public-key bundle (signing + agreement),
/// hex-encoded. Useful for the JS side to display fingerprints.
#[wasm_bindgen]
pub fn npub_to_pubkey_hex(npub: String) -> JsValue {
    match IdentityPublic::from_npub(&npub) {
        Ok(p) => {
            let mut out = String::with_capacity(128);
            for b in p.signing_pubkey() {
                out.push_str(&format!("{:02x}", b));
            }
            for b in p.agreement_pubkey() {
                out.push_str(&format!("{:02x}", b));
            }
            to_js(&JsCmdResult::ok(out))
        }
        Err(e) => to_js(&JsCmdResult::<String>::err(e)),
    }
}

/// Forget the in-memory private key. After this call, `sign_message` returns
/// an error until `identity_new()` is invoked again.
#[wasm_bindgen]
pub fn clear_identity() {
    PRIVATE_KEY_BYTES.with(|cell| *cell.borrow_mut() = None);
}

// ============================================================================
// ECIES bindings (Олег 2026-08-24 11:00 MSK, E2E шифрование)
// ============================================================================
//
// JS-интерфейс:
//   encrypt_for_recipient(recipientNpub: string, plaintextBase64: string)
//     -> JsCmdResult<String>  // base64 sealed envelope (32+12+ct)
//
//   decrypt_envelope(sealedBase64: string)
//     -> JsCmdResult<String>  // base64 plaintext
//
// Plaintext может быть любым байтами (text, JSON, бинарь файла). Вход/выход — base64,
// потому что WASM<->JS граница лучше всего работает с ASCII-friendly форматами.
//
// Поток вызова:
//   let pt = JSON.stringify({body: "...", attachments: [...]})
//   let ptB64 = btoa(pt)
//   let sealed = encrypt_for_recipient(recipientNpub, ptB64)
//   // sealed.base64 шифрован — relay его не прочитает
//   sendToRelay(sealed.data)
//

/// ECIES-encrypt arbitrary bytes (base64 in/out) for a recipient identified by their npub.
///
/// Returns a base64-encoded `SealedEnvelope`:
///
///   [ephemeral_pubkey: 32 bytes][nonce: 12 bytes][ciphertext + 16-byte GCM tag]
///
/// Plaintext is opaque to the relay. Use for text bodies, JSON envelopes, file
/// blobs — up to ~50 MB on modern browsers before JS-side memory pressure.
#[wasm_bindgen]
pub fn encrypt_for_recipient(recipient_npub: String, plaintext_b64: String) -> JsValue {
    // 1. Get our identity from in-memory slot
    let seed_opt = PRIVATE_KEY_BYTES.with(|cell| cell.borrow().clone());
    let seed = match seed_opt {
        Some(s) => s,
        None => return to_js(&JsCmdResult::<String>::err("no identity — call identity_new() first")),
    };
    let me = match Identity::from_bytes(&seed) {
        Ok(i) => i,
        Err(e) => return to_js(&JsCmdResult::<String>::err(format!("from_bytes: {e}"))),
    };

    // 2. Parse recipient npub
    let recipient = match IdentityPublic::from_npub(&recipient_npub) {
        Ok(p) => p,
        Err(e) => return to_js(&JsCmdResult::<String>::err(format!("recipient npub: {e}"))),
    };

    // 3. Decode plaintext base64
    let plaintext = match base64_decode(&plaintext_b64) {
        Ok(v) => v,
        Err(e) => return to_js(&JsCmdResult::<String>::err(format!("plaintext base64: {e}"))),
    };

    // 4. ECIES encrypt
    let sealed = match me.ecies_encrypt(&mut rand_core::OsRng, &recipient, &plaintext) {
        Ok(s) => s,
        Err(e) => return to_js(&JsCmdResult::<String>::err(format!("ecies_encrypt: {e}"))),
    };

    // 5. Serialize sealed envelope and base64-encode for JS
    let bytes = sealed.to_bytes();
    let out_b64 = base64_encode(&bytes);
    to_js(&JsCmdResult::ok(out_b64))
}

/// ECIES-decrypt a sealed envelope (base64) produced by `encrypt_for_recipient`.
///
/// Returns the original plaintext as base64. The sender is anonymous in ECIES
/// (only ephemeral pubkey is known); sender authentication must come from the
/// outer envelope's ed25519 signature, not from ECIES.
#[wasm_bindgen]
pub fn decrypt_envelope(sealed_b64: String) -> JsValue {
    let seed_opt = PRIVATE_KEY_BYTES.with(|cell| cell.borrow().clone());
    let seed = match seed_opt {
        Some(s) => s,
        None => return to_js(&JsCmdResult::<String>::err("no identity — call identity_new() first")),
    };
    let me = match Identity::from_bytes(&seed) {
        Ok(i) => i,
        Err(e) => return to_js(&JsCmdResult::<String>::err(format!("from_bytes: {e}"))),
    };

    let sealed_bytes = match base64_decode(&sealed_b64) {
        Ok(v) => v,
        Err(e) => return to_js(&JsCmdResult::<String>::err(format!("sealed base64: {e}"))),
    };
    let sealed = match SealedEnvelope::from_bytes(&sealed_bytes) {
        Ok(s) => s,
        Err(e) => return to_js(&JsCmdResult::<String>::err(format!("sealed parse: {e}"))),
    };

    let plaintext = match me.ecies_decrypt(&sealed.ephemeral_pubkey, &sealed.nonce, &sealed.ciphertext) {
        Ok(p) => p,
        Err(e) => return to_js(&JsCmdResult::<String>::err(format!("ecies_decrypt: {e}"))),
    };

    let out_b64 = base64_encode(&plaintext);
    to_js(&JsCmdResult::ok(out_b64))
}

// ----- base64 helpers (Олег 2026-08-24 11:00 MSK) -----------------------------
// We avoid adding a `base64` crate dependency; for WASM payload we use a simple
// implementation that's good enough for binary blobs. browser.atob / btoa is
// available in JS — these helpers let the PWA call encrypt_for_recipient with
// either base64 or hex if it wants. We use base64 throughout for compactness.

fn base64_encode(bytes: &[u8]) -> String {
    // RFC 4648 base64 (standard alphabet, with padding).
    const ALPHA: &[u8; 64] =
        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(((bytes.len() + 2) / 3) * 4);
    let mut i = 0;
    while i + 3 <= bytes.len() {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8) | (bytes[i + 2] as u32);
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
        out.push(ALPHA[(n & 0x3f) as usize] as char);
        i += 3;
    }
    let rem = bytes.len() - i;
    if rem == 1 {
        let n = (bytes[i] as u32) << 16;
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push('=');
        out.push('=');
    } else if rem == 2 {
        let n = ((bytes[i] as u32) << 16) | ((bytes[i + 1] as u32) << 8);
        out.push(ALPHA[((n >> 18) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 12) & 0x3f) as usize] as char);
        out.push(ALPHA[((n >> 6) & 0x3f) as usize] as char);
        out.push('=');
    }
    out
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    fn val(c: u8) -> Result<u32, String> {
        match c {
            b'A'..=b'Z' => Ok((c - b'A') as u32),
            b'a'..=b'z' => Ok(26 + (c - b'a') as u32),
            b'0'..=b'9' => Ok(52 + (c - b'0') as u32),
            b'+' => Ok(62),
            b'/' => Ok(63),
            b'=' => Ok(0), // padding (ignored)
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

#[wasm_bindgen(start)]
pub fn _start() {
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("[murmur-id-wasm panic] {info}");
        web_sys::console::error_1(&JsValue::from_str(&msg));
    }));
}
