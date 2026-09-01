//! SQLite persistence layer for murmur envelopes (v149: npub-only, no aliases).
//!
//! Schema:
//!   envelopes(envelope_hash PK, from_npub, to_npub, body BLOB, sig BLOB, ts INTEGER)
//!   blobs + attachment_refs (ref_count cascaded on envelope delete)
//!
//! rusqlite + bundled: richer queries, BLOB support,
//! UNIQUE constraint for idempotency, transactional safety.

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use sha3::Digest;
use std::path::Path;
use std::sync::Arc;
use tracing::{debug, info, warn};

#[derive(Clone)]
pub struct MessageStore {
    conn: Arc<Mutex<Connection>>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ContactRow {
    pub peer: String,
    pub last_message_preview: String,
    pub last_ts: i64,
    pub unread_count: i64,
}

#[derive(Debug, Clone)]
pub struct HistoryRow {
    pub from_npub: String,
    pub to_npub: String,
    pub body: Vec<u8>,
    pub sig: Vec<u8>,
    pub ts: i64,
    pub envelope_hash: String,
    /// Phase 2 (Variant Б): attachments for this envelope.
    /// [{blob_id, wrapped_key, name, mime, size, position}]
    pub attachments: Vec<AttachmentMeta>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct AttachmentMeta {
    pub blob_id: String,
    pub wrapped_key: String,
    pub iv: String,
    pub name: String,
    pub mime: Option<String>,
    pub size: Option<u64>,
    pub position: i64,
}

#[derive(Debug)]
pub struct HistoryResponse {
    pub messages: Vec<HistoryRow>,
    pub next_before_ts: Option<i64>,
}

impl MessageStore {
    pub fn new(path: &Path) -> rusqlite::Result<Self> {
        #[allow(unused_mut)]
        let mut conn = Connection::open(path)?;
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS envelopes (
                envelope_hash TEXT PRIMARY KEY,
                from_npub     TEXT NOT NULL,
                to_npub       TEXT NOT NULL,
                body          BLOB NOT NULL,
                sig           BLOB NOT NULL DEFAULT X'',
                ts            INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_envelopes_from ON envelopes(from_npub);
            -- Phase 1 attachments (Variant B): blobs table + attachment_refs table.
            -- Lesson #165: отдельный /upload endpoint, inline base64 anti-pattern.
            CREATE TABLE IF NOT EXISTS blobs (
                id           TEXT PRIMARY KEY,
                sha256       CHAR(64) NOT NULL UNIQUE,
                mime         VARCHAR(127) NOT NULL,
                size         INTEGER NOT NULL CHECK (size > 0 AND size <= 52428800),
                storage_path TEXT NOT NULL,
                created_at   INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
                ref_count    INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_blobs_sha256 ON blobs(sha256);
            CREATE INDEX IF NOT EXISTS idx_blobs_created_at ON blobs(created_at);
            CREATE TABLE IF NOT EXISTS attachment_refs (
                id             TEXT PRIMARY KEY,
                envelope_hash  CHAR(64) NOT NULL,
                blob_id        TEXT NOT NULL REFERENCES blobs(id),
                wrapped_key    TEXT NOT NULL,
                iv             TEXT NOT NULL DEFAULT '',
                name           VARCHAR(255) NOT NULL,
                position       SMALLINT NOT NULL DEFAULT 0,
                created_at     INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER)),
                original_size  INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_attachment_refs_envelope ON attachment_refs(envelope_hash);
            CREATE INDEX IF NOT EXISTS idx_attachment_refs_blob ON attachment_refs(blob_id);
            ",
        )?;
        // Migration: если таблица envelopes была создана раньше, добавить expires_at.
        let has_expires: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('envelopes') WHERE name = 'expires_at'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if has_expires == 0 {
            conn.execute_batch(
                "ALTER TABLE envelopes ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;
                 CREATE INDEX IF NOT EXISTS idx_envelopes_expires_at ON envelopes(expires_at);",
            )?;
        }
        // Migration: если таблица envelopes была создана раньше, добавить read_at.
        let has_read_at: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('envelopes') WHERE name = 'read_at'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if has_read_at == 0 {
            conn.execute_batch(
                "ALTER TABLE envelopes ADD COLUMN read_at INTEGER NOT NULL DEFAULT 0;
                 CREATE INDEX IF NOT EXISTS idx_envelopes_recipient_unread ON envelopes(to_npub, from_npub, read_at);",
            )?;
        }
        // ── v149 npub-only migration ────────────────────────────────────────
        // Alias concept removed (Олег 2026-08-30): сервер хранит только npub-маршрутизацию.
        // 1) envelopes.to_alias → to_npub (RENAME COLUMN, SQLite >= 3.25).
        // 2) user_aliases таблица удаляется полностью.
        let has_to_npub: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('envelopes') WHERE name = 'to_npub'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if has_to_npub == 0 {
            conn.execute_batch(
                "DROP INDEX IF EXISTS idx_envelopes_recipient_unread;
                 DROP INDEX IF EXISTS idx_envelopes_to_alias;
                 DROP INDEX IF EXISTS idx_envelopes_to_alias_ts;
                 ALTER TABLE envelopes RENAME COLUMN to_alias TO to_npub;
                 CREATE INDEX IF NOT EXISTS idx_envelopes_recipient_unread ON envelopes(to_npub, from_npub, read_at);
                 DROP TABLE IF EXISTS user_aliases;",
            )?;
            info!("v149 migration: envelopes.to_alias → to_npub, user_aliases dropped");
        }
        // На всякий случай: если БД старая, а to_npub уже был (не должно случиться)
        let has_user_aliases: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='user_aliases'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if has_user_aliases > 0 {
            conn.execute_batch("DROP TABLE IF EXISTS user_aliases;")?;
            info!("v149 migration: user_aliases dropped");
        }
        // Индексы on to_npub — строго после миграции (на старой БД колонка
        // появляется только через RENAME COLUMN).
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_envelopes_to_npub ON envelopes(to_npub);
             CREATE INDEX IF NOT EXISTS idx_envelopes_to_npub_ts ON envelopes(to_npub, ts);",
        )?;
        // Migration: original_size в attachment_refs (Phase 2 enhancement).
        let has_original_size: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('attachment_refs') WHERE name = 'original_size'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if has_original_size == 0 {
            conn.execute_batch(
                "ALTER TABLE attachment_refs ADD COLUMN original_size INTEGER NOT NULL DEFAULT 0;",
            )?;
        }
        // Migration: iv в attachment_refs (Phase 3 — нужен получателю для AES-GCM decrypt).
        let has_iv: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('attachment_refs') WHERE name = 'iv'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if has_iv == 0 {
            conn.execute_batch(
                "ALTER TABLE attachment_refs ADD COLUMN iv TEXT NOT NULL DEFAULT '';",
            )?;
        }
        // v160f: identity transfer codes (перенос личности Safari → PWA на iOS,
        // разные хранилища). Сервер хранит ТОЛЬКО шифротекст под hash(code):
        // сам код (и ключ) серверу недоступны.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS identity_transfers (
                code_hash   CHAR(64) PRIMARY KEY,
                ct_b64      TEXT NOT NULL,
                created_at  INTEGER NOT NULL,
                expires_at  INTEGER NOT NULL,
                used        INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_identity_transfers_expires ON identity_transfers(expires_at);
            ",
        )?;
        debug!(db_path = %path.display(), "message store initialised");
        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    fn exec_sql(&self, sql: &str, p: impl rusqlite::Params) -> rusqlite::Result<usize> {
        self.conn.lock().execute(sql, p)
    }

