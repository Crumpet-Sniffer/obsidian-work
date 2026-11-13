export interface Run {
  text: string;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  href?: string;
}

/** Escape characters that would change Markdown meaning, while keeping notes readable. */
export function escapeMd(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/(^|[^A-Za-z0-9])_|_(?![A-Za-z0-9])/g, (m) => m.replace("_", "\\_"))
    .replace(/`/g, "\\`")
    .replace(/\[\[/g, "\\[\\[")
    .replace(/\]\]/g, "\\]\\]")
    .replace(/%%/g, "\\%\\%")
    .replace(/<(?=[A-Za-z/!])/g, "\\<");
}

/** Make sure a whole line can't be read as a heading, quote, list or rule. */
export function escapeLineStart(line: string): string {
  return line
    .replace(/^(\s*)(#{1,6}\s)/, "$1\\$2")
    .replace(/^(\s*)>/, "$1\\>")
    .replace(/^(\s*)([-+*])(\s)/, "$1\\$2$3")
    .replace(/^(\s*)(\d+)([.)])(\s)/, "$1$2\\$3$4")
    .replace(/^(\s*)(-{3,}|_{3,}|={3,})\s*$/, "$1\\$2");
}

function sameFmt(a: Run, b: Run): boolean {
  return !!a.b === !!b.b && !!a.i === !!b.i && !!a.u === !!b.u && (a.href ?? "") === (b.href ?? "");
}

/** Merge neighbouring runs with identical formatting so we don't emit `**a****b**`. */
export function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out[out.length - 1];
    if (last && sameFmt(last, r)) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

function wrap(text: string, mark: (t: string) => string): string {
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
  return m[2] ? m[1] + mark(m[2]) + m[3] : text;
}

export function renderRuns(runs: Run[], opts: { pipes?: boolean } = {}): string {
  let out = "";
  for (const r of mergeRuns(runs)) {
    let t = escapeMd(r.text);
    if (opts.pipes) t = t.replace(/\|/g, "\\|");
    if (r.u) t = wrap(t, (x) => `<u>${x}</u>`);
    if (r.i) t = wrap(t, (x) => `*${x}*`);
    if (r.b) t = wrap(t, (x) => `**${x}**`);
    if (r.href) t = wrap(t, (x) => `[${x}](${r.href!.replace(/ /g, "%20").replace(/\)/g, "%29")})`);
    out += t;
  }
  return out;
}

export function plainWords(s: string): number {
  return (s.match(/[A-Za-z0-9]+/g) ?? []).length;
}

/** Collapse whitespace inside a line but keep deliberate newlines. */
export function tidyLine(s: string): string {
  return s.replace(/[ \t ]+/g, " ").replace(/ *\n */g, "\n").trim();
}
