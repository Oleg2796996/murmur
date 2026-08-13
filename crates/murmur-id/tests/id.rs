//! murmur-id — integration tests
//!
//! Step 1: minimal viable identity.

use murmur_id::{Identity, IdentityPublic};
use rand::rngs::OsRng;

#[test]
fn identity_generates_and_roundtrips() {
    let id = Identity::generate(&mut OsRng);
    let bytes = id.to_bytes().expect("serialize");
    let restored = Identity::from_bytes(&bytes).expect("deserialize");
    assert_eq!(id.public().signing_pubkey(), restored.public().signing_pubkey());
    assert_eq!(id.public().agreement_pubkey(), restored.public().agreement_pubkey());
}

#[test]
fn identity_signatures_verify() {
    let id = Identity::generate(&mut OsRng);
    let msg = b"hello, murmur";
    let sig = id.sign(msg);
    assert!(id.verify(msg, &sig));
}

#[test]
fn identity_signatures_reject_tampered_message() {
    let id = Identity::generate(&mut OsRng);
    let msg = b"hello, murmur";
    let sig = id.sign(msg);
    let mut tampered = msg.to_vec();
    tampered[0] ^= 0x01;
    assert!(!id.verify(&tampered, &sig));
}

#[test]
fn identity_address_is_bech32_npub() {
    let id = Identity::generate(&mut OsRng);
    let npub = id.public().npub();
    assert!(npub.starts_with("npub1"), "expected npub1 prefix, got {npub}");
    assert!(npub.len() >= 60, "npub too short: {npub}");
}

#[test]
fn identity_from_npub_roundtrip() {
    let id = Identity::generate(&mut OsRng);
    let npub = id.public().npub();
    let restored = IdentityPublic::from_npub(&npub).expect("valid npub");
    assert_eq!(id.public().signing_pubkey(), restored.signing_pubkey());
    assert_eq!(id.public().agreement_pubkey(), restored.agreement_pubkey());
}

#[test]
fn invalid_npub_rejected() {
    let err = IdentityPublic::from_npub("npub1invalid").expect_err("should reject");
    let _ = err;
}

#[test]
fn batched_generation_yields_distinct_identities() {
    let a = Identity::generate(&mut OsRng);
    let b = Identity::generate(&mut OsRng);
    assert_ne!(a.public().signing_pubkey(), b.public().signing_pubkey());
    assert_ne!(a.public().npub(), b.public().npub());
}

#[test]
fn postcard_serialized_size_is_64_bytes() {
    let id = Identity::generate(&mut OsRng);
    let bytes = id.to_bytes().expect("serialize");
    // 32 (ed25519) + 32 (x25519) = 64 bytes, plus maybe a few bytes of postcard frame
    assert!(
        bytes.len() <= 96,
        "serialized identity larger than expected: {} bytes",
        bytes.len()
    );
    assert!(
        bytes.len() >= 64,
        "serialized identity smaller than expected: {} bytes",
        bytes.len()
    );
}
