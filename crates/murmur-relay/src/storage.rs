//! SQLite persistence layer for murmur envelopes, contacts, and unread counts.
//!
//! Schema:
//!   envelopes(envelope_hash PK, from_npub, to_alias, body BLOB, sig BLOB, ts INTEGER)
//!   user_aliases(alias PK, npub, unread INTEGER DEFAULT 0)
//!
//! rusqlite + bundled: richer queries, BLOB support,
//! UNIQUE constraint for idempotency, transactional safety.

use parking_lot::Mutex;
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;
use std::sync::Arc;
use tracing::debug;

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
    pub to_alias: String,
    pub body: Vec<u8>,
    pub sig: Vec<u8>,
    pub ts: i64,
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
                to_alias      TEXT NOT NULL,
                body          BLOB NOT NULL,
                sig           BLOB NOT NULL DEFAULT X'',
                ts            INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_envelopes_from ON envelopes(from_npub);
            CREATE INDEX IF NOT EXISTS idx_envelopes_to_alias ON envelopes(to_alias);
            CREATE INDEX IF NOT EXISTS idx_envelopes_to_alias_ts ON envelopes(to_alias, ts);
            CREATE TABLE IF NOT EXISTS user_aliases (
                alias  TEXT PRIMARY KEY,
                npub   TEXT NOT NULL,
                unread INTEGER NOT NULL DEFAULT 0
            );
            ",
        )?;
        debug!(db_path = %path.display(), "message store initialised");
        Ok(Self { conn: Arc::new(Mutex::new(conn)) })
    }

    fn exec_sql(&self, sql: &str, p: impl rusqlite::Params) -> rusqlite::Result<usize> {
        self.conn.lock().execute(sql, p)
    }

    pub fn upsert_envelope(
        &self,
        hash: &str,
        from: &str,
        to_alias: &str,
        body: &[u8],
        sig: &[u8],
        ts: i64,
    ) -> rusqlite::Result<bool> {
        let n = self.exec_sql(
            "INSERT OR IGNORE INTO envelopes (envelope_hash, from_npub, to_alias, body, sig, ts)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![hash, from, to_alias, body, sig, ts],
        )?;
        Ok(n > 0)
    }

    pub fn register_alias(&self, alias: &str, npub: &str) -> rusqlite::Result<()> {
        self.exec_sql(
            "INSERT OR REPLACE INTO user_aliases (alias, npub, unread) VALUES (?1, ?2, 0)",
            params![alias, npub],
        )
        .map(|_| ())
    }

    pub fn aliases_for_npub(&self, npub: &str) -> rusqlite::Result<Vec<String>> {
        let c = self.conn.lock();
        let mut s = c.prepare("SELECT alias FROM user_aliases WHERE npub = ?1")?;
        let mut rows = Vec::new();
        for r in s.query_map(params![npub], |r| r.get(0))? {
            rows.push(r?);
        }
        Ok(rows)
    }

    pub fn npub_for_alias(&self, alias: &str) -> rusqlite::Result<Option<String>> {
        self.conn.lock().query_row(
            "SELECT npub FROM user_aliases WHERE alias = ?1",
            params![alias],
            |r| r.get(0),
        )
        .optional()
    }

    pub fn increment_unread(&self, alias: &str) -> rusqlite::Result<()> {
        self.exec_sql(
            "UPDATE user_aliases SET unread = unread + 1 WHERE alias = ?1",
            params![alias],
        )
        .map(|_| ())
    }

    pub fn get_contacts(&self, npub: &str) -> rusqlite::Result<Vec<ContactRow>> {
        let peers: Vec<(String, i64)> = {
            let c = self.conn.lock();
            let mut stmt = c.prepare(
                "SELECT peer, MAX(last_ts) FROM (
                    SELECT CASE
                        WHEN e.from_npub LIKE 'npub1%' THEN e.from_npub
                        ELSE COALESCE(
                            (SELECT ua2.npub FROM user_aliases ua2 WHERE ua2.alias = e.from_npub),
                            e.from_npub
                        )
                     END as peer, MAX(e.ts) as last_ts
                    FROM envelopes e
                    JOIN user_aliases ua ON ua.alias = e.to_alias
                    WHERE ua.npub = ?1 AND e.from_npub != ?1
                    UNION
                    SELECT COALESCE(
                        (SELECT ua2.npub FROM user_aliases ua2 WHERE ua2.alias = e.to_alias),
                        e.to_alias
                    ) as peer,
                        MAX(e.ts) as last_ts
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
            let unread: i64 = self.get_unread_for_peer(npub, &peer)?;
            rows.push(ContactRow {
                peer,
                last_message_preview: preview,
                last_ts,
                unread_count: unread,
            });
        }
        Ok(rows)
    }

    fn get_unread_for_peer(&self, npub: &str, peer: &str) -> rusqlite::Result<i64> {
        let c = self.conn.lock();
        let val: i64 = c.query_row(
            "SELECT COALESCE(SUM(ua.unread), 0) FROM envelopes e \
             JOIN user_aliases ua ON ua.alias = e.to_alias \
             WHERE ua.npub = ?1 AND e.from_npub = ?2",
            params![npub, peer],
            |r| r.get(0),
        )
        .unwrap_or(0);
        Ok(val)
    }

    fn preview_for_peer(&self, peer: &str, self_npub: &str) -> rusqlite::Result<String> {
        let c = self.conn.lock();
        let body: Option<Vec<u8>> = c.query_row(
            "SELECT body FROM envelopes \
             WHERE (from_npub = ?1 AND to_alias = ?2) \
                OR (to_alias = ?1 AND from_npub = ?2) \
             ORDER BY ts DESC LIMIT 1",
            params![peer, self_npub],
            |r| r.get(0),
        )
        .optional()?;
        if let Some(b) = body {
            if let Ok(s) = String::from_utf8(b.clone()) {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&s) {
                    if let Some(bs) = v.get("body").and_then(|b| b.as_str()) {
                        return Ok(trunc(bs, 80));
                    }
                    if let Some(bs) = v
                        .get("payload")
                        .and_then(|p| p.get("body").and_then(|b| b.as_str()))
                    {
                        return Ok(trunc(bs, 80));
                    }
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
        let sql = format!(
            "SELECT from_npub, to_alias, body, sig, ts FROM envelopes \
             WHERE ((to_alias IN (SELECT alias FROM user_aliases WHERE npub = ?1) AND from_npub = ?2) \
                 OR (from_npub = ?1 AND to_alias IN (SELECT alias FROM user_aliases WHERE npub = ?2)))\
             {} \
             ORDER BY ts DESC LIMIT ?5",
            if before_ts.is_some() { " AND ts < ?6" } else { "" }
        );

        let rows: Vec<HistoryRow> = if let Some(bt) = before_ts {
            let mapped = c
                .prepare(&sql)?
                .query_map(params![npub, peer, npub, peer, limit, bt], |r| {
                    Ok(HistoryRow {
                        from_npub: r.get(0)?,
                        to_alias: r.get(1)?,
                        body: r.get(2)?,
                        sig: r.get(3)?,
                        ts: r.get(4)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();
            mapped
        } else {
            let mapped = c
                .prepare(&sql)?
                .query_map(params![npub, peer, npub, peer, limit], |r| {
                    Ok(HistoryRow {
                        from_npub: r.get(0)?,
                        to_alias: r.get(1)?,
                        body: r.get(2)?,
                        sig: r.get(3)?,
                        ts: r.get(4)?,
                    })
                })?
                .filter_map(|r| r.ok())
                .collect();
            mapped
        };

        let next = rows.last().map(|r| r.ts);
        Ok(HistoryResponse {
            messages: rows,
            next_before_ts: next,
        })
    }

    pub fn reset_unread_for_peer(&self, npub: &str, peer: &str) -> rusqlite::Result<()> {
        self.exec_sql(
            "UPDATE user_aliases SET unread = 0 WHERE npub = ?1 \
             AND alias IN (SELECT DISTINCT to_alias FROM envelopes WHERE from_npub = ?2)",
            params![npub, peer],
        )
        .map(|_| ())
    }
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
        assert_eq!(n, 2);
    }

    #[test]
    fn upsert_idempotent() {
        let db = MessageStore::new(&tmp().join("idem.db")).unwrap();
        assert!(db
            .upsert_envelope("h1", "npub_alice", "alias_bob", b"Hello", b"sig1", 1000)
            .unwrap());
        assert!(!db
            .upsert_envelope("h1", "npub_alice", "alias_bob", b"Hello", b"sig1", 1000)
            .unwrap());
    }

    #[test]
    fn register_alias() {
        let db = MessageStore::new(&tmp().join("alias.db")).unwrap();
        db.register_alias("oleg-hp", "npub_oleg").unwrap();
        let aliases = db.aliases_for_npub("npub_oleg").unwrap();
        assert_eq!(aliases, vec!["oleg-hp"]);
        let npub = db.npub_for_alias("oleg-hp").unwrap().unwrap();
        assert_eq!(npub, "npub_oleg");
    }

    #[test]
    fn full_roundtrip() {
        let db = MessageStore::new(&tmp().join("rt.db")).unwrap();
        db.register_alias("oleg-hp", "npub_oleg").unwrap();
        db.register_alias("alice-hp", "npub_alice").unwrap();
        db.upsert_envelope("h1", "npub_alice", "oleg-hp", b"Hello!", b"sig1", 1000)
            .unwrap();
        db.increment_unread("oleg-hp").unwrap();
        db.upsert_envelope("h2", "npub_oleg", "alice-hp", b"Hi Alice!", b"sig2", 1100)
            .unwrap();

        let contacts = db.get_contacts("npub_oleg").unwrap();
        assert_eq!(contacts.len(), 1);
        assert_eq!(contacts[0].peer, "npub_alice");
        assert_eq!(contacts[0].last_ts, 1100);
        assert_eq!(contacts[0].unread_count, 1);

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

        db.reset_unread_for_peer("npub_oleg", "npub_alice").unwrap();
        let contacts2 = db.get_contacts("npub_oleg").unwrap();
        assert_eq!(contacts2[0].unread_count, 0);
    }
}
