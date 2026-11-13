import { normalizePath, Notice, TAbstractFile, TFile } from "obsidian";
import type Microsidian from "../main";
import { analyseDocument, apiKey, estimate, explainError, MODEL } from "../ai/analyse";
import { buildCatalogue } from "../ai/catalogue";
import { convertOffice } from "../convert";
import { under } from "../config";
import { OFFICE_EXTENSIONS } from "../constants";
import { applyIngest } from "../vault/apply";
import { convertVaultFile } from "../vault/convertFile";
import { ObsidianIO } from "../vault/obsidianIO";
import { confirmSend, reviewProposal } from "./modals";
import { validate } from "./proposal";

/** Watches the Ingest folder and files each new Word/PowerPoint document with Claude's help. */
export class IngestService {
  private queue: string[] = [];
  private running = false;

  constructor(private plugin: Microsidian) {}

  get folder(): string {
    return normalizePath(this.plugin.layout.ingest);
  }

  isCandidate(f: TAbstractFile): f is TFile {
    return (
      f instanceof TFile &&
      under(f.path, this.folder) &&
      f.path !== this.folder &&
      OFFICE_EXTENSIONS.includes(f.extension.toLowerCase()) &&
      !f.name.startsWith("~$") // Office lock files
    );
  }

  async ensureFolder(): Promise<void> {
    const ad = this.plugin.app.vault.adapter;
    if (!(await ad.exists(this.folder))) await ad.mkdir(this.folder);
  }

  onCreate(f: TAbstractFile): void {
    if (this.isCandidate(f)) this.enqueue(f.path);
  }

  /** Queue every document currently waiting in the Ingest folder. */
  scan(): number {
    const files = this.plugin.app.vault.getFiles().filter((f) => this.isCandidate(f));
    files.forEach((f) => this.enqueue(f.path));
    return files.length;
  }

  private enqueue(path: string): void {
    if (!this.queue.includes(path)) this.queue.push(path);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const path = this.queue.shift()!;
        try {
          await this.process(path);
        } catch (e) {
          console.error("[Microsidian] ingest failed", path, e);
          new Notice(`Could not file ${path.split("/").pop()}: ${e instanceof Error ? e.message : String(e)}`, 10000);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Wait until the file stops growing (it may still be copying in). */
  private async waitStable(path: string): Promise<void> {
    const ad = this.plugin.app.vault.adapter;
    let last = -1;
    for (let i = 0; i < 40; i++) {
      const size = (await ad.stat(path))?.size ?? -1;
      if (size > 0 && size === last) return;
      last = size;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  async process(path: string): Promise<void> {
    const plugin = this.plugin;
    const { app, settings, layout } = plugin;
    let file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    await this.waitStable(path);
    file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;

    if (!apiKey(plugin)) {
      new Notice("Microsidian: add your Anthropic API key in the plugin settings, then drop the file in again.", 10000);
      return;
    }

    const io = new ObsidianIO(app, layout);
    const status = new Notice(`Reading ${file.name}…`, 0);
    try {
      // convert only to get the text for Claude; nothing is written yet
      const res = await convertOffice(await app.vault.readBinary(file), file.extension, {
        imageMinBytes: settings.imageMinKB * 1000,
        isLogo: plugin.imageIndex.isLogo,
        attachmentsDir: layout.attachments,
      });
      const cat = await buildCatalogue(io, layout);
      const est = estimate(cat, res.body, settings.guidance);

      if (!settings.autoAcceptIngest) {
        status.hide();
        if (!(await confirmSend(app, file.name, est.tokens, est.costUsd, MODEL))) return;
      }
      status.setMessage(`Asking Claude where "${file.name}" belongs…`);

      let outcome;
      try {
        outcome = await analyseDocument(plugin, cat, file.name, res.body);
      } catch (e) {
        new Notice(`Microsidian: ${explainError(e)}`, 12000);
        return;
      } finally {
        status.hide();
      }

      let proposal = validate(outcome.analysis, cat, res.body, layout);
      const note = `Cost about $${outcome.costUsd.toFixed(3)} (${outcome.usage.input.toLocaleString()} in, ${outcome.usage.output.toLocaleString()} out` +
        (outcome.usage.cacheRead ? `, ${outcome.usage.cacheRead.toLocaleString()} cached` : "") + ")" +
        (outcome.fallbackUsed ? ". A substitute model was used because the first declined." : ".") +
        (cat.omitted ? ` Your vault is large: ${cat.omitted} notes were not shown to Claude.` : "");

      if (settings.autoAcceptIngest) {
        if (!proposal.suitable) {
          new Notice(`${file.name} stays in ${this.folder}: ${proposal.reason}`, 12000);
          return;
        }
      } else {
        const edited = await reviewProposal(app, file.name, proposal, cat, note);
        if (!edited) {
          new Notice(`${file.name} stays in ${this.folder}.`);
          return;
        }
        proposal = edited;
      }

      const report = await applyIngest(
        {
          io,
          cat,
          layout,
          updateFolderIndexes: settings.updateFolderIndexes,
          convert: async (p) => {
            const f = app.vault.getAbstractFileByPath(p);
            if (!(f instanceof TFile)) throw new Error(`Filed original not found: ${p}`);
            return convertVaultFile(plugin, f);
          },
        },
        file.path,
        proposal,
      );
      await this.log(io, file.name, report.notePath, proposal.topics.map((t) => t.name), proposal.newTopics.map((t) => t.name), proposal.related.length, outcome.costUsd, report.changed.length);

      new Notice(`Filed ${file.name}: ${report.changed.length} files updated.` + (report.warnings.length ? ` ${report.warnings.join(" ")}` : ""), 8000);
      const noteFile = app.vault.getAbstractFileByPath(report.notePath);
      if (noteFile instanceof TFile) {
        plugin.pairing.link(report.originalPath, report.notePath);
        await app.workspace.getLeaf(false).openFile(noteFile);
      }
    } finally {
      status.hide();
    }
  }

  private async log(io: ObsidianIO, file: string, notePath: string, topics: string[], newTopics: string[], related: number, cost: number, changed: number): Promise<void> {
    const logPath = `${this.folder}/_log.md`;
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const line = `- ${stamp} **${file}** -> [[${notePath.slice(0, -3)}]] | topics: ${topics.join(", ") || "none"}${newTopics.length ? ` | new topics: ${newTopics.join(", ")}` : ""} | ${related} related | ${changed} files updated | about $${cost.toFixed(3)}`;
    if (await io.exists(logPath)) await io.edit(logPath, (t) => t.replace(/\s+$/, "") + "\n" + line + "\n");
    else await io.write(logPath, `# Ingest log\n\nEvery document filed from this folder, newest last.\n\n${line}\n`);
  }
}
