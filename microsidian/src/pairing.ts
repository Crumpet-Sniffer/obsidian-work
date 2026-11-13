import { App, TFile } from "obsidian";
import type { Layout } from "./config";
import { under } from "./config";
import { OFFICE_EXTENSIONS } from "./constants";

/**
 * Keeps the link between an original (.docx/.pptx in the originals folder) and its
 * Markdown note, using the note's `source:` frontmatter.
 */
export class Pairing {
  private noteByOriginal = new Map<string, string>();
  private originalByNote = new Map<string, string>();

  constructor(private app: App, private layout: () => Layout) {}

  rebuild(): void {
    this.noteByOriginal.clear();
    this.originalByNote.clear();
    for (const f of this.app.vault.getMarkdownFiles()) this.index(f);
  }

  index(file: TFile): void {
    if (file.extension !== "md") return;
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const src = typeof fm?.source === "string" ? fm.source : null;
    if (!src || !under(src, this.layout().originals)) return;
    // drop any stale mapping for this note
    const old = this.originalByNote.get(file.path);
    if (old && old !== src) this.noteByOriginal.delete(old);
    this.noteByOriginal.set(src, file.path);
    this.originalByNote.set(file.path, src);
  }

  /** Record a pairing right away, before Obsidian has re-read the new note's frontmatter. */
  link(originalPath: string, notePath: string): void {
    this.noteByOriginal.set(originalPath, notePath);
    this.originalByNote.set(notePath, originalPath);
  }

  remove(path: string): void {
    const orig = this.originalByNote.get(path);
    if (orig) this.noteByOriginal.delete(orig);
    this.originalByNote.delete(path);
  }

  noteFor(original: TFile | string): TFile | null {
    const p = typeof original === "string" ? original : original.path;
    const n = this.noteByOriginal.get(p);
    const f = n ? this.app.vault.getAbstractFileByPath(n) : null;
    return f instanceof TFile ? f : null;
  }

  originalFor(note: TFile | string): TFile | null {
    const p = typeof note === "string" ? note : note.path;
    const o = this.originalByNote.get(p);
    const f = o ? this.app.vault.getAbstractFileByPath(o) : null;
    return f instanceof TFile ? f : null;
  }

  /** The note for an original, or the original for a note, whichever applies. */
  counterpart(file: TFile): TFile | null {
    if (OFFICE_EXTENSIONS.includes(file.extension)) return this.noteFor(file);
    if (file.extension === "md") return this.originalFor(file);
    return null;
  }

  get size(): number {
    return this.noteByOriginal.size;
  }
}
