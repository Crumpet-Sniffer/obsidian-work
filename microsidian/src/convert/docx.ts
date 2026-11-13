import type JSZip from "jszip";
import { Images } from "./images";
import { attr, desc, dirname, El, insideOf, kid, kids, on, parseXml, resolvePath } from "./xml";
import { escapeLineStart, plainWords, renderRuns, Run, tidyLine } from "./text";
import type { ConvertOptions, ConvertResult } from "./types";

interface Rel {
  target: string;
  external: boolean;
}
interface Ctx {
  rels: Map<string, Rel>;
  headingByStyle: Map<string, number>;
  numFmt: Map<string, string>; // "numId:ilvl" -> numFmt
  images: Images;
}
interface Para {
  text: string;
  imgs: string[];
  boxes: string[];
  heading: number;
  list: { level: number; ordered: boolean } | null;
}
interface Block {
  kind: "list" | "block";
  text: string;
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
      m.set(id, { target: external ? t : resolvePath(dirname(part), t), external });
    }
  }
  return m;
}

async function readStyles(zip: JSZip): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  const f = zip.file("word/styles.xml");
  if (!f) return m;
  const doc = parseXml(await f.async("string"));
  for (const s of desc(doc, "w:style")) {
    const id = attr(s, "w:styleId");
    const name = attr(kid(s, "w:name"), "w:val")?.toLowerCase() ?? "";
    if (!id) continue;
    const h = name.match(/^heading (\d)$/);
    if (h) m.set(id, Number(h[1]));
    else if (name === "title") m.set(id, 1);
  }
  return m;
}

async function readNumbering(zip: JSZip): Promise<Map<string, string>> {
  const m = new Map<string, string>();
  const f = zip.file("word/numbering.xml");
  if (!f) return m;
  const doc = parseXml(await f.async("string"));
  const abstract = new Map<string, Map<string, string>>();
  for (const a of desc(doc, "w:abstractNum")) {
    const id = attr(a, "w:abstractNumId");
    if (!id) continue;
    const lv = new Map<string, string>();
    for (const l of kids(a, "w:lvl")) lv.set(attr(l, "w:ilvl") ?? "0", attr(kid(l, "w:numFmt"), "w:val") ?? "bullet");
    abstract.set(id, lv);
  }
  for (const n of desc(doc, "w:num")) {
    const id = attr(n, "w:numId");
    const abs = attr(kid(n, "w:abstractNumId"), "w:val");
    const lv = abs ? abstract.get(abs) : undefined;
    if (id && lv) for (const [ilvl, fmt] of lv) m.set(`${id}:${ilvl}`, fmt);
  }
  return m;
}

// ---------- paragraphs ----------
interface Acc {
  runs: Run[];
  imgs: string[];
  boxes: string[];
}

function collect(node: El, ctx: Ctx, acc: Acc, href?: string): void {
  for (const c of kids(node)) {
    switch (c.nodeName) {
      case "w:r":
        run(c, ctx, acc, href);
        break;
      case "w:hyperlink": {
        const id = attr(c, "r:id");
        const rel = id ? ctx.rels.get(id) : undefined;
        collect(c, ctx, acc, rel?.external ? rel.target : href);
        break;
      }
      case "w:ins":
      case "w:smartTag":
      case "w:sdt":
      case "w:sdtContent":
      case "w:fldSimple":
      case "w:customXml":
        collect(c, ctx, acc, href);
        break;
      case "mc:AlternateContent": {
        const ch = kid(c, "mc:Choice") ?? kid(c, "mc:Fallback");
        if (ch) collect(ch, ctx, acc, href);
        break;
      }
    }
  }
}

