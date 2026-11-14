use std::{collections::HashMap, path::PathBuf};

use axum::{
    extract::{Multipart, Path, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    Form,
};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use crate::{
    auth::{self, AdminUser, ClientIp, CurrentUser},
    db::VaultRow,
    errors::{AppError, AppResult},
    handlers::{auth::CsrfForm, ingest},
    templates::{
        fmt_bytes, fmt_ts, render, AdminPage, AuditView, BackupView, MessagePage, MsView, Opt, PageCtx, UserView,
        VaultAdminPage, VaultAdminView, VaultNewPage,
    },
    vault::{self, is_valid_id, ImportError, Limits},
    AppState,
};

fn vault_view(v: VaultRow) -> VaultAdminView {
    VaultAdminView {
        id: v.id,
        name: v.name,
        description: v.description,
        files: v.file_count,
        size: fmt_bytes(v.total_bytes),
        updated: fmt_ts(v.updated_at),
    }
}

fn message(user: &CurrentUser, title: &str, msg: String, secret: Option<String>) -> Response {
    render(&MessagePage {
        page: PageCtx::for_user(user),
        title: title.into(),
        message: msg,
        secret,
        back_href: "/admin".into(),
        back_label: "Back to admin".into(),
    })
}

#[derive(Deserialize)]
pub struct DashboardQuery {
    saved: Option<String>,
}

pub async fn dashboard(
    State(st): State<AppState>,
    AdminUser(user): AdminUser,
    axum::extract::Query(q): axum::extract::Query<DashboardQuery>,
) -> AppResult {
    let users = st
        .db
        .list_users()
        .await?
        .into_iter()
        .map(|u| UserView {
            is_me: u.id == user.id,
            id: u.id,
            username: u.username,
            is_admin: u.role == "admin",
            disabled: u.disabled,
            must_change: u.must_change_password,
            created: fmt_ts(u.created_at),
            last_login: u.last_login_at.map(fmt_ts).unwrap_or_else(|| "never".into()),
        })
        .collect();
    let vaults = st.db.list_vaults().await?.into_iter().map(vault_view).collect();
    let audit = st
        .db
        .recent_audit(100)
        .await?
        .into_iter()
        .map(|a| AuditView {
            ts: fmt_ts(a.ts),
            username: a.username.unwrap_or_default(),
            ip: a.ip.unwrap_or_default(),
            action: a.action,
            detail: a.detail,
        })
        .collect();
    let s = ingest::Settings::load(&st.db).await?;
    let ms = MsView {
        key_set: s.api_key.is_some(),
        key_from_env: s.api_key.is_some() && !s.key_saved,
        key_hint: s.key_hint(),
        models: ingest::MODELS
            .iter()
            .map(|(id, label)| Opt { value: id.to_string(), label: label.to_string(), selected: *id == s.model })
            .collect(),
        efforts: ingest::EFFORTS
            .iter()
            .map(|e| Opt { value: e.to_string(), label: e.to_string(), selected: *e == s.effort })
            .collect(),
        guidance: s.guidance,
        ingest: s.ingest,
        originals: s.originals,
        attachments: s.attachments,
        topics: s.topics,
        topics_index: s.topics_index,
        image_min_kb: s.image_min_kb,
        folder_indexes: s.folder_indexes,
        saved: q.saved.as_deref() == Some("microsidian"),
    };
    Ok(render(&AdminPage { page: PageCtx::for_user(&user), csrf: user.csrf.clone(), users, vaults, audit, ms }))
}

// ---------------------------------------------------------------- users

#[derive(Deserialize)]
pub struct NewUserForm {
    csrf: String,
    username: String,
    #[serde(default)]
    role: String,
}

pub async fn create_user(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    AdminUser(user): AdminUser,
    Form(f): Form<NewUserForm>,
) -> AppResult {
    user.check_csrf(&f.csrf)?;
    let username = f.username.trim().to_string();
    auth::validate_username(&username).map_err(AppError::BadRequest)?;
    let role = if f.role == "admin" { "admin" } else { "member" };
    let temp = auth::generate_temp_password();
    let hash = auth::hash_password_async(temp.clone()).await?;
    if st.db.create_user(username.clone(), hash, role, true).await?.is_none() {
        return Err(AppError::BadRequest("That username is already taken.".into()));
    }
    st.db.audit(user.audit_id(), Some(ip), "user_created", format!("{username} ({role})")).await;
    Ok(message(
        &user,
        "Account created",
        format!("Give {username} this one-time password over a private channel. They will have to choose their own password when they first sign in. It will not be shown again."),
        Some(temp),
    ))
}

#[derive(Deserialize)]
pub struct UserActionForm {
    csrf: String,
    action: String,
}

pub async fn user_action(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    AdminUser(user): AdminUser,
    Path(target_id): Path<i64>,
    Form(f): Form<UserActionForm>,
) -> AppResult {
    user.check_csrf(&f.csrf)?;
    if target_id == user.id {
        return Err(AppError::BadRequest("Use the Password page to manage your own account.".into()));
    }
    let target = st.db.get_user(target_id).await?.ok_or(AppError::NotFound)?;
    let target_is_active_admin = target.role == "admin" && !target.disabled;
    let last_admin = target_is_active_admin && st.db.count_active_admins().await? <= 1;
    let name = target.username.clone();

    match f.action.as_str() {
        "reset" => {
            let temp = auth::generate_temp_password();
            let hash = auth::hash_password_async(temp.clone()).await?;
            st.db.set_password(target.id, hash, true).await?;
            st.db.delete_user_sessions(target.id, None).await?;
            st.db.audit(user.audit_id(), Some(ip), "user_password_reset", name.clone()).await;
            return Ok(message(
                &user,
                "Password reset",
                format!("{name} has been signed out everywhere. Give them this one-time password; they must change it at next sign-in."),
                Some(temp),
            ));
        }
        "disable" => {
            if last_admin {
                return Err(AppError::BadRequest("You cannot disable the last administrator.".into()));
            }
            st.db.set_disabled(target.id, true).await?;
            st.db.delete_user_sessions(target.id, None).await?;
            st.db.audit(user.audit_id(), Some(ip), "user_disabled", name).await;
        }
        "enable" => {
            st.db.set_disabled(target.id, false).await?;
            st.db.audit(user.audit_id(), Some(ip), "user_enabled", name).await;
        }
        "make_admin" => {
            st.db.set_role(target.id, "admin").await?;
            st.db.delete_user_sessions(target.id, None).await?;
            st.db.audit(user.audit_id(), Some(ip), "user_promoted", name).await;
        }
        "make_user" | "make_member" => {
            if last_admin {
                return Err(AppError::BadRequest("You cannot demote the last administrator.".into()));
            }
            st.db.set_role(target.id, "member").await?;
            st.db.delete_user_sessions(target.id, None).await?;
            st.db.audit(user.audit_id(), Some(ip), "user_demoted", name).await;
        }
        "delete" => {
            if last_admin {
                return Err(AppError::BadRequest("You cannot delete the last administrator.".into()));
            }
            st.db.delete_user(target.id).await?;
            st.db.audit(user.audit_id(), Some(ip), "user_deleted", name).await;
        }
        _ => return Err(AppError::BadRequest("Unknown action.".into())),
    }
    Ok(Redirect::to("/admin#users").into_response())
}

// ---------------------------------------------------------------- uploads

struct Upload {
    fields: HashMap<String, String>,
    zip: Option<TempFile>,
}

/// Deletes the uploaded temp file when dropped, whatever happens.
struct TempFile(PathBuf);
impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Stream a multipart form to disk with hard size caps. The CSRF field must come before the file.
async fn read_upload(st: &AppState, user: &CurrentUser, mut mp: Multipart) -> AppResult<Upload> {
    let bad = |m: &str| AppError::BadRequest(m.to_string());
    let mut fields = HashMap::new();
    let mut zip = None;
    let mut csrf_ok = false;
    while let Some(mut field) = mp.next_field().await.map_err(|_| bad("The upload was interrupted. Please try again."))? {
        let name = field.name().unwrap_or("").to_string();
        if name == "vault_zip" {
            if !csrf_ok {
                return Err(AppError::Forbidden("Your form expired. Reload the page and try again.".into()));
            }
            if zip.is_some() {
                return Err(bad("Only one file can be uploaded at a time."));
            }
            let tmp = TempFile(st.cfg.tmp_dir().join(format!("{}.zip", uuid::Uuid::new_v4().simple())));
            let mut out = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&tmp.0).await?;
            let mut written: u64 = 0;
            let mut head: Vec<u8> = Vec::with_capacity(4);
            while let Some(chunk) = field.chunk().await.map_err(|_| bad("The upload was interrupted or is too large."))? {
                written += chunk.len() as u64;
                if written > st.cfg.max_upload_bytes {
                    return Err(bad(&format!(
                        "That file is larger than the {} MB upload limit.",
                        st.cfg.max_upload_bytes / 1024 / 1024
                    )));
                }
                if head.len() < 4 {
                    let need = 4 - head.len();
                    head.extend(chunk.iter().take(need).copied());
                }
                out.write_all(&chunk).await?;
            }
            out.flush().await?;
            if written == 0 {
                continue; // no file chosen
            }
            if head != b"PK\x03\x04" {
                return Err(bad("That file is not a ZIP archive. Compress your vault folder to .zip first."));
            }
            zip = Some(tmp);
        } else {
            let mut value = Vec::new();
            while let Some(chunk) = field.chunk().await.map_err(|_| bad("The upload was interrupted."))? {
                value.extend_from_slice(&chunk);
                if value.len() > 8 * 1024 {
                    return Err(bad("A form field is too long."));
                }
            }
            let value = String::from_utf8(value).map_err(|_| bad("Form fields must be text."))?;
            if name == "csrf" {
                user.check_csrf(&value)?;
                csrf_ok = true;
            }
            fields.insert(name, value);
        }
    }
    if !csrf_ok {
        return Err(AppError::Forbidden("Your form expired. Reload the page and try again.".into()));
    }
    if zip.is_none() {
        if let Some(id) = fields.get("upload_id") {
            zip = Some(take_chunked_upload(st, id).await?);
        }
    }
    Ok(Upload { fields, zip })
}