    /// Crate-internal accessor for upload module to do raw SQL.
    pub(crate) fn with_conn<R>(&self, f: impl FnOnce(&mut rusqlite::Connection) -> rusqlite::Result<R>) -> rusqlite::Result<R> {
        let mut c = self.conn.lock();
        f(&mut c)
    }

    /// Generate a v4-like UUID string from OS RNG. Used for attachment_refs.id.
    pub fn new_attachment_ref_id() -> String {
        use rand::RngCore;
        let mut bytes = [0u8; 16];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        // Set version (4) and variant (RFC 4122).
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        format!(
            "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5],
            bytes[6], bytes[7],
            bytes[8], bytes[9],
            bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        )
    }

    pub fn upsert_envelope(
        &self,
        hash: &str,
        from: &str,
        to_npub: &str,
        body: &[u8],
        sig: &[u8],
        ts: i64,
        expires_at: i64,
    ) -> rusqlite::Result<bool> {
        let n = self.exec_sql(
            "INSERT OR IGNORE INTO envelopes (envelope_hash, from_npub, to_npub, body, sig, ts, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![hash, from, to_npub, body, sig, ts, expires_at],
        )?;
        Ok(n > 0)
    }

    /// Phase 2 (Variant Б): upsert envelope + insert attachment_refs atomically.
    /// attachments_meta: [{blob_id, wrapped_key, name, mime, size}] from envelope JSON.
    /// Returns Ok(true) if a NEW envelope was inserted (refcount for blobs incremented),
    /// Ok(false) if it was a duplicate (refs skipped to avoid double-counting).
    pub fn upsert_envelope_with_attachments(
        &self,
        hash: &str,
        from: &str,
        to_npub: &str,
        body: &[u8],
        sig: &[u8],
        ts: i64,
        expires_at: i64,
        attachments_meta: &[serde_json::Value],
    ) -> rusqlite::Result<bool> {
        let mut c = self.conn.lock();
        let tx = c.transaction()?;
        let n = tx.execute(
            "INSERT OR IGNORE INTO envelopes (envelope_hash, from_npub, to_npub, body, sig, ts, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![hash, from, to_npub, body, sig, ts, expires_at],
        )?;
        if n > 0 && !attachments_meta.is_empty() {
            // Increment ref_count for each blob referenced (only on first insert).
            for (pos, att) in attachments_meta.iter().enumerate() {
                let blob_id = att.get("blob_id").and_then(|v| v.as_str()).unwrap_or("");
                let wrapped_key = att.get("wrapped_key").and_then(|v| v.as_str()).unwrap_or("");
                let name = att.get("name").and_then(|v| v.as_str()).unwrap_or("");
                let iv = att.get("iv").and_then(|v| v.as_str()).unwrap_or("");
                // original_size = plaintext file size (before AES-256-GCM).
                // For Phase 2, captured from envelope attachments_meta.
                let original_size = att.get("size").and_then(|v| v.as_u64()).unwrap_or(0) as i64;
                if blob_id.is_empty() || wrapped_key.is_empty() {
                    continue;
                }
                // Validate blob exists before inserting ref.
                let blob_exists: bool = tx.query_row(
                    "SELECT 1 FROM blobs WHERE id = ?1",
                    params![blob_id],
                    |_| Ok(true),
                ).unwrap_or(false);
                if !blob_exists {
                    continue; // skip refs to non-existent blobs (orphan protection)
                }
                tx.execute(
                    "INSERT INTO attachment_refs (id, envelope_hash, blob_id, wrapped_key, iv, name, position, original_size)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![
                        MessageStore::new_attachment_ref_id(),
                        hash,
                        blob_id,
                        wrapped_key,
                        iv,
                        name,
                        pos as i64,
                        original_size,
                    ],
                )?;
                // Increment blob ref_count (so orphan cleanup knows it's still used).
                tx.execute(
                    "UPDATE blobs SET ref_count = ref_count + 1 WHERE id = ?1",
                    params![blob_id],
                )?;
            }
        }
        tx.commit()?;
        Ok(n > 0)
    }

