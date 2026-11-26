//! The Practice page and its JSON API: writing quizzes and flashcards with Claude, the question hub of past exam
//! questions, practice sessions and their marking, history, and the exam coach. See `crate::practice`.

use std::collections::{HashMap, HashSet};

use axum::{
    extract::{Path, Query, State},
    http::HeaderMap,
    Json,
};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    auth::{AdminUser, CurrentUser},
    errors::AppResult,
    handlers::{
        edit::{check_csrf, ok, ApiErr, ApiResult},
        ingest::Settings,
        vaults::{authorize, index_for},
    },
    practice::{self, PaperInfo, Profile, Question, Session, Who, DEFAULT_MARKS, DIFFICULTIES, DOC_KINDS, MAX_MARKS, MAX_QUESTIONS, TYPES},
    templates::{render, PageCtx, PapersAdminPage, PracticePage},
    vault::{file_url, VaultIndex},
    AppState,
};

fn who(u: &CurrentUser) -> Who {
    (u.id, u.username.clone())
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

pub async fn page(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> AppResult {
    let v = authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    let mut res = render(&PracticePage {
        page: PageCtx::for_user(&user),
        csrf: user.csrf.clone(),
        vault_id: v.id,
        vault_name: v.name,
        configured: s.api_key.is_some(),
        is_admin: user.is_admin,
        max_file_mb: st.cfg.max_file_bytes / 1024 / 1024,
    });
    // Retrieval quizzes show slide decks and documents (drawn in the page) and PDFs (framed) beside the questions.
    res.headers_mut().insert(axum::http::header::CONTENT_SECURITY_POLICY, axum::http::HeaderValue::from_static(crate::security::PRACTICE_CSP));
    Ok(res)
}

/// Past papers and exam documents for a vault: adding them, the paper guides, the years and clearing the hub. On the
/// admin side of the site; the questions themselves are practised on the Practice page.
pub async fn papers_page(State(st): State<AppState>, AdminUser(user): AdminUser, Path(id): Path<String>) -> AppResult {
    let v = authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    Ok(render(&PapersAdminPage {
        page: PageCtx::for_user(&user),
        csrf: user.csrf.clone(),
        vault_id: v.id,
        vault_name: v.name,
        configured: s.api_key.is_some(),
    }))
}

/// Everything the page needs to draw its forms: topics, mark levels, question types, past papers.
pub async fn meta(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    let idx = index_for(&st, &v.id).await?;
    let topics = practice::vault_topics(&idx, &s);
    let qs = st.db.questions(v.id.clone()).await?;
    // The mark levels to write questions at: the ones the past papers use, once there are past papers. A vault with
    // none yet offers the usual levels, and any its other questions have.
    let paper_marks: Vec<i64> = qs.iter().filter(|q| q.source == "paper" && q.marks > 0).map(|q| q.marks).collect();
    let mut marks: Vec<i64> = if paper_marks.is_empty() { DEFAULT_MARKS.iter().copied().chain(qs.iter().map(|q| q.marks).filter(|m| *m > 0)).collect() } else { paper_marks };
    marks.sort_unstable();
    marks.dedup();
    // The kinds of question in the hub, marks and type together ("9-mark evaluation"), fewest marks first.
    let mut kinds: Vec<(i64, String)> = Vec::new();
    for q in &qs {
        let k = question_kind(q);
        if !kinds.iter().any(|(_, s)| s.eq_ignore_ascii_case(&k)) {
            kinds.push((q.marks, k));
        }
    }
    kinds.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.to_lowercase().cmp(&b.1.to_lowercase())));
    let styles: Vec<&str> = kinds.iter().map(|(_, s)| s.as_str()).collect();
    let papers = st.db.papers(v.id.clone()).await?;
    let paper_json: Vec<Value> = papers
        .iter()
        .map(|p| {
            json!({
                "id": p.id,
                "title": p.title,
                "qualification": p.info.qualification,
                "paperNumber": p.info.paper_number,
                "month": p.info.month,
                "year": p.info.year,
                "by": p.username,
                "questions": p.questions,
                "createdAt": p.created_at,
                "examUrl": if p.exam_path.is_empty() { String::new() } else { file_url(&v.id, &p.exam_path) },
                "schemeUrl": if p.scheme_path.is_empty() { String::new() } else { file_url(&v.id, &p.scheme_path) },
                "insertUrls": p.insert_paths.iter().filter(|x| !x.is_empty()).map(|x| file_url(&v.id, x)).collect::<Vec<_>>(),
                "canDelete": user.is_admin || p.user_id == Some(user.id),
            })
        })
        .collect();
    let docs = st.db.docs(v.id.clone()).await?;
    let profiles = st.db.profiles(v.id.clone()).await?;
    let (building, failed) = practice::profile_status(&st, &v.id);
    let doc_json: Vec<Value> = docs
        .iter()
        .map(|d| {
            json!({
                "id": d.id,
                "kind": d.kind,
                "kindLabel": DOC_KINDS.iter().find(|k| k.0 == d.kind).map(|k| k.1).unwrap_or("Other"),
                "title": d.title,
                "qualification": d.info.qualification,
                "paperNumber": d.info.paper_number,
                "month": d.info.month,
                "year": d.info.year,
                "summary": d.digest.get("summary").cloned().unwrap_or(json!("")),
                "url": if d.path.is_empty() { String::new() } else { file_url(&v.id, &d.path) },
                "by": d.username,
                "canDelete": user.is_admin || d.user_id == Some(user.id),
            })
        })
        .collect();
    let (idx2, vid2, profs) = (idx.clone(), v.id.clone(), profiles.clone());
    let qs_spec: Vec<Vec<String>> = qs.iter().map(|q| q.spec.clone()).collect();
    let profile_json: Vec<Value> = tokio::task::spawn_blocking(move || {
        profs
            .iter()
            .map(|p| {
                let fields: Vec<Value> = p
                    .labels()
                    .into_iter()
                    .map(|l| {
                        let n = qs_spec.iter().filter(|s| s.contains(&l)).count();
                        json!({ "label": l, "questions": n })
                    })
                    .collect();
                json!({
                    "id": p.id,
                    "qualification": p.qualification,
                    "paperNumber": p.paper_number,
                    "title": p.title,
                    "fields": fields,
                    "html": practice::render(&idx2, &vid2, &p.markdown()),
                    "updatedAt": p.updated_at,
                })
            })
            .collect()
    })
    .await?;
    let quals = st.db.qualifications(v.id.clone()).await?;
    let years: Vec<Value> = st
        .db
        .year_notes(v.id.clone())
        .await?
        .into_iter()
        .map(|y| json!({ "qualification": y.qualification, "year": y.year, "notes": y.notes, "updatedAt": y.updated_at }))
        .collect();
    ok(json!({
        "years": years,
        "configured": s.api_key.is_some(),
        "docs": doc_json,
        "profiles": profile_json,
        "qualifications": quals,
        "buildingProfiles": building,
        "failedProfiles": failed.into_iter().map(|(q, e)| json!({ "qualification": q, "error": e })).collect::<Vec<_>>(),
        "topics": topics,
        "markLevels": marks,
        "maxMarks": MAX_MARKS,
        "maxQuestions": MAX_QUESTIONS,
        "types": TYPES.iter().map(|(id, label)| json!({ "id": id, "label": label })).collect::<Vec<_>>(),
        "difficulties": DIFFICULTIES,
        "papers": paper_json,
        "paperQuestions": qs.iter().filter(|q| q.source == "paper").count(),
        "styles": styles,
        "generatedQuestions": qs.iter().filter(|q| q.source == "generated").count(),
        "maxFileBytes": st.cfg.max_file_bytes,
    }))
}

// ---------------------------------------------------------------- questions as the browser sees them

/// A question for the page. Answers and mark schemes are left out until it has been answered (`reveal`).
fn question_json(idx: &VaultIndex, vault_id: &str, q: &Question, reveal: bool) -> Value {
    let mut v = json!({
        "id": q.id,
        "number": q.number,
        "type": q.qtype,
        "marks": q.marks,
        "topics": q.topics,
        "difficulty": q.difficulty,
        "source": q.source,
        "paper": q.paper_title,
        "paperId": q.paper_id,
        "html": practice::render(idx, vault_id, &q.text),
        "options": q.options,
        "blanks": q.blanks.len(),
        "spec": q.spec,
        "qualification": q.qualification,
        "hint": q.hint,
        "style": q.style,
    });
    if q.qtype == "calc" {
        v["calc"] = json!({ "values": q.calc.get("values").cloned().unwrap_or(json!([])), "unit": q.calc.get("unit").cloned().unwrap_or(json!("")), "decimals": q.calc.get("decimals").cloned().unwrap_or(json!(2)) });
        if reveal {
            let reference: Vec<String> = q.calc.get("tokens").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
            v["calc"]["answer"] = q.calc.get("answer").cloned().unwrap_or(Value::Null);
            v["calc"]["tokens"] = json!(reference);
            v["calc"]["formula"] = json!(practice::calc_formula_text(&q.calc, &reference));
        }
    }
    if reveal {
        v["explanation"] = json!(q.explanation);
        v["optionNotes"] = json!(q.option_notes);
        v["correct"] = json!(q.correct);
        v["accepted"] = json!(q.blanks);
        v["schemeHtml"] = json!(practice::render(idx, vault_id, &q.scheme));
    }
    v
}

#[derive(Deserialize, Default)]
pub struct HubQuery {
    #[serde(default)]
    topics: String,
    #[serde(default)]
    types: String,
    #[serde(default)]
    marks: String,
    #[serde(default)]
    source: String,
    #[serde(default)]
    paper: String,
    #[serde(default)]
    years: String,
    /// Specification area labels, separated by "|" (labels can hold commas).
    #[serde(default)]
    spec: String,
    /// Question styles from the paper guides ("Multiple choice", "25-mark essay"), separated by "|".
    #[serde(default)]
    styles: String,
    /// Words to look for in the question, its number or its paper's name.
    #[serde(default)]
    q: String,
    /// "" (paper order), "marks_desc", "marks_asc" or "newest".
    #[serde(default)]
    sort: String,
    /// For "Show more": how many are already shown.
    #[serde(default)]
    offset: usize,
}

/// A question's marks and type as one label, for the hub's Question type filter: "9-mark evaluation",
/// "1-mark multiple choice", "4-mark written answer". The type is the exam's own name for it (from the paper guides)
/// when there is one, else how it is answered; the marks are always the question's own.
fn question_kind(q: &Question) -> String {
    let style = q.style.trim();
    // Styles such as "9-mark evaluation" already carry a mark count: keep only the type.
    let rest = match style.split_once(|c: char| c == ' ' || c == '\u{a0}') {
        Some((first, rest)) if first.chars().next().is_some_and(|c| c.is_ascii_digit()) && first.to_lowercase().contains("mark") => rest.trim(),
        _ => style,
    };
    let what = if rest.is_empty() { TYPES.iter().find(|t| t.0 == q.qtype).map(|t| t.1).unwrap_or("question").to_string() } else { rest.to_string() };
    // "Multiple choice" reads "1-mark multiple choice"; a word in capitals ("SQL query") is left as it is.
    let mut c = what.chars();
    let what = match (c.next(), c.clone().next()) {
        (Some(f), Some(s)) if f.is_uppercase() && !s.is_uppercase() => format!("{}{}", f.to_lowercase(), c.as_str()),
        _ => what,
    };
    format!("{}-mark {what}", q.marks)
}

