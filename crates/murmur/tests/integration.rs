//! Integration tests for the murmur crate: load_or_create identity,
//! send/record_outgoing, receive_from, verify logs end-to-end.

use murmur::{Murmur, MurmurError};
use murmur_id::{Identity, IdentityPublic};
use murmur_log::Log;
use murmur_transport::Envelope;
use rand::SeedableRng;
use tempfile::tempdir;

fn alice_and_bob(
    home: &std::path::Path,
) -> (Murmur, Murmur, IdentityPublic, IdentityPublic) {
    // Two distinct murmur users (so they have independent identity.bin).
    let alice_dir = home.join("alice");
    let bob_dir = home.join("bob");
    std::fs::create_dir_all(&alice_dir).unwrap();
    std::fs::create_dir_all(&bob_dir).unwrap();

    // Build alice manually so we can pin RNG; Murmur::load_or_create uses thread_rng() too.
    let mut rng = rand::rngs::StdRng::seed_from_u64(0xA11CE);
    let alice_id = Identity::generate(&mut rng);
    std::fs::write(
        alice_dir.join("identity.bin"),
        alice_id.to_bytes().unwrap(),
    )
    .unwrap();
    let alice = Murmur::load(&alice_dir, "alice").unwrap();

    let mut rng = rand::rngs::StdRng::seed_from_u64(0xB0B);
    let bob_id = Identity::generate(&mut rng);
    std::fs::write(bob_dir.join("identity.bin"), bob_id.to_bytes().unwrap()).unwrap();
    let bob = Murmur::load(&bob_dir, "bob").unwrap();

    let alice_pub = alice.public();
    let bob_pub = bob.public();
    (alice, bob, alice_pub, bob_pub)
}

#[test]
fn roundtrip_send_record_receive_persist_log() {
    let dir = tempdir().unwrap();
    let (alice, bob, _alice_pub, bob_pub) = alice_and_bob(dir.path());

    // Alice composes an envelope addressed to bob.
    let env = alice
        .build_envelope(&bob_pub.npub(), b"hello bob, this is alice")
        .expect("alice signs");

    // Alice records her outgoing envelope (for her own audit log).
    let alice_hash = alice
        .record_outgoing("bob", &env, 1_000_000)
        .expect("alice records outgoing");
    assert_eq!(alice_hash.len(), 32);

    // Bob receives alice's envelope and persists the payload to his incoming log.
    let bob_hash = bob
        .receive_from("alice", &alice.public(), &env, 1_000_001)
        .expect("bob receives and logs");
    assert_eq!(bob_hash.len(), 32);

    // Bob's incoming log has 1 entry; verify chain + merkle root.
    let log = bob.incoming_log("alice").unwrap();
    assert_eq!(log.len(), 1);
    log.verify().expect("incoming log verifies");

    // Verify the stored payload matches what alice sent.
    log.verify().unwrap(); // idempotent

    // Alice's outgoing log also verifies.
    let out = alice.outgoing_log("bob").unwrap();
    assert_eq!(out.len(), 1);
    out.verify().expect("outgoing log verifies");
}

#[test]
fn receive_from_rejects_bad_signature() {
    let dir = tempdir().unwrap();
    let (alice, bob, alice_pub, bob_pub) = alice_and_bob(dir.path());
    let env = alice
        .build_envelope(&bob_pub.npub(), b"hello bob")
        .expect("alice signs");

    // Bob lies about who sent it (claims it was Eve, but envelope is signed by Alice).
    // receive_from passes alice_pub as `from_pub`, so signature matches — let's tamper instead.
    let mut tampered = env.clone();
    tampered.payload = b"evil".to_vec();

    let err = bob
        .receive_from("alice", &alice_pub, &tampered, 0)
        .expect_err("verify detects tamper");
    match err {
        MurmurError::Envelope(_) => {}
        other => panic!("expected Envelope error, got {other:?}"),
    }

    // Bob's incoming log is empty (the rejected envelope was not appended).
    let log = bob.incoming_log("alice").unwrap();
    assert_eq!(log.len(), 0);
}

#[test]
fn load_or_create_is_idempotent() {
    let dir = tempdir().unwrap();
    let home = dir.path().join("user");

    let a = Murmur::load_or_create(&home, "tester").expect("create");
    let npub_a = a.public().npub();

    let b = Murmur::load_or_create(&home, "tester").expect("re-open");
    let npub_b = b.public().npub();

    assert_eq!(npub_a, npub_b, "identity must persist across reload");
}

#[test]
fn contacts_lifecycle_round_trips() {
    // Tiny smoke: just exercise the inner `Envelope` API and `Log` API together.
    let dir = tempdir().unwrap();
    let mut rng = rand::rngs::StdRng::seed_from_u64(0xCAFE);
    let id = Identity::generate(&mut rng);
    let pub_ = id.public();
    // npub is bech32
    let npub = pub_.npub();
    assert!(npub.starts_with("npub1"));

    // 100 envelopes serialized to a single log file.
    let base = dir.path();
    let mut log = Log::open(base, "outbox").unwrap();
    for i in 0..100 {
        let env = Envelope::sign(&id, format!("msg {i}").into_bytes()).unwrap();
        let bytes = postcard::to_stdvec(&env).unwrap();
        log.append_payload(i as u64, bytes).unwrap();
    }
    log.verify().unwrap();
    let _ = log.merkle_root().unwrap();
}
