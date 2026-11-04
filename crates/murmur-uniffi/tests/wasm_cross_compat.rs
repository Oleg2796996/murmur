// Cross-compat: WASM-encrypted sealed envelope -> Rust murmur-uniffi decrypt.
use murmur_id::Identity;

fn hex_decode(s: &str) -> Vec<u8> {
    (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i+2], 16).unwrap()).collect()
}

#[test]
fn wasm_sealed_to_rust_decrypt() {
    let sealed_b64 = "24kh+qrfA0h34z2GpGSZTIsdOUpIVZvmpTDAYATt4GitecDD/QOherigzW/tTBDFBLK7FX+1Z402+KBIXn8SrhW8NX8dPl9t+xRzvGGy2CVIp2wXDQ==";
    let sk_hex = "c2289229763db5f6dc19265be2066e27db04ef56ba00ce24f6c9337ec882a014e52c7c9e4ebc63904048b776fbe84d28c9080788ead972f1847d690b00f32758";
    use base64::Engine;
    let sealed_bytes = base64::engine::general_purpose::STANDARD.decode(sealed_b64).unwrap();
    let id = Identity::from_bytes(&hex_decode(sk_hex)).unwrap();
    let env = murmur_id::SealedEnvelope::from_bytes(&sealed_bytes).unwrap();
    let pt = id.ecies_decrypt(&env.ephemeral_pubkey, &env.nonce, &env.ciphertext).unwrap();
    assert_eq!(String::from_utf8(pt).unwrap(), "murmur-cross-wasm-to-rust");
}
