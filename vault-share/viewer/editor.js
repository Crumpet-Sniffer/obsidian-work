// Markdown editor for notes (CodeMirror 6): autosave, wiki-link completion, image paste/drop, shortcuts.
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, drawSelection, highlightActiveLine, placeholder, ViewPlugin, Decoration } from "@codemirror/view";
import { defaultKeymap, history as cmHistory, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage, markdownKeymap } from "@codemirror/lang-markdown";
import { syntaxHighlighting, HighlightStyle, indentOnInput, bracketMatching } from "@codemirror/language";
import { autocompletion, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { tags as t } from "@lezer/highlight";

const VS = window.VS;
const article = document.querySelector("article.note[data-path]");
const toggle = document.querySelector("[data-edit-toggle]");
if (!VS || !article) {
  // Not a note page (or no sidebar): nothing to edit.
} else {
  const notePath = article.dataset.path;
  const scroller = article.closest(".view-content");
  let view = null;
  let pane = null;
  let etag = null;
  let dirty = false;
  let saving = false;
  let timer = null;
  let titleInput = null;
  let currentPath = notePath;
  let statusEl = null;

  // ---------- look ----------
  const highlight = HighlightStyle.define([
    { tag: t.heading1, fontSize: "2em", fontWeight: "700", lineHeight: "1.25" },
    { tag: t.heading2, fontSize: "1.6em", fontWeight: "600", lineHeight: "1.3" },
    { tag: t.heading3, fontSize: "1.37em", fontWeight: "600" },
    { tag: t.heading4, fontSize: "1.25em", fontWeight: "600" },
    { tag: [t.heading5, t.heading6], fontSize: "1.12em", fontWeight: "600" },
    { tag: t.strong, fontWeight: "700" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: [t.link, t.url], color: "var(--accent)" },
    { tag: t.monospace, fontFamily: "var(--mono)", fontSize: "0.92em", background: "var(--code-bg)", borderRadius: "3px" },
    { tag: t.quote, color: "var(--muted)" },
    { tag: [t.processingInstruction, t.contentSeparator, t.meta], color: "var(--faint)" },
  ]);

  const theme = EditorView.theme({
    "&": { backgroundColor: "transparent", color: "var(--ink)", fontSize: "16px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": { fontFamily: "var(--ui)", lineHeight: "1.55", overflow: "visible" },
    ".cm-content": { caretColor: "var(--ink)", padding: "0 0 40vh" },
    ".cm-line": { padding: "0" },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--ink)" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "rgba(138,108,239,.35)" },
    ".cm-tooltip": { backgroundColor: "var(--bg-alt)", border: "1px solid var(--line)", borderRadius: "8px", color: "var(--ink)" },
    ".cm-tooltip-autocomplete > ul > li": { padding: "4px 10px" },
    ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--active)", color: "var(--ink)" },
    ".cm-completionDetail": { color: "var(--faint)", fontStyle: "normal", marginLeft: "10px" },
    ".cm-searchMatch": { backgroundColor: "var(--mark)" },
    ".cm-panels": { backgroundColor: "var(--bg-alt)", color: "var(--ink)", borderColor: "var(--line)" },
    ".cm-panels input, .cm-panels button": { font: "inherit", fontSize: "13px" },
    ".cm-frontmatter, .cm-frontmatter *": { fontSize: "13px !important", fontWeight: "400 !important", fontFamily: "var(--mono)", color: "var(--muted) !important", lineHeight: "1.5 !important" },
  }, { dark: true });

  // The YAML block at the top is shown as plain monospace text, not as a heading.
  const frontmatter = ViewPlugin.fromClass(class {
    constructor(v) { this.decorations = this.build(v); }
    update(u) { if (u.docChanged) this.decorations = this.build(u.view); }
    build(v) {
      const doc = v.state.doc;
      if (doc.lines < 2 || doc.line(1).text.trim() !== "---") return Decoration.none;
      let end = 0;
      for (let i = 2; i <= Math.min(doc.lines, 200); i++) {
        const tx = doc.line(i).text.trim();
        if (tx === "---" || tx === "...") { end = i; break; }
      }
      if (!end) return Decoration.none;
      const deco = [];
      for (let i = 1; i <= end; i++) deco.push(Decoration.line({ class: "cm-frontmatter" }).range(doc.line(i).from));
      return Decoration.set(deco);
    }
  }, { decorations: (p) => p.decorations });

  // ---------- helpers ----------
  const wrap = (open, close = open) => (v) => {
    const changes = v.state.changeByRange((r) => {
      const text = v.state.sliceDoc(r.from, r.to);
      if (text.startsWith(open) && text.endsWith(close) && text.length >= open.length + close.length) {
        return { changes: { from: r.from, to: r.to, insert: text.slice(open.length, text.length - close.length) }, range: r.extend(r.from, r.to - open.length - close.length) };
      }
      return { changes: [{ from: r.from, insert: open }, { from: r.to, insert: close }], range: r.empty ? r.extend(r.from + open.length) : r.extend(r.from, r.to + open.length + close.length) };
    });
    v.dispatch(changes, { scrollIntoView: true, userEvent: "input" });
    return true;
  };
  const insertLink = (v) => {
    const r = v.state.selection.main;
    const sel = v.state.sliceDoc(r.from, r.to);
    const insert = `[${sel}]()`;
    v.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: { anchor: r.from + insert.length - 1 }, userEvent: "input" });
    return true;
  };

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  // ---------- saving ----------
  function scheduleSave() {
    dirty = true;
    setStatus("Unsaved changes…");
    clearTimeout(timer);
    timer = setTimeout(saveNow, 700);
  }

  async function saveNow() {
    clearTimeout(timer);
    if (!view || !dirty) return true;
    if (saving) { timer = setTimeout(saveNow, 300); return false; }
    saving = true;
    const content = view.state.doc.toString();
    setStatus("Saving…");
    try {
      const r = await VS.api("PUT", "note", { path: currentPath, content, etag });
      etag = r.etag;
      if (view.state.doc.toString() === content) dirty = false;
      setStatus(dirty ? "Unsaved changes…" : "Saved");
      if (dirty) timer = setTimeout(saveNow, 300);
      return !dirty;
    } catch (e) {
      if (e.status === 409) conflict(e.data && e.data.etag);
      else { setStatus("Could not save. Retrying…"); timer = setTimeout(saveNow, 4000); }
      return false;
    } finally {
      saving = false;
    }
  }

  function conflict(serverEtag) {
    clearTimeout(timer);
    setStatus("Changed elsewhere");
    if (pane.querySelector(".editor-banner")) return;
    const bar = document.createElement("div");
    bar.className = "editor-banner";
    const msg = document.createElement("span");
    msg.textContent = "This note was changed by someone else since you opened it.";
    const keep = document.createElement("button");
    keep.type = "button";
    keep.textContent = "Keep my version";
    keep.addEventListener("click", () => { etag = serverEtag; bar.remove(); dirty = true; saveNow(); });
    const reload = document.createElement("button");
    reload.type = "button";
    reload.textContent = "Load theirs";
    reload.addEventListener("click", async () => {
      const r = await VS.api("GET", `note?path=${encodeURIComponent(currentPath)}`);
      etag = r.etag;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: r.content } });
      dirty = false;
      bar.remove();
      setStatus("Saved");
    });
    bar.append(msg, keep, reload);
    pane.prepend(bar);
  }

  // ---------- wiki-link completion ----------
  let files = null;
  async function loadFiles() {
    if (files) return files;
    try {
      const r = await fetch(`/v/${VS.vault}/api/files`, { credentials: "same-origin" });
      files = (await r.json()).files || [];
    } catch { files = []; }
    return files;
  }

  async function wikiSource(ctx) {
    const m = ctx.matchBefore(/!?\[\[[^\]\n|#]*$/);
    if (!m) return null;
    const embed = m.text.startsWith("!");
    const q = m.text.slice(embed ? 3 : 2).toLowerCase();
    const list = await loadFiles();
    const from = m.from + (embed ? 3 : 2);
    const scored = [];
    for (const f of list) {
      const isNote = /\.md$/i.test(f);
      if (!embed && !isNote) continue;
      const name = isNote ? f.replace(/\.md$/i, "") : f;
      const base = name.slice(name.lastIndexOf("/") + 1);
      const hay = base.toLowerCase();
      let s = 0;
      if (!q) s = 1;
      else if (hay.startsWith(q)) s = 3;
      else if (hay.includes(q)) s = 2;
      else if (name.toLowerCase().includes(q)) s = 1;
      if (s) scored.push({ s, base, name, f });
    }
    scored.sort((a, b) => b.s - a.s || a.base.length - b.base.length || a.base.localeCompare(b.base));
    // Use the short name unless another file shares it.
    const counts = new Map();
    for (const f of list) { const b = f.slice(f.lastIndexOf("/") + 1).replace(/\.md$/i, "").toLowerCase(); counts.set(b, (counts.get(b) || 0) + 1); }
    return {
      from,
      filter: false,
      options: scored.slice(0, 40).map((x) => {
        const target = counts.get(x.base.toLowerCase()) > 1 ? x.name : x.base;
        return {
          label: x.base,
          detail: x.name.includes("/") ? x.name.slice(0, x.name.lastIndexOf("/")) : "",
          apply: (v, _c, f0, to) => {
            const after = v.state.sliceDoc(to, to + 2) === "]]" ? 2 : 0;
            const insert = target + (after ? "" : "]]");
            v.dispatch({ changes: { from: f0, to: to + after, insert: after ? target + "]]" : insert }, selection: { anchor: f0 + target.length + 2 } });
          },
        };
      }),
    };
  }

  // ---------- attachments: paste or drop images and files ----------
  async function uploadFile(file) {
    let name = file.name || "file";
    const ext = (name.match(/\.([A-Za-z0-9]+)$/) || [, ""])[1].toLowerCase();
    if (!ext && file.type.startsWith("image/")) name = `image.${file.type.split("/")[1].replace("jpeg", "jpg").replace("svg+xml", "svg")}`;
    if (/^image\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, "0");
      name = `Pasted image ${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${name.split(".").pop()}`;
    }
    const res = await fetch(`/v/${VS.vault}/api/attach?name=${encodeURIComponent(name)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "X-CSRF-Token": VS.csrf },
      body: file,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Upload failed");
    return data;
  }

  async function handleFiles(fileList, pos) {
    for (const f of fileList) {
      try {
        setStatus("Uploading " + (f.name || "file") + "…");
        const r = await uploadFile(f);
        const isImg = /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(r.name);
        const at = pos ?? view.state.selection.main.head;
        const ins = `${isImg || true ? "!" : ""}[[${r.name}]]\n`;
        view.dispatch({ changes: { from: at, insert: ins }, selection: { anchor: at + ins.length }, userEvent: "input.paste" });
        files = null; // refresh completion list
      } catch (e) {
        VS.toast(e.message);
      }
    }
    setStatus(dirty ? "Unsaved changes…" : "Saved");
  }

  // ---------- open / close ----------
  async function open() {
    if (view) return;
    let note;
    try {
      note = await VS.api("GET", `note?path=${encodeURIComponent(notePath)}`);
    } catch (e) {
      VS.toast(e.message);
      return;
    }
    etag = note.etag;
    currentPath = notePath;
    article.hidden = true;
    pane = document.createElement("article");
    pane.className = "note editor-note";
    titleInput = document.createElement("input");
    titleInput.className = "inline-title";
    titleInput.value = VS.stripMd(VS.basename(notePath));
    titleInput.setAttribute("aria-label", "Note title");
    titleInput.maxLength = 200;
    const mount = document.createElement("div");
    mount.className = "editor-mount";
    pane.append(titleInput, mount);
    scroller.appendChild(pane);

    view = new EditorView({
      parent: mount,
      state: EditorState.create({
        doc: note.content,
        extensions: [
          cmHistory(),
          EditorView.cspNonce.of((document.querySelector('meta[name="csp-nonce"]') || {}).content || ""),
          drawSelection(),
          highlightActiveLine(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          markdown({ base: markdownLanguage }),
          syntaxHighlighting(highlight),
          theme,
          frontmatter,
          EditorView.lineWrapping,
          placeholder("Start writing…"),
          autocompletion({ override: [wikiSource], icons: false }),
          keymap.of([
            { key: "Mod-s", run: () => { saveNow(); return true; }, preventDefault: true },
            { key: "Mod-b", run: wrap("**"), preventDefault: true },
            { key: "Mod-i", run: wrap("*"), preventDefault: true },
            { key: "Mod-k", run: insertLink, preventDefault: true },
            { key: "Mod-Shift-x", run: wrap("~~"), preventDefault: true },
            { key: "Mod-e", run: () => { close(); return true; }, preventDefault: true },
            ...markdownKeymap,
            ...closeBracketsKeymap,
            ...searchKeymap,
            ...historyKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => { if (u.docChanged) scheduleSave(); }),
          EditorView.domEventHandlers({
            paste(e) {
              const fl = e.clipboardData && [...e.clipboardData.files];
              if (fl && fl.length) { e.preventDefault(); handleFiles(fl); return true; }
              return false;
            },
            drop(e, v) {
              const fl = e.dataTransfer && [...e.dataTransfer.files];
              if (fl && fl.length) {
                e.preventDefault();
                handleFiles(fl, v.posAtCoords({ x: e.clientX, y: e.clientY }) ?? undefined);
                return true;
              }
              return false;
            },
          }),
        ],
      }),
    });

    statusEl = document.querySelector("[data-save-state]");
    if (!statusEl) {
      const bar = document.querySelector("[data-status]");
      if (bar) {
        statusEl = document.createElement("span");
        statusEl.setAttribute("data-save-state", "");
        bar.prepend(statusEl);
      }
    }
    setStatus("Editing");
    toggle?.classList.add("is-active");
    if (toggle) toggle.title = "Reading view (Ctrl+E)";
    if (window.location.hash !== "#edit") history.replaceState(null, "", window.location.pathname + window.location.search + "#edit");
    scroller.scrollTop = 0;
    // New, empty notes: start on the title so it can be named straight away.
    if (!note.content.trim() && /^Untitled/.test(titleInput.value)) { titleInput.focus(); titleInput.select(); }
    else view.focus();

    titleInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); titleInput.blur(); view.focus(); }
      else if (e.key === "Escape") { titleInput.value = VS.stripMd(VS.basename(currentPath)); view.focus(); }
    });
    titleInput.addEventListener("change", renameFromTitle);
  }

  async function renameFromTitle() {
    const name = titleInput.value.trim().replace(/[\\/:*?"<>|]/g, "");
    const old = VS.stripMd(VS.basename(currentPath));
    if (!name || name === old) { titleInput.value = old; return; }
    const ok = await saveNow();
    if (ok === false && dirty) return;
    try {
      const r = await VS.api("POST", "rename", { from: currentPath, to: VS.join(VS.dirname(currentPath), name), update_links: true });
      window.location.href = r.url + "#edit";
    } catch (e) {
      VS.toast(e.message);
      titleInput.value = old;
    }
  }

  async function close() {
    if (!view) return;
    await saveNow();
    if (dirty) { VS.toast("Could not save your changes yet."); return; }
    window.location.href = window.location.pathname + window.location.search;
  }

  toggle?.addEventListener("click", () => (view ? close() : open()));
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === "e" || e.key === "E") && !view) {
      e.preventDefault();
      open();
    }
  });
  window.addEventListener("beforeunload", (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ""; }
  });
  window.addEventListener("pagehide", () => {
    // Best effort: send unsaved text when the tab is closing.
    if (dirty && view) {
      try {
        fetch(`/v/${VS.vault}/api/note`, {
          method: "PUT", keepalive: true, credentials: "same-origin",
          headers: { "X-CSRF-Token": VS.csrf, "Content-Type": "application/json" },
          body: JSON.stringify({ path: currentPath, content: view.state.doc.toString(), etag }),
        });
      } catch { /* ignore */ }
    }
  });
  if (window.location.hash === "#edit") open();
}
