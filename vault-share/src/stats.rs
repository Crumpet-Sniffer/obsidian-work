//! Live resource figures for the tracker in the top right of every page: the machine the site runs on (the NAS:
//! its CPU, memory and the disk holding the data folder) and the site itself (this server plus its ingest worker).
//!
//! Figures are sampled at most every 1.5 seconds, however many pages ask. Inside a container /proc/stat and
//! /proc/meminfo are the host's, so the NAS figures are the whole machine's; the site's are its own processes,
//! with the container's limits where it has them.

use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, Instant},
};

use axum::extract::State;
use serde_json::{json, Value};
use sysinfo::{Disks, Pid, ProcessRefreshKind, ProcessesToUpdate, System};

use crate::{
    auth::CurrentUser,
    handlers::edit::{ok, ApiResult},
    AppState,
};

const MIN_INTERVAL: Duration = Duration::from_millis(1500);
/// The resource history on the admin page: a sample every two seconds, kept for two minutes.
pub const HISTORY_EVERY: Duration = Duration::from_secs(2);
const HISTORY_SECS: i64 = 120;

pub struct Sampler {
    /// None until first used, or when this platform has no figures to give.
    sys: Option<System>,
    disks: Option<Disks>,
    last: Option<Instant>,
    disks_at: Option<Instant>,
    snapshot: Value,
    /// The last two minutes, oldest first: (unix seconds, NAS CPU %, NAS memory %, site CPU %, site memory %).
    history: VecDeque<(i64, Option<f64>, Option<f64>, Option<f64>, Option<f64>)>,
}

impl Default for Sampler {
    fn default() -> Self {
        Sampler { sys: None, disks: None, last: None, disks_at: None, snapshot: json!(null), history: VecDeque::new() }
    }
}

/// CPUs the container may use (cgroup v2 `cpu.max`), when it is limited.
fn cgroup_cpus() -> Option<f64> {
    let s = std::fs::read_to_string("/sys/fs/cgroup/cpu.max").ok()?;
    let mut it = s.split_whitespace();
    let quota: f64 = it.next()?.parse().ok()?; // "max" fails to parse: no limit
    let period: f64 = it.next()?.parse().ok()?;
    (period > 0.0).then_some(quota / period)
}

/// Memory the container may use (cgroup v2 `memory.max`), when it is limited.
fn cgroup_memory() -> Option<u64> {
    std::fs::read_to_string("/sys/fs/cgroup/memory.max").ok()?.trim().parse().ok()
}

/// Memory the container is using, page cache included, as the limit counts it (cgroup v2 `memory.current`).
fn cgroup_memory_used() -> Option<u64> {
    std::fs::read_to_string("/sys/fs/cgroup/memory.current").ok()?.trim().parse().ok()
}

