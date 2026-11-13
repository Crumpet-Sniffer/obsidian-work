import { FileView, MarkdownRenderer, Notice, TFile, WorkspaceLeaf } from "obsidian";
import { renderAsync } from "docx-preview";
import { init as initPptx } from "pptx-preview";
import JSZip from "jszip";
import type Microsidian from "../main";
import { OFFICE_EXTENSIONS, VIEW_TYPE_OFFICE } from "../constants";

/** Slide size in EMU from ppt/presentation.xml, to size the preview with the right aspect ratio. */
async function slideAspect(buf: ArrayBuffer): Promise<number> {
  try {
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("ppt/presentation.xml")?.async("string");
    const m = xml?.match(/<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
    if (m) return Number(m[1]) / Number(m[2]);
  } catch {
    /* fall through */
  }
  return 16 / 9;
}

export class OfficeView extends FileView {
  private bodyEl!: HTMLElement;
  private pptx: ReturnType<typeof initPptx> | null = null;
  private pendingSlide: number | null = null;
  private renderToken = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: Microsidian) {
    super(leaf);
    this.navigation = true;
  }

  getViewType(): string {
    return VIEW_TYPE_OFFICE;
  }

  getIcon(): string {
    return this.file?.extension === "pptx" ? "presentation" : "file-text";
  }

  canAcceptExtension(extension: string): boolean {
    return OFFICE_EXTENSIONS.includes(extension);
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("cc-office-view");
    this.addAction("file-text", "Open linked note", () => this.openNote());
    this.addAction("external-link", "Open in default app", () => this.openExternal());
    if (!this.bodyEl) this.bodyEl = this.contentEl.createDiv({ cls: "cc-office-body" });
  }

  /** Links like [[deck.pptx#slide-3]] arrive here. */
  setEphemeralState(state: unknown): void {
    super.setEphemeralState(state);
    const s = state as { subpath?: string; slide?: number } | null;
    let n: number | null = null;
    if (typeof s?.slide === "number") n = s.slide;
    const m = s?.subpath?.match(/slide[-_ ]?(\d+)/i);
    if (m) n = Number(m[1]);
    if (n && n > 0) {
      this.pendingSlide = n;
      this.gotoSlide(n);
    }
  }

  async onLoadFile(file: TFile): Promise<void> {
    const token = ++this.renderToken;
    // Obsidian can load the file before onOpen has finished, so make sure the container exists
    if (!this.bodyEl) {
      this.contentEl.addClass("cc-office-view");
      this.bodyEl = this.contentEl.createDiv({ cls: "cc-office-body" });
    }
    this.bodyEl.empty();
    this.bodyEl.createDiv({ cls: "cc-loading", text: "Loading…" });
    try {
      const buf = await this.app.vault.readBinary(file);
      if (token !== this.renderToken) return;
      this.bodyEl.empty();
      if (file.extension === "docx") await this.renderDocx(buf);
      else await this.renderPptx(buf);
    } catch (err) {
      console.error("[Microsidian] render failed", err);
      if (token !== this.renderToken) return;
      await this.renderFallback(file, err);
    }
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    this.renderToken++;
    this.destroyPptx();
    this.bodyEl?.empty();
  }

  async onClose(): Promise<void> {
    this.destroyPptx();
  }

  private destroyPptx(): void {
    try {
      this.pptx?.destroy();
    } catch {
      /* ignore */
    }
    this.pptx = null;
  }

  // ---------- Word ----------
  private async renderDocx(buf: ArrayBuffer): Promise<void> {
    const styles = this.bodyEl.createDiv({ cls: "cc-docx-styles" });
    const page = this.bodyEl.createDiv({ cls: "cc-docx-page" });
    await renderAsync(buf, page, styles, {
      className: "docx",
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      breakPages: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: false,
      experimental: true,
    });
  }

  // ---------- PowerPoint ----------
  private async renderPptx(buf: ArrayBuffer): Promise<void> {
    const aspect = await slideAspect(buf);
    const host = this.bodyEl.createDiv({ cls: "cc-pptx-host" });
    const avail = Math.max(320, (this.contentEl.clientWidth || 900) - 64);
    const width = Math.min(avail, 1100);
    const height = Math.round(width / aspect);
    host.style.setProperty("--cc-slide-w", `${width}px`);
    host.style.setProperty("--cc-slide-h", `${height}px`);
    const stage = host.createDiv({ cls: "cc-pptx-stage" });
    this.pptx = initPptx(stage, { width, height, mode: "slide" });
    await this.pptx.preview(buf);
    if (this.pendingSlide) this.gotoSlide(this.pendingSlide);
  }

  gotoSlide(n: number): void {
    const p = this.pptx;
    if (!p || !p.slideCount) return; // applied after load via pendingSlide
    const idx = Math.min(Math.max(n, 1), p.slideCount) - 1;
    p.renderSingleSlide(idx);
    p.updatePagination();
    this.pendingSlide = null;
  }

  // ---------- Fallback ----------
  private async renderFallback(file: TFile, err: unknown): Promise<void> {
    this.bodyEl.empty();
    const note = this.plugin.pairing.noteFor(file);
    const box = this.bodyEl.createDiv({ cls: "cc-fallback" });
    box.createEl("p", {
      cls: "cc-fallback-msg",
      text: `Could not render this file in Obsidian (${err instanceof Error ? err.message : String(err)}). ` +
        (note ? "Showing the text from its linked note instead." : "No linked note was found."),
    });
    if (note) {
      const md = await this.app.vault.cachedRead(note);
      const holder = box.createDiv({ cls: "markdown-rendered" });
      await MarkdownRenderer.render(this.app, md, holder, note.path, this);
    }
  }

  // ---------- Actions ----------
  private async openNote(): Promise<void> {
    if (!this.file) return;
    const note = this.plugin.pairing.noteFor(this.file);
    if (!note) {
      new Notice("No linked note found for this file.");
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(note);
  }

  private openExternal(): void {
    if (!this.file) return;
    // Obsidian desktop: opens in the system default app.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.app as any).openWithDefaultApp?.(this.file.path);
  }
}
