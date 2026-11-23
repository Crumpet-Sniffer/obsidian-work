//! Sources added in the background.
//!
//! The browser only uploads the files of a batch (Word, PowerPoint, or zips of them) and then watches. Everything
//! else happens on the server, in the ingest worker: a Node.js process this server starts (see `worker.rs`) that
//! runs Microsidian's own code. It unpacks the zips, converts each file, reads the text in its pictures, has Claude
//! plan the batch and connect each file, and files them. The page can be closed at any time.
//!
//! The worker talks to this server over loopback only. It picks up a batch with its token, and is then given a
//! session of the account that uploaded the batch, so it reads and writes the vault through the normal API, with
//! exactly that account's rights, and every change is audited as usual.

use std::{net::SocketAddr, path::PathBuf};

use axum::{
    extract::{ConnectInfo, Multipart, Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};
use subtle::ConstantTimeEq;
use tokio::io::AsyncWriteExt;

use crate::{
    auth::{self, ClientIp, CurrentUser},
    db::{self, BatchRow},
    handlers::{
        edit::{check_csrf, ok, ApiErr, ApiResult},
        ingest::Settings,
        vaults::authorize,
    },
    AppState,
};

/// Most files one batch may have (a zip counts as one; the files inside it are not limited here).
const MAX_FILES: usize = 1000;
/// Batches listed on the Sources page.
const LIST: i64 = 8;

fn batch_dir(st: &AppState, id: &str) -> PathBuf {
    st.cfg.data_dir.join("ingest").join(id)
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// A file name as uploaded, made safe to store and show: the last path segment, no control characters.
fn clean_name(raw: &str) -> Option<String> {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("").trim();
    let name: String = base.chars().filter(|c| !c.is_control()).take(200).collect();
    let ok_ext = source_ext(&name).is_some();
    (ok_ext && !name.starts_with('.') && !name.starts_with("~$")).then_some(name)
}

/// Pictures that can be added as sources on their own (each becomes a note of its text and description).
pub const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp"];

/// The extension of a file that can be uploaded to a batch: Word, PowerPoint, PDF, a picture, or a zip of them.
fn source_ext(name: &str) -> Option<String> {
    let ext = name.rsplit_once('.')?.1.to_ascii_lowercase();
    (matches!(ext.as_str(), "docx" | "pptx" | "pdf" | "zip") || IMAGE_EXTS.contains(&ext.as_str())).then_some(ext)
}

/// Whether a file's first bytes fit its extension.
fn magic_ok(ext: &str, head: &[u8]) -> bool {
    match ext {
        "docx" | "pptx" | "zip" => head.starts_with(b"PK\x03\x04"),
        "pdf" => head.starts_with(b"%PDF-"),
        "png" => head.starts_with(b"\x89PNG"),
        "jpg" | "jpeg" => head.starts_with(&[0xFF, 0xD8, 0xFF]),
        "gif" => head.starts_with(b"GIF8"),
        "webp" => head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP",
        _ => false,
    }
}

fn batch_json(b: &BatchRow, me: &CurrentUser) -> Value {
    let files: Value = serde_json::from_str(&b.files).unwrap_or(json!([]));
    let names: Vec<Value> = files.as_array().map(|a| a.iter().filter_map(|f| f.get("name").cloned()).collect()).unwrap_or_default();
    json!({
        "id": b.id,
        "status": b.status,
        "cancelRequested": b.cancel_requested,
        "by": b.username,
        "mine": b.user_id == me.id,
        "createdAt": b.created_at,
        "updatedAt": b.updated_at,
        "files": names,
        "kind": b.kind,
        "meta": serde_json::from_str::<Value>(&b.meta).unwrap_or(json!({})),
        "progress": serde_json::from_str::<Value>(&b.progress).unwrap_or(json!({})),
    })
}

#[derive(Deserialize, Default)]
pub struct CreateBody {
    #[serde(default)]
    kind: String,
    /// For a past paper: what to call it in the question hub.
    #[serde(default)]
    title: String,
    /// For past papers: one zip of papers and mark schemes, sorted and named by Claude.
    #[serde(default)]
    zip: bool,
    /// For the question hub: a qualification's specification.
    #[serde(default)]
    spec: bool,
}

#[derive(Deserialize, Default)]
pub struct ListQuery {
    #[serde(default)]
    kind: String,
}

/// The kind of batch asked for: "paper", or "sources" for anything else.
fn kind_of(k: &str) -> &'static str {
    if k == "paper" { "paper" } else { "sources" }
}

async fn own_batch(st: &AppState, user: &CurrentUser, vault: &str, bid: &str) -> Result<BatchRow, ApiErr> {
    if !valid_id(bid) {
        return Err(ApiErr::NotFound);
    }
    let b = st.db.get_batch(bid.to_string()).await?.ok_or(ApiErr::NotFound)?;
    if b.vault_id != vault {
        return Err(ApiErr::NotFound);
    }
    if b.user_id != user.id && !user.is_admin {
        return Err(ApiErr::Forbidden("Only the person who added these files, or an admin, can change this.".into()));
    }
    Ok(b)
}

// ---------------------------------------------------------------- the Sources page

/// Start a batch. Files are then uploaded to it one by one, and `start` queues it for the worker.
pub async fn create(
    State(st): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    body: Option<Json<CreateBody>>,
) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let body = body.map(|Json(b)| b).unwrap_or_default();
    let kind = kind_of(&body.kind);
    let title: String = body.title.trim().chars().filter(|c| !c.is_control()).take(150).collect();
    if kind == "paper" && title.is_empty() && !body.zip && !body.spec {
        return Err(ApiErr::Bad("Give the paper a name, such as \"June 2024 Paper 1\".".into()));
    }
    if Settings::load(&st.db).await?.api_key.is_none() {
        return Err(ApiErr::Bad("No Anthropic API key is set. An admin can add one under Admin → Microsidian.".into()));
    }
    let bid = uuid::Uuid::new_v4().simple().to_string();
    tokio::fs::create_dir_all(batch_dir(&st, &bid)).await.map_err(|e| ApiErr::Internal(e.into()))?;
    st.db.create_batch(bid.clone(), v.id, user.id, user.username.clone(), kind, json!({ "title": title, "zip": body.zip, "spec": body.spec }).to_string()).await?;
    ok(json!({ "id": bid }))
}

