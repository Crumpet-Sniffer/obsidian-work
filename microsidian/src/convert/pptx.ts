import type JSZip from "jszip";
import { Images } from "./images";
import { attr, desc, dirname, El, kid, kids, parseXml, resolvePath } from "./xml";
import { escapeLineStart, plainWords, renderRuns, Run, tidyLine } from "./text";
import type { ConvertOptions, ConvertResult } from "./types";

interface Rel {
  target: string;
  external: boolean;
  type: string;
}

async function readRels(zip: JSZip, part: string): Promise<Map<string, Rel>> {
  const m = new Map<string, Rel>();
  const f = zip.file(`${dirname(part)}/_rels/${part.split("/").pop()}.rels`);
  if (!f) return m;
  const doc = parseXml(await f.async("string"));
  for (const r of desc(doc, "Relationship")) {
    const id = attr(r, "Id");
    const t = attr(r, "Target");
    if (id && t) {
      const external = r.getAttribute("TargetMode") === "External";
      m.set(id, { target: external ? t : resolvePath(dirname(part), t), external, type: r.getAttribute("Type") ?? "" });
    }
  }
  return m;
}

/** Slide parts in presentation order (not file-number order). */
async function slideOrder(zip: JSZip): Promise<string[]> {
  const pres = zip.file("ppt/presentation.xml");
  if (!pres) throw new Error("Not a PowerPoint file: ppt/presentation.xml is missing");
  const doc = parseXml(await pres.async("string"));
  const rels = await readRels(zip, "ppt/presentation.xml");
  const out: string[] = [];
  for (const s of desc(doc, "p:sldId")) {
    const t = rels.get(attr(s, "r:id") ?? "")?.target;
    if (t && zip.file(t)) out.push(t);
  }
  if (!out.length) {
    // fall back to numeric file order
    for (const n of Object.keys(zip.files).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)))
      out.push(n);
    out.sort((a, b) => Number(a.match(/\d+/g)!.pop()) - Number(b.match(/\d+/g)!.pop()));
  }
  return out;
}

interface Acc {
  /** Blocks in slide order. */
  items: { kind: "title" | "block" | "list"; text: string }[];
}

function paraRuns(p: El, rels: Map<string, Rel>): Run[] {
  const runs: Run[] = [];
  for (const c of kids(p)) {
    if (c.nodeName === "a:r") {
      const t = kid(c, "a:t")?.textContent ?? "";
      const hl = kid(kid(c, "a:rPr"), "a:hlinkClick");
      const rel = hl ? rels.get(attr(hl, "r:id") ?? "") : undefined;
      if (t) runs.push({ text: t, href: rel?.external ? rel.target : undefined });
    } else if (c.nodeName === "a:br") {
      runs.push({ text: "\n" });
    } else if (c.nodeName === "a:fld") {
      if ((c.getAttribute("type") ?? "").startsWith("slidenum")) continue;
      const t = kid(c, "a:t")?.textContent ?? "";
      if (t) runs.push({ text: t });
    }
  }
  return runs;
}

/** Text lines of a txBody; bullets become list items. */
function bodyLines(txBody: El, rels: Map<string, Rel>): { text: string; list: boolean }[] {
  const out: { text: string; list: boolean }[] = [];
  for (const p of kids(txBody, "a:p")) {
    const t = tidyLine(renderRuns(paraRuns(p, rels)));
    if (!t) continue;
    const pPr = kid(p, "a:pPr");
    const lvl = Number(attr(pPr, "lvl") ?? 0);
    const noBullet = !!kid(pPr, "a:buNone");
    const bullet = !!kid(pPr, "a:buChar") || !!kid(pPr, "a:buAutoNum") || (lvl > 0 && !noBullet);
    if (bullet) {
      const pad = "  ".repeat(Math.min(lvl, 6));
      const mark = kid(pPr, "a:buAutoNum") ? "1." : "-";
      out.push({ text: t.split("\n").map((l, i) => (i === 0 ? `${pad}${mark} ${l}` : `${pad}  ${l}`)).join("\n"), list: true });
    } else out.push({ text: escapeLineStart(t), list: false });
  }
  return out;
}

function pushLines(acc: Acc, lines: { text: string; list: boolean }[]): void {
  if (!lines.length) return;
  acc.items.push({ kind: lines.every((l) => l.list) ? "list" : "block", text: lines.map((l) => l.text).join("\n") });
}

