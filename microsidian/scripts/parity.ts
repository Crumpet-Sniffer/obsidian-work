/**
 * Parity test: convert every original with the converter and check that every paragraph (3+ words)
 * in the original XML appears in the converted note. If notes already exist, also compares word and image counts.
 * Vault: the generated sample, or $MICROSIDIAN_VAULT.   Usage: npx tsx scripts/parity.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import JSZip from "jszip";
import { convertOffice } from "../src/convert";
import { hash } from "../src/convert/images";
import { norm, originalParagraphs, target, walk } from "./lib";

const OUT = resolve(__dirname, "..", ".parity-out");

async function main() {
  const { vault, layout } = await target();
  const ORIG = join(vault, layout.originals);
  const files = walk(ORIG).filter((f) => /\.(docx|pptx)$/i.test(f)).sort();
  console.log(`vault: ${vault}  (${files.length} originals)`);

  // existing notes by source
  const existing = new Map<string, string>();
  for (const f of walk(vault)) {
    if (!f.endsWith(".md") || /[\\/](_Originals|_Attachments|\.obsidian)[\\/]/.test(f.slice(vault.length))) continue;
    const t = readFileSync(f, "utf8");
    const m = t.match(/^source: "([^"]+)"$/m);
    if (m) existing.set(m[1], t);
  }

  // logo index: image hashes that appear in 5+ files
  const usage = new Map<string, Set<string>>();
  for (const f of files) {
    const zip = await JSZip.loadAsync(readFileSync(f));
    for (const n of Object.keys(zip.files)) {
      if (!/\/media\//.test(n) || !/\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(n)) continue;
      const h = hash(await zip.file(n)!.async("uint8array"));
      (usage.get(h) ?? usage.set(h, new Set()).get(h)!).add(f);
    }
  }
  const isLogo = (h: string) => (usage.get(h)?.size ?? 0) >= 5;

  let origWords = 0, newWords = 0, oldWords = 0, missingParas = 0, failures = 0, imgNew = 0, imgOld = 0;
  const wordDiffs: string[] = [];
  const missingByFile: string[] = [];
  const t0 = Date.now();

  for (const f of files) {
    const rel = relative(ORIG, f).split("\\").join("/");
    const ext = f.endsWith("docx") ? "docx" : "pptx";
    const buf = readFileSync(f);
    try {
      const res = await convertOffice(buf, ext, { imageMinBytes: 30_000, isLogo, attachmentsDir: layout.attachments, originalPath: `${layout.originals}/${rel}` });
      const outPath = join(OUT, rel.replace(/\.(docx|pptx)$/i, ".md"));
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, res.body);

      // strict paragraph check (compare with spaces removed: a word can be split across runs)
      const note = norm(res.body).replace(/ /g, "");
      const paras = await originalParagraphs(buf, ext);
      const miss: string[] = [];
      for (const p of paras) {
        const t = norm(p);
        if (t.split(" ").length < 3 || note.includes(t.replace(/ /g, ""))) continue;
        miss.push(t.slice(0, 110));
      }
      origWords += paras.reduce((n, p) => n + (p.match(/[A-Za-z0-9]+/g)?.length ?? 0), 0);
      missingParas += miss.length;
      if (miss.length) missingByFile.push(`${rel.split("/").pop()}: ${miss.length}  e.g. "${miss[0]}"`);

      // compare with the current note, if there is one
      const old = existing.get(`${layout.originals}/${rel}`);
      if (old) {
        const body = old.replace(/\r\n/g, "\n").replace(/^---[\s\S]*?\n---\n/, "").replace(/%% connections:start %%[\s\S]*?%% connections:end %%/, "")
          .split("\n").filter((l) => !l.startsWith("Original: ") && !l.startsWith("# ")).join("\n");
        const ow = norm(body).split(" ").filter(Boolean).length;
        oldWords += ow;
        newWords += res.words;
        imgOld += (body.match(/!\[\[/g) ?? []).length;
        imgNew += (res.body.match(/!\[\[/g) ?? []).length;
        const ratio = ow ? res.words / ow : 1;
        if (Math.abs(ratio - 1) > 0.1) wordDiffs.push(`${(ratio * 100).toFixed(0)}%  new ${res.words} vs old ${ow}  ${rel.split("/").pop()}`);
      }
    } catch (e) {
      failures++;
      console.log("FAILED", rel, (e as Error).message);
    }
  }

  console.log(`\nconverted ${files.length - failures}/${files.length} files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`strict check: ${missingParas} original paragraphs (3+ words) missing from the converted notes`);
  missingByFile.slice(0, 25).forEach((l) => console.log("   ", l));
  if (oldWords) {
    console.log(`words: converted ${newWords} vs current notes ${oldWords} (${((newWords / oldWords) * 100).toFixed(1)}%)`);
    console.log(`image embeds: converted ${imgNew} vs current notes ${imgOld}`);
    console.log(`files whose word count differs by more than 10%: ${wordDiffs.length}`);
    wordDiffs.slice(0, 20).forEach((l) => console.log("   ", l));
  }
  process.exitCode = failures || missingParas || !files.length ? 1 : 0;
}
main();
