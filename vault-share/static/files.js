// File tree actions: new note/folder, rename, delete, copy, drag and drop, sort order, context menu,
// plus the small helpers (VS.api, VS.ask, VS.toast) the editor and other panels share.
(function () {
  "use strict";
  const sb = document.getElementById("sidebar");
  if (!sb) return;
  const vault = sb.dataset.vault;
  const csrf = sb.dataset.csrf;
  const tree = sb.querySelector(".tree");

  // ---------- shared helpers ----------
  async function api(method, path, body) {
    const res = await fetch(`/v/${vault}/api/${path}`, {
      method,
      credentials: "same-origin",
      headers: { "X-CSRF-Token": csrf, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  function toast(message, ms = 3500) {
    let host = document.getElementById("toasts");
    if (!host) {
      host = document.createElement("div");
      host.id = "toasts";
      host.setAttribute("role", "status");
      document.body.appendChild(host);
    }
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = message;
    host.appendChild(t);
    setTimeout(() => t.remove(), ms);
  }

  // A small modal: text input (optional) with OK/Cancel. Resolves with the text, true, or null when cancelled.
  function dialog({ title, message = "", input = false, value = "", okText = "OK", danger = false }) {
    return new Promise((resolve) => {
      const overlay = document.createElement("div");
      overlay.className = "qs-overlay";
      const box = document.createElement("div");
      box.className = "qs dlg";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-label", title);
      const h = document.createElement("h3");
      h.textContent = title;
      box.appendChild(h);
      if (message) {
        const p = document.createElement("p");
        p.textContent = message;
        box.appendChild(p);
      }
      let field = null;
      if (input) {
        field = document.createElement("input");
        field.type = "text";
        field.value = value;
        field.maxLength = 200;
        field.setAttribute("aria-label", title);
        box.appendChild(field);
      }
      const row = document.createElement("div");
      row.className = "dlg-buttons";
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel";
      const ok = document.createElement("button");
      ok.type = "button";
      ok.textContent = okText;
      ok.className = danger ? "danger" : "mod-cta";
      row.append(cancel, ok);
      box.appendChild(row);
      overlay.appendChild(box);
      document.body.appendChild(overlay);
      const done = (v) => { overlay.remove(); resolve(v); };
      cancel.addEventListener("click", () => done(null));
      ok.addEventListener("click", () => done(input ? field.value.trim() : true));
      overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) done(null); });
      box.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); done(null); }
        else if (e.key === "Enter") { e.preventDefault(); done(input ? field.value.trim() : true); }
      });
      if (field) { field.focus(); field.select(); } else ok.focus();
    });
  }

  const dirname = (p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
  const basename = (p) => p.slice(p.lastIndexOf("/") + 1);
  const stripMd = (n) => n.replace(/\.md$/i, "");
  const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");
  const noteUrl = (p) => `/v/${vault}/n/${encodePath(p)}`;
  const join = (dir, name) => (dir ? `${dir}/${name}` : name);

  const VS = (window.VS = { vault, csrf, api, toast, dialog, dirname, basename, stripMd, noteUrl, encodePath, join });

  // The note currently open (if any) and its folder.
  const currentPath = () => {
    const a = sb.querySelector('.tree a[aria-current="page"]');
    return a ? a.dataset.path || "" : "";
  };
  VS.currentPath = currentPath;
  const existingPaths = () => new Set([...sb.querySelectorAll("[data-path]")].map((e) => e.dataset.path.toLowerCase()));

  function uniqueName(dir, base, ext) {
    const have = existingPaths();
    let n = 0;
    for (;;) {
      const name = n === 0 ? base : `${base} ${n}`;
      if (!have.has(join(dir, name + ext).toLowerCase())) return name;
      n++;
    }
  }

  function fail(err) {
    toast(err && err.message ? err.message : "Something went wrong.");
  }

  // ---------- actions ----------
  async function newNote(dir) {
    try {
      const name = uniqueName(dir, "Untitled", ".md");
      const r = await api("POST", "create", { path: join(dir, name), kind: "note", content: "" });
      window.location.href = r.url + "#edit";
    } catch (e) { fail(e); }
  }

  async function newFolder(dir) {
    const name = await dialog({ title: "New folder", input: true, value: uniqueName(dir, "New folder", ""), okText: "Create" });
    if (!name) return;
    try {
      await api("POST", "create", { path: join(dir, name), kind: "folder" });
      window.location.reload();
    } catch (e) { fail(e); }
  }

  async function renameItem(path, isDir) {
    const old = isDir ? basename(path) : stripMd(basename(path));
    const name = await dialog({ title: isDir ? "Rename folder" : "Rename", input: true, value: old, okText: "Rename" });
    if (!name || name === old) return;
    try {
      const to = join(dirname(path), name);
      const r = await api("POST", "rename", { from: path, to, update_links: true });
      if (path === currentPath()) window.location.href = r.url || window.location.pathname;
      else window.location.reload();
    } catch (e) { fail(e); }
  }

  async function deleteItem(path, isDir) {
    const ok = await dialog({
      title: isDir ? "Delete folder" : "Delete note",
      message: `“${isDir ? basename(path) : stripMd(basename(path))}” will be moved to the vault's trash folder.`,
      okText: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await api("POST", "delete", { path });
      if (path === currentPath() || (isDir && currentPath().startsWith(path + "/"))) window.location.href = `/v/${vault}`;
      else window.location.reload();
    } catch (e) { fail(e); }
  }

  async function duplicateNote(path) {
    try {
      const src = await api("GET", `note?path=${encodeURIComponent(path)}`);
      const base = stripMd(basename(path));
      const name = uniqueName(dirname(path), `${base} copy`, ".md");
      const r = await api("POST", "create", { path: join(dirname(path), name), kind: "note", content: src.content });
      window.location.href = r.url;
    } catch (e) { fail(e); }
  }

  async function moveItem(from, intoDir) {
    const to = join(intoDir, basename(from));
    if (to === from || intoDir === dirname(from) || to.startsWith(from + "/")) return;
    try {
      const r = await api("POST", "rename", { from, to, update_links: true });
      if (from === currentPath()) window.location.href = r.url || window.location.pathname;
      else window.location.reload();
    } catch (e) { fail(e); }
  }

  VS.newNote = newNote;

  // ---------- toolbar buttons ----------
  const folderOfCurrent = () => dirname(currentPath());
  sb.querySelector("[data-new-note]")?.addEventListener("click", () => newNote(folderOfCurrent()));
  sb.querySelector("[data-new-folder]")?.addEventListener("click", () => newFolder(folderOfCurrent()));

  // ---------- sort order ----------
  const SORTS = [["az", "File name (A to Z)"], ["za", "File name (Z to A)"]];
  let sortIdx = 0;
  try { sortIdx = Math.max(0, SORTS.findIndex((s) => s[0] === localStorage.getItem("vault-share:sort"))); } catch { /* ignore */ }
  function applySort() {
    const dir = SORTS[sortIdx][0] === "za" ? -1 : 1;
    const cmp = (a, b) => dir * a.textContent.trim().localeCompare(b.textContent.trim(), undefined, { numeric: true, sensitivity: "base" });
    tree.querySelectorAll("ul").forEach((ul) => {
      const items = [...ul.children];
      const label = (li) => (li.querySelector(":scope > details > summary") || li.querySelector(":scope > a") || li);
      const dirs = items.filter((li) => li.classList.contains("dir")).sort((a, b) => cmp(label(a), label(b)));
      const files = items.filter((li) => !li.classList.contains("dir")).sort((a, b) => cmp(label(a), label(b)));
      [...dirs, ...files].forEach((li) => ul.appendChild(li));
    });
  }
  const sortBtn = sb.querySelector("[data-sort]");
  if (sortBtn) {
    sortBtn.title = "Change sort order: " + SORTS[sortIdx][1];
    sortBtn.addEventListener("click", () => {
      sortIdx = (sortIdx + 1) % SORTS.length;
      try { localStorage.setItem("vault-share:sort", SORTS[sortIdx][0]); } catch { /* ignore */ }
      sortBtn.title = "Change sort order: " + SORTS[sortIdx][1];
      applySort();
      toast("Sorted by " + SORTS[sortIdx][1]);
    });
    if (sortIdx !== 0) applySort();
  }

  // ---------- context menu ----------
  let menu = null;
  function closeMenu() { if (menu) menu.remove(); menu = null; }
  function showMenu(x, y, items) {
    closeMenu();
    menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.setAttribute("role", "menu");
    for (const it of items) {
      if (it === "-") { const hr = document.createElement("div"); hr.className = "ctx-sep"; menu.appendChild(hr); continue; }
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.textContent = it.label;
      if (it.danger) b.className = "danger";
      b.addEventListener("click", () => { closeMenu(); it.run(); });
      menu.appendChild(b);
    }
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + "px";
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + "px";
  }
  document.addEventListener("click", closeMenu);
  document.addEventListener("scroll", closeMenu, true);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
  VS.showMenu = showMenu;

  tree.addEventListener("contextmenu", (e) => {
    const el = e.target.closest("[data-path]");
    e.preventDefault();
    if (!el) {
      showMenu(e.clientX, e.clientY, [
        { label: "New note", run: () => newNote("") },
        { label: "New folder", run: () => newFolder("") },
      ]);
      return;
    }
    const path = el.dataset.path;
    const isDir = el.dataset.dir === "1";
    const isNote = !isDir && /\.md$/i.test(path);
    const items = [];
    if (isDir) {
      items.push({ label: "New note", run: () => newNote(path) }, { label: "New folder", run: () => newFolder(path) }, "-");
    } else {
      items.push({ label: "Open in new tab", run: () => VS.openInNewTab && VS.openInNewTab(el.getAttribute("href")) });
      if (isNote) {
        items.push({ label: "Open to the right", run: () => VS.openSplit && VS.openSplit(el.getAttribute("href")) });
        items.push({ label: "Bookmark", run: () => VS.toggleBookmark && VS.toggleBookmark(path) });
        items.push({ label: "Make a copy", run: () => duplicateNote(path) });
      }
      items.push("-");
    }
    items.push({ label: "Copy path", run: () => { try { navigator.clipboard.writeText(path); toast("Path copied"); } catch { toast(path); } } });
    if (isDir || isNote) items.push({ label: "Rename…", run: () => renameItem(path, isDir) });
    items.push({ label: "Delete", danger: true, run: () => deleteItem(path, isDir) });
    showMenu(e.clientX, e.clientY, items);
  });

  // ---------- drag and drop to move ----------
  tree.querySelectorAll("a[data-path], summary[data-path]").forEach((el) => { el.draggable = true; });
  let dragging = null;
  tree.addEventListener("dragstart", (e) => {
    const el = e.target.closest("[data-path]");
    if (!el) return;
    dragging = el.dataset.path;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", dragging);
  });
  tree.addEventListener("dragend", () => {
    dragging = null;
    tree.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target"));
  });
  tree.addEventListener("dragover", (e) => {
    if (!dragging) return;
    const dir = e.target.closest("summary[data-dir]");
    const rootSum = e.target.closest(".tree-root > summary");
    if (!dir && !rootSum) return;
    e.preventDefault();
    tree.querySelectorAll(".drop-target").forEach((x) => x.classList.remove("drop-target"));
    (dir || rootSum).classList.add("drop-target");
  });
  tree.addEventListener("drop", (e) => {
    if (!dragging) return;
    const dir = e.target.closest("summary[data-dir]");
    const rootSum = e.target.closest(".tree-root > summary");
    if (!dir && !rootSum) return;
    e.preventDefault();
    const from = dragging;
    dragging = null;
    moveItem(from, dir ? dir.dataset.path : "");
  });
})();
