// Past exam papers and their mark schemes, and the exam board's other documents, for the question hub on the
// Practice page.
//  - One paper: the exam paper and (optionally) its mark scheme, uploaded together with a name.
//  - A zip of assessment resources: every PDF, Word and PowerPoint file in it is looked at, and Claude works out
//    which are question papers and which mark scheme and inserts (case studies, source booklets, data sheets) go
//    with each (and each paper's qualification, number, month and year), and which are specifications, examiner
//    reports, answers and commentaries, or notes and guidance. Other versions of the same paper (modified,
//    enlarged print) are folded into one: the standard version is read, the others only if it cannot be. Each
//    paper is then added as if it had been uploaded on its own, and each of the other documents is read.
//  - A specification on its own.
// A specification, report, commentary or guidance document is read by Claude into notes (content areas, command
// words, marking guidance, examiners' findings) and kept with the file. When anything is added, the server builds
// the guide to each paper of the qualification again from all of it (src/practice.rs, build_profiles).
// Adding a paper: its files (paper, mark scheme, inserts) are read like sources (text, and the text in their
// pictures), kept in the vault under the originals folder, and Claude splits the paper into its questions, each with
// its marks, type, topics and mark scheme, quoting what it needs from the insert. The questions go to the server, which checks and saves them (src/handlers/practice.rs, add_paper).
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import { ServerIO, Session } from "./server.js";
import { pool, withPictureReadings } from "./pictures.js";
import { cullZip, DOCUMENT } from "./cull.js";
import { Cancelled, Reporter, convertOptions, convertSource, explain, outOfCredit, readPictures } from "./batch.js";

const PaperDetails = z.object({ qualification: z.string(), paper_number: z.string(), month: z.string(), year: z.number().int() });

const Extracted = z.object({
  paper: PaperDetails,
  questions: z.array(
    z.object({
      number: z.string(),
      type: z.enum(["single", "multi", "fill", "written"]),
      text: z.string(),
      options: z.array(z.string()),
      correct: z.array(z.number().int()),
      blanks: z.array(z.array(z.string())),
      marks: z.number().int(),
      mark_scheme: z.string(),
      topics: z.array(z.string()),
      difficulty: z.enum(["easy", "medium", "hard"]),
    }),
  ),
});

const DOC_KINDS = ["specification", "examiner_report", "answers_commentary", "notes_guidance", "mark_scheme"];
const KIND_LABEL = { specification: "Specification", examiner_report: "Examiner report", answers_commentary: "Answers and commentary", notes_guidance: "Notes and guidance", mark_scheme: "Mark scheme" };

const Version = z.object({ file: z.string(), modified: z.boolean() });
const Matched = z.object({
  papers: z.array(PaperDetails.extend({ exam_file: z.string(), modified: z.boolean(), scheme_file: z.string(), inserts: z.array(Version) })),
  documents: z.array(PaperDetails.extend({ file: z.string(), kind: z.enum([...DOC_KINDS, "other"]), reason: z.string() })),
});

const Digest = PaperDetails.extend({
  summary: z.string(),
  assessment: z.array(z.object({ paper_number: z.string(), title: z.string(), duration: z.string(), total_marks: z.number().int(), format: z.string() })),
  content_areas: z.array(z.object({ code: z.string(), title: z.string(), points: z.array(z.string()), papers: z.array(z.string()) })),
  command_words: z.array(z.object({ word: z.string(), meaning: z.string(), marks: z.string() })),
  assessment_objectives: z.array(z.object({ code: z.string(), meaning: z.string(), weighting: z.string() })),
  key_points: z.array(z.string()),
  marking_guidance: z.array(z.string()),
  exemplars: z.array(z.object({ question: z.string(), marks: z.string(), comment: z.string() })),
});

/** Most characters of a paper, its mark scheme and its inserts sent to Claude together (about 400,000 tokens). */
const BUDGET = 1_600_000;
/** The share of the budget an insert keeps when everything does not fit. */
const INSERT_SHARE = 0.25;
/** Characters of each file's start shown to Claude when sorting a zip. */
const PEEK = 5000;
/** Papers of a zip read and split into questions at the same time. */
const PAPERS_AT_ONCE = 2;

