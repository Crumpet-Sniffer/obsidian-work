// Builds ../static/ingest.js. It bundles Microsidian's source from ../../microsidian, which has no node_modules of
// its own here, so its imports are resolved from this folder's node_modules.
import esbuild from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(here, "ingest.js")],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2020",
  platform: "browser",
  outfile: join(here, "../static/ingest.js"),
  nodePaths: [join(here, "node_modules")],
  alias: { crypto: join(here, "shims/crypto.js") },
  logLevel: "info",
});
