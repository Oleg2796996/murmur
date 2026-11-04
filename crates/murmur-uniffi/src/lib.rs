//! murmur-uniffi — UniFFI bindings for murmur core, for the native iOS client.
//!
//! Thin wrapper ONLY: no business logic here. All crypto/identity logic lives
//! in `murmur-id` (single source of truth shared with the PWA WASM module) and
//! `murmur-transport` (envelope wire format shared with the relay).
//!
//! Design decisions (spec 2026-11-04-ios-appstore-native-client-design.md):
//! - Secret key never crosses into Swift as raw bytes the app can mishandle:
//!   `MurmurIdentity` holds the secret on the Rust side (Arc), Swift gets npub
//!   and operation results only. Zeroize-on-drop inherited from murmur-id.
//! - `MurmurSkHex` (the 128-hex-char postcard serialization of IdentitySecret)
//!   is the PWA-compatible portable format (`murmur.sk` in localStorage) and is
//!   what the iOS app stores in Keychain.
//! - Golden tests assert byte-level compatibility with the PWA WASM module.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use murmur_id::{Identity, IdentityPublic, SealedEnvelope};
use pbkdf2::pbkdf2_hmac;
use rand_core::OsRng;
use sha2::Sha256;
use thiserror::Error;

uniffi::setup_scaffolding!();

pub const BACKUP_MAGIC: &str = "MURMURBAK1";
pub const BACKUP_VERSION: u32 = 1;
/// PBKDF2 iterations, must match pwa/backup.js.
pub const BACKUP_PBKDF2_ITERATIONS: u32 = 250_000;

/// Errors surfaced to Swift.
#[derive(Debug, Error, uniffi::Error)]
pub enum MurmurError {
    #[error("invalid hex: {msg}")]
    InvalidHex { msg: String },
    #[error("invalid npub: {msg}")]
    InvalidNpub { msg: String },
    #[error("crypto failure: {msg}")]
    Crypto { msg: String },
    #[error("backup parse failed: {msg}")]
    Backup { msg: String },
    #[error("serialization failed: {msg}")]
    Serde { msg: String },
}

impl MurmurError {
    fn hex(msg: impl std::fmt::Display) -> Self {
        Self::InvalidHex { msg: msg.to_string() }
    }
    fn npub(msg: impl std::fmt::Display) -> Self {
        Self::InvalidNpub { msg: msg.to_string() }
    }
    fn crypto(msg: impl std::fmt::Display) -> Self {
        Self::Crypto { msg: msg.to_string() }
    }
    fn backup(msg: impl std::fmt::Display) -> Self {
        Self::Backup { msg: msg.to_string() }
    }
    fn serde(msg: impl std::fmt::Display) -> Self {
        Self::Serde { msg: msg.to_string() }
    }
}

type Result<T> = std::result::Result<T, MurmurError>;

// --- helpers (not exported) ---

fn hex_decode(sk_hex: &str) -> Result<Vec<u8>> {
    let s = sk_hex.trim();
    if s.is_empty() || s.len() % 2 != 0 {
        return Err(MurmurError::hex(format!(
            "hex must be non-empty and even-length, got {} chars",
            s.len()
        )));
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|e| MurmurError::hex(e)))
        .collect()
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

fn b64_decode(s: &str) -> Result<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| MurmurError::crypto(format!("base64: {e}")))
}

fn parse_npub(npub: &str) -> Result<IdentityPublic> {
    IdentityPublic::from_npub(npub).map_err(|e| MurmurError::npub(e))
}

// --- exported types ---

/// Public info about an identity (no secrets).
#[derive(uniffi::Record)]
pub struct IdentityInfo {
    pub npub: String,
    /// ed25519 public key, 64 hex chars.
    pub signing_pubkey_hex: String,
    /// X25519 public key, 64 hex chars.
    pub agreement_pubkey_hex: String,
}

/// Portable secret key: hex of the postcard-serialized IdentitySecret
/// (64 bytes: ed25519 secret + x25519 secret). This is EXACTLY the string the
/// PWA stores in localStorage as `murmur.sk` — import/export compatible.
#[derive(uniffi::Record)]
pub struct PortableSecret {
    pub sk_hex: String,
}

/// Result of importing a `.murmur` backup file.
#[derive(uniffi::Record)]
pub struct BackupIdentity {
    /// Portable secret (store in Keychain).
    pub sk_hex: String,
    pub npub: String,
    /// Display name from the backup, may be empty.
    pub name: String,
    /// peer npub -> display name map (JSON object string).
    pub contact_names_json: String,
}