const basename = (p) => p.split("/").pop();
const safeName = (s) => s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Paper";
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const titleOf = (d) => [[d.month, d.year > 0 ? String(d.year) : ""].filter(Boolean).join(" "), d.paper_number].filter(Boolean).join(" ").trim();
/** A modified or other alternative version of a paper or insert, by its file name (Claude says so too). */
const ALTERNATIVE = /\bmodified\b|enlarged|large[- ]?print|braille|\b\d{2}\s?pt\b/i;
/** A series named like "Sample set 1" or "Specimen" rather than by its month: not a real exam year. */
const sampleSet = (month) => !!month && !/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(month.trim());
/** An error that no other file would get past: the account, not the file. */
const accountProblem = (e) => outOfCredit(e) || (!!e && (e.status === 401 || e.status === 403));
const claude = (session) => new Anthropic({ apiKey: "held-by-the-server", fetch: session.claudeFetch, dangerouslyAllowBrowser: true });

/** Read one file fully: its text with what was read from its pictures, and the converted result. */
async function readDoc(doc, cfg, readCfg, session, set, onFraction, check) {
  set("working", "Reading the file…", null);
  const bytes = doc.bytes || (await doc.get());
  const res = await convertSource(bytes, doc.name, convertOptions(cfg));
  const r = await readPictures(res.images, { name: doc.name, title: doc.title }, readCfg, session, (_s, state, text, bar) => set(state, text, bar), onFraction, check);
  return { bytes, res, text: withPictureReadings(res.body, r.readings), pictures: r.readings.size, how: r.how };
}

/** Keep a file (and the pictures its text embeds) in the vault. Returns where it went. */
async function keep(io, folder, name, bytes, images) {
  let path = `${folder}/${name}`;
  for (let n = 2; await io.exists(path); n++) path = `${folder}/${name.replace(/(\.[^.]+)$/, ` (${n})$1`)}`;
  await io.writeBinary(path, bytes);
  for (const img of images) if (!(await io.exists(img.path))) await io.writeBinary(img.path, img.data);
  return path;
}

