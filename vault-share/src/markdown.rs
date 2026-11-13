//! Obsidian-flavoured Markdown -> sanitized HTML.
//!
//! Wikilinks (`[[Note]]`, `[[Note#Heading|alias]]`), embeds (`![[image.png|300]]`) and
//! highlights (`==text==`) are rewritten before CommonMark parsing (skipping code). The final
//! HTML always goes through an allow-list sanitizer (ammonia), so a malicious vault cannot inject
//! scripts, event handlers, iframes, forms or `javascript:` URLs.

use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    sync::OnceLock,
};

use ammonia::Builder;
use pulldown_cmark::{html, CowStr, Event, Options, Parser, Tag, TagEnd};

use crate::vault::{esc, file_url, link_url, mime_for, note_url, Kind, VaultIndex};

pub struct RenderCtx<'a> {
    pub vault_id: &'a str,
    pub index: &'a VaultIndex,
}

pub fn render(src: &str, ctx: &RenderCtx) -> String {
    let body = strip_frontmatter(src);
    let pre = preprocess(body, ctx);

    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_FOOTNOTES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    opts.insert(Options::ENABLE_GFM);

    let events = with_heading_ids(Parser::new_ext(&pre, opts).collect());
    let mut out = String::with_capacity(pre.len() * 3 / 2);
    html::push_html(&mut out, events.into_iter());
    let out = callouts(&out);
    sanitizer().clean(&out).to_string()
}

// ---------------------------------------------------------------- properties and callouts

/// Frontmatter as `(key, values)` pairs; scalars are a single value. Handles `key: value`,
/// `key: [a, b]` and `key:` followed by `- item` lines, which is what Obsidian writes.
pub fn frontmatter_props(src: &str) -> Vec<(String, Vec<String>)> {
    let src = src.strip_prefix('\u{feff}').unwrap_or(src);
    let Some(rest) = src.strip_prefix("---\n").or_else(|| src.strip_prefix("---\r\n")) else {
        return Vec::new();
    };
    let unquote = |v: &str| v.trim().trim_matches(|c| c == '"' || c == '\'').trim().to_string();
    let mut out: Vec<(String, Vec<String>)> = Vec::new();
    let mut closed = false;
    for line in rest.lines() {
        let t = line.trim_end();
        if t == "---" || t == "..." {
            closed = true;
            break;
        }
        if t.trim().is_empty() || t.trim_start().starts_with('#') {
            continue;
        }
        let indented = t.starts_with(' ') || t.starts_with('\t');
        let item = t.trim_start().strip_prefix("- ").or_else(|| t.trim_start().strip_prefix("-").filter(|s| s.is_empty()));
        if let Some(item) = item {
            if let Some(last) = out.last_mut() {
                let v = unquote(item);
                if !v.is_empty() {
                    last.1.push(v);
                }
            }
            continue;
        }
        if indented {
            continue; // nested structures are not shown
        }
        let Some((key, value)) = t.split_once(':') else { continue };
        let key = key.trim();
        if key.is_empty() || key.len() > 60 || key.contains(['"', '\'', '{', '[']) {
            continue;
        }
        let value = value.trim();
        let values: Vec<String> = if value.is_empty() {
            Vec::new()
        } else if let Some(inner) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
            inner.split(',').map(unquote).filter(|v| !v.is_empty()).collect()
        } else {
            vec![unquote(value)]
        };
        out.push((key.to_string(), values));
        if out.len() >= 50 {
            break;
        }
    }
    if !closed {
        return Vec::new();
    }
    out.retain(|(_, v)| !v.is_empty());
    out
}

