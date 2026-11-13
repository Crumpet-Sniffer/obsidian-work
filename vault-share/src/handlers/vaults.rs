use std::sync::Arc;

use axum::{
    body::Body,
    extract::{Path, Query, Request, State},
    http::{header, HeaderValue},
    response::{IntoResponse, Redirect},
};
use percent_encoding::{utf8_percent_encode, NON_ALPHANUMERIC};
use serde::Deserialize;
use tower::ServiceExt;
use tower_http::services::ServeFile;

use crate::{
    auth::CurrentUser,
    db::VaultRow,
    errors::{AppError, AppResult},
    markdown::{self, RenderCtx},
    security::FILE_CSP,
    templates::{fmt_ts, render, GraphPage, HomePage, NotePage, PageCtx, SearchHit, SearchPage, VaultCard},
    vault::{self, is_valid_id, Kind, VaultIndex},
    AppState,
};

const MAX_NOTE_BYTES: u64 = 5 * 1024 * 1024;

/// Load a vault the user may read. Returns 404 (not 403) so vault ids cannot be probed.
pub async fn authorize(st: &AppState, user: &CurrentUser, id: &str) -> AppResult<VaultRow> {
    if !is_valid_id(id) {
        return Err(AppError::NotFound);
    }
    let v = st.db.get_vault(id.to_string()).await?.ok_or(AppError::NotFound)?;
    if user.is_admin || v.shared_with_all || st.db.user_has_access(v.id.clone(), user.id).await? {
        Ok(v)
    } else {
        Err(AppError::NotFound)
    }
}

pub async fn index_for(st: &AppState, id: &str) -> AppResult<Arc<VaultIndex>> {
    if let Some(idx) = st.indexes.read().unwrap_or_else(|e| e.into_inner()).get(id) {
        return Ok(idx.clone());
    }
    let root = st.cfg.vaults_dir().join(id);
    let idx = Arc::new(tokio::task::spawn_blocking(move || VaultIndex::build(&root)).await??);
    st.indexes.write().unwrap_or_else(|e| e.into_inner()).insert(id.to_string(), idx.clone());
    Ok(idx)
}

pub async fn home(State(st): State<AppState>, user: CurrentUser) -> AppResult {
    let vaults = if user.is_admin { st.db.list_vaults().await? } else { st.db.list_vaults_for_user(user.id).await? };
    Ok(render(&HomePage {
        page: PageCtx::for_user(&user),
        vaults: vaults
            .into_iter()
            .map(|v| VaultCard {
                id: v.id,
                name: v.name,
                description: v.description,
                files: v.file_count,
                updated: fmt_ts(v.updated_at),
            })
            .collect(),
    }))
}

