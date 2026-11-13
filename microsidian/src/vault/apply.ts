import type { Catalogue } from "../ai/catalogue";
import type { ConvertResult } from "../convert";
import type { Proposal } from "../ingest/proposal";
import type { Layout } from "../config";
import { topFolder } from "../config";
import { CONN_END, CONN_START } from "../constants";
import { escapeRe } from "../connections";
import { addInlineLinks } from "./linker";
import { buildHead, composeNote, isMostlyVisual } from "./notes";
import { addNoteToFolderIndex, addNoteToTopicPage, addToConnections, newTopicPage, updateTopicsIndex } from "./edits";
import type { VaultIO } from "./vaultio";

export interface ApplyEnv {
  io: VaultIO;
  cat: Catalogue;
  layout: Layout;
  /** Add the note to a "<top folder> - Index" note when one exists. */
  updateFolderIndexes: boolean;
  /** Convert the original at this vault path and save its images. */
  convert(path: string): Promise<ConvertResult>;
}

export interface ApplyReport {
  notePath: string;
  originalPath: string;
  changed: string[];
  warnings: string[];
}

const basename = (p: string) => p.split("/").pop()!;

async function uniquePath(io: VaultIO, path: string): Promise<string> {
  if (!(await io.exists(path))) return path;
  const dot = path.lastIndexOf(".");
  const stem = path.slice(0, dot);
  const ext = path.slice(dot);
  for (let i = 2; i < 100; i++) if (!(await io.exists(`${stem} (${i})${ext}`))) return `${stem} (${i})${ext}`;
  throw new Error(`Could not find a free name for ${path}`);
}

function countMentions(body: string, phrases: string[]): number {
  if (!phrases.length) return 1;
  const rx = new RegExp(`(?<![\\w])(?:${[...new Set(phrases)].map(escapeRe).join("|")})(?![\\w])`, "gi");
  return Math.max(1, (body.match(rx) ?? []).length);
}

export async function applyIngest(env: ApplyEnv, ingestPath: string, p: Proposal): Promise<ApplyReport> {
  const { io, cat, layout } = env;
  const changed: string[] = [];
  const warnings: string[] = [];
  const touch = (path: string) => {
    if (!changed.includes(path)) changed.push(path);
  };

  const fileName = basename(ingestPath);
  const dot = fileName.lastIndexOf(".");
  const ext = fileName.slice(dot + 1).toLowerCase();
  const name = fileName.slice(0, dot).replace(/[​[\]#^|]/g, "").replace(/\s+/g, " ").trim();
  const folder = p.folderPath;
  const sub = folder ? `/${folder}` : "";

  // 1. file the original (the originals folder mirrors the note's folder)
  const originalPath = await uniquePath(io, `${layout.originals}${sub}/${fileName}`);
  await io.rename(ingestPath, originalPath);
  touch(originalPath);

  // 2. convert it (images are saved by the converter's environment)
  const res = await env.convert(originalPath);

  // 3. topics and links
  const defaults = new Map(cat.topics.map((t) => [t.name, t.phrases]));
  const allTopics = [
    ...p.topics.map((t) => ({ name: t.name, phrases: [...t.phrases, ...(defaults.get(t.name) ?? [])] })),
    ...p.newTopics.map((t) => ({ name: t.name, phrases: t.phrases })),
  ];
  const linked = addInlineLinks(res.body, allTopics, layout.topics);

  // 4. connections block
  const notePath = await uniquePath(io, `${folder ? folder + "/" : ""}${name}.md`);
  const noteKey = notePath.slice(0, -3);
  const label = basename(noteKey);
  const conn: string[] = [CONN_START, "", "---", "## Connections", ""];
  if (allTopics.length) conn.push("**Topics:** " + allTopics.map((t) => `[[${layout.topics}/${t.name}|${t.name}]]`).join(" · "), "");
  if (p.related.length) conn.push("**Related notes**", ...p.related.map((r) => `- [[${r.path}|${basename(r.path)}]]: ${r.reason}`), "");
  conn.push(CONN_END);
  const hasConn = allTopics.length > 0 || p.related.length > 0;

  const text = composeNote(buildHead({ source: originalPath, name, ext }), linked.body, {
    visual: isMostlyVisual(res.words, res.images.length),
    connections: hasConn ? conn.join("\n") : undefined,
  });
  await io.write(notePath, text);
  touch(notePath);

  // 5. topic pages
  const indexNote = io.resolve(layout.topicsIndex);
  for (const t of p.newTopics) {
    const page = `${layout.topics}/${t.name}.md`;
    if (!(await io.exists(page))) await io.write(page, newTopicPage(t, indexNote ? layout.topicsIndex : null));
  }
  const section = topFolder(folder) || "(vault root)";
  for (const t of allTopics) {
    const page = `${layout.topics}/${t.name}.md`;
    const count = countMentions(res.body, t.phrases);
    await io.edit(page, (txt) => addNoteToTopicPage(txt, { section, notePath: noteKey, label, count }));
    touch(page);
  }

  // 6. topics index (only when the note exists)
  if (indexNote && allTopics.length) {
    await io.edit(indexNote, (txt) => {
      let out = txt;
      for (const t of allTopics) {
        const nt = p.newTopics.find((x) => x.name === t.name);
        out = updateTopicsIndex(out, { name: t.name, topicsFolder: layout.topics, theme: nt?.theme, isNew: !!nt });
      }
      return out;
    });
    touch(indexNote);
  }

  // 7. folder index note: "<top folder> - Index", when it exists
  const top = topFolder(folder);
  if (env.updateFolderIndexes && top) {
    const idx = io.resolve(`${top} - Index`);
    if (idx) {
      const rel = folder.split("/").slice(1);
      const rest = rel.slice(1).join(" / ");
      await io.edit(idx, (txt) => addNoteToFolderIndex(txt, { section: rel[0] ?? "(top level)", label: rest ? `${rest} - ${name}` : name, notePath: noteKey }));
      touch(idx);
    }
  }

  // 8. back-links in related notes (only notes that already have a Connections block)
  const skipped: string[] = [];
  for (const r of p.related) {
    const file = `${r.path}.md`;
    if (!(await io.exists(file))) continue;
    let didChange = false;
    await io.edit(file, (txt) => {
      const next = addToConnections(txt, `- [[${noteKey}|${label}]]: ${r.reason}`);
      didChange = next !== txt.replace(/\r\n/g, "\n");
      return didChange ? next : txt;
    });
    if (didChange) touch(file);
    else if (!(await io.read(file)).includes(CONN_START)) skipped.push(basename(r.path));
  }
  if (skipped.length) warnings.push(`Not back-linked (no Connections block): ${skipped.join(", ")}.`);

  return { notePath, originalPath, changed, warnings };
}
