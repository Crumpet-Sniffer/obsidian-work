import type { BatchNote, Catalogue, TopicInfo } from "../ai/catalogue";
import { withBatch } from "../ai/catalogue";
import type { BatchPlan } from "../ai/plan";
import type { IngestAnalysis } from "../ai/schema";
import type { Layout } from "../config";
import { noteName } from "../vault/apply";
import { checkFolder, cleanSeg, type Proposal } from "./proposal";

const lc = (s: string) => s.toLowerCase();

/** What the plan decided for one document, after the checks. */
export interface PlannedDoc {
  id: string;
  fileName: string;
  suitable: boolean;
  reason: string;
  folder: string;
  /** Vault path of its note without ".md": where applyIngest will put it, filing in batch order. */
  notePath: string;
  summary: string;
  topics: string[];
}

export interface CheckedPlan {
  newTopics: TopicInfo[];
  /** By document id. Documents the plan left out are missing here and are filed on their own. */
  docs: Map<string, PlannedDoc>;
  /** The vault catalogue plus the planned topics and every suitable document of the batch. */
  catalogue: Catalogue;
}

/**
 * Check Claude's plan against the vault: drop invented topics, clean folders, and work out each note's path.
 * `files` must be in the order the batch will be filed; `exists` says whether a vault path is already taken.
 */
export function checkPlan(
  plan: BatchPlan,
  cat: Catalogue,
  layout: Layout,
  files: { id: string; fileName: string }[],
  exists: (path: string) => boolean,
): CheckedPlan {
  const known = new Map(cat.topics.map((t) => [lc(t.name), t.name]));
  const newTopics: TopicInfo[] = [];
  for (const t of plan.newTopics) {
    const name = cleanSeg(t.name);
    if (!name || known.has(lc(name)) || !t.definition.trim()) continue;
    let theme = t.theme.trim();
    if (cat.themes.length) theme = cat.themes.find((x) => lc(x) === lc(theme)) ?? cat.themes[0];
    else theme = "";
    known.set(lc(name), name);
    newTopics.push({ name, theme, definition: t.definition.trim(), phrases: [] });
  }

  const docs = new Map<string, PlannedDoc>();
  const taken = new Set<string>();
  const batch: BatchNote[] = [];
  for (const f of files) {
    const d = plan.documents.find((x) => x.id === f.id);
    if (!d) continue;
    const folder = checkFolder(d.folderPath, cat, layout, []);
    const stem = `${folder ? folder + "/" : ""}${noteName(f.fileName)}`;
    let notePath = stem;
    if (d.suitable) {
      for (let i = 2; exists(`${notePath}.md`) || taken.has(lc(notePath)); i++) notePath = `${stem} (${i})`;
      taken.add(lc(notePath));
    }
    const topics = [...new Set(d.topics.map((n) => known.get(lc(n.trim()))).filter((n): n is string => !!n))];
    const pd: PlannedDoc = { id: f.id, fileName: f.fileName, suitable: d.suitable, reason: d.reason.trim(), folder, notePath, summary: d.summary.trim(), topics };
    docs.set(f.id, pd);
    if (d.suitable) {
      const parts = notePath.split("/");
      batch.push({ path: notePath, folder, title: parts[parts.length - 1], topics, summary: pd.summary });
    }
  }

  return { newTopics, docs, catalogue: withBatch(cat, newTopics, batch) };
}

/**
 * A topic the catalogue already lists (an existing one or one planned for the batch) that Claude gives as a new
 * topic is the same topic: move it to `topics`, where validate keeps it, instead of letting validate drop it.
 */
export function mergeKnownTopics(a: IngestAnalysis, cat: Catalogue): IngestAnalysis {
  const names = new Map(cat.topics.map((t) => [lc(t.name), t.name]));
  const topics = [...a.topics];
  const newTopics = a.newTopics.filter((t) => {
    const name = names.get(lc(cleanSeg(t.name)));
    if (!name) return true;
    if (!topics.some((x) => lc(x.name) === lc(name))) topics.push({ name, phrases: t.phrases });
    return false;
  });
  return { ...a, topics, newTopics };
}

/** What one document's own call is told about the plan. */
export function planNote(d: PlannedDoc, total: number): string {
  return [
    `This document is one of ${total} added together.`,
    `Folder chosen for it: ${d.folder ? `"${d.folder}"` : "the vault root"}.`,
    `Its note will be: ${d.notePath}`,
    d.topics.length ? `Topics planned for it: ${d.topics.join(", ")}.` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Bring one document's checked answer in line with the plan: the planned folder, no link to itself, and planned
 * topics whose page does not exist yet are created by this document (the first of the batch to use them).
 * `d` is null for a document the plan left out: it keeps its own folder, but it is still checked against the
 * batch's catalogue, so the planned topics it uses still need their pages.
 */
export async function fitToPlan(
  p: Proposal,
  d: PlannedDoc | null,
  plan: CheckedPlan,
  topicPageExists: (name: string) => Promise<boolean>,
): Promise<Proposal> {
  const planned = new Map(plan.newTopics.map((t) => [t.name, t]));
  const topics: Proposal["topics"] = [];
  const newTopics = [...p.newTopics];
  for (const t of p.topics) {
    const nt = planned.get(t.name);
    if (nt && !(await topicPageExists(t.name)) && !newTopics.some((x) => x.name === t.name)) {
      newTopics.push({ name: nt.name, theme: nt.theme, definition: nt.definition, phrases: t.phrases });
    } else topics.push(t);
  }
  if (!d) return { ...p, topics, newTopics };
  return { ...p, folderPath: d.folder, topics, newTopics, related: p.related.filter((r) => r.path !== d.notePath) };
}
