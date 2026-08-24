//! murmur-id — Identity layer
//!
//! Step 1: minimal viable identity.
//!
//! Composition of an `Identity`:
//! - **Signing key:** ed25519 (long-term, used for message signatures and the
//!   public-facing identity `npub`).
//! - **Agreement key:** X25519 (used for ECDH, future X3DH-style key agreement).
//!
//! Wire format: `postcard` (compact, deterministic, versioned).
//! Human format: bech32 (`npub1...`) for the public identity — Nostr-compatible
//! visual identity but with murmur's own hrp ("npub") purely for ergonomics.
//!
//! Security invariants:
//! - Identities are **deterministic-derivable** from the 32-byte seed (ed25519
//!   signing key) plus the 32-byte X25519 secret. No hidden state, no padding.
//! - Secret keys are zeroized on drop.
//! - Signatures are deterministic (ed25519-dalek default).
//! - `npub` packs signing + agreement keys (64 bytes) into bech32 with hrp "npub".

#![forbid(unsafe_code)]
#![warn(missing_docs)]

use bech32::{self, ToBase32};
use ed25519_dalek::{
    Signature, Signer, SigningKey, Verifier, VerifyingKey, SECRET_KEY_LENGTH,
};
use rand_core::{CryptoRng, RngCore};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use x25519_dalek::{PublicKey as X25519Public, StaticSecret as X25519Secret};
use zeroize::{Zeroize, ZeroizeOnDrop};

// ECIES (Олег 2026-08-24 11:00 MSK): X25519 ECDH + HKDF-SHA256 + AES-256-GCM
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use hkdf::Hkdf;
use sha2::Sha256;

/// bech32 human-readable part for murmur signing public keys.
pub const NOSTR_HRP: &str = "npub";

/// Size of an ed25519 signing key (private).
pub const SIGNING_SECRET_LEN: usize = SECRET_KEY_LENGTH;
/// Size of an ed25519 verifying key (public).
pub const SIGNING_PUBLIC_LEN: usize = 32;
/// Size of an X25519 secret key.
pub const AGREEMENT_SECRET_LEN: usize = 32;
/// Size of an X25519 public key.
pub const AGREEMENT_PUBLIC_LEN: usize = 32;

