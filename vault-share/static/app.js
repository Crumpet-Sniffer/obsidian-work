// Small progressive enhancements. Loaded from 'self' only (strict CSP, no inline script).
document.addEventListener("submit", (e) => {
  const form = e.target;
  const msg = form.getAttribute("data-confirm");
  if (msg && !window.confirm(msg)) {
    e.preventDefault();
    return;
  }
  if (form.hasAttribute("data-upload") && window.XMLHttpRequest && window.FormData) {
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
  const fileInput = form.querySelector('input[type="file"]');
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