    /// Lesson #130/#131: после успешной доставки envelope (через WS broadcast
    /// или /api/history) сокращаем TTL с 24ч до 5 минут. Через 5 мин cron
    /// физически удалит envelope. Таким образом сервер не хранит
    /// доставленные сообщения долго — это «honest relay» с разумным
    /// окном для offline peer'а.
    pub fn shorten_expires_at(&self, hash: &str, new_expires_at: i64) -> rusqlite::Result<()> {
        self.exec_sql(
            "UPDATE envelopes SET expires_at = ?1 WHERE envelope_hash = ?2",
            params![new_expires_at, hash],
        )?;
        Ok(())
    }



    pub fn get_contacts(&self, npub: &str) -> rusqlite::Result<Vec<ContactRow>> {
        // v149: npub-only. Контакты = пиров из envelopes (живут в TTL-окне).
        // unread считается клиентом (lesson #125) — серверный счётчик удалён
        // вместе с user_aliases.
        let peers: Vec<(String, i64)> = {
            let c = self.conn.lock();
            let mut stmt = c.prepare(
                "SELECT peer, MAX(last_ts) FROM (
                    SELECT e.from_npub as peer, MAX(e.ts) as last_ts
                    FROM envelopes e
                    WHERE e.to_npub = ?1 AND e.from_npub != ?1 AND e.from_npub != 'system:relay'
                    UNION
                    SELECT e.to_npub as peer, MAX(e.ts) as last_ts
                    FROM envelopes e
                    WHERE e.from_npub = ?1
                ) GROUP BY peer ORDER BY MAX(last_ts) DESC",
            )?;
            let result: Vec<(String, i64)> = stmt
                .query_map(params![npub], |r| Ok((r.get(0)?, r.get(1)?)))?
                .filter_map(|r| r.ok())
                .collect();
            result
        };

