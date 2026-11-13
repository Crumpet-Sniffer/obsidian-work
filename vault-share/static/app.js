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

function startUpload(form) {
  const btn = form.querySelector('button[type="submit"]');
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

  const xhr = new XMLHttpRequest();
  const t0 = performance.now();
  let lastT = t0, lastLoaded = 0, speed = 0; // bytes/second, smoothed

  function reset(msg) {
    box.remove();
    if (btn) btn.disabled = false;
    form.querySelectorAll("input").forEach((i) => (i.readOnly = false));
    if (msg) window.alert(msg);
  }

  xhr.upload.onprogress = (ev) => {
    if (!ev.lengthComputable) {
      text.textContent = "Uploading… " + fmtBytes(ev.loaded);
      return;
    }
    const now = performance.now();
    if (now - lastT >= 500) {
      const inst = ((ev.loaded - lastLoaded) * 1000) / (now - lastT);
      speed = speed ? speed * 0.7 + inst * 0.3 : inst;
      lastT = now;
      lastLoaded = ev.loaded;
    }
    const pct = (ev.loaded / ev.total) * 100;
    bar.value = pct;
    let line = Math.floor(pct) + "% · " + fmtBytes(ev.loaded) + " of " + fmtBytes(ev.total);
    if (speed > 0) {
      line += " · " + fmtBytes(speed) + "/s · about " + fmtTime((ev.total - ev.loaded) / speed) + " left";
    }
    text.textContent = line;
  };
  xhr.upload.onload = () => {
    bar.removeAttribute("value"); // indeterminate while the server unpacks and indexes the vault
    const secs = (performance.now() - t0) / 1000;
    text.textContent = "Upload complete (" + fmtTime(secs) + "). Processing on the server… this can take a moment.";
    cancel.remove();
  };
  xhr.onload = () => {
    // Success is a redirect to the vault page. Anything else is a server-rendered error page.
    const final = xhr.responseURL || "";
    const target = new URL(form.action, location.href).href;
    if (xhr.status >= 200 && xhr.status < 300 && final && final !== target) {
      location.assign(final);
    } else {
      document.open();
      document.write(xhr.responseText);
      document.close();
    }
  };
  xhr.onerror = () => reset("The upload failed. Check your connection and try again.");
  xhr.ontimeout = () => reset("The upload timed out. Try again.");
  xhr.onabort = () => reset();
  cancel.addEventListener("click", () => xhr.abort());

  xhr.open("POST", form.action);
  xhr.send(new FormData(form));
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