fn csv(s: &str) -> Vec<String> {
    s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

/// Questions sent per page of the hub.
const HUB_PAGE: usize = 40;

#[derive(Clone, Copy, PartialEq)]
enum Facet {
    Topics,
    Types,
    Marks,
    Years,
    Spec,
    Styles,
}

/// The question hub, like a shop's catalogue: filtered by topic, question type, mark level, exam year and
/// specification area (each a list; empty means any), by source and paper, and by words in the question. With
/// each page of results come counts for every filter value: how many questions it would give with the other
/// filters as they are.
pub async fn hub(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, Query(q): Query<HubQuery>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let idx = index_for(&st, &v.id).await?;
    let topics = csv(&q.topics);
    let types = csv(&q.types);
    let marks: Vec<i64> = csv(&q.marks).iter().filter_map(|m| m.parse().ok()).collect();
    let papers: Vec<i64> = csv(&q.paper).iter().filter_map(|m| m.parse().ok()).collect();
    let years: Vec<i64> = csv(&q.years).iter().filter_map(|m| m.parse().ok()).collect();
    let spec: Vec<String> = q.spec.split('|').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
    let styles: Vec<String> = q.styles.split('|').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
    let words: Vec<String> = q.q.to_lowercase().split_whitespace().take(12).map(str::to_string).collect();
    let year_of: HashMap<i64, i64> = st.db.papers(v.id.clone()).await?.into_iter().map(|p| (p.id, p.info.year)).collect();
    let all = st.db.questions(v.id.clone()).await?;

    let year = |x: &Question| x.paper_id.and_then(|p| year_of.get(&p).copied()).filter(|y| *y > 0);
    // The filters that are not facets: where questions come from, the paper, and the words searched for.
    let base = |x: &Question| {
        let from = match q.source.as_str() {
            "paper" => x.source == "paper",
            "generated" => x.source == "generated",
            "mine" => x.source == "generated" && x.user_id == Some(user.id),
            // Retrieval quiz questions belong with their document, not in the bank.
            _ => x.source != "retrieval",
        };
        let hay = || format!("{} {} {}", x.text, x.number, x.paper_title).to_lowercase();
        from && (papers.is_empty() || x.paper_id.is_some_and(|p| papers.contains(&p))) && (words.is_empty() || {
            let h = hay();
            words.iter().all(|w| h.contains(w.as_str()))
        })
    };
    // Every facet's filter, leaving one out (to count that facet's values).
    let passes = |x: &Question, skip: Option<Facet>| {
        let on = |f: Facet| skip != Some(f);
        (!on(Facet::Spec) || spec.is_empty() || x.spec.iter().any(|t| spec.iter().any(|w| w.eq_ignore_ascii_case(t))))
            && (!on(Facet::Topics) || topics.is_empty() || x.topics.iter().any(|t| topics.iter().any(|w| w.eq_ignore_ascii_case(t))))
            && (!on(Facet::Types) || types.is_empty() || types.contains(&x.qtype))
            && (!on(Facet::Marks) || marks.is_empty() || marks.contains(&x.marks))
            && (!on(Facet::Years) || years.is_empty() || year(x).is_some_and(|y| years.contains(&y)))
            && (!on(Facet::Styles) || styles.is_empty() || {
                let k = question_kind(x);
                styles.iter().any(|w| w.eq_ignore_ascii_case(&k))
            })
    };

    let pool: Vec<&Question> = all.iter().filter(|x| base(x)).collect();
    let mut counts: HashMap<&'static str, HashMap<String, usize>> = HashMap::new();
    for (name, facet) in [("topics", Facet::Topics), ("types", Facet::Types), ("marks", Facet::Marks), ("years", Facet::Years), ("spec", Facet::Spec), ("styles", Facet::Styles)] {
        let c = counts.entry(name).or_default();
        for x in pool.iter().filter(|x| passes(x, Some(facet))) {
            let keys: Vec<String> = match facet {
                Facet::Topics => x.topics.clone(),
                Facet::Types => vec![x.qtype.clone()],
                Facet::Marks => vec![x.marks.to_string()],
                Facet::Years => year(x).map(|y| vec![y.to_string()]).unwrap_or_default(),
                Facet::Spec => x.spec.clone(),
                Facet::Styles => vec![question_kind(x)],
            };
            for k in keys {
                *c.entry(k).or_default() += 1;
            }
        }
    }

    let mut matched: Vec<Question> = pool.into_iter().filter(|x| passes(x, None)).cloned().collect();
    match q.sort.as_str() {
        "marks_desc" => matched.sort_by(|a, b| b.marks.cmp(&a.marks).then(a.id.cmp(&b.id))),
        "marks_asc" => matched.sort_by(|a, b| a.marks.cmp(&b.marks).then(a.id.cmp(&b.id))),
        "newest" => matched.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id))),
        _ => {}
    }
    let total = matched.len();
    let vid = v.id.clone();
    let offset = q.offset.min(total);
    let list = tokio::task::spawn_blocking(move || matched.iter().skip(offset).take(HUB_PAGE).map(|q| question_json(&idx, &vid, q, true)).collect::<Vec<_>>());
    let list = list.await?;
    ok(json!({ "questions": list, "total": total, "offset": offset, "facets": counts }))
}

/// The ingest worker hands over the questions it found in a past paper.
#[derive(Deserialize)]
pub struct PaperBody {
    title: String,
    #[serde(default)]
    exam_path: String,
    #[serde(default)]
    scheme_path: String,
    #[serde(default)]
    insert_paths: Vec<String>,
    questions: Vec<Value>,
    #[serde(default)]
    qualification: String,
    #[serde(default)]
    paper_number: String,
    #[serde(default)]
    month: String,
    #[serde(default)]
    year: i64,
}

pub async fn add_paper(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap, Json(b): Json<PaperBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    let idx = index_for(&st, &v.id).await?;
    let topics = practice::vault_topics(&idx, &s);
    let qs: Vec<Question> = b.questions.iter().filter_map(|q| practice::clean_question(q, &topics, &[])).collect();
    if qs.is_empty() {
        return Err(ApiErr::Bad("No usable questions were found in this paper.".into()));
    }
    let info = PaperInfo::clean(&b.qualification, &b.paper_number, &b.month, b.year);
    let mut title: String = b.title.trim().chars().filter(|c| !c.is_control()).take(150).collect();
    if title.is_empty() {
        title = info.title();
    }
    if title.is_empty() {
        title = "Past paper".into();
    }
    let n = qs.len();
    let inserts: Vec<String> = b.insert_paths.into_iter().map(|x| x.trim().to_string()).filter(|x| !x.is_empty() && x.len() <= 1000).take(10).collect();
    let pid = st.db.add_paper(v.id.clone(), who(&user), title.clone(), info, b.exam_path, b.scheme_path, inserts, qs).await?;
    st.db.audit(user.audit_id(), None, "paper_added", format!("{}: {title}, {n} questions", v.name)).await;
    ok(json!({ "id": pid, "questions": n, "dropped": b.questions.len() - n }))
}

pub async fn delete_paper(State(st): State<AppState>, user: CurrentUser, Path((id, pid)): Path<(String, i64)>, headers: HeaderMap) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let paper = st.db.papers(v.id.clone()).await?.into_iter().find(|p| p.id == pid).ok_or(ApiErr::NotFound)?;
    if !user.is_admin && paper.user_id != Some(user.id) {
        return Err(ApiErr::Forbidden("Only the person who added this paper, or an admin, can remove it.".into()));
    }
    st.db.delete_paper(v.id.clone(), pid).await?;
    st.db.audit(user.audit_id(), None, "paper_removed", format!("{}: {}", v.name, paper.title)).await;
    ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------- writing questions

#[derive(Deserialize)]
pub struct GenerateBody {
    #[serde(default)]
    topics: Vec<String>,
    types: Vec<String>,
    marks: Vec<i64>,
    difficulty: String,
    count: usize,
    #[serde(default)]
    use_papers: bool,
    /// Write the questions for this paper (its guide's id), on these of its specification areas.
    #[serde(default)]
    profile: Option<i64>,
    #[serde(default)]
    spec: Vec<String>,
    /// The student's own words on what to focus on.
    #[serde(default)]
    focus: String,
    /// Where the questions come from: "claude" (Claude writes them all, the default), "bank" (past paper questions
    /// from the question bank only) or "mix" (half from the bank, the rest written by Claude).
    #[serde(default)]
    source: String,
}

/// The student's focus request, tidied: at most 1000 characters.
fn clean_focus(s: &str) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\n').take(1000).collect::<String>().trim().to_string()
}

/// Check the choices shared by questions and flashcards: topics must be the vault's.
fn check_topics(all: &[String], chosen: &[String]) -> Result<Vec<String>, ApiErr> {
    if all.is_empty() {
        return Ok(Vec::new());
    }
    let picked: Vec<String> = all.iter().filter(|t| chosen.iter().any(|c| c.eq_ignore_ascii_case(t))).cloned().collect();
    if picked.is_empty() {
        return Err(ApiErr::Bad("Choose at least one topic.".into()));
    }
    Ok(picked)
}

fn summary_title(count: usize, noun: &str, topics: &[String]) -> String {
    let what = match topics.len() {
        0 => "all notes".to_string(),
        1..=2 => topics.join(", "),
        n => format!("{}, {} and {} more", topics[0], topics[1], n - 2),
    };
    format!("{count} {noun}{} · {what}", if count == 1 { "" } else { "s" })
}

/// Start writing questions. Returns the new session at once; it becomes "ready" when Claude has written them. Past
/// paper questions from the bank are put in straight away ("bank"), or alongside Claude's ("mix").
pub async fn generate(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap, Json(b): Json<GenerateBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    let source = match b.source.as_str() {
        "bank" => "bank",
        "mix" => "mix",
        _ => "claude",
    };
    if s.api_key.is_none() && source != "bank" {
        return Err(ApiErr::Bad("No Anthropic API key is set. An admin can add one under Admin → Claude settings.".into()));
    }
    let idx = index_for(&st, &v.id).await?;
    let topics = check_topics(&practice::vault_topics(&idx, &s), &b.topics)?;
    let types: Vec<String> = TYPES.iter().map(|t| t.0.to_string()).filter(|t| b.types.contains(t)).collect();
    if types.is_empty() {
        return Err(ApiErr::Bad("Choose at least one question type.".into()));
    }
    let mut marks: Vec<i64> = b.marks.iter().copied().filter(|m| (1..=MAX_MARKS).contains(m)).collect();
    marks.sort_unstable();
    marks.dedup();
    if marks.is_empty() {
        return Err(ApiErr::Bad("Choose at least one mark level.".into()));
    }
    if !DIFFICULTIES.contains(&b.difficulty.as_str()) {
        return Err(ApiErr::Bad("Choose how hard the questions should be.".into()));
    }
    if b.count == 0 || b.count > MAX_QUESTIONS {
        return Err(ApiErr::Bad(format!("Ask for 1 to {MAX_QUESTIONS} questions.")));
    }
    let profile: Option<Profile> = match b.profile {
        Some(pid) => Some(st.db.profiles(v.id.clone()).await?.into_iter().find(|p| p.id == pid).ok_or_else(|| ApiErr::Bad("That paper's guide no longer exists.".into()))?),
        None => None,
    };
    let spec: Vec<String> = match &profile {
        Some(p) => {
            let all = p.labels();
            let chosen: Vec<String> = all.iter().filter(|l| b.spec.iter().any(|c| c.eq_ignore_ascii_case(l))).cloned().collect();
            if chosen.is_empty() { all } else { chosen }
        }
        None => Vec::new(),
    };
    // Past paper questions from the bank, for "bank" and "mix".
    let from_bank: Vec<i64> = if source == "claude" {
        Vec::new()
    } else {
        let all = st.db.questions(v.id.clone()).await?;
        let answered: HashSet<i64> = st.db.marked_attempts(user.id, v.id.clone()).await?.iter().filter_map(|a| a.question_id).collect();
        let want = if source == "bank" { b.count } else { b.count / 2 };
        let paper = profile.as_ref().map(|p| (p.qualification.as_str(), p.paper_number.as_str()));
        practice::pick_from_bank(&all, &answered, &topics, &types, &marks, paper, &spec, want)
    };
    let focus = clean_focus(&b.focus);
    let what = |n: usize| {
        let mut t = summary_title(n, "question", &topics);
        if let Some(p) = &profile {
            t = format!("{} · {}", summary_title(n, "question", &[]).split(" · ").next().unwrap_or(""), p.title);
        }
        t
    };
    if source == "bank" {
        if from_bank.is_empty() {
            return Err(ApiErr::Bad("No past paper questions in the bank match these choices. Choose more topics, question types or mark levels, or move the slider to let Claude write some.".into()));
        }
        let n = from_bank.len();
        let session = Session {
            id: new_id(),
            vault_id: v.id.clone(),
            user_id: user.id,
            title: format!("{} (past papers)", what(n)),
            kind: "hub".into(),
            settings: json!({ "topics": topics, "types": types, "marks": marks, "source": "bank", "asked": b.count }),
            status: "ready".into(),
            error: String::new(),
            question_ids: from_bank,
            score: 0,
            total: 0,
            created_at: 0,
        };
        st.db.create_practice_session(session.clone()).await?;
        return ok(json!({ "id": session.id, "fromBank": n, "asked": b.count }));
    }
    let n_bank = from_bank.len();
    let claude_count = b.count - n_bank;
    let title = if n_bank > 0 { format!("{} (mixed)", what(b.count)) } else { what(b.count) };
    let job = Generation {
        topics,
        types,
        marks,
        difficulty: b.difficulty,
        count: claude_count,
        use_papers: b.use_papers,
        profile,
        spec,
        focus,
        follow_up: String::new(),
        avoid: Vec::new(),
        kind: "generated",
        prefill: from_bank,
        resource: None,
        extra: json!({ "source": source, "fromBank": n_bank }),
    };
    let created = start_generation(&st, &user, &v.id, title, job).await?;
    ok(json!({ "id": created, "fromBank": n_bank, "asked": b.count }))
}

/// A document the questions are written from (retrieval quizzes and the mini quiz after them).
struct ResourceJob {
    note: String,
    title: String,
    text: String,
}

/// What to write for one set of questions.
struct Generation {
    topics: Vec<String>,
    types: Vec<String>,
    marks: Vec<i64>,
    difficulty: String,
    count: usize,
    use_papers: bool,
    profile: Option<Profile>,
    spec: Vec<String>,
    focus: String,
    /// For a follow-up quiz: the questions the student lost marks on, and what they missed. For the mini quiz after a
    /// retrieval quiz: the questions answered with the document open, and how they went.
    follow_up: String,
    /// Question texts not to write again (a follow-up's earlier questions).
    avoid: Vec<String>,
    /// The session's kind: "generated", "retrieval" (open book) or "recall" (the closed-book mini quiz).
    kind: &'static str,
    /// Questions already chosen from the bank, practised with the ones Claude writes.
    prefill: Vec<i64>,
    resource: Option<ResourceJob>,
    /// More settings to keep with the session.
    extra: Value,
}

/// The words of a question, lower-cased, for spotting one written again with small changes.
fn word_set(t: &str) -> HashSet<String> {
    t.to_lowercase().split(|c: char| !c.is_alphanumeric()).filter(|w| w.len() > 2).map(str::to_string).collect()
}

/// True when two questions share most of their words (the same question, lightly reworded).
fn near_copy(a: &HashSet<String>, b: &HashSet<String>) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    let shared = a.intersection(b).count() as f64;
    shared / (a.len().min(b.len()) as f64) >= 0.8
}