        let mut rows = Vec::new();
        for (peer, last_ts) in peers {
            let preview = self.preview_for_peer(&peer, npub)?;
            rows.push(ContactRow {
                peer,
                last_message_preview: preview,
                last_ts,
                unread_count: 0,
            });
        }
        Ok(rows)
    }

    pub(crate) fn preview_for_peer(&self, peer: &str, self_npub: &str) -> rusqlite::Result<String> {
        let c = self.conn.lock();
        let body: Option<Vec<u8>> = c.query_row(
            "SELECT body FROM envelopes \
             WHERE (from_npub = ?1 AND to_npub = ?2) \
                OR (to_npub = ?1 AND from_npub = ?2) \
             ORDER BY ts DESC LIMIT 1",
            params![peer, self_npub],
            |r| r.get(0),
        )
        .optional()?;
        if let Some(b) = body {
            if let Ok(s) = String::from_utf8(b.clone()) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                    // E2E: если envelope зашифрован (`ct` есть) — preview ВСЕГДА
                    // placeholder, иначе утекает ciphertext+signed_payload+sig.
                    // (Олег 2026-08-25 08:18 MSK)
                    if v.get("ct").and_then(|x| x.as_str()).is_some() {
                        return Ok("🔒 зашифрованное сообщение".to_string());
                    }
                    if let Some(bs) = v.get("body").and_then(|b| b.as_str()) {
                        return Ok(trunc(bs, 80));
                    }
                    if let Some(bs) = v
                        .get("payload")
                        .and_then(|p| p.get("body").and_then(|b| b.as_str()))
                    {
                        return Ok(trunc(bs, 80));
                    }
                    // Envelope JSON без body и без ct — fallback attachments.
                    if let Some(arr) = v.get("attachments_meta").and_then(|a| a.as_array()) {
                        if let Some(first) = arr.first().and_then(|x| x.get("name")).and_then(|n| n.as_str()) {
                            return Ok(format!("📎 {}", first));
                        }
                    }
                    // Ничего не нашли — возвращаем placeholder, а не сырой JSON.
                    return Ok("🔒 зашифрованное сообщение".to_string());
                }
                return Ok(trunc(&s, 80));
            }
            Ok(format!("binary({} bytes)", b.len()))
        } else {
            Ok("(no messages)".into())
        }
    }

    pub fn get_history(
        &self,
        npub: &str,
        peer: &str,
        limit: i64,
        before_ts: Option<i64>,
    ) -> rusqlite::Result<HistoryResponse> {
        let c = self.conn.lock();
        // v149: npub-only. `to_npub` — всегда полный npub получателя
        // (PWA POST /envelope?to=<npub>). Простая симметричная пара.
        let sql = if before_ts.is_some() {
            "SELECT from_npub, to_npub, body, sig, ts, envelope_hash FROM envelopes \
             WHERE ((from_npub = ?1 AND to_npub = ?2) OR (from_npub = ?2 AND to_npub = ?1)) \
              AND ts < ?3 \
             ORDER BY ts DESC LIMIT ?4".to_string()
        } else {
            "SELECT from_npub, to_npub, body, sig, ts, envelope_hash FROM envelopes \
             WHERE ((from_npub = ?1 AND to_npub = ?2) OR (from_npub = ?2 AND to_npub = ?1)) \
             ORDER BY ts DESC LIMIT ?3".to_string()
        };

        let mut rows: Vec<HistoryRow> = if let Some(bt) = before_ts {
            let mapped = c
                .prepare(&sql)?
                .query_map(params![npub, peer, bt, limit], |r| {
                    Ok(HistoryRow {
                        from_npub: r.get(0)?,
                        to_npub: r.get(1)?,
                        body: r.get(2)?,
                        sig: r.get(3)?,
                        ts: r.get(4)?,
                        envelope_hash: r.get(5)?,
                        attachments: Vec::new(),
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();
            mapped
        } else {
            let mapped = c
                .prepare(&sql)?
                .query_map(params![npub, peer, limit], |r| {
                    Ok(HistoryRow {
                        from_npub: r.get(0)?,
                        to_npub: r.get(1)?,
                        body: r.get(2)?,
                        sig: r.get(3)?,
                        ts: r.get(4)?,
                        envelope_hash: r.get(5)?,
                        attachments: Vec::new(),
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();
            mapped
        };

        // Phase 2: load attachment_refs for each envelope in batch.
        if !rows.is_empty() {
            let placeholders = std::iter::repeat("?").take(rows.len()).collect::<Vec<_>>().join(",");
            let att_sql = format!(
                "SELECT ar.envelope_hash, ar.blob_id, ar.wrapped_key, ar.iv, ar.name, b.mime, ar.original_size, ar.position \
                 FROM attachment_refs ar JOIN blobs b ON b.id = ar.blob_id \
                 WHERE ar.envelope_hash IN ({}) ORDER BY ar.position",
                placeholders
            );
            let hashes: Vec<&str> = rows.iter().map(|r| r.envelope_hash.as_str()).collect();
            let mut att_stmt = c.prepare(&att_sql)?;
            let att_rows = att_stmt
                .query_map(rusqlite::params_from_iter(hashes), |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        AttachmentMeta {
                            blob_id: r.get(1)?,
                            wrapped_key: r.get(2)?,
                            iv: r.get(3)?,
                            name: r.get(4)?,
                            mime: Some(r.get::<_, String>(5)?),
                            size: r.get::<_, Option<i64>>(6)?.map(|v| v as u64),
                            position: r.get(7)?,
                        },
                    ))
                })?
                .filter_map(|r| r.ok());
            // Group by envelope_hash.
            let mut by_hash: std::collections::HashMap<String, Vec<AttachmentMeta>> =
                std::collections::HashMap::new();
            for (h, meta) in att_rows {
                by_hash.entry(h).or_default().push(meta);
            }
            for row in rows.iter_mut() {
                if let Some(meta) = by_hash.remove(&row.envelope_hash) {
                    row.attachments = meta;
                }
            }
        }

        let next = rows.last().map(|r| r.ts);
        Ok(HistoryResponse {
            messages: rows,
            next_before_ts: next,
        })
    }

    /// Возвращает список envelope'ов, у которых истёк TTL и которые ещё
    /// не были помечены как возвращённые отправителю.
    pub fn list_expired_envelopes(&self) -> rusqlite::Result<Vec<ExpiredEnvelope>> {
        let c = self.conn.lock();
        let mut s = c.prepare(
            "SELECT envelope_hash, from_npub, to_npub, body, sig, ts, expires_at \
             FROM envelopes \
             WHERE expires_at > 0 AND expires_at < CAST(strftime('%s','now') AS INTEGER)",
        )?;
        let rows = s
            .query_map([], |r| {
                Ok(ExpiredEnvelope {
                    envelope_hash: r.get(0)?,
                    from_npub: r.get(1)?,
                    to_npub: r.get(2)?,
                    body: r.get(3)?,
                    sig: r.get(4)?,
                    ts: r.get(5)?,
                    expires_at: r.get(6)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// Возвращает отправителю envelope с системной пометкой «undelivered».
    /// Этот новый envelope имеет _kind = "undelivered", ссылается на
    /// original envelope_hash, и предназначен обратно отправителю.
    pub fn create_undelivered_notification(
        &self,
        original: &ExpiredEnvelope,
        recipient_npub: &str,
    ) -> rusqlite::Result<bool> {
        // Формируем новый envelope как JSON, чтобы PWA могла его прочитать.
        let body = serde_json::json!({
            "_kind": "undelivered",
            "original_envelope_hash": original.envelope_hash,
            "original_recipient": original.to_npub,
            "original_ts": original.ts,
            "reason": "expired",
            "message": "Адресат не заходил в сеть 24 часа. Попробуйте позже.",
        });
        let body_bytes = serde_json::to_vec(&body).unwrap_or_default();
        let new_hash = {
            let mut hasher = sha3::Sha3_256::new();
            Digest::update(&mut hasher, &body_bytes);
            hex::encode(Digest::finalize(hasher))
        };

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0) as i64;

        let n = self.exec_sql(
            "INSERT OR IGNORE INTO envelopes (envelope_hash, from_npub, to_npub, body, sig, ts, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                new_hash,
                "system:relay",      // отправитель — сам релей
                recipient_npub,      // уведомление уходит ОТПРАВИТЕСЮ оригинала
                body_bytes,
                b"",                 // без подписи
                now,
                now + 86400,         // тоже с TTL 24h
            ],
        )?;
        Ok(n > 0)
    }

    /// Удаляет envelope по hash + каскад вложений (v149, минимальное хранение):
    /// attachment_refs по hash сносятся, blob'ы декрементируются; blob с
    /// ref_count 0 удаляется физически (строка + файл). Вызывается из TTL-cron
    /// И из пути доставки после успешной broadcast — данные живут ровно столько,
    /// сколько нужно для маршрутизации.
    pub fn delete_envelope_by_hash(&self, hash: &str) -> rusqlite::Result<Vec<String>> {
        let mut deleted_files: Vec<String> = Vec::new();
        let c = self.conn.lock();
        // 1) Какие blob'ы привязаны к этому envelope?
        let blob_ids: Vec<(String, String)> = {
            let mut s = c.prepare(
                "SELECT ar.blob_id, COALESCE(b.storage_path, '') FROM attachment_refs ar \
                 LEFT JOIN blobs b ON b.id = ar.blob_id \
                 WHERE ar.envelope_hash = ?1",
            )?;
            let rows = s
                .query_map(params![hash], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };
        // 2) В одной транзакции: refs → декремент → удаление при ref_count <= 0.
        let tx = c.unchecked_transaction()?;
        tx.execute("DELETE FROM attachment_refs WHERE envelope_hash = ?1", params![hash])?;
        for (blob_id, storage_path) in &blob_ids {
            tx.execute(
                "UPDATE blobs SET ref_count = ref_count - 1 WHERE id = ?1",
                params![blob_id],
            )?;
            let remaining: i64 = tx.query_row(
                "SELECT ref_count FROM blobs WHERE id = ?1",
                params![blob_id],
                |r| r.get(0),
            ).unwrap_or(0);
            if remaining <= 0 {
                tx.execute("DELETE FROM blobs WHERE id = ?1", params![blob_id])?;
                if !storage_path.is_empty() {
                    deleted_files.push(storage_path.clone());
                }
            }
        }
        tx.commit()?;
        drop(c);
        // 3) Сам envelope.
        self.exec_sql("DELETE FROM envelopes WHERE envelope_hash = ?1", params![hash])?;
        // 4) Файлы — после коммита (I/O вне блокировки).
        for p in &deleted_files {
            let path = std::path::Path::new(p);
            if path.exists() {
                match std::fs::remove_file(path) {
                    Ok(_) => info!(blob = %p, "v149: blob file deleted (ref_count=0)"),
                    Err(e) => warn!(blob = %p, error = %e, "v149: failed to delete blob file"),
                }
            }
        }
        Ok(deleted_files)
    }

    /// v149: blob'ы без ссылок (orphan) — удалить. Вызывается из TTL-cron.
    // ── v160f: identity transfer codes ─────────────────────────────────────

    /// Сохранить шифротекст личности под hash(код). Возвращает expires_at.
    /// Одноразовый: used=0; 10 мин TTL. Старые протухшие чистим при создании.
    pub fn create_identity_transfer(
        &self,
        code_hash: &str,
        ct_b64: &str,
        now: i64,
        ttl_secs: i64,
    ) -> rusqlite::Result<i64> {
        let expires = now + ttl_secs;
        let c = self.conn.lock();
        // Cleanup: удаляем все истёкшие/использованные (лёгкий housekeeping).
        let _ = c.execute(
            "DELETE FROM identity_transfers WHERE expires_at < ?1 OR used = 1",
            rusqlite::params![now],
        );
        // Один активный код на шифротекст не ограничиваем (hash уникален),
        // но ограничим частоту на уровне приложения — клиент генерит новый код
        // только по явному клику.
        c.execute(
            "INSERT INTO identity_transfers (code_hash, ct_b64, created_at, expires_at, used) \
             VALUES (?1, ?2, ?3, ?4, 0)
             ON CONFLICT(code_hash) DO UPDATE SET ct_b64 = excluded.ct_b64, \
             created_at = excluded.created_at, expires_at = excluded.expires_at, used = 0",
            rusqlite::params![code_hash, ct_b64, now, expires],
        )?;
        Ok(expires)
    }

    /// Одноразовое потребление кода: атомарный UPDATE used=0→1 (защита от гонки).
    pub fn consume_identity_transfer(&self, code_hash: &str) -> rusqlite::Result<Option<String>> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0) as i64;
        let mut c = self.conn.lock();
        let row: Option<(String, i64, i64)> = c
            .query_row(
                "SELECT ct_b64, expires_at, used FROM identity_transfers WHERE code_hash = ?1",
                rusqlite::params![code_hash],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
            )
            .ok();
        let Some((ct_b64, expires_at, used)) = row else {
            return Ok(None);
        };
        if used == 1 || expires_at < now {
            let _ = c.execute(
                "DELETE FROM identity_transfers WHERE code_hash = ?1",
                rusqlite::params![code_hash],
            );
            return Ok(None);
        }
        let n = c.execute(
            "UPDATE identity_transfers SET used = 1 WHERE code_hash = ?1 AND used = 0",
            rusqlite::params![code_hash],
        )?;
        if n == 0 {
            return Ok(None); // проиграли гонку другому запросу
        }
        let _ = c.execute(
            "DELETE FROM identity_transfers WHERE code_hash = ?1",
            rusqlite::params![code_hash],
        );
        Ok(Some(ct_b64))
    }

    pub fn delete_orphan_blobs(&self) -> rusqlite::Result<Vec<String>> {
        let mut deleted_files: Vec<String> = Vec::new();
        let blob_ids: Vec<(String, String)> = {
            let c = self.conn.lock();
            let mut s = c.prepare(
                "SELECT b.id, b.storage_path FROM blobs b \
                 WHERE NOT EXISTS (SELECT 1 FROM attachment_refs ar WHERE ar.blob_id = b.id)",
            )?;
            let rows = s
                .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
                .filter_map(|r| r.ok())
                .collect();
            rows
        };
        if blob_ids.is_empty() {
            return Ok(deleted_files);
        }
        {
            let c = self.conn.lock();
            let tx = c.unchecked_transaction()?;
            for (blob_id, storage_path) in &blob_ids {
                tx.execute("DELETE FROM blobs WHERE id = ?1", params![blob_id])?;
                if !storage_path.is_empty() {
                    deleted_files.push(storage_path.clone());
                }
            }
            tx.commit()?;
        }
        for p in &deleted_files {
            let path = std::path::Path::new(p);
            if path.exists() {
                match std::fs::remove_file(path) {
                    Ok(_) => info!(blob = %p, "v149: orphan blob deleted"),
                    Err(e) => warn!(blob = %p, error = %e, "v149: failed to delete orphan blob file"),
                }
            }
        }
        Ok(deleted_files)
    }

    // Раньше здесь были unread_by_peer и mark_incoming_read — но клиент
    // теперь считает unread локально (см. lesson #125), серверная логика
    // для badge больше не нужна.
}

#[derive(Debug, Clone)]
pub struct ExpiredEnvelope {
    pub envelope_hash: String,
    pub from_npub: String,
    pub to_npub: String,
    pub body: Vec<u8>,
    pub sig: Vec<u8>,
    pub ts: i64,
    pub expires_at: i64,
}

fn trunc(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        format!("{}…", s.chars().take(max).collect::<String>())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;

    fn tmp() -> std::path::PathBuf {
        let mut p = env::temp_dir();
        p.push(format!(
            "murmur-storage-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_micros()
        ));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn schema_creation() {
        let db = MessageStore::new(&tmp().join("test.db")).unwrap();
        let n: i64 = db
            .conn
            .lock()
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        // v149: envelopes + blobs (+attachment_refs). user_aliases удалена.
        assert_eq!(n, 3);
    }

    #[test]
    fn upsert_idempotent() {
        let db = MessageStore::new(&tmp().join("idem.db")).unwrap();
        assert!(db
            .upsert_envelope("h1", "npub_alice", "npub_bob", b"Hello", b"sig1", 1000, 1000 + 86400)
            .unwrap());
        assert!(!db
            .upsert_envelope("h1", "npub_alice", "npub_bob", b"Hello", b"sig1", 1000, 1000 + 86400)
            .unwrap());
    }

    #[test]
    fn full_roundtrip() {
        let db = MessageStore::new(&tmp().join("rt.db")).unwrap();
        db.upsert_envelope("h1", "npub_alice", "npub_oleg", b"Hello!", b"sig1", 1000, 1000 + 86400)
            .unwrap();
        db.upsert_envelope("h2", "npub_oleg", "npub_alice", b"Hi Alice!", b"sig2", 1100, 1100 + 86400)
            .unwrap();

        let contacts = db.get_contacts("npub_oleg").unwrap();
        assert_eq!(contacts.len(), 1);
        assert_eq!(contacts[0].peer, "npub_alice");
        assert_eq!(contacts[0].last_ts, 1100);
        assert_eq!(contacts[0].unread_count, 0);

        let hist = db
            .get_history("npub_oleg", "npub_alice", 100, None)
            .unwrap();
        assert_eq!(hist.messages.len(), 2);
        assert_eq!(hist.messages[0].ts, 1100);
        assert_eq!(hist.messages[1].ts, 1000);

        let pag = db
            .get_history("npub_oleg", "npub_alice", 100, Some(1050))
            .unwrap();
        assert_eq!(pag.messages.len(), 1);
        assert_eq!(pag.messages[0].ts, 1000);
        assert_eq!(pag.next_before_ts, Some(1000));

        // v149: удаление envelope с каскадом blob'ов.
        db.delete_envelope_by_hash("h1").unwrap();
        let hist2 = db
            .get_history("npub_oleg", "npub_alice", 100, None)
            .unwrap();
        assert_eq!(hist2.messages.len(), 1);
    }

    #[test]
    fn blob_cascade_delete() {
        let db = MessageStore::new(&tmp().join("blobcasc.db")).unwrap();
        // 2 blob'а, один шарится между двумя envelope'ами.
        db.with_conn(|c| {
            c.execute_batch(
                "INSERT INTO blobs (id, sha256, mime, size, storage_path, created_at, ref_count) VALUES
                 ('b1', 's1', 'image/png', 10, '/tmp/b1', 0, 0),
                 ('b2', 's2', 'image/png', 10, '/tmp/b2', 0, 0);",
            )
        })
        .unwrap();
        let meta = serde_json::json!([
            {"blob_id": "b1", "wrapped_key": "k", "name": "a.png", "position": 0},
            {"blob_id": "b2", "wrapped_key": "k", "name": "b.png", "position": 1}
        ]);
        let meta2 = serde_json::json!([
            {"blob_id": "b1", "wrapped_key": "k", "name": "a.png", "position": 0}
        ]);
        db.upsert_envelope_with_attachments("e1", "npub_a", "npub_b", b"x", b"", 1000, 2000,
            meta.as_array().unwrap()).unwrap();
        db.upsert_envelope_with_attachments("e2", "npub_a", "npub_c", b"x", b"", 1001, 2001,
            meta2.as_array().unwrap()).unwrap();
        // b1: ref_count=2, b2: ref_count=1 (v149 Lesson #352: 0-start + increment
        // per ref — счётчик всегда равен числу живых attachment_refs).
        let (c1, c2): (i64, i64) = db.with_conn(|c| {
            let a: i64 = c.query_row("SELECT ref_count FROM blobs WHERE id='b1'", [], |r| r.get(0)).unwrap();
            let b: i64 = c.query_row("SELECT ref_count FROM blobs WHERE id='b2'", [], |r| r.get(0)).unwrap();
            Ok((a, b))
        }).unwrap();
        assert_eq!((c1, c2), (2, 1), "ref_count must equal live ref rows");
        db.delete_envelope_by_hash("e1").unwrap();
        let b1: i64 = db.with_conn(|c| c.query_row("SELECT ref_count FROM blobs WHERE id='b1'", [], |r| r.get(0))).unwrap();
        let b2: Option<i64> = db.with_conn(|c| c.query_row("SELECT ref_count FROM blobs WHERE id='b2'", [], |r| r.get(0)).optional()).map(|o| o.flatten()).unwrap_or(None);
        assert_eq!(b1, 1);
        assert!(b2.is_none(), "b2 must be deleted at ref_count=0");
        db.delete_envelope_by_hash("e2").unwrap();
        let left: i64 = db.with_conn(|c| c.query_row("SELECT COUNT(*) FROM blobs", [], |r| r.get(0))).unwrap();
        assert_eq!(left, 0, "all blobs gone after both envelopes deleted");
    }
}