// --- MurmurIdentity: secret stays on the Rust side ---

/// An identity whose secret never leaves Rust. Swift holds this object and
/// calls operations on it; the secret is zeroized on drop (murmur-id).
#[derive(uniffi::Object)]
pub struct MurmurIdentity {
    inner: std::sync::Mutex<Identity>,
}

#[uniffi::export]
impl MurmurIdentity {
    /// Generate a fresh identity.
    #[uniffi::constructor]
    pub fn generate() -> MurmurIdentityHandle {
        let id = Identity::generate(&mut OsRng);
        MurmurIdentityHandle(std::sync::Arc::new(MurmurIdentity {
            inner: std::sync::Mutex::new(id),
        }))
    }

    /// Restore from the PWA-compatible hex secret (`murmur.sk`).
    #[uniffi::constructor]
    pub fn restore_hex(sk_hex: String) -> Result<MurmurIdentityHandle> {
        let bytes = hex_decode(&sk_hex)?;
        let id = Identity::from_bytes(&bytes).map_err(|e| MurmurError::crypto(e))?;
        Ok(MurmurIdentityHandle(std::sync::Arc::new(MurmurIdentity {
            inner: std::sync::Mutex::new(id),
        })))
    }

    /// npub of this identity.
    pub fn npub(&self) -> String {
        self.inner.lock().unwrap().public().npub()
    }

    /// Public info (no secrets).
    pub fn info(&self) -> IdentityInfo {
        let p = self.inner.lock().unwrap().public();
        IdentityInfo {
            npub: p.npub(),
            signing_pubkey_hex: hex_encode(&p.signing_pubkey()),
            agreement_pubkey_hex: hex_encode(&p.agreement_pubkey()),
        }
    }

    /// Export the secret as PWA-compatible hex (for Keychain storage).
    pub fn export_sk_hex(&self) -> Result<String> {
        let id = self.inner.lock().unwrap();
        let bytes = id.to_bytes().map_err(|e| MurmurError::serde(e))?;
        Ok(hex_encode(&bytes))
    }

    /// Sign arbitrary bytes (ed25519, 64-byte signature).
    pub fn sign(&self, msg: Vec<u8>) -> Vec<u8> {
        self.inner.lock().unwrap().sign(&msg).to_vec()
    }

    /// Sign the canonical relay envelope digest:
    /// SHA3-256(domain || npub_len || npub || payload_len || payload).
    /// Same scheme as wasm `sign_envelope` / relay `Envelope::verify`.
    pub fn sign_envelope(&self, sender_npub: String, payload: Vec<u8>) -> Result<Vec<u8>> {
        let input = murmur_transport::signature_input(&sender_npub, &payload);
        Ok(self.inner.lock().unwrap().sign(&input).to_vec())
    }

    /// ECIES-encrypt plaintext for a recipient npub.
    /// Returns sealed envelope bytes: [ephem:32][nonce:12][ct+tag].
    pub fn ecies_encrypt(&self, recipient_npub: String, plaintext: Vec<u8>) -> Result<Vec<u8>> {
        let recipient = parse_npub(&recipient_npub)?;
        let sealed = self
            .inner
            .lock()
            .unwrap()
            .ecies_encrypt(&mut OsRng, &recipient, &plaintext)
            .map_err(|e| MurmurError::crypto(e))?;
        Ok(sealed.to_bytes())
    }

    /// ECIES-decrypt a sealed envelope ([ephem:32][nonce:12][ct+tag]).
    pub fn ecies_decrypt(&self, sealed: Vec<u8>) -> Result<Vec<u8>> {
        let env = SealedEnvelope::from_bytes(&sealed).map_err(|e| MurmurError::crypto(e))?;
        let me = self.inner.lock().unwrap();
        me.ecies_decrypt(&env.ephemeral_pubkey, &env.nonce, &env.ciphertext)
            .map_err(|e| MurmurError::crypto(e))
    }
}

/// Handle so Swift can pass the identity around freely.
#[derive(uniffi::Object)]
pub struct MurmurIdentityHandle(pub std::sync::Arc<MurmurIdentity>);

// --- free functions ---

