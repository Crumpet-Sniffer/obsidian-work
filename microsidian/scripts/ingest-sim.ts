/**
 * End-to-end test of the Ingest filing step on scratch COPIES of a vault (the real vault is never written).
 * Claude's reply is mocked; validation, conversion, the note, topic pages, indexes and back-links are real.
 *  A-D run on the generated sample vault; E (round trip) runs on whatever vault is under test.
 * Vault for E: the generated sample, or $MICROSIDIAN_VAULT.   Usage: npx tsx scripts/ingest-sim.ts
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildCatalogue, Catalogue } from "../src/ai/catalogue";
import type { IngestAnalysis } from "../src/ai/schema";
import { convertOffice } from "../src/convert";
import { DEFAULT_LAYOUT as L } from "../src/config";
import { validate } from "../src/ingest/proposal";
import { checkPlan, fitToPlan, mergeKnownTopics } from "../src/ingest/batch";
import { fitToBudget } from "../src/ai/plan";
import { applyIngest, ApplyReport } from "../src/vault/apply";
import { eol } from "../src/vault/notes";
import { topicsFromConnections } from "../src/vault/linker";
import { extractConnections } from "../src/connections";
import { NodeIO } from "./nodeIO";
import { target, walk } from "./lib";
import { ensureFixture, FIXTURE_ROOT, FIXTURE_VAULT } from "./make-fixture";

const ROOT = resolve(__dirname, "..");
const SIM = join(ROOT, ".ingest-sim");
let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failures++; };

const copyNotes = (from: string, to: string) =>
  cpSync(from, to, { recursive: true, filter: (s) => !/[\\/](_Originals|_Attachments|\.obsidian)([\\/]|$)/.test(s.slice(from.length)) });

function env(io: NodeIO, cat: Catalogue) {
  return {
    io, cat, layout: L, updateFolderIndexes: true,
    convert: async (path: string) => {
      const res = await convertOffice(await io.readBinary(path), path.split(".").pop()!, { imageMinBytes: 30_000, isLogo: () => false, attachmentsDir: L.attachments, originalPath: path });
      for (const i of res.images) await io.writeBinary(i.path, i.data);
      return res;
    },
  };
}
const docText = async (src: string) => (await convertOffice(readFileSync(src), src.split(".").pop()!, { imageMinBytes: 30_000, isLogo: () => false, attachmentsDir: L.attachments })).body;

/** Every [[link]] in the changed notes resolves (by name or path), and section anchors exist. */
function verifyLinks(io: NodeIO, realFiles: Set<string>, changed: string[], willWrite: Set<string>) {
  const all = new Set<string>([...realFiles, ...io.list(), ...willWrite]);
  const names = new Set([...all].filter((f) => f.endsWith(".md")).flatMap((f) => [f.slice(0, -3), f.slice(0, -3).split("/").pop()!]));
  let broken = 0, badAnchor = 0;
  for (const f of changed.filter((f) => f.endsWith(".md"))) {
    for (const m of eol(readFileSync(join(io.root, f), "utf8")).matchAll(/!?\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|[^\]]*)?\]\]/g)) {
      const t = m[1];
      const isFile = /\.(docx|pptx|png|jpe?g|gif|pdf)$/i.test(t);
      if (!(all.has(t) || names.has(t) || all.has(t + ".md"))) { broken++; console.log("   broken:", t, "in", f); continue; }
      if (m[2] && !isFile) {
        const path = [...all].find((x) => x === `${t}.md` || x.endsWith(`/${t}.md`))!;
        const body = eol(readFileSync(join(io.root, path), "utf8"));
        if (!new RegExp(`^#{1,6} ${m[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m").test(body)) { badAnchor++; console.log("   bad anchor:", t, "#", m[2], "in", f); }
      }
    }
  }
  check(broken === 0, `all links in the ${changed.length} changed files resolve`);
  check(badAnchor === 0, "all section anchors exist");
}

/** Existing lines may only be replaced when they are topic counts. */
function noLinesLost(io: NodeIO, before: Map<string, string>, changed: string[]) {
  const removed: string[] = [];
  for (const f of changed) {
    const old = before.get(f);
    if (!old) continue;
    const after = new Set(eol(readFileSync(join(io.root, f), "utf8")).split("\n"));
    for (const l of old.split("\n")) if (l.trim() && !after.has(l)) removed.push(`${f.split("/").pop()}: ${l.slice(0, 110)}`);
  }
  const unexpected = removed.filter((r) => !/: \d+ (lessons?|notes?)/.test(r));
  check(unexpected.length === 0, `no existing lines removed except topic counts (${removed.length} replaced)`);
  unexpected.slice(0, 8).forEach((r) => console.log("   removed:", r));
}

const snapshot = (io: NodeIO) => new Map(io.markdownPaths().map((p) => [p, eol(readFileSync(join(io.root, p), "utf8"))]));
const analysis = (o: Partial<IngestAnalysis>): IngestAnalysis => ({ suitable: true, reason: "", folderPath: "", topics: [], newTopics: [], relatedNotes: [], ...o });
const read = (io: NodeIO, p: string) => eol(readFileSync(join(io.root, p), "utf8"));

async function main() {
  rmSync(SIM, { recursive: true, force: true });
  await ensureFixture();
  const realFixture = new Set(walk(FIXTURE_VAULT).map((f) => f.slice(FIXTURE_VAULT.length + 1).split("\\").join("/")));

  // ---------- A: file into an existing folder, with existing topics and related notes ----------
  console.log("\nA. Budget Review.docx into an existing folder (Projects/Alpha)");
  const vA = join(SIM, "a");
  copyNotes(FIXTURE_VAULT, vA);
  mkdirSync(join(vA, "Ingest"), { recursive: true });
  copyFileSync(join(FIXTURE_ROOT, "samples", "Budget Review.docx"), join(vA, "Ingest", "Budget Review.docx"));
  let io = new NodeIO(vA);
  let cat = await buildCatalogue(io, L);
  const docA = await docText(join(FIXTURE_ROOT, "samples", "Budget Review.docx"));
  check(cat.notes.length === 4 && cat.topics.length === 3 && cat.folders.includes("Projects/Alpha"), `catalogue: ${cat.notes.length} notes, ${cat.topics.length} topics, folders ${cat.folders.join(", ")}`);
  const snapA = snapshot(io);
  const pa = validate(analysis({
    folderPath: "Projects/Alpha",
    topics: [{ name: "Budget", phrases: ["budget"] }, { name: "risk management", phrases: ["risk management", "risk register"] }],
    relatedNotes: [{ path: "Projects/Alpha/Kickoff", reason: "Same project" }, { path: "Projects/Alpha/Requirements", reason: "Sets the budget" }],
  }), cat, docA, L);
  check(pa.warnings.length === 0 && pa.topics.length === 2, "reply validated with no warnings (topic names matched case-insensitively)");
  const rA: ApplyReport = await applyIngest(env(io, cat), "Ingest/Budget Review.docx", pa);
  check(!existsSync(join(vA, "Ingest", "Budget Review.docx")), "document left the Ingest folder");
  check(existsSync(join(vA, "_Originals/Projects/Alpha/Budget Review.docx")), "original filed in the originals folder, mirroring the note's folder");
  check(rA.notePath === "Projects/Alpha/Budget Review.md" && existsSync(join(vA, rA.notePath)), `note created at ${rA.notePath}`);
  const nA = read(io, rA.notePath);
  check(nA.includes('source: "_Originals/Projects/Alpha/Budget Review.docx"') && !/^unit:/m.test(nA), "frontmatter has the source and no course-specific properties");
  check(/\[\[Topics\/Budget\|[Bb]udget\]\]/.test(nA) && nA.includes("**Topics:** [[Topics/Budget|Budget]] · [[Topics/Risk management|Risk management]]"), "inline topic links and the Topics line");
  check(nA.includes("**Related notes**") && nA.includes("[[Projects/Alpha/Kickoff|Kickoff]]: Same project"), "related notes listed");
  check(read(io, "Topics/Budget.md").includes("- [[Projects/Alpha/Budget Review|Budget Review]]"), "topic page lists the new note under its folder section");
  check(/- \[\[Topics\/Budget\|Budget\]\]: 3 notes/.test(read(io, "Topics - Index.md")), "Topics index count went from 2 to 3");
  check(/## Alpha[\s\S]*- \[\[Projects\/Alpha\/Budget Review\|Budget Review\]\]/.test(read(io, "Projects - Index.md")), '"Projects - Index" got the note under its subfolder heading');
  check(read(io, "Projects/Alpha/Kickoff.md").includes("[[Projects/Alpha/Budget Review|Budget Review]]: Same project") && read(io, "Projects/Alpha/Requirements.md").includes("Budget Review"), "related notes got back-links");
  verifyLinks(io, realFixture, rA.changed, new Set());
  noLinesLost(io, snapA, rA.changed);

  // ---------- B: a brand-new folder and a new topic ----------
  console.log("\nB. Retrospective.pptx into a new folder (Clients/Acme) with a new topic");
  const vB = join(SIM, "b");
  copyNotes(FIXTURE_VAULT, vB);
  mkdirSync(join(vB, "Ingest"), { recursive: true });
  copyFileSync(join(FIXTURE_ROOT, "samples", "Retrospective.pptx"), join(vB, "Ingest", "Retrospective.pptx"));
  io = new NodeIO(vB);
  cat = await buildCatalogue(io, L);
  const docB = await docText(join(FIXTURE_ROOT, "samples", "Retrospective.pptx"));
  const snapB = snapshot(io);
  const pb = validate(analysis({
    folderPath: "Clients/Acme",
    topics: [{ name: "User research", phrases: ["Interviews with users"] }],
    newTopics: [{ name: "Team rituals", theme: "Delivery", definition: "Regular meetings a team uses to improve.", phrases: ["retrospective", "shared notes"] }],
  }), cat, docB, L);
  check(pb.warnings.some((w) => w.startsWith("New folder")) && pb.newTopics.length === 1, "new folder is flagged for the user; new topic accepted");
  const rB = await applyIngest(env(io, cat), "Ingest/Retrospective.pptx", pb);
  check(existsSync(join(vB, "Clients/Acme/Retrospective.md")) && existsSync(join(vB, "_Originals/Clients/Acme/Retrospective.pptx")), "new folders created for the note and the original");
  const tp = read(io, "Topics/Team rituals.md");
  check(tp.includes('theme: "Delivery"') && tp.includes('phrases: ["retrospective","shared notes"]') && tp.includes("## Clients") && tp.includes("Clients/Acme/Retrospective"), "new topic page: theme, phrases, definition and its first note");
  check(/## Delivery[\s\S]*- \[\[Topics\/Team rituals\|Team rituals\]\]: 1 note/.test(read(io, "Topics - Index.md")), "Topics index lists the new topic under its theme");
  check(!existsSync(join(vB, "Clients - Index.md")), "no folder index note existed, so none was created or required");
  verifyLinks(io, realFixture, rB.changed, new Set());
  noLinesLost(io, snapB, rB.changed);

  // ---------- C: an invented reply is cleaned up ----------
  console.log("\nC. validation of an invented reply");
  const bad = analysis({
    folderPath: "Topics/Secret", topics: [{ name: "Budget", phrases: ["budget", "a phrase that is not in the text"] }, { name: "Quantum basket weaving", phrases: ["x"] }],
    newTopics: [{ name: "Budget", theme: "Delivery", definition: "dup", phrases: [] }, { name: "Gardening", theme: "Nonexistent theme", definition: "Plants.", phrases: ["budget"] }],
    relatedNotes: [{ path: "Nope/Not a note", reason: "r" }, { path: "Projects/Alpha/Kickoff", reason: "ok" }],
  });
  const pc = validate(bad, cat, docA, L);
  check(pc.folderPath === "" && pc.warnings.some((w) => /own folders/.test(w)), "a folder inside the plugin's own folders is refused");
  check(pc.topics.length === 1 && pc.topics[0].phrases.join() === "budget", "unknown topic and unfound phrase dropped");
  check(pc.newTopics.length === 1 && pc.newTopics[0].name === "Gardening" && pc.newTopics[0].theme === "Delivery", "duplicate new topic dropped; unknown theme replaced and flagged");
  check(pc.related.length === 1 && pc.related[0].path === "Projects/Alpha/Kickoff", "related note that does not exist dropped");

  // ---------- D: an empty vault (no topics, no indexes) ----------
  console.log("\nD. an empty vault");
  const vD = join(SIM, "d");
  mkdirSync(join(vD, "Ingest"), { recursive: true });
  copyFileSync(join(FIXTURE_ROOT, "samples", "Retrospective.pptx"), join(vD, "Ingest", "Retrospective.pptx"));
  io = new NodeIO(vD);
  cat = await buildCatalogue(io, L);
  check(cat.notes.length === 0 && cat.topics.length === 0 && cat.text.includes("no notes yet") && cat.text.includes("no topic pages yet"), "catalogue of an empty vault says so");
  const pd = validate(analysis({ folderPath: "Meetings", newTopics: [{ name: "Team rituals", theme: "", definition: "Regular team meetings.", phrases: ["retrospective"] }] }), cat, docB, L);
  const rD = await applyIngest(env(io, cat), "Ingest/Retrospective.pptx", pd);
  check(existsSync(join(vD, "Meetings/Retrospective.md")) && existsSync(join(vD, "Topics/Team rituals.md")), "note and first topic page created from nothing");
  check(!read(io, "Topics/Team rituals.md").includes("**Theme:**") && rD.warnings.length === 0, "topic page without a theme has no theme link; no warnings");
  verifyLinks(io, new Set(), rD.changed, new Set([...walk(vD)].map((f) => f.slice(vD.length + 1).split("\\").join("/"))));

  // ---------- E: round trip on the vault under test ----------
  const { vault, sample } = await target();
  console.log(`\nE. round trip on ${sample ? "the sample vault" : vault}: file a copy of an existing document, answer taken from its note`);
  const vE = join(SIM, "e");
  copyNotes(vault, vE);
  io = new NodeIO(vE);
  cat = await buildCatalogue(io, L);
  const realFiles = new Set(walk(vault).map((f) => f.slice(vault.length + 1).split("\\").join("/")));
  let picked: { note: string; orig: string } | null = null;
  for (const n of cat.notes) {
    const text = read(io, n.path + ".md");
    const src = text.match(/^source: "([^"]+\.(?:docx|pptx))"$/m)?.[1];
    if (src && realFiles.has(src) && topicsFromConnections(extractConnections(text) ?? "", L.topics).length >= 2) { picked = { note: n.path, orig: src }; break; }
  }
  if (!picked) check(false, "no converted note with topics found to use");
  else {
    const note = read(io, picked.note + ".md");
    const conn = extractConnections(note) ?? "";
    const names = topicsFromConnections(conn, L.topics);
    const related = [...conn.matchAll(/^- \[\[([^\]|]+)\|[^\]]*\]\](?: \([^)]*\))?: (.+)$/gm)].map((m) => ({ path: m[1], reason: m[2] })).filter((r) => cat.notes.some((c) => c.path === r.path));
    const ext = picked.orig.split(".").pop()!;
    const copyName = `Round trip copy.${ext}`;
    mkdirSync(join(vE, "Ingest"), { recursive: true });
    copyFileSync(join(vault, picked.orig), join(vE, "Ingest", copyName));
    const doc = await docText(join(vault, picked.orig));
    const folder = picked.note.split("/").slice(0, -1).join("/");
    const snapE = snapshot(io);
    const pe = validate(analysis({
      folderPath: folder,
      topics: names.map((n) => ({ name: n, phrases: cat.topics.find((t) => t.name === n)?.phrases.slice(0, 2) ?? [] })),
      relatedNotes: related,
    }), cat, doc, L);
    console.log(`  using ${picked.note}: ${pe.topics.length} topics, ${pe.related.length} related notes`);
    const rE = await applyIngest(env(io, cat), `Ingest/${copyName}`, pe);
    check(existsSync(join(vE, rE.notePath)) && existsSync(join(vE, rE.originalPath)), `note and original filed: ${rE.notePath}`);
    check(topicsFromConnections(extractConnections(read(io, rE.notePath)) ?? "", L.topics).join() === pe.topics.map((t) => t.name).join(), "the new note carries the same topics as the original note");
    verifyLinks(io, realFiles, rE.changed, new Set(readdirSafe(join(vE, L.attachments)).map((f) => `${L.attachments}/${f}`)));
    noLinesLost(io, snapE, rE.changed);
    console.log("  warnings:", rE.warnings);
  }

  await batchScenario(realFixture);

  console.log(`\n${failures ? "FAILED: " + failures + " check(s)" : "all checks passed"}`);
  process.exitCode = failures ? 1 : 0;
}

// ---------- F: two documents added together, planned as one batch ----------
async function batchScenario(realFixture: Set<string>) {
  console.log("\nF. Budget Review.docx and Retrospective.pptx added together (planned as a batch)");
  const vF = join(SIM, "f");
  copyNotes(FIXTURE_VAULT, vF);
  mkdirSync(join(vF, "Ingest"), { recursive: true });
  const files = [
    { id: "D1", fileName: "Budget Review.docx" },
    { id: "D2", fileName: "Retrospective.pptx" },
  ];
  for (const f of files) copyFileSync(join(FIXTURE_ROOT, "samples", f.fileName), join(vF, "Ingest", f.fileName));
  const io = new NodeIO(vF);
  const base = await buildCatalogue(io, L);
  const snap = snapshot(io);

  // Claude's plan (mocked): one new topic shared by both, a new folder for the second document.
  const plan = checkPlan(
    {
      newTopics: [
        { name: "Lessons learned", theme: "delivery", definition: "What a team takes from finished work into the next piece of work." },
        { name: "Budget", theme: "Delivery", definition: "Already a topic, so this one is dropped." },
      ],
      documents: [
        { id: "D1", suitable: true, reason: "", folderPath: "projects/alpha", summary: "A review of the Alpha budget.", topics: ["budget", "Lessons learned", "Not a topic"] },
        { id: "D2", suitable: true, reason: "", folderPath: "Clients/Acme", summary: "A retrospective of the Acme work.", topics: ["Lessons learned", "Risk management"] },
      ],
    },
    base, L, files, (p) => existsSync(join(vF, p)),
  );
  check(plan.newTopics.length === 1 && plan.newTopics[0].theme === "Delivery", "plan: the new topic kept (theme matched to the vault's spelling), the duplicate of an existing topic dropped");
  const d1 = plan.docs.get("D1")!, d2 = plan.docs.get("D2")!;
  check(d1.folder === "Projects/Alpha" && d1.notePath === "Projects/Alpha/Budget Review", `plan: D1 goes to ${d1.notePath} (existing folder's spelling)`);
  check(d2.notePath === "Clients/Acme/Retrospective", `plan: D2 goes to ${d2.notePath}`);
  check(d1.topics.join() === "Budget,Lessons learned", "plan: invented topic names dropped from a document's topics");
  const cat = plan.catalogue;
  check(cat.notes.some((n) => n.path === d2.notePath) && cat.topics.some((t) => t.name === "Lessons learned") && cat.folders.includes("Clients/Acme"),
    "batch catalogue lists the other documents, the planned topic and the planned folder");
  check(cat.text.includes("## Notes being added now") && cat.text.includes("A retrospective of the Acme work."), "batch catalogue text has the batch section with summaries");
  check(base.notes.length + 2 === cat.notes.length && base.topics.length + 1 === cat.topics.length, "the vault's own catalogue is left as it was");

  const topicPage = async (name: string) => io.exists(`${L.topics}/${name}.md`);

  // A document the plan left out is still checked against the batch catalogue: a planned topic it uses must be
  // created (it does not exist yet), and it keeps its own folder.
  const loose = await fitToPlan(
    { suitable: true, reason: "", folderPath: "Own/Folder", topics: [{ name: "Lessons learned", phrases: [] }], newTopics: [], related: [], warnings: [] },
    null, plan, async () => false,
  );
  check(loose.newTopics.map((t) => t.name).join() === "Lessons learned" && loose.folderPath === "Own/Folder",
    "a document left out of the plan still creates the planned topic it uses, and keeps its own folder");

  // D1 first: it links to D2, which is filed after it. Its answer names a different folder and itself.
  const text1 = await docText(join(FIXTURE_ROOT, "samples", files[0].fileName));
  let p1 = validate(mergeKnownTopics(analysis({
    folderPath: "Somewhere/Else",
    topics: [{ name: "Budget", phrases: [] }, { name: "lessons learned", phrases: [] }],
    relatedNotes: [{ path: d2.notePath, reason: "Same lessons" }, { path: d1.notePath, reason: "itself" }, { path: "Projects/Alpha/Kickoff", reason: "Same project" }],
  }), cat), cat, text1, L);
  p1 = await fitToPlan(p1, d1, plan, topicPage);
  check(p1.folderPath === "Projects/Alpha", "D1: the planned folder is used, not the one in its own answer");
  check(!p1.related.some((r) => r.path === d1.notePath) && p1.related.some((r) => r.path === d2.notePath), "D1: no link to itself; the link to D2 (not filed yet) is kept");
  check(p1.newTopics.map((t) => t.name).join() === "Lessons learned" && p1.topics.map((t) => t.name).join() === "Budget", "D1: the planned topic is created by the first document that uses it");
  const r1 = await applyIngest(env(io, cat), `Ingest/${files[0].fileName}`, p1);
  check(r1.notePath === `${d1.notePath}.md`, `D1 filed at the planned path (${r1.notePath})`);

  // D2 gives the planned topic as a "new" topic (in other capitals): it is the same topic.
  const text2 = await docText(join(FIXTURE_ROOT, "samples", files[1].fileName));
  let p2 = validate(mergeKnownTopics(analysis({
    folderPath: "Clients/Acme",
    topics: [{ name: "Risk management", phrases: [] }],
    newTopics: [{ name: "Lessons Learned", theme: "Delivery", definition: "x", phrases: [] }],
    relatedNotes: [{ path: d1.notePath, reason: "Same lessons" }],
  }), cat), cat, text2, L);
  p2 = await fitToPlan(p2, d2, plan, topicPage);
  check(p2.newTopics.length === 0 && p2.topics.map((t) => t.name).sort().join() === "Lessons learned,Risk management", "D2: the planned topic, given as new, is recognised as the same topic and its page is not made twice");
  const r2 = await applyIngest(env(io, cat), `Ingest/${files[1].fileName}`, p2);
  check(r2.notePath === `${d2.notePath}.md`, `D2 filed at the planned path (${r2.notePath})`);

  const lessons = read(io, "Topics/Lessons learned.md");
  check(lessons.includes("[[Projects/Alpha/Budget Review|Budget Review]]") && lessons.includes("[[Clients/Acme/Retrospective|Retrospective]]"), "the planned topic's page lists both documents");
  check(/- \[\[Topics\/Lessons learned\|Lessons learned\]\]: 2 notes/.test(read(io, "Topics - Index.md")), "Topics index: the planned topic listed once, with 2 notes");
  check(read(io, r1.notePath).includes("[[Clients/Acme/Retrospective|Retrospective]]: Same lessons"), "D1's note links to D2, filed after it");
  check(read(io, r2.notePath).includes("[[Projects/Alpha/Budget Review|Budget Review]]: Same lessons"), "D2's note links back to D1");
  verifyLinks(io, realFixture, [...new Set([...r1.changed, ...r2.changed])], new Set());
  noLinesLost(io, snap, [...new Set([...r1.changed, ...r2.changed])]);

  // fitting a large batch into one request
  const big = [
    { id: "a", fileName: "a", text: "x".repeat(100) },
    { id: "b", fileName: "b", text: "y".repeat(5_000) },
    { id: "c", fileName: "c", text: "z".repeat(9_000) },
  ];
  const fit = fitToBudget(big, 6_000);
  const lens = fit.docs.map((d) => d.text.replace(/\n\[The rest.*$/, "").length);
  check(fit.docs[0].text === big[0].text && fit.shortened.join() === "b,c" && lens[1] === lens[2] && lens.reduce((a, b) => a + b, 0) <= 6_000,
    `fitToBudget: short documents whole, long ones cut to an equal share (${lens.join(", ")} chars)`);
  check(fitToBudget(big, 1_000_000).shortened.length === 0, "fitToBudget: nothing cut when the batch fits");
}
function readdirSafe(d: string): string[] { return existsSync(d) && statSync(d).isDirectory() ? readdirSync(d) : []; }
main().catch((e) => { console.error(e); process.exit(1); });