pub async fn vault_home(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> AppResult {
    let v = authorize(&st, &user, &id).await?;
    let idx = index_for(&st, &v.id).await?;
    match idx.home_note() {
        Some(note) => Ok(Redirect::to(&vault::note_url(&v.id, note)).into_response()),
        None => Ok(render(&NotePage {
            page: PageCtx::for_user(&user),
            vault_id: v.id.clone(),
            vault_name: v.name,
            title: "Empty vault".into(),
            folder: String::new(),
            tree_html: idx.tree_html(&v.id, None),
            content_html: "<p>This vault has no notes yet.</p>".into(),
            raw_url: String::new(),
            graph_url: String::new(),
        })),
    }
}

pub async fn note(State(st): State<AppState>, user: CurrentUser, Path((id, path)): Path<(String, String)>) -> AppResult {
    let v = authorize(&st, &user, &id).await?;
    let idx = index_for(&st, &v.id).await?;
    let disk = idx.disk_path(&path).ok_or(AppError::NotFound)?;
    if !vault::is_note(&path) {
        return Ok(Redirect::to(&vault::file_url(&v.id, &path)).into_response());
    }
    let meta = tokio::fs::metadata(&disk).await.map_err(|_| AppError::NotFound)?;
    let content_html = if meta.len() > MAX_NOTE_BYTES {
        "<p>This note is too large to display. Use “Download .md” instead.</p>".to_string()
    } else {
        let bytes = tokio::fs::read(&disk).await?;
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let (vid, idx2) = (v.id.clone(), idx.clone());
        tokio::task::spawn_blocking(move || markdown::render(&text, &RenderCtx { vault_id: &vid, index: &idx2 })).await?
    };
    let (folder, file) = path.rsplit_once('/').unwrap_or(("", path.as_str()));
    Ok(render(&NotePage {
        page: PageCtx::for_user(&user),
        vault_id: v.id.clone(),
        vault_name: v.name.clone(),
        title: file.strip_suffix(".md").unwrap_or(file).to_string(),
        folder: folder.replace('/', " / "),
        tree_html: idx.tree_html(&v.id, Some(&path)),
        content_html,
        raw_url: vault::file_url(&v.id, &path),
        graph_url: format!("/v/{}/graph?focus={}", v.id, utf8_percent_encode(&path, NON_ALPHANUMERIC)),
    }))
}

pub async fn file(
    State(st): State<AppState>,
    user: CurrentUser,
    Path((id, path)): Path<(String, String)>,
    req: Request,
) -> AppResult {
    let v = authorize(&st, &user, &id).await?;
    let idx = index_for(&st, &v.id).await?;
    let disk = idx.disk_path(&path).ok_or(AppError::NotFound)?;
    let (mime, kind) = vault::mime_for(&path).ok_or(AppError::NotFound)?;

    let res = ServeFile::new(disk).oneshot(req).await.map_err(|e| AppError::Internal(e.into()))?;
    let mut res = res.map(Body::new);
    let h = res.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(mime));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("private, max-age=600"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    // Browsers refuse to render PDFs in a sandboxed CSP, and PDFs cannot run page script anyway.
    if !matches!(kind, Kind::Pdf) {
        h.insert(header::CONTENT_SECURITY_POLICY, HeaderValue::from_static(FILE_CSP));
    }
    let name = path.rsplit('/').next().unwrap_or("file");
    let inline = matches!(kind, Kind::Image | Kind::Audio | Kind::Video | Kind::Pdf);
    let disposition = format!(
        "{}; filename*=UTF-8''{}",
        if inline { "inline" } else { "attachment" },
        utf8_percent_encode(name, NON_ALPHANUMERIC)
    );
    if let Ok(v) = HeaderValue::from_str(&disposition) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    Ok(res)
}

#[derive(Deserialize)]
pub struct GraphQuery {
    #[serde(default)]
    focus: String,
}

pub async fn graph_page(
    State(st): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(GraphQuery { focus }): Query<GraphQuery>,
) -> AppResult {
    let v = authorize(&st, &user, &id).await?;
    let idx = index_for(&st, &v.id).await?;
    let focus = if idx.contains(&focus) { focus } else { String::new() };
    Ok(render(&GraphPage {
        page: PageCtx::for_user(&user),
        vault_id: v.id.clone(),
        vault_name: v.name,
        tree_html: idx.tree_html(&v.id, (!focus.is_empty()).then_some(focus.as_str())),
        focus,
    }))
}

pub async fn graph_json(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> AppResult {
    let v = authorize(&st, &user, &id).await?;
    let idx = index_for(&st, &v.id).await?;
    let json = tokio::task::spawn_blocking(move || idx.graph_json(&v.id)).await?;
    Ok(([(header::CONTENT_TYPE, "application/json")], json.as_str().to_owned()).into_response())
}

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    q: String,
}

pub async fn search(
    State(st): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    Query(SearchQuery { q }): Query<SearchQuery>,
) -> AppResult {
    let v = authorize(&st, &user, &id).await?;
    let idx = index_for(&st, &v.id).await?;
    let q: String = q.trim().chars().take(100).collect();
    let (results, truncated) = if q.chars().count() >= 2 {
        let (idx2, q2, vid) = (idx.clone(), q.clone(), v.id.clone());
        tokio::task::spawn_blocking(move || run_search(&idx2, &vid, &q2)).await?
    } else {
        (Vec::new(), false)
    };
    Ok(render(&SearchPage {
        page: PageCtx::for_user(&user),
        vault_id: v.id.clone(),
        vault_name: v.name,
        tree_html: idx.tree_html(&v.id, None),
        q,
        results,
        truncated,
    }))
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_boundary(s: &str, mut i: usize) -> usize {
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i.min(s.len())
}

fn run_search(idx: &VaultIndex, vault_id: &str, q: &str) -> (Vec<SearchHit>, bool) {
    const LIMIT: usize = 50;
    let needle = q.to_lowercase();
    let mut hits = Vec::new();
    for rel in idx.notes() {
        if hits.len() >= LIMIT {
            return (hits, true);
        }
        let Some(disk) = idx.disk_path(rel) else { continue };
        let Ok(meta) = std::fs::metadata(&disk) else { continue };
        if meta.len() > MAX_NOTE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&disk) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        let body = markdown::strip_frontmatter(&text);
        let lower = body.to_lowercase();
        let (folder, file) = rel.rsplit_once('/').unwrap_or(("", rel.as_str()));
        let title = file.strip_suffix(".md").unwrap_or(file).to_string();
        let title_hit = title.to_lowercase().contains(&needle);
        let pos = lower.find(&needle);
        if pos.is_none() && !title_hit {
            continue;
        }
        // Use the original text when lowercasing kept byte offsets aligned.
        let src: &str = if lower.len() == body.len() { body } else { &lower };
        let (before, matched, after) = match pos {
            Some(p) if src.is_char_boundary(p) && src.is_char_boundary(p + needle.len()) => {
                let s = floor_boundary(src, p.saturating_sub(80));
                let e = ceil_boundary(src, p + needle.len() + 120);
                (
                    format!("{}{}", if s > 0 { "…" } else { "" }, &src[s..p]),
                    src[p..p + needle.len()].to_string(),
                    format!("{}{}", &src[p + needle.len()..e], if e < src.len() { "…" } else { "" }),
                )
            }
            _ => {
                let e = ceil_boundary(src, 160);
                (src[..e].to_string(), String::new(), String::new())
            }
        };
        hits.push(SearchHit {
            url: vault::note_url(vault_id, rel),
            title,
            folder: folder.replace('/', " / "),
            before,
            matched,
            after,
        });
    }
    (hits, false)
}
