import { CONN_END, CONN_START } from "../constants";
import { escapeRe } from "../connections";
import { eol } from "./notes";

/** Pure text edits for the generated pages (topic pages, indexes, Connections blocks). */

const tidy = (lines: string[]): string => lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";

function sectionEnd(lines: string[], start: number): number {
  for (let i = start + 1; i < lines.length; i++) if (/^#{1,2} /.test(lines[i])) return i;
  return lines.length;
}

/** Headings the plugin never reorders: they stay at the end of a topic page. */
const RESERVED = ["## Reference documents", "## Related topics"];
const isReserved = (h: string) => RESERVED.some((r) => h.startsWith(r));

/** Index of the first `## ` heading that should come after `head` (alphabetical, reserved ones last), or -1. */
function headingSlot(lines: string[], head: string): number {
  const mineReserved = isReserved(head);
  return lines.findIndex((l, i) => {
    if (i === 0 || !l.startsWith("## ")) return false;
    const r = isReserved(l);
    return r !== mineReserved ? r : l.toLowerCase() > head.toLowerCase();
  });
}

// ---------- topic pages ----------
export interface TopicEntry {
  /** Heading the note is listed under: its top-level folder, or "(vault root)". */
  section: string;
  notePath: string; // vault path without .md
  label: string;
  count: number;
}

export function addNoteToTopicPage(text: string, o: TopicEntry): string {
  const lines = eol(text).split("\n");
  const nf = lines.findIndex((l) => l.startsWith("*Not found in any"));
  if (nf >= 0) lines.splice(nf, 1);

  const bullet = `- [[${o.notePath}|${o.label}]]: ${o.count} mention${o.count === 1 ? "" : "s"}`;
  const head = `## ${o.section}`;
  const h = lines.indexOf(head);
  if (h < 0) {
    let at = headingSlot(lines, head);
    if (at < 0) at = lines.length;
    lines.splice(at, 0, "", head, "", bullet, "");
  } else {
    const end = sectionEnd(lines, h);
    let insertAt = -1;
    let last = -1;
    for (let i = h + 1; i < end; i++) {
      if (!lines[i].startsWith("- ")) continue;
      last = i;
      const n = Number(lines[i].match(/: (\d+) mentions?/)?.[1] ?? 0);
      if (insertAt < 0 && n < o.count) insertAt = i;
    }
    if (insertAt < 0) insertAt = last >= 0 ? last + 1 : h + 2;
    lines.splice(insertAt, 0, bullet);
  }
  return tidy(lines);
}

export interface NewTopicPage {
  name: string;
  theme: string;
  definition: string;
  phrases: string[];
}

/** A brand-new topic page, with no notes yet (add the first with addNoteToTopicPage). */
export function newTopicPage(t: NewTopicPage, indexName: string | null): string {
  return [
    "---",
    "tags: [topic]",
    ...(t.theme ? [`theme: ${JSON.stringify(t.theme)}`] : []),
    `phrases: ${JSON.stringify(t.phrases)}`,
    "---",
    "",
    `# ${t.name}`,
    "",
    `> ${t.definition}`,
    "",
    ...(t.theme && indexName ? [`**Theme:** [[${indexName}#${t.theme}|${t.theme}]]`, ""] : []),
  ].join("\n");
}

// ---------- topics index ----------
/** Count one more note for an existing topic, or list a new topic (under its theme heading when there is one). */
export function updateTopicsIndex(text: string, o: { name: string; topicsFolder: string; theme?: string; isNew: boolean }): string {
  const lines = eol(text).split("\n");
  const link = `[[${o.topicsFolder}/${o.name}|${o.name}]]`;
  const rx = new RegExp(`^- ${escapeRe(link)}: (\\d+) (lessons?|notes?)(.*)$`);
  const i = lines.findIndex((l) => rx.test(l));
  if (i >= 0) {
    const m = lines[i].match(rx)!;
    const n = Number(m[1]) + 1;
    const word = m[2].startsWith("lesson") ? "lessons" : n === 1 ? "note" : "notes";
    lines[i] = `- ${link}: ${n} ${word}${m[3]}`;
  } else if (o.isNew) {
    const line = `- ${link}: 1 note`;
    const h = o.theme ? lines.indexOf(`## ${o.theme}`) : -1;
    if (h >= 0) {
      const end = sectionEnd(lines, h);
      let last = h + 1;
      for (let k = h + 1; k < end; k++) if (lines[k].startsWith("- ")) last = k;
      lines.splice(last + 1, 0, line);
    } else if (o.theme) lines.push("", `## ${o.theme}`, "", line, "");
    else lines.push(line);
  }
  return tidy(lines);
}

// ---------- folder index notes ("<top folder> - Index") ----------
export function addNoteToFolderIndex(text: string, o: { section: string; label: string; notePath: string }): string {
  const lines = eol(text).split("\n");
  const bullet = `- [[${o.notePath}|${o.label}]]`;
  const head = `## ${o.section}`;
  const h = lines.indexOf(head);
  const lab = (l: string) => (l.match(/\|([^\]]*)\]\]/)?.[1] ?? l).toLowerCase();
  if (h < 0) {
    let at = lines.findIndex((l, i) => i > 0 && l.startsWith("## ") && l.toLowerCase() > head.toLowerCase());
    if (at < 0) at = lines.length;
    lines.splice(at, 0, head, "", bullet, "");
  } else {
    const end = sectionEnd(lines, h);
    let insertAt = -1;
    let last = -1;
    for (let i = h + 1; i < end; i++) {
      if (!lines[i].startsWith("- ")) continue;
      last = i;
      if (insertAt < 0 && lab(lines[i]) > o.label.toLowerCase()) insertAt = i;
    }
    if (insertAt < 0) insertAt = last >= 0 ? last + 1 : h + 2;
    lines.splice(insertAt, 0, bullet);
  }
  return tidy(lines);
}

// ---------- Connections blocks ----------
/** Add a line to a note's "Related notes" list (or its older "Related lessons" list); creates the list when missing. */
export function addToConnections(noteText: string, line: string): string {
  const t = eol(noteText);
  const a = t.indexOf(CONN_START);
  const b = t.indexOf(CONN_END);
  if (a < 0 || b < 0) return t;
  const target = line.match(/\[\[([^\]|]+)/)?.[1];
  const block = t.slice(a, b);
  if (target && block.includes(`[[${target}|`)) return t; // already listed
  const lines = block.split("\n");
  let h = lines.indexOf("**Related notes**");
  if (h < 0) h = lines.indexOf("**Related lessons**");
  if (h >= 0) {
    let last = h;
    for (let i = h + 1; i < lines.length && lines[i].startsWith("- "); i++) last = i;
    lines.splice(last + 1, 0, line);
  } else lines.push("**Related notes**", line, "");
  return t.slice(0, a) + lines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "\n\n") + t.slice(b);
}
