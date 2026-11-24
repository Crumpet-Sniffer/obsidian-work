//! Practice: quizzes and flashcards that Claude writes from a vault's notes, the question hub (questions taken from
//! past exam papers and their mark schemes), marking against mark schemes, and an exam coach to talk to.
//!
//! Everything that calls Claude runs on the server with the admin's key, model and effort (as filing does), in a
//! background task where it can take a while, so closing the page does not lose the work. Past papers are read by
//! the ingest worker (it converts PDFs and Office files and reads their pictures), which hands the questions it
//! finds to `add_paper`.

use std::collections::{HashMap, HashSet};

use anyhow::Result;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};

use crate::{
    db::{now, Db},
    handlers::ingest::{self, Settings},
    markdown,
    vault::VaultIndex,
    AppState,
};

pub const TYPES: &[(&str, &str)] = &[
    ("single", "Select one option"),
    ("multi", "Select multiple options"),
    ("fill", "Fill in the blanks"),
    ("written", "Written answer"),
];
pub const DIFFICULTIES: &[&str] = &["easy", "medium", "hard", "mixed"];
/// Mark levels offered even before any past paper is in the hub.
pub const DEFAULT_MARKS: &[i64] = &[1, 2, 3, 4, 6, 8];
pub const MAX_MARKS: i64 = 30;
pub const MAX_QUESTIONS: usize = 30;
/// Characters of notes sent to Claude to write questions or cards from (about 100,000 tokens).
const NOTES_BUDGET: usize = 400_000;
/// Past paper questions shown to Claude as examples of the course's style.
const EXAMPLES: usize = 30;
/// Written answers marked at the same time.
const MARK_PARALLEL: usize = 4;

pub type Who = (i64, String);

// ---------------------------------------------------------------- calling Claude

/// One call to Claude with the admin's key, model and effort. With a JSON schema the reply is parsed into a value
/// (structured output); without one it is the reply's text. Errors are sentences to show the student.
pub async fn ask(
    st: &AppState,
    who: &Who,
    vault_id: &str,
    what: &str,
    system: &str,
    extra_system: Option<String>,
    messages: Value,
    schema: Option<Value>,
    max_tokens: u64,
) -> Result<Value, String> {
    let s = Settings::load(&st.db).await.map_err(|_| "The settings could not be read.".to_string())?;
    let key = s.api_key.clone().ok_or("No Anthropic API key is set. An admin can add one under Admin → Microsidian.")?;
    if !ingest::allow_call(st, who.0, false) {
        return Err("Too many calls to Claude from this account in the last hour. Try again later.".into());
    }
    let model = s.model.clone();
    let mut system_blocks = vec![json!({ "type": "text", "text": system })];
    if let Some(x) = extra_system {
        system_blocks.push(json!({ "type": "text", "text": x }));
    }
    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": system_blocks,
        "messages": messages,
        "output_config": { "effort": s.effort },
    });
    if let Some(schema) = schema.as_ref() {
        body["output_config"]["format"] = json!({ "type": "json_schema", "schema": schema });
    }
    let haiku = model.contains("haiku");
    let mut req = st
        .http
        .post(format!("{}/v1/messages", ingest::api_base()))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01");
    if !haiku {
        // If safety systems decline, the API answers with a substitute model instead.
        body["fallbacks"] = json!("default");
        req = req.header("anthropic-beta", "server-side-fallback-2026-07-01").query(&[("beta", "true")]);
    }
    let res = req.json(&body).send().await.map_err(|e| {
        tracing::warn!("anthropic request failed: {}", e.without_url());
        "Could not reach the Anthropic API from the server.".to_string()
    })?;
    let status = res.status();
    let bytes = res.bytes().await.map_err(|_| "The reply from the Anthropic API was cut off.".to_string())?;
    let reply: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);

    // Keep what it cost, for the spend chart, and audit it.
    let usage = reply.get("usage").cloned().unwrap_or(Value::Null);
    let n = |k: &str| usage.get(k).and_then(Value::as_u64).unwrap_or(0);
    if status.is_success() {
        let tokens = crate::spend::Tokens {
            input: n("input_tokens"),
            output: n("output_tokens"),
            cache_read: n("cache_read_input_tokens"),
            cache_write: n("cache_creation_input_tokens"),
        };
        let answered_by = reply.get("model").and_then(Value::as_str).unwrap_or(&model).to_string();
        let cost = crate::spend::cost_micro_usd(&answered_by, &model, tokens);
        let _ = st
            .db
            .record_usage(
                Some(who.clone()),
                vault_id.to_string(),
                answered_by,
                tokens.input as i64,
                tokens.output as i64,
                tokens.cache_read as i64,
                tokens.cache_write as i64,
                cost,
            )
            .await;
    }
    st.db
        .audit(
            Some(who.clone()),
            None,
            "claude_call",
            if status.is_success() {
                format!("practice, {what}: {model} ({} in, {} out)", n("input_tokens") + n("cache_read_input_tokens"), n("output_tokens"))
            } else {
                format!("practice, {what}: {model} failed with status {}", status.as_u16())
            },
        )
        .await;

    if !status.is_success() {
        let msg = reply.pointer("/error/message").and_then(Value::as_str).unwrap_or("no details");
        return Err(match status.as_u16() {
            401 => "The Anthropic API key was rejected. An admin can fix it under Admin → Microsidian.".into(),
            429 => "Anthropic's rate limit was reached. Wait a minute and try again.".into(),
            529 | 503 => "Claude is overloaded at the moment. Try again in a few minutes.".into(),
            s => format!("The Anthropic API returned an error ({s}): {msg}"),
        });
    }
    match reply.get("stop_reason").and_then(Value::as_str) {
        Some("refusal") => return Err("Claude declined this request.".into()),
        Some("max_tokens") => return Err("Claude's reply was too long and was cut off. Ask for fewer at a time.".into()),
        _ => {}
    }
    let text: String = reply
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|b| b.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    if schema.is_some() {
        serde_json::from_str(&text).map_err(|_| "Claude's reply could not be read. Try again.".to_string())
    } else if text.trim().is_empty() {
        Err("Claude's reply was empty. Try again.".into())
    } else {
        Ok(Value::String(text))
    }
}

/// A JSON schema object with every property required (as structured outputs need).
fn object(props: Value) -> Value {
    let required: Vec<String> = props.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
    json!({ "type": "object", "properties": props, "required": required, "additionalProperties": false })
}

fn strings() -> Value {
    json!({ "type": "array", "items": { "type": "string" } })
}

/// One question, as Claude writes or extracts it.
pub fn question_schema(with_number: bool) -> Value {
    let mut props = json!({
        "type": { "type": "string", "enum": TYPES.iter().map(|t| t.0).collect::<Vec<_>>() },
        "text": { "type": "string" },
        "options": strings(),
        "correct": { "type": "array", "items": { "type": "integer" } },
        "blanks": { "type": "array", "items": strings() },
        "marks": { "type": "integer" },
        "mark_scheme": { "type": "string" },
        "topics": strings(),
        "difficulty": { "type": "string", "enum": ["easy", "medium", "hard"] },
    });
    if !with_number {
        props["spec_areas"] = strings();
        props["hint"] = json!({ "type": "string" });
        props["explanation"] = json!({ "type": "string" });
        props["option_feedback"] = strings();
    }
    if with_number {
        props["number"] = json!({ "type": "string" });
    }
    object(props)
}

// ---------------------------------------------------------------- questions

/// A question as stored. `answer` holds `{correct: [..], blanks: [[..]]}`.
#[derive(Clone, Debug)]
pub struct Question {
    pub id: i64,
    pub paper_id: Option<i64>,
    pub paper_title: String,
    pub source: String,
    pub user_id: Option<i64>,
    pub number: String,
    pub text: String,
    pub qtype: String,
    pub options: Vec<String>,
    pub correct: Vec<usize>,
    pub blanks: Vec<Vec<String>>,
    pub marks: i64,
    pub scheme: String,
    pub topics: Vec<String>,
    pub difficulty: String,
    pub created_at: i64,
    /// The qualification and paper number of its past paper (empty for questions Claude wrote).
    pub qualification: String,
    pub paper_number: String,
    /// Specification areas it examines, as labels ("A1 Digital devices") from its paper's guide.
    pub spec: Vec<String>,
    /// For a question Claude wrote for one paper: that paper's guide.
    pub profile_id: Option<i64>,
    /// A nudge shown before answering, without giving the answer away (questions Claude wrote).
    pub hint: String,
    /// Why the right answer is right, shown once it has been answered.
    pub explanation: String,
    /// For choice questions: one note per option on why it is right or wrong.
    pub option_notes: Vec<String>,
}

impl Question {
    /// The question as kept with an attempt, so history still shows it if the question is deleted.
    pub fn snapshot(&self) -> Value {
        json!({
            "id": self.id, "number": self.number, "text": self.text, "type": self.qtype, "options": self.options,
            "correct": self.correct, "blanks": self.blanks, "marks": self.marks, "scheme": self.scheme,
            "topics": self.topics, "difficulty": self.difficulty, "paper": self.paper_title, "source": self.source,
            "qualification": self.qualification, "paperNumber": self.paper_number, "spec": self.spec, "profile": self.profile_id,
            "hint": self.hint, "explanation": self.explanation, "optionNotes": self.option_notes,
        })
    }

    pub fn from_snapshot(v: &Value) -> Question {
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        Question {
            id: v.get("id").and_then(Value::as_i64).unwrap_or(0),
            paper_id: None,
            paper_title: s("paper"),
            source: s("source"),
            user_id: None,
            number: s("number"),
            text: s("text"),
            qtype: s("type"),
            options: serde_json::from_value(v.get("options").cloned().unwrap_or(json!([]))).unwrap_or_default(),
            correct: serde_json::from_value(v.get("correct").cloned().unwrap_or(json!([]))).unwrap_or_default(),
            blanks: serde_json::from_value(v.get("blanks").cloned().unwrap_or(json!([]))).unwrap_or_default(),
            marks: v.get("marks").and_then(Value::as_i64).unwrap_or(0),
            scheme: s("scheme"),
            topics: serde_json::from_value(v.get("topics").cloned().unwrap_or(json!([]))).unwrap_or_default(),
            difficulty: s("difficulty"),
            created_at: 0,
            qualification: s("qualification"),
            paper_number: s("paperNumber"),
            spec: serde_json::from_value(v.get("spec").cloned().unwrap_or(json!([]))).unwrap_or_default(),
            profile_id: v.get("profile").and_then(Value::as_i64),
            hint: s("hint"),
            explanation: s("explanation"),
            option_notes: serde_json::from_value(v.get("optionNotes").cloned().unwrap_or(json!([]))).unwrap_or_default(),
        }
    }
}

