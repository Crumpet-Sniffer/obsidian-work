// Renders math ($...$, $$...$$) with KaTeX (MathML output, so no fonts or inline styles are needed) and
// loads Mermaid on demand for ```mermaid blocks. Mermaid is rendered to an SVG that is shown as an image,
// which keeps the page's strict Content-Security-Policy intact.
import katex from "katex";

function renderMath(root) {
  root.querySelectorAll(".math[data-tex]").forEach((el) => {
    if (el.dataset.done) return;
    el.dataset.done = "1";
    try {
      el.innerHTML = katex.renderToString(el.dataset.tex, {
        displayMode: el.classList.contains("math-display"),
        output: "mathml",
        throwOnError: false,
        trust: false,
        strict: "ignore",
      });
    } catch {
      /* leave the plain $tex$ text */
    }
  });
}

let mermaidReady = null;
function loadMermaid() {
  if (mermaidReady) return mermaidReady;
  mermaidReady = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    const base = document.querySelector('script[src*="/static/render.js"]');
    const v = base ? new URL(base.src).search : "";
    s.src = "/static/mermaid.js" + v;
    s.onload = () => resolve(window.__mermaid);
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return mermaidReady;
}

async function renderMermaid(root) {
  const blocks = [...root.querySelectorAll("pre > code.language-mermaid")].filter((c) => !c.dataset.done);
  if (!blocks.length) return;
  let mermaid;
  try {
    mermaid = await loadMermaid();
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "dark", fontFamily: "sans-serif" });
  } catch {
    return;
  }
  let n = 0;
  for (const code of blocks) {
    code.dataset.done = "1";
    try {
      const { svg } = await mermaid.render("mmd" + Date.now() + "_" + n++, code.textContent);
      const img = document.createElement("img");
      img.className = "mermaid-diagram";
      img.alt = "Diagram";
      img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
      code.closest("pre").replaceWith(img);
    } catch (e) {
      code.closest("pre").classList.add("mermaid-error");
    }
    document.querySelectorAll("[id^='dmmd'],[id^='mmd']").forEach((x) => { if (x.tagName !== "IMG") x.remove(); });
  }
}

// Inline #tags in note text become links that search for the tag (like Obsidian's tag pills).
function linkTags(root) {
  const vault = (document.getElementById("sidebar") || {}).dataset?.vault;
  if (!vault) return;
  const scope = root.querySelectorAll ? root.querySelectorAll(".note .prose") : [];
  scope.forEach((prose) => {
    const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement.closest("a, code, pre, .math, .callout-title, h1, h2, h3, h4, h5, h6, .tag") || !/(^|\s)#[\p{L}][\p{L}\p{N}_\/-]*/u.test(n.nodeValue)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const frag = document.createDocumentFragment();
      const re = /(^|\s)#([\p{L}][\p{L}\p{N}_\/-]*)/gu;
      let last = 0, m;
      const text = n.nodeValue;
      while ((m = re.exec(text))) {
        frag.appendChild(document.createTextNode(text.slice(last, m.index) + m[1]));
        const a = document.createElement("a");
        a.className = "tag";
        a.href = `/v/${vault}/search?q=${encodeURIComponent("tag:#" + m[2])}`;
        a.textContent = "#" + m[2];
        frag.appendChild(a);
        last = m.index + m[0].length;
      }
      frag.appendChild(document.createTextNode(text.slice(last)));
      n.parentNode.replaceChild(frag, n);
    }
  });
}

function run(root) {
  linkTags(root);
  renderMath(root);
  renderMermaid(root);
}

run(document);
window.VSRender = { run };
