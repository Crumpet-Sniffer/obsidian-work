// Small progressive enhancements. Loaded from 'self' only (strict CSP, no inline script).
document.addEventListener("submit", (e) => {
  const form = e.target;
  const msg = form.getAttribute("data-confirm");
  if (msg && !window.confirm(msg)) {
    e.preventDefault();
    return;
  }
  // With no file chosen (a new, empty vault) there is nothing to show progress for: submit normally.
  const picked = form.querySelector('input[type="file"][name]');
  const hasFile = !!(picked && picked.files && picked.files.length);
  if (form.hasAttribute("data-upload") && hasFile && window.XMLHttpRequest && window.FormData) {
    e.preventDefault();
    startUpload(form);
  }
});

// ---------- upload with progress, speed and ETA ----------
function fmtBytes(n) {
  if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
  if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
  return Math.max(1, Math.round(n / 1024)) + " KB";
}
function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return s + " s";
  const m = Math.floor(s / 60);
  if (m < 60) return m + " min " + String(s % 60).padStart(2, "0") + " s";
  return Math.floor(m / 60) + " h " + String(m % 60).padStart(2, "0") + " min";
}

// Files bigger than this are sent in pieces (the server says the exact piece size). Keeps every
// request under proxy limits such as Cloudflare's 100 MB cap.
const CHUNK_AT = 75 * 1024 * 1024;

