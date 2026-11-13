//! Safe ZIP import, on-disk vault index, link resolution and the sidebar file tree.

use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{self, Read},
    path::{Component, Path, PathBuf},
    sync::{Arc, OnceLock},
};

use percent_encoding::{utf8_percent_encode, AsciiSet, NON_ALPHANUMERIC};
use walkdir::WalkDir;

// ---------------------------------------------------------------- file types

pub enum Kind {
    Note,
    Image,
    Audio,
    Video,
    Pdf,
    Other,
}

/// Whitelist of file types we keep from an upload, with the exact MIME type we serve them as.
pub fn mime_for(path: &str) -> Option<(&'static str, Kind)> {
    let ext = path.rsplit_once('.')?.1.to_ascii_lowercase();
    Some(match ext.as_str() {
        "md" => ("text/plain; charset=utf-8", Kind::Note),
        "png" => ("image/png", Kind::Image),
        "jpg" | "jpeg" => ("image/jpeg", Kind::Image),
        "gif" => ("image/gif", Kind::Image),
        "webp" => ("image/webp", Kind::Image),
        "avif" => ("image/avif", Kind::Image),
        "bmp" => ("image/bmp", Kind::Image),
        "svg" => ("image/svg+xml", Kind::Image),
        "mp3" => ("audio/mpeg", Kind::Audio),
        "wav" => ("audio/wav", Kind::Audio),
        "ogg" => ("audio/ogg", Kind::Audio),
        "m4a" => ("audio/mp4", Kind::Audio),
        "flac" => ("audio/flac", Kind::Audio),
        "mp4" => ("video/mp4", Kind::Video),
        "webm" => ("video/webm", Kind::Video),
        "mov" => ("video/quicktime", Kind::Video),
        "pdf" => ("application/pdf", Kind::Pdf),
        "txt" => ("text/plain; charset=utf-8", Kind::Other),
        "csv" => ("text/csv; charset=utf-8", Kind::Other),
        "canvas" => ("application/json", Kind::Other),
        "excalidraw" => ("application/json", Kind::Other),
        "docx" => ("application/vnd.openxmlformats-officedocument.wordprocessingml.document", Kind::Other),
        "xlsx" => ("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", Kind::Other),
        "pptx" => ("application/vnd.openxmlformats-officedocument.presentationml.presentation", Kind::Other),
        _ => return None,
    })
}

pub fn is_office(path: &str) -> bool {
    path.rsplit_once('.').is_some_and(|(_, e)| e.eq_ignore_ascii_case("docx") || e.eq_ignore_ascii_case("pptx"))
}

pub fn is_note(path: &str) -> bool {
    matches!(mime_for(path), Some((_, Kind::Note)))
}

