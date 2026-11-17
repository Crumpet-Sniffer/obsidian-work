// Downloads the OCR models into ../ocr for running the site outside Docker (then set OCR_DIR to that folder).
// The same files, pinned the same way, are fetched by the Dockerfile; keep the two lists in step.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "ocr");
const FILES = [
  ["PP-OCRv6_small_det.onnx", "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_det_onnx/resolve/28fe5895c24fd108c19eb3e8479f4ab385fbfc62/inference.onnx", "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e"],
  ["PP-OCRv6_small_rec.onnx", "https://huggingface.co/PaddlePaddle/PP-OCRv6_small_rec_onnx/resolve/b8f84f0b80c529de40b4fbb3544b84fa7233a513/inference.onnx", "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634"],
];
const sha = (b) => createHash("sha256").update(b).digest("hex");

for (const [name, url, want] of FILES) {
  const path = join(dir, name);
  if (existsSync(path) && sha(readFileSync(path)) === want) { console.log(`${name}: already here`); continue; }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== want) throw new Error(`${name}: checksum mismatch, not saved`);
  writeFileSync(path, buf);
  console.log(`${name}: saved (${(buf.length / 1e6).toFixed(1)} MB)`);
}
