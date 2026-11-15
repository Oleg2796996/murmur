// Parse a REAL PWA backup exported by pwa/backup.js (text-only, 16 MB).
//
// The fixture is not committed (it is a private user backup). Point the test
// at a file with MURMUR_BACKUP_FIXTURE=/path/to/file.murmur, otherwise the
// test is skipped — CI must not fail on a missing private fixture.
//
// Password for the fixture: MURMUR_BACKUP_PASSWORD (never hard-coded).
use murmur_uniffi::murmur_backup_parse;

// The password is NOT hard-coded: it must come from the environment
// (MURMUR_BACKUP_PASSWORD). A missing value skips the test instead of
// baking a secret into the repository.
fn fixture_password() -> Option<String> {
    match std::env::var("MURMUR_BACKUP_PASSWORD") {
        Ok(p) if !p.is_empty() => Some(p),
        _ => None,
    }
}

#[test]
fn parse_real_pwa_backup() {
    let path = match std::env::var("MURMUR_BACKUP_FIXTURE") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("skip: MURMUR_BACKUP_FIXTURE not set");
            return;
        }
    };
    let raw = match std::fs::read(&path) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("skip: cannot read {}: {}", path, e);
            return;
        }
    };
    let password = match fixture_password() {
        Some(p) => p,
        None => {
            eprintln!("skip: MURMUR_BACKUP_PASSWORD not set");
            return;
        }
    };
    let info = murmur_backup_parse(raw, password).expect("parse must succeed");
    assert_eq!(info.sk_hex.len(), 128, "sk is 64 bytes -> 128 hex chars");
    assert!(info.npub.starts_with("npub1"), "npub must be bech32");
    eprintln!(
        "npub={} name={} sk_len={} contacts={}",
        info.npub,
        info.name,
        info.sk_hex.len(),
        info.contact_names_json.len()
    );
}

#[test]
fn wrong_password_fails() {
    let path = match std::env::var("MURMUR_BACKUP_FIXTURE") {
        Ok(p) => p,
        Err(_) => {
            eprintln!("skip: MURMUR_BACKUP_FIXTURE not set");
            return;
        }
    };
    let raw = match std::fs::read(&path) {
        Ok(r) => r,
        Err(_) => return,
    };
    let res = murmur_backup_parse(raw, "definitely-wrong-password".into());
    assert!(res.is_err(), "wrong password must not decrypt");
}
