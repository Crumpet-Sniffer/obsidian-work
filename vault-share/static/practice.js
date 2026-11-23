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

  function alertBox(where, text, kind = "error") {
    const p = make("p", `alert ${kind}`, text);
    where.prepend(p);
    setTimeout(() => p.remove(), 8000);
  }

  // ---------- tabs ----------
  const TABS = ["questions", "hub", "cards", "history", "coach"];
  function show(name) {
    $$("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
    $$("[data-tab]").forEach((b) => b.setAttribute("aria-selected", b.dataset.tab === name ? "true" : "false"));
    if (TABS.includes(name) && location.hash !== `#${name}`) history.replaceState(null, "", `#${name}`);
    if (name === "history") loadHistory();
    if (name === "cards") loadDecks();
    if (name === "coach") loadCoach();
    if (name === "hub") { loadPaperJobs(); loadHub(); }
    window.scrollTo({ top: 0 });
  }
  $$("[data-tab]").forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));

  // ---------- choice groups with "Select all" ----------
  // values: [{value, label}]. Returns a function giving the ticked values.
  function choices(name, values, { checked = true, anyHint = "" } = {}) {
    const box = $(`[data-choices="${name}"]`);
    if (!box) return () => [];
    const legend = box.querySelector("legend");
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
      c.checked = checked;
      l.append(c, document.createTextNode(` ${v.label}`));
      list.appendChild(l);
      return c;
    });
    const sync = () => {
      const n = boxes.filter((b) => b.checked).length;
      allBox.checked = n === boxes.length;
      allBox.indeterminate = n > 0 && n < boxes.length;
    };
    allBox.addEventListener("change", () => { boxes.forEach((b) => { b.checked = allBox.checked; }); sync(); box.dispatchEvent(new Event("change", { bubbles: true })); });
    boxes.forEach((b) => b.addEventListener("change", sync));
    sync();
    box.append(all, list);
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
    pick.hubTopics = choices("hub-topics", topics, { checked: false, anyHint: "None ticked means any." });
    pick.hubTypes = choices("hub-types", types, { checked: false, anyHint: "None ticked means any." });
    pick.hubMarks = choices("hub-marks", marks, { checked: false, anyHint: "None ticked means any." });
    const years = [...new Set(meta.papers.map((p) => p.year).filter((y) => y > 0))].sort((a, b) => b - a);
    pick.hubYears = choices("hub-years", years.map((y) => ({ value: y, label: String(y) })), { checked: false, anyHint: years.length ? "None ticked means any." : "" });
    pick.cardTopics = choices("card-topics", topics);
    const specLabels = [...new Set(meta.profiles.flatMap((p) => p.fields.map((f) => f.label)))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    pick.hubSpec = choices("hub-spec", specLabels.map((l) => ({ value: l, label: l })), { checked: false, anyHint: specLabels.length ? "None ticked means any. Past questions are tagged when the paper guides are built." : "" });
    $("[data-choices=hub-spec]").hidden = !specLabels.length;
    // Questions tab: write for one paper, on some of its specification areas.
    const paperSel = $("[data-gen-paper]");
    const keepPaper = paperSel.value;
    paperSel.replaceChildren(new Option("Any paper (no paper guide)", ""));
    for (const p of meta.profiles) paperSel.appendChild(new Option(`${p.title}${p.qualification ? ` · ${p.qualification}` : ""}`, String(p.id)));
    paperSel.value = [...paperSel.options].some((o) => o.value === keepPaper) ? keepPaper : "";
    $("[data-gen-paper-row]").hidden = !meta.profiles.length;
    genPaperChanged();
    $("#pr-quals").replaceChildren(...(meta.qualifications || []).map((q) => new Option(q)));
    renderDocs();
    renderGuides();
    const usePapers = $("[data-gen-form] [name=use_papers]");
    usePapers.disabled = !meta.paperQuestions;
    usePapers.checked = !!meta.paperQuestions;
    usePapers.parentElement.title = meta.paperQuestions ? `${meta.paperQuestions} past paper questions in the hub` : "Add past papers in the Question hub first";
    renderPapers();
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
  const quiz = { id: null, data: null, poll: 0 };
  const quizItems = $("[data-quiz-items]");
  const quizStatus = $("[data-quiz-status]");

  async function openSession(id) {
    quiz.id = id;
    quiz.data = null;
    show("quiz");
    $("[data-quiz-title]").textContent = "Loading…";
    $("[data-quiz-score]").textContent = "";
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
        ? `Claude is writing ${plural((s.settings && s.settings.count) || s.questions, "question")} from your notes… (${secs} s; this can take a minute or two)`
        : `Marking your answers… (${secs} s)`;
      quiz.poll = window.setTimeout(refreshSession, 2000);
    } else {
      quiz.t0 = 0;
    }
    if (s.status === "failed") {
      quizStatus.textContent = s.error || "This did not work. Try again.";
      $("[data-quiz-actions]").hidden = true;
      $("[data-quiz-after]").hidden = true;
      return;
    }
    if (s.status === "generating") return;
    if (s.status === "ready") quizStatus.textContent = `${plural(s.items.length, "question")}, ${plural(s.items.reduce((n, q) => n + q.marks, 0), "mark")}. ${s.items.length === 1 ? "Answer it, then hand it in" : "Answer them, then hand them in"} for marking.`;
    if (s.status === "marked") {
      quizStatus.textContent = s.error || "Marked. Your answers, the marks and the feedback are saved in History.";
      $("[data-quiz-score]").textContent = `${s.score} / ${s.total} (${pct(s.score, s.total)}%)`;
    }
    if (s.status !== "marking" || !quizItems.children.length) renderItems(s);
    $("[data-quiz-actions]").hidden = s.status !== "ready";
    $("[data-quiz-after]").hidden = s.status !== "marked";
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

  function renderItems(s) {
    quizItems.replaceChildren();
    const answered = s.status === "marked" || s.status === "marking";
    s.items.forEach((q, n) => {
      const li = make("li", "pr-q");
      li.dataset.qid = q.id;
      const head = make("div", "pr-q-head");
      head.append(make("strong", "", `Question ${n + 1}`));
      head.append(make("span", "pr-tag", plural(q.marks, "mark")), make("span", "pr-tag", typeLabel(q.type)));
      for (const t of q.topics) head.append(make("span", "pr-tag pr-topic", t));
      for (const t of q.spec || []) head.append(make("span", "pr-tag pr-spec", t));
      if (q.paper) head.append(make("span", "muted small", `${q.paper}${q.number ? ` · Q${q.number}` : ""}`));
      li.appendChild(head);
      const body = make("div", "pr-q-text prose");
      body.innerHTML = q.html;
      li.appendChild(body);
      const a = q.attempt || null;
      const ans = (a && a.answer) || {};
      const fb = (a && a.feedback) || {};
      if (q.type === "fill") {
        const inputs = placeBlanks(body, q.id, answered, ans.blanks);
        if (!inputs.length) body.appendChild(make("p", "muted small", "This question's blanks could not be shown."));
        if (a && Array.isArray(fb.blanks)) {
          inputs.forEach((inp, i) => {
            if (!inp) return;
            inp.classList.add(fb.blanks[i] ? "is-right" : "is-wrong");
            if (!fb.blanks[i] && q.accepted && q.accepted[i]) inp.title = `Accepted: ${q.accepted[i].join(", ")}`;
          });
          const keys = make("p", "small muted", `Answers: ${(q.accepted || []).map((b, i) => `(${i + 1}) ${b[0]}`).join(" · ")}`);
          li.appendChild(keys);
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
          c.disabled = answered;
          const picked = q.type === "single" ? ans.choice === i : (ans.choices || []).includes(i);
          c.checked = !!picked;
          l.append(c, document.createTextNode(` ${opt}`));
          if (a && q.correct) {
            const right = q.correct.includes(i);
            if (right) l.classList.add("is-right");
            else if (picked) l.classList.add("is-wrong");
          }
          list.appendChild(l);
        });
        li.appendChild(list);
      } else {
        const ta = make("textarea", "pr-written");
        ta.rows = Math.min(14, 3 + q.marks);
        ta.maxLength = 20000;
        ta.placeholder = `Your answer (${plural(q.marks, "mark")})`;
        ta.disabled = answered;
        ta.value = ans.text || "";
        const wc = make("span", "muted small pr-wc");
        const count = () => { const w = ta.value.trim().split(/\s+/).filter(Boolean).length; wc.textContent = plural(w, "word"); };
        ta.addEventListener("input", count);
        count();
        li.append(ta, wc);
      }
      if (a) li.appendChild(result(q, a));
      quizItems.appendChild(li);
    });
  }

  function result(q, a) {
    const box = make("div", "pr-result");
    const fb = a.feedback || {};
    const top = make("div", "pr-result-top");
    if (a.marks === null || a.marks === undefined) top.append(make("strong", "pr-mark is-pending", fb.error ? "Not marked" : "Marking…"));
    else top.append(make("strong", `pr-mark ${a.marks === a.total ? "is-full" : a.marks === 0 ? "is-zero" : "is-part"}`, `${a.marks} / ${a.total}`));
    box.appendChild(top);
    if (fb.error) box.appendChild(make("p", "small", fb.error));
    if (fb.feedbackHtml) { const d = make("div", "prose small"); d.innerHTML = fb.feedbackHtml; box.appendChild(d); }
    else if (fb.feedback) box.appendChild(make("p", "small", fb.feedback));
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

  function collectAnswers() {
    const out = {};
    for (const li of $$(".pr-q", quizItems)) {
      const q = quiz.data.items.find((x) => String(x.id) === li.dataset.qid);
      if (!q) continue;
      if (q.type === "single") {
        const c = li.querySelector("input[type=radio]:checked");
        out[q.id] = { choice: c ? Number(c.value) : null };
      } else if (q.type === "multi") {
        out[q.id] = { choices: $$("input[type=checkbox]:checked", li).map((c) => Number(c.value)) };
      } else if (q.type === "fill") {
        const b = [];
        $$("input.pr-blank", li).forEach((i) => { b[Number(i.dataset.blank)] = i.value; });
        out[q.id] = { blanks: Array.from(b, (x) => x || "") };
      } else {
        out[q.id] = { text: li.querySelector("textarea").value };
      }
    }
    return out;
  }

  $("[data-quiz-form]").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!quiz.data || quiz.data.status !== "ready") return;
    const answers = collectAnswers();
    const empty = Object.values(answers).filter((a) => (a.text !== undefined && !a.text.trim()) || a.choice === null || (a.choices && !a.choices.length) || (a.blanks && a.blanks.every((x) => !x.trim()))).length;
    if (empty && !window.confirm(`${plural(empty, "question")} ${empty === 1 ? "has" : "have"} no answer. Hand in anyway?`)) return;
    const btn = $("[data-quiz-submit]");
    btn.disabled = true;
    try {
      await api("POST", `practice/sessions/${quiz.id}/submit`, { answers });
      quiz.t0 = Date.now();
      // Keep the answers on screen, locked, while they are marked.
      $$("input, textarea", quizItems).forEach((i) => { i.disabled = true; });
      await refreshSession();
    } catch (err) {
      alertBox($("[data-panel=quiz]"), err.message);
    } finally {
      btn.disabled = false;
    }
  });
  $("[data-quiz-back]").addEventListener("click", () => { window.clearTimeout(quiz.poll); quiz.id = null; show(location.hash.slice(1) && TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "questions"); });
  $("[data-quiz-again]").addEventListener("click", async () => {
    if (!quiz.data) return;
    try {
      const r = await api("POST", "practice/sessions", { question_ids: quiz.data.items.map((q) => q.id), title: `${quiz.data.title.replace(/ \(again\)$/, "")} (again)` });
      openSession(r.id);
    } catch (e) { alertBox($("[data-panel=quiz]"), e.message); }
  });
  $("[data-quiz-coach]").addEventListener("click", () => {
    if (!quiz.data) return;
    show("coach");
    const ta = $("[data-chat-form] textarea");
    ta.value = `I just answered "${quiz.data.title}" and got ${quiz.data.score} out of ${quiz.data.total}. What went wrong, and what should I work on?`;
    ta.focus();
  });

  // ---------- question hub ----------
  const hubList = $("[data-hub-list]");
  const hubForm = $("[data-hub-form]");
  let hubTimer = 0;
  const selected = new Set();
  function renderPapers() {
    const box = $("[data-papers]");
    box.replaceChildren();
    const sel = $("[data-paper-filter]");
    const keep = sel.value;
    sel.replaceChildren(new Option("Any paper", ""));
    if (!meta.papers.length) {
      box.appendChild(make("p", "muted small", "No past papers yet."));
      return;
    }
    const wrap = make("div", "table-wrap");
    const t = make("table", "table small");
    t.innerHTML = "<thead><tr><th>Paper</th><th>Qualification</th><th>Questions</th><th>Added by</th><th></th></tr></thead>";
    const tb = make("tbody");
    for (const p of meta.papers) {
      sel.appendChild(new Option(p.qualification ? `${p.title} · ${p.qualification}` : p.title, String(p.id)));
      const tr = make("tr");
      tr.appendChild(make("td", "", p.title));
      tr.appendChild(make("td", "muted", p.qualification || ""));
      tr.appendChild(make("td", "", String(p.questions)));
      tr.appendChild(make("td", "", p.by));
      const act = make("td", "actions");
      if (p.examUrl) { const a = make("a", "button", "Paper"); a.href = p.examUrl; a.target = "_blank"; act.appendChild(a); }
      if (p.schemeUrl) { const a = make("a", "button", "Mark scheme"); a.href = p.schemeUrl; a.target = "_blank"; act.appendChild(a); }
      if (p.canDelete) {
        const b = make("button", "danger", "Remove");
        b.type = "button";
        b.addEventListener("click", async () => {
          if (!window.confirm(`Remove "${p.title}" and its ${plural(p.questions, "question")} from the hub? Answers already given stay in History.`)) return;
          try { await api("DELETE", `practice/papers/${p.id}`); await loadMeta(); loadHub(); } catch (e) { alertBox(box, e.message); }
        });
        act.appendChild(b);
      }
      tr.appendChild(act);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    box.appendChild(wrap);
    sel.value = [...sel.options].some((o) => o.value === keep) ? keep : "";
  }

  async function loadHub() {
    if (!meta) return;
    const f = new FormData(hubForm);
    const q = new URLSearchParams({
      topics: pick.hubTopics().join(","),
      types: pick.hubTypes().join(","),
      marks: pick.hubMarks().join(","),
      years: pick.hubYears().join(","),
      spec: pick.hubSpec().join("|"),
      source: f.get("source") || "",
      paper: f.get("paper") || "",
    });
    let r;
    try { r = await api("GET", `practice/hub?${q}`); } catch (e) { $("[data-hub-count]").textContent = e.message; return; }
    selected.clear();
    updateHubBar();
    $("[data-hub-count]").textContent = r.total > r.questions.length ? `${r.total} questions match; the first ${r.questions.length} are shown` : `${plural(r.total, "question")} ${r.total === 1 ? "matches" : "match"}`;
    hubList.replaceChildren();
    for (const q of r.questions) {
      const li = make("li", "pr-hub-q");
      const head = make("label", "check pr-q-head");
      const c = make("input");
      c.type = "checkbox";
      c.value = String(q.id);
      c.addEventListener("change", () => { if (c.checked) selected.add(q.id); else selected.delete(q.id); updateHubBar(); });
      head.append(c, make("strong", "", q.paper ? `${q.paper}${q.number ? ` · Q${q.number}` : ""}` : "Written by Claude"));
      head.append(make("span", "pr-tag", plural(q.marks, "mark")), make("span", "pr-tag", typeLabel(q.type)));
      for (const t of q.topics) head.append(make("span", "pr-tag pr-topic", t));
      for (const t of q.spec || []) head.append(make("span", "pr-tag pr-spec", t));
      li.appendChild(head);
      const body = make("div", "pr-q-text prose");
      body.innerHTML = q.html;
      li.appendChild(body);
      if (q.options && q.options.length) {
        const ol = make("ol", "pr-hub-options small");
        q.options.forEach((o) => ol.appendChild(make("li", "", o)));
        li.appendChild(ol);
      }
      const d = make("details", "pr-more");
      d.appendChild(make("summary", "", "Mark scheme"));
      const sc = make("div", "prose small");
      sc.innerHTML = q.schemeHtml || "";
      if (q.correct && q.correct.length) sc.prepend(make("p", "", `Correct: ${q.correct.map((i) => q.options[i]).join("; ")}`));
      if (q.accepted && q.accepted.length) sc.prepend(make("p", "", `Accepted answers: ${q.accepted.map((b, i) => `(${i + 1}) ${b.join(" / ")}`).join(" · ")}`));
      d.appendChild(sc);
      li.appendChild(d);
      hubList.appendChild(li);
    }
  }
  function updateHubBar() {
    const b = $("[data-hub-practise]");
    b.disabled = !selected.size;
    b.textContent = selected.size ? `Practise ${plural(selected.size, "question")}` : "Practise selected";
  }
  hubForm.addEventListener("change", () => { window.clearTimeout(hubTimer); hubTimer = window.setTimeout(loadHub, 250); });
  $("[data-hub-all]").addEventListener("click", () => {
    const boxes = $$("input[type=checkbox]", hubList);
    const on = boxes.some((b) => !b.checked);
    boxes.forEach((b) => { b.checked = on; if (on) selected.add(Number(b.value)); else selected.delete(Number(b.value)); });
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

  // ---------- adding a past paper (uploaded in pieces, read by the ingest worker) ----------
  const CHUNK = 64 * 1024 * 1024;
  function sendChunk(bid, file, offset, onSent) {
    return new Promise((resolve, reject) => {
      const end = Math.min(offset + CHUNK, file.size);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${base}/ingest/batches/${bid}/files`);
      xhr.setRequestHeader("X-CSRF-Token", csrf);
      xhr.setRequestHeader("X-Upload-Name", encodeURIComponent(file.name));
      xhr.setRequestHeader("X-Upload-Size", String(file.size));
      xhr.setRequestHeader("X-Upload-Offset", String(offset));
      xhr.upload.onprogress = (e) => onSent(offset + Math.min(e.loaded, end - offset));
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else if (xhr.status === 409 && data && typeof data.received === "number") resolve({ received: data.received, resync: true });
        else reject(new ApiError((data && data.error) || `The server answered ${xhr.status}.`));
      };
      xhr.onerror = () => reject(new ApiError("The upload was interrupted. Check your connection and try again."));
      const form = new FormData();
      form.append("chunk", file.slice(offset, end), "chunk");
      xhr.send(form);
    });
  }
  async function sendFile(bid, file, onSent) {
    let offset = 0;
    for (;;) {
      const r = await sendChunk(bid, file, offset, onSent);
      offset = r.received;
      onSent(offset);
      if (offset >= file.size && !r.resync) return;
    }
  }
  const paperForm = $("[data-paper-form]");
  const jobsEl = $("[data-paper-jobs]");
  let jobsTimer = 0;
  paperForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(paperForm);
    const title = String(f.get("title") || "").trim();
    const files = [f.get("exam"), f.get("scheme")].filter((x) => x && x.size);
    if (!title || !files.length) return;
    const tooBig = files.find((x) => x.size > meta.maxFileBytes);
    if (tooBig) { alertBox(paperForm, `${tooBig.name} is too large.`); return; }
    const btn = paperForm.querySelector("button[type=submit]");
    btn.disabled = true;
    const row = make("li", "job");
    row.append(make("strong", "", title), make("span", "job-status", "Uploading…"));
    jobsEl.prepend(row);
    let bid = null;
    try {
      bid = (await api("POST", "ingest/batches", { kind: "paper", title })).id;
      const total = files.reduce((n, x) => n + x.size, 0);
      let done = 0;
      for (const file of files) {
        await sendFile(bid, file, (sent) => { row.lastChild.textContent = `Uploading… ${pct(done + sent, total)}%`; });
        done += file.size;
      }
      await api("POST", `ingest/batches/${bid}/start`);
      row.remove();
      paperForm.reset();
      loadPaperJobs();
    } catch (err) {
      if (bid) { try { await api("POST", `ingest/batches/${bid}/cancel`); } catch { /* gone */ } }
      row.classList.add("is-failed");
      row.lastChild.textContent = `Not added: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });
  const zipForm = $("[data-zip-form]");
  zipForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = new FormData(zipForm).get("zip");
    if (!file || !file.size) return;
    const btn = zipForm.querySelector("button[type=submit]");
    btn.disabled = true;
    const row = make("li", "job");
    row.append(make("strong", "", file.name), make("span", "job-status", "Uploading…"));
    jobsEl.prepend(row);
    let bid = null;
    try {
      bid = (await api("POST", "ingest/batches", { kind: "paper", zip: true })).id;
      await sendFile(bid, file, (sent) => { row.lastChild.textContent = `Uploading… ${pct(sent, file.size)}%`; });
      await api("POST", `ingest/batches/${bid}/start`);
      row.remove();
      zipForm.reset();
      loadPaperJobs();
    } catch (err) {
      if (bid) { try { await api("POST", `ingest/batches/${bid}/cancel`); } catch { /* gone */ } }
      row.classList.add("is-failed");
      row.lastChild.textContent = `Not added: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  const specForm = $("[data-spec-form]");
  specForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(specForm);
    const file = f.get("spec");
    if (!file || !file.size) return;
    if (file.size > meta.maxFileBytes) { alertBox(specForm, `${file.name} is too large.`); return; }
    const btn = specForm.querySelector("button[type=submit]");
    btn.disabled = true;
    const row = make("li", "job");
    row.append(make("strong", "", file.name), make("span", "job-status", "Uploading…"));
    jobsEl.prepend(row);
    let bid = null;
    try {
      bid = (await api("POST", "ingest/batches", { kind: "paper", spec: true, title: String(f.get("qualification") || "").trim() })).id;
      await sendFile(bid, file, (sent) => { row.lastChild.textContent = `Uploading… ${pct(sent, file.size)}%`; });
      await api("POST", `ingest/batches/${bid}/start`);
      row.remove();
      specForm.reset();
      loadPaperJobs();
    } catch (err) {
      if (bid) { try { await api("POST", `ingest/batches/${bid}/cancel`); } catch { /* gone */ } }
      row.classList.add("is-failed");
      row.lastChild.textContent = `Not added: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- exam documents and paper guides ----------
  function renderDocs() {
    const box = $("[data-docs]");
    box.replaceChildren();
    if (!meta.docs.length) { box.appendChild(make("p", "muted small", "No specifications, examiner reports, commentaries or guidance yet.")); return; }
    const wrap = make("div", "table-wrap");
    const t = make("table", "table small");
    t.innerHTML = "<thead><tr><th>Document</th><th>Kind</th><th>Qualification</th><th>Paper / series</th><th></th></tr></thead>";
    const tb = make("tbody");
    for (const d of meta.docs) {
      const tr = make("tr");
      const name = make("td");
      name.appendChild(make("strong", "", d.title));
      if (d.summary) name.appendChild(make("div", "muted", d.summary));
      tr.appendChild(name);
      tr.appendChild(make("td", "nowrap", d.kindLabel));
      tr.appendChild(make("td", "", d.qualification || ""));
      tr.appendChild(make("td", "nowrap", [d.paperNumber, d.month, d.year || ""].filter(Boolean).join(" ")));
      const act = make("td", "actions");
      if (d.url) { const a = make("a", "button", "Open"); a.href = d.url; a.target = "_blank"; act.appendChild(a); }
      if (d.canDelete) {
        const b = make("button", "danger", "Remove");
        b.type = "button";
        b.addEventListener("click", async () => {
          if (!window.confirm(`Remove "${d.title}"? Build the guides again afterwards to leave it out of them.`)) return;
          try { await api("DELETE", `practice/docs/${d.id}`); await loadMeta(); } catch (e) { alertBox(box, e.message); }
        });
        act.appendChild(b);
      }
      tr.appendChild(act);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    box.appendChild(wrap);
  }

  let guidesTimer = 0;
  function renderGuides() {
    window.clearTimeout(guidesTimer);
    const box = $("[data-guides]");
    const status = $("[data-guides-status]");
    box.replaceChildren();
    const building = meta.buildingProfiles || [];
    const failed = meta.failedProfiles || [];
    const bits = [];
    if (building.length) bits.push(`Claude is building the guides for ${building.join(", ")}… (this takes a minute or two)`);
    for (const f of failed) bits.push(`The guides for ${f.qualification} could not be built: ${f.error}`);
    status.textContent = bits.join(" ");
    status.className = `small ${failed.length && !building.length ? "pr-bad" : "muted"}`;
    if (!meta.profiles.length && !building.length) box.appendChild(make("p", "muted small", "No guides yet. Add a specification or past papers and they are built automatically."));
    for (const p of meta.profiles) {
      const d = make("details", "pr-guide");
      const sum = make("summary");
      sum.append(make("strong", "", p.title));
      if (p.qualification) sum.append(make("span", "muted small", p.qualification));
      sum.append(make("span", "muted small", `${p.fields.length} fields · ${p.fields.reduce((n, f) => n + f.questions, 0)} tagged questions`));
      d.appendChild(sum);
      const fields = make("div", "pr-fields");
      for (const f of p.fields) {
        const b = make("button", "pr-field", f.label);
        b.type = "button";
        b.title = "Show the past questions on this area";
        b.appendChild(make("span", "muted", String(f.questions)));
        b.addEventListener("click", () => {
          $$("[data-choices=hub-spec] .pr-chip input").forEach((c) => { c.checked = c.value === f.label; });
          const src = hubForm.querySelector("[name=source]");
          src.value = "";
          loadHub();
          hubList.scrollIntoView({ behavior: "smooth", block: "start" });
        });
        fields.appendChild(b);
      }
      d.appendChild(fields);
      const body = make("div", "prose small pr-guide-body");
      body.innerHTML = p.html;
      d.appendChild(body);
      const act = make("div", "pr-actions");
      const go = make("button", "primary", "Write questions for this paper");
      go.type = "button";
      go.addEventListener("click", () => { show("questions"); $("[data-gen-paper]").value = String(p.id); genPaperChanged(); });
      act.appendChild(go);
      d.appendChild(act);
      box.appendChild(d);
    }
    $("[data-guides-rebuild]").disabled = !!building.length || !(meta.qualifications || []).length;
    if (building.length) guidesTimer = window.setTimeout(() => loadMeta().then(() => { if (!$("[data-panel=hub]").hidden) loadHub(); }), 5000);
  }
  $("[data-guides-rebuild]").addEventListener("click", async () => {
    try { await api("POST", "practice/profiles/rebuild", {}); await loadMeta(); } catch (e) { alertBox($("[data-panel=hub]"), e.message); }
  });

  async function loadPaperJobs() {
    window.clearTimeout(jobsTimer);
    let r;
    try { r = await api("GET", "ingest/batches?kind=paper"); } catch { return; }
    const recent = r.batches.filter((b) => b.status !== "uploading" && (["queued", "running"].includes(b.status) || Date.now() / 1000 - b.updatedAt < 3600));
    $$("li[data-bid]", jobsEl).forEach((li) => li.remove());
    let active = false;
    for (const b of recent) {
      const li = make("li", `job ${b.status === "done" ? "is-done" : b.status === "failed" ? "is-failed" : ""}`);
      li.dataset.bid = b.id;
      const p = b.progress || {};
      const steps = p.steps || {};
      let text;
      if (b.status === "queued") text = "Waiting to start…";
      else if (b.status === "running") {
        active = true;
        const clock = `${Math.floor((steps.plan && steps.plan.elapsed) / 60 || 0)}:${String(((steps.plan && steps.plan.elapsed) || 0) % 60).padStart(2, "0")}`;
        if (steps.plan && steps.plan.state === "working") text = `${steps.plan.note || "Claude is reading the paper"}… (${clock})`;
        else if (b.meta && b.meta.zip && steps.file && steps.file.state === "working") text = `Adding papers and reading documents: ${steps.file.done} of ${steps.file.of} done…`;
        else if (steps.file && steps.file.state === "working") text = "Adding the questions to the hub…";
        else if (b.meta && b.meta.zip && steps.read && steps.read.state === "working") text = `Looking at each document (${steps.read.done} of ${steps.read.of})…`;
        else text = ((p.files || []).find((f) => f.state === "working") || {}).text || "Reading the files…";
      } else text = p.summary || b.status;
      const jobTitle = b.meta && b.meta.spec ? `Specification: ${b.files.join(", ")}` : (b.meta && !b.meta.zip && b.meta.title) || b.files.join(", ");
      li.append(make("strong", "", jobTitle), make("span", "job-status", text));
      // A zip: what was found in it, paper by paper.
      if (b.meta && b.meta.zip && (p.files || []).length > 1) {
        const d = make("details", "pr-more pr-job-files");
        d.open = b.status === "running" || openJobs.has(b.id);
        d.addEventListener("toggle", () => { if (d.open) openJobs.add(b.id); else openJobs.delete(b.id); });
        d.appendChild(make("summary", "", "What was in the zip"));
        const ul = make("ul", "small");
        for (const f of p.files.slice(1)) {
          const item = make("li", `pr-job-file is-${f.state}`);
          item.append(make("strong", "", f.name), document.createTextNode(` · ${f.text || ""}`));
          if (f.detail) item.appendChild(make("div", "muted", f.detail));
          ul.appendChild(item);
        }
        if (p.files[0] && p.files[0].detail) ul.appendChild(make("li", "muted", p.files[0].detail));
        d.appendChild(ul);
        li.appendChild(d);
      }
      if (b.status === "queued" || b.status === "running") {
        const stop = make("button", "linklike small", "Stop");
        stop.type = "button";
        stop.addEventListener("click", async () => { try { await api("POST", `ingest/batches/${b.id}/cancel`); } catch { /* ignore */ } loadPaperJobs(); });
        li.appendChild(stop);
      }
      jobsEl.appendChild(li);
      if (b.status === "done" && !seenDone.has(b.id)) { seenDone.add(b.id); if (seenDone.ready) { loadMeta().then(loadHub); } }
    }
    seenDone.ready = true;
    if (active || recent.some((b) => b.status === "queued")) jobsTimer = window.setTimeout(loadPaperJobs, 3000);
  }
  const seenDone = new Set();
  const openJobs = new Set();

  // ---------- flashcards ----------
  const cardsForm = $("[data-cards-form]");
  let decksTimer = 0;
  cardsForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(cardsForm);
    const btn = cardsForm.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      await api("POST", "practice/decks", { topics: pick.cardTopics(), difficulty: f.get("difficulty"), count: Math.max(1, Math.min(60, parseInt(f.get("count"), 10) || 20)) });
      loadDecks();
    } catch (err) { alertBox(cardsForm, err.message); } finally { btn.disabled = false; }
  });
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
      li.appendChild(info);
      const act = make("div", "pr-actions");
      if (d.status === "ready") {
        const b = make("button", "primary", "Study");
        b.type = "button";
        b.addEventListener("click", () => study(d.id));
        act.appendChild(b);
      }
      if (d.status !== "generating") {
        const x = make("button", "", "Delete");
        x.type = "button";
        x.addEventListener("click", async () => { if (window.confirm(`Delete "${d.title}"?`)) { await api("DELETE", `practice/decks/${d.id}`); loadDecks(); } });
        act.appendChild(x);
      }
      li.appendChild(act);
      ul.appendChild(li);
    }
    box.appendChild(ul);
    if (r.decks.some((d) => d.status === "generating")) decksTimer = window.setTimeout(loadDecks, 2500);
  }

  const st = { deck: null, order: [], at: 0, back: false, saveTimer: 0 };
  async function study(id) {
    const d = await api("GET", `practice/decks/${id}`);
    st.deck = d;
    st.deck.progress = d.progress || {};
    st.at = 0;
    st.back = false;
    $("[data-card-only-again]").checked = false;
    reorder(false);
    $("[data-study-title]").textContent = d.title;
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
    const known = Object.values(st.deck.progress).filter((v) => v === "known").length;
    $("[data-study-score]").textContent = `${known} / ${st.deck.items.length} known`;
    if (!st.order.length) {
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
    $("[data-card-hint]").textContent = st.back ? "Answer · click to see the question again" : "Click or press Space to turn over";
  }
  function saveProgress() {
    window.clearTimeout(st.saveTimer);
    st.saveTimer = window.setTimeout(() => { api("PUT", `practice/decks/${st.deck.id}/progress`, { progress: st.deck.progress }).catch(() => {}); }, 400);
  }
  const flip = () => { if (st.order.length) { st.back = !st.back; drawCard(); } };
  const move = (d) => { if (st.order.length) { st.at = (st.at + d + st.order.length) % st.order.length; st.back = false; drawCard(); } };
  const markCard = (v) => { if (!st.order.length) return; st.deck.progress[st.order[st.at]] = v; saveProgress(); move(1); };
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

  // ---------- history ----------
  async function loadHistory() {
    const box = $("[data-history]");
    let r;
    try { r = await api("GET", "practice/sessions"); } catch (e) { box.textContent = e.message; return; }
    box.replaceChildren();
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

  // ---------- exam coach ----------
  const chat = $("[data-chat]");
  const chatForm = $("[data-chat-form]");
  function renderCoach(r) {
    const s = r.stats;
    const stats = $("[data-stats]");
    stats.replaceChildren();
    if (!s.answers) {
      stats.appendChild(make("p", "muted small", "No marked answers yet. Answer some questions and the coach will have more to go on."));
    } else {
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
          li.title = `${x.got} / ${x.of} marks over ${plural(x.answers, "answer")}`;
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
    chat.replaceChildren();
    if (!r.messages.length) chat.appendChild(make("p", "muted small", "Ask the coach how you are doing, or what to revise next."));
    for (const m of r.messages) {
      const d = make("div", `pr-msg ${m.role === "user" ? "is-user" : "is-coach"}`);
      if (m.role === "user") d.textContent = m.text;
      else { d.classList.add("prose"); d.innerHTML = m.html; }
      chat.appendChild(d);
    }
    chat.scrollTop = chat.scrollHeight;
  }
  async function loadCoach() {
    try { renderCoach(await api("GET", "practice/coach")); } catch (e) { chat.textContent = e.message; }
  }
  chatForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const ta = chatForm.querySelector("textarea");
    const text = ta.value.trim();
    if (!text) return;
    const btn = chatForm.querySelector("button[type=submit]");
    btn.disabled = true;
    chat.appendChild(Object.assign(make("div", "pr-msg is-user"), { textContent: text }));
    const wait = make("div", "pr-msg is-coach muted", "The coach is thinking…");
    chat.appendChild(wait);
    chat.scrollTop = chat.scrollHeight;
    ta.value = "";
    try {
      renderCoach(await api("POST", "practice/coach", { message: text }));
    } catch (err) {
      wait.textContent = err.message;
      ta.value = text;
    } finally {
      btn.disabled = false;
    }
  });
  chatForm.querySelector("textarea").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); chatForm.requestSubmit(); } });
  $("[data-chat-clear]").addEventListener("click", async () => {
    if (!window.confirm("Clear this conversation? Your answers and marks are kept.")) return;
    try { renderCoach(await api("POST", "practice/coach/clear")); } catch (e) { alertBox(chatForm, e.message); }
  });

  // ---------- start ----------
  loadMeta()
    .then(() => {
      const tab = location.hash.slice(1);
      show(TABS.includes(tab) ? tab : "questions");
    })
    .catch((e) => alertBox(host, `The page could not load: ${e.message}`));
})();