/// A path component we are willing to store/serve: visible, printable, sane length.
fn component_ok(c: &str) -> bool {
    !c.is_empty()
        && c.len() <= 255
        && !c.starts_with('.')
        && c != "__MACOSX"
        && !c.chars().any(|ch| ch.is_control() || matches!(ch, '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

pub fn is_valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}

// ---------------------------------------------------------------- import

pub struct Limits {
    pub max_total: u64,
    pub max_file: u64,
    pub max_files: usize,
}

pub struct ImportStats {
    pub files: usize,
    pub bytes: u64,
    pub skipped: usize,
}

#[derive(Debug)]
pub enum ImportError {
    /// Safe to show to the uploader.
    Invalid(String),
    Io(io::Error),
}

impl From<io::Error> for ImportError {
    fn from(e: io::Error) -> Self {
        ImportError::Io(e)
    }
}

fn invalid<T>(msg: impl Into<String>) -> Result<T, ImportError> {
    Err(ImportError::Invalid(msg.into()))
}

/// Extract `zip_path` into `vaults_dir/<vault_id>`, atomically replacing any previous version.
///
/// Protections: path traversal (zip-slip), absolute paths, symlinks, hidden/config folders,
/// non-whitelisted file types, encrypted entries, duplicate names, and zip bombs (byte limits
/// are enforced on the *actual* decompressed stream, not the header's claimed size).
pub fn import_zip(
    zip_path: &Path,
    vaults_dir: &Path,
    vault_id: &str,
    limits: &Limits,
) -> Result<ImportStats, ImportError> {
    assert!(is_valid_id(vault_id));
    let file = fs::File::open(zip_path)?;
    let mut archive = match zip::ZipArchive::new(io::BufReader::new(file)) {
        Ok(a) => a,
        Err(_) => return invalid("That file is not a valid ZIP archive."),
    };
    if archive.len() > limits.max_files.saturating_mul(4) + 1000 {
        return invalid("The archive contains too many entries.");
    }

    // Pass 1: decide which entries to keep and compute a common top-level folder to strip
    // (zipping a folder usually produces `MyVault/...`).
    let mut keep: Vec<(usize, Vec<String>)> = Vec::new();
    let mut skipped = 0usize;
    for i in 0..archive.len() {
        let entry = match archive.by_index_raw(i) {
            Ok(e) => e,
            Err(_) => return invalid("The archive is damaged."),
        };
        if entry.is_dir() {
            continue;
        }
        let Some(name) = entry.enclosed_name() else {
            return invalid("The archive contains unsafe file paths.");
        };
        if entry.is_symlink() || entry.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000) {
            skipped += 1;
            continue;
        }
        if entry.encrypted() {
            return invalid("Password-protected ZIP files are not supported.");
        }
        let mut comps = Vec::new();
        let mut ok = true;
        for c in name.components() {
            match c {
                Component::Normal(s) => match s.to_str() {
                    Some(s) if component_ok(s) => comps.push(s.to_string()),
                    _ => ok = false,
                },
                _ => ok = false,
            }
        }
        let joined = comps.join("/");
        if !ok || comps.is_empty() || joined.len() > 1024 || mime_for(&joined).is_none() {
            skipped += 1;
            continue;
        }
        keep.push((i, comps));
    }
    if keep.len() > limits.max_files {
        return invalid(format!("The vault has more than {} files.", limits.max_files));
    }
    let strip = match keep.first() {
        Some((_, first)) if first.len() > 1 => {
            let root = &first[0];
            keep.iter().all(|(_, c)| c.len() > 1 && &c[0] == root)
        }
        _ => false,
    };
    if !keep.iter().any(|(_, c)| is_note(c.last().map(String::as_str).unwrap_or(""))) {
        return invalid("No Markdown (.md) notes were found in that ZIP. Zip your vault folder and try again.");
    }

    // Pass 2: extract into a private staging directory.
    let staging = vaults_dir.join(format!(".staging-{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&staging)?;
    let result = (|| -> Result<ImportStats, ImportError> {
        let mut total: u64 = 0;
        for (i, comps) in &keep {
            let rel: PathBuf = comps.iter().skip(usize::from(strip)).collect();
            let dest = staging.join(&rel);
            debug_assert!(dest.starts_with(&staging));
            if let Some(parent) = dest.parent() {
                fs::create_dir_all(parent)?;
            }
            let mut entry = match archive.by_index(*i) {
                Ok(e) => e,
                Err(_) => return invalid("The archive is damaged or uses an unsupported compression method."),
            };
            let cap = limits.max_file.min(limits.max_total.saturating_sub(total));
            if entry.size() > cap {
                return invalid("The archive is larger than the allowed size once extracted.");
            }
            let mut out = match fs::OpenOptions::new().write(true).create_new(true).open(&dest) {
                Ok(f) => f,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                    return invalid("The archive contains duplicate file names.")
                }
                Err(e) => return Err(e.into()),
            };
            let written = match io::copy(&mut (&mut entry).take(cap + 1), &mut out) {
                Ok(n) => n,
                Err(e) if e.kind() == io::ErrorKind::InvalidData => return invalid("The archive is damaged."),
                Err(e) => return Err(e.into()),
            };
            if written > cap {
                return invalid("The archive expands beyond the allowed size (possible ZIP bomb).");
            }
            total += written;
        }
        Ok(ImportStats { files: keep.len(), bytes: total, skipped })
    })();

    let stats = match result {
        Ok(s) => s,
        Err(e) => {
            let _ = fs::remove_dir_all(&staging);
            return Err(e);
        }
    };

    let final_dir = vaults_dir.join(vault_id);
    if final_dir.exists() {
        let old = vaults_dir.join(format!(".old-{}", uuid::Uuid::new_v4().simple()));
        fs::rename(&final_dir, &old)?;
        if let Err(e) = fs::rename(&staging, &final_dir) {
            let _ = fs::rename(&old, &final_dir);
            let _ = fs::remove_dir_all(&staging);
            return Err(e.into());
        }
        let _ = fs::remove_dir_all(&old);
    } else {
        fs::rename(&staging, &final_dir)?;
    }
    Ok(stats)
}

/// Remove leftovers from interrupted imports.
pub fn cleanup_dirs(vaults_dir: &Path, tmp_dir: &Path) {
    if let Ok(rd) = fs::read_dir(vaults_dir) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with(".staging-") || name.starts_with(".old-") || name.starts_with(".trash-") {
                let _ = fs::remove_dir_all(e.path());
            }
        }
    }
    if let Ok(rd) = fs::read_dir(tmp_dir) {
        for e in rd.flatten() {
            let _ = fs::remove_file(e.path());
        }
    }
}

