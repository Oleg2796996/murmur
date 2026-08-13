//! End-to-end test: two in-memory iroh nodes exchange an Envelope.
//!
//! Requires `--features iroh`.

#![cfg(feature = "iroh")]

use murmur_id::Identity;
use murmur_transport::iroh_transport::{spawn_memory_node, ALPN};
use murmur_transport::Envelope;
use std::sync::{Arc, Mutex};

#[tokio::test]
async fn alice_sends_envelope_to_bob_via_iroh() {
    // Alice's identity (sender).
    let alice = Identity::generate(&mut rand::thread_rng());
    let alice_pub = alice.public();

    // Bob's view of alice: he already knows alice's npub (via share-link).
    let received: Arc<Mutex<Vec<Envelope>>> = Arc::new(Mutex::new(Vec::new()));
    let received_clone = received.clone();
    let bob_node = spawn_memory_node(alice_pub.clone(), move |env| {
        received_clone.lock().unwrap().push(env);
    })
    .await
    .expect("spawn bob node");

    // Alice: a plain iroh endpoint (no murmur ALPN — she's the sender, not the listener).
    let alice_node = iroh::node::Node::memory().build().await.expect("build alice").spawn().await.expect("spawn alice");

    let bob_node_id = bob_node.node_id();
    let payload = b"hello from alice".to_vec();
    let env = Envelope::sign(&alice, payload.clone()).unwrap();
    let conn = alice_node
        .endpoint()
        .connect_by_node_id(bob_node_id, ALPN)
        .await
        .expect("dial bob");
    let (mut send, mut recv) = conn.open_bi().await.expect("open bi");
    let bytes = postcard::to_stdvec(&env).unwrap();
    send.write_all(&bytes).await.expect("write");
    send.finish().expect("finish");
    send.stopped().await.expect("stopped");
    let _ack = recv.read_to_end(8).await.expect("read ack");

    // Give bob a moment to dispatch the handler.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    bob_node.shutdown().await.ok();
    alice_node.shutdown().await.ok();

    let received = received.lock().unwrap();
    assert_eq!(received.len(), 1, "bob should have received exactly one envelope");
    let got = &received[0];
    assert_eq!(got.payload, payload);
    assert_eq!(got.sender_npub, alice_pub.npub());
    got.verify(&alice_pub).expect("envelope must verify");
}

#[tokio::test]
async fn bob_rejects_envelope_signed_by_unknown_sender() {
    let alice = Identity::generate(&mut rand::thread_rng());
    let eve = Identity::generate(&mut rand::thread_rng());

    let alice_pub = alice.public();
    let received: Arc<Mutex<Vec<Envelope>>> = Arc::new(Mutex::new(Vec::new()));
    let received_clone = received.clone();
    let bob_node = spawn_memory_node(alice_pub.clone(), move |env| {
        received_clone.lock().unwrap().push(env);
    })
    .await
    .expect("spawn bob node");

    let alice_node = iroh::node::Node::memory().build().await.expect("build alice").spawn().await.expect("spawn alice");

    let bob_node_id = bob_node.node_id();
    let env = Envelope::sign(&eve, b"i am alice, trust me".to_vec()).unwrap();
    let conn = alice_node
        .endpoint()
        .connect_by_node_id(bob_node_id, ALPN)
        .await
        .expect("dial bob");
    let (mut send, mut _recv) = conn.open_bi().await.expect("open bi");
    let bytes = postcard::to_stdvec(&env).unwrap();
    send.write_all(&bytes).await.expect("write");
    send.finish().expect("finish");
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;

    bob_node.shutdown().await.ok();
    alice_node.shutdown().await.ok();
    assert!(received.lock().unwrap().is_empty(), "bob must reject envelope signed by eve");
}