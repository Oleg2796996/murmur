// Parse a real .murmur backup produced by WebCrypto (PWA backup.js format).
use murmur_uniffi::murmur_backup_parse;

#[test]
fn parse_pwa_backup() {
    let raw = std::fs::read("/tmp/murmur-backup.murmur")
        .expect("backup fixture — regenerate with node script if missing");
    let res = murmur_backup_parse(raw, "test-password-123".into()).unwrap();
    assert_eq!(res.npub, "npub1ulk7qm05d6k5yv2fmzn4r4058fz5n7hx426wk56hypcx3z89qxvvgncp2cx9at8w7rpmpc0f2dck6vjgl322tuwh52nh98afjqq3qhs26w2n7");
    assert_eq!(res.name, "Олег");
    assert!(res.sk_hex.starts_with("c2289229"));
    assert!(res.contact_names_json.contains("Тест"));
}

#[test]
fn wrong_password_fails() {
    let raw = std::fs::read("/tmp/murmur-backup.murmur").unwrap();
    let res = murmur_backup_parse(raw, "wrong-password".into());
    assert!(res.is_err(), "wrong password must not decrypt");
}
