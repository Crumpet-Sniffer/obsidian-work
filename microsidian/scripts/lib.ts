import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import JSZip from "jszip";
import { DEFAULT_LAYOUT, Layout } from "../src/config";
import { desc, parseXml } from "../src/convert/xml";
import { ensureFixture, FIXTURE_VAULT } from "./make-fixture";

export const norm = (s: string) =>
  (s
    .replace(/<\/?[a-z][^>]*>/gi, " ")
    .replace(/!?\[\[[^\]]*\]\]/g, " ")
    .replace(/\]\((?:[^()\s]|\([^)]*\))*\)/g, " ")
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? []).join(" ");

export function walk(d: string, out: string[] = []): string[] {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    statSync(p).isDirectory() ? walk(p, out) : out.push(p);
  }
  return out;
}

/** The vault the tests run on: $MICROSIDIAN_VAULT if set, otherwise the generated sample vault. */
export async function target(): Promise<{ vault: string; layout: Layout; sample: boolean }> {
  const env = process.env.MICROSIDIAN_VAULT;
  if (env) return { vault: resolve(env), layout: DEFAULT_LAYOUT, sample: false };
  await ensureFixture();
  return { vault: FIXTURE_VAULT, layout: DEFAULT_LAYOUT, sample: true };
}

export async function originalParagraphs(buf: Buffer, ext: string): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  const parts = Object.keys(zip.files).filter((n) =>
    ext === "docx" ? n === "word/document.xml" : /^ppt\/slides\/slide\d+\.xml$/.test(n) || /^ppt\/diagrams\/data\d+\.xml$/.test(n),
  );
  const out: string[] = [];
  for (const part of parts) {
    const doc = parseXml(await zip.file(part)!.async("string"));
    // drop mc:Fallback copies (duplicates of the mc:Choice content)
    for (const fb of desc(doc, "mc:Fallback")) fb.parentNode?.removeChild(fb);
    const word = ext === "docx" && part.startsWith("word/");
    const pTag = word ? "w:p" : "a:p";
    for (const p of desc(doc, pTag)) {
      // text of this paragraph only (not of text boxes nested inside it); breaks/tabs count as spaces
      let t = "";
      const visit = (n: Node) => {
        for (let c = n.firstChild; c; c = c.nextSibling) {
          if (c.nodeType !== 1) continue;
          const e = c as Element;
          const name = e.nodeName;
          if (name === pTag || name === "w:txbxContent") continue; // nested paragraph
          if (name === "w:r") {
            const rPr = Array.from(e.childNodes).find((x) => x.nodeName === "w:rPr") as Element | undefined;
            if (rPr && Array.from(rPr.childNodes).some((x) => x.nodeName === "w:vanish")) continue;
          }
          if (name === "w:t" || name === "a:t") t += e.textContent ?? "";
          else if (name === "w:br" || name === "w:tab" || name === "a:br" || name === "w:cr") t += " ";
          else visit(e);
        }
      };
      visit(p);
      out.push(t);
    }
  }
  return out;
}
