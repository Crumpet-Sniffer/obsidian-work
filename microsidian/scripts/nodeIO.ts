import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_LAYOUT, Layout, under } from "../src/config";
import type { VaultIO } from "../src/vault/vaultio";

/** VaultIO on a plain folder, for tests that must not touch the real vault. */
export class NodeIO implements VaultIO {
  constructor(public root: string, private layout: Layout = DEFAULT_LAYOUT) {}
  private p = (x: string) => join(this.root, x);
  async exists(path: string) { return existsSync(this.p(path)); }
  async read(path: string) { return readFileSync(this.p(path), "utf8"); }
  async write(path: string, text: string) { mkdirSync(dirname(this.p(path)), { recursive: true }); writeFileSync(this.p(path), text); }
  async edit(path: string, fn: (t: string) => string) { writeFileSync(this.p(path), fn(readFileSync(this.p(path), "utf8"))); }
  async rename(from: string, to: string) { mkdirSync(dirname(this.p(to)), { recursive: true }); renameSync(this.p(from), this.p(to)); }
  async readBinary(path: string) { return new Uint8Array(readFileSync(this.p(path))); }
  async writeBinary(path: string, data: Uint8Array) { mkdirSync(dirname(this.p(path)), { recursive: true }); writeFileSync(this.p(path), data); }
  list(dir = "", out: string[] = []): string[] {
    if (!existsSync(this.p(dir || "."))) return out;
    for (const f of readdirSync(this.p(dir || "."))) {
      const rel = dir ? `${dir}/${f}` : f;
      statSync(this.p(rel)).isDirectory() ? this.list(rel, out) : out.push(rel);
    }
    return out;
  }
  markdownPaths() {
    const skip = [this.layout.originals, this.layout.attachments.split("/")[0], this.layout.ingest];
    return this.list().filter((f) => f.endsWith(".md") && !skip.some((s) => under(f, s)) && !f.split("/").some((s) => s.startsWith(".")));
  }
  resolve(name: string) {
    const m = this.markdownPaths();
    return m.find((f) => f === `${name}.md`) ?? m.find((f) => f.endsWith(`/${name}.md`)) ?? null;
  }
}
