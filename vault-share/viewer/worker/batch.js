// One batch of sources, filed on the server. The same three steps the Sources page used to run in the browser:
//   1. every file is converted and the text in its pictures is read (OCR);
//   2. Claude reads the whole batch at once, with the vault's catalogue, and plans topics and folders for it;
//   3. each file gets its own call, against the catalogue plus the plan (so it can be connected to any other file
//      of the batch, even one filed after it), and is then filed.
// A single file skips step 2. If planning fails, each file is filed on its own. Progress is reported to the server,
// which shows it on the Sources page; the person who added the files does not need to keep the page open.
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { convertOffice } from "../../../microsidian/src/convert";
import { buildCatalogue } from "../../../microsidian/src/ai/catalogue";
import { callClaude, explainError } from "../../../microsidian/src/ai/claude";
import { planBatch } from "../../../microsidian/src/ai/plan";
import { validate } from "../../../microsidian/src/ingest/proposal";
import { checkPlan, fitToPlan, mergeKnownTopics, planNote } from "../../../microsidian/src/ingest/batch";
import { applyIngest } from "../../../microsidian/src/vault/apply";
import { internal, ApiError, ServerIO, Session } from "./server.js";
import { readImageText, withImageText } from "./ocr.js";

const OFFICE = /\.(docx|pptx)$/i;
const basename = (p) => p.split("/").pop();
const extOf = (p) => (p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "");

class Cancelled extends Error {}

function explain(e) {
  if (e instanceof ApiError) return e.message;
  if (e && e.status === 401) return "The Anthropic API key is missing or was rejected. An admin can fix it under Admin → Microsidian.";
  return explainError(e).replace("in the plugin settings", "under Admin → Microsidian");
}

// Sends the batch's progress to the server: at most every 1.5 seconds, at once when forced, and every 5 seconds
// while a long step is running (so the page's clock keeps going). The answer says whether to stop.
class Reporter {
  constructor(id, progress) {
    this.id = id;
    this.p = progress;
    this.last = 0;
    this.cancel = false;
    this.started = 0; // when the step being timed began
    this.timer = setInterval(() => { void this.push(true); }, 5000);
  }
  async push(force = false) {
    const now = Date.now();
    if (!force && now - this.last < 1500) return;
    this.last = now;
    if (this.started && this.p.steps.plan.state === "working") this.p.steps.plan.elapsed = Math.round((now - this.started) / 1000);
    try {
      const r = await internal(this.id, { progress: this.p });
      if (r && r.cancel) this.cancel = true;
    } catch (e) {
      console.warn(`progress report failed: ${e.message}`);
    }
  }
  check() {
    if (this.cancel) throw new Cancelled();
  }
  async finish(status) {
    clearInterval(this.timer);
    await internal(this.id, { progress: this.p, status });
  }
}