fn clip(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').take(max).collect::<String>().trim().to_string()
}

/// Blanks in a fill question: {{1}}, {{2}}, ... in order.
pub fn blank_count(text: &str) -> usize {
    let mut n = 0;
    while text.contains(&format!("{{{{{}}}}}", n + 1)) {
        n += 1;
    }
    n
}

/// Check a question Claude wrote or extracted. Topics are matched to the vault's topics (any case); with no topics
/// in the vault, Claude's own names are kept. Returns None for a question that cannot be used.
pub fn clean_question(v: &Value, topics: &[String], spec_allowed: &[String]) -> Option<Question> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("");
    let qtype = s("type");
    if !TYPES.iter().any(|t| t.0 == qtype) {
        return None;
    }
    let text = clip(s("text"), 20_000);
    if text.is_empty() {
        return None;
    }
    let mut options: Vec<String> = v
        .get("options")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(|o| clip(o, 1000)).filter(|o| !o.is_empty()).take(10).collect())
        .unwrap_or_default();
    let mut correct: Vec<usize> = v
        .get("correct")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_u64).map(|i| i as usize).filter(|i| *i < options.len()).collect())
        .unwrap_or_default();
    correct.sort_unstable();
    correct.dedup();
    let mut blanks: Vec<Vec<String>> = v
        .get("blanks")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|b| b.as_array().map(|x| x.iter().filter_map(Value::as_str).map(|t| clip(t, 200)).filter(|t| !t.is_empty()).take(12).collect()).unwrap_or_default())
                .collect()
        })
        .unwrap_or_default();
    match qtype {
        "single" if options.len() < 2 || correct.len() != 1 => return None,
        "multi" if options.len() < 2 || correct.is_empty() => return None,
        "fill" => {
            let n = blank_count(&text);
            if n == 0 || blanks.len() < n || blanks.iter().take(n).any(|b| b.is_empty()) {
                return None;
            }
            blanks.truncate(n);
        }
        _ => {}
    }
    if qtype != "single" && qtype != "multi" {
        options.clear();
        correct.clear();
    }
    if qtype != "fill" {
        blanks.clear();
    }
    let marks = v.get("marks").and_then(Value::as_i64).unwrap_or(1).clamp(1, MAX_MARKS);
    let wanted: Vec<String> = v
        .get("topics")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(|t| clip(t, 120)).filter(|t| !t.is_empty()).collect())
        .unwrap_or_default();
    let mut qt: Vec<String> = Vec::new();
    for t in wanted {
        let pick = if topics.is_empty() { Some(t) } else { topics.iter().find(|x| x.eq_ignore_ascii_case(&t)).cloned() };
        if let Some(p) = pick {
            if !qt.contains(&p) {
                qt.push(p);
            }
        }
    }
    qt.truncate(4);
    let mut spec: Vec<String> = Vec::new();
    for t in v.get("spec_areas").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).collect::<Vec<_>>()).unwrap_or_default() {
        let t = t.trim();
        // A label, or just its code ("A1" for "A1 Digital devices").
        let hit = spec_allowed.iter().find(|x| x.eq_ignore_ascii_case(t) || x.split_whitespace().next().is_some_and(|c| c.eq_ignore_ascii_case(t)));
        if let Some(h) = hit {
            if !spec.contains(h) {
                spec.push(h.clone());
            }
        }
    }
    spec.truncate(4);
    let mut option_notes: Vec<String> = if options.is_empty() {
        Vec::new()
    } else {
        v.get("option_feedback").and_then(Value::as_array).map(|a| a.iter().map(|o| clip(o.as_str().unwrap_or(""), 600)).take(options.len()).collect()).unwrap_or_default()
    };
    if option_notes.iter().all(String::is_empty) {
        option_notes.clear();
    }
    let difficulty = match s("difficulty") {
        d @ ("easy" | "medium" | "hard") => d.to_string(),
        _ => "medium".into(),
    };
    Some(Question {
        id: 0,
        paper_id: None,
        paper_title: String::new(),
        source: String::new(),
        user_id: None,
        number: clip(s("number"), 40),
        text,
        qtype: qtype.to_string(),
        options,
        correct,
        blanks,
        marks,
        scheme: clip(s("mark_scheme"), 20_000),
        topics: qt,
        difficulty,
        created_at: 0,
        qualification: String::new(),
        paper_number: String::new(),
        spec,
        profile_id: None,
        hint: clip(s("hint"), 600),
        explanation: clip(s("explanation"), 3000),
        option_notes,
    })
}

const Q_COLS: &str = "q.id, q.paper_id, COALESCE(p.title, ''), q.source, q.user_id, q.number, q.text, q.qtype, q.options, \
                      q.answer, q.marks, q.scheme, q.topics, q.difficulty, q.created_at, COALESCE(p.qualification, ''), \
                      COALESCE(p.paper_number, ''), q.spec, q.profile_id";

fn q_row(r: &rusqlite::Row) -> rusqlite::Result<Question> {
    let answer: Value = serde_json::from_str(&r.get::<_, String>(9)?).unwrap_or(json!({}));
    Ok(Question {
        id: r.get(0)?,
        paper_id: r.get(1)?,
        paper_title: r.get(2)?,
        source: r.get(3)?,
        user_id: r.get(4)?,
        number: r.get(5)?,
        text: r.get(6)?,
        qtype: r.get(7)?,
        options: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or_default(),
        correct: serde_json::from_value(answer.get("correct").cloned().unwrap_or(json!([]))).unwrap_or_default(),
        blanks: serde_json::from_value(answer.get("blanks").cloned().unwrap_or(json!([]))).unwrap_or_default(),
        marks: r.get(10)?,
        scheme: r.get(11)?,
        topics: serde_json::from_str(&r.get::<_, String>(12)?).unwrap_or_default(),
        difficulty: r.get(13)?,
        created_at: r.get(14)?,
        qualification: r.get(15)?,
        paper_number: r.get(16)?,
        spec: serde_json::from_str(&r.get::<_, String>(17)?).unwrap_or_default(),
        profile_id: r.get(18)?,
        hint: answer.get("hint").and_then(Value::as_str).unwrap_or("").to_string(),
        explanation: answer.get("explanation").and_then(Value::as_str).unwrap_or("").to_string(),
        option_notes: serde_json::from_value(answer.get("optionNotes").cloned().unwrap_or(json!([]))).unwrap_or_default(),
    })
}

fn insert_q(tx: &rusqlite::Transaction, vault: &str, paper: Option<i64>, source: &str, user: Option<i64>, q: &Question) -> rusqlite::Result<i64> {
    tx.execute(
        "INSERT INTO questions (vault_id, paper_id, source, user_id, number, text, qtype, options, answer, marks, scheme, topics, difficulty, created_at, spec, profile_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        params![
            vault,
            paper,
            source,
            user,
            q.number,
            q.text,
            q.qtype,
            serde_json::to_string(&q.options).unwrap_or_default(),
            json!({ "correct": q.correct, "blanks": q.blanks, "hint": q.hint, "explanation": q.explanation, "optionNotes": q.option_notes }).to_string(),
            q.marks,
            q.scheme,
            serde_json::to_string(&q.topics).unwrap_or_default(),
            q.difficulty,
            now(),
            serde_json::to_string(&q.spec).unwrap_or_default(),
            q.profile_id
        ],
    )?;
    Ok(tx.last_insert_rowid())
}

/// What a past paper is, from its cover.
#[derive(Clone, Debug, Default)]
pub struct PaperInfo {
    pub qualification: String,
    pub paper_number: String,
    pub month: String,
    pub year: i64,
}

const MONTHS: &[&str] = &["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

impl PaperInfo {
    /// Tidy what Claude read off the cover: a month by its full name, a believable year (or 0).
    pub fn clean(qualification: &str, paper_number: &str, month: &str, year: i64) -> PaperInfo {
        let m = month.trim();
        let first3: String = m.to_lowercase().chars().take(3).collect();
        let month = MONTHS
            .iter()
            .find(|full| first3.chars().count() == 3 && full.to_lowercase().starts_with(&first3))
            .map(|f| f.to_string())
            .unwrap_or_else(|| clip(m, 30));
        PaperInfo {
            qualification: clip(qualification, 150),
            paper_number: clip(paper_number, 40),
            month,
            year: if (1980..=2100).contains(&year) { year } else { 0 },
        }
    }

    /// A name for the paper, such as "June 2024 Paper 1".
    pub fn title(&self) -> String {
        let when = [self.month.clone(), if self.year > 0 { self.year.to_string() } else { String::new() }]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" ");
        [when, self.paper_number.clone()].into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" ")
    }

    pub fn month_index(&self) -> i64 {
        MONTHS.iter().position(|m| *m == self.month).map(|i| i as i64 + 1).unwrap_or(0)
    }
}

#[derive(Clone, Debug)]
pub struct Paper {
    pub id: i64,
    pub info: PaperInfo,
    pub user_id: Option<i64>,
    pub username: String,
    pub title: String,
    pub exam_path: String,
    pub scheme_path: String,
    /// The inserts given with the paper (case studies, source booklets, data sheets), as vault paths.
    pub insert_paths: Vec<String>,
    pub questions: i64,
    pub created_at: i64,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub vault_id: String,
    pub user_id: i64,
    pub title: String,
    pub kind: String,
    pub settings: Value,
    pub status: String,
    pub error: String,
    pub question_ids: Vec<i64>,
    pub score: i64,
    pub total: i64,
    pub created_at: i64,
}

const S_COLS: &str = "id, vault_id, user_id, title, kind, settings, status, error, question_ids, score, total, created_at";

fn s_row(r: &rusqlite::Row) -> rusqlite::Result<Session> {
    Ok(Session {
        id: r.get(0)?,
        vault_id: r.get(1)?,
        user_id: r.get(2)?,
        title: r.get(3)?,
        kind: r.get(4)?,
        settings: serde_json::from_str(&r.get::<_, String>(5)?).unwrap_or(json!({})),
        status: r.get(6)?,
        error: r.get(7)?,
        question_ids: serde_json::from_str(&r.get::<_, String>(8)?).unwrap_or_default(),
        score: r.get(9)?,
        total: r.get(10)?,
        created_at: r.get(11)?,
    })
}

