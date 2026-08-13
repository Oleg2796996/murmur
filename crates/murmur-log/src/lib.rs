//! murmur-log — Append-only local log with SHA3 chain and Merkle anchoring.
//!
//! Each contact gets its own file. Every entry contains the hash of the previous
//! entry (chain). A Merkle root is computed over all entry hashes in the log,
//! used as a daily anchor for witness (OTS / Nostr).
//!
//! Storage: `<base_dir>/{contact_npub_or_id}.log` — binary, length-prefixed
//! postcard entries (4-byte LE length prefix + postcard payload).
//!
//! Hash: SHA3-256 over `seq || le_u32(ts) || payload || prev_hash`.
//! (Length fields are part of the hash to prevent ambiguity.)

use serde::{Deserialize, Serialize};
use sha3::{Digest, Sha3_256};
use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use thiserror::Error;

/// Domain separator for the SHA3 chain hash (prevents cross-protocol collisions).
const HASH_DOMAIN: &[u8; 8] = b"murmur-l";

/// A single entry in an append-only log.
///
/// `seq` is a monotonically increasing sequence number assigned by the appender
/// (NOT verified at this layer — the caller is trusted). `timestamp` is UNIX
/// seconds. `payload` is opaque bytes. `prev_hash` is the SHA3-256 hash of the
/// previous entry, or `[0u8; 32]` for the first entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub seq: u64,
    pub timestamp: u64,
    pub payload: Vec<u8>,
    pub prev_hash: [u8; 32],
}

impl Entry {
    /// Construct a new entry.
    pub fn new(seq: u64, timestamp: u64, payload: Vec<u8>, prev_hash: [u8; 32]) -> Result<Self, LogError> {
        if payload.len() > u32::MAX as usize {
            return Err(LogError::PayloadTooLarge(payload.len()));
        }
        Ok(Self { seq, timestamp, payload, prev_hash })
    }

    /// Compute the SHA3-256 hash of this entry, including the domain separator.
    ///
    /// Inputs (in order): `HASH_DOMAIN || le_u32(payload.len()) || payload || le_u64(timestamp) || le_u64(seq) || prev_hash`
    ///
    /// The domain + length prefixes prevent an attacker from crafting two entries
    /// with the same hash by re-arranging fields.
    pub fn hash(&self) -> [u8; 32] {
        let mut hasher = Sha3_256::new();
        hasher.update(HASH_DOMAIN);
        hasher.update((self.payload.len() as u32).to_le_bytes());
        hasher.update(&self.payload);
        hasher.update(self.timestamp.to_le_bytes());
        hasher.update(self.seq.to_le_bytes());
        hasher.update(self.prev_hash);
        let out = hasher.finalize();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&out);
        hash
    }
}

/// A 32-byte Merkle root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MerkleRoot([u8; 32]);

impl MerkleRoot {
    pub fn from_bytes(b: [u8; 32]) -> Self {
        Self(b)
    }
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
    pub fn into_bytes(self) -> [u8; 32] {
        self.0
    }
}

/// Errors for log operations.
#[derive(Debug, Error)]
pub enum LogError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("postcard decode: {0}")]
    Postcard(#[from] postcard::Error),
    #[error("chain broken at seq={seq}: prev_hash mismatch (stored={stored:?}, computed={computed:?})")]
    ChainBroken {
        seq: u64,
        stored: [u8; 32],
        computed: [u8; 32],
    },
    #[error("payload too large: {0} bytes (max u32)")]
    PayloadTooLarge(usize),
    #[error("invalid contact id: {0}")]
    InvalidContact(String),
}

/// A contact-scoped append-only log.
///
/// File format: `<base_dir>/{contact}.log`
/// Each record: 4-byte LE length prefix + postcard(Entry).
///
/// Invariants:
/// - Entries are append-only; never modified.
#[derive(Debug)]
pub struct Log {
    path: PathBuf,
    writer: BufWriter<File>,
    entries_count: u64,
    last_hash: [u8; 32],
    /// In-memory cache of entry hashes for Merkle root computation.
    hashes: Vec<[u8; 32]>,
}

