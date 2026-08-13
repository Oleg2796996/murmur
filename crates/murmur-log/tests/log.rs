//! Integration tests for murmur-log
//!
//! Use tempdir for file ops. Each test gets a fresh Log.

use murmur_log::{Entry, Log, MerkleRoot, LogError};
use tempfile::TempDir;

/// Helper: empty entry chain
fn empty_chain() -> [u8; 32] {
    [0u8; 32]
}

#[test]
fn append_first_entry_has_empty_prev_hash() {
    let dir = TempDir::new().unwrap();
    let mut log = Log::open(dir.path(), "alice").unwrap();
    let entry = Entry::new(0, 1_000_000, b"hello".to_vec(), empty_chain()).unwrap();
    let hash = log.append(&entry).unwrap();
    // hash must be 32 bytes, non-zero (sha3 of non-empty input)
    assert_eq!(hash.len(), 32);
    assert_ne!(hash, empty_chain());
}

#[test]
fn append_chains_prev_hash() {
    let dir = TempDir::new().unwrap();
    let mut log = Log::open(dir.path(), "alice").unwrap();
    let e1 = Entry::new(0, 1, b"one".to_vec(), empty_chain()).unwrap();
    let h1 = log.append(&e1).unwrap();
    let e2 = Entry::new(1, 2, b"two".to_vec(), h1).unwrap();
    let h2 = log.append(&e2).unwrap();
    assert_ne!(h1, h2);
    // e2 stored with prev_hash = h1
    assert_eq!(e2.prev_hash, h1);
}

#[test]
fn verify_clean_chain_succeeds() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().to_path_buf();
    let npub = "alice";

    let mut log = Log::open(&path, npub).unwrap();
    let mut prev = empty_chain();
    for i in 0..10 {
        let e = Entry::new(i as u64, i as u64 * 1000, format!("msg {}", i).into_bytes(), prev).unwrap();
        prev = log.append(&e).unwrap();
    }

    // Reopen and verify
    let log2 = Log::open(&path, npub).unwrap();
    log2.verify().unwrap();
}

#[test]
fn verify_detects_tampered_payload() {
    // Strategy: open Log, append 5 entries, close (drop). Tamper the last byte
    // of the file (guaranteed to be inside the last entry's postcard payload).
    // Reopen the Log: this calls verify internally during replay and must fail.
    let dir = TempDir::new().unwrap();
    let path = dir.path().to_path_buf();
    let npub = "alice";

    {
        let mut log = Log::open(&path, npub).unwrap();
        let mut prev = empty_chain();
        for i in 0..5 {
            let e = Entry::new(
                i as u64,
                i as u64 * 1000,
                format!("msg-pad-{}", i).into_bytes(),
                prev,
            )
            .unwrap();
            prev = log.append(&e).unwrap();
        }
    } // drop log, flushes writer

    let file = path.join(format!("{}.log", npub));
    let mut bytes = std::fs::read(&file).unwrap();
    let last = bytes.len() - 1;
    bytes[last] ^= 0xFF;
    std::fs::write(&file, &bytes).unwrap();

    let result = Log::open(&path, npub);
    assert!(matches!(result, Err(LogError::ChainBroken { .. })), "expected ChainBroken, got {:?}", result);
}

#[test]
fn merkle_root_of_single_entry_equals_entry_hash() {
    let dir = TempDir::new().unwrap();
    let mut log = Log::open(dir.path(), "alice").unwrap();
    let e = Entry::new(0, 1, b"only".to_vec(), empty_chain()).unwrap();
    let h = log.append(&e).unwrap();
    let root = log.merkle_root().unwrap();
    assert_eq!(root.as_bytes(), &h[..]);
}

#[test]
fn merkle_root_changes_when_appending() {
    let dir = TempDir::new().unwrap();
    let mut log = Log::open(dir.path(), "alice").unwrap();
    let e1 = Entry::new(0, 1, b"one".to_vec(), empty_chain()).unwrap();
    log.append(&e1).unwrap();
    let r1 = log.merkle_root().unwrap();
    let e2 = Entry::new(1, 2, b"two".to_vec(), r1.into_bytes()).unwrap();
    log.append(&e2).unwrap();
    let r2 = log.merkle_root().unwrap();
    assert_ne!(r1.as_bytes(), r2.as_bytes());
}

#[test]
fn entry_serde_roundtrip_postcard() {
    let e = Entry::new(42, 1_700_000_000, b"hi".to_vec(), [7u8; 32]).unwrap();
    let bytes = postcard::to_stdvec(&e).unwrap();
    let e2: Entry = postcard::from_bytes(&bytes).unwrap();
    assert_eq!(e.seq, e2.seq);
    assert_eq!(e.timestamp, e2.timestamp);
    assert_eq!(e.payload, e2.payload);
    assert_eq!(e.prev_hash, e2.prev_hash);
}

#[test]
fn different_contacts_get_different_files() {
    let dir = TempDir::new().unwrap();
    let path = dir.path().to_path_buf();
    let mut alice = Log::open(&path, "alice").unwrap();
    let mut bob = Log::open(&path, "bob").unwrap();
    let ea = Entry::new(0, 1, b"for alice".to_vec(), empty_chain()).unwrap();
    let eb = Entry::new(0, 1, b"for bob".to_vec(), empty_chain()).unwrap();
    let ha = alice.append(&ea).unwrap();
    let hb = bob.append(&eb).unwrap();
    assert_ne!(ha, hb);
    assert!(path.join("alice.log").exists());
    assert!(path.join("bob.log").exists());
}

#[test]
fn merkle_root_type_is_32_bytes() {
    let r = MerkleRoot::from_bytes([0u8; 32]);
    assert_eq!(r.as_bytes().len(), 32);
}