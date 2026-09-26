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

/// v160s4: SHA-256 хэш npub для aggregates-only статистики. Односторонняя
/// функция — связь хэша с сообщениями/личностью не восстанавливается.
fn murmur_sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    Digest::update(&mut h, data);
    hex::encode(Digest::finalize(h))
}

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

/// v160s: агрегаты для admin dashboard (только числа, без PII).
#[derive(Debug, serde::Serialize)]
pub struct StatsSnapshot {
    pub generated_at: i64,
    pub unique_peers_total: i64,
    pub unique_peers_24h: i64,
    pub envelopes_pending: i64,
    pub envelopes_24h: i64,
    pub envelopes_total: i64,
    pub blobs_total: i64,
    pub blobs_bytes_total: i64,
    pub blobs_24h: i64,
    /// (hour_bucket_unix, count) — 48h
    pub msgs_hourly: Vec<(i64, i64)>,
    /// (day_bucket_unix, count, bytes) — 7d
    pub blobs_daily: Vec<(i64, i64, i64)>,
    // v160s6 (Олег 2026-09-17): новый формат дашборда.
    /// доставлено сегодня (счётчик stats_daily.delivered)
    pub delivered_today: i64,
    /// отправлено сегодня (stats_daily.msgs)
    pub msgs_today: i64,
    /// активные пользователи за 24h (seen_users_day, сегодня+вчера)
    pub active_users_24h: i64,
    /// недоставленные (24h-TTL, получатель не забрал)
    pub envelopes_undelivered: i64,
    /// байт занято под relay (envelopes + blobs на диске)
    pub disk_used_bytes: i64,
    /// байт свободно на разделе home_dir
    pub disk_free_bytes: i64,
    /// всего байт на разделе home_dir
    pub disk_total_bytes: i64,
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
            -- v160s4 (Олег 2026-09-16): aggregates-only статистика. Хэши npub
            -- (SHA-256) для счётчика новых пользователей: односторонняя функция,
            -- связь хэша с сообщениями не восстанавливается. Сами npub тут НЕ храним.
            CREATE TABLE IF NOT EXISTS seen_users (
                npub_hash     TEXT PRIMARY KEY,
                first_seen    INTEGER NOT NULL
            );
            -- Уникальность в пределах дня (для active_users).
            CREATE TABLE IF NOT EXISTS seen_users_day (
                npub_hash     TEXT NOT NULL,
                day           INTEGER NOT NULL,
                PRIMARY KEY (npub_hash, day)
            );
            -- v160s5: dedupe счётчика сообщений (1 раз на envelope,
            -- без дублей от повторных /api/history-опросов).
            CREATE TABLE IF NOT EXISTS msgs_counted (
                envelope_hash TEXT PRIMARY KEY,
                day           INTEGER NOT NULL
            );
            -- Сводная таблица по дням: инкременты при delivery/register.
            -- Живёт вечно (не зависит от 5-min TTL).
            CREATE TABLE IF NOT EXISTS stats_daily (
                day           INTEGER PRIMARY KEY, -- unix midnight UTC
                new_users     INTEGER NOT NULL DEFAULT 0,
                active_users  INTEGER NOT NULL DEFAULT 0,
                msgs          INTEGER NOT NULL DEFAULT 0,
                delivered     INTEGER NOT NULL DEFAULT 0 -- v160s6: доставлено за день
            );
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
            -- v160p Phase 2: bearer tokens for blob download. Token = 32 random bytes,
            -- server generates at upload, receiver presents at download. Stored server-side
            -- only (never in plaintext envelope — client keeps it in sealed ct).
            CREATE TABLE IF NOT EXISTS blob_tokens (
                blob_id    TEXT PRIMARY KEY REFERENCES blobs(id),
                token_hash CHAR(64) NOT NULL UNIQUE,
                created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER))
            );
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
        // v160s6 (Олег 2026-09-17): stats_daily.delivered для старых БД.
        let has_delivered: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('stats_daily') WHERE name = 'delivered'",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);
        if has_delivered == 0 {
            conn.execute_batch(
                "ALTER TABLE stats_daily ADD COLUMN delivered INTEGER NOT NULL DEFAULT 0;",
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
        // v160o: wall-clock для refresh created_at при ref_count++ (см. ниже).
        let now_ts: i64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
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
                // v160o: ref_count refresh — «24h от последней отправки».
                // Дедуп-хит оживляет старый blob (orphan cleanup отсчитывает от created_at).
                tx.execute(
                    "UPDATE blobs SET ref_count = ref_count + 1, created_at = ?2 WHERE id = ?1",
                    params![blob_id, now_ts],
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
    /// v160s4: отмечает активность пользователя (по хэшу npub) за сегодня.
    /// Возвращает true, если пользователь СЕГОДНЯ впервые активен (для
    /// active_users-инкремента), false если уже отмечен сегодня.
    /// new_users инкрементится только при ПЕРВОМ появлении за всё время.
    pub fn record_user_activity(&self, npub: &str, ts: i64) -> rusqlite::Result<(bool, bool)> {
        let hash = murmur_sha256_hex(npub.as_bytes());
        let day = ts - (ts % 86400); // unix midnight UTC
        let c = self.conn.lock();
        // Первый раз за всё время?
        let seen: Option<i64> = c
            .query_row(
                "SELECT first_seen FROM seen_users WHERE npub_hash = ?1",
                params![hash],
                |r| r.get(0),
            )
            .optional()?;
        let is_new = seen.is_none();
        if is_new {
            c.execute(
                "INSERT INTO seen_users (npub_hash, first_seen) VALUES (?1, ?2)",
                params![hash, ts],
            )?;
        }
        // Инкремент active_users за день: active_users в строке дня = счётчик
        // активных СЕГОДНЯ. Уникальность в пределах дня: если today_first=0 и
        // строка дня уже существует, пользователь мог быть активен ранее в этот
        // же день. Храним daily unique через отдельную таблицу seen_users_day.
        // Проще: active_users_day = COUNT(DISTINCT npub_hash) из seen_users_day.
        let first_today: bool = c
            .query_row(
                "SELECT COUNT(*) FROM seen_users_day WHERE npub_hash = ?1 AND day = ?2",
                params![hash, day],
                |r| r.get::<_, i64>(0),
            )
            .map(|n| n == 0)
            .unwrap_or(true);
        if first_today {
            c.execute(
                "INSERT INTO seen_users_day (npub_hash, day) VALUES (?1, ?2)",
                params![hash, day],
            )?;
            c.execute(
                "INSERT INTO stats_daily (day, new_users, active_users, msgs) VALUES (?1, ?2, 1, 0)
                 ON CONFLICT(day) DO UPDATE SET active_users = active_users + 1",
                params![day, if is_new { 1i64 } else { 0i64 }],
            )?;
        }
        Ok((is_new, first_today))
    }

    /// v160s5: инкремент счётчика сообщений за день (при приёме envelope релеем,
    /// 1 раз на сообщение — без дублей от повторных /api/history-опросов).
    /// Олег 2026-09-16 20:33: счётчик считал многократно одни и те же сообщения.
    /// dedupe по message_hash через таблицу msgs_counted.
    /// v160s6c (Олег 2026-09-17): is_service — receipts/служебные envelope'ы
    /// (_kind:"receipt" и т.п.) НЕ считаем как отправленные сообщения.
    /// Тест 17.09: 2 msgs → "4 отправлено" — каждое полученное сообщение
    /// генерирует receipt (✓✓), receipt идёт через /api/envelope как обычный
    /// envelope и попадал в счётчик. is_service считаем в accept_envelope
    /// до persist (json_path + _kind != "").
    /// Активность отправителя учитываем только для обычных сообщений тоже
    /// (receiptы не должны раздувать active_users).
    pub fn record_msg_envelope(&self, envelope_hash: &str, from_npub: &str, ts: i64, is_service: bool) -> rusqlite::Result<()> {
        let day = ts - (ts % 86400);
        let c = self.conn.lock();
        // Новый ли отправитель сегодня (для active_users) — по daily-хэшу.
        // v160s6c: пропускаем для служебных (receiptы не раздувают active_users).
        if !is_service {
        let hash = murmur_sha256_hex(from_npub.as_bytes());
        let first_today: bool = c
            .query_row(
                "SELECT COUNT(*) FROM seen_users_day WHERE npub_hash = ?1 AND day = ?2",
                params![hash, day],
                |r| r.get::<_, i64>(0),
            )
            .map(|n| n == 0)
            .unwrap_or(true);
        if first_today {
            c.execute(
                "INSERT OR IGNORE INTO seen_users_day (npub_hash, day) VALUES (?1, ?2)",
                params![hash, day],
            )?;
            c.execute(
                "INSERT INTO stats_daily (day, active_users) VALUES (?1, 1)
                 ON CONFLICT(day) DO UPDATE SET active_users = active_users + 1",
                params![day],
            )?;
        }
        }
        // Сообщение считаем 1 раз (dedupe по hash) — только обычные messages.
        // v160s6c: receipts/служебные НЕ считаем (is_service → skip целиком).
        if is_service {
            return Ok(());
        }
        let n = c.execute(
            "INSERT OR IGNORE INTO msgs_counted (envelope_hash, day) VALUES (?1, ?2)",
            params![envelope_hash, day],
        )?;
        if n > 0 {
            c.execute(
                "INSERT INTO stats_daily (day, msgs) VALUES (?1, 1)
                 ON CONFLICT(day) DO UPDATE SET msgs = msgs + 1",
                params![day],
            )?;
        }
        Ok(())
    }

    /// v160s5: инкремент счётчика сообщений за день (при delivery).
    pub fn record_msg_count(&self, ts: i64) -> rusqlite::Result<()> {
        let day = ts - (ts % 86400);
        let c = self.conn.lock();
        c.execute(
            "INSERT INTO stats_daily (day, msgs) VALUES (?1, 1)
             ON CONFLICT(day) DO UPDATE SET msgs = msgs + 1",
            params![day],
        )?;
        Ok(())
    }

    /// v160s4: пакетный инкремент счётчика сообщений (не блокирует доставку).
    pub fn record_msg_count_batch(&self, n: i64, ts: i64) {
        if n <= 0 {
            return;
        }
        let day = ts - (ts % 86400);
        let c = self.conn.lock();
        if let Err(e) = c.execute(
            "INSERT INTO stats_daily (day, msgs) VALUES (?1, ?2)
             ON CONFLICT(day) DO UPDATE SET msgs = msgs + ?2",
            params![day, n],
        ) {
            warn!(err=%e, "record_msg_count_batch failed");
        }
    }

    /// v160s4: сводная таблица по дням (агрегаты, без PII) для dashboard.
    pub fn get_stats_daily(&self) -> rusqlite::Result<Vec<(i64, i64, i64, i64)>> {
        let c = self.conn.lock();
        let mut s = c.prepare(
            "SELECT day, new_users, active_users, msgs FROM stats_daily ORDER BY day DESC LIMIT 30",
        )?;
        let rows = s
            .query_map([], |r| {
                Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    }

    /// v160s4: нарастающий итог уникальных пользователей (по хэшам seen_users).
    pub fn get_total_users(&self) -> rusqlite::Result<i64> {
        let c = self.conn.lock();
        let n = c.query_row("SELECT COUNT(*) FROM seen_users", [], |r| r.get(0))?;
        Ok(n)
    }

    pub fn shorten_expires_at(&self, hash: &str, new_expires_at: i64) -> rusqlite::Result<()> {
        // v160s6b (Олег 2026-09-17): conditional UPDATE — считаем ТОЛЬКО
        // первое сокращение (когда expires_at ещё 24h, т.е. > new_expires_at).
        // /api/history возвращает ВСЮ историю (включая уже доставленные msgs),
        // клиент поллит её каждые несколько сек — безусловный UPDATE + инкремент
        // давал delivered=740 при 4 сообщениях (урок #426).
        let n = self.exec_sql(
            // v160b4 (Олег 2026-09-17): read_at=1 в том же условном UPDATE —
            // badge-счётчик (unread_badge_count) считает только read_at=0,
            // иначе прочитанные (сокращённые) висят в счётчике до TTL-удаления
            // и следующий пуш показывал наклейку с накрученной цифрой.
            "UPDATE envelopes SET expires_at = ?1, read_at = 1 WHERE envelope_hash = ?2 AND expires_at > ?1",
            params![new_expires_at, hash],
        )?;
        if n > 0 {
            self.record_delivered_for_hash(hash);
            // v160y32: system:relay-нотификации («Адресат не забрал») удаляются
            // СРАЗУ при чтении получателем — не живут 24ч по TTL (хвосты 412 Б,
            // ручные чистки). Личные сообщения — обычный путь (shorten выше).
            match self.delete_envelope_by_hash_if_service(hash) {
                Ok(true) => info!("undelivered notification deleted on delivery"),
                Ok(false) => {}
                Err(e) => warn!(err=%e, "service delete failed"),
            }
            return Ok(());
        }
        // v160w4d (Олег 2026-09-20): условный UPDATE не сработал → строка уже
        // сокращена ранее (WS live-доставка: envelope.rs зовёт
        // shorten_expires_at_keep_unread, который НЕ ставит read_at).
        // /api/history = получатель забрал историю → read_at=1 ставим
        // БЕЗУСЛОВНО (отдельным UPDATE). Иначе WS-доставленные сообщения
        // навсегда висят read_at=0 в unread_badge_count, и следующий пуш
        // несёт badge = старые непрочитанные + 1 (симптом Олега 20.09:
        // после обновления счётчик начинается не с 1, а с 7).
        // Матчит только read_at=0 строки → для уже прочитанных это no-op,
        // полл не «пере-прочитывает» и статистику не трогает.
        let _m = self.exec_sql(
            "UPDATE envelopes SET read_at = 1 WHERE envelope_hash = ?1 AND read_at = 0",
            params![hash],
        )?;
        Ok(())
    }

    /// v160w4c (Олег 2026-09-19): WS live-доставка ≠ «прочитано».
    /// envelope.rs путь (n>0, получатель онлайн) раньше звал shorten_expires_at
    /// и ставил read_at=1 → unread_badge_count между пушами давал 1 и наклейка
    /// iPhone не поднималась выше 1 (логи теста 19.09 12:14:52–12:15:01,
    /// badge=1,1,1 при живом WS). read_at=1 теперь ставит ТОЛЬКО /api/history
    /// (push.rs — реальный забор истории). Тот же conditional UPDATE +
    /// delivered-статистика, БЕЗ read_at=1.
    pub fn shorten_expires_at_keep_unread(
        &self,
        hash: &str,
        new_expires_at: i64,
    ) -> rusqlite::Result<()> {
        let n = self.exec_sql(
            "UPDATE envelopes SET expires_at = ?1 WHERE envelope_hash = ?2 AND expires_at > ?1",
            params![new_expires_at, hash],
        )?;
        if n == 0 {
            return Ok(()); // уже сокращено ранее — не считаем повторно
        }
        self.record_delivered_for_hash(hash);
        // v160y32: system:relay-нотификации удаляются СРАЗУ при WS-доставке.
        match self.delete_envelope_by_hash_if_service(hash) {
            Ok(true) => info!("undelivered notification deleted on ws delivery"),
            Ok(false) => {}
            Err(e) => warn!(err=%e, "service delete failed (ws)"),
        }
        Ok(())
    }

    /// Общая часть delivered-статистики: is_service-фильтр (v160s6e) +
    /// stats_daily increment (v160s6). Вызывается 1 раз на envelope при
    /// ПЕРВОЙ доставке.
    fn record_delivered_for_hash(&self, hash: &str) {
        // v160s6e (Олег 2026-09-17): receipts/служебные envelope'ы (_kind)
        // НЕ считаем в «доставлено». Тест 17.09: доставлено=9 при 5 сообщениях —
        // /api/history возвращает и receipts (✓✓ лежат в envelopes), клиент
        // поллит их → каждое первое сокращение receipt'а инкрементировало
        // delivered. is_service = json-тело с _kind — routing-поля, не подписаны.
        {
            let c0 = self.conn.lock();
            let body: Option<Vec<u8>> = c0
                .query_row(
                    "SELECT body FROM envelopes WHERE envelope_hash = ?1",
                    params![hash],
                    |r| r.get(0),
                )
                .optional()
                .unwrap_or(None);
            drop(c0);
            if let Some(body) = body {
                let is_service = serde_json::from_slice::<serde_json::Value>(&body)
                    .ok()
                    .and_then(|v| v.get("_kind").and_then(|k| k.as_str()).map(|s| !s.is_empty()))
                    .unwrap_or(false);
                if is_service {
                    return;
                }
            }
        }
        // v160s6 (Олег 2026-09-17): доставлено сегодня — счётчик в stats_daily.
        // Вызывается 1 раз на envelope при ПЕРВОЙ доставке (после v160s6b
        // conditional UPDATE выше отсекает повторные вызовы от /api/history
        // поллинга). delivered день = сегодня (момент доставки, не ts сообщения).
        let now: i64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let day = now - (now % 86400);
        let c = self.conn.lock();
        if let Err(e) = c.execute(
            "INSERT INTO stats_daily (day, delivered) VALUES (?1, 1)
             ON CONFLICT(day) DO UPDATE SET delivered = delivered + 1",
            params![day],
        ) {
            warn!(err=%e, "delivered counter increment failed");
        }
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
                    // v160t (Олег): типовое превью по mime («фото/видео/аудио/файл»),
                    // НЕ нейтральное имя f-…bin — тогда серверное превью совпадает
                    // с клиентским (previewForMsg v160t) и loadContacts не портит
                    // сайдбар. mime в attachments_meta не является секретом.
                    if let Some(arr) = v.get("attachments_meta").and_then(|a| a.as_array()) {
                        if let Some(first) = arr.first() {
                            let mime = first.get("mime").and_then(|m| m.as_str()).unwrap_or("");
                            let kind = if mime.starts_with("image/") {
                                "фото"
                            } else if mime.starts_with("video/") {
                                "видео"
                            } else if mime.starts_with("audio/") {
                                "аудио"
                            } else {
                                "файл"
                            };
                            let n = arr.len();
                            return Ok(if n > 1 {
                                format!("📎 {} +{}", kind, n - 1)
                            } else {
                                format!("📎 {}", kind)
                            });
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

    /// v160b4 (Олег 2026-09-17): число live (не забранных через /api/history)
    /// личных envelope'ов для получателя — unread при закрытом приложении.
    /// Исключения: receipts (_kind:"receipt" в JSON body) и system:relay.
    /// Служит badge для push payload (клиент перезапишет точным total при
    /// живой странице). Return 0 если store недоступен/нет строк.
    pub fn unread_badge_count(&self, to_npub: &str) -> i64 {
        let c = self.conn.lock();
        c.query_row(
            // v160b4: read_at=0 only — прочитанные (сокращённые TTL) не считаем.
            // Плюс expires_at > now как дополнительный фильтр (TTL-крон удаляет).
            "SELECT COUNT(*) FROM envelopes \
             WHERE to_npub = ?1 AND from_npub != ?1 AND from_npub != 'system:relay' \
               AND read_at = 0 AND expires_at > ?2 \
               AND body NOT LIKE '%\"_kind\":\"receipt\"%'",
            params![to_npub, std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)],
            |r| r.get::<_, i64>(0),
        )
        .unwrap_or(0)
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
            // v160y24: read_at включён в выборку — классификация TTL-крона
            // по факту доставки, не по expires_at − ts.
            "SELECT envelope_hash, from_npub, to_npub, body, sig, ts, expires_at, read_at \
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
                    read_at: r.get(7)?,
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
            "message": "Адресат не забрал сообщение за 24 часа. Попробуйте позже.",
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

    /// v160y32 (Олег 2026-09-24): system:relay-нотификации удаляются СРАЗУ
    /// при доставке, TTL-окно им не нужно. «Адресат не забрал…» — сигнал для
    /// получателя; после доставки (WS live или забор /api/history) строка —
    /// мусор: 412 Б хвостов на дашборде, ручные чистки. Держим 24h TTL только
    /// для случая «получатель так и не вернулся» — тогда TTL-крон снесёт.
    pub fn delete_envelope_by_hash_if_service(&self, hash: &str) -> rusqlite::Result<bool> {
        // 1. Проверяем service-статус ДО удаления (system:relay или _kind в body).
        let is_service: bool = {
            let c0 = self.conn.lock();
            let row: Option<(String, Option<Vec<u8>>)> = c0
                .query_row(
                    "SELECT from_npub, body FROM envelopes WHERE envelope_hash = ?1",
                    params![hash],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()
                .unwrap_or(None);
            drop(c0);
            match row {
                Some((from, body)) => {
                    if from == "system:relay" {
                        true
                    } else {
                        body
                            .and_then(|b| {
                                serde_json::from_slice::<serde_json::Value>(&b)
                                    .ok()
                                    .and_then(|v| {
                                        v.get("_kind").and_then(|k| k.as_str()).map(|s| !s.is_empty())
                                    })
                            })
                            .unwrap_or(false)
                    }
                }
                None => false, // нет строки — нечего удалять
            }
        };
        if !is_service {
            return Ok(false); // личное сообщение — обычный путь (shorten)
        }
        // 2. Служебное — удаляем (refs сносятся; у system:relay их нет,
        // но delete_envelope_by_hash безопасен в любом случае).
        self.delete_envelope_by_hash(hash)?;
        Ok(true)
    }

    /// Удаляет envelope по hash + сносит attachment_refs (v160o).
    /// Blob'ы ТОЛЬКО декрементируются: ref_count 0 → blob остаётся в БД как
    /// «orphan» (строка + файл) и физически удаляется позже — только
    /// delete_orphan_blobs, если он старше BLOB_MAX_AGE_SECS (24h от загрузки).
    /// Это гарантирует: полученное видео остаётся доступным ~24h независимо
    /// от судьбы envelope (v160m каскад убивал файл через ~5 мин после доставки).
    /// Приватность: файл — AES-256-GCM шифротекст; wrapped_key живёт только в
    /// attachment_refs, после их удаления дешифровать не может даже владелец relay.
    pub fn delete_envelope_by_hash(&self, hash: &str) -> rusqlite::Result<()> {
        let c = self.conn.lock();
        let tx = c.unchecked_transaction()?;
        // ref_count уникальных blob'ов этого envelope — вниз (строки blob'ов живут).
        tx.execute(
            "UPDATE blobs SET ref_count = MAX(ref_count - 1, 0) \
             WHERE id IN (SELECT DISTINCT blob_id FROM attachment_refs WHERE envelope_hash = ?1)",
            params![hash],
        )?;
        tx.execute("DELETE FROM attachment_refs WHERE envelope_hash = ?1", params![hash])?;
        tx.commit()?;
        drop(c);
        // Сам envelope.
        self.exec_sql("DELETE FROM envelopes WHERE envelope_hash = ?1", params![hash])?;
        Ok(())
    }

    /// v149: blob'ы без ссылок (orphan) — удалить. Вызывается из TTL-cron.
    /// v160o: blob'ы без ссылок (orphan) удаляем только если они старше
    /// retention_secs (сек от загрузки, created_at). Свежие orphan'ы — это
    /// чьи-то ещё не забранные видео/фото: они обязаны дожить до 24h.
    pub fn delete_orphan_blobs(&self, now: i64, retention_secs: i64) -> rusqlite::Result<Vec<String>> {
        let mut deleted_files: Vec<String> = Vec::new();
        let blob_ids: Vec<(String, String)> = {
            let c = self.conn.lock();
            let mut s = c.prepare(
                "SELECT b.id, b.storage_path FROM blobs b \
                 WHERE NOT EXISTS (SELECT 1 FROM attachment_refs ar WHERE ar.blob_id = b.id) \
                 AND b.created_at < ?1",
            )?;
            let rows = s
                .query_map(params![now.saturating_sub(retention_secs)], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
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
                // v160s: blob_tokens.blob_id REFERENCES blobs(id) — token-строки
                // обязаны уйти ПЕРВЫМИ, иначе DELETE FROM blobs ловит
                // «FOREIGN KEY constraint failed» каждые 5 минут (прод, 16.09).
                tx.execute("DELETE FROM blob_tokens WHERE blob_id = ?1", params![blob_id])?;
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
                    Ok(_) => info!(blob = %p, "v160o: orphan blob deleted (age > retention)"),
                    Err(e) => warn!(blob = %p, error = %e, "v160o: failed to delete orphan blob file"),
                }
            }
        }
        Ok(deleted_files)
    }

    // Раньше здесь были unread_by_peer и mark_incoming_read — но клиент
    // теперь считает unread локально (см. lesson #125), серверная логика
    // для badge больше не нужна.

    /// v160s (Олег 2026-09-16): агрегаты для admin dashboard.
    /// ПРИВАТНОСТЬ: только ЧИСЛА — никаких npub-списков, тел, preview,
    /// содержимого. Сервер и так не видит контент (E2E), а в дашборд не
    /// утекают даже метаданные отдельных пользователей.
    pub fn get_stats(&self) -> rusqlite::Result<StatsSnapshot> {
        let c = self.conn.lock();
        let now: i64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        // v160s3: q1 с bind-параметром (?1). Прежняя версия вызывала query_row
        // с пустыми params при ?1 в SQL → ошибка bind → unwrap_or(0) → ВСЕ
        // 24h-счётчики всегда 0 (Олег поймал: дашборд показывал 0 активности,
        // хотя сообщения шли). now инлайнится как i64-литерал — инъекции нет
        // (число, не строка).
        let q1 = |sql: &str, arg: i64| -> i64 {
            c.query_row(sql, params![arg], |r| r.get(0)).unwrap_or(0)
        };
        let q0 = |sql: &str| -> i64 {
            c.query_row(sql, [], |r| r.get(0)).unwrap_or(0)
        };
        // Уникальные npub за всё время (отправители + получатели, system:relay
        // исключён — это нотификации релея, не пользователи).
        let unique_peers_total = q0(
            "SELECT COUNT(DISTINCT n) FROM (
                SELECT from_npub n FROM envelopes WHERE from_npub != 'system:relay'
                UNION
                SELECT to_npub FROM envelopes WHERE to_npub != 'system:relay'
            )",
        );
        let unique_peers_24h = q1(
            "SELECT COUNT(DISTINCT n) FROM (
                SELECT from_npub n FROM envelopes WHERE from_npub != 'system:relay' AND ts > ?1
                UNION
                SELECT to_npub FROM envelopes WHERE to_npub != 'system:relay' AND ts > ?1
            )",
            now,
        );
        // Активность по часам за последние 48h (ts хранится в секундах).
        let hourly_window = now.saturating_sub(48 * 3600);
        let mut msgs_hourly: Vec<(i64, i64)> = Vec::new();
        {
            let mut s = match c.prepare(
                "SELECT (ts / 3600) * 3600 AS hour_bucket, COUNT(*)
                 FROM envelopes
                 WHERE ts > ?1 AND from_npub != 'system:relay'
                 GROUP BY hour_bucket ORDER BY hour_bucket",
            ) {
                Ok(s) => s,
                Err(e) => return Err(e),
            };
            let rows = s
                .query_map(params![hourly_window], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
                })?
                .filter_map(|r| r.ok());
            for r in rows {
                msgs_hourly.push(r);
            }
        }
        // Медиа по дням за 7 дней.
        let daily_window = now.saturating_sub(7 * 86400);
        let mut blobs_daily: Vec<(i64, i64, i64)> = Vec::new(); // (day, count, bytes)
        {
            let mut s = match c.prepare(
                "SELECT (created_at / 86400) * 86400 AS day_bucket, COUNT(*), COALESCE(SUM(size), 0)
                 FROM blobs
                 WHERE created_at > ?1
                 GROUP BY day_bucket ORDER BY day_bucket",
            ) {
                Ok(s) => s,
                Err(e) => return Err(e),
            };
            let rows = s
                .query_map(params![daily_window], |r| {
                    Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
                })?
                .filter_map(|r| r.ok());
            for r in rows {
                blobs_daily.push(r);
            }
        }
        Ok(StatsSnapshot {
            generated_at: now,
            unique_peers_total,
            unique_peers_24h,
            envelopes_pending: q1(
                "SELECT COUNT(*) FROM envelopes WHERE expires_at > ?1", // ещё в TTL-окне (не снесены)
                now,
            ),
            envelopes_24h: q1(
                "SELECT COUNT(*) FROM envelopes WHERE ts > ?1 AND from_npub != 'system:relay'",
                now,
            ),
            envelopes_total: q0(
                "SELECT COUNT(*) FROM envelopes WHERE from_npub != 'system:relay'",
            ),
            blobs_total: q0("SELECT COUNT(*) FROM blobs"),
            blobs_bytes_total: q0("SELECT COALESCE(SUM(size), 0) FROM blobs"),
            blobs_24h: q1("SELECT COUNT(*) FROM blobs WHERE created_at > ?1", now),
            msgs_hourly,
            blobs_daily,
            // v160s6: новый формат дашборда (Олег 2026-09-17).
            // delivered/msgs сегодня — stats_daily за сегодняшний UTC-день.
            delivered_today: q1(
                "SELECT COALESCE(delivered, 0) FROM stats_daily WHERE day = ?1",
                now - (now % 86400),
            ),
            msgs_today: q1(
                "SELECT COALESCE(msgs, 0) FROM stats_daily WHERE day = ?1",
                now - (now % 86400),
            ),
            // активные за 24h — уникальные npub-хэши в seen_users_day за
            // последние сутки (day >= сегодня-1день, один bind-параметр —
            // q1 биндит только один arg, IN (?1,?2) с двумя плейсхолдерами
            // падает с bind error → unwrap_or(0) → всегда 0, урок #420 повтор).
            active_users_24h: q1(
                "SELECT COUNT(DISTINCT npub_hash) FROM seen_users_day WHERE day >= ?1",
                now - (now % 86400) - 86400,
            ),
            // недоставленные — в TTL-окне И 24h-TTL (не сокращён после доставки).
            // v160y31 (Олег 23:23): system:relay-нотификации («Адресат не забрал»,
            // TTL 86400 > 600) попадали в счётчик как «недоставленные» — 2 хвоста
            // на проде при пустом счётчике. Фейковые нотификации — НЕ сообщения.
            envelopes_undelivered: q1(
                "SELECT COUNT(*) FROM envelopes WHERE expires_at > ?1 AND (expires_at - ts) > 600 AND from_npub != 'system:relay'",
                now,
            ),
            // диск: занято = envelopes (body+sig) + blobs (size) по таблицам;
            // свободно/всего — statvfs по разделу с БД.
            disk_used_bytes: q0(
                "SELECT COALESCE((SELECT SUM(length(body) + length(sig)) FROM envelopes), 0) + COALESCE((SELECT SUM(size) FROM blobs), 0)",
            ),
            disk_free_bytes: {
                use rustix::fs::statvfs;
                match statvfs("/var/lib/murmur-relay") {
                    Ok(s) => (s.f_bavail as i64) * (s.f_bsize as i64),
                    Err(_) => 0,
                }
            },
            disk_total_bytes: {
                use rustix::fs::statvfs;
                match statvfs("/var/lib/murmur-relay") {
                    Ok(s) => (s.f_blocks as i64) * (s.f_bsize as i64),
                    Err(_) => 0,
                }
            },
        })
    }
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
    // v160y24 (Олег 2026-09-23): признак реальной доставки для TTL-крона
    // (read_at=1 ставится при shorten_expires_at / WS-доставке). 0 = никогда
    // не доставлен → «undelivered» нотификация отправителю.
    pub read_at: i64,
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
        // v160p: identity_transfers удалена, blob_tokens добавлена.
        // v160s (uncommitted в рабочем дереве): seen_users, seen_users_day,
        // msgs_counted, stats_daily — итог 8. Тест падал до v160b4 (ассерт 4).
        assert_eq!(n, 8);
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
    fn shorten_keep_unread_then_history_marks_read_v160w4d() {
        // Симптом Олега 2026-09-20: WS-доставка (keep_unread) оставляла read_at=0,
        // условный UPDATE в shorten_expires_at на /api/history не матчил строку
        // (expires_at уже сокращён) → сообщение навсегда unread → новый пуш нёс
        // badge = старые непрочитанные + 1 (счёт «не с 1, а с 7»).
        let db = MessageStore::new(&tmp().join("w4d.db")).unwrap();
        // unread_badge_count фильтрует expires_at > реальный now — тестовые
        // конверты должны жить в текущем времени, не в фиксированном 1970-м.
        let now: i64 = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as i64;
        let full_ttl = now + 86_400;
        let short_ttl = now + 300;
        db.upsert_envelope("h_ws", "npub_alice", "npub_bob", b"Hello", b"sig1", now, full_ttl)
            .unwrap();

        // 1. WS live-доставка: TTL сокращается, read_at остаётся 0.
        db.shorten_expires_at_keep_unread("h_ws", short_ttl).unwrap();
        assert_eq!(db.unread_badge_count("npub_bob"), 1, "после WS unread");

        // 2. Повторная WS-доставка (дупло) — TTL не продлевается.
        db.shorten_expires_at_keep_unread("h_ws", short_ttl).unwrap();
        assert_eq!(db.unread_badge_count("npub_bob"), 1);

        // 3. /api/history забрал историю: строка уже сокращена → условный UPDATE
        // не сработает, но read_at обязан встать (безусловный докат v160w4d).
        db.shorten_expires_at("h_ws", short_ttl).unwrap();
        assert_eq!(
            db.unread_badge_count("npub_bob"),
            0,
            "после /api/history сообщение прочитано"
        );

        // 4. Повторные поллы не ломают статистику (delivered инкремент 1 раз).
        db.shorten_expires_at("h_ws", short_ttl).unwrap();
        db.shorten_expires_at("h_ws", short_ttl).unwrap();
        assert_eq!(db.unread_badge_count("npub_bob"), 0);

        // 5. Обычный путь без WS: /api/history ставит read_at=1 сразу.
        db.upsert_envelope("h_http", "npub_alice", "npub_bob", b"Hi", b"sig2", now, full_ttl)
            .unwrap();
        db.shorten_expires_at("h_http", short_ttl).unwrap();
        assert_eq!(db.unread_badge_count("npub_bob"), 0);
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
        // v160o: удаление envelope НЕ удаляет blob'ы физически (ref_count → 0,
        // строка+файл живут как orphan до 24h от created_at).
        db.delete_envelope_by_hash("e1").unwrap();
        let b1: i64 = db.with_conn(|c| c.query_row("SELECT ref_count FROM blobs WHERE id='b1'", [], |r| r.get(0))).unwrap();
        let b2: Option<i64> = db.with_conn(|c| c.query_row("SELECT ref_count FROM blobs WHERE id='b2'", [], |r| r.get(0)).optional()).map(|o| o.flatten()).unwrap_or(None);
        assert_eq!(b1, 1);
        assert!(b2.is_some(), "b2 must survive as orphan (row alive, ref_count=0)");
        db.delete_envelope_by_hash("e2").unwrap();
        let (left, (r1, r2)): (i64, (i64, i64)) = db.with_conn(|c| {
            let n: i64 = c.query_row("SELECT COUNT(*) FROM blobs", [], |r| r.get(0)).unwrap();
            let a: i64 = c.query_row("SELECT ref_count FROM blobs WHERE id='b1'", [], |r| r.get(0)).unwrap();
            let b: i64 = c.query_row("SELECT ref_count FROM blobs WHERE id='b2'", [], |r| r.get(0)).unwrap();
            Ok((n, (a, b)))
        }).unwrap();
        assert_eq!(left, 2, "v160o: both blob rows survive envelope deletion");
        assert_eq!((r1, r2), (0, 0), "ref_counts drained to 0");
        // Свежий orphan (created_at = сейчас) НЕ удаляется cleanup'ом с retention 24h.
        let now: i64 = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        db.with_conn(|c| {
            c.execute_batch(
                "INSERT INTO blobs (id, sha256, mime, size, storage_path, created_at, ref_count) VALUES
                 ('b3', 's3', 'image/png', 10, '/tmp/b3', 0, 0);",
            )
        })
        .unwrap();
        db.with_conn(|c| c.execute("UPDATE blobs SET created_at = ?1 WHERE id IN ('b1','b2','b3')", params![now])).unwrap();
        let fresh: Vec<String> = db.delete_orphan_blobs(now, 86_400).unwrap();
        assert!(fresh.is_empty(), "fresh orphans must survive cleanup");
        let left_fresh: i64 = db.with_conn(|c| c.query_row("SELECT COUNT(*) FROM blobs", [], |r| r.get(0))).unwrap();
        assert_eq!(left_fresh, 3);
        // Старше retention — удаляются (файлы fake, remove_file защищён exists()).
        db.with_conn(|c| c.execute_batch("UPDATE blobs SET created_at = created_at - 90000")).unwrap();
        let stale: Vec<String> = db.delete_orphan_blobs(now, 86_400).unwrap();
        assert_eq!(stale.len(), 3, "aged orphans must be deleted");
        let left_old: i64 = db.with_conn(|c| c.query_row("SELECT COUNT(*) FROM blobs", [], |r| r.get(0))).unwrap();
        assert_eq!(left_old, 0);
    }
}
