// Sources page: add Word and PowerPoint files to a vault, and remove them again.
//
// This runs Microsidian's own code (the Obsidian plugin in ../../microsidian) in the browser: the converter, the
// catalogue, the request to Claude, the checks on its answer and the filing. Only two things differ from the plugin:
// vault files are read and written through the site's API (SiteIO below), and the request to Claude goes to this
// server, which adds the API key and applies the model and effort an admin chose. The key never reaches the browser.
import { convertOffice } from "../../microsidian/src/convert";
import { buildCatalogue } from "../../microsidian/src/ai/catalogue";
import { callClaude, explainError } from "../../microsidian/src/ai/claude";
import { validate } from "../../microsidian/src/ingest/proposal";
import { applyIngest } from "../../microsidian/src/vault/apply";
import { under } from "../../microsidian/src/config";
import { parseFrontmatter } from "../../microsidian/src/vault/vaultio";
import JSZip from "jszip";

// Files chosen on the New vault page wait here (in this browser only) until the new vault's Sources page picks
// them up. A page cannot hand files to the next page any other way.
const handoff = {
  open() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("vault-share", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("first-sources");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  },
  async run(mode, fn) {
    const db = await this.open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction("first-sources", mode);
        const req = fn(tx.objectStore("first-sources"));
        tx.oncomplete = () => resolve(req && req.result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  put(vault, files) { return this.run("readwrite", (s) => s.put(files, vault)); },
  async take(vault) {
    const files = await this.run("readonly", (s) => s.get(vault));
    if (files) await this.run("readwrite", (s) => s.delete(vault));
    return Array.isArray(files) ? files : [];
  },
};

// ---------- New vault page ----------
(() => {
  "use strict";
  const form = document.querySelector("form[data-new-vault]");
  if (!form) return;
  const zipEl = form.querySelector('input[name="vault_zip"]');
  const srcEl = form.querySelector("[data-first-sources]");
  const dropEl = form.querySelector("[data-drop]");
  const dropText = form.querySelector("[data-drop-text]");
  const emptyText = dropText ? dropText.innerHTML : "";
  const mode = () => (form.querySelector('input[name="mode"]:checked') || {}).value;
  const isSource = (f) => /\.(docx|pptx|zip)$/i.test(f.name) && !f.name.startsWith("~$");
  let chosen = [];

  function show() {
    if (!dropText) return;
    if (!chosen.length) { dropText.innerHTML = emptyText; dropEl.classList.remove("has-files"); return; }
    dropEl.classList.add("has-files");
    const names = chosen.slice(0, 3).map((f) => f.name).join(", ");
    dropText.textContent = `${chosen.length} file${chosen.length === 1 ? "" : "s"}: ${names}${chosen.length > 3 ? ", …" : ""}`;
  }
  function choose(files) {
    const ok = files.filter(isSource);
    if (ok.length < files.length) window.alert("Only .docx, .pptx and .zip files can be added. The others were left out.");
    chosen = ok;
    show();
  }

  if (srcEl) srcEl.addEventListener("change", () => choose([...srcEl.files]));
  if (dropEl && srcEl && !srcEl.disabled) {
    const over = (on) => dropEl.classList.toggle("is-over", on);
    dropEl.addEventListener("dragover", (e) => { e.preventDefault(); over(true); });
    dropEl.addEventListener("dragleave", () => over(false));
    dropEl.addEventListener("drop", (e) => {
      e.preventDefault();
      over(false);
      if (e.dataTransfer && e.dataTransfer.files.length) choose([...e.dataTransfer.files]);
    });
  }
  // Whatever was picked for the other way of starting is dropped, so it cannot be sent by mistake.
  form.querySelectorAll('input[name="mode"]').forEach((r) =>
    r.addEventListener("change", () => {
      if (mode() === "zip") { chosen = []; if (srcEl) srcEl.value = ""; show(); }
      else if (zipEl) zipEl.value = "";
      if (zipEl) zipEl.required = mode() === "zip";
    }),
  );

  form.addEventListener("submit", async (e) => {
    if (mode() !== "scratch" || !chosen.length) return; // an ordinary form post
    e.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    btn.disabled = true;
    btn.textContent = "Creating…";
    try {
      const res = await fetch(form.action, { method: "POST", credentials: "same-origin", body: new FormData(form) });
      const m = new URL(res.url).pathname.match(/^\/v\/([0-9a-f]{32})\/sources$/);
      if (!res.ok || !m) throw new Error("not created");
      try {
        await handoff.put(m[1], chosen);
      } catch (err) {
        console.error("[new vault] could not keep the files for the next page", err);
        window.alert("The vault was created, but this browser could not carry the files over. Add them on the next page.");
      }
      window.location.href = res.url;
    } catch {
      btn.disabled = false;
      btn.textContent = "Create vault";
      window.alert("The vault could not be created. Check the name and try again.");
    }
  });
})();

// ---------- Sources page ----------
(() => {
  "use strict";
  const host = document.querySelector("[data-sources]");
  if (!host) return;

  const vault = host.dataset.vault;
  const csrf = host.dataset.csrf;
  const configured = host.dataset.configured === "1";
  const base = `/v/${vault}`;
  const OFFICE = ["docx", "pptx"];

  const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");
  const basename = (p) => p.split("/").pop();
  const extOf = (p) => (p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "");

  // ---------- API ----------
  class ApiError extends Error {
    constructor(status, message, body) { super(message); this.status = status; this.body = body; }
  }

  async function api(method, path, { json, body, query } = {}) {
    const qs = query ? "?" + new URLSearchParams(query).toString() : "";
    const headers = { "X-CSRF-Token": csrf };
    if (json !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${base}/api/${path}${qs}`, {
      method,
      credentials: "same-origin",
      headers,
      body: json !== undefined ? JSON.stringify(json) : body,
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const msg = (data && data.error) || (res.status === 401 ? "Your session expired. Reload the page and sign in again." : `The server answered ${res.status}.`);
      throw new ApiError(res.status, msg, data);
    }
    return data;
  }

  // ---------- vault access for Microsidian's code ----------
  // Holds the text of every note, fetched in one request, so reads are local. Writes go to the server.
  class SiteIO {
    constructor(layout) {
      this.layout = layout;
      this.files = new Set();
      this.notes = new Map();
      this.pending = null; // { path, bytes }: the file being added, which is not on the server yet
    }

    async load() {
      const c = await api("GET", "ingest/corpus");
      this.files = new Set(c.files);
      this.notes = new Map(Object.entries(c.notes));
    }

    async exists(path) {
      return this.files.has(path) || (!!this.pending && this.pending.path === path);
    }

    async read(path) {
      if (this.notes.has(path)) return this.notes.get(path);
      const n = await api("GET", "note", { query: { path } });
      this.notes.set(path, n.content);
      return n.content;
    }

    async save(path, text, etag) {
      await api("PUT", "note", { json: etag ? { path, content: text, etag } : { path, content: text } });
      this.notes.set(path, text);
      this.files.add(path);
    }

    async write(path, text) {
      let etag;
      if (this.files.has(path)) etag = (await api("GET", "note", { query: { path } })).etag;
      await this.save(path, text, etag);
    }

    // Read, change and save. If someone else saved the note in between, start again from their version.
    async edit(path, fn) {
      for (let attempt = 0; ; attempt++) {
        const cur = await api("GET", "note", { query: { path } });
        const next = fn(cur.content);
        if (next === cur.content) { this.notes.set(path, cur.content); return; }
        try {
          await this.save(path, next, cur.etag);
          return;
        } catch (e) {
          if (!(e instanceof ApiError) || e.status !== 409 || attempt >= 2) throw e;
        }
      }
    }

    async rename(from, to) {
      if (this.pending && this.pending.path === from) {
        // Filing the new source: this is the moment it is uploaded, straight to where it belongs.
        await this.writeBinary(to, this.pending.bytes);
        this.pending = { path: to, bytes: this.pending.bytes };
        return;
      }
      await api("POST", "rename", { json: { from, to, update_links: false } });
      this.files.delete(from);
      this.files.add(to);
      if (this.notes.has(from)) { this.notes.set(to, this.notes.get(from)); this.notes.delete(from); }
    }

    async readBinary(path) {
      if (this.pending && this.pending.path === path) return this.pending.bytes;
      const res = await fetch(`${base}/f/${encodePath(path)}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`Could not read ${path}.`);
      return new Uint8Array(await res.arrayBuffer());
    }

    async writeBinary(path, data) {
      await api("PUT", "ingest/file", { query: { path }, body: data });
      this.files.add(path);
    }

    markdownPaths() {
      const { originals, attachments, ingest } = this.layout;
      const skip = [originals, attachments.split("/")[0], ingest];
      return [...this.notes.keys()].filter((p) => !skip.some((s) => under(p, s)) && !p.split("/").some((seg) => seg.startsWith(".")));
    }

    // A bare link name such as "Topics - Index" to a note path, the way Obsidian resolves it.
    resolve(name) {
      if (this.notes.has(`${name}.md`)) return `${name}.md`;
      const want = `${basename(name)}.md`.toLowerCase();
      const hits = [...this.notes.keys()].filter((p) => basename(p).toLowerCase() === want);
      hits.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b));
      return hits[0] ?? null;
    }
  }

  // The SDK's request, sent to this server instead of to Anthropic.
  function serverFetch(_url, init = {}) {
    const beta = new Headers(init.headers || {}).get("anthropic-beta");
    const headers = { "Content-Type": "application/json", "X-CSRF-Token": csrf };
    if (beta) headers["anthropic-beta"] = beta;
    return fetch(`${base}/api/ingest/claude`, { method: "POST", credentials: "same-origin", headers, body: init.body, signal: init.signal });
  }

  function explain(e) {
    if (e instanceof ApiError) return e.message;
    if (e && e.status === 401) return "The Anthropic API key is missing or was rejected. An admin can fix it under Admin → Microsidian.";
    if (e && e.status === 403 && /expired|csrf/i.test(String(e.message))) return "Your session expired. Reload the page and try again.";
    return explainError(e).replace("in the plugin settings", "under Admin → Microsidian");
  }

  // ---------- adding ----------
  const jobsEl = host.querySelector("[data-jobs]");
  const pickEl = host.querySelector("[data-pick]");
  const dropEl = host.querySelector("[data-drop]");
  let cfg = null;
  const queue = [];
  let busy = false;

  function jobRow(name) {
    const li = document.createElement("li");
    li.className = "job is-waiting";
    const title = document.createElement("strong");
    title.textContent = name;
    const status = document.createElement("span");
    status.className = "job-status";
    status.textContent = "Waiting…";
    const detail = document.createElement("div");
    detail.className = "job-detail small muted";
    li.append(title, status, detail);
    jobsEl.prepend(li);
    return {
      set(state, text) { li.className = `job is-${state}`; status.textContent = text; },
      detail(nodes) { detail.replaceChildren(...nodes); },
    };
  }

  // Running totals for this visit, shown above the list while a batch is going through.
  const progressEl = host.querySelector("[data-progress]");
  const tally = { total: 0, filed: 0, left: 0 };
  function showTally() {
    if (!progressEl) return;
    progressEl.hidden = tally.total < 2;
    const settled = tally.filed + tally.left;
    progressEl.textContent =
      (settled < tally.total ? `Filing ${Math.min(settled + 1, tally.total)} of ${tally.total}` : `Finished ${tally.total}`) +
      ` · ${tally.filed} filed` + (tally.left ? ` · ${tally.left} not added` : "");
  }
  function addJob(name, title, get) {
    tally.total++;
    queue.push({ name, row: jobRow(title), get });
  }

  const isOffice = (name) => OFFICE.includes(extOf(name)) && !basename(name).startsWith("~$");

  // Every Word and PowerPoint file inside a zip, in any subfolder, becomes a source. Each one is unpacked only
  // when its turn comes, so a big zip is never held in memory twice over.
  async function openZip(file) {
    const row = jobRow(file.name);
    row.set("working", "Opening the zip…");
    let zip;
    try {
      zip = await JSZip.loadAsync(file);
    } catch {
      row.set("failed", "Not added: this zip could not be opened.");
      return;
    }
    const entries = Object.values(zip.files)
      .filter((e) => !e.dir && isOffice(e.name) && !e.name.split("/").some((seg) => seg.startsWith(".") || seg === "__MACOSX"))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (!entries.length) {
      row.set("failed", "Not added: no .docx or .pptx files were found in this zip.");
      return;
    }
    row.set("done", `${entries.length} file${entries.length === 1 ? "" : "s"} found`);
    for (const entry of entries) {
      const name = basename(entry.name);
      addJob(name, entry.name, async () => new File([await entry.async("uint8array")], name));
    }
  }

  async function enqueue(files) {
    for (const file of files) {
      if (extOf(file.name) === "zip") {
        await openZip(file);
      } else if (isOffice(file.name)) {
        addJob(file.name, file.name, async () => file);
      } else {
        jobRow(file.name).set("failed", "Not added: only .docx, .pptx and .zip files can be added.");
      }
    }
    showTally();
    void pump();
  }

  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length) {
        const job = queue.shift();
        try {
          const filed = await addSource(await job.get(), job.row);
          if (filed) tally.filed++; else tally.left++;
        } catch (e) {
          console.error("[sources] could not add", job.name, e);
          job.row.set("failed", `Not added: ${explain(e)}`);
          tally.left++;
        }
        showTally();
      }
    } finally {
      busy = false;
      void refreshList();
    }
  }

  async function addSource(file, row) {
    if (!cfg) cfg = await api("GET", "ingest/config");
    if (!cfg.configured) throw new Error("No Anthropic API key is set. An admin can add one under Admin → Microsidian.");
    if (file.size > cfg.maxFileBytes) throw new Error(`Files can be at most ${Math.floor(cfg.maxFileBytes / 1048576)} MB.`);
    const layout = cfg.layout;
    const ext = extOf(file.name);
    const convertOpts = { imageMinBytes: cfg.imageMinKB * 1000, isLogo: () => false, attachmentsDir: layout.attachments };

    row.set("working", "Reading the file…");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const res = await convertOffice(bytes, ext, convertOpts);

    row.set("working", "Looking through the vault…");
    const io = new SiteIO(layout);
    await io.load();
    const cat = await buildCatalogue(io, layout);

    row.set("working", "Asking Claude where it belongs…");
    const outcome = await callClaude({
      apiKey: "held-by-the-server",
      fetch: serverFetch,
      effort: cfg.effort,
      catalogue: cat,
      guidance: cfg.guidance,
      fileName: file.name,
      documentText: res.body,
    });
    const proposal = validate(outcome.analysis, cat, res.body, layout);
    if (!proposal.suitable) {
      row.set("skipped", `Not added: ${proposal.reason || "the filing guidance says not to file this kind of document."}`);
      return false;
    }

    row.set("working", "Filing it…");
    const ingestPath = `${layout.ingest}/${file.name}`;
    io.pending = { path: ingestPath, bytes };
    const report = await applyIngest(
      {
        io,
        cat,
        layout,
        updateFolderIndexes: cfg.updateFolderIndexes,
        convert: async (path) => {
          const out = await convertOffice(await io.readBinary(path), ext, { ...convertOpts, originalPath: path });
          for (const img of out.images) if (!(await io.exists(img.path))) await io.writeBinary(img.path, img.data);
          return out;
        },
      },
      ingestPath,
      proposal,
    );

    const link = document.createElement("a");
    link.href = `${base}/n/${encodePath(report.notePath)}`;
    link.textContent = report.notePath.slice(0, -3);
    const topics = proposal.topics.length + proposal.newTopics.length;
    const u = outcome.usage;
    const bits = [
      `${topics} topic${topics === 1 ? "" : "s"}`,
      `${proposal.related.length} related note${proposal.related.length === 1 ? "" : "s"}`,
      `${report.changed.length} files updated`,
      `${(u.input + u.cacheRead).toLocaleString()} tokens in, ${u.output.toLocaleString()} out`,
    ];
    const notes = [...report.warnings];
    if (outcome.fallbackUsed) notes.push("A substitute model was used because the first declined.");
    if (cat.omitted) notes.push(`This vault is large: ${cat.omitted} notes were not shown to Claude.`);
    row.set("done", "Filed");
    row.detail([link, document.createTextNode(` · ${bits.join(" · ")}${notes.length ? ". " + notes.join(" ") : ""}`)]);
    return true;
  }

  if (pickEl) {
    pickEl.addEventListener("change", () => {
      enqueue([...pickEl.files]);
      pickEl.value = "";
    });
  }
  if (dropEl && configured) {
    const over = (on) => dropEl.classList.toggle("is-over", on);
    dropEl.addEventListener("dragover", (e) => { e.preventDefault(); over(true); });
    dropEl.addEventListener("dragleave", () => over(false));
    dropEl.addEventListener("drop", (e) => {
      e.preventDefault();
      over(false);
      if (e.dataTransfer && e.dataTransfer.files.length) enqueue([...e.dataTransfer.files]);
    });
  }
  window.addEventListener("beforeunload", (e) => { if (busy) e.preventDefault(); });

  // ---------- the list, and removing ----------
  const listEl = host.querySelector("[data-list]");
  const listStatus = host.querySelector("[data-list-status]");

  async function refreshList() {
    try {
      if (!cfg) cfg = await api("GET", "ingest/config");
      const io = new SiteIO(cfg.layout);
      await io.load();
      const originals = [...io.files].filter((p) => under(p, cfg.layout.originals) && OFFICE.includes(extOf(p))).sort((a, b) => a.localeCompare(b));
      const noteFor = new Map();
      for (const [path, text] of io.notes) {
        const src = parseFrontmatter(text).source;
        if (typeof src === "string" && src) noteFor.set(src, path);
      }
      const body = listEl.tBodies[0];
      body.replaceChildren();
      for (const path of originals) {
        const tr = document.createElement("tr");
        const inner = path.slice(cfg.layout.originals.length + 1);
        const folder = inner.includes("/") ? inner.slice(0, inner.lastIndexOf("/")) : "";

        const tdSrc = document.createElement("td");
        const a = document.createElement("a");
        a.href = `${base}/o/${encodePath(path)}`;
        a.textContent = basename(path);
        tdSrc.append(a);
        if (folder) {
          const f = document.createElement("div");
          f.className = "small muted";
          f.textContent = folder;
          tdSrc.append(f);
        }

        const tdNote = document.createElement("td");
        const note = noteFor.get(path);
        if (note) {
          const n = document.createElement("a");
          n.href = `${base}/n/${encodePath(note)}`;
          n.textContent = basename(note).slice(0, -3);
          tdNote.append(n);
        } else {
          tdNote.className = "muted";
          tdNote.textContent = "no note";
        }

        const tdAct = document.createElement("td");
        tdAct.className = "actions";
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "danger";
        btn.textContent = "Remove";
        btn.addEventListener("click", () => removeSource(io, path, note, btn));
        tdAct.append(btn);

        tr.append(tdSrc, tdNote, tdAct);
        body.append(tr);
      }
      listEl.hidden = originals.length === 0;
      listStatus.hidden = originals.length > 0;
      listStatus.textContent = "No sources yet.";
    } catch (e) {
      listStatus.hidden = false;
      listStatus.textContent = `Could not load the sources: ${explain(e)}`;
    }
  }

  async function removeSource(io, original, note, btn) {
    if (busy) return;
    const what = note ? `“${basename(original)}” and its note “${basename(note).slice(0, -3)}”` : `“${basename(original)}”`;
    if (!window.confirm(`Remove ${what} from this vault? They move to the vault's trash.`)) return;
    btn.disabled = true;
    btn.textContent = "Removing…";
    try {
      if (note) {
        // Take the note out of topic pages, index notes and other notes' Connections: list lines that link to it.
        const key = note.slice(0, -3);
        const links = [`[[${key}|`, `[[${key}]]`, `[[${key}#`];
        const mentions = (line) => /^\s*[-*] /.test(line) && links.some((l) => line.includes(l));
        for (const [path, text] of io.notes) {
          if (path === note || !links.some((l) => text.includes(l))) continue;
          await io.edit(path, (t) => {
            const nl = t.includes("\r\n") ? "\r\n" : "\n";
            const lines = t.split(/\r?\n/);
            const kept = lines.filter((line) => !mentions(line));
            return kept.length === lines.length ? t : kept.join(nl);
          });
        }
        await api("POST", "delete", { json: { path: note } });
      }
      await api("POST", "delete", { json: { path: original } });
    } catch (e) {
      window.alert(`Could not remove it: ${explain(e)}`);
    }
    await refreshList();
  }

  void refreshList();

  // Files chosen while creating this vault: start on them straight away.
  if (configured) {
    handoff.take(vault).then((files) => { if (files.length) enqueue(files); }).catch(() => { /* nothing waiting */ });
  }
})();
