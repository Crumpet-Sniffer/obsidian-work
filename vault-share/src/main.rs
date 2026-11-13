mod auth;
mod config;
mod db;
mod errors;
mod graph;
mod handlers;
mod markdown;
mod security;
mod templates;
mod vault;

use std::{
    collections::HashMap,
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    sync::{Arc, RwLock},
    time::Duration,
};

use axum::{
    extract::DefaultBodyLimit,
    http::{header, StatusCode},
    middleware,
    response::IntoResponse,
    routing::{get, post},
    Router,
};
use tower_http::{catch_panic::CatchPanicLayer, timeout::TimeoutLayer, trace::TraceLayer};
use tracing_subscriber::EnvFilter;

use handlers::{admin, auth as auth_h, vaults};

pub struct AppInner {
    pub cfg: config::Config,
    pub db: db::Db,
    pub limiter: auth::LoginLimiter,
    pub indexes: RwLock<HashMap<String, Arc<vault::VaultIndex>>>,
    pub upload_lock: tokio::sync::Mutex<()>,
}

pub type AppState = Arc<AppInner>;

fn main() -> anyhow::Result<()> {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        std::process::exit(healthcheck());
    }
    tokio::runtime::Builder::new_multi_thread().enable_all().build()?.block_on(run())
}

/// `vault-share healthcheck` – used by Docker's HEALTHCHECK (the runtime image has no curl).
fn healthcheck() -> i32 {
    let port = std::env::var("BIND_ADDR")
        .ok()
        .and_then(|a| a.parse::<SocketAddr>().ok())
        .map(|a| a.port())
        .unwrap_or(8080);
    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let attempt = || -> std::io::Result<bool> {
        let mut s = TcpStream::connect_timeout(&addr, Duration::from_secs(3))?;
        s.set_read_timeout(Some(Duration::from_secs(3)))?;
        s.write_all(b"GET /healthz HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
        let mut buf = [0u8; 32];
        let n = s.read(&mut buf)?;
        Ok(buf[..n].windows(3).any(|w| w == b"200"))
    };
    match attempt() {
        Ok(true) => 0,
        _ => 1,
    }
}

async fn run() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let cfg = config::Config::from_env()?;
    std::fs::create_dir_all(cfg.vaults_dir())?;
    std::fs::create_dir_all(cfg.tmp_dir())?;
    vault::cleanup_dirs(&cfg.vaults_dir(), &cfg.tmp_dir());
    templates::set_site_name(cfg.site_name.clone());

    let db = db::Db::open(&cfg.db_path())?;
    auth::bootstrap_admin(&db, &cfg).await?;
    let _ = auth::dummy_hash();

    if !cfg.cookie_secure {
        tracing::warn!("COOKIE_SECURE=false: only use this for local testing over plain HTTP.");
    }

    let state: AppState = Arc::new(AppInner {
        cfg: cfg.clone(),
        db,
        limiter: auth::LoginLimiter::default(),
        indexes: RwLock::new(HashMap::new()),
        upload_lock: tokio::sync::Mutex::new(()),
    });

    // Housekeeping: expire sessions, prune audit log (180 days) and throttle state.
    let bg = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(15 * 60));
        loop {
            tick.tick().await;
            if let Err(e) = bg.db.delete_expired_sessions(bg.cfg.session_idle_secs, bg.cfg.session_max_secs).await {
                tracing::error!("session cleanup failed: {e:#}");
            }
            let _ = bg.db.prune_audit(180 * 86_400).await;
            bg.limiter.prune();
        }
    });

    let app = router(state);
    let listener = tokio::net::TcpListener::bind(cfg.bind).await?;
    tracing::info!("listening on http://{}", cfg.bind);
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

fn router(state: AppState) -> Router {
    let upload_limit = state.cfg.max_upload_bytes as usize + 1024 * 1024;

    // Large multipart uploads: big body limit, no short timeout.
    let uploads = Router::new()
        .route("/admin/vaults", post(admin::create_vault))
        .route("/admin/vaults/{id}/upload", post(admin::replace_vault))
        .layer(DefaultBodyLimit::max(upload_limit));

    let pages = Router::new()
        .route("/", get(vaults::home))
        .route("/login", get(auth_h::login_page).post(auth_h::login_submit))
        .route("/logout", post(auth_h::logout))
        .route("/account/password", get(auth_h::password_form).post(auth_h::password_submit))
        .route("/v/{id}", get(vaults::vault_home))
        .route("/v/{id}/search", get(vaults::search))
        .route("/v/{id}/graph", get(vaults::graph_page))
        .route("/v/{id}/graph.json", get(vaults::graph_json))
        .route("/v/{id}/n/{*path}", get(vaults::note))
        .route("/v/{id}/f/{*path}", get(vaults::file))
        .route("/admin", get(admin::dashboard))
        .route("/admin/users", post(admin::create_user))
        .route("/admin/users/{id}", post(admin::user_action))
        .route("/admin/vaults/new", get(admin::new_vault_form))
        .route("/admin/vaults/{id}", get(admin::manage_vault))
        .route("/admin/vaults/{id}/settings", post(admin::vault_settings))
        .route("/admin/vaults/{id}/access", post(admin::vault_access))
        .route("/admin/vaults/{id}/delete", post(admin::delete_vault))
        .layer(DefaultBodyLimit::max(64 * 1024))
        .layer(TimeoutLayer::with_status_code(StatusCode::REQUEST_TIMEOUT, Duration::from_secs(60)));

    Router::new()
        .merge(pages)
        .merge(uploads)
        .route("/healthz", get(|| async { "ok" }))
        .route("/static/app.css", get(static_css))
        .route("/static/obsidian.css", get(static_obsidian_css))
        .route("/static/app.js", get(static_js))
        .route("/static/graph.js", get(static_graph_js))
        .route("/favicon.svg", get(favicon))
        .route("/robots.txt", get(|| async { "User-agent: *\nDisallow: /\n" }))
        .fallback(|| async { errors::AppError::NotFound })
        .layer(middleware::from_fn_with_state(state.clone(), security::origin_check))
        .layer(middleware::from_fn_with_state(state.clone(), security::security_headers))
        .layer(TraceLayer::new_for_http())
        .layer(CatchPanicLayer::new())
        .with_state(state)
}

async fn static_css() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8"), (header::CACHE_CONTROL, "public, max-age=3600")],
        include_str!("../static/app.css"),
    )
}

async fn static_obsidian_css() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8"), (header::CACHE_CONTROL, "public, max-age=3600")],
        include_str!("../static/obsidian.css"),
    )
}

async fn static_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8"), (header::CACHE_CONTROL, "public, max-age=3600")],
        include_str!("../static/app.js"),
    )
}

async fn static_graph_js() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/javascript; charset=utf-8"), (header::CACHE_CONTROL, "public, max-age=3600")],
        include_str!("../static/graph.js"),
    )
}

async fn favicon() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "image/svg+xml"), (header::CACHE_CONTROL, "public, max-age=86400")],
        include_str!("../static/favicon.svg"),
    )
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        if let Ok(mut s) = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            s.recv().await;
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! { _ = ctrl_c => {}, _ = term => {} }
    tracing::info!("shutting down");
}