export async function runBatch(claim) {
  const prevDone = new Map(((claim.progress && claim.progress.files) || []).filter((f) => f.state === "done").map((f) => [f.key, f]));
  const p = {
    v: 1,
    stage: "read",
    planned: false,
    steps: {
      read: { state: "waiting", done: 0, of: 0, note: "" },
      plan: { state: "waiting", note: "", elapsed: 0 },
      file: { state: "waiting", done: 0, of: 0, note: "" },
    },
    files: [],
    summary: "",
  };
  const rep = new Reporter(claim.id, p);
  const session = new Session(claim.vault, claim.session);
  let status = "done";
  try {
    const cfg = await session.api("GET", "ingest/config");
    if (!cfg.configured) throw new Error("No Anthropic API key is set. An admin can add one under Admin → Microsidian.");

    // The uploads: Word and PowerPoint files, and zips, whose Word and PowerPoint files (in any subfolder) are
    // each a source. A zip is opened once; each file in it is unpacked when it is needed.
    const sources = [];
    for (let i = 0; i < claim.files.length; i++) {
      const f = claim.files[i];
      if (extOf(f.name) === "zip") {
        const row = { key: `${i}`, name: f.name, state: "working", text: "Opening the zip…" };
        p.files.push(row);
        try {
          const zip = await JSZip.loadAsync(await readFile(f.path));
          const entries = Object.values(zip.files)
            .filter((e) => !e.dir && OFFICE.test(e.name) && !basename(e.name).startsWith("~$") && !e.name.split("/").some((s) => s.startsWith(".") || s === "__MACOSX"))
            .sort((a, b) => a.name.localeCompare(b.name));
          if (!entries.length) Object.assign(row, { state: "failed", text: "Not added: no .docx or .pptx files were found in this zip." });
          else Object.assign(row, { state: "done", text: `${entries.length} file${entries.length === 1 ? "" : "s"} found` });
          for (const e of entries) sources.push({ key: `${i}:${e.name}`, name: basename(e.name), title: e.name, get: () => e.async("uint8array") });
        } catch {
          Object.assign(row, { state: "failed", text: "Not added: this zip could not be opened." });
        }
      } else {
        sources.push({ key: `${i}`, name: f.name, title: f.name, get: async () => new Uint8Array(await readFile(f.path)) });
      }
    }
    for (const s of sources) {
      s.row = prevDone.get(s.key) ?? { key: s.key, name: s.title, state: "waiting", text: "Waiting…" };
      p.files.push(s.row);
    }
    // After a restart, files that were already filed are not filed again.
    const todo = sources.filter((s) => s.row.state !== "done");
    const set = (s, state, text, bar) => {
      s.row.state = state;
      s.row.text = text;
      if (bar === undefined) delete s.row.bar; else s.row.bar = bar;
    };
    const fail = (s, e) => {
      if (e instanceof Cancelled) throw e;
      console.warn(`could not add ${s.title}: ${e && e.stack ? e.stack : e}`);
      set(s, "failed", `Not added: ${explain(e)}`);
    };
    p.planned = todo.length > 1;
    p.steps.read.of = todo.length;
    p.steps.file.of = todo.length;
    await rep.push(true);

    // 1. read every file
    p.steps.read.state = "working";
    for (let i = 0; i < todo.length; i++) {
      const s = todo[i];
      rep.check();
      p.steps.read.done = i;
      p.steps.read.note = s.name;
      try {
        s.doc = await readSource(s, cfg, set, async (f) => { p.steps.read.done = i + f; rep.check(); await rep.push(); });
        set(s, "waiting", todo.length > 1 ? "Read · waiting for the rest of the batch" : "Read");
      } catch (e) {
        fail(s, e);
      }
      await rep.push();
    }
    Object.assign(p.steps.read, { state: "done", done: todo.length, note: "" });
    const ready = todo.filter((s) => s.doc);
    // Claude knows each file by a short id; file names can hold any character.
    ready.forEach((s, n) => { s.id = `D${n + 1}`; });

    const io = new ServerIO(session, cfg.layout);
    await io.load();

    // 2. plan the batch
    let plan = null;
    if (p.planned) {
      p.stage = "plan";
      if (ready.length < 2) {
        Object.assign(p.steps.plan, { state: "skipped", note: ready.length ? "Only one file could be read, so there is nothing to plan." : "" });
      } else {
        for (const s of ready) set(s, "working", "Claude is reading the whole batch…", null);
        Object.assign(p.steps.plan, { state: "working", note: "Claude is reading every file before deciding anything", elapsed: 0 });
        rep.started = Date.now();
        await rep.push(true);
        try {
          const cat = await buildCatalogue(io, cfg.layout);
          const out = await planBatch({
            apiKey: "held-by-the-server",
            fetch: session.claudeFetch,
            effort: cfg.effort,
            catalogue: cat,
            guidance: cfg.guidance,
            documents: ready.map((s) => ({ id: s.id, fileName: s.doc.fileName, text: s.doc.text })),
          });
          plan = checkPlan(out.plan, cat, cfg.layout, ready.map((s) => ({ id: s.id, fileName: s.doc.fileName })), (x) => io.files.has(x));
          for (const id of out.shortened) {
            const s = ready.find((x) => x.id === id);
            if (s) s.planShortened = true;
          }
          const u = out.usage;
          const bits = [
            `${plan.newTopics.length} new topic${plan.newTopics.length === 1 ? "" : "s"} planned`,
            `${(u.input + u.cacheRead).toLocaleString("en-GB")} tokens in, ${u.output.toLocaleString("en-GB")} out`,
          ];
          if (out.shortened.length) bits.push(`the batch was too large to send whole, so ${out.shortened.length} of the longest files were shortened for the plan (each file's own step still sees all of it)`);
          if (out.fallbackUsed) bits.push("a substitute model was used because the first declined");
          Object.assign(p.steps.plan, { state: "done", note: bits.join(" · ") });
        } catch (e) {
          if (e instanceof Cancelled) throw e;
          console.warn(`could not plan the batch: ${e && e.stack ? e.stack : e}`);
          Object.assign(p.steps.plan, { state: "failed", note: `The batch could not be planned (${explain(e)}). Each file is filed on its own instead.` });
        }
        rep.started = 0;
        for (const s of ready) set(s, "waiting", "Waiting to be filed…");
      }
      await rep.push(true);
    }

    // 3. connect and file each one
    p.stage = "file";
    p.steps.file.state = "working";
    let filed = 0;
    for (let i = 0; i < ready.length; i++) {
      const s = ready[i];
      rep.check();
      p.steps.file.done = i;
      p.steps.file.note = s.name;
      await rep.push(true);
      try {
        if (await fileSource(s, cfg, io, plan, ready.length, set, async (f) => { p.steps.file.done = i + f; await rep.push(); })) filed++;
      } catch (e) {
        fail(s, e);
      }
    }
    Object.assign(p.steps.file, { state: "done", done: ready.length, note: "" });
    const before = sources.length - todo.length;
    const left = todo.length - filed;
    p.summary = `${filed + before} filed${left ? ` · ${left} not added` : ""}`;
  } catch (e) {
    if (e instanceof Cancelled) {
      status = "cancelled";
      for (const f of p.files) if (f.state === "waiting" || f.state === "working") Object.assign(f, { state: "skipped", text: "Not added: the batch was stopped." });
      const filed = p.files.filter((f) => f.state === "done" && f.link).length;
      p.summary = `Stopped · ${filed} filed`;
    } else {
      status = "failed";
      console.warn(`batch ${claim.id} failed: ${e && e.stack ? e.stack : e}`);
      for (const f of p.files) if (f.state === "waiting" || f.state === "working") Object.assign(f, { state: "failed", text: `Not added: ${explain(e)}` });
      p.summary = `Nothing more could be added: ${explain(e)}`;
    }
    for (const f of p.files) delete f.bar;
  }
  p.stage = "done";
  await rep.finish(status);
}

