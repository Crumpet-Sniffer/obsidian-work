// Builds ../worker/worker.mjs, the ingest worker the server runs with Node.js (see src/worker.rs). It bundles
// Microsidian's source from ../../microsidian and everything else, except onnxruntime-node, which is native and is
// installed next to it (../worker/package.json; the Dockerfile does that).
import esbuild from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

await esbuild.build({
  entryPoints: [join(here, "worker/main.js")],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: join(here, "../worker/worker.mjs"),
  nodePaths: [join(here, "node_modules")],
  // @napi-rs/canvas: pdf.js tries it for rendering, which the worker never does.
  external: ["onnxruntime-node", "@napi-rs/canvas"],
  // Bundled CommonJS packages still call require() for Node's own modules.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: "eof",
  logLevel: "info",
});
