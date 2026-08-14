//! Cross-machine E2E test (Step 6).
//!
//! Two iroh Nodes with REAL UDP sockets (`bind_random_port`),
//! `RelayMode::Disabled`, `DiscoveryConfig::None`. No relay, no DNS, no
//! Pkarr — only direct addresses. Since both Nodes listen on 127.0.0.1,
//! this is a loopback test, but it exercises the same code path as
//! cross-machine E2E (over a real network).
//!
//! If this test passes, the only thing missing for true cross-machine is
//! the `direct_addresses` containing a publicly-reachable IP + open UDP
//! port on the listener side.

#![cfg(feature = "iroh")]

use murmur::iroh_integration::{listen, send_envelope_via_endpoint, spawn_sender_endpoint, build_node_addr};
use murmur::{Murmur, MurmurError};
use murmur_id::Identity;
use std::sync::Arc;
use tempfile::tempdir;

#[tokio::test]
async fn cross_machine_two_real_nodes_loopback() {
    let dir = tempdir().unwrap();
    let alice_home = dir.path().join("alice");
    let bob_home = dir.path().join("bob");
    std::fs::create_dir_all(&alice_home).unwrap();
    std::fs::create_dir_all(&bob_home).unwrap();

    let alice = seed_murmur(0xA11CE, &alice_home, "alice");
    let bob = seed_murmur(0xB0B, &bob_home, "bob");

    // Bob: real-network listener (UDP socket, random port, no relay).
    let bob_arc = Arc::new(Murmur::load(&bob_home, "bob").unwrap());
    let (bob_node, bob_node_id, bob_addr) =
        listen(bob_arc.clone(), alice.public(), "alice".into())
            .await
            .expect("bob listener up");
    assert!(bob_addr.port() > 0, "bob should have a real port");

    // Alice: send an envelope via plain endpoint + NodeAddr.
    let alice_endpoint = spawn_sender_endpoint().await.expect("alice endpoint");
    let payload = b"hello from alice (cross-machine E2E)";
    let env = alice.build_envelope(&bob.public().npub(), payload).unwrap();

    // Also record outgoing in alice's log so we can verify her side too.
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    alice.record_outgoing("bob", &env, ts).unwrap();

    let bob_node_addr = build_node_addr(bob_node_id, bob_addr);
    send_envelope_via_endpoint(&alice_endpoint, bob_node_addr, &env)
        .await
        .expect("alice sends");

    // Give bob a moment to dispatch the handler.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    bob_node.shutdown().await.ok();

    // Assert: bob's incoming log has the payload.
    let bob_in = bob_arc.incoming_log("alice").unwrap();
    assert_eq!(bob_in.len(), 1, "bob should have 1 entry");
    bob_in.verify().unwrap();

    // Assert: alice's outgoing log has the payload.
    let alice_out = alice.outgoing_log("bob").unwrap();
    assert_eq!(alice_out.len(), 1, "alice should have 1 outgoing entry");
    alice_out.verify().unwrap();
}

fn seed_murmur(seed: u64, home: &std::path::Path, name: &str) -> Murmur {
    use rand::SeedableRng;
    let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
    let id = Identity::generate(&mut rng);
    std::fs::create_dir_all(home).unwrap();
    std::fs::write(home.join("identity.bin"), id.to_bytes().unwrap()).unwrap();
    Murmur::load(home, name).unwrap()
}
