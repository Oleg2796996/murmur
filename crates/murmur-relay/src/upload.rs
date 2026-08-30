//! `/api/upload` + `/api/blob/{id}` — Phase 1 Murmur Attachments (Variant B).
//!
//! Architecture (одобрено 4 профильными агентами в `memory/murmur/agents-feedback-2026-08-25.md`):
//! - Client шифрует файл локально (AES-256-GCM, ECIES-wrapped key) → POST /api/upload binary.
//! - Server хранит blob на диске (`data/blobs/{sha256[0:2]}/{sha256[2:4]}/{sha256}`).
//! - SHA-256 dedup: UNIQUE constraint в `blobs` таблице.
//! - `GET /api/blob/{id}` — recipient может скачать (auth через bearer npub + recipient check).
//!
//! Phase 1 (MVP) — без auth (как и /api/contacts в MVP-01). Будет добавлен bearer в Phase 2.
//! Anti-pattern: не inline base64 в envelope (Lesson #165).

use crate::storage::MessageStore;
use hyper::{body::Bytes, StatusCode};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BlobMeta {
    pub blob_id: String,
    pub sha256: String,
    pub size: u64,
    pub mime: String,
}

#[derive(Debug)]
pub struct UploadRequest {
    pub body: Bytes,
    pub wrapped_key: String,
    pub mime: String,
    pub name: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug)]
pub enum UploadError {
    BadRequest(String),
    IntegrityCheckFailed,
    TooLarge,
    Storage(String),
    NotFound,
    Forbidden(String),
}

impl UploadError {
    pub fn status(&self) -> StatusCode {
        match self {
            Self::BadRequest(_) => StatusCode::BAD_REQUEST,
            Self::IntegrityCheckFailed => StatusCode::BAD_REQUEST,
            Self::TooLarge => StatusCode::PAYLOAD_TOO_LARGE,
            Self::Storage(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::NotFound => StatusCode::NOT_FOUND,
            Self::Forbidden(_) => StatusCode::FORBIDDEN,
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::BadRequest(m) => m.clone(),
            Self::IntegrityCheckFailed => "sha256 mismatch".into(),
            Self::TooLarge => "file too large (max 50 MB)".into(),
            Self::Storage(m) => format!("storage error: {}", m),
            Self::NotFound => "blob not found".into(),
            Self::Forbidden(m) => m.clone(),
        }
    }
}

impl From<rusqlite::Error> for UploadError {
    fn from(e: rusqlite::Error) -> Self {
        UploadError::Storage(format!("sqlite: {}", e))
    }
}

const MAX_BLOB_SIZE: u64 = 50 * 1024 * 1024; // 50 MB
const BLOB_DIR: &str = "blobs";

/// Validate metadata, verify sha256, write to filesystem, insert DB row.
/// Returns BlobMeta. If sha256 already exists — returns existing blob_id (idempotent).
pub fn handle_upload(
    store: &MessageStore,
    home_dir: &PathBuf,
    req: UploadRequest,
) -> Result<BlobMeta, UploadError> {
    // 1. Validate size
    if req.size > MAX_BLOB_SIZE {
        return Err(UploadError::TooLarge);
    }
    if req.body.len() as u64 != req.size {
        return Err(UploadError::BadRequest(format!(
            "size mismatch: header says {} bytes, body has {}",
            req.size,
            req.body.len()
        )));
    }

    // 2. Validate sha256 format
    if req.sha256.len() != 64 || !req.sha256.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(UploadError::BadRequest("invalid sha256 format".into()));
    }

    // 3. Verify sha256 of received bytes (Lesson #166: integrity check mandatory).
    let mut hasher = Sha256::new();
    hasher.update(&req.body);
    let actual = format!("{:x}", hasher.finalize());
    if actual != req.sha256 {
        return Err(UploadError::IntegrityCheckFailed);
    }

    // 4. Idempotency: check if sha256 already exists.
    if let Some(existing_id) = store.find_blob_id_by_sha256(&req.sha256)? {
        tracing::info!(
            sha256 = %req.sha256,
            blob_id = %existing_id,
            "dedup hit — returning existing blob"
        );
        let blob = store.get_blob_by_id(&existing_id)?.ok_or(UploadError::NotFound)?;
        return Ok(BlobMeta {
            blob_id: existing_id,
            sha256: blob.sha256,
            size: blob.size as u64,
            mime: blob.mime,
        });
    }

