import { CONN_START } from "../constants";

export const eol = (s: string): string => s.replace(/\r\n/g, "\n");

export interface HeadInfo {
  source: string; // vault path of the original
  name: string;
  ext: string; // docx | pptx
}

/** Frontmatter, title and the "Original:" link line. */
export function buildHead(h: HeadInfo): string {
  return [
    "---",
    `source: "${h.source}"`,
    `tags: [${h.ext}]`,
    "---",
    "",
    `# ${h.name}`,
    `Original: [[${h.source}|Open original file]]`,
  ].join("\n");
}

export interface NoteParts {
  /** Everything up to and including the "Original:" line. */
  head: string;
  /** The converted content. */
  body: string;
  /** The Connections block (from its start marker to the end), or "". */
  connections: string;
}

export function splitNote(text: string): NoteParts | null {
  const t = eol(text);
  const m = t.match(/^Original: .*$/m);
  if (!m || m.index === undefined) return null;
  const headEnd = m.index + m[0].length;
  const c = t.indexOf(CONN_START);
  return {
    head: t.slice(0, headEnd),
    body: t.slice(headEnd, c < 0 ? undefined : c).trim(),
    connections: c < 0 ? "" : t.slice(c).trimEnd(),
  };
}

export function composeNote(head: string, body: string, opts: { visual?: boolean; connections?: string } = {}): string {
  const warn = opts.visual
    ? "> [!warning] Mostly visual\n> Little text could be extracted (diagrams, shapes or images). Open the original file to see it properly.\n\n"
    : "";
  return head + "\n\n" + warn + body.trim() + (opts.connections ? "\n\n" + opts.connections : "") + "\n";
}

/** True when a converted note has almost no text and no images. */
export function isMostlyVisual(words: number, imageCount: number): boolean {
  return words < 40 && imageCount === 0;
}
