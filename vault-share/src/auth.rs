//! Passwords, sessions, login throttling and the request extractors that enforce authentication.

use std::{
    collections::HashMap,
    convert::Infallible,
    net::SocketAddr,
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use axum::{
    extract::{ConnectInfo, FromRequestParts},
    http::{header, request::Parts, HeaderMap, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Redirect, Response},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand::{rngs::OsRng, Rng, RngCore};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;

use crate::{config::Config, db, errors::AppError, AppState};

// ---------------------------------------------------------------- passwords

pub const MIN_PASSWORD_LEN: usize = 12;
pub const MAX_PASSWORD_LEN: usize = 128;

pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| anyhow::anyhow!("hashing failed: {e}"))
}

pub fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok(),
        Err(_) => false,
    }
}

/// A real Argon2 hash used when the username does not exist, so that response timing
/// does not reveal which usernames are valid.
pub fn dummy_hash() -> &'static str {
    static H: OnceLock<String> = OnceLock::new();
    H.get_or_init(|| hash_password(&random_token(16)).expect("argon2 works"))
}

pub async fn hash_password_async(password: String) -> anyhow::Result<String> {
    tokio::task::spawn_blocking(move || hash_password(&password)).await?
}

pub async fn verify_password_async(password: String, hash: String) -> bool {
    tokio::task::spawn_blocking(move || verify_password(&password, &hash)).await.unwrap_or(false)
}

pub fn validate_new_password(password: &str, username: &str) -> Result<(), String> {
    let chars = password.chars().count();
    if chars < MIN_PASSWORD_LEN {
        return Err(format!("Password must be at least {MIN_PASSWORD_LEN} characters."));
    }
    if password.len() > MAX_PASSWORD_LEN {
        return Err(format!("Password must be at most {MAX_PASSWORD_LEN} bytes."));
    }
    if password.to_lowercase().contains(&username.to_lowercase()) {
        return Err("Password must not contain your username.".into());
    }
    let distinct: std::collections::HashSet<char> = password.chars().collect();
    if distinct.len() < 5 {
        return Err("Password is too repetitive.".into());
    }
    const COMMON: &[&str] = &[
        "password", "123456", "qwerty", "letmein", "welcome", "iloveyou", "admin", "abc123",
        "obsidian", "monkey", "dragon", "football",
    ];
    let lower = password.to_lowercase();
    if COMMON.iter().any(|c| lower.contains(c)) && chars < 16 {
        return Err("Password is too easy to guess. Try a longer passphrase.".into());
    }
    Ok(())
}

/// Human-friendly one-time password for new/reset accounts (~80 bits of entropy).
pub fn generate_temp_password() -> String {
    const ALPHABET: &[u8] = b"abcdefghjkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";
    let mut rng = OsRng;
    (0..4)
        .map(|_| {
            (0..4).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect::<String>()
        })
        .collect::<Vec<_>>()
        .join("-")
}

pub fn validate_username(name: &str) -> Result<(), String> {
    let ok_len = (3..=32).contains(&name.len());
    let ok_chars = name.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b));
    if ok_len && ok_chars {
        Ok(())
    } else {
        Err("Username must be 3-32 characters: letters, digits, '.', '_' or '-'.".into())
    }
}

// ---------------------------------------------------------------- tokens

pub fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    OsRng.fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

pub fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

pub fn ct_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && bool::from(a.as_bytes().ct_eq(b.as_bytes()))
}

// ---------------------------------------------------------------- cookies

pub fn get_cookie<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    for value in headers.get_all(header::COOKIE) {
        let Ok(s) = value.to_str() else { continue };
        for part in s.split(';') {
            if let Some((k, v)) = part.trim().split_once('=') {
                if k == name {
                    return Some(v);
                }
            }
        }
    }
    None
}

pub fn session_cookie(cfg: &Config, token: &str, max_age: i64) -> HeaderValue {
    // SameSite=Lax: cookie is sent on top-level navigations (so shared links work) but never on
    // cross-site POSTs. CSRF tokens + Origin checks protect every state-changing request too.
    let mut s = format!(
        "{}={}; Path=/; HttpOnly; SameSite=Lax; Max-Age={}",
        cfg.session_cookie(),
        token,
        max_age
    );
    if cfg.cookie_secure {
        s.push_str("; Secure");
    }
    HeaderValue::from_str(&s).expect("cookie is ascii")
}

