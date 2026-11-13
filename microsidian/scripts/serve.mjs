// Tiny static server for the render harness: serves scripts/harness and the vault's _Originals.
import http from "node:http";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VAULT = process.env.MICROSIDIAN_VAULT ? resolve(process.env.MICROSIDIAN_VAULT) : resolve(ROOT, ".fixture", "vault");
const ORIG = join(VAULT, "_Originals");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json" };
function walk(d, out = []) { for (const f of readdirSync(d)) { const p = join(d, f); statSync(p).isDirectory() ? walk(p, out) : out.push(p); } return out; }
http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  try {
    if (url === "/list") {
      const files = walk(ORIG).filter(f => /\.(docx|pptx)$/i.test(f)).map(f => f.slice(ORIG.length + 1).split(String.fromCharCode(92)).join("/"));
      res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(files));
    }
    if (url.startsWith("/orig/")) {
      const p = join(ORIG, url.slice(6)); if (!p.startsWith(ORIG) || !existsSync(p)) throw 404;
      res.writeHead(200, { "content-type": "application/octet-stream" }); return res.end(readFileSync(p));
    }
    const p = join(ROOT, "scripts", "harness", url === "/" ? "index.html" : url.slice(1));
    if (!p.startsWith(join(ROOT, "scripts", "harness")) || !existsSync(p)) throw 404;
    res.writeHead(200, { "content-type": MIME[extname(p)] || "application/octet-stream" }); res.end(readFileSync(p));
  } catch (e) { res.writeHead(e === 404 ? 404 : 500); res.end(String(e)); }
}).listen(Number(process.env.PORT) || 4173, "127.0.0.1", () => console.log("harness listening"));