impl Sampler {
    fn sample(&mut self, data_dir: &std::path::Path, worker_pid: u32) -> Value {
        if self.last.is_some_and(|t| t.elapsed() < MIN_INTERVAL) {
            return self.snapshot.clone();
        }
        if self.sys.is_none() {
            match System::new() {
                Ok(s) => self.sys = Some(s),
                Err(e) => {
                    tracing::warn!("resource figures are not available here: {e}");
                    self.last = Some(Instant::now() + Duration::from_secs(3600));
                    return self.snapshot.clone();
                }
            }
        }
        if self.disks.is_none() {
            self.disks = Disks::new().ok();
        }
        let sys = self.sys.as_mut().expect("set above");
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let me = Pid::from_u32(std::process::id());
        let mut pids = vec![me];
        if worker_pid != 0 {
            pids.push(Pid::from_u32(worker_pid));
        }
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&pids),
            true,
            ProcessRefreshKind::nothing().with_cpu().with_memory(),
        );
        // Disk sizes change slowly; the list is read again every half minute.
        if let Some(d) = self.disks.as_mut().filter(|_| self.disks_at.is_none_or(|t| t.elapsed() > Duration::from_secs(30))) {
            d.refresh(true);
            self.disks_at = Some(Instant::now());
        }

        let cores = sys.cpus().len().max(1);
        // The first sample has nothing to compare with, so CPU figures start on the second.
        let first = self.last.is_none();
        let nas_cpu = if first { None } else { Some(sys.global_cpu_usage() as f64) };

        let data = std::fs::canonicalize(data_dir).unwrap_or_else(|_| data_dir.to_path_buf());
        // Windows gives canonical paths a `\\?\` prefix that mount points do not have.
        let data = std::path::PathBuf::from(data.to_string_lossy().trim_start_matches(r"\\?\").to_string());
        let disk = self
            .disks
            .iter()
            .flat_map(|d| d.iter())
            .filter(|d| data.starts_with(d.mount_point()))
            .max_by_key(|d| d.mount_point().as_os_str().len())
            .map(|d| json!({ "total": d.total_space(), "used": d.total_space().saturating_sub(d.available_space()) }));

        let mut app_cpu = 0f64; // percent of one core
        let mut app_mem = 0u64;
        let mut worker = false;
        for pid in &pids {
            if let Some(p) = sys.process(*pid) {
                app_cpu += p.cpu_usage() as f64;
                app_mem += p.memory();
                if *pid != me {
                    worker = true;
                }
            }
        }
        let cpu_limit = cgroup_cpus().filter(|c| *c < cores as f64);
        let mem_limit = cgroup_memory().filter(|m| *m < sys.total_memory());
        let app_cpu_share = cpu_limit.unwrap_or(cores as f64);

        self.snapshot = json!({
            "nas": {
                "cpu": nas_cpu,
                "cores": cores,
                "memUsed": sys.used_memory(),
                "memTotal": sys.total_memory(),
                "disk": disk,
            },
            "app": {
                // Percent of the CPUs the site may use (the container's limit, or the whole machine).
                "cpu": if first { None } else { Some(app_cpu / app_cpu_share) },
                "cpuLimit": cpu_limit,
                "mem": app_mem,
                "memContainer": mem_limit.and(cgroup_memory_used()),
                "memLimit": mem_limit,
                "worker": worker,
            },
        });
        self.last = Some(Instant::now());
        // The same figures as percentages of what there is, for the history.
        let pct = |used: f64, of: f64| if of > 0.0 { Some((used / of * 100.0).clamp(0.0, 100.0)) } else { None };
        let app_mem_used = mem_limit.and(cgroup_memory_used()).unwrap_or(app_mem) as f64;
        let now = crate::db::now();
        self.history.push_back((
            now,
            nas_cpu.map(|c| c.clamp(0.0, 100.0)),
            pct(sys.used_memory() as f64, sys.total_memory() as f64),
            if first { None } else { Some((app_cpu / app_cpu_share).clamp(0.0, 100.0)) },
            pct(app_mem_used, mem_limit.unwrap_or(sys.total_memory()) as f64),
        ));
        while self.history.front().is_some_and(|h| h.0 < now - HISTORY_SECS) {
            self.history.pop_front();
        }
        self.snapshot.clone()
    }

    /// The last two minutes as JSON for the admin page's chart.
    fn history_json(&self) -> Value {
        let round = |v: Option<f64>| v.map(|x| (x * 10.0).round() / 10.0);
        json!({
            "seconds": HISTORY_SECS,
            "every": HISTORY_EVERY.as_secs(),
            "points": self.history.iter().map(|(t, nc, nm, ac, am)| json!({ "t": t, "nasCpu": round(*nc), "nasMem": round(*nm), "appCpu": round(*ac), "appMem": round(*am) })).collect::<Vec<_>>(),
        })
    }
}

/// Take a sample (for the history) every two seconds, whether or not a page is asking.
pub async fn keep_history(st: AppState) {
    let mut tick = tokio::time::interval(HISTORY_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tick.tick().await;
        let st2 = st.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let pid = st2.worker_pid.load(std::sync::atomic::Ordering::Relaxed);
            let mut s = st2.stats.lock().unwrap_or_else(|e| e.into_inner());
            s.sample(&st2.cfg.data_dir, pid);
        })
        .await;
    }
}

/// The last two minutes of CPU and memory use, for the chart on the admin page (admins only).
pub async fn history(State(st): State<AppState>, user: CurrentUser) -> ApiResult {
    if !user.is_admin {
        return Err(crate::handlers::edit::ApiErr::Forbidden("Only an admin can see this.".into()));
    }
    let st2 = st.clone();
    let v = tokio::task::spawn_blocking(move || st2.stats.lock().unwrap_or_else(|e| e.into_inner()).history_json()).await?;
    ok(v)
}

/// How far back the spend figure in the tracker looks.
const SPEND_WINDOW: i64 = 30 * 60;

pub async fn stats(State(st): State<AppState>, user: CurrentUser) -> ApiResult {
    let st2 = st.clone();
    let mut snap = tokio::task::spawn_blocking(move || {
        let pid = st2.worker_pid.load(std::sync::atomic::Ordering::Relaxed);
        let mut s = st2.stats.lock().unwrap_or_else(|e| e.into_inner());
        s.sample(&st2.cfg.data_dir, pid)
    })
    .await?;
    // What calls to Claude cost in the last half hour: the whole site's for an admin, otherwise the account's own.
    let since = crate::db::now() - SPEND_WINDOW;
    let (micro, calls) = st.db.usage_since(since, if user.is_admin { None } else { Some(user.id) }).await?;
    let usd = crate::spend::usd(micro);
    if snap.is_null() {
        snap = json!({});
    }
    snap["spend"] = json!({
        "amount": crate::spend::fmt_usd(usd),
        "usd": usd,
        "calls": calls,
        "minutes": SPEND_WINDOW / 60,
        "everyone": user.is_admin,
    });
    ok(snap)
}

pub type Stats = Mutex<Sampler>;
