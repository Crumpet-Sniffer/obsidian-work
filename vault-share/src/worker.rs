//! Starts and watches the ingest worker: a Node.js process (INGEST_WORKER, run with NODE_BIN) that files the
//! sources uploaded on the Sources page in the background (see handlers/batches.rs). If it stops, it is started
//! again. It gets a clean environment: the server's URL on loopback, its token and the OCR folder, nothing else
//! (in particular not the Anthropic key or the admin password).

use std::{
    net::{IpAddr, Ipv4Addr, Ipv6Addr},
    process::Stdio,
    time::Duration,
};

use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
};

use crate::AppState;

/// Where the worker reaches this server: the bound address, or loopback when bound to all addresses.
fn server_url(st: &AppState) -> String {
    let bind = st.cfg.bind;
    let ip = match bind.ip() {
        IpAddr::V4(a) if a.is_unspecified() => IpAddr::V4(Ipv4Addr::LOCALHOST),
        IpAddr::V6(a) if a.is_unspecified() => IpAddr::V6(Ipv6Addr::LOCALHOST),
        ip => ip,
    };
    match ip {
        IpAddr::V6(a) => format!("http://[{a}]:{}", bind.port()),
        IpAddr::V4(a) => format!("http://{a}:{}", bind.port()),
    }
}

pub async fn supervise(st: AppState) {
    let script = st.cfg.worker_script.clone();
    if !script.is_file() {
        tracing::warn!(
            "ingest worker not found at {} (set INGEST_WORKER): sources can be uploaded but will wait until it runs",
            script.display()
        );
        return;
    }
    let mut backoff = Duration::from_secs(2);
    loop {
        let started = std::time::Instant::now();
        let mut cmd = Command::new(&st.cfg.node_bin);
        cmd.arg(&script)
            .env_clear()
            .env("VS_SERVER", server_url(&st))
            .env("VS_WORKER_TOKEN", &st.worker_token)
            .env("OCR_DIR", &st.cfg.ocr_dir)
            .env("NODE_ENV", "production")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // Operating-system variables Node needs to start (Windows' crypto needs SYSTEMROOT); none hold secrets.
        for name in ["TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR"] {
            if let Ok(v) = std::env::var(name) {
                cmd.env(name, v);
            }
        }
        match cmd.spawn() {
            Ok(mut child) => {
                tracing::info!("ingest worker started (pid {:?})", child.id());
                st.worker_pid.store(child.id().unwrap_or(0), std::sync::atomic::Ordering::Relaxed);
                if let Some(out) = child.stdout.take() {
                    tokio::spawn(async move {
                        let mut lines = BufReader::new(out).lines();
                        while let Ok(Some(l)) = lines.next_line().await {
                            tracing::info!(target: "ingest_worker", "{l}");
                        }
                    });
                }
                if let Some(err) = child.stderr.take() {
                    tokio::spawn(async move {
                        let mut lines = BufReader::new(err).lines();
                        while let Ok(Some(l)) = lines.next_line().await {
                            tracing::warn!(target: "ingest_worker", "{l}");
                        }
                    });
                }
                match child.wait().await {
                    Ok(s) => tracing::warn!("ingest worker exited ({s})"),
                    Err(e) => tracing::error!("ingest worker: {e}"),
                }
                st.worker_pid.store(0, std::sync::atomic::Ordering::Relaxed);
            }
            Err(e) => tracing::error!("could not start the ingest worker with {}: {e}", st.cfg.node_bin.display()),
        }
        // A worker that ran for a while is restarted quickly; one that keeps failing at once, less and less often.
        if started.elapsed() > Duration::from_secs(60) {
            backoff = Duration::from_secs(2);
        } else {
            backoff = (backoff * 2).min(Duration::from_secs(300));
        }
        tokio::time::sleep(backoff).await;
    }
}