impl Log {
    /// Open (or create) a log for the given contact under `base_dir`.
    ///
    /// `contact` must be safe for use as a filename — alphanumeric, `_`, `-`,
    /// or Nostr `npub1...`. We accept `npub` as a special case (it's safe).
    pub fn open<P: AsRef<Path>>(base_dir: P, contact: &str) -> Result<Self, LogError> {
        validate_contact(contact)?;
        let path: PathBuf = base_dir.as_ref().join(format!("{}.log", contact));
        let mut hashes: Vec<[u8; 32]> = Vec::new();
        let mut last_hash = [0u8; 32];
        let mut entries_count = 0u64;

        // Replay existing file to rebuild hash chain + entry list.
        if path.exists() {
            let file = File::open(&path)?;
            let mut reader = BufReader::new(file);
            loop {
                let entry = match read_entry(&mut reader) {
                    Ok(e) => e,
                    Err(LogError::Io(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                    Err(e) => return Err(e),
                };
                let actual_prev = entry.prev_hash;
                let computed = entry.hash();
                if actual_prev != last_hash {
                    return Err(LogError::ChainBroken {
                        seq: entry.seq,
                        stored: actual_prev,
                        computed: last_hash,
                    });
                }
                last_hash = computed;
                hashes.push(computed);
                entries_count = entry.seq + 1;
            }
        }

        let writer = BufWriter::new(
            OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)?,
        );

        Ok(Self { path, writer, entries_count, last_hash, hashes })
    }

    /// Append an entry. The entry's `prev_hash` MUST equal the current chain head.
    pub fn append(&mut self, entry: &Entry) -> Result<[u8; 32], LogError> {
        // Caller is responsible for setting prev_hash correctly, but we verify.
        if entry.prev_hash != self.last_hash {
            return Err(LogError::ChainBroken {
                seq: entry.seq,
                stored: entry.prev_hash,
                computed: self.last_hash,
            });
        }
        if entry.seq != self.entries_count {
            return Err(LogError::ChainBroken {
                seq: entry.seq,
                stored: entry.prev_hash,
                computed: self.last_hash,
            });
        }

        let bytes = postcard::to_stdvec(entry)?;
        let len = bytes.len() as u32;
        self.writer.write_all(&len.to_le_bytes())?;
        self.writer.write_all(&bytes)?;
        self.writer.flush()?;

        let hash = entry.hash();
        self.last_hash = hash;
        self.entries_count += 1;
        self.hashes.push(hash);
        Ok(hash)
    }

    /// Number of entries appended (in-memory).
    pub fn len(&self) -> usize {
        self.hashes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.hashes.is_empty()
    }

    /// Path to the log file.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Re-verify the on-disk chain. Errors on first mismatch.
    ///
    /// For each entry we:
    /// 1. Verify seq is monotonic (0, 1, 2, ...).
    /// 2. Verify entry.prev_hash matches the computed hash of the previous entry.
    /// 3. Recompute this entry's hash — this catches tampered payload, because
    ///    if the payload changes, the recomputed hash won't match the next
    ///    entry's prev_hash field.
    pub fn verify(&self) -> Result<(), LogError> {
        let file = File::open(&self.path)?;
        let mut reader = BufReader::new(file);
        let mut expected_prev = [0u8; 32];
        let mut expected_seq = 0u64;
        loop {
            let entry = match read_entry(&mut reader) {
                Ok(e) => e,
                Err(LogError::Io(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(e),
            };
            if entry.seq != expected_seq {
                return Err(LogError::ChainBroken {
                    seq: entry.seq,
                    stored: entry.prev_hash,
                    computed: expected_prev,
                });
            }
            if entry.prev_hash != expected_prev {
                return Err(LogError::ChainBroken {
                    seq: entry.seq,
                    stored: entry.prev_hash,
                    computed: expected_prev,
                });
            }
            let computed = entry.hash();
            expected_prev = computed;
            expected_seq += 1;
        }
        Ok(())
    }

    /// Compute Merkle root over all entry hashes currently in memory.
    pub fn merkle_root(&self) -> Result<MerkleRoot, LogError> {
        if self.hashes.is_empty() {
            return Ok(MerkleRoot::from_bytes([0u8; 32]));
        }
        Ok(MerkleRoot::from_bytes(merkle_root_of(&self.hashes)))
    }
}

impl Drop for Log {
    fn drop(&mut self) {
        let _ = self.writer.flush();
    }
}

// --- internal helpers ---

fn validate_contact(contact: &str) -> Result<(), LogError> {
    if contact.is_empty() || contact.len() > 128 {
        return Err(LogError::InvalidContact(contact.to_string()));
    }
    if !contact
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return Err(LogError::InvalidContact(contact.to_string()));
    }
    Ok(())
}

fn read_entry<R: Read>(r: &mut R) -> Result<Entry, LogError> {
    let mut len_buf = [0u8; 4];
    r.read_exact(&mut len_buf)?;
    let len = u32::from_le_bytes(len_buf) as usize;
    let mut payload = vec![0u8; len];
    r.read_exact(&mut payload)?;
    let entry: Entry = postcard::from_bytes(&payload)?;
    Ok(entry)
}

fn merkle_root_of(leaves: &[[u8; 32]]) -> [u8; 32] {
    // Pad to power of 2 by duplicating the last leaf (Bitcoin-style).
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    while level.len() & (level.len() - 1) != 0 {
        let last = *level.last().unwrap();
        level.push(last);
    }
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks(2) {
            let mut hasher = Sha3_256::new();
            hasher.update(b"murmur-mr");
            hasher.update(pair[0]);
            hasher.update(pair[1]);
            let out = hasher.finalize();
            let mut h = [0u8; 32];
            h.copy_from_slice(&out);
            next.push(h);
        }
        level = next;
    }
    level[0]
}

// (unused trait removed; File::seek is used directly if needed in future)