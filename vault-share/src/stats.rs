//! Live resource figures for the tracker in the top right of every page: the machine the site runs on (the NAS:
//! its CPU, memory and the disk holding the data folder) and the site itself (this server plus its ingest worker).
//!
//! Figures are sampled at most every 1.5 seconds, however many pages ask. Inside a container /proc/stat and
//! /proc/meminfo are the host's, so the NAS figures are the whole machine's; the site's are its own processes,
//! with the container's limits where it has them.

use std::{
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

pub struct Sampler {
    /// None until first used, or when this platform has no figures to give.
    sys: Option<System>,
    disks: Option<Disks>,
    last: Option<Instant>,
    disks_at: Option<Instant>,
    snapshot: Value,
}

impl Default for Sampler {
    fn default() -> Self {
        Sampler { sys: None, disks: None, last: None, disks_at: None, snapshot: json!(null) }
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
        self.snapshot.clone()
    }
}

pub async fn stats(State(st): State<AppState>, _user: CurrentUser) -> ApiResult {
    let st2 = st.clone();
    let snap = tokio::task::spawn_blocking(move || {
        let pid = st2.worker_pid.load(std::sync::atomic::Ordering::Relaxed);
        let mut s = st2.stats.lock().unwrap_or_else(|e| e.into_inner());
        s.sample(&st2.cfg.data_dir, pid)
    })
    .await?;
    ok(snap)
}

pub type Stats = Mutex<Sampler>;