/// Create the session and write its questions in the background. Returns the session's id.
async fn start_generation(st: &AppState, user: &CurrentUser, vault: &str, title: String, g: Generation) -> Result<String, ApiErr> {
    let mut settings = json!({
        "topics": g.topics, "types": g.types, "marks": g.marks, "difficulty": g.difficulty, "count": g.count, "usePapers": g.use_papers,
        "profile": g.profile.as_ref().map(|p| p.id), "spec": g.spec, "focus": g.focus, "followUp": !g.follow_up.is_empty() && g.kind == "generated",
    });
    if let Some(extra) = g.extra.as_object() {
        for (k, val) in extra {
            settings[k] = val.clone();
        }
    }
    if let Some(r) = &g.resource {
        settings["resource"] = json!({ "note": r.note, "title": r.title });
    }
    let session = Session {
        id: new_id(),
        vault_id: vault.to_string(),
        user_id: user.id,
        title,
        kind: g.kind.into(),
        settings: settings.clone(),
        status: "generating".into(),
        error: String::new(),
        question_ids: g.prefill.clone(),
        score: 0,
        total: 0,
        created_at: 0,
    };
    st.db.create_practice_session(session.clone()).await?;
    let st2 = st.clone();
    let w = who(user);
    let created = session.id.clone();
    tokio::spawn(async move {
        let sid = session.id.clone();
        let written = if g.count == 0 { Ok(Vec::new()) } else { write_questions(&st2, &w, &session.vault_id, &g).await };
        match written {
            Ok(ids) => {
                let mut all: Vec<i64> = g.prefill.iter().copied().chain(ids).collect();
                if !g.prefill.is_empty() {
                    use rand::seq::SliceRandom;
                    all.shuffle(&mut rand::thread_rng());
                }
                let _ = st2.db.set_session(sid, "ready", String::new(), Some(all), None).await;
            }
            // With questions from the bank already chosen, practise those and say what went wrong with the rest.
            Err(e) if !g.prefill.is_empty() => {
                let note = format!("Claude's questions could not be written ({e}), so these are past paper questions only.");
                let _ = st2.db.set_session(sid, "ready", note, Some(g.prefill.clone()), None).await;
            }
            Err(e) => {
                let _ = st2.db.set_session(sid, "failed", e, None, None).await;
            }
        }
    });
    Ok(created)
}

async fn write_questions(st: &AppState, who: &Who, vault: &str, g: &Generation) -> Result<Vec<i64>, String> {
    let (topics, types, marks, difficulty, count, use_papers, profile, spec) =
        (&g.topics[..], &g.types[..], &g.marks[..], g.difficulty.as_str(), g.count, g.use_papers, g.profile.as_ref(), &g.spec[..]);
    let s = Settings::load(&st.db).await.map_err(|_| "The settings could not be read.".to_string())?;
    let type_names: Vec<&str> = types.iter().map(|t| TYPES.iter().find(|x| x.0 == t).map(|x| x.1).unwrap_or(t)).collect();
    let (mut msg, prompt, what) = if let Some(r) = &g.resource {
        // A retrieval quiz, or the mini quiz after one: written from one document.
        let mut msg = format!("<resource title=\"{}\">\n{}\n</resource>\n\n", r.title.replace('"', "'"), r.text);
        if !g.follow_up.is_empty() {
            msg.push_str(&format!("<earlier>\n{}</earlier>\n\n", g.follow_up));
        }
        // The mini quiz drops questions too like the earlier ones, so a few spare are asked for.
        let asked = if g.kind == "recall" { count + 3 } else { count };
        msg.push_str(&format!(
            "Write {asked} question{}.\nQuestion types: {} (type ids: {}).\nTopics: {}.",
            if asked == 1 { "" } else { "s" },
            type_names.join(", "),
            types.join(", "),
            if topics.is_empty() { "(none)".to_string() } else { topics.join("; ") },
        ));
        let (prompt, what) = if g.kind == "recall" { (crate::prompts::RECALL, "writing a mini quiz") } else { (crate::prompts::RETRIEVAL, "writing a retrieval quiz") };
        (msg, prompt.to_string(), what)
    } else {
        let idx = index_for(st, vault).await.map_err(|_| "The vault could not be read.".to_string())?;
        let (s2, t2) = (s.clone(), topics.to_vec());
        let notes = tokio::task::spawn_blocking(move || practice::notes_context(&idx, &s2, &t2)).await.map_err(|_| "The notes could not be read.".to_string())?;
        if notes.trim().is_empty() {
            return Err("There are no notes on these topics to write questions from.".into());
        }
        let examples = if use_papers {
            let all = st.db.questions(vault.to_string()).await.map_err(|_| "The question hub could not be read.".to_string())?;
            practice::examples(&all, topics, types, marks, profile.map(|p| (p.qualification.as_str(), p.paper_number.as_str())))
        } else {
            String::new()
        };
        let mut msg = format!("<notes>\n{notes}</notes>\n\n");
        if let Some(p) = profile {
            msg.push_str(&format!("<paper_profile>\n{}\n</paper_profile>\n\n", p.markdown()));
        }
        if !examples.is_empty() {
            msg.push_str(&format!("<past_paper_examples>\n{examples}</past_paper_examples>\n\n"));
        }
        msg.push_str(&format!(
            "Write {count} question{}.\nQuestion types: {} (type ids: {}).\nMark levels: {}.\nTopics: {}.\nDifficulty: {difficulty}.",
            if count == 1 { "" } else { "s" },
            type_names.join(", "),
            types.join(", "),
            marks.iter().map(|m| format!("{m} mark{}", if *m == 1 { "" } else { "s" })).collect::<Vec<_>>().join(", "),
            if topics.is_empty() { "any, from the notes".to_string() } else { topics.join("; ") },
        ));
        if types.iter().any(|t| t == "calc") {
            msg.push_str(&format!("\n\n{}", crate::prompts::CALC));
        }
        if profile.is_some() {
            msg.push_str(&format!("\nThe questions are for this paper. Specification areas (use these exact labels in spec_areas): {}.", spec.join("; ")));
        }
        if !g.follow_up.is_empty() {
            msg.push_str(&format!(
                "\n\n<follow_up>\n{}\n</follow_up>\nThe student has already answered every question in <follow_up>. Write {count} completely new questions on the same ideas: a different scenario, wording and angle for each. Never copy or lightly reword a question from <follow_up>.",
                g.follow_up
            ));
        }
        (msg, s.generate_prompt().to_string(), "writing questions")
    };
    if !g.focus.is_empty() {
        msg.push_str(&format!("\n\n<student_request>\n{}\n</student_request>", g.focus.replace("</student_request>", "")));
    }
    let schema = json!({
        "type": "object",
        "properties": { "questions": { "type": "array", "items": practice::question_schema(false) } },
        "required": ["questions"],
        "additionalProperties": false,
    });
    let v = practice::ask(st, who, vault, what, &prompt, None, json!([{ "role": "user", "content": msg }]), Some(schema), 32_000).await?;
    let qs: Vec<Question> = v
        .get("questions")
        .and_then(Value::as_array)
        .map(|a| {
            let avoid: Vec<HashSet<String>> = g.avoid.iter().map(|t| word_set(t)).collect();
            a.iter()
                .filter_map(|q| practice::clean_question(q, topics, spec))
                .filter(|q| types.contains(&q.qtype))
                .filter(|q| {
                    let w = word_set(&q.text);
                    !avoid.iter().any(|x| near_copy(x, &w))
                })
                .take(count)
                .collect()
        })
        .unwrap_or_default();
    let allowed: Vec<String> = profile.map(|p| p.styles()).unwrap_or_default();
    let qs: Vec<Question> = qs
        .into_iter()
        .map(|mut q| {
            q.profile_id = profile.map(|p| p.id);
            q.style = allowed.iter().find(|s| s.eq_ignore_ascii_case(q.style.trim())).cloned().unwrap_or_default();
            q
        })
        .collect();
    if qs.is_empty() {
        return Err("Claude's questions could not be used. Try again.".into());
    }
    let source = if g.resource.is_some() { "retrieval" } else { "generated" };
    st.db.add_questions(vault.to_string(), source, who.0, qs).await.map_err(|_| "The questions could not be saved.".to_string())
}

// ---------------------------------------------------------------- sessions

#[derive(Deserialize)]
pub struct FromHubBody {
    question_ids: Vec<i64>,
    #[serde(default)]
    title: String,
}

/// Practise questions from the hub (or again, questions of an earlier session).
pub async fn from_hub(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap, Json(b): Json<FromHubBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let mut seen = HashSet::new();
    let ids: Vec<i64> = b.question_ids.into_iter().filter(|i| seen.insert(*i)).take(50).collect();
    let qs = st.db.questions_by_id(v.id.clone(), ids.clone()).await?;
    if qs.is_empty() {
        return Err(ApiErr::Bad("Choose at least one question.".into()));
    }
    let title: String = b.title.trim().chars().filter(|c| !c.is_control()).take(150).collect();
    let session = Session {
        id: new_id(),
        vault_id: v.id.clone(),
        user_id: user.id,
        title: if title.is_empty() { format!("{} question{} from the hub", qs.len(), if qs.len() == 1 { "" } else { "s" }) } else { title },
        kind: "hub".into(),
        settings: json!({}),
        status: "ready".into(),
        error: String::new(),
        question_ids: qs.iter().map(|q| q.id).collect(),
        score: 0,
        total: 0,
        created_at: 0,
    };
    st.db.create_practice_session(session.clone()).await?;
    ok(json!({ "id": session.id }))
}

fn session_summary(s: &Session) -> Value {
    json!({
        "id": s.id, "title": s.title, "kind": s.kind, "status": s.status, "error": s.error,
        "score": s.score, "total": s.total, "questions": s.question_ids.len(), "createdAt": s.created_at, "settings": s.settings,
    })
}

pub async fn sessions(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let list = st.db.practice_sessions(user.id, v.id, 200).await?;
    ok(json!({ "sessions": list.iter().map(session_summary).collect::<Vec<_>>() }))
}

async fn own_session(st: &AppState, user: &CurrentUser, vault: &str, sid: &str) -> Result<Session, ApiErr> {
    let s = st.db.practice_session(sid.to_string()).await?.ok_or(ApiErr::NotFound)?;
    if s.vault_id != vault || s.user_id != user.id {
        return Err(ApiErr::NotFound);
    }
    Ok(s)
}

/// A session with its questions; once answered, with the answers, marks, feedback and mark schemes.
pub async fn session(State(st): State<AppState>, user: CurrentUser, Path((id, sid)): Path<(String, String)>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let s = own_session(&st, &user, &v.id, &sid).await?;
    let idx = index_for(&st, &v.id).await?;
    let attempts = st.db.attempts(s.id.clone()).await?;
    let mut out = session_summary(&s);
    if attempts.is_empty() {
        let qs = st.db.questions_by_id(v.id.clone(), s.question_ids.clone()).await?;
        let vid = v.id.clone();
        let checked = s.settings.get("checked").and_then(Value::as_object).cloned().unwrap_or_default();
        let list = tokio::task::spawn_blocking(move || {
            qs.iter()
                .map(|q| match checked.get(&q.id.to_string()) {
                    Some(c) => {
                        let mut j = question_json(&idx, &vid, q, true);
                        j["check"] = check_json(&idx, &vid, q, c);
                        j
                    }
                    None => question_json(&idx, &vid, q, false),
                })
                .collect::<Vec<_>>()
        })
        .await?;
        out["items"] = json!(list);
    } else {
        // Answered: show the questions as they were when answered, even if changed or removed since.
        let vid = v.id.clone();
        let list = tokio::task::spawn_blocking(move || {
            attempts
                .iter()
                .map(|a| {
                    let q = Question::from_snapshot(&a.question);
                    let mut j = question_json(&idx, &vid, &q, true);
                    let mut fb = a.feedback.clone();
                    for k in ["feedback", "model"] {
                        if let Some(t) = fb.get(k).and_then(Value::as_str).map(str::to_string) {
                            fb[format!("{k}Html")] = json!(practice::render(&idx, &vid, &t));
                        }
                    }
                    j["attempt"] = json!({ "answer": a.answer, "marks": a.marks, "total": a.total, "feedback": fb });
                    j
                })
                .collect::<Vec<_>>()
        })
        .await?;
        out["items"] = json!(list);
    }
    if let Some(note) = s.settings.pointer("/resource/note").and_then(Value::as_str) {
        if s.kind == "retrieval" && idx_has(&st, &v.id, note).await {
            let idx = index_for(&st, &v.id).await?;
            let (vid, n) = (v.id.clone(), note.to_string());
            let r = tokio::task::spawn_blocking(move || {
                let text = std::fs::read_to_string(idx.disk_path(&n).unwrap_or_default()).unwrap_or_default();
                let body = crate::markdown::strip_frontmatter(&text).to_string();
                let html = practice::render(&idx, &vid, &body);
                let mut res = practice::Resource { note: n.clone(), title: String::new(), original: String::new(), kind: "note".into(), topics: Vec::new() };
                if let Some(found) = practice::resources_one(&idx, &n) {
                    res = found;
                }
                let mut j = resource_json(&vid, &res);
                j["html"] = json!(html);
                j
            })
            .await?;
            out["resource"] = r;
        }
    }
    if s.kind == "recall" {
        if let Some(pid) = s.settings.get("parent").and_then(Value::as_str) {
            if let Ok(p) = own_session(&st, &user, &v.id, pid).await {
                out["parent"] = json!({ "id": p.id, "title": p.title, "score": p.score, "total": p.total, "status": p.status });
            }
        }
    }
    if s.kind == "retrieval" {
        let later = st.db.practice_sessions(user.id, v.id.clone(), 200).await?;
        if let Some(r) = later.iter().find(|x| x.kind == "recall" && x.settings.get("parent").and_then(Value::as_str) == Some(s.id.as_str())) {
            out["recall"] = json!({ "id": r.id, "score": r.score, "total": r.total, "status": r.status });
        }
    }
    ok(out)
}

