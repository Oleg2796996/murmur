//! E2E encryption test for murmur (variant B).

use murmur_id::{Identity, SealedEnvelope};

fn to_sealed(bytes: &[u8]) -> SealedEnvelope {
    SealedEnvelope::from_bytes(bytes).expect("sealed parse")
}

#[test]
fn e2e_text_message_roundtrip() {
    let alice = Identity::generate(&mut rand::rngs::OsRng);
    let bob = Identity::generate(&mut rand::rngs::OsRng);
    let alice_npub = alice.public().npub();
    let bob_npub = bob.public().npub();
    assert!(alice_npub.starts_with("npub1"));
    assert!(bob_npub.starts_with("npub1"));

    let msg = b"hello bob";
    let sealed = alice
        .ecies_encrypt(&mut rand::rngs::OsRng, &bob.public(), msg)
        .expect("encrypt");
    let bytes = sealed.to_bytes();
    assert!(bytes.len() > 50);

    let parsed = to_sealed(&bytes);
    let plaintext = bob
        .ecies_decrypt(&parsed.ephemeral_pubkey, &parsed.nonce, &parsed.ciphertext)
        .expect("decrypt");
    assert_eq!(plaintext, msg);
}

#[test]
fn e2e_tampered_ciphertext_fails() {
    let alice = Identity::generate(&mut rand::rngs::OsRng);
    let bob = Identity::generate(&mut rand::rngs::OsRng);
    let sealed = alice
        .ecies_encrypt(&mut rand::rngs::OsRng, &bob.public(), b"secret")
        .expect("encrypt");
    let mut bytes = sealed.to_bytes();
    assert!(bytes.len() > 45);
    bytes[44] ^= 0x01;
    let bad = to_sealed(&bytes);
    let result = bob.ecies_decrypt(&bad.ephemeral_pubkey, &bad.nonce, &bad.ciphertext);
    assert!(result.is_err(), "decrypt must fail on tampered ciphertext");
}

#[test]
fn e2e_wrong_recipient_fails() {
    let alice = Identity::generate(&mut rand::rngs::OsRng);
    let bob = Identity::generate(&mut rand::rngs::OsRng);
    let eve = Identity::generate(&mut rand::rngs::OsRng);
    let sealed = alice
        .ecies_encrypt(&mut rand::rngs::OsRng, &bob.public(), b"for Bob only")
        .expect("encrypt");
    let result = eve.ecies_decrypt(&sealed.ephemeral_pubkey, &sealed.nonce, &sealed.ciphertext);
    assert!(result.is_err(), "Eve must not be able to decrypt");
}

#[test]
fn e2e_envelope_serialization_roundtrip() {
    let alice = Identity::generate(&mut rand::rngs::OsRng);
    let bob = Identity::generate(&mut rand::rngs::OsRng);
    let sealed = alice
        .ecies_encrypt(&mut rand::rngs::OsRng, &bob.public(), b"payload")
        .expect("encrypt");
    let bytes = sealed.to_bytes();
    let restored = to_sealed(&bytes);
    let plaintext = bob
        .ecies_decrypt(&restored.ephemeral_pubkey, &restored.nonce, &restored.ciphertext)
        .expect("decrypt restored");
    assert_eq!(plaintext, b"payload");
}

#[test]
fn e2e_50mb_attachment_roundtrip() {
    let alice = Identity::generate(&mut rand::rngs::OsRng);
    let bob = Identity::generate(&mut rand::rngs::OsRng);
    let payload = vec![0xAB_u8; 50 * 1024 * 1024];
    let start = std::time::Instant::now();
    let sealed = alice
        .ecies_encrypt(&mut rand::rngs::OsRng, &bob.public(), &payload)
        .expect("encrypt 50MB");
    let enc_time = start.elapsed();
    let start = std::time::Instant::now();
    let plaintext = bob
        .ecies_decrypt(&sealed.ephemeral_pubkey, &sealed.nonce, &sealed.ciphertext)
        .expect("decrypt 50MB");
    let dec_time = start.elapsed();
    assert_eq!(plaintext.len(), payload.len());
    assert_eq!(&plaintext[0..16], &payload[0..16]);
    assert_eq!(&plaintext[payload.len()-16..], &payload[payload.len()-16..]);
    eprintln!("50MB encrypt: {:?}, decrypt: {:?}", enc_time, dec_time);
}

#[test]
fn e2e_signature_input_is_deterministic() {
    // Связь PWA ↔ relay: PWA формирует `from|to|ts|ct` как signed_payload,
    // подписывает через sign_envelope. Relay verify делает signature_input
    // (SHA3-256 SHAKE) тем же путём. Тест проверяет что Identity::sign +
    // IdentityPublic::verify согласованы (одна и та же ed25519 key).
    let alice = Identity::generate(&mut rand::rngs::OsRng);
    let alice_npub = alice.public().npub();
    let payload = b"hello bob".to_vec();
    let sig = alice.sign(&payload);
    let alice_pub = murmur_id::IdentityPublic::from_npub(&alice_npub).expect("npub");
    assert!(alice_pub.verify(&payload, &sig), "self-verify must work");
    // Tamper → fail.
    let mut bad = payload.clone();
    bad[0] ^= 0x01;
    assert!(!alice_pub.verify(&bad, &sig), "tamper must fail");
}
