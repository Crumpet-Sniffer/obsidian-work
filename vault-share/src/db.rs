//! SQLite persistence. A single connection behind a mutex, used from blocking threads.

use std::{
    path::Path,
    sync::{Arc, Mutex},
};

use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};

pub fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

#[derive(Clone)]
pub struct Db {
    conn: Arc<Mutex<Connection>>,
}

#[derive(Clone, Debug)]
pub struct UserRow {
    pub id: i64,
    pub username: String,
    pub password_hash: String,
    pub role: String,
    pub disabled: bool,
    pub must_change_password: bool,
    pub created_at: i64,
    pub last_login_at: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct SessionRow {
    pub user_id: i64,
    pub username: String,
    pub role: String,
    pub disabled: bool,
    pub must_change_password: bool,
    pub csrf_token: String,
    pub created_at: i64,
    pub last_seen_at: i64,
}

#[derive(Clone, Debug)]
pub struct VaultRow {
    pub id: String,
    pub name: String,
    pub description: String,
    pub shared_with_all: bool,
    pub file_count: i64,
    pub total_bytes: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Clone, Debug)]
pub struct AuditRow {
    pub ts: i64,
    pub username: Option<String>,
    pub ip: Option<String>,
    pub action: String,
    pub detail: String,
}

const SCHEMA_V1: &str = r#"
CREATE TABLE users (
    id                   INTEGER PRIMARY KEY,
    username             TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash        TEXT NOT NULL,
    role                 TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    disabled             INTEGER NOT NULL DEFAULT 0,
    must_change_password INTEGER NOT NULL DEFAULT 1,
    created_at           INTEGER NOT NULL,
    last_login_at        INTEGER
);
CREATE TABLE sessions (
    token_hash   TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf_token   TEXT NOT NULL,
    created_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ip           TEXT,
    user_agent   TEXT
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE vaults (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    shared_with_all INTEGER NOT NULL DEFAULT 0,
    file_count      INTEGER NOT NULL DEFAULT 0,
    total_bytes     INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
);
CREATE TABLE vault_access (
    vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
    user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (vault_id, user_id)
);
CREATE TABLE audit_log (
    id       INTEGER PRIMARY KEY,
    ts       INTEGER NOT NULL,
    user_id  INTEGER,
    username TEXT,
    ip       TEXT,
    action   TEXT NOT NULL,
    detail   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX audit_ts ON audit_log(ts);
"#;

fn user_from_row(r: &rusqlite::Row) -> rusqlite::Result<UserRow> {
    Ok(UserRow {
        id: r.get(0)?,
        username: r.get(1)?,
        password_hash: r.get(2)?,
        role: r.get(3)?,
        disabled: r.get(4)?,
        must_change_password: r.get(5)?,
        created_at: r.get(6)?,
        last_login_at: r.get(7)?,
    })
}
const USER_COLS: &str =
    "id, username, password_hash, role, disabled, must_change_password, created_at, last_login_at";

fn vault_from_row(r: &rusqlite::Row) -> rusqlite::Result<VaultRow> {
    Ok(VaultRow {
        id: r.get(0)?,
        name: r.get(1)?,
        description: r.get(2)?,
        shared_with_all: r.get(3)?,
        file_count: r.get(4)?,
        total_bytes: r.get(5)?,
        created_at: r.get(6)?,
        updated_at: r.get(7)?,
    })
}
const VAULT_COLS: &str =
    "id, name, description, shared_with_all, file_count, total_bytes, created_at, updated_at";

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path)?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "secure_delete", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 1 {
            conn.execute_batch(&format!("BEGIN; {SCHEMA_V1} PRAGMA user_version = 1; COMMIT;"))?;
        }
        if version < 2 {
            // Site-wide settings chosen on the admin page (key/value).
            conn.execute_batch(
                "BEGIN; CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;
                 PRAGMA user_version = 2; COMMIT;",
            )?;
        }
        if version < 3 {
            // One row per call to Claude, for the spend chart. Costs are in millionths of a US dollar.
            conn.execute_batch(
                "BEGIN;
                 CREATE TABLE api_usage (
                     id                 INTEGER PRIMARY KEY,
                     ts                 INTEGER NOT NULL,
                     user_id            INTEGER,
                     username           TEXT,
                     vault_id           TEXT,
                     model              TEXT NOT NULL,
                     input_tokens       INTEGER NOT NULL DEFAULT 0,
                     output_tokens      INTEGER NOT NULL DEFAULT 0,
                     cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
                     cache_write_tokens INTEGER NOT NULL DEFAULT 0,
                     cost_micro_usd     INTEGER NOT NULL DEFAULT 0
                 );
                 CREATE INDEX api_usage_ts ON api_usage(ts);
                 PRAGMA user_version = 3; COMMIT;",
            )?;
        }
        if version < 4 {
            // Sources added in the background: one row per batch of uploaded files (see handlers/batches.rs).
            conn.execute_batch(
                "BEGIN;
                 CREATE TABLE ingest_batches (
                     id               TEXT PRIMARY KEY,
                     vault_id         TEXT NOT NULL,
                     user_id          INTEGER NOT NULL,
                     username         TEXT NOT NULL,
                     status           TEXT NOT NULL,
                     cancel_requested INTEGER NOT NULL DEFAULT 0,
                     files            TEXT NOT NULL DEFAULT '[]',
                     progress         TEXT NOT NULL DEFAULT '{}',
                     worker_session   TEXT,
                     created_at       INTEGER NOT NULL,
                     updated_at       INTEGER NOT NULL
                 );
                 CREATE INDEX ingest_batches_vault ON ingest_batches(vault_id, created_at);
                 CREATE INDEX ingest_batches_status ON ingest_batches(status, created_at);
                 PRAGMA user_version = 4; COMMIT;",
            )?;
        }
        if version < 5 {
            // Graph view settings, per account per vault: the settings in use, and named presets anyone can load.
            // Vaults have no foreign key here (deleting one deletes its rows in delete_vault).
            conn.execute_batch(
                "BEGIN;
                 CREATE TABLE graph_state (
                     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                     vault_id   TEXT NOT NULL,
                     settings   TEXT NOT NULL,
                     updated_at INTEGER NOT NULL,
                     PRIMARY KEY (user_id, vault_id)
                 );
                 CREATE TABLE graph_presets (
                     id         INTEGER PRIMARY KEY,
                     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                     vault_id   TEXT NOT NULL,
                     name       TEXT NOT NULL,
                     settings   TEXT NOT NULL,
                     updated_at INTEGER NOT NULL,
                     UNIQUE (user_id, vault_id, name)
                 );
                 CREATE INDEX graph_presets_vault ON graph_presets(vault_id);
                 PRAGMA user_version = 5; COMMIT;",
            )?;
        }
        if version < 6 {
            // Practice: past papers and their questions (the question hub), questions Claude wrote, practice
            // sessions and every answer given, flashcard decks, and each account's conversation with the exam
            // coach. Batches gain a kind ('sources' or 'paper', a past paper being read by the ingest worker).
            conn.execute_batch(
                "BEGIN;
                 ALTER TABLE ingest_batches ADD COLUMN kind TEXT NOT NULL DEFAULT 'sources';
                 ALTER TABLE ingest_batches ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
                 CREATE TABLE hub_papers (
                     id          INTEGER PRIMARY KEY,
                     vault_id    TEXT NOT NULL,
                     user_id     INTEGER,
                     username    TEXT NOT NULL DEFAULT '',
                     title       TEXT NOT NULL,
                     exam_path   TEXT NOT NULL DEFAULT '',
                     scheme_path TEXT NOT NULL DEFAULT '',
                     created_at  INTEGER NOT NULL
                 );
                 CREATE INDEX hub_papers_vault ON hub_papers(vault_id);
                 CREATE TABLE questions (
                     id         INTEGER PRIMARY KEY,
                     vault_id   TEXT NOT NULL,
                     paper_id   INTEGER REFERENCES hub_papers(id) ON DELETE CASCADE,
                     source     TEXT NOT NULL,
                     user_id    INTEGER,
                     number     TEXT NOT NULL DEFAULT '',
                     text       TEXT NOT NULL,
                     qtype      TEXT NOT NULL,
                     options    TEXT NOT NULL DEFAULT '[]',
                     answer     TEXT NOT NULL DEFAULT '{}',
                     marks      INTEGER NOT NULL,
                     scheme     TEXT NOT NULL DEFAULT '',
                     topics     TEXT NOT NULL DEFAULT '[]',
                     difficulty TEXT NOT NULL DEFAULT '',
                     created_at INTEGER NOT NULL
                 );
                 CREATE INDEX questions_vault ON questions(vault_id, source);
                 CREATE TABLE practice_sessions (
                     id           TEXT PRIMARY KEY,
                     vault_id     TEXT NOT NULL,
                     user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                     title        TEXT NOT NULL,
                     kind         TEXT NOT NULL,
                     settings     TEXT NOT NULL DEFAULT '{}',
                     status       TEXT NOT NULL,
                     error        TEXT NOT NULL DEFAULT '',
                     question_ids TEXT NOT NULL DEFAULT '[]',
                     score        INTEGER NOT NULL DEFAULT 0,
                     total        INTEGER NOT NULL DEFAULT 0,
                     created_at   INTEGER NOT NULL,
                     updated_at   INTEGER NOT NULL
                 );
                 CREATE INDEX practice_sessions_user ON practice_sessions(user_id, vault_id, created_at);
                 CREATE TABLE attempts (
                     id          INTEGER PRIMARY KEY,
                     session_id  TEXT NOT NULL REFERENCES practice_sessions(id) ON DELETE CASCADE,
                     user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                     vault_id    TEXT NOT NULL,
                     question_id INTEGER REFERENCES questions(id) ON DELETE SET NULL,
                     question    TEXT NOT NULL,
                     answer      TEXT NOT NULL,
                     marks       INTEGER,
                     total       INTEGER NOT NULL,
                     feedback    TEXT NOT NULL DEFAULT '{}',
                     created_at  INTEGER NOT NULL
                 );
                 CREATE INDEX attempts_user ON attempts(user_id, vault_id);
                 CREATE TABLE flash_decks (
                     id         TEXT PRIMARY KEY,
                     vault_id   TEXT NOT NULL,
                     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                     title      TEXT NOT NULL,
                     settings   TEXT NOT NULL DEFAULT '{}',
                     status     TEXT NOT NULL,
                     error      TEXT NOT NULL DEFAULT '',
                     cards      TEXT NOT NULL DEFAULT '[]',
                     progress   TEXT NOT NULL DEFAULT '{}',
                     created_at INTEGER NOT NULL,
                     updated_at INTEGER NOT NULL
                 );
                 CREATE INDEX flash_decks_user ON flash_decks(user_id, vault_id, created_at);
                 CREATE TABLE coach_messages (
                     id         INTEGER PRIMARY KEY,
                     vault_id   TEXT NOT NULL,
                     user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                     role       TEXT NOT NULL,
                     content    TEXT NOT NULL,
                     created_at INTEGER NOT NULL
                 );
                 CREATE INDEX coach_messages_user ON coach_messages(user_id, vault_id, id);
                 PRAGMA user_version = 6; COMMIT;",
            )?;
        }
        if version < 7 {
            // Past papers: what the paper is, from its cover (qualification, paper number, month, year).
            conn.execute_batch(
                "BEGIN;
                 ALTER TABLE hub_papers ADD COLUMN qualification TEXT NOT NULL DEFAULT '';
                 ALTER TABLE hub_papers ADD COLUMN paper_number TEXT NOT NULL DEFAULT '';
                 ALTER TABLE hub_papers ADD COLUMN month TEXT NOT NULL DEFAULT '';
                 ALTER TABLE hub_papers ADD COLUMN year INTEGER NOT NULL DEFAULT 0;
                 PRAGMA user_version = 7; COMMIT;",
            )?;
        }
        if version < 8 {
            // Course documents for the question hub (specifications, examiner reports, answers and commentaries,
            // notes and guidance), the guide to each examined paper built from them, and the specification areas
            // each question examines.
            conn.execute_batch(
                "BEGIN;
                 ALTER TABLE questions ADD COLUMN spec TEXT NOT NULL DEFAULT '[]';
                 ALTER TABLE questions ADD COLUMN profile_id INTEGER;
                 CREATE TABLE hub_docs (
                     id            INTEGER PRIMARY KEY,
                     vault_id      TEXT NOT NULL,
                     user_id       INTEGER,
                     username      TEXT NOT NULL DEFAULT '',
                     kind          TEXT NOT NULL,
                     title         TEXT NOT NULL,
                     path          TEXT NOT NULL DEFAULT '',
                     qualification TEXT NOT NULL DEFAULT '',
                     paper_number  TEXT NOT NULL DEFAULT '',
                     month         TEXT NOT NULL DEFAULT '',
                     year          INTEGER NOT NULL DEFAULT 0,
                     digest        TEXT NOT NULL DEFAULT '{}',
                     created_at    INTEGER NOT NULL
                 );
                 CREATE INDEX hub_docs_vault ON hub_docs(vault_id);
                 CREATE TABLE paper_profiles (
                     id            INTEGER PRIMARY KEY,
                     vault_id      TEXT NOT NULL,
                     qualification TEXT NOT NULL,
                     paper_number  TEXT NOT NULL,
                     title         TEXT NOT NULL,
                     profile       TEXT NOT NULL,
                     updated_at    INTEGER NOT NULL,
                     UNIQUE (vault_id, qualification, paper_number)
                 );
                 PRAGMA user_version = 8; COMMIT;",
            )?;
        }
        Ok(Db { conn: Arc::new(Mutex::new(conn)) })
    }

    /// Run a closure against the connection on a blocking thread.
    pub async fn call<F, R>(&self, f: F) -> Result<R>
    where
        F: FnOnce(&mut Connection) -> rusqlite::Result<R> + Send + 'static,
        R: Send + 'static,
    {
        let conn = self.conn.clone();
        let res = tokio::task::spawn_blocking(move || {
            let mut guard = conn.lock().unwrap_or_else(|e| e.into_inner());
            f(&mut guard)
        })
        .await?;
        Ok(res?)
    }

    // ---------- users ----------

    pub async fn count_users(&self) -> Result<i64> {
        self.call(|c| c.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))).await
    }

    pub async fn count_active_admins(&self) -> Result<i64> {
        self.call(|c| {
            c.query_row(
                "SELECT COUNT(*) FROM users WHERE role = 'admin' AND disabled = 0",
                [],
                |r| r.get(0),
            )
        })
        .await
    }

    /// Returns `Ok(None)` if the username already exists.
    pub async fn create_user(
        &self,
        username: String,
        hash: String,
        role: &'static str,
        must_change: bool,
    ) -> Result<Option<i64>> {
        self.call(move |c| {
            let res = c.execute(
                "INSERT INTO users (username, password_hash, role, must_change_password, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![username, hash, role, must_change, now()],
            );
            match res {
                Ok(_) => Ok(Some(c.last_insert_rowid())),
                Err(rusqlite::Error::SqliteFailure(e, _))
                    if e.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    Ok(None)
                }
                Err(e) => Err(e),
            }
        })
        .await
    }

    pub async fn get_user_by_name(&self, username: String) -> Result<Option<UserRow>> {
        self.call(move |c| {
            c.query_row(
                &format!("SELECT {USER_COLS} FROM users WHERE username = ?1"),
                [username],
                user_from_row,
            )
            .optional()
        })
        .await
    }

    pub async fn get_user(&self, id: i64) -> Result<Option<UserRow>> {
        self.call(move |c| {
            c.query_row(&format!("SELECT {USER_COLS} FROM users WHERE id = ?1"), [id], user_from_row)
                .optional()
        })
        .await
    }

    pub async fn list_users(&self) -> Result<Vec<UserRow>> {
        self.call(|c| {
            let mut st =
                c.prepare(&format!("SELECT {USER_COLS} FROM users ORDER BY username COLLATE NOCASE"))?;
            let rows = st.query_map([], user_from_row)?.collect();
            rows
        })
        .await
    }

    pub async fn set_password(&self, id: i64, hash: String, must_change: bool) -> Result<()> {
        self.call(move |c| {
            c.execute(
                "UPDATE users SET password_hash = ?2, must_change_password = ?3 WHERE id = ?1",
                params![id, hash, must_change],
            )
            .map(|_| ())
        })
        .await
    }

    pub async fn set_disabled(&self, id: i64, disabled: bool) -> Result<()> {
        self.call(move |c| {
            c.execute("UPDATE users SET disabled = ?2 WHERE id = ?1", params![id, disabled]).map(|_| ())
        })
        .await
    }

    pub async fn set_role(&self, id: i64, role: &'static str) -> Result<()> {
        self.call(move |c| {
            c.execute("UPDATE users SET role = ?2 WHERE id = ?1", params![id, role]).map(|_| ())
        })
        .await
    }

    pub async fn delete_user(&self, id: i64) -> Result<()> {
        self.call(move |c| c.execute("DELETE FROM users WHERE id = ?1", [id]).map(|_| ())).await
    }

    pub async fn touch_login(&self, id: i64) -> Result<()> {
        self.call(move |c| {
            c.execute("UPDATE users SET last_login_at = ?2 WHERE id = ?1", params![id, now()]).map(|_| ())
        })
        .await
    }

    // ---------- sessions ----------

    pub async fn create_session(
        &self,
        token_hash: String,
        user_id: i64,
        csrf: String,
        ip: String,
        user_agent: String,
    ) -> Result<()> {
        self.call(move |c| {
            let tx = c.transaction()?;
            let ts = now();
            tx.execute(
                "INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, last_seen_at, ip, user_agent)
                 VALUES (?1, ?2, ?3, ?4, ?4, ?5, ?6)",
                params![token_hash, user_id, csrf, ts, ip, user_agent],
            )?;
            // Keep at most 10 concurrent sessions per user.
            tx.execute(
                "DELETE FROM sessions WHERE user_id = ?1 AND token_hash NOT IN
                   (SELECT token_hash FROM sessions WHERE user_id = ?1 ORDER BY last_seen_at DESC LIMIT 10)",
                [user_id],
            )?;
            tx.commit()
        })
        .await
    }

    pub async fn get_session(&self, token_hash: String) -> Result<Option<SessionRow>> {
        self.call(move |c| {
            c.query_row(
                "SELECT s.user_id, u.username, u.role, u.disabled, u.must_change_password,
                        s.csrf_token, s.created_at, s.last_seen_at
                 FROM sessions s JOIN users u ON u.id = s.user_id
                 WHERE s.token_hash = ?1",
                [token_hash],
                |r| {
                    Ok(SessionRow {
                        user_id: r.get(0)?,
                        username: r.get(1)?,
                        role: r.get(2)?,
                        disabled: r.get(3)?,
                        must_change_password: r.get(4)?,
                        csrf_token: r.get(5)?,
                        created_at: r.get(6)?,
                        last_seen_at: r.get(7)?,
                    })
                },
            )
            .optional()
        })
        .await
    }

    pub async fn touch_session(&self, token_hash: String) -> Result<()> {
        self.call(move |c| {
            c.execute(
                "UPDATE sessions SET last_seen_at = ?2 WHERE token_hash = ?1",
                params![token_hash, now()],
            )
            .map(|_| ())
        })
        .await
    }

    pub async fn delete_session(&self, token_hash: String) -> Result<()> {
        self.call(move |c| {
            c.execute("DELETE FROM sessions WHERE token_hash = ?1", [token_hash]).map(|_| ())
        })
        .await
    }

    /// Delete every session of a user, optionally keeping one (the current one).
    pub async fn delete_user_sessions(&self, user_id: i64, keep: Option<String>) -> Result<()> {
        self.call(move |c| {
            c.execute(
                "DELETE FROM sessions WHERE user_id = ?1 AND token_hash IS NOT ?2",
                params![user_id, keep],
            )
            .map(|_| ())
        })
        .await
    }

    pub async fn delete_expired_sessions(&self, idle_secs: i64, max_secs: i64) -> Result<usize> {
        self.call(move |c| {
            let t = now();
            c.execute(
                "DELETE FROM sessions WHERE last_seen_at < ?1 OR created_at < ?2",
                params![t - idle_secs, t - max_secs],
            )
        })
        .await
    }

    // ---------- vaults ----------

    pub async fn create_vault(
        &self,
        id: String,
        name: String,
        description: String,
        shared_with_all: bool,
        file_count: i64,
        total_bytes: i64,
    ) -> Result<()> {
        self.call(move |c| {
            let t = now();
            c.execute(
                "INSERT INTO vaults (id, name, description, shared_with_all, file_count, total_bytes, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![id, name, description, shared_with_all, file_count, total_bytes, t],
            )
            .map(|_| ())
        })
        .await
    }

    pub async fn get_vault(&self, id: String) -> Result<Option<VaultRow>> {
        self.call(move |c| {
            c.query_row(&format!("SELECT {VAULT_COLS} FROM vaults WHERE id = ?1"), [id], vault_from_row)
                .optional()
        })
        .await
    }

    pub async fn list_vaults(&self) -> Result<Vec<VaultRow>> {
        self.call(|c| {
            let mut st =
                c.prepare(&format!("SELECT {VAULT_COLS} FROM vaults ORDER BY name COLLATE NOCASE"))?;
            let rows = st.query_map([], vault_from_row)?.collect();
            rows
        })
        .await
    }

    pub async fn update_vault_meta(
        &self,
        id: String,
        name: String,
        description: String,
        shared_with_all: bool,
    ) -> Result<()> {
        self.call(move |c| {
            c.execute(
                "UPDATE vaults SET name = ?2, description = ?3, shared_with_all = ?4 WHERE id = ?1",
                params![id, name, description, shared_with_all],
            )
            .map(|_| ())
        })
        .await
    }

    pub async fn update_vault_stats(&self, id: String, files: i64, bytes: i64) -> Result<()> {
        self.call(move |c| {
            c.execute(
                "UPDATE vaults SET file_count = ?2, total_bytes = ?3, updated_at = ?4 WHERE id = ?1",
                params![id, files, bytes, now()],
            )
            .map(|_| ())
        })
        .await
    }

    pub async fn delete_vault(&self, id: String) -> Result<()> {
        self.call(move |c| {
            let tx = c.transaction()?;
            tx.execute("DELETE FROM graph_state WHERE vault_id = ?1", [&id])?;
            tx.execute("DELETE FROM graph_presets WHERE vault_id = ?1", [&id])?;
            for table in ["attempts", "practice_sessions", "questions", "hub_papers", "flash_decks", "coach_messages", "hub_docs", "paper_profiles"] {
                tx.execute(&format!("DELETE FROM {table} WHERE vault_id = ?1"), [&id])?;
            }
            tx.execute("DELETE FROM vaults WHERE id = ?1", [&id])?;
            tx.commit()
        })
        .await
    }

    // ---------- API usage ----------

    #[allow(clippy::too_many_arguments)]
    pub async fn record_usage(
        &self,
        who: Option<(i64, String)>,
        vault_id: String,
        model: String,
        input: i64,
        output: i64,
        cache_read: i64,
        cache_write: i64,
        cost_micro_usd: i64,
    ) -> Result<()> {
        self.call(move |c| {
            let (uid, name) = match who {
                Some((id, n)) => (Some(id), Some(n)),
                None => (None, None),
            };
            c.execute(
                "INSERT INTO api_usage (ts, user_id, username, vault_id, model, input_tokens, output_tokens,
                                        cache_read_tokens, cache_write_tokens, cost_micro_usd)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                params![now(), uid, name, vault_id, model, input, output, cache_read, cache_write, cost_micro_usd],
            )
            .map(|_| ())
        })
        .await
    }

    /// `(day number in UTC, cost in millionths of a dollar, calls)` for each day with calls since `since`.
    pub async fn usage_by_day(&self, since: i64) -> Result<Vec<(i64, i64, i64)>> {
        self.call(move |c| {
            let mut st = c.prepare(
                "SELECT ts / 86400, SUM(cost_micro_usd), COUNT(*) FROM api_usage WHERE ts >= ?1 GROUP BY ts / 86400",
            )?;
            let rows = st.query_map([since], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect();
            rows
        })
        .await
    }

    /// `(model, cost, calls)` since `since`, dearest first.
    pub async fn usage_by_model(&self, since: i64) -> Result<Vec<(String, i64, i64)>> {
        self.call(move |c| {
            let mut st = c.prepare(
                "SELECT model, SUM(cost_micro_usd), COUNT(*) FROM api_usage WHERE ts >= ?1
                 GROUP BY model ORDER BY SUM(cost_micro_usd) DESC",
            )?;
            let rows = st.query_map([since], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect();
            rows
        })
        .await
    }

    /// `(cost, calls)` over all time.
    pub async fn usage_total(&self) -> Result<(i64, i64)> {
        self.call(|c| {
            c.query_row("SELECT COALESCE(SUM(cost_micro_usd), 0), COUNT(*) FROM api_usage", [], |r| Ok((r.get(0)?, r.get(1)?)))
        })
        .await
    }

    // ---------- settings ----------

    pub async fn settings_with_prefix(&self, prefix: &'static str) -> Result<std::collections::HashMap<String, String>> {
        self.call(move |c| {
            let mut st = c.prepare("SELECT key, value FROM settings WHERE key LIKE ?1 || '%'")?;
            let rows = st.query_map([prefix], |r| Ok((r.get(0)?, r.get(1)?)))?.collect();
            rows
        })
        .await
    }

    pub async fn set_setting(&self, key: String, value: String) -> Result<()> {
        self.call(move |c| {
            c.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map(|_| ())
        })
        .await
    }

    // ---------- audit ----------

    pub async fn audit(
        &self,
        user: Option<(i64, String)>,
        ip: Option<String>,
        action: &'static str,
        detail: String,
    ) {
        tracing::info!(target: "audit", action, user = ?user.as_ref().map(|u| &u.1), ip = ?ip, %detail);
        let res = self
            .call(move |c| {
                c.execute(
                    "INSERT INTO audit_log (ts, user_id, username, ip, action, detail) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![now(), user.as_ref().map(|u| u.0), user.map(|u| u.1), ip, action, detail],
                )
            })
            .await;
        if let Err(e) = res {
            tracing::error!("failed to write audit log: {e:#}");
        }
    }

    pub async fn recent_audit(&self, limit: i64) -> Result<Vec<AuditRow>> {
        self.call(move |c| {
            let mut st = c.prepare(
                "SELECT ts, username, ip, action, detail FROM audit_log ORDER BY id DESC LIMIT ?1",
            )?;
            let rows = st
                .query_map([limit], |r| {
                    Ok(AuditRow {
                        ts: r.get(0)?,
                        username: r.get(1)?,
                        ip: r.get(2)?,
                        action: r.get(3)?,
                        detail: r.get(4)?,
                    })
                })?
                .collect();
            rows
        })
        .await
    }

    pub async fn prune_audit(&self, keep_secs: i64) -> Result<usize> {
        self.call(move |c| c.execute("DELETE FROM audit_log WHERE ts < ?1", [now() - keep_secs])).await
    }

    // ---------------------------------------------------------------- ingest batches

    pub async fn create_batch(&self, id: String, vault_id: String, user_id: i64, username: String, kind: &'static str, meta: String) -> Result<()> {
        self.call(move |c| {
            let ts = now();
            c.execute(
                "INSERT INTO ingest_batches (id, vault_id, user_id, username, status, created_at, updated_at, kind, meta)
                 VALUES (?1, ?2, ?3, ?4, 'uploading', ?5, ?5, ?6, ?7)",
                params![id, vault_id, user_id, username, ts, kind, meta],
            )
            .map(|_| ())
        })
        .await
    }

    pub async fn get_batch(&self, id: String) -> Result<Option<BatchRow>> {
        self.call(move |c| {
            c.query_row(&format!("SELECT {BATCH_COLS} FROM ingest_batches WHERE id = ?1"), [id], batch_row).optional()
        })
        .await
    }

    /// The most recent batches of a vault, newest first.
    pub async fn list_batches(&self, vault_id: String, kind: &'static str, limit: i64) -> Result<Vec<BatchRow>> {
        self.call(move |c| {
            let mut st = c.prepare(&format!(
                "SELECT {BATCH_COLS} FROM ingest_batches WHERE vault_id = ?1 AND kind = ?3 ORDER BY created_at DESC, rowid DESC LIMIT ?2"
            ))?;
            let rows = st.query_map(params![vault_id, limit, kind], batch_row)?.collect();
            rows
        })
        .await
    }

    /// Record an uploaded file (as JSON `{name, stored, size}`) on a batch that is still being uploaded.
    pub async fn add_batch_file(&self, id: String, file: serde_json::Value) -> Result<bool> {
        self.call(move |c| {
            let tx = c.transaction()?;
            let files: Option<String> = tx
                .query_row("SELECT files FROM ingest_batches WHERE id = ?1 AND status = 'uploading'", [&id], |r| r.get(0))
                .optional()?;
            let Some(files) = files else { return Ok(false) };
            let mut list: Vec<serde_json::Value> = serde_json::from_str(&files).unwrap_or_default();
            list.push(file);
            tx.execute(
                "UPDATE ingest_batches SET files = ?2, updated_at = ?3 WHERE id = ?1",
                params![id, serde_json::Value::Array(list).to_string(), now()],
            )?;
            tx.commit()?;
            Ok(true)
        })
        .await
    }

    /// Move a batch from one status to another. False when it was not in `from`.
    pub async fn set_batch_status(&self, id: String, from: &'static [&'static str], to: &'static str) -> Result<bool> {
        self.call(move |c| {
            let marks = from.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(",");
            let n = c.execute(
                &format!("UPDATE ingest_batches SET status = ?2, updated_at = ?3 WHERE id = ?1 AND status IN ({marks})"),
                params![id, to, now()],
            )?;
            Ok(n == 1)
        })
        .await
    }

    pub async fn request_batch_cancel(&self, id: String) -> Result<()> {
        self.call(move |c| {
            c.execute("UPDATE ingest_batches SET cancel_requested = 1, updated_at = ?2 WHERE id = ?1", params![id, now()]).map(|_| ())
        })
        .await
    }

    /// Store the worker's progress report; returns whether the batch's owner asked to cancel it.
    pub async fn set_batch_progress(&self, id: String, progress: String) -> Result<bool> {
        self.call(move |c| {
            c.execute(
                "UPDATE ingest_batches SET progress = ?2, updated_at = ?3 WHERE id = ?1 AND status = 'running'",
                params![id, progress, now()],
            )?;
            let cancel: Option<i64> =
                c.query_row("SELECT cancel_requested FROM ingest_batches WHERE id = ?1", [id], |r| r.get(0)).optional()?;
            Ok(cancel.unwrap_or(1) != 0)
        })
        .await
    }

    /// Hand the oldest queued batch to the worker: it becomes `running`, with the hash of the session made for it.
    pub async fn claim_batch(&self, session_hash: String) -> Result<Option<BatchRow>> {
        self.call(move |c| {
            let tx = c.transaction()?;
            let row = tx
                .query_row(
                    &format!("SELECT {BATCH_COLS} FROM ingest_batches WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1"),
                    [],
                    batch_row,
                )
                .optional()?;
            if let Some(r) = &row {
                tx.execute(
                    "UPDATE ingest_batches SET status = 'running', worker_session = ?2, updated_at = ?3 WHERE id = ?1",
                    params![r.id, session_hash, now()],
                )?;
            }
            tx.commit()?;
            Ok(row)
        })
        .await
    }

    /// End a running batch: final status and progress, and the worker's session is forgotten (returned to delete).
    pub async fn finish_batch(&self, id: String, status: &'static str, progress: Option<String>) -> Result<Option<String>> {
        self.call(move |c| {
            let tx = c.transaction()?;
            let session: Option<Option<String>> =
                tx.query_row("SELECT worker_session FROM ingest_batches WHERE id = ?1", [&id], |r| r.get(0)).optional()?;
            match progress {
                Some(p) => tx.execute(
                    "UPDATE ingest_batches SET status = ?2, progress = ?3, worker_session = NULL, updated_at = ?4 WHERE id = ?1",
                    params![id, status, p, now()],
                )?,
                None => tx.execute(
                    "UPDATE ingest_batches SET status = ?2, worker_session = NULL, updated_at = ?3 WHERE id = ?1",
                    params![id, status, now()],
                )?,
            };
            tx.commit()?;
            Ok(session.flatten())
        })
        .await
    }

    /// After a restart: batches that were running go back to the queue (the worker resumes them), and their old
    /// worker sessions are returned so they can be deleted.
    pub async fn requeue_running_batches(&self) -> Result<Vec<String>> {
        self.call(move |c| {
            let tx = c.transaction()?;
            let sessions: Vec<String> = {
                let mut st = tx.prepare("SELECT worker_session FROM ingest_batches WHERE status = 'running' AND worker_session IS NOT NULL")?;
                let rows = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
                rows
            };
            tx.execute("UPDATE ingest_batches SET status = 'queued', worker_session = NULL, updated_at = ?1 WHERE status = 'running'", [now()])?;
            tx.commit()?;
            Ok(sessions)
        })
        .await
    }

    /// Forget finished batches older than `keep_secs`, and abandoned uploads older than a day. Returns their ids.
    pub async fn prune_batches(&self, keep_secs: i64) -> Result<Vec<String>> {
        self.call(move |c| {
            let tx = c.transaction()?;
            let cutoff = now() - keep_secs;
            let stale = now() - 86_400;
            let ids: Vec<String> = {
                let mut st = tx.prepare(
                    "SELECT id FROM ingest_batches WHERE (status IN ('done','failed','cancelled') AND updated_at < ?1)
                        OR (status = 'uploading' AND updated_at < ?2)",
                )?;
                let rows = st.query_map(params![cutoff, stale], |r| r.get(0))?.collect::<rusqlite::Result<Vec<String>>>()?;
                rows
            };
            for id in &ids {
                tx.execute("DELETE FROM ingest_batches WHERE id = ?1", [id])?;
            }
            tx.commit()?;
            Ok(ids)
        })
        .await
    }
}