async fn idx_has(st: &AppState, vault: &str, rel: &str) -> bool {
    index_for(st, vault).await.map(|i| i.contains(rel)).unwrap_or(false)
}

#[derive(Deserialize)]
pub struct SubmitBody {
    /// Question id (as a string) -> answer: {choice}, {choices}, {blanks} or {text}.
    answers: serde_json::Map<String, Value>,
}

fn clean_answer(q: &Question, a: Option<&Value>) -> Value {
    let a = a.cloned().unwrap_or(json!({}));
    match q.qtype.as_str() {
        "single" => json!({ "choice": a.get("choice").and_then(Value::as_u64).filter(|i| (*i as usize) < q.options.len()) }),
        "multi" => {
            let mut c: Vec<u64> = a.get("choices").and_then(Value::as_array).map(|x| x.iter().filter_map(Value::as_u64).filter(|i| (*i as usize) < q.options.len()).collect()).unwrap_or_default();
            c.sort_unstable();
            c.dedup();
            json!({ "choices": c })
        }
        "fill" => {
            let b: Vec<String> = (0..q.blanks.len())
                .map(|i| a.get("blanks").and_then(|x| x.get(i)).and_then(Value::as_str).unwrap_or("").chars().take(200).collect())
                .collect();
            json!({ "blanks": b })
        }
        "calc" => {
            let n_values = q.calc.get("values").and_then(Value::as_array).map(|x| x.len()).unwrap_or(0);
            let ok = |t: &str| {
                practice::CALC_OPS.contains(&t)
                    || t.strip_prefix('v').and_then(|k| k.parse::<usize>().ok()).is_some_and(|k| k < n_values)
                    || t.strip_prefix("n:").and_then(|n| n.parse::<f64>().ok()).is_some_and(|n| n.is_finite())
            };
            let tokens: Vec<String> = a
                .get("tokens")
                .and_then(Value::as_array)
                .map(|x| x.iter().filter_map(Value::as_str).filter(|t| t.len() <= 40 && ok(t)).map(str::to_string).take(practice::CALC_MAX_TOKENS).collect())
                .unwrap_or_default();
            json!({ "tokens": tokens })
        }
        _ => json!({ "text": a.get("text").and_then(Value::as_str).unwrap_or("").chars().filter(|c| !c.is_control() || *c == '\n').take(20_000).collect::<String>() }),
    }
}

/// Hand in the answers. They are saved at once and marked in the background (written ones by Claude).
pub async fn submit(State(st): State<AppState>, user: CurrentUser, Path((id, sid)): Path<(String, String)>, headers: HeaderMap, Json(b): Json<SubmitBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let s = own_session(&st, &user, &v.id, &sid).await?;
    if !st.db.claim_session(s.id.clone(), "ready", "marking").await? {
        return Err(ApiErr::Bad("These answers have already been handed in. Start the questions again to have another go.".into()));
    }
    let mut qs = st.db.questions_by_id(v.id.clone(), s.question_ids.clone()).await?;
    let profiles = st.db.profiles(v.id.clone()).await?;
    for q in qs.iter_mut() {
        if q.profile_id.is_none() && !q.qualification.is_empty() {
            q.profile_id = profiles
                .iter()
                .find(|p| p.qualification.eq_ignore_ascii_case(&q.qualification) && p.paper_number.eq_ignore_ascii_case(&q.paper_number))
                .or_else(|| {
                    let same: Vec<&Profile> = profiles.iter().filter(|p| p.qualification.eq_ignore_ascii_case(&q.qualification)).collect();
                    if same.len() == 1 { Some(same[0]) } else { None }
                })
                .map(|p| p.id);
        }
    }
    let rows: Vec<(Option<i64>, Value, Value, i64)> =
        qs.iter().map(|q| (Some(q.id), q.snapshot(), clean_answer(q, b.answers.get(&q.id.to_string())), q.marks)).collect();
    st.db.add_attempts(s.id.clone(), user.id, v.id.clone(), rows).await?;
    tokio::spawn(practice::mark_session(st.clone(), who(&user), s));
    ok(json!({ "ok": true }))
}

/// A checked answer as the page shows it: the answer, its marks and the feedback (Markdown rendered).
fn check_json(idx: &VaultIndex, vault_id: &str, q: &Question, c: &Value) -> Value {
    let mut fb = c.get("feedback").cloned().unwrap_or(json!({}));
    for k in ["feedback", "model"] {
        if let Some(t) = fb.get(k).and_then(Value::as_str).map(str::to_string) {
            fb[format!("{k}Html")] = json!(practice::render(idx, vault_id, &t));
        }
    }
    json!({ "answer": c.get("answer").cloned().unwrap_or(json!({})), "marks": c.get("marks").cloned().unwrap_or(Value::Null), "total": q.marks, "feedback": fb })
}

#[derive(Deserialize)]
pub struct CheckBody {
    question_id: i64,
    answer: Value,
}

/// Check one answer before handing in (one question at a time): choice and fill-in answers at once, a written
/// answer by Claude. The result is kept with the session, so handing in does not mark it again.
pub async fn check(State(st): State<AppState>, user: CurrentUser, Path((id, sid)): Path<(String, String)>, headers: HeaderMap, Json(b): Json<CheckBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let s = own_session(&st, &user, &v.id, &sid).await?;
    if s.status != "ready" {
        return Err(ApiErr::Bad("These answers have already been handed in.".into()));
    }
    if !s.question_ids.contains(&b.question_id) {
        return Err(ApiErr::NotFound);
    }
    let mut q = st.db.questions_by_id(v.id.clone(), vec![b.question_id]).await?.pop().ok_or(ApiErr::NotFound)?;
    let answer = clean_answer(&q, Some(&b.answer));
    let (marks, feedback) = if q.qtype == "written" {
        let text = answer.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if text.is_empty() {
            return Err(ApiErr::Bad("Write an answer first.".into()));
        }
        if Settings::load(&st.db).await?.api_key.is_none() {
            return Err(ApiErr::Bad("No Anthropic API key is set. An admin can add one under Admin → Claude settings.".into()));
        }
        let profiles = st.db.profiles(v.id.clone()).await?;
        if q.profile_id.is_none() && !q.qualification.is_empty() {
            q.profile_id = profiles.iter().find(|p| p.qualification.eq_ignore_ascii_case(&q.qualification) && p.paper_number.eq_ignore_ascii_case(&q.paper_number)).map(|p| p.id);
        }
        let guide = q.profile_id.and_then(|pid| profiles.iter().find(|p| p.id == pid)).map(|p| p.marking_guidance()).filter(|g| !g.is_empty());
        let (st2, w, vid, q2) = (st.clone(), who(&user), v.id.clone(), q.clone());
        // In its own task, so the marking is kept even if the page is closed while waiting.
        let task = tokio::spawn(async move { practice::mark_written(&st2, &w, &vid, &q2, &text, guide, None).await });
        match task.await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => return Err(ApiErr::Bad(e)),
            Err(e) => return Err(ApiErr::Internal(e.into())),
        }
    } else {
        practice::mark_objective(&q, &answer)
    };
    let entry = json!({ "answer": answer, "marks": marks, "feedback": feedback });
    // Read the settings again just before saving, so checks of other questions made meanwhile are kept.
    let fresh = st.db.practice_session(s.id.clone()).await?.ok_or(ApiErr::NotFound)?;
    let mut settings = fresh.settings.clone();
    if !settings.is_object() {
        settings = json!({});
    }
    if !settings.get("checked").is_some_and(Value::is_object) {
        settings["checked"] = json!({});
    }
    settings["checked"][q.id.to_string()] = entry.clone();
    st.db.set_session_settings(s.id.clone(), settings).await?;
    let idx = index_for(&st, &v.id).await?;
    let vid = v.id.clone();
    let out = tokio::task::spawn_blocking(move || {
        let mut j = question_json(&idx, &vid, &q, true);
        j["check"] = check_json(&idx, &vid, &q, &entry);
        j
    })
    .await?;
    ok(out)
}

#[derive(Deserialize)]
pub struct RemarkBody {
    question_id: i64,
}

/// Marking feedback as the page shows it: its Markdown rendered.
fn rendered_feedback(idx: &VaultIndex, vault_id: &str, fb: &Value) -> Value {
    let mut fb = fb.clone();
    for k in ["feedback", "model"] {
        if let Some(t) = fb.get(k).and_then(Value::as_str).map(str::to_string) {
            fb[format!("{k}Html")] = json!(practice::render(idx, vault_id, &t));
        }
    }
    fb
}

/// The marking guidance of a question's paper, for marking a written answer to it.
async fn guidance_for(st: &AppState, vault: &str, q: &mut Question) -> Result<Option<String>, ApiErr> {
    let profiles = st.db.profiles(vault.to_string()).await?;
    if q.profile_id.is_none() && !q.qualification.is_empty() {
        q.profile_id = profiles.iter().find(|p| p.qualification.eq_ignore_ascii_case(&q.qualification) && p.paper_number.eq_ignore_ascii_case(&q.paper_number)).map(|p| p.id);
    }
    Ok(q.profile_id.and_then(|pid| profiles.iter().find(|p| p.id == pid)).map(|p| p.marking_guidance()).filter(|g| !g.is_empty()))
}

/// Challenge the marking of a written answer: Claude marks it again from scratch, point by point, quoting the answer,
/// and the new marking replaces the old one (the score is worked out again). Once per answer. Works for answers
/// handed in and for answers checked before handing in.
pub async fn remark(State(st): State<AppState>, user: CurrentUser, Path((id, sid)): Path<(String, String)>, headers: HeaderMap, Json(b): Json<RemarkBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let s = own_session(&st, &user, &v.id, &sid).await?;
    if Settings::load(&st.db).await?.api_key.is_none() {
        return Err(ApiErr::Bad("No Anthropic API key is set. An admin can add one under Admin → Claude settings.".into()));
    }
    let attempts = st.db.attempts(s.id.clone()).await?;
    let idx = index_for(&st, &v.id).await?;
    let vid = v.id.clone();
    if !attempts.is_empty() {
        // Handed in: re-mark the answer kept with the session.
        if s.status != "marked" {
            return Err(ApiErr::Bad("Wait until the answers have been marked.".into()));
        }
        let a = attempts.iter().find(|a| a.question.get("id").and_then(Value::as_i64) == Some(b.question_id)).ok_or(ApiErr::NotFound)?;
        let mut q = Question::from_snapshot(&a.question);
        if q.qtype != "written" {
            return Err(ApiErr::Bad("Only written answers are marked by Claude, so only they can be challenged.".into()));
        }
        if a.feedback.get("remarked").and_then(Value::as_bool).unwrap_or(false) {
            return Err(ApiErr::Bad("This answer has already been marked again.".into()));
        }
        let text = a.answer.get("text").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if text.is_empty() {
            return Err(ApiErr::Bad("No answer was given, so there is nothing to mark again.".into()));
        }
        let guide = guidance_for(&st, &v.id, &mut q).await?;
        let mut earlier = a.feedback.clone();
        earlier["marks"] = json!(a.marks.unwrap_or(0));
        let (st2, w, vid2, q2) = (st.clone(), who(&user), v.id.clone(), q.clone());
        // In its own task, so the new marking is kept even if the page is closed while waiting.
        let (aid, total) = (a.id, a.total);
        let sid2 = s.id.clone();
        let err = s.error.clone();
        let task = tokio::spawn(async move {
            let r = practice::mark_written(&st2, &w, &vid2, &q2, &text, guide, Some(&earlier)).await?;
            st2.db.mark_attempt(aid, Some(r.0), r.1.clone()).await.map_err(|_| "The new marking could not be saved.".to_string())?;
            let all = st2.db.attempts(sid2.clone()).await.map_err(|_| "The score could not be worked out again.".to_string())?;
            let score: i64 = all.iter().filter_map(|x| x.marks).sum();
            let out_of: i64 = all.iter().map(|x| x.total).sum();
            let _ = st2.db.set_session(sid2, "marked", err, None, Some((score, out_of))).await;
            Ok::<_, String>((r, score, out_of))
        });
        let ((marks, fb), score, out_of) = match task.await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => return Err(ApiErr::Bad(e)),
            Err(e) => return Err(ApiErr::Internal(e.into())),
        };
        st.db.audit(user.audit_id(), None, "practice_remark", format!("{}: {} → {marks} of {total}", v.name, a.marks.unwrap_or(0))).await;
        let answer = a.answer.clone();
        let item = tokio::task::spawn_blocking(move || {
            let mut j = question_json(&idx, &vid, &q, true);
            j["attempt"] = json!({ "answer": answer, "marks": marks, "total": total, "feedback": rendered_feedback(&idx, &vid, &fb) });
            j
        })
        .await?;
        return ok(json!({ "item": item, "score": score, "total": out_of }));
    }
    // Not handed in yet: re-mark an answer checked one at a time.
    if s.status != "ready" {
        return Err(ApiErr::Bad("Wait until the answers have been marked.".into()));
    }
    let entry = s.settings.pointer(&format!("/checked/{}", b.question_id)).cloned().ok_or(ApiErr::NotFound)?;
    let mut q = st.db.questions_by_id(v.id.clone(), vec![b.question_id]).await?.pop().ok_or(ApiErr::NotFound)?;
    if q.qtype != "written" {
        return Err(ApiErr::Bad("Only written answers are marked by Claude, so only they can be challenged.".into()));
    }
    if entry.pointer("/feedback/remarked").and_then(Value::as_bool).unwrap_or(false) {
        return Err(ApiErr::Bad("This answer has already been marked again.".into()));
    }
    let text = entry.pointer("/answer/text").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let guide = guidance_for(&st, &v.id, &mut q).await?;
    let mut earlier = entry.get("feedback").cloned().unwrap_or(json!({}));
    earlier["marks"] = entry.get("marks").cloned().unwrap_or(json!(0));
    let (st2, w, vid2, q2) = (st.clone(), who(&user), v.id.clone(), q.clone());
    let task = tokio::spawn(async move { practice::mark_written(&st2, &w, &vid2, &q2, &text, guide, Some(&earlier)).await });
    let (marks, fb) = match task.await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Err(ApiErr::Bad(e)),
        Err(e) => return Err(ApiErr::Internal(e.into())),
    };
    let new_entry = json!({ "answer": entry.get("answer").cloned().unwrap_or(json!({})), "marks": marks, "feedback": fb });
    // Read the settings again just before saving, so checks of other questions made meanwhile are kept.
    let fresh = st.db.practice_session(s.id.clone()).await?.ok_or(ApiErr::NotFound)?;
    let mut settings = fresh.settings.clone();
    settings["checked"][b.question_id.to_string()] = new_entry.clone();
    st.db.set_session_settings(s.id.clone(), settings).await?;
    let item = tokio::task::spawn_blocking(move || {
        let mut j = question_json(&idx, &vid, &q, true);
        j["check"] = check_json(&idx, &vid, &q, &new_entry);
        j
    })
    .await?;
    ok(json!({ "item": item }))
}

