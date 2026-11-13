import type { App } from "obsidian";
import JSZip from "jszip";
import { hash } from "../convert/images";
import { OFFICE_EXTENSIONS } from "../constants";

const LOGO_FILES = 5; // an image shared by this many files is a template logo
const RASTER = /\.(png|jpe?g|gif|bmp|svg|webp)$/i;

/** Which image hashes appear in which originals, so repeated template logos can be skipped. */
export class ImageIndex {
  private byHash = new Map<string, Set<string>>();
  private built = false;

  constructor(private app: App, private originalsDir: () => string, private persist: () => Promise<void>) {}

  load(data: Record<string, string[]> | undefined): void {
    this.byHash.clear();
    for (const [h, files] of Object.entries(data ?? {})) this.byHash.set(h, new Set(files));
    this.built = this.byHash.size > 0;
  }

  toJSON(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [h, s] of this.byHash) out[h] = [...s];
    return out;
  }

  isLogo = (h: string): boolean => (this.byHash.get(h)?.size ?? 0) >= LOGO_FILES;

  update(path: string, hashes: string[]): void {
    for (const s of this.byHash.values()) s.delete(path);
    for (const h of hashes) (this.byHash.get(h) ?? this.byHash.set(h, new Set()).get(h)!).add(path);
    for (const [h, s] of this.byHash) if (!s.size) this.byHash.delete(h);
  }

  /** Scan every original once (only if the index has never been built). */
  async ensureBuilt(onProgress?: (done: number, total: number) => void): Promise<void> {
    if (this.built) return;
    await this.rebuild(onProgress);
  }

  async rebuild(onProgress?: (done: number, total: number) => void): Promise<void> {
    this.byHash.clear();
    const files = await this.listOriginals(this.originalsDir());
    let done = 0;
    for (const path of files) {
      try {
        const zip = await JSZip.loadAsync(await this.app.vault.adapter.readBinary(path));
        const hashes: string[] = [];
        for (const name of Object.keys(zip.files)) {
          if (zip.files[name].dir || !/\/media\//.test(name) || !RASTER.test(name)) continue;
          hashes.push(hash(await zip.file(name)!.async("uint8array")));
        }
        this.update(path, hashes);
      } catch (e) {
        console.warn("[Microsidian] could not index", path, e);
      }
      onProgress?.(++done, files.length);
    }
    this.built = true;
    await this.persist();
  }

  private async listOriginals(dir: string, out: string[] = []): Promise<string[]> {
    const ad = this.app.vault.adapter;
    if (!(await ad.exists(dir))) return out;
    const { files, folders } = await ad.list(dir);
    for (const f of files) if (OFFICE_EXTENSIONS.includes(f.split(".").pop()!.toLowerCase())) out.push(f);
    for (const d of folders) await this.listOriginals(d, out);
    return out;
  }
}
