// PowerPoint renderer from PPTX Viewer (https://github.com/MichalAFerber/pptx-viewer.us, commit ab7a826).
// The OOXML slide reader below is that project's parsePptx/renderDeck code, ported to an ES module that
// renders into a given element. Behaviour is unchanged: slides are stacked one under another, with text
// boxes and pictures placed at their EMU positions and text sized relative to the slide (container queries).
// One addition (marked "vault-share"): placeholders with no position of their own take it from the slide
// layout, then the slide master, as PowerPoint does. Without it, titles and bodies pile up in the corner.
//
// MIT License
//
// Copyright (c) 2026 Michal Ferber (TechGuyWithABeard)
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
// associated documentation files (the "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial
// portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
// LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
// EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
// IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.
import JSZip from "jszip";

const RELNS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
function localName(node) {
  return node.localName || String(node.nodeName).replace(/^.*:/, "");
}
function firstDesc(node, ln) {
  const els = node.getElementsByTagNameNS ? node.getElementsByTagNameNS("*", ln) : node.getElementsByTagName(ln);
  return els.length ? els[0] : null;
}
function parseRels(xml) {
  const map = {};
  if (!xml) return map;
  const d = new DOMParser().parseFromString(xml, "application/xml");
  const rs = d.getElementsByTagNameNS("*", "Relationship");
  for (let i = 0; i < rs.length; i++) map[rs[i].getAttribute("Id")] = rs[i].getAttribute("Target");
  return map;
}
function getXfrm(spPrOwner) {
  const xf = firstDesc(spPrOwner, "xfrm");
  if (!xf) return null;
  const off = firstDesc(xf, "off"), ext = firstDesc(xf, "ext");
  if (!off || !ext) return null;
  return { x: +off.getAttribute("x"), y: +off.getAttribute("y"), cx: +ext.getAttribute("cx"), cy: +ext.getAttribute("cy") };
}
function parseSp(node) {
  const xf = getXfrm(node);
  const phEl = firstDesc(node, "ph");
  const ph = phEl ? phEl.getAttribute("type") || "body" : "";
  const phIdx = phEl ? phEl.getAttribute("idx") || "" : "";
  const tx = firstDesc(node, "txBody");
  const paras = [];
  if (tx) {
    const ps = tx.getElementsByTagNameNS("*", "p");
    for (let i = 0; i < ps.length; i++) {
      let pPr = null;
      const kids = ps[i].childNodes, runs = [];
      for (let k = 0; k < kids.length; k++) {
        const kn = kids[k];
        if (kn.nodeType !== 1) continue;
        const kln = localName(kn);
        if (kln === "pPr") pPr = kn;
        else if (kln === "r") {
          const t = firstDesc(kn, "t");
          const txt = t ? t.textContent || "" : "";
          const rPr = firstDesc(kn, "rPr");
          const run = { t: txt, sz: 0, b: false, i: false, color: "" };
          if (rPr) {
            run.sz = +rPr.getAttribute("sz") || 0;
            run.b = rPr.getAttribute("b") === "1";
            run.i = rPr.getAttribute("i") === "1";
            const clr = firstDesc(rPr, "srgbClr");
            if (clr) run.color = clr.getAttribute("val") || "";
          }
          runs.push(run);
        } else if (kln === "br") runs.push({ t: "\n", sz: 0 });
      }
      const algn = pPr ? pPr.getAttribute("algn") : "";
      paras.push({ runs, algn: { ctr: "center", r: "right", just: "justify", l: "left" }[algn] || "" });
    }
  }
  if (!paras.length && !xf) return null;
  return { type: "text", ph, phIdx, x: xf && xf.x, y: xf && xf.y, cx: xf && xf.cx, cy: xf && xf.cy, paragraphs: paras };
}
function resolvePath(fromPath, target) {
  const base = fromPath.replace(/[^/]+$/, "");
  const parts = (base + target).split("/"), out = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("/");
}
function parsePic(node, srelMap, zip, slidePath, tasks) {
  const xf = getXfrm(node);
  const blip = firstDesc(node, "blip");
  if (!blip) return null;
  const rid = blip.getAttributeNS(RELNS, "embed") || blip.getAttribute("r:embed") || blip.getAttribute("embed");
  const target = rid && srelMap[rid];
  if (!target) return null;
  const mediaPath = resolvePath(slidePath, target);
  const shape = { type: "pic", x: xf && xf.x, y: xf && xf.y, cx: xf && xf.cx, cy: xf && xf.cy, src: "" };
  const f = zip.file(mediaPath);
  if (f) {
    const mime = /\.png$/i.test(mediaPath) ? "image/png" : /\.gif$/i.test(mediaPath) ? "image/gif"
      : /\.svg$/i.test(mediaPath) ? "image/svg+xml" : "image/jpeg";
    tasks.push(f.async("base64").then((b64) => { shape.src = "data:" + mime + ";base64," + b64; }));
  }
  return shape;
}
async function parseSlide(sxml, srelMap, zip, slidePath) {
  const d = new DOMParser().parseFromString(sxml, "application/xml");
  const trees = d.getElementsByTagNameNS("*", "spTree");
  const shapes = [], tasks = [];
  if (trees.length) {
    for (const node of trees[0].childNodes) {
      if (node.nodeType !== 1) continue;
      const ln = localName(node);
      if (ln === "sp") { const s = parseSp(node); if (s) shapes.push(s); }
      else if (ln === "pic") { const p = parsePic(node, srelMap, zip, slidePath, tasks); if (p) shapes.push(p); }
    }
  }
  await Promise.all(tasks);
  return { shapes };
}
// vault-share: placeholder positions inherited from the slide layout and master.
const TITLES = ["title", "ctrTitle"];
function phKind(t) {
  return TITLES.includes(t) ? "title" : t;
}
async function placeholderBoxes(zip, path, cache) {
  if (cache.has(path)) return cache.get(path);
  const result = (async () => {
    const f = zip.file(path);
    if (!f) return { boxes: [], parent: null };
    const d = new DOMParser().parseFromString(await f.async("string"), "application/xml");
    const boxes = [];
    for (const sp of d.getElementsByTagNameNS("*", "sp")) {
      const phEl = firstDesc(sp, "ph"), xf = getXfrm(sp);
      if (phEl && xf) boxes.push({ type: phEl.getAttribute("type") || "body", idx: phEl.getAttribute("idx") || "", xf });
    }
    const rf = zip.file(path.replace(/([^/]+)$/, "_rels/$1.rels"));
    const rels = parseRels(rf ? await rf.async("string") : "");
    const up = /slideLayout/i.test(path) ? Object.values(rels).find((t) => /slideMaster\d*\.xml$/i.test(t)) : null;
    return { boxes, parent: up ? resolvePath(path, up) : null };
  })();
  cache.set(path, result);
  return result;
}
function matchBox(boxes, sh) {
  return (sh.phIdx && boxes.find((b) => b.idx === sh.phIdx)) || boxes.find((b) => phKind(b.type) === phKind(sh.ph)) || null;
}
async function inheritPositions(zip, shapes, layoutPath, cache) {
  for (const sh of shapes) {
    if (sh.type !== "text" || !sh.ph || sh.cx) continue;
    for (let path = layoutPath, depth = 0; path && depth < 2; depth++) {
      const { boxes, parent } = await placeholderBoxes(zip, path, cache);
      const b = matchBox(boxes, sh);
      if (b) { Object.assign(sh, { x: b.xf.x, y: b.xf.y, cx: b.xf.cx, cy: b.xf.cy }); break; }
      path = parent;
    }
  }
}