// ---------------------------------------------------------------- index

pub struct VaultIndex {
    pub root: PathBuf,
    /// Relative paths using `/`, sorted.
    pub files: Vec<String>,
    /// Folders (relative paths), including empty ones, so they can be shown and created.
    pub dirs: Vec<String>,
    by_lower_path: HashMap<String, String>,
    by_lower_name: HashMap<String, Vec<String>>,
    graph: OnceLock<Arc<String>>,
    links: OnceLock<Arc<crate::graph::Links>>,
}

impl VaultIndex {
    /// Link graph as JSON, computed on first request and cached until the vault changes.
    pub fn graph_json(&self, vault_id: &str) -> Arc<String> {
        self.graph.get_or_init(|| Arc::new(crate::graph::build(self, vault_id))).clone()
    }

    /// Backlinks and original<->note pairing, computed on first use and cached until the vault changes.
    pub fn links(&self) -> Arc<crate::graph::Links> {
        self.links.get_or_init(|| Arc::new(crate::graph::Links::build(self))).clone()
    }

    pub fn build(root: &Path) -> io::Result<Self> {
        let mut files = Vec::new();
        let mut dirs = Vec::new();
        if root.exists() {
            for entry in WalkDir::new(root).follow_links(false).max_depth(32) {
                let entry = entry.map_err(io::Error::other)?;
                if entry.file_type().is_dir() && entry.depth() > 0 {
                    if let Ok(rel) = entry.path().strip_prefix(root) {
                        let parts: Vec<&str> = rel.components().filter_map(|c| c.as_os_str().to_str()).collect();
                        if parts.len() == rel.components().count() && parts.iter().all(|c| component_ok(c)) {
                            dirs.push(parts.join("/"));
                        }
                    }
                    continue;
                }
                if !entry.file_type().is_file() {
                    continue; // skips symlinks
                }
                let Ok(rel) = entry.path().strip_prefix(root) else { continue };
                let mut parts = Vec::new();
                let mut ok = true;
                for c in rel.components() {
                    match c {
                        Component::Normal(s) => match s.to_str() {
                            Some(s) if component_ok(s) => parts.push(s),
                            _ => ok = false,
                        },
                        _ => ok = false,
                    }
                }
                let rel = parts.join("/");
                if ok && mime_for(&rel).is_some() {
                    files.push(rel);
                }
            }
        }
        files.sort_by_key(|f| f.to_lowercase());
        dirs.sort_by_key(|d| d.to_lowercase());
        let mut by_lower_path = HashMap::new();
        let mut by_lower_name: HashMap<String, Vec<String>> = HashMap::new();
        for f in &files {
            let lower = f.to_lowercase();
            let name = lower.rsplit('/').next().unwrap_or(&lower).to_string();
            by_lower_path.insert(lower, f.clone());
            by_lower_name.entry(name).or_default().push(f.clone());
        }
        Ok(VaultIndex { root: root.to_path_buf(), files, dirs, by_lower_path, by_lower_name, graph: OnceLock::new(), links: OnceLock::new() })
    }

    pub fn contains(&self, rel: &str) -> bool {
        self.by_lower_path.get(&rel.to_lowercase()).is_some_and(|p| p == rel)
    }

    /// Absolute on-disk path for an indexed file. Returns None for anything not in the index,
    /// which rules out traversal, hidden files and symlinks.
    pub fn disk_path(&self, rel: &str) -> Option<PathBuf> {
        if !self.contains(rel) {
            return None;
        }
        let p = rel.split('/').fold(self.root.clone(), |acc, c| acc.join(c));
        Some(p)
    }

    pub fn notes(&self) -> impl Iterator<Item = &String> {
        self.files.iter().filter(|f| is_note(f))
    }

