// Signature compatibility: Rust murmur-uniffi must produce the SAME hex sigs
// as the PWA WASM module for the same identity + payload.
use murmur_id::Identity;

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

fn hex_encode(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[test]
fn signatures_match_pwa_wasm() {
    // Vectors produced by the live pwa/pkg/murmur_id_wasm.js module.
    let sk_hex = "e02eb5516780dbb7ab70c860d98ef866fd6e848e97ada436e776cf5446ddd23999a1ed0efb8154d1558f3639b1058f801c86dee0f026adbc8061fcf7a4cbe45c";
    let npub = "npub1mp4g4uqa8wajxugktveepd3frr3vjqxqaqxv7ug5g28g5pj9ygumkcxmuy6h6djqty6p7pvmw29n7yj9ywz7f2tghwx4lhqc2jn65yse98twa";
    let auth_msg = "murmur-auth-v1|npub1mp4g4uqa8wajxugktveepd3frr3vjqxqaqxv7ug5g28g5pj9ygumkcxmuy6h6djqty6p7pvmw29n7yj9ywz7f2tghwx4lhqc2jn65yse98twa|1793790000";
    let auth_sig = "f3ec0d6546c250a042a5c49bd38694abaeb45e3a8b5d4c4459e3696e199ec0dd6cd967689b90fabfaafafc54f2d8d4b919ce7ff90836a1f08ca458fee2bc7906";
    let env_sig = "8bb190133f6b7ab9a0ba17d038df4741e9d6a044966aab2eb0b5ef33cbbe4187bc4cf0bf448f2c87564dde28e97edacbeb62e318810c46c855e1ac1f33c2fc06";
    let payload = base64_decode("bnB1YjFtcDRnNHVxYTh3YWp4dWdrdHZlZXBkM2ZycjN2anF4cWFxeHY3dWc1ZzI4ZzVwajl5Z3Vta2N4bXV5Nmg2ZGpxdHk2cDdwdm13MjluN3lqOXl3ejdmMnRnaHd4NGxocWMyam42NXlzZTk4dHdhfHBlZXJ8MTc5Mzc5MDAwMHxDVEI2NA==");

    let id = Identity::from_bytes(&hex_decode(sk_hex)).unwrap();
    assert_eq!(id.public().npub(), npub, "identity restore must match PWA");

    // 1. plain sign_message equivalent (murmur-auth-v1 tokens)
    assert_eq!(
        hex_encode(&id.sign(auth_msg.as_bytes())),
        auth_sig,
        "sign() hex must match PWA WASM sign_message"
    );

    // 2. envelope signature (relay Envelope::verify)
    let input = murmur_transport::signature_input(npub, &payload);
    assert_eq!(
        hex_encode(&id.sign(&input)),
        env_sig,
        "sign_envelope hex must match PWA WASM sign_envelope"
    );
}

fn base64_decode(s: &str) -> Vec<u8> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(s).unwrap()
}
