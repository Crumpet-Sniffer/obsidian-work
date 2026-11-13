import { renderAsync } from "docx-preview";
import { init as initPptx } from "pptx-preview";
import JSZip from "jszip";

type Row = { file: string; kind: string; ok: boolean; ms: number; detail: string };
const out: Row[] = [];
(window as any).__results = out;
(window as any).__done = false;

async function aspect(buf: ArrayBuffer) {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file("ppt/presentation.xml")?.async("string");
  const m = xml?.match(/<p:sldSz[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/);
  return m ? Number(m[1]) / Number(m[2]) : 16 / 9;
}
const withTimeout = <T,>(p: Promise<T>, ms: number) => Promise.race([p, new Promise<T>((_, r) => setTimeout(() => r(new Error("timeout " + ms + "ms")), ms))]);

async function run() {
  const list: string[] = await (await fetch("/list")).json();
  const status = document.getElementById("status")!;
  for (const [i, file] of list.entries()) {
    status.textContent = `${i + 1}/${list.length} ${file}`;
    const t0 = performance.now();
    const kind = file.toLowerCase().endsWith("docx") ? "docx" : "pptx";
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:-9999px;top:0";
    document.body.appendChild(host);
    try {
      const buf = await (await fetch("/orig/" + encodeURI(file))).arrayBuffer();
      if (kind === "docx") {
        const styles = document.createElement("div"); const page = document.createElement("div");
        host.append(styles, page);
        await withTimeout(renderAsync(buf, page, styles, { breakPages: true, experimental: true }), 30000);
        const pages = page.querySelectorAll("section.docx").length;
        const txt = (page.textContent || "").replace(/\s+/g, " ").trim();
        out.push({ file, kind, ok: pages > 0 && txt.length > 20, ms: Math.round(performance.now() - t0), detail: `${pages} pages, ${txt.length} chars` });
      } else {
        const a = await aspect(buf), w = 960, h = Math.round(w / a);
        const stage = document.createElement("div"); stage.style.cssText = `position:relative;width:${w}px;height:${h}px`;
        host.append(stage);
        const p: any = initPptx(stage, { width: w, height: h, mode: "slide" });
        await withTimeout(p.preview(buf), 30000);
        const n = p.slideCount; let bad = 0, empty = 0; const errs: string[] = [];
        for (let s = 0; s < n; s++) {
          try { p.renderSingleSlide(s); p.updatePagination(); const el = stage.querySelector(`.pptx-preview-slide-wrapper-${s}`); if (!el) bad++; else if (!(el.textContent || "").trim() && !el.querySelector("img,svg,canvas,table")) empty++; }
          catch (e: any) { bad++; if (errs.length < 2) errs.push(String(e?.message || e).slice(0, 80)); }
        }
        out.push({ file, kind, ok: n > 0 && bad === 0, ms: Math.round(performance.now() - t0), detail: `${n} slides, ${bad} failed, ${empty} blank${errs.length ? " | " + errs.join("; ") : ""}` });
      }
    } catch (e: any) {
      out.push({ file, kind, ok: false, ms: Math.round(performance.now() - t0), detail: String(e?.message || e).slice(0, 160) });
    }
    host.remove();
  }
  (window as any).__done = true;
  status.textContent = "done";
  const bad = out.filter(r => !r.ok);
  document.getElementById("summary")!.textContent = `${out.length - bad.length}/${out.length} rendered OK; ${bad.length} failed`;
}
async function show(file: string, slide: number) {
  const buf = await (await fetch("/orig/" + encodeURI(file))).arrayBuffer();
  const root = document.getElementById("status")!; root.textContent = file;
  if (file.toLowerCase().endsWith("docx")) {
    const styles = document.createElement("div"), page = document.createElement("div");
    document.body.append(styles, page);
    await renderAsync(buf, page, styles, { breakPages: true, experimental: true });
  } else {
    const a = await aspect(buf), w = 960, h = Math.round(w / a);
    const stage = document.createElement("div"); stage.style.cssText = `position:relative;width:${w}px;height:${h}px;border:1px solid #888`;
    document.body.append(stage);
    const p: any = initPptx(stage, { width: w, height: h, mode: "slide" });
    await p.preview(buf);
    if (slide > 0) { p.renderSingleSlide(slide - 1); p.updatePagination(); }
  }
  (window as any).__shown = true;
}
const q = new URLSearchParams(location.search);
if (q.get("file")) show(q.get("file")!, Number(q.get("slide") || 0)); else run();