/// Errors that can arise in identity operations.
#[derive(Debug, Error)]
pub enum IdentityError {
    /// Failed to (de)serialize — corrupt or truncated bytes.
    #[error("serialization error: {0}")]
    Serde(#[from] postcard::Error),
    /// bech32 decoding failed — input is not a valid npub.
    #[error("bech32 decode error: {0}")]
    Bech32(#[from] bech32::Error),
    /// ed25519 keys derived from bytes are invalid (e.g., not on the curve).
    #[error("invalid key bytes: {0}")]
    InvalidKey(String),
    /// ECIES encrypt/decrypt failed (bad tag, HKDF error, malformed input).
    #[error("ecies error: {0}")]
    Ecies(String),
}

/// On-disk / on-wire representation of an identity (secret half).
///
/// Layout (postcard):
/// ```text
/// [ed25519 secret: 32 bytes]
/// [x25519 secret:  32 bytes]
/// ```
#[derive(Clone, Serialize, Deserialize, Zeroize, ZeroizeOnDrop)]
struct IdentitySecret {
    /// ed25519 signing secret (32 bytes).
    signing: [u8; SECRET_KEY_LENGTH],
    /// X25519 agreement secret (32 bytes).
    agreement: [u8; AGREEMENT_SECRET_LEN],
}

/// Public identity (no secrets). Safe to share, broadcast, store in address book.
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct IdentityPublic {
    signing_pub: [u8; SIGNING_PUBLIC_LEN],
    agreement_pub: [u8; AGREEMENT_PUBLIC_LEN],
}

impl IdentityPublic {
    /// Build a public identity from raw bytes.
    pub fn from_public_bytes(
        signing_pub: [u8; SIGNING_PUBLIC_LEN],
        agreement_pub: [u8; AGREEMENT_PUBLIC_LEN],
    ) -> Self {
        Self {
            signing_pub,
            agreement_pub,
        }
    }

    /// Recover the public identity from a bech32 `npub1...` string.
    pub fn from_npub(s: &str) -> Result<Self, IdentityError> {
        let (hrp, data, variant) = match bech32::decode(s) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("from_npub: bech32::decode failed: s.len={}, s[..30]={:?}, err={:?}", s.len(), &s.chars().take(30).collect::<String>(), e);
                return Err(IdentityError::InvalidKey(format!("bech32 decode error: {e}")));
            }
        };
        eprintln!("from_npub: hrp={}, data.len={}, variant={:?}, s.len={}", hrp, data.len(), variant, s.len());
        if hrp != NOSTR_HRP {
            return Err(IdentityError::InvalidKey(format!(
                "expected hrp {NOSTR_HRP}, got {hrp}"
            )));
        }
        // bech32 may strip trailing zero-padding from 5-bit groups, so accept
        // anywhere in 103..=104 (64 bytes packed = 102.4 5-bit groups → encoded as 104).
        if data.len() < 103 || data.len() > 104 {
            return Err(IdentityError::InvalidKey(format!(
                "expected ~104 5-bit groups (64 bytes packed), got {}",
                data.len()
            )));
        }
        let mut bytes = [0u8; 64];
        let mut acc: u32 = 0;
        let mut bits: u32 = 0;
        let mut out_idx = 0;
        for g in &data {
            if out_idx >= 64 {
                break;
            }
            acc = (acc << 5) | u32::from(g.to_u8());
            bits += 5;
            if bits >= 8 {
                bits -= 8;
                bytes[out_idx] = ((acc >> bits) & 0xff) as u8;
                out_idx += 1;
            }
        }
        if out_idx != 64 {
            return Err(IdentityError::InvalidKey(format!(
                "5→8 bit conversion produced {out_idx} bytes, expected 64"
            )));
        }
        let mut signing_pub = [0u8; SIGNING_PUBLIC_LEN];
        let mut agreement_pub = [0u8; AGREEMENT_PUBLIC_LEN];
        signing_pub.copy_from_slice(&bytes[..32]);
        agreement_pub.copy_from_slice(&bytes[32..]);
        Ok(Self {
            signing_pub,
            agreement_pub,
        })
    }

    /// Encode as `npub1...` bech32. Packs signing + agreement (64 bytes total).
    pub fn npub(&self) -> String {
        let mut combined = [0u8; 64];
        combined[..32].copy_from_slice(&self.signing_pub);
        combined[32..].copy_from_slice(&self.agreement_pub);
        bech32::encode(NOSTR_HRP, combined.to_base32(), bech32::Variant::Bech32)
            .expect("bech32 encode")
    }

    /// ed25519 verifying key (32 bytes).
    pub fn signing_pubkey(&self) -> [u8; SIGNING_PUBLIC_LEN] {
        self.signing_pub
    }

    /// X25519 public key (32 bytes).
    pub fn agreement_pubkey(&self) -> [u8; AGREEMENT_PUBLIC_LEN] {
        self.agreement_pub
    }

    /// Verify an ed25519 signature against this public key.
    ///
    /// Returns `false` on any decoding error (malformed signature, bad key).
    pub fn verify(&self, msg: &[u8], sig_bytes: &[u8; 64]) -> bool {
        use ed25519_dalek::{Signature, Verifier, VerifyingKey};
        let verifying = match VerifyingKey::from_bytes(&self.signing_pub) {
            Ok(v) => v,
            Err(_) => return false,
        };
        let sig = match Signature::from_slice(sig_bytes) {
            Ok(s) => s,
            Err(_) => return false,
        };
        verifying.verify(msg, &sig).is_ok()
    }
}

/// The full identity: secrets + derived public keys.
#[derive(Clone)]
pub struct Identity {
    secret: IdentitySecret,
    public: IdentityPublic,
}