async function parsePptx(zip) {
  const presFile = zip.file("ppt/presentation.xml");
  if (!presFile) throw new Error("not a PowerPoint file (no presentation.xml)");
  const pd = new DOMParser().parseFromString(await presFile.async("string"), "application/xml");
  const sz = firstDesc(pd, "sldSz");
  const W = sz ? +sz.getAttribute("cx") : 9144000, H = sz ? +sz.getAttribute("cy") : 6858000;
  const rids = [...pd.getElementsByTagNameNS("*", "sldId")].map((e) => e.getAttributeNS(RELNS, "id") || e.getAttribute("r:id"));
  const relsFile = zip.file("ppt/_rels/presentation.xml.rels");
  const relMap = parseRels(relsFile ? await relsFile.async("string") : "");
  const slides = [], phCache = new Map();
  for (const rid of rids) {
    const target = relMap[rid];
    if (!target) continue;
    const path = resolvePath("ppt/presentation.xml", target);
    const f = zip.file(path);
    if (!f) continue;
    const sxml = await f.async("string");
    const rf = zip.file(path.replace(/([^/]+)$/, "_rels/$1.rels"));
    const srels = rf ? await rf.async("string") : "";
    const srelMap = parseRels(srels);
    const slide = await parseSlide(sxml, srelMap, zip, path);
    const layout = Object.values(srelMap).find((t) => /slideLayout\d*\.xml$/i.test(t));
    if (layout) await inheritPositions(zip, slide.shapes, resolvePath(path, layout), phCache);
    slides.push(slide);
  }
  return { w: W, h: H, slides };
}

