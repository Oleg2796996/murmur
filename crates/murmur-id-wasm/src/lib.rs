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

use rand_core::OsRng;
use serde::Serialize;
use std::cell::RefCell;
use wasm_bindgen::prelude::*;

use murmur_id::{Identity, IdentityPublic};

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

/// Convert a `JsCmdResult<T>` into a `JsValue` (plain JS object).
fn to_js<T: Serialize>(r: &JsCmdResult<T>) -> JsValue {
    serde_wasm_bindgen::to_value(r).unwrap_or_else(|e| {
        JsValue::from_str(&format!("serialization error: {e}"))
    })
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

#[wasm_bindgen(start)]
pub fn _start() {
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("[murmur-id-wasm panic] {info}");
        web_sys::console::error_1(&JsValue::from_str(&msg));
    }));
}