impl Identity {
    /// Generate a new identity from a cryptographically-secure RNG.
    pub fn generate<R: RngCore + CryptoRng>(rng: &mut R) -> Self {
        let mut signing = [0u8; SECRET_KEY_LENGTH];
        rng.fill_bytes(&mut signing);
        let mut agreement = [0u8; AGREEMENT_SECRET_LEN];
        rng.fill_bytes(&mut agreement);

        let signing_key = SigningKey::from_bytes(&signing);
        let verifying = signing_key.verifying_key();

        let secret = IdentitySecret { signing, agreement };
        let public = {
            let agreement_secret = X25519Secret::from(agreement);
            let pub_key = X25519Public::from(&agreement_secret);
            IdentityPublic {
                signing_pub: verifying.to_bytes(),
                agreement_pub: *pub_key.as_bytes(),
            }
        };

        Self { secret, public }
    }

    /// Postcard-serialize the secret half.
    pub fn to_bytes(&self) -> Result<Vec<u8>, IdentityError> {
        Ok(postcard::to_stdvec(&self.secret)?)
    }

    /// Deserialize from postcard bytes (the secret half).
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, IdentityError> {
        let secret: IdentitySecret = postcard::from_bytes(bytes)?;
        let signing_key = SigningKey::from_bytes(&secret.signing);
        let verifying = signing_key.verifying_key();
        let agreement_secret = X25519Secret::from(secret.agreement);
        let agreement_pub = X25519Public::from(&agreement_secret);
        let public = IdentityPublic {
            signing_pub: verifying.to_bytes(),
            agreement_pub: *agreement_pub.as_bytes(),
        };
        Ok(Self { secret, public })
    }

    /// Public identity (no secrets).
    pub fn public(&self) -> IdentityPublic {
        self.public
    }

    /// Sign a message with the ed25519 key. Returns a 64-byte signature.
    pub fn sign(&self, msg: &[u8]) -> [u8; 64] {
        let signing_key = SigningKey::from_bytes(&self.secret.signing);
        let sig = signing_key.sign(msg);
        sig.to_bytes()
    }

    /// Verify a signature against a message.
    pub fn verify(&self, msg: &[u8], sig_bytes: &[u8; 64]) -> bool {
        let verifying = match VerifyingKey::from_bytes(&self.public.signing_pub) {
            Ok(v) => v,
            Err(_) => return false,
        };
        let sig = match Signature::from_slice(sig_bytes) {
            Ok(s) => s,
            Err(_) => return false,
        };
        verifying.verify(msg, &sig).is_ok()
    }

    /// Convenience: alias for [`Self::public`] — sometimes more readable.
    pub fn public_only(&self) -> IdentityPublic {
        self.public
    }
}

// ============================================================================
// ECIES — encrypted envelope payloads (Олег 2026-08-24 11:00 MSK)
// ============================================================================
//
// Recipient = recipient agreement_pubkey (X25519 public).
// Sender generates ephemeral X25519 keypair, computes ECDH(recipient, ephemeral),
// derives AES-256-GCM key via HKDF-SHA256(salt="murmur-ecies-v1", info="ecies-encrypt").
// Output = [ephemeral_pubkey: 32][nonce: 12][ciphertext+tag]
//
// Decryption: recipient takes ephemeral_pubkey from envelope, computes ECDH(own
// secret, ephemeral_pubkey), derives same key, decrypts. AEAD tag ensures
// authenticity + integrity.
//
// Why ephemeral per-message: sender's static X25519 secret is never used directly,
// so no risk of reusing key across encryptions (and forward-secrecy if recipient
// rotates their secret).
//
// Why bind to agreement_pubkey only: signing key (ed25519) is for authentication
// (signature over envelope), agreement key is for encryption. Standard split.

/// HKDF salt — domain separation between ECIES uses.
pub const ECIES_SALT: &[u8] = b"murmur-ecies-v1";
/// HKDF info — identifies ECIES use case (vs other KDFs).
pub const ECIES_INFO: &[u8] = b"ecies-encrypt";
/// Nonce length for AES-256-GCM.
pub const ECIES_NONCE_LEN: usize = 12;
/// Ephemeral public key length (X25519).
pub const ECIES_EPHEM_LEN: usize = 32;

