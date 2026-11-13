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
    by_lower_path: HashMap<String, String>,
    by_lower_name: HashMap<String, Vec<String>>,
    graph: OnceLock<Arc<String>>,
}

impl VaultIndex {
    /// Link graph as JSON, computed on first request and cached until the vault changes.
    pub fn graph_json(&self, vault_id: &str) -> Arc<String> {
        self.graph.get_or_init(|| Arc::new(crate::graph::build(self, vault_id))).clone()
    }

    pub fn build(root: &Path) -> io::Result<Self> {
        let mut files = Vec::new();
        if root.exists() {
            for entry in WalkDir::new(root).follow_links(false).max_depth(32) {
                let entry = entry.map_err(io::Error::other)?;
                if !entry.file_type().is_file() {
                    continue; // skips symlinks and directories
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
        let mut by_lower_path = HashMap::new();
        let mut by_lower_name: HashMap<String, Vec<String>> = HashMap::new();
        for f in &files {
            let lower = f.to_lowercase();
            let name = lower.rsplit('/').next().unwrap_or(&lower).to_string();
            by_lower_path.insert(lower, f.clone());
            by_lower_name.entry(name).or_default().push(f.clone());
        }
        Ok(VaultIndex { root: root.to_path_buf(), files, by_lower_path, by_lower_name, graph: OnceLock::new() })
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
                out.push_str(if open { "<li class=\"dir\"><details open><summary>" } else { "<li class=\"dir\"><details><summary>" });
                out.push_str(&esc(name));
                out.push_str("</summary>");
                walk(sub, &path, vault_id, current, out);
                out.push_str("</details></li>");
            }
            for (name, path) in &d.files {
                let note = is_note(name);
                let label = if note { name.strip_suffix(".md").or(name.strip_suffix(".MD")).unwrap_or(name) } else { name };
                let url = if note { note_url(vault_id, path) } else { file_url(vault_id, path) };
                let is_current = current == Some(*path);
                out.push_str(&format!(
                    "<li class=\"{}\"><a href=\"{}\"{}>{}</a></li>",
                    if note { "note" } else { "att" },
                    esc(&url),
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