#[derive(Clone, Debug)]
pub struct Attempt {
    pub id: i64,
    pub session_id: String,
    pub question_id: Option<i64>,
    pub question: Value,
    pub answer: Value,
    pub marks: Option<i64>,
    pub total: i64,
    pub feedback: Value,
    pub created_at: i64,
}

const A_COLS: &str = "id, session_id, question_id, question, answer, marks, total, feedback, created_at";

fn a_row(r: &rusqlite::Row) -> rusqlite::Result<Attempt> {
    Ok(Attempt {
        id: r.get(0)?,
        session_id: r.get(1)?,
        question_id: r.get(2)?,
        question: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(json!({})),
        answer: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or(json!({})),
        marks: r.get(5)?,
        total: r.get(6)?,
        feedback: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or(json!({})),
        created_at: r.get(8)?,
    })
}

#[derive(Clone, Debug)]
pub struct Deck {
    pub id: String,
    pub user_id: i64,
    pub title: String,
    pub settings: Value,
    pub status: String,
    pub error: String,
    pub cards: Value,
    pub progress: Value,
    pub created_at: i64,
}

/// A study guide, briefing, glossary or other report Claude wrote from the notes.
#[derive(Clone, Debug)]
pub struct Report {
    pub id: String,
    pub user_id: i64,
    pub kind: String,
    pub title: String,
    pub settings: Value,
    pub status: String,
    pub error: String,
    pub content: String,
    pub created_at: i64,
}

const R_COLS: &str = "id, user_id, kind, title, settings, status, error, content, created_at";

fn r_row(r: &rusqlite::Row) -> rusqlite::Result<Report> {
    Ok(Report {
        id: r.get(0)?,
        user_id: r.get(1)?,
        kind: r.get(2)?,
        title: r.get(3)?,
        settings: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or(json!({})),
        status: r.get(5)?,
        error: r.get(6)?,
        content: r.get(7)?,
        created_at: r.get(8)?,
    })
}

const D_COLS: &str = "id, user_id, title, settings, status, error, cards, progress, created_at";

fn d_row(r: &rusqlite::Row) -> rusqlite::Result<Deck> {
    Ok(Deck {
        id: r.get(0)?,
        user_id: r.get(1)?,
        title: r.get(2)?,
        settings: serde_json::from_str(&r.get::<_, String>(3)?).unwrap_or(json!({})),
        status: r.get(4)?,
        error: r.get(5)?,
        cards: serde_json::from_str(&r.get::<_, String>(6)?).unwrap_or(json!([])),
        progress: serde_json::from_str(&r.get::<_, String>(7)?).unwrap_or(json!({})),
        created_at: r.get(8)?,
    })
}

impl Db {
    // ---------- question hub

    /// Add a past paper and the questions taken from it, together.
    #[allow(clippy::too_many_arguments)]
    pub async fn add_paper(&self, vault: String, who: Who, title: String, info: PaperInfo, exam: String, scheme: String, inserts: Vec<String>, qs: Vec<Question>) -> Result<i64> {
        self.call(move |c| {
            let tx = c.transaction()?;
            tx.execute(
                "INSERT INTO hub_papers (vault_id, user_id, username, title, exam_path, scheme_path, created_at, qualification, paper_number, month, year, insert_paths)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![vault, who.0, who.1, title, exam, scheme, now(), info.qualification, info.paper_number, info.month, info.year, serde_json::to_string(&inserts).unwrap_or_else(|_| "[]".into())],
            )?;
            let pid = tx.last_insert_rowid();
            for q in &qs {
                insert_q(&tx, &vault, Some(pid), "paper", Some(who.0), q)?;
            }
            tx.commit()?;
            Ok(pid)
        })
        .await
    }

    pub async fn add_questions(&self, vault: String, source: &'static str, user: i64, qs: Vec<Question>) -> Result<Vec<i64>> {
        self.call(move |c| {
            let tx = c.transaction()?;
            let mut ids = Vec::new();
            for q in &qs {
                ids.push(insert_q(&tx, &vault, None, source, Some(user), q)?);
            }
            tx.commit()?;
            Ok(ids)
        })
        .await
    }

    pub async fn papers(&self, vault: String) -> Result<Vec<Paper>> {
        self.call(move |c| {
            let mut st = c.prepare(
                "SELECT p.id, p.user_id, p.username, p.title, p.exam_path, p.scheme_path,
                        (SELECT COUNT(*) FROM questions q WHERE q.paper_id = p.id), p.created_at,
                        p.qualification, p.paper_number, p.month, p.year, p.insert_paths
                 FROM hub_papers p WHERE p.vault_id = ?1",
            )?;
            let rows: rusqlite::Result<Vec<Paper>> = st
                .query_map([vault], |r| {
                    Ok(Paper {
                        id: r.get(0)?,
                        info: PaperInfo { qualification: r.get(8)?, paper_number: r.get(9)?, month: r.get(10)?, year: r.get(11)? },
                        user_id: r.get(1)?,
                        username: r.get(2)?,
                        title: r.get(3)?,
                        exam_path: r.get(4)?,
                        scheme_path: r.get(5)?,
                        insert_paths: serde_json::from_str(&r.get::<_, String>(12)?).unwrap_or_default(),
                        questions: r.get(6)?,
                        created_at: r.get(7)?,
                    })
                })?
                .collect();
            // Newest exams first, then by qualification and paper number.
            rows.map(|mut v| {
                v.sort_by(|a, b| {
                    (b.info.year, b.info.month_index())
                        .cmp(&(a.info.year, a.info.month_index()))
                        .then(a.info.qualification.to_lowercase().cmp(&b.info.qualification.to_lowercase()))
                        .then(a.info.paper_number.cmp(&b.info.paper_number))
                        .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
                });
                v
            })
        })
        .await
    }

    pub async fn delete_paper(&self, vault: String, id: i64) -> Result<bool> {
        self.call(move |c| c.execute("DELETE FROM hub_papers WHERE id = ?1 AND vault_id = ?2", params![id, vault]).map(|n| n > 0)).await
    }

    /// Every question of a vault (filtered by the caller), newest papers' questions in paper order.
    pub async fn questions(&self, vault: String) -> Result<Vec<Question>> {
        self.call(move |c| {
            let mut st = c.prepare(&format!(
                "SELECT {Q_COLS} FROM questions q LEFT JOIN hub_papers p ON p.id = q.paper_id WHERE q.vault_id = ?1
                 ORDER BY q.paper_id IS NULL, p.year DESC, p.qualification COLLATE NOCASE, p.paper_number, p.title COLLATE NOCASE, q.id"
            ))?;
            let rows = st.query_map([vault], q_row)?.collect();
            rows
        })
        .await
    }

    pub async fn questions_by_id(&self, vault: String, ids: Vec<i64>) -> Result<Vec<Question>> {
        self.call(move |c| {
            let mut out = Vec::new();
            let mut st = c.prepare(&format!("SELECT {Q_COLS} FROM questions q LEFT JOIN hub_papers p ON p.id = q.paper_id WHERE q.id = ?1 AND q.vault_id = ?2"))?;
            for id in ids {
                if let Some(q) = st.query_row(params![id, vault], q_row).optional()? {
                    out.push(q);
                }
            }
            Ok(out)
        })
        .await
    }

    // ---------- practice sessions and attempts

    pub async fn create_practice_session(&self, s: Session) -> Result<()> {
        self.call(move |c| {
            c.execute(
                "INSERT INTO practice_sessions (id, vault_id, user_id, title, kind, settings, status, question_ids, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                params![s.id, s.vault_id, s.user_id, s.title, s.kind, s.settings.to_string(), s.status, serde_json::to_string(&s.question_ids).unwrap_or_default(), now()],
            )
            .map(|_| ())
        })
        .await
    }

    pub async fn practice_session(&self, id: String) -> Result<Option<Session>> {
        self.call(move |c| c.query_row(&format!("SELECT {S_COLS} FROM practice_sessions WHERE id = ?1"), [id], s_row).optional()).await
    }

    pub async fn practice_sessions(&self, user: i64, vault: String, limit: i64) -> Result<Vec<Session>> {
        self.call(move |c| {
            let mut st = c.prepare(&format!(
                "SELECT {S_COLS} FROM practice_sessions WHERE user_id = ?1 AND vault_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT ?3"
            ))?;
            let rows = st.query_map(params![user, vault, limit], s_row)?.collect();
            rows
        })
        .await
    }

    pub async fn set_session(&self, id: String, status: &'static str, error: String, question_ids: Option<Vec<i64>>, score: Option<(i64, i64)>) -> Result<()> {
        self.call(move |c| {
            c.execute("UPDATE practice_sessions SET status = ?2, error = ?3, updated_at = ?4 WHERE id = ?1", params![id, status, error, now()])?;
            if let Some(q) = question_ids {
                c.execute("UPDATE practice_sessions SET question_ids = ?2 WHERE id = ?1", params![id, serde_json::to_string(&q).unwrap_or_default()])?;
            }
            if let Some((s, t)) = score {
                c.execute("UPDATE practice_sessions SET score = ?2, total = ?3 WHERE id = ?1", params![id, s, t])?;
            }
            Ok(())
        })
        .await
    }

    /// Move a session from one status to another, only if it is still in the first. True if it moved.
    pub async fn claim_session(&self, id: String, from: &'static str, to: &'static str) -> Result<bool> {
        self.call(move |c| {
            c.execute("UPDATE practice_sessions SET status = ?3, updated_at = ?4 WHERE id = ?1 AND status = ?2", params![id, from, to, now()]).map(|n| n > 0)
        })
        .await
    }

    /// Replace a session's settings (they also hold answers already checked one at a time).
    pub async fn set_session_settings(&self, id: String, settings: Value) -> Result<()> {
        self.call(move |c| c.execute("UPDATE practice_sessions SET settings = ?2, updated_at = ?3 WHERE id = ?1", params![id, settings.to_string(), now()]).map(|_| ())).await
    }

    pub async fn add_attempts(&self, session: String, user: i64, vault: String, rows: Vec<(Option<i64>, Value, Value, i64)>) -> Result<()> {
        self.call(move |c| {
            let tx = c.transaction()?;
            for (qid, q, a, total) in rows {
                tx.execute(
                    "INSERT INTO attempts (session_id, user_id, vault_id, question_id, question, answer, total, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                    params![session, user, vault, qid, q.to_string(), a.to_string(), total, now()],
                )?;
            }
            tx.commit()
        })
        .await
    }