/// Sealed envelope output of ECIES encryption.
///
/// Layout (bytes):
/// ```text
/// [ephemeral_pubkey: 32 bytes][nonce: 12 bytes][ciphertext + 16-byte tag]
/// ```
#[derive(Clone, Debug)]
pub struct SealedEnvelope {
    /// Ephemeral X25519 public key (sender's per-message key).
    pub ephemeral_pubkey: [u8; ECIES_EPHEM_LEN],
    /// AES-GCM nonce (unique per encryption).
    pub nonce: [u8; ECIES_NONCE_LEN],
    /// AES-GCM ciphertext + authentication tag.
    pub ciphertext: Vec<u8>,
}

impl SealedEnvelope {
    /// Total serialized length (header + ciphertext).
    pub fn total_len(&self) -> usize {
        ECIES_EPHEM_LEN + ECIES_NONCE_LEN + self.ciphertext.len()
    }

    /// Serialize to bytes: `[ephem][nonce][ct]`.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.total_len());
        out.extend_from_slice(&self.ephemeral_pubkey);
        out.extend_from_slice(&self.nonce);
        out.extend_from_slice(&self.ciphertext);
        out
    }

    /// Parse from wire bytes. Returns `Err` if input is too short.
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, IdentityError> {
        if bytes.len() < ECIES_EPHEM_LEN + ECIES_NONCE_LEN {
            return Err(IdentityError::Ecies(format!(
                "sealed envelope too short: {} bytes (need at least {})",
                bytes.len(),
                ECIES_EPHEM_LEN + ECIES_NONCE_LEN
            )));
        }
        let mut ephem = [0u8; ECIES_EPHEM_LEN];
        ephem.copy_from_slice(&bytes[..ECIES_EPHEM_LEN]);
        let mut nonce = [0u8; ECIES_NONCE_LEN];
        nonce.copy_from_slice(&bytes[ECIES_EPHEM_LEN..ECIES_EPHEM_LEN + ECIES_NONCE_LEN]);
        let ct = bytes[ECIES_EPHEM_LEN + ECIES_NONCE_LEN..].to_vec();
        Ok(Self {
            ephemeral_pubkey: ephem,
            nonce,
            ciphertext: ct,
        })
    }
}