fn clip(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn prop_value_html(key: &str, v: &str, ctx: &RenderCtx) -> String {
    let v = clip(v, 500);
    if matches!(key.to_ascii_lowercase().as_str(), "tags" | "tag") {
        return format!("<span class=\"tag\">{}</span>", esc(v.trim_start_matches('#')));
    }
    let wiki = v.strip_prefix("[[").and_then(|x| x.strip_suffix("]]"));
    let target = wiki.map(|w| w.split('|').next().unwrap_or(w).trim()).unwrap_or(v.as_str());
    let looks_like_path = wiki.is_some()
        || (target.contains('/') && target.rsplit('/').next().is_some_and(|f| f.contains('.')))
        || target.to_ascii_lowercase().ends_with(".md");
    if looks_like_path {
        let name = target.split('#').next().unwrap_or(target);
        if let Some(path) = ctx.index.resolve(name) {
            let url = match mime_for(path) {
                Some((_, Kind::Note)) => note_url(ctx.vault_id, path),
                _ => link_url(ctx.vault_id, path),
            };
            let label = path.rsplit('/').next().unwrap_or(path);
            let label = label.strip_suffix(".md").unwrap_or(label);
            return format!("<a class=\"internal\" href=\"{}\">{}</a>", esc(&url), esc(label));
        }
    }
    if v.starts_with("https://") || v.starts_with("http://") {
        return format!("<a href=\"{}\" rel=\"noopener noreferrer nofollow\" target=\"_blank\">{}</a>", esc(&v), esc(&v));
    }
    esc(&v)
}

/// Obsidian-style "Properties" block for a note's frontmatter. Empty when there is none.
pub fn render_properties(src: &str, ctx: &RenderCtx) -> String {
    let props = frontmatter_props(src);
    if props.is_empty() {
        return String::new();
    }
    let mut out = String::from("<details class=\"props\" open><summary>Properties</summary><div class=\"props-body\">");
    for (key, values) in &props {
        out.push_str("<div class=\"prop\"><span class=\"prop-key\">");
        out.push_str(&esc(&clip(key, 60)));
        out.push_str("</span><span class=\"prop-val\">");
        for (i, v) in values.iter().take(30).enumerate() {
            if i > 0 {
                out.push(' ');
            }
            out.push_str(&prop_value_html(key, v, ctx));
        }
        out.push_str("</span></div>");
    }
    out.push_str("</div></details>");
    out
}

/// Canonical callout kind (the CSS has a colour and icon for each), following Obsidian's aliases.
fn callout_kind(ty: &str) -> &'static str {
    match ty.to_ascii_lowercase().as_str() {
        "info" => "info",
        "abstract" | "summary" | "tldr" => "abstract",
        "todo" => "todo",
        "tip" | "hint" | "important" => "tip",
        "success" | "check" | "done" => "success",
        "question" | "help" | "faq" => "question",
        "warning" | "caution" | "attention" => "warning",
        "failure" | "fail" | "missing" => "failure",
        "danger" | "error" => "danger",
        "bug" => "bug",
        "example" => "example",
        "quote" | "cite" => "quote",
        _ => "note",
    }
}

/// Turn Obsidian callouts (`> [!info] Title` ...) into styled blocks. Runs on the rendered HTML,
/// before sanitising, so every resulting tag and class has to be allowed by the sanitiser.
pub fn callouts(html: &str) -> String {
    const OPEN: &str = "<blockquote>\n<p>[!";
    let mut out = String::with_capacity(html.len() + 128);
    let mut rest = html;
    while let Some(i) = rest.find(OPEN) {
        out.push_str(&rest[..i]);
        let after = &rest[i + OPEN.len()..];
        let parsed = (|| {
            let close = after.find(']')?;
            let ty = &after[..close];
            if ty.is_empty() || ty.len() > 30 || !ty.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
                return None;
            }
            let tail = &after[close + 1..];
            let tail = tail.strip_prefix(['+', '-']).unwrap_or(tail);
            let pend = tail.find("</p>")?;
            let para = &tail[..pend];
            let after_p = &tail[pend + 4..];
            // find the matching </blockquote>, allowing nested quotes
            let mut depth = 1usize;
            let mut pos = 0usize;
            let end = loop {
                let next_open = after_p[pos..].find("<blockquote");
                let next_close = after_p[pos..].find("</blockquote>")?;
                match next_open {
                    Some(o) if o < next_close => {
                        depth += 1;
                        pos += o + "<blockquote".len();
                    }
                    _ => {
                        depth -= 1;
                        if depth == 0 {
                            break pos + next_close;
                        }
                        pos += next_close + "</blockquote>".len();
                    }
                }
            };
            Some((ty, para, &after_p[..end], &after_p[end + "</blockquote>".len()..]))
        })();
        let Some((ty, para, inner, remainder)) = parsed else {
            out.push_str(OPEN);
            rest = after;
            continue;
        };
        let (title, body) = match para.split_once('\n') {
            Some((t, b)) => (t.trim(), Some(b)),
            None => (para.trim(), None),
        };
        let kind = callout_kind(ty);
        let default_title = {
            let mut c = ty.chars();
            c.next().map(|f| f.to_uppercase().collect::<String>() + &c.as_str().to_lowercase()).unwrap_or_default()
        };
        out.push_str("<blockquote class=\"callout callout-");
        out.push_str(kind);
        out.push_str("\"><div class=\"callout-title\">");
        out.push_str(if title.is_empty() { &default_title } else { title });
        out.push_str("</div><div class=\"callout-content\">");
        if let Some(b) = body {
            if !b.trim().is_empty() {
                out.push_str("<p>");
                out.push_str(b);
                out.push_str("</p>");
            }
        }
        out.push_str(inner);
        out.push_str("</div></blockquote>");
        rest = remainder;
    }
    out.push_str(rest);
    out
}

