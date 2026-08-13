//! Persistent state for a witness per contact.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::WitnessError;

/// Metadata stored to `<witness_dir>/<contact>.json` after a successful
/// submit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WitnessMeta {
    pub contact: String,
    pub digest_hex: String,
    pub calendar_url: String,
    pub ok_ts: chrono::DateTime<chrono::Utc>,
    pub last_attempt_ts: chrono::DateTime<chrono::Utc>,
    pub last_error: Option<String>,
    pub attempts: u32,
}

/// Pending record stored to `<witness_dir>/pending/<contact>.json` when
/// the latest attempt failed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingRecord {
    pub contact: String,
    pub digest_hex: String,
    pub started_ts: chrono::DateTime<chrono::Utc>,
    pub error: String,
    pub attempted_calendar: Vec<String>,
}

/// Snapshot of witness state for `murmur-witness status`.
#[derive(Debug)]
pub struct WitnessStatus {
    /// Path to the last successful `.ots` file, if any.
    pub ots_path: Option<PathBuf>,
    /// Path to the meta JSON, if any.
    pub meta_path: Option<PathBuf>,
    /// Path to the pending JSON (last failed attempt), if any.
    pub pending_path: Option<PathBuf>,
    /// Parsed meta if present.
    pub meta: Option<WitnessMeta>,
    /// Pending record if present.
    pub pending: Option<PendingRecord>,
    /// Number of submit attempts observed (from meta or zero).
    pub attempts: u32,
}

impl WitnessStatus {
    pub fn read(witness_dir: &Path, contact: &str) -> Result<Self, WitnessError> {
        let ots_path = witness_dir.join(format!("{contact}.ots"));
        let meta_path = witness_dir.join(format!("{contact}.json"));
        let pending_path = witness_dir
            .join("pending")
            .join(format!("{contact}.json"));

        let meta = if meta_path.exists() {
            let bytes = std::fs::read(&meta_path)?;
            Some(serde_json::from_slice::<WitnessMeta>(&bytes)?)
        } else {
            None
        };
        let pending = if pending_path.exists() {
            let bytes = std::fs::read(&pending_path)?;
            Some(serde_json::from_slice::<PendingRecord>(&bytes)?)
        } else {
            None
        };
        let attempts = meta.as_ref().map(|m| m.attempts).unwrap_or(0);
        Ok(Self {
            ots_path: ots_path.exists().then_some(ots_path),
            meta_path: meta_path.exists().then_some(meta_path),
            pending_path: pending_path.exists().then_some(pending_path),
            meta,
            pending,
            attempts,
        })
    }
}