/// A follow-up quiz: new questions on what the student lost marks on in a marked session.
pub async fn follow_up(State(st): State<AppState>, user: CurrentUser, Path((id, sid)): Path<(String, String)>, headers: HeaderMap) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let s = own_session(&st, &user, &v.id, &sid).await?;
    if s.status != "marked" {
        return Err(ApiErr::Bad("Hand these answers in first.".into()));
    }
    let settings = Settings::load(&st.db).await?;
    if settings.api_key.is_none() {
        return Err(ApiErr::Bad("No Anthropic API key is set. An admin can add one under Admin → Claude settings.".into()));
    }
    let attempts = st.db.attempts(s.id.clone()).await?;
    let missed: Vec<(Question, &practice::Attempt)> =
        attempts.iter().filter(|a| a.marks.is_some_and(|m| m < a.total)).map(|a| (Question::from_snapshot(&a.question), a)).collect();
    if missed.is_empty() {
        return Err(ApiErr::Bad("You lost no marks on these, so there is nothing to follow up. Try a harder set instead.".into()));
    }
    let idx = index_for(&st, &v.id).await?;
    let all_topics = practice::vault_topics(&idx, &settings);
    let mut topics: Vec<String> = all_topics.iter().filter(|t| missed.iter().any(|(q, _)| q.topics.iter().any(|x| x.eq_ignore_ascii_case(t)))).cloned().collect();
    if topics.is_empty() {
        let earlier: Vec<String> = s.settings.get("topics").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
        topics = all_topics.iter().filter(|t| earlier.iter().any(|x| x.eq_ignore_ascii_case(t))).cloned().collect();
    }
    if topics.is_empty() && !all_topics.is_empty() {
        return Err(ApiErr::Bad("The questions you lost marks on have no topics in this vault to write from.".into()));
    }
    let mut types: Vec<String> = Vec::new();
    let mut marks: Vec<i64> = Vec::new();
    let mut brief = String::new();
    for (q, a) in missed.iter().take(15) {
        if !types.contains(&q.qtype) {
            types.push(q.qtype.clone());
        }
        if !marks.contains(&q.marks) {
            marks.push(q.marks);
        }
        let fb = &a.feedback;
        let missed_points: Vec<&str> = fb.get("missed").and_then(Value::as_array).map(|x| x.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let text: String = q.text.chars().take(800).collect();
        brief.push_str(&format!(
            "<lost marks=\"{}/{}\" type=\"{}\" topics=\"{}\">\n{}\n{}{}</lost>\n",
            a.marks.unwrap_or(0),
            a.total,
            q.qtype,
            q.topics.join(", ").replace('"', "'"),
            text,
            if missed_points.is_empty() { String::new() } else { format!("Missed: {}\n", missed_points.join("; ")) },
            fb.get("feedback").and_then(Value::as_str).map(|f| format!("Examiner: {}\n", f.chars().take(400).collect::<String>())).unwrap_or_default(),
        ));
    }
    marks.sort_unstable();
    let profile = match s.settings.get("profile").and_then(Value::as_i64) {
        Some(pid) => st.db.profiles(v.id.clone()).await?.into_iter().find(|p| p.id == pid),
        None => None,
    };
    let spec = profile.as_ref().map(|p| p.labels()).unwrap_or_default();
    let count = (missed.len() * 2).clamp(3, 10);
    let difficulty = s.settings.get("difficulty").and_then(Value::as_str).filter(|d| DIFFICULTIES.contains(d)).unwrap_or("mixed").to_string();
    let use_papers = st.db.questions(v.id.clone()).await?.iter().any(|q| q.source == "paper");
    let base = s.title.trim_start_matches("Follow-up · ").trim_end_matches(" (again)").to_string();
    let title: String = format!("Follow-up · {base}").chars().take(150).collect();
    let avoid: Vec<String> = attempts.iter().map(|a| Question::from_snapshot(&a.question).text).collect();
    let job = Generation {
        topics,
        types,
        marks,
        difficulty,
        count,
        use_papers,
        profile,
        spec,
        focus: String::new(),
        follow_up: brief,
        avoid,
        kind: "generated",
        prefill: Vec::new(),
        resource: None,
        extra: json!({}),
    };
    let created = start_generation(&st, &user, &v.id, title, job).await?;
    ok(json!({ "id": created }))
}

// ---------------------------------------------------------------- flashcards

#[derive(Deserialize)]
pub struct DeckBody {
    #[serde(default)]
    topics: Vec<String>,
    difficulty: String,
    count: usize,
    #[serde(default)]
    focus: String,
}

pub async fn make_deck(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap, Json(b): Json<DeckBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    if s.api_key.is_none() {
        return Err(ApiErr::Bad("No Anthropic API key is set. An admin can add one under Admin → Claude settings.".into()));
    }
    let idx = index_for(&st, &v.id).await?;
    let topics = check_topics(&practice::vault_topics(&idx, &s), &b.topics)?;
    if !DIFFICULTIES.contains(&b.difficulty.as_str()) {
        return Err(ApiErr::Bad("Choose how hard the cards should be.".into()));
    }
    if !(1..=60).contains(&b.count) {
        return Err(ApiErr::Bad("Ask for 1 to 60 cards.".into()));
    }
    let did = new_id();
    let title = summary_title(b.count, "card", &topics);
    let focus = clean_focus(&b.focus);
    st.db.create_deck(did.clone(), v.id.clone(), user.id, title, json!({ "topics": topics, "difficulty": b.difficulty, "count": b.count, "focus": focus })).await?;
    let st2 = st.clone();
    let w = who(&user);
    let (vid, did2) = (v.id.clone(), did.clone());
    tokio::spawn(async move {
        match write_cards(&st2, &w, &vid, &topics, &b.difficulty, b.count, &focus).await {
            Ok(cards) => {
                let _ = st2.db.finish_deck(did2, "ready", String::new(), cards).await;
            }
            Err(e) => {
                let _ = st2.db.finish_deck(did2, "failed", e, json!([])).await;
            }
        }
    });
    ok(json!({ "id": did }))
}

async fn write_cards(st: &AppState, who: &Who, vault: &str, topics: &[String], difficulty: &str, count: usize, focus: &str) -> Result<Value, String> {
    let s = Settings::load(&st.db).await.map_err(|_| "The settings could not be read.".to_string())?;
    let idx = index_for(st, vault).await.map_err(|_| "The vault could not be read.".to_string())?;
    let (s2, t2) = (s.clone(), topics.to_vec());
    let notes = tokio::task::spawn_blocking(move || practice::notes_context(&idx, &s2, &t2)).await.map_err(|_| "The notes could not be read.".to_string())?;
    if notes.trim().is_empty() {
        return Err("There are no notes on these topics to make cards from.".into());
    }
    let mut msg = format!(
        "<notes>\n{notes}</notes>\n\nWrite {count} flashcard{}.\nTopics: {}.\nDifficulty: {difficulty}.",
        if count == 1 { "" } else { "s" },
        if topics.is_empty() { "any, from the notes".to_string() } else { topics.join("; ") }
    );
    if !focus.is_empty() {
        msg.push_str(&format!("\n\n<student_request>\n{}\n</student_request>", focus.replace("</student_request>", "")));
    }
    let schema = json!({
        "type": "object",
        "properties": { "cards": { "type": "array", "items": {
            "type": "object",
            "properties": { "front": { "type": "string" }, "back": { "type": "string" }, "topic": { "type": "string" } },
            "required": ["front", "back", "topic"],
            "additionalProperties": false,
        } } },
        "required": ["cards"],
        "additionalProperties": false,
    });
    let v = practice::ask(st, who, vault, "writing flashcards", s.cards_prompt(), None, json!([{ "role": "user", "content": msg }]), Some(schema), 16_000).await?;
    let clip = |x: &Value, n: usize| x.as_str().unwrap_or("").chars().filter(|c| !c.is_control() || *c == '\n').take(n).collect::<String>().trim().to_string();
    let cards: Vec<Value> = v
        .get("cards")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|c| json!({ "front": clip(&c["front"], 600), "back": clip(&c["back"], 1500), "topic": clip(&c["topic"], 120) }))
                .filter(|c| !c["front"].as_str().unwrap_or("").is_empty() && !c["back"].as_str().unwrap_or("").is_empty())
                .take(count)
                .collect()
        })
        .unwrap_or_default();
    if cards.is_empty() {
        return Err("Claude's cards could not be used. Try again.".into());
    }
    Ok(json!(cards))
}

fn deck_json(d: &practice::Deck, with_cards: bool) -> Value {
    let n = d.cards.as_array().map(|a| a.len()).unwrap_or(0);
    let known = d.progress.as_object().map(|o| o.values().filter(|v| v.as_str() == Some("known")).count()).unwrap_or(0);
    let mut v = json!({ "id": d.id, "title": d.title, "status": d.status, "error": d.error, "cards": n, "known": known, "createdAt": d.created_at, "settings": d.settings });
    if with_cards {
        v["items"] = d.cards.clone();
        v["progress"] = d.progress.clone();
    }
    v
}

pub async fn decks(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let list = st.db.decks(user.id, v.id).await?;
    ok(json!({ "decks": list.iter().map(|d| deck_json(d, false)).collect::<Vec<_>>() }))
}

async fn own_deck(st: &AppState, user: &CurrentUser, did: &str) -> Result<practice::Deck, ApiErr> {
    let d = st.db.deck(did.to_string()).await?.ok_or(ApiErr::NotFound)?;
    if d.user_id != user.id {
        return Err(ApiErr::NotFound);
    }
    Ok(d)
}

pub async fn deck(State(st): State<AppState>, user: CurrentUser, Path((id, did)): Path<(String, String)>) -> ApiResult {
    authorize(&st, &user, &id).await?;
    let d = own_deck(&st, &user, &did).await?;
    ok(deck_json(&d, true))
}

#[derive(Deserialize)]
pub struct ProgressBody {
    progress: serde_json::Map<String, Value>,
}