    /// Resolve an Obsidian link target (`Note`, `Folder/Note`, `image.png`) like Obsidian does:
    /// exact path first, then path-suffix / basename match, preferring the shortest path.
    pub fn resolve(&self, target: &str) -> Option<&str> {
        let t = target.trim().trim_start_matches('/').replace('\\', "/");
        if t.is_empty() {
            return None;
        }
        let lower = t.to_lowercase();
        let mut candidates = vec![];
        if mime_for(&lower).is_none() || !lower.contains('.') {
            candidates.push(format!("{lower}.md"));
        }
        candidates.push(lower);
        for c in &candidates {
            if let Some(p) = self.by_lower_path.get(c) {
                return Some(p);
            }
        }
        for c in &candidates {
            let name = c.rsplit('/').next().unwrap_or(c);
            let Some(list) = self.by_lower_name.get(name) else { continue };
            let suffix = format!("/{c}");
            let best = list
                .iter()
                .filter(|p| !c.contains('/') || p.to_lowercase().ends_with(&suffix))
                .min_by_key(|p| (p.matches('/').count(), p.len()));
            if let Some(b) = best {
                return Some(b);
            }
        }
        None
    }

    /// The note to open when a vault is first visited.
    pub fn home_note(&self) -> Option<&str> {
        for name in ["readme.md", "index.md", "home.md", "welcome.md", "start here.md"] {
            if let Some(p) = self.by_lower_path.get(name) {
                return Some(p);
            }
        }
        self.notes().find(|n| !n.contains('/')).or_else(|| self.notes().next()).map(String::as_str)
    }

    /// Sidebar tree as HTML. Every dynamic string is escaped.
    pub fn tree_html(&self, vault_id: &str, current: Option<&str>) -> String {
        #[derive(Default)]
        struct Dir<'a> {
            dirs: BTreeMap<String, (&'a str, Dir<'a>)>,
            files: Vec<(&'a str, &'a str)>,
        }
        let mut root = Dir::default();
        for d in &self.dirs {
            let mut node = &mut root;
            for p in d.split('/') {
                node = &mut node.dirs.entry(p.to_lowercase()).or_insert_with(|| (p, Dir::default())).1;
            }
        }
        for f in &self.files {
            let mut node = &mut root;
            let mut parts: Vec<&str> = f.split('/').collect();
            let file = parts.pop().unwrap_or("");
            for p in parts {
                node = &mut node.dirs.entry(p.to_lowercase()).or_insert_with(|| (p, Dir::default())).1;
            }
            node.files.push((file, f));
        }
        fn walk(d: &Dir, prefix: &str, vault_id: &str, current: Option<&str>, out: &mut String) {
            out.push_str("<ul>");
            for (name, sub) in d.dirs.values() {
                let path = if prefix.is_empty() { name.to_string() } else { format!("{prefix}/{name}") };
                let open = current.is_some_and(|c| c.starts_with(&format!("{path}/")));
                out.push_str(if open { "<li class=\"dir\"><details open><summary" } else { "<li class=\"dir\"><details><summary" });
                out.push_str(&format!(" data-path=\"{}\" data-dir=\"1\">", esc(&path)));
                out.push_str(&esc(name));
                out.push_str("</summary>");
                walk(sub, &path, vault_id, current, out);
                out.push_str("</details></li>");
            }
            for (name, path) in &d.files {
                let note = is_note(name);
                let label = if note { name.strip_suffix(".md").or(name.strip_suffix(".MD")).unwrap_or(name) } else { name };
                let url = if note { note_url(vault_id, path) } else { link_url(vault_id, path) };
                let is_current = current == Some(*path);
                out.push_str(&format!(
                    "<li class=\"{}\"><a href=\"{}\" data-path=\"{}\"{}>{}</a></li>",
                    if note { "note" } else { "att" },
                    esc(&url),
                    esc(path),
                    if is_current { " aria-current=\"page\"" } else { "" },
                    esc(label)
                ));
            }
            out.push_str("</ul>");
        }
        let mut out = String::new();
        walk(&root, "", vault_id, current, &mut out);
        out
    }
}

// ---------------------------------------------------------------- editing: safe paths and file operations
//
// Everything that changes a vault on disk goes through these helpers. Paths are checked component by
// component (no `..`, no hidden folders, no odd characters), parents may not be symlinks, writes are
// atomic (temp file + rename) and deletes only ever move things into the hidden `.trash` folder.

/// Largest note the editor will save.
pub const MAX_EDIT_BYTES: usize = 5 * 1024 * 1024;

