// TEMP verification: decrypt a vector produced by the live PWA WASM module.
use murmur_id::{Identity, SealedEnvelope};

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

#[test]
fn live_wasm_vector_decrypts_in_rust() {
    let sk_hex = "a6160610d8f3c3df2e14852e8a36b1dde7744efe75ac1ae2bfb77b210aa9e06a22186f8b02945a84019e0ff9203c003a595eb9449caaa6e84223917f0bfdb8bf";
    let sealed_b64 = "xlITu2bdaT/EZsxEwsYyAuyaejfN+aUt5HqzyyGEnBhdLJzOkDAuUk74ZbeHh7DAejYKcUm3eJupgqm9kj43RpuVifcQzTldCDqGbvSHd1QHLR9RoQSqTMDo";
    let expected = "murmur-live-cross-wasm-to-rust";

    use base64::Engine;
    let sealed_bytes = base64::engine::general_purpose::STANDARD
        .decode(sealed_b64)
        .unwrap();
    let id = Identity::from_bytes(&hex_decode(sk_hex)).unwrap();
    let env = SealedEnvelope::from_bytes(&sealed_bytes).unwrap();
    let pt = id
        .ecies_decrypt(&env.ephemeral_pubkey, &env.nonce, &env.ciphertext)
        .unwrap();
    assert_eq!(String::from_utf8(pt).unwrap(), expected);
}
