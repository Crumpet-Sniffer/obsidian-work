// PDF sources: the text of each page and the pictures on it, in the same shape as Microsidian's Word and PowerPoint
// converter (convertOffice), so the rest of filing is the same for every kind of source. pdf.js (Mozilla, Apache-2.0)
// reads the file; nothing is rendered, so no canvas is needed.
//  - Text: each page's text layer, as paragraphs, under a "Page N" heading.
//  - Pictures: the images drawn on each page, decoded by pdf.js, saved as PNG and embedded after that page's text.
//    They are read like any other source's pictures (OCR or Claude), which is also how a scanned PDF, whose pages
//    are pictures with no text layer, gets its text.
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { escapeLineStart, escapeMd } from "../../../microsidian/src/convert/text";
import "./pdf-env.js";
// pdf.js runs its worker on this thread when the worker's handler is on globalThis (there are no worker threads
// to start inside the bundle).
import * as pdfjsWorker from "pdfjs-dist/legacy/build/pdf.worker.mjs";
import { getDocument, OPS, ImageKind } from "pdfjs-dist/legacy/build/pdf.mjs";

globalThis.pdfjsWorker = pdfjsWorker;

/** Pictures smaller than this on either side are bullets, rules and logos, not content. */
const MIN_SIDE = 48;
/** Most pictures kept from one PDF (a scanned book has one per page). */
const MAX_PICTURES = 400;

const md5 = (data) => createHash("md5").update(data).digest("hex");

/** A pdf.js image object as RGBA, or null. */
function toRgba(img) {
  if (!img || !img.width || !img.height || !img.data) return null;
  const { width, height, data, kind } = img;
  const n = width * height;
  const out = new Uint8Array(n * 4);
  if (kind === ImageKind.RGBA_32BPP) {
    out.set(data.subarray(0, n * 4));
  } else if (kind === ImageKind.RGB_24BPP) {
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      out[i * 4] = data[j]; out[i * 4 + 1] = data[j + 1]; out[i * 4 + 2] = data[j + 2]; out[i * 4 + 3] = 255;
    }
  } else if (kind === ImageKind.GRAYSCALE_1BPP) {
    const rowBytes = (width + 7) >> 3;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const bit = (data[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
        const v = bit ? 255 : 0;
        const o = (y * width + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = v; out[o + 3] = 255;
      }
    }
  } else {
    return null;
  }
  return { width, height, rgba: out };
}

/** Get a page's image object (it may arrive a moment after the operator list). */
function getObj(page, id) {
  const store = id.startsWith("g_") ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      store.get(id, finish);
    } catch {
      finish(null);
    }
    setTimeout(() => finish(null), 5_000);
  });
}

/** The text of a page as paragraphs: lines joined, a blank line where the text jumps down by more than a line. */
function pageText(content) {
  const lines = [];
  let line = "", lastY = null, lastH = 0, gap = false;
  const flush = () => {
    const t = line.replace(/\s+/g, " ").trim();
    if (t) lines.push({ t, gap });
    line = ""; gap = false;
  };
  for (const item of content.items) {
    if (typeof item.str !== "string") continue;
    const y = item.transform ? item.transform[5] : null;
    const h = item.height || lastH || 10;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > h * 0.5) {
      const jump = lastY - y > h * 1.8;
      flush();
      gap = jump;
    }
    line += item.str;
    if (item.hasEOL) { flush(); }
    else if (item.str && !item.str.endsWith(" ")) line += " ";
    if (y !== null) lastY = y;
    lastH = h;
  }
  flush();
  const paras = [];
  for (const l of lines) {
    if (!paras.length || l.gap) paras.push(l.t);
    else {
      const prev = paras[paras.length - 1];
      // A line that ends a sentence, or a short line (a heading or list item), ends its paragraph.
      if (/[.:!?]$/.test(prev) || prev.length < 40) paras.push(l.t);
      else paras[paras.length - 1] = prev.replace(/-$/, "") + (prev.endsWith("-") ? "" : " ") + l.t;
    }
  }
  return paras.map((p) => escapeLineStart(escapeMd(p))).join("\n\n");
}

/**
 * Convert a PDF (bytes) to { body, images, imageHashes, slideCount (pages), words }, like convertOffice.
 * `opts` is Microsidian's ConvertOptions: imageMinBytes, isLogo, attachmentsDir.
 */
export async function convertPdf(bytes, opts) {
  const task = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  const doc = await task.promise;
  const parts = [];
  const images = new Map();
  const hashes = new Set();
  let words = 0;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const text = pageText(await page.getTextContent());
      words += text.split(/\s+/).filter(Boolean).length;
      const embeds = [];
      if (images.size < MAX_PICTURES) {
        let ops = null;
        try { ops = await page.getOperatorList(); } catch { ops = null; }
        const seen = new Set();
        for (let i = 0; ops && i < ops.fnArray.length && images.size < MAX_PICTURES; i++) {
          if (ops.fnArray[i] !== OPS.paintImageXObject && ops.fnArray[i] !== OPS.paintImageXObjectRepeat) continue;
          const id = ops.argsArray[i][0];
          if (typeof id !== "string" || seen.has(id)) continue;
          seen.add(id);
          const px = toRgba(await getObj(page, id));
          if (!px || px.width < MIN_SIDE || px.height < MIN_SIDE) continue;
          const png = new Uint8Array(PNG.sync.write({ width: px.width, height: px.height, data: Buffer.from(px.rgba.buffer, 0, px.rgba.byteLength) }, { colorType: 6 }));
          const h = md5(png);
          hashes.add(h);
          if (png.byteLength < opts.imageMinBytes || opts.isLogo(h)) continue;
          const path = `${opts.attachmentsDir}/${h.slice(0, 12)}.png`;
          if (!images.has(path)) images.set(path, { path, hash: h, data: png });
          embeds.push(`![[${path}]]`);
        }
      }
      page.cleanup();
      if (!text && !embeds.length) continue;
      parts.push([`## Page ${p}`, text, ...embeds].filter(Boolean).join("\n\n"));
    }
    return { body: parts.join("\n\n"), images: [...images.values()], imageHashes: [...hashes], slideCount: doc.numPages, words };
  } finally {
    await task.destroy();
  }
}
