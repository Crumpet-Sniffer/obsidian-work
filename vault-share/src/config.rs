use std::{env, net::SocketAddr, path::PathBuf};

use anyhow::{bail, Context, Result};

/// Runtime configuration, read once from environment variables at startup.
#[derive(Clone, Debug)]
pub struct Config {
    pub bind: SocketAddr,
    pub data_dir: PathBuf,
    pub site_name: String,
    /// Mark cookies `Secure` + send HSTS. Must be true whenever the site is reached over HTTPS.
    pub cookie_secure: bool,
    /// Trust `X-Forwarded-For` / `X-Forwarded-Host` (only enable behind a reverse proxy you control).
    pub trust_proxy: bool,
    /// Exact public origin, e.g. `https://notes.example.com`. Used for the CSRF origin check.
    pub public_origin: Option<String>,
    pub max_upload_bytes: u64,
    pub max_extracted_bytes: u64,
    pub max_file_bytes: u64,
    pub max_files: usize,
    pub session_idle_secs: i64,
    pub session_max_secs: i64,
    pub admin_username: String,
    pub admin_password: Option<String>,
}

fn env_str(name: &str) -> Option<String> {
    env::var(name).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn env_bool(name: &str, default: bool) -> Result<bool> {
    match env_str(name) {
        None => Ok(default),
        Some(v) => match v.to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Ok(true),
            "0" | "false" | "no" | "off" => Ok(false),
            _ => bail!("{name} must be true or false (got {v:?})"),
        },
    }
}

fn env_u64(name: &str, default: u64) -> Result<u64> {
    match env_str(name) {
        None => Ok(default),
        Some(v) => v.parse().with_context(|| format!("{name} must be a whole number")),
    }
}

const MIB: u64 = 1024 * 1024;

impl Config {
    pub fn from_env() -> Result<Self> {
        let bind: SocketAddr = env_str("BIND_ADDR")
            .unwrap_or_else(|| "0.0.0.0:8080".into())
            .parse()
            .context("BIND_ADDR must look like 0.0.0.0:8080")?;

        let public_origin = env_str("PUBLIC_ORIGIN").map(|s| s.trim_end_matches('/').to_string());
        if let Some(o) = &public_origin {
            if !(o.starts_with("https://") || o.starts_with("http://")) {
                bail!("PUBLIC_ORIGIN must start with https:// or http://");
            }
        }

        let admin_username = env_str("ADMIN_USERNAME").unwrap_or_else(|| "admin".into());
        let cfg = Config {
            bind,
            data_dir: env_str("DATA_DIR").map(PathBuf::from).unwrap_or_else(|| "/data".into()),
            site_name: env_str("SITE_NAME").unwrap_or_else(|| "Vault Share".into()),
            cookie_secure: env_bool("COOKIE_SECURE", true)?,
            trust_proxy: env_bool("TRUST_PROXY", false)?,
            public_origin,
            max_upload_bytes: env_u64("MAX_UPLOAD_MB", 512)? * MIB,
            max_extracted_bytes: env_u64("MAX_EXTRACTED_MB", 2048)? * MIB,
            max_file_bytes: env_u64("MAX_FILE_MB", 256)? * MIB,
            max_files: env_u64("MAX_FILES", 20_000)? as usize,
            session_idle_secs: env_u64("SESSION_IDLE_HOURS", 24)? as i64 * 3600,
            session_max_secs: env_u64("SESSION_MAX_DAYS", 7)? as i64 * 86_400,
            admin_username,
            admin_password: env_str("ADMIN_PASSWORD"),
        };
        if cfg.max_upload_bytes == 0 || cfg.max_files == 0 {
            bail!("upload limits must be greater than zero");
        }
        Ok(cfg)
    }

    /// `__Host-` prefix forces Secure + Path=/ + no Domain in the browser.
    pub fn session_cookie(&self) -> &'static str {
        if self.cookie_secure {
            "__Host-vs_session"
        } else {
            "vs_session"
        }
    }

    pub fn vaults_dir(&self) -> PathBuf {
        self.data_dir.join("vaults")
    }

    pub fn tmp_dir(&self) -> PathBuf {
        self.data_dir.join("tmp")
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("vault-share.db")
    }
}