    // 5. Generate blob_id and write to filesystem (sharded by hash prefix).
    let blob_id = Uuid::new_v4().to_string();
    let blob_dir = home_dir.join(BLOB_DIR);
    let shard1 = &req.sha256[0..2];
    let shard2 = &req.sha256[2..4];
    let shard_dir = blob_dir.join(shard1).join(shard2);

    std::fs::create_dir_all(&shard_dir)
        .map_err(|e| UploadError::Storage(format!("mkdir failed: {}", e)))?;

    let blob_path = shard_dir.join(&req.sha256);
    std::fs::write(&blob_path, &req.body)
        .map_err(|e| UploadError::Storage(format!("write failed: {}", e)))?;

    // 6. Insert into blobs table.
    store.insert_blob(&blob_id, &req.sha256, &req.mime, req.size, &blob_path.to_string_lossy())?;

    tracing::info!(
        blob_id = %blob_id,
        sha256 = %req.sha256,
        size = req.size,
        mime = %req.mime,
        name = %req.name,
        "blob uploaded"
    );

    Ok(BlobMeta {
        blob_id,
        sha256: req.sha256,
        size: req.size,
        mime: req.mime,
    })
}

/// Look up blob by id, check authorization (Phase 1: open, Phase 2: bearer).
/// Returns (blob_path, blob_meta) or error.
pub fn handle_download(
    store: &MessageStore,
    blob_id: &str,
) -> Result<(PathBuf, BlobMeta), UploadError> {
    let blob = store
        .get_blob_by_id(blob_id)?
        .ok_or(UploadError::NotFound)?;

    let path = PathBuf::from(&blob.storage_path);
    if !path.exists() {
        return Err(UploadError::NotFound);
    }

    Ok((
        path,
        BlobMeta {
            blob_id: blob_id.to_string(),
            sha256: blob.sha256,
            size: blob.size as u64,
            mime: blob.mime,
        },
    ))
}

impl MessageStore {
    /// Lookup blob_id by sha256 (idempotency dedup).
    pub fn find_blob_id_by_sha256(&self, sha256: &str) -> rusqlite::Result<Option<String>> {
        self.with_conn(|c| {
            c.query_row(
                "SELECT id FROM blobs WHERE sha256 = ?1",
                params![sha256],
                |r| r.get(0),
            )
            .optional()
        })
    }

    /// Get blob by id.
    pub fn get_blob_by_id(&self, blob_id: &str) -> rusqlite::Result<Option<BlobRow>> {
        self.with_conn(|c| {
            c.query_row(
                "SELECT id, sha256, mime, size, storage_path FROM blobs WHERE id = ?1",
                params![blob_id],
                |r| {
                    Ok(BlobRow {
                        id: r.get(0)?,
                        sha256: r.get(1)?,
                        mime: r.get(2)?,
                        size: r.get(3)?,
                        storage_path: r.get(4)?,
                    })
                },
            )
            .optional()
        })
    }

    /// Insert new blob. v149: ref_count starts at 0 — it is incremented
    /// once per actual reference in `upsert_envelope_with_attachments`, so
    /// ref_count always equals the number of live attachment_refs rows.
    /// (DEFAULT 1 + link increment double-counted; harmless for the
    /// rows-based cascade, but lied in metadata and left zombie blobs for
    /// the orphan sweep to collect — Lesson #352.)
    pub fn insert_blob(
        &self,
        id: &str,
        sha256: &str,
        mime: &str,
        size: u64,
        storage_path: &str,
    ) -> rusqlite::Result<()> {
        self.with_conn(|c| {
            c.execute(
                "INSERT INTO blobs (id, sha256, mime, size, storage_path, ref_count) VALUES (?1, ?2, ?3, ?4, ?5, 0)",
                params![id, sha256, mime, size as i64, storage_path],
            )?;
            Ok(())
        })
    }
}

#[derive(Debug, Clone)]
pub struct BlobRow {
    pub id: String,
    pub sha256: String,
    pub mime: String,
    pub size: i64,
    pub storage_path: String,
}
