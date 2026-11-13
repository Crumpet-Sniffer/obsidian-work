use std::{collections::HashMap, path::PathBuf};

use axum::{
    extract::{Multipart, Path, State},
    response::{IntoResponse, Redirect, Response},
    Form,
};
use serde::Deserialize;
use tokio::io::AsyncWriteExt;

use crate::{
    auth::{self, AdminUser, ClientIp, CurrentUser},
    db::VaultRow,
    errors::{AppError, AppResult},
    handlers::auth::CsrfForm,
    templates::{
        fmt_bytes, fmt_ts, render, AccessView, AdminPage, AuditView, MessagePage, PageCtx, UserView, VaultAdminPage,
        VaultAdminView, VaultNewPage,
    },
    vault::{self, is_valid_id, ImportError, Limits},
    AppState,
};

fn vault_view(v: VaultRow) -> VaultAdminView {
    VaultAdminView {
        id: v.id,
        name: v.name,
        description: v.description,
        shared_with_all: v.shared_with_all,
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

pub async fn dashboard(State(st): State<AppState>, AdminUser(user): AdminUser) -> AppResult {
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
    Ok(render(&AdminPage { page: PageCtx::for_user(&user), csrf: user.csrf.clone(), users, vaults, audit }))
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
        "make_member" => {
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
    Ok(Upload { fields, zip })
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

pub async fn new_vault_form(State(st): State<AppState>, AdminUser(user): AdminUser) -> Response {
    render(&VaultNewPage {
        page: PageCtx::for_user(&user),
        csrf: user.csrf.clone(),
        max_upload_mb: st.cfg.max_upload_bytes / 1024 / 1024,
    })
}

pub async fn create_vault(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    AdminUser(user): AdminUser,
    mp: Multipart,
) -> AppResult {
    let up = read_upload(&st, &user, mp).await?;
    let name = clean_text(up.fields.get("name"), 100);
    if name.is_empty() {
        return Err(AppError::BadRequest("Give the vault a name.".into()));
    }
    let description = clean_text(up.fields.get("description"), 500);
    let shared = up.fields.contains_key("shared_with_all");
    let zip = up.zip.ok_or_else(|| AppError::BadRequest("Choose a .zip file of your vault.".into()))?;

    let id = uuid::Uuid::new_v4().simple().to_string();
    let stats = import(&st, &zip, &id).await?;
    st.db
        .create_vault(id.clone(), name.clone(), description, shared, stats.files as i64, stats.bytes as i64)
        .await?;
    st.db
        .audit(user.audit_id(), Some(ip), "vault_created", format!("{name}: {} files, {} skipped", stats.files, stats.skipped))
        .await;
    Ok(Redirect::to(&format!("/admin/vaults/{id}?imported={}&skipped={}", stats.files, stats.skipped)).into_response())
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
    let members = st
        .db
        .access_list(v.id.clone())
        .await?
        .into_iter()
        .map(|(user_id, username, granted)| AccessView { user_id, username, granted })
        .collect();
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
        members,
        max_upload_mb: st.cfg.max_upload_bytes / 1024 / 1024,
        notice,
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
    shared_with_all: Option<String>,
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
    let shared = f.shared_with_all.is_some();
    st.db.update_vault_meta(v.id.clone(), name.clone(), clean_text(Some(&f.description), 500), shared).await?;
    st.db
        .audit(user.audit_id(), Some(ip), "vault_settings", format!("{name}: shared_with_all={shared}"))
        .await;
    Ok(Redirect::to(&format!("/admin/vaults/{}", v.id)).into_response())
}

#[derive(Deserialize)]
pub struct AccessForm {
    csrf: String,
    user_id: i64,
    grant: String,
}

pub async fn vault_access(
    State(st): State<AppState>,
    ClientIp(ip): ClientIp,
    AdminUser(user): AdminUser,
    Path(id): Path<String>,
    Form(f): Form<AccessForm>,
) -> AppResult {
    user.check_csrf(&f.csrf)?;
    let v = admin_vault(&st, &id).await?;
    let target = st.db.get_user(f.user_id).await?.ok_or(AppError::NotFound)?;
    let grant = f.grant == "1";
    st.db.set_access(v.id.clone(), target.id, grant).await?;
    st.db
        .audit(
            user.audit_id(),
            Some(ip),
            if grant { "vault_access_granted" } else { "vault_access_revoked" },
            format!("{} -> {}", v.name, target.username),
        )
        .await;
    Ok(Redirect::to(&format!("/admin/vaults/{}#access", v.id)).into_response())
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