function table(tbl: El, rels: Map<string, Rel>): string | null {
  const rows: string[][] = [];
  for (const tr of kids(tbl, "a:tr")) {
    const cells: string[] = [];
    for (const tc of kids(tr, "a:tc")) {
      const lines = kids(kid(tc, "a:txBody"), "a:p")
        .map((p) => tidyLine(renderRuns(paraRuns(p, rels), { pipes: true })).replace(/\n/g, "<br>"))
        .filter(Boolean);
      cells.push(lines.join("<br>"));
      const span = Number(attr(tc, "gridSpan") ?? 1);
      for (let i = 1; i < span; i++) cells.push("");
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.some((r) => r.some((c) => c.trim()))) return null;
  const cols = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => "| " + Array.from({ length: cols }, (_, i) => r[i] ?? "").join(" | ") + " |";
  return [line(rows[0]), "| " + Array(cols).fill("---").join(" | ") + " |", ...rows.slice(1).map(line)].join("\n");
}

interface SlideCtx {
  zip: JSZip;
  rels: Map<string, Rel>;
  images: Images;
  seenImg: Set<string>;
  smart: Map<string, string[]>; // diagram part -> text lines (cache)
}

async function diagramText(ctx: SlideCtx, part: string): Promise<string[]> {
  const cached = ctx.smart.get(part);
  if (cached) return cached;
  const f = ctx.zip.file(part);
  const lines: string[] = [];
  if (f) {
    const doc = parseXml(await f.async("string"));
    for (const p of desc(doc, "a:p")) {
      const t = tidyLine(desc(p, "a:t").map((x) => x.textContent ?? "").join(""));
      if (t && lines[lines.length - 1] !== t) lines.push(t);
    }
  }
  ctx.smart.set(part, lines);
  return lines;
}

async function walkShapes(parent: El, ctx: SlideCtx, acc: Acc): Promise<void> {
  for (const c of kids(parent)) {
    switch (c.nodeName) {
      case "p:sp": {
        const ph = kid(kid(kid(c, "p:nvSpPr"), "p:nvPr"), "p:ph");
        const type = attr(ph, "type") ?? "";
        if (["sldNum", "dt"].includes(type)) break;
        const tx = kid(c, "p:txBody");
        if (!tx) break;
        const lines = bodyLines(tx, ctx.rels);
        if (!lines.length) break;
        if (type === "title" || type === "ctrTitle") {
          acc.items.push({ kind: "title", text: lines.map((l) => l.text).join(" ").replace(/\s+/g, " ") });
        } else pushLines(acc, lines);
        break;
      }
      case "p:pic": {
        const blip = desc(c, "a:blip")[0];
        const id = attr(blip, "r:embed");
        const part = id ? ctx.rels.get(id)?.target : null;
        const e = ctx.images.embed(part);
        if (e && !ctx.seenImg.has(e)) {
          ctx.seenImg.add(e);
          acc.items.push({ kind: "block", text: e });
        }
        break;
      }
      case "p:graphicFrame": {
        const tbl = desc(c, "a:tbl")[0];
        if (tbl) {
          const md = table(tbl, ctx.rels);
          if (md) acc.items.push({ kind: "block", text: md });
        }
        const dm = desc(c, "dgm:relIds")[0];
        const part = dm ? ctx.rels.get(attr(dm, "r:dm") ?? "")?.target : null;
        if (part) {
          const lines = await diagramText(ctx, part);
          if (lines.length) acc.items.push({ kind: "block", text: lines.map((l) => "> " + l).join("\n") });
        }
        break;
      }
      case "p:grpSp":
        await walkShapes(c, ctx, acc);
        break;
      case "mc:AlternateContent": {
        const ch = kid(c, "mc:Choice");
        if (ch) await walkShapes(ch, ctx, acc);
        break;
      }
    }
  }
}

async function notesText(zip: JSZip, rels: Map<string, Rel>): Promise<string[]> {
  const rel = [...rels.values()].find((r) => r.type.endsWith("/notesSlide"));
  const f = rel ? zip.file(rel.target) : null;
  if (!f) return [];
  const doc = parseXml(await f.async("string"));
  const nrels = await readRels(zip, rel!.target);
  const out: string[] = [];
  for (const sp of desc(doc, "p:sp")) {
    const type = attr(kid(kid(kid(sp, "p:nvSpPr"), "p:nvPr"), "p:ph"), "type");
    if (type !== "body") continue;
    const tx = kid(sp, "p:txBody");
    if (tx) for (const l of bodyLines(tx, nrels)) out.push(l.text.replace(/\n/g, " "));
  }
  return out;
}

export async function convertPptx(zip: JSZip, opts: ConvertOptions): Promise<ConvertResult> {
  const slides = await slideOrder(zip);
  const images = await Images.load(zip, opts);
  const smart = new Map<string, string[]>();
  const parts: string[] = [];
  let words = 0;

  for (const [i, part] of slides.entries()) {
    const n = i + 1;
    const doc = parseXml(await zip.file(part)!.async("string"));
    const rels = await readRels(zip, part);
    const tree = doc.getElementsByTagName("p:spTree")[0] as El | undefined;
    const acc: Acc = { items: [] };
    if (tree) await walkShapes(tree, { zip, rels, images, seenImg: new Set(), smart }, acc);

    const out: string[] = ["---", `## Slide ${n}`];
    if (opts.originalPath) out.push(`[[${opts.originalPath}#slide-${n}|▶ open slide]]`);
    out.push("");
    const title = acc.items.find((x) => x.kind === "title");
    if (title) out.push(`### ${title.text}`, "");
    const rest = acc.items.filter((x) => x.kind !== "title");
    rest.forEach((b, k) => {
      if (k) out.push(rest[k - 1].kind === "list" && b.kind === "list" ? "" : "");
      out.push(b.text);
    });
    const notes = await notesText(zip, rels);
    if (notes.length) {
      out.push("", "> [!note] Speaker notes", ...notes.map((l) => "> " + l));
    }
    const slideMd = out.join("\n").replace(/\n{3,}/g, "\n\n");
    parts.push(slideMd);
    words += plainWords(slideMd.replace(/!\[\[[^\]]*\]\]|\[\[[^\]]*\]\]/g, " ").replace(/^## Slide \d+$/m, ""));
  }

  return {
    body: "\n" + parts.join("\n\n").trim(),
    images: [...images.out.values()],
    imageHashes: [...images.hashes],
    slideCount: slides.length,
    words,
  };
}