// ---------------------------------------------------------------- chunked uploads
//
// Big vault zips can exceed what a proxy in front of the app accepts in one request (Cloudflare's
// free plan caps request bodies at 100 MB). The browser instead sends the zip in CHUNK_BYTES
// pieces, which are appended to a temp file, then submits the normal form with `upload_id`.

/// Size of each piece the browser sends. Kept well under Cloudflare's 100 MB request limit.
const CHUNK_BYTES: u64 = 75 * 1024 * 1024;
/// Unfinished uploads older than this are deleted the next time someone starts one.
const STALE_UPLOAD_SECS: u64 = 24 * 60 * 60;

fn json_response(status: StatusCode, body: serde_json::Value) -> Response {
    (status, [(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
}

fn check_header_csrf(user: &CurrentUser, headers: &HeaderMap) -> AppResult<()> {
    let token = headers.get("x-csrf-token").and_then(|v| v.to_str().ok()).unwrap_or("");
    user.check_csrf(token)
}

/// Path of an upload in progress. Ids are 32 lowercase hex characters, which rules out path tricks.
fn part_path(st: &AppState, id: &str) -> Option<PathBuf> {
    let ok = id.len() == 32 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    ok.then(|| st.cfg.tmp_dir().join(format!("{id}.part")))
}

async fn sweep_stale_uploads(st: &AppState) {
    let Ok(mut rd) = tokio::fs::read_dir(st.cfg.tmp_dir()).await else { return };
    while let Ok(Some(e)) = rd.next_entry().await {
        let path = e.path();
        let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("");
        if ext != "part" && ext != "chunk" {
            continue;
        }
        let age = e.metadata().await.ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok());
        if age.is_some_and(|a| a.as_secs() > STALE_UPLOAD_SECS) {
            let _ = tokio::fs::remove_file(&path).await;
        }
    }
}

/// Start a chunked upload: creates an empty temp file and tells the browser the chunk size.
pub async fn upload_start(State(st): State<AppState>, user: CurrentUser, headers: HeaderMap) -> AppResult {
    check_header_csrf(&user, &headers)?;
    sweep_stale_uploads(&st).await;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let path = part_path(&st, &id).ok_or(AppError::NotFound)?;
    tokio::fs::OpenOptions::new().write(true).create_new(true).open(&path).await?;
    Ok(json_response(
        StatusCode::OK,
        serde_json::json!({ "id": id, "chunk_bytes": CHUNK_BYTES, "max_bytes": st.cfg.max_upload_bytes }),
    ))
}

/// Append one chunk. The browser says where the chunk starts (`x-upload-offset`); if that is not where the
/// file ends the server answers 409 with how much it really has, so the browser can resume from there.
pub async fn upload_chunk(
    State(st): State<AppState>,
    user: CurrentUser,
    Path(id): Path<String>,
    headers: HeaderMap,
    mut mp: Multipart,
) -> AppResult {
    check_header_csrf(&user, &headers)?;
    let bad = |m: &str| AppError::BadRequest(m.to_string());
    let part = part_path(&st, &id).ok_or(AppError::NotFound)?;
    let offset: u64 = headers
        .get("x-upload-offset")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| bad("Missing upload offset."))?;
    let have = tokio::fs::metadata(&part).await.map_err(|_| AppError::NotFound)?.len();
    if offset != have {
        return Ok(json_response(StatusCode::CONFLICT, serde_json::json!({ "received": have })));
    }

    // Write to a side file first so a dropped connection never leaves half a chunk in the real file.
    let side = TempFile(st.cfg.tmp_dir().join(format!("{}.chunk", uuid::Uuid::new_v4().simple())));
    let mut size: u64 = 0;
    let mut head: Vec<u8> = Vec::with_capacity(4);
    {
        let mut out = tokio::fs::OpenOptions::new().write(true).create_new(true).open(&side.0).await?;
        while let Some(mut field) = mp.next_field().await.map_err(|_| bad("The upload was interrupted."))? {
            if field.name() != Some("chunk") {
                continue;
            }
            while let Some(piece) = field.chunk().await.map_err(|_| bad("The upload was interrupted."))? {
                size += piece.len() as u64;
                if size > CHUNK_BYTES {
                    return Err(bad("That piece is larger than the chunk size."));
                }
                if have + size > st.cfg.max_upload_bytes {
                    return Err(bad(&format!(
                        "That file is larger than the {} MB upload limit.",
                        st.cfg.max_upload_bytes / 1024 / 1024
                    )));
                }
                if head.len() < 4 {
                    let need = 4 - head.len();
                    head.extend(piece.iter().take(need).copied());
                }
                out.write_all(&piece).await?;
            }
            break;
        }
        out.flush().await?;
    }
    if size == 0 {
        return Err(bad("Empty upload piece."));
    }
    if have == 0 && head != b"PK\x03\x04" {
        return Err(bad("That file is not a ZIP archive. Compress your vault folder to .zip first."));
    }
    let mut src = tokio::fs::File::open(&side.0).await?;
    let mut dst = tokio::fs::OpenOptions::new().append(true).open(&part).await?;
    tokio::io::copy(&mut src, &mut dst).await?;
    dst.flush().await?;
    Ok(json_response(StatusCode::OK, serde_json::json!({ "received": have + size })))
}

/// Turn a finished chunked upload (`upload_id` form field) into the zip the import expects.
async fn take_chunked_upload(st: &AppState, id: &str) -> AppResult<TempFile> {
    let bad = |m: &str| AppError::BadRequest(m.to_string());
    let part = part_path(st, id).ok_or_else(|| bad("The upload could not be found. Please try again."))?;
    let mut f = tokio::fs::File::open(&part).await.map_err(|_| bad("The upload could not be found. Please try again."))?;
    let mut head = [0u8; 4];
    tokio::io::AsyncReadExt::read_exact(&mut f, &mut head).await.map_err(|_| bad("That file is not a ZIP archive."))?;
    drop(f);
    if &head != b"PK\x03\x04" {
        return Err(bad("That file is not a ZIP archive. Compress your vault folder to .zip first."));
    }
    let zip_path = st.cfg.tmp_dir().join(format!("{}.zip", uuid::Uuid::new_v4().simple()));
    tokio::fs::rename(&part, &zip_path).await?;
    Ok(TempFile(zip_path))
}

fn clean_text(s: Option<&String>, max: usize) -> String {
    s.map(|s| s.trim().chars().filter(|c| !c.is_control() || *c == '\n').take(max).collect())
        .unwrap_or_default()
}

async fn import(st: &AppState, zip: &TempFile, vault_id: &str) -> AppResult<vault::ImportStats> {
    let _guard = st.upload_lock.lock().await; // one extraction at a time
    let (zip_path, vaults_dir, id) = (zip.0.clone(), st.cfg.vaults_dir(), vault_id.to_string());
    let limits = Limits {
        max_total: st.cfg.max_extracted_bytes,
        max_file: st.cfg.max_file_bytes,
        max_files: st.cfg.max_files,
    };
    let res = tokio::task::spawn_blocking(move || vault::import_zip(&zip_path, &vaults_dir, &id, &limits)).await?;
    st.indexes.write().unwrap_or_else(|e| e.into_inner()).remove(vault_id);
    match res {
        Ok(s) => Ok(s),
        Err(ImportError::Invalid(m)) => Err(AppError::BadRequest(m)),
        Err(ImportError::Io(e)) => Err(AppError::Internal(e.into())),
    }
}

/// Any account can create a vault: empty, or from a zip of an existing one.
pub async fn new_vault_form(State(st): State<AppState>, user: CurrentUser) -> AppResult {
    let configured = ingest::Settings::load(&st.db).await?.api_key.is_some();
    Ok(render(&VaultNewPage {
        page: PageCtx::for_user(&user),
        csrf: user.csrf.clone(),
        max_upload_mb: st.cfg.max_upload_bytes / 1024 / 1024,
        configured,
        is_admin: user.is_admin,
    }))
}

pub async fn create_vault(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    user: CurrentUser,
    mp: Multipart,
) -> AppResult {
    let up = read_upload(&st, &user, mp).await?;
    let name = clean_text(up.fields.get("name"), 100);
    if name.is_empty() {
        return Err(AppError::BadRequest("Give the vault a name.".into()));
    }
    let description = clean_text(up.fields.get("description"), 500);
    // "Import" was chosen but no zip came with it: say so instead of quietly making an empty vault.
    if up.fields.get("mode").map(String::as_str) == Some("zip") && up.zip.is_none() {
        return Err(AppError::BadRequest("Choose a .zip file of your vault, or pick Start from scratch.".into()));
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (files, bytes, skipped) = match &up.zip {
        Some(zip) => {
            let stats = import(&st, zip, &id).await?;
            (stats.files as i64, stats.bytes as i64, stats.skipped)
        }
        None => {
            // No zip: start with an empty vault to add notes and sources to.
            tokio::fs::create_dir_all(st.cfg.vaults_dir().join(&id)).await?;
            (0, 0, 0)
        }
    };
    st.db.create_vault(id.clone(), name.clone(), description, true, files, bytes).await?;
    st.db
        .audit(user.audit_id(), Some(ip), "vault_created", format!("{name}: {files} files, {skipped} skipped"))
        .await;
    if up.zip.is_none() {
        return Ok(Redirect::to(&format!("/v/{id}/sources")).into_response());
    }
    if user.is_admin {
        return Ok(Redirect::to(&format!("/admin/vaults/{id}?imported={files}&skipped={skipped}")).into_response());
    }
    Ok(Redirect::to(&format!("/v/{id}")).into_response())
}

async fn admin_vault(st: &AppState, id: &str) -> AppResult<VaultRow> {
    if !is_valid_id(id) {
        return Err(AppError::NotFound);
    }
    st.db.get_vault(id.to_string()).await?.ok_or(AppError::NotFound)
}

#[derive(Deserialize)]
pub struct ImportNotice {
    imported: Option<usize>,
    skipped: Option<usize>,
}

pub async fn manage_vault(
    State(st): State<AppState>,
    AdminUser(user): AdminUser,
    Path(id): Path<String>,
    axum::extract::Query(n): axum::extract::Query<ImportNotice>,
) -> AppResult {
    let v = admin_vault(&st, &id).await?;
    let notice = n.imported.map(|i| {
        let s = n.skipped.unwrap_or(0);
        if s > 0 {
            format!("Imported {i} files. Skipped {s} (hidden folders like .obsidian, symlinks or unsupported file types).")
        } else {
            format!("Imported {i} files.")
        }
    });
    Ok(render(&VaultAdminPage {
        page: PageCtx::for_user(&user),
        csrf: user.csrf.clone(),
        vault: vault_view(v),
        max_upload_mb: st.cfg.max_upload_bytes / 1024 / 1024,
        notice,
        backups: {
            let id = id.clone();
            let dir = st.cfg.backups_dir();
            tokio::task::spawn_blocking(move || vault::list_backups(&dir, &id)).await?
                .into_iter()
                .map(|(ts, name, size)| BackupView { name, when: fmt_ts(ts as i64), size: fmt_bytes(size as i64) })
                .collect()
        },
    }))
}

pub async fn replace_vault(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    AdminUser(user): AdminUser,
    Path(id): Path<String>,
    mp: Multipart,
) -> AppResult {
    let v = admin_vault(&st, &id).await?;
    let up = read_upload(&st, &user, mp).await?;
    let zip = up.zip.ok_or_else(|| AppError::BadRequest("Choose a .zip file of your vault.".into()))?;
    // Edits made on the site live only in the vault folder, so keep a copy before the upload replaces it.
    {
        let (dir, backups, vid) = (st.cfg.vaults_dir().join(&v.id), st.cfg.backups_dir(), v.id.clone());
        tokio::task::spawn_blocking(move || vault::backup_vault(&dir, &backups, &vid)).await?.map_err(|e| {
            tracing::error!("backup failed: {e}");
            AppError::BadRequest("Could not back up the current version, so nothing was replaced. Check free disk space.".into())
        })?;
    }
    let stats = import(&st, &zip, &v.id).await?;
    st.db.update_vault_stats(v.id.clone(), stats.files as i64, stats.bytes as i64).await?;
    st.db
        .audit(user.audit_id(), Some(ip), "vault_replaced", format!("{}: {} files", v.name, stats.files))
        .await;
    Ok(Redirect::to(&format!("/admin/vaults/{}?imported={}&skipped={}", v.id, stats.files, stats.skipped)).into_response())
}

#[derive(Deserialize)]
pub struct VaultSettingsForm {
    csrf: String,
    name: String,
    #[serde(default)]
    description: String,
}

pub async fn vault_settings(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    AdminUser(user): AdminUser,
    Path(id): Path<String>,
    Form(f): Form<VaultSettingsForm>,
) -> AppResult {
    user.check_csrf(&f.csrf)?;
    let v = admin_vault(&st, &id).await?;
    let name = clean_text(Some(&f.name), 100);
    if name.is_empty() {
        return Err(AppError::BadRequest("Give the vault a name.".into()));
    }
    st.db.update_vault_meta(v.id.clone(), name.clone(), clean_text(Some(&f.description), 500), true).await?;
    st.db.audit(user.audit_id(), Some(ip), "vault_settings", name).await;
    Ok(Redirect::to(&format!("/admin/vaults/{}", v.id)).into_response())
}

pub async fn delete_vault(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    AdminUser(user): AdminUser,
    Path(id): Path<String>,
    Form(f): Form<CsrfForm>,
) -> AppResult {
    user.check_csrf(&f.csrf)?;
    let v = admin_vault(&st, &id).await?;
    let _guard = st.upload_lock.lock().await;
    st.db.delete_vault(v.id.clone()).await?;
    st.indexes.write().unwrap_or_else(|e| e.into_inner()).remove(&v.id);
    let dir = st.cfg.vaults_dir().join(&v.id);
    let trash = st.cfg.vaults_dir().join(format!(".trash-{}", v.id));
    tokio::task::spawn_blocking(move || {
        if std::fs::rename(&dir, &trash).is_ok() {
            let _ = std::fs::remove_dir_all(&trash);
        }
    })
    .await?;
    st.db.audit(user.audit_id(), Some(ip), "vault_deleted", v.name).await;
    Ok(Redirect::to("/admin").into_response())
}

/// Download a backup zip made before a re-upload.
pub async fn download_backup(
    State(st): State<AppState>,
    AdminUser(_user): AdminUser,
    Path((id, name)): Path<(String, String)>,
    req: axum::extract::Request,
) -> AppResult {
    use tower::ServiceExt;
    if !is_valid_id(&id) || !name.ends_with(".zip") || !name[..name.len() - 4].bytes().all(|b| b.is_ascii_digit()) {
        return Err(AppError::NotFound);
    }
    let path = st.cfg.backups_dir().join(&id).join(&name);
    if !path.is_file() {
        return Err(AppError::NotFound);
    }
    let res = tower_http::services::ServeFile::new(path).oneshot(req).await.map_err(|e| AppError::Internal(e.into()))?;
    let mut res = res.map(axum::body::Body::new);
    let h = res.headers_mut();
    h.insert(axum::http::header::CONTENT_TYPE, axum::http::HeaderValue::from_static("application/zip"));
    h.insert(axum::http::header::CACHE_CONTROL, axum::http::HeaderValue::from_static("no-store"));
    if let Ok(v) = axum::http::HeaderValue::from_str(&format!("attachment; filename=\"vault-backup-{name}\"")) {
        h.insert(axum::http::header::CONTENT_DISPOSITION, v);
    }
    Ok(res)
}