pub async fn deck_progress(State(st): State<AppState>, user: CurrentUser, Path((id, did)): Path<(String, String)>, headers: HeaderMap, Json(b): Json<ProgressBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    authorize(&st, &user, &id).await?;
    let d = own_deck(&st, &user, &did).await?;
    let n = d.cards.as_array().map(|a| a.len()).unwrap_or(0);
    let clean: serde_json::Map<String, Value> = b
        .progress
        .into_iter()
        .filter(|(k, v)| k.parse::<usize>().is_ok_and(|i| i < n) && matches!(v.as_str(), Some("known" | "again")))
        .collect();
    st.db.set_deck_progress(d.id, user.id, Value::Object(clean)).await?;
    ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
pub struct CardsBody {
    cards: Vec<Value>,
    #[serde(default)]
    progress: serde_json::Map<String, Value>,
}

/// Save a deck's cards after editing, adding or deleting cards, with the progress re-numbered to match.
pub async fn deck_cards(State(st): State<AppState>, user: CurrentUser, Path((id, did)): Path<(String, String)>, headers: HeaderMap, Json(b): Json<CardsBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    authorize(&st, &user, &id).await?;
    let d = own_deck(&st, &user, &did).await?;
    if d.status != "ready" {
        return Err(ApiErr::Bad("These cards are still being written.".into()));
    }
    let clip = |x: &Value, n: usize| x.as_str().unwrap_or("").chars().filter(|c| !c.is_control() || *c == '\n').take(n).collect::<String>().trim().to_string();
    let cards: Vec<Value> = b
        .cards
        .iter()
        .take(200)
        .map(|c| json!({ "front": clip(&c["front"], 600), "back": clip(&c["back"], 1500), "topic": clip(&c["topic"], 120) }))
        .filter(|c| !c["front"].as_str().unwrap_or("").is_empty() && !c["back"].as_str().unwrap_or("").is_empty())
        .collect();
    if cards.is_empty() {
        return Err(ApiErr::Bad("A deck needs at least one card with a front and a back. Delete the deck instead.".into()));
    }
    let n = cards.len();
    let progress: serde_json::Map<String, Value> =
        b.progress.into_iter().filter(|(k, v)| k.parse::<usize>().is_ok_and(|i| i < n) && matches!(v.as_str(), Some("known" | "again"))).collect();
    st.db.set_deck_cards(d.id.clone(), user.id, json!(cards), Value::Object(progress)).await?;
    let d = own_deck(&st, &user, &did).await?;
    ok(deck_json(&d, true))
}

pub async fn delete_deck(State(st): State<AppState>, user: CurrentUser, Path((id, did)): Path<(String, String)>, headers: HeaderMap) -> ApiResult {
    check_csrf(&user, &headers)?;
    authorize(&st, &user, &id).await?;
    if !st.db.delete_deck(did, user.id).await? {
        return Err(ApiErr::NotFound);
    }
    ok(json!({ "ok": true }))
}

// ---------------------------------------------------------------- conversations (the exam coach and Ask Claude), kept as threads

#[derive(Deserialize, Default)]
pub struct ThreadQuery {
    /// The saved conversation to show; empty for the most recent one, "new" for none (a new conversation).
    #[serde(default)]
    thread: String,
}

fn thread_json(t: &practice::Thread) -> Value {
    json!({ "id": t.id, "title": t.title, "createdAt": t.created_at, "updatedAt": t.updated_at, "messages": t.messages })
}

/// One channel's saved conversations, and the messages of the one shown.
async fn conversation_view(st: &AppState, user: &CurrentUser, vault: &str, channel: &'static str, thread: &str) -> Result<Value, ApiErr> {
    let threads = st.db.chat_threads(user.id, vault.to_string(), channel).await?;
    let current = match thread {
        "new" => None,
        "" => threads.first().cloned(),
        t => threads.iter().find(|x| x.id == t).cloned(),
    };
    let msgs = match &current {
        Some(t) => st.db.thread_messages(t.id.clone(), 400).await?,
        None => Vec::new(),
    };
    let idx = index_for(st, vault).await?;
    let vid = vault.to_string();
    let list = tokio::task::spawn_blocking(move || {
        msgs.iter()
            .map(|(role, content, ts)| {
                let html = if role == "assistant" { practice::render(&idx, &vid, content) } else { String::new() };
                json!({ "role": role, "text": content, "html": html, "at": ts })
            })
            .collect::<Vec<_>>()
    })
    .await?;
    Ok(json!({
        "messages": list,
        "thread": current.as_ref().map(|t| t.id.clone()),
        "threads": threads.iter().map(thread_json).collect::<Vec<_>>(),
    }))
}

/// The thread a new message goes into: the one named (if it is the account's), or a new one titled after the message.
async fn thread_for(st: &AppState, user: &CurrentUser, vault: &str, channel: &'static str, thread: &str, first: &str) -> Result<String, ApiErr> {
    if !thread.is_empty() && thread != "new" {
        return st.db.own_thread(thread.to_string(), user.id, vault.to_string(), channel).await?.map(|t| t.id).ok_or(ApiErr::NotFound);
    }
    let one_line = first.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut title: String = one_line.chars().take(80).collect();
    if one_line.chars().count() > 80 {
        title = format!("{}…", title.trim_end());
    }
    Ok(st.db.create_thread(user.id, vault.to_string(), channel, title).await?)
}

/// The conversation as sent back to Claude: it must start with the student, so a leading reply left by the history
/// limit is dropped.
fn as_messages(history: &[(String, String, i64)]) -> Vec<Value> {
    history
        .iter()
        .skip_while(|(r, _, _)| r != "user")
        .map(|(r, c, _)| json!({ "role": if r == "assistant" { "assistant" } else { "user" }, "content": c }))
        .collect()
}

// ---------------------------------------------------------------- exam coach

const COACH_HISTORY: i64 = 30;
/// A line the coach ends its reply with to set the student a retrieval quiz on a topic.
const SET_RETRIEVAL: &str = "SET-RETRIEVAL-QUIZ:";

fn task_json(t: &practice::CoachTask) -> Value {
    json!({ "id": t.id, "kind": t.kind, "topic": t.topic, "reason": t.reason, "status": t.status, "sessionId": t.session_id, "createdAt": t.created_at, "updatedAt": t.updated_at })
}

/// The topics that have documents to do a retrieval quiz with, and how many each has.
async fn resource_counts(st: &AppState, vault: &str) -> Result<Vec<(String, usize)>, ApiErr> {
    let s = Settings::load(&st.db).await?;
    let idx = index_for(st, vault).await?;
    Ok(tokio::task::spawn_blocking(move || {
        let topics = practice::vault_topics(&idx, &s);
        let res = practice::resources(&idx, &s, &topics);
        topics.into_iter().map(|t| {
            let n = res.iter().filter(|r| r.topics.contains(&t)).count();
            (t, n)
        }).collect::<Vec<_>>()
    })
    .await?)
}

async fn coach_view(st: &AppState, user: &CurrentUser, vault: &str, thread: &str) -> Result<Value, ApiErr> {
    let mut out = conversation_view(st, user, vault, "coach", thread).await?;
    let stats = practice::stats(st, user.id, vault).await?;
    let counts = resource_counts(st, vault).await?;
    let grades = st.db.coach_grades(user.id, vault.to_string()).await?;
    let graded: Vec<Value> = grades.as_ref().and_then(|g| g.0.as_array().cloned()).unwrap_or_default();
    // Every topic, with its grade (if graded) and how many documents it has.
    let topics: Vec<Value> = counts
        .iter()
        .map(|(t, n)| {
            let g = graded.iter().find(|x| x.get("topic").and_then(Value::as_str).is_some_and(|y| y.eq_ignore_ascii_case(t)));
            let result = stats.get("topics").and_then(Value::as_array).and_then(|a| a.iter().find(|x| x.get("name").and_then(Value::as_str) == Some(t.as_str()))).cloned();
            json!({
                "topic": t,
                "grade": g.and_then(|x| x.get("grade")).cloned().unwrap_or(json!("")),
                "reason": g.and_then(|x| x.get("reason")).cloned().unwrap_or(json!("")),
                "resources": n,
                "result": result,
            })
        })
        .collect();
    out["stats"] = stats.clone();
    out["topics"] = json!(topics);
    out["graded"] = json!(grades.as_ref().map(|g| json!({ "answers": g.1, "at": g.2 })));
    out["answers"] = stats.get("answers").cloned().unwrap_or(json!(0));
    out["tasks"] = json!(st.db.coach_tasks(user.id, vault.to_string()).await?.iter().map(task_json).collect::<Vec<_>>());
    Ok(out)
}

pub async fn coach(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, Query(q): Query<ThreadQuery>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    ok(coach_view(&st, &user, &v.id, &q.thread).await?)
}

#[derive(Deserialize)]
pub struct CoachBody {
    message: String,
    #[serde(default)]
    thread: String,
}

/// Take the coach's SET-RETRIEVAL-QUIZ lines out of its reply: the reply without them, and the topics named (only
/// the vault's topics that have documents, at most three).
fn take_assignments(reply: &str, allowed: &[String]) -> (String, Vec<String>) {
    let mut topics: Vec<String> = Vec::new();
    let mut kept: Vec<&str> = Vec::new();
    for line in reply.lines() {
        let l = line.trim().trim_matches('*').trim_matches('`').trim();
        if let Some(rest) = l.strip_prefix(SET_RETRIEVAL) {
            let name = rest.trim().trim_matches(|c: char| c == '"' || c == '[' || c == ']' || c == '.');
            if let Some(t) = allowed.iter().find(|a| a.eq_ignore_ascii_case(name)) {
                if !topics.contains(t) && topics.len() < 3 {
                    topics.push(t.clone());
                }
            }
        } else {
            kept.push(line);
        }
    }
    (kept.join("\n").trim_end().to_string(), topics)
}

/// Send a message to the coach and wait for the reply. The reply is worked out in its own task, so it is still
/// saved if the page is closed while waiting. The coach can set retrieval quizzes on topics the student is
/// struggling with; they are added to the student's list of work.
pub async fn coach_send(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap, Json(b): Json<CoachBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let text: String = b.message.chars().filter(|c| !c.is_control() || *c == '\n').take(4000).collect::<String>().trim().to_string();
    if text.is_empty() {
        return Err(ApiErr::Bad("Type a message first.".into()));
    }
    let s = Settings::load(&st.db).await?;
    if s.api_key.is_none() {
        return Err(ApiErr::Bad("No Anthropic API key is set. An admin can add one under Admin → Claude settings.".into()));
    }
    let thread = thread_for(&st, &user, &v.id, "coach", &b.thread, &text).await?;
    st.db.add_coach_message(user.id, v.id.clone(), "coach", thread.clone(), "user", text).await?;
    let stats = practice::stats(&st, user.id, &v.id).await?;
    let counts = resource_counts(&st, &v.id).await?;
    let topics: Vec<String> = counts.iter().map(|(t, _)| t.clone()).collect();
    let with_docs: Vec<String> = counts.iter().filter(|(_, n)| *n > 0).map(|(t, _)| t.clone()).collect();
    let history = st.db.thread_messages(thread.clone(), COACH_HISTORY).await?;
    let msgs = as_messages(&history);
    let mut context = format!(
        "Course: {}. Topics in the student's notes: {}.\n\nThe student's practice results so far (JSON; percentages are of marks available):\n{}",
        v.name,
        if topics.is_empty() { "(none yet)".to_string() } else { topics.join("; ") },
        serde_json::to_string_pretty(&stats).unwrap_or_default()
    );
    if let Some((grades, _, _)) = st.db.coach_grades(user.id, v.id.clone()).await? {
        context.push_str(&format!("\n\nThe RAG grades you last gave each topic (JSON):\n{}", grades));
    }
    let tasks = st.db.coach_tasks(user.id, v.id.clone()).await?;
    let waiting: Vec<String> = tasks.iter().filter(|t| t.status != "done").map(|t| t.topic.clone()).collect();
    if !with_docs.is_empty() {
        context.push_str(&format!(
            "\n\nYou can set the student a retrieval quiz on a topic: they open one of their documents on it (slides or notes) and answer questions by finding the answers in it, then take a short quiz without it. Set one when they are struggling with a topic or ask you for work, by ending your reply with a line \"{SET_RETRIEVAL} <exact topic name>\" for each topic (at most three). The site takes these lines out of your reply and adds the quizzes to the student's list, so also say in your reply what you have set and why. Topics with documents to quiz on: {}.{}",
            with_docs.join("; "),
            if waiting.is_empty() { String::new() } else { format!(" Already set and not yet done: {}.", waiting.join("; ")) }
        ));
    }
    let guides: String = st.db.profiles(v.id.clone()).await?.iter().map(|p| p.markdown()).collect::<Vec<_>>().join("\n");
    if !guides.is_empty() {
        context.push_str(&format!("\n\nGuides to the student's exam papers:\n<paper_guides>\n{}\n</paper_guides>", guides.chars().take(60_000).collect::<String>()));
    }
    let st2 = st.clone();
    let (w, vid, prompt, th) = (who(&user), v.id.clone(), s.coach_prompt().to_string(), thread.clone());
    let task = tokio::spawn(async move {
        let r = practice::ask(&st2, &w, &vid, "exam coach", &prompt, Some(context), json!(msgs), None, 6000).await;
        if let Ok(Value::String(reply)) = &r {
            let (mut kept, set) = take_assignments(reply, &with_docs);
            let mut added = Vec::new();
            for t in set {
                if st2.db.add_coach_task(w.0, vid.clone(), "retrieval", t.clone(), "Set by your coach in a conversation.".into()).await.unwrap_or(false) {
                    added.push(t);
                }
            }
            if !added.is_empty() {
                kept.push_str(&format!("\n\n*Added to your work from the coach: a retrieval quiz on {}.*", added.join(", ")));
            }
            let _ = st2.db.add_coach_message(w.0, vid.clone(), "coach", th.clone(), "assistant", kept).await;
        }
        r
    });
    match task.await {
        Ok(Ok(_)) => ok(coach_view(&st, &user, &v.id, &thread).await?),
        Ok(Err(e)) => Err(ApiErr::Bad(e)),
        Err(e) => Err(ApiErr::Internal(e.into())),
    }
}

/// Delete one saved conversation with the coach. Answers, marks, grades and work set are kept.
pub async fn coach_delete_thread(State(st): State<AppState>, user: CurrentUser, Path((id, tid)): Path<(String, String)>, headers: HeaderMap) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    if !st.db.delete_thread(tid, user.id).await? {
        return Err(ApiErr::NotFound);
    }
    ok(coach_view(&st, &user, &v.id, "").await?)
}

