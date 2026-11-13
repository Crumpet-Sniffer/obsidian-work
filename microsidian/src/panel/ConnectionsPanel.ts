import { ItemView, MarkdownRenderer, TFile, WorkspaceLeaf } from "obsidian";
import type Microsidian from "../main";
import { OFFICE_EXTENSIONS, VIEW_TYPE_CONNECTIONS } from "../constants";
import { under } from "../config";
import { extractConnections } from "../connections";

/** Right-sidebar panel: topics, related notes and backlinks for the open note or original. */
export class ConnectionsPanel extends ItemView {
  private current: TFile | null = null;
  private seq = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: Microsidian) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_CONNECTIONS;
  }
  getDisplayText(): string {
    return "Connections";
  }
  getIcon(): string {
    return "network";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("cc-panel");
    const refresh = () => void this.refresh();
    this.registerEvent(this.app.workspace.on("active-leaf-change", refresh));
    this.registerEvent(this.app.workspace.on("file-open", refresh));
    this.registerEvent(
      this.app.metadataCache.on("changed", (f) => {
        if (this.current && (f.path === this.current.path || f.path === this.plugin.pairing.counterpart(this.current)?.path)) refresh();
      }),
    );
    await this.refresh();
  }

  /** Which file should the panel describe? Ignore the panel's own leaf. */
  private target(): TFile | null {
    const leaf = this.app.workspace.getMostRecentLeaf();
    const view = leaf?.view as { file?: TFile } | undefined;
    const f = view?.file ?? this.app.workspace.getActiveFile();
    return f instanceof TFile ? f : null;
  }

  async refresh(): Promise<void> {
    const file = this.target();
    if (!file) return;
    if (this.current?.path === file.path && this.contentEl.childElementCount) {
      // same file: still re-render so edits show up
    }
    this.current = file;
    const my = ++this.seq;
    const isOriginal = OFFICE_EXTENSIONS.includes(file.extension);
    const note = isOriginal ? this.plugin.pairing.noteFor(file) : file.extension === "md" ? file : null;
    const original = isOriginal ? file : note ? this.plugin.pairing.originalFor(note) : null;

    const frag = document.createDocumentFragment();
    const root = createDiv();
    frag.appendChild(root);

    // header
    const head = root.createDiv({ cls: "cc-panel-head" });
    head.createDiv({ cls: "cc-panel-title", text: note?.basename ?? file.basename });
    const btns = head.createDiv({ cls: "cc-panel-btns" });
    if (original && (!isOriginal || note)) {
      const b = btns.createEl("button", { text: isOriginal ? "Open note" : "Open original" });
      b.onclick = () => void this.app.workspace.getLeaf(false).openFile(isOriginal ? note! : original);
    }

    if (!note) {
      root.createDiv({ cls: "cc-panel-empty", text: "Open a note or one of its original files to see its connections." });
    } else {
      const md = await this.app.vault.cachedRead(note);
      if (my !== this.seq) return;
      const block = extractConnections(md);
      const sec = root.createDiv({ cls: "cc-panel-section" });
      sec.createEl("h4", { text: "Connections" });
      const body = sec.createDiv({ cls: "markdown-rendered cc-panel-md" });
      if (block) await MarkdownRenderer.render(this.app, block, body, note.path, this);
      else body.createDiv({ cls: "cc-panel-empty", text: "This note has no Connections block yet." });
      this.wireLinks(body, note.path);

      const bl = this.backlinks(note, original);
      if (bl.length) {
        const bsec = root.createDiv({ cls: "cc-panel-section" });
        bsec.createEl("h4", { text: `Linked from (${bl.length})` });
        const ul = bsec.createEl("ul", { cls: "cc-panel-list" });
        for (const f of bl.slice(0, 25)) {
          const li = ul.createEl("li");
          const a = li.createEl("a", { text: f.basename, cls: "internal-link" });
          a.onclick = (e) => {
            e.preventDefault();
            void this.app.workspace.getLeaf(e.ctrlKey || e.metaKey).openFile(f);
          };
        }
        if (bl.length > 25) bsec.createDiv({ cls: "cc-panel-more", text: `+ ${bl.length - 25} more` });
      }
    }
    if (my !== this.seq) return;
    this.contentEl.empty();
    this.contentEl.appendChild(frag);
  }

  private backlinks(note: TFile, original: TFile | null): TFile[] {
    const out: TFile[] = [];
    const resolved = this.app.metadataCache.resolvedLinks;
    for (const [src, targets] of Object.entries(resolved)) {
      if (src === note.path || under(src, this.plugin.layout.originals)) continue;
      if (targets[note.path] || (original && targets[original.path])) {
        const f = this.app.vault.getAbstractFileByPath(src);
        if (f instanceof TFile) out.push(f);
      }
    }
    return out.sort((a, b) => a.basename.localeCompare(b.basename));
  }

  /** Rendered internal links need a click handler inside a custom view. */
  private wireLinks(el: HTMLElement, sourcePath: string): void {
    el.querySelectorAll<HTMLAnchorElement>("a.internal-link").forEach((a) => {
      a.addEventListener("click", (e) => {
        e.preventDefault();
        const href = a.getAttribute("data-href") ?? a.getAttribute("href") ?? "";
        void this.app.workspace.openLinkText(href, sourcePath, e.ctrlKey || e.metaKey);
      });
    });
  }
}
