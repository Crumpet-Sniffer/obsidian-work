// Sources page: add Word and PowerPoint files to a vault, and remove them again.
//
// Adding is done by the server in the background: this page uploads the files as one batch and then shows the
// progress the server reports (see src/handlers/batches.rs and the worker in ./worker). Removing is done here,
// through the site's API.
import { under } from "../../microsidian/src/config";
import { parseFrontmatter } from "../../microsidian/src/vault/vaultio";
import JSZip from "jszip";
import { cullZip } from "./worker/cull.js";

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
  const isSource = (f) => /\.(docx|pptx|pdf|zip|png|jpe?g|gif|webp)$/i.test(f.name) && !f.name.startsWith("~$");
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
    if (ok.length < files.length) window.alert("Only Word, PowerPoint, PDF, picture and .zip files can be added. The others were left out.");
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
  const OFFICE = ["docx", "pptx", "pdf"];

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

  function explain(e) {
    if (e instanceof ApiError) return e.message;
    return e && e.message ? e.message : String(e);
  }

  // ---------- adding ----------
  // The files are uploaded to the server as one batch, and the server files them in the background (its ingest
  // worker: see src/handlers/batches.rs). This page only uploads and then shows the progress the server reports,
  // so it can be closed once the upload has finished, and opened again later, from any browser, to see how it went.
  const jobsEl = host.querySelector("[data-jobs]");
  const pickEl = host.querySelector("[data-pick]");
  const dropEl = host.querySelector("[data-drop]");
  const batchesEl = host.querySelector("[data-batches]");
  let cfg = null;
  let uploading = 0; // batches being uploaded from this page
  const local = new Map(); // batch id -> { sent, total } while this page uploads it
  const opened = new Set(); // batches whose file list is open
  let batches = [];
  let workerRunning = true;
  let received = 0; // when the last list arrived (for the planning clock)
  let pollTimer = 0;

  const PICTURES = ["png", "jpg", "jpeg", "gif", "webp"];
  const isOffice = (name) => OFFICE.includes(extOf(name)) && !basename(name).startsWith("~$");
  const isPicture = (name) => PICTURES.includes(extOf(name));
  const isSource = (f) => (isOffice(f.name) || isPicture(f.name) || extOf(f.name) === "zip") && !f.name.startsWith(".");

  function make(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  // A <progress>: a number from 0 to 1 fills it, null makes it a moving "working" bar.
  function bar(cls, p) {
    const b = make("progress", cls);
    b.max = 1;
    if (p !== null) b.value = Math.max(0, Math.min(1, p));
    return b;
  }

  const mb = (n) => `${(n / 1048576).toFixed(n < 10 * 1048576 ? 1 : 0)} MB`;
  const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const active = (b) => b.status === "uploading" || b.status === "queued" || b.status === "running";

  // One line for a file that could not be added before any upload (wrong type, too large).
  function rejectRow(name, text) {
    const li = make("li", "job is-failed");
    li.append(make("strong", "", name), make("span", "job-status", text));
    jobsEl.prepend(li);
  }

  // Files go up in pieces of this size, so no request is over the 100 MB a proxy in front of the site may accept
  // (Cloudflare's free plan). The server joins them up.
  const CHUNK = 64 * 1024 * 1024;

  // One piece of a file. XMLHttpRequest, because fetch cannot report upload progress.
  function sendChunk(bid, file, offset, onSent) {
    return new Promise((resolve, reject) => {
      const end = Math.min(offset + CHUNK, file.size);
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `${base}/api/ingest/batches/${bid}/files`);
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
        else if (xhr.status === 413) reject(new ApiError(413, (data && data.error) || "This file is too large for the server or the connection to it."));
        else reject(new ApiError(xhr.status, (data && data.error) || `The server answered ${xhr.status}.`));
      };
      xhr.onerror = () => reject(Object.assign(new Error("The upload was interrupted. Check your connection and try again."), { network: true }));
      const form = new FormData();
      form.append("chunk", file.slice(offset, end), "chunk");
      xhr.send(form);
    });
  }

  // Upload one file of a batch in pieces, reporting bytes sent. A piece lost to the network is sent again (up to
  // three times in a row); if the server already has more or less of the file, carry on from where it is.
  async function sendFile(bid, file, onSent) {
    let offset = 0;
    let failures = 0;
    for (;;) {
      let r;
      try {
        r = await sendChunk(bid, file, offset, onSent);
      } catch (e) {
        if (!e.network || ++failures > 3) throw e;
        await new Promise((ok) => setTimeout(ok, 2000 * failures));
        continue;
      }
      failures = 0;
      offset = r.received;
      onSent(offset);
      if (offset >= file.size && !r.resync) return r;
    }
  }

  // One line saying what culling a zip did.
  function noteRow(name, text, failed) {
    const li = make("li", failed ? "job is-failed" : "job is-done");
    li.append(make("strong", "", name), make("span", "job-status", text));
    jobsEl.prepend(li);
    return li;
  }

  // Zips this page culls itself before uploading (larger ones are sent whole and culled on the server, so a
  // browser never has to hold a huge zip in memory).
  const CULL_IN_BROWSER = 400 * 1024 * 1024;

  /**
   * Cull a zip: keep only its resource files (Word, PowerPoint and pictures that are not icons), from any
   * subfolder, and pack them into a new zip with the same folders. Returns the File to upload, or null when
   * nothing in it can be added. A zip with nothing to cull is uploaded as it is.
   */
  async function cullBeforeUpload(f) {
    if (f.size > CULL_IN_BROWSER) return f;
    const row = noteRow(f.name, "Looking through the zip…");
    let zip;
    try {
      zip = await JSZip.loadAsync(f);
    } catch {
      row.remove();
      rejectRow(f.name, "Not added: this zip could not be opened.");
      return null;
    }
    const { kept, culled, summary } = cullZip(zip, { imageMinBytes: (cfg.imageMinKB || 0) * 1000 });
    if (!kept.length) {
      row.remove();
      rejectRow(f.name, `Not added: no Word, PowerPoint, PDF or picture files were found in it.${summary ? ` Culled: ${summary}.` : ""}`);
      return null;
    }
    const status = row.querySelector(".job-status");
    if (!culled) {
      status.textContent = `${kept.length} resource file${kept.length === 1 ? "" : "s"}, nothing to cull`;
      return f;
    }
    status.textContent = `Culling ${culled} file${culled === 1 ? "" : "s"}…`;
    const out = new JSZip();
    for (const k of kept) out.file(k.path, await k.e.async("uint8array"), { date: k.e.date, binary: true });
    // Word, PowerPoint and pictures are already compressed: storing them is as small and much faster.
    const blob = await out.generateAsync({ type: "blob", compression: "STORE" });
    const saved = f.size - blob.size;
    status.textContent = `${kept.length} resource file${kept.length === 1 ? "" : "s"} kept · culled ${summary}${saved >= 1048576 ? ` (${mb(saved)} not uploaded)` : ""}`;
    return new File([blob], f.name, { type: "application/zip" });
  }

  async function enqueue(files) {
    if (!cfg) cfg = await api("GET", "ingest/config");
    const ok = [];
    for (const f of files) {
      if (!isSource(f)) rejectRow(f.name, "Not added: only Word (.docx), PowerPoint (.pptx), PDF, pictures (.png, .jpg, .gif, .webp) and .zip files can be added.");
      else if ((isOffice(f.name) || isPicture(f.name)) && f.size > cfg.maxFileBytes) rejectRow(f.name, `Not added: files can be at most ${Math.floor(cfg.maxFileBytes / 1048576)} MB.`);
      else if (extOf(f.name) === "zip") {
        const z = await cullBeforeUpload(f);
        if (z) ok.push(z);
      } else ok.push(f);
    }
    if (!ok.length) return;

    uploading++;
    let bid = null;
    try {
      bid = (await api("POST", "ingest/batches")).id;
      const total = ok.reduce((n, f) => n + f.size, 0);
      const up = { sent: 0, total, names: ok.map((f) => f.name) };
      local.set(bid, up);
      opened.add(bid);
      await refreshBatches();
      let done = 0;
      for (const f of ok) {
        await sendFile(bid, f, (loaded) => { up.sent = done + loaded; render(); });
        done += f.size;
        up.sent = done;
        render();
      }
      await api("POST", `ingest/batches/${bid}/start`);
    } catch (e) {
      console.error("[sources] upload failed", e);
      if (bid) {
        try { await api("POST", `ingest/batches/${bid}/cancel`); } catch { /* already gone */ }
      }
      rejectRow(ok.length === 1 ? ok[0].name : `${ok.length} files`, `Not added: ${explain(e)}`);
    } finally {
      uploading--;
      if (bid) local.delete(bid);
      await refreshBatches();
    }
  }

  async function cancelBatch(b, btn) {
    if (!window.confirm(b.status === "running"
      ? "Stop this batch? Files already filed stay in the vault; the rest are not added."
      : "Cancel this batch? None of its files will be added.")) return;
    btn.disabled = true;
    try {
      await api("POST", `ingest/batches/${b.id}/cancel`);
    } catch (e) {
      window.alert(`Could not stop it: ${explain(e)}`);
    }
    await refreshBatches();
  }

  // ---------- showing the batches ----------
  const STATUS = { uploading: "Uploading", queued: "Waiting to start", running: "Being added", done: "Finished", failed: "Failed", cancelled: "Stopped" };

  function steps(b) {
    const p = b.progress || {};
    const s = p.steps || {};
    const up = local.get(b.id);
    const out = [];
    // Uploading (this page's own count, or done once the server has the batch)
    if (up) out.push({ label: `Uploading ${up.names.length} file${up.names.length === 1 ? "" : "s"} to the server`, state: "working", frac: up.total ? up.sent / up.total : 0, count: `${mb(up.sent)} of ${mb(up.total)}` });
    else if (b.status === "uploading") out.push({ label: "Uploading the files to the server", state: "working", frac: null, count: "", note: `Being uploaded by ${b.by} from another page` });
    else if (!b.files.length) out.push({ label: "The files were not uploaded", state: "failed", frac: 0, count: "" });
    else out.push({ label: `Uploaded ${b.files.length} file${b.files.length === 1 ? "" : "s"}`, state: "done", frac: 1, count: "Done" });
    if (b.status === "uploading" || b.status === "queued" || !s.read) {
      for (const label of ["Reading the files and the text in their pictures", "Claude plans the batch and connects each file, then it is filed"]) {
        out.push({ label, state: b.status === "cancelled" || b.status === "failed" ? "failed" : "waiting", frac: 0, count: b.status === "queued" ? "Waiting" : "" });
      }
      return out;
    }
    const counted = (st, label) => {
      const of = st.of || 0;
      const working = st.state === "working";
      return {
        label,
        state: st.state,
        frac: of ? Math.min(1, st.done / of) : st.state === "done" ? 1 : 0,
        count: st.state === "waiting" ? "Waiting" : of ? (st.done >= of ? `${of} of ${of}` : `${Math.floor(st.done) + 1} of ${of}`) : st.state === "done" ? "Done" : "",
        note: working ? st.note : "",
      };
    };
    out.push(counted(s.read, "Reading the files and the text in their pictures"));
    if (p.planned) {
      const pl = s.plan;
      const elapsed = (pl.elapsed || 0) + (pl.state === "working" ? (Date.now() - received) / 1000 : 0);
      out.push({
        label: `Claude reads all ${s.read.of} files together and plans their topics and folders`,
        state: pl.state,
        frac: pl.state === "working" ? null : pl.state === "waiting" ? 0 : 1,
        count: pl.state === "working" ? clock(elapsed) : pl.state === "done" ? "Done" : pl.state === "waiting" ? "Waiting" : "Skipped",
        note: pl.note,
        timer: pl.state === "working" ? pl.elapsed || 0 : null,
      });
    }
    out.push(counted(s.file, "Claude connects each file to the vault and the rest of the batch, then it is filed"));
    return out;
  }

  function batchView(b) {
    const list = steps(b);
    const overall = list.reduce((n, s) => n + (s.frac === null ? 0.5 : s.frac), 0) / list.length;
    const done = !active(b);
    const box = make("section", `batch is-${b.status}`);
    const head = make("div", "batch-head");
    const p = b.progress || {};
    const title = done
      ? `${STATUS[b.status]}${p.summary ? ` · ${p.summary}` : ""}`
      : `${STATUS[b.status]} · ${b.files.length} file${b.files.length === 1 ? "" : "s"}`;
    // A batch that finished cleanly is one line: what it filed, who added it and when. Its steps (all full
    // bars) only matter while it runs, or to see where a failed one stopped.
    const compact = b.status === "done";
    if (compact) box.classList.add("is-compact");
    head.append(make("strong", "", title), make("span", "batch-pct", done ? "" : `${Math.floor(overall * 100)}%`));
    box.append(head);
    if (!compact) box.append(bar("batch-bar", done ? 1 : overall));

    const ol = make("ol", "batch-steps");
    if (compact) ol.hidden = true;
    for (const s of list) {
      const li = make("li", `batch-step is-${s.state}`);
      const count = make("span", "batch-count", s.count);
      if (s.timer !== null && s.timer !== undefined) count.dataset.timer = String(s.timer);
      li.append(make("span", "batch-label", s.label), count, bar("", s.frac), make("span", "batch-note", s.note || ""));
      ol.append(li);
    }
    box.append(ol);

    const foot = make("div", "batch-foot small muted");
    const when = new Date(b.createdAt * 1000).toLocaleString();
    foot.append(make("span", "", `Added by ${b.by} · ${when}`));
    if (active(b) && !done && (b.mine || host.dataset.admin === "1") && !b.cancelRequested && !local.has(b.id)) {
      const stop = make("button", "linklike", b.status === "running" ? "Stop" : "Cancel");
      stop.type = "button";
      stop.addEventListener("click", () => cancelBatch(b, stop));
      foot.append(stop);
    }
    if (b.cancelRequested && active(b)) foot.append(make("span", "", " · stopping after the current file…"));
    box.append(foot);

    const files = p.files || [];
    if (files.length) {
      const det = make("details", "batch-files");
      det.open = opened.has(b.id);
      det.addEventListener("toggle", () => { if (det.open) opened.add(b.id); else opened.delete(b.id); });
      const failed = files.filter((f) => f.state === "failed" || f.state === "skipped").length;
      det.append(make("summary", "", `${files.length} file${files.length === 1 ? "" : "s"}${failed ? ` · ${failed} not added` : ""}`));
      const ul = make("ul", "jobs");
      for (const f of files) {
        const li = make("li", `job is-${f.state}`);
        li.append(make("strong", "", f.name), make("span", "job-status", f.text));
        if (f.state === "working" && "bar" in f) li.append(bar("job-bar", f.bar));
        if (f.link || f.detail) {
          const d = make("div", "job-detail small muted");
          if (f.link) {
            const a = make("a", "", f.link.replace(/\.md$/, ""));
            a.href = `${base}/n/${encodePath(f.link)}`;
            d.append(a);
          }
          if (f.detail) d.append(document.createTextNode(`${f.link ? " · " : ""}${f.detail}`));
          li.append(d);
        }
        ul.append(li);
      }
      det.append(ul);
      box.append(det);
    }
    return box;
  }

  function render() {
    if (!batchesEl) return;
    const nodes = [];
    const waiting = batches.some((b) => b.status === "queued");
    if (waiting && !workerRunning) {
      nodes.push(make("p", "alert error", "The server's ingest worker is not running, so these files are waiting. An admin can check the server's logs."));
    }
    for (const b of batches) nodes.push(batchView(b));
    batchesEl.replaceChildren(...nodes);
    batchesEl.hidden = nodes.length === 0;
  }

  // The planning clock keeps going between polls.
  window.setInterval(() => {
    if (!batchesEl) return;
    for (const el of batchesEl.querySelectorAll("[data-timer]")) el.textContent = clock(Number(el.dataset.timer) + (Date.now() - received) / 1000);
  }, 1000);

  let lastActive = new Set();
  async function refreshBatches() {
    window.clearTimeout(pollTimer);
    try {
      const r = await api("GET", "ingest/batches");
      batches = r.batches;
      workerRunning = r.worker.running;
      received = Date.now();
      render();
      // When a batch finishes, the list of sources below changes.
      const now = new Set(batches.filter(active).map((b) => b.id));
      if ([...lastActive].some((id) => !now.has(id))) void refreshList();
      lastActive = now;
    } catch (e) {
      console.error("[sources] could not load the batches", e);
    }
    // Watch closely while something is happening; otherwise look now and then (another page may add files).
    pollTimer = window.setTimeout(refreshBatches, batches.some(active) || uploading ? 2000 : 20000);
  }

  if (pickEl) {
    pickEl.addEventListener("change", () => {
      void enqueue([...pickEl.files]);
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
      if (e.dataTransfer && e.dataTransfer.files.length) void enqueue([...e.dataTransfer.files]);
    });
  }
  // Only the upload needs this page; once the server has the files, it can be closed.
  window.addEventListener("beforeunload", (e) => { if (uploading) e.preventDefault(); });
  void refreshBatches();

  // ---------- the list, and removing ----------
  const listEl = host.querySelector("[data-list]");
  const listStatus = host.querySelector("[data-list-status]");
  const listFind = host.querySelector("[data-list-find]");
  const listMore = host.querySelector("[data-list-more]");
  const PAGE = 50;
  let listRows = [];
  let listLimit = PAGE;
  // Shows the sources that match the search box, 50 at a time, so the page stays a sensible length.
  function showList() {
    const q = (listFind?.value || "").trim().toLowerCase();
    const hits = q ? listRows.filter((r) => r.key.includes(q)) : listRows;
    const body = listEl.tBodies[0];
    body.replaceChildren(...hits.slice(0, listLimit).map((r) => r.tr));
    listEl.hidden = hits.length === 0;
    listStatus.hidden = hits.length > 0;
    listStatus.textContent = listRows.length ? "No sources match that search." : "No sources yet.";
    if (listMore) {
      const left = hits.length - Math.min(listLimit, hits.length);
      listMore.hidden = left <= 0;
      listMore.textContent = `Show ${Math.min(left, PAGE)} more (${left} not shown)`;
    }
    if (listFind) listFind.closest("[data-list-tools]").hidden = listRows.length <= PAGE / 5;
  }
  listFind?.addEventListener("input", () => { listLimit = PAGE; showList(); });
  listMore?.addEventListener("click", () => { listLimit += PAGE; showList(); });

  async function refreshList() {
    try {
      if (!cfg) cfg = await api("GET", "ingest/config");
      const io = new SiteIO(cfg.layout);
      await io.load();
      const originals = [...io.files].filter((p) => under(p, cfg.layout.originals) && (OFFICE.includes(extOf(p)) || PICTURES.includes(extOf(p)))).sort((a, b) => a.localeCompare(b));
      const noteFor = new Map();
      for (const [path, text] of io.notes) {
        const src = parseFrontmatter(text).source;
        if (typeof src === "string" && src) noteFor.set(src, path);
      }
      const rows = [];
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
        rows.push({ tr, key: `${inner} ${note || ""}`.toLowerCase() });
      }
      listRows = rows;
      showList();
    } catch (e) {
      listStatus.hidden = false;
      listStatus.textContent = `Could not load the sources: ${explain(e)}`;
    }
  }

  async function removeSource(io, original, note, btn) {
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