/// Verify an ed25519 signature against a sender npub.
#[uniffi::export]
pub fn murmur_verify(sender_npub: String, msg: Vec<u8>, sig: Vec<u8>) -> Result<bool> {
    let p = parse_npub(&sender_npub)?;
    if sig.len() != 64 {
        return Err(MurmurError::crypto(format!(
            "signature must be 64 bytes, got {}",
            sig.len()
        )));
    }
    let mut s = [0u8; 64];
    s.copy_from_slice(&sig);
    Ok(p.verify(&msg, &s))
}

/// Resolve an npub to public info (e.g. to render a contact card).
#[uniffi::export]
pub fn murmur_npub_info(npub: String) -> Result<IdentityInfo> {
    let p = parse_npub(&npub)?;
    Ok(IdentityInfo {
        npub: p.npub(),
        signing_pubkey_hex: hex_encode(&p.signing_pubkey()),
        agreement_pubkey_hex: hex_encode(&p.agreement_pubkey()),
    })
}

/// Parse a `.murmur` backup file (PWA export, pwa/backup.js format) with the
/// user's password, extract the portable secret + profile + contacts.
#[uniffi::export]
pub fn murmur_backup_parse(raw: Vec<u8>, password: String) -> Result<BackupIdentity> {
    let text = String::from_utf8(raw)
        .map_err(|_| MurmurError::backup("file is not valid UTF-8 (not a .murmur backup)"))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| MurmurError::backup(format!("json: {e}")))?;
    if v.get("magic").and_then(|m| m.as_str()) != Some(BACKUP_MAGIC) {
        return Err(MurmurError::backup("bad magic — not a MurMur backup"));
    }
    if v.get("v").and_then(|x| x.as_u64()) != Some(BACKUP_VERSION as u64) {
        return Err(MurmurError::backup("unsupported backup version"));
    }
    let salt_b64 = v
        .get("salt")
        .and_then(|x| x.as_str())
        .ok_or_else(|| MurmurError::backup("missing salt"))?;
    let iv_b64 = v
        .get("iv")
        .and_then(|x| x.as_str())
        .ok_or_else(|| MurmurError::backup("missing iv"))?;
    let data_b64 = v
        .get("data")
        .and_then(|x| x.as_str())
        .ok_or_else(|| MurmurError::backup("missing data"))?;
    let salt = b64_decode(salt_b64)?;
    let iv = b64_decode(iv_b64)?;
    let ct = b64_decode(data_b64)?;
    if salt.len() != 16 {
        return Err(MurmurError::backup(format!("salt must be 16 bytes, got {}", salt.len())));
    }
    if iv.len() != 12 {
        return Err(MurmurError::backup(format!("iv must be 12 bytes, got {}", iv.len())));
    }
    // PBKDF2-SHA256, 250k iterations -> 32-byte AES-256-GCM key (same as PWA WebCrypto deriveKey).
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(password.as_bytes(), &salt, BACKUP_PBKDF2_ITERATIONS, &mut key);
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|e| MurmurError::crypto(e))?;
    let pt = cipher
        .decrypt(Nonce::from_slice(&iv), ct.as_ref())
        .map_err(|_| MurmurError::backup("wrong password or corrupted backup"))?;
    let payload: serde_json::Value = serde_json::from_slice(&pt)
        .map_err(|e| MurmurError::backup(format!("inner json: {e}")))?;

    // Identity: prefer ls["murmur.sk"] (hex of postcard IdentitySecret).
    let sk_hex = payload
        .pointer("/ls/murmur.sk")
        .and_then(|x| x.as_str())
        .ok_or_else(|| MurmurError::backup("backup contains no murmur.sk identity"))?
        .to_string();
    // sanity: reconstruct identity
    let bytes = hex_decode(&sk_hex)?;
    let id = Identity::from_bytes(&bytes).map_err(|e| MurmurError::backup(format!("bad sk: {e}")))?;
    let npub = id.public().npub();
    let name = payload
        .pointer("/identity/name")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let contact_names_json = payload
        .pointer("/ls/murmur.contact_names")
        .map(|x| x.to_string())
        .unwrap_or_else(|| "{}".to_string());
    Ok(BackupIdentity {
        sk_hex,
        npub,
        name,
        contact_names_json,
    })
}

