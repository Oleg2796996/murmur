//! Integration tests for murmur-transport
//!
//! Uses iroh in-memory nodes so we don't open real sockets.

use murmur_id::Identity;
use murmur_transport::{Envelope, EnvelopeError};

fn fresh_identity() -> Identity {
    let mut rng = rand::thread_rng();
    Identity::generate(&mut rng)
}

#[test]
fn envelope_sign_and_verify_roundtrip() {
    let sender = fresh_identity();
    let payload = b"hello world".to_vec();
    let env = Envelope::sign(&sender, payload.clone()).unwrap();
    assert_eq!(env.payload, payload);
    assert_eq!(env.sender_npub, sender.public().npub());
    assert_eq!(env.signature.len(), 64);
    env.verify(&sender.public()).unwrap();
}

#[test]
fn envelope_detects_tampered_payload() {
    let sender = fresh_identity();
    let mut env = Envelope::sign(&sender, b"hello".to_vec()).unwrap();
    env.payload = b"goodbye".to_vec();
    let result = env.verify(&sender.public());
    assert!(matches!(result, Err(EnvelopeError::InvalidSignature)));
}

#[test]
fn envelope_detects_wrong_sender() {
    let alice = fresh_identity();
    let bob = fresh_identity();
    // Bob signs but claims to be alice
    let mut env = Envelope::sign(&bob, b"spoofed".to_vec()).unwrap();
    env.sender_npub = alice.public().npub().clone();
    let result = env.verify(&alice.public());
    assert!(matches!(result, Err(EnvelopeError::NpubMismatch) | Err(EnvelopeError::InvalidSignature)));
}

#[test]
fn envelope_postcard_roundtrip() {
    let sender = fresh_identity();
    let env = Envelope::sign(&sender, b"data".to_vec()).unwrap();
    let bytes = postcard::to_stdvec(&env).unwrap();
    let env2: Envelope = postcard::from_bytes(&bytes).unwrap();
    assert_eq!(env.payload, env2.payload);
    assert_eq!(env.sender_npub, env2.sender_npub);
    assert_eq!(env.signature, env2.signature);
}

#[test]
fn envelope_signing_message_is_canonical() {
    // Two envelopes signed independently with same payload must have
    // deterministic signatures (because we hash payload || sender_npub first).
    let sender = fresh_identity();
    let env1 = Envelope::sign(&sender, b"hi".to_vec()).unwrap();
    let env2 = Envelope::sign(&sender, b"hi".to_vec()).unwrap();
    assert_eq!(env1.signature, env2.signature);
}