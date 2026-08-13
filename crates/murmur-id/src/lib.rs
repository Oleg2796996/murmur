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
        let (hrp, data, _variant) = bech32::decode(s)?;
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
