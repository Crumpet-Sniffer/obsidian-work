// The ingest worker. Started (and restarted) by the vault-share server, which passes VS_SERVER, VS_WORKER_TOKEN and
// OCR_DIR. It asks the server for the next batch of uploaded sources every few seconds, files it, and reports
// progress as it goes. One batch at a time; batches wait in the server's queue.
import { runBatch } from "./batch.js";
import { internal } from "./server.js";

const IDLE_MS = 3000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!process.env.VS_SERVER || !process.env.VS_WORKER_TOKEN) {
  console.error("VS_SERVER and VS_WORKER_TOKEN must be set (the vault-share server starts this worker).");
  process.exit(2);
}

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stopping = true; process.exit(0); });

console.log("ingest worker ready");
while (!stopping) {
  let claim = null;
  try {
    claim = await internal("claim");
  } catch (e) {
    console.warn(`could not ask for work: ${e.message}`);
  }
  if (!claim) {
    await sleep(IDLE_MS);
    continue;
  }
  console.log(`batch ${claim.id}: ${claim.files.length} upload(s)`);
  const t0 = Date.now();
  try {
    await runBatch(claim);
  } catch (e) {
    // runBatch reports its own failures; this is only reached if even that report could not be sent.
    console.error(`batch ${claim.id}: ${e && e.stack ? e.stack : e}`);
    await sleep(IDLE_MS);
  }
  console.log(`batch ${claim.id} finished in ${Math.round((Date.now() - t0) / 1000)} s`);
}