#[derive(Clone, Debug)]
pub struct GraphPreset {
    pub id: i64,
    pub user_id: i64,
    pub username: String,
    pub name: String,
    pub settings: String,
    pub updated_at: i64,
}

impl Db {
    // ---------- graph view settings ----------

    pub async fn graph_state(&self, user_id: i64, vault_id: String) -> Result<Option<String>> {
        self.call(move |c| {
            c.query_row("SELECT settings FROM graph_state WHERE user_id = ?1 AND vault_id = ?2", params![user_id, vault_id], |r| r.get(0))
                .optional()
        })
        .await
    }

    pub async fn set_graph_state(&self, user_id: i64, vault_id: String, settings: String) -> Result<()> {
        self.call(move |c| {
            c.execute(
                "INSERT INTO graph_state (user_id, vault_id, settings, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT (user_id, vault_id) DO UPDATE SET settings = excluded.settings, updated_at = excluded.updated_at",
                params![user_id, vault_id, settings, now()],
            )
            .map(|_| ())
        })
        .await
    }

    /// Every preset for a vault, of every account, newest first.
    pub async fn graph_presets(&self, vault_id: String) -> Result<Vec<GraphPreset>> {
        self.call(move |c| {
            let mut st = c.prepare(
                "SELECT p.id, p.user_id, u.username, p.name, p.settings, p.updated_at
                 FROM graph_presets p JOIN users u ON u.id = p.user_id
                 WHERE p.vault_id = ?1 ORDER BY u.username COLLATE NOCASE, p.name COLLATE NOCASE",
            )?;
            let rows = st
                .query_map([vault_id], |r| {
                    Ok(GraphPreset {
                        id: r.get(0)?,
                        user_id: r.get(1)?,
                        username: r.get(2)?,
                        name: r.get(3)?,
                        settings: r.get(4)?,
                        updated_at: r.get(5)?,
                    })
                })?
                .collect();
            rows
        })
        .await
    }