function run(r: El, ctx: Ctx, acc: Acc, href?: string): void {
  const rPr = kid(r, "w:rPr");
  if (rPr && kid(rPr, "w:vanish")) return;
  const u = kid(rPr, "w:u");
  const fmt = {
    b: on(kid(rPr, "w:b"), "w:val"),
    i: on(kid(rPr, "w:i"), "w:val"),
    u: !!u && (u.getAttribute("w:val") ?? "single") !== "none",
    href,
  };
  let text = "";
  for (const c of kids(r)) {
    switch (c.nodeName) {
      case "w:t":
        text += c.textContent ?? "";
        break;
      case "w:tab":
        text += " ";
        break;
      case "w:br":
        if (!["page", "column"].includes(c.getAttribute("w:type") ?? "")) text += "\n";
        break;
      case "w:cr":
        text += "\n";
        break;
      case "w:noBreakHyphen":
        text += "-";
        break;
      case "w:drawing":
      case "w:pict":
      case "w:object":
      case "mc:AlternateContent":
        media(c.nodeName === "mc:AlternateContent" ? (kid(c, "mc:Choice") ?? c) : c, ctx, acc);
        break;
    }
  }
  if (text) acc.runs.push({ text, ...fmt });
}

/** Images and text boxes hanging off a drawing/pict element. */
function media(el: El, ctx: Ctx, acc: Acc): void {
  for (const b of desc(el, "a:blip")) {
    const id = attr(b, "r:embed") ?? attr(b, "r:link");
    const e = ctx.images.embed(id ? ctx.rels.get(id)?.target : null);
    if (e && !acc.imgs.includes(e)) acc.imgs.push(e);
  }
  for (const v of desc(el, "v:imagedata")) {
    const id = attr(v, "r:id");
    const e = ctx.images.embed(id ? ctx.rels.get(id)?.target : null);
    if (e && !acc.imgs.includes(e)) acc.imgs.push(e);
  }
  for (const box of desc(el, "w:txbxContent")) {
    if (insideOf(box, "w:txbxContent", el)) continue; // outermost only
    const ps = [...kids(box, "w:p"), ...kids(box, "w:tbl").flatMap((t) => desc(t, "w:p"))];
    for (const p of ps) {
      const sub: Acc = { runs: [], imgs: [], boxes: [] };
      collect(p, ctx, sub);
      const t = tidyLine(renderRuns(sub.runs));
      if (t) acc.boxes.push(t);
    }
  }
}

function paragraph(p: El, ctx: Ctx): Para {
  const acc: Acc = { runs: [], imgs: [], boxes: [] };
  collect(p, ctx, acc);
  const pPr = kid(p, "w:pPr");
  const style = attr(kid(pPr, "w:pStyle"), "w:val");
  const heading = style ? (ctx.headingByStyle.get(style) ?? 0) : 0;
  let list: Para["list"] = null;
  const numPr = kid(pPr, "w:numPr");
  if (numPr && !heading) {
    const numId = attr(kid(numPr, "w:numId"), "w:val");
    if (numId && numId !== "0") {
      const level = Number(attr(kid(numPr, "w:ilvl"), "w:val") ?? 0);
      const fmt = ctx.numFmt.get(`${numId}:${level}`) ?? "bullet";
      list = { level, ordered: !["bullet", "none"].includes(fmt) };
    }
  }
  return { text: tidyLine(renderRuns(acc.runs)), imgs: acc.imgs, boxes: acc.boxes, heading, list };
}

// ---------- tables ----------
function cellText(tc: El, ctx: Ctx, imgs: string[], boxes: string[]): string {
  const parts: string[] = [];
  for (const c of kids(tc)) {
    if (c.nodeName === "w:p") {
      const p = paragraph(c, ctx);
      if (p.text) parts.push(p.text.replace(/\n/g, "<br>").replace(/\|/g, "\\|"));
      imgs.push(...p.imgs);
      boxes.push(...p.boxes);
    } else if (c.nodeName === "w:tbl") {
      for (const q of desc(c, "w:p")) {
        const p = paragraph(q, ctx);
        if (p.text) parts.push(p.text.replace(/\|/g, "\\|"));
        imgs.push(...p.imgs);
      }
    }
  }
  return parts.join("<br>");
}