/// Largest piece of a file one request may carry. The browser sends pieces of 64 MB, so a request stays under the
/// 100 MB a proxy in front of the site may accept (Cloudflare's free plan), like the chunked vault upload.
const MAX_CHUNK: u64 = 96 * 1024 * 1024;

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// One piece of one file of a batch: the multipart field `chunk`, with the file's name (`X-Upload-Name`,
/// percent-encoded), its total size (`X-Upload-Size`) and where this piece starts (`X-Upload-Offset`). Pieces are
/// appended to a part file as they arrive; a piece that does not start where the part file ends is refused with
/// 409 and the size received so far, so the browser can carry on from there. When the last piece is in, the file
/// is checked and added to the batch.
pub async fn upload(
    State(st): State<AppState>,
    user: CurrentUser,
    Path((id, bid)): Path<(String, String)>,
    headers: HeaderMap,
    mut mp: Multipart,
) -> ApiResult {
    check_csrf(&user, &headers)?;
    authorize(&st, &user, &id).await?;
    let b = own_batch(&st, &user, &id, &bid).await?;
    if b.status != "uploading" {
        return Err(ApiErr::Bad("This batch has already started.".into()));
    }
    let count = serde_json::from_str::<Vec<Value>>(&b.files).map(|f| f.len()).unwrap_or(0);
    if count >= MAX_FILES {
        return Err(ApiErr::Bad(format!("A batch can have at most {MAX_FILES} files. Put the rest in a zip, or add them as another batch.")));
    }
    let raw_name = header_str(&headers, "x-upload-name").unwrap_or("");
    let decoded = percent_encoding::percent_decode_str(raw_name).decode_utf8_lossy();
    let name = clean_name(&decoded).ok_or_else(|| ApiErr::Bad("Only Word, PowerPoint, PDF, picture (.png, .jpg, .gif, .webp) and .zip files can be added.".into()))?;
    let total: u64 = header_str(&headers, "x-upload-size").and_then(|v| v.parse().ok()).ok_or_else(|| ApiErr::Bad("Missing file size.".into()))?;
    let offset: u64 = header_str(&headers, "x-upload-offset").and_then(|v| v.parse().ok()).ok_or_else(|| ApiErr::Bad("Missing upload offset.".into()))?;
    let lower = name.to_ascii_lowercase();
    let is_zip = lower.ends_with(".zip");
    let limit = if is_zip { st.cfg.max_upload_bytes } else { st.cfg.max_file_bytes };
    if total == 0 {
        return Err(ApiErr::Bad(format!("{name} is empty.")));
    }
    if total > limit {
        return Err(ApiErr::TooLarge(format!("{name} is too large: files can be at most {} MB.", limit / 1024 / 1024)));
    }

    let dir = batch_dir(&st, &bid);
    let part = dir.join("upload.part");
    let have = if offset == 0 { 0 } else { tokio::fs::metadata(&part).await.map(|m| m.len()).unwrap_or(0) };
    if offset != have {
        // The last piece arrived but its answer was lost, and the browser is sending it again: the file is already
        // complete (it is the batch's latest file and no part file is left), so say so instead of starting over.
        let files = serde_json::from_str::<Vec<Value>>(&b.files).unwrap_or_default();
        let done = files.last().is_some_and(|f| f.get("name").and_then(Value::as_str) == Some(name.as_str()) && f.get("size").and_then(Value::as_u64) == Some(total));
        if done && have == 0 && offset > 0 {
            return ok(json!({ "received": total, "name": name, "size": total }));
        }
        return Err(ApiErr::Conflict(json!({ "error": "The upload is out of step.", "received": have })));
    }
    let mut out = if offset == 0 {
        tokio::fs::File::create(&part).await
    } else {
        tokio::fs::OpenOptions::new().append(true).open(&part).await
    }
    .map_err(|e| ApiErr::Internal(e.into()))?;

    let interrupted = || ApiErr::Bad("The upload was interrupted.".into());
    let mut got: u64 = 0;
    let mut found = false;
    while let Some(mut field) = mp.next_field().await.map_err(|_| interrupted())? {
        if field.name() != Some("chunk") {
            continue;
        }
        found = true;
        while let Some(piece) = field.chunk().await.map_err(|_| interrupted())? {
            got += piece.len() as u64;
            if got > MAX_CHUNK || offset + got > total {
                drop(out);
                let _ = tokio::fs::remove_file(&part).await;
                return Err(ApiErr::Bad("That piece of the upload is larger than expected.".into()));
            }
            out.write_all(&piece).await.map_err(|e| ApiErr::Internal(e.into()))?;
        }
    }
    out.flush().await.map_err(|e| ApiErr::Internal(e.into()))?;
    drop(out);
    if !found {
        return Err(ApiErr::Bad("No file was sent.".into()));
    }
    let received = offset + got;
    if received < total {
        return ok(json!({ "received": received }));
    }

    // The whole file is in: check its first bytes fit its type (Word, PowerPoint and zips are all zip
    // containers), then keep it.
    let ext = source_ext(&name).unwrap_or_default();
    let mut head = [0u8; 12];
    let fits = match tokio::fs::File::open(&part).await {
        Ok(mut f) => {
            let mut n = 0;
            while n < head.len() {
                match tokio::io::AsyncReadExt::read(&mut f, &mut head[n..]).await {
                    Ok(0) | Err(_) => break,
                    Ok(k) => n += k,
                }
            }
            magic_ok(&ext, &head[..n])
        }
        Err(_) => false,
    };
    if !fits {
        let _ = tokio::fs::remove_file(&part).await;
        return Err(ApiErr::Bad(format!("{name} is not the kind of file its name says.")));
    }
    let stored = format!("{count:04}.{ext}");
    tokio::fs::rename(&part, dir.join(&stored)).await.map_err(|e| ApiErr::Internal(e.into()))?;
    if !st.db.add_batch_file(bid.clone(), json!({ "name": name, "stored": stored, "size": total })).await? {
        let _ = tokio::fs::remove_file(dir.join(&stored)).await;
        return Err(ApiErr::Bad("This batch has already started.".into()));
    }
    ok(json!({ "received": received, "name": name, "size": total }))
}

