//! murmur-id-wasm — WASM bindings for murmur-id.
//!
//! Exposes the same envelope the Tauri commands use (`{ ok, data, error }`)
//! so the PWA frontend and the Tauri desktop share one calling convention.
//!
//! Build:
//!   wasm-pack build crates/murmur-id-wasm --target web --release
//!
//! Outputs `pkg/murmur_id_wasm.js` + `pkg/murmur_id_wasm_bg.wasm`.

use getrandom::getrandom;
use serde::Serialize;
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

/// Generate a new murmur identity.
/// Returns the bech32 `npub1...` string (Nostr-compatible visual format).
#[wasm_bindgen]
pub fn identity_new() -> JsValue {
    let mut bytes = [0u8; 32];
    if let Err(e) = getrandom(&mut bytes) {
        return to_js(&JsCmdResult::<String>::err(format!("getrandom: {e}")));
    }
    use rand_chacha::rand_core::SeedableRng;
    use rand_chacha::ChaCha20Rng;
    let mut rng = ChaCha20Rng::from_seed(bytes);
    let id = Identity::generate(&mut rng);
    to_js(&JsCmdResult::ok(id.public().npub()))
}

/// Return the package version, used for cache-busting.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Sign a UTF-8 message. Private keys are not yet held in PWA; this is a
/// placeholder that returns an explanatory error. Step 9b will wire this
/// through `murmur-id::Identity::sign`.
#[wasm_bindgen]
pub fn sign_message(_npub: String, _msg: String) -> JsValue {
    to_js(&JsCmdResult::<String>::err(
        "sign_message: private keys not yet held in PWA (Step 9b)",
    ))
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

#[wasm_bindgen(start)]
pub fn _start() {
    // Logging hook for debugging — surface panics to the JS console.
    std::panic::set_hook(Box::new(|info| {
        let msg = format!("[murmur-id-wasm panic] {info}");
        web_sys::console::error_1(&JsValue::from_str(&msg));
    }));
}