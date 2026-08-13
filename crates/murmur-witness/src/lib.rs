//! `murmur-witness`: minimal OpenTimestamps submit layer.
//!
//! For each per-contact log, computes the Merkle root and submits it as a
//! 32-byte SHA-256 digest to an OpenTimestamps calendar server. The
//! resulting `DetachedTimestampFile` (Promise) is stored on disk next to
//! the log. On failure, the error is persisted to a `pending` file so the
//! user can run `murmur-witness status` and see what happened.
//!
//! We do NOT auto-retry or run a background loop — single-shot submit on
//! demand. This is a deliberately small surface area; upgrade/verify
//! against Bitcoin is a separate command (`prove`).

pub mod ots;
pub mod status;

use std::path::{Path, PathBuf};

use murmur_log::MerkleRoot;

/// Default OTS calendar pool (a.pool). B.pool is the fallback.
pub const DEFAULT_CALENDAR_URLS: &[&str] = &[
    "https://a.pool.opentimestamps.org",
    "https://b.pool.opentimestamps.org",
];

#[derive(Debug, thiserror::Error)]
pub enum WitnessError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("log error: {0}")]
    Log(#[from] murmur_log::LogError),
    #[error("ots serialization error: {0}")]
    Ots(String),
    #[error("all calendars failed: {}", .urls.join(", "))]
    AllCalendarsFailed { urls: Vec<String>, last: String },
    #[error("http error: {0}")]
    Http(String),
    #[error("invalid digest length: expected 32, got {0}")]
    InvalidDigestLength(usize),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Result of a witness attempt.
///
/// Either an OTS Promise was successfully obtained and saved, or the
/// attempt failed and the error was recorded to a `pending` file for
/// later inspection.
#[derive(Debug)]
pub enum SubmitOutcome {
    Ok {
        ots_path: PathBuf,
        digest_hex: String,
        calendar_url: String,
    },
    Pending {
        pending_path: PathBuf,
        digest_hex: String,
        error: String,
    },
}

/// Top-level API for one contact's witness state.
pub struct Witness {
    contact: String,
    /// Witness directory for this contact (e.g. `<home>/witness/`).
    witness_dir: PathBuf,
}

impl Witness {
    /// Construct a `Witness` handle for the given home directory + contact.
    /// The directory layout follows `murmur-log`: stores under
    /// `<home>/witness/`.
    pub fn new(home_dir: &Path, contact: &str) -> Result<Self, WitnessError> {
        let witness_dir = home_dir.join("witness");
        std::fs::create_dir_all(&witness_dir)?;
        Ok(Self {
            contact: contact.to_string(),
            witness_dir,
        })
    }

    /// Read the current status of the witness.
    pub fn status(&self) -> Result<status::WitnessStatus, WitnessError> {
        status::WitnessStatus::read(&self.witness_dir, &self.contact)
    }

    /// Build the canonical digest (SHA-256 of the Merkle root bytes) for
    /// submission. Returns `(digest_hex, digest_bytes)`.
    pub fn build_digest(
        &self,
        merkle_root: &MerkleRoot,
    ) -> (String, Vec<u8>) {
        let bytes = merkle_root.as_bytes().to_vec();
        let hex = hex::encode(&bytes);
        (hex, bytes)
    }

    /// Submit the current Merkle root of the contact's incoming log to
    /// the configured OTS calendar. Persists `.ots` on success or
    /// `.pending.json` on failure. Returns a `SubmitOutcome` describing
    /// what was written.
    ///
    /// Network IO is attempted against the default calendar pool
    /// (`DEFAULT_CALENDAR_URLS`). Failures are recorded, not propagated.
    pub fn submit(
        &self,
        merkle_root: &MerkleRoot,
    ) -> Result<SubmitOutcome, WitnessError> {
        let (digest_hex, digest_bytes) = self.build_digest(merkle_root);
        let started_ts = chrono::Utc::now();

        let (calendar_url, ots_bytes, error) =
            ots::submit_to_any(DEFAULT_CALENDAR_URLS, &digest_bytes);

        match (calendar_url, ots_bytes) {
            (Some(url), Some(ots_bytes)) => {
                // Success.
                let ots_path = self.witness_dir.join(format!("{}.ots", self.contact));
                std::fs::write(&ots_path, &ots_bytes)?;
                let meta = status::WitnessMeta {
                    contact: self.contact.clone(),
                    digest_hex: digest_hex.clone(),
                    calendar_url: url.clone(),
                    ok_ts: chrono::Utc::now(),
                    last_attempt_ts: chrono::Utc::now(),
                    last_error: None,
                    attempts: self.status().map(|s| s.attempts + 1).unwrap_or(1),
                };
                let meta_path = self.witness_dir.join(format!("{}.json", self.contact));
                std::fs::write(&meta_path, serde_json::to_vec_pretty(&meta)?)?;
                Ok(SubmitOutcome::Ok {
                    ots_path,
                    digest_hex,
                    calendar_url: url,
                })
            }
            (None, None) => {
                let err_msg = error.unwrap_or_else(|| "unknown error".to_string());
                let pending = status::PendingRecord {
                    contact: self.contact.clone(),
                    digest_hex: digest_hex.clone(),
                    started_ts,
                    error: err_msg.clone(),
                    attempted_calendar: DEFAULT_CALENDAR_URLS.iter().map(|s| s.to_string()).collect(),
                };
                let pending_path = self
                    .witness_dir
                    .join("pending")
                    .join(format!("{}.json", self.contact));
                std::fs::create_dir_all(pending_path.parent().unwrap())?;
                std::fs::write(&pending_path, serde_json::to_vec_pretty(&pending)?)?;
                Ok(SubmitOutcome::Pending {
                    pending_path,
                    digest_hex,
                    error: err_msg,
                })
            }
            _ => unreachable!(),
        }
    }
}