function pct(v, whole) {
  return (v / whole) * 100 + "%";
}
function renderSlide(slide, W, H, num) {
  const wrap = el("div", "slide-wrap");
  wrap.id = "slide-" + num;
  const lbl = el("div", "slide-num");
  lbl.textContent = "Slide " + num;
  wrap.appendChild(lbl);
  const sl = el("div", "slide");
  sl.style.aspectRatio = W + " / " + H;
  for (const sh of slide.shapes) {
    const box = el("div", sh.type === "pic" ? "s-pic" : "s-txt");
    if (sh.x != null && sh.cx) {
      box.style.left = pct(sh.x, W); box.style.top = pct(sh.y, H);
      box.style.width = pct(sh.cx, W); box.style.height = pct(sh.cy, H);
    }
    if (sh.type === "pic") {
      if (sh.src) { const img = document.createElement("img"); img.src = sh.src; img.alt = ""; box.appendChild(img); }
    } else {
      for (const para of sh.paragraphs) {
        const pel = el("p", "s-p");
        if (para.algn) pel.style.textAlign = para.algn;
        if (!para.runs.length) pel.textContent = "​";
        for (const run of para.runs) {
          if (run.t === "\n") { pel.appendChild(document.createElement("br")); continue; }
          const span = document.createElement("span");
          span.textContent = run.t;
          const sz = run.sz || (sh.ph === "title" || sh.ph === "ctrTitle" ? 3200 : 1800);
          span.style.fontSize = (sz * 12700) / W + "cqw";
          if (run.b) span.style.fontWeight = "700";
          if (run.i) span.style.fontStyle = "italic";
          if (run.color) span.style.color = "#" + run.color;
          pel.appendChild(span);
        }
        box.appendChild(pel);
      }
    }
    sl.appendChild(box);
  }
  wrap.appendChild(sl);
  return wrap;
}

/** Render a .pptx (as bytes) into `host`, one slide under another. Returns the number of slides. */
export async function renderPptx(buf, host) {
  const deck = await parsePptx(await JSZip.loadAsync(buf));
  host.classList.add("pptx-deck");
  if (!deck.slides.length) {
    const m = el("div", "office-status");
    m.textContent = "No slides found in this presentation.";
    host.appendChild(m);
    return 0;
  }
  deck.slides.forEach((s, i) => host.appendChild(renderSlide(s, deck.w, deck.h, i + 1)));
  return deck.slides.length;
}