const convertOptions = (cfg) => ({ imageMinBytes: cfg.imageMinKB * 1000, isLogo: () => false, attachmentsDir: cfg.layout.attachments });

// Step 1 for one file: its text, with the words read from its pictures. Only the text is kept.
async function readSource(s, cfg, set, onFraction) {
  set(s, "working", "Reading the file…", null);
  const bytes = await s.get();
  if (bytes.byteLength > cfg.maxFileBytes) throw new Error(`Files can be at most ${Math.floor(cfg.maxFileBytes / 1048576)} MB.`);
  const res = await convertOffice(bytes, extOf(s.name), convertOptions(cfg));
  let ocr = { text: new Map(), failed: 0 };
  let ocrError = "";
  if (res.images.length) {
    set(s, "working", "Reading the text in its pictures…", 0);
    try {
      ocr = await readImageText(res.images, async (done, total) => {
        set(s, "working", `Reading the text in its pictures (${done + 1} of ${total})…`, done / total);
        await onFraction(done / total);
      });
    } catch (e) {
      if (e instanceof Cancelled) throw e;
      console.warn(`OCR could not run: ${e && e.stack ? e.stack : e}`);
      ocrError = e && e.message ? e.message : String(e);
    }
  }
  return { fileName: s.name, text: withImageText(res.body, ocr.text), pictures: ocr.text.size, ocrFailed: ocr.failed, ocrError };
}