    pub async fn attempts(&self, session: String) -> Result<Vec<Attempt>> {
        self.call(move |c| {
            let mut st = c.prepare(&format!("SELECT {A_COLS} FROM attempts WHERE session_id = ?1 ORDER BY id"))?;
            let rows = st.query_map([session], a_row)?.collect();
            rows
        })
        .await
    }

    /// Every marked answer an account gave in a vault, oldest first.
    pub async fn marked_attempts(&self, user: i64, vault: String) -> Result<Vec<Attempt>> {
        self.call(move |c| {
            let mut st = c.prepare(&format!("SELECT {A_COLS} FROM attempts WHERE user_id = ?1 AND vault_id = ?2 AND marks IS NOT NULL ORDER BY id"))?;
            let rows = st.query_map(params![user, vault], a_row)?.collect();
            rows
        })
        .await
    }

    pub async fn mark_attempt(&self, id: i64, marks: Option<i64>, feedback: Value) -> Result<()> {
        self.call(move |c| c.execute("UPDATE attempts SET marks = ?2, feedback = ?3 WHERE id = ?1", params![id, marks, feedback.to_string()]).map(|_| ())).await
    }

    // ---------- flashcards

    pub async fn create_deck(&self, id: String, vault: String, user: i64, title: String, settings: Value) -> Result<()> {
        self.call(move |c| {
            c.execute(
                "INSERT INTO flash_decks (id, vault_id, user_id, title, settings, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'generating', ?6, ?6)",
                params![id, vault, user, title, settings.to_string(), now()],
            )
            .map(|_| ())
        })
        .await
    }

    pub async fn deck(&self, id: String) -> Result<Option<Deck>> {
        self.call(move |c| c.query_row(&format!("SELECT {D_COLS} FROM flash_decks WHERE id = ?1"), [id], d_row).optional()).await
    }

    pub async fn decks(&self, user: i64, vault: String) -> Result<Vec<Deck>> {
        self.call(move |c| {
            let mut st = c.prepare(&format!("SELECT {D_COLS} FROM flash_decks WHERE user_id = ?1 AND vault_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT 100"))?;
            let rows = st.query_map(params![user, vault], d_row)?.collect();
            rows
        })
        .await
    }

    pub async fn finish_deck(&self, id: String, status: &'static str, error: String, cards: Value) -> Result<()> {
        self.call(move |c| {
            c.execute("UPDATE flash_decks SET status = ?2, error = ?3, cards = ?4, updated_at = ?5 WHERE id = ?1", params![id, status, error, cards.to_string(), now()]).map(|_| ())
        })
        .await
    }

    pub async fn set_deck_progress(&self, id: String, user: i64, progress: Value) -> Result<bool> {
        self.call(move |c| {
            c.execute("UPDATE flash_decks SET progress = ?3, updated_at = ?4 WHERE id = ?1 AND user_id = ?2", params![id, user, progress.to_string(), now()]).map(|n| n > 0)
        })
        .await
    }

    /// Replace a deck's cards (after editing, adding or deleting cards) and its progress.
    pub async fn set_deck_cards(&self, id: String, user: i64, cards: Value, progress: Value) -> Result<bool> {
        self.call(move |c| {
            c.execute("UPDATE flash_decks SET cards = ?3, progress = ?4, updated_at = ?5 WHERE id = ?1 AND user_id = ?2", params![id, user, cards.to_string(), progress.to_string(), now()])
                .map(|n| n > 0)
        })
        .await
    }

    // ---------- study guides and reports

    pub async fn create_report(&self, id: String, vault: String, user: i64, kind: String, title: String, settings: Value) -> Result<()> {
        self.call(move |c| {
            c.execute(
                "INSERT INTO practice_reports (id, vault_id, user_id, kind, title, settings, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'generating', ?7, ?7)",
                params![id, vault, user, kind, title, settings.to_string(), now()],
            )
            .map(|_| ())
        })
        .await
    }

    pub async fn finish_report(&self, id: String, status: &'static str, error: String, title: Option<String>, content: String) -> Result<()> {
        self.call(move |c| {
            c.execute("UPDATE practice_reports SET status = ?2, error = ?3, content = ?4, updated_at = ?5 WHERE id = ?1", params![id, status, error, content, now()])?;
            if let Some(t) = title {
                c.execute("UPDATE practice_reports SET title = ?2 WHERE id = ?1", params![id, t])?;
            }
            Ok(())
        })
        .await
    }

    pub async fn reports(&self, user: i64, vault: String) -> Result<Vec<Report>> {
        self.call(move |c| {
            let mut st = c.prepare(&format!("SELECT {R_COLS} FROM practice_reports WHERE user_id = ?1 AND vault_id = ?2 ORDER BY created_at DESC, rowid DESC LIMIT 100"))?;
            let rows = st.query_map(params![user, vault], r_row)?.collect();
            rows
        })
        .await
    }

    pub async fn report(&self, id: String) -> Result<Option<Report>> {
        self.call(move |c| c.query_row(&format!("SELECT {R_COLS} FROM practice_reports WHERE id = ?1"), [id], r_row).optional()).await
    }

    pub async fn delete_report(&self, id: String, user: i64) -> Result<bool> {
        self.call(move |c| c.execute("DELETE FROM practice_reports WHERE id = ?1 AND user_id = ?2", params![id, user]).map(|n| n > 0)).await
    }

    pub async fn delete_deck(&self, id: String, user: i64) -> Result<bool> {
        self.call(move |c| c.execute("DELETE FROM flash_decks WHERE id = ?1 AND user_id = ?2", params![id, user]).map(|n| n > 0)).await
    }

    // ---------- exam coach

    pub async fn coach_messages(&self, user: i64, vault: String, limit: i64) -> Result<Vec<(String, String, i64)>> {
        self.call(move |c| {
            let mut st = c.prepare(
                "SELECT role, content, created_at FROM (SELECT id, role, content, created_at FROM coach_messages WHERE user_id = ?1 AND vault_id = ?2 ORDER BY id DESC LIMIT ?3) ORDER BY id",
            )?;
            let rows = st.query_map(params![user, vault, limit], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect();
            rows
        })
        .await
    }

    pub async fn add_coach_message(&self, user: i64, vault: String, role: &'static str, content: String) -> Result<()> {
        self.call(move |c| {
            c.execute("INSERT INTO coach_messages (vault_id, user_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)", params![vault, user, role, content, now()]).map(|_| ())
        })
        .await
    }

    pub async fn clear_coach(&self, user: i64, vault: String) -> Result<()> {
        self.call(move |c| c.execute("DELETE FROM coach_messages WHERE user_id = ?1 AND vault_id = ?2", params![user, vault]).map(|_| ())).await
    }
}

// ---------------------------------------------------------------- notes as context

/// The vault's topics: the notes in its topics folder (Admin → Microsidian), by name, without the topics index.
pub fn vault_topics(idx: &VaultIndex, s: &Settings) -> Vec<String> {
    let prefix = format!("{}/", s.topics.trim_end_matches('/'));
    let mut out: Vec<String> = idx
        .notes()
        .filter(|p| p.starts_with(&prefix))
        .map(|p| p.rsplit('/').next().unwrap_or(p).trim_end_matches(".md").to_string())
        .filter(|n| !n.eq_ignore_ascii_case(&s.topics_index) && !n.to_lowercase().ends_with(" - index"))
        .collect();
    out.sort_by_key(|a| a.to_lowercase());
    out.dedup();
    out
}

/// A note's own text: no frontmatter and no Connections block.
fn note_text(idx: &VaultIndex, rel: &str) -> String {
    let Some(disk) = idx.disk_path(rel) else { return String::new() };
    if std::fs::metadata(&disk).map(|m| m.len() > 2 * 1024 * 1024).unwrap_or(true) {
        return String::new();
    }
    let raw = std::fs::read_to_string(&disk).unwrap_or_default();
    let (main, _) = markdown::split_connections(&raw);
    markdown::strip_frontmatter(&main).trim().to_string()
}

fn cut(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let mut end = max;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n[…]", &s[..end])
}

/// The notes on the chosen topics (the topic page and every note linking to it), shared fairly within the budget.
/// With no topics chosen (a vault without topic pages), notes from across the vault.
pub fn notes_context(idx: &VaultIndex, s: &Settings, topics: &[String]) -> String {
    let skip = |p: &str| {
        p.starts_with(&format!("{}/", s.originals)) || p.starts_with(&format!("{}/", s.attachments.split('/').next().unwrap_or(""))) || p.split('/').any(|seg| seg.starts_with('.'))
    };
    let mut out = String::new();
    if topics.is_empty() {
        let notes: Vec<&String> = idx.notes().filter(|p| !skip(p)).collect();
        let per = (NOTES_BUDGET / notes.len().max(1)).max(1500);
        for n in notes {
            if out.len() > NOTES_BUDGET {
                break;
            }
            let t = note_text(idx, n);
            if !t.is_empty() {
                out.push_str(&format!("<note path=\"{}\">\n{}\n</note>\n", n.replace('"', "'"), cut(&t, per)));
            }
        }
        return out;
    }
    let links = idx.links();
    let per_topic = NOTES_BUDGET / topics.len();
    let folder = s.topics.trim_end_matches('/');
    for t in topics {
        let page = format!("{folder}/{t}.md");
        let mut notes: Vec<String> = links
            .backlinks
            .get(&page)
            .map(|v| v.iter().filter(|p| !p.starts_with(&format!("{folder}/")) && !p.to_lowercase().ends_with(" - index.md") && !skip(p)).cloned().collect())
            .unwrap_or_default();
        notes.sort();
        let mut block = String::new();
        let page_text = note_text(idx, &page);
        if !page_text.is_empty() {
            block.push_str(&format!("<topic_page>\n{}\n</topic_page>\n", cut(&page_text, 4000)));
        }
        let per = ((per_topic.saturating_sub(block.len())) / notes.len().max(1)).max(1500);
        for n in notes {
            if block.len() > per_topic {
                break;
            }
            let text = note_text(idx, &n);
            if !text.is_empty() {
                block.push_str(&format!("<note path=\"{}\">\n{}\n</note>\n", n.replace('"', "'"), cut(&text, per)));
            }
        }
        out.push_str(&format!("<topic name=\"{}\">\n{}</topic>\n", t.replace('"', "'"), block));
    }
    out
}

/// Past paper questions most like what was asked for, as examples of the course's style.
pub fn examples(all: &[Question], topics: &[String], types: &[String], marks: &[i64], paper: Option<(&str, &str)>) -> String {
    let same_paper = |q: &Question| paper.is_none_or(|(qual, num)| q.qualification.eq_ignore_ascii_case(qual) && q.paper_number.eq_ignore_ascii_case(num));
    // Past questions of the chosen paper, or of any paper when it has none in the hub yet.
    let any_of_paper = all.iter().any(|q| q.source == "paper" && same_paper(q));
    let mut scored: Vec<(i64, &Question)> = all
        .iter()
        .filter(|q| q.source == "paper" && (!any_of_paper || same_paper(q)))
        .map(|q| {
            let t = q.topics.iter().filter(|x| topics.iter().any(|y| y.eq_ignore_ascii_case(x))).count() as i64;
            let score = t * 3 + if types.contains(&q.qtype) { 2 } else { 0 } + if marks.contains(&q.marks) { 2 } else { 0 };
            (score, q)
        })
        .collect();
    scored.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.id.cmp(&b.1.id)));
    let mut out = String::new();
    for (_, q) in scored.into_iter().take(EXAMPLES) {
        out.push_str(&format!(
            "<example paper=\"{}\" marks=\"{}\" type=\"{}\" topics=\"{}\">\n<question>\n{}\n</question>\n<mark_scheme>\n{}\n</mark_scheme>\n</example>\n",
            format!("{} {}", q.paper_title, q.number).trim().replace('"', "'"),
            q.marks,
            q.qtype,
            q.topics.join(", ").replace('"', "'"),
            cut(&q.text, 4000),
            cut(&q.scheme, 4000)
        ));
    }
    out
}

