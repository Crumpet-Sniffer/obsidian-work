//! JSON API for changing a vault: save/create/rename/delete notes and folders, upload attachments.
//!
//! Anyone who can read a vault can edit it. Every request needs the session's CSRF token in the
//! `X-CSRF-Token` header (plus the global same-origin check). Deletes move files to a hidden `.trash`
//! folder inside the vault, so nothing is lost by a mistaken click.

use std::path::PathBuf;

use axum::{
    body::Bytes,
    extract::{Path, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::{
    auth::{ClientIp, CurrentUser},
    errors::AppError,
    handlers::vaults::{authorize, index_for},
    markdown,
    vault::{self, is_note, safe_rel, VaultIndex, MAX_EDIT_BYTES},
    AppState,
};

pub enum ApiErr {
    Bad(String),
    Forbidden(String),
    NotFound,
    Conflict(serde_json::Value),
    TooLarge(String),
    Internal(anyhow::Error),
}

impl From<AppError> for ApiErr {
    fn from(e: AppError) -> Self {
        match e {
            AppError::NotFound => ApiErr::NotFound,
            AppError::Forbidden(m) => ApiErr::Forbidden(m),
            AppError::BadRequest(m) => ApiErr::Bad(m),
            AppError::Internal(e) => ApiErr::Internal(e),
        }
    }
}

impl<E: Into<anyhow::Error>> From<E> for ApiErr {
    fn from(e: E) -> Self {
        ApiErr::Internal(e.into())
    }
}

impl IntoResponse for ApiErr {
    fn into_response(self) -> Response {
        let (status, body) = match self {
            ApiErr::Bad(m) => (StatusCode::BAD_REQUEST, json!({ "error": m })),
            ApiErr::Forbidden(m) => (StatusCode::FORBIDDEN, json!({ "error": m })),
            ApiErr::NotFound => (StatusCode::NOT_FOUND, json!({ "error": "Not found." })),
            ApiErr::Conflict(v) => (StatusCode::CONFLICT, v),
            ApiErr::TooLarge(m) => (StatusCode::PAYLOAD_TOO_LARGE, json!({ "error": m })),
            ApiErr::Internal(e) => {
                tracing::error!("api error: {e:#}");
                (StatusCode::INTERNAL_SERVER_ERROR, json!({ "error": "Something went wrong on our side." }))
            }
        };
        (status, [(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
    }
}

type ApiResult = Result<Response, ApiErr>;

fn ok(body: serde_json::Value) -> ApiResult {
    Ok((StatusCode::OK, [(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response())
}

fn check_csrf(user: &CurrentUser, headers: &HeaderMap) -> Result<(), ApiErr> {
    let token = headers.get("x-csrf-token").and_then(|v| v.to_str().ok()).unwrap_or("");
    Ok(user.check_csrf(token)?)
}

fn etag(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().take(8).map(|b| format!("{b:02x}")).collect()
}

fn bad_path() -> ApiErr {
    ApiErr::Bad("That name is not allowed. Avoid \\ : * ? \" < > | and names starting with a dot.".into())
}

/// Drop the cached index and refresh the vault card's file count and size.
async fn changed(st: &AppState, vault_id: &str, structure: bool) {
    st.indexes.write().unwrap_or_else(|e| e.into_inner()).remove(vault_id);
    if structure {
        let root = st.cfg.vaults_dir().join(vault_id);
        if let Ok((files, bytes)) = tokio::task::spawn_blocking(move || vault::dir_stats(&root)).await {
            let _ = st.db.update_vault_stats(vault_id.to_string(), files, bytes).await;
        }
    }
}

fn root_of(st: &AppState, vault_id: &str) -> PathBuf {
    st.cfg.vaults_dir().join(vault_id)
}

#[derive(Deserialize)]
pub struct PathQuery {
    path: String,
}

/// Raw Markdown of a note plus an etag for conflict detection.
pub async fn note_get(
    State(st): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(q): Query<PathQuery>,
) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let rel = safe_rel(&q.path).filter(|p| is_note(p)).ok_or_else(bad_path)?;
    let disk = vault::note_disk_path(&root_of(&st, &v.id), &rel).ok_or(ApiErr::NotFound)?;
    let meta = tokio::fs::metadata(&disk).await.map_err(|_| ApiErr::NotFound)?;
    if meta.len() as usize > MAX_EDIT_BYTES {
        return Err(ApiErr::TooLarge("This note is too large to edit here.".into()));
    }
    let bytes = tokio::fs::read(&disk).await?;
    let content = String::from_utf8_lossy(&bytes).into_owned();
    ok(json!({ "path": rel, "content": content, "etag": etag(content.as_bytes()) }))
}

#[derive(Deserialize)]
pub struct SaveBody {
    path: String,
    content: String,
    /// The etag the editor loaded. Required when overwriting; absent when creating.
    etag: Option<String>,
}

/// Save a note. Fails with 409 if it changed on the server since the editor loaded it.
pub async fn note_put(
    State(st): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(b): Json<SaveBody>,
) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let rel = safe_rel(&b.path).filter(|p| is_note(p)).ok_or_else(bad_path)?;
    if b.content.len() > MAX_EDIT_BYTES {
        return Err(ApiErr::TooLarge("This note is too large to save.".into()));
    }
    let root = root_of(&st, &v.id);
    let content = b.content;
    let expect = b.etag;
    let rel2 = rel.clone();
    let (new_etag, created) = tokio::task::spawn_blocking(move || -> Result<(String, bool), ApiErr> {
        let existing = std::fs::read(vault::note_disk_path(&root, &rel2).unwrap_or_else(|| root.join(&rel2))).ok();
        let created = existing.is_none();
        if let Some(cur) = &existing {
            if expect.as_deref() != Some(etag(cur).as_str()) {
                return Err(ApiErr::Conflict(json!({ "error": "This note changed since you opened it.", "etag": etag(cur) })));
            }
        }
        vault::write_atomic(&root, &rel2, content.as_bytes()).map_err(|_| bad_path())?;
        Ok((etag(content.as_bytes()), created))
    })
    .await??;
    changed(&st, &v.id, created).await;
    ok(json!({ "etag": new_etag, "created": created }))
}

#[derive(Deserialize)]
pub struct CreateBody {
    path: String,
    /// "note" or "folder"
    kind: String,
    #[serde(default)]
    content: String,
}

pub async fn create(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    user: CurrentUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(b): Json<CreateBody>,
) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let root = root_of(&st, &v.id);
    let is_folder = match b.kind.as_str() {
        "folder" => true,
        "note" => false,
        _ => return Err(ApiErr::Bad("Unknown kind.".into())),
    };
    let mut rel = safe_rel(&b.path).ok_or_else(bad_path)?;
    if !is_folder && !is_note(&rel) {
        rel.push_str(".md");
        rel = safe_rel(&rel).ok_or_else(bad_path)?;
    }
    if b.content.len() > MAX_EDIT_BYTES {
        return Err(ApiErr::TooLarge("That content is too large.".into()));
    }
    let (rel2, content) = (rel.clone(), b.content);
    tokio::task::spawn_blocking(move || -> Result<(), ApiErr> {
        if vault::path_exists(&root, &rel2) {
            return Err(ApiErr::Conflict(json!({ "error": "Something with that name already exists." })));
        }
        if is_folder {
            vault::create_dir(&root, &rel2).map_err(|_| bad_path())
        } else {
            vault::write_atomic(&root, &rel2, content.as_bytes()).map_err(|_| bad_path())
        }
    })
    .await??;
    changed(&st, &v.id, true).await;
    st.db.audit(user.audit_id(), Some(ip), if is_folder { "folder_created" } else { "note_created" }, format!("{}: {rel}", v.name)).await;
    let url = if is_folder { String::new() } else { vault::note_url(&v.id, &rel) };
    ok(json!({ "path": rel, "url": url }))
}

#[derive(Deserialize)]
pub struct RenameBody {
    from: String,
    to: String,
    #[serde(default)]
    update_links: bool,
}

pub async fn rename(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    user: CurrentUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(b): Json<RenameBody>,
) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let root = root_of(&st, &v.id);
    let from = safe_rel(&b.from).ok_or_else(bad_path)?;
    let mut to = safe_rel(&b.to).ok_or_else(bad_path)?;
    let idx = index_for(&st, &v.id).await?;
    let was_dir = idx.dirs.iter().any(|d| d == &from);
    let was_note = !was_dir && is_note(&from);
    if !was_dir && !idx.contains(&from) {
        return Err(ApiErr::NotFound);
    }
    if was_note && !is_note(&to) {
        to.push_str(".md");
        to = safe_rel(&to).ok_or_else(bad_path)?;
    }
    let (from2, to2, update) = (from.clone(), to.clone(), b.update_links);
    let updated = tokio::task::spawn_blocking(move || -> Result<usize, ApiErr> {
        // Work out which notes need their links rewritten while the old layout is still on disk.
        let mut rewrites: Vec<(String, String)> = Vec::new();
        if update {
            rewrites = link_rewrites(&idx, &from2, &to2);
        }
        vault::rename_path(&root, &from2, &to2).map_err(|e| match e.kind() {
            std::io::ErrorKind::AlreadyExists => ApiErr::Conflict(json!({ "error": "Something with that name already exists." })),
            std::io::ErrorKind::InvalidInput => ApiErr::Bad(e.to_string()),
            _ => bad_path(),
        })?;
        let mut n = 0;
        for (old_rel, text) in rewrites {
            let now_rel = moved_path(&old_rel, &from2, &to2);
            if vault::write_atomic(&root, &now_rel, text.as_bytes()).is_ok() {
                n += 1;
            }
        }
        Ok(n)
    })
    .await??;
    changed(&st, &v.id, true).await;
    st.db.audit(user.audit_id(), Some(ip), "file_renamed", format!("{}: {from} -> {to}", v.name)).await;
    let url = if was_dir { String::new() } else if was_note { vault::note_url(&v.id, &to) } else { vault::link_url(&v.id, &to) };
    ok(json!({ "path": to, "url": url, "links_updated": updated }))
}

/// Where `path` ends up after `from` is renamed to `to` (file or folder).
fn moved_path(path: &str, from: &str, to: &str) -> String {
    if path == from {
        to.to_string()
    } else if let Some(rest) = path.strip_prefix(&format!("{from}/")) {
        format!("{to}/{rest}")
    } else {
        path.to_string()
    }
}

/// `(note path before the rename, new text)` for every note whose wiki links point at what is being renamed.
fn link_rewrites(idx: &VaultIndex, from: &str, to: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for note in idx.notes() {
        let Some(disk) = idx.disk_path(note) else { continue };
        let Ok(meta) = std::fs::metadata(&disk) else { continue };
        if meta.len() as usize > MAX_EDIT_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&disk) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        let changed = markdown::rewrite_wikilinks(&text, &|target: &str| {
            let name = target.trim();
            let resolved = idx.resolve(name)?;
            let hit = resolved == from || resolved.starts_with(&format!("{from}/"));
            if !hit {
                return None;
            }
            let new_full = moved_path(resolved, from, to);
            let had_ext = name.to_ascii_lowercase().ends_with(".md");
            let strip = |p: &str| -> String {
                if had_ext || !is_note(p) { p.to_string() } else { p.strip_suffix(".md").unwrap_or(p).to_string() }
            };
            if name.contains('/') {
                Some(strip(&new_full))
            } else {
                Some(strip(new_full.rsplit('/').next().unwrap_or(&new_full)))
            }
        });
        if let Some(new_text) = changed {
            out.push((note.clone(), new_text));
        }
    }
    out
}

#[derive(Deserialize)]
pub struct DeleteBody {
    path: String,
}

pub async fn delete(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    user: CurrentUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    Json(b): Json<DeleteBody>,
) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let rel = safe_rel(&b.path).ok_or_else(bad_path)?;
    let root = root_of(&st, &v.id);
    let rel2 = rel.clone();
    tokio::task::spawn_blocking(move || -> Result<(), ApiErr> {
        if !vault::path_exists(&root, &rel2) {
            return Err(ApiErr::NotFound);
        }
        vault::move_to_trash(&root, &rel2).map_err(|_| bad_path())
    })
    .await??;
    changed(&st, &v.id, true).await;
    st.db.audit(user.audit_id(), Some(ip), "file_deleted", format!("{}: {rel}", v.name)).await;
    ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
pub struct AttachQuery {
    name: String,
    /// Folder to store it in; defaults to `_Attachments` when the vault has one, else the vault root.
    dir: Option<String>,
}

/// Upload an attachment (image, PDF, ...). The body is the raw file.
pub async fn attach(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    user: CurrentUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    Query(q): Query<AttachQuery>,
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
    let name = q.name.rsplit(['/', '\\']).next().unwrap_or("").trim().to_string();
    if safe_rel(&name).is_none() || is_note(&name) || vault::mime_for(&name).is_none() {
        return Err(ApiErr::Bad("That file type is not supported.".into()));
    }
    let idx = index_for(&st, &v.id).await?;
    let dir = match q.dir.as_deref().filter(|d| !d.is_empty()) {
        Some(d) => safe_rel(d).ok_or_else(bad_path)?,
        None if idx.dirs.iter().any(|d| d == "_Attachments") => "_Attachments".to_string(),
        None => String::new(),
    };
    let root = root_of(&st, &v.id);
    let rel = tokio::task::spawn_blocking(move || -> Result<String, ApiErr> {
        let (stem, ext) = name.rsplit_once('.').map(|(s, e)| (s.to_string(), format!(".{e}"))).unwrap_or((name.clone(), String::new()));
        let pick = |n: u32| {
            let file = if n == 0 { name.clone() } else { format!("{stem}-{n}{ext}") };
            if dir.is_empty() { file } else { format!("{dir}/{file}") }
        };
        let mut n = 0;
        while vault::path_exists(&root, &pick(n)) {
            n += 1;
            if n > 999 {
                return Err(ApiErr::Conflict(json!({ "error": "Too many files with that name." })));
            }
        }
        let rel = pick(n);
        vault::write_atomic(&root, &rel, &body).map_err(|_| bad_path())?;
        Ok(rel)
    })
    .await??;
    changed(&st, &v.id, true).await;
    st.db.audit(user.audit_id(), Some(ip), "file_uploaded", format!("{}: {rel}", v.name)).await;
    ok(json!({ "path": rel, "name": rel.rsplit('/').next().unwrap_or(&rel), "url": vault::file_url(&v.id, &rel) }))
}

/// Every file in the vault (paths), for link completion in the editor.
pub async fn files_list(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let idx = index_for(&st, &v.id).await?;
    ok(json!({ "files": idx.files }))
}

#[derive(Deserialize)]
pub struct SearchQ {
    #[serde(default)]
    q: String,
}

/// Search results with context snippets, for the sidebar search panel.
pub async fn search_json(
    State(st): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(SearchQ { q }): Query<SearchQ>,
) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let idx = index_for(&st, &v.id).await?;
    let q: String = q.trim().chars().take(200).collect();
    let vid = v.id.clone();
    let (hits, truncated) = tokio::task::spawn_blocking(move || crate::search::search(&idx, &q, 100)).await?;
    let results: Vec<_> = hits
        .into_iter()
        .map(|h| {
            json!({
                "title": h.title,
                "path": h.path,
                "folder": h.folder,
                "url": vault::note_url(&vid, &h.path),
                "matches": h.matches,
                "snippets": h.snippets.iter().map(|s| json!({ "before": s.before, "match": s.matched, "after": s.after })).collect::<Vec<_>>(),
            })
        })
        .collect();
    ok(json!({ "results": results, "truncated": truncated }))
}

/// Every tag in the vault with the number of notes using it.
pub async fn tags_json(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let idx = index_for(&st, &v.id).await?;
    let links = tokio::task::spawn_blocking(move || idx.links()).await?;
    let mut tags: Vec<_> = links.tags.iter().map(|(t, notes)| json!({ "tag": t, "count": notes.len() })).collect();
    tags.sort_by(|a, b| b["count"].as_u64().cmp(&a["count"].as_u64()).then_with(|| a["tag"].as_str().cmp(&b["tag"].as_str())));
    ok(json!({ "tags": tags }))
}
