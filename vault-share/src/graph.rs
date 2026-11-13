//! Link graph of a vault (notes + linked attachments), serialized once per upload.

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::{
    markdown::{link_targets, LinkTarget},
    vault::{file_url, is_note, note_url, VaultIndex},
};

const MAX_NOTE_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Serialize)]
struct Node<'a> {
    label: &'a str,
    path: &'a str,
    url: String,
    kind: &'static str,
}

#[derive(Serialize)]
struct Graph<'a> {
    nodes: Vec<Node<'a>>,
    links: Vec<[usize; 2]>,
}

fn label(path: &str) -> &str {
    let name = path.rsplit('/').next().unwrap_or(path);
    name.strip_suffix(".md").unwrap_or(name)
}

/// Resolve `[text](rel/path.md)` relative to the linking note's folder, falling back to
/// Obsidian-style name lookup.
fn resolve_relative<'a>(idx: &'a VaultIndex, from: &str, target: &str) -> Option<&'a str> {
    let mut parts: Vec<&str> = match from.rsplit_once('/') {
        Some((dir, _)) => dir.split('/').collect(),
        None => Vec::new(),
    };
    for seg in target.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            s => parts.push(s),
        }
    }
    let joined = parts.join("/");
    idx.resolve(&joined).or_else(|| idx.resolve(target.rsplit('/').next().unwrap_or(target)))
}

pub fn build(idx: &VaultIndex, vault_id: &str) -> String {
    let mut ids: HashMap<&str, usize> = HashMap::new();
    let mut nodes: Vec<Node> = Vec::new();
    for n in idx.notes() {
        ids.insert(n, nodes.len());
        nodes.push(Node { label: label(n), path: n, url: note_url(vault_id, n), kind: "note" });
    }

    let mut edges: HashSet<(usize, usize)> = HashSet::new();
    let notes: Vec<&String> = idx.notes().collect();
    for note in notes {
        let Some(disk) = idx.disk_path(note) else { continue };
        if std::fs::metadata(&disk).map(|m| m.len() > MAX_NOTE_BYTES).unwrap_or(true) {
            continue;
        }
        let Ok(bytes) = std::fs::read(&disk) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        let from = ids[note.as_str()];
        for target in link_targets(&text) {
            let resolved = match &target {
                LinkTarget::Wiki(w) => idx.resolve(w),
                LinkTarget::Relative(r) => resolve_relative(idx, note, r),
            };
            let Some(path) = resolved else { continue };
            let to = match ids.get(path) {
                Some(&i) => i,
                None => {
                    let i = nodes.len();
                    ids.insert(path, i);
                    let kind = if is_note(path) { "note" } else { "file" };
                    nodes.push(Node { label: label(path), path, url: file_url(vault_id, path), kind });
                    i
                }
            };
            if to != from {
                edges.insert((from.min(to), from.max(to)));
            }
        }
    }
    let mut links: Vec<[usize; 2]> = edges.into_iter().map(|(a, b)| [a, b]).collect();
    links.sort_unstable();
    serde_json::to_string(&Graph { nodes, links }).unwrap_or_else(|_| "{\"nodes\":[],\"links\":[]}".into())
}
