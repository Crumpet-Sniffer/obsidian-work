/**
 * Simulates "Re-sync all notes from their originals" on a COPY of the notes (the vault is never written):
 * converts every original, keeps each note's head and Connections block, re-applies its topic links, then checks
 * that Connections are preserved, every link resolves, no original paragraph is lost and topic links are kept.
 * Vault: the generated sample, or $MICROSIDIAN_VAULT.   Usage: npx tsx scripts/sync-sim.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import JSZip from "jszip";
import { convertOffice } from "../src/convert";
import { hash } from "../src/convert/images";
import { isSystemPath, under } from "../src/config";
import { addInlineLinks, inlineTopicNames, stripTopicLinks, topicsFromConnections } from "../src/vault/linker";
import { composeNote, eol, isMostlyVisual, splitNote } from "../src/vault/notes";
import { norm, originalParagraphs, target, walk } from "./lib";

const OUT = resolve(__dirname, "..", ".sync-sim");

async function main() {
  const { vault, layout } = await target();
  const rel = (p: string) => relative(vault, p).split("\\").join("/");
  const all = walk(vault).map(rel);
  const fileSet = new Set(all);
  // Obsidian resolves [[Name]] by file name anywhere in the vault, and [[a/b]] by path
  const mdNames = new Set(all.filter((f) => f.endsWith(".md")).flatMap((f) => [f.slice(0, -3), f.slice(0, -3).split("/").pop()!]));
  const willWrite = new Set<string>(); // images the plugin would create during the sync

  // topic phrases from the topic pages' frontmatter
  const phrases = new Map<string, string[]>();
  for (const f of all.filter((f) => under(f, layout.topics) && f.endsWith(".md"))) {
    const m = eol(readFileSync(join(vault, f), "utf8")).match(/^phrases: (\[.*\])$/m);
    if (m) phrases.set(f.slice(layout.topics.length + 1, -3), JSON.parse(m[1]));
  }

  // logo index
  const usage = new Map<string, Set<string>>();
  const originals = all.filter((f) => under(f, layout.originals) && /\.(docx|pptx)$/i.test(f));
  for (const f of originals) {
    const zip = await JSZip.loadAsync(readFileSync(join(vault, f)));
    for (const n of Object.keys(zip.files)) {
      if (!/\/media\//.test(n) || !/\.(png|jpe?g|gif|bmp|svg|webp)$/i.test(n)) continue;
      const h = hash(await zip.file(n)!.async("uint8array"));
      (usage.get(h) ?? usage.set(h, new Set()).get(h)!).add(f);
    }
  }
  const isLogo = (h: string) => (usage.get(h)?.size ?? 0) >= 5;

  const notes = all.filter((f) => f.endsWith(".md") && !isSystemPath(f, layout) && !f.startsWith(".obsidian"));
  let n = 0, connKept = 0, connLost = 0, brokenLinks = 0, paraMissing = 0, oldTopicLinks = 0, newTopicLinks = 0, visualNew = 0;
  const problems: string[] = [];

  for (const f of notes) {
    const old = eol(readFileSync(join(vault, f), "utf8"));
    const src = old.match(/^source: "([^"]+\.(?:docx|pptx))"$/m)?.[1];
    if (!src || !fileSet.has(src)) continue;
    const parts = splitNote(old);
    if (!parts) { problems.push(`cannot split ${f}`); continue; }
    n++;
    const buf = readFileSync(join(vault, src));
    const res = await convertOffice(buf, src.split(".").pop()!, { imageMinBytes: 30_000, isLogo, attachmentsDir: layout.attachments, originalPath: src });

    const names = [...new Set([...topicsFromConnections(parts.connections, layout.topics), ...inlineTopicNames(parts.body, layout.topics)])];
    const tp = names.filter((x) => phrases.has(x)).map((x) => ({ name: x, phrases: phrases.get(x)! }));
    const linked = addInlineLinks(stripTopicLinks(res.body, layout.topics), tp, layout.topics);
    res.images.forEach((i) => willWrite.add(i.path));
    const visual = isMostlyVisual(res.words, res.images.length);
    if (visual) visualNew++;
    const next = composeNote(parts.head, linked.body, { visual, connections: parts.connections });
    const out = join(OUT, f);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, next);

    const np = splitNote(next)!;
    if (np.connections === parts.connections) connKept++; else { connLost++; problems.push(`connections changed: ${f}`); }

    const oldN = inlineTopicNames(parts.body, layout.topics).length, newN = inlineTopicNames(np.body, layout.topics).length;
    oldTopicLinks += oldN; newTopicLinks += newN;
    if (newN < oldN * 0.6) problems.push(`topic links ${oldN} -> ${newN}: ${f.split("/").pop()}`);

    for (const m of next.matchAll(/(?<!!)!?\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]/g)) {
      const t = m[1];
      if (!(fileSet.has(t) || willWrite.has(t) || mdNames.has(t) || fileSet.has(t + ".md"))) { brokenLinks++; if (problems.length < 40) problems.push(`broken link [[${t}]] in ${f.split("/").pop()}`); }
    }

    const note = norm(stripTopicLinks(next, layout.topics)).replace(/ /g, "");
    for (const p of await originalParagraphs(buf, src.split(".").pop()!)) {
      const t = norm(p);
      if (t.split(" ").length >= 3 && !note.includes(t.replace(/ /g, ""))) paraMissing++;
    }
  }

  console.log(`vault: ${vault}`);
  console.log(`simulated re-sync of ${n} notes (output in .sync-sim, vault untouched)`);
  console.log(`Connections block preserved: ${connKept}/${n}   changed: ${connLost}`);
  console.log(`inline topic links: before ${oldTopicLinks}, after ${newTopicLinks}`);
  console.log(`links that do not resolve: ${brokenLinks}`);
  console.log(`original paragraphs missing from the new notes: ${paraMissing}`);
  console.log(`notes flagged "mostly visual": ${visualNew}`);
  problems.slice(0, 40).forEach((p) => console.log("  -", p));
  process.exitCode = connLost || brokenLinks || paraMissing || !n ? 1 : 0;
}
main();
