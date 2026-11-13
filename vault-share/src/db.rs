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

    pub async fn list_vaults_for_user(&self, user_id: i64) -> Result<Vec<VaultRow>> {
        self.call(move |c| {
            let mut st = c.prepare(&format!(
                "SELECT {VAULT_COLS} FROM vaults
                 WHERE shared_with_all = 1
                    OR id IN (SELECT vault_id FROM vault_access WHERE user_id = ?1)
                 ORDER BY name COLLATE NOCASE"
            ))?;
            let rows = st.query_map([user_id], vault_from_row)?.collect();
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
        self.call(move |c| c.execute("DELETE FROM vaults WHERE id = ?1", [id]).map(|_| ())).await
    }

    pub async fn user_has_access(&self, vault_id: String, user_id: i64) -> Result<bool> {
        self.call(move |c| {
            c.query_row(
                "SELECT EXISTS (SELECT 1 FROM vault_access WHERE vault_id = ?1 AND user_id = ?2)",
                params![vault_id, user_id],
                |r| r.get(0),
            )
        })
        .await
    }

    /// Every non-admin user plus whether they were explicitly granted this vault.
    pub async fn access_list(&self, vault_id: String) -> Result<Vec<(i64, String, bool)>> {
        self.call(move |c| {
            let mut st = c.prepare(
                "SELECT u.id, u.username,
                        EXISTS (SELECT 1 FROM vault_access a WHERE a.vault_id = ?1 AND a.user_id = u.id)
                 FROM users u WHERE u.role = 'member'
                 ORDER BY u.username COLLATE NOCASE",
            )?;
            let rows = st.query_map([vault_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect();
            rows
        })
        .await
    }

    pub async fn set_access(&self, vault_id: String, user_id: i64, granted: bool) -> Result<()> {
        self.call(move |c| {
            if granted {
                c.execute(
                    "INSERT OR IGNORE INTO vault_access (vault_id, user_id) VALUES (?1, ?2)",
                    params![vault_id, user_id],
                )
            } else {
                c.execute(
                    "DELETE FROM vault_access WHERE vault_id = ?1 AND user_id = ?2",
                    params![vault_id, user_id],
                )
            }
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
}