/// Normalise a user-supplied relative path. Returns None for anything unsafe or unreasonable.
pub fn safe_rel(path: &str) -> Option<String> {
    let p = path.trim().trim_matches('/').replace('\\', "/");
    if p.is_empty() || p.len() > 400 {
        return None;
    }
    let parts: Vec<&str> = p.split('/').collect();
    if parts.len() > 32 || !parts.iter().all(|c| component_ok(c)) {
        return None;
    }
    Some(parts.join("/"))
}

fn abs_path(root: &Path, rel: &str) -> PathBuf {
    rel.split('/').fold(root.to_path_buf(), |acc, c| acc.join(c))
}

/// True when none of the existing ancestors of `rel` (inside `root`) is a symlink.
fn no_symlink_ancestors(root: &Path, rel: &str) -> bool {
    let mut cur = root.to_path_buf();
    for c in rel.split('/') {
        cur.push(c);
        match fs::symlink_metadata(&cur) {
            Ok(m) if m.file_type().is_symlink() => return false,
            Ok(_) => {}
            Err(_) => break, // does not exist yet: nothing further to check
        }
    }
    true
}

/// On-disk path of a note that may not be indexed yet (editing reads straight from disk).
pub fn note_disk_path(root: &Path, rel: &str) -> Option<PathBuf> {
    let p = abs_path(root, rel);
    fs::symlink_metadata(&p).ok().filter(|m| m.is_file() && no_symlink_ancestors(root, rel)).map(|_| p)
}

pub fn path_exists(root: &Path, rel: &str) -> bool {
    fs::symlink_metadata(abs_path(root, rel)).is_ok()
}

/// Write a file atomically, creating parent folders.
pub fn write_atomic(root: &Path, rel: &str, bytes: &[u8]) -> io::Result<()> {
    if !no_symlink_ancestors(root, rel) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "unsafe path"));
    }
    let dest = abs_path(root, rel);
    let parent = dest.parent().ok_or_else(|| io::Error::other("no parent"))?;
    fs::create_dir_all(parent)?;
    let tmp = parent.join(format!(".tmp-{}", uuid::Uuid::new_v4().simple()));
    let res = (|| {
        use std::io::Write;
        let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        fs::rename(&tmp, &dest)
    })();
    if res.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    res
}

pub fn create_dir(root: &Path, rel: &str) -> io::Result<()> {
    if !no_symlink_ancestors(root, rel) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "unsafe path"));
    }
    fs::create_dir_all(abs_path(root, rel))
}

/// Move a file or folder to `.trash/<timestamp>/<path>` instead of deleting it.
pub fn move_to_trash(root: &Path, rel: &str) -> io::Result<()> {
    if !no_symlink_ancestors(root, rel) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "unsafe path"));
    }
    let stamp = format!(
        "{}-{}",
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0),
        &uuid::Uuid::new_v4().simple().to_string()[..4]
    );
    let dest = abs_path(&root.join(".trash").join(stamp), rel);
    fs::create_dir_all(dest.parent().ok_or_else(|| io::Error::other("no parent"))?)?;
    fs::rename(abs_path(root, rel), dest)
}

/// Rename or move a file/folder. Refuses to overwrite and to move a folder into itself.
pub fn rename_path(root: &Path, from: &str, to: &str) -> io::Result<()> {
    if !no_symlink_ancestors(root, from) || !no_symlink_ancestors(root, to) {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "unsafe path"));
    }
    if to == from || to.starts_with(&format!("{from}/")) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "cannot move a folder into itself"));
    }
    if path_exists(root, to) {
        return Err(io::Error::new(io::ErrorKind::AlreadyExists, "target exists"));
    }
    let dest = abs_path(root, to);
    fs::create_dir_all(dest.parent().ok_or_else(|| io::Error::other("no parent"))?)?;
    fs::rename(abs_path(root, from), dest)
}

/// File count and total size of the indexed files of a vault (used to keep the vault card up to date).
pub fn dir_stats(root: &Path) -> (i64, i64) {
    let (mut files, mut bytes) = (0i64, 0i64);
    for e in WalkDir::new(root).follow_links(false).max_depth(32).into_iter().flatten() {
        if !e.file_type().is_file() {
            continue;
        }
        let Ok(rel) = e.path().strip_prefix(root) else { continue };
        let ok = rel.components().all(|c| matches!(c, Component::Normal(s) if s.to_str().is_some_and(component_ok)));
        if ok && rel.to_str().is_some_and(|r| mime_for(r).is_some()) {
            files += 1;
            bytes += e.metadata().map(|m| m.len() as i64).unwrap_or(0);
        }
    }
    (files, bytes)
}


