// Reading the pictures in a source with Claude, instead of OCR (Admin → Microsidian → Pictures).
//  - With a picture model (such as Haiku), each picture gets its own small call, several at a time, and its text
//    and a description are written into what the filing model reads, after the picture's embed.
//  - Without one, the filing model is shown the pictures themselves, each right after its embed.
// Pictures are scaled down (longest side 1568 px, which is what Claude works at anyway) and sent as JPEG, so a
// large photo costs no more than it needs to.
import jpeg from "jpeg-js";
import { readImage } from "../../../microsidian/src/ai/images";
import { decode } from "./ocr.js";

const MAX_SIDE = 1568;
/** Anthropic takes pictures up to 5 MB each (as base64). */
const MAX_BASE64 = 5 * 1024 * 1024;
/** Pictures shown to the filing model in one request: the API takes at most 100, and requests at most 32 MB. */
export const DIRECT_MAX_IMAGES = 100;
export const DIRECT_MAX_BYTES = 24 * 1024 * 1024;

const b64 = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString("base64");

/** Scale down to MAX_SIDE (averaging), with transparent areas made white. RGBA out. */
function shrink({ width, height, rgba }) {
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
  const out = new Uint8Array(w * h * 4);
  const sx = width / w, sy = height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < height; yy++) {
        for (let xx = x0; xx < x1 && xx < width; xx++) {
          const i = (yy * width + xx) * 4;
          const a = rgba[i + 3] / 255;
          r += rgba[i] * a + 255 * (1 - a);
          g += rgba[i + 1] * a + 255 * (1 - a);
          b += rgba[i + 2] * a + 255 * (1 - a);
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/**
 * A picture as Claude takes it: { mediaType, data (base64) }, or null when it cannot be sent (a format that cannot
 * be decoded here, such as BMP or SVG, or a WebP too large to send as it is).
 */
export function toImageBlock(path, data) {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "webp") {
    const s = b64(data);
    return s.length <= MAX_BASE64 ? { mediaType: "image/webp", data: s } : null;
  }
  const px = decode(path, data);
  if (!px) return null;
  const img = shrink(px);
  const out = jpeg.encode(img, 85);
  const s = b64(out.data);
  return s.length <= MAX_BASE64 ? { mediaType: "image/jpeg", data: s } : null;
}

/** Run `fn` over `items`, at most `limit` at a time. Results in the same order. */
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Read every picture with the picture model, `parallel` at a time. Returns { text: Map path -> {text, description},
 * failed, usage }. `onProgress(done, total)` is called as each picture finishes; `check()` throws to stop.
 */
export async function readPicturesWithClaude(images, { fetch, effort, system, parallel, context, onProgress, check }) {
  const text = new Map();
  let failed = 0, done = 0;
  const usage = { input: 0, output: 0 };
  let firstError = "";
  await pool(images, parallel, async (img) => {
    check();
    try {
      const block = toImageBlock(img.path, img.data);
      if (!block) { failed++; return; }
      const r = await readImage({ apiKey: "held-by-the-server", fetch, effort, image: block, system, context });
      usage.input += r.usage.input + r.usage.cacheRead;
      usage.output += r.usage.output;
      if (r.reading.text || r.reading.description) text.set(img.path, r.reading);
    } catch (e) {
      if (e && e.name === "Cancelled") throw e;
      console.warn(`Claude could not read ${img.path}: ${e && e.message ? e.message : e}`);
      if (!firstError) firstError = e && e.message ? e.message : String(e);
      failed++;
    } finally {
      done++;
      await onProgress(done, images.length);
    }
  });
  // Every picture failed the same way (no key, rate limit): say why instead of carrying on without them.
  if (images.length && failed === images.length && firstError) throw new Error(firstError);
  return { text, failed, usage };
}

/**
 * The pictures to show the filing model itself: as many as fit in one request, in the order the document
 * embeds them. Returns { blocks: Map path -> block, left: pictures that did not fit or could not be sent }.
 */
export function directBlocks(images) {
  const blocks = new Map();
  let bytes = 0, left = 0;
  for (const img of images) {
    if (blocks.size >= DIRECT_MAX_IMAGES) { left++; continue; }
    const b = toImageBlock(img.path, img.data);
    if (!b || bytes + b.data.length > DIRECT_MAX_BYTES) { left++; continue; }
    bytes += b.data.length;
    blocks.set(img.path, b);
  }
  return { blocks, left };
}

/**
 * The document as the filing model reads it: the converted text, with what was read from each picture placed right
 * after that picture's first embed: <image_text> (OCR, or the text Claude copied out) and <image_description>.
 */
export function withPictureReadings(body, readings) {
  if (!readings.size) return body;
  const done = new Set();
  const strip = (s) => s.replace(/<\/?image_(text|description)>/g, "");
  return body.replace(/!\[\[([^\]\n]+)\]\]/g, (embed, path) => {
    const r = readings.get(path);
    if (!r || done.has(path)) return embed;
    done.add(path);
    let out = embed;
    if (r.text) out += `\n<image_text>\n${strip(r.text)}\n</image_text>`;
    if (r.description) out += `\n<image_description>\n${strip(r.description)}\n</image_description>`;
    return out;
  });
}
