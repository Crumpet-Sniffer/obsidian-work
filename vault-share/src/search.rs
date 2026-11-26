//! Vault search with Obsidian-style operators: `file:`, `path:`, `tag:`, `content:`, `-exclude`, "exact phrase".

use crate::{markdown, vault::VaultIndex};

const MAX_NOTE_BYTES: u64 = 5 * 1024 * 1024;
const MAX_SNIPPETS: usize = 3;

pub struct Snippet {
    pub before: String,
    pub matched: String,
    pub after: String,
}

pub struct Hit {
    pub path: String,
    pub title: String,
    pub folder: String,
    pub snippets: Vec<Snippet>,
    pub matches: usize,
}

enum Kind {
    Text,
    File,
    Path,
    Tag,
    Content,
}

struct Term {
    kind: Kind,
    value: String, // lowercase
    negated: bool,
}

fn parse(q: &str) -> Vec<Term> {
    let mut terms = Vec::new();
    let chars: Vec<char> = q.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i].is_whitespace() {
            i += 1;
            continue;
        }
        let mut negated = false;
        if chars[i] == '-' && i + 1 < chars.len() && !chars[i + 1].is_whitespace() {
            negated = true;
            i += 1;
        }
        // operator prefix
        let mut kind = Kind::Text;
        for (name, k) in [("file:", Kind::File), ("path:", Kind::Path), ("tag:", Kind::Tag), ("content:", Kind::Content)] {
            let n = name.chars().count();
            if chars.len() >= i + n && chars[i..i + n].iter().collect::<String>().eq_ignore_ascii_case(name) {
                kind = k;
                i += n;
                break;
            }
        }
        let mut value = String::new();
        if i < chars.len() && chars[i] == '"' {
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                value.push(chars[i]);
                i += 1;
            }
            i += 1; // closing quote
        } else {
            while i < chars.len() && !chars[i].is_whitespace() {
                value.push(chars[i]);
                i += 1;
            }
        }
        let value = value.trim().to_lowercase();
        if !value.is_empty() {
            terms.push(Term { kind, value, negated });
        }
    }
    terms
}

