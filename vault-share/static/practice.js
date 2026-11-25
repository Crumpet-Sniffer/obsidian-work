// Practice page: questions Claude writes from the vault's notes, the question hub of past exam questions,
// flashcards, the history of everything answered, and the exam coach. Talks to /v/{id}/api/practice/... (see
// src/handlers/practice.rs). Question and feedback HTML comes from the server already sanitised.
(() => {
  "use strict";
  const host = document.querySelector("[data-practice]");
  if (!host) return;
  const vault = host.dataset.vault;
  const csrf = host.dataset.csrf;
  const base = `/v/${vault}/api`;
  const $ = (sel, root = host) => root.querySelector(sel);
  const $$ = (sel, root = host) => [...root.querySelectorAll(sel)];

  // ---------- helpers ----------
  class ApiError extends Error {}
  async function api(method, path, body) {
    const res = await fetch(`${base}/${path}`, {
      method,
      credentials: "same-origin",
      headers: { "X-CSRF-Token": csrf, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new ApiError((data && data.error) || (res.status === 401 ? "Your session expired. Reload the page and sign in again." : `The server answered ${res.status}.`));
    return data;
  }
  function make(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const when = (ts) => new Date(ts * 1000).toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  let meta = null;
  const typeLabel = (t) => ((meta && meta.types.find((x) => x.id === t)) || { label: t }).label;
  /** Links to the inserts of a question's paper (its case study or source booklet), or nothing. */
  function insertLinks(q) {
    const paper = meta && q.paperId && meta.papers.find((p) => p.id === q.paperId);
    if (!paper || !paper.insertUrls || !paper.insertUrls.length) return [];
    return paper.insertUrls.map((u, i) => {
      const a = make("a", "small", paper.insertUrls.length > 1 ? `Insert ${i + 1}` : "Insert");
      a.href = u;
      a.target = "_blank";
      a.title = "The case study or source material given with this paper";
      return a;
    });
  }

  function alertBox(where, text, kind = "error") {
    const p = make("p", `alert ${kind}`, text);
    where.prepend(p);
    setTimeout(() => p.remove(), 8000);
  }

  /** A short message at the bottom of the screen that goes away by itself. */
  let toastTimer = 0;
  function toast(text, kind = "ok") {
    let t = document.querySelector(".pr-toast");
    if (!t) { t = make("div", "pr-toast"); t.setAttribute("role", "status"); document.body.appendChild(t); }
    t.textContent = text;
    t.className = `pr-toast is-${kind} is-on`;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => t.classList.remove("is-on"), 3500);
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast("Copied."); } catch { toast("Could not copy: your browser blocked it.", "error"); }
  }

  function download(name, text, type = "text/markdown") {
    const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
    const a = make("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** A file name made from a title: no characters that are not allowed in vault paths. */
  const fileName = (t) => (t || "Untitled").replace(/[\\/:*?"<>|#^[\]]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "Untitled";

  /** Save Markdown into the vault as a new note (adding a number if the name is taken). Returns its URL. */
  async function saveNote(folder, title, md) {
    const name = fileName(title);
    // The vault shows the file name as the note's title, so a first heading saying the same is left out.
    md = md.replace(/^\s*# [^\n]*\n+/, "");
    for (let n = 1; n < 50; n++) {
      const path = `${folder}/${name}${n > 1 ? ` ${n}` : ""}.md`;
      const res = await fetch(`${base}/create`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "X-CSRF-Token": csrf, Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "note", path, content: md }),
      });
      if (res.status === 409) continue;
      let data = null;
      try { data = await res.json(); } catch { /* not JSON */ }
      if (!res.ok) throw new ApiError((data && data.error) || `The server answered ${res.status}.`);
      return data;
    }
    throw new ApiError("There are already too many notes with that name.");
  }

  /** Show fill-in blanks ({{1}}, {{2}} ...) in a question's text as numbered gaps, where they cannot be typed in. */
  function showGaps(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (/\{\{\d+\}\}/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const frag = document.createDocumentFragment();
      for (const part of node.nodeValue.split(/(\{\{\d+\}\})/)) {
        const m = part.match(/^\{\{(\d+)\}\}$/);
        if (m) frag.appendChild(make("span", "pr-gap", `(${m[1]})`));
        else if (part) frag.appendChild(document.createTextNode(part));
      }
      node.parentNode.replaceChild(frag, node);
    }
  }

  // ---------- tabs ----------
  const TABS = ["questions", "hub", "cards", "guides", "mindmaps", "ask", "history", "coach"];
  // Views opened from a tab keep that tab highlighted.
  const PARENT = { quiz: null, study: "cards", report: "guides", mindmap: "mindmaps" };
  /** The tab named in the address (#hub, or #hub?years=2024 from a link with filters set). */
  const hashTab = () => location.hash.slice(1).split("?")[0];
  function show(name) {
    if (name !== "report") stopListening();
    if (name !== "study") stopTimer();
    $$("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
    const tab = TABS.includes(name) ? name : PARENT[name] !== undefined ? PARENT[name] || hashTab() : "";
    $$("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false"));
    // On a phone the tab row scrolls sideways: keep the chosen tab in view.
    const sel = $(`[data-tab="${tab}"]`);
    if (sel && sel.parentElement.scrollWidth > sel.parentElement.clientWidth) sel.parentElement.scrollTo({ left: sel.offsetLeft - 16, behavior: "smooth" });
    if (TABS.includes(name) && location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
    if (name === "history") loadHistory();
    if (name === "cards") loadDecks();
    if (name === "coach") coachChat.load();
    if (name === "ask") askChat.load();
    if (name === "guides") loadReports();
    if (name === "mindmaps") loadMaps();
    if (name === "hub") loadHub();
    window.scrollTo({ top: 0 });
  }
  // Arrow keys move between the tabs (the tab pattern).
  $("[role=tablist]").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const tabs = $$("[data-tab]");
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    show(tabs[next].dataset.tab);
  });
  window.addEventListener("hashchange", () => { if (TABS.includes(hashTab())) openFromHash(); });
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));

  // ---------- choice groups with "Select all" ----------
  // values: [{value, label}]. Returns a function giving the ticked values.
  function choices(name, values, { checked = true, anyHint = "" } = {}) {
    const box = $(`[data-choices="${name}"]`);
    if (!box) return () => [];
    const legend = box.querySelector("legend");
    const before = $$(".pr-chip input", box);
    const wasTicked = new Set(before.filter((c) => c.checked).map((c) => c.value));
    box.replaceChildren(legend);
    if (!values.length) {
      box.appendChild(make("p", "muted small", name.includes("topics") ? "This vault has no topic pages yet, so questions cover all of its notes." : "Nothing to choose from yet."));
      return () => [];
    }
    const all = make("label", "check pr-all");
    const allBox = make("input");
    allBox.type = "checkbox";
    all.append(allBox, document.createTextNode(" Select all"));
    const list = make("div", "pr-choice-list");
    const boxes = values.map((v) => {
      const l = make("label", "check pr-chip");
      const c = make("input");
      c.type = "checkbox";
      c.value = String(v.value);
      c.checked = before.length ? wasTicked.has(String(v.value)) : checked;
      l.append(c, make("span", "pr-chip-label", ` ${v.label}`), make("span", "pr-n"));
      list.appendChild(l);
      return c;
    });
    const count = make("span", "muted small pr-count");
    const sync = () => {
      const n = boxes.filter((b) => b.checked).length;
      allBox.checked = n === boxes.length;
      allBox.indeterminate = n > 0 && n < boxes.length;
      count.textContent = `${n} of ${boxes.length} chosen`;
    };
    // "Select all" acts on the ones the search shows (all of them when there is no search).
    const shown = () => boxes.filter((b) => !b.parentElement.hidden);
    allBox.addEventListener("change", () => { shown().forEach((b) => { b.checked = allBox.checked; }); sync(); box.dispatchEvent(new Event("change", { bubbles: true })); });
    boxes.forEach((b) => b.addEventListener("change", sync));
    const top = make("div", "pr-choice-top");
    top.append(all);
    if (values.length > 12) {
      const find = make("input", "pr-find");
      find.type = "search";
      find.placeholder = "Search…";
      find.setAttribute("aria-label", `Search ${legend ? legend.textContent : "the choices"}`);
      find.addEventListener("input", () => {
        const q = find.value.trim().toLowerCase();
        boxes.forEach((b) => { b.parentElement.hidden = !!q && !b.parentElement.querySelector(".pr-chip-label").textContent.toLowerCase().includes(q); });
        all.lastChild.nodeValue = q ? " Select all shown" : " Select all";
      });
      // Enter in the search box must not submit the form.
      find.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
      top.append(find);
    }
    top.append(count);
    sync();
    box.append(top, list);
    if (anyHint) box.appendChild(make("p", "muted small", anyHint));
    return () => boxes.filter((b) => b.checked).map((b) => b.value);
  }

  let pick = {};
  async function loadMeta() {
    meta = await api("GET", "practice/meta");
    const topics = meta.topics.map((t) => ({ value: t, label: t }));
    const types = meta.types.map((t) => ({ value: t.id, label: t.label }));
    const marks = meta.markLevels.map((m) => ({ value: m, label: plural(m, "mark") }));
    pick.topics = choices("topics", topics);
    pick.types = choices("types", types);
    pick.marks = choices("marks", marks);
    pick.hubTopics = choices("hub-topics", topics, { checked: false });
    pick.hubTypes = choices("hub-types", types, { checked: false });
    pick.hubStyles = choices("hub-styles", (meta.styles || []).map((s) => ({ value: s, label: s })), { checked: false });
    pick.hubMarks = choices("hub-marks", marks, { checked: false });
    const years = [...new Set(meta.papers.map((p) => p.year).filter((y) => y > 0))].sort((a, b) => b - a);
    pick.hubYears = choices("hub-years", years.map((y) => ({ value: y, label: String(y) })), { checked: false });
    pick.cardTopics = choices("card-topics", topics);
    pick.reportTopics = choices("report-topics", topics);
    const specLabels = [...new Set(meta.profiles.flatMap((p) => p.fields.map((f) => f.label)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    pick.hubSpec = choices("hub-spec", specLabels.map((l) => ({ value: l, label: l })), { checked: false });
    $("[data-facet-spec]").hidden = !specLabels.length;
    // Questions tab: write for one paper, on some of its specification areas.
    const paperSel = $("[data-gen-paper]");
    const keepPaper = paperSel.value;
    paperSel.replaceChildren(new Option("Any paper (no paper guide)", ""));
    for (const p of meta.profiles) paperSel.appendChild(new Option(`${p.title}${p.qualification ? ` · ${p.qualification}` : ""}`, String(p.id)));
    paperSel.value = [...paperSel.options].some((o) => o.value === keepPaper) ? keepPaper : "";
    $("[data-gen-paper-row]").hidden = !meta.profiles.length;
    genPaperChanged();
    pick.mapTopics = choices("map-topics", topics);
    pick.askTopics = choices("ask-topics", topics, { checked: false });
    askScope();
    drawBuilding();
    const usePapers = $("[data-gen-form] [name=use_papers]");
    usePapers.disabled = !meta.paperQuestions;
    usePapers.checked = !!meta.paperQuestions;
    usePapers.parentElement.title = meta.paperQuestions ? `${meta.paperQuestions} past paper questions in the hub` : "No past papers have been added yet (an admin adds them on the admin page)";
    renderPapers();
    if (!hubState.sourceSet) { hubState.sourceSet = true; hubForm.querySelector("[name=source]").value = defaultSource(); }
  }

  // ---------- writing questions ----------
  const genForm = $("[data-gen-form]");
  function genPaperChanged() {
    const p = meta.profiles.find((x) => String(x.id) === $("[data-gen-paper]").value);
    const box = $("[data-choices=gen-spec]");
    box.hidden = !p;
    pick.genSpec = p ? choices("gen-spec", p.fields.map((f) => ({ value: f.label, label: f.questions ? `${f.label} (${f.questions})` : f.label }))) : () => [];
    $("[data-gen-paper-hint]").textContent = p ? "Claude follows this paper's format, command words and examiners' advice, and models the questions on its past papers." : "";
  }
  $("[data-gen-paper]").addEventListener("change", genPaperChanged);
  async function generate(count) {
    const f = new FormData(genForm);
    const body = {
      topics: pick.topics(),
      types: pick.types(),
      marks: pick.marks().map(Number),
      difficulty: f.get("difficulty"),
      count,
      use_papers: !!f.get("use_papers"),
      profile: f.get("profile") ? Number(f.get("profile")) : null,
      spec: pick.genSpec ? pick.genSpec() : [],
      focus: String(f.get("focus") || ""),
    };
    const btns = $$("button", genForm);
    btns.forEach((b) => { b.disabled = true; });
    try {
      const r = await api("POST", "practice/generate", body);
      openSession(r.id);
    } catch (e) {
      alertBox(genForm, e.message);
    } finally {
      btns.forEach((b) => { b.disabled = false; });
    }
  }
  genForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const n = Math.max(1, Math.min(meta ? meta.maxQuestions : 30, parseInt(new FormData(genForm).get("count"), 10) || 1));
    generate(n);
  });
  $("[data-gen-one]").addEventListener("click", () => generate(1));

  // ---------- a set of questions: answering and results ----------
  // Questions can be checked one by one before handing in (choice and fill-in at once, written ones by Claude),
  // shown all on one page or one at a time, and once marked there is a summary with follow-ups.
  const quiz = { id: null, data: null, poll: 0, t0: 0, at: 0, filter: "all", mode: "all" };
  try { quiz.mode = localStorage.getItem("pr.quizMode") === "one" ? "one" : "all"; } catch { /* storage blocked */ }
  const quizItems = $("[data-quiz-items]");
  const quizStatus = $("[data-quiz-status]");

  async function openSession(id) {
    quiz.id = id;
    quiz.data = null;
    quiz.at = 0;
    quiz.filter = "all";
    quiz.t0 = 0;
    show("quiz");
    $("[data-quiz-title]").textContent = "Loading…";
    $("[data-quiz-score]").textContent = "";
    $("[data-quiz-summary]").hidden = true;
    $("[data-quiz-tools]").hidden = true;
    $("[data-quiz-dots]").hidden = true;
    $("[data-quiz-step]").hidden = true;
    $("[data-quiz-actions]").hidden = true;
    $("[data-quiz-after]").hidden = true;
    quizItems.replaceChildren();
    quizStatus.textContent = "";
    await refreshSession();
  }

  async function refreshSession() {
    window.clearTimeout(quiz.poll);
    const id = quiz.id;
    let s;
    try {
      s = await api("GET", `practice/sessions/${id}`);
    } catch (e) {
      quizStatus.textContent = e.message;
      return;
    }
    if (quiz.id !== id) return;
    quiz.data = s;
    $("[data-quiz-title]").textContent = s.title;
    const busy = s.status === "generating" || s.status === "marking";
    if (busy) {
      const t0 = quiz.t0 || (quiz.t0 = Date.now());
      const secs = Math.round((Date.now() - t0) / 1000);
      quizStatus.textContent = s.status === "generating"
        ? `Claude is writing ${plural((s.settings && s.settings.count) || s.questions, "question")} from your notes… (${secs} s; this can take a minute or two, and you can leave this page)`
        : `Marking your answers… (${secs} s)`;
      quiz.poll = window.setTimeout(refreshSession, 2000);
    } else {
      quiz.t0 = 0;
    }
    if (s.status === "failed") {
      quizStatus.textContent = s.error || "This did not work. Try again.";
      ["[data-quiz-actions]", "[data-quiz-after]", "[data-quiz-tools]", "[data-quiz-dots]", "[data-quiz-step]"].forEach((x) => { $(x).hidden = true; });
      return;
    }
    if (s.status === "generating") return;
    if (s.status === "ready") {
      const marks = s.items.reduce((n, q) => n + q.marks, 0);
      quizStatus.textContent = `${plural(s.items.length, "question")}, ${plural(marks, "mark")}. Check each answer as you go if you like, then hand ${s.items.length === 1 ? "it" : "them"} in for marking.`;
    }
    if (s.status === "marked") {
      quizStatus.textContent = s.error || "Marked. Your answers, the marks and the feedback are saved in History.";
      $("[data-quiz-score]").textContent = `${s.score} / ${s.total} (${pct(s.score, s.total)}%)`;
    }
    if (s.status !== "marking" || !quizItems.children.length) renderItems(s);
    $("[data-quiz-actions]").hidden = s.status !== "ready";
    $("[data-quiz-after]").hidden = s.status !== "marked";
    $("[data-quiz-tools]").hidden = !(s.status === "ready" || s.status === "marked") || s.items.length < 2;
    renderSummary(s);
    layout();
  }

  // Fill-in blanks: {{1}}, {{2}} ... in the question's text become boxes.
  function placeBlanks(root, qid, disabled, values) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (/\{\{\d+\}\}/.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
    const inputs = [];
    for (const node of nodes) {
      const parts = node.nodeValue.split(/(\{\{\d+\}\})/);
      const frag = document.createDocumentFragment();
      for (const part of parts) {
        const m = part.match(/^\{\{(\d+)\}\}$/);
        if (!m) { frag.appendChild(document.createTextNode(part)); continue; }
        const i = parseInt(m[1], 10) - 1;
        const inp = make("input", "pr-blank");
        inp.type = "text";
        inp.maxLength = 200;
        inp.dataset.blank = String(i);
        inp.setAttribute("aria-label", `Blank ${i + 1}`);
        inp.autocomplete = "off";
        inp.spellcheck = false;
        inp.disabled = disabled;
        if (values && values[i] !== undefined) inp.value = values[i];
        inputs[i] = inp;
        frag.appendChild(inp);
      }
      node.parentNode.replaceChild(frag, node);
    }
    return inputs;
  }

  /** The marking of a question: the handed-in attempt, or the answer checked before handing in. */
  const markingOf = (q) => q.attempt || q.check || null;
  /** How a question went: "full", "part", "zero", "skipped", "answered" (not checked yet) or "" (no answer). */
  function stateOf(q, li) {
    const a = markingOf(q);
    if (a) {
      if (isEmpty(a.answer || {})) return quiz.data && quiz.data.status === "marked" ? "skipped" : "";
      if (a.marks === null || a.marks === undefined) return "";
      return a.marks >= a.total ? "full" : a.marks > 0 ? "part" : "zero";
    }
    return li && !isEmpty(answerOf(li, q)) ? "answered" : "";
  }
  function isEmpty(a) {
    if (!a) return true;
    if ("text" in a) return !String(a.text || "").trim();
    if ("choice" in a) return a.choice === null || a.choice === undefined;
    if ("choices" in a) return !(a.choices || []).length;
    if ("blanks" in a) return (a.blanks || []).every((x) => !String(x || "").trim());
    return true;
  }

  function renderItems(s) {
    quizItems.replaceChildren();
    s.items.forEach((q, n) => quizItems.appendChild(renderItem(q, n, s)));
  }

  function renderItem(q, n, s) {
    const li = make("li", "pr-q");
    li.dataset.qid = q.id;
    li.id = `pr-q-${n + 1}`;
    const head = make("div", "pr-q-head");
    head.append(make("strong", "", `Question ${n + 1}`));
    head.append(make("span", "pr-tag", plural(q.marks, "mark")));
    if (q.style) head.append(make("span", "pr-tag pr-style", q.style));
    head.append(make("span", "pr-tag", typeLabel(q.type)));
    for (const t of q.topics) head.append(make("span", "pr-tag pr-topic", t));
    for (const t of q.spec || []) head.append(make("span", "pr-tag pr-spec", t));
    if (q.paper) head.append(make("span", "muted small", `${q.paper}${q.number ? ` · Q${q.number}` : ""}`));
    head.append(...insertLinks(q));
    li.appendChild(head);
    const body = make("div", "pr-q-text prose");
    body.innerHTML = q.html;
    li.appendChild(body);
    const a = markingOf(q);
    const locked = s.status === "marked" || s.status === "marking" || !!q.check;
    const ans = (a && a.answer) || {};
    const fb = (a && a.feedback) || {};
    if (q.type === "fill") {
      const inputs = placeBlanks(body, q.id, locked, ans.blanks);
      if (!inputs.length) body.appendChild(make("p", "muted small", "This question's blanks could not be shown."));
      if (a && Array.isArray(fb.blanks)) {
        inputs.forEach((inp, i) => {
          if (!inp) return;
          inp.classList.add(fb.blanks[i] ? "is-right" : "is-wrong");
          if (!fb.blanks[i] && q.accepted && q.accepted[i]) inp.title = `Accepted: ${q.accepted[i].join(", ")}`;
        });
        li.appendChild(make("p", "small muted", `Answers: ${(q.accepted || []).map((b, i) => `(${i + 1}) ${b[0]}`).join(" · ")}`));
      }
    } else if (q.type === "single" || q.type === "multi") {
      const list = make("div", "pr-options");
      if (q.type === "multi") list.appendChild(make("p", "muted small", "Select all that apply."));
      q.options.forEach((opt, i) => {
        const l = make("label", "check pr-option");
        const c = make("input");
        c.type = q.type === "single" ? "radio" : "checkbox";
        c.name = `q${q.id}`;
        c.value = String(i);
        c.disabled = locked;
        const picked = q.type === "single" ? ans.choice === i : (ans.choices || []).includes(i);
        c.checked = !!picked;
        const letter = make("span", "pr-letter", String.fromCharCode(65 + i));
        const text = make("span", "pr-option-text");
        text.appendChild(document.createTextNode(opt));
        if (a && q.correct) {
          const right = q.correct.includes(i);
          if (right) l.classList.add("is-right");
          else if (picked) l.classList.add("is-wrong");
          // Claude's notes can start "Correct:" or "Wrong:", which the tick or cross already says.
          const note = ((q.optionNotes && q.optionNotes[i]) || "").replace(/^\s*(correct|incorrect|wrong|right|true|false)\b[\s:.,;–—-]*/i, "").replace(/^./, (c) => c.toUpperCase());
          if (right || picked) text.appendChild(make("span", "pr-option-note", `${right ? (picked ? "✓ That's right. " : "✓ The right answer. ") : "✗ Not quite. "}${note || ""}`));
          else if (note) text.appendChild(make("span", "pr-option-note muted", note));
        }
        l.append(c, letter, text);
        list.appendChild(l);
      });
      li.appendChild(list);
    } else {
      const ta = make("textarea", "pr-written");
      ta.rows = Math.min(14, 3 + q.marks);
      ta.maxLength = 20000;
      ta.placeholder = `Your answer (${plural(q.marks, "mark")})`;
      ta.setAttribute("aria-label", `Your answer to question ${n + 1}`);
      ta.disabled = locked;
      ta.value = ans.text || "";
      const wc = make("span", "muted small pr-wc");
      const count = () => { const w = ta.value.trim().split(/\s+/).filter(Boolean).length; wc.textContent = plural(w, "word"); };
      ta.addEventListener("input", count);
      count();
      li.append(ta, wc);
    }
    // Before handing in: a hint, and checking this one answer.
    if (s.status === "ready" && !q.check) {
      const act = make("div", "pr-actions pr-q-actions");
      if (q.hint) {
        const hint = make("p", "pr-hint small", `Hint: ${q.hint}`);
        hint.hidden = true;
        const hb = make("button", "small", "Show a hint");
        hb.type = "button";
        hb.addEventListener("click", () => { hint.hidden = !hint.hidden; hb.textContent = hint.hidden ? "Show a hint" : "Hide the hint"; });
        act.appendChild(hb);
        li.appendChild(hint);
      }
      const cb = make("button", "small", q.type === "written" ? "Mark this answer now" : "Check answer");
      cb.type = "button";
      cb.title = q.type === "written" ? "Claude marks this answer against the mark scheme now; it is not marked again when you hand in" : "See if this answer is right";
      cb.addEventListener("click", () => checkOne(li, q, cb));
      act.appendChild(cb);
      li.appendChild(act);
    }
    if (a) li.appendChild(result(q, a, n));
    li.addEventListener("input", () => { if (quiz.mode === "one" || !$("[data-quiz-dots]").hidden) drawDots(); });
    li.addEventListener("change", () => drawDots());
    return li;
  }

  async function checkOne(li, q, btn) {
    const answer = answerOf(li, q);
    if (isEmpty(answer)) { toast(q.type === "written" ? "Write an answer first." : "Answer the question first.", "error"); return; }
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = q.type === "written" ? "Claude is marking…" : "Checking…";
    try {
      const j = await api("POST", `practice/sessions/${quiz.id}/check`, { question_id: q.id, answer });
      const i = quiz.data.items.findIndex((x) => x.id === q.id);
      if (i < 0) return;
      quiz.data.items[i] = j;
      const fresh = renderItem(j, i, quiz.data);
      li.replaceWith(fresh);
      layout();
      const r = fresh.querySelector(".pr-result");
      if (r) r.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e) {
      toast(e.message, "error");
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  function result(q, a, n) {
    const box = make("div", "pr-result");
    const fb = a.feedback || {};
    const top = make("div", "pr-result-top");
    if (a.marks === null || a.marks === undefined) top.append(make("strong", "pr-mark is-pending", fb.error ? "Not marked" : "Marking…"));
    else top.append(make("strong", `pr-mark ${a.marks === a.total ? "is-full" : a.marks === 0 ? "is-zero" : "is-part"}`, `${a.marks} / ${a.total}`));
    if (q.check && !q.attempt) top.append(make("span", "muted small", "Checked. It counts when you hand in."));
    const explain = make("button", "small linklike", "Ask Claude to explain this");
    explain.type = "button";
    explain.addEventListener("click", () => {
      const yours = q.type === "written" ? (a.answer && a.answer.text) || "" : q.type === "fill" ? ((a.answer && a.answer.blanks) || []).join(" / ") : q.type === "single" ? q.options[a.answer && a.answer.choice] || "" : ((a.answer && a.answer.choices) || []).map((i) => q.options[i]).join("; ");
      const text = make("div");
      text.innerHTML = q.html;
      const scheme = make("div");
      scheme.innerHTML = q.schemeHtml || "";
      const opts = q.options && q.options.length ? `\nOptions: ${q.options.map((o, i) => `${String.fromCharCode(65 + i)}) ${o}`).join("; ")}` : "";
      const marking = [
        a.marks !== null && a.marks !== undefined ? `Marks: ${a.marks} out of ${a.total}` : "",
        fb.feedback ? `Feedback: ${String(fb.feedback).slice(0, 1200)}` : "",
        fb.missed && fb.missed.length ? `Missed: ${fb.missed.join("; ").slice(0, 800)}` : "",
        scheme.textContent.trim() ? `Mark scheme: ${scheme.textContent.trim().slice(0, 1500)}` : "",
      ].filter(Boolean).join("\n");
      askClaude(`Explain question ${n + 1} to me: what the right answer is, why, and what I should have done to get full marks.\n\nQuestion: ${text.textContent.trim().slice(0, 1500)}${opts}\n\nMy answer: ${String(yours).slice(0, 2000) || "(none)"}${marking ? `\n\n${marking}` : ""}`);
    });
    top.append(explain);
    box.appendChild(top);
    if (fb.error) box.appendChild(make("p", "small", fb.error));
    if (fb.feedbackHtml) { const d = make("div", "prose small"); d.innerHTML = fb.feedbackHtml; box.appendChild(d); }
    else if (fb.feedback) box.appendChild(make("p", "small", fb.feedback));
    if (q.explanation) box.appendChild(make("p", "small pr-why", q.explanation));
    const lists = make("div", "pr-points");
    const listOf = (title, items, cls) => {
      if (!items || !items.length) return;
      const d = make("div", cls);
      d.appendChild(make("strong", "small", title));
      const ul = make("ul", "small");
      items.forEach((x) => ul.appendChild(make("li", "", x)));
      d.appendChild(ul);
      lists.appendChild(d);
    };
    listOf("You got", fb.met, "pr-met");
    listOf("You missed", fb.missed, "pr-missed");
    if (lists.children.length) box.appendChild(lists);
    if (fb.modelHtml) {
      const d = make("details", "pr-more");
      d.appendChild(make("summary", "", "Model answer"));
      const c = make("div", "prose small");
      c.innerHTML = fb.modelHtml;
      d.appendChild(c);
      box.appendChild(d);
    }
    if (q.schemeHtml) {
      const d = make("details", "pr-more");
      d.appendChild(make("summary", "", "Mark scheme"));
      const c = make("div", "prose small");
      c.innerHTML = q.schemeHtml;
      d.appendChild(c);
      box.appendChild(d);
    }
    return box;
  }

  /** The answer given in one question's box. */
  function answerOf(li, q) {
    if (q.type === "single") {
      const c = li.querySelector("input[type=radio]:checked");
      return { choice: c ? Number(c.value) : null };
    }
    if (q.type === "multi") return { choices: $$("input[type=checkbox]:checked", li).map((c) => Number(c.value)) };
    if (q.type === "fill") {
      const b = [];
      $$("input.pr-blank", li).forEach((i) => { b[Number(i.dataset.blank)] = i.value; });
      return { blanks: Array.from(b, (x) => x || "") };
    }
    const ta = li.querySelector("textarea");
    return { text: ta ? ta.value : "" };
  }

  function collectAnswers() {
    const out = {};
    for (const li of $$(".pr-q", quizItems)) {
      const q = quiz.data.items.find((x) => String(x.id) === li.dataset.qid);
      if (q) out[q.id] = answerOf(li, q);
    }
    return out;
  }

  // ----- one at a time, the dots and the summary
  function layout() {
    if (!quiz.data || !quiz.data.items) return;
    const s = quiz.data;
    const one = quiz.mode === "one" && s.items.length > 1 && (s.status === "ready" || s.status === "marked");
    $$("[data-quiz-mode]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.quizMode === quiz.mode ? "true" : "false"));
    quiz.at = Math.max(0, Math.min(quiz.at, s.items.length - 1));
    const lis = $$(".pr-q", quizItems);
    lis.forEach((li, i) => {
      const q = s.items[i];
      const passes = quiz.filter === "all" || stateOf(q, li) === quiz.filter;
      li.hidden = one ? i !== quiz.at : !passes;
    });
    const step = $("[data-quiz-step]");
    step.hidden = !one;
    $("[data-quiz-prev]").disabled = quiz.at === 0;
    $("[data-quiz-next]").disabled = quiz.at >= s.items.length - 1;
    // In one-at-a-time mode the hand-in button waits for the last question.
    $("[data-quiz-actions]").classList.toggle("is-quiet", one && quiz.at < s.items.length - 1);
    drawDots();
  }

  function drawDots() {
    const s = quiz.data;
    const dots = $("[data-quiz-dots]");
    if (!s || !s.items || s.items.length < 2 || !(s.status === "ready" || s.status === "marked")) { dots.hidden = true; return; }
    dots.hidden = false;
    dots.replaceChildren();
    const lis = $$(".pr-q", quizItems);
    let checked = 0;
    let answered = 0;
    s.items.forEach((q, i) => {
      const st = stateOf(q, lis[i]);
      if (["full", "part", "zero"].includes(st)) checked++;
      if (st) answered++;
      const b = make("button", `pr-dot ${st ? `is-${st}` : ""}${quiz.mode === "one" && i === quiz.at ? " is-at" : ""}`, String(i + 1));
      b.type = "button";
      const words = { full: "full marks", part: "some marks", zero: "no marks", skipped: "skipped", answered: "answered", "": "not answered yet" };
      b.title = `Question ${i + 1}: ${words[st]}`;
      b.setAttribute("aria-label", b.title);
      b.addEventListener("click", () => goTo(i));
      const li = make("li");
      li.appendChild(b);
      dots.appendChild(li);
    });
    $("[data-quiz-progress]").textContent = s.status === "ready" ? `${answered} of ${s.items.length} answered${checked ? ` · ${checked} checked` : ""}` : "";
  }

  function goTo(i) {
    if (quiz.mode === "one") { quiz.at = i; layout(); window.scrollTo({ top: $("[data-panel=quiz]").offsetTop - 60, behavior: "smooth" }); return; }
    quiz.filter = "all";
    layout();
    renderSummary(quiz.data);
    const li = $$(".pr-q", quizItems)[i];
    if (li) li.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $$("[data-quiz-mode]").forEach((b) => b.addEventListener("click", () => {
    quiz.mode = b.dataset.quizMode;
    try { localStorage.setItem("pr.quizMode", quiz.mode); } catch { /* storage blocked */ }
    quiz.filter = "all";
    renderSummary(quiz.data);
    layout();
  }));
  $("[data-quiz-prev]").addEventListener("click", () => goTo(quiz.at - 1));
  $("[data-quiz-next]").addEventListener("click", () => goTo(quiz.at + 1));
  // Left and right arrows move between questions in one-at-a-time mode (not while typing).
  document.addEventListener("keydown", (e) => {
    if ($("[data-panel=quiz]").hidden || quiz.mode !== "one" || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.target.closest && e.target.closest("textarea, input[type=text], input[type=search], select")) return;
    if (e.key === "ArrowRight" && quiz.data && quiz.at < quiz.data.items.length - 1) { e.preventDefault(); goTo(quiz.at + 1); }
    if (e.key === "ArrowLeft" && quiz.at > 0) { e.preventDefault(); goTo(quiz.at - 1); }
  });

  function renderSummary(s) {
    const box = $("[data-quiz-summary]");
    if (!s || s.status !== "marked" || !s.items) { box.hidden = true; return; }
    box.hidden = false;
    box.replaceChildren();
    const groups = { full: [], part: [], zero: [], skipped: [] };
    s.items.forEach((q, i) => { const st = stateOf(q); if (groups[st]) groups[st].push(i); });
    const n = s.items.length;
    const head = make("div", "pr-summary-head");
    head.append(make("span", "pr-summary-label", "Your score"), make("strong", "pr-summary-score", `${s.score} / ${s.total}`), make("span", "muted", `(${pct(s.score, s.total)}%)`));
    box.appendChild(head);
    const bar = make("div", "pr-sumbar");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `${groups.full.length} full marks, ${groups.part.length} some marks, ${groups.zero.length} no marks, ${groups.skipped.length} skipped`);
    for (const k of ["full", "part", "zero", "skipped"]) {
      if (!groups[k].length) continue;
      const seg = make("span", `is-${k}`);
      seg.style.flexGrow = String(groups[k].length);
      bar.appendChild(seg);
    }
    box.appendChild(bar);
    const filters = make("div", "pr-filters");
    const label = { all: `All (${n})`, full: `Full marks (${groups.full.length})`, part: `Some marks (${groups.part.length})`, zero: `No marks (${groups.zero.length})`, skipped: `Skipped (${groups.skipped.length})` };
    for (const k of ["all", "full", "part", "zero", "skipped"]) {
      if (k !== "all" && !groups[k].length) continue;
      const b = make("button", `pr-filter is-${k}`, label[k]);
      b.type = "button";
      b.setAttribute("aria-pressed", quiz.filter === k ? "true" : "false");
      b.addEventListener("click", () => {
        quiz.filter = k;
        if (k !== "all" && quiz.mode === "one") { quiz.mode = "all"; }
        renderSummary(s);
        layout();
      });
      filters.appendChild(b);
    }
    box.appendChild(filters);
    const lost = [...groups.part, ...groups.zero, ...groups.skipped].sort((a, b) => a - b);
    $("[data-quiz-missed]").hidden = !lost.length;
    $("[data-quiz-missed]").textContent = lost.length ? `Retake the ${plural(lost.length, "question")} I lost marks on` : "";
    $("[data-quiz-followup]").hidden = !lost.length;
    if (lost.length) {
      const d = make("div", "pr-lost small");
      d.appendChild(make("strong", "", "Where you lost marks"));
      const ul = make("ol", "");
      for (const i of lost.slice(0, 12)) {
        const q = s.items[i];
        const a = markingOf(q) || {};
        const tmp = make("div");
        tmp.innerHTML = q.html;
        const li = make("li");
        li.value = i + 1;
        const words = tmp.textContent.trim().replace(/\{\{\d+\}\}/g, "___").replace(/\s+/g, " ");
        const short = words.length > 140 ? `${words.slice(0, 140).replace(/\s+\S*$/, "")}…` : words;
        const got = a.marks ?? 0;
        const of = a.total ?? q.marks;
        const pill = make("span", `pr-mark ${got === 0 ? "is-zero" : "is-part"}`, `${got} / ${of}`);
        const link = make("button", "linklike", short);
        link.type = "button";
        link.title = "Go to this question";
        link.addEventListener("click", () => goTo(i));
        li.append(pill, link);
        ul.appendChild(li);
      }
      d.appendChild(ul);
      box.appendChild(d);
    }
  }

  $("[data-quiz-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!quiz.data || quiz.data.status !== "ready") return;
    const answers = collectAnswers();
    const empty = Object.values(answers).filter(isEmpty).length;
    if (empty && !window.confirm(`${plural(empty, "question")} ${empty === 1 ? "has" : "have"} no answer. Hand in anyway?`)) return;
    const btn = $("[data-quiz-submit]");
    btn.disabled = true;
    try {
      await api("POST", `practice/sessions/${quiz.id}/submit`, { answers });
      quiz.t0 = Date.now();
      // Keep the answers on screen, locked, while they are marked.
      $$("input, textarea, .pr-q-actions button", quizItems).forEach((i) => { i.disabled = true; });
      quiz.mode = quiz.mode === "one" ? "one" : "all";
      await refreshSession();
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (err) {
      alertBox($("[data-panel=quiz]"), err.message);
    } finally {
      btn.disabled = false;
    }
  });
  $("[data-quiz-back]").addEventListener("click", () => { window.clearTimeout(quiz.poll); quiz.id = null; show(location.hash.slice(1) && TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "questions"); });
  async function retake(ids, title) {
    try {
      const r = await api("POST", "practice/sessions", { question_ids: ids, title });
      openSession(r.id);
    } catch (e) { alertBox($("[data-panel=quiz]"), e.message); }
  }
  const baseTitle = () => quiz.data.title.replace(/ \((again|lost marks)\)$/, "");
  $("[data-quiz-again]").addEventListener("click", () => { if (quiz.data) retake(quiz.data.items.map((q) => q.id), `${baseTitle()} (again)`); });
  $("[data-quiz-missed]").addEventListener("click", () => {
    if (!quiz.data) return;
    const ids = quiz.data.items.filter((q) => ["part", "zero", "skipped"].includes(stateOf(q))).map((q) => q.id);
    if (ids.length) retake(ids, `${baseTitle()} (lost marks)`);
  });
  $("[data-quiz-followup]").addEventListener("click", async (e) => {
    if (!quiz.data) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api("POST", `practice/sessions/${quiz.id}/followup`);
      openSession(r.id);
    } catch (err) { alertBox($("[data-panel=quiz]"), err.message); } finally { btn.disabled = false; }
  });
  $("[data-quiz-coach]").addEventListener("click", () => {
    if (!quiz.data) return;
    askCoach(`I just answered "${quiz.data.title}" and got ${quiz.data.score} out of ${quiz.data.total}. What went wrong, and what should I work on?`, false);
  });

  // ---------- question hub ----------
  const hubList = $("[data-hub-list]");
  const hubForm = $("[data-hub-form]");
  let hubTimer = 0;
  const selected = new Set();
  function renderPapers() {
    const sel = $("[data-paper-filter]");
    const keep = sel.value;
    sel.replaceChildren(new Option("Any paper", ""));
    for (const p of meta.papers) sel.appendChild(new Option(p.qualification ? `${p.title} · ${p.qualification}` : p.title, String(p.id)));
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
  }

  // ---------- the question hub: a catalogue with filters on the left ----------
  const hubQ = $("[data-hub-q]");
  const hubSort = $("[data-hub-sort]");
  const hubMore = $("[data-hub-more]");
  const FACETS = { "hub-styles": "styles", "hub-topics": "topics", "hub-types": "types", "hub-marks": "marks", "hub-years": "years", "hub-spec": "spec" };
  const hubState = { shown: 0, total: 0, seq: 0 };

  /** Put each filter value's count next to it, and dim the ones that would give nothing. */
  function drawCounts(facets) {
    for (const [name, key] of Object.entries(FACETS)) {
      const counts = (facets && facets[key]) || {};
      // Topic and specification names match whatever case they were tagged with.
      const lower = {};
      for (const [k, n] of Object.entries(counts)) lower[k.toLowerCase()] = (lower[k.toLowerCase()] || 0) + n;
      $$(`[data-choices="${name}"] .pr-chip`).forEach((l) => {
        const c = l.querySelector("input");
        const n = lower[String(c.value).toLowerCase()] || 0;
        l.querySelector(".pr-n").textContent = String(n);
        l.classList.toggle("is-none", !n && !c.checked);
      });
    }
  }

  /** The filters in use, as chips to take off one at a time. */
  function drawActive() {
    const box = $("[data-hub-active]");
    box.replaceChildren();
    let n = 0;
    const chip = (text, undo) => {
      n++;
      const b = make("button", "pr-active-chip", text);
      b.type = "button";
      b.setAttribute("aria-label", `Remove the filter ${text}`);
      b.appendChild(make("span", "", "×"));
      b.addEventListener("click", () => { undo(); loadHub(); });
      box.appendChild(b);
    };
    const src = hubForm.querySelector("[name=source]");
    if (src.value !== defaultSource()) chip(src.selectedOptions[0].textContent, () => { src.value = defaultSource(); });
    const paper = $("[data-paper-filter]");
    if (paper.value) chip(paper.selectedOptions[0].textContent, () => { paper.value = ""; });
    for (const name of Object.keys(FACETS)) {
      $$(`[data-choices="${name}"] .pr-chip input:checked`).forEach((c) => {
        chip(c.parentElement.querySelector(".pr-chip-label").textContent.trim(), () => { c.checked = false; c.dispatchEvent(new Event("change")); });
      });
    }
    if (hubQ.value.trim()) chip(`“${hubQ.value.trim()}”`, () => { hubQ.value = ""; });
    if (n > 1) {
      const all = make("button", "linklike small", "Clear all");
      all.type = "button";
      all.addEventListener("click", clearHub);
      box.appendChild(all);
    }
    box.hidden = !n;
    $("[data-filter-count]").textContent = n ? `(${n})` : "";
  }

  /** Past paper questions, unless there are none yet: then everything (the questions Claude wrote). */
  const defaultSource = () => (meta && !meta.paperQuestions ? "" : "paper");
  function clearHub() {
    hubForm.querySelector("[name=source]").value = defaultSource();
    $("[data-paper-filter]").value = "";
    $$(".pr-store-filters .pr-chip input").forEach((c) => { c.checked = false; });
    $$(".pr-store-filters input.pr-find").forEach((f) => { f.value = ""; f.dispatchEvent(new Event("input")); });
    $$(".pr-store-filters .pr-all input").forEach((a) => { a.checked = false; a.indeterminate = false; });
    hubQ.value = "";
    loadHub();
  }

  function hubCard(q) {
    const li = make("li", "pr-hub-q");
    const head = make("label", "check pr-q-head");
    const c = make("input");
    c.type = "checkbox";
    c.value = String(q.id);
    c.checked = selected.has(q.id);
    c.setAttribute("aria-label", "Choose this question to practise");
    c.addEventListener("change", () => { if (c.checked) selected.add(q.id); else selected.delete(q.id); li.classList.toggle("is-picked", c.checked); updateHubBar(); });
    li.classList.toggle("is-picked", c.checked);
    head.append(c, make("strong", "", q.paper ? `${q.paper}${q.number ? ` · Q${q.number}` : ""}` : "Written by Claude"));
    head.append(make("span", "pr-tag pr-marks", plural(q.marks, "mark")));
    if (q.style) head.append(make("span", "pr-tag pr-style", q.style));
    head.append(make("span", "pr-tag", typeLabel(q.type)));
    for (const t of q.topics) head.append(make("span", "pr-tag pr-topic", t));
    for (const t of q.spec || []) head.append(make("span", "pr-tag pr-spec", t));
    li.appendChild(head);
    const links = insertLinks(q);
    if (links.length) { const line = make("p", "small muted pr-q-links", "Uses the insert given with the paper: "); line.append(...links); li.appendChild(line); }
    const body = make("div", "pr-q-text prose");
    body.innerHTML = q.html;
    if (q.type === "fill") showGaps(body);
    li.appendChild(body);
    if (q.options && q.options.length) {
      const ol = make("ol", "pr-hub-options small");
      q.options.forEach((o) => ol.appendChild(make("li", "", o)));
      li.appendChild(ol);
    }
    const foot = make("div", "pr-hub-foot");
    const d = make("details", "pr-more");
    d.appendChild(make("summary", "", "Mark scheme"));
    const sc = make("div", "prose small");
    sc.innerHTML = q.schemeHtml || "";
    if (q.correct && q.correct.length) sc.prepend(make("p", "", `Correct: ${q.correct.map((i) => q.options[i]).join("; ")}`));
    if (q.accepted && q.accepted.length) sc.prepend(make("p", "", `Accepted answers: ${q.accepted.map((b, i) => `(${i + 1}) ${b.join(" / ")}`).join(" · ")}`));
    d.appendChild(sc);
    const go = make("button", "small", "Practise this one");
    go.type = "button";
    go.addEventListener("click", async () => {
      try { const r = await api("POST", "practice/sessions", { question_ids: [q.id] }); openSession(r.id); } catch (e) { toast(e.message, "error"); }
    });
    foot.append(d, go);
    li.appendChild(foot);
    return li;
  }

  /** Fetch the hub with the filters in use: a fresh list, or (more) the next page added to it. */
  async function loadHub(more = false) {
    if (!meta) return;
    const f = new FormData(hubForm);
    const q = new URLSearchParams({
      topics: pick.hubTopics().join(","),
      types: pick.hubTypes().join(","),
      marks: pick.hubMarks().join(","),
      years: pick.hubYears().join(","),
      spec: pick.hubSpec().join("|"),
      styles: pick.hubStyles().join("|"),
      source: f.get("source") || "",
      paper: f.get("paper") || "",
      q: hubQ.value.trim(),
      sort: hubSort.value,
      offset: String(more ? hubState.shown : 0),
    });
    const seq = ++hubState.seq;
    drawActive();
    hubMore.disabled = true;
    let r;
    try { r = await api("GET", `practice/hub?${q}`); } catch (e) { $("[data-hub-count]").textContent = e.message; hubMore.disabled = false; return; }
    if (seq !== hubState.seq) return; // a newer search has started
    if (!more) {
      selected.clear();
      hubList.replaceChildren();
      hubState.shown = 0;
    }
    hubState.total = r.total;
    for (const item of r.questions) hubList.appendChild(hubCard(item));
    hubState.shown += r.questions.length;
    drawCounts(r.facets);
    updateHubBar();
    $("[data-hub-count]").textContent = r.total ? `${plural(r.total, "question")}${r.total > hubState.shown ? ` · showing ${hubState.shown}` : ""}` : "";
    if (!r.total) {
      const empty = make("li", "pr-hub-empty");
      const filtered = !$("[data-hub-active]").hidden;
      const nothing = !meta.paperQuestions && !meta.generatedQuestions;
      if (filtered && !nothing) {
        empty.append(make("strong", "", "No questions match."), make("p", "muted small", "Take off a filter, or search for something else."));
      } else {
        empty.append(make("strong", "", nothing ? "The question hub is empty." : "No questions here yet."));
        empty.append(make("p", "muted small", "Add past papers and their mark schemes and every question is filed here, or have Claude write some questions for you."));
        const act = make("div", "pr-actions");
        if (host.dataset.admin === "1") {
          const add = make("a", "button primary", "Add past papers");
          add.href = `/admin/vaults/${vault}/papers`;
          act.appendChild(add);
        } else {
          empty.appendChild(make("p", "muted small", "An admin adds past papers on the admin page."));
        }
        const write = make("button", "", "Write questions");
        write.type = "button";
        write.addEventListener("click", () => show("questions"));
        act.append(write);
        empty.appendChild(act);
      }
      if (hubState.seq === seq) hubList.appendChild(empty);
    }
    hubMore.hidden = hubState.shown >= r.total;
    hubMore.disabled = false;
    hubMore.textContent = `Show more (${r.total - hubState.shown} left)`;
  }
  function updateHubBar() {
    const b = $("[data-hub-practise]");
    b.disabled = !selected.size;
    b.textContent = selected.size ? `Practise ${plural(selected.size, "question")}` : "Practise selected";
  }
  hubForm.addEventListener("change", () => { window.clearTimeout(hubTimer); hubTimer = window.setTimeout(() => loadHub(), 250); });
  hubForm.addEventListener("submit", (e) => e.preventDefault());
  hubQ.addEventListener("input", () => { window.clearTimeout(hubTimer); hubTimer = window.setTimeout(() => loadHub(), 350); });
  hubSort.addEventListener("change", () => loadHub());
  hubMore.addEventListener("click", () => loadHub(true));
  $("[data-hub-clear]").addEventListener("click", clearHub);
  // On a phone the filters slide over the list.
  const store = $("[data-panel=hub]");
  const openFilters = (on) => {
    store.classList.toggle("show-filters", on);
    $("[data-filters-open]").setAttribute("aria-expanded", on ? "true" : "false");
    if (on) { const first = $(".pr-store-filters select"); if (first) first.focus(); } else $("[data-filters-open]").focus();
  };
  $("[data-filters-open]").addEventListener("click", () => openFilters(true));
  $$("[data-filters-close]").forEach((b) => b.addEventListener("click", () => openFilters(false)));
  store.addEventListener("keydown", (e) => { if (e.key === "Escape" && store.classList.contains("show-filters")) openFilters(false); });
  function clearFilters() {
    hubForm.querySelector("[name=source]").value = defaultSource();
    $("[data-paper-filter]").value = "";
    $$(".pr-store-filters .pr-chip input").forEach((c) => { c.checked = false; });
    hubQ.value = "";
  }
  // Refresh filters: Claude reads every past question again (with the specification and examiners' documents) and
  // sorts each by question type, specification area and topic. It is the same job as building the paper guides.
  const refreshBtn = $("[data-hub-refresh]");
  const refreshStatus = $("[data-hub-refresh-status]");
  let wasRefreshing = false;
  function drawRefresh(building, failed) {
    const canRefresh = !!(meta.qualifications || []).length;
    refreshBtn.hidden = !canRefresh;
    refreshBtn.disabled = !!building.length;
    refreshBtn.lastChild.nodeValue = building.length ? "Refreshing…" : "Refresh filters";
    if (building.length) {
      refreshStatus.hidden = false;
      refreshStatus.className = "small pr-refresh-status";
      refreshStatus.textContent = `Claude is reading every past question of ${building.join(", ")} again to sort them by question type, specification area and topic. This takes a minute or two; the filters update when it is done.`;
      wasRefreshing = true;
    } else if (failed.length) {
      refreshStatus.hidden = false;
      refreshStatus.className = "small pr-refresh-status pr-bad";
      refreshStatus.textContent = `The filters could not be refreshed: ${failed.map((f) => f.error).join(" ")}`;
    } else if (wasRefreshing) {
      wasRefreshing = false;
      refreshStatus.hidden = false;
      refreshStatus.className = "small pr-refresh-status";
      refreshStatus.textContent = "The filters are up to date.";
      setTimeout(() => { refreshStatus.hidden = true; }, 6000);
    } else {
      refreshStatus.hidden = true;
    }
  }
  /** While the paper guides are being built (the filters refreshed), check again every few seconds. */
  let buildTimer = 0;
  function drawBuilding() {
    window.clearTimeout(buildTimer);
    const building = meta.buildingProfiles || [];
    const qualName = (q) => (meta.qualifications || []).find((x) => x.toLowerCase() === String(q).toLowerCase()) || q;
    drawRefresh(building.map(qualName), meta.failedProfiles || []);
    if (building.length) buildTimer = window.setTimeout(() => loadMeta().then(() => { if (!$("[data-panel=hub]").hidden) loadHub(); }, () => {}), 5000);
  }
  refreshBtn.addEventListener("click", async () => {
    if (!window.confirm("Refresh the filters? Claude reads every past question in the hub again and sorts each by question type, specification area and topic. It takes a minute or two and uses your Claude credit.")) return;
    refreshBtn.disabled = true;
    try {
      await api("POST", "practice/profiles/rebuild", {});
      await loadMeta();
    } catch (e) {
      toast(e.message, "error");
      refreshBtn.disabled = false;
    }
  });

  $("[data-hub-all]").addEventListener("click", () => {
    const boxes = $$("input[type=checkbox]", hubList);
    const on = boxes.some((b) => !b.checked);
    boxes.forEach((b) => { b.checked = on; b.closest("li").classList.toggle("is-picked", on); if (on) selected.add(Number(b.value)); else selected.delete(Number(b.value)); });
    updateHubBar();
  });
  $("[data-hub-practise]").addEventListener("click", async () => {
    if (!selected.size) return;
    const ids = [...selected].slice(0, 50);
    try {
      const r = await api("POST", "practice/sessions", { question_ids: ids });
      openSession(r.id);
    } catch (e) { alertBox($("[data-panel=hub]"), e.message); }
  });

  // ---------- flashcards ----------
  const cardsForm = $("[data-cards-form]");
  let decksTimer = 0;
  cardsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(cardsForm);
    const btn = cardsForm.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await api("POST", "practice/decks", { topics: pick.cardTopics(), difficulty: f.get("difficulty"), count: Math.max(1, Math.min(60, parseInt(f.get("count"), 10) || 20)), focus: String(f.get("focus") || "") });
      loadDecks();
      toast("Claude is writing the cards. They appear below when ready.");
    } catch (err) { alertBox(cardsForm, err.message); } finally { btn.disabled = false; }
  });

  /** A deck as a CSV file (front, back, topic), which Anki and Quizlet can import. */
  function deckCsv(d) {
    const cell = (x) => `"${String(x || "").replace(/"/g, '""')}"`;
    return ["Front,Back,Topic", ...d.items.map((c) => [c.front, c.back, c.topic].map(cell).join(","))].join("\r\n");
  }
  async function downloadDeck(id) {
    try {
      const d = st.deck && st.deck.id === id ? st.deck : await api("GET", `practice/decks/${id}`);
      download(`${fileName(d.title)}.csv`, deckCsv(d), "text/csv");
    } catch (e) { toast(e.message, "error"); }
  }

  async function loadDecks() {
    window.clearTimeout(decksTimer);
    let r;
    try { r = await api("GET", "practice/decks"); } catch { return; }
    const box = $("[data-decks]");
    box.replaceChildren();
    if (!r.decks.length) { box.appendChild(make("p", "muted small", "No flashcards yet.")); return; }
    const ul = make("ul", "pr-decks");
    for (const d of r.decks) {
      const li = make("li", "pr-deck");
      const info = make("div");
      info.append(make("strong", "", d.title));
      const sub = d.status === "generating" ? "Claude is writing the cards…" : d.status === "failed" ? d.error || "These cards could not be made." : `${plural(d.cards, "card")} · ${d.known} known · ${when(d.createdAt)}`;
      info.append(make("div", `small ${d.status === "failed" ? "pr-bad" : "muted"}`, sub));
      if (d.status === "ready" && d.cards) {
        const bar = make("span", "pr-bar pr-deck-bar");
        const fill = make("span");
        fill.style.width = `${pct(d.known, d.cards)}%`;
        bar.appendChild(fill);
        bar.title = `${d.known} of ${d.cards} known`;
        info.append(bar);
      }
      li.appendChild(info);
      const act = make("div", "pr-actions");
      if (d.status === "ready") {
        const b = make("button", "primary", "Study");
        b.type = "button";
        b.addEventListener("click", () => study(d.id));
        const dl = make("button", "", "Download");
        dl.type = "button";
        dl.title = "Download as a CSV file (opens in Excel; imports into Anki or Quizlet)";
        dl.addEventListener("click", () => downloadDeck(d.id));
        act.append(b, dl);
      }
      if (d.status !== "generating") {
        const x = make("button", "danger", "Delete");
        x.type = "button";
        x.addEventListener("click", async () => {
          if (!window.confirm(`Delete "${d.title}"?`)) return;
          try { await api("DELETE", `practice/decks/${d.id}`); loadDecks(); } catch (e) { toast(e.message, "error"); }
        });
        act.appendChild(x);
      }
      li.appendChild(act);
      ul.appendChild(li);
    }
    box.appendChild(ul);
    if (r.decks.some((d) => d.status === "generating")) decksTimer = window.setTimeout(loadDecks, 2500);
  }

  const st = { deck: null, order: [], at: 0, back: false, saveTimer: 0, clock: 0, started: 0 };
  async function study(id) {
    let d;
    try { d = await api("GET", `practice/decks/${id}`); } catch (e) { toast(e.message, "error"); return; }
    st.deck = d;
    st.deck.progress = d.progress || {};
    st.at = 0;
    st.back = false;
    $("[data-card-only-again]").checked = false;
    reorder(false);
    $("[data-study-title]").textContent = d.title;
    closeEditor();
    show("study");
    drawCard();
    $("[data-card]").focus();
  }
  function reorder(shuffle) {
    const onlyAgain = $("[data-card-only-again]").checked;
    st.order = st.deck.items.map((_, i) => i).filter((i) => !onlyAgain || st.deck.progress[i] === "again");
    if (shuffle) for (let i = st.order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [st.order[i], st.order[j]] = [st.order[j], st.order[i]]; }
    st.at = 0;
    st.back = false;
  }
  function drawCard() {
    const face = $("[data-card-face]");
    const cardEl = $("[data-card]");
    const vals = Object.values(st.deck.progress);
    const known = vals.filter((v) => v === "known").length;
    const again = vals.filter((v) => v === "again").length;
    $("[data-study-score]").textContent = `${known} / ${st.deck.items.length} known`;
    $("[data-card-counts]").textContent = `Got it: ${known} · Again: ${again} · Not seen: ${st.deck.items.length - known - again}`;
    const has = st.order.length > 0;
    ["[data-card-edit]", "[data-card-delete]", "[data-card-explain]"].forEach((x) => { $(x).disabled = !has; });
    if (!has) {
      face.textContent = "No cards here. Untick “Only cards marked Again” to see them all.";
      cardEl.className = "pr-card";
      return;
    }
    const i = st.order[st.at];
    const c = st.deck.items[i];
    face.replaceChildren(
      make("div", "pr-card-meta muted small", `${st.at + 1} of ${st.order.length}${c.topic ? ` · ${c.topic}` : ""}${st.deck.progress[i] ? ` · ${st.deck.progress[i] === "known" ? "Got it" : "Again"}` : ""}`),
      make("div", "pr-card-text", st.back ? c.back : c.front),
    );
    cardEl.className = `pr-card${st.back ? " is-back" : ""}`;
    cardEl.setAttribute("aria-label", st.back ? "Flashcard answer: press to see the question" : "Flashcard question: press to turn over");
    $("[data-card-hint]").textContent = st.back ? "Answer · click to see the question again" : "Click or press Space to turn over";
  }
  function saveProgress() {
    window.clearTimeout(st.saveTimer);
    st.saveTimer = window.setTimeout(() => { api("PUT", `practice/decks/${st.deck.id}/progress`, { progress: st.deck.progress }).catch(() => toast("Your progress could not be saved.", "error")); }, 400);
  }
  const flip = () => { if (st.order.length) { st.back = !st.back; drawCard(); } };
  const move = (d) => { if (st.order.length) { st.at = (st.at + d + st.order.length) % st.order.length; st.back = false; drawCard(); } };
  const markCard = (v) => {
    if (!st.order.length) return;
    st.deck.progress[st.order[st.at]] = v;
    saveProgress();
    if (st.at === st.order.length - 1) {
      const known = Object.values(st.deck.progress).filter((x) => x === "known").length;
      toast(known === st.deck.items.length ? "Every card is marked Got it. Well done!" : `End of the deck: ${known} of ${st.deck.items.length} known. Tick “Only cards marked Again” to go over the rest.`);
    }
    move(1);
  };
  $("[data-card]").addEventListener("click", flip);
  $("[data-card]").addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
    else if (e.key === "ArrowRight") move(1);
    else if (e.key === "ArrowLeft") move(-1);
    else if (e.key === "1") markCard("again");
    else if (e.key === "2") markCard("known");
  });
  $("[data-card-next]").addEventListener("click", () => move(1));
  $("[data-card-prev]").addEventListener("click", () => move(-1));
  $("[data-card-again]").addEventListener("click", () => markCard("again"));
  $("[data-card-known]").addEventListener("click", () => markCard("known"));
  $("[data-card-shuffle]").addEventListener("click", () => { reorder(true); drawCard(); });
  $("[data-card-only-again]").addEventListener("change", () => { reorder(false); drawCard(); });
  $("[data-study-back]").addEventListener("click", () => show("cards"));
  $("[data-card-restart]").addEventListener("click", () => {
    if (!window.confirm("Start again? This clears Got it and Again from every card in this deck.")) return;
    st.deck.progress = {};
    saveProgress();
    $("[data-card-only-again]").checked = false;
    reorder(false);
    drawCard();
  });
  $("[data-card-download]").addEventListener("click", () => st.deck && downloadDeck(st.deck.id));
  $("[data-card-explain]").addEventListener("click", () => {
    if (!st.order.length) return;
    const c = st.deck.items[st.order[st.at]];
    askClaude(`Explain this flashcard to me in more depth, with an example, and how it could come up in an exam.\n\nFront: ${c.front}\nBack: ${c.back}`);
  });

  // A stopwatch, to time a run through the deck.
  function stopTimer() { window.clearInterval(st.clock); st.clock = 0; const b = $("[data-card-timer]"); if (b) b.setAttribute("aria-pressed", "false"); }
  $("[data-card-timer]").addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (st.clock) { stopTimer(); return; }
    st.started = Date.now();
    b.setAttribute("aria-pressed", "true");
    const tick = () => {
      const s = Math.floor((Date.now() - st.started) / 1000);
      $("[data-card-clock]").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    tick();
    st.clock = window.setInterval(tick, 1000);
  });

  // Editing, adding and deleting cards.
  const editor = $("[data-card-editor]");
  let editing = null; // index of the card being edited, or -1 for a new card
  editor.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); closeEditor(); $("[data-card]").focus(); } });
  function openEditor(i) {
    editing = i;
    const c = i >= 0 ? st.deck.items[i] : { front: "", back: "", topic: (st.order.length && st.deck.items[st.order[st.at]].topic) || "" };
    editor.front.value = c.front;
    editor.back.value = c.back;
    editor.topic.value = c.topic || "";
    editor.hidden = false;
    $("[data-card]").hidden = true;
    // No moving to another card while one is being edited.
    $(".pr-card-actions").hidden = true;
    editor.front.focus();
  }
  function closeEditor() { editor.hidden = true; editing = null; $("[data-card]").hidden = false; $(".pr-card-actions").hidden = false; }
  async function saveCards(items, progress) {
    const d = await api("PUT", `practice/decks/${st.deck.id}/cards`, { cards: items, progress });
    st.deck.items = d.items;
    st.deck.progress = d.progress || {};
  }
  $("[data-card-edit]").addEventListener("click", () => { if (st.order.length) openEditor(st.order[st.at]); });
  $("[data-card-add]").addEventListener("click", () => openEditor(-1));
  $("[data-card-editor-cancel]").addEventListener("click", () => { closeEditor(); $("[data-card]").focus(); });
  editor.addEventListener("submit", async (e) => {
    e.preventDefault();
    const card = { front: editor.front.value.trim(), back: editor.back.value.trim(), topic: editor.topic.value.trim() };
    if (!card.front || !card.back) return;
    const items = st.deck.items.slice();
    if (editing >= 0) items[editing] = card;
    else items.push(card);
    try {
      await saveCards(items, st.deck.progress);
      const wasNew = editing < 0;
      closeEditor();
      if (wasNew) { reorder(false); st.at = st.order.indexOf(st.deck.items.length - 1); if (st.at < 0) st.at = 0; }
      drawCard();
      toast(wasNew ? "Card added." : "Card saved.");
    } catch (err) { toast(err.message, "error"); }
  });
  $("[data-card-delete]").addEventListener("click", async () => {
    if (!st.order.length) return;
    const i = st.order[st.at];
    if (st.deck.items.length === 1) { toast("This is the last card. Delete the whole deck instead.", "error"); return; }
    if (!window.confirm("Delete this card?")) return;
    const items = st.deck.items.filter((_, j) => j !== i);
    // Progress is kept by card number, so the cards after the deleted one move up one.
    const progress = {};
    for (const [k, v] of Object.entries(st.deck.progress)) { const n = Number(k); if (n < i) progress[n] = v; else if (n > i) progress[n - 1] = v; }
    try {
      await saveCards(items, progress);
      const at = st.at;
      reorder(false);
      st.at = Math.min(at, Math.max(0, st.order.length - 1));
      drawCard();
      toast("Card deleted.");
    } catch (err) { toast(err.message, "error"); }
  });

  // ---------- study guides and reports ----------
  const reportForm = $("[data-report-form]");
  const reportFocus = reportForm.querySelector("[name=focus]");
  let reportKinds = [];
  let reportKind = "study_guide";
  let reportsTimer = 0;
  const rp = { data: null, poll: 0 };

  function drawKinds() {
    const box = $("[data-report-kinds]");
    box.replaceChildren();
    for (const k of reportKinds) {
      const b = make("button", "pr-kind");
      b.type = "button";
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", k.id === reportKind ? "true" : "false");
      b.append(make("strong", "", k.label), make("span", "small muted", k.about));
      b.addEventListener("click", () => { reportKind = k.id; drawKinds(); });
      box.appendChild(b);
    }
    const custom = reportKind === "custom";
    $("[data-report-focus-label]").innerHTML = "";
    $("[data-report-focus-label]").append(document.createTextNode(custom ? "What should it be? " : "Anything to add? "), make("span", "muted small", custom ? "(required)" : "(optional)"));
    reportFocus.required = custom;
    reportFocus.placeholder = custom ? "For example: a timeline of the laws on computer misuse, or a comparison table of network topologies" : "For example: keep it to one page, or write it for a 12-mark question";
  }

  async function loadReports() {
    window.clearTimeout(reportsTimer);
    let r;
    try { r = await api("GET", "practice/reports"); } catch (e) { $("[data-reports]").textContent = e.message; return; }
    if (!reportKinds.length) { reportKinds = r.kinds; drawKinds(); }
    const reports = r.reports.filter((d) => d.kind !== "mind_map");
    const box = $("[data-reports]");
    box.replaceChildren();
    box.appendChild(make("h2", "pr-h2", "Your study guides"));
    if (!reports.length) { box.appendChild(make("p", "muted small", "None yet.")); return; }
    const ul = make("ul", "pr-decks");
    for (const d of reports) {
      const li = make("li", "pr-deck");
      const info = make("div");
      info.append(make("strong", "", d.title));
      const sub = d.status === "generating" ? "Claude is writing it…" : d.status === "failed" ? d.error || "This could not be written." : `${d.kindLabel} · ${when(d.createdAt)}`;
      info.append(make("div", `small ${d.status === "failed" ? "pr-bad" : "muted"}`, sub));
      li.appendChild(info);
      const act = make("div", "pr-actions");
      if (d.status === "ready") {
        const b = make("button", "primary", "Open");
        b.type = "button";
        b.addEventListener("click", () => openReport(d.id));
        act.appendChild(b);
      }
      if (d.status !== "generating") {
        const x = make("button", "danger", "Delete");
        x.type = "button";
        x.addEventListener("click", async () => {
          if (!window.confirm(`Delete "${d.title}"? Copies saved in the vault are kept.`)) return;
          try { await api("DELETE", `practice/reports/${d.id}`); loadReports(); } catch (e) { toast(e.message, "error"); }
        });
        act.appendChild(x);
      }
      li.appendChild(act);
      ul.appendChild(li);
    }
    box.appendChild(ul);
    if (reports.some((d) => d.status === "generating")) reportsTimer = window.setTimeout(loadReports, 3000);
  }

  reportForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = reportForm.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const r = await api("POST", "practice/reports", { kind: reportKind, topics: pick.reportTopics(), focus: reportFocus.value });
      reportFocus.value = "";
      openReport(r.id);
    } catch (err) { alertBox(reportForm, err.message); } finally { btn.disabled = false; }
  });

  async function openReport(id) {
    window.clearTimeout(rp.poll);
    rp.id = id;
    rp.t0 = rp.t0 || Date.now();
    let r;
    try { r = await api("GET", `practice/reports/${id}`); } catch (e) { toast(e.message, "error"); return; }
    if (rp.id !== id) return;
    rp.data = r;
    if ($("[data-panel=report]").hidden) show("report");
    $("[data-report-title]").textContent = r.title;
    const status = $("[data-report-status]");
    const body = $("[data-report-body]");
    $$("[data-report-tools] button").forEach((b) => { b.disabled = r.status !== "ready" && !b.matches("[data-report-delete]"); });
    if (r.status === "generating") {
      status.textContent = `Claude is writing it from your notes… (${Math.round((Date.now() - rp.t0) / 1000)} s; this can take a minute or two, and you can leave this page)`;
      body.replaceChildren();
      rp.poll = window.setTimeout(() => openReport(id), 2500);
      return;
    }
    rp.t0 = 0;
    status.textContent = r.status === "failed" ? r.error || "This could not be written. Try again." : "";
    status.className = `small ${r.status === "failed" ? "pr-bad" : "muted"}`;
    body.innerHTML = r.html || "";
  }
  $("[data-report-back]").addEventListener("click", () => { window.clearTimeout(rp.poll); rp.id = null; show("guides"); });
  $("[data-report-copy]").addEventListener("click", () => rp.data && copyText(rp.data.markdown));
  $("[data-report-download]").addEventListener("click", () => rp.data && download(`${fileName(rp.data.title)}.md`, rp.data.markdown));
  $("[data-report-print]").addEventListener("click", () => window.print());
  $("[data-report-save]").addEventListener("click", async (e) => {
    if (!rp.data) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await saveNote("Study guides", rp.data.title, rp.data.markdown);
      const s = $("[data-report-status]");
      s.className = "small muted";
      s.replaceChildren(document.createTextNode(`Saved as ${r.path}. `));
      if (r.url) { const a = make("a", "", "Open the note"); a.href = r.url; s.appendChild(a); }
      toast("Saved to the vault.");
    } catch (err) { toast(err.message, "error"); } finally { btn.disabled = false; }
  });
  $("[data-report-delete]").addEventListener("click", async () => {
    if (!rp.data || !window.confirm(`Delete "${rp.data.title}"? Copies saved in the vault are kept.`)) return;
    try { await api("DELETE", `practice/reports/${rp.data.id}`); rp.id = null; show("guides"); } catch (e) { toast(e.message, "error"); }
  });
  $("[data-report-quiz]").addEventListener("click", () => {
    if (!rp.data) return;
    const topics = new Set((rp.data.settings && rp.data.settings.topics) || []);
    show("questions");
    if (topics.size) $$("[data-choices=topics] .pr-chip input").forEach((c) => { c.checked = topics.has(c.value); c.dispatchEvent(new Event("change")); });
    $("[data-gen-form] [name=focus]").value = `Test me on the content of my study guide "${rp.data.title}".`;
    $("[data-gen-submit]").focus();
    toast("The topics are chosen. Pick the question types, then write the questions.");
  });

  // Listening: the browser reads the guide aloud.
  const speech = window.speechSynthesis;
  function stopListening() {
    if (speech && (speech.speaking || speech.pending)) speech.cancel();
    const b = $("[data-report-listen]");
    if (b) { b.setAttribute("aria-pressed", "false"); b.textContent = "▶ Listen"; }
  }
  if (!speech) $("[data-report-listen]").hidden = true;
  $("[data-report-listen]").addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (!rp.data || !speech) return;
    if (speech.speaking && !speech.paused) { speech.pause(); b.textContent = "▶ Resume"; b.setAttribute("aria-pressed", "false"); return; }
    if (speech.paused) { speech.resume(); b.textContent = "❚❚ Pause"; b.setAttribute("aria-pressed", "true"); return; }
    // Read it a paragraph at a time: long texts in one go stop part-way in some browsers.
    const parts = $$("h1, h2, h3, h4, p, li, td, th", $("[data-report-body]")).map((x) => x.textContent.trim()).filter(Boolean);
    const voice = speech.getVoices().find((v) => /^en[-_]GB/i.test(v.lang)) || speech.getVoices().find((v) => /^en/i.test(v.lang));
    parts.forEach((t, i) => {
      const u = new SpeechSynthesisUtterance(t);
      if (voice) u.voice = voice;
      u.rate = 1.02;
      if (i === parts.length - 1) u.onend = () => stopListening();
      speech.speak(u);
    });
    b.textContent = "❚❚ Pause";
    b.setAttribute("aria-pressed", "true");
  });
  window.addEventListener("beforeunload", () => { if (speech) speech.cancel(); });

  // ---------- history ----------
  async function loadHistory() {
    const box = $("[data-history]");
    let r;
    try { r = await api("GET", "practice/sessions"); } catch (e) { box.textContent = e.message; return; }
    box.replaceChildren();
    $("[data-history-clear]").hidden = !r.sessions.length;
    if (!r.sessions.length) { box.appendChild(make("p", "muted small", "Nothing answered yet.")); return; }
    const wrap = make("div", "table-wrap");
    const t = make("table", "table small");
    t.innerHTML = "<thead><tr><th>When</th><th>Questions</th><th>Score</th><th></th></tr></thead>";
    const tb = make("tbody");
    const STATUS = { generating: "Being written", ready: "Not handed in", marking: "Being marked", failed: "Failed" };
    for (const s of r.sessions) {
      const tr = make("tr");
      tr.appendChild(make("td", "nowrap", when(s.createdAt)));
      tr.appendChild(make("td", "", s.title));
      tr.appendChild(make("td", "", s.status === "marked" ? `${s.score} / ${s.total} (${pct(s.score, s.total)}%)` : STATUS[s.status] || s.status));
      const act = make("td", "actions");
      const b = make("button", "", s.status === "ready" ? "Answer" : "Open");
      b.type = "button";
      b.addEventListener("click", () => openSession(s.id));
      act.appendChild(b);
      tr.appendChild(act);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    box.appendChild(wrap);
  }
  $("[data-history-clear]").addEventListener("click", async (e) => {
    if (!window.confirm("Delete every set of questions you have answered in this vault, with your answers, marks and feedback?\n\nYour history and the exam coach's results start again from nothing. The questions, flashcards, study guides and mind maps are kept. This cannot be undone.")) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api("POST", "practice/history/clear", {});
      toast(`Cleared ${plural(r.sessions, "set")} of questions (${plural(r.answers, "answer")}).`);
      quiz.id = null;
      quiz.data = null;
      await loadHistory();
    } catch (err) { toast(err.message, "error"); } finally { btn.disabled = false; }
  });

  // ---------- conversations: the exam coach and Ask Claude ----------
  /**
   * A chat in one panel ([data-chat], [data-chat-form], [data-chat-suggest], [data-chat-clear] inside it), talking to
   * practice/<path>. extra() adds to each message sent; onView(reply) draws anything else the reply carries.
   */
  function chatBox(panel, { path, suggest, empty, thinking, noteName, extra = () => ({}), onView = () => {}, clearText }) {
    const log = $("[data-chat]", panel);
    const form = $("[data-chat-form]", panel);
    const ta = form.querySelector("textarea");
    let loading = Promise.resolve();
    let busy = false;
    function message(m) {
      const d = make("div", `pr-msg ${m.role === "user" ? "is-user" : "is-coach"}`);
      if (m.role === "user") { d.textContent = m.text; return d; }
      const body = make("div", "prose");
      body.innerHTML = m.html;
      d.appendChild(body);
      const act = make("div", "pr-msg-actions");
      const copy = make("button", "linklike small", "Copy");
      copy.type = "button";
      copy.addEventListener("click", () => copyText(m.text));
      const save = make("button", "linklike small", "Save as a note");
      save.type = "button";
      save.addEventListener("click", async () => {
        save.disabled = true;
        try {
          const day = new Date((m.at || Date.now() / 1000) * 1000).toISOString().slice(0, 10);
          const r = await saveNote("Study guides", `${noteName} ${day}`, `${m.text}\n`);
          toast(`Saved as ${r.path}.`);
        } catch (e) { toast(e.message, "error"); } finally { save.disabled = false; }
      });
      act.append(copy, save);
      d.appendChild(act);
      return d;
    }
    function draw(r) {
      onView(r);
      log.replaceChildren();
      if (!r.messages.length) log.appendChild(make("p", "muted small", empty));
      for (const m of r.messages) log.appendChild(message(m));
      log.scrollTop = log.scrollHeight;
      const box = $("[data-chat-suggest]", panel);
      box.replaceChildren();
      for (const t of suggest) {
        const b = make("button", "pr-suggestion small", t);
        b.type = "button";
        b.addEventListener("click", () => { ta.value = t; form.requestSubmit(); });
        box.appendChild(b);
      }
    }
    function load() {
      loading = api("GET", `practice/${path}`).then(draw, (e) => { log.textContent = e.message; });
      return loading;
    }
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text || busy) return;
      busy = true;
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      $$("[data-chat-suggest] button", panel).forEach((b) => { b.disabled = true; });
      const none = log.querySelector(":scope > p.muted");
      if (none) none.remove();
      log.appendChild(Object.assign(make("div", "pr-msg is-user"), { textContent: text }));
      const wait = make("div", "pr-msg is-coach muted pr-typing", thinking);
      log.appendChild(wait);
      log.scrollTop = log.scrollHeight;
      ta.value = "";
      try {
        draw(await api("POST", `practice/${path}`, { message: text, ...extra() }));
      } catch (err) {
        wait.textContent = err.message;
        wait.classList.remove("pr-typing");
        wait.classList.add("pr-bad");
        ta.value = text;
      } finally {
        busy = false;
        btn.disabled = false;
        $$("[data-chat-suggest] button", panel).forEach((b) => { b.disabled = false; });
      }
    });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    $("[data-chat-clear]", panel).addEventListener("click", async () => {
      if (!window.confirm(clearText)) return;
      try { draw(await api("POST", `practice/${path}/clear`)); } catch (e) { alertBox(form, e.message); }
    });
    /** Put a message in the box: sent straight away, or (send false) left there to edit first. */
    async function ask(text, send) {
      await loading;
      ta.value = text;
      if (send) form.requestSubmit();
      else { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      form.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    return { load, ask };
  }

  function drawStats(s) {
    const stats = $("[data-stats]");
    stats.replaceChildren();
    if (!s.answers) {
      stats.appendChild(make("p", "muted small", "No marked answers yet. Answer some questions and the coach will have more to go on."));
      return;
    }
    stats.appendChild(make("p", "", `${plural(s.answers, "answer")} marked · ${s.got} / ${s.of} marks (${s.percent}%)`));
    const grid = make("div", "pr-stat-grid");
    const table = (title, rows) => {
      if (!rows.length) return;
      const d = make("div", "pr-stat");
      d.appendChild(make("strong", "small", title));
      const ul = make("ul", "small");
      rows.slice(0, 6).forEach((x) => {
        const li = make("li", "");
        const bar = make("span", "pr-bar");
        const fill = make("span", x.percent < 50 ? "is-low" : x.percent < 70 ? "is-mid" : "");
        fill.style.width = `${Math.max(2, x.percent)}%`;
        bar.appendChild(fill);
        li.append(make("span", "pr-stat-name", x.name), bar, make("span", "pr-stat-pct", `${Math.round(x.percent)}%`));
        li.title = `${x.name}: ${x.got} / ${x.of} marks over ${plural(x.answers, "answer")}`;
        ul.appendChild(li);
      });
      d.appendChild(ul);
      grid.appendChild(d);
    };
    table("Weakest topics", s.topics);
    table("Specification areas", s.specAreas || []);
    table("Question types", s.types);
    table("Mark levels", s.markLevels);
    stats.appendChild(grid);
  }

  const coachChat = chatBox($("[data-panel=coach]"), {
    path: "coach",
    suggest: [
      "Where am I losing the most marks?",
      "What should I revise this week?",
      "How do I write a good answer to a 9-mark question?",
      "Which topics am I strongest in?",
      "Quiz me with three quick questions on my weakest topic.",
    ],
    empty: "Ask the coach how you are doing, or what to revise next.",
    thinking: "The coach is thinking",
    noteName: "Exam coach",
    onView: (r) => drawStats(r.stats),
    clearText: "Clear this conversation? Your answers and marks are kept.",
  });
  /** Open the coach with a message: sent straight away, or (send false) left in the box to edit first. */
  function askCoach(text, send = true) {
    show("coach");
    return coachChat.ask(text, send);
  }

  const askChat = chatBox($("[data-panel=ask]"), {
    path: "chat",
    suggest: [
      "Summarise the main ideas of my notes.",
      "Explain the hardest idea in my notes simply, with an example.",
      "What are the key terms I need to know, with definitions?",
      "Test me: ask me one exam-style question and mark my answer.",
      "Which ideas in my notes are most likely to come up in the exam?",
    ],
    empty: "Ask Claude anything about your notes. Claude answers from them and links the notes it used.",
    thinking: "Claude is reading your notes",
    noteName: "Ask Claude",
    extra: () => ({ topics: pick.askTopics ? pick.askTopics() : [] }),
    clearText: "Start a new chat? This conversation is deleted; notes you saved from it are kept.",
  });
  /** Ask Claude about something (an answer, a card, an idea on a mind map): opens the chat and sends it. */
  function askClaude(text, send = true) {
    show("ask");
    return askChat.ask(text, send);
  }
  /** Which notes Ask Claude reads, in its summary line. */
  function askScope() {
    const n = pick.askTopics ? pick.askTopics().length : 0;
    $("[data-ask-scope]").textContent = n ? `(${plural(n, "topic")})` : "(all of your notes)";
  }
  $("[data-choices=ask-topics]").addEventListener("change", askScope);

  // ---------- mind maps ----------
  // Claude writes a mind map as a nested Markdown list (kept with the study guides, kind "mind_map"); it is drawn
  // here as a tree growing to the right, whose branches open and close.
  const mapForm = $("[data-map-form]");
  let mapsTimer = 0;
  const mm = { data: null, tree: null, poll: 0, t0: 0, scale: 1, id: null };

  async function loadMaps() {
    window.clearTimeout(mapsTimer);
    const box = $("[data-maps]");
    let r;
    try { r = await api("GET", "practice/reports"); } catch (e) { box.textContent = e.message; return; }
    const maps = r.reports.filter((d) => d.kind === "mind_map");
    box.replaceChildren();
    box.appendChild(make("h2", "pr-h2", "Your mind maps"));
    if (!maps.length) { box.appendChild(make("p", "muted small", "None yet.")); return; }
    const ul = make("ul", "pr-decks");
    for (const d of maps) {
      const li = make("li", "pr-deck");
      const info = make("div");
      info.append(make("strong", "", d.title));
      const sub = d.status === "generating" ? "Claude is mapping your notes…" : d.status === "failed" ? d.error || "This could not be made." : when(d.createdAt);
      info.append(make("div", `small ${d.status === "failed" ? "pr-bad" : "muted"}`, sub));
      li.appendChild(info);
      const act = make("div", "pr-actions");
      if (d.status === "ready") {
        const b = make("button", "primary", "Open");
        b.type = "button";
        b.addEventListener("click", () => openMap(d.id));
        act.appendChild(b);
      }
      if (d.status !== "generating") {
        const x = make("button", "danger", "Delete");
        x.type = "button";
        x.addEventListener("click", async () => {
          if (!window.confirm(`Delete the mind map "${d.title}"? Copies saved in the vault are kept.`)) return;
          try { await api("DELETE", `practice/reports/${d.id}`); loadMaps(); } catch (e) { toast(e.message, "error"); }
        });
        act.appendChild(x);
      }
      li.appendChild(act);
      ul.appendChild(li);
    }
    box.appendChild(ul);
    if (maps.some((d) => d.status === "generating")) mapsTimer = window.setTimeout(loadMaps, 3000);
  }

  mapForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = mapForm.querySelector("button[type=submit]");
    const focus = mapForm.querySelector("[name=focus]");
    btn.disabled = true;
    try {
      const r = await api("POST", "practice/reports", { kind: "mind_map", topics: pick.mapTopics(), focus: focus.value });
      focus.value = "";
      openMap(r.id);
    } catch (err) { alertBox(mapForm, err.message); } finally { btn.disabled = false; }
  });

  /** The tree of a mind map's Markdown: the level-1 heading is the centre, the nested list its branches. */
  function parseMap(md, fallback) {
    const root = { label: fallback || "Mind map", children: [], depth: 0 };
    const stack = [{ indent: -1, node: root }];
    for (const raw of String(md || "").split(/\r?\n/)) {
      const h = raw.match(/^#\s+(.+)/);
      if (h) { root.label = h[1].trim(); continue; }
      const m = raw.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/);
      if (!m) continue;
      const indent = m[1].replace(/\t/g, "  ").length;
      const label = m[2].replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a).replace(/[*_`]/g, "").trim();
      if (!label) continue;
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      const parent = stack[stack.length - 1].node;
      const node = { label, children: [], depth: parent.depth + 1 };
      parent.children.push(node);
      stack.push({ indent, node });
    }
    const walk = (n, parent) => { n.parent = parent; n.open = n.depth < 1; n.children.forEach((c) => walk(c, n)); };
    walk(root, null);
    // The branches each get a colour; their ideas share it.
    root.children.forEach((c, i) => { const paint = (n) => { n.hue = i; n.children.forEach(paint); }; paint(c); });
    return root;
  }

  async function openMap(id) {
    window.clearTimeout(mm.poll);
    if (mm.id !== id) { mm.t0 = Date.now(); mm.scale = 1; }
    mm.id = id;
    let r;
    try { r = await api("GET", `practice/reports/${id}`); } catch (e) { toast(e.message, "error"); return; }
    if (mm.id !== id) return;
    mm.data = r;
    if ($("[data-panel=mindmap]").hidden) show("mindmap");
    $("[data-map-title]").textContent = r.title;
    const status = $("[data-map-status]");
    $$("[data-map-tools] button").forEach((b) => { b.disabled = r.status !== "ready" && !b.matches("[data-map-delete]"); });
    const canvas = $("[data-map-canvas]");
    if (r.status === "generating") {
      status.className = "small muted";
      status.textContent = `Claude is mapping your notes… (${Math.round((Date.now() - mm.t0) / 1000)} s; this can take a minute, and you can leave this page)`;
      canvas.replaceChildren();
      mm.poll = window.setTimeout(() => openMap(id), 2500);
      return;
    }
    status.className = `small ${r.status === "failed" ? "pr-bad" : "muted"}`;
    status.textContent = r.status === "failed" ? r.error || "This could not be made. Try again." : "";
    if (r.status !== "ready") { canvas.replaceChildren(); return; }
    mm.tree = parseMap(r.markdown, r.title);
    if (!mm.tree.children.length) { status.textContent = "This mind map is empty. Delete it and try again."; canvas.replaceChildren(); return; }
    drawMap();
    fitMap();
  }

  const SVG = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v)); return e; };
  const BRANCH_HUES = [212, 152, 32, 280, 350, 190, 95, 260, 15, 320];
  /** Split a label into lines of about 26 characters. */
  function wrapLabel(text) {
    const lines = [];
    let line = "";
    for (const w of text.split(/\s+/)) {
      if (line && (line + " " + w).length > 26) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
    }
    if (line) lines.push(line);
    return lines.slice(0, 4);
  }
  let measureCtx = null;
  function textWidth(t, bold) {
    measureCtx = measureCtx || document.createElement("canvas").getContext("2d");
    measureCtx.font = `${bold ? "600 " : ""}14px ${getComputedStyle(document.body).fontFamily}`;
    return measureCtx.measureText(t).width;
  }

  /** Lay out the open part of the tree (left to right) and draw it as SVG. */
  function drawMap() {
    const canvas = $("[data-map-canvas]");
    const css = getComputedStyle(document.body);
    const ink = css.color || "#222";
    const dark = (() => { const m = (css.backgroundColor || "").match(/\d+/g); return m ? (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 < 128 : false; })();
    const LINE = 18, PAD_X = 12, PAD_Y = 8, GAP_Y = 10, GAP_X = 56, TOGGLE = 22;
    // Size every visible node.
    const visible = [];
    const size = (n) => {
      n.lines = wrapLabel(n.label);
      const bold = n.depth === 0;
      n.w = Math.ceil(Math.max(...n.lines.map((l) => textWidth(l, bold)))) + PAD_X * 2 + (n.children.length ? TOGGLE : 0);
      n.h = n.lines.length * LINE + PAD_Y * 2;
      visible.push(n);
      if (n.open) n.children.forEach(size);
    };
    size(mm.tree);
    const colW = [];
    for (const n of visible) colW[n.depth] = Math.max(colW[n.depth] || 0, n.w);
    const colX = [0];
    for (let d = 1; d < colW.length; d++) colX[d] = colX[d - 1] + colW[d - 1] + GAP_X;
    // Leaves take the next free row; a parent sits in the middle of its children.
    let y = 0;
    const place = (n) => {
      n.x = colX[n.depth];
      if (n.open && n.children.length) {
        n.children.forEach(place);
        const first = n.children[0], last = n.children[n.children.length - 1];
        const mid = (first.y + first.h / 2 + last.y + last.h / 2) / 2;
        n.y = mid - n.h / 2;
        // A tall parent must not overlap the row below its children.
        if (n.y + n.h + GAP_Y > y) y = n.y + n.h + GAP_Y;
        if (n.y < 0) { const shift = -n.y; const move = (c) => { c.y += shift; if (c.open) c.children.forEach(move); }; move(n); y += shift; }
      } else {
        n.y = y;
        y += n.h + GAP_Y;
      }
    };
    place(mm.tree);
    const width = colX[colX.length - 1] + colW[colW.length - 1] + 8;
    const height = Math.max(y - GAP_Y, mm.tree.h) + 8;
    const svg = svgEl("svg", { xmlns: SVG, viewBox: `-4 -4 ${width + 4} ${height + 4}`, role: "img", "aria-label": `Mind map: ${mm.tree.label}` });
    svg.style.fontFamily = css.fontFamily;
    mm.size = { width: width + 4, height: height + 4 };
    const colour = (n, kind) => {
      if (n.depth === 0) return kind === "fill" ? (dark ? "#3b3f58" : "#e6e8f7") : kind === "stroke" ? (dark ? "#8f96d6" : "#5b63b7") : ink;
      const h = BRANCH_HUES[n.hue % BRANCH_HUES.length];
      if (kind === "fill") return dark ? `hsl(${h} 30% ${n.depth === 1 ? 30 : 22}%)` : `hsl(${h} 70% ${n.depth === 1 ? 88 : 95}%)`;
      if (kind === "stroke") return dark ? `hsl(${h} 55% 62%)` : `hsl(${h} 50% 45%)`;
      return ink;
    };
    const edges = svgEl("g", { fill: "none", "stroke-width": 1.6 });
    const nodes = svgEl("g");
    svg.append(edges, nodes);
    for (const n of visible) {
      if (n.parent) {
        const x1 = n.parent.x + n.parent.w, y1 = n.parent.y + n.parent.h / 2, x2 = n.x, y2 = n.y + n.h / 2, mx = (x1 + x2) / 2;
        edges.appendChild(svgEl("path", { d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, stroke: colour(n, "stroke"), opacity: 0.7 }));
      }
      const g = svgEl("g", { class: "pr-map-node", transform: `translate(${n.x},${n.y})` });
      const box = svgEl("g", { class: "pr-map-label", tabindex: 0, role: "button", "aria-label": `${n.label}: ask Claude about this` });
      box.appendChild(svgEl("rect", { width: n.w, height: n.h, rx: 8, fill: colour(n, "fill"), stroke: colour(n, "stroke"), "stroke-width": n.depth < 2 ? 1.5 : 1 }));
      n.lines.forEach((l, i) => {
        const t = svgEl("text", { x: PAD_X, y: PAD_Y + LINE * i + 14, fill: colour(n, "text"), "font-size": 14, "font-weight": n.depth === 0 ? 600 : 400 });
        t.textContent = l;
        box.appendChild(t);
      });
      const title = svgEl("title");
      title.textContent = `${n.label}\nClick to ask Claude about this`;
      box.appendChild(title);
      const askAbout = () => {
        const path = [];
        for (let p = n.parent; p; p = p.parent) path.unshift(p.label);
        askClaude(n.depth === 0 ? `Give me an overview of "${n.label}" from my notes.` : `Explain "${n.label}" from my notes${path.length ? `, in the context of ${path.map((x) => `"${x}"`).join(" → ")}` : ""}.`);
      };
      box.addEventListener("click", (e) => { if (!mm.dragged) askAbout(); e.stopPropagation(); });
      box.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); askAbout(); } });
      g.appendChild(box);
      if (n.children.length) {
        const tg = svgEl("g", { class: "pr-map-toggle", tabindex: 0, role: "button", "aria-expanded": n.open ? "true" : "false", "aria-label": `${n.open ? "Close" : "Open"} ${n.label} (${plural(n.children.length, "idea")})`, transform: `translate(${n.w - TOGGLE + 2},${n.h / 2})` });
        tg.appendChild(svgEl("circle", { cx: 8, cy: 0, r: 9, fill: colour(n, "stroke") }));
        const arrow = svgEl("text", { x: 8, y: 4.5, "text-anchor": "middle", "font-size": 12, fill: dark ? "#111" : "#fff", "font-weight": 700 });
        arrow.textContent = n.open ? "‹" : "›";
        tg.appendChild(arrow);
        const t2 = svgEl("title");
        t2.textContent = n.open ? "Close this branch" : `Open this branch (${plural(n.children.length, "idea")})`;
        tg.appendChild(t2);
        const toggle = () => { n.open = !n.open; drawMap(); const again = $(`[data-map-canvas] .pr-map-toggle[aria-label^="${n.open ? "Close" : "Open"} ${CSS.escape(n.label)}"]`); if (again) again.focus(); };
        tg.addEventListener("click", (e) => { if (!mm.dragged) toggle(); e.stopPropagation(); });
        tg.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
        g.appendChild(tg);
      }
      nodes.appendChild(g);
    }
    canvas.replaceChildren(svg);
    applyScale();
  }
  function applyScale() {
    const svg = $("[data-map-canvas] svg");
    if (!svg || !mm.size) return;
    svg.setAttribute("width", String(Math.round(mm.size.width * mm.scale)));
    svg.setAttribute("height", String(Math.round(mm.size.height * mm.scale)));
  }
  function fitMap() {
    const canvas = $("[data-map-canvas]");
    if (!mm.size) return;
    const fit = Math.min((canvas.clientWidth - 16) / mm.size.width, (Math.max(320, window.innerHeight * 0.7) - 16) / mm.size.height);
    // Never so small the words cannot be read: a big map scrolls instead, starting at its centre idea.
    mm.scale = Math.max(0.6, Math.min(1.2, fit || 1));
    applyScale();
    const root = mm.tree;
    canvas.scrollLeft = 0;
    canvas.scrollTop = Math.max(0, (root.y + root.h / 2) * mm.scale - canvas.clientHeight / 2);
  }
  /** Open or close every branch. */
  function setOpen(open) {
    if (!mm.tree) return;
    const walk = (n) => { n.open = open || n.depth === 0; n.children.forEach(walk); };
    walk(mm.tree);
    drawMap();
    fitMap();
  }
  $("[data-map-expand]").addEventListener("click", () => setOpen(true));
  $("[data-map-collapse]").addEventListener("click", () => setOpen(false));
  $$("[data-map-zoom]").forEach((b) => b.addEventListener("click", () => {
    const z = Number(b.dataset.mapZoom);
    if (!z) fitMap();
    else { mm.scale = Math.max(0.25, Math.min(3, mm.scale * (z > 0 ? 1.25 : 0.8))); applyScale(); }
  }));
  // Drag to move around a map larger than the box.
  (() => {
    const canvas = $("[data-map-canvas]");
    let start = null;
    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY, left: canvas.scrollLeft, top: canvas.scrollTop };
      mm.dragged = false;
    });
    canvas.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!mm.dragged && Math.hypot(dx, dy) < 5) return;
      if (!mm.dragged) { mm.dragged = true; canvas.setPointerCapture(e.pointerId); canvas.classList.add("is-dragging"); }
      canvas.scrollLeft = start.left - dx;
      canvas.scrollTop = start.top - dy;
    });
    const end = () => { start = null; canvas.classList.remove("is-dragging"); window.setTimeout(() => { mm.dragged = false; }, 0); };
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
  })();
  $("[data-map-back]").addEventListener("click", () => { window.clearTimeout(mm.poll); mm.id = null; show("mindmaps"); });
  $("[data-map-save]").addEventListener("click", async (e) => {
    if (!mm.data) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await saveNote("Mind maps", mm.data.title, mm.data.markdown);
      const s = $("[data-map-status]");
      s.className = "small muted";
      s.replaceChildren(document.createTextNode(`Saved as ${r.path}. `));
      if (r.url) { const a = make("a", "", "Open the note"); a.href = r.url; s.appendChild(a); }
      toast("Saved to the vault.");
    } catch (err) { toast(err.message, "error"); } finally { btn.disabled = false; }
  });
  $("[data-map-download]").addEventListener("click", () => {
    const svg = $("[data-map-canvas] svg");
    if (!svg || !mm.data) return;
    const copy = svg.cloneNode(true);
    copy.setAttribute("width", String(mm.size.width * 2));
    copy.setAttribute("height", String(mm.size.height * 2));
    const bg = svgEl("rect", { x: -4, y: -4, width: mm.size.width, height: mm.size.height, fill: getComputedStyle(document.body).backgroundColor || "#fff" });
    copy.insertBefore(bg, copy.firstChild);
    const text = new XMLSerializer().serializeToString(copy);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = mm.size.width * 2;
      c.height = mm.size.height * 2;
      c.getContext("2d").drawImage(img, 0, 0);
      c.toBlob((blob) => {
        if (!blob) { download(`${fileName(mm.data.title)}.svg`, text, "image/svg+xml"); return; }
        const url = URL.createObjectURL(blob);
        const a = make("a");
        a.href = url;
        a.download = `${fileName(mm.data.title)}.png`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, "image/png");
    };
    img.onerror = () => download(`${fileName(mm.data.title)}.svg`, text, "image/svg+xml");
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  });
  $("[data-map-delete]").addEventListener("click", async () => {
    if (!mm.data || !window.confirm(`Delete the mind map "${mm.data.title}"? Copies saved in the vault are kept.`)) return;
    try { await api("DELETE", `practice/reports/${mm.data.id}`); mm.id = null; show("mindmaps"); } catch (e) { toast(e.message, "error"); }
  });
  window.addEventListener("resize", () => { if (!$("[data-panel=mindmap]").hidden && mm.tree) applyScale(); });

  // ---------- links into a tab with filters set (from the admin page's past papers) ----------
  // #hub?years=2024, #hub?spec=1.2 Networks&source=, #hub?paper=12, #questions?paper=3 (a paper guide's id).
  function openFromHash() {
    const [tab, query] = location.hash.slice(1).split("?");
    if (!TABS.includes(tab)) { show("questions"); return; }
    const p = new URLSearchParams(query || "");
    if (tab === "hub" && query) {
      clearFilters();
      const tick = (name, value) => $$(`[data-choices=${name}] .pr-chip input`).forEach((c) => { c.checked = c.value === value; c.dispatchEvent(new Event("change")); });
      if (p.has("years")) tick("hub-years", p.get("years"));
      if (p.has("spec")) tick("hub-spec", p.get("spec"));
      if (p.has("paper")) { const sel = $("[data-paper-filter]"); if ([...sel.options].some((o) => o.value === p.get("paper"))) sel.value = p.get("paper"); }
      if (p.has("source")) hubForm.querySelector("[name=source]").value = p.get("source");
    }
    if (tab === "questions" && p.has("paper")) {
      const sel = $("[data-gen-paper]");
      if ([...sel.options].some((o) => o.value === p.get("paper"))) { sel.value = p.get("paper"); genPaperChanged(); }
    }
    show(tab);
  }

  // ---------- start ----------
  loadMeta()
    .then(openFromHash)
    .catch((e) => alertBox(host, `The page could not load: ${e.message}`));
})();