// ---------------------------------------------------------------- marking

fn norm(s: &str) -> String {
    let lower = s.to_lowercase();
    let t: String = lower.chars().map(|c| if c.is_alphanumeric() || c == '.' || c == '%' { c } else { ' ' }).collect();
    let words: Vec<&str> = t.split_whitespace().collect();
    let words: Vec<&str> = if words.len() > 1 && matches!(words[0], "a" | "an" | "the") { words[1..].to_vec() } else { words };
    words.join(" ").trim_end_matches('.').to_string()
}

/// Marks for an answer to a question that can be marked without Claude (single, multi, fill), with feedback.
pub fn mark_objective(q: &Question, answer: &Value) -> (i64, Value) {
    let total = q.marks;
    match q.qtype.as_str() {
        "single" => {
            let pick = answer.get("choice").and_then(Value::as_u64).map(|i| i as usize);
            let right = pick.is_some() && q.correct.first() == pick.as_ref();
            (if right { total } else { 0 }, json!({ "right": right }))
        }
        "multi" => {
            let picks: HashSet<usize> = answer.get("choices").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_u64).map(|i| i as usize).collect()).unwrap_or_default();
            let correct: HashSet<usize> = q.correct.iter().copied().collect();
            let right = picks.intersection(&correct).count() as i64;
            let wrong = picks.difference(&correct).count() as i64;
            let per = total as f64 / correct.len().max(1) as f64;
            let marks = (((right - wrong).max(0)) as f64 * per).floor() as i64;
            (marks.min(total), json!({ "right": right, "wrong": wrong }))
        }
        "fill" => {
            let given: Vec<String> = answer.get("blanks").and_then(Value::as_array).map(|a| a.iter().map(|v| v.as_str().unwrap_or("").to_string()).collect()).unwrap_or_default();
            let ok: Vec<bool> = q
                .blanks
                .iter()
                .enumerate()
                .map(|(i, accepted)| {
                    let g = norm(given.get(i).map(String::as_str).unwrap_or(""));
                    !g.is_empty() && accepted.iter().any(|a| norm(a) == g)
                })
                .collect();
            let per = total as f64 / q.blanks.len().max(1) as f64;
            let marks = (ok.iter().filter(|b| **b).count() as f64 * per).floor() as i64;
            (marks.min(total), json!({ "blanks": ok }))
        }
        _ => (0, json!({})),
    }
}

/// Mark a written answer against its mark scheme with Claude.
pub async fn mark_written(st: &AppState, who: &Who, vault_id: &str, q: &Question, text: &str, guidance: Option<String>) -> Result<(i64, Value), String> {
    let s = Settings::load(&st.db).await.map_err(|_| "The settings could not be read.".to_string())?;
    let scheme = if q.scheme.trim().is_empty() { "(No mark scheme was given: mark as an examiner for this course would.)" } else { &q.scheme };
    let msg = format!(
        "<question marks=\"{}\">\n{}\n</question>\n\n<mark_scheme>\n{}\n</mark_scheme>\n\n<answer>\n{}\n</answer>",
        q.marks,
        q.text,
        scheme,
        text.replace("</answer>", "")
    );
    let schema = object(json!({
        "marks": { "type": "integer" },
        "feedback": { "type": "string" },
        "points_met": strings(),
        "points_missed": strings(),
        "model_answer": { "type": "string" },
    }));
    let v = ask(st, who, vault_id, "marking", s.mark_prompt(), guidance.map(|g| format!("<paper_guidance>\n{g}\n</paper_guidance>")), json!([{ "role": "user", "content": msg }]), Some(schema), 8000).await?;
    let marks = v.get("marks").and_then(Value::as_i64).unwrap_or(0).clamp(0, q.marks);
    let list = |k: &str| v.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(|x| clip(x, 400)).take(20).collect::<Vec<_>>()).unwrap_or_default();
    Ok((
        marks,
        json!({
            "feedback": clip(v.get("feedback").and_then(Value::as_str).unwrap_or(""), 3000),
            "met": list("points_met"),
            "missed": list("points_missed"),
            "model": clip(v.get("model_answer").and_then(Value::as_str).unwrap_or(""), 6000),
        }),
    ))
}

/// Mark every answer of a session: the objective ones here, written ones by Claude, several at a time.
pub async fn mark_session(st: AppState, who: Who, session: Session) {
    let attempts = match st.db.attempts(session.id.clone()).await {
        Ok(a) => a,
        Err(e) => {
            tracing::error!("marking {}: {e:#}", session.id);
            let _ = st.db.set_session(session.id.clone(), "failed", "The answers could not be read.".into(), None, None).await;
            return;
        }
    };
    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(MARK_PARALLEL));
    // Each paper's marking tips and common mistakes, for answers to its questions.
    let guides: std::sync::Arc<HashMap<i64, String>> = std::sync::Arc::new(
        st.db.profiles(session.vault_id.clone()).await.unwrap_or_default().iter().map(|p| (p.id, p.marking_guidance())).filter(|(_, g)| !g.is_empty()).collect(),
    );
    // Written answers already marked with "Check" (one question at a time), unchanged since: keep that marking.
    let checked: std::sync::Arc<serde_json::Map<String, Value>> =
        std::sync::Arc::new(session.settings.get("checked").and_then(Value::as_object).cloned().unwrap_or_default());
    let mut set = tokio::task::JoinSet::new();
    for a in attempts {
        let checked = checked.clone();
        let st = st.clone();
        let who = who.clone();
        let vault = session.vault_id.clone();
        let sem = sem.clone();
        let guides = guides.clone();
        set.spawn(async move {
            let q = Question::from_snapshot(&a.question);
            let (marks, feedback) = if q.qtype == "written" {
                let text = a.answer.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
                let earlier = a.question.get("id").and_then(Value::as_i64).and_then(|id| checked.get(&id.to_string())).filter(|c| {
                    c.pointer("/answer/text").and_then(Value::as_str).map(str::trim) == Some(text.as_str()) && c.get("marks").and_then(Value::as_i64).is_some()
                });
                if text.is_empty() {
                    (Some(0), json!({ "feedback": "No answer was given." }))
                } else if let Some(c) = earlier {
                    (c.get("marks").and_then(Value::as_i64).map(|m| m.clamp(0, q.marks)), c.get("feedback").cloned().unwrap_or(json!({})))
                } else {
                    let _permit = sem.acquire().await;
                    let guide = q.profile_id.and_then(|id| guides.get(&id).cloned());
                    match mark_written(&st, &who, &vault, &q, &text, guide).await {
                        Ok((m, f)) => (Some(m), f),
                        Err(e) => (None, json!({ "error": format!("This answer could not be marked: {e}") })),
                    }
                }
            } else {
                let (m, f) = mark_objective(&q, &a.answer);
                (Some(m), f)
            };
            let _ = st.db.mark_attempt(a.id, marks, feedback).await;
            (marks, a.total)
        });
    }
    let (mut score, mut total, mut unmarked) = (0i64, 0i64, 0usize);
    while let Some(r) = set.join_next().await {
        if let Ok((m, t)) = r {
            total += t;
            match m {
                Some(m) => score += m,
                None => unmarked += 1,
            }
        }
    }
    let note = if unmarked > 0 { format!("{unmarked} answer(s) could not be marked; the score leaves them out.") } else { String::new() };
    let _ = st.db.set_session(session.id.clone(), "marked", note, None, Some((score, total))).await;
}

// ---------------------------------------------------------------- course documents and paper guides

pub const DOC_KINDS: &[(&str, &str)] = &[
    ("specification", "Specification"),
    ("examiner_report", "Examiner report"),
    ("answers_commentary", "Answers and commentary"),
    ("notes_guidance", "Notes and guidance"),
    ("mark_scheme", "Mark scheme without its paper"),
];

/// A specification, examiner report, answers and commentary, or notes and guidance, with what Claude read from it.
#[derive(Clone, Debug)]
pub struct Doc {
    pub id: i64,
    pub user_id: Option<i64>,
    pub username: String,
    pub kind: String,
    pub title: String,
    pub path: String,
    pub info: PaperInfo,
    pub digest: Value,
    pub created_at: i64,
}

/// The guide to one examined paper of a qualification: its fields (specification areas), command words, marking
/// tips and common mistakes. `profile` holds what Claude wrote, checked.
#[derive(Clone, Debug)]
pub struct Profile {
    pub id: i64,
    pub qualification: String,
    pub paper_number: String,
    pub title: String,
    pub profile: Value,
    pub updated_at: i64,
}

fn list_of(v: &Value, k: &str) -> Vec<Value> {
    v.get(k).and_then(Value::as_array).cloned().unwrap_or_default()
}
fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

impl Profile {
    /// The labels of its fields, such as "A1 Digital devices".
    pub fn labels(&self) -> Vec<String> {
        list_of(&self.profile, "fields").iter().map(field_label).filter(|l| !l.is_empty()).collect()
    }

