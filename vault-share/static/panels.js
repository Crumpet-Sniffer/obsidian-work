// Sidebar panels (search, bookmarks), tabs, split view, hover previews and the tags list.
(function () {
  "use strict";
  const VS = window.VS;
  const sb = document.getElementById("sidebar");
  if (!VS || !sb) return;
  const vault = VS.vault;
  const pref = (k, d) => { try { const v = localStorage.getItem(`vault-share:${k}:${vault}`); return v ? JSON.parse(v) : d; } catch { return d; } };
  const setPref = (k, v) => { try { localStorage.setItem(`vault-share:${k}:${vault}`, JSON.stringify(v)); } catch { /* ignore */ } };
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const pageTitle = () => document.title.split(" · ")[0] || "Untitled";
  const here = () => window.location.pathname + window.location.search;
  const isVaultLink = (href) => typeof href === "string" && href.startsWith(`/v/${vault}/`) && /\/(n|o|graph|search|new-tab)(\/|$|\?)/.test(href.slice(`/v/${vault}`.length));

  // ================= sidebar panels =================
  const panels = sb.querySelectorAll("[data-panel-body]");
  const tabsBtns = sb.querySelectorAll("[data-panel]");
  function showPanel(name) {
    panels.forEach((p) => (p.hidden = p.getAttribute("data-panel-body") !== name));
    tabsBtns.forEach((b) => b.classList.toggle("is-active", b.getAttribute("data-panel") === name));
    if (name === "search") { const i = sb.querySelector("[data-search-input]"); if (i) { i.focus(); i.select(); } }
  }
  tabsBtns.forEach((b) => b.addEventListener("click", () => showPanel(b.getAttribute("data-panel"))));
  VS.showPanel = showPanel;

  // ---------- search ----------
  const input = sb.querySelector("[data-search-input]");
  const results = sb.querySelector("[data-search-results]");
  const meta = sb.querySelector("[data-search-meta]");
  let seq = 0, timer = null;
  async function runSearch(q) {
    const my = ++seq;
    q = q.trim();
    results.textContent = "";
    if (q.length < 2) { meta.textContent = q ? "Type at least two characters." : ""; return; }
    meta.textContent = "Searching…";
    try {
      const r = await fetch(`/v/${vault}/api/search?q=${encodeURIComponent(q)}`, { credentials: "same-origin" });
      const d = await r.json();
      if (my !== seq) return;
      meta.textContent = d.results.length ? `${d.results.length}${d.truncated ? "+" : ""} result${d.results.length === 1 ? "" : "s"}` : "No matches found.";
      for (const hit of d.results) {
        const box = el("div", "sr");
        const a = el("a", "sr-title", hit.title);
        a.href = hit.url;
        const count = el("span", "sr-count", String(hit.matches || ""));
        const head = el("div", "sr-head");
        head.append(a, count);
        box.appendChild(head);
        if (hit.folder) box.appendChild(el("div", "sr-folder", hit.folder));
        for (const s of hit.snippets) {
          const line = el("a", "sr-snip");
          line.href = hit.url;
          line.append(document.createTextNode(s.before));
          if (s.match) line.appendChild(el("mark", null, s.match));
          line.append(document.createTextNode(s.after));
          box.appendChild(line);
        }
        results.appendChild(box);
      }
    } catch {
      if (my === seq) meta.textContent = "Search failed. Try again.";
    }
  }
  if (input) {
    input.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => { runSearch(input.value); try { sessionStorage.setItem(`vs-q:${vault}`, input.value); } catch { /* ignore */ } }, 250);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { clearTimeout(timer); runSearch(input.value); }
      else if (e.key === "Escape") { input.value = ""; runSearch(""); }
    });
    try { const q = sessionStorage.getItem(`vs-q:${vault}`); if (q) { input.value = q; } } catch { /* ignore */ }
  }
  VS.openSearch = (q) => { showPanel("search"); if (input) { input.value = q; runSearch(q); } };
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "F" || e.key === "f")) { e.preventDefault(); showPanel("search"); }
  });
  // `?q=` on the search page is also run in the sidebar when it is opened from a tag link
  sb.querySelectorAll("[data-search-help]").forEach((b) => b.addEventListener("click", () => sb.querySelector("[data-search-ops]")?.toggleAttribute("hidden")));

  // ---------- bookmarks ----------
  let bookmarks = pref("bookmarks", []);
  if (!Array.isArray(bookmarks)) bookmarks = [];
  const bmList = sb.querySelector("[data-bookmarks]");
  const star = document.querySelector("[data-bookmark-toggle]");
  const noteArticle = document.querySelector("article.note[data-path]");
  function renderBookmarks() {
    if (bmList) {
      bmList.textContent = "";
      if (!bookmarks.length) bmList.appendChild(el("li", "muted rb-empty", "No bookmarks yet. Use the star on a note, or right-click a note in the file list."));
      for (const b of bookmarks) {
        const li = el("li", "bm-item");
        const a = el("a", null, VS.stripMd(VS.basename(b)));
        a.href = VS.noteUrl(b);
        a.title = b;
        const x = el("button", "icon-btn", "×");
        x.type = "button";
        x.title = "Remove bookmark";
        x.addEventListener("click", () => VS.toggleBookmark(b));
        li.append(a, x);
        bmList.appendChild(li);
      }
    }
    if (star && noteArticle) {
      const on = bookmarks.includes(noteArticle.dataset.path);
      star.classList.toggle("is-active", on);
      star.title = on ? "Remove bookmark" : "Bookmark this note";
    }
  }
  VS.toggleBookmark = (path) => {
    const i = bookmarks.indexOf(path);
    if (i >= 0) bookmarks.splice(i, 1); else bookmarks.unshift(path);
    setPref("bookmarks", bookmarks);
    renderBookmarks();
  };
  if (star && noteArticle) star.addEventListener("click", () => VS.toggleBookmark(noteArticle.dataset.path));
  renderBookmarks();

  // ---------- recent files ----------
  if (noteArticle) {
    const rec = pref("recent", []).filter((r) => r && r.url !== here());
    rec.unshift({ url: here(), title: pageTitle() });
    setPref("recent", rec.slice(0, 20));
  }
  const recentEl = document.querySelector("[data-recent]");
  if (recentEl) {
    const rec = pref("recent", []);
    if (!rec.length) recentEl.appendChild(el("li", "muted", "No recent files."));
    for (const r of rec) { const li = el("li"); const a = el("a", null, r.title); a.href = r.url; li.appendChild(a); recentEl.appendChild(li); }
  }
  document.querySelectorAll("[data-empty-action]").forEach((b) => b.addEventListener("click", () => {
    const a = b.getAttribute("data-empty-action");
    if (a === "new") VS.newNote("");
    else if (a === "goto") document.dispatchEvent(new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true, cancelable: true }));
    else if (a === "close") closeTab(state.active);
  }));

  // ---------- tags (right sidebar) ----------
  const tagsBtn = document.querySelector('[data-rb-tab="tags"]');
  const tagsList = document.querySelector("[data-tags-list]");
  let tagsLoaded = false;
  async function loadTags() {
    if (tagsLoaded || !tagsList) return;
    tagsLoaded = true;
    try {
      const r = await fetch(`/v/${vault}/api/tags`, { credentials: "same-origin" });
      const d = await r.json();
      if (!d.tags.length) tagsList.appendChild(el("li", "muted rb-empty", "No tags in this vault."));
      for (const t of d.tags) {
        const li = el("li", "tag-row");
        const a = el("a", "tag", "#" + t.tag);
        a.href = `/v/${vault}/search?q=${encodeURIComponent("tag:#" + t.tag)}`;
        a.addEventListener("click", (e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); VS.openSearch("tag:#" + t.tag); });
        li.append(a, el("span", "muted", String(t.count)));
        tagsList.appendChild(li);
      }
    } catch { tagsLoaded = false; }
  }
  tagsBtn?.addEventListener("click", loadTags);
  // Tag pills in Properties open a search for that tag in the sidebar
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a.tag[href*='/search?q=']");
    if (!a || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    const q = decodeURIComponent((a.getAttribute("href").split("?q=")[1] || ""));
    if (q) VS.openSearch(q);
  });

  // ================= tabs =================
  const TABS_KEY = `vault-share:tabs:${vault}`;
  const loadTabs = () => { try { const d = JSON.parse(localStorage.getItem(TABS_KEY)); if (d && Array.isArray(d.tabs)) return d; } catch { /* ignore */ } return { tabs: [] }; };
  const saveTabs = () => { try { localStorage.setItem(TABS_KEY, JSON.stringify({ tabs: state.tabs })); } catch { /* ignore */ } };
  const state = loadTabs();
  state.active = null;
  try { state.active = sessionStorage.getItem(TABS_KEY); } catch { /* ignore */ }
  const newId = () => Math.random().toString(36).slice(2, 10);
  const iconFor = (url) => (/\/graph/.test(url) ? "i-graph" : /\/search/.test(url) ? "i-search" : /\/new-tab/.test(url) ? "i-plus" : "i-file");
  const setActive = (id) => { state.active = id; try { sessionStorage.setItem(TABS_KEY, id || ""); } catch { /* ignore */ } };

  let cur = state.tabs.find((t) => t.id === state.active);
  if (!cur) { cur = { id: newId() }; state.tabs.push(cur); setActive(cur.id); }
  cur.url = here();
  cur.title = pageTitle();
  cur.icon = iconFor(cur.url);
  // keep the list tidy: drop tabs pointing at the same page as the current one, and cap the length
  state.tabs = state.tabs.filter((t, i, a) => t.id === cur.id || (t.url && t.url !== cur.url && a.findIndex((x) => x.url === t.url) === i)).slice(-14);
  saveTabs();

  function navigate(url) { window.location.href = url; }
  function closeTab(id) {
    const i = state.tabs.findIndex((t) => t.id === id);
    if (i < 0) return;
    state.tabs.splice(i, 1);
    saveTabs();
    if (id !== state.active) { renderTabs(); return; }
    const next = state.tabs[Math.min(i, state.tabs.length - 1)];
    if (next) { setActive(next.id); navigate(next.url); }
    else { setActive(null); navigate(`/v/${vault}`); }
  }
  function openInNewTab(href) {
    const t = { id: newId(), url: href, title: decodeURIComponent((href.split("?")[0].split("/").pop() || "New tab").replace(/\.md$/i, "")), icon: iconFor(href) };
    state.tabs.push(t);
    saveTabs();
    setActive(t.id);
    navigate(href);
  }
  VS.openInNewTab = openInNewTab;

  function renderTabs() {
    const bar = document.querySelector(".tabbar");
    if (!bar) return;
    bar.querySelectorAll(".tab").forEach((t) => t.remove());
    const plus = bar.querySelector(".tab-new");
    for (const t of state.tabs) {
      const tab = el("div", "tab" + (t.id === state.active ? " is-active" : ""));
      tab.title = t.title || "";
      const ic = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      ic.setAttribute("class", "ic tab-icon");
      const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
      use.setAttribute("href", "#" + (t.icon || "i-file"));
      ic.appendChild(use);
      const title = el("span", "tab-title", t.title || "Untitled");
      const x = el("button", "tab-close", "×");
      x.type = "button";
      x.setAttribute("aria-label", "Close tab");
      x.addEventListener("click", (e) => { e.stopPropagation(); closeTab(t.id); });
      tab.append(ic, title, x);
      tab.addEventListener("click", () => { if (t.id !== state.active) { setActive(t.id); navigate(t.url); } });
      tab.addEventListener("auxclick", (e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } });
      bar.insertBefore(tab, plus);
    }
  }
  renderTabs();
  const plusBtn = document.querySelector(".tabbar .tab-new");
  plusBtn?.addEventListener("click", (e) => { e.preventDefault(); openInNewTab(`/v/${vault}/new-tab`); });

  // Ctrl/Cmd or middle click on a vault link opens it in a new tab
  function linkFrom(e) { const a = e.target.closest("a[href]"); return a && isVaultLink(a.getAttribute("href")) ? a : null; }
  document.addEventListener("click", (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey) return;
    const a = linkFrom(e);
    if (a) { e.preventDefault(); openInNewTab(a.getAttribute("href")); }
  });
  document.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    const a = linkFrom(e);
    if (a) { e.preventDefault(); openInNewTab(a.getAttribute("href")); }
  });

  // ================= split view =================
  const pageCache = new Map();
  async function fetchPage(url) {
    const base = url.split("#")[0];
    if (pageCache.has(base)) return pageCache.get(base);
    const r = await fetch(base, { credentials: "same-origin" });
    if (!r.ok) throw new Error("Could not load that note.");
    const doc = new DOMParser().parseFromString(await r.text(), "text/html");
    pageCache.set(base, doc);
    if (pageCache.size > 30) pageCache.delete(pageCache.keys().next().value);
    return doc;
  }

  let splitPane = null;
  async function loadSplit(url) {
    if (!splitPane) return;
    const body = splitPane.querySelector(".split-body");
    body.textContent = "Loading…";
    try {
      const doc = await fetchPage(url);
      const art = doc.querySelector("article.note");
      body.textContent = "";
      if (art) {
        const copy = document.importNode(art, true);
        copy.removeAttribute("data-path");
        body.appendChild(copy);
        if (window.VSRender) window.VSRender.run(body);
        splitPane.querySelector(".split-title").textContent = (doc.title || "").split(" · ")[0];
        splitPane.dataset.url = url;
        splitPane.querySelector(".split-open").href = url;
      } else body.textContent = "This page cannot be shown here.";
    } catch (e) { body.textContent = e.message; }
  }
  VS.openSplit = async (href) => {
    const view = document.querySelector(".main > .view, .main > .panes > .view");
    if (!view) return;
    let panes = document.querySelector(".main > .panes");
    if (!panes) {
      panes = el("div", "panes");
      view.parentNode.insertBefore(panes, view);
      panes.appendChild(view);
    }
    if (splitPane) splitPane.remove();
    splitPane = el("div", "split-pane");
    const head = el("div", "split-head");
    const title = el("span", "split-title", "Loading…");
    const open = el("a", "icon-btn", "↗");
    open.className = "icon-btn split-open";
    open.title = "Open in this tab";
    const close = el("button", "icon-btn", "×");
    close.type = "button";
    close.title = "Close split";
    close.addEventListener("click", () => { splitPane.remove(); splitPane = null; panes.classList.remove("has-split"); });
    head.append(title, open, close);
    splitPane.append(head, el("div", "split-body view-content"));
    panes.appendChild(splitPane);
    panes.classList.add("has-split");
    splitPane.addEventListener("click", (e) => {
      const a = e.target.closest("a[href]");
      if (!a) return;
      const href = a.getAttribute("href");
      if (href.startsWith("#")) return;
      if (isVaultLink(href) && /\/n\//.test(href) && !e.ctrlKey && !e.metaKey) { e.preventDefault(); loadSplit(href); }
    });
    loadSplit(href);
  };
  // "Open to the right" for links in the note, via Alt+click
  document.addEventListener("click", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const a = linkFrom(e);
    if (a && /\/n\//.test(a.getAttribute("href"))) { e.preventDefault(); VS.openSplit(a.getAttribute("href")); }
  });
  document.querySelector("[data-split-current]")?.addEventListener("click", () => {
    // split the current note with itself so you can scroll two places at once
    VS.openSplit(here());
  });

  // ================= hover preview =================
  let pop = null, popTimer = null, hideTimer = null, popFor = null;
  function hidePop() { clearTimeout(popTimer); if (pop) { pop.remove(); pop = null; popFor = null; } }
  async function showPop(a) {
    const href = a.getAttribute("href");
    const [url, frag] = href.split("#");
    let doc;
    try { doc = await fetchPage(url); } catch { return; }
    if (popFor !== a) return;
    const prose = doc.querySelector("article.note .prose");
    if (!prose) return;
    const box = el("div", "hover-preview");
    box.setAttribute("role", "tooltip");
    const h = el("div", "hover-title", (doc.title || "").split(" · ")[0]);
    const body = el("div", "prose hover-body");
    let nodes = [...prose.children];
    const target = frag ? prose.querySelector("#" + CSS.escape(decodeURIComponent(frag))) : null;
    if (target) {
      const lvl = /^H[1-6]$/.test(target.tagName) ? Number(target.tagName[1]) : 7;
      const sect = [target];
      for (let n = target.nextElementSibling; n && sect.length < 40; n = n.nextElementSibling) {
        if (/^H[1-6]$/.test(n.tagName) && Number(n.tagName[1]) <= lvl) break;
        sect.push(n);
      }
      nodes = sect;
    }
    nodes.slice(0, 40).forEach((n) => body.appendChild(document.importNode(n, true)));
    box.append(h, body);
    document.body.appendChild(box);
    if (window.VSRender) window.VSRender.run(body);
    const r = a.getBoundingClientRect();
    const bw = box.offsetWidth, bh = box.offsetHeight;
    let top = r.bottom + 6;
    if (top + bh > window.innerHeight - 8) top = Math.max(8, r.top - bh - 6);
    box.style.left = Math.max(8, Math.min(r.left, window.innerWidth - bw - 8)) + "px";
    box.style.top = top + "px";
    box.addEventListener("mouseenter", () => clearTimeout(hideTimer));
    box.addEventListener("mouseleave", () => { hideTimer = setTimeout(hidePop, 200); });
    hidePopOnly();
    pop = box;
  }
  function hidePopOnly() { if (pop) { pop.remove(); pop = null; } }
  document.addEventListener("mouseover", (e) => {
    const a = e.target.closest && e.target.closest(".prose a[href], .rb-body a[href]");
    if (!a || !isVaultLink(a.getAttribute("href")) || !/\/n\//.test(a.getAttribute("href"))) return;
    if (a.closest(".hover-preview") && false) return;
    clearTimeout(hideTimer);
    if (popFor === a) return;
    clearTimeout(popTimer);
    popFor = a;
    popTimer = setTimeout(() => showPop(a), 450);
  });
  document.addEventListener("mouseout", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || a !== popFor) return;
    clearTimeout(popTimer);
    hideTimer = setTimeout(() => { if (!pop || !pop.matches(":hover")) hidePop(); }, 250);
    popFor = null;
  });
  document.addEventListener("scroll", hidePop, true);
})();