    /// Save a preset under a name, replacing the account's own preset of that name. Returns its id, or None
    /// when the account already has `max` presets for this vault (and none of this name).
    pub async fn save_graph_preset(&self, user_id: i64, vault_id: String, name: String, settings: String, max: i64) -> Result<Option<i64>> {
        self.call(move |c| {
            let tx = c.transaction()?;
            let existing: Option<i64> = tx
                .query_row(
                    "SELECT id FROM graph_presets WHERE user_id = ?1 AND vault_id = ?2 AND name = ?3",
                    params![user_id, vault_id, name],
                    |r| r.get(0),
                )
                .optional()?;
            let id = match existing {
                Some(id) => {
                    tx.execute("UPDATE graph_presets SET settings = ?1, updated_at = ?2 WHERE id = ?3", params![settings, now(), id])?;
                    id
                }
                None => {
                    let n: i64 = tx.query_row(
                        "SELECT COUNT(*) FROM graph_presets WHERE user_id = ?1 AND vault_id = ?2",
                        params![user_id, vault_id],
                        |r| r.get(0),
                    )?;
                    if n >= max {
                        return Ok(None);
                    }
                    tx.execute(
                        "INSERT INTO graph_presets (user_id, vault_id, name, settings, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                        params![user_id, vault_id, name, settings, now()],
                    )?;
                    tx.last_insert_rowid()
                }
            };
            tx.commit()?;
            Ok(Some(id))
        })
        .await
    }

