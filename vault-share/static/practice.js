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

  /**
   * An error shown at the top of a form or panel. It stays until it is dismissed or the same place shows another,
   * so a student who looked away still sees why something did not work.
   */
  function alertBox(where, text, kind = "error") {
    where.querySelectorAll(":scope > .alert.is-dismissable").forEach((x) => x.remove());
    const p = make("div", `alert ${kind} is-dismissable`);
    p.setAttribute("role", kind === "error" ? "alert" : "status");
    const x = make("button", "alert-close");
    x.type = "button";
    x.setAttribute("aria-label", "Dismiss");
    x.textContent = "×";
    x.addEventListener("click", () => p.remove());
    p.append(make("span", "", text), x);
    where.prepend(p);
    p.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  /** A short message at the bottom of the screen that goes away by itself (the site's toasts, app.js). */
  const toast = (text, kind = "ok", opts) => window.UI.toast(text, kind, opts);
  /** The site's confirm dialog (app.js): resolves true or false. */
  const ask = (opts) => window.UI.confirm(opts);

  /** Grey placeholder rows while a list loads. */
  function skeleton(where, rows = 3, { tall = false, grid = false } = {}) {
    const ul = make("ul", `skel-list${grid ? " is-grid" : ""}`);
    ul.setAttribute("aria-hidden", "true");
    for (let i = 0; i < rows; i++) {
      const li = make("li", `skel-row${tall ? " is-tall" : ""}`);
      li.append(make("span", "skel is-title"), make("span", "skel is-line"));
      if (tall) li.append(make("span", "skel is-line"), make("span", "skel is-short"));
      ul.appendChild(li);
    }
    where.appendChild(ul);
    where.setAttribute("aria-busy", "true");
    return ul;
  }
  const doneLoading = (where) => where.removeAttribute("aria-busy");

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
  const TABS = ["today", "questions", "hub", "cards", "guides", "mindmaps", "retrieval", "ask", "history", "coach"];
  // Views opened from a tab keep that tab highlighted.
  const PARENT = { quiz: null, study: "cards", report: "guides", mindmap: "mindmaps" };
  /** The tab named in the address (#hub, or #hub?years=2024 from a link with filters set). */
  const hashTab = () => location.hash.slice(1).split("?")[0];
  function show(name) {
    if (name !== "report") stopListening();
    if (name !== "study") stopTimer();
    if (name !== "quiz") { clearResource(); leaveQuiz(); }
    // A quiz and a deck being studied fill the page: the sections step aside (Back returns to them).
    host.classList.toggle("is-focus", name === "quiz" || name === "study");
    $$("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
    const tab = TABS.includes(name) ? name : name === "quiz" ? quiz.from : PARENT[name] !== undefined ? PARENT[name] || hashTab() : "";
    $$("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === tab ? "true" : "false"));
    syncTabStops();
    if (TABS.includes(name) && location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
    if (name === "history") loadHistory();
    if (name === "cards") loadDecks();
    if (name === "coach") coachChat.load();
    if (name === "ask") askChat.load();
    if (name === "guides") loadReports();
    if (name === "mindmaps") loadMaps();
    if (name === "hub") loadHub();
    if (name === "retrieval") loadRetrieval();
    if (name === "today") loadToday();
    // On a narrow screen the sections are one scrolling strip: keep the chosen one in view.
    const sel = $(`[data-tab="${tab}"]`);
    if (sel && sel.scrollIntoView && getComputedStyle($(".pr-nav")).overflowX === "auto") sel.scrollIntoView({ block: "nearest", inline: "center" });
    window.scrollTo({ top: 0 });
  }
  $$("[data-tab]").forEach((b) => {
    const panel = $(`[data-panel="${b.dataset.tab}"]`);
    b.id = `pr-tab-${b.dataset.tab}`;
    if (!panel) return;
    panel.id = panel.id || `pr-panel-${b.dataset.tab}`;
    b.setAttribute("aria-controls", panel.id);
    if (!panel.hasAttribute("aria-labelledby")) panel.setAttribute("aria-labelledby", b.id);
  });
  // Only the chosen tab is in the Tab order; arrow keys move between them.
  const syncTabStops = () => $$("[data-tab]").forEach((b) => { b.tabIndex = b.getAttribute("aria-selected") === "true" ? 0 : -1; });
  /** Something a screen reader should hear once (a stage of a long job), without moving focus. */
  const liveNote = make("p", "sr-only");
  liveNote.setAttribute("aria-live", "polite");
  host.appendChild(liveNote);
  const announce = (text) => { liveNote.textContent = ""; window.setTimeout(() => { liveNote.textContent = text; }, 50); };
  // Arrow keys move between the tabs (the tab pattern): up and down in the sidebar, left and right in the strip.
  $("[role=tablist]").addEventListener("keydown", (e) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) return;
    const tabs = $$("[data-tab]");
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const fwd = e.key === "ArrowRight" || e.key === "ArrowDown";
    const next = e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (i + (fwd ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    show(tabs[next].dataset.tab);
  });
  // Back and forward move between sections and in and out of a quiz (#quiz/<id>).
  window.addEventListener("hashchange", () => { if (TABS.includes(hashTab()) || hashTab().startsWith("quiz/")) openFromHash(); });
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  // Shortcuts to a section (on Today): data-goto names it; data-goto-new also opens its "New …" sheet.
  host.addEventListener("click", (e) => {
    const b = e.target.closest("[data-goto]");
    if (!b) return;
    show(b.dataset.goto);
    if (b.hasAttribute("data-goto-new")) openSheet(b.dataset.goto);
  });

  /** A form that needs at least one topic ticked says so before asking the server. */
  function hasTopics(form, picked) {
    if (!meta || !meta.topics.length || picked.length) return true;
    alertBox(form, "Choose at least one topic. The suggestions above pick the ones you most need to work on.");
    return false;
  }

  // ---------- side sheets: the "New deck / guide / mind map" forms ----------
  function openSheet(name) {
    const d = $(`[data-sheet="${name}"]`);
    if (!d || d.open) return;
    d.classList.remove("is-closing");
    d.showModal();
    // The choice lists fold to the width they have, which they only have once shown.
    $$(".pr-choice-list", d).forEach((l) => l.refold && l.refold());
    ensureGrades();
    const first = d.querySelector(".pr-chip input, textarea, select, input");
    if (first) first.focus({ preventScroll: true });
  }
  function closeSheet(d) {
    if (!d || !d.open) return;
    d.classList.add("is-closing");
    const done = () => { d.close(); d.classList.remove("is-closing"); };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) done(); else setTimeout(done, 180);
  }
  $$("[data-sheet-open]").forEach((b) => b.addEventListener("click", () => openSheet(b.dataset.sheetOpen)));
  $$("[data-sheet]").forEach((d) => {
    $$("[data-sheet-close]", d).forEach((b) => b.addEventListener("click", () => closeSheet(d)));
    d.addEventListener("cancel", (e) => { e.preventDefault(); closeSheet(d); });
    // A click on the dimmed page beside the sheet closes it (a click on the sheet's own padding does not).
    d.addEventListener("click", (e) => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeSheet(d);
    });
  });
  const sheetOf = (el) => el.closest("[data-sheet]");

  // ---------- choice groups with "Select all" ----------
  // values: [{value, label}]. Returns a function giving the ticked values.
  const FOLD = 12;
  // The coach's grade for each topic (lower-case name → "red", "amber" or "green"), once known: the topic pickers
  // offer the ones to work on. Fetched once, when a picker that offers them is first opened.
  let topicGrades = null;
  let gradesLoading = null;
  const suggestDrawers = {};
  function setGrades(topics) {
    topicGrades = {};
    for (const t of topics || []) if (t.grade) topicGrades[String(t.topic).toLowerCase()] = t.grade;
    Object.values(suggestDrawers).forEach((f) => f());
  }
  function ensureGrades() {
    if (topicGrades || gradesLoading) return;
    gradesLoading = api("GET", "practice/coach").then((r) => setGrades(r.topics), () => {}).finally(() => { gradesLoading = null; });
  }

  function choices(name, values, { checked = true, anyHint = "", suggest = false } = {}) {
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
    // Short labels ("2 marks", "2024") get narrower columns than topic names.
    if (values.every((v) => String(v.label).length <= 12)) list.classList.add("is-short");
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
        // A search looks through all of them, so the "Show all" fold is set aside while there is one.
        list.classList.toggle("is-searching", !!q);
        refold();
      });
      // Enter in the search box must not submit the form.
      find.addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault(); });
      top.append(find);
    }
    top.append(count);
    sync();
    box.append(top);
    // Quick picks from the coach's grades: the topics losing marks, or those and the ones with some way to go.
    if (suggest) {
      const row = make("div", "pr-topic-suggest");
      row.setAttribute("role", "group");
      row.setAttribute("aria-label", "Suggested topics");
      const tick = (want) => {
        boxes.forEach((b) => { b.checked = want.has(b.value.toLowerCase()); });
        sync();
        box.dispatchEvent(new Event("change", { bubbles: true }));
      };
      suggestDrawers[name] = () => {
        row.replaceChildren();
        const g = topicGrades || {};
        const red = values.filter((v) => g[String(v.value).toLowerCase()] === "red").map((v) => String(v.value).toLowerCase());
        const amber = values.filter((v) => g[String(v.value).toLowerCase()] === "amber").map((v) => String(v.value).toLowerCase());
        row.hidden = !red.length && !amber.length;
        if (row.hidden) return;
        row.appendChild(make("span", "small muted", "Suggested:"));
        const pickBtn = (label, list, dot) => {
          const b = make("button", "pr-suggest-pick small");
          b.type = "button";
          b.append(make("span", `pr-rag-dot is-${dot}`), document.createTextNode(` ${label} (${list.length})`));
          b.addEventListener("click", () => tick(new Set(list)));
          row.appendChild(b);
        };
        if (red.length) pickBtn("Topics losing marks", red, "red");
        if (amber.length) pickBtn(red.length ? "Those and the amber ones" : "Amber topics", [...red, ...amber], "amber");
      };
      row.hidden = true;
      box.append(row);
      suggestDrawers[name]();
    }
    box.append(list);
    // A long list shows its first two rows (in a one-column list, its first 12), with a button for the rest,
    // instead of a box that scrolls. How many fit in two rows depends on the width, so it is worked out again
    // whenever the list changes size (including when its tab is first shown).
    list.classList.add("is-folded");
    const more = make("button", "linklike small pr-more-chips");
    more.type = "button";
    more.hidden = true;
    // Choices hidden for giving nothing (is-none, in the question filters) are left out of the count and the fold.
    const offered = () => boxes.map((b) => b.parentElement).filter((l) => !l.classList.contains("is-none"));
    const label = () => { more.textContent = list.classList.contains("is-folded") ? `Show all ${offered().length}` : "Show fewer"; };
    more.addEventListener("click", () => { list.classList.toggle("is-folded"); label(); });
    box.append(more);
    function refold() {
      if (!list.offsetParent) return;
      const cols = getComputedStyle(list).gridTemplateColumns.split(" ").filter(Boolean).length;
      const keep = cols > 1 ? cols * 2 : FOLD;
      const shown = offered();
      boxes.forEach((b) => b.parentElement.classList.remove("is-extra"));
      shown.forEach((l, i) => l.classList.toggle("is-extra", i >= keep));
      more.hidden = shown.length <= keep || list.classList.contains("is-searching");
      label();
    }
    list.refold = refold;
    if (window.ResizeObserver) new ResizeObserver(() => refold()).observe(list);
    refold();
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
    pick.hubMarks = () => [];
    const years = [...new Set(meta.papers.map((p) => p.year).filter((y) => y > 0))].sort((a, b) => b - a);
    pick.hubYears = choices("hub-years", years.map((y) => ({ value: y, label: String(y) })), { checked: false });
    pick.cardTopics = choices("card-topics", topics, { checked: false, suggest: true });
    pick.reportTopics = choices("report-topics", topics, { checked: false, suggest: true });
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
    pick.mapTopics = choices("map-topics", topics, { checked: false, suggest: true });
    pick.askTopics = choices("ask-topics", topics, { checked: false });
    askScope();
    drawBuilding();
    const usePapers = $("[data-gen-form] [name=use_papers]");
    usePapers.disabled = !meta.paperQuestions;
    usePapers.checked = !!meta.paperQuestions;
    usePapers.parentElement.title = meta.paperQuestions ? `${meta.paperQuestions} past paper questions in the hub` : "No past papers have been added yet (an admin adds them on the admin page)";
    renderPapers();
    sourceSetup();
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
      source: genSource(),
    };
    const btns = $$("button", genForm);
    btns.forEach((b) => { b.disabled = true; });
    try {
      const r = await api("POST", "practice/generate", body);
      if (body.source === "bank" && r.fromBank < r.asked) toast(`Only ${plural(r.fromBank, "past paper question")} matched your choices, so that is how many there are.`);
      else if (body.source === "mix" && r.fromBank < Math.floor(r.asked / 2)) toast(`${r.fromBank ? `Only ${plural(r.fromBank, "past paper question")} matched` : "No past paper questions matched"}, so Claude is writing the rest.`);
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
  // One question at a time suits a phone; a wider screen shows them all, unless the student chose otherwise.
  quiz.mode = window.matchMedia("(max-width: 640px)").matches ? "one" : "all";
  try { const saved = localStorage.getItem("pr.quizMode"); if (saved === "one" || saved === "all") quiz.mode = saved; } catch { /* storage blocked */ }
  quiz.from = "";
  quiz.clock = 0;
  quiz.started = 0;
  const quizItems = $("[data-quiz-items]");
  const quizStatus = $("[data-quiz-status]");

  /** Open a set of questions. It gets its own address (#quiz/<id>), so Back, reload and bookmarks find it. */
  async function openSession(id, { fromAddress = false } = {}) {
    if (!fromAddress && TABS.includes(hashTab())) quiz.from = hashTab();
    if (!fromAddress && location.hash !== `#quiz/${id}`) history.pushState({ quiz: id }, "", `#quiz/${id}`);
    show("quiz");
    quiz.id = id;
    quiz.data = null;
    quiz.at = 0;
    quiz.filter = "all";
    quiz.t0 = 0;
    quiz.started = 0;
    stopQuizClock();
    $("[data-quiz-steps]").hidden = true;
    $("[data-quiz-handin]").hidden = true;
    $("[data-quiz-bar-progress]").textContent = "";
    $("[data-quiz-track]").style.width = "0";
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
    if (s.resource && s.status !== "failed") showResource(s.resource, s.id);
    else clearResource();
    drawCompare(s);
    const busy = s.status === "generating" || s.status === "marking";
    const steps = $("[data-quiz-steps]");
    if (busy) {
      const t0 = quiz.t0 || (quiz.t0 = Date.now());
      const fromDoc = s.kind === "retrieval" || s.kind === "recall";
      const n = (s.settings && s.settings.count) || s.questions;
      quizStatus.textContent = "";
      steps.hidden = false;
      drawSteps(steps, s.status === "generating"
        ? {
          title: `Claude is writing ${plural(n, "question")}${s.settings && s.settings.fromBank ? ` to go with ${plural(s.settings.fromBank, "past paper question")}` : ""}`,
          steps: [fromDoc ? "Reading the document" : "Reading your notes", "Writing the questions", "Writing the mark schemes", "Checking them over"],
          at: [0, 6, 25, 50],
          note: "This usually takes a minute or two. You can leave this page: the questions are saved here when they are ready.",
        }
        : { title: "Marking your answers", steps: ["Reading your answers", "Marking against the mark scheme", "Writing your feedback"], at: [0, 4, 15], note: "Written answers take longest: Claude checks each point of the mark scheme." }, t0);
      quiz.poll = window.setTimeout(refreshSession, 2000);
    } else {
      quiz.t0 = 0;
      steps.hidden = true;
    }
    $("[data-quiz-handin]").hidden = s.status !== "ready";
    if (s.status === "ready") startQuizClock(); else stopQuizClock();
    if (s.status === "failed") {
      quizStatus.textContent = s.error || "This did not work. Try again.";
      ["[data-quiz-actions]", "[data-quiz-after]", "[data-quiz-tools]", "[data-quiz-dots]", "[data-quiz-step]"].forEach((x) => { $(x).hidden = true; });
      return;
    }
    if (s.status === "generating") return;
    if (s.status === "ready") {
      const marks = s.items.reduce((n, q) => n + q.marks, 0);
      const intro = s.kind === "retrieval" ? "Find each answer in the document on the left. " : s.kind === "recall" ? "The document is closed now: answer from memory. " : "";
      quizStatus.textContent = `${intro}${plural(s.items.length, "question")}, ${plural(marks, "mark")}. Check each answer as you go if you like, then hand ${s.items.length === 1 ? "it" : "them"} in for marking.${s.error ? ` ${s.error}` : ""}`;
    }
    if (s.status === "marked") {
      // The summary shows the score; this line only says what is not obvious.
      quizStatus.textContent = s.error || "";
      $("[data-quiz-score]").textContent = `${s.score} / ${s.total}`;
    }
    if (s.status !== "marking" || !quizItems.children.length) renderItems(s);
    $("[data-quiz-actions]").hidden = s.status !== "ready";
    $("[data-quiz-after]").hidden = s.status !== "marked";
    // After a retrieval quiz: the mini quiz without the document (or the one already taken).
    const recallBtn = $("[data-quiz-recall]");
    recallBtn.hidden = !(s.kind === "retrieval" && s.status === "marked");
    recallBtn.textContent = s.recall ? (s.recall.status === "marked" ? `See your mini quiz without the document (${s.recall.score} / ${s.recall.total})` : "Go to your mini quiz without the document") : "Now try a mini quiz without the document";
    $("[data-quiz-tools]").hidden = !(s.status === "ready" || s.status === "marked") || s.items.length < 2;
    renderSummary(s);
    // A retrieval quiz goes on to the mini quiz; retaking it away from its document would not be the same quiz.
    $("[data-quiz-again]").hidden = s.kind === "retrieval";
    if (s.kind === "retrieval") { $("[data-quiz-followup]").hidden = true; $("[data-quiz-missed]").hidden = true; }
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
    if ("tokens" in a) return !(a.tokens || []).length;
    return true;
  }

  // ----- the quiz bar: progress, a clock while answering
  function drawBarProgress(answered, total) {
    const s = quiz.data;
    const ready = s && s.status === "ready";
    $("[data-quiz-bar-progress]").textContent = ready ? `${answered} of ${total} answered` : "";
    $("[data-quiz-track]").style.width = ready ? `${pct(answered, total)}%` : s && s.status === "marked" ? "100%" : "0";
  }
  function startQuizClock() {
    if (quiz.clock) return;
    quiz.started = quiz.started || Date.now();
    $("[data-quiz-timer]").hidden = false;
    const tick = () => {
      const secs = Math.floor((Date.now() - quiz.started) / 1000);
      $("[data-quiz-clock]").textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
    };
    tick();
    quiz.clock = window.setInterval(tick, 1000);
  }
  function stopQuizClock() {
    window.clearInterval(quiz.clock);
    quiz.clock = 0;
    const t = $("[data-quiz-timer]");
    if (t) t.hidden = true;
  }
  /** Leaving a quiz: no more checking on it, and the clock stops. */
  function leaveQuiz() {
    window.clearTimeout(quiz.poll);
    stopQuizClock();
    quiz.id = null;
  }

  /**
   * What Claude is doing while the student waits: the stages of the job, the one it has probably reached (from how
   * long it has taken so far), and how long that is. The job itself does not report its stage, so the last one is
   * only reached when it is done.
   */
  function drawSteps(el, { title, steps, at, note }, t0) {
    const secs = Math.round((Date.now() - t0) / 1000);
    let cur = 0;
    at.forEach((t, i) => { if (secs >= t) cur = i; });
    el.replaceChildren();
    const head = make("div", "pr-steps-head");
    const spin = make("span", "pr-spinner");
    spin.setAttribute("aria-hidden", "true");
    head.append(spin, make("strong", "", title), make("span", "small muted pr-steps-time", secs < 60 ? `${secs} s` : `${Math.floor(secs / 60)} min ${secs % 60} s`));
    const ol = make("ol", "pr-steps-list");
    steps.forEach((t, i) => {
      const li = make("li", i < cur ? "is-done" : i === cur ? "is-now" : "");
      const mark = make("span", "pr-step-mark");
      if (i < cur) mark.appendChild(svgIcon("i-check"));
      li.append(mark, make("span", "", t));
      if (i === cur) li.setAttribute("aria-current", "step");
      ol.appendChild(li);
    });
    el.append(head, ol);
    if (note) el.appendChild(make("p", "small muted", note));
    const key = `${title}|${cur}`;
    if (el.dataset.stage !== key) { el.dataset.stage = key; announce(`${title}. Step ${cur + 1} of ${steps.length}: ${steps[cur]}.`); }
  }

  /** A score as a ring that fills to its percentage. */
  function scoreRing(p, cls) {
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 44 44");
    svg.setAttribute("class", `pr-ring ${cls}`);
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", `${p} per cent`);
    const C = 2 * Math.PI * 19;
    const circle = (c) => { const e = document.createElementNS(NS, "circle"); e.setAttribute("cx", "22"); e.setAttribute("cy", "22"); e.setAttribute("r", "19"); e.setAttribute("class", c); return e; };
    const track = circle("pr-ring-track");
    const fill = circle("pr-ring-fill");
    fill.setAttribute("stroke-dasharray", `0 ${C}`);
    requestAnimationFrame(() => requestAnimationFrame(() => fill.setAttribute("stroke-dasharray", `${(C * p) / 100} ${C}`)));
    const label = document.createElementNS(NS, "text");
    label.setAttribute("x", "22");
    label.setAttribute("y", "22");
    label.setAttribute("class", "pr-ring-text");
    label.textContent = `${p}%`;
    svg.append(track, fill, label);
    return svg;
  }

  /**
   * A written answer after marking, as the student wrote it, with the words that met a point of the mark scheme
   * marked green and the words the marking said went wrong marked amber.
   */
  function quotedAnswer(text, evidence) {
    const box = make("blockquote", "pr-answer");
    const lower = text.toLowerCase();
    const ranges = [];
    const clean = (x) => String(x || "").replace(/^[\s"“”'‘’.…]+|[\s"“”'‘’.…]+$/g, "");
    const place = (phrase, cls) => {
      const q = clean(phrase);
      if (q.length < 3) return;
      let i = lower.indexOf(q.toLowerCase());
      let len = q.length;
      // A quote that was trimmed or joined with "…": find its opening words instead.
      if (i < 0) {
        const part = q.split(/…|\.\.\./)[0].trim().slice(0, 60);
        if (part.length >= 12) { i = lower.indexOf(part.toLowerCase()); len = part.length; }
      }
      if (i < 0) return;
      if (ranges.some((r) => i < r.end && i + len > r.start)) return;
      ranges.push({ start: i, end: i + len, cls });
    };
    for (const e of evidence || []) {
      if (e.met && e.evidence) place(e.evidence, "is-met");
      if (!e.met && e.said) place(e.said, "is-said");
    }
    ranges.sort((a, b) => a.start - b.start);
    let at = 0;
    for (const r of ranges) {
      if (r.start > at) box.appendChild(document.createTextNode(text.slice(at, r.start)));
      const m = make("mark", r.cls, text.slice(r.start, r.end));
      m.title = r.cls === "is-met" ? "This earned a mark" : "The marking picked this out as not right";
      m.appendChild(make("span", "sr-only", r.cls === "is-met" ? " (earned a mark)" : " (marked as not right)"));
      box.appendChild(m);
      at = r.end;
    }
    if (at < text.length) box.appendChild(document.createTextNode(text.slice(at)));
    if (!text.trim()) box.appendChild(make("span", "muted", "No answer was given."));
    return box;
  }

  /** In a marked set, each question opens and closes; full-mark ones start closed. */
  function makeFoldable(li, q, n) {
    const st = stateOf(q);
    li.classList.add("is-foldable");
    const head = li.querySelector(".pr-q-head");
    const btn = make("button", "icon-btn pr-fold");
    btn.type = "button";
    btn.appendChild(svgIcon("i-chev-down"));
    const preview = make("p", "pr-q-preview small muted");
    const tmp = make("div");
    tmp.innerHTML = q.html;
    const words = tmp.textContent.trim().replace(/\{\{\d+\}\}/g, "___").replace(/\s+/g, " ");
    preview.textContent = words.length > 150 ? `${words.slice(0, 150).replace(/\s+\S*$/, "")}…` : words;
    head.appendChild(btn);
    head.after(preview);
    const set = (open) => {
      li.classList.toggle("is-collapsed", !open);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      btn.setAttribute("aria-label", `${open ? "Close" : "Open"} question ${n + 1}`);
    };
    set(st !== "full");
    btn.addEventListener("click", (e) => { e.stopPropagation(); set(li.classList.contains("is-collapsed")); });
    head.addEventListener("click", (e) => { if (e.target.closest("a, button, input")) return; set(li.classList.contains("is-collapsed")); });
    li._fold = set;
  }
  $$("[data-quiz-fold]").forEach((b) => b.addEventListener("click", () => {
    const open = b.dataset.quizFold === "open";
    $$(".pr-q.is-foldable", quizItems).forEach((li) => li._fold && li._fold(open));
  }));

  function renderItems(s) {
    quizItems.replaceChildren();
    s.items.forEach((q, n) => quizItems.appendChild(renderItem(q, n, s)));
    const marked = s.status === "marked" && s.items.length > 1;
    $$("[data-quiz-fold]").forEach((b) => { b.hidden = !marked; });
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
    } else if (q.type === "calc") {
      li.appendChild(calcBuilder(li, q, locked, ans));
    } else if (locked && a && a.marks !== null && a.marks !== undefined) {
      // Marked: the answer as written, with what earned marks picked out (no box to type in any more).
      li.appendChild(quotedAnswer(ans.text || "", fb.evidence));
      const w = String(ans.text || "").trim().split(/\s+/).filter(Boolean).length;
      li.appendChild(make("span", "muted small pr-wc", plural(w, "word")));
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
        const hint = make("p", "pr-hint small", `${s.kind === "retrieval" ? "Where to look" : "Hint"}: ${q.hint}`);
        hint.hidden = true;
        if (s.kind === "retrieval" && s.resource) {
          const jump = make("button", "linklike small", "Take me there");
          jump.type = "button";
          jump.addEventListener("click", () => { if (!goToPlace(q.hint)) toast("Look for it in the document on the left."); });
          hint.append(" ", jump);
        }
        const hintWord = s.kind === "retrieval" ? "where to look" : "a hint";
        const hb = make("button", "small", `Show ${hintWord}`);
        hb.type = "button";
        hb.addEventListener("click", () => { hint.hidden = !hint.hidden; hb.textContent = hint.hidden ? `Show ${hintWord}` : "Hide it"; });
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
    if (s.status === "marked" && s.items.length > 1) makeFoldable(li, q, n);
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
      if (r) r.classList.add("is-fresh");
      if (r) r.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e) {
      toast(e.message, "error");
      btn.disabled = false;
      btn.textContent = label;
    }
  }

  /** Challenge the marking of one written answer: it is marked again and the new marking replaces the old. */
  async function challenge(q, btn) {
    if (!(await ask({ title: "Challenge this mark?", body: "Claude marks this answer again from scratch, checking your words against each point of the mark scheme.\n\nThe new mark replaces this one, even if it is lower. You can challenge each answer once.", confirm: "Mark it again" }))) return;
    btn.disabled = true;
    btn.textContent = "Claude is marking it again…";
    try {
      const r = await api("POST", `practice/sessions/${quiz.id}/remark`, { question_id: q.id });
      const i = quiz.data.items.findIndex((x) => x.id === q.id);
      if (i < 0) return;
      quiz.data.items[i] = r.item;
      if (r.score !== undefined) {
        quiz.data.score = r.score;
        quiz.data.total = r.total;
        $("[data-quiz-score]").textContent = `${r.score} / ${r.total} (${pct(r.score, r.total)}%)`;
      }
      const li = $$(".pr-q", quizItems)[i];
      const fresh = renderItem(r.item, i, quiz.data);
      if (li) li.replaceWith(fresh);
      renderSummary(quiz.data);
      layout();
      const res2 = fresh.querySelector(".pr-result");
      if (res2) res2.classList.add("is-fresh");
      const box = fresh.querySelector(".pr-remark");
      if (box) box.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } catch (e) {
      toast(e.message, "error");
      btn.disabled = false;
      btn.textContent = "Challenge this mark";
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
      const yours = q.type === "calc" ? `${fb.formula || "(no formula)"}${fb.value !== null && fb.value !== undefined ? ` = ${fmtNum(fb.value, (q.calc && q.calc.decimals) || 2)}` : ""}` : q.type === "written" ? (a.answer && a.answer.text) || "" : q.type === "fill" ? ((a.answer && a.answer.blanks) || []).join(" / ") : q.type === "single" ? q.options[a.answer && a.answer.choice] || "" : ((a.answer && a.answer.choices) || []).map((i) => q.options[i]).join("; ");
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
      const where = `This is question ${n + 1} of my quiz "${(quiz.data && quiz.data.title) || "Practice questions"}": ${plural(q.marks, "mark")}, ${typeLabel(q.type).toLowerCase()}${q.style ? ` (${q.style})` : ""}${q.topics.length ? `, on ${q.topics.join(", ")}` : ""}.`;
      askClaude(`${where}\n\nExplain it to me: what the right answer is, why, and what I should have done to get full marks.\n\nQuestion: ${text.textContent.trim().slice(0, 1500)}${opts}\n\nMy answer: ${String(yours).slice(0, 2000) || "(none)"}${marking ? `\n\n${marking}` : ""}`, true, q.topics || []);
    });
    top.append(explain);
    // A written answer Claude marked can be challenged once: it is marked again from scratch, point by point.
    const marked = a.marks !== null && a.marks !== undefined;
    if (q.type === "written" && marked && !fb.remarked && !fb.error && a.answer && String(a.answer.text || "").trim() && quiz.id) {
      const ch = make("button", "small linklike", "Challenge this mark");
      ch.type = "button";
      ch.title = "Think the marking misread your answer? Claude marks it again from scratch, quoting your words against each point of the mark scheme. The new mark replaces this one.";
      ch.addEventListener("click", () => challenge(q, ch));
      top.append(ch);
    }
    box.appendChild(top);
    if (fb.error) box.appendChild(make("p", "small", fb.error));
    if (q.type === "calc" && q.calc) {
      const c = q.calc;
      const dp = c.decimals ?? 2;
      const unit = c.unit ? ` ${c.unit}` : "";
      const mine = make("p", "small pr-calc-mark");
      const tokens = (a.answer && a.answer.tokens) || [];
      mine.append(make("strong", "", "Your formula: "));
      if (tokens.length) mine.append(formulaView(tokens, c), document.createTextNode(fb.value !== null && fb.value !== undefined ? ` = ${fmtNum(fb.value, dp)}${unit}` : " (not a complete formula)"));
      else mine.append(document.createTextNode("none"));
      box.appendChild(mine);
      if (c.tokens) {
        const model = make("p", "small pr-calc-mark");
        model.append(make("strong", "", "The working: "), formulaView(c.tokens, c), document.createTextNode(` = ${fmtNum(c.answer, dp)}${unit}`));
        box.appendChild(model);
      }
      if (fb.method && !fb.right) box.appendChild(make("p", "small", "You used the right values but put them together the wrong way, so you get method marks only."));
    }
    if (fb.feedbackHtml) { const d = make("div", "prose small pr-feedback"); d.innerHTML = fb.feedbackHtml; box.appendChild(d); }
    else if (fb.feedback) box.appendChild(make("p", "small pr-feedback", fb.feedback));
    if (fb.remarked) {
      const was = Number(fb.previous) || 0;
      const d = make("div", `pr-remark small ${a.marks > was ? "is-up" : a.marks < was ? "is-down" : ""}`);
      d.append(make("strong", "", a.marks === was ? `Marked again after your challenge: still ${a.marks} / ${a.total}.` : `Marked again after your challenge: ${was} → ${a.marks} / ${a.total}.`));
      if (fb.note) d.append(" ", document.createTextNode(fb.note));
      box.appendChild(d);
    }
    // The question's own explanation of the right answer, labelled so it is not taken for the student's answer.
    if (q.explanation) {
      const why = make("p", "small pr-why");
      why.append(make("strong", "", "Why this is the answer: "), document.createTextNode(q.explanation));
      box.appendChild(why);
    }
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
    if (Array.isArray(fb.evidence) && fb.evidence.length) {
      // Each mark scheme point with the words of the answer that met it.
      const withQuote = (met) => fb.evidence.filter((e) => !!e.met === met).map((e) => {
        const li = make("li", "", e.point);
        if (met && e.evidence) li.append(make("span", "pr-quote", `“${e.evidence}”`));
        // For a point missed: what the answer said about it instead (a definition the wrong way round, say).
        if (!met && e.said) li.append(make("span", "pr-quote is-said", `You wrote: “${e.said}”`));
        else if (!met && "said" in e) li.append(make("span", "pr-quote is-said", "Your answer does not mention this."));
        return li;
      });
      for (const [title, met, cls] of [["You got", true, "pr-met"], ["You missed", false, "pr-missed"]]) {
        const items = withQuote(met);
        if (!items.length) continue;
        const d = make("div", cls);
        d.appendChild(make("strong", "small", title));
        const ul = make("ul", "small");
        ul.append(...items);
        d.appendChild(ul);
        lists.appendChild(d);
      }
    } else {
      listOf("You got", fb.met, "pr-met");
      listOf("You missed", fb.missed, "pr-missed");
    }
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
    if (q.type === "calc") return { tokens: (li._calcTokens || []).slice() };
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
    quizItems.classList.toggle("is-one", one);
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
    drawBarProgress(answered, s.items.length);
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
    if (/^[a-f]$/i.test(e.key) && quiz.data && quiz.data.status === "ready") {
      const li = $$(".pr-q", quizItems)[quiz.at];
      const opt = li && li.querySelectorAll(".pr-option input:not(:disabled)")[e.key.toLowerCase().charCodeAt(0) - 97];
      if (opt) { e.preventDefault(); opt.click(); opt.focus(); }
    }
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
    const p = pct(s.score, s.total);
    head.append(scoreRing(p, markClass(p)));
    const words = make("div", "pr-summary-words");
    words.append(
      make("span", "pr-eyebrow", "Your score"),
      make("strong", "pr-summary-score", `${s.score} / ${s.total} marks`),
      make("span", "small muted", p >= 85 ? "Excellent work." : p >= 70 ? "A strong result." : p >= 40 ? "Some marks to win back below." : "Plenty to learn from: start with the questions below."),
    );
    head.appendChild(words);
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
        const link = make("button", "linklike pr-lost-q", short);
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
    if (empty && !(await ask({ title: "Hand in with gaps?", body: `${plural(empty, "question")} ${empty === 1 ? "has" : "have"} no answer yet. Unanswered questions score nothing.`, confirm: "Hand in anyway", cancel: "Keep answering" }))) return;
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
  $("[data-quiz-back]").addEventListener("click", () => {
    if (history.state && history.state.quiz) { history.back(); return; }
    show(quiz.from || "today");
  });
  $("[data-quiz-handin]").addEventListener("click", () => $("[data-quiz-form]").requestSubmit());
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
  $("[data-quiz-recall]").addEventListener("click", async (e) => {
    if (!quiz.data) return;
    if (quiz.data.recall) { openSession(quiz.data.recall.id); return; }
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api("POST", `practice/sessions/${quiz.id}/recall`);
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
  const FACETS = { "hub-styles": "styles", "hub-topics": "topics", "hub-types": "types", "hub-years": "years", "hub-spec": "spec" };
  const hubState = { shown: 0, total: 0, seq: 0 };

  /**
   * Put each filter value's count next to it, and hide the ones that would give nothing with the other filters
   * (a ticked one stays, so it can be unticked).
   */
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
      const list = $(`[data-choices="${name}"] .pr-choice-list`);
      if (list && list.refold) list.refold();
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
    if (q.type === "calc" && q.calc) {
      const tiles = make("p", "small pr-q-links", "Values: ");
      q.calc.values.forEach((v) => tiles.appendChild(tokenChip(`v${q.calc.values.indexOf(v)}`, q.calc, "is-small")));
      li.appendChild(tiles);
    }
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
    if (q.type === "calc" && q.calc && q.calc.tokens) {
      const w = make("p", "", "Working: ");
      w.append(formulaView(q.calc.tokens, q.calc), document.createTextNode(` = ${fmtNum(q.calc.answer, q.calc.decimals ?? 2)}${q.calc.unit ? ` ${q.calc.unit}` : ""}`));
      sc.prepend(w);
    }
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
    if (!more && !hubList.children.length) { const li = make("li", "pr-skel-li"); skeleton(li, 4, { tall: true, grid: true }); hubList.appendChild(li); }
    let r;
    try { r = await api("GET", `practice/hub?${q}`); } catch (e) { $("[data-hub-count]").textContent = e.message; hubMore.disabled = false; hubList.querySelectorAll(".pr-skel-li").forEach((x) => x.remove()); return; }
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
        empty.append(make("strong", "", nothing ? "There are no past paper questions yet." : "No questions here yet."));
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
    if (!(await ask({ title: "Refresh the filters?", body: "Claude reads every past question in the hub again and sorts each by question type, specification area and topic.\n\nIt takes a minute or two and uses your Claude credit.", confirm: "Refresh filters" }))) return;
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
    if (!hasTopics(cardsForm, pick.cardTopics())) return;
    btn.disabled = true;
    try {
      await api("POST", "practice/decks", { topics: pick.cardTopics(), difficulty: f.get("difficulty"), count: Math.max(1, Math.min(60, parseInt(f.get("count"), 10) || 20)), focus: String(f.get("focus") || "") });
      closeSheet(sheetOf(cardsForm));
      cardsForm.querySelector("[name=focus]").value = "";
      loadDecks();
      toast("Claude is writing the cards. The deck appears here when it is ready.");
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

  // ---------- the libraries: decks, study guides and mind maps as cards ----------
  /** A saved title without the count Claude's titles start with ("8 cards · Backups" → "Backups"). */
  const shortTitle = (t) => String(t || "").replace(/^\d+\s+(cards?|questions?)\s+·\s+/i, "") || t;
  function svgIcon(id) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ic");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${id}`);
    svg.appendChild(use);
    return svg;
  }
  /**
   * One item of a library: an icon, its title and details, a progress bar if it has one, the way in (open), and
   * smaller tools (icon buttons). While Claude is still writing it, or if that failed, it says so instead.
   */
  function libCard({ icon, kicker = "", title, status, busy, error, meta, progress = null, open, tools = [] }) {
    const li = make("li", `pr-lib-card is-${status}`);
    const top = make("div", "pr-lib-top");
    const badge = make("span", "pr-lib-icon");
    badge.appendChild(svgIcon(icon));
    top.appendChild(badge);
    if (kicker) top.appendChild(make("span", "pr-lib-kicker", kicker));
    li.appendChild(top);
    const h = make("h3", "pr-lib-title", title);
    h.title = title;
    li.appendChild(h);
    if (status === "generating") {
      li.append(make("p", "small muted pr-lib-meta", busy), make("span", "skel pr-lib-busy"));
    } else if (status === "failed") {
      li.appendChild(make("p", "small pr-bad pr-lib-meta", error));
    } else {
      li.appendChild(make("p", "small muted pr-lib-meta", meta));
      if (progress) {
        const p = make("div", "pr-lib-progress");
        const bar = make("span", "pr-bar");
        const fill = make("span");
        fill.style.width = `${pct(progress.done, progress.of)}%`;
        bar.appendChild(fill);
        p.append(bar, make("span", "small muted", progress.label));
        li.appendChild(p);
      }
    }
    const foot = make("div", "pr-lib-foot");
    if (status === "ready" && open) {
      const b = make("button", "pr-row-cta", open.label);
      b.type = "button";
      b.addEventListener("click", open.run);
      foot.appendChild(b);
    }
    const tl = make("span", "pr-lib-tools");
    for (const t of tools) {
      if (status === "generating" || (t.ready && status !== "ready")) continue;
      const b = make("button", `icon-btn${t.danger ? " is-danger" : ""}`);
      b.type = "button";
      b.title = t.label;
      b.setAttribute("aria-label", `${t.label}: ${title}`);
      b.appendChild(svgIcon(t.icon));
      b.addEventListener("click", t.run);
      tl.appendChild(b);
    }
    foot.appendChild(tl);
    li.appendChild(foot);
    return li;
  }
  /** What an empty library shows: what it is for, and the way to make the first one. */
  function libEmpty({ icon, title, text, label, run }) {
    const d = make("div", "pr-empty");
    const badge = make("span", "pr-empty-icon");
    badge.appendChild(svgIcon(icon));
    const b = make("button", "primary", label);
    b.type = "button";
    b.addEventListener("click", run);
    d.append(badge, make("h3", "", title), make("p", "small muted", text), b);
    return d;
  }

  async function loadDecks() {
    window.clearTimeout(decksTimer);
    const box = $("[data-decks]");
    if (!box.children.length) skeleton(box, 3, { tall: true, grid: true });
    let r;
    try { r = await api("GET", "practice/decks"); } catch (e) { box.replaceChildren(make("p", "pr-bad small", e.message)); doneLoading(box); return; }
    doneLoading(box);
    box.replaceChildren();
    $("[data-sheet-open=cards]").hidden = !r.decks.length;
    if (!r.decks.length) {
      box.appendChild(libEmpty({ icon: "i-cards", title: "No flashcard decks yet", text: "Choose a few topics and Claude writes a deck of cards from your notes: key terms, explanations or applying the ideas.", label: "Make your first deck", run: () => openSheet("cards") }));
      return;
    }
    const grid = make("ul", "pr-lib-grid");
    for (const d of r.decks) {
      grid.appendChild(libCard({
        icon: "i-cards",
        title: shortTitle(d.title),
        status: d.status,
        busy: "Claude is writing the cards…",
        error: d.error || "These cards could not be made.",
        meta: `${plural(d.cards, "card")} · ${d.due ? `${d.due} due now` : "nothing due now"}`,
        progress: d.status === "ready" && d.cards ? { done: d.known, of: d.cards, label: `${d.known} of ${d.cards} known` } : null,
        open: { label: d.due ? `Review ${d.due}` : "Study", run: () => study(d.id) },
        tools: [
          { icon: "i-download", label: "Download as a CSV file (opens in Excel; imports into Anki or Quizlet)", run: () => downloadDeck(d.id), ready: true },
          { icon: "i-trash", label: "Delete this deck", danger: true, run: async () => {
            if (!(await ask({ title: "Delete this deck?", body: `“${d.title}” and your progress on it will be deleted.`, confirm: "Delete deck", danger: true }))) return;
            try { await api("DELETE", `practice/decks/${d.id}`); loadDecks(); toast("Deck deleted."); } catch (e) { toast(e.message, "error"); }
          } },
        ],
      }));
    }
    box.appendChild(grid);
    if (r.decks.some((d) => d.status === "generating")) decksTimer = window.setTimeout(loadDecks, 2500);
  }

  const st = { deck: null, order: [], at: 0, back: false, saveTimer: 0, clock: 0, started: 0, done: false };

  // ----- spaced repetition: each card sits in a box from 1 to 5, and the higher its box the longer until it is due
  // again. "Got it" moves a card up a box; "Again" sends it back to box 1, due again in a few minutes.
  const BOX_WAIT = [0, 10 * 60, 86400, 3 * 86400, 7 * 86400, 21 * 86400];
  const nowSecs = () => Math.floor(Date.now() / 1000);
  const srOf = (i) => (st.deck.progress.sr && st.deck.progress.sr[i]) || null;
  const isDue = (i) => { const e = srOf(i); return !e || e.due <= nowSecs(); };
  function schedule(i, known) {
    const sr = st.deck.progress.sr || (st.deck.progress.sr = {});
    const was = srOf(i);
    const box = known ? Math.min(5, ((was && was.box) || 1) + 1) : 1;
    sr[i] = { box, due: nowSecs() + BOX_WAIT[box] };
  }
  /** "in 3 days", "in 10 minutes", "now". */
  function untilWords(t) {
    const d = t - nowSecs();
    if (d <= 60) return "now";
    if (d < 3600) return `in ${plural(Math.round(d / 60), "minute")}`;
    if (d < 86400) return `in ${plural(Math.round(d / 3600), "hour")}`;
    return `in ${plural(Math.round(d / 86400), "day")}`;
  }

  async function study(id) {
    let d;
    try { d = await api("GET", `practice/decks/${id}`); } catch (e) { toast(e.message, "error"); return; }
    st.deck = d;
    st.deck.progress = d.progress || {};
    st.at = 0;
    st.back = false;
    $("[data-study-title]").textContent = shortTitle(d.title);
    // Cards due now come first; a deck with none due opens on every card.
    const due = d.items.filter((_, i) => isDue(i)).length;
    $("[data-card-set]").value = due ? "due" : "all";
    reorder(false);
    closeEditor();
    show("study");
    drawCard();
    $("[data-card]").focus();
  }
  function reorder(shuffle) {
    const set = $("[data-card-set]").value;
    st.order = st.deck.items.map((_, i) => i).filter((i) => set === "all" || (set === "again" ? st.deck.progress[i] === "again" : isDue(i)));
    if (shuffle) for (let i = st.order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [st.order[i], st.order[j]] = [st.order[j], st.order[i]]; }
    st.at = 0;
    st.back = false;
    st.done = false;
    drawSetCounts();
  }
  /** How many cards each choice of "Study" has. */
  function drawSetCounts() {
    const n = st.deck.items.length;
    const due = st.deck.items.filter((_, i) => isDue(i)).length;
    const again = st.deck.items.filter((_, i) => st.deck.progress[i] === "again").length;
    const opts = $("[data-card-set]").options;
    opts[0].textContent = `Cards due now (${due})`;
    opts[1].textContent = `Every card (${n})`;
    opts[2].textContent = `Cards marked Again (${again})`;
  }
  function drawCard() {
    const cardEl = $("[data-card]");
    const front = $("[data-card-front]");
    const back = $("[data-card-back]");
    const n = st.deck.items.length;
    const known = st.deck.items.filter((_, i) => st.deck.progress[i] === "known").length;
    const again = st.deck.items.filter((_, i) => st.deck.progress[i] === "again").length;
    $("[data-study-score]").textContent = `${known} / ${n} known`;
    $("[data-card-counts]").textContent = `Got it: ${known} · Again: ${again} · Not seen: ${n - known - again}`;
    const has = st.order.length > 0 && !st.done;
    ["[data-card-edit]", "[data-card-delete]", "[data-card-explain]"].forEach((x) => { $(x).disabled = !has; });
    $$(".pr-card-actions button").forEach((b) => { b.disabled = !has; });
    cardEl.classList.remove("is-back", "is-gone-left", "is-gone-right");
    if (!has) {
      // The end of a session, or nothing in this set: say when the next cards are due.
      const next = st.deck.items.map((_, i) => srOf(i)).filter((e) => e && e.due > nowSecs()).sort((a, b) => a.due - b.due)[0];
      const set = $("[data-card-set]").value;
      const title = st.done ? (set === "due" ? "That is every card due now" : "End of the deck") : set === "due" ? "Nothing is due now" : "No cards here";
      const text = st.done
        ? `${known} of ${n} cards are marked Got it.${next ? ` The next card is due ${untilWords(next.due)}.` : ""}`
        : set === "due" ? `${next ? `The next card is due ${untilWords(next.due)}. ` : ""}You can still go through every card.` : "Choose another set of cards to study.";
      const end = make("div", "pr-card-end");
      end.append(make("strong", "", title), make("span", "small muted", text));
      if (set !== "all") {
        const b = make("button", "pr-row-cta small", "Study every card");
        b.type = "button";
        b.addEventListener("click", (e) => { e.stopPropagation(); $("[data-card-set]").value = "all"; reorder(false); drawCard(); });
        end.appendChild(b);
      }
      front.replaceChildren(end);
      back.replaceChildren();
      cardEl.classList.add("is-empty");
      $("[data-card-hint]").textContent = "";
      return;
    }
    cardEl.classList.remove("is-empty");
    const i = st.order[st.at];
    const c = st.deck.items[i];
    const e = srOf(i);
    const meta = `${st.at + 1} of ${st.order.length}${c.topic ? ` · ${c.topic}` : ""}${e ? ` · box ${e.box} of 5` : " · new"}`;
    front.replaceChildren(make("div", "pr-card-meta muted small", meta), make("div", "pr-card-text", c.front), make("span", "pr-card-label", "Question"));
    back.replaceChildren(make("div", "pr-card-meta muted small", meta), make("div", "pr-card-text", c.back), make("span", "pr-card-label", "Answer"));
    cardEl.classList.toggle("is-back", st.back);
    cardEl.setAttribute("aria-label", st.back ? `Answer: ${c.back}. Press to see the question` : `Question: ${c.front}. Press to turn over`);
    $("[data-card-hint]").textContent = st.back ? "Did you know it? Choose Again or Got it" : "Click or press Space to turn over";
  }
  function saveProgress() {
    window.clearTimeout(st.saveTimer);
    st.saveTimer = window.setTimeout(() => { api("PUT", `practice/decks/${st.deck.id}/progress`, { progress: st.deck.progress }).catch(() => toast("Your progress could not be saved.", "error")); }, 400);
  }
  const flip = () => { if (st.order.length && !st.done) { st.back = !st.back; drawCard(); } };
  const move = (d) => { if (st.order.length) { st.done = false; st.at = (st.at + d + st.order.length) % st.order.length; st.back = false; drawCard(); } };
  const markCard = (v) => {
    if (!st.order.length || st.done) return;
    const i = st.order[st.at];
    st.deck.progress[i] = v;
    schedule(i, v === "known");
    saveProgress();
    drawSetCounts();
    // The card leaves to the side it was marked on, then the next comes in.
    const cardEl = $("[data-card]");
    const last = st.at === st.order.length - 1;
    const next = () => {
      if (last) { st.done = true; drawCard(); return; }
      st.at++;
      st.back = false;
      drawCard();
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { next(); return; }
    cardEl.classList.add(v === "known" ? "is-gone-right" : "is-gone-left");
    setTimeout(next, 220);
  };
  $("[data-card]").addEventListener("click", () => { if (st.swiped) { st.swiped = false; return; } flip(); });
  $("[data-card]").addEventListener("keydown", (e) => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
    else if (e.key === "ArrowRight") move(1);
    else if (e.key === "ArrowLeft") move(-1);
    else if (e.key === "1") markCard("again");
    else if (e.key === "2") markCard("known");
  });
  // On a touch screen: swipe the card right for Got it, left for Again.
  (() => {
    const cardEl = $("[data-card]");
    let start = null;
    cardEl.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || !st.order.length || st.done) return;
      start = { x: e.clientX, y: e.clientY, id: e.pointerId, dx: 0 };
    });
    cardEl.addEventListener("pointermove", (e) => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      // A mostly upright move is the page scrolling, not a swipe.
      if (!start.moving && Math.abs(dy) > Math.abs(dx)) { start = null; return; }
      if (!start.moving && Math.abs(dx) > 8) { start.moving = true; try { cardEl.setPointerCapture(e.pointerId); } catch { /* the pointer has already gone */ } cardEl.classList.add("is-dragging"); }
      if (!start.moving) return;
      start.dx = dx;
      cardEl.style.setProperty("--drag", `${dx}px`);
      cardEl.classList.toggle("is-leaning-right", dx > 40);
      cardEl.classList.toggle("is-leaning-left", dx < -40);
    });
    const end = () => {
      if (!start) return;
      const { dx, moving } = start;
      start = null;
      cardEl.classList.remove("is-dragging", "is-leaning-right", "is-leaning-left");
      cardEl.style.removeProperty("--drag");
      if (!moving) return;
      st.swiped = true;
      if (dx > 90) markCard("known");
      else if (dx < -90) markCard("again");
    };
    cardEl.addEventListener("pointerup", end);
    cardEl.addEventListener("pointercancel", end);
  })();
  $("[data-card-next]").addEventListener("click", () => move(1));
  $("[data-card-prev]").addEventListener("click", () => move(-1));
  $("[data-card-again]").addEventListener("click", () => markCard("again"));
  $("[data-card-known]").addEventListener("click", () => markCard("known"));
  $("[data-card-shuffle]").addEventListener("click", () => { reorder(true); drawCard(); });
  $("[data-card-set]").addEventListener("change", () => { reorder(false); drawCard(); $("[data-card]").focus(); });
  $("[data-study-back]").addEventListener("click", () => show("cards"));
  $("[data-card-restart]").addEventListener("click", async () => {
    if (!(await ask({ title: "Start the deck again?", body: "This clears Got it and Again from every card in this deck, and makes every card due now.", confirm: "Start again", danger: true }))) return;
    st.deck.progress = {};
    saveProgress();
    $("[data-card-set]").value = "all";
    reorder(false);
    drawCard();
  });
  $("[data-card-download]").addEventListener("click", () => st.deck && downloadDeck(st.deck.id));
  $("[data-card-explain]").addEventListener("click", () => {
    if (!st.order.length) return;
    const c = st.deck.items[st.order[st.at]];
    const where = `This is a flashcard from my deck "${st.deck.title}"${c.topic ? `, on ${c.topic}` : ""}.`;
    askClaude(`${where}\n\nExplain it to me in more depth, with an example, and how it could come up in an exam.\n\nFront: ${c.front}\nBack: ${c.back}`, true, c.topic ? [c.topic] : []);
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
    if (!(await ask({ title: "Delete this card?", body: "It is taken out of this deck for good.", confirm: "Delete card", danger: true }))) return;
    const items = st.deck.items.filter((_, j) => j !== i);
    // Progress is kept by card number, so the cards after the deleted one move up one.
    const progress = {};
    const sr = {};
    const shift = (from, to) => { for (const [k, v] of Object.entries(from)) { const n = Number(k); if (!Number.isInteger(n)) continue; if (n < i) to[n] = v; else if (n > i) to[n - 1] = v; } };
    shift(Object.fromEntries(Object.entries(st.deck.progress).filter(([k]) => k !== "sr")), progress);
    shift(st.deck.progress.sr || {}, sr);
    progress.sr = sr;
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
      const b = make("button", `pr-kind${k.id === "custom" ? " is-custom" : ""}`);
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
    const box = $("[data-reports]");
    if (!box.children.length) skeleton(box, 3, { tall: true, grid: true });
    let r;
    try { r = await api("GET", "practice/reports"); } catch (e) { box.textContent = e.message; doneLoading(box); return; }
    doneLoading(box);
    if (!reportKinds.length) { reportKinds = r.kinds; drawKinds(); }
    const reports = r.reports.filter((d) => d.kind !== "mind_map");
    box.replaceChildren();
    $("[data-sheet-open=guides]").hidden = !reports.length;
    if (!reports.length) {
      box.appendChild(libEmpty({ icon: "i-doc", title: "No study guides yet", text: "Claude writes a study guide, briefing, cheat sheet, glossary or revision plan from your notes on the topics you choose.", label: "Write your first guide", run: () => openSheet("guides") }));
      return;
    }
    const grid = make("ul", "pr-lib-grid");
    for (const d of reports) {
      grid.appendChild(libCard({
        icon: "i-doc",
        kicker: d.kindLabel,
        title: d.title,
        status: d.status,
        busy: "Claude is writing it…",
        error: d.error || "This could not be written.",
        meta: when(d.createdAt),
        open: { label: "Open", run: () => openReport(d.id) },
        tools: [
          { icon: "i-trash", label: "Delete this study guide", danger: true, run: async () => {
            if (!(await ask({ title: "Delete this study guide?", body: `“${d.title}” will be deleted. Copies you saved in the vault are kept.`, confirm: "Delete", danger: true }))) return;
            try { await api("DELETE", `practice/reports/${d.id}`); loadReports(); toast("Study guide deleted."); } catch (e) { toast(e.message, "error"); }
          } },
        ],
      }));
    }
    box.appendChild(grid);
    if (reports.some((d) => d.status === "generating")) reportsTimer = window.setTimeout(loadReports, 3000);
  }

  reportForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = reportForm.querySelector("button[type=submit]");
    if (!hasTopics(reportForm, pick.reportTopics())) return;
    btn.disabled = true;
    try {
      const r = await api("POST", "practice/reports", { kind: reportKind, topics: pick.reportTopics(), focus: reportFocus.value });
      reportFocus.value = "";
      closeSheet(sheetOf(reportForm));
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
      status.textContent = "";
      const steps = make("div", "pr-steps");
      drawSteps(steps, { title: "Claude is writing it", steps: ["Reading your notes", "Planning what to include", "Writing it", "Checking it over"], at: [0, 8, 20, 70], note: "This usually takes a minute or two. You can leave this page: it is saved under Study guides when it is ready." }, rp.t0);
      body.replaceChildren(steps);
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
    if (!rp.data || !(await ask({ title: "Delete this study guide?", body: `“${rp.data.title}” will be deleted. Copies you saved in the vault are kept.`, confirm: "Delete", danger: true }))) return;
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
  /** A button's content as one of the page's icons and a word. */
  function iconLabel(b, id, text) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ic");
    svg.setAttribute("aria-hidden", "true");
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", `#${id}`);
    svg.appendChild(use);
    b.replaceChildren(svg, make("span", "", text));
  }
  function stopListening() {
    if (speech && (speech.speaking || speech.pending)) speech.cancel();
    const b = $("[data-report-listen]");
    if (b) { b.setAttribute("aria-pressed", "false"); iconLabel(b, "i-play", "Listen"); }
  }
  if (!speech) $("[data-report-listen]").hidden = true;
  $("[data-report-listen]").addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (!rp.data || !speech) return;
    if (speech.speaking && !speech.paused) { speech.pause(); iconLabel(b, "i-play", "Resume"); b.setAttribute("aria-pressed", "false"); return; }
    if (speech.paused) { speech.resume(); iconLabel(b, "i-pause", "Pause"); b.setAttribute("aria-pressed", "true"); return; }
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
    iconLabel(b, "i-pause", "Pause");
    b.setAttribute("aria-pressed", "true");
  });
  window.addEventListener("beforeunload", () => { if (speech) speech.cancel(); });

  // ---------- history ----------
  async function loadHistory() {
    const box = $("[data-history]");
    if (!box.children.length) skeleton(box, 4);
    let r;
    try { r = await api("GET", "practice/sessions"); } catch (e) { box.textContent = e.message; doneLoading(box); return; }
    doneLoading(box);
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
    if (!(await ask({ title: "Clear your answer history?", body: "Every set of questions you have answered in this vault is deleted, with your answers, marks and feedback. Your history and the exam coach's results start again from nothing.\n\nThe questions, flashcards, study guides and mind maps are kept. This cannot be undone.", confirm: "Clear history", danger: true }))) return;
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
  /** The coach's lines that set work ("SET-RETRIEVAL-QUIZ: topic"): the server takes them out of the saved reply. */
  const SET_LINE = /^\s*[*`]*SET-RETRIEVAL-QUIZ:.*$/gm;

  /**
   * Send a message and read the reply as it is written: the server streams it as lines of JSON ({"delta": text},
   * then {"done": view} or {"error": message}). onDelta gets each piece. Resolves with the conversation as saved.
   * A server that answers with plain JSON (an error, or no streaming) is handled the same way as api().
   */
  async function sendStreaming(path, body, onDelta) {
    const res = await fetch(`${base}/${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-CSRF-Token": csrf, Accept: "application/x-ndjson", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const type = res.headers.get("content-type") || "";
    if (!res.ok || !type.includes("event-stream") || !res.body) {
      let data = null;
      try { data = await res.json(); } catch { /* not JSON */ }
      if (!res.ok) throw new ApiError((data && data.error) || (res.status === 401 ? "Your session expired. Reload the page and sign in again." : `The server answered ${res.status}.`));
      return data;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let view = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (typeof ev.delta === "string") onDelta(ev.delta);
        else if (ev.done) view = ev.done;
        else if (ev.error) throw new ApiError(ev.error);
      }
    }
    if (!view) throw new ApiError("The reply was cut off. Open the conversation again to see it: it is saved once Claude finishes.");
    return view;
  }

  /** The notes a reply links to, as chips under it: links into this vault, each once. */
  function sourceChips(body) {
    const seen = new Set();
    const links = [...body.querySelectorAll("a[href]")].filter((a) => {
      const h = a.getAttribute("href") || "";
      if (!h.startsWith(`/v/${vault}/`) || h.includes("/practice") || h.includes("/api/")) return false;
      const key = h.split("#")[0];
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (!links.length) return null;
    const row = make("div", "pr-sources");
    row.appendChild(make("span", "pr-sources-label", "From your notes"));
    for (const a of links.slice(0, 8)) {
      const c = make("a", "pr-source-chip");
      c.href = a.getAttribute("href");
      c.target = "_blank";
      c.rel = "noopener";
      c.appendChild(svgIcon("i-file"));
      c.appendChild(make("span", "", a.textContent.trim() || "Note"));
      row.appendChild(c);
    }
    if (links.length > 8) row.appendChild(make("span", "small muted", `and ${links.length - 8} more`));
    return row;
  }

  /**
   * A chat in one panel ([data-chat], [data-chat-form], [data-chat-suggest], the conversation bar [data-conv] and the
   * list of conversations [data-conv-sheet] inside it), talking to practice/<path>. Every conversation is saved:
   * "New" starts another, and the list goes back to an older one. Replies stream in as Claude writes them.
   * extra() adds to each message sent; onView(reply) draws anything else the reply carries.
   */
  function chatBox(panel, { path, suggest, empty, thinking, noteName, extra = () => ({}), onView = () => {} }) {
    const log = $("[data-chat]", panel);
    const form = $("[data-chat-form]", panel);
    const ta = form.querySelector("textarea");
    const sendBtn = form.querySelector("button[type=submit]");
    const sheet = $("[data-conv-sheet]", panel);
    const list = $("[data-conv-list]", panel);
    const openList = $("[data-conv-open]", panel);
    const delThread = $("[data-conv-delete]", panel);
    const suggestBox = $("[data-chat-suggest]", panel);
    let loading = Promise.resolve();
    let busy = false;
    let thread = null; // the conversation shown, or null for a new one
    let last = null;

    // The box grows with what is typed, up to a limit.
    const grow = () => { ta.style.height = "auto"; ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`; };
    ta.addEventListener("input", grow);

    function message(m) {
      const d = make("div", `pr-msg ${m.role === "user" ? "is-user" : "is-coach"}`);
      if (m.role === "user") { d.textContent = m.text; return d; }
      const body = make("div", "prose");
      body.innerHTML = m.html;
      d.appendChild(body);
      const chips = sourceChips(body);
      if (chips) d.appendChild(chips);
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

    /** The bar (this conversation, how many there are) and the list of saved conversations. */
    function drawThreads(r) {
      const threads = r.threads || [];
      const cur = threads.find((t) => t.id === r.thread);
      $("[data-conv-current]", panel).textContent = cur ? (cur.title || "Conversation") : "New conversation";
      $("[data-conv-count]", panel).textContent = threads.length ? String(threads.length) : "";
      openList.disabled = !threads.length;
      openList.title = threads.length ? `Your ${plural(threads.length, "saved conversation")}` : "No saved conversations yet";
      delThread.hidden = !r.thread;
      list.replaceChildren();
      for (const t of threads) {
        const li = make("li");
        const b = make("button", `pr-conv-item${t.id === r.thread ? " is-current" : ""}`);
        b.type = "button";
        b.append(make("span", "pr-conv-title", t.title || "Conversation"), make("span", "small muted", when(t.updatedAt)));
        if (t.id === r.thread) b.setAttribute("aria-current", "true");
        b.addEventListener("click", () => { closeSheet(sheet); if (!busy && t.id !== thread) load(t.id); });
        li.appendChild(b);
        list.appendChild(li);
      }
    }
    function draw(r) {
      last = r;
      thread = r.thread || null;
      onView(r);
      drawThreads(r);
      doneLoading(log);
      log.replaceChildren();
      if (!r.messages.length) {
        const intro = make("div", "pr-chat-empty");
        intro.append(make("p", "", empty));
        log.appendChild(intro);
      }
      for (const m of r.messages) log.appendChild(message(m));
      // Suggestions are for starting a conversation; once it is going they step aside.
      suggestBox.replaceChildren();
      suggestBox.hidden = r.messages.length > 0;
      for (const t of suggest) {
        const b = make("button", "pr-suggestion small", t);
        b.type = "button";
        b.addEventListener("click", () => { ta.value = t; form.requestSubmit(); });
        suggestBox.appendChild(b);
      }
    }
    /** Show a saved conversation ("" for the most recent, "new" for a new one). */
    let seq = 0;
    function load(which) {
      const q = which === undefined ? (thread || "") : which;
      const n = ++seq;
      if (!log.children.length) skeleton(log, 2);
      // Only the last one asked for is drawn, when several are on their way.
      loading = api("GET", `practice/${path}${q ? `?thread=${encodeURIComponent(q)}` : ""}`).then((r) => { if (n === seq) draw(r); }, (e) => { if (n === seq) log.textContent = e.message; });
      return loading;
    }
    openList.addEventListener("click", () => { if (!sheet.open) { sheet.showModal(); const cur = list.querySelector(".is-current") || list.querySelector("button"); if (cur) cur.focus(); } });
    $("[data-conv-sheet-close]", panel).addEventListener("click", () => closeSheet(sheet));
    sheet.addEventListener("cancel", (e) => { e.preventDefault(); closeSheet(sheet); });
    sheet.addEventListener("click", (e) => {
      if (e.target !== sheet) return;
      const r = sheet.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) closeSheet(sheet);
    });
    $("[data-conv-new]", panel).addEventListener("click", () => {
      if (busy) return;
      load("new").then(() => ta.focus());
    });
    delThread.addEventListener("click", async () => {
      if (!thread || busy) return;
      if (!(await window.UI.confirm({ title: "Delete this conversation?", body: "Notes you saved from it are kept. This cannot be undone.", confirm: "Delete conversation", danger: true }))) return;
      try { draw(await api("DELETE", `practice/${path}/threads/${encodeURIComponent(thread)}`)); toast("Conversation deleted."); } catch (e) { toast(e.message, "error"); }
    });

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = ta.value.trim();
      if (!text || busy) return;
      busy = true;
      sendBtn.disabled = true;
      openList.disabled = true;
      suggestBox.hidden = true;
      const intro = log.querySelector(":scope > .pr-chat-empty, :scope > p.muted");
      if (intro) intro.remove();
      log.appendChild(Object.assign(make("div", "pr-msg is-user"), { textContent: text }));
      const wait = make("div", "pr-msg is-coach is-streaming");
      const live = make("div", "pr-stream-text");
      const dots = make("span", "pr-typing-dots", "");
      dots.setAttribute("aria-label", thinking);
      dots.append(make("span"), make("span"), make("span"));
      live.appendChild(dots);
      wait.appendChild(live);
      log.appendChild(wait);
      log.setAttribute("aria-busy", "true");
      wait.scrollIntoView({ behavior: "smooth", block: "nearest" });
      ta.value = "";
      grow();
      // Pieces are drawn once per frame; the page follows the reply while it is in view at the bottom.
      let written = "";
      let frame = 0;
      // Following the reply stops as soon as the student scrolls themselves.
      let follow = true;
      const stopFollowing = () => { follow = false; };
      window.addEventListener("wheel", stopFollowing, { once: true, passive: true });
      window.addEventListener("touchmove", stopFollowing, { once: true, passive: true });
      const paint = () => {
        frame = 0;
        const shown = written.replace(SET_LINE, "").replace(/\n{3,}/g, "\n\n");
        live.textContent = shown;
        const r = wait.getBoundingClientRect();
        if (follow && r.bottom > window.innerHeight - 140) window.scrollBy({ top: r.bottom - window.innerHeight + 160 });
      };
      try {
        const view = await sendStreaming(`practice/${path}`, { message: text, thread: thread || "", ...extra() }, (piece) => {
          written += piece;
          if (!frame) frame = requestAnimationFrame(paint);
        });
        if (frame) cancelAnimationFrame(frame);
        const top = wait.getBoundingClientRect().top;
        draw(view);
        // Keep the reply where it was while the plain text becomes formatted.
        const reply = log.lastElementChild;
        if (reply && top < 0) reply.scrollIntoView({ block: "start" });
      } catch (err) {
        if (frame) cancelAnimationFrame(frame);
        wait.classList.remove("is-streaming");
        live.replaceChildren(make("p", "pr-bad", err.message));
        if (written) live.prepend(make("p", "", written.replace(SET_LINE, "")));
        if (!written) ta.value = text;
        if (last) drawThreads(last);
      } finally {
        window.removeEventListener("wheel", stopFollowing);
        window.removeEventListener("touchmove", stopFollowing);
        log.removeAttribute("aria-busy");
        busy = false;
        sendBtn.disabled = false;
        openList.disabled = !(last && (last.threads || []).length);
      }
    });
    ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    /**
     * Put a message in the box: sent straight away, or (send false) left there to edit first. A message from
     * elsewhere on the page (explaining a question, a card, an idea) starts a new conversation, so the one open is
     * kept as it was.
     */
    async function put(text, send, fresh = true) {
      await (fresh ? load("new") : loading);
      ta.value = text;
      grow();
      if (send) form.requestSubmit();
      else { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      form.scrollIntoView({ behavior: "smooth", block: "end" });
    }
    return { load, ask: put, redraw: draw };
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
      "Set me retrieval quizzes on the topics I am struggling with.",
    ],
    empty: "Ask the coach how you are doing, or what to revise next.",
    thinking: "The coach is thinking",
    noteName: "Exam coach",
    onView: (r) => { drawStats(r.stats); drawTasks($("[data-coach-tasks]"), r.tasks || [], "coach"); drawRag(r); setGrades(r.topics); },
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
  });
  /**
   * Ask Claude about something (an answer, a card, an idea on a mind map): opens the chat and sends it. With
   * topics, "Which notes Claude reads" is set to them first, so Claude reads the notes the thing was made from.
   */
  function askClaude(text, send = true, topics = []) {
    show("ask");
    if (topics.length) setChoices("ask-topics", topics);
    return askChat.ask(text, send);
  }
  /** Tick exactly these values in a choice group (when any of them is in it). */
  function setChoices(name, values) {
    const want = new Set(values.map((v) => String(v).toLowerCase()));
    const boxes = $$(`[data-choices="${name}"] .pr-chip input`);
    if (!boxes.some((b) => want.has(b.value.toLowerCase()))) return false;
    boxes.forEach((b) => { b.checked = want.has(b.value.toLowerCase()); b.dispatchEvent(new Event("change")); });
    $(`[data-choices="${name}"]`).dispatchEvent(new Event("change", { bubbles: true }));
    return true;
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
    if (!box.children.length) skeleton(box, 3, { tall: true, grid: true });
    let r;
    try { r = await api("GET", "practice/reports"); } catch (e) { box.textContent = e.message; doneLoading(box); return; }
    doneLoading(box);
    const maps = r.reports.filter((d) => d.kind === "mind_map");
    box.replaceChildren();
    $("[data-sheet-open=mindmaps]").hidden = !maps.length;
    if (!maps.length) {
      box.appendChild(libEmpty({ icon: "i-mindmap", title: "No mind maps yet", text: "Choose a topic or two and Claude maps its main themes and how the ideas branch out from them.", label: "Make your first mind map", run: () => openSheet("mindmaps") }));
      return;
    }
    const grid = make("ul", "pr-lib-grid");
    for (const d of maps) {
      grid.appendChild(libCard({
        icon: "i-mindmap",
        title: d.title,
        status: d.status,
        busy: "Claude is mapping your notes…",
        error: d.error || "This could not be made.",
        meta: when(d.createdAt),
        open: { label: "Open", run: () => openMap(d.id) },
        tools: [
          { icon: "i-trash", label: "Delete this mind map", danger: true, run: async () => {
            if (!(await ask({ title: "Delete this mind map?", body: `“${d.title}” will be deleted. Copies you saved in the vault are kept.`, confirm: "Delete", danger: true }))) return;
            try { await api("DELETE", `practice/reports/${d.id}`); loadMaps(); toast("Mind map deleted."); } catch (e) { toast(e.message, "error"); }
          } },
        ],
      }));
    }
    box.appendChild(grid);
    if (maps.some((d) => d.status === "generating")) mapsTimer = window.setTimeout(loadMaps, 3000);
  }

  mapForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = mapForm.querySelector("button[type=submit]");
    const focus = mapForm.querySelector("[name=focus]");
    if (!hasTopics(mapForm, pick.mapTopics())) return;
    btn.disabled = true;
    try {
      const r = await api("POST", "practice/reports", { kind: "mind_map", topics: pick.mapTopics(), focus: focus.value });
      focus.value = "";
      closeSheet(sheetOf(mapForm));
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
      status.textContent = "";
      const steps = make("div", "pr-steps");
      drawSteps(steps, { title: "Claude is making the mind map", steps: ["Reading your notes", "Finding the main themes", "Branching out the ideas"], at: [0, 8, 25], note: "This usually takes about a minute. You can leave this page: it is saved under Mind maps when it is ready." }, mm.t0);
      canvas.replaceChildren(steps);
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

  /**
   * What to ask Claude about an idea on the open mind map, and the topics whose notes to read. The message says
   * it is a mind map, which one and what it was made from, where the idea sits, and the ideas around it, so
   * Claude can tell what "Overview" or "Risks" means on this map.
   */
  function mapQuestion(n) {
    const map = mm.tree.label;
    const topics = (mm.data && mm.data.settings && mm.data.settings.topics) || [];
    const names = (list) => {
      const shown = list.slice(0, 12).map((x) => `"${x.label}"`).join(", ");
      return list.length > 12 ? `${shown} and ${list.length - 12} more` : shown;
    };
    const lines = [`This is about my mind map "${map}"${topics.length ? `, which Claude made from my notes on ${topics.join(", ")}` : ", which Claude made from my notes"}.`];
    if (n.depth === 0) {
      if (n.children.length) lines.push(`Its main branches are ${names(n.children)}.`);
      lines.push("", `Give me an overview of "${map}" from my notes, going through each branch of the map.`);
    } else {
      const path = [];
      for (let p = n; p; p = p.parent) path.unshift(`"${p.label}"`);
      lines.push(`I clicked the idea "${n.label}". On the map it sits here: ${path.join(" → ")}.`);
      if (n.children.length) lines.push(`The ideas branching from it are ${names(n.children)}.`);
      const beside = n.parent.children.filter((x) => x !== n);
      if (beside.length) lines.push(`Beside it under "${n.parent.label}" are ${names(beside)}.`);
      const about = n.depth > 1 ? `"${n.parent.label}" in "${map}"` : `"${map}"`;
      lines.push("", `Explain "${n.label}" from my notes, as part of ${about}${n.children.length ? ", including the ideas that branch from it" : ""}.`);
    }
    return [lines.join("\n"), true, topics];
  }

  /** Lay out the open part of the tree (left to right) and draw it as SVG. */
  function drawMap() {
    const canvas = $("[data-map-canvas]");
    const css = getComputedStyle(document.body);
    const ink = css.color || "#222";
    const dark = (() => { const m = (css.backgroundColor || "").match(/\d+/g); return m ? (Number(m[0]) + Number(m[1]) + Number(m[2])) / 3 < 128 : false; })();
    const LINE = 18, PAD_X = 12, PAD_Y = 8, GAP_Y = 10, GAP_X = 56, TOGGLE = 22;
    const accent = (css.getPropertyValue("--accent") || "").trim() || "#8a6cef";
    // The accent at a fifth of its strength, as an SVG fill (which takes plain colours).
    const accentSoft = (() => {
      const m = accent.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
      return m ? `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, .22)` : (dark ? "#3b3f58" : "#e6e8f7");
    })();
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
      // The centre idea takes the theme's accent colour.
      if (n.depth === 0) return kind === "fill" ? accentSoft : kind === "stroke" ? accent : ink;
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
      const askAbout = () => askClaude(...mapQuestion(n));
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
    if (!mm.data || !(await ask({ title: "Delete this mind map?", body: `“${mm.data.title}” will be deleted. Copies you saved in the vault are kept.`, confirm: "Delete", danger: true }))) return;
    try { await api("DELETE", `practice/reports/${mm.data.id}`); mm.id = null; show("mindmaps"); } catch (e) { toast(e.message, "error"); }
  });
  window.addEventListener("resize", () => { if (!$("[data-panel=mindmap]").hidden && mm.tree) applyScale(); });

  // ---------- where practice questions come from: the past paper bank, a mix, or Claude ----------
  const SOURCES = ["bank", "mix", "claude"];
  const SOURCE_TEXT = {
    bank: ["Past paper questions only", "Questions from the past papers under Past paper questions that match your choices, ready at once. Claude does not write any (difficulty and focus do not apply)."],
    mix: ["A mix of both", "About half the questions come from the past papers in the bank, and Claude writes the rest to match."],
    claude: ["Only Claude's questions", "Claude writes every question from your notes, modelled on the past papers if you like."],
  };
  const sourceRange = $("[data-gen-source]");
  const genSource = () => SOURCES[Number(sourceRange.value)] || "claude";
  function sourceChanged() {
    const src = genSource();
    const [label, hint] = SOURCE_TEXT[src];
    sourceRange.setAttribute("aria-valuetext", label);
    const n = meta ? meta.paperQuestions : 0;
    $("[data-gen-source-hint]").textContent = src !== "claude" && !n ? "No past papers have been added yet, so Claude writes them all." : hint;
    $$("[data-source-stop]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.sourceStop === sourceRange.value ? "true" : "false"));
    $$("[data-gen-claude-only]", genForm).forEach((el) => { el.hidden = src === "bank"; });
    $("[data-gen-submit]").textContent = src === "bank" ? "Find the questions" : "Write the questions";
    try { localStorage.setItem("pr.genSource", src); } catch { /* storage blocked */ }
  }
  function sourceSetup() {
    const has = !!(meta && meta.paperQuestions);
    sourceRange.disabled = !has;
    $$("[data-source-stop]").forEach((b) => { b.disabled = !has; });
    let saved = "claude";
    try { saved = localStorage.getItem("pr.genSource") || "claude"; } catch { /* storage blocked */ }
    sourceRange.value = String(has ? Math.max(0, SOURCES.indexOf(saved)) : 2);
    sourceChanged();
  }
  sourceRange.addEventListener("input", sourceChanged);
  $$("[data-source-stop]").forEach((b) => b.addEventListener("click", () => { if (!sourceRange.disabled) { sourceRange.value = b.dataset.sourceStop; sourceChanged(); } }));

  // ---------- calculation questions: build the formula from tiles ----------
  // Tokens are "v0", "v1" ... (the question's value tiles), "n:8" (a number typed in) and + - * / ^ ( ). The same
  // grammar is evaluated on the server (src/practice.rs, eval_tokens) when the answer is marked.
  const OPS = ["+", "-", "*", "/", "^", "(", ")"];
  const OP_LABEL = { "+": "+", "-": "−", "*": "×", "/": "÷", "^": "^", "(": "(", ")": ")" };
  function evalTokens(tokens, values) {
    let i = 0;
    const peek = () => tokens[i];
    function expr() {
      let a = term();
      while (a !== null && (peek() === "+" || peek() === "-")) { const op = tokens[i++]; const b = term(); if (b === null) return null; a = op === "+" ? a + b : a - b; }
      return a;
    }
    function term() {
      let a = power();
      while (a !== null && (peek() === "*" || peek() === "/")) { const op = tokens[i++]; const b = power(); if (b === null || (op === "/" && b === 0)) return null; a = op === "*" ? a * b : a / b; }
      return a;
    }
    function power() {
      const b = unary();
      if (b !== null && peek() === "^") { i++; const e = power(); return e === null ? null : Math.pow(b, e); }
      return b;
    }
    function unary() {
      if (peek() === "-") { i++; const v = unary(); return v === null ? null : -v; }
      return primary();
    }
    function primary() {
      const t = tokens[i++];
      if (t === undefined) return null;
      if (t === "(") { const v = expr(); if (v === null || peek() !== ")") return null; i++; return v; }
      if (t.startsWith("n:")) { const n = Number(t.slice(2)); return Number.isFinite(n) ? n : null; }
      if (/^v\d+$/.test(t)) { const v = values[Number(t.slice(1))]; return typeof v === "number" ? v : null; }
      return null;
    }
    if (!tokens.length) return null;
    const r = expr();
    return r !== null && i === tokens.length && Number.isFinite(r) ? r : null;
  }
  const fmtNum = (n, dp = 2) => {
    if (n === null || n === undefined || !Number.isFinite(n)) return "";
    const r = Math.round(n * 10 ** Math.min(6, dp + 2)) / 10 ** Math.min(6, dp + 2);
    return r.toLocaleString(undefined, { maximumFractionDigits: Math.min(6, dp + 2) });
  };
  function tokenLabel(t, calc) {
    if (OPS.includes(t)) return OP_LABEL[t];
    if (t.startsWith("n:")) return t.slice(2);
    const v = calc.values[Number(t.slice(1))];
    return v ? v.label : "?";
  }
  function tokenChip(t, calc, cls = "") {
    const isOp = OPS.includes(t);
    const c = make("span", `pr-tok ${isOp ? "is-op" : t.startsWith("n:") ? "is-num" : "is-val"} ${cls}`.trim());
    if (isOp || t.startsWith("n:")) c.textContent = tokenLabel(t, calc);
    else {
      const v = calc.values[Number(t.slice(1))];
      c.append(make("span", "pr-tok-label", v ? v.label : "?"), make("span", "pr-tok-value", v ? `${fmtNum(v.value, 6)}${v.unit ? ` ${v.unit}` : ""}` : ""));
    }
    return c;
  }
  /** A read-only formula, for the marking. */
  function formulaView(tokens, calc) {
    const d = make("span", "pr-formula-view");
    tokens.forEach((t) => d.appendChild(tokenChip(t, calc, "is-small")));
    return d;
  }

  /** The formula builder for one calculation question. Its tokens are kept on the question's list item. */
  function calcBuilder(li, q, locked, ans) {
    const calc = q.calc || { values: [], unit: "", decimals: 2 };
    const values = calc.values.map((v) => v.value);
    let tokens = Array.isArray(ans.tokens) ? ans.tokens.slice() : [];
    li._calcTokens = tokens;
    const box = make("div", `pr-calc${locked ? " is-locked" : ""}`);
    const result = make("div", "pr-calc-result");
    result.setAttribute("aria-live", "polite");
    const formula = make("div", "pr-calc-formula");
    formula.setAttribute("aria-label", "Your formula");
    const changed = () => {
      li._calcTokens = tokens;
      drawFormula();
      li.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const insertAt = (t, at) => { if (locked || tokens.length >= 80) return; tokens.splice(at === undefined ? tokens.length : at, 0, t); changed(); };
    // Where a drop at this point lands among the formula's tiles.
    const dropIndex = (x, y) => {
      const chips = [...formula.querySelectorAll(".pr-tok")];
      for (let i = 0; i < chips.length; i++) {
        const r = chips[i].getBoundingClientRect();
        if (y < r.top) return i;
        if (y <= r.bottom && x < r.left + r.width / 2) return i;
      }
      return chips.length;
    };
    function drawFormula() {
      formula.replaceChildren();
      if (!tokens.length) formula.appendChild(make("span", "muted small pr-calc-empty", locked ? "No formula was built." : "Drag values and operators here (or click them) to build your formula."));
      tokens.forEach((t, i) => {
        const c = tokenChip(t, calc);
        if (!locked) {
          c.draggable = true;
          c.tabIndex = 0;
          c.title = "Drag to move, or click to take it out";
          c.setAttribute("role", "button");
          c.setAttribute("aria-label", `${tokenLabel(t, calc)}: remove from the formula`);
          c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", `move:${i}`); e.dataTransfer.effectAllowed = "move"; c.classList.add("is-dragging"); });
          c.addEventListener("dragend", (e) => {
            c.classList.remove("is-dragging");
            // Dragged out of the formula: take it out.
            if (e.dataTransfer.dropEffect === "none") { tokens.splice(i, 1); changed(); }
          });
          const remove = () => { tokens.splice(i, 1); changed(); };
          c.addEventListener("click", remove);
          c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " " || e.key === "Backspace" || e.key === "Delete") { e.preventDefault(); remove(); } });
        }
        formula.appendChild(c);
      });
      const v = evalTokens(tokens, values);
      result.replaceChildren();
      if (!tokens.length) result.append(make("span", "muted", "= …"));
      else if (v === null) result.append(make("span", "muted", "= the formula is not finished yet"));
      else result.append(make("strong", "", `= ${fmtNum(v, calc.decimals)}${calc.unit ? ` ${calc.unit}` : ""}`));
    }
    if (!locked) {
      formula.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = e.dataTransfer.types.includes("text/plain") ? "move" : "none"; formula.classList.add("is-over"); });
      formula.addEventListener("dragleave", () => formula.classList.remove("is-over"));
      formula.addEventListener("drop", (e) => {
        e.preventDefault();
        formula.classList.remove("is-over");
        const data = e.dataTransfer.getData("text/plain");
        let at = dropIndex(e.clientX, e.clientY);
        if (data.startsWith("move:")) {
          const from = Number(data.slice(5));
          const [t] = tokens.splice(from, 1);
          if (from < at) at--;
          tokens.splice(at, 0, t);
          changed();
        } else if (data.startsWith("add:")) insertAt(data.slice(4), at);
      });
      const tray = make("div", "pr-calc-tray");
      tray.appendChild(make("span", "pr-calc-tray-label small muted", "Values"));
      const addable = (t, label) => {
        const c = tokenChip(t, calc);
        c.draggable = true;
        c.tabIndex = 0;
        c.setAttribute("role", "button");
        c.setAttribute("aria-label", `Add ${label} to the formula`);
        c.title = "Drag into the formula, or click to add it at the end";
        c.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", `add:${t}`); e.dataTransfer.effectAllowed = "copyMove"; });
        c.addEventListener("click", () => insertAt(t));
        c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); insertAt(t); } });
        return c;
      };
      calc.values.forEach((v, i) => tray.appendChild(addable(`v${i}`, v.label)));
      const ops = make("div", "pr-calc-tray pr-calc-ops");
      ops.appendChild(make("span", "pr-calc-tray-label small muted", "Operators"));
      OPS.forEach((o) => ops.appendChild(addable(o, OP_LABEL[o])));
      const num = make("input", "pr-calc-num");
      num.type = "number";
      num.step = "any";
      num.placeholder = "Number";
      num.setAttribute("aria-label", "A number to add to the formula");
      const addNum = make("button", "small", "Add number");
      addNum.type = "button";
      const pushNum = () => { const n = Number(num.value); if (num.value.trim() === "" || !Number.isFinite(n)) return; insertAt(`n:${n}`); num.value = ""; };
      addNum.addEventListener("click", pushNum);
      num.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); pushNum(); } });
      ops.append(num, addNum);
      const tools = make("div", "pr-actions pr-calc-tools");
      const undo = make("button", "small", "Undo");
      undo.type = "button";
      undo.addEventListener("click", () => { if (tokens.length) { tokens.pop(); changed(); } });
      const clear = make("button", "small", "Clear");
      clear.type = "button";
      clear.addEventListener("click", () => { tokens.length = 0; changed(); });
      tools.append(undo, clear);
      box.append(tray, ops);
      const row = make("div", "pr-calc-row");
      row.append(formula, result);
      box.append(row, tools);
    } else {
      const row = make("div", "pr-calc-row");
      row.append(formula, result);
      box.append(row);
    }
    drawFormula();
    return box;
  }

  // ---------- the document beside a retrieval quiz ----------
  const assetV = (() => { const s = document.querySelector('script[src*="/static/practice.js"]'); return s ? (s.getAttribute("src").split("?")[1] || "") : ""; })();
  const res = { key: null, data: null, view: "original" };
  const resBox = $("[data-quiz-resource]");
  const resBody = $("[data-resource-body]");
  const container = host.closest(".container");
  function clearResource() {
    res.key = null;
    res.data = null;
    resBody.replaceChildren();
    resBox.hidden = true;
    $("[data-panel=quiz]").classList.remove("has-resource");
    if (container) container.classList.remove("pr-wide");
  }
  function drawResourceView() {
    const r = res.data;
    resBody.replaceChildren();
    $$("[data-resource-view]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.resourceView === res.view ? "true" : "false"));
    const showOriginal = res.view === "original" && r.fileUrl;
    $("[data-resource-open]").href = showOriginal ? (r.kind === "pdf" ? r.fileUrl : r.fileUrl.replace("/f/", "/o/")) : r.noteUrl;
    if (showOriginal && (r.kind === "pptx" || r.kind === "docx")) {
      // The same renderer as the document viewer page; it draws into the first [data-office] element.
      const hostEl = make("div", "office-host");
      hostEl.dataset.office = "";
      hostEl.dataset.kind = r.kind;
      hostEl.dataset.src = r.fileUrl;
      hostEl.appendChild(make("div", "office-status", "Loading…"));
      resBody.appendChild(hostEl);
      const sc = document.createElement("script");
      sc.src = `/static/office.js${assetV ? `?${assetV}` : ""}`;
      sc.async = true;
      sc.addEventListener("load", () => sc.remove());
      document.body.appendChild(sc);
    } else if (showOriginal && r.kind === "pdf") {
      const f = make("iframe", "pr-resource-pdf");
      f.src = r.fileUrl;
      f.title = r.title;
      resBody.appendChild(f);
    } else {
      const art = make("article", "prose pr-resource-note");
      art.innerHTML = r.html || "<p>This document could not be shown.</p>";
      // Links in the note open in a new tab, so the quiz stays open.
      art.querySelectorAll("a[href]").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
      resBody.appendChild(art);
    }
  }
  function showResource(r, key) {
    resBox.hidden = false;
    $("[data-panel=quiz]").classList.add("has-resource");
    if (container) container.classList.add("pr-wide");
    if (res.key === key) return;
    res.key = key;
    res.data = r;
    res.view = r.fileUrl ? "original" : "note";
    $("[data-resource-title]").textContent = r.title || "Document";
    $("[data-resource-views]").hidden = !r.fileUrl;
    drawResourceView();
  }
  $$("[data-resource-view]").forEach((b) => b.addEventListener("click", () => { if (res.data && res.view !== b.dataset.resourceView) { res.view = b.dataset.resourceView; drawResourceView(); } }));
  /** Scroll the document to a slide, page or heading named in a hint ("Slide 4", "Page 2", "Encryption"). */
  function goToPlace(hint) {
    if (!res.data) return false;
    // "Slide 4", "Slides 8 and 9", "page 2": the first one named.
    const m = String(hint).match(/\b(slide|page)s?\s*(\d+)/i);
    const kind = m ? m[1].toLowerCase() : "";
    const n = m ? Number(m[2]) : 0;
    if (res.view === "original" && res.data.kind === "pdf" && kind === "page") {
      const f = resBody.querySelector("iframe");
      if (f) { f.src = `${res.data.fileUrl}#page=${n}`; return true; }
    }
    if (res.view === "original" && res.data.kind === "pptx" && kind === "slide") {
      const el = resBody.querySelector(`#slide-${n}`);
      if (el) { el.scrollIntoView({ behavior: "smooth", block: "start" }); return true; }
    }
    const heads = [...resBody.querySelectorAll("h1, h2, h3, h4")];
    const want = m ? `${m[1]} ${n}`.toLowerCase() : String(hint).toLowerCase().replace(/^(look at|see|on|in|under)\s+/, "").replace(/[."']/g, "").trim();
    const h = heads.find((x) => x.textContent.trim().toLowerCase() === want) || heads.find((x) => want && x.textContent.toLowerCase().includes(want));
    if (h) { h.scrollIntoView({ behavior: "smooth", block: "start" }); return true; }
    return false;
  }

  // ---------- retrieval quizzes: choosing a document ----------
  const rv = { topic: "", list: [], tasks: [], task: null, loaded: false, seq: 0, limit: 20, lastQ: "" };
  const KIND_LABEL = { pptx: "Slides", docx: "Word", pdf: "PDF", note: "Note" };
  async function loadRetrieval() {
    const status = $("[data-retrieval-status]");
    const n = ++rv.seq;
    status.textContent = "Finding your documents…";
    const list = $("[data-retrieval-list]");
    if (!list.children.length) skeleton(list, 5);
    let r;
    try { r = await api("GET", `practice/resources${rv.topic ? `?topic=${encodeURIComponent(rv.topic)}` : ""}`); } catch (e) { status.textContent = e.message; doneLoading(list); list.replaceChildren(); return; }
    if (n !== rv.seq) return;
    doneLoading(list);
    list.replaceChildren();
    const sel = $("[data-retrieval-topic]");
    if (!rv.loaded) {
      rv.loaded = true;
      sel.replaceChildren(new Option("Every topic", ""));
      for (const t of r.topics) sel.appendChild(new Option(t, t));
    }
    sel.value = rv.topic;
    rv.list = r.resources;
    rv.tasks = r.tasks || [];
    drawTasks($("[data-retrieval-tasks]"), rv.tasks, "retrieval");
    drawResources();
  }
  const RES_PAGE = 20;
  $("[data-retrieval-more]").addEventListener("click", () => { rv.limit += RES_PAGE; drawResources(); });
  function drawResources() {
    const ul = $("[data-retrieval-list]");
    const status = $("[data-retrieval-status]");
    const q = $("[data-retrieval-q]").value.trim().toLowerCase();
    const shown = rv.list.filter((r) => !q || r.title.toLowerCase().includes(q) || r.note.toLowerCase().includes(q));
    ul.replaceChildren();
    if (rv.lastQ !== q) { rv.limit = RES_PAGE; rv.lastQ = q; }
    const task = rv.task && rv.tasks.find((t) => t.id === rv.task);
    status.textContent = !rv.list.length
      ? (rv.topic ? `There are no documents linked to ${rv.topic} yet.` : "There are no documents in this vault yet.")
      : `${plural(shown.length, "document")}${rv.topic ? ` on ${rv.topic}` : ""}${task ? `. This quiz is the work your coach set on ${task.topic}.` : ""}`;
    const more = $("[data-retrieval-more]");
    const left = shown.length - Math.min(shown.length, rv.limit);
    more.hidden = left <= 0;
    more.textContent = `Show ${Math.min(left, RES_PAGE)} more (${left} not shown)`;
    for (const r of shown.slice(0, rv.limit)) {
      const li = make("li", "pr-resource-item");
      li.append(make("span", `pr-doc-kind is-${r.kind}`, KIND_LABEL[r.kind] || "Note"));
      const main = make("div", "pr-resource-main");
      main.append(make("strong", "", r.title));
      if (r.topics.length) main.append(make("span", "small muted", r.topics.slice(0, 4).join(" · ")));
      li.appendChild(main);
      const view = make("a", "button small", "View");
      view.href = r.fileUrl ? (r.kind === "pdf" ? r.fileUrl : r.fileUrl.replace("/f/", "/o/")) : r.noteUrl;
      view.target = "_blank";
      view.rel = "noopener";
      const go = make("button", "pr-row-cta small", "Start a retrieval quiz");
      go.type = "button";
      go.addEventListener("click", () => startRetrieval(r, go));
      const act = make("span", "pr-actions");
      act.append(view, go);
      li.appendChild(act);
      ul.appendChild(li);
    }
  }
  async function startRetrieval(r, btn) {
    btn.disabled = true;
    btn.textContent = "Starting…";
    try {
      const out = await api("POST", "practice/retrieval", { note: r.note, count: Number($("[data-retrieval-count]").value) || 8, task: rv.task, topic: rv.topic });
      rv.task = null;
      openSession(out.id);
    } catch (e) {
      toast(e.message, "error");
      btn.disabled = false;
      btn.textContent = "Start a retrieval quiz";
    }
  }
  /** Open the Retrieval tab on a topic (from the coach's topics or the work it set). */
  function retrievalOn(topic, task = null) {
    rv.topic = topic || "";
    rv.task = task;
    $("[data-retrieval-q]").value = "";
    show("retrieval");
  }
  $("[data-retrieval-topic]").addEventListener("change", (e) => { rv.topic = e.target.value; rv.task = null; rv.limit = RES_PAGE; loadRetrieval(); });
  $("[data-retrieval-q]").addEventListener("input", drawResources);

  // ---------- work the coach sets ----------
  function drawTasks(box, tasks, where) {
    const open = tasks.filter((t) => t.status !== "done");
    const done = tasks.filter((t) => t.status === "done");
    box.hidden = !open.length && !(where === "coach" && done.length);
    box.replaceChildren();
    if (box.hidden) return;
    const head = make("div", "pr-tasks-head");
    head.append(make("strong", "", "Work from your coach"));
    if (done.length) head.append(make("span", "small muted", `${done.length} done`));
    box.appendChild(head);
    if (!open.length) { box.appendChild(make("p", "small muted", "All done. Ask the coach for more, or grade your topics again.")); return; }
    const ul = make("ul", "pr-task-list");
    for (const t of open) {
      const li = make("li", "pr-task");
      const main = make("div", "pr-task-main");
      main.append(make("span", "", `Retrieval quiz on ${t.topic}`));
      if (t.reason) main.append(make("span", "small muted", t.reason));
      li.appendChild(main);
      const act = make("span", "pr-actions");
      if (t.status === "started" && t.sessionId) {
        const b = make("button", "small pr-row-cta", "Continue");
        b.type = "button";
        b.addEventListener("click", () => openSession(t.sessionId));
        act.appendChild(b);
      } else {
        const b = make("button", "small pr-row-cta", "Start");
        b.type = "button";
        b.title = "Choose one of your documents on this topic";
        b.addEventListener("click", () => retrievalOn(t.topic, t.id));
        act.appendChild(b);
      }
      const x = make("button", "small linklike", "Dismiss");
      x.type = "button";
      x.addEventListener("click", async () => {
        try {
          const r = await api("DELETE", `practice/coach/tasks/${t.id}`);
          rv.tasks = r.tasks;
          drawTasks($("[data-retrieval-tasks]"), r.tasks, "retrieval");
          drawTasks($("[data-coach-tasks]"), r.tasks, "coach");
        } catch (e) { toast(e.message, "error"); }
      });
      act.appendChild(x);
      li.appendChild(act);
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }

  // ---------- the coach's RAG grade for each topic ----------
  const GRADE_WORD = { red: "Losing marks", amber: "Some way to go", green: "Secure", none: "Not graded", "": "Not graded" };
  /** Fewer answers than this on a topic and its percentage is shown as a guide only. */
  const FEW_ANSWERS = 3;
  function drawRag(r) {
    const list = $("[data-rag-list]");
    const heat = $("[data-rag-heat]");
    const box = $("[data-rag]");
    const topics = r.topics || [];
    drawCoachSummary(r);
    box.hidden = !topics.length;
    if (!topics.length) return;
    list.replaceChildren();
    heat.replaceChildren();
    heat.classList.remove("show-all");
    const order = { red: 0, amber: 1, green: 2, none: 3, "": 3 };
    const sorted = topics.slice().sort((a, b) => (order[a.grade] - order[b.grade]) || a.topic.localeCompare(b.topic));
    const counts = { red: 0, amber: 0, green: 0, none: 0 };
    for (const t of sorted) {
      const g = t.grade && t.grade !== "" ? t.grade : "none";
      counts[g]++;
      const few = t.result && t.result.answers < FEW_ANSWERS;
      const label = `${t.topic}: ${GRADE_WORD[t.grade || ""]}${t.result ? `, ${t.result.got} / ${t.result.of} marks over ${plural(t.result.answers, "answer")}` : ""}${t.resources ? "" : " (no documents for a retrieval quiz yet)"}`;
      // The heat map: one small tile per topic, in grade order.
      const cell = make("li");
      const tile = make("button", `pr-heat-cell is-${g}`);
      tile.type = "button";
      tile.disabled = !t.resources;
      tile.setAttribute("aria-label", label);
      tile.dataset.tip = label;
      tile.append(make("span", "pr-heat-name", t.topic));
      if (t.result) tile.append(make("span", `pr-heat-pct${few ? " is-few" : ""}`, `${Math.round(t.result.percent)}%`));
      tile.addEventListener("click", () => retrievalOn(t.topic));
      cell.appendChild(tile);
      heat.appendChild(cell);
      // The detailed list, folded away under the heat map.
      const li = make("li");
      const b = make("button", `pr-rag-item is-${t.grade || "none"}`);
      b.type = "button";
      b.disabled = !t.resources;
      const top = make("span", "pr-rag-top");
      top.append(make("span", `pr-rag-dot is-${t.grade || "none"}`), make("strong", "pr-rag-name", t.topic));
      // A percentage from one or two answers says little: it is shown with how few there were.
      if (t.result) top.append(make("span", "pr-rag-pct small", few ? `${Math.round(t.result.percent)}% · ${plural(t.result.answers, "answer")}` : `${Math.round(t.result.percent)}%`));
      b.append(top);
      if (t.reason) b.append(make("span", "pr-rag-reason small muted", t.reason));
      b.append(make("span", "pr-rag-docs small", t.resources ? `${plural(t.resources, "document")} · retrieval quiz` : "No documents on this topic yet"));
      b.title = label;
      b.addEventListener("click", () => retrievalOn(t.topic));
      li.appendChild(b);
      list.appendChild(li);
    }
    // The heat map shows every graded topic and a few others; the rest of the ungraded ones wait behind one tile.
    const SHOW_NONE = 6;
    const extra = [...heat.children].filter((li, i) => sorted[i] && !(sorted[i].grade && sorted[i].grade !== "none")).slice(SHOW_NONE);
    extra.forEach((li) => li.classList.add("is-extra"));
    if (extra.length) {
      const li = make("li");
      const more = make("button", "pr-heat-more", `${extra.length} more not graded yet`);
      more.type = "button";
      more.addEventListener("click", () => { heat.classList.add("show-all"); li.remove(); });
      li.appendChild(more);
      heat.appendChild(li);
    }
    $("[data-rag-summary]").textContent = `${counts.red} red · ${counts.amber} amber · ${counts.green} green${counts.none ? ` · ${counts.none} not graded` : ""}`;
    const g = r.graded;
    const since = g ? (r.answers || 0) - g.answers : 0;
    $("[data-rag-when]").textContent = g ? `Graded ${when(g.at)}${since > 0 ? `, ${plural(since, "answer")} ago` : ""}` : "";
    const btn = $("[data-rag-grade]");
    btn.textContent = g ? "Grade my topics again" : "Grade my topics";
    btn.disabled = host.dataset.configured !== "1";
    // Grading asks Claude, so it waits for the student to ask for it (it used to start by itself).
    btn.classList.toggle("primary", !g && r.answers > 0);
  }

  /** The coach's summary: how it is going overall, and what the topics look like. */
  function drawCoachSummary(r) {
    const box = $("[data-coach-summary]");
    box.replaceChildren();
    const st = r.stats || {};
    const topics = r.topics || [];
    const n = (gr) => topics.filter((t) => t.grade === gr).length;
    const cell = (value, label, cls = "") => {
      const d = make("div", `pr-coach-stat ${cls}`.trim());
      d.append(make("strong", "", value), make("span", "small muted", label));
      return d;
    };
    if (st.answers) {
      box.append(
        cell(`${Math.round(st.percent)}%`, `of your marks, over ${plural(st.answers, "answer")}`, markClass(st.percent)),
        cell(String(n("red")), "topics losing marks", n("red") ? "is-zero" : ""),
        cell(String(n("amber")), "with some way to go", n("amber") ? "is-part" : ""),
        cell(String(n("green")), "secure", n("green") ? "is-full" : ""),
      );
    } else {
      box.appendChild(make("p", "small muted", "Answer some questions and the coach has something to go on: your marks, and a grade for each topic."));
    }
    if (!r.graded && r.answers > 0) {
      const p = make("p", "small pr-coach-nudge");
      p.append(document.createTextNode("Your topics have not been graded yet. "));
      const b = make("button", "linklike small", "Grade them now");
      b.type = "button";
      b.addEventListener("click", gradeTopics);
      p.appendChild(b);
      box.appendChild(p);
    }
  }
  async function gradeTopics() {
    const btn = $("[data-rag-grade]");
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "The coach is grading your topics…";
    try {
      coachChat.redraw(await api("POST", "practice/coach/grades"));
      toast("Your topics have been graded.");
    } catch (e) {
      toast(e.message, "error");
      btn.textContent = label;
    } finally {
      btn.disabled = false;
    }
  }
  $("[data-rag-grade]").addEventListener("click", gradeTopics);

  /** For a retrieval quiz and the mini quiz after it: the two scores side by side. */
  function drawCompare(s) {
    const box = $("[data-quiz-compare]");
    let open = null, closed = null;
    if (s.kind === "recall" && s.parent && s.parent.status === "marked") { open = s.parent; closed = s.status === "marked" ? s : null; }
    if (s.kind === "retrieval" && s.status === "marked") { open = s; closed = s.recall && s.recall.status === "marked" ? s.recall : null; }
    box.hidden = !(open && closed);
    if (box.hidden) return;
    box.replaceChildren();
    const cell = (label, x) => {
      const d = make("div", "pr-compare-cell");
      d.append(make("span", "small muted", label), make("strong", "", `${x.score} / ${x.total}`), make("span", "muted", `${pct(x.score, x.total)}%`));
      return d;
    };
    const a = pct(open.score, open.total), b = pct(closed.score, closed.total);
    box.append(cell("With the document open", open), cell("Without it", closed),
      make("p", "small pr-compare-note",
        a < 50 ? "Finding the answers in the document was hard too, so start there: read it through carefully, then do another retrieval quiz on it before testing yourself again."
          : b >= a ? "You remembered it as well as you could find it. Well done."
          : b >= a - 20 ? "You remembered most of it. Go over the questions you missed without the document."
          : "There is a gap between finding it and remembering it. Do another retrieval quiz on this soon, then try again from memory."));
  }

  // ---------- Today: what to do next, and how it is going ----------
  // Built from what the page already has: the coach's view (grades, work it set, overall marks), the sets of
  // questions answered and the flashcard decks. Nothing here asks Claude anything.
  const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  /** Days in a row with a set of questions handed in, up to today (or yesterday, if nothing is handed in yet today). */
  function streakOf(sessions) {
    const days = new Set(sessions.filter((x) => x.status === "marked").map((x) => dayKey(new Date(x.createdAt * 1000))));
    const d = new Date();
    if (!days.has(dayKey(d))) d.setDate(d.getDate() - 1);
    let n = 0;
    while (days.has(dayKey(d))) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }
  const markClass = (p) => (p >= 70 ? "is-full" : p >= 40 ? "is-part" : "is-zero");

  /** A number (or "12%", "3 / 10") counting up to its value over a moment; left as it is with reduced motion. */
  function countUp(el, text) {
    const m = String(text).match(/^(\d+)(.*)$/);
    if (!m || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = Number(m[1]);
    const rest = m[2];
    if (to < 2) return;
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 600);
      const eased = 1 - (1 - k) ** 3;
      el.textContent = `${Math.round(to * eased)}${rest}`;
      if (k < 1) requestAnimationFrame(step);
    };
    el.textContent = `0${rest}`;
    requestAnimationFrame(step);
  }

  /** Open the quiz creator with these topics ticked. */
  function quizOn(topics) {
    show("questions");
    if (setChoices("topics", topics)) toast(`${topics.join(", ")} chosen. Pick the question types, then write the questions.`, "info");
    $("[data-gen-submit]").focus({ preventScroll: true });
  }

  let todaySeq = 0;
  async function loadToday() {
    const n = ++todaySeq;
    const now = new Date();
    $("[data-today-date]").textContent = now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" });
    const h = now.getHours();
    $("[data-today-greeting]").textContent = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    const next = $("[data-today-next]");
    const recent = $("[data-today-recent]");
    const focus = $("[data-today-topics]");
    if (!next.children.length) {
      skeleton(next, 1, { tall: true });
      skeleton($("[data-today-tiles]"), 4, { grid: true });
      skeleton(recent, 3);
      skeleton(focus, 3);
    }
    const [c, se, de] = await Promise.allSettled([api("GET", "practice/coach"), api("GET", "practice/sessions"), api("GET", "practice/decks")]);
    if (n !== todaySeq) return;
    const coach = c.status === "fulfilled" ? c.value : null;
    const sessions = se.status === "fulfilled" ? se.value.sessions : [];
    const decks = de.status === "fulfilled" ? de.value.decks.filter((d) => d.status === "ready") : [];
    if (coach) setGrades(coach.topics);
    [next, $("[data-today-tiles]"), recent, focus].forEach((x) => { doneLoading(x); x.replaceChildren(); });
    if (se.status === "rejected" && c.status === "rejected") {
      alertBox(next, se.reason.message);
      return;
    }
    drawNext(coach, sessions, decks);
    drawTiles(coach, sessions, decks);
    drawRecent(sessions);
    drawFocus(coach);
  }

  /** The one thing to do next: finish a quiz, the coach's work, a red topic, cards to learn, or a first quiz. */
  function drawNext(coach, sessions, decks) {
    const box = $("[data-today-next]");
    const ready = sessions.find((x) => x.status === "ready");
    const tasks = ((coach && coach.tasks) || []).filter((t) => t.status !== "done");
    const red = ((coach && coach.topics) || []).filter((t) => t.grade === "red");
    const deck = decks.filter((d) => d.due > 0).sort((a, b) => b.due - a.due)[0];
    let it;
    if (ready) {
      it = { icon: "i-quiz", kicker: "Finish what you started", title: shortTitle(ready.title), text: `${plural(ready.questions, "question")} waiting for your answers.`, label: "Carry on", run: () => openSession(ready.id) };
    } else if (tasks.length) {
      const t = tasks[0];
      const going = t.status === "started" && t.sessionId;
      it = { icon: "i-target", kicker: "Set by your coach", title: `Retrieval quiz on ${t.topic}`, text: t.reason || "Find the answers in your documents, then see what you remember without them.", label: going ? "Continue" : "Start", run: () => (going ? openSession(t.sessionId) : retrievalOn(t.topic, t.id)) };
    } else if (red.length) {
      const t = red[0];
      it = { icon: "i-target", kicker: "Where you are losing marks", title: t.topic, text: t.reason || "Your coach graded this topic red.", label: "Quiz me on it", run: () => quizOn([t.topic]) };
    } else if (deck) {
      it = { icon: "i-cards", kicker: "Flashcards due for review", title: shortTitle(deck.title), text: `${plural(deck.due, "card")} due now. A few minutes keeps them in your memory.`, label: "Review them", run: () => study(deck.id) };
    } else {
      it = { icon: "i-quiz", kicker: sessions.length ? "Keep it going" : "Get started", title: sessions.length ? "Test yourself on something new" : "Take your first quiz", text: "Claude writes exam-style questions from your notes and marks your answers.", label: "Quiz me", run: () => show("questions") };
    }
    const card = make("div", "pr-next-card");
    const badge = make("span", "pr-next-icon");
    badge.appendChild(svgIcon(it.icon));
    const body = make("div", "pr-next-body");
    body.append(make("p", "pr-eyebrow", it.kicker), make("h2", "pr-next-title", it.title), make("p", "small muted", it.text));
    const b = make("button", "primary pr-next-go", it.label);
    b.type = "button";
    b.addEventListener("click", it.run);
    card.append(badge, body, b);
    box.appendChild(card);
  }

  function drawTiles(coach, sessions, decks) {
    const box = $("[data-today-tiles]");
    const tile = (icon, value, label, sub, cls = "") => {
      const d = make("div", `pr-tile ${cls}`.trim());
      const top = make("div", "pr-tile-top");
      top.append(svgIcon(icon), make("span", "pr-tile-label", label));
      const v = make("strong", "pr-tile-value", value);
      countUp(v, value);
      d.append(top, v, make("span", "small muted pr-tile-sub", sub));
      return d;
    };
    const last = sessions.find((x) => x.status === "marked");
    box.appendChild(last
      ? tile("i-chart", `${last.score} / ${last.total}`, "Last score", `${pct(last.score, last.total)}% · ${shortTitle(last.title)}`, markClass(pct(last.score, last.total)))
      : tile("i-chart", "–", "Last score", "Nothing marked yet"));
    const streak = streakOf(sessions);
    box.appendChild(tile("i-flame", String(streak), "Day streak", streak ? (streak === 1 ? "Hand one in tomorrow to keep it going" : "Days in a row with a quiz handed in") : "Hand in a quiz today to start one", streak ? "is-streak" : ""));
    const due = decks.reduce((a, d) => a + (d.due || 0), 0);
    box.appendChild(tile("i-cards", String(due), "Cards due", decks.length ? (due ? `across ${plural(decks.filter((d) => d.due).length, "deck")}` : "All caught up") : "No flashcard decks yet"));
    const st = coach && coach.stats;
    box.appendChild(st && st.answers
      ? tile("i-target", `${Math.round(st.percent)}%`, "All your marks", `${st.got} of ${st.of} marks over ${plural(st.answers, "answer")}`, markClass(st.percent))
      : tile("i-target", "–", "All your marks", "Answer some questions to see this"));
  }

  function drawRecent(sessions) {
    const box = $("[data-today-recent]");
    const list = sessions.filter((x) => x.status === "marked" || x.status === "ready").slice(0, 5);
    if (!list.length) { box.appendChild(make("p", "small muted pr-block-empty", "Nothing answered yet. Your quizzes and their marks appear here.")); return; }
    const ul = make("ul", "pr-recent");
    for (const x of list) {
      const li = make("li");
      const b = make("button", "pr-recent-item");
      b.type = "button";
      const p = pct(x.score, x.total);
      b.append(
        x.status === "marked" ? make("span", `pr-mark ${markClass(p)}`, `${p}%`) : make("span", "pr-mark is-pending", "To do"),
        make("span", "pr-recent-title", shortTitle(x.title)),
        make("span", "small muted pr-recent-when", when(x.createdAt)),
      );
      b.title = x.status === "marked" ? `${x.score} / ${x.total}: open to see the marking` : "Not handed in yet: open to answer";
      b.addEventListener("click", () => openSession(x.id));
      li.appendChild(b);
      ul.appendChild(li);
    }
    box.appendChild(ul);
  }

  function drawFocus(coach) {
    const box = $("[data-today-topics]");
    if (!coach) { box.appendChild(make("p", "small muted pr-block-empty", "The coach's grades could not be loaded.")); return; }
    if (!coach.graded) {
      box.appendChild(make("p", "small muted pr-block-empty", coach.answers ? "Your topics have not been graded yet. The exam coach grades each one red, amber or green from your answers." : "Once you have answered some questions, the exam coach grades each topic red, amber or green."));
      return;
    }
    const order = { red: 0, amber: 1 };
    const weak = (coach.topics || []).filter((t) => t.grade === "red" || t.grade === "amber").sort((a, b) => order[a.grade] - order[b.grade]);
    if (!weak.length) { box.appendChild(make("p", "small muted pr-block-empty", "Every graded topic is green. Try a harder quiz, or past paper questions.")); return; }
    const ul = make("ul", "pr-focus-list");
    for (const t of weak.slice(0, 5)) {
      const li = make("li", "pr-focus-item");
      const main = make("div", "pr-focus-main");
      const name = make("span", "pr-focus-name");
      name.append(make("span", `pr-rag-dot is-${t.grade}`), document.createTextNode(` ${t.topic}`));
      main.appendChild(name);
      if (t.reason) main.appendChild(make("span", "small muted pr-focus-reason", t.reason));
      const b = make("button", "pr-row-cta small", "Quiz me");
      b.type = "button";
      b.addEventListener("click", () => quizOn([t.topic]));
      li.append(main, b);
      ul.appendChild(li);
    }
    box.appendChild(ul);
    if (weak.length > 5) box.appendChild(make("p", "small muted", `And ${weak.length - 5} more in the exam coach.`));
  }

  // ---------- links into a tab with filters set (from the admin page's past papers) ----------
  // #hub?years=2024, #hub?spec=1.2 Networks&source=, #hub?paper=12, #questions?paper=3 (a paper guide's id).
  function openFromHash() {
    const [tab, query] = location.hash.slice(1).split("?");
    if (tab.startsWith("quiz/")) {
      const id = tab.slice(5);
      if (id && id !== quiz.id) openSession(id, { fromAddress: true });
      return;
    }
    if (!TABS.includes(tab)) { show("today"); return; }
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
