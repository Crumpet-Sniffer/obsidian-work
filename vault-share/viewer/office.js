// Renders a .docx or .pptx original in the browser. Word uses docx-preview (as in the Microsidian plugin);
// PowerPoint uses the PPTX Viewer renderer (pptx-viewer.js).
import { renderAsync } from "docx-preview";
import { renderPptx } from "./pptx-viewer.js";

const host = document.querySelector("[data-office]");

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

  const count = await renderPptx(buf, host);
  // Links like [[deck.pptx#slide-3]] open at that slide.
  const m = location.hash.match(/slide[-_ ]?(\d+)/i);
  if (m && count) {
    const n = Math.min(Math.max(Number(m[1]), 1), count);
    document.getElementById("slide-" + n)?.scrollIntoView({ block: "start" });
  }
}

main().catch((err) => {
  console.error(err);
  host.textContent = "";
  el("office-status error", host, "Could not display this file in the browser (" + (err && err.message ? err.message : err) + "). Use the download link instead.");
});