function table(tbl: El, ctx: Ctx): { md: string; imgs: string[]; boxes: string[] } | null {
  const imgs: string[] = [];
  const boxes: string[] = [];
  const rows: string[][] = [];
  for (const tr of kids(tbl, "w:tr")) {
    const cells: string[] = [];
    for (const tc of kids(tr, "w:tc")) {
      cells.push(cellText(tc, ctx, imgs, boxes));
      const span = Number(attr(kid(kid(tc, "w:tcPr"), "w:gridSpan"), "w:val") ?? 1);
      for (let i = 1; i < span; i++) cells.push("");
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.some((r) => r.some((c) => c.trim()))) return imgs.length || boxes.length ? { md: "", imgs, boxes } : null;
  const cols = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => "| " + Array.from({ length: cols }, (_, i) => r[i] ?? "").join(" | ") + " |";
  const md = [line(rows[0]), "| " + Array(cols).fill("---").join(" | ") + " |", ...rows.slice(1).map(line)].join("\n");
  return { md, imgs, boxes };
}

// ---------- body ----------
function walk(parent: El, ctx: Ctx, out: Block[]): void {
  for (const c of kids(parent)) {
    if (c.nodeName === "w:p") {
      const p = paragraph(c, ctx);
      if (p.text) {
        if (p.heading) out.push({ kind: "block", text: `${"#".repeat(Math.min(p.heading, 6))} ${p.text.replace(/\n/g, " ")}` });
        else if (p.list) {
          const lines = p.text.split("\n");
          const mark = p.list.ordered ? "1." : "-";
          const pad = "  ".repeat(Math.min(p.list.level, 6));
          out.push({ kind: "list", text: lines.map((l, i) => (i === 0 ? `${pad}${mark} ${l}` : `${pad}  ${l}`)).join("\n") });
        } else out.push({ kind: "block", text: escapeLineStart(p.text) });
      }
      for (const i of p.imgs) out.push({ kind: "block", text: i });
      if (p.boxes.length) out.push({ kind: "block", text: p.boxes.map((b) => "> " + b.replace(/\n/g, "\n> ")).join("\n") });
    } else if (c.nodeName === "w:tbl") {
      const t = table(c, ctx);
      if (t) {
        if (t.md) out.push({ kind: "block", text: t.md });
        for (const i of t.imgs) out.push({ kind: "block", text: i });
        if (t.boxes.length) out.push({ kind: "block", text: t.boxes.map((b) => "> " + b).join("\n") });
      }
    } else if (c.nodeName === "w:sdt") {
      const content = kid(c, "w:sdtContent");
      if (content) walk(content, ctx, out);
    } else if (c.nodeName === "mc:AlternateContent") {
      const ch = kid(c, "mc:Choice");
      if (ch) walk(ch, ctx, out);
    }
  }
}

export async function convertDocx(zip: JSZip, opts: ConvertOptions): Promise<ConvertResult> {
  const docFile = zip.file("word/document.xml");
  if (!docFile) throw new Error("Not a Word file: word/document.xml is missing");
  const doc = parseXml(await docFile.async("string"));
  const body = doc.getElementsByTagName("w:body")[0] as El | undefined;
  if (!body) throw new Error("Word file has no body");
  const images = await Images.load(zip, opts);
  const ctx: Ctx = {
    rels: await readRels(zip, "word/document.xml"),
    headingByStyle: await readStyles(zip),
    numFmt: await readNumbering(zip),
    images,
  };
  const blocks: Block[] = [];
  walk(body, ctx, blocks);
  let md = "";
  blocks.forEach((b, i) => {
    if (i) md += blocks[i - 1].kind === "list" && b.kind === "list" ? "\n" : "\n\n";
    md += b.text;
  });
  const text = md.replace(/!\[\[[^\]]*\]\]/g, " ");
  return {
    body: md.trim(),
    images: [...images.out.values()],
    imageHashes: [...images.hashes],
    slideCount: 0,
    words: plainWords(text),
  };
}
