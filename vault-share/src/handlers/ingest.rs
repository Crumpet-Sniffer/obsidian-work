//! Microsidian on the site: add Word and PowerPoint files to a vault as sources.
//!
//! The browser does the conversion and the filing (it runs Microsidian's own code against the edit API).
//! This module holds what must stay on the server: the settings an admin chooses, and the one call to
//! Claude, which is made here so the API key never reaches a browser. The model and effort are set from
//! the admin's settings whatever the browser sent.

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Form, Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::{AdminUser, ClientIp, CurrentUser},
    db::Db,
    errors::{AppError, AppResult},
    handlers::{
        edit::{bad_path, changed, check_csrf, ok, root_of, ApiErr, ApiResult},
        vaults::{authorize, index_for},
    },
    templates::{render, PageCtx, SourcesPage},
    vault::{self, is_note, is_office, safe_rel, MAX_EDIT_BYTES},
    AppState,
};

/// Models an admin can pick. The first is the default (the one the Obsidian plugin uses).
pub const MODELS: &[(&str, &str)] = &[
    ("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    ("claude-opus-5-5", "Claude Opus 5.5"),
    ("claude-fable-5-2", "Claude Fable 5.2"),
    ("claude-haiku-5-5", "Claude Haiku 5.5"),
];
pub const EFFORTS: &[&str] = &["low", "medium", "high", "xhigh", "max"];

const GUIDANCE_MAX: usize = 4000;
/// Calls to Claude one account may make per hour.
const CALLS_PER_HOUR: usize = 60;
/// Room for the reply. The browser's own figure is replaced with this.
const MAX_TOKENS: u64 = 16_000;
/// Most text the corpus endpoint returns in one go.
const CORPUS_MAX_BYTES: usize = 96 * 1024 * 1024;

#[derive(Clone)]
pub struct Settings {
    /// From the admin page, or the ANTHROPIC_API_KEY environment variable when none is saved.
    pub api_key: Option<String>,
    /// True when the key in use was saved on the admin page (not taken from the environment).
    pub key_saved: bool,
    pub model: String,
    pub effort: String,
    pub guidance: String,
    pub ingest: String,
    pub originals: String,
    pub attachments: String,
    pub topics: String,
    pub topics_index: String,
    pub image_min_kb: u32,
    pub folder_indexes: bool,
}

impl Settings {
    pub async fn load(db: &Db) -> anyhow::Result<Self> {
        let s = db.settings_with_prefix("ms.").await?;
        let get = |k: &str, default: &str| s.get(k).cloned().unwrap_or_else(|| default.to_string());
        let saved = s.get("ms.api_key").cloned().filter(|k| !k.is_empty());
        let key_saved = saved.is_some();
        let env_key = std::env::var("ANTHROPIC_API_KEY").ok().map(|k| k.trim().to_string()).filter(|k| !k.is_empty());
        Ok(Settings {
            api_key: saved.or(env_key),
            key_saved,
            model: get("ms.model", MODELS[0].0),
            effort: get("ms.effort", "medium"),
            guidance: get("ms.guidance", ""),
            ingest: get("ms.ingest", "Ingest"),
            originals: get("ms.originals", "_Originals"),
            attachments: get("ms.attachments", "_Attachments/images"),
            topics: get("ms.topics", "Topics"),
            topics_index: get("ms.topics_index", "Topics - Index"),
            image_min_kb: s.get("ms.image_min_kb").and_then(|v| v.parse().ok()).unwrap_or(30),
            folder_indexes: s.get("ms.folder_indexes").map(|v| v == "1").unwrap_or(true),
        })
    }

    /// Last four characters of the key, to recognise it by on the admin page.
    pub fn key_hint(&self) -> String {
        match &self.api_key {
            Some(k) if k.chars().count() >= 12 => {
                let tail: String = k.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
                format!("…{tail}")
            }
            Some(_) => "set".into(),
            None => String::new(),
        }
    }
}

// ---------------------------------------------------------------- admin form

#[derive(Deserialize)]
pub struct SettingsForm {
    csrf: String,
    #[serde(default)]
    api_key: String,
    clear_key: Option<String>,
    model: String,
    effort: String,
    #[serde(default)]
    guidance: String,
    ingest: String,
    originals: String,
    attachments: String,
    topics: String,
    #[serde(default)]
    topics_index: String,
    image_min_kb: String,
    folder_indexes: Option<String>,
}

fn folder(value: &str, label: &str) -> Result<String, AppError> {
    let trimmed = value.trim().replace('\\', "/");
    let trimmed = trimmed.trim_matches('/');
    safe_rel(trimmed).ok_or_else(|| AppError::BadRequest(format!("{label}: that folder name is not allowed.")))
}

pub async fn save_settings(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    AdminUser(user): AdminUser,
    Form(f): Form<SettingsForm>,
) -> AppResult {
    user.check_csrf(&f.csrf)?;
    if !MODELS.iter().any(|(id, _)| *id == f.model) {
        return Err(AppError::BadRequest("Choose one of the listed models.".into()));
    }
    if !EFFORTS.contains(&f.effort.as_str()) {
        return Err(AppError::BadRequest("Choose one of the listed effort levels.".into()));
    }
    let image_min_kb: u32 = f
        .image_min_kb
        .trim()
        .parse()
        .ok()
        .filter(|n| *n <= 100_000)
        .ok_or_else(|| AppError::BadRequest("Smallest image must be a whole number of KB.".into()))?;
    let topics_index: String = f.topics_index.trim().chars().filter(|c| !c.is_control()).take(100).collect();
    let guidance: String = f.guidance.replace("\r\n", "\n").chars().filter(|c| !c.is_control() || *c == '\n').take(GUIDANCE_MAX).collect();

    let mut set: Vec<(&str, String)> = vec![
        ("ms.model", f.model.clone()),
        ("ms.effort", f.effort.clone()),
        ("ms.guidance", guidance),
        ("ms.ingest", folder(&f.ingest, "Ingest folder")?),
        ("ms.originals", folder(&f.originals, "Originals folder")?),
        ("ms.attachments", folder(&f.attachments, "Images folder")?),
        ("ms.topics", folder(&f.topics, "Topics folder")?),
        ("ms.topics_index", topics_index),
        ("ms.image_min_kb", image_min_kb.to_string()),
        ("ms.folder_indexes", if f.folder_indexes.is_some() { "1" } else { "0" }.to_string()),
    ];
    let new_key = f.api_key.trim().to_string();
    let mut key_change = "unchanged";
    if f.clear_key.is_some() {
        set.push(("ms.api_key", String::new()));
        key_change = "removed";
    } else if !new_key.is_empty() {
        if new_key.len() > 400 || new_key.chars().any(|c| c.is_whitespace() || c.is_control()) {
            return Err(AppError::BadRequest("That does not look like an API key.".into()));
        }
        set.push(("ms.api_key", new_key));
        key_change = "replaced";
    }
    for (k, v) in set {
        st.db.set_setting(k.to_string(), v).await?;
    }
    st.db
        .audit(
            user.audit_id(),
            Some(ip),
            "microsidian_settings",
            format!("model={}, effort={}, api key {key_change}", f.model, f.effort),
        )
        .await;
    Ok(Redirect::to("/admin?saved=microsidian#microsidian").into_response())
}

// ---------------------------------------------------------------- sources page

pub async fn sources_page(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> AppResult {
    let v = authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    Ok(render(&SourcesPage {
        page: PageCtx::for_user(&user),
        csrf: user.csrf.clone(),
        vault_id: v.id,
        vault_name: v.name,
        configured: s.api_key.is_some(),
        is_admin: user.is_admin,
        max_file_mb: st.cfg.max_file_bytes / 1024 / 1024,
    }))
}

// ---------------------------------------------------------------- JSON API

/// What the browser needs to convert and file a source. Never includes the API key.
pub async fn config(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> ApiResult {
    authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    ok(json!({
        "configured": s.api_key.is_some(),
        "model": s.model,
        "effort": s.effort,
        "guidance": s.guidance,
        "layout": {
            "ingest": s.ingest,
            "originals": s.originals,
            "attachments": s.attachments,
            "topics": s.topics,
            "topicsIndex": s.topics_index,
        },
        "imageMinKB": s.image_min_kb,
        "updateFolderIndexes": s.folder_indexes,
        "maxFileBytes": st.cfg.max_file_bytes,
    }))
}

/// Every file path in the vault and the text of every note, in one response. Filing a source reads most
/// notes (to list them for Claude and to link them), which would otherwise take one request per note.
pub async fn corpus(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let idx = index_for(&st, &v.id).await?;
    let body = tokio::task::spawn_blocking(move || -> Result<Value, ApiErr> {
        let mut notes = serde_json::Map::new();
        let mut total = 0usize;
        for rel in idx.notes() {
            let Some(disk) = idx.disk_path(rel) else { continue };
            let Ok(meta) = std::fs::metadata(&disk) else { continue };
            if meta.len() as usize > MAX_EDIT_BYTES {
                continue;
            }
            let Ok(bytes) = std::fs::read(&disk) else { continue };
            total += bytes.len();
            if total > CORPUS_MAX_BYTES {
                return Err(ApiErr::TooLarge("This vault has too much text to file sources from the site.".into()));
            }
            notes.insert(rel.clone(), Value::String(String::from_utf8_lossy(&bytes).into_owned()));
        }
        Ok(json!({ "files": idx.files, "notes": notes }))
    })
    .await??;
    ok(body)
}

#[derive(Deserialize)]
pub struct FileQuery {
    path: String,
}

/// Write a file at an exact path (a source being added, or an image taken from one). The body is the raw
/// file. Notes go through the note API instead, which checks for conflicting edits.
pub async fn put_file(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    user: CurrentUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    Query(q): Query<FileQuery>,
    body: Bytes,
) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    if body.is_empty() {
        return Err(ApiErr::Bad("Empty file.".into()));
    }
    if body.len() as u64 > st.cfg.max_file_bytes {
        return Err(ApiErr::TooLarge(format!("Files can be at most {} MB.", st.cfg.max_file_bytes / 1024 / 1024)));
    }
    let rel = safe_rel(&q.path).ok_or_else(bad_path)?;
    if is_note(&rel) || vault::mime_for(&rel).is_none() {
        return Err(ApiErr::Bad("That file type is not supported.".into()));
    }
    if is_office(&rel) && !body.starts_with(b"PK\x03\x04") {
        return Err(ApiErr::Bad("That is not a Word or PowerPoint file.".into()));
    }
    let root = root_of(&st, &v.id);
    let rel2 = rel.clone();
    tokio::task::spawn_blocking(move || vault::write_atomic(&root, &rel2, &body)).await?.map_err(|_| bad_path())?;
    changed(&st, &v.id, true).await;
    if is_office(&rel) {
        st.db.audit(user.audit_id(), Some(ip), "source_uploaded", format!("{}: {rel}", v.name)).await;
    }
    ok(json!({ "path": rel }))
}

/// An error in the shape the Anthropic API uses, so the SDK in the browser reports it like any other.
fn api_error(status: StatusCode, kind: &str, message: &str) -> Response {
    let body = json!({ "type": "error", "error": { "type": kind, "message": message } });
    (status, [(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
}

fn allow_call(st: &AppState, user_id: i64) -> bool {
    let mut calls = st.ingest_calls.lock().unwrap_or_else(|e| e.into_inner());
    let now = Instant::now();
    let hour = Duration::from_secs(3600);
    calls.retain(|_, times: &mut Vec<Instant>| {
        times.retain(|t| now.duration_since(*t) < hour);
        !times.is_empty()
    });
    let mine = calls.entry(user_id).or_default();
    if mine.len() >= CALLS_PER_HOUR {
        return false;
    }
    mine.push(now);
    true
}

/// Where the Anthropic API is. ANTHROPIC_BASE_URL overrides it (a gateway, or a mock server in tests).
fn api_base() -> String {
    std::env::var("ANTHROPIC_BASE_URL")
        .ok()
        .map(|u| u.trim().trim_end_matches('/').to_string())
        .filter(|u| u.starts_with("https://") || u.starts_with("http://127.0.0.1") || u.starts_with("http://localhost"))
        .unwrap_or_else(|| "https://api.anthropic.com".to_string())
}

/// Forward one Messages request to Anthropic with the admin's key, model and effort.
pub async fn claude(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    user: CurrentUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(mut body): Json<Value>,
) -> Result<Response, ApiErr> {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    let Some(key) = s.api_key.clone() else {
        return Ok(api_error(
            StatusCode::UNAUTHORIZED,
            "authentication_error",
            "No Anthropic API key is set. An admin can add one on the Admin page.",
        ));
    };
    let Some(obj) = body.as_object_mut().filter(|o| o.get("messages").is_some_and(Value::is_array)) else {
        return Ok(api_error(StatusCode::BAD_REQUEST, "invalid_request_error", "Not a Messages request."));
    };
    if !allow_call(&st, user.id) {
        return Ok(api_error(
            StatusCode::TOO_MANY_REQUESTS,
            "rate_limit_error",
            "Too many sources filed from this account in the last hour. Try again later.",
        ));
    }

    // The admin's settings win over whatever the browser sent.
    obj.insert("model".into(), json!(s.model));
    obj.insert("max_tokens".into(), json!(MAX_TOKENS));
    obj.remove("stream");
    let out = obj.entry("output_config").or_insert_with(|| json!({}));
    if let Some(o) = out.as_object_mut() {
        o.insert("effort".into(), json!(s.effort));
    }
    if s.model.contains("haiku") {
        obj.remove("fallbacks"); // Haiku has no server-side fallback
    }

    let mut req = st
        .http
        .post(format!("{}/v1/messages", api_base()))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body);
    let beta = headers.get("anthropic-beta").and_then(|v| v.to_str().ok()).unwrap_or("");
    if !beta.is_empty() && beta.len() < 300 && beta.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b',' || b == b' ') {
        req = req.header("anthropic-beta", beta).query(&[("beta", "true")]);
    }
    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!("anthropic request failed: {}", e.without_url());
            return Ok(api_error(StatusCode::BAD_GATEWAY, "api_error", "Could not reach the Anthropic API from the server."));
        }
    };
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let pass: Vec<(String, HeaderValue)> = ["request-id", "retry-after"]
        .iter()
        .filter_map(|h| {
            let v = res.headers().get(*h)?.as_bytes();
            Some((h.to_string(), HeaderValue::from_bytes(v).ok()?))
        })
        .collect();
    let bytes = res.bytes().await.map_err(|e| ApiErr::Internal(anyhow::anyhow!("anthropic reply: {}", e.without_url())))?;

    let usage: HashMap<String, u64> = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .and_then(|v| v.get("usage").cloned())
        .and_then(|u| u.as_object().cloned())
        .map(|u| u.into_iter().filter_map(|(k, v)| Some((k, v.as_u64()?))).collect())
        .unwrap_or_default();
    let detail = if status.is_success() {
        format!(
            "{}: {} ({} in, {} out)",
            v.name,
            s.model,
            usage.get("input_tokens").copied().unwrap_or(0) + usage.get("cache_read_input_tokens").copied().unwrap_or(0),
            usage.get("output_tokens").copied().unwrap_or(0)
        )
    } else {
        format!("{}: {} failed with status {}", v.name, s.model, status.as_u16())
    };
    st.db.audit(user.audit_id(), Some(ip), "claude_call", detail).await;

    let mut out = (status, [(header::CONTENT_TYPE, "application/json")], bytes).into_response();
    for (name, value) in pass {
        if let Ok(n) = axum::http::HeaderName::from_bytes(name.as_bytes()) {
            out.headers_mut().insert(n, value);
        }
    }
    Ok(out)
}