    /// Delete one of the account's own presets. False when there is no such preset.
    pub async fn delete_graph_preset(&self, user_id: i64, vault_id: String, id: i64) -> Result<bool> {
        self.call(move |c| {
            c.execute("DELETE FROM graph_presets WHERE id = ?1 AND user_id = ?2 AND vault_id = ?3", params![id, user_id, vault_id]).map(|n| n > 0)
        })
        .await
    }
}

#[derive(Clone, Debug)]
pub struct BatchRow {
    pub id: String,
    pub vault_id: String,
    pub user_id: i64,
    pub username: String,
    pub status: String,
    pub cancel_requested: bool,
    pub files: String,
    pub progress: String,
    pub created_at: i64,
    pub updated_at: i64,
    /// "sources" (files to file into the vault) or "paper" (a past paper and its mark scheme for the question hub).
    pub kind: String,
    pub meta: String,
}

const BATCH_COLS: &str =
    "id, vault_id, user_id, username, status, cancel_requested, files, progress, created_at, updated_at, kind, meta";

fn batch_row(r: &rusqlite::Row) -> rusqlite::Result<BatchRow> {
    Ok(BatchRow {
        id: r.get(0)?,
        vault_id: r.get(1)?,
        user_id: r.get(2)?,
        username: r.get(3)?,
        status: r.get(4)?,
        cancel_requested: r.get::<_, i64>(5)? != 0,
        files: r.get(6)?,
        progress: r.get(7)?,
        created_at: r.get(8)?,
        updated_at: r.get(9)?,
        kind: r.get(10)?,
        meta: r.get(11)?,
    })
}
