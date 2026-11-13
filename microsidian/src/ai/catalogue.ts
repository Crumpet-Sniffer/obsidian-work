import type { Layout } from "../config";
import { under } from "../config";
import { extractConnections } from "../connections";
import { topicsFromConnections } from "../vault/linker";
import { eol } from "../vault/notes";
import { parseFrontmatter, VaultIO } from "../vault/vaultio";

export interface NoteInfo {
  path: string; // vault path without ".md"
  folder: string; // "" for notes at the vault root
  title: string;
  topics: string[];
}
export interface TopicInfo {
  name: string;
  theme: string;
  definition: string;
  phrases: string[];
}
export interface Catalogue {
  folders: string[];
  topics: TopicInfo[];
  themes: string[];
  notes: NoteInfo[];
  /** Notes left out of the list because the vault is large. */
  omitted: number;
  /** The catalogue rendered as prompt text. */
  text: string;
}

/** Most notes listed to Claude; keeps the request size (and cost) bounded on large vaults. */
export const MAX_NOTES = 500;

const isIndexNote = (title: string, layout: Layout) => title === layout.topicsIndex || / - Index$/.test(title) || title === "Home";

export async function buildCatalogue(io: VaultIO, layout: Layout): Promise<Catalogue> {
  const mds = io.markdownPaths();

  // topics
  const topics: TopicInfo[] = [];
  for (const p of mds.filter((p) => under(p, layout.topics))) {
    const text = eol(await io.read(p));
    const fm = parseFrontmatter(text);
    topics.push({
      name: p.slice(layout.topics.length + 1, -3),
      theme: typeof fm.theme === "string" ? fm.theme : "",
      definition: text.match(/^> (.+)$/m)?.[1] ?? "",
      phrases: Array.isArray(fm.phrases) ? fm.phrases : [],
    });
  }
  topics.sort((a, b) => a.theme.localeCompare(b.theme) || a.name.localeCompare(b.name));
  const themes = [...new Set(topics.map((t) => t.theme).filter(Boolean))];

  // notes
  const candidates = mds
    .filter((p) => !under(p, layout.topics))
    .filter((p) => !isIndexNote(p.split("/").pop()!.slice(0, -3), layout))
    .sort();
  const listed = candidates.slice(0, MAX_NOTES);
  const notes: NoteInfo[] = [];
  for (const p of listed) {
    const text = eol(await io.read(p));
    const parts = p.split("/");
    notes.push({
      path: p.slice(0, -3),
      folder: parts.slice(0, -1).join("/"),
      title: parts[parts.length - 1].slice(0, -3),
      topics: topicsFromConnections(extractConnections(text) ?? "", layout.topics),
    });
  }
  const omitted = candidates.length - listed.length;

  const folderSet = new Set<string>();
  for (const n of notes) {
    const segs = n.folder.split("/").filter(Boolean);
    for (let i = 1; i <= segs.length; i++) folderSet.add(segs.slice(0, i).join("/"));
  }
  const folders = [...folderSet].sort();

  const text = render({ folders, topics, themes, notes, omitted });
  return { folders, topics, themes, notes, omitted, text };
}

function render(c: Omit<Catalogue, "text">): string {
  const out: string[] = ["# VAULT CATALOGUE", ""];
  out.push("## Folders that contain notes (folderPath is a path from the vault root)", "");
  out.push(...(c.folders.length ? c.folders.map((f) => `- ${f}`) : ["(the vault has no notes yet)"]), "");
  out.push("## Topics (use these exact names)", "");
  if (!c.topics.length) out.push("(there are no topic pages yet)");
  let theme: string | null = null;
  for (const t of c.topics) {
    if (t.theme !== theme) {
      theme = t.theme;
      if (theme) out.push(`### Theme: ${theme}`);
    }
    out.push(`- ${t.name}${t.definition ? `: ${t.definition}` : ""}`);
  }
  out.push("", "## Existing notes (path | topics)", "");
  for (const n of c.notes) out.push(`${n.path} | ${n.topics.slice(0, 6).join(", ")}`);
  if (c.omitted) out.push(`(${c.omitted} more notes are not listed)`);
  return out.join("\n");
}