function xhrSend(track, method, url, { headers = {}, body = null, onProgress = null, onUploaded = null } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    track(xhr);
    xhr.open(method, url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    if (onProgress) xhr.upload.onprogress = onProgress;
    if (onUploaded) xhr.upload.onload = onUploaded;
    xhr.onload = () => resolve(xhr);
    xhr.onerror = () => reject(new Error("network"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.send(body);
  });
}

function startUpload(form) {
  const btn = form.querySelector('button[type="submit"]');
  const fileInput = form.querySelector('input[type="file"][name]');
  const file = fileInput && fileInput.files && fileInput.files[0];
  const csrf = (form.querySelector('input[name="csrf"]') || {}).value || "";
  const box = document.createElement("div");
  box.className = "upload-progress";
  box.setAttribute("role", "status");
  const bar = document.createElement("progress");
  bar.max = 100;
  bar.value = 0;
  const text = document.createElement("p");
  text.className = "upload-stats small";
  text.textContent = "Starting upload…";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  box.append(bar, text, cancel);
  form.appendChild(box);
  if (btn) btn.disabled = true;
  form.querySelectorAll("input").forEach((i) => (i.readOnly = true));

  let current = null;
  let cancelled = false;
  const t0 = performance.now();
  let lastT = t0, lastLoaded = 0, speed = 0; // bytes/second, smoothed

  function reset(msg) {
    box.remove();
    if (btn) btn.disabled = false;
    form.querySelectorAll("input").forEach((i) => (i.readOnly = false));
    if (msg) window.alert(msg);
  }

  function report(loaded, total) {
    const now = performance.now();
    if (now - lastT >= 500) {
      const inst = ((loaded - lastLoaded) * 1000) / (now - lastT);
      speed = speed ? speed * 0.7 + inst * 0.3 : inst;
      lastT = now;
      lastLoaded = loaded;
    }
    const pct = (loaded / total) * 100;
    bar.value = pct;
    let line = Math.floor(pct) + "% · " + fmtBytes(loaded) + " of " + fmtBytes(total);
    if (speed > 0) {
      line += " · " + fmtBytes(speed) + "/s · about " + fmtTime((total - loaded) / speed) + " left";
    }
    text.textContent = line;
  }

  function processing() {
    bar.removeAttribute("value"); // indeterminate while the server unpacks and indexes the vault
    const secs = (performance.now() - t0) / 1000;
    text.textContent = "Upload complete (" + fmtTime(secs) + "). Processing on the server… this can take a moment.";
    cancel.remove();
  }

  // Success is a redirect to the vault page. Anything else is a server-rendered error page.
  function finish(xhr) {
    const final = xhr.responseURL || "";
    const target = new URL(form.action, location.href).href;
    if (xhr.status >= 200 && xhr.status < 300 && final && final !== target) {
      location.assign(final);
    } else {
      document.open();
      document.write(xhr.responseText);
      document.close();
    }
  }

  cancel.addEventListener("click", () => {
    cancelled = true;
    if (current) current.abort();
  });
  const track = (xhr) => (current = xhr);

  // Normal single-request upload (small files).
  async function sendWhole() {
    const xhr = await xhrSend(track, "POST", form.action, {
      body: new FormData(form),
      onProgress: (ev) => {
        if (ev.lengthComputable) report(ev.loaded, ev.total);
        else text.textContent = "Uploading… " + fmtBytes(ev.loaded);
      },
      onUploaded: processing,
    });
    finish(xhr);
  }

  // Large files: send pieces to /admin/uploads, then submit the form with the upload id instead of the file.
  async function sendChunked() {
    const start = await xhrSend(track, "POST", "/admin/uploads", { headers: { "X-CSRF-Token": csrf } });
    let info;
    try {
      info = JSON.parse(start.responseText);
    } catch {
      // Not JSON: an error page (session expired, not an admin, ...). Show it.
      return finish(start);
    }
    if (start.status !== 200 || !info.id) throw new Error("Could not start the upload.");
    const size = file.size;
    const piece = info.chunk_bytes || CHUNK_AT;
    let offset = 0;
    let failures = 0;
    while (offset < size) {
      const end = Math.min(offset + piece, size);
      const body = new FormData();
      body.append("chunk", file.slice(offset, end), "chunk");
      let xhr;
      try {
        xhr = await xhrSend(track, "PUT", "/admin/uploads/" + info.id, {
          headers: { "X-CSRF-Token": csrf, "X-Upload-Offset": String(offset) },
          body,
          onProgress: (ev) => report(Math.min(size, offset + ev.loaded), size),
        });
      } catch (err) {
        if (cancelled || err.message === "aborted") throw err;
        if (++failures > 5) throw new Error("The connection kept failing.");
        text.textContent = "Connection problem, retrying…";
        await new Promise((r) => setTimeout(r, 1000 * failures));
        // The server may have stored the piece even though we never heard back: ask where it stands.
        const probe = await xhrSend(track, "PUT", "/admin/uploads/" + info.id, {
          headers: { "X-CSRF-Token": csrf, "X-Upload-Offset": "999999999999999" },
          body: new FormData(),
        }).catch(() => null);
        if (probe && probe.status === 409) {
          try { offset = JSON.parse(probe.responseText).received; } catch { /* keep offset */ }
        }
        continue;
      }
      if (xhr.status === 409) {
        // Server and browser disagree about how much has arrived: continue from the server's number.
        offset = JSON.parse(xhr.responseText).received;
        continue;
      }
      if (xhr.status !== 200) {
        if (xhr.status >= 500 && ++failures <= 5) continue;
        return finish(xhr);
      }
      failures = 0;
      offset = JSON.parse(xhr.responseText).received;
    }
    report(size, size);
    const fd = new FormData();
    for (const [k, v] of new FormData(form).entries()) if (!(v instanceof File)) fd.append(k, v);
    fd.append("upload_id", info.id);
    bar.removeAttribute("value");
    cancel.disabled = true;
    processing();
    const done = await xhrSend(track, "POST", form.action, { body: fd });
    finish(done);
  }

  (file && file.size > CHUNK_AT ? sendChunked() : sendWhole()).catch((err) => {
    if (cancelled || (err && err.message === "aborted")) reset();
    else reset("The upload failed (" + (err && err.message ? err.message : "unknown error") + "). Check your connection and try again.");
  });
}

document.addEventListener("click", (e) => {
  const copy = e.target.closest("[data-copy]");
  if (copy) {
    const el = document.getElementById(copy.getAttribute("data-copy"));
    if (el && navigator.clipboard) {
      navigator.clipboard.writeText(el.textContent.trim()).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => (copy.textContent = "Copy"), 1500);
      });
    }
  }
  const toggle = e.target.closest("[data-toggle-sidebar]");
  if (toggle) {
    const app = document.getElementById("app");
    const narrow = window.matchMedia("(max-width: 800px)").matches;
    app.classList.toggle(narrow ? "nav-open" : "nav-closed");
  }
  if (e.target.closest("[data-tree-expand]")) {
    document.querySelectorAll(".tree details").forEach((d) => (d.open = true));
  }
  if (e.target.closest("[data-tree-collapse]")) {
    document.querySelectorAll(".tree details:not(.tree-root)").forEach((d) => (d.open = false));
  }
  const hist = e.target.closest("[data-history]");
  if (hist) {
    if (hist.getAttribute("data-history") === "back") history.back();
    else history.forward();
  }
  if (e.target.closest("[data-graph-close]")) {
    const p = document.querySelector("[data-graph-panel]");
    if (p) p.classList.add("is-hidden");
  }
});

