/**
 * Tests the Claude call against a MOCK server (no network, no API key, no cost):
 * checks the exact request the SDK sends, that a valid reply is parsed, and the refusal / error paths.
 * Vault for the catalogue: the generated sample, or $MICROSIDIAN_VAULT.   Usage: npx tsx scripts/claude-mock.ts
 */
import { buildCatalogue } from "../src/ai/catalogue";
import { callClaude, explainError, MODEL } from "../src/ai/claude";
import { NodeIO } from "./nodeIO";
import { target } from "./lib";

let failures = 0;
const check = (ok: boolean, msg: string) => { console.log(`  ${ok ? "PASS" : "FAIL"}  ${msg}`); if (!ok) failures++; };

const reply = {
  suitable: true, reason: "A meeting document.", folderPath: "Projects/Alpha",
  topics: [{ name: "Budget", phrases: ["budget"] }], newTopics: [], relatedNotes: [],
};
const message = (over: object = {}) => ({
  id: "msg_test", type: "message", role: "assistant", model: MODEL,
  content: [{ type: "text", text: JSON.stringify(reply) }],
  stop_reason: "end_turn", stop_sequence: null,
  usage: { input_tokens: 12000, output_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 8000 },
  ...over,
});

async function main() {
  const { vault, layout } = await target();
  const cat = await buildCatalogue(new NodeIO(vault, layout), layout);
  console.log(`catalogue: ${cat.notes.length} notes, ${cat.topics.length} topics, about ${Math.round(cat.text.length / 4).toLocaleString()} tokens`);

  const seen: { url: string; headers: Record<string, string>; body: any }[] = [];
  const mk = (status: number, json: unknown) => (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    seen.push({ url: String(input), headers, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const call = (f: typeof fetch, guidance = "") => callClaude({ apiKey: "sk-ant-test", fetch: f, effort: "medium", catalogue: cat, guidance, fileName: "Budget Review.docx", documentText: "## Slide 1\nThe budget is tight." });

  console.log("\nrequest and reply");
  const out = await call(mk(200, message()), "Do not file worksheets.");
  const r = seen[0];
  check(r.url.includes("/v1/messages"), `posts to ${new URL(r.url).pathname}`);
  check(r.body.model === "claude-sonnet-5-5", "model is claude-sonnet-5-5");
  check(r.body.fallbacks === "default", 'fallbacks: "default" is sent');
  check((r.headers["anthropic-beta"] ?? "").includes("server-side-fallback-2026-07-01"), "beta header server-side-fallback-2026-07-01 is sent");
  check(r.body.output_config?.effort === "medium" && r.body.output_config?.format?.type === "json_schema", "effort and a JSON-schema output format are sent");
  check(r.body.thinking === undefined && r.body.temperature === undefined && r.body.tool_choice === undefined, "no thinking budget, sampling or forced tool_choice (rejected on this model)");
  const sys: { text: string; cache_control?: unknown }[] = r.body.system;
  check(sys.length === 3 && sys[1].text.includes("Do not file worksheets.") && !sys[1].cache_control, "the user's guidance is its own system block");
  check(!!sys[2].cache_control && sys[2].text.startsWith("# VAULT CATALOGUE"), "catalogue is the last, cacheable system block");
  check(!/BTEC|course|spec code|unit/i.test(sys[0].text), "the base instructions mention no course, spec codes or units");
  check(r.body.messages.length === 1 && r.body.messages[0].role === "user", "single user message, no assistant prefill");
  check((r.headers["authorization"] ?? "") === "Bearer sk-ant-test" || r.headers["x-api-key"] === "sk-ant-test", "API key is sent (Authorization: Bearer, as this SDK version does)");
  check(r.headers["anthropic-dangerous-direct-browser-access"] === "true", "browser-access header is set (Obsidian runs in an Electron window)");
  const props = Object.keys(r.body.output_config.format.schema.properties ?? {}).join(",");
  check(props === "suitable,reason,folderPath,topics,newTopics,relatedNotes", `schema fields: ${props}`);
  check(out.analysis.folderPath === "Projects/Alpha" && out.analysis.topics[0].name === "Budget", "structured reply parsed");
  check(out.usage.cacheRead === 8000 && out.costUsd > 0 && out.costUsd < 0.05, `usage and cost read ($${out.costUsd.toFixed(4)})`);
  await call(mk(200, message()), "");
  check(seen[1].body.system.length === 2, "no guidance block is sent when the setting is empty");

  console.log("\nrefusal, truncation, bad output, errors");
  await call(mk(200, message({ stop_reason: "refusal", stop_details: { type: "refusal", category: "general_harms", explanation: "test refusal" } }))).then(
    () => check(false, "refusal should throw"), (e) => check(/declined.*test refusal/.test(e.message), "refusal becomes a clear error"));
  await call(mk(200, message({ stop_reason: "max_tokens" }))).then(
    () => check(false, "max_tokens should throw"), (e) => check(/cut off/.test(e.message), "truncated reply becomes a clear error"));
  await call(mk(200, message({ content: [{ type: "text", text: "not json" }] }))).then(
    () => check(false, "bad JSON should throw"), (e) => check(e instanceof Error, "unreadable reply throws instead of writing garbage"));
  for (const [status, expect] of [[401, /key was rejected/], [429, /Rate limited/], [403, /not allowed/]] as const) {
    await call(mk(status, { type: "error", error: { type: "x", message: "m" } })).then(
      () => check(false, `${status} should throw`), (e) => check(expect.test(explainError(e)), `HTTP ${status} -> "${explainError(e).slice(0, 50)}"`));
  }
  console.log(failures ? `\nFAILED ${failures}` : "\nall checks passed");
  process.exitCode = failures ? 1 : 0;
}
main().catch((e) => { console.error(e); process.exit(1); });