/** Claude splits a paper into its questions. */
async function extract(session, cfg, topics, title, paperText, schemeText, insertText) {
  let paper = paperText || "";
  let scheme = schemeText || "";
  let insert = insertText || "";
  if (paper.length + scheme.length + insert.length > BUDGET) {
    insert = insert.slice(0, Math.max(Math.floor(BUDGET * INSERT_SHARE), BUDGET - paper.length - scheme.length));
    const rest = BUDGET - insert.length;
    paper = paper.slice(0, Math.max(Math.floor(rest / 2), rest - scheme.length));
    scheme = scheme.slice(0, rest - paper.length);
  }
  const msg = await claude(session).beta.messages.parse({
    model: "claude-sonnet-5-5", // the server uses the model an admin chose
    max_tokens: 16000,
    output_config: { effort: "medium", format: zodOutputFormat(Extracted) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: cfg.prompts && cfg.prompts.extract ? cfg.prompts.extract : undefined,
    messages: [
      {
        role: "user",
        content:
          `<topics>\n${topics.join("\n")}\n</topics>\n\n` +
          `<exam_paper title="${title.replace(/"/g, "'")}">\n${paper}\n</exam_paper>\n\n` +
          (insert ? `<insert>\n${insert}\n</insert>\n\n` : "") +
          (scheme ? `<mark_scheme>\n${scheme}\n</mark_scheme>` : "<mark_scheme>\n(No mark scheme was uploaded: write one for each question.)\n</mark_scheme>"),
      },
    ],
  });
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to read this paper.");
  if (msg.stop_reason === "max_tokens") throw new Error("The paper has too many questions to read in one go. Split it into parts and add each one.");
  if (!msg.parsed_output) throw new Error("Claude's list of questions could not be read. Try again.");
  return { ...msg.parsed_output, usage: msg.usage };
}

/**
 * Add one paper: read its files (the paper, its mark scheme and inserts), keep them in the vault, have Claude split
 * the paper into questions, and hand them to the server. `details` (qualification, paper number, month, year) are
 * used when known; otherwise what Claude reads off the cover. `cache` keeps files already read and saved (by
 * document), so trying another version of a paper does not read or save its mark scheme and inserts again.
 * Returns the server's answer ({ id, questions, dropped }).
 */
async function addOne({ session, cfg, readCfg, io, topics, title, details, exam, scheme, inserts = [], cache = new Map(), set, onFraction, check, onClaude }) {
  const folder = `${cfg.layout.originals}/Question Hub/${safeName(title || titleOf(details || {}) || basename(exam.name).replace(/\.[^.]+$/, ""))}`;
  const docs = [
    { doc: exam, label: "the paper" },
    ...(scheme ? [{ doc: scheme, label: "the mark scheme" }] : []),
    ...inserts.map((d, i) => ({ doc: d, label: inserts.length > 1 ? `insert ${i + 1}` : "the insert" })),
  ];
  const read = [];
  for (let i = 0; i < docs.length; i++) {
    const { doc, label } = docs[i];
    let r = cache.get(doc);
    if (!r) {
      r = await readDoc(doc, cfg, readCfg, session, (state, text, bar) => set(state, `${text.replace("the file", label)}`, bar), (f) => onFraction((i + f) / docs.length), check);
      set("working", `Saving ${label} in the vault…`, null);
      r.path = await keep(io, folder, doc.name, r.bytes, r.res.images);
      cache.set(doc, r);
    }
    read.push(r);
  }
  check();
  set("working", "Claude is splitting the paper into questions…", null);
  if (onClaude) await onClaude();
  const insertRead = read.slice(scheme ? 2 : 1);
  const insertText = insertRead.map((r, i) => (insertRead.length > 1 ? `## ${inserts[i].name}\n\n${r.text}` : r.text)).join("\n\n");
  const out = await extract(session, cfg, topics, title || titleOf(details || {}) || exam.name, read[0].text, scheme ? read[1].text : "", insertText);
  const d = details && (details.year || details.paper_number || details.month) ? details : out.paper;
  set("working", "Adding the questions to the hub…", null);
  const saved = await session.api("POST", "practice/papers", {
    json: {
      title: title || "",
      exam_path: read[0].path,
      scheme_path: scheme ? read[1].path : "",
      insert_paths: insertRead.map((r) => r.path),
      qualification: d.qualification || out.paper.qualification || "",
      paper_number: d.paper_number || "",
      month: d.month || "",
      year: sampleSet(d.month) ? 0 : d.year || 0,
      questions: out.questions,
    },
  });
  return { ...saved, qualification: d.qualification || out.paper.qualification || "", usage: out.usage, pictures: read.reduce((n, r) => n + r.pictures, 0), how: read.find((r) => r.how)?.how || "" };
}

/**
 * Read a specification, examiner report, commentary or guidance document: its text (pictures read too, except in a
 * specification, whose pictures are logos and diagrams of the course), what Claude takes from it, and the file kept
 * in the vault. Hands it to the server and returns its qualification.
 */
async function addDoc({ session, cfg, readCfg, io, quals, kind, details, doc, set, check }) {
  const docCfg = kind === "specification" ? { ...readCfg, images: { mode: "ocr", model: "", parallel: 1 }, imageMinKB: 1e9 } : readCfg;
  const r = await readDoc(doc, docCfg, docCfg, session, (state, text, bar) => set(state, text.replace("the file", "the document"), bar), async () => { check(); }, check);
  check();
  set("working", "Claude is reading it…", null);
  let text = r.text;
  if (text.length > BUDGET) text = text.slice(0, BUDGET);
  const msg = await claude(session).beta.messages.parse({
    model: "claude-sonnet-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium", format: zodOutputFormat(Digest) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: cfg.prompts && cfg.prompts.digest ? cfg.prompts.digest : undefined,
    messages: [{
      role: "user",
      content: `Kind of document: ${KIND_LABEL[kind] || kind}\nFile: ${doc.title}\n\n<known_qualifications>\n${quals.join("\n")}\n</known_qualifications>\n\n<document>\n${text}\n</document>`,
    }],
  });
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to read this document.");
  if (msg.stop_reason === "max_tokens") throw new Error("What Claude took from this document was too long and was cut off.");
  if (!msg.parsed_output) throw new Error("What Claude read from this document could not be understood. Try again.");
  const dg = msg.parsed_output;
  // What the sorting step worked out wins where it said something; the document's own reading fills the gaps.
  const d = {
    qualification: (details && details.qualification) || dg.qualification || "",
    paper_number: kind === "specification" ? "" : (details && details.paper_number) || dg.paper_number || "",
    month: kind === "specification" ? "" : (details && details.month) || dg.month || "",
    // A sample or specimen set (named, not a month) has no exam year, whatever date the document shows.
    year: kind === "specification" || sampleSet(details && details.month) ? 0 : (details && details.year) || dg.year || 0,
  };
  set("working", "Saving it in the vault…", null);
  const folder = `${cfg.layout.originals}/Question Hub/Resources/${safeName(d.qualification || "General")}`;
  const path = await keep(io, folder, doc.name, r.bytes, kind === "specification" ? [] : r.res.images);
  await session.api("POST", "practice/docs", {
    json: { kind, title: doc.name.replace(/\.[^.]+$/, ""), path, ...d, digest: { ...dg, ...d } },
  });
  const areas = dg.content_areas.length;
  set("done", `${KIND_LABEL[kind]} read${areas ? ` · ${plural(areas, "content area")}` : ""}${dg.key_points.length ? ` · ${plural(dg.key_points.length, "point")} from examiners` : ""}${dg.exemplars.length ? ` · ${plural(dg.exemplars.length, "sample answer")}` : ""}`);
  return d.qualification;
}

/** Ask the server to build the guides to these qualifications' papers again (it does so in the background). */
async function rebuildGuides(session, quals) {
  const list = [...new Set(quals.filter(Boolean))];
  if (!list.length) return;
  try {
    await session.api("POST", "practice/profiles/rebuild", { json: { qualifications: list } });
  } catch (e) {
    console.warn(`could not start building paper guides: ${e.message}`);
  }
}

function newProgress(claim, files) {
  return {
    v: 1,
    kind: "paper",
    stage: "read",
    planned: true,
    steps: {
      read: { state: "waiting", done: 0, of: files, note: "" },
      plan: { state: "waiting", note: "", elapsed: 0 },
      file: { state: "waiting", done: 0, of: 1, note: "" },
    },
    files: [],
    summary: "",
  };
}

function setter(row) {
  return (state, text, bar) => {
    row.state = state;
    row.text = text;
    if (bar === undefined || bar === null) delete row.bar; else row.bar = bar;
  };
}

export async function runPaper(claim) {
  const zipMode = !!(claim.meta && claim.meta.zip);
  const specMode = !!(claim.meta && claim.meta.spec);
  const p = newProgress(claim, claim.files.length);
  const rep = new Reporter(claim.id, p);
  const session = new Session(claim.vault, claim.session);
  let status = "done";
  try {
    const cfg = await session.api("GET", "ingest/config");
    if (!cfg.configured) throw new Error("No Anthropic API key is set. An admin can add one under Admin → Microsidian.");
    // Showing pictures to the filing model is a filing choice; a paper's pictures are always read to text.
    const readCfg = cfg.images && cfg.images.mode === "claude" && !cfg.images.model ? { ...cfg, images: { ...cfg.images, mode: "ocr" } } : cfg;
    const io = new ServerIO(session, cfg.layout);
    await io.load();
    const meta = await session.api("GET", "practice/meta");
    const topics = meta.topics || [];
    const ctx = { session, cfg, readCfg, io, topics, quals: meta.qualifications || [], check: () => rep.check(), halt: "" };
    let touched = [];
    if (zipMode) touched = await runZip(claim, p, rep, ctx, meta);
    else if (specMode) touched = await runSpec(claim, p, rep, ctx);
    else touched = await runSingle(claim, p, rep, ctx);
    if (ctx.halt) {
      // Building the guides would fail the same way; they are built again when the rest is added.
      status = "failed";
      p.summary = `${p.summary} · Stopped: ${ctx.halt}`;
    } else {
      await rebuildGuides(session, touched);
      if (touched.some(Boolean)) p.summary += " · the paper guides are being built again";
    }
  } catch (e) {
    if (e instanceof Cancelled) {
      status = "cancelled";
      p.summary = p.summary ? `Stopped · ${p.summary}` : "Stopped";
    } else {
      status = "failed";
      console.warn(`paper ${claim.id} failed: ${e && e.stack ? e.stack : e}`);
      p.summary = `${p.summary ? `${p.summary} · ` : ""}Nothing more could be added: ${explain(e)}`;
    }
    for (const f of p.files) if (f.state === "waiting" || f.state === "working") Object.assign(f, { state: status === "cancelled" ? "skipped" : "failed" });
    for (const s of Object.values(p.steps)) if (s.state === "working") s.state = "failed";
  }
  p.stage = "done";
  await rep.finish(status);
}

/** One paper, named by whoever uploaded it. */
async function runSingle(claim, p, rep, ctx) {
  const title = String((claim.meta && claim.meta.title) || "");
  const row = { key: "0", name: title || claim.files[0].name, state: "waiting", text: "Waiting…" };
  p.files.push(row);
  const doc = (f) => ({ name: f.name, title: `${title}: ${f.name}`, get: async () => new Uint8Array(await readFile(f.path)) });
  // What each uploaded file is, in upload order (older batches: the paper, then its mark scheme).
  const parts = Array.isArray(claim.meta && claim.meta.parts) && claim.meta.parts.length === claim.files.length ? claim.meta.parts : ["exam", "scheme"];
  const of = (part) => claim.files.filter((_f, i) => parts[i] === part).map(doc);
  const exam = of("exam")[0] || doc(claim.files[0]);
  p.steps.read.state = "working";
  p.steps.read.of = 1;
  await rep.push(true);
  const saved = await addOne({
    ...ctx,
    title,
    details: null,
    exam,
    scheme: of("scheme")[0] || null,
    inserts: of("insert"),
    set: setter(row),
    onFraction: async (f) => { p.steps.read.done = f; rep.check(); await rep.push(); },
    onClaude: async () => {
      Object.assign(p.steps.read, { state: "done", done: 1 });
      p.stage = "plan";
      Object.assign(p.steps.plan, { state: "working", note: "Claude is reading the paper and its mark scheme", elapsed: 0 });
      rep.started = Date.now();
      await rep.push(true);
    },
  });
  rep.started = 0;
  Object.assign(p.steps.plan, { state: "done", note: "" });
  Object.assign(p.steps.file, { state: "done", done: 1 });
  Object.assign(row, { state: "done", text: `${plural(saved.questions, "question")} added`, link: "" });
  p.summary = `${plural(saved.questions, "question")} added to the hub${saved.dropped ? ` · ${saved.dropped} could not be used` : ""}`;
  return [saved.qualification];
}

/** A specification on its own. */
async function runSpec(claim, p, rep, ctx) {
  const f = claim.files[0];
  const row = { key: "0", name: f.name, state: "waiting", text: "Waiting…" };
  p.files.push(row);
  p.steps.read.state = "working";
  p.steps.read.of = 1;
  await rep.push(true);
  const name = String((claim.meta && claim.meta.title) || "");
  const qual = await addDoc({
    ...ctx,
    kind: "specification",
    details: name ? { qualification: name, paper_number: "", month: "", year: 0 } : null,
    doc: { name: f.name, title: f.name, get: async () => new Uint8Array(await readFile(f.path)) },
    set: setter(row),
  });
  Object.assign(p.steps.read, { state: "done", done: 1 });
  Object.assign(p.steps.plan, { state: "done" });
  Object.assign(p.steps.file, { state: "done", done: 1 });
  p.summary = `Specification read${qual ? ` for ${qual}` : ""}`;
  return [qual];
}

/** A zip of papers and mark schemes: sort them into pairs, then add each paper. */
async function runZip(claim, p, rep, ctx, meta) {
  const zipRow = { key: "zip", name: claim.files[0].name, state: "working", text: "Opening the zip…" };
  p.files.push(zipRow);
  await rep.push(true);

  // 1. the documents in the zip (pictures, videos, system files and so on are left out)
  const zip = await JSZip.loadAsync(await readFile(claim.files[0].path));
  const { kept, culled, summary } = cullZip(zip, { imageMinBytes: Number.MAX_SAFE_INTEGER });
  const docs = kept.filter((k) => DOCUMENT.test(k.path)).map((k, i) => ({ id: `F${i + 1}`, path: k.path, name: basename(k.path), title: k.path, get: () => k.e.async("uint8array") }));
  const left = culled + (kept.length - docs.length);
  if (!docs.length) throw new Error("There are no PDF, Word or PowerPoint files in this zip.");
  Object.assign(zipRow, { state: "done", text: `${plural(docs.length, "document")} found${left ? ` · ${plural(left, "other file")} left out` : ""}` });
  if (summary) zipRow.detail = `Left out: ${summary}.`;

  // 2. the start of each document, to tell papers from mark schemes
  p.steps.read.state = "working";
  p.steps.read.of = docs.length;
  p.steps.read.note = "Looking at the start of each document";
  await rep.push(true);
  for (let i = 0; i < docs.length; i++) {
    rep.check();
    const d = docs[i];
    p.steps.read.done = i;
    p.steps.read.note = d.name;
    try {
      const res = await convertSource(await d.get(), d.name, convertOptions(ctx.cfg));
      d.peek = res.body.replace(/!\[\[[^\]]*\]\]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, PEEK);
      // A scanned paper has no text: read its first pictures (the cover) instead.
      if (d.peek.length < 300 && res.images.length) {
        const r = await readPictures(res.images.slice(0, 2), d, ctx.readCfg, ctx.session, () => {}, async () => {}, ctx.check);
        d.peek = withPictureReadings(res.body.split("\n\n").slice(0, 6).join("\n\n"), r.readings).slice(0, PEEK);
      }
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      d.peek = "";
      d.unreadable = explain(e);
    }
    await rep.push();
  }
  Object.assign(p.steps.read, { state: "done", done: docs.length, note: "" });

  // 3. Claude sorts them into papers (with their mark schemes and inserts) and other documents
  p.stage = "plan";
  Object.assign(p.steps.plan, { state: "working", note: "Claude is matching each paper to its mark scheme and inserts", elapsed: 0 });
  rep.started = Date.now();
  await rep.push(true);
  const readable = docs.filter((d) => !d.unreadable);
  const msg = await claude(ctx.session).beta.messages.parse({
    model: "claude-sonnet-5-5",
    max_tokens: 16000,
    output_config: { effort: "medium", format: zodOutputFormat(Matched) },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: ctx.cfg.prompts && ctx.cfg.prompts.match ? ctx.cfg.prompts.match : undefined,
    messages: [{
      role: "user",
      content: `<known_qualifications>\n${ctx.quals.join("\n")}\n</known_qualifications>\n\n${plural(readable.length, "file")} in this folder.\n\n` + readable.map((d) => `<file id="${d.id}" path="${d.path.replace(/"/g, "'")}">\n${d.peek || "(no text could be read)"}\n</file>`).join("\n\n"),
    }],
  });
  rep.started = 0;
  if (!msg.parsed_output) throw new Error("Claude could not sort the files in this zip. Try again.");
  const byId = new Map(readable.map((d) => [d.id, d]));
  const used = new Set();
  const others = [];

  // Every version of the same paper (same qualification and title) is one paper: the mark scheme and inserts found
  // for any version go with all of them, and the standard version is read first.
  const groups = new Map();
  for (const m of msg.parsed_output.papers) {
    const exam = byId.get(m.exam_file);
    if (!exam || used.has(exam.id)) continue;
    used.add(exam.id);
    let scheme = byId.get(m.scheme_file);
    if (scheme && used.has(scheme.id)) scheme = null;
    if (scheme) used.add(scheme.id);
    const details = { qualification: m.qualification, paper_number: m.paper_number, month: m.month, year: m.year };
    const title = titleOf(details) || exam.name.replace(/\.[^.]+$/, "");
    const key = `${(details.qualification || "").toLowerCase()}|${title.toLowerCase()}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, title, details, copies: [], schemes: [], inserts: new Map() }));
    g.copies.push({ exam, modified: !!m.modified || ALTERNATIVE.test(exam.name) });
    if (scheme) g.schemes.push(scheme);
    for (const v of m.inserts || []) {
      const d = byId.get(v.file);
      if (d && !g.inserts.has(d.id)) g.inserts.set(d.id, { doc: d, modified: !!v.modified || ALTERNATIVE.test(d.name) });
    }
  }
  const pairs = [...groups.values()];
  for (const g of pairs) {
    g.copies.sort((a, b) => Number(a.modified) - Number(b.modified));
    g.scheme = g.schemes[0] || null;
    for (const extra of g.schemes.slice(1)) others.push(`${extra.path} (another copy of the mark scheme for ${g.title})`);
    // An id Claude gave as an insert but that is a paper or mark scheme is not an insert.
    const ins = [...g.inserts.values()].filter((v) => !used.has(v.doc.id));
    // The standard version's inserts. An insert that comes only in modified versions holds what the standard
    // paper prints itself (enlarged papers move it out), so it is read only with a modified version of the paper.
    g.insertDocs = ins.filter((v) => !v.modified).map((v) => v.doc);
    g.modifiedInsert = g.insertDocs.length ? null : (ins[0] || {}).doc || null;
    g.otherInserts = ins.filter((v) => !g.insertDocs.includes(v.doc)).map((v) => v.doc);
  }
  for (const g of pairs) for (const d of [...g.insertDocs, ...g.otherInserts]) used.add(d.id);

  // The other assessment resources worth reading (each file once), and what is left over.
  const resources = [];
  // Documents already in the hub (same kind and file name) are not read again.
  const haveDocs = new Set((meta.docs || []).map((d) => `${d.kind}|${d.title.toLowerCase()}`));
  const docsSkipped = [];
  for (const m of msg.parsed_output.documents) {
    const doc = byId.get(m.file);
    if (!doc || used.has(doc.id) || m.kind === "other") continue;
    used.add(doc.id);
    const details = { qualification: m.qualification, paper_number: m.paper_number, month: m.month, year: m.year };
    const key = `${m.kind}|${doc.name.replace(/\.[^.]+$/, "").toLowerCase()}`;
    if (haveDocs.has(key)) { docsSkipped.push({ doc, kind: m.kind, details }); continue; }
    haveDocs.add(key);
    resources.push({ doc, kind: m.kind, details });
  }
  others.push(
    ...msg.parsed_output.documents.filter((o) => o.kind === "other" && byId.has(o.file) && !used.has(o.file)).map((o) => `${byId.get(o.file).path} (${o.reason})`),
    ...readable.filter((d) => !used.has(d.id) && !msg.parsed_output.documents.some((o) => o.file === d.id)).map((d) => `${d.path} (not recognised)`),
    ...docs.filter((d) => d.unreadable).map((d) => `${d.path} (could not be read: ${d.unreadable})`),
  );

  // Papers already in the hub are not added twice.
  // A paper whose qualification is not known counts as the same as one of any qualification with the same name.
  const have = (meta.papers || []).map((x) => ({ q: (x.qualification || "").toLowerCase(), t: x.title.toLowerCase() }));
  const already = (q, t) => have.some((h) => h.t === t && (!h.q || !q || h.q === q));
  const todo = [];
  for (const g of pairs) {
    const first = g.copies[0].exam;
    const files = [first.name, g.scheme ? g.scheme.name : "", ...g.insertDocs.map((d) => d.name)].filter(Boolean).join(" + ");
    const notes = [];
    if (g.copies.length > 1) notes.push(`Other versions of this paper, read only if the first cannot be: ${g.copies.slice(1).map((c) => c.exam.name).join(", ")}.`);
    if (g.otherInserts.length) {
      notes.push(g.modifiedInsert
        ? `Inserts of the modified versions only (the standard paper prints this material itself), read only with a modified version: ${g.otherInserts.map((d) => d.name).join(", ")}.`
        : `Other versions of its insert, not needed: ${g.otherInserts.map((d) => d.name).join(", ")}.`);
    }
    g.row = { key: first.id, name: `${g.title}${g.details.qualification ? ` · ${g.details.qualification}` : ""}`, state: "waiting", text: g.scheme ? files : `${files} (no mark scheme found)` };
    if (notes.length) g.row.detail = notes.join(" ");
    p.files.push(g.row);
    if (already((g.details.qualification || "").toLowerCase(), g.title.toLowerCase())) Object.assign(g.row, { state: "skipped", text: "Already in the question hub" });
    else todo.push(g);
  }
  for (const r of resources) {
    const series = [r.details.month, r.details.year > 0 ? String(r.details.year) : "", r.details.paper_number].filter(Boolean).join(" ");
    r.row = { key: r.doc.id, name: `${KIND_LABEL[r.kind]}${series ? ` · ${series}` : ""}${r.details.qualification ? ` · ${r.details.qualification}` : ""}`, state: "waiting", text: r.doc.name };
    p.files.push(r.row);
  }
  if (docsSkipped.length) {
    p.files.push({
      key: "docs-skipped",
      name: `${plural(docsSkipped.length, "exam document")} already in the hub`,
      state: "skipped",
      text: "Read before, so not read again",
      detail: docsSkipped.map((d) => `${d.doc.name} (${KIND_LABEL[d.kind]})`).join(" · "),
    });
  }
  if (others.length) p.files.push({ key: "others", name: `${plural(others.length, "other document")} not used`, state: "skipped", text: "Not a paper, mark scheme, insert or other useful exam document", detail: others.join(" · ") });
  const withScheme = pairs.filter((x) => x.scheme).length;
  const withInsert = pairs.filter((x) => x.insertDocs.length).length;
  Object.assign(p.steps.plan, {
    state: "done",
    note: [
      `${plural(pairs.length, "paper")} found, ${withScheme} with a mark scheme${withInsert ? `, ${withInsert} with an insert` : ""}`,
      resources.length ? `${plural(resources.length, "other exam document")} to read` : "",
    ].filter(Boolean).join(" · "),
  });
  if (!pairs.length && !resources.length && !docsSkipped.length) throw new Error("Claude found no question papers or other exam documents in this zip.");

  // 4. read the other documents, then add each paper (a few at a time)
  p.stage = "file";
  const jobs = [...resources.map((r) => ({ resource: r })), ...todo.map((g) => ({ group: g }))];
  Object.assign(p.steps.file, { state: "working", done: 0, of: jobs.length, note: "" });
  await rep.push(true);
  let added = 0, questions = 0, failed = 0, read = 0, unread = 0, notStarted = 0;
  const touched = [];
  const finished = async () => {
    p.steps.file.done = added + failed + read + unread + notStarted;
    await rep.push(true);
  };
  // After an account problem (no credit, key rejected) nothing else can be read: stop, and say so on each row left.
  const stop = (e) => { if (!ctx.halt) ctx.halt = explain(e); };
  await pool(jobs, PAPERS_AT_ONCE, async (job) => {
    rep.check();
    const row = job.resource ? job.resource.row : job.group.row;
    if (ctx.halt) {
      notStarted++;
      Object.assign(row, { state: "skipped", text: `Not started: ${ctx.halt}` });
      await finished();
      return;
    }
    if (job.resource) {
      const r = job.resource;
      try {
        touched.push(await addDoc({ ...ctx, kind: r.kind, details: r.details, doc: r.doc, set: setter(r.row) }));
        read++;
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        if (accountProblem(e)) stop(e);
        unread++;
        console.warn(`could not read ${r.doc.path}: ${e && e.stack ? e.stack : e}`);
        setter(r.row)("failed", `Not read: ${explain(e)}`);
      }
      await finished();
      return;
    }
    const g = job.group;
    const set = setter(g.row);
    const cache = new Map();
    let lastErr = null;
    for (let i = 0; i < g.copies.length; i++) {
      const exam = g.copies[i].exam;
      try {
        const inserts = g.copies[i].modified && g.modifiedInsert ? [g.modifiedInsert] : g.insertDocs;
        const saved = await addOne({ ...ctx, title: "", details: g.details, exam, scheme: g.scheme, inserts, cache, set, onFraction: async () => { rep.check(); await rep.push(); } });
        added++;
        questions += saved.questions;
        touched.push(saved.qualification);
        const bits = [`${plural(saved.questions, "question")} added`];
        if (i > 0) bits.push(`from ${exam.name}`);
        if (!g.scheme) bits.push("no mark scheme, so Claude wrote one");
        if (inserts.length) bits.push(`with ${inserts.length === 1 ? "its insert" : plural(inserts.length, "insert")}`);
        if (saved.dropped) bits.push(`${saved.dropped} could not be used`);
        set("done", bits.join(" · "));
        lastErr = null;
        break;
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        lastErr = e;
        console.warn(`could not add ${g.title} from ${exam.path}: ${e && e.stack ? e.stack : e}`);
        if (accountProblem(e)) { stop(e); break; }
        if (i + 1 < g.copies.length) set("working", `${exam.name} could not be used (${explain(e)}). Trying ${g.copies[i + 1].exam.name}…`, null);
      }
    }
    if (lastErr) {
      failed++;
      set("failed", `Not added: ${explain(lastErr)}`);
    }
    await finished();
  });
  Object.assign(p.steps.file, { state: ctx.halt ? "failed" : "done", note: "" });
  const skipped = pairs.length - todo.length;
  p.summary = [
    `${plural(added, "paper")} added (${plural(questions, "question")})`,
    skipped || docsSkipped.length ? `${skipped + docsSkipped.length} already in the hub` : "",
    failed ? `${failed} could not be added` : "",
    read ? `${plural(read, "other exam document")} read` : "",
    unread ? `${unread} could not be read` : "",
    notStarted ? `${notStarted} not started` : "",
    others.length ? `${plural(others.length, "other document")} not used` : "",
  ].filter(Boolean).join(" · ");
  return touched;
}