const CONN_START: &str = "%% connections:start %%";
const CONN_END: &str = "%% connections:end %%";

/// Split a note into its main text and the auto-generated Connections block (topics, related notes).
/// The block is returned without its markers, `---` rule and `## Connections` heading.
pub fn split_connections(src: &str) -> (String, Option<String>) {
    let (Some(a), Some(b)) = (src.find(CONN_START), src.find(CONN_END)) else {
        return (src.to_string(), None);
    };
    if b < a {
        return (src.to_string(), None);
    }
    let inner = src[a + CONN_START.len()..b].trim();
    let inner = inner.strip_prefix("---").map(str::trim_start).unwrap_or(inner);
    let inner = inner.strip_prefix("## Connections").map(str::trim_start).unwrap_or(inner).trim();
    let main = format!("{}\n{}", src[..a].trim_end(), src[b + CONN_END.len()..].trim_start());
    (main.trim_end().to_string() + "\n", (!inner.is_empty()).then(|| inner.to_string()))
}

/// The `source:` frontmatter value (path of the original document), without quotes or `[[ ]]`.
pub fn frontmatter_source(src: &str) -> Option<String> {
    let src = src.strip_prefix('\u{feff}').unwrap_or(src);
    let rest = src.strip_prefix("---\n").or_else(|| src.strip_prefix("---\r\n"))?;
    for line in rest.lines() {
        let t = line.trim_end();
        if t == "---" || t == "..." {
            break;
        }
        if let Some(v) = t.strip_prefix("source:") {
            let v = v.trim().trim_matches(|c| c == '"' || c == '\'').trim_start_matches("[[").trim_end_matches("]]");
            let v = v.split('|').next().unwrap_or(v).trim();
            return (!v.is_empty()).then(|| v.to_string());
        }
    }
    None
}

pub fn strip_frontmatter(src: &str) -> &str {
    let src = src.strip_prefix('\u{feff}').unwrap_or(src);
    let Some(rest) = src.strip_prefix("---\n").or_else(|| src.strip_prefix("---\r\n")) else {
        return src;
    };
    let mut offset = 0;
    for line in rest.split_inclusive('\n') {
        offset += line.len();
        let t = line.trim_end();
        if t == "---" || t == "..." {
            return &rest[offset..];
        }
    }
    src
}

/// GitHub-style slug used for heading ids and `#heading` links.
pub fn slugify(s: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in s.trim().chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
            dash = false;
        } else if (c.is_whitespace() || c == '-' || c == '_') && !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "section".into()
    } else {
        out
    }
}

fn with_heading_ids(events: Vec<Event<'_>>) -> Vec<Event<'_>> {
    let mut used: HashMap<String, usize> = HashMap::new();
    let mut out = Vec::with_capacity(events.len());
    for (i, ev) in events.iter().enumerate() {
        if let Event::Start(Tag::Heading { level, classes, attrs, .. }) = ev {
            let mut text = String::new();
            for e in &events[i + 1..] {
                match e {
                    Event::End(TagEnd::Heading(_)) => break,
                    Event::Text(t) | Event::Code(t) => text.push_str(t),
                    _ => {}
                }
            }
            let base = slugify(&text);
            let n = used.entry(base.clone()).or_insert(0);
            let id = if *n == 0 { base.clone() } else { format!("{base}-{n}") };
            *n += 1;
            out.push(Event::Start(Tag::Heading {
                level: *level,
                id: Some(CowStr::from(id)),
                classes: classes.clone(),
                attrs: attrs.clone(),
            }));
        } else {
            out.push(ev.clone());
        }
    }
    out
}

// ---------------------------------------------------------------- preprocessing

fn fence_open(trimmed: &str) -> Option<(char, usize)> {
    let ch = trimmed.chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }
    let run = trimmed.chars().take_while(|c| *c == ch).count();
    (run >= 3).then_some((ch, run))
}