impl Identity {
    /// Encrypt plaintext so ONLY the recipient (with the matching `npub`) can decrypt.
    ///
    /// Uses ephemeral ECDH: generates a fresh X25519 keypair per call, computes
    /// shared secret with recipient's agreement_pubkey, derives AES-256-GCM key
    /// via HKDF, encrypts. The recipient decrypts with their agreement_secret.
    ///
    /// Returns a `SealedEnvelope` containing the ephemeral pubkey, nonce, and
    /// ciphertext. The plaintext itself is zeroized on return (caller's responsibility).
    ///
    /// AAD: empty (we don't bind to context yet). If we later want to bind to
    /// sender/recipient npub, we'd add it here and pass to Aead.
    pub fn ecies_encrypt<R: RngCore + CryptoRng>(
        &self,
        rng: &mut R,
        recipient: &IdentityPublic,
        plaintext: &[u8],
    ) -> Result<SealedEnvelope, IdentityError> {
        // 1. Generate ephemeral X25519 keypair
        let mut ephem_secret_bytes = [0u8; AGREEMENT_SECRET_LEN];
        rng.fill_bytes(&mut ephem_secret_bytes);
        let ephem_secret = X25519Secret::from(ephem_secret_bytes);
        let ephem_pub = X25519Public::from(&ephem_secret);

        // 2. ECDH(ephem_secret, recipient_pubkey) = 32-byte shared
        let recipient_x = X25519Public::from(recipient.agreement_pubkey());
        let shared = ephem_secret.diffie_hellman(&recipient_x);
        let shared_bytes = shared.to_bytes();

        // 3. HKDF-SHA256(salt=ECIES_SALT, ikm=shared, info=ECIES_INFO) -> 32-byte AES key
        let hk = Hkdf::<Sha256>::new(Some(ECIES_SALT), &shared_bytes);
        let mut aes_key = [0u8; 32];
        hk.expand(ECIES_INFO, &mut aes_key)
            .map_err(|e| IdentityError::Ecies(format!("hkdf expand: {e}")))?;

        // 4. Generate nonce
        let mut nonce_bytes = [0u8; ECIES_NONCE_LEN];
        rng.fill_bytes(&mut nonce_bytes);

        // 5. AES-256-GCM encrypt
        let cipher = Aes256Gcm::new_from_slice(&aes_key)
            .map_err(|e| IdentityError::Ecies(format!("key init: {e}")))?;
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext,
                    aad: b"",
                },
            )
            .map_err(|e| IdentityError::Ecies(format!("encrypt: {e}")))?;

        // Zero ephemeral secret + shared + HKDF output (defense-in-depth)
        let mut ephem_zero = ephem_secret_bytes;
        ephem_zero.zeroize();
        let mut shared_zero = shared_bytes;
        shared_zero.zeroize();
        let mut key_zero = aes_key;
        key_zero.zeroize();

        Ok(SealedEnvelope {
            ephemeral_pubkey: *ephem_pub.as_bytes(),
            nonce: nonce_bytes,
            ciphertext,
        })
    }

    /// Decrypt a SealedEnvelope from `sender_ephemeral_pubkey` + ciphertext.
    ///
    /// The `sender_agreement_pubkey` is recovered from the ephemeral_pubkey field
    /// (sender is anonymous in ECIES — only ephemeral_pubkey is known; we don't
    // bind to a static sender identity. For sender authentication, use the
    // outer envelope's ed25519 signature.).
    ///
    /// AAD: empty, must match what was used in `ecies_encrypt`.
    pub fn ecies_decrypt(
        &self,
        sender_ephemeral_pubkey: &[u8; ECIES_EPHEM_LEN],
        nonce: &[u8; ECIES_NONCE_LEN],
        ciphertext: &[u8],
    ) -> Result<Vec<u8>, IdentityError> {
        if nonce.len() != ECIES_NONCE_LEN {
            return Err(IdentityError::Ecies(format!(
                "bad nonce len: {} (want {})",
                nonce.len(),
                ECIES_NONCE_LEN
            )));
        }

        // 1. Parse ephemeral pubkey
        let ephem_pub = X25519Public::from(*sender_ephemeral_pubkey);

        // 2. ECDH(own agreement_secret, ephemeral_pubkey) = same shared secret
        let own_secret = X25519Secret::from(self.secret.agreement);
        let shared = own_secret.diffie_hellman(&ephem_pub);
        let shared_bytes = shared.to_bytes();

        // 3. Same HKDF derivation
        let hk = Hkdf::<Sha256>::new(Some(ECIES_SALT), &shared_bytes);
        let mut aes_key = [0u8; 32];
        hk.expand(ECIES_INFO, &mut aes_key)
            .map_err(|e| IdentityError::Ecies(format!("hkdf expand: {e}")))?;

        // 4. Decrypt
        let cipher = Aes256Gcm::new_from_slice(&aes_key)
            .map_err(|e| IdentityError::Ecies(format!("key init: {e}")))?;
        let nonce_obj = Nonce::from_slice(nonce);
        let plaintext = cipher
            .decrypt(
                nonce_obj,
                Payload {
                    msg: ciphertext,
                    aad: b"",
                },
            )
            .map_err(|e| IdentityError::Ecies(format!("decrypt (bad tag or wrong key): {e}")))?;

        let mut shared_zero = shared_bytes;
        shared_zero.zeroize();
        let mut key_zero = aes_key;
        key_zero.zeroize();

        Ok(plaintext)
    }
}

/// ECIES roundtrip + tamper-detection tests (Олег 2026-08-24 11:00 MSK).
#[cfg(test)]
mod ecies_tests {
    use super::*;
    use rand::rngs::OsRng;
    use std::ops::BitXorAssign;

    #[test]
    fn roundtrip_small() {
        let alice = Identity::generate(&mut OsRng);
        let bob = Identity::generate(&mut OsRng);
        let pt: &[u8] = b"hello world";
        let sealed = alice
            .ecies_encrypt(&mut OsRng, &bob.public(), pt)
            .expect("encrypt");
        let decrypted = bob
            .ecies_decrypt(&sealed.ephemeral_pubkey, &sealed.nonce, &sealed.ciphertext)
            .expect("decrypt");
        assert_eq!(pt.to_vec(), decrypted);
    }