// Keep the current note visible in a long file tree.
const current = document.querySelector('.tree a[aria-current="page"]');
if (current) current.scrollIntoView({ block: "center" });

// ---------- right sidebar: tabs, outline, outgoing links ----------
(function () {
  const rb = document.getElementById("rightbar");
  if (!rb) return;
  const tabs = rb.querySelectorAll("[data-rb-tab]");
  const panes = rb.querySelectorAll("[data-rb-pane]");
  tabs.forEach((t) =>
    t.addEventListener("click", () => {
      tabs.forEach((x) => x.classList.toggle("is-active", x === t));
      panes.forEach((p) => (p.hidden = p.getAttribute("data-rb-pane") !== t.getAttribute("data-rb-tab")));
    }),
  );

  const prose = document.querySelector(".note .prose");
  const outline = rb.querySelector("[data-outline]");
  const outlinks = rb.querySelector("[data-outlinks]");
  const empty = (list, text) => {
    const li = document.createElement("li");
    li.className = "muted rb-empty";
    li.textContent = text;
    list.appendChild(li);
  };
  if (!prose) {
    if (outline) empty(outline, "Open the note to see its outline.");
    if (outlinks) empty(outlinks, "Open the note to see its links.");
    return;
  }

  // Outline: every heading in the note, indented by level.
  const heads = [...prose.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter((h) => h.id);
  if (outline) {
    if (!heads.length) empty(outline, "No headings in this note.");
    const min = Math.min(...heads.map((h) => Number(h.tagName[1])), 6);
    const items = heads.map((h) => {
      const li = document.createElement("li");
      li.className = "lvl-" + (Number(h.tagName[1]) - min + 1);
      const a = document.createElement("a");
      a.href = "#" + h.id;
      a.textContent = h.textContent;
      li.appendChild(a);
      outline.appendChild(li);
      return [h, a];
    });
    // Highlight the heading currently at the top of the note.
    const scroller = prose.closest(".view-content");
    if (scroller && items.length) {
      const update = () => {
        const top = scroller.getBoundingClientRect().top + 24;
        let cur = items[0];
        for (const it of items) if (it[0].getBoundingClientRect().top <= top) cur = it;
        items.forEach((it) => it[1].classList.toggle("is-current", it === cur));
      };
      scroller.addEventListener("scroll", update, { passive: true });
      update();
    }
  }

  // Outgoing links: notes and files this note links to (each once).
  if (outlinks) {
    const seen = new Set();
    prose.querySelectorAll("a[href^='/v/']").forEach((a) => {
      const href = a.getAttribute("href");
      if (seen.has(href)) return;
      seen.add(href);
      const li = document.createElement("li");
      const link = document.createElement("a");
      link.href = href;
      link.textContent = a.textContent.trim() || href;
      li.appendChild(link);
      outlinks.appendChild(li);
    });
    if (!seen.size) empty(outlinks, "This note has no links to other notes.");
  }

  // Status bar: backlinks, words, characters (like Obsidian's bottom-right counters).
  const status = document.querySelector("[data-status]");
  if (status) {
    const text = prose.innerText || "";
    const words = (text.trim().match(/\S+/g) || []).length;
    const bl = Number(status.getAttribute("data-backlinks") || 0);
    const parts = [bl + (bl === 1 ? " backlink" : " backlinks"), words + (words === 1 ? " word" : " words"), text.length + " characters"];
    parts.forEach((p) => {
      const s = document.createElement("span");
      s.textContent = p;
      status.appendChild(s);
    });
  }
})();

// ---------- quick switcher (Ctrl+O, or Ctrl+K): jump to any note by name ----------
(function () {
  const ribbon = document.querySelector(".ribbon-tabs a");
  const m = ribbon && ribbon.getAttribute("href") ? ribbon.getAttribute("href").match(/^\/v\/([0-9a-f]+)/) : null;
  if (!m) return;
  const vaultId = m[1];
  let notes = null;
  let overlay = null;

  function score(q, text) {
    // Subsequence match: reward consecutive characters, word starts and early matches.
    q = q.toLowerCase();
    const t = text.toLowerCase();
    let ti = 0, s = 0, run = 0;
    const idx = [];
    for (let qi = 0; qi < q.length; qi++) {
      const c = q[qi];
      const at = t.indexOf(c, ti);
      if (at < 0) return null;
      run = at === ti && qi > 0 ? run + 1 : 0;
      s += 1 + run * 2 + (at === 0 || " -_/".includes(t[at - 1]) ? 3 : 0) - at * 0.01;
      idx.push(at);
      ti = at + 1;
    }
    if (t.includes(q)) s += 10;
    return { s, idx };
  }

  function highlight(text, idx) {
    const frag = document.createDocumentFragment();
    const set = new Set(idx);
    let buf = "", on = false;
    const flush = () => {
      if (!buf) return;
      if (on) {
        const mk = document.createElement("mark");
        mk.textContent = buf;
        frag.appendChild(mk);
      } else frag.appendChild(document.createTextNode(buf));
      buf = "";
    };
    for (let i = 0; i < text.length; i++) {
      const hit = set.has(i);
      if (hit !== on) { flush(); on = hit; }
      buf += text[i];
    }
    flush();
    return frag;
  }

  async function load() {
    if (notes) return notes;
    try {
      const r = await fetch("/v/" + vaultId + "/graph.json", { credentials: "same-origin" });
      const d = await r.json();
      notes = d.nodes.filter((n) => n.kind === "note").map((n) => ({ label: n.label, path: n.path, url: n.url }));
    } catch {
      notes = [];
    }
    return notes;
  }

  function close() {
    if (overlay) overlay.remove();
    overlay = null;
  }

  async function open() {
    if (overlay) return close();
    overlay = document.createElement("div");
    overlay.className = "qs-overlay";
    const box = document.createElement("div");
    box.className = "qs";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-label", "Quick switcher");
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Find or jump to a note…";
    input.setAttribute("aria-label", "Find a note");
    input.autocomplete = "off";
    const list = document.createElement("ul");
    const hint = document.createElement("div");
    hint.className = "qs-hint";
    hint.textContent = "↑↓ to navigate · Enter to open · Esc to close";
    box.append(input, list, hint);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    input.focus();
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });

    const all = await load();
    let shown = [], sel = 0;

    function render() {
      const q = input.value.trim();
      let rows;
      if (!q) rows = all.slice(0, 30).map((n) => ({ n, idx: [] }));
      else {
        rows = [];
        for (const n of all) {
          const a = score(q, n.label);
          const b = a ? null : score(q, n.path);
          if (a) rows.push({ n, idx: a.idx, s: a.s + 5 });
          else if (b) rows.push({ n, idx: [], s: b.s });
        }
        rows.sort((x, y) => y.s - x.s);
        rows = rows.slice(0, 30);
      }
      shown = rows;
      sel = Math.min(sel, Math.max(0, rows.length - 1));
      list.textContent = "";
      if (!rows.length) {
        const e = document.createElement("div");
        e.className = "qs-empty";
        e.textContent = "No notes found.";
        list.appendChild(e);
        return;
      }
      rows.forEach((r, i) => {
        const li = document.createElement("li");
        if (i === sel) li.className = "is-selected";
        const name = document.createElement("span");
        name.className = "qs-name";
        name.appendChild(highlight(r.n.label, r.idx));
        const path = document.createElement("span");
        path.className = "qs-path";
        path.textContent = r.n.path.includes("/") ? r.n.path.slice(0, r.n.path.lastIndexOf("/")) : "";
        li.append(name, path);
        li.addEventListener("mousemove", () => { if (sel !== i) { sel = i; render(); } });
        li.addEventListener("click", () => go(i));
        list.appendChild(li);
      });
      const cur = list.querySelector(".is-selected");
      if (cur) cur.scrollIntoView({ block: "nearest" });
    }
    function go(i) {
      const r = shown[i];
      if (r) window.location.href = r.n.url;
    }
    input.addEventListener("input", () => { sel = 0; render(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, shown.length - 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); render(); }
      else if (e.key === "Enter") { e.preventDefault(); go(sel); }
      else if (e.key === "Escape") { e.preventDefault(); close(); }
    });
    render();
  }

  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "o" || e.key === "O" || e.key === "k" || e.key === "K")) {
      e.preventDefault();
      open();
    } else if (e.key === "Escape" && overlay) {
      close();
    }
  });
  const search = document.querySelector('.ribbon-tabs a[title="Search"]');
  if (search) search.title = "Search (Ctrl+O to jump to a note)";
})();

// A note that opens with its own name as a heading would show the title twice: keep the page title only.
(() => {
  const title = document.querySelector("article.note > .note-title");
  const first = document.querySelector("article.note > .prose > h1:first-child");
  const norm = (el) => el.textContent.trim().replace(/\s+/g, " ").toLowerCase();
  if (title && first && norm(title) === norm(first)) first.classList.add("is-title-echo");
})();