/// Call `f(line, in_code_block)` for every line, tracking fenced code blocks.
fn for_each_line<'a>(src: &'a str, mut f: impl FnMut(&'a str, bool)) {
    let mut fence: Option<(char, usize)> = None;
    for line in src.split_inclusive('\n') {
        let trimmed = line.trim_start_matches([' ', '\t']);
        let indent = line.len() - trimmed.len();
        if let Some((ch, n)) = fence {
            if indent < 4 {
                let run = trimmed.chars().take_while(|c| *c == ch).count();
                if run >= n && trimmed[run * ch.len_utf8()..].trim().is_empty() {
                    fence = None;
                }
            }
            f(line, true);
            continue;
        }
        if indent < 4 {
            if let Some(fo) = fence_open(trimmed) {
                fence = Some(fo);
                f(line, true);
                continue;
            }
        }
        f(line, false);
    }
}

/// `b[i]` is a backtick: return the index just past the matching inline code span
/// (or past the backtick run if it is never closed).
fn skip_code_span(b: &[u8], i: usize) -> usize {
    let run = b[i..].iter().take_while(|&&c| c == b'`').count();
    let mut j = i + run;
    while j < b.len() {
        if b[j] == b'`' {
            let r = b[j..].iter().take_while(|&&c| c == b'`').count();
            if r == run {
                return j + r;
            }
            j += r;
        } else {
            j += 1;
        }
    }
    i + run
}

fn preprocess(src: &str, ctx: &RenderCtx) -> String {
    let mut out = String::with_capacity(src.len() + 256);
    for_each_line(src, |line, code| if code { out.push_str(line) } else { inline(line, ctx, &mut out) });
    out
}

/// A link found in a note's source, before resolution.
pub enum LinkTarget<'a> {
    /// `[[Target]]` / `![[Target]]` (file part only, no heading or alias).
    Wiki(&'a str),
    /// `[text](relative/path.md)`, percent-decoded, without `#fragment`.
    Relative(String),
}

/// Every outgoing link in a note (ignoring code blocks and inline code). Used for the graph.
pub fn link_targets(src: &str) -> Vec<LinkTarget<'_>> {
    let mut out = Vec::new();
    for_each_line(strip_frontmatter(src), |line, code| {
        if code {
            return;
        }
        let b = line.as_bytes();
        let mut i = 0;
        while i < b.len() {
            match b[i] {
                b'\\' => i += 2,
                b'`' => i = skip_code_span(b, i),
                b'[' if b[i..].starts_with(b"[[") => match find_close(line, i + 2, None) {
                    Some(end) => {
                        let file = parse_link(&line[i + 2..end]).file;
                        if !file.is_empty() {
                            out.push(LinkTarget::Wiki(file));
                        }
                        i = end + 2;
                    }
                    None => i += 2,
                },
                b']' if b[i..].starts_with(b"](") => {
                    let start = i + 2;
                    match line[start..].find(')') {
                        Some(len) => {
                            let raw = line[start..start + len].trim();
                            let raw = raw.strip_prefix('<').and_then(|r| r.strip_suffix('>')).unwrap_or_else(|| {
                                raw.split_whitespace().next().unwrap_or("")
                            });
                            let target = raw.split('#').next().unwrap_or("");
                            let external = target.contains("://") || target.starts_with("mailto:") || target.starts_with('/');
                            if !target.is_empty() && !external {
                                let decoded = percent_encoding::percent_decode_str(target).decode_utf8_lossy();
                                out.push(LinkTarget::Relative(decoded.into_owned()));
                            }
                            i = start + len + 1;
                        }
                        None => i += 2,
                    }
                }
                _ => i += 1,
            }
        }
    });
    out
}

