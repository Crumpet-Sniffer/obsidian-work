import type { Catalogue } from "../ai/catalogue";
import type { IngestAnalysis } from "../ai/schema";
import type { Layout } from "../config";
import { isSystemPath, trimFolder } from "../config";

export interface Proposal {
  /** False when Claude says the owner's guidance says not to file this document. */
  suitable: boolean;
  reason: string;
  /** Folder from the vault root. */
  folderPath: string;
  topics: { name: string; phrases: string[] }[];
  newTopics: { name: string; theme: string; definition: string; phrases: string[] }[];
  related: { path: string; reason: string }[];
  /** Things the checks changed or dropped, shown to the user. */
  warnings: string[];
}

const cleanSeg = (s: string) => s.replace(/[\\:*?"<>|#^[\]]/g, "").replace(/\s+/g, " ").trim();
const lc = (s: string) => s.toLowerCase();

/** Keep only phrases that really occur in the document (case-insensitive), at most `max`. */
export function realPhrases(phrases: string[], doc: string, max = 4): string[] {
  const hay = lc(doc);
  const out: string[] = [];
  for (const p of phrases) {
    const t = p.replace(/\s+/g, " ").trim();
    if (t.length >= 3 && hay.includes(lc(t)) && !out.some((x) => lc(x) === lc(t))) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** Check Claude's answer against what really exists in the vault and the document; drop anything invented. */
export function validate(a: IngestAnalysis, cat: Catalogue, doc: string, layout: Layout): Proposal {
  const warnings: string[] = [];

  // folder
  let folder = trimFolder(a.folderPath).split("/").map(cleanSeg).filter(Boolean).join("/");
  const known = cat.folders.find((f) => lc(f) === lc(folder));
  if (known) folder = known;
  else if (folder && cat.folders.length) warnings.push(`New folder: "${folder}" does not exist yet and will be created.`);
  if (folder && isSystemPath(folder + "/x", layout)) {
    warnings.push(`"${folder}" is one of Microsidian's own folders or starts with a dot; the note will go in the vault root instead. Pick a folder below.`);
    folder = "";
  }

  // topics
  const byName = new Map(cat.topics.map((t) => [lc(t.name), t.name]));
  const topics: Proposal["topics"] = [];
  for (const t of a.topics) {
    const name = byName.get(lc(t.name.trim()));
    if (!name) {
      warnings.push(`Dropped unknown topic "${t.name}".`);
      continue;
    }
    if (topics.some((x) => x.name === name)) continue;
    const phrases = realPhrases(t.phrases, doc);
    if (t.phrases.length > phrases.length) warnings.push(`${name}: dropped phrases not found in the document.`);
    topics.push({ name, phrases });
  }

  const newTopics: Proposal["newTopics"] = [];
  for (const t of a.newTopics) {
    const name = cleanSeg(t.name);
    if (!name || byName.has(lc(name)) || newTopics.some((x) => lc(x.name) === lc(name)) || !t.definition.trim()) continue;
    let theme = t.theme.trim();
    if (cat.themes.length) {
      const match = cat.themes.find((x) => lc(x) === lc(theme));
      if (!match) {
        warnings.push(`New topic "${name}": unknown theme "${theme}", using "${cat.themes[0]}".`);
        theme = cat.themes[0];
      } else theme = match;
    } else theme = "";
    newTopics.push({ name, theme, definition: t.definition.trim(), phrases: realPhrases(t.phrases, doc) });
  }

  // related notes
  const paths = new Set(cat.notes.map((n) => n.path));
  const related: Proposal["related"] = [];
  for (const r of a.relatedNotes) {
    const p = r.path.replace(/^\[\[|\]\]$/g, "").replace(/\.md$/, "").trim();
    if (!paths.has(p)) {
      warnings.push(`Dropped a related note that does not exist: ${p}`);
      continue;
    }
    if (!related.some((x) => x.path === p)) related.push({ path: p, reason: r.reason.trim() });
    if (related.length >= 6) break;
  }

  return { suitable: a.suitable, reason: a.reason, folderPath: folder, topics, newTopics, related, warnings };
}
