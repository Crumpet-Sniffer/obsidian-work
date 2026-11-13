//! Askama page models. All `{{ }}` output is HTML-escaped; only pre-sanitized HTML uses `|safe`.

use std::sync::OnceLock;

use askama::Template;
use axum::{
    http::StatusCode,
    response::{Html, IntoResponse, Response},
};

use crate::auth::CurrentUser;

static SITE_NAME: OnceLock<String> = OnceLock::new();

pub fn set_site_name(name: String) {
    let _ = SITE_NAME.set(name);
}

pub struct NavUser {
    pub username: String,
    pub is_admin: bool,
    pub csrf: String,
    pub must_change: bool,
}

pub struct PageCtx {
    pub site_name: String,
    pub user: Option<NavUser>,
    /// Fingerprint of the bundled CSS/JS, added to asset URLs so browsers and CDNs fetch new files after an update.
    pub asset_v: String,
}

/// Short hash of every bundled static file. Changes whenever any of them changes.
pub fn asset_version() -> &'static str {
    use sha2::{Digest, Sha256};
    static V: OnceLock<String> = OnceLock::new();
    V.get_or_init(|| {
        let mut h = Sha256::new();
        for f in [
            include_str!("../static/app.css"),
            include_str!("../static/obsidian.css"),
            include_str!("../static/app.js"),
            include_str!("../static/graph.js"),
            include_str!("../static/office.js"),
        ] {
            h.update(f.as_bytes());
        }
        h.finalize().iter().take(5).map(|b| format!("{b:02x}")).collect()
    })
}

impl PageCtx {
    pub fn anonymous() -> Self {
        PageCtx {
            site_name: SITE_NAME.get().cloned().unwrap_or_else(|| "Vault Share".into()),
            user: None,
            asset_v: asset_version().to_string(),
        }
    }

    pub fn for_user(u: &CurrentUser) -> Self {
        PageCtx {
            user: Some(NavUser {
                username: u.username.clone(),
                is_admin: u.is_admin,
                csrf: u.csrf.clone(),
                must_change: u.must_change_password,
            }),
            ..Self::anonymous()
        }
    }
}

pub fn render_status<T: Template>(status: StatusCode, t: &T) -> Response {
    match t.render() {
        Ok(html) => (status, Html(html)).into_response(),
        Err(e) => {
            tracing::error!("template error: {e}");
            (StatusCode::INTERNAL_SERVER_ERROR, "template error").into_response()
        }
    }
}

pub fn render<T: Template>(t: &T) -> Response {
    render_status(StatusCode::OK, t)
}

#[derive(Template)]
#[template(path = "login.html")]
pub struct LoginPage {
    pub page: PageCtx,
    pub error: Option<String>,
    pub username: String,
    pub next: String,
}

#[derive(Template)]
#[template(path = "password.html")]
pub struct PasswordPage {
    pub page: PageCtx,
    pub csrf: String,
    pub error: Option<String>,
    pub forced: bool,
    pub min_len: usize,
}

pub struct VaultCard {
    pub id: String,
    pub name: String,
    pub description: String,
    pub files: i64,
    pub updated: String,
}

#[derive(Template)]
#[template(path = "home.html")]
pub struct HomePage {
    pub page: PageCtx,
    pub vaults: Vec<VaultCard>,
}

#[derive(Template)]
#[template(path = "note.html")]
pub struct NotePage {
    pub page: PageCtx,
    pub vault_id: String,
    pub vault_name: String,
    pub title: String,
    pub folder: String,
    pub tree_html: String,
    pub content_html: String,
    pub raw_url: String,
    pub graph_url: String,
    /// Rendered Connections block (topics, related notes) of a converted document.
    pub conn_html: String,
    /// Viewer URL of the Word/PowerPoint original this note was converted from, if any.
    pub original_url: String,
    pub backlinks: Vec<Backlink>,
    /// Rendered frontmatter ("Properties") block, already escaped.
    pub properties_html: String,
}

pub struct Backlink {
    pub url: String,
    pub title: String,
    pub folder: String,
}

#[derive(Template)]
#[template(path = "original.html")]
pub struct OriginalPage {
    pub page: PageCtx,
    pub vault_id: String,
    pub vault_name: String,
    pub title: String,
    pub kind: String,
    pub tree_html: String,
    pub file_url: String,
    pub note_url: String,
    pub conn_html: String,
    pub backlinks: Vec<Backlink>,
}

#[derive(Template)]
#[template(path = "graph.html")]
pub struct GraphPage {
    pub page: PageCtx,
    pub vault_id: String,
    pub vault_name: String,
    pub tree_html: String,
    pub focus: String,
}

pub struct SearchHit {
    pub url: String,
    pub title: String,
    pub folder: String,
    pub before: String,
    pub matched: String,
    pub after: String,
}

#[derive(Template)]
#[template(path = "search.html")]
pub struct SearchPage {
    pub page: PageCtx,
    pub vault_id: String,
    pub vault_name: String,
    pub tree_html: String,
    pub q: String,
    pub results: Vec<SearchHit>,
    pub truncated: bool,
}

pub struct UserView {
    pub id: i64,
    pub username: String,
    pub is_admin: bool,
    pub disabled: bool,
    pub must_change: bool,
    pub created: String,
    pub last_login: String,
    pub is_me: bool,
}

pub struct VaultAdminView {
    pub id: String,
    pub name: String,
    pub description: String,
    pub shared_with_all: bool,
    pub files: i64,
    pub size: String,
    pub updated: String,
}

pub struct AuditView {
    pub ts: String,
    pub username: String,
    pub ip: String,
    pub action: String,
    pub detail: String,
}

#[derive(Template)]
#[template(path = "admin.html")]
pub struct AdminPage {
    pub page: PageCtx,
    pub csrf: String,
    pub users: Vec<UserView>,
    pub vaults: Vec<VaultAdminView>,
    pub audit: Vec<AuditView>,
}

#[derive(Template)]
#[template(path = "vault_new.html")]
pub struct VaultNewPage {
    pub page: PageCtx,
    pub csrf: String,
    pub max_upload_mb: u64,
}

pub struct AccessView {
    pub user_id: i64,
    pub username: String,
    pub granted: bool,
}

#[derive(Template)]
#[template(path = "vault_admin.html")]
pub struct VaultAdminPage {
    pub page: PageCtx,
    pub csrf: String,
    pub vault: VaultAdminView,
    pub members: Vec<AccessView>,
    pub max_upload_mb: u64,
    pub notice: Option<String>,
}

#[derive(Template)]
#[template(path = "message.html")]
pub struct MessagePage {
    pub page: PageCtx,
    pub title: String,
    pub message: String,
    pub secret: Option<String>,
    pub back_href: String,
    pub back_label: String,
}

pub fn fmt_ts(ts: i64) -> String {
    chrono::DateTime::from_timestamp(ts, 0)
        .map(|d| d.format("%Y-%m-%d %H:%M UTC").to_string())
        .unwrap_or_default()
}

pub fn fmt_bytes(b: i64) -> String {
    let b = b as f64;
    if b >= 1024.0 * 1024.0 * 1024.0 {
        format!("{:.1} GB", b / (1024.0 * 1024.0 * 1024.0))
    } else if b >= 1024.0 * 1024.0 {
        format!("{:.1} MB", b / (1024.0 * 1024.0))
    } else {
        format!("{:.0} KB", (b / 1024.0).ceil())
    }
}