fn inline(line: &str, ctx: &RenderCtx, out: &mut String) {
    let b = line.as_bytes();
    let mut i = 0;
    let mut last = 0;
    let mut mark_close: Option<usize> = None;
    while i < b.len() {
        if Some(i) == mark_close {
            out.push_str(&line[last..i]);
            out.push_str("</mark>");
            i += 2;
            last = i;
            mark_close = None;
            continue;
        }
        match b[i] {
            b'\\' => i += 2,
            b'`' => i = skip_code_span(b, i),
            b'!' if b[i..].starts_with(b"![[") => match find_close(line, i + 3, mark_close) {
                Some(end) => {
                    out.push_str(&line[last..i]);
                    out.push_str(&embed(&line[i + 3..end], ctx));
                    i = end + 2;
                    last = i;
                }
                None => i += 1,
            },
            b'[' if b[i..].starts_with(b"[[") => match find_close(line, i + 2, mark_close) {
                Some(end) => {
                    out.push_str(&line[last..i]);
                    out.push_str(&wikilink(&line[i + 2..end], ctx));
                    i = end + 2;
                    last = i;
                }
                None => i += 1,
            },
            b'=' if mark_close.is_none() && b[i..].starts_with(b"==") => {
                let start = i + 2;
                let close = line[start..].find("==").map(|p| p + start);
                match close {
                    Some(c)
                        if c > start
                            && !b[start].is_ascii_whitespace()
                            && !b[c - 1].is_ascii_whitespace()
                            && !line[start..c].contains('`') =>
                    {
                        out.push_str(&line[last..i]);
                        out.push_str("<mark>");
                        i = start;
                        last = i;
                        mark_close = Some(c);
                    }
                    _ => i += 2,
                }
            }
            _ => i += 1,
        }
    }
    out.push_str(&line[last.min(line.len())..]);
    if mark_close.is_some() {
        out.push_str("</mark>");
    }
}

fn find_close(line: &str, from: usize, limit: Option<usize>) -> Option<usize> {
    let end = line[from..].find("]]")? + from;
    let inner = &line[from..end];
    let ok = !inner.is_empty() && inner.len() <= 512 && !inner.contains("[[") && limit.is_none_or(|l| end < l);
    ok.then_some(end)
}

struct LinkParts<'a> {
    file: &'a str,
    heading: Option<&'a str>,
    alias: Option<&'a str>,
}

fn parse_link(inner: &str) -> LinkParts<'_> {
    let (target, alias) = match inner.split_once('|') {
        Some((t, a)) => (t.strip_suffix('\\').unwrap_or(t), Some(a.trim())),
        None => (inner, None),
    };
    let (file, heading) = match target.split_once('#') {
        Some((f, h)) => (f.trim(), Some(h.trim())),
        None => (target.trim(), None),
    };
    LinkParts { file, heading, alias: alias.filter(|a| !a.is_empty()) }
}

fn display_name(file: &str) -> &str {
    let name = file.rsplit('/').next().unwrap_or(file);
    name.strip_suffix(".md").unwrap_or(name)
}

fn heading_fragment(h: Option<&str>) -> String {
    match h {
        Some(h) if !h.is_empty() && !h.starts_with('^') => format!("#{}", slugify(h)),
        _ => String::new(),
    }
}

fn wikilink(inner: &str, ctx: &RenderCtx) -> String {
    let p = parse_link(inner);
    let label = match (p.alias, p.heading) {
        (Some(a), _) => a.to_string(),
        (None, Some(h)) if p.file.is_empty() => h.to_string(),
        (None, Some(h)) if !h.starts_with('^') => format!("{} › {}", display_name(p.file), h),
        _ => display_name(p.file).to_string(),
    };
    if p.file.is_empty() {
        return format!("<a class=\"internal\" href=\"{}\">{}</a>", esc(&heading_fragment(p.heading)), esc(&label));
    }
    match ctx.index.resolve(p.file) {
        Some(path) => {
            let url = match mime_for(path) {
                Some((_, Kind::Note)) => note_url(ctx.vault_id, path) + &heading_fragment(p.heading),
                _ => link_url(ctx.vault_id, path),
            };
            format!("<a class=\"internal\" href=\"{}\">{}</a>", esc(&url), esc(&label))
        }
        None => format!("<span class=\"broken\" title=\"Not in this vault\">{}</span>", esc(&label)),
    }
}