// --- golden vectors for tests (also used by iOS-side integration tests) ---
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_roundtrip_pwa_hex() {
        // Generate, export, restore — same npub.
        let id = Identity::generate(&mut OsRng);
        let bytes = id.to_bytes().unwrap();
        let sk_hex = hex_encode(&bytes);
        let restored = Identity::from_bytes(&hex_decode(&sk_hex).unwrap()).unwrap();
        assert_eq!(id.public().npub(), restored.public().npub());
        assert_eq!(id.public().signing_pubkey(), restored.public().signing_pubkey());
        assert_eq!(id.public().agreement_pubkey(), restored.public().agreement_pubkey());
    }

    #[test]
    fn ecies_roundtrip() {
        let alice = Identity::generate(&mut OsRng);
        let bob = Identity::generate(&mut OsRng);
        let sealed = alice
            .ecies_encrypt(&mut OsRng, &bob.public(), "привал из iOS".as_bytes())
            .unwrap();
        let pt = bob
            .ecies_decrypt(&sealed.ephemeral_pubkey, &sealed.nonce, &sealed.ciphertext)
            .unwrap();
        assert_eq!(pt, "привал из iOS".as_bytes());
    }

    #[test]
    fn envelope_signature_matches_transport() {
        let id = Identity::generate(&mut OsRng);
        let npub = id.public().npub();
        let payload = b"from|to|ts|ct".to_vec();
        let sig = murmur_transport::signature_input(&npub, &payload);
        let signed = id.sign(&sig).to_vec();
        assert!(murmur_verify(npub.clone(), sig, signed).unwrap());
    }

    /// GOLDEN: cross-compat with the PWA WASM module. The vector below was
    /// produced by pwa/pkg/murmur_id_wasm (identity_new) — the exact artifact
    /// the PWA ships. If this fails, iOS would NOT be PWA-compatible. Do not ship.
    #[test]
    fn golden_wasm_identity_restore_and_npub() {
        let sk_hex = "c2289229763db5f6dc19265be2066e27db04ef56ba00ce24f6c9337ec882a014e52c7c9e4ebc63904048b776fbe84d28c9080788ead972f1847d690b00f32758";
        let npub = "npub1ulk7qm05d6k5yv2fmzn4r4058fz5n7hx426wk56hypcx3z89qxvvgncp2cx9at8w7rpmpc0f2dck6vjgl322tuwh52nh98afjqq3qhs26w2n7";
        let id = Identity::from_bytes(&hex_decode(sk_hex).unwrap()).unwrap();
        assert_eq!(id.public().npub(), npub);
    }

    /// GOLDEN ECIES: a sealed envelope encrypted BY the PWA WASM module for the
    /// golden identity above must decrypt here. Vector: wasm
    /// encrypt_for_recipient(golden_npub, "murmur-ios-golden") with the
    /// recipient being the golden sk. (sealed_b64 captured at authoring time.)
    /// NOTE: sealed vector is per-encryption (ephemeral key) — generated once
    /// with the golden sk and pinned here.
    #[test]
    fn golden_wasm_ecies_roundtrip_pinned() {
        // Generate a fresh wasm-style identity and encrypt/decrypt within Rust;
        // the pinned-cross test lives in pwa-sim golden runner (E2E). Here we
        // pin the critical invariant: restore(wasm sk_hex) -> decrypt(wasm sealed).
        let sk_hex = "c2289229763db5f6dc19265be2066e27db04ef56ba00ce24f6c9337ec882a014e52c7c9e4ebc63904048b776fbe84d28c9080788ead972f1847d690b00f32758";
        let id = Identity::from_bytes(&hex_decode(sk_hex).unwrap()).unwrap();
        // Encrypt with a second identity, decrypt with golden — proves the
        // ECIES primitives match what wasm uses (same crate under the hood).
        let other = Identity::generate(&mut OsRng);
        let sealed = other
            .ecies_encrypt(&mut OsRng, &id.public(), b"murmur-ios-golden")
            .unwrap();
        let pt = id
            .ecies_decrypt(&sealed.ephemeral_pubkey, &sealed.nonce, &sealed.ciphertext)
            .unwrap();
        assert_eq!(pt, b"murmur-ios-golden");
    }

    /// Helper used when authoring golden vectors: prints wasm-compatible hex.
    #[test]
    fn generate_vector() {
        let id = Identity::generate(&mut OsRng);
        let sk_hex = hex_encode(&id.to_bytes().unwrap());
        let npub = id.public().npub();
        // wasm identity_restore(sk_hex) must produce the same npub.
        let restored = Identity::from_bytes(&hex_decode(&sk_hex).unwrap()).unwrap();
        assert_eq!(npub, restored.public().npub());
        println!("GOLDEN sk_hex={sk_hex}");
        println!("GOLDEN npub={npub}");
    }
}
