// Admin → a vault → Past papers: adding past papers and exam documents to the question hub (uploaded in pieces and
// read by the ingest worker), the paper guides built from them, the papers by year, the course documents, and
// clearing the hub or everyone's answers. Talks to /v/{id}/api/... (src/handlers/practice.rs, batches.rs).
// The questions themselves are practised on the vault's Practice page; links here open it with a filter set.
(() => {
  "use strict";
  const host = document.querySelector("[data-papers]");
  if (!host) return;
  const vault = host.dataset.vault;
  const csrf = host.dataset.csrf;
  const base = `/v/${vault}/api`;
  const practice = `/v/${vault}/practice`;
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
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  function alertBox(where, text, kind = "error") {
    const p = make("p", `alert ${kind}`, text);
    where.prepend(p);
    setTimeout(() => p.remove(), 8000);
  }
  /** A link to the Practice page's question bank (or another tab) with filters set, e.g. {years: 2024}. */
  function practiceLink(text, tab, params, cls = "button") {
    const a = make("a", cls, text);
    const q = new URLSearchParams(params || {}).toString();
    a.href = `${practice}#${tab}${q ? `?${q}` : ""}`;
    return a;
  }

  let meta = null;
  async function loadMeta() {
    meta = await api("GET", "practice/meta");
    $("#pr-quals").replaceChildren(...(meta.qualifications || []).map((q) => new Option(q)));
    renderDocs();
    renderGuides();
    renderYears();
  }

  // ---------- papers by year ----------
  // A document about one exam year (an examiner report, commentary or guidance for a dated series).
  const ofYear = (d) => d.year > 0 && d.kind !== "specification";

  /** One section per exam year: its papers, its documents and the examiners' notes on the year as a whole. */
  function renderYears() {
    const box = $("[data-years]");
    const open = new Set($$("details.pr-year[open]", box).map((d) => d.dataset.year));
    const first = !box.dataset.drawn;
    box.dataset.drawn = "1";
    box.replaceChildren();
    const notes = meta.years || [];
    const years = [...new Set([...meta.papers.map((p) => p.year), ...meta.docs.filter(ofYear).map((d) => d.year), ...notes.map((y) => y.year)].filter((y) => y > 0))].sort((a, b) => b - a);
    const undated = meta.papers.filter((p) => !(p.year > 0));
    if (!years.length && !undated.length) {
      box.appendChild(make("p", "muted small", "No past papers yet."));
      return;
    }
    const quals = new Set([...meta.papers.map((p) => p.qualification), ...notes.map((y) => y.qualification)].filter(Boolean));
    const section = (key, title, papers, docs, yearNotes) => {
      const d = make("details", "pr-guide pr-year");
      d.dataset.year = key;
      d.open = open.has(key) || (first && key === String(years[0]));
      const sum = make("summary");
      sum.append(make("strong", "", title));
      const qs = papers.reduce((n, p) => n + p.questions, 0);
      const bits = [plural(papers.length, "paper"), plural(qs, "question")];
      if (docs.length) bits.push(plural(docs.length, "document"));
      sum.append(make("span", "muted small", bits.join(" · ")));
      d.appendChild(sum);
      for (const y of yearNotes) d.appendChild(yearNotesBox(y, quals.size > 1));
      if (!yearNotes.length && docs.length) {
        const building = (meta.buildingProfiles || []).length;
        d.appendChild(make("p", "muted small", building ? "Claude is writing the examiners' notes for this year…" : "No examiners' notes for this year yet: they are written when the guides are built."));
      }
      if (papers.length) {
        d.appendChild(make("h3", "pr-h3", "Papers"));
        d.appendChild(paperTable(papers));
      }
      if (docs.length) {
        d.appendChild(make("h3", "pr-h3", "Documents"));
        d.appendChild(docTable(docs));
      }
      if (papers.length && key !== "undated") {
        const act = make("div", "pr-actions");
        act.appendChild(practiceLink(`Show ${key}'s questions in Past paper questions`, "hub", { years: key }));
        d.appendChild(act);
      }
      box.appendChild(d);
    };
    for (const y of years) {
      section(String(y), String(y), meta.papers.filter((p) => p.year === y), meta.docs.filter((d) => ofYear(d) && d.year === y), notes.filter((n) => n.year === y));
    }
    if (undated.length) section("undated", "Sample and undated papers", undated, [], []);
  }

  /** What examiners said about one year of one qualification. */
  function yearNotesBox(y, showQual) {
    const n = y.notes || {};
    const box = make("div", "pr-year-notes");
    box.appendChild(make("h3", "", showQual && y.qualification ? `Examiners' notes · ${y.qualification}` : "Examiners' notes"));
    if (n.overview) box.appendChild(make("p", "", n.overview));
    for (const [k, title] of [["went_well", "What went well"], ["common_mistakes", "Common mistakes"], ["advice", "Advice for next time"]]) {
      const items = n[k] || [];
      if (!items.length) continue;
      box.appendChild(make("h3", "", title));
      const ul = make("ul", "small");
      items.forEach((i, n) => { const li = make("li", "", i); if (n >= 5) li.hidden = true; ul.appendChild(li); });
      box.appendChild(ul);
      if (items.length > 5) {
        const more = make("button", "linklike small pr-show-all", `Show all ${items.length}`);
        more.type = "button";
        more.setAttribute("aria-expanded", "false");
        more.addEventListener("click", () => {
          const open = more.getAttribute("aria-expanded") !== "true";
          $$("li", ul).forEach((li, n) => { if (n >= 5) li.hidden = !open; });
          more.setAttribute("aria-expanded", open ? "true" : "false");
          more.textContent = open ? "Show fewer" : `Show all ${items.length}`;
        });
        box.appendChild(more);
      }
    }
    return box;
  }

  function paperTable(papers) {
    const box = make("div");
    const wrap = make("div", "table-wrap");
    const t = make("table", "table small");
    t.innerHTML = "<thead><tr><th>Paper</th><th>Qualification</th><th>Questions</th><th>Added by</th><th></th></tr></thead>";
    const tb = make("tbody");
    for (const p of papers) {
      const tr = make("tr");
      tr.appendChild(make("td", "", p.title));
      tr.appendChild(make("td", "muted", p.qualification || ""));
      tr.appendChild(make("td", "", String(p.questions)));
      tr.appendChild(make("td", "", p.by));
      const act = make("td", "actions");
      act.appendChild(practiceLink("Questions", "hub", { paper: p.id }));
      if (p.examUrl) { const a = make("a", "button", "Paper"); a.href = p.examUrl; a.target = "_blank"; act.appendChild(a); }
      if (p.schemeUrl) { const a = make("a", "button", "Mark scheme"); a.href = p.schemeUrl; a.target = "_blank"; act.appendChild(a); }
      (p.insertUrls || []).forEach((u, i, all) => { const a = make("a", "button", all.length > 1 ? `Insert ${i + 1}` : "Insert"); a.href = u; a.target = "_blank"; act.appendChild(a); });
      if (p.canDelete) {
        const b = make("button", "danger", "Remove");
        b.type = "button";
        b.addEventListener("click", async () => {
          if (!(await window.UI.confirm({ title: "Remove this paper?", body: `“${p.title}” and its ${plural(p.questions, "question")} are taken out of the hub. Answers already given stay in everyone's history.`, confirm: "Remove paper", danger: true }))) return;
          try { await api("DELETE", `practice/papers/${p.id}`); await loadMeta(); } catch (e) { alertBox(box, e.message); }
        });
        act.appendChild(b);
      }
      tr.appendChild(act);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    wrap.appendChild(t);
    box.appendChild(wrap);
    return box;
  }

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
  const jobsEl = $("[data-paper-jobs]");
  let jobsTimer = 0;

  /** Upload files as one batch for the ingest worker and start it. */
  async function upload(form, label, batch, files) {
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    const row = make("li", "job");
    row.append(make("strong", "", label), make("span", "job-status", "Uploading…"));
    jobsEl.prepend(row);
    let bid = null;
    try {
      bid = (await api("POST", "ingest/batches", batch)).id;
      const total = files.reduce((n, x) => n + x.size, 0);
      let done = 0;
      for (const file of files) {
        await sendFile(bid, file, (sent) => { row.lastChild.textContent = `Uploading… ${pct(done + sent, total)}%`; });
        done += file.size;
      }
      await api("POST", `ingest/batches/${bid}/start`);
      row.remove();
      form.reset();
      loadPaperJobs();
    } catch (err) {
      if (bid) { try { await api("POST", `ingest/batches/${bid}/cancel`); } catch { /* gone */ } }
      row.classList.add("is-failed");
      row.lastChild.textContent = `Not added: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  }

  const paperForm = $("[data-paper-form]");
  paperForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(paperForm);
    const title = String(f.get("title") || "").trim();
    const chosen = [["exam", f.get("exam")], ["scheme", f.get("scheme")], ["insert", f.get("insert")]].filter(([, x]) => x && x.size);
    if (!title || !chosen.length || chosen[0][0] !== "exam") return;
    const files = chosen.map(([, x]) => x);
    const tooBig = files.find((x) => meta && x.size > meta.maxFileBytes);
    if (tooBig) { alertBox(paperForm, `${tooBig.name} is too large.`); return; }
    upload(paperForm, title, { kind: "paper", title, parts: chosen.map(([part]) => part) }, files);
  });
  const zipForm = $("[data-zip-form]");
  zipForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const file = new FormData(zipForm).get("zip");
    if (!file || !file.size) return;
    upload(zipForm, file.name, { kind: "paper", zip: true }, [file]);
  });
  const specForm = $("[data-spec-form]");
  specForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(specForm);
    const file = f.get("spec");
    if (!file || !file.size) return;
    if (meta && file.size > meta.maxFileBytes) { alertBox(specForm, `${file.name} is too large.`); return; }
    upload(specForm, file.name, { kind: "paper", spec: true, title: String(f.get("qualification") || "").trim() }, [file]);
  });

  // ---------- exam documents and paper guides ----------
  function renderDocs() {
    const box = $("[data-docs]");
    box.replaceChildren();
    const course = meta.docs.filter((d) => !ofYear(d));
    if (!course.length) { box.appendChild(make("p", "muted small", meta.docs.length ? "None: every document so far is about one exam year, under Papers by year." : "No specifications, examiner reports, commentaries or guidance yet.")); return; }
    box.appendChild(docTable(course));
  }

  function docTable(docs) {
    const box = make("div");
    const wrap = make("div", "table-wrap");
    const t = make("table", "table small");
    t.innerHTML = "<thead><tr><th>Document</th><th>Kind</th><th>Qualification</th><th>Paper / series</th><th></th></tr></thead>";
    const tb = make("tbody");
    for (const d of docs) {
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
          if (!(await window.UI.confirm({ title: "Remove this document?", body: `“${d.title}” is removed. Build the guides again afterwards to leave it out of them.`, confirm: "Remove document", danger: true }))) return;
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
    return box;
  }

  let guidesTimer = 0;
  /** A qualification as it is printed (the server reports the ones being built in lower case). */
  const qualName = (q) => (meta.qualifications || []).find((x) => x.toLowerCase() === String(q).toLowerCase()) || q;
  function renderGuides() {
    window.clearTimeout(guidesTimer);
    const box = $("[data-guides]");
    const status = $("[data-guides-status]");
    box.replaceChildren();
    const building = meta.buildingProfiles || [];
    const failed = meta.failedProfiles || [];
    const bits = [];
    if (building.length) bits.push(`Claude is building the guides for ${building.map(qualName).join(", ")}… (this takes a minute or two)`);
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
        const a = practiceLink(f.label, "hub", { spec: f.label, source: "" }, "pr-field");
        a.title = "Show the past questions on this area in Past paper questions";
        a.appendChild(make("span", "muted", String(f.questions)));
        fields.appendChild(a);
      }
      d.appendChild(fields);
      const body = make("div", "prose small pr-guide-body");
      body.innerHTML = p.html;
      d.appendChild(body);
      const act = make("div", "pr-actions");
      act.appendChild(practiceLink("Write questions for this paper", "questions", { paper: p.id }, "button primary"));
      d.appendChild(act);
      box.appendChild(d);
    }
    $("[data-guides-rebuild]").disabled = !!building.length || !(meta.qualifications || []).length;
    if (building.length) guidesTimer = window.setTimeout(() => loadMeta().catch(() => {}), 5000);
  }
  $("[data-guides-rebuild]").addEventListener("click", async () => {
    try { await api("POST", "practice/profiles/rebuild", {}); await loadMeta(); } catch (e) { alertBox($("[data-guides]"), e.message); }
  });

  // ---------- clearing ----------
  const wipeBox = $("[data-wipe]");
  $("[data-wipe-go]", wipeBox).addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    const files = $("input[name=files]", wipeBox).checked;
    const n = meta ? meta.papers.length : 0;
    const typed = window.prompt(
      `This deletes ${plural(n, "past paper")} and all their questions, ${plural(meta ? meta.docs.length : 0, "exam document")}, the paper guides and the year notes${files ? ", and moves the exam files to the vault's trash" : ""}. It cannot be undone.\n\nType the vault's name to confirm:`,
      "",
    );
    if (typed === null) return;
    btn.disabled = true;
    try {
      const r = await api("POST", "practice/wipe", { confirm: typed, files });
      await loadMeta();
      alertBox($("div", wipeBox), `Cleared: ${plural(r.papers, "paper")} (${plural(r.questions, "question")}), ${plural(r.docs, "document")}, ${plural(r.guides, "guide")}, ${plural(r.years, "year")} of notes${r.filesMoved ? "; the exam files are in the vault's trash" : ""}.`, "ok");
    } catch (err) {
      alertBox($("div", wipeBox), err.message);
    } finally {
      btn.disabled = false;
    }
  });
  const wipeAnswers = $("[data-wipe-answers]");
  $("[data-wipe-answers-go]", wipeAnswers).addEventListener("click", async (e) => {
    if (!(await window.UI.confirm({ title: "Delete every answer in this vault?", body: "Every answer anyone has given here is deleted, with the marks and feedback. Everyone's history and exam coach results start again from nothing.\n\nThis cannot be undone.", confirm: "Delete every answer", danger: true }))) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const r = await api("POST", "practice/history/clear", { everyone: true });
      alertBox($("div", wipeAnswers), `Cleared ${plural(r.sessions, "set")} of questions (${plural(r.answers, "answer")}).`, "ok");
    } catch (err) {
      alertBox($("div", wipeAnswers), err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- jobs: papers and documents being read ----------
  const seenDone = new Set();
  const seenProgress = new Map();
  let listsRefreshed = 0;
  const openJobs = new Set();
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
      const finished = ["done", "failed", "cancelled"].includes(b.status);
      if (finished && !seenDone.has(b.id)) { seenDone.add(b.id); if (seenDone.ready) loadMeta().catch(() => {}); }
      // While a zip is being added, show each paper and document in the lists as it is saved.
      const done = (steps.file && steps.file.done) || 0;
      if (b.status === "running" && done > (seenProgress.get(b.id) || 0)) {
        seenProgress.set(b.id, done);
        if (Date.now() - listsRefreshed > 10000) { listsRefreshed = Date.now(); loadMeta().catch(() => {}); }
      }
    }
    seenDone.ready = true;
    if (active || recent.some((b) => b.status === "queued")) jobsTimer = window.setTimeout(loadPaperJobs, 3000);
  }

  // ---------- start ----------
  loadMeta()
    .then(loadPaperJobs)
    .catch((e) => alertBox(host, `The page could not load: ${e.message}`));
})();