fn embed(inner: &str, ctx: &RenderCtx) -> String {
    let p = parse_link(inner);
    let Some(path) = ctx.index.resolve(p.file) else {
        return format!("<span class=\"broken\" title=\"Not in this vault\">{}</span>", esc(display_name(p.file)));
    };
    let url = file_url(ctx.vault_id, path);
    let name = display_name(path);
    match mime_for(path).map(|m| m.1) {
        Some(Kind::Image) => {
            // `|300` or `|300x200` sizes, otherwise alias is alt text.
            let size = p.alias.and_then(|a| {
                let (w, h) = a.split_once('x').unwrap_or((a, ""));
                let w: u32 = w.trim().parse().ok()?;
                Some((w.min(4000), h.trim().parse::<u32>().ok().map(|h| h.min(4000))))
            });
            let alt = esc(if size.is_some() { name } else { p.alias.unwrap_or(name) });
            match size {
                Some((w, Some(h))) => format!("<img src=\"{}\" alt=\"{alt}\" width=\"{w}\" height=\"{h}\" loading=\"lazy\">", esc(&url)),
                Some((w, None)) => format!("<img src=\"{}\" alt=\"{alt}\" width=\"{w}\" loading=\"lazy\">", esc(&url)),
                None => format!("<img src=\"{}\" alt=\"{alt}\" loading=\"lazy\">", esc(&url)),
            }
        }
        Some(Kind::Audio) => format!("<audio controls preload=\"metadata\" src=\"{}\"></audio>", esc(&url)),
        Some(Kind::Video) => format!("<video controls preload=\"metadata\" src=\"{}\"></video>", esc(&url)),
        Some(Kind::Note) => {
            let href = note_url(ctx.vault_id, path) + &heading_fragment(p.heading);
            format!("<a class=\"internal embed\" href=\"{}\">{}</a>", esc(&href), esc(p.alias.unwrap_or(name)))
        }
        _ => format!("<a class=\"internal embed\" href=\"{}\">{}</a>", esc(&url), esc(p.alias.unwrap_or(name))),
    }
}

// ---------------------------------------------------------------- sanitizer