    /// The guide as Markdown: for the page, and for Claude when writing or marking questions for this paper.
    pub fn markdown(&self) -> String {
        let p = &self.profile;
        let mut out = format!("## {}\n\n", self.title);
        if !self.qualification.is_empty() {
            out.push_str(&format!("*{}*\n\n", self.qualification));
        }
        if !str_of(p, "overview").is_empty() {
            out.push_str(&format!("{}\n\n", str_of(p, "overview")));
        }
        let fields = list_of(p, "fields");
        if !fields.is_empty() {
            out.push_str("### Fields this paper examines\n\n");
            for f in &fields {
                let marks: Vec<String> = list_of(f, "marks").iter().filter_map(Value::as_i64).map(|m| m.to_string()).collect();
                let types: Vec<String> = list_of(f, "types").iter().filter_map(Value::as_str).map(|t| TYPES.iter().find(|x| x.0 == t).map(|x| x.1.to_lowercase()).unwrap_or_else(|| t.to_string())).collect();
                let mut extra = Vec::new();
                if !marks.is_empty() {
                    extra.push(format!("{} marks", marks.join(", ")));
                }
                if !types.is_empty() {
                    extra.push(types.join(", "));
                }
                out.push_str(&format!(
                    "- **{}**: {}{}\n",
                    field_label(f),
                    str_of(f, "what"),
                    if extra.is_empty() { String::new() } else { format!(" ({})", extra.join("; ")) }
                ));
            }
            out.push('\n');
        }
        let words = list_of(p, "command_words");
        if !words.is_empty() {
            out.push_str("### Command words\n\n");
            for w in &words {
                let marks = str_of(w, "marks");
                out.push_str(&format!("- **{}**{}: {}\n", str_of(w, "word"), if marks.is_empty() { String::new() } else { format!(" ({marks})") }, str_of(w, "meaning")));
            }
            out.push('\n');
        }
        out.push_str(&self.marking_guidance());
        out
    }

    /// Marking tips and common mistakes, as Markdown (what the marker is given).
    pub fn marking_guidance(&self) -> String {
        let mut out = String::new();
        for (k, title) in [("marking_tips", "How marks are earned"), ("common_mistakes", "Common mistakes (examiners' reports)")] {
            let items: Vec<String> = list_of(&self.profile, k).iter().filter_map(Value::as_str).map(str::to_string).collect();
            if !items.is_empty() {
                out.push_str(&format!("### {title}\n\n"));
                for i in items {
                    out.push_str(&format!("- {i}\n"));
                }
                out.push('\n');
            }
        }
        out
    }
}

fn field_label(f: &Value) -> String {
    format!("{} {}", str_of(f, "code").trim(), str_of(f, "title").trim()).trim().to_string()
}

const DOC_COLS: &str = "id, user_id, username, kind, title, path, qualification, paper_number, month, year, digest, created_at";

fn doc_row(r: &rusqlite::Row) -> rusqlite::Result<Doc> {
    Ok(Doc {
        id: r.get(0)?,
        user_id: r.get(1)?,
        username: r.get(2)?,
        kind: r.get(3)?,
        title: r.get(4)?,
        path: r.get(5)?,
        info: PaperInfo { qualification: r.get(6)?, paper_number: r.get(7)?, month: r.get(8)?, year: r.get(9)? },
        digest: serde_json::from_str(&r.get::<_, String>(10)?).unwrap_or(json!({})),
        created_at: r.get(11)?,
    })
}

