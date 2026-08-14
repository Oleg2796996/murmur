//! End-to-end test for the murmur crate through iroh: bob listens,
//! alice sends an envelope, bob's incoming log gets the payload.

#![cfg(feature = "iroh")]

use murmur::iroh_integration::{listen, send_envelope_via_endpoint, spawn_sender_endpoint, build_node_addr};
use murmur::{Murmur, MurmurError};
use murmur_id::Identity;
use std::sync::Arc;
use tempfile::tempdir;

#[tokio::test]
async fn end_to_end_through_iroh_persists_to_bob_log() {
    let dir = tempdir().unwrap();
    let alice_home = dir.path().join("alice");
    let bob_home = dir.path().join("bob");
    std::fs::create_dir_all(&alice_home).unwrap();
    std::fs::create_dir_all(&bob_home).unwrap();

    // Seed identities with fixed RNGs (so npubs are deterministic).
    let alice = seed_identity(0xA11CE, &alice_home);
    let bob = seed_identity(0xB0B, &bob_home);

    // bob: spin up his listener, expected to receive from alice.
    let bob_arc = Arc::new(Murmur::load(&bob_home, "bob").unwrap());
    let (bob_node, bob_node_id, bob_addr) = listen(bob_arc.clone(), alice.public(), "alice".into())
        .await
        .expect("bob listener up");
    // Sanity: the listener got a real bind address (random port > 0).
    assert!(bob_addr.port() > 0, "bob should have a real port");

    // alice: send an envelope.
    let alice_endpoint = spawn_sender_endpoint().await.expect("alice endpoint");
    let payload = b"hello bob, from your friend alice";
    let env = alice.build_envelope(&bob.public().npub(), payload).unwrap();
    let bob_node_addr = build_node_addr(bob_node_id, bob_addr);
    send_envelope_via_endpoint(&alice_endpoint, bob_node_addr, &env)
        .await
        .expect("alice sends");

    // Give bob a moment to dispatch the handler.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    bob_node.shutdown().await.ok();

    // Assert: bob's incoming log "alice" has the payload.
    let log = bob_arc.incoming_log("alice").unwrap();
    assert_eq!(log.len(), 1, "bob should have 1 entry");
    log.verify().unwrap();
    let root = log.merkle_root().unwrap();
    assert_ne!(root.as_bytes(), &[0u8; 32], "merkle root must be non-zero");
}

#[test]
fn receive_from_rejects_tampered_envelope() {
    // Pure unit-style: no iroh needed. Echoes the basic trust check.
    use murmur_transport::Envelope;
    let dir = tempdir().unwrap();
    let alice = seed_identity(0xAA, &dir.path().join("a"));
    let env = alice.build_envelope("npub1qqqqq", b"orig").unwrap();
    let mut tampered = env.clone();
    tampered.payload = b"tampered".to_vec();
    // We expect Envelope(_, InvalidSignature) when re-verifying.
    let r: Result<_, MurmurError> = alice.receive_from("sender", &alice.public(), &tampered, 0);
    assert!(r.is_err(), "tampered envelope must fail verification");
}

fn seed_identity(seed: u64, home: &std::path::Path) -> Murmur {
    use rand::SeedableRng;
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let id = Identity::generate(&mut rng);
    std::fs::create_dir_all(home).unwrap();
    std::fs::write(home.join("identity.bin"), id.to_bytes().unwrap()).unwrap();
    Murmur::load(home, "u").unwrap()
}