pub fn clear_session_cookie(cfg: &Config) -> HeaderValue {
    session_cookie(cfg, "", 0)
}

// ---------------------------------------------------------------- login throttling

struct Attempts {
    failures: u32,
    window_start: Instant,
    locked_until: Option<Instant>,
}

/// In-memory brute-force protection keyed by client IP and by username.
#[derive(Default)]
pub struct LoginLimiter {
    map: Mutex<HashMap<String, Attempts>>,
}

pub const MAX_FAILS_PER_IP: u32 = 10;
pub const MAX_FAILS_PER_USER: u32 = 8;
const WINDOW: Duration = Duration::from_secs(15 * 60);
const LOCKOUT: Duration = Duration::from_secs(15 * 60);
const MAX_TRACKED: usize = 50_000;

impl LoginLimiter {
    /// Remaining lockout time, if the key is currently locked.
    pub fn locked(&self, key: &str) -> Option<Duration> {
        let map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        let until = map.get(key)?.locked_until?;
        until.checked_duration_since(Instant::now())
    }

    pub fn fail(&self, key: &str, max: u32) {
        let now = Instant::now();
        let mut map = self.map.lock().unwrap_or_else(|e| e.into_inner());
        if map.len() >= MAX_TRACKED {
            map.retain(|_, a| now.duration_since(a.window_start) < WINDOW || a.locked_until.is_some_and(|u| u > now));
            if map.len() >= MAX_TRACKED {
                map.clear(); // extreme flood; fail open on memory rather than crash
            }
        }
        let a = map.entry(key.to_string()).or_insert(Attempts { failures: 0, window_start: now, locked_until: None });
        if now.duration_since(a.window_start) > WINDOW {
            a.failures = 0;
            a.window_start = now;
            a.locked_until = None;
        }
        a.failures += 1;
        if a.failures >= max {
            a.locked_until = Some(now + LOCKOUT);
        }
    }

    pub fn reset(&self, key: &str) {
        self.map.lock().unwrap_or_else(|e| e.into_inner()).remove(key);
    }

    pub fn prune(&self) {
        let now = Instant::now();
        self.map
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .retain(|_, a| now.duration_since(a.window_start) < WINDOW || a.locked_until.is_some_and(|u| u > now));
    }
}

// ---------------------------------------------------------------- client ip

#[derive(Clone, Debug)]
pub struct ClientIp(pub String);

pub fn client_ip(parts: &Parts, cfg: &Config) -> String {
    if cfg.trust_proxy {
        // Right-most entry is the one appended by our (trusted) reverse proxy.
        if let Some(xff) = parts.headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()) {
            if let Some(ip) = xff.rsplit(',').map(str::trim).find(|s| !s.is_empty()) {
                return ip.chars().take(64).collect();
            }
        }
        if let Some(ip) = parts.headers.get("x-real-ip").and_then(|v| v.to_str().ok()) {
            return ip.trim().chars().take(64).collect();
        }
    }
    parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0.ip().to_string())
        .unwrap_or_else(|| "unknown".into())
}

impl FromRequestParts<AppState> for ClientIp {
    type Rejection = Infallible;
    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Infallible> {
        Ok(ClientIp(client_ip(parts, &st.cfg)))
    }
}

// ---------------------------------------------------------------- sessions

#[derive(Clone, Debug)]
pub struct CurrentUser {
    pub id: i64,
    pub username: String,
    pub is_admin: bool,
    pub must_change_password: bool,
    pub csrf: String,
    pub session_hash: String,
}

impl CurrentUser {
    pub fn audit_id(&self) -> Option<(i64, String)> {
        Some((self.id, self.username.clone()))
    }

    pub fn check_csrf(&self, provided: &str) -> Result<(), AppError> {
        if ct_eq(&self.csrf, provided) {
            Ok(())
        } else {
            Err(AppError::Forbidden("Your form expired. Go back, reload the page and try again.".into()))
        }
    }
}