fn sanitizer() -> &'static Builder<'static> {
    static S: OnceLock<Builder<'static>> = OnceLock::new();
    S.get_or_init(|| {
        let mut b = Builder::default();
        b.add_tags(&["input", "audio", "video", "mark"]);
        b.add_tag_attributes("input", &["type", "checked", "disabled"]);
        b.add_tag_attributes("audio", &["controls", "src", "preload"]);
        b.add_tag_attributes("video", &["controls", "src", "preload"]);
        b.add_tag_attributes("img", &["loading"]);
        for tag in ["h1", "h2", "h3", "h4", "h5", "h6", "div", "sup", "li"] {
            b.add_tag_attributes(tag, &["id"]);
        }
        b.add_allowed_classes("a", &["internal", "embed"]);
        b.add_allowed_classes("span", &["broken"]);
        b.add_allowed_classes("div", &["footnote-definition", "callout-title", "callout-content"]);
        b.add_allowed_classes("sup", &["footnote-reference", "footnote-definition-label"]);
        b.add_allowed_classes(
            "blockquote",
            &[
                "callout",
                "callout-info",
                "callout-abstract",
                "callout-todo",
                "callout-tip",
                "callout-success",
                "callout-question",
                "callout-warning",
                "callout-failure",
                "callout-danger",
                "callout-bug",
                "callout-example",
                "callout-quote",
                "callout-note",
                "markdown-alert-note",
                "markdown-alert-tip",
                "markdown-alert-important",
                "markdown-alert-warning",
                "markdown-alert-caution",
            ],
        );
        b.url_schemes(HashSet::from(["http", "https", "mailto"]));
        b.link_rel(Some("noopener noreferrer nofollow"));
        b.attribute_filter(|el, attr, value| match (el, attr) {
            ("input", "type") if value != "checkbox" => None,
            // Media and inline images may only come from this server.
            ("audio" | "video", "src") if !value.starts_with("/v/") => None,
            _ => Some(Cow::Borrowed(value)),
        });
        b
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn index() -> (tempdir::Dir, VaultIndex) {
        let d = tempdir::Dir::new();
        fs::create_dir_all(d.0.join("Folder")).unwrap();
        fs::write(d.0.join("Folder/Note A.md"), "# A").unwrap();
        fs::write(d.0.join("Other.md"), "x").unwrap();
        fs::write(d.0.join("Folder/pic.png"), "x").unwrap();
        let idx = VaultIndex::build(&d.0).unwrap();
        (d, idx)
    }

    mod tempdir {
        pub struct Dir(pub std::path::PathBuf);
        impl Dir {
            pub fn new() -> Self {
                let p = std::env::temp_dir().join(format!("vs-test-{}", uuid::Uuid::new_v4().simple()));
                std::fs::create_dir_all(&p).unwrap();
                Dir(p)
            }
        }
        impl Drop for Dir {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
    }

    #[test]
    fn wikilinks_and_embeds() {
        let (_d, idx) = index();
        let ctx = RenderCtx { vault_id: "v", index: &idx };
        let html = render("See [[Note A|the note]] and [[Missing]]\n\n![[pic.png|200]]\n\n`[[Other]]`", &ctx);
        assert!(html.contains("href=\"/v/v/n/Folder/Note%20A.md\""), "{html}");
        assert!(html.contains("class=\"broken\""), "{html}");
        assert!(html.contains("width=\"200\""), "{html}");
        assert!(html.contains("<code>[[Other]]</code>"), "{html}");
    }

    #[test]
    fn strips_scripts_and_js_urls() {
        let (_d, idx) = index();
        let ctx = RenderCtx { vault_id: "v", index: &idx };
        let html = render(
            "<script>alert(1)</script><img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))\n\n<a href=\"javascript:alert(1)\">y</a><iframe src=//e></iframe><form action=/logout></form><svg onload=alert(1)>",
            &ctx,
        );
        assert!(!html.contains("<script"), "{html}");
        assert!(!html.contains("onerror"), "{html}");
        assert!(!html.contains("onload"), "{html}");
        assert!(!html.contains("href=\"javascript"), "{html}");
        assert!(!html.contains("<iframe"), "{html}");
        assert!(!html.contains("<form"), "{html}");
        assert!(!html.contains("<svg"), "{html}");
    }

    #[test]
    fn extracts_link_targets() {
        let src = "---\nx: [[NotMe]]\n---\nSee [[A#h|alias]], ![[pic.png|200]], [b](sub/B%20note.md#x), [web](https://e.com)\n\n```\n[[InCode]]\n```\n`[[Inline]]`";
        let got: Vec<String> = link_targets(src)
            .into_iter()
            .map(|t| match t {
                LinkTarget::Wiki(w) => format!("w:{w}"),
                LinkTarget::Relative(r) => format!("r:{r}"),
            })
            .collect();
        assert_eq!(got, vec!["w:A", "w:pic.png", "r:sub/B note.md"]);
    }

    #[test]
    fn frontmatter_and_highlight() {
        let (_d, idx) = index();
        let ctx = RenderCtx { vault_id: "v", index: &idx };
        let html = render("---\ntags: [a]\n---\n# Title\nsome ==bright== text", &ctx);
        assert!(!html.contains("tags"), "{html}");
        assert!(html.contains("<h1 id=\"title\">"), "{html}");
        assert!(html.contains("<mark>bright</mark>"), "{html}");
    }
}

#[cfg(test)]
mod callout_tests {
    use super::*;

    #[test]
    fn callout_becomes_styled_block() {
        let html = callouts("<blockquote>\n<p>[!info] Recovered content\nSome text here</p>\n</blockquote>\n");
        assert!(html.contains("callout callout-info"), "{html}");
        assert!(html.contains("<div class=\"callout-title\">Recovered content</div>"), "{html}");
        assert!(html.contains("<p>Some text here</p>"), "{html}");
        let clean = sanitizer().clean(&html).to_string();
        assert!(clean.contains("callout-title"), "classes survive sanitising: {clean}");
    }

    #[test]
    fn plain_quote_is_untouched() {
        let src = "<blockquote>\n<p>just a quote</p>\n</blockquote>\n";
        assert_eq!(callouts(src), src);
    }

    #[test]
    fn callout_without_title_uses_type() {
        let html = callouts("<blockquote>\n<p>[!warning]</p>\n</blockquote>\n");
        assert!(html.contains(">Warning</div>"), "{html}");
    }

    #[test]
    fn frontmatter_properties_parse() {
        let src = "---\nsource: \"_Originals/a.docx\"\ntags: [unit-1, docx]\nlist:\n  - one\n  - two\n---\n\n# T\n";
        let p = frontmatter_props(src);
        assert_eq!(p[0], ("source".to_string(), vec!["_Originals/a.docx".to_string()]));
        assert_eq!(p[1].1, vec!["unit-1".to_string(), "docx".to_string()]);
        assert_eq!(p[2].1, vec!["one".to_string(), "two".to_string()]);
        assert!(frontmatter_props("# no frontmatter").is_empty());
    }
}