/// The coach grades every topic red, amber or green from the student's results, and sets retrieval quizzes on the
/// ones that need them.
pub async fn coach_grade(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    if s.api_key.is_none() {
        return Err(ApiErr::Bad("No Anthropic API key is set. An admin can add one under Admin → Claude settings.".into()));
    }
    let counts = resource_counts(&st, &v.id).await?;
    if counts.is_empty() {
        return Err(ApiErr::Bad("This vault has no topic pages to grade.".into()));
    }
    let stats = practice::stats(&st, user.id, &v.id).await?;
    let answers = stats.get("answers").and_then(Value::as_i64).unwrap_or(0);
    let topics: Vec<String> = counts.iter().map(|(t, _)| t.clone()).collect();
    let msg = format!(
        "<topics>\n{}\n</topics>\n\n<results>\n{}\n</results>\n\nGrade every topic in <topics>.",
        topics.join("\n"),
        serde_json::to_string_pretty(&stats).unwrap_or_default()
    );
    let schema = json!({
        "type": "object",
        "properties": { "grades": { "type": "array", "items": {
            "type": "object",
            "properties": {
                "topic": { "type": "string" },
                "grade": { "type": "string", "enum": ["red", "amber", "green", "none"] },
                "reason": { "type": "string" },
                "set_retrieval": { "type": "boolean" },
            },
            "required": ["topic", "grade", "reason", "set_retrieval"],
            "additionalProperties": false,
        } } },
        "required": ["grades"],
        "additionalProperties": false,
    });
    let (st2, w, vid) = (st.clone(), who(&user), v.id.clone());
    let task = tokio::spawn(async move {
        practice::ask(&st2, &w, &vid, "grading topics", crate::prompts::GRADES, None, json!([{ "role": "user", "content": msg }]), Some(schema), 16_000).await
    });
    let reply = match task.await {
        Ok(Ok(r)) => r,
        Ok(Err(e)) => return Err(ApiErr::Bad(e)),
        Err(e) => return Err(ApiErr::Internal(e.into())),
    };
    let given: Vec<Value> = reply.get("grades").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut grades: Vec<Value> = Vec::new();
    let mut to_set: Vec<(String, String)> = Vec::new();
    for (t, n) in &counts {
        let g = given.iter().find(|x| x.get("topic").and_then(Value::as_str).is_some_and(|y| y.trim().eq_ignore_ascii_case(t)));
        let grade = g.and_then(|x| x.get("grade")).and_then(Value::as_str).filter(|x| ["red", "amber", "green", "none"].contains(x)).unwrap_or("none");
        let reason: String = g.and_then(|x| x.get("reason")).and_then(Value::as_str).unwrap_or("Not practised yet.").chars().take(300).collect();
        if g.and_then(|x| x.get("set_retrieval")).and_then(Value::as_bool).unwrap_or(false) && *n > 0 && grade != "green" && to_set.len() < 5 {
            to_set.push((t.clone(), reason.clone()));
        }
        grades.push(json!({ "topic": t, "grade": grade, "reason": reason }));
    }
    st.db.save_coach_grades(user.id, v.id.clone(), json!(grades), answers).await?;
    for (t, reason) in to_set {
        st.db.add_coach_task(user.id, v.id.clone(), "retrieval", t, reason).await?;
    }
    ok(coach_view(&st, &user, &v.id, "").await?)
}

/// Remove a piece of work the coach set.
pub async fn coach_delete_task(State(st): State<AppState>, user: CurrentUser, Path((id, tid)): Path<(String, i64)>, headers: HeaderMap) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    if !st.db.delete_coach_task(tid, user.id).await? {
        return Err(ApiErr::NotFound);
    }
    ok(json!({ "tasks": st.db.coach_tasks(user.id, v.id.clone()).await?.iter().map(task_json).collect::<Vec<_>>() }))
}

// ---------------------------------------------------------------- retrieval quizzes

#[derive(Deserialize, Default)]
pub struct ResourcesQuery {
    #[serde(default)]
    topic: String,
}

fn resource_json(vault: &str, r: &practice::Resource) -> Value {
    json!({
        "note": r.note,
        "title": r.title,
        "kind": r.kind,
        "original": r.original,
        "topics": r.topics,
        "noteUrl": file_url_note(vault, &r.note),
        "fileUrl": if r.original.is_empty() { String::new() } else { file_url(vault, &r.original) },
    })
}

fn file_url_note(vault: &str, note: &str) -> String {
    crate::vault::note_url(vault, note)
}

/// The documents to do a retrieval quiz with: on one topic, or on every topic.
pub async fn resources(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, Query(q): Query<ResourcesQuery>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    let idx = index_for(&st, &v.id).await?;
    let vid = v.id.clone();
    let topic = q.topic.trim().to_string();
    let out = tokio::task::spawn_blocking(move || {
        let all = practice::vault_topics(&idx, &s);
        let chosen: Vec<String> = if topic.is_empty() { all.clone() } else { all.iter().filter(|t| t.eq_ignore_ascii_case(&topic)).cloned().collect() };
        let list = practice::resources(&idx, &s, &chosen);
        json!({ "topics": all, "resources": list.iter().map(|r| resource_json(&vid, r)).collect::<Vec<_>>() })
    })
    .await?;
    let mut out = out;
    out["tasks"] = json!(st.db.coach_tasks(user.id, v.id.clone()).await?.iter().map(task_json).collect::<Vec<_>>());
    ok(out)
}

#[derive(Deserialize)]
pub struct RetrievalBody {
    note: String,
    #[serde(default)]
    count: Option<usize>,
    /// The coach's task this quiz does, if any.
    #[serde(default)]
    task: Option<i64>,
    /// The topic it was chosen from, if any.
    #[serde(default)]
    topic: String,
}

const RETRIEVAL_TYPES: &[&str] = &["single", "multi", "fill", "written"];

/// Start a retrieval quiz: Claude writes questions answered by finding the information in one document, which is
/// shown beside them.
pub async fn retrieval(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap, Json(b): Json<RetrievalBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    if s.api_key.is_none() {
        return Err(ApiErr::Bad("No Anthropic API key is set. An admin can add one under Admin → Claude settings.".into()));
    }
    let idx = index_for(&st, &v.id).await?;
    if !crate::vault::is_note(&b.note) || !idx.contains(&b.note) {
        return Err(ApiErr::Bad("That document is no longer in the vault.".into()));
    }
    let (idx2, s2, note) = (idx.clone(), s.clone(), b.note.clone());
    let (res, text) = tokio::task::spawn_blocking(move || {
        let all = practice::vault_topics(&idx2, &s2);
        let found = practice::resources(&idx2, &s2, &all).into_iter().find(|r| r.note == note);
        (found, practice::resource_text(&idx2, &note))
    })
    .await?;
    if text.trim().len() < 200 {
        return Err(ApiErr::Bad("This document has too little text to write a retrieval quiz from.".into()));
    }
    let title = b.note.rsplit('/').next().unwrap_or(&b.note).trim_end_matches(".md").to_string();
    let mut topics = res.as_ref().map(|r| r.topics.clone()).unwrap_or_default();
    if topics.is_empty() && !b.topic.is_empty() {
        topics.push(b.topic.clone());
    }
    let count = b.count.unwrap_or(8).clamp(3, 15);
    let job = Generation {
        topics,
        types: RETRIEVAL_TYPES.iter().map(|t| t.to_string()).collect(),
        marks: vec![1, 2, 3],
        difficulty: "mixed".into(),
        count,
        use_papers: false,
        profile: None,
        spec: Vec::new(),
        focus: String::new(),
        follow_up: String::new(),
        avoid: Vec::new(),
        kind: "retrieval",
        prefill: Vec::new(),
        resource: Some(ResourceJob { note: b.note.clone(), title: title.clone(), text }),
        extra: json!({ "task": b.task }),
    };
    let sid = start_generation(&st, &user, &v.id, format!("Retrieval quiz · {title}"), job).await?;
    if let Some(t) = b.task {
        st.db.set_coach_task(t, user.id, "started", Some(sid.clone())).await?;
    }
    ok(json!({ "id": sid }))
}

/// After a retrieval quiz: a short quiz on the same document without it in front of the student.
pub async fn recall(State(st): State<AppState>, user: CurrentUser, Path((id, sid)): Path<(String, String)>, headers: HeaderMap) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let s = own_session(&st, &user, &v.id, &sid).await?;
    if s.kind != "retrieval" {
        return Err(ApiErr::Bad("A mini quiz follows a retrieval quiz.".into()));
    }
    if s.status != "marked" {
        return Err(ApiErr::Bad("Hand in the retrieval quiz first.".into()));
    }
    let settings = Settings::load(&st.db).await?;
    if settings.api_key.is_none() {
        return Err(ApiErr::Bad("No Anthropic API key is set. An admin can add one under Admin → Claude settings.".into()));
    }
    let note = s.settings.pointer("/resource/note").and_then(Value::as_str).unwrap_or("").to_string();
    let idx = index_for(&st, &v.id).await?;
    if note.is_empty() || !idx.contains(&note) {
        return Err(ApiErr::Bad("The document of this quiz is no longer in the vault.".into()));
    }
    let (idx2, n2) = (idx.clone(), note.clone());
    let text = tokio::task::spawn_blocking(move || practice::resource_text(&idx2, &n2)).await?;
    let attempts = st.db.attempts(s.id.clone()).await?;
    let mut earlier = String::new();
    for a in &attempts {
        let q = Question::from_snapshot(&a.question);
        earlier.push_str(&format!("<question marks=\"{}/{}\">\n{}\n</question>\n", a.marks.unwrap_or(0), a.total, q.text.chars().take(600).collect::<String>()));
    }
    let title = s.settings.pointer("/resource/title").and_then(Value::as_str).unwrap_or("this document").to_string();
    let topics: Vec<String> = s.settings.get("topics").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
    let job = Generation {
        topics,
        types: RETRIEVAL_TYPES.iter().map(|t| t.to_string()).collect(),
        marks: vec![1, 2, 3],
        difficulty: "mixed".into(),
        count: 5,
        use_papers: false,
        profile: None,
        spec: Vec::new(),
        focus: String::new(),
        follow_up: earlier,
        avoid: attempts.iter().map(|a| Question::from_snapshot(&a.question).text).collect(),
        kind: "recall",
        prefill: Vec::new(),
        resource: Some(ResourceJob { note, title: title.clone(), text }),
        extra: json!({ "parent": s.id, "task": s.settings.get("task").cloned().unwrap_or(Value::Null) }),
    };
    let created = start_generation(&st, &user, &v.id, format!("Mini quiz without the document · {title}"), job).await?;
    ok(json!({ "id": created }))
}

// ---------------------------------------------------------------- Ask Claude (a tutor on the notes)

/// Messages of the conversation sent back to Claude with each new one.
const CHAT_HISTORY: i64 = 40;

pub async fn chat(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, Query(q): Query<ThreadQuery>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    ok(conversation_view(&st, &user, &v.id, "chat", &q.thread).await?)
}

#[derive(Deserialize)]
pub struct ChatBody {
    message: String,
    /// The topics whose notes Claude reads; none means notes from across the vault.
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default)]
    thread: String,
}

/// Ask Claude about the notes and wait for the reply. Like the coach, the reply is worked out in its own task so it
/// is saved even if the page is closed while waiting.
pub async fn chat_send(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap, Json(b): Json<ChatBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let text: String = b.message.chars().filter(|c| !c.is_control() || *c == '\n').take(8000).collect::<String>().trim().to_string();
    if text.is_empty() {
        return Err(ApiErr::Bad("Type a message first.".into()));
    }
    let s = Settings::load(&st.db).await?;
    if s.api_key.is_none() {
        return Err(ApiErr::Bad("No Anthropic API key is set. An admin can add one under Admin → Claude settings.".into()));
    }
    let idx = index_for(&st, &v.id).await?;
    let all = practice::vault_topics(&idx, &s);
    let topics: Vec<String> = all.iter().filter(|t| b.topics.iter().any(|c| c.eq_ignore_ascii_case(t))).cloned().collect();
    let (s2, t2) = (s.clone(), topics.clone());
    let notes = tokio::task::spawn_blocking(move || practice::notes_context(&idx, &s2, &t2)).await?;
    let thread = thread_for(&st, &user, &v.id, "chat", &b.thread, &text).await?;
    st.db.add_coach_message(user.id, v.id.clone(), "chat", thread.clone(), "user", text).await?;
    let history = st.db.thread_messages(thread.clone(), CHAT_HISTORY).await?;
    let msgs = as_messages(&history);
    let context = format!(
        "Course: {}. Topics in the student's notes: {}.\n\n<notes>\n{}</notes>",
        v.name,
        if all.is_empty() { "(no topic pages)".to_string() } else { all.join("; ") },
        if notes.trim().is_empty() { "(The vault has no notes yet.)\n".to_string() } else { notes }
    );
    let st2 = st.clone();
    let (w, vid, th) = (who(&user), v.id.clone(), thread.clone());
    let task = tokio::spawn(async move {
        let r = practice::ask(&st2, &w, &vid, "ask Claude", crate::prompts::CHAT, Some(context), json!(msgs), None, 8000).await;
        if let Ok(Value::String(reply)) = &r {
            let _ = st2.db.add_coach_message(w.0, vid.clone(), "chat", th.clone(), "assistant", reply.clone()).await;
        }
        r
    });
    match task.await {
        Ok(Ok(_)) => ok(conversation_view(&st, &user, &v.id, "chat", &thread).await?),
        Ok(Err(e)) => Err(ApiErr::Bad(e)),
        Err(e) => Err(ApiErr::Internal(e.into())),
    }
}

/// Delete one saved conversation with Claude. Notes saved from it are kept.
pub async fn chat_delete_thread(State(st): State<AppState>, user: CurrentUser, Path((id, tid)): Path<(String, String)>, headers: HeaderMap) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    if !st.db.delete_thread(tid, user.id).await? {
        return Err(ApiErr::NotFound);
    }
    ok(conversation_view(&st, &user, &v.id, "chat", "").await?)
}

// ---------------------------------------------------------------- clearing the answer history

#[derive(Deserialize, Default)]
pub struct ClearHistoryBody {
    /// Everyone's answers in this vault, not only the signed-in account's (admins only).
    #[serde(default)]
    everyone: bool,
}