/// All files are uploaded: queue the batch for the worker.
pub async fn start(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    user: CurrentUser,
    Path((id, bid)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let b = own_batch(&st, &user, &id, &bid).await?;
    let n = serde_json::from_str::<Vec<Value>>(&b.files).map(|f| f.len()).unwrap_or(0);
    if n == 0 {
        return Err(ApiErr::Bad("No files were uploaded.".into()));
    }
    if !st.db.set_batch_status(bid.clone(), &["uploading"], "queued").await? {
        return Err(ApiErr::Bad("This batch has already started.".into()));
    }
    st.db.audit(user.audit_id(), Some(ip), "sources_queued", format!("{}: {n} file(s), batch {bid}", v.name)).await;
    ok(json!({ "ok": true }))
}

/// Stop a batch: at once if it has not started; otherwise the worker stops after the file it is on.
pub async fn cancel(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    user: CurrentUser,
    Path((id, bid)): Path<(String, String)>,
    headers: HeaderMap,
) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    own_batch(&st, &user, &id, &bid).await?;
    if st.db.set_batch_status(bid.clone(), &["uploading", "queued"], "cancelled").await? {
        let _ = tokio::fs::remove_dir_all(batch_dir(&st, &bid)).await;
    } else {
        st.db.request_batch_cancel(bid.clone()).await?;
    }
    st.db.audit(user.audit_id(), Some(ip), "sources_cancelled", format!("{}: batch {bid}", v.name)).await;
    ok(json!({ "ok": true }))
}