// ---------------------------------------------------------------- backups

/// Zip the current contents of a vault into `backups/<vault_id>/<unix time>.zip` and keep the newest few.
/// Called before a re-upload replaces the vault, because the upload would otherwise wipe edits made on the site.
pub fn backup_vault(vault_dir: &Path, backups_dir: &Path, vault_id: &str) -> io::Result<Option<PathBuf>> {
    if !vault_dir.is_dir() {
        return Ok(None);
    }
    let dir = backups_dir.join(vault_id);
    fs::create_dir_all(&dir)?;
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let dest = dir.join(format!("{stamp}.zip"));
    let tmp = dir.join(format!(".{stamp}.partial"));
    let res = (|| -> io::Result<()> {
        let file = fs::File::create(&tmp)?;
        let mut zw = zip::ZipWriter::new(io::BufWriter::new(file));
        let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for e in WalkDir::new(vault_dir).follow_links(false).max_depth(32).into_iter().flatten() {
            let Ok(rel) = e.path().strip_prefix(vault_dir) else { continue };
            let name = rel.to_string_lossy().replace('\\', "/");
            if name.is_empty() || name.split('/').any(|c| c.starts_with(".tmp-")) {
                continue;
            }
            if e.file_type().is_dir() {
                zw.add_directory(format!("{name}/"), opts).map_err(io::Error::other)?;
            } else if e.file_type().is_file() {
                zw.start_file(name, opts).map_err(io::Error::other)?;
                io::copy(&mut fs::File::open(e.path())?, &mut zw)?;
            }
        }
        zw.finish().map_err(io::Error::other)?;
        Ok(())
    })();
    if let Err(e) = res {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    fs::rename(&tmp, &dest)?;
    // keep the newest three
    let mut all = list_backups(backups_dir, vault_id);
    all.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, old, _) in all.into_iter().skip(3) {
        let _ = fs::remove_file(dir.join(old));
    }
    Ok(Some(dest))
}

/// `(unix time, file name, bytes)` of each backup of a vault.
pub fn list_backups(backups_dir: &Path, vault_id: &str) -> Vec<(u64, String, u64)> {
    let mut out = Vec::new();
    if let Ok(rd) = fs::read_dir(backups_dir.join(vault_id)) {
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if let Some(ts) = name.strip_suffix(".zip").and_then(|s| s.parse::<u64>().ok()) {
                out.push((ts, name, e.metadata().map(|m| m.len()).unwrap_or(0)));
            }
        }
    }
    out.sort_by(|a, b| b.0.cmp(&a.0));
    out
}


// ---------------------------------------------------------------- urls & escaping

const SEGMENT: &AsciiSet = &NON_ALPHANUMERIC.remove(b'-').remove(b'.').remove(b'_').remove(b'~');

pub fn encode_path(rel: &str) -> String {
    rel.split('/').map(|s| utf8_percent_encode(s, SEGMENT).to_string()).collect::<Vec<_>>().join("/")
}

pub fn note_url(vault_id: &str, rel: &str) -> String {
    format!("/v/{vault_id}/n/{}", encode_path(rel))
}

pub fn file_url(vault_id: &str, rel: &str) -> String {
    format!("/v/{vault_id}/f/{}", encode_path(rel))
}

/// Viewer page for a Word/PowerPoint original.
pub fn office_url(vault_id: &str, rel: &str) -> String {
    format!("/v/{vault_id}/o/{}", encode_path(rel))
}

/// Where a link to an attachment should go: Office documents open in the viewer, the rest are served directly.
pub fn link_url(vault_id: &str, rel: &str) -> String {
    if is_office(rel) { office_url(vault_id, rel) } else { file_url(vault_id, rel) }
}

pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn component_rules() {
        assert!(component_ok("Notes"));
        assert!(!component_ok(".obsidian"));
        assert!(!component_ok("__MACOSX"));
        assert!(!component_ok("a:b"));
        assert!(!component_ok(""));
    }

    #[test]
    fn ids() {
        assert!(is_valid_id("0123456789abcdef0123456789abcdef"));
        assert!(!is_valid_id("../../etc/passwd"));
        assert!(!is_valid_id("0123456789ABCDEF0123456789ABCDEF"));
    }

    #[test]
    fn encodes_paths() {
        assert_eq!(encode_path("My Folder/Note #1.md"), "My%20Folder/Note%20%231.md");
    }
}
