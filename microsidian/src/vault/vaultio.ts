/**
 * The few vault operations the ingest logic needs. Obsidian implements it with its Vault API,
 * and the test scripts implement it on a plain folder, so the same code can be tested without Obsidian.
 */
export interface VaultIO {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  /** Create or overwrite a text file (parent folders are created). */
  write(path: string, text: string): Promise<void>;
  /** Atomic read-modify-write of a text file. */
  edit(path: string, fn: (text: string) => string): Promise<void>;
  /** Move/rename a file (parent folders are created). */
  rename(from: string, to: string): Promise<void>;
  readBinary(path: string): Promise<Uint8Array>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  /** Vault paths of all Markdown notes (not inside the originals, attachments or ingest folders). */
  markdownPaths(): string[];
  /** Resolve a bare link name such as "Topics - Index" to a vault path, or null. */
  resolve(name: string): string | null;
}

/** Minimal reader for the frontmatter these notes use (`key: "string"`, `key: [json, array]`). */
export function parseFrontmatter(text: string): Record<string, string | string[]> {
  const m = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---/);
  const out: Record<string, string | string[]> = {};
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) continue;
    const v = kv[2].trim();
    if (v.startsWith("[")) {
      try {
        out[kv[1]] = JSON.parse(v);
      } catch {
        out[kv[1]] = v
          .slice(1, -1)
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter(Boolean);
      }
    } else out[kv[1]] = v.replace(/^"(.*)"$/, "$1");
  }
  return out;
}