/// The recent batches of a vault with their progress, and whether the worker is running.
pub async fn list(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, Query(q): Query<ListQuery>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let rows = st.db.list_batches(v.id, kind_of(&q.kind), LIST).await?;
    let seen = st.worker_seen.load(std::sync::atomic::Ordering::Relaxed);
    ok(json!({
        "batches": rows.iter().map(|b| batch_json(b, &user)).collect::<Vec<_>>(),
        "worker": { "running": seen > 0 && db::now() - seen < 30 },
    }))
}

// ---------------------------------------------------------------- the worker

/// Internal routes: loopback connections carrying this process's worker token only.
fn worker_auth(st: &AppState, peer: &SocketAddr, headers: &HeaderMap) -> Result<(), Response> {
    let token = headers.get("x-worker-token").and_then(|v| v.to_str().ok()).unwrap_or("");
    let ok = peer.ip().is_loopback() && bool::from(token.as_bytes().ct_eq(st.worker_token.as_bytes()));
    if !ok {
        return Err(StatusCode::NOT_FOUND.into_response());
    }
    st.worker_seen.store(db::now(), std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// The next queued batch, if any, with the files to read and a session for its owner.
pub async fn claim(State(st): State<AppState>, ConnectInfo(peer): ConnectInfo<SocketAddr>, headers: HeaderMap) -> Response {
    if let Err(r) = worker_auth(&st, &peer, &headers) {
        return r;
    }
    let token = auth::random_token(32);
    let hash = auth::sha256_hex(&token);
    let b = match st.db.claim_batch(hash.clone()).await {
        Ok(Some(b)) => b,
        Ok(None) => return StatusCode::NO_CONTENT.into_response(),
        Err(e) => {
            tracing::error!("claiming an ingest batch failed: {e:#}");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let fail = |msg: &str| json!({ "summary": msg, "files": [] }).to_string();
    let user = match st.db.get_user(b.user_id).await {
        Ok(Some(u)) if !u.disabled => u,
        _ => {
            let _ = st.db.finish_batch(b.id.clone(), "failed", Some(fail("The account that added these files no longer exists or is disabled."))).await;
            let _ = tokio::fs::remove_dir_all(batch_dir(&st, &b.id)).await;
            return StatusCode::NO_CONTENT.into_response();
        }
    };
    let csrf = auth::random_token(32);
    if let Err(e) = st.db.create_session(hash, user.id, csrf.clone(), "127.0.0.1".into(), "vault-share ingest worker".into()).await {
        tracing::error!("could not create the worker's session: {e:#}");
        let _ = st.db.set_batch_status(b.id.clone(), &["running"], "queued").await;
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let dir = batch_dir(&st, &b.id);
    let files: Vec<Value> = serde_json::from_str::<Vec<Value>>(&b.files)
        .unwrap_or_default()
        .into_iter()
        .map(|f| {
            let stored = f.get("stored").and_then(Value::as_str).unwrap_or("");
            json!({ "name": f.get("name").cloned().unwrap_or(json!("")), "path": dir.join(stored).to_string_lossy() })
        })
        .collect();
    Json(json!({
        "id": b.id,
        "vault": b.vault_id,
        "kind": b.kind,
        "meta": serde_json::from_str::<Value>(&b.meta).unwrap_or(json!({})),
        "files": files,
        "progress": serde_json::from_str::<Value>(&b.progress).unwrap_or(json!({})),
        "session": { "cookie": st.cfg.session_cookie(), "token": token, "csrf": csrf },
    }))
    .into_response()
}

#[derive(Deserialize)]
pub struct Report {
    progress: Value,
    #[serde(default)]
    status: Option<String>,
}

/// A progress report from the worker. With `status`, the batch is over (done, failed or cancelled).
pub async fn report(
    State(st): State<AppState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(bid): Path<String>,
    headers: HeaderMap,
    Json(r): Json<Report>,
) -> Response {
    if let Err(resp) = worker_auth(&st, &peer, &headers) {
        return resp;
    }
    if !valid_id(&bid) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let progress = r.progress.to_string();
    let result = match r.status.as_deref() {
        None => st.db.set_batch_progress(bid.clone(), progress).await.map(|cancel| json!({ "cancel": cancel })),
        Some(s) => {
            let status: &'static str = match s {
                "done" => "done",
                "cancelled" => "cancelled",
                _ => "failed",
            };
            match st.db.finish_batch(bid.clone(), status, Some(progress)).await {
                Ok(session) => {
                    if let Some(h) = session {
                        let _ = st.db.delete_session(h).await;
                    }
                    let _ = tokio::fs::remove_dir_all(batch_dir(&st, &bid)).await;
                    if let Ok(Some(b)) = st.db.get_batch(bid.clone()).await {
                        let summary = r.progress.get("summary").and_then(Value::as_str).unwrap_or("").to_string();
                        st.db.audit(Some((b.user_id, b.username)), Some("127.0.0.1".into()), "sources_finished", format!("batch {bid} {status}: {summary}")).await;
                    }
                    Ok(json!({ "cancel": false }))
                }
                Err(e) => Err(e),
            }
        }
    };
    match result {
        Ok(v) => Json(v).into_response(),
        Err(e) => {
            tracing::error!("storing ingest progress failed: {e:#}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

/// At start-up: batches that were running when the server stopped go back to the queue, and the worker's old
/// sessions are deleted. The worker resumes them, skipping files it had already filed.
pub async fn recover(st: &AppState) {
    match st.db.requeue_running_batches().await {
        Ok(sessions) => {
            for h in sessions {
                let _ = st.db.delete_session(h).await;
            }
        }
        Err(e) => tracing::error!("could not requeue interrupted ingest batches: {e:#}"),
    }
}

/// Housekeeping: forget batches finished more than 30 days ago (and uploads abandoned for a day) and their files.
pub async fn prune(st: &AppState) {
    if let Ok(ids) = st.db.prune_batches(30 * 86_400).await {
        for id in ids {
            let _ = tokio::fs::remove_dir_all(batch_dir(st, &id)).await;
        }
    }
}