fn floor_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_boundary(s: &str, mut i: usize) -> usize {
    i = i.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// Search every note. Returns the hits (at most `limit`) and whether more existed.
pub fn search(idx: &VaultIndex, q: &str, limit: usize) -> (Vec<Hit>, bool) {
    let terms = parse(q);
    if terms.is_empty() {
        return (Vec::new(), false);
    }
    let needs_tags = terms.iter().any(|t| matches!(t.kind, Kind::Tag));
    let mut hits = Vec::new();
    for rel in idx.notes() {
        if hits.len() >= limit {
            return (hits, true);
        }
        let Some(disk) = idx.disk_path(rel) else { continue };
        let Ok(meta) = std::fs::metadata(&disk) else { continue };
        if meta.len() > MAX_NOTE_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&disk) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        let body = markdown::strip_frontmatter(&text);
        let lower = body.to_lowercase();
        let (folder, file) = rel.rsplit_once('/').unwrap_or(("", rel.as_str()));
        let title = file.strip_suffix(".md").unwrap_or(file).to_string();
        let title_l = title.to_lowercase();
        let path_l = rel.to_lowercase();
        let tags: Vec<String> = if needs_tags { markdown::note_tags(&text).iter().map(|t| t.to_lowercase()).collect() } else { Vec::new() };

        let mut ok = true;
        let mut positive = false;
        for t in &terms {
            let hit = match t.kind {
                Kind::Text => lower.contains(&t.value) || title_l.contains(&t.value),
                Kind::Content => lower.contains(&t.value),
                Kind::File => title_l.contains(&t.value),
                Kind::Path => path_l.contains(&t.value),
                Kind::Tag => {
                    let want = t.value.trim_start_matches('#');
                    tags.iter().any(|g| g == want || g.starts_with(&format!("{want}/")))
                }
            };
            if !t.negated {
                positive = true;
            }
            if hit == t.negated {
                ok = false;
                break;
            }
        }
        if !ok || !positive && terms.iter().all(|t| t.negated) && false {
            continue;
        }

        // snippets for text-like terms
        let src: &str = if lower.len() == body.len() { body } else { &lower };
        let mut snippets = Vec::new();
        let mut matches = 0;
        for t in terms.iter().filter(|t| !t.negated && matches!(t.kind, Kind::Text | Kind::Content)) {
            let mut from = 0;
            while let Some(p) = lower[from..].find(&t.value) {
                let p = from + p;
                matches += 1;
                if snippets.len() < MAX_SNIPPETS && src.is_char_boundary(p) && src.is_char_boundary(p + t.value.len()) {
                    let s = floor_boundary(src, p.saturating_sub(70));
                    let e = ceil_boundary(src, p + t.value.len() + 110);
                    let s = src[s..p].rfind('\n').map(|n| s + n + 1).unwrap_or(s);
                    let e = src[p + t.value.len()..e].find('\n').map(|n| p + t.value.len() + n).unwrap_or(e);
                    // Never start or end part-way through a [[link]]: widen to the whole link (on the same line).
                    let line_start = src[..s].rfind('\n').map_or(0, |n| n + 1);
                    let s = match src[line_start..s].rfind("[[") {
                        Some(o) if !src[line_start + o..s].contains("]]") => line_start + o,
                        _ => s,
                    };
                    let e = match src[s..e].rfind("[[") {
                        Some(o) if !src[s + o..e].contains("]]") => match src[e..].find("]]") {
                            Some(c) if !src[e..e + c].contains('\n') => e + c + 2,
                            _ => e,
                        },
                        _ => e,
                    };
                    snippets.push(plain_snippet(&src[s..e], p - s, t.value.len(), s > 0, e < src.len()));
                }
                from = p + t.value.len().max(1);
                if from >= lower.len() || matches > 500 {
                    break;
                }
            }
        }
        if snippets.is_empty() {
            let e = ceil_boundary(src, 160);
            snippets.push(Snippet { before: plain_text(src[..e].trim()), matched: String::new(), after: String::new() });
        }
        hits.push(Hit { path: rel.clone(), title, folder: folder.replace('/', " / "), snippets, matches });
    }
    // notes whose name matches come first
    hits.sort_by_key(|h| {
        let n = h.title.to_lowercase();
        let named = terms.iter().any(|t| !t.negated && matches!(t.kind, Kind::Text | Kind::File) && n.contains(&t.value));
        std::cmp::Reverse(named)
    });
    (hits, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_operators_and_phrases() {
        let t = parse("path:Topics \"exact phrase\" -draft tag:#unit-1 plain");
        assert_eq!(t.len(), 5);
        assert!(matches!(t[0].kind, Kind::Path) && t[0].value == "topics");
        assert!(matches!(t[1].kind, Kind::Text) && t[1].value == "exact phrase");
        assert!(t[2].negated && t[2].value == "draft");
        assert!(matches!(t[3].kind, Kind::Tag) && t[3].value == "#unit-1");
    }
}

/// Markdown as it reads: `[[Topics/Encryption|Encryption]]` is "Encryption", `[[A4.2-Encryption]]` is
/// "A4.2-Encryption", `[text](url)` is "text", and heading, list, quote and emphasis marks are dropped. Pictures
/// (`![[...]]`, `![](...)`) are left out.
pub fn plain_text(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    for (n, line) in md.split('\n').enumerate() {
        if n > 0 {
            out.push(' ');
        }
        let mut l = line.trim_start();
        while let Some(r) = l.strip_prefix('>') {
            l = r.trim_start();
        }
        let hashes = l.chars().take_while(|c| *c == '#').count();
        if hashes > 0 && l[hashes..].starts_with(' ') {
            l = l[hashes..].trim_start();
        }
        for m in ["- [ ] ", "- [x] ", "- ", "* ", "+ "] {
            if let Some(r) = l.strip_prefix(m) {
                l = r;
                break;
            }
        }
        let mut rest = l;
        while !rest.is_empty() {
            if rest.starts_with("[[") || rest.starts_with("![[") {
                let pic = rest.starts_with('!');
                let open = if pic { 3 } else { 2 };
                if let Some(close) = rest[open..].find("]]") {
                    let inner = &rest[open..open + close];
                    if !pic {
                        let shown = match inner.split_once('|') {
                            Some((_, alias)) => alias,
                            None => inner.split('#').next().unwrap_or(inner).rsplit('/').next().unwrap_or(inner),
                        };
                        out.push_str(shown);
                    }
                    rest = &rest[open + close + 2..];
                    continue;
                }
            }
            if rest.starts_with('[') || rest.starts_with("![") {
                let open = if rest.starts_with('!') { 2 } else { 1 };
                if let Some(mid) = rest[open..].find("](") {
                    if let Some(end) = rest[open + mid + 2..].find(')') {
                        if open == 1 {
                            out.push_str(&rest[open..open + mid]);
                        }
                        rest = &rest[open + mid + 2 + end + 1..];
                        continue;
                    }
                }
            }
            if rest.starts_with("**") || rest.starts_with("__") || rest.starts_with("==") || rest.starts_with("~~") {
                rest = &rest[2..];
                continue;
            }
            if rest.starts_with('`') {
                rest = &rest[1..];
                continue;
            }
            let c = rest.chars().next().unwrap();
            out.push(c);
            rest = &rest[c.len_utf8()..];
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// One search snippet from a line of a note: its markdown made plain, with the match (at `at`, `len` bytes into
/// `line`) picked out. When the match sits inside a link's target, which plain text leaves out, the match is
/// looked for again in the plain line; failing that the line is shown without a highlight.
fn plain_snippet(line: &str, at: usize, len: usize, cut_start: bool, cut_end: bool) -> Snippet {
    let lead = if cut_start { "…" } else { "" };
    let tail = if cut_end { "…" } else { "" };
    let raw_before = &line[..at];
    let in_link = raw_before.rfind("[[").map_or(false, |o| !raw_before[o..].contains("]]"))
        || raw_before.rfind("](").map_or(false, |o| !raw_before[o..].contains(')'));
    if !in_link {
        let before = plain_text(raw_before);
        let after = plain_text(&line[at + len..]);
        let gap_b = if raw_before.ends_with(char::is_whitespace) && !before.is_empty() { " " } else { "" };
        let gap_a = if line[at + len..].starts_with(char::is_whitespace) && !after.is_empty() { " " } else { "" };
        return Snippet {
            before: format!("{lead}{before}{gap_b}"),
            matched: line[at..at + len].to_string(),
            after: format!("{gap_a}{after}{tail}"),
        };
    }
    let word = line[at..at + len].to_lowercase();
    let all = plain_text(line);
    if let Some(p) = all.to_lowercase().find(&word) {
        let e = p + word.len();
        if e <= all.len() && all.is_char_boundary(p) && all.is_char_boundary(e) {
            return Snippet {
                before: format!("{lead}{}", &all[..p]),
                matched: all[p..e].to_string(),
                after: format!("{}{tail}", &all[e..]),
            };
        }
    }
    Snippet { before: format!("{lead}{all}{tail}"), matched: String::new(), after: String::new() }
}

#[cfg(test)]
mod plain_tests {
    use super::*;

    #[test]
    fn markdown_made_plain() {
        assert_eq!(plain_text("- [[Topics/Encryption|Encryption]]: 16 lessons"), "Encryption: 16 lessons");
        assert_eq!(plain_text("### Do it now: **Encryption** in [your life](x.md)"), "Do it now: Encryption in your life");
        assert_eq!(plain_text("See [[Unit 2/A4.2-Encryption]] and ![[pic.png]]"), "See A4.2-Encryption and");
    }

    #[test]
    fn snippet_inside_a_link() {
        let line = "- [[Topics/Encryption|Encryption]]: 16 lessons";
        let at = line.find("Encryption").unwrap();
        let s = plain_snippet(line, at, 10, false, false);
        assert_eq!((s.before.as_str(), s.matched.as_str(), s.after.as_str()), ("", "Encryption", ": 16 lessons"));
    }

    #[test]
    fn snippet_in_plain_words() {
        let line = "# Cheat Sheet: Encryption and Firewalls";
        let at = line.find("Encryption").unwrap();
        let s = plain_snippet(line, at, 10, false, true);
        assert_eq!((s.before.as_str(), s.matched.as_str(), s.after.as_str()), ("Cheat Sheet: ", "Encryption", " and Firewalls…"));
    }
}