    #[test]
    fn roundtrip_50mb() {
        // Имитируем максимальный attachment (Олег 2026-08-24 11:00 MSK, 50 MB cap).
        let alice = Identity::generate(&mut OsRng);
        let bob = Identity::generate(&mut OsRng);
        let pt = vec![0xab_u8; 50 * 1024 * 1024];
        let sealed = alice
            .ecies_encrypt(&mut OsRng, &bob.public(), &pt)
            .expect("encrypt 50 MB");
        assert_eq!(sealed.ciphertext.len(), 50 * 1024 * 1024 + 16); // +16 = GCM tag
        let decrypted = bob
            .ecies_decrypt(&sealed.ephemeral_pubkey, &sealed.nonce, &sealed.ciphertext)
            .expect("decrypt 50 MB");
        assert_eq!(pt.len(), decrypted.len());
        assert_eq!(pt[..100], decrypted[..100]); // spot check
    }

    #[test]
    fn tamper_detection() {
        let alice = Identity::generate(&mut OsRng);
        let bob = Identity::generate(&mut OsRng);
        let sealed = alice
            .ecies_encrypt(&mut OsRng, &bob.public(), b"secret")
            .expect("encrypt");
        // Меняем последний байт (tag)
        let mut tampered = sealed.clone();
        tampered.ciphertext.last_mut().unwrap().bitxor_assign(1);
        let res = bob.ecies_decrypt(&tampered.ephemeral_pubkey, &tampered.nonce, &tampered.ciphertext);
        assert!(res.is_err(), "tampered ciphertext must fail AEAD tag");
    }

    #[test]
    fn wrong_recipient_fails() {
        let alice = Identity::generate(&mut OsRng);
        let bob = Identity::generate(&mut OsRng);
        let eve = Identity::generate(&mut OsRng);
        let sealed = alice
            .ecies_encrypt(&mut OsRng, &bob.public(), b"only for bob")
            .expect("encrypt");
        // Eve не может расшифровать (у неё другой agreement_secret)
        let res = eve.ecies_decrypt(&sealed.ephemeral_pubkey, &sealed.nonce, &sealed.ciphertext);
        assert!(res.is_err(), "wrong recipient must fail");
    }

    #[test]
    fn envelope_serialization() {
        let alice = Identity::generate(&mut OsRng);
        let bob = Identity::generate(&mut OsRng);
        let sealed = alice
            .ecies_encrypt(&mut OsRng, &bob.public(), b"hello")
            .expect("encrypt");
        let bytes = sealed.to_bytes();
        let restored = SealedEnvelope::from_bytes(&bytes).expect("parse");
        assert_eq!(sealed.ephemeral_pubkey, restored.ephemeral_pubkey);
        assert_eq!(sealed.nonce, restored.nonce);
        assert_eq!(sealed.ciphertext, restored.ciphertext);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;

    #[test]
    fn sign_verify_roundtrip() {
        let id = Identity::generate(&mut OsRng);
        let msg = b"murmur test";
        let sig = id.sign(msg);
        assert!(id.verify(msg, &sig));
    }

    #[test]
    fn sign_verify_fails_for_tampered_sig() {
        let id = Identity::generate(&mut OsRng);
        let msg = b"hi bob";
        let mut sig = id.sign(msg);
        sig[0] ^= 0x01;
        assert!(!id.verify(msg, &sig));
    }

    #[test]
    fn postcard_roundtrip_preserves_public_keys() {
        let id = Identity::generate(&mut OsRng);
        let bytes = id.to_bytes().expect("serialize");
        let restored = Identity::from_bytes(&bytes).expect("deserialize");
        assert_eq!(id.public().signing_pubkey(), restored.public().signing_pubkey());
        assert_eq!(id.public().agreement_pubkey(), restored.public().agreement_pubkey());
    }

    #[test]
    fn npub_roundtrip() {
        let id = Identity::generate(&mut OsRng);
        let npub = id.public().npub();
        let restored = IdentityPublic::from_npub(&npub).expect("valid npub");
        assert_eq!(id.public().signing_pubkey(), restored.signing_pubkey());
        assert_eq!(id.public().agreement_pubkey(), restored.agreement_pubkey());
    }
}