// Step 3 for one file: Claude's connections for it, checked, then the note and the original are written.
async function fileSource(s, cfg, io, plan, total, set, onFraction) {
  const { layout } = cfg;
  const doc = s.doc;
  const planned = plan ? plan.docs.get(s.id) ?? null : null;
  if (planned && !planned.suitable) {
    set(s, "skipped", `Not added: ${planned.reason || "the filing guidance says not to file this kind of document."}`);
    return false;
  }

  // With a plan, every file is checked against the same catalogue: the vault plus the whole batch. Without one,
  // the vault is read again so this file sees the ones filed before it.
  let cat;
  if (plan) cat = plan.catalogue;
  else {
    set(s, "working", "Looking through the vault…", null);
    await io.load();
    cat = await buildCatalogue(io, layout);
  }

  set(s, "working", plan ? "Claude is making its connections…" : "Asking Claude where it belongs…", null);
  await onFraction(0.05);
  const outcome = await callClaude({
    apiKey: "held-by-the-server",
    fetch: io.s.claudeFetch,
    effort: cfg.effort,
    catalogue: cat,
    guidance: cfg.guidance,
    fileName: doc.fileName,
    documentText: doc.text,
    batchPlan: planned ? planNote(planned, total) : undefined,
  });
  await onFraction(0.7);
  let proposal = validate(mergeKnownTopics(outcome.analysis, cat), cat, doc.text, layout);
  if (plan) proposal = await fitToPlan(proposal, planned, plan, (name) => io.exists(`${layout.topics}/${name}.md`));
  if (!proposal.suitable) {
    set(s, "skipped", `Not added: ${proposal.reason || "the filing guidance says not to file this kind of document."}`);
    return false;
  }

  set(s, "working", "Filing it…", 0.75);
  const bytes = await s.get();
  const ext = extOf(s.name);
  const ingestPath = `${layout.ingest}/${s.name}`;
  io.pending = { path: ingestPath, bytes };
  let report;
  try {
    report = await applyIngest(
      {
        io,
        cat,
        layout,
        updateFolderIndexes: cfg.updateFolderIndexes,
        convert: async (path) => {
          const out = await convertOffice(await io.readBinary(path), ext, { ...convertOptions(cfg), originalPath: path });
          for (const img of out.images) if (!(await io.exists(img.path))) await io.writeBinary(img.path, img.data);
          return out;
        },
      },
      ingestPath,
      proposal,
    );
  } finally {
    io.pending = null;
  }
  await onFraction(1);

  const topics = proposal.topics.length + proposal.newTopics.length;
  const u = outcome.usage;
  const bits = [
    `${topics} topic${topics === 1 ? "" : "s"}`,
    `${proposal.related.length} related note${proposal.related.length === 1 ? "" : "s"}`,
    `${report.changed.length} files updated`,
    `${(u.input + u.cacheRead).toLocaleString("en-GB")} tokens in, ${u.output.toLocaleString("en-GB")} out`,
  ];
  if (doc.pictures) bits.push(`text read from ${doc.pictures} picture${doc.pictures === 1 ? "" : "s"}`);
  if (planned) bits.push("planned with the batch");
  const notes = [...report.warnings];
  if (outcome.fallbackUsed) notes.push("A substitute model was used because the first declined.");
  if (doc.ocrError) notes.push(`The text in its pictures could not be read (${doc.ocrError}), so Claude saw only the document's own text.`);
  else if (doc.ocrFailed) notes.push(`${doc.ocrFailed} picture${doc.ocrFailed === 1 ? "" : "s"} could not be read.`);
  if (s.planShortened) notes.push("Its text was shortened for the batch plan, which was too large to send whole; its own connections used all of it.");
  if (planned && report.notePath.slice(0, -3) !== planned.notePath) notes.push(`It was filed at a different path from the one planned (${planned.notePath}), so links to it from this batch may need fixing.`);
  if (cat.omitted) notes.push(`This vault is large: ${cat.omitted} notes were not shown to Claude.`);
  set(s, "done", "Filed");
  s.row.link = report.notePath;
  s.row.detail = `${bits.join(" · ")}${notes.length ? ". " + notes.join(" ") : ""}`;
  return true;
}
