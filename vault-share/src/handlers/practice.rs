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
    auth::CurrentUser,
    errors::AppResult,
    handlers::{
        edit::{check_csrf, ok, ApiErr, ApiResult},
        ingest::Settings,
        vaults::{authorize, index_for},
    },
    practice::{self, PaperInfo, Profile, Question, Session, Who, DEFAULT_MARKS, DIFFICULTIES, DOC_KINDS, MAX_MARKS, MAX_QUESTIONS, TYPES},
    templates::{render, PageCtx, PracticePage},
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
    Ok(render(&PracticePage {
        page: PageCtx::for_user(&user),
        csrf: user.csrf.clone(),
        vault_id: v.id,
        vault_name: v.name,
        configured: s.api_key.is_some(),
        is_admin: user.is_admin,
        max_file_mb: st.cfg.max_file_bytes / 1024 / 1024,
    }))
}

/// Everything the page needs to draw its forms: topics, mark levels, question types, past papers.
pub async fn meta(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    let idx = index_for(&st, &v.id).await?;
    let topics = practice::vault_topics(&idx, &s);
    let qs = st.db.questions(v.id.clone()).await?;
    let mut marks: Vec<i64> = DEFAULT_MARKS.to_vec();
    for q in &qs {
        if !marks.contains(&q.marks) {
            marks.push(q.marks);
        }
    }
    marks.sort_unstable();
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
    });
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
            _ => true,
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
    };

    let pool: Vec<&Question> = all.iter().filter(|x| base(x)).collect();
    let mut counts: HashMap<&'static str, HashMap<String, usize>> = HashMap::new();
    for (name, facet) in [("topics", Facet::Topics), ("types", Facet::Types), ("marks", Facet::Marks), ("years", Facet::Years), ("spec", Facet::Spec)] {
        let c = counts.entry(name).or_default();
        for x in pool.iter().filter(|x| passes(x, Some(facet))) {
            let keys: Vec<String> = match facet {
                Facet::Topics => x.topics.clone(),
                Facet::Types => vec![x.qtype.clone()],
                Facet::Marks => vec![x.marks.to_string()],
                Facet::Years => year(x).map(|y| vec![y.to_string()]).unwrap_or_default(),
                Facet::Spec => x.spec.clone(),
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

/// Start writing questions. Returns the new session at once; it becomes "ready" when Claude has written them.
pub async fn generate(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap, Json(b): Json<GenerateBody>) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    let s = Settings::load(&st.db).await?;
    if s.api_key.is_none() {
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
    let focus = clean_focus(&b.focus);
    let mut title = summary_title(b.count, "question", &topics);
    if let Some(p) = &profile {
        title = format!("{} · {}", summary_title(b.count, "question", &[]).split(" · ").next().unwrap_or(""), p.title);
    }
    let job = Generation { topics, types, marks, difficulty: b.difficulty, count: b.count, use_papers: b.use_papers, profile, spec, focus, follow_up: String::new(), avoid: Vec::new() };
    let created = start_generation(&st, &user, &v.id, title, job).await?;
    ok(json!({ "id": created }))
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
    /// For a follow-up quiz: the questions the student lost marks on, and what they missed.
    follow_up: String,
    /// Question texts not to write again (a follow-up's earlier questions).
    avoid: Vec<String>,
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
    let settings = json!({
        "topics": g.topics, "types": g.types, "marks": g.marks, "difficulty": g.difficulty, "count": g.count, "usePapers": g.use_papers,
        "profile": g.profile.as_ref().map(|p| p.id), "spec": g.spec, "focus": g.focus, "followUp": !g.follow_up.is_empty(),
    });
    let session = Session {
        id: new_id(),
        vault_id: vault.to_string(),
        user_id: user.id,
        title,
        kind: "generated".into(),
        settings: settings.clone(),
        status: "generating".into(),
        error: String::new(),
        question_ids: Vec::new(),
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
        match write_questions(&st2, &w, &session.vault_id, &g).await {
            Ok(ids) => {
                let _ = st2.db.set_session(sid, "ready", String::new(), Some(ids), None).await;
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
    let type_names: Vec<&str> = types.iter().map(|t| TYPES.iter().find(|x| x.0 == t).map(|x| x.1).unwrap_or(t)).collect();
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
    if profile.is_some() {
        msg.push_str(&format!("\nThe questions are for this paper. Specification areas (use these exact labels in spec_areas): {}.", spec.join("; ")));
    }
    if !g.follow_up.is_empty() {
        msg.push_str(&format!(
            "\n\n<follow_up>\n{}\n</follow_up>\nThe student has already answered every question in <follow_up>. Write {count} completely new questions on the same ideas: a different scenario, wording and angle for each. Never copy or lightly reword a question from <follow_up>.",
            g.follow_up
        ));
    }
    if !g.focus.is_empty() {
        msg.push_str(&format!("\n\n<student_request>\n{}\n</student_request>", g.focus.replace("</student_request>", "")));
    }
    let schema = json!({
        "type": "object",
        "properties": { "questions": { "type": "array", "items": practice::question_schema(false) } },
        "required": ["questions"],
        "additionalProperties": false,
    });
    let v = practice::ask(st, who, vault, "writing questions", s.generate_prompt(), None, json!([{ "role": "user", "content": msg }]), Some(schema), 32_000).await?;
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
    let qs: Vec<Question> = qs.into_iter().map(|mut q| { q.profile_id = profile.map(|p| p.id); q }).collect();
    if qs.is_empty() {
        return Err("Claude's questions could not be used. Try again.".into());
    }
    st.db.add_questions(vault.to_string(), "generated", who.0, qs).await.map_err(|_| "The questions could not be saved.".to_string())
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
    ok(out)
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
        let task = tokio::spawn(async move { practice::mark_written(&st2, &w, &vid, &q2, &text, guide).await });
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
    let job = Generation { topics, types, marks, difficulty, count, use_papers, profile, spec, focus: String::new(), follow_up: brief, avoid };
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

// ---------------------------------------------------------------- exam coach

const COACH_HISTORY: i64 = 30;

async fn coach_view(st: &AppState, user: &CurrentUser, vault: &str) -> Result<Value, ApiErr> {
    let idx = index_for(st, vault).await?;
    let msgs = st.db.coach_messages(user.id, vault.to_string(), 200).await?;
    let stats = practice::stats(st, user.id, vault).await?;
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
    Ok(json!({ "messages": list, "stats": stats }))
}

pub async fn coach(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>) -> ApiResult {
    let v = authorize(&st, &user, &id).await?;
    ok(coach_view(&st, &user, &v.id).await?)
}

#[derive(Deserialize)]
pub struct CoachBody {
    message: String,
}

/// Send a message to the coach and wait for the reply. The reply is worked out in its own task, so it is still
/// saved if the page is closed while waiting.
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
    st.db.add_coach_message(user.id, v.id.clone(), "user", text).await?;
    let stats = practice::stats(&st, user.id, &v.id).await?;
    let idx = index_for(&st, &v.id).await?;
    let topics = practice::vault_topics(&idx, &s);
    let history = st.db.coach_messages(user.id, v.id.clone(), COACH_HISTORY).await?;
    // The conversation must start with the student; drop a leading reply left by the history limit.
    let msgs: Vec<Value> = history
        .iter()
        .skip_while(|(r, _, _)| r != "user")
        .map(|(r, c, _)| json!({ "role": if r == "assistant" { "assistant" } else { "user" }, "content": c }))
        .collect();
    let mut context = format!(
        "Course: {}. Topics in the student's notes: {}.\n\nThe student's practice results so far (JSON; percentages are of marks available):\n{}",
        v.name,
        if topics.is_empty() { "(none yet)".to_string() } else { topics.join("; ") },
        serde_json::to_string_pretty(&stats).unwrap_or_default()
    );
    let guides: String = st.db.profiles(v.id.clone()).await?.iter().map(|p| p.markdown()).collect::<Vec<_>>().join("\n");
    if !guides.is_empty() {
        context.push_str(&format!("\n\nGuides to the student's exam papers:\n<paper_guides>\n{}\n</paper_guides>", guides.chars().take(60_000).collect::<String>()));
    }
    let st2 = st.clone();
    let (w, vid, prompt) = (who(&user), v.id.clone(), s.coach_prompt().to_string());
    let task = tokio::spawn(async move {
        let r = practice::ask(&st2, &w, &vid, "exam coach", &prompt, Some(context), json!(msgs), None, 6000).await;
        if let Ok(Value::String(reply)) = &r {
            let _ = st2.db.add_coach_message(w.0, vid.clone(), "assistant", reply.clone()).await;
        }
        r
    });
    match task.await {
        Ok(Ok(_)) => ok(coach_view(&st, &user, &v.id).await?),
        Ok(Err(e)) => Err(ApiErr::Bad(e)),
        Err(e) => Err(ApiErr::Internal(e.into())),
    }
}

pub async fn coach_clear(State(st): State<AppState>, user: CurrentUser, Path(id): Path<String>, headers: HeaderMap) -> ApiResult {
    check_csrf(&user, &headers)?;
    let v = authorize(&st, &user, &id).await?;
    st.db.clear_coach(user.id, v.id.clone()).await?;
    ok(coach_view(&st, &user, &v.id).await?)
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

fn report_json(idx: Option<&VaultIndex>, vault_id: &str, r: &practice::Report) -> Value {
    let label = REPORT_KINDS.iter().find(|k| k.0 == r.kind).map(|k| k.1).unwrap_or("Report");
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
    let Some(kind) = REPORT_KINDS.iter().find(|k| k.0 == b.kind) else {
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
    let v = practice::ask(st, who, vault, "writing a study guide", s.report_prompt(), None, json!([{ "role": "user", "content": msg }]), None, 16_000).await?;
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
