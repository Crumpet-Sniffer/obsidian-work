// Renders a .docx or .pptx original in the browser (same libraries and options as the Microsidian plugin).
import { renderAsync } from "docx-preview";
import { init as initPptx } from "pptx-preview";
import JSZip from "jszip";

const host = document.querySelector("[data-office]");

async function slideAspect(buf) {
  try {
    const zip = await JSZip.loadAsync(buf);
    const xml = await zip.file("ppt/presentation.xml")?.async("string");
    const m = xml?.match(/<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
    if (m) return Number(m[1]) / Number(m[2]);
  } catch {
    /* use default */
  }
  return 16 / 9;
}

function el(cls, parent, text) {
  const d = document.createElement("div");
  d.className = cls;
  if (text) d.textContent = text;
  parent.appendChild(d);
  return d;
}

async function main() {
  const kind = host.dataset.kind;
  host.textContent = "";
  const status = el("office-status", host, "Loading…");
  const res = await fetch(host.dataset.src, { credentials: "same-origin" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const buf = await res.arrayBuffer();
  status.remove();

  if (kind === "docx") {
    const styles = el("docx-styles", host);
    const page = el("docx-page", host);
    await renderAsync(buf, page, styles, {
      className: "docx", inWrapper: true, ignoreWidth: false, ignoreHeight: false, breakPages: true,
      renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true,
      renderComments: false, experimental: true,
    });
    return;
  }

  const aspect = await slideAspect(buf);
  const width = Math.min(Math.max(320, (host.clientWidth || 900) - 64), 1100);
  const height = Math.round(width / aspect);
  const stage = el("pptx-stage", host);
  stage.style.width = width + "px";
  stage.style.height = height + "px";
  const pptx = initPptx(stage, { width, height, mode: "slide" });
  await pptx.preview(buf);
  const m = location.hash.match(/slide[-_ ]?(\d+)/i);
  if (m && pptx.slideCount) {
    const idx = Math.min(Math.max(Number(m[1]), 1), pptx.slideCount) - 1;
    pptx.renderSingleSlide(idx);
    pptx.updatePagination();
  }
}

main().catch((err) => {
  console.error(err);
  host.textContent = "";
  el("office-status error", host, "Could not display this file in the browser (" + (err && err.message ? err.message : err) + "). Use the download link instead.");
});
