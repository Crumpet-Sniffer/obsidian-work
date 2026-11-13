import { Notice, TFile } from "obsidian";
import type Microsidian from "../main";
import { under } from "../config";
import { OFFICE_EXTENSIONS } from "../constants";
import { convertVaultFile } from "./convertFile";
import { addInlineLinks, inlineTopicNames, stripTopicLinks, topicsFromConnections } from "./linker";
import { composeNote, eol, isMostlyVisual, splitNote } from "./notes";

export type SyncStatus = "updated" | "unchanged" | "no-note" | "error";

/** Topic names -> phrases, read from the `phrases:` property of each topic page. */
export function topicPhrases(plugin: Microsidian, names: string[]): { name: string; phrases: string[] }[] {
  const out: { name: string; phrases: string[] }[] = [];
  for (const name of names) {
    const f = plugin.app.vault.getAbstractFileByPath(`${plugin.layout.topics}/${name}.md`);
    const phrases = f instanceof TFile ? plugin.app.metadataCache.getFileCache(f)?.frontmatter?.phrases : undefined;
    if (Array.isArray(phrases)) out.push({ name, phrases: phrases.map(String) });
  }
  return out;
}

/** Keeps each note's converted text up to date with its original Word/PowerPoint file. */
export class SyncService {
  private timers = new Map<string, number>();
  private busy = new Set<string>();

  constructor(private plugin: Microsidian) {}

  isOriginal(f: unknown): f is TFile {
    return f instanceof TFile && under(f.path, this.plugin.layout.originals) && OFFICE_EXTENSIONS.includes(f.extension);
  }

  /** Re-convert shortly after the file stops changing (Word and PowerPoint save in several steps). */
  schedule(file: TFile): void {
    if (!this.plugin.settings.autoSyncOnModify || !this.isOriginal(file)) return;
    window.clearTimeout(this.timers.get(file.path));
    this.timers.set(
      file.path,
      window.setTimeout(() => {
        this.timers.delete(file.path);
        void this.syncOriginal(file, true);
      }, 2000),
    );
  }

  async syncOriginal(file: TFile, notify = false): Promise<SyncStatus> {
    if (this.busy.has(file.path)) return "unchanged";
    this.busy.add(file.path);
    try {
      const note = this.plugin.pairing.noteFor(file);
      if (!note) return "no-note";
      const old = eol(await this.plugin.app.vault.read(note));
      const parts = splitNote(old);
      if (!parts) return "no-note";

      const res = await convertVaultFile(this.plugin, file);

      // keep the topic links the note had (from its Connections line and inline links)
      const folder = this.plugin.layout.topics;
      const names = [...new Set([...topicsFromConnections(parts.connections, folder), ...inlineTopicNames(parts.body, folder)])];
      const linked = addInlineLinks(stripTopicLinks(res.body, folder), topicPhrases(this.plugin, names), folder);

      const next = composeNote(parts.head, linked.body, {
        visual: isMostlyVisual(res.words, res.images.length),
        connections: parts.connections,
      });
      if (next === old) return "unchanged";
      await this.plugin.app.vault.modify(note, next);
      if (notify) new Notice(`Updated note for ${file.name}`);
      return "updated";
    } catch (e) {
      console.error("[Microsidian] sync failed", file.path, e);
      if (notify) new Notice(`Could not update the note for ${file.name}: ${e instanceof Error ? e.message : String(e)}`);
      return "error";
    } finally {
      this.busy.delete(file.path);
    }
  }

  async syncAll(): Promise<void> {
    const files = this.plugin.app.vault.getFiles().filter((f) => this.isOriginal(f));
    const notice = new Notice(`Re-syncing ${files.length} originals…`, 0);
    const tally: Record<SyncStatus, number> = { updated: 0, unchanged: 0, "no-note": 0, error: 0 };
    for (const [i, f] of files.entries()) {
      notice.setMessage(`Re-syncing originals… ${i + 1}/${files.length}`);
      tally[await this.syncOriginal(f)]++;
    }
    notice.hide();
    new Notice(
      `Re-sync finished: ${tally.updated} updated, ${tally.unchanged} unchanged` +
        (tally["no-note"] ? `, ${tally["no-note"]} without a note` : "") +
        (tally.error ? `, ${tally.error} failed (see console)` : ""),
      8000,
    );
  }
}
