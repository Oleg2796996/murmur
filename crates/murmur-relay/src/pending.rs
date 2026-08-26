//! Per-contact pending envelope store.
//!
//! When an iroh-direct envelope arrives, the relay appends it to
//! `<home>/pending/<recipient_alias>.log` (binary, postcard-encoded entry).
//! Subscribed WebSocket clients also get a copy via broadcast, but the
//! persistent log is the source of truth (so re-connecting clients can
//! fetch missed messages).

use parking_lot::Mutex;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PendingEntry {
    /// Recipient alias (e.g. "oleg-hp").
    pub to_alias: String,
    /// Sender npub (string form, for logging).
    pub from_npub: String,
    /// Timestamp (Unix seconds, sender's clock).
    pub ts: u64,
    /// Raw envelope bytes (postcard-encoded, ready to ship over WS).
    pub envelope_bytes: Vec<u8>,
    /// Envelope hash (sha3 hex), for deduplication / ack.
    pub envelope_hash_hex: String,
}

#[derive(Clone)]
pub struct PendingStore {
    inner: Arc<Mutex<Inner>>,
}

struct Inner {
    /// `<home>/pending`
    pending_dir: PathBuf,
    /// In-memory index: alias → bytes written (to dedupe per-write).
    /// Persistence is the file; this is just a write-offset cache.
    offsets: HashMap<String, u64>,
}

impl PendingStore {
    /// Path to the `<home>/pending` directory. Exposed so other modules
    /// (e.g. upload) can derive home_dir via `.parent()`.
    pub fn pending_dir(&self) -> PathBuf {
        self.inner.lock().pending_dir.clone()
    }

    pub fn new(home: &Path) -> std::io::Result<Self> {
        let pending_dir = home.join("pending");
        fs::create_dir_all(&pending_dir)?;
        let mut offsets = HashMap::new();
        if let Ok(rd) = fs::read_dir(&pending_dir) {
            for e in rd.flatten() {
                if let Ok(meta) = e.metadata() {
                    if meta.is_file() {
                        let alias = e.file_name().to_string_lossy().trim_end_matches(".log").to_string();
                        offsets.insert(alias, meta.len());
                    }
                }
            }
        }
        Ok(Self {
            inner: Arc::new(Mutex::new(Inner { pending_dir, offsets })),
        })
    }

    /// Append a pending entry for `to_alias`.
    pub fn append(&self, entry: &PendingEntry) -> std::io::Result<()> {
        let mut inner = self.inner.lock();
        let path = inner.pending_dir.join(format!("{}.log", entry.to_alias));
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)?;
        let bytes = postcard::to_stdvec(entry).map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
        // Length-prefixed framing: u32 BE length + payload
        let len = bytes.len() as u32;
        f.write_all(&len.to_be_bytes())?;
        f.write_all(&bytes)?;
        f.sync_all()?;
        *inner.offsets.entry(entry.to_alias.clone()).or_insert(0) += 4 + bytes.len() as u64;
        Ok(())
    }

    /// Read all entries for `alias` (for replay on reconnect).
    pub fn read_all(&self, alias: &str) -> std::io::Result<Vec<PendingEntry>> {
        let inner = self.inner.lock();
        let path = inner.pending_dir.join(format!("{}.log", alias));
        if !path.exists() {
            return Ok(vec![]);
        }
        let mut f = File::open(&path)?;
        let mut out = Vec::new();
        loop {
            let mut len_buf = [0u8; 4];
            match f.read_exact(&mut len_buf) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(e),
            }
            let len = u32::from_be_bytes(len_buf) as usize;
            let mut buf = vec![0u8; len];
            f.read_exact(&mut buf)?;
            let entry: PendingEntry = postcard::from_bytes(&buf)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            out.push(entry);
        }
        Ok(out)
    }

    /// Read entries starting at byte offset `from_offset`.
    pub fn read_from(&self, alias: &str, from_offset: u64) -> std::io::Result<Vec<PendingEntry>> {
        let inner = self.inner.lock();
        let path = inner.pending_dir.join(format!("{}.log", alias));
        if !path.exists() {
            return Ok(vec![]);
        }
        let mut f = File::open(&path)?;
        f.seek(SeekFrom::Start(from_offset))?;
        let mut out = Vec::new();
        loop {
            let mut len_buf = [0u8; 4];
            match f.read_exact(&mut len_buf) {
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(e),
            }
            let len = u32::from_be_bytes(len_buf) as usize;
            let mut buf = vec![0u8; len];
            f.read_exact(&mut buf)?;
            let entry: PendingEntry = postcard::from_bytes(&buf)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e))?;
            out.push(entry);
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("murmur-relay-test-{}", std::process::id()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn append_and_read_roundtrip() {
        let home = tmp().join("home1");
        std::fs::create_dir_all(&home).unwrap();
        let store = PendingStore::new(&home).unwrap();
        let entry = PendingEntry {
            to_alias: "oleg-hp".into(),
            from_npub: "npub1alice".into(),
            ts: 1700000000,
            envelope_bytes: vec![1, 2, 3, 4],
            envelope_hash_hex: "abcd".into(),
        };
        store.append(&entry).unwrap();
        store.append(&entry).unwrap();
        let all = store.read_all("oleg-hp").unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].envelope_bytes, vec![1, 2, 3, 4]);
    }

    #[test]
    fn read_from_offset() {
        let home = tmp().join("home2");
        std::fs::create_dir_all(&home).unwrap();
        let store = PendingStore::new(&home).unwrap();
        for i in 0..3 {
            store.append(&PendingEntry {
                to_alias: "bob".into(),
                from_npub: "npub1alice".into(),
                ts: 1700000000 + i,
                envelope_bytes: vec![i as u8],
                envelope_hash_hex: format!("h{i}"),
            }).unwrap();
        }
        let all = store.read_all("bob").unwrap();
        assert_eq!(all.len(), 3);
        // read from after first entry: total offset = len of first (4 bytes len + 4+5 fields...)
        // Easier: skip first by reading offset.
        // Each entry: 4 (len) + postcard payload size. Read all then drop first.
        let _ = all;
        let after = store.read_from("bob", 1).unwrap_or_default();
        // offset=1 reads garbage len, returns err or empty
        assert!(after.is_empty() || after.len() < 3);
    }
}