fn plausible_token(t: &str) -> bool {
    t.len() == 43 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// Resolve the session cookie to a user, enforcing idle + absolute timeouts.
pub async fn lookup_session(st: &AppState, headers: &HeaderMap) -> Option<CurrentUser> {
    let token = get_cookie(headers, st.cfg.session_cookie())?;
    if !plausible_token(token) {
        return None;
    }
    let hash = sha256_hex(token);
    let row = match st.db.get_session(hash.clone()).await {
        Ok(Some(r)) => r,
        Ok(None) => return None,
        Err(e) => {
            tracing::error!("session lookup failed: {e:#}");
            return None;
        }
    };
    let now = db::now();
    let expired = now - row.last_seen_at > st.cfg.session_idle_secs
        || now - row.created_at > st.cfg.session_max_secs;
    if row.disabled || expired {
        let _ = st.db.delete_session(hash).await;
        return None;
    }
    if now - row.last_seen_at > 60 {
        let _ = st.db.touch_session(hash.clone()).await;
    }
    Some(CurrentUser {
        id: row.user_id,
        username: row.username,
        is_admin: row.role == "admin",
        must_change_password: row.must_change_password,
        csrf: row.csrf_token,
        session_hash: hash,
    })
}

/// Only allow local, path-absolute redirect targets (no `//evil.com`, no `\`).
pub fn safe_next(next: &str) -> Option<&str> {
    let ok = next.starts_with('/')
        && !next.starts_with("//")
        && !next.contains('\\')
        && !next.chars().any(|c| c.is_control())
        && next.len() <= 1024
        && !next.starts_with("/login")
        && !next.starts_with("/logout");
    ok.then_some(next)
}

impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Response> {
        match lookup_session(st, &parts.headers).await {
            Some(user) => {
                let path = parts.uri.path();
                if user.must_change_password && path != "/account/password" && path != "/logout" {
                    return Err(Redirect::to("/account/password").into_response());
                }
                Ok(user)
            }
            None if parts.method == Method::GET || parts.method == Method::HEAD => {
                let target = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or("/");
                let location = match safe_next(target) {
                    Some(t) if t != "/" => format!(
                        "/login?next={}",
                        percent_encoding::utf8_percent_encode(t, percent_encoding::NON_ALPHANUMERIC)
                    ),
                    _ => "/login".to_string(),
                };
                Err(Redirect::to(&location).into_response())
            }
            None => Err((StatusCode::UNAUTHORIZED, "Your session expired. Please sign in again.")
                .into_response()),
        }
    }
}

/// Extractor that additionally requires the admin role.
pub struct AdminUser(pub CurrentUser);

impl FromRequestParts<AppState> for AdminUser {
    type Rejection = Response;

    async fn from_request_parts(parts: &mut Parts, st: &AppState) -> Result<Self, Response> {
        let user = CurrentUser::from_request_parts(parts, st).await?;
        if user.is_admin {
            Ok(AdminUser(user))
        } else {
            Err(AppError::Forbidden("Administrators only.".into()).into_response())
        }
    }
}

/// Create the first admin account if the database has no users.
pub async fn bootstrap_admin(db: &db::Db, cfg: &Config) -> anyhow::Result<()> {
    if db.count_users().await? > 0 {
        return Ok(());
    }
    validate_username(&cfg.admin_username).map_err(|e| anyhow::anyhow!("ADMIN_USERNAME: {e}"))?;
    let (password, generated) = match &cfg.admin_password {
        Some(p) => {
            validate_new_password(p, &cfg.admin_username)
                .map_err(|e| anyhow::anyhow!("ADMIN_PASSWORD: {e}"))?;
            (p.clone(), false)
        }
        None => (generate_temp_password(), true),
    };
    let hash = hash_password_async(password.clone()).await?;
    // Always force a change on first login so the bootstrap secret stops being useful.
    db.create_user(cfg.admin_username.clone(), hash, "admin", true).await?;
    if generated {
        tracing::warn!(
            "\n==========================================================\n  Created initial admin account\n    username: {}\n    password: {}\n  You will be asked to change it on first sign-in.\n==========================================================",
            cfg.admin_username,
            password
        );
    } else {
        tracing::warn!("Created initial admin account '{}' from ADMIN_PASSWORD. Remove ADMIN_PASSWORD from your config after first sign-in.", cfg.admin_username);
    }
    db.audit(None, None, "bootstrap_admin", cfg.admin_username.clone()).await;
    Ok(())
}
