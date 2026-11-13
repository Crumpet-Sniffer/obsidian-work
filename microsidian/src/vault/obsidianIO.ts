import { App, TFile } from "obsidian";
import type { Layout } from "../config";
import { under } from "../config";
import type { VaultIO } from "./vaultio";

/** VaultIO backed by Obsidian's Vault API. */
export class ObsidianIO implements VaultIO {
  constructor(private app: App, private layout: Layout) {}

  private file(path: string): TFile | null {
    const f = this.app.vault.getAbstractFileByPath(path);
    return f instanceof TFile ? f : null;
  }

  private async mkdirs(path: string): Promise<void> {
    const dir = path.slice(0, Math.max(0, path.lastIndexOf("/")));
    if (!dir || (await this.app.vault.adapter.exists(dir))) return;
    await this.app.vault.adapter.mkdir(dir);
  }

  exists(path: string): Promise<boolean> {
    return this.app.vault.adapter.exists(path);
  }

  async read(path: string): Promise<string> {
    const f = this.file(path);
    return f ? this.app.vault.cachedRead(f) : this.app.vault.adapter.read(path);
  }

  async write(path: string, text: string): Promise<void> {
    await this.mkdirs(path);
    const f = this.file(path);
    if (f) await this.app.vault.modify(f, text);
    else if (await this.app.vault.adapter.exists(path)) await this.app.vault.adapter.write(path, text);
    else await this.app.vault.create(path, text);
  }

  async edit(path: string, fn: (text: string) => string): Promise<void> {
    const f = this.file(path);
    if (f) await this.app.vault.process(f, fn);
    else await this.app.vault.adapter.process(path, fn);
  }

  async rename(from: string, to: string): Promise<void> {
    await this.mkdirs(to);
    const f = this.file(from);
    if (!f) throw new Error(`File not found: ${from}`);
    await this.app.fileManager.renameFile(f, to);
  }

  async readBinary(path: string): Promise<Uint8Array> {
    return new Uint8Array(await this.app.vault.adapter.readBinary(path));
  }

  async writeBinary(path: string, data: Uint8Array): Promise<void> {
    await this.mkdirs(path);
    const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    await this.app.vault.adapter.writeBinary(path, ab);
  }

  markdownPaths(): string[] {
    // topic pages are included (the catalogue reads them); originals, attachments and the ingest folder are not
    const { originals, attachments, ingest } = this.layout;
    const skip = [originals, attachments.split("/")[0], ingest];
    return this.app.vault
      .getMarkdownFiles()
      .map((f) => f.path)
      .filter((p) => !skip.some((s) => under(p, s)) && !p.split("/").some((seg) => seg.startsWith(".")));
  }

  resolve(name: string): string | null {
    return this.app.metadataCache.getFirstLinkpathDest(name, "")?.path ?? null;
  }
}