impl Db {
    #[allow(clippy::too_many_arguments)]
    pub async fn add_doc(&self, vault: String, who: Who, kind: String, title: String, path: String, info: PaperInfo, digest: Value) -> Result<i64> {
        self.call(move |c| {
            c.execute(
                "INSERT INTO hub_docs (vault_id, user_id, username, kind, title, path, qualification, paper_number, month, year, digest, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![vault, who.0, who.1, kind, title, path, info.qualification, info.paper_number, info.month, info.year, digest.to_string(), now()],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await
    }

    pub async fn docs(&self, vault: String) -> Result<Vec<Doc>> {
        self.call(move |c| {
            let mut st = c.prepare(&format!("SELECT {DOC_COLS} FROM hub_docs WHERE vault_id = ?1 ORDER BY qualification COLLATE NOCASE, kind, year DESC, title COLLATE NOCASE"))?;
            let rows = st.query_map([vault], doc_row)?.collect();
            rows
        })
        .await
    }

    pub async fn delete_doc(&self, vault: String, id: i64) -> Result<bool> {
        self.call(move |c| c.execute("DELETE FROM hub_docs WHERE id = ?1 AND vault_id = ?2", params![id, vault]).map(|n| n > 0)).await
    }

    pub async fn profiles(&self, vault: String) -> Result<Vec<Profile>> {
        self.call(move |c| {
            let mut st = c.prepare(
                "SELECT id, qualification, paper_number, title, profile, updated_at FROM paper_profiles WHERE vault_id = ?1
                 ORDER BY qualification COLLATE NOCASE, paper_number COLLATE NOCASE",
            )?;
            let rows = st
                .query_map([vault], |r| {
                    Ok(Profile {
                        id: r.get(0)?,
                        qualification: r.get(1)?,
                        paper_number: r.get(2)?,
                        title: r.get(3)?,
                        profile: serde_json::from_str(&r.get::<_, String>(4)?).unwrap_or(json!({})),
                        updated_at: r.get(5)?,
                    })
                })?
                .collect();
            rows
        })
        .await
    }

    /// Save a qualification's paper guides (keeping the ids of papers that stay, so questions written for them keep
    /// their guide), drop guides for papers no longer listed, and set the fields of its past questions.
    pub async fn save_profiles(&self, vault: String, qualification: String, profiles: Vec<(String, String, Value)>, tags: Vec<(i64, Vec<String>)>) -> Result<()> {
        self.call(move |c| {
            let tx = c.transaction()?;
            let keep: Vec<String> = profiles.iter().map(|p| p.0.clone()).collect();
            for (num, title, json) in &profiles {
                tx.execute(
                    "INSERT INTO paper_profiles (vault_id, qualification, paper_number, title, profile, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT (vault_id, qualification, paper_number) DO UPDATE SET title = excluded.title, profile = excluded.profile, updated_at = excluded.updated_at",
                    params![vault, qualification, num, title, json.to_string(), now()],
                )?;
            }
            let existing: Vec<(i64, String)> = {
                let mut st = tx.prepare("SELECT id, paper_number FROM paper_profiles WHERE vault_id = ?1 AND qualification = ?2")?;
                let rows = st.query_map(params![vault, qualification], |r| Ok((r.get(0)?, r.get(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            for (id, num) in existing {
                if !keep.contains(&num) {
                    tx.execute("DELETE FROM paper_profiles WHERE id = ?1", [id])?;
                }
            }
            for (qid, labels) in tags {
                tx.execute("UPDATE questions SET spec = ?2 WHERE id = ?1 AND vault_id = ?3", params![qid, serde_json::to_string(&labels).unwrap_or_default(), vault])?;
            }
            tx.commit()
        })
        .await
    }

    /// Qualification names in the hub (from papers and documents), for matching new uploads to.
    pub async fn qualifications(&self, vault: String) -> Result<Vec<String>> {
        self.call(move |c| {
            let mut st = c.prepare(
                "SELECT qualification FROM hub_papers WHERE vault_id = ?1 AND qualification != ''
                 UNION SELECT qualification FROM hub_docs WHERE vault_id = ?1 AND qualification != '' ORDER BY 1 COLLATE NOCASE",
            )?;
            let rows = st.query_map([vault], |r| r.get(0))?.collect();
            rows
        })
        .await
    }
}

/// What examiners said about one exam year of a qualification, all its papers and series taken together. `notes`
/// holds what Claude wrote, checked: overview, went_well, common_mistakes, advice.
#[derive(Clone, Debug)]
pub struct YearNotes {
    pub qualification: String,
    pub year: i64,
    pub notes: Value,
    pub updated_at: i64,
}

impl Db {
    pub async fn year_notes(&self, vault: String) -> Result<Vec<YearNotes>> {
        self.call(move |c| {
            let mut st = c.prepare("SELECT qualification, year, notes, updated_at FROM hub_years WHERE vault_id = ?1 ORDER BY year DESC, qualification COLLATE NOCASE")?;
            let rows = st
                .query_map([vault], |r| {
                    Ok(YearNotes { qualification: r.get(0)?, year: r.get(1)?, notes: serde_json::from_str(&r.get::<_, String>(2)?).unwrap_or(json!({})), updated_at: r.get(3)? })
                })?
                .collect();
            rows
        })
        .await
    }

    /// Replace a qualification's year notes with these (years left out lose theirs).
    pub async fn save_year_notes(&self, vault: String, qualification: String, years: Vec<(i64, Value)>) -> Result<()> {
        self.call(move |c| {
            let tx = c.transaction()?;
            tx.execute("DELETE FROM hub_years WHERE vault_id = ?1 AND qualification = ?2", params![vault, qualification])?;
            for (year, notes) in &years {
                tx.execute(
                    "INSERT INTO hub_years (vault_id, qualification, year, notes, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![vault, qualification, year, notes.to_string(), now()],
                )?;
            }
            tx.commit()
        })
        .await
    }
}

/// What clearing a vault's exam data removed.
#[derive(Clone, Copy, Debug, Default)]
pub struct Wiped {
    pub papers: i64,
    pub questions: i64,
    pub docs: i64,
    pub guides: i64,
    pub years: i64,
}

impl Db {
    /// Remove everything the question hub holds for a vault: past papers and their questions, exam documents,
    /// paper guides and year notes. Questions Claude wrote, answers, flashcards and the coach stay (questions
    /// written for a paper's guide lose the link to it).
    pub async fn wipe_exam_data(&self, vault: String) -> Result<Wiped> {
        self.call(move |c| {
            let tx = c.transaction()?;
            let count = |sql: &str| -> rusqlite::Result<i64> { tx.query_row(sql, [&vault], |r| r.get(0)) };
            let w = Wiped {
                papers: count("SELECT COUNT(*) FROM hub_papers WHERE vault_id = ?1")?,
                questions: count("SELECT COUNT(*) FROM questions WHERE vault_id = ?1 AND paper_id IS NOT NULL")?,
                docs: count("SELECT COUNT(*) FROM hub_docs WHERE vault_id = ?1")?,
                guides: count("SELECT COUNT(*) FROM paper_profiles WHERE vault_id = ?1")?,
                years: count("SELECT COUNT(*) FROM hub_years WHERE vault_id = ?1")?,
            };
            tx.execute("DELETE FROM questions WHERE vault_id = ?1 AND paper_id IS NOT NULL", [&vault])?;
            tx.execute("UPDATE questions SET profile_id = NULL WHERE vault_id = ?1 AND profile_id IS NOT NULL", [&vault])?;
            for table in ["hub_papers", "hub_docs", "paper_profiles", "hub_years"] {
                tx.execute(&format!("DELETE FROM {table} WHERE vault_id = ?1"), [&vault])?;
            }
            tx.commit()?;
            Ok(w)
        })
        .await
    }
}

/// Forget the last guide-building errors of a vault (after its exam data is cleared).
pub fn clear_profile_errors(st: &AppState, vault: &str) {
    let prefix = format!("{vault}\u{1f}");
    st.profile_errors.lock().unwrap_or_else(|e| e.into_inner()).retain(|k, _| !k.starts_with(&prefix));
}

/// Doc kinds that say how a year's exams went (a specification is about the course, not a year).
const YEAR_DOC_KINDS: &[&str] = &["examiner_report", "answers_commentary", "notes_guidance"];

/// Write the examiners' notes on each exam year of one qualification, from that year's examiner reports,
/// commentaries and guidance. Years without such documents get no notes. Returns how many years have notes.
pub async fn build_year_notes(st: &AppState, who: &Who, vault: &str, qualification: &str) -> Result<usize, String> {
    let s = Settings::load(&st.db).await.map_err(|_| "The settings could not be read.".to_string())?;
    let same = |q: &str| q.trim().eq_ignore_ascii_case(qualification.trim());
    let docs: Vec<Doc> = st
        .db
        .docs(vault.to_string())
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|d| same(&d.info.qualification) && d.info.year > 0 && YEAR_DOC_KINDS.contains(&d.kind.as_str()))
        .collect();
    let years: Vec<i64> = {
        let mut y: Vec<i64> = docs.iter().map(|d| d.info.year).collect();
        y.sort_unstable_by(|a, b| b.cmp(a));
        y.dedup();
        y
    };
    if years.is_empty() {
        st.db.save_year_notes(vault.to_string(), qualification.to_string(), Vec::new()).await.map_err(|e| e.to_string())?;
        return Ok(0);
    }
    let papers: Vec<Paper> = st.db.papers(vault.to_string()).await.map_err(|e| e.to_string())?.into_iter().filter(|p| same(&p.info.qualification) && years.contains(&p.info.year)).collect();
    let mut documents = String::new();
    for d in &docs {
        // Only what bears on how the year went: not the content areas or command words of the course.
        let g = |k: &str| d.digest.get(k).cloned().unwrap_or(json!([]));
        let digest = json!({ "summary": d.digest.get("summary").cloned().unwrap_or(json!("")), "key_points": g("key_points"), "marking_guidance": g("marking_guidance"), "exemplars": g("exemplars") });
        let block = format!(
            "<document kind=\"{}\" title=\"{}\" year=\"{}\" series=\"{}\" paper=\"{}\">\n{}\n</document>\n",
            d.kind,
            d.title.replace('"', "'"),
            d.info.year,
            d.info.month.replace('"', "'"),
            d.info.paper_number.replace('"', "'"),
            cut(&digest.to_string(), 60_000)
        );
        if documents.len() + block.len() > 800_000 {
            break;
        }
        documents.push_str(&block);
    }
    let mut listed = String::new();
    for p in &papers {
        listed.push_str(&format!("{} | {} | {} questions\n", p.info.year, p.title, p.questions));
    }
    let msg = format!("Qualification: {qualification}\n\n<documents>\n{documents}</documents>\n\n<papers>\nyear | paper | questions in the bank\n{listed}</papers>");
    let year = object(json!({
        "year": { "type": "integer" },
        "overview": { "type": "string" },
        "went_well": strings(),
        "common_mistakes": strings(),
        "advice": strings(),
    }));
    let schema = object(json!({ "years": { "type": "array", "items": year } }));
    let v = ask(st, who, vault, "writing year notes", s.year_prompt(), None, json!([{ "role": "user", "content": msg }]), Some(schema), 16_000).await?;
    let texts = |x: &Value, k: &str| -> Vec<Value> { list_of(x, k).iter().map(|t| clip(t.as_str().unwrap_or(""), 400)).filter(|t| !t.is_empty()).take(25).map(Value::String).collect() };
    let mut saved: Vec<(i64, Value)> = Vec::new();
    for y in list_of(&v, "years") {
        let Some(n) = y["year"].as_i64().filter(|n| years.contains(n)) else { continue };
        if saved.iter().any(|x| x.0 == n) {
            continue;
        }
        let notes = json!({
            "overview": clip(y["overview"].as_str().unwrap_or(""), 2000),
            "went_well": texts(&y, "went_well"),
            "common_mistakes": texts(&y, "common_mistakes"),
            "advice": texts(&y, "advice"),
        });
        saved.push((n, notes));
    }
    let n = saved.len();
    st.db.save_year_notes(vault.to_string(), qualification.to_string(), saved).await.map_err(|e| e.to_string())?;
    Ok(n)
}

/// Build (or rebuild) the paper guides of one qualification from its documents and past questions.
pub async fn build_profiles(st: &AppState, who: &Who, vault: &str, qualification: &str) -> Result<usize, String> {
    let s = Settings::load(&st.db).await.map_err(|_| "The settings could not be read.".to_string())?;
    let same = |q: &str| q.trim().eq_ignore_ascii_case(qualification.trim());
    let docs: Vec<Doc> = st.db.docs(vault.to_string()).await.map_err(|e| e.to_string())?.into_iter().filter(|d| same(&d.info.qualification)).collect();
    let questions: Vec<Question> =
        st.db.questions(vault.to_string()).await.map_err(|e| e.to_string())?.into_iter().filter(|q| q.source == "paper" && same(&q.qualification)).collect();
    if docs.is_empty() && questions.is_empty() {
        return Err("There is nothing in the hub for this qualification yet.".into());
    }
    let mut documents = String::new();
    for d in &docs {
        let series = [d.info.month.clone(), if d.info.year > 0 { d.info.year.to_string() } else { String::new() }].join(" ").trim().to_string();
        let block = format!(
            "<document kind=\"{}\" title=\"{}\" paper=\"{}\" series=\"{}\">\n{}\n</document>\n",
            d.kind,
            d.title.replace('"', "'"),
            d.info.paper_number.replace('"', "'"),
            series,
            cut(&d.digest.to_string(), 120_000)
        );
        if documents.len() + block.len() > 800_000 {
            break;
        }
        documents.push_str(&block);
    }
    let mut past = String::new();
    for q in &questions {
        let text: String = q.text.split_whitespace().collect::<Vec<_>>().join(" ");
        past.push_str(&format!(
            "{} | {} | {} | Q{} | {} marks | {} | {}\n",
            q.id,
            q.paper_title,
            if q.paper_number.is_empty() { "(no paper number)" } else { &q.paper_number },
            q.number,
            q.marks,
            q.qtype,
            cut(&text, 220)
        ));
    }
    let msg = format!(
        "Qualification: {qualification}\n\n<documents>\n{documents}</documents>\n\n<past_questions>\nid | paper | paper number | number | marks | type | text\n{past}</past_questions>"
    );
    let field = object(json!({
        "code": { "type": "string" },
        "title": { "type": "string" },
        "what": { "type": "string" },
        "marks": { "type": "array", "items": { "type": "integer" } },
        "types": { "type": "array", "items": { "type": "string", "enum": TYPES.iter().map(|t| t.0).collect::<Vec<_>>() } },
    }));
    let word = object(json!({ "word": { "type": "string" }, "meaning": { "type": "string" }, "marks": { "type": "string" } }));
    let profile = object(json!({
        "paper_number": { "type": "string" },
        "title": { "type": "string" },
        "overview": { "type": "string" },
        "fields": { "type": "array", "items": field },
        "command_words": { "type": "array", "items": word },
        "marking_tips": strings(),
        "common_mistakes": strings(),
    }));
    let schema = object(json!({
        "profiles": { "type": "array", "items": profile },
        "question_fields": { "type": "array", "items": object(json!({ "id": { "type": "integer" }, "paper_number": { "type": "string" }, "codes": strings() })) },
    }));
    let v = ask(st, who, vault, "building paper guides", s.profile_prompt(), None, json!([{ "role": "user", "content": msg }]), Some(schema), 32_000).await?;

    // Check what came back: sensible sizes, one guide per paper number.
    let short = |x: &Value, n: usize| clip(x.as_str().unwrap_or(""), n);
    let texts = |x: &Value, k: &str, n: usize, max: usize| -> Vec<Value> { list_of(x, k).iter().map(|t| short(t, n)).filter(|t| !t.is_empty()).take(max).map(Value::String).collect() };
    let mut saved: Vec<(String, String, Value)> = Vec::new();
    for p in list_of(&v, "profiles") {
        let num = short(&p["paper_number"], 40);
        if saved.iter().any(|x| x.0.eq_ignore_ascii_case(&num)) {
            continue;
        }
        let mut fields: Vec<Value> = Vec::new();
        for f in list_of(&p, "fields").iter().take(80) {
            let code = short(&f["code"], 20);
            let title = short(&f["title"], 150);
            if code.is_empty() && title.is_empty() {
                continue;
            }
            let marks: Vec<i64> = list_of(f, "marks").iter().filter_map(Value::as_i64).filter(|m| (1..=MAX_MARKS).contains(m)).collect();
            let types: Vec<String> = list_of(f, "types").iter().filter_map(Value::as_str).filter(|t| TYPES.iter().any(|x| x.0 == *t)).map(str::to_string).collect();
            fields.push(json!({ "code": code, "title": title, "what": short(&f["what"], 600), "marks": marks, "types": types }));
        }
        let words: Vec<Value> = list_of(&p, "command_words")
            .iter()
            .take(40)
            .map(|w| json!({ "word": short(&w["word"], 40), "meaning": short(&w["meaning"], 400), "marks": short(&w["marks"], 40) }))
            .filter(|w| !w["word"].as_str().unwrap_or("").is_empty())
            .collect();
        let title = {
            let t = short(&p["title"], 200);
            if t.is_empty() { if num.is_empty() { qualification.to_string() } else { num.clone() } } else { t }
        };
        let json = json!({
            "overview": short(&p["overview"], 2000),
            "fields": fields,
            "command_words": words,
            "marking_tips": texts(&p, "marking_tips", 400, 30),
            "common_mistakes": texts(&p, "common_mistakes", 400, 30),
        });
        saved.push((num, title, json));
    }
    if saved.is_empty() {
        return Err("Claude did not describe any papers. Try again.".into());
    }
    // Each past question's fields, as labels of its paper's guide.
    let labels_of = |num: &str| -> Vec<(String, String)> {
        saved
            .iter()
            .find(|x| x.0.eq_ignore_ascii_case(num))
            .or(if saved.len() == 1 { saved.first() } else { None })
            .map(|x| list_of(&x.2, "fields").iter().map(|f| (str_of(f, "code").to_string(), field_label(f))).collect())
            .unwrap_or_default()
    };
    let ids: HashSet<i64> = questions.iter().map(|q| q.id).collect();
    let mut tags: Vec<(i64, Vec<String>)> = Vec::new();
    for t in list_of(&v, "question_fields") {
        let Some(id) = t["id"].as_i64().filter(|i| ids.contains(i)) else { continue };
        let fields = labels_of(str_of(&t, "paper_number"));
        let mut labels: Vec<String> = Vec::new();
        for c in list_of(&t, "codes").iter().filter_map(Value::as_str) {
            if let Some((_, l)) = fields.iter().find(|(code, label)| code.eq_ignore_ascii_case(c.trim()) || label.eq_ignore_ascii_case(c.trim())) {
                if !labels.contains(l) {
                    labels.push(l.clone());
                }
            }
        }
        labels.truncate(4);
        tags.push((id, labels));
    }
    let n = saved.len();
    st.db.save_profiles(vault.to_string(), qualification.to_string(), saved, tags).await.map_err(|e| e.to_string())?;
    Ok(n)
}

/// Rebuild the guides of these qualifications in the background, one build per qualification at a time.
pub fn rebuild_in_background(st: &AppState, who: Who, vault: String, qualifications: Vec<String>) -> Vec<String> {
    let mut started = Vec::new();
    for q in qualifications {
        let key = format!("{vault}\u{1f}{}", q.to_lowercase());
        {
            let mut jobs = st.profile_jobs.lock().unwrap_or_else(|e| e.into_inner());
            if !jobs.insert(key.clone()) {
                continue;
            }
        }
        started.push(q.clone());
        let (st2, who2, vault2) = (st.clone(), who.clone(), vault.clone());
        tokio::spawn(async move {
            let guides = build_profiles(&st2, &who2, &vault2, &q).await;
            // The year notes need only the documents, so they are written even when the guides could not be.
            let years = build_year_notes(&st2, &who2, &vault2, &q).await;
            let r = match (guides, years) {
                (Err(e), _) => Err(e),
                (Ok(_), Err(e)) => Err(format!("the examiners' notes for each year could not be written: {e}")),
                (Ok(n), Ok(_)) => Ok(n),
            };
            {
                let mut errors = st2.profile_errors.lock().unwrap_or_else(|e| e.into_inner());
                match &r {
                    Ok(_) => {
                        errors.remove(&key);
                    }
                    Err(e) => {
                        tracing::warn!("building paper guides for {q}: {e}");
                        errors.insert(key.clone(), e.clone());
                    }
                }
            }
            st2.profile_jobs.lock().unwrap_or_else(|e| e.into_inner()).remove(&key);
        });
    }
    started
}

/// Qualifications whose guides are being built, and the last error for any that failed, for a vault.
pub fn profile_status(st: &AppState, vault: &str) -> (Vec<String>, Vec<(String, String)>) {
    let prefix = format!("{vault}\u{1f}");
    let building = st.profile_jobs.lock().unwrap_or_else(|e| e.into_inner()).iter().filter_map(|k| k.strip_prefix(&prefix).map(str::to_string)).collect();
    let failed = st
        .profile_errors
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .iter()
        .filter_map(|(k, e)| k.strip_prefix(&prefix).map(|q| (q.to_string(), e.clone())))
        .collect();
    (building, failed)
}

// ---------------------------------------------------------------- results for the coach

/// Percentages by topic, question type and mark level, flashcard results, and recent answers that lost marks.
pub async fn stats(st: &AppState, user: i64, vault: &str) -> Result<Value> {
    let attempts = st.db.marked_attempts(user, vault.to_string()).await?;
    let mut by_topic: HashMap<String, (i64, i64, i64)> = HashMap::new();
    let mut by_type: HashMap<String, (i64, i64, i64)> = HashMap::new();
    let mut by_marks: HashMap<i64, (i64, i64, i64)> = HashMap::new();
    let mut by_spec: HashMap<String, (i64, i64, i64)> = HashMap::new();
    let (mut got, mut avail) = (0i64, 0i64);
    for a in &attempts {
        let q = Question::from_snapshot(&a.question);
        let m = a.marks.unwrap_or(0);
        got += m;
        avail += a.total;
        let add = |e: &mut (i64, i64, i64)| {
            e.0 += m;
            e.1 += a.total;
            e.2 += 1;
        };
        for t in &q.topics {
            add(by_topic.entry(t.clone()).or_default());
        }
        if q.topics.is_empty() {
            add(by_topic.entry("(no topic)".into()).or_default());
        }
        add(by_type.entry(q.qtype.clone()).or_default());
        for t in &q.spec {
            add(by_spec.entry(t.clone()).or_default());
        }
        add(by_marks.entry(a.total).or_default());
    }
    let pct = |g: i64, t: i64| if t > 0 { (g as f64 * 1000.0 / t as f64).round() / 10.0 } else { 0.0 };
    let rows = |m: Vec<(String, (i64, i64, i64))>| -> Vec<Value> {
        let mut v: Vec<Value> = m.into_iter().map(|(k, (g, t, n))| json!({ "name": k, "got": g, "of": t, "answers": n, "percent": pct(g, t) })).collect();
        v.sort_by(|a, b| a["percent"].as_f64().partial_cmp(&b["percent"].as_f64()).unwrap_or(std::cmp::Ordering::Equal));
        v
    };
    let type_label = |t: &str| TYPES.iter().find(|x| x.0 == t).map(|x| x.1).unwrap_or(t).to_string();
    let mut marks_rows: Vec<Value> = by_marks.into_iter().map(|(k, (g, t, n))| json!({ "name": format!("{k}-mark"), "marks": k, "got": g, "of": t, "answers": n, "percent": pct(g, t) })).collect();
    marks_rows.sort_by_key(|v| v["marks"].as_i64().unwrap_or(0));
    let recent: Vec<Value> = attempts
        .iter()
        .rev()
        .filter(|a| a.marks.unwrap_or(0) < a.total)
        .take(12)
        .map(|a| {
            let q = Question::from_snapshot(&a.question);
            json!({
                "question": cut(&q.text, 400),
                "topics": q.topics,
                "type": q.qtype,
                "marks": a.marks,
                "of": a.total,
                "missed": a.feedback.get("missed").cloned().unwrap_or(json!([])),
                "feedback": a.feedback.get("feedback").cloned().unwrap_or(json!("")),
            })
        })
        .collect();
    let decks = st.db.decks(user, vault.to_string()).await?;
    let cards: Vec<Value> = decks
        .iter()
        .filter(|d| d.status == "ready")
        .map(|d| {
            let n = d.cards.as_array().map(|a| a.len()).unwrap_or(0);
            let p = d.progress.as_object();
            let known = p.map(|o| o.values().filter(|v| v.as_str() == Some("known")).count()).unwrap_or(0);
            let again = p.map(|o| o.values().filter(|v| v.as_str() == Some("again")).count()).unwrap_or(0);
            json!({ "deck": d.title, "cards": n, "known": known, "again": again })
        })
        .collect();
    Ok(json!({
        "answers": attempts.len(),
        "got": got,
        "of": avail,
        "percent": pct(got, avail),
        "topics": rows(by_topic.into_iter().collect()),
        "types": rows(by_type.into_iter().map(|(k, v)| (type_label(&k), v)).collect()),
        "specAreas": rows(by_spec.into_iter().collect()),
        "markLevels": marks_rows,
        "recentLost": recent,
        "flashcards": cards,
    }))
}

/// Render Markdown from Claude or a question for the browser: sanitised HTML, with links and pictures resolved
/// against the vault.
pub fn render(idx: &VaultIndex, vault_id: &str, md: &str) -> String {
    markdown::render(md, &markdown::RenderCtx { vault_id, index: idx })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paper_info_is_tidied() {
        let p = PaperInfo::clean(" BTEC IT Unit 1 ", "Paper 1", "jun", 2024);
        assert_eq!((p.month.as_str(), p.year), ("June", 2024));
        assert_eq!(p.title(), "June 2024 Paper 1");
        assert_eq!(PaperInfo::clean("", "", "Été", 99).year, 0);
        assert_eq!(PaperInfo::clean("", "Paper 2", "", 0).title(), "Paper 2");
    }

    #[test]
    fn objective_marking() {
        let q = |t: &str, marks: i64| Question {
            id: 1, paper_id: None, paper_title: String::new(), source: String::new(), user_id: None, number: String::new(),
            text: "The {{1}} runs code and {{2}} stores it.".into(), qtype: t.into(),
            options: vec!["a".into(), "b".into(), "c".into(), "d".into()], correct: vec![0, 2],
            blanks: vec![vec!["CPU".into(), "processor".into()], vec!["RAM".into()]], marks, scheme: String::new(),
            topics: vec![], difficulty: String::new(), created_at: 0,
            qualification: String::new(), paper_number: String::new(), spec: vec![], profile_id: None,
            hint: String::new(), explanation: String::new(), option_notes: vec![],
        };
        assert_eq!(mark_objective(&q("multi", 2), &json!({ "choices": [0, 2] })).0, 2);
        assert_eq!(mark_objective(&q("multi", 2), &json!({ "choices": [0, 1] })).0, 0);
        assert_eq!(mark_objective(&q("multi", 2), &json!({ "choices": [0] })).0, 1);
        assert_eq!(mark_objective(&q("fill", 2), &json!({ "blanks": ["The Processor.", "rom"] })).0, 1);
        let mut single = q("single", 1);
        single.correct = vec![1];
        assert_eq!(mark_objective(&single, &json!({ "choice": 1 })).0, 1);
        assert_eq!(mark_objective(&single, &json!({ "choice": null })).0, 0);
    }
}
