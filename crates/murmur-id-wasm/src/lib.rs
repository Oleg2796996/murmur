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

use getrandom::getrandom;
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

/// Generate a new murmur identity. Stores the private seed internally so
/// subsequent `sign_message` calls can use it.
#[wasm_bindgen]
pub fn identity_new() -> JsValue {
    let mut bytes = [0u8; 32];
    if let Err(e) = getrandom(&mut bytes) {
        return to_js(&JsCmdResult::<IdentityInfo>::err(format!("getrandom: {e}")));
    }
    // Store the seed BEFORE building Identity so sign_message can rebuild.
    PRIVATE_KEY_BYTES.with(|cell| *cell.borrow_mut() = Some(bytes.to_vec()));
    let id = match Identity::from_bytes(&bytes) {
        Ok(i) => i,
        Err(e) => return to_js(&JsCmdResult::<IdentityInfo>::err(format!("from_bytes: {e}"))),
    };
    let pubkey = id.public();
    let info = IdentityInfo {
        npub: pubkey.npub(),
        signing_pubkey_hex: hex_lower(&pubkey.signing_pubkey()),
        agreement_pubkey_hex: hex_lower(&pubkey.agreement_pubkey()),
    };
    to_js(&JsCmdResult::ok(info))
}

/// Return the package version, used for cache-busting.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
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
