// A past exam paper and its mark scheme, for the question hub on the Practice page. Both files are read like
// sources (text, and the text in their pictures), kept in the vault under the originals folder, and Claude splits
// the paper into its questions, each with its marks, type, topics and mark scheme. The questions go to the server,
// which checks them and saves them (src/handlers/practice.rs, add_paper).
import { readFile } from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";
import { ServerIO, Session } from "./server.js";
import { withPictureReadings } from "./pictures.js";
import { Cancelled, Reporter, convertOptions, convertSource, explain, readPictures } from "./batch.js";

const Extracted = z.object({
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

/** Most characters of the paper and mark scheme sent to Claude together (about 400,000 tokens). */
const BUDGET = 1_600_000;

const safeName = (s) => s.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Paper";

export async function runPaper(claim) {
  const title = String((claim.meta && claim.meta.title) || "Past paper");
  const p = {
    v: 1,
    kind: "paper",
    stage: "read",
    planned: true,
    steps: {
      read: { state: "waiting", done: 0, of: claim.files.length, note: "" },
      plan: { state: "waiting", note: "", elapsed: 0 },
      file: { state: "waiting", done: 0, of: 1, note: "" },
    },
    files: claim.files.map((f, i) => ({ key: `${i}`, name: f.name, state: "waiting", text: i === 0 ? "Exam paper" : "Mark scheme" })),
    summary: "",
  };
  const rep = new Reporter(claim.id, p);
  const session = new Session(claim.vault, claim.session);
  let status = "done";
  try {
    const cfg = await session.api("GET", "ingest/config");
    if (!cfg.configured) throw new Error("No Anthropic API key is set. An admin can add one under Admin → Microsidian.");
    // Pictures shown to the filing model directly is a filing choice; a paper's pictures are always read to text.
    const readCfg = cfg.images && cfg.images.mode === "claude" && !cfg.images.model ? { ...cfg, images: { ...cfg.images, mode: "ocr" } } : cfg;
    const io = new ServerIO(session, cfg.layout);
    await io.load();
    const folder = `${cfg.layout.originals}/Question Hub/${safeName(title)}`;
    await rep.push(true);

    // 1. read both files, and keep them (and their pictures) in the vault
    p.steps.read.state = "working";
    const texts = [];
    const paths = [];
    for (let i = 0; i < claim.files.length; i++) {
      const f = claim.files[i];
      const row = p.files[i];
      const set = (state, text, bar) => { row.state = state; row.text = text; if (bar === undefined) delete row.bar; else row.bar = bar; };
      const s = { name: f.name, title: `${title}: ${f.name}`, row };
      rep.check();
      p.steps.read.note = f.name;
      set("working", "Reading the file…", null);
      const bytes = new Uint8Array(await readFile(f.path));
      const res = await convertSource(bytes, f.name, convertOptions(cfg));
      const r = await readPictures(res.images, s, readCfg, session, (_s, state, text, bar) => set(state, text, bar), async (fr) => { p.steps.read.done = i + fr; rep.check(); await rep.push(); }, () => rep.check());
      texts.push(withPictureReadings(res.body, r.readings));
      set("working", "Saving it in the vault…", null);
      let path = `${folder}/${f.name}`;
      for (let n = 2; await io.exists(path); n++) path = `${folder}/${f.name.replace(/(\.[^.]+)$/, ` (${n})$1`)}`;
      await io.writeBinary(path, bytes);
      for (const img of res.images) if (!(await io.exists(img.path))) await io.writeBinary(img.path, img.data);
      paths.push(path);
      set("done", `${i === 0 ? "Exam paper" : "Mark scheme"} read${r.readings.size ? ` · ${r.readings.size} picture${r.readings.size === 1 ? "" : "s"} ${r.how}` : ""}`);
      p.steps.read.done = i + 1;
      await rep.push(true);
    }
    Object.assign(p.steps.read, { state: "done", note: "" });

    // 2. Claude splits the paper into questions
    p.stage = "plan";
    Object.assign(p.steps.plan, { state: "working", note: "Claude is reading the paper and its mark scheme", elapsed: 0 });
    rep.started = Date.now();
    await rep.push(true);
    const meta = await session.api("GET", "practice/meta");
    let paper = texts[0] || "";
    let scheme = texts[1] || "";
    if (paper.length + scheme.length > BUDGET) {
      const half = Math.floor(BUDGET / 2);
      paper = paper.slice(0, Math.max(half, BUDGET - scheme.length));
      scheme = scheme.slice(0, BUDGET - paper.length);
    }
    const client = new Anthropic({ apiKey: "held-by-the-server", fetch: session.claudeFetch, dangerouslyAllowBrowser: true });
    const msg = await client.beta.messages.parse({
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
            `<topics>\n${(meta.topics || []).join("\n")}\n</topics>\n\n` +
            `<exam_paper title="${title.replace(/"/g, "'")}">\n${paper}\n</exam_paper>\n\n` +
            (scheme ? `<mark_scheme>\n${scheme}\n</mark_scheme>` : "<mark_scheme>\n(No mark scheme was uploaded: write one for each question.)\n</mark_scheme>"),
        },
      ],
    });
    rep.started = 0;
    if (msg.stop_reason === "refusal") throw new Error("Claude declined to read this paper.");
    if (msg.stop_reason === "max_tokens") throw new Error("The paper has too many questions to read in one go. Split it into parts and add each one.");
    if (!msg.parsed_output) throw new Error("Claude's list of questions could not be read. Try again.");
    const found = msg.parsed_output.questions;
    const u = msg.usage;
    Object.assign(p.steps.plan, { state: "done", note: `${found.length} question${found.length === 1 ? "" : "s"} found · ${(u.input_tokens + (u.cache_read_input_tokens || 0)).toLocaleString("en-GB")} tokens in, ${u.output_tokens.toLocaleString("en-GB")} out` });

    // 3. save them in the question hub
    p.stage = "file";
    Object.assign(p.steps.file, { state: "working", note: "Adding the questions to the hub" });
    await rep.push(true);
    const saved = await session.api("POST", "practice/papers", { json: { title, exam_path: paths[0] || "", scheme_path: paths[1] || "", questions: found } });
    Object.assign(p.steps.file, { state: "done", done: 1, note: "" });
    p.summary = `${saved.questions} question${saved.questions === 1 ? "" : "s"} added to the hub${saved.dropped ? ` · ${saved.dropped} could not be used` : ""}`;
  } catch (e) {
    if (e instanceof Cancelled) {
      status = "cancelled";
      p.summary = "Stopped";
    } else {
      status = "failed";
      console.warn(`paper ${claim.id} failed: ${e && e.stack ? e.stack : e}`);
      p.summary = `The paper could not be added: ${explain(e)}`;
    }
    for (const f of p.files) if (f.state === "waiting" || f.state === "working") Object.assign(f, { state: status === "cancelled" ? "skipped" : "failed" });
    for (const s of Object.values(p.steps)) if (s.state === "working") s.state = "failed";
  }
  p.stage = "done";
  await rep.finish(status);
}