/// Delete every set of questions answered in this vault, with the answers, marks and feedback: the signed-in
/// account's, or (an admin) everyone's. The questions themselves, flashcards, study guides and chats are kept.
pub async fn clear_history(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap, body: Option<Json<ClearHistoryBody>>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let everyone = body.map(|Json(b)| b.everyone).unwrap_or(false);
    if everyone && !user.is_admin {
        return Err(ApiErr::Forbidden("Only an admin can clear everyone's answers.".into()));
    }
    let (sessions, answers) = st.db.clear_history(v.id.clone(), if everyone { None } else { Some(user.id) }).await?;
    st.db
        .audit(
            user.audit_id(),
            None,
            "practice_history_cleared",
            format!("{}: {}, {sessions} sets, {answers} answers", v.name, if everyone { "everyone's answers" } else { "own answers" }),
        )
        .await;
    ok(json!({ "sessions": sessions, "answers": answers }))
}

// ---------------------------------------------------------------- study guides and reports

pub const REPORT_KINDS: &[(&str, &str, &str)] = &[
    ("study_guide", "Study guide", "Key ideas, a short-answer quiz with answers, essay questions and a glossary"),
    ("briefing", "Briefing document", "The main themes and most important points, with how they connect"),
    ("cheat_sheet", "Cheat sheet", "One compact page of facts, definitions and comparisons to revise from"),
    ("glossary", "Glossary", "Every key term, defined, in alphabetical order"),
    ("faq", "FAQ", "Questions students usually have about these topics, answered"),
    ("revision_plan", "Revision plan", "What to revise first from your results, with checklists"),
    ("custom", "Write your own", "Describe what you want: structure, style and length"),
];

/// Mind maps are kept with the study guides (as a nested Markdown list) but listed on their own tab.
pub const MIND_MAP_KIND: (&str, &str, &str) = ("mind_map", "Mind map", "The main themes of the notes and how their ideas branch out");

fn report_json(idx: Option<&VaultIndex>, vault_id: &str, r: &practice::Report) -> Value {
    let label = REPORT_KINDS.iter().chain(std::iter::once(&MIND_MAP_KIND)).find(|k| k.0 == r.kind).map(|k| k.1).unwrap_or("Report");
    let mut v = json!({ "id": r.id, "kind": r.kind, "kindLabel": label, "title": r.title, "status": r.status, "error": r.error, "createdAt": r.created_at, "settings": r.settings });
    if let Some(idx) = idx {
        v["markdown"] = json!(r.content);
        v["html"] = json!(practice::render(idx, vault_id, &r.content));
    }
    v
}

pub async fn reports(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let list = st.db.reports(user.id, v.id.clone()).await?;
    ok(json!({
        "reports": list.iter().map(|r| report_json(None, &v.id, r)).collect::<Vec<_>>(),
        "kinds": REPORT_KINDS.iter().map(|(id, label, about)| json!({ "id": id, "label": label, "about": about })).collect::<Vec<_>>(),
    }))
}

async fn own_report(st: &AppState, user: &CurrentUser, vault: &str, rid: &str) -> Result<practice::Report, ApiErr> {
    let r = st.db.report(rid.to_string()).await?.ok_or(ApiErr::NotFound)?;
    if r.user_id != user.id {
        return Err(ApiErr::NotFound);
    }
    let _ = vault;
    Ok(r)
}

pub async fn report(State(st): State<AppState>, user: CurrentUser, Path((id, rid)): Path<(String, String)>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let r = own_report(&st, &user, &v.id, &rid).await?;
    let idx = index_for(&st, &v.id).await?;
    let vid = v.id.clone();
    ok(tokio::task::spawn_blocking(move || report_json(Some(&idx), &vid, &r)).await?)
}

pub async fn delete_report(State(st): State<AppState>, user: CurrentUser, Path((id, rid)): Path<(String, String)>, headers: HeaderMap) -> ApiResult {
    check_csrf(&user, &headers)?;
    authorize(&st, &user, &id).await?;
    if !st.db.delete_report(rid, user.id).await? {
        return Err(ApiErr::NotFound);
    }
    ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
pub struct ReportBody {
    kind: String,
    #[serde(default)]
    topics: Vec<String>,
    #[serde(default)]
    focus: String,
}

/// Start writing a study guide or other report. Returns at once; it becomes "ready" when Claude has written it.
pub async fn make_report(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap, Json(b): Json<ReportBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    if s.api_key.is_none() {
        return Err(ApiErr::Bad("No Anthropic API key is set. An admin can add one under Admin → Claude settings.".into()));
    }
    let Some(kind) = REPORT_KINDS.iter().chain(std::iter::once(&MIND_MAP_KIND)).find(|k| k.0 == b.kind) else {
        return Err(ApiErr::Bad("Choose what to write.".into()));
    };
    let focus = clean_focus(&b.focus);
    if kind.0 == "custom" && focus.is_empty() {
        return Err(ApiErr::Bad("Describe what you want written.".into()));
    }
    let idx = index_for(&st, &v.id).await?;
    let topics = check_topics(&practice::vault_topics(&idx, &s), &b.topics)?;
    let rid = new_id();
    let title = format!("{} · {}", kind.1, summary_title(0, "", &topics).split(" · ").nth(1).unwrap_or("all notes"));
    st.db.create_report(rid.clone(), v.id.clone(), user.id, kind.0.to_string(), title, json!({ "topics": topics, "focus": focus })).await?;
    let (st2, w, vid, rid2, kind_id) = (st.clone(), who(&user), v.id.clone(), rid.clone(), kind.0);
    tokio::spawn(async move {
        match write_report(&st2, &w, &vid, kind_id, &topics, &focus).await {
            Ok((title, md)) => {
                let _ = st2.db.finish_report(rid2, "ready", String::new(), title, md).await;
            }
            Err(e) => {
                let _ = st2.db.finish_report(rid2, "failed", e, None, String::new()).await;
            }
        }
    });
    ok(json!({ "id": rid }))
}

async fn write_report(st: &AppState, who: &Who, vault: &str, kind: &str, topics: &[String], focus: &str) -> Result<(Option<String>, String), String> {
    let s = Settings::load(&st.db).await.map_err(|_| "The settings could not be read.".to_string())?;
    let idx = index_for(st, vault).await.map_err(|_| "The vault could not be read.".to_string())?;
    let (s2, t2) = (s.clone(), topics.to_vec());
    let notes = tokio::task::spawn_blocking(move || practice::notes_context(&idx, &s2, &t2)).await.map_err(|_| "The notes could not be read.".to_string())?;
    if notes.trim().is_empty() {
        return Err("There are no notes on these topics to write from.".into());
    }
    let mut msg = format!(
        "<notes>\n{notes}</notes>\n\nWrite: {kind}.\nTopics: {}.",
        if topics.is_empty() { "all of the notes".to_string() } else { topics.join("; ") }
    );
    if matches!(kind, "revision_plan" | "custom" | "study_guide") {
        if let Ok(stats) = practice::stats(st, who.0, vault).await {
            if stats.get("answers").and_then(Value::as_i64).unwrap_or(0) > 0 {
                msg.push_str(&format!("\n\n<results>\n{}\n</results>", serde_json::to_string(&stats).unwrap_or_default()));
            }
        }
    }
    if !focus.is_empty() {
        msg.push_str(&format!("\n\n<student_request>\n{}\n</student_request>", focus.replace("</student_request>", "")));
    }
    let (what, prompt) = if kind == MIND_MAP_KIND.0 { ("making a mind map", crate::prompts::MIND_MAP) } else { ("writing a study guide", s.report_prompt()) };
    let v = practice::ask(st, who, vault, what, prompt, None, json!([{ "role": "user", "content": msg }]), None, 16_000).await?;
    let md = v.as_str().unwrap_or("").trim().to_string();
    let md = md.strip_prefix("```markdown").or_else(|| md.strip_prefix("```md")).map(|x| x.trim_end().trim_end_matches("```").trim().to_string()).unwrap_or(md);
    let title = md.lines().find_map(|l| l.strip_prefix("# ")).map(|t| t.trim().chars().take(150).collect::<String>()).filter(|t| !t.is_empty());
    Ok((title, md))
}

// ---------------------------------------------------------------- course documents and paper guides

/// The ingest worker hands over a specification, examiner report, answers and commentary, or notes and guidance,
/// with what Claude read from it.
#[derive(Deserialize)]
pub struct DocBody {
    kind: String,
    title: String,
    #[serde(default)]
    path: String,
    #[serde(default)]
    qualification: String,
    #[serde(default)]
    paper_number: String,
    #[serde(default)]
    month: String,
    #[serde(default)]
    year: i64,
    digest: Value,
}

pub async fn add_doc(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap, Json(b): Json<DocBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    if !DOC_KINDS.iter().any(|k| k.0 == b.kind) {
        return Err(ApiErr::Bad("Unknown kind of document.".into()));
    }
    if !b.digest.is_object() || b.digest.to_string().len() > 400_000 {
        return Err(ApiErr::Bad("What was read from this document is missing or too large.".into()));
    }
    let info = PaperInfo::clean(&b.qualification, &b.paper_number, &b.month, b.year);
    let title: String = b.title.trim().chars().filter(|c| !c.is_control()).take(200).collect();
    let did = st.db.add_doc(v.id.clone(), who(&user), b.kind.clone(), if title.is_empty() { "Document".into() } else { title.clone() }, b.path, info, b.digest).await?;
    st.db.audit(user.audit_id(), None, "course_doc_added", format!("{}: {} ({})", v.name, title, b.kind)).await;
    ok(json!({ "id": did }))
}

pub async fn delete_doc(State(st): State<AppState>, user: CurrentUser, Path((id, did)): Path<(String, i64)>, headers: HeaderMap) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let d = st.db.docs(v.id.clone()).await?.into_iter().find(|d| d.id == did).ok_or(ApiErr::NotFound)?;
    if !user.is_admin && d.user_id != Some(user.id) {
        return Err(ApiErr::Forbidden("Only the person who added this document, or an admin, can remove it.".into()));
    }
    st.db.delete_doc(v.id.clone(), did).await?;
    st.db.audit(user.audit_id(), None, "course_doc_removed", format!("{}: {}", v.name, d.title)).await;
    ok(json!({ "ok": true }))
}

#[derive(Deserialize)]
pub struct WipeBody {
    /// The vault's name, typed to confirm.
    confirm: String,
    /// Also move the files kept for the hub (`<originals>/Question Hub`) to the vault's trash.
    #[serde(default)]
    files: bool,
}

/// Clear everything the question hub holds for this vault (admins only). Refused while papers are being added or
/// guides built, since those would write to it again afterwards.
pub async fn wipe(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap, Json(b): Json<WipeBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    if !user.is_admin {
        return Err(ApiErr::Forbidden("Only an admin can clear the question hub.".into()));
    }
    if b.confirm.trim() != v.name.trim() {
        return Err(ApiErr::Bad(format!("Type the vault's name, \"{}\", to confirm.", v.name)));
    }
    let busy = st.db.list_batches(v.id.clone(), "paper", 50).await?.iter().any(|x| matches!(x.status.as_str(), "uploading" | "queued" | "running"));
    if busy {
        return Err(ApiErr::Bad("Papers are still being added to the hub. Wait for them to finish, or stop them, then try again.".into()));
    }
    if !practice::profile_status(&st, &v.id).0.is_empty() {
        return Err(ApiErr::Bad("The paper guides are being built. Try again in a minute or two.".into()));
    }
    let w = st.db.wipe_exam_data(v.id.clone()).await?;
    practice::clear_profile_errors(&st, &v.id);
    let mut files_moved = false;
    if b.files {
        let s = Settings::load(&st.db).await?;
        if let Some(rel) = crate::vault::safe_rel(&format!("{}/Question Hub", s.originals.trim_end_matches('/'))) {
            let root = crate::handlers::edit::root_of(&st, &v.id);
            files_moved = tokio::task::spawn_blocking(move || crate::vault::path_exists(&root, &rel) && crate::vault::move_to_trash(&root, &rel).is_ok()).await.unwrap_or(false);
            if files_moved {
                crate::handlers::edit::changed(&st, &v.id, true).await;
            }
        }
    }
    st.db
        .audit(
            user.audit_id(),
            None,
            "exam_data_wiped",
            format!(
                "{}: {} papers, {} questions, {} documents, {} guides, {} years{}",
                v.name,
                w.papers,
                w.questions,
                w.docs,
                w.guides,
                w.years,
                if files_moved { ", files moved to the trash" } else { "" }
            ),
        )
        .await;
    ok(json!({ "papers": w.papers, "questions": w.questions, "docs": w.docs, "guides": w.guides, "years": w.years, "filesMoved": files_moved }))
}

#[derive(Deserialize, Default)]
pub struct RebuildBody {
    #[serde(default)]
    qualifications: Vec<String>,
}

/// Build the paper guides again (for these qualifications, or all of them), in the background.
pub async fn rebuild_profiles(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap, body: Option<Json<RebuildBody>>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    if Settings::load(&st.db).await?.api_key.is_none() {
        return Err(ApiErr::Bad("No Anthropic API key is set. An admin can add one under Admin → Claude settings.".into()));
    }
    let known = st.db.qualifications(v.id.clone()).await?;
    let asked = body.map(|Json(b)| b.qualifications).unwrap_or_default();
    let quals: Vec<String> = if asked.is_empty() { known } else { known.into_iter().filter(|k| asked.iter().any(|a| a.eq_ignore_ascii_case(k))).collect() };
    if quals.is_empty() {
        return Err(ApiErr::Bad("Add a specification or past papers first: the guides are built from them.".into()));
    }
    let started = practice::rebuild_in_background(&st, who(&user), v.id.clone(), quals);
    ok(json!({ "building": started }))
}
