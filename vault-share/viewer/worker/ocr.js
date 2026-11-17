// Reads the text in a source's pictures, on the server: PaddleOCR (PP-OCRv6 small, PaddlePaddle's own ONNX
// models) run by ONNX Runtime's native build, which uses every CPU core. Pictures are decoded in plain JavaScript
// (PNG, JPEG, GIF), so nothing else native is needed. Only the text is sent on to Claude, never the pictures.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as ort from "onnxruntime-node";
import { PaddleOcrService, parseRecognitionDictionary } from "paddleocr";
import { PNG } from "pngjs";
import jpeg from "jpeg-js";
import { GifReader } from "omggif";

const DIR = process.env.OCR_DIR || "ocr";
const FILES = { det: "PP-OCRv6_small_det.onnx", rec: "PP-OCRv6_small_rec.onnx", dict: "ppocrv6_dict.txt" };
// Larger pictures are scaled down first; the detector works on at most this many pixels per side anyway.
const MAX_SIDE = 2048;

let service = null;

async function load() {
  if (service) return service;
  const buf = async (name) => {
    const b = await readFile(join(DIR, name));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  };
  const [det, rec, dict] = await Promise.all([buf(FILES.det), buf(FILES.rec), readFile(join(DIR, FILES.dict), "utf8")]);
  service = await PaddleOcrService.createInstance({
    ort,
    modelPreset: "PP-OCRv6_small",
    detection: { modelBuffer: det },
    recognition: { modelBuffer: rec, charactersDictionary: parseRecognitionDictionary(dict) },
  });
  return service;
}

/** RGBA pixels of a picture, or null for a format that cannot be decoded here. */
function decode(path, data) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (ext === "png") {
    const p = PNG.sync.read(b);
    return { width: p.width, height: p.height, rgba: p.data };
  }
  if (ext === "jpg" || ext === "jpeg") {
    const j = jpeg.decode(b, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 250 });
    return { width: j.width, height: j.height, rgba: j.data };
  }
  if (ext === "gif") {
    const g = new GifReader(b);
    const rgba = new Uint8Array(g.width * g.height * 4);
    g.decodeAndBlitFrameRGBA(0, rgba);
    return { width: g.width, height: g.height, rgba };
  }
  return null;
}

/** Transparent areas become white (as they look on a slide or page); large pictures are averaged down. */
function prepare({ width, height, rgba }) {
  const k = Math.max(1, Math.ceil(Math.max(width, height) / MAX_SIDE));
  const w = Math.floor(width / k) || 1, h = Math.floor(height / k) || 1;
  const out = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, bl = 0, n = 0;
      for (let dy = 0; dy < k; dy++) {
        const sy = y * k + dy;
        if (sy >= height) break;
        for (let dx = 0; dx < k; dx++) {
          const sx = x * k + dx;
          if (sx >= width) break;
          const i = (sy * width + sx) * 4;
          const a = rgba[i + 3] / 255;
          r += rgba[i] * a + 255 * (1 - a);
          g += rgba[i + 1] * a + 255 * (1 - a);
          bl += rgba[i + 2] * a + 255 * (1 - a);
          n++;
        }
      }
      const o = (y * w + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = bl / n;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * Stock-photo watermarks and patterned backgrounds read as lines of one word over and over. They say nothing about
 * the document, so such lines are dropped, as are repeated lines.
 */
export function tidy(text) {
  const seen = new Set(), out = [];
  for (const line of text.split("\n")) {
    const words = line.split(/\s+/).map((w) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")).filter(Boolean);
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    const top = words.length ? Math.max(...counts.values()) / words.length : 0;
    if ((words.length >= 6 && top >= 0.4) || (words.length >= 4 && top >= 0.75)) continue;
    const key = words.join(" ");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(line.trim());
  }
  return out.join("\n");
}

/**
 * Read the text in each picture. Returns a Map of picture path -> text (pictures with no text are left out),
 * plus how many pictures could not be read. `onProgress(done, total)` is called before each picture.
 */
export async function readImageText(images, onProgress = () => {}) {
  const out = new Map();
  let failed = 0;
  if (!images.length) return { text: out, failed };
  const ocr = await load();
  for (let i = 0; i < images.length; i++) {
    await onProgress(i, images.length);
    try {
      const px = decode(images[i].path, images[i].data);
      if (!px) { failed++; continue; }
      const results = await ocr.recognize(prepare(px));
      const text = tidy(ocr.processRecognition(results).text);
      if (text) out.set(images[i].path, text);
    } catch (e) {
      console.warn(`OCR failed for ${images[i].path}: ${e && e.message ? e.message : e}`);
      failed++;
    }
  }
  return { text: out, failed };
}

/**
 * The document as Claude sees it: the converted text, with the words read from each picture placed right after
 * that picture's embed. Each picture's text is given once, after its first embed.
 */
export function withImageText(body, text) {
  if (!text.size) return body;
  const done = new Set();
  return body.replace(/!\[\[([^\]\n]+)\]\]/g, (embed, path) => {
    const t = text.get(path);
    if (!t || done.has(path)) return embed;
    done.add(path);
    return `${embed}\n<image_text>\n${t.replace(/<\/?image_text>/g, "")}\n</image_text>`;
  });
}
