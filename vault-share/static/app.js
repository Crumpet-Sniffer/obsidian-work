// Small progressive enhancements. Loaded from 'self' only (strict CSP, no inline script).
document.addEventListener("submit", (e) => {
  const form = e.target;
  const msg = form.getAttribute("data-confirm");
  if (msg && !window.confirm(msg)) {
    e.preventDefault();
    return;
  }
  if (form.hasAttribute("data-upload")) {
    const btn = form.querySelector('button[type="submit"]');
    if (btn) {
      btn.disabled = true;
      btn.textContent = "Uploading… this can take a while";
    }
  }
});

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
