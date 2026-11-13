// Graph view: force-directed layout of notes and the links between them, drawn on a canvas.
// No dependencies (the page CSP only allows scripts from this server).
(() => {
  "use strict";
  const wrap = document.querySelector("[data-graph]");
  if (!wrap) return;

  const canvas = wrap.querySelector("canvas");
  const ctx = canvas.getContext("2d");
  const statusEl = wrap.querySelector("[data-graph-status]");
  const searchEl = wrap.querySelector("[data-graph-search]");
  const filesEl = wrap.querySelector("[data-graph-files]");
  const orphansEl = wrap.querySelector("[data-graph-orphans]");
  const resetEl = wrap.querySelector("[data-graph-reset]");
  const focusPath = wrap.dataset.focus || "";

  // ---------- state ----------
  let data = null;               // { nodes: [{label, path, url, kind}], links: [[a, b]] }
  let nodes = [];                // simulated nodes
  let links = [];                // [nodeA, nodeB]
  let view = { x: 0, y: 0, k: 1 }; // screen = world * k + (x, y), in CSS pixels
  let alpha = 0, alphaTarget = 0;
  let hover = null, drag = null, pan = null;
  let query = "";
  let running = false;
  let colors = {};
  let width = 0, height = 0;
  const dpr = () => window.devicePixelRatio || 1;

  // Preferences live in this browser only (localStorage may be unavailable, so every access is guarded).
  function readPref(key, fallback) {
    try {
      const v = localStorage.getItem("vault-share:graph:" + key);
      return v ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  }
  function savePref(key, value) {
    try { localStorage.setItem("vault-share:graph:" + key, JSON.stringify(value)); } catch { /* ignore */ }
  }

  // ---------- theme ----------
  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    colors = {
      bg: v("--bg"), ink: v("--ink"), muted: v("--graph-node") || v("--muted"), line: v("--graph-link") || v("--line"),
      accent: v("--accent"), file: v("--ok"), surface: v("--surface"),
    };
  }
  readColors();
  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { readColors(); draw(); });
  }

  // ---------- sizing ----------
  function resize() {
    const r = wrap.getBoundingClientRect();
    width = Math.max(1, r.width);
    height = Math.max(1, r.height);
    canvas.width = Math.round(width * dpr());
    canvas.height = Math.round(height * dpr());
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    draw();
  }
  resize();
  new ResizeObserver(resize).observe(wrap);

  // ---------- data ----------
  fetch(wrap.dataset.src, { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then((d) => { data = d; rebuild(true); })
    .catch(() => { statusEl.textContent = "Could not load the graph. Try reloading the page."; });

  function rebuild(initial) {
    const old = new Map(nodes.map((n) => [n.path, n]));
    const withFiles = filesEl.checked;
    const withOrphans = orphansEl.checked;
    const included = data.nodes.map((n) => n.kind === "note" || withFiles);
    const deg = new Array(data.nodes.length).fill(0);
    const kept = [];
    // Links arrive as directed [from, to] pairs; A->B and B->A are drawn as one line (arrows show direction).
    const pairs = new Map();
    for (const [f, t] of data.links) {
      if (!(included[f] && included[t])) continue;
      const lo = Math.min(f, t), hi = Math.max(f, t), key = lo + "|" + hi;
      let e = pairs.get(key);
      if (!e) { e = { lo, hi, dir: 0 }; pairs.set(key, e); }
      e.dir |= f === lo ? 1 : 2;
    }
    for (const e of pairs.values()) { deg[e.lo]++; deg[e.hi]++; kept.push([e.lo, e.hi, e.dir]); }
    const map = new Map();
    nodes = [];
    data.nodes.forEach((n, i) => {
      if (!included[i]) return;
      if (!withOrphans && deg[i] === 0 && n.path !== focusPath) return;
      const prev = old.get(n.path);
      // Phyllotaxis spiral start: deterministic and evenly spread.
      const j = nodes.length;
      const rad = 12 * Math.sqrt(j + 0.5), ang = j * 2.39996323;
      map.set(i, nodes.length);
      nodes.push({
        ...n,
        deg: deg[i],
        r: 4.5 + Math.sqrt(deg[i]) * 2.2,
        x: prev ? prev.x : rad * Math.cos(ang),
        y: prev ? prev.y : rad * Math.sin(ang),
        vx: 0, vy: 0, fx: null, fy: null,
        nbrs: new Set(),
        match: false,
        la: 0, da: 1, gc: null, // animated label alpha, animated dimming alpha, group colour
      });
    });
    links = [];
    for (const [a, b, dir] of kept) {
      const ia = map.get(a), ib = map.get(b);
      if (ia === undefined || ib === undefined) continue;
      const A = nodes[ia], B = nodes[ib];
      links.push([A, B, 0, dir]); // [from, to, animated "highlighted" amount, direction bits]
      A.nbrs.add(B); B.nbrs.add(A);
    }
    applySearch();
    applyGroups();
    const noteCount = nodes.filter((n) => n.kind === "note").length;
    const fileCount = nodes.length - noteCount;
    statusEl.textContent =
      `${noteCount} note${noteCount === 1 ? "" : "s"}` +
      (fileCount ? ` · ${fileCount} attachment${fileCount === 1 ? "" : "s"}` : "") +
      ` · ${links.length} link${links.length === 1 ? "" : "s"}`;

    if (initial) {
      alpha = 1;
      // Pre-settle off-screen so the first frame already looks like a graph.
      const warm = Math.min(200, Math.max(40, Math.floor(60000 / Math.max(1, nodes.length))));
      for (let i = 0; i < warm; i++) tick();
      const f = nodes.find((n) => n.path === focusPath);
      if (f) centerOn(f, 1.6); else fit();
    } else {
      alpha = Math.max(alpha, 0.6);
    }
    start();
  }

  // ---------- simulation ----------
  const DECAY = 0.4, THETA2 = 0.81, MAX_D2 = 900 * 900;
  // Adjustable in the Forces panel. Defaults reproduce the original layout.
  const FORCE_DEFAULTS = { center: 0.3, repel: 10, link: 1, dist: 55 };
  const forces = Object.assign({}, FORCE_DEFAULTS);
  const savedForces = readPref("forces", {});
  for (const k of Object.keys(FORCE_DEFAULTS)) if (Number.isFinite(savedForces[k])) forces[k] = savedForces[k];

  // Display options (Display panel): when labels appear, node size and link thickness.
  const DISPLAY_DEFAULTS = { fade: 0.45, nodeSize: 1, linkWidth: 1, arrows: 0 };
  const display = Object.assign({}, DISPLAY_DEFAULTS);
  const savedDisplay = readPref("display", {});
  for (const k of Object.keys(DISPLAY_DEFAULTS)) if (Number.isFinite(savedDisplay[k])) display[k] = savedDisplay[k];
  // Zoom level at which labels start to fade in: lower threshold slider = labels only when zoomed in far.
  const labelZoomStart = () => 2.2 - 2.0 * display.fade;

  function buildTree() {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      if (n.x < x0) x0 = n.x; if (n.y < y0) y0 = n.y;
      if (n.x > x1) x1 = n.x; if (n.y > y1) y1 = n.y;
    }
    const size = Math.max(x1 - x0, y1 - y0, 1) + 1;
    const root = { x0, y0, size, m: 0, cx: 0, cy: 0, kids: null, body: null };
    for (const n of nodes) insert(root, n, 0);
    return root;
  }

  function insert(q, n, depth) {
    q.cx = (q.cx * q.m + n.x) / (q.m + 1);
    q.cy = (q.cy * q.m + n.y) / (q.m + 1);
    q.m += 1;
    if (!q.kids) {
      if (!q.body) { q.body = n; return; }
      if (depth > 40) return; // coincident points: just aggregate
      const old = q.body; q.body = null;
      q.kids = [null, null, null, null];
      place(q, old, depth);
    }
    place(q, n, depth);
  }

  function place(q, n, depth) {
    const h = q.size / 2;
    const i = (n.x >= q.x0 + h ? 1 : 0) + (n.y >= q.y0 + h ? 2 : 0);
    if (!q.kids[i]) {
      q.kids[i] = { x0: q.x0 + (i & 1 ? h : 0), y0: q.y0 + (i & 2 ? h : 0), size: h, m: 0, cx: 0, cy: 0, kids: null, body: null };
    }
    insert(q.kids[i], n, depth + 1);
  }

  function repel(q, n) {
    if (!q || q.m === 0) return;
    let dx = q.cx - n.x, dy = q.cy - n.y;
    let d2 = dx * dx + dy * dy;
    if (q.body === n && !q.kids) return;
    if (!q.kids || (q.size * q.size) / Math.max(d2, 1e-9) < THETA2) {
      if (d2 > MAX_D2) return;
      if (d2 < 1) { dx = (Math.random() - 0.5) || 0.1; dy = (Math.random() - 0.5) || 0.1; d2 = dx * dx + dy * dy + 1; }
      const m = q.body === n ? q.m - 1 : q.m;
      const w = (-forces.repel * 16 * alpha * m) / d2;
      n.vx += dx * w; n.vy += dy * w;
      return;
    }
    for (const k of q.kids) repel(k, n);
  }

  function tick() {
    alpha += (alphaTarget - alpha) * 0.02;
    if (nodes.length === 0) return;
    // Links (springs), d3-style with degree-based bias.
    for (const [s, t] of links) {
      let dx = t.x + t.vx - s.x - s.vx, dy = t.y + t.vy - s.y - s.vy;
      let l = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const strength = 1 / Math.min(s.deg || 1, t.deg || 1);
      l = ((l - forces.dist) / l) * alpha * strength * 0.7 * forces.link;
      dx *= l; dy *= l;
      const bias = (s.deg || 1) / ((s.deg || 1) + (t.deg || 1));
      t.vx -= dx * bias; t.vy -= dy * bias;
      s.vx += dx * (1 - bias); s.vy += dy * (1 - bias);
    }
    // Repulsion (Barnes–Hut).
    const tree = buildTree();
    for (const n of nodes) repel(tree, n);
    // Gravity toward the origin keeps unlinked notes nearby.
    for (const n of nodes) {
      n.vx -= n.x * forces.center * 0.12 * alpha;
      n.vy -= n.y * forces.center * 0.12 * alpha;
    }
    for (const n of nodes) {
      if (n.fx !== null) { n.x = n.fx; n.y = n.fy; n.vx = 0; n.vy = 0; continue; }
      n.vx *= 1 - DECAY; n.vy *= 1 - DECAY;
      n.x += n.vx; n.y += n.vy;
    }
  }

  function start() {
    if (running) return;
    running = true;
    requestAnimationFrame(frame);
  }

  function frame() {
    const simulating = alpha > 0.003 || alphaTarget > 0;
    if (simulating) tick();
    const fading = stepFades();
    draw();
    if (simulating || fading) requestAnimationFrame(frame);
    else running = false;
  }

  // ---------- fades ----------
  // Labels, dimming and highlighted links ease toward their targets instead of switching instantly,
  // so labels fade in when you hover a node and fade out when you leave it.
  const EASE = 0.2;

  function currentFocus() {
    return hover || nodes.find((n) => n.path === focusPath) || null;
  }

  function approach(cur, target) {
    const next = cur + (target - cur) * EASE;
    return Math.abs(target - next) < 0.01 ? target : next;
  }

  function stepFades() {
    const focus = currentFocus();
    const searching = query.length > 0;
    const zoomFade = Math.min(1, Math.max(0, (view.k - labelZoomStart()) / 0.5));
    let moving = false;
    for (const n of nodes) {
      const lit = !focus || n === focus || focus.nbrs.has(n);
      const dim = (focus && !lit) || (searching && !n.match);
      const important = n === focus || n.match || (focus && focus.nbrs.has(n));
      const daT = dim ? 0.2 : 1;
      const laT = (important ? 1 : zoomFade) * (dim ? 0.25 : 1);
      const da = approach(n.da, daT), la = approach(n.la, laT);
      if (da !== daT || la !== laT) moving = true;
      n.da = da; n.la = la;
    }
    for (const l of links) {
      const hotT = focus && (l[0] === focus || l[1] === focus) ? 1 : 0;
      l[2] = approach(l[2], hotT);
      if (l[2] !== hotT) moving = true;
    }
    return moving;
  }

  // ---------- view helpers ----------
  const toWorld = (sx, sy) => [(sx - view.x) / view.k, (sy - view.y) / view.k];

  function fit() {
    if (!nodes.length) { view = { x: width / 2, y: height / 2, k: 1 }; return; }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r);
      x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r);
    }
    const pad = 60;
    const k = Math.min(2, Math.max(0.05, Math.min((width - pad * 2) / (x1 - x0 || 1), (height - pad * 2) / (y1 - y0 || 1))));
    view = { k, x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k };
  }

  function centerOn(n, k) {
    view = { k, x: width / 2 - n.x * k, y: height / 2 - n.y * k };
  }

  function nodeAt(sx, sy) {
    const [wx, wy] = toWorld(sx, sy);
    const slop = 6 / view.k;
    let best = null, bestD = Infinity;
    for (const n of nodes) {
      const dx = n.x - wx, dy = n.y - wy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < n.r * display.nodeSize + slop && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  // ---------- drawing ----------
  function arrowhead(from, to) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const r = to.r * display.nodeSize + 2 / view.k;
    const tx = to.x - ux * r, ty = to.y - uy * r;
    const size = 7 / view.k;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - ux * size + uy * size * 0.5, ty - uy * size - ux * size * 0.5);
    ctx.lineTo(tx - ux * size - uy * size * 0.5, ty - uy * size + ux * size * 0.5);
    ctx.closePath();
    ctx.fill();
  }

  function draw() {
    if (!width) return;
    const s = dpr();
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!nodes.length) return;
    ctx.setTransform(s * view.k, 0, 0, s * view.k, s * view.x, s * view.y);

    const focusNode = currentFocus();

    // Links
    for (const l of links) {
      const a = l[0], b = l[1], h = l[2];
      const lit = Math.min(a.da, b.da);               // 0.2 (dimmed) .. 1
      const base = 0.25 + 0.55 * ((lit - 0.2) / 0.8); // 0.25 .. 0.8
      ctx.strokeStyle = h > 0.5 ? colors.accent : colors.line;
      ctx.globalAlpha = base + (0.9 - base) * h;
      ctx.lineWidth = ((1 + 0.6 * h) * display.linkWidth) / view.k;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (display.arrows) {
        ctx.fillStyle = ctx.strokeStyle;
        if (l[3] & 1) arrowhead(a, b);
        if (l[3] & 2) arrowhead(b, a);
      }
    }

    // Nodes
    for (const n of nodes) {
      ctx.globalAlpha = n.da;
      ctx.fillStyle = n.match
        ? colors.accent
        : n.gc || (n === focusNode ? colors.accent : n.kind === "file" ? colors.file : colors.muted);
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r * display.nodeSize, 0, Math.PI * 2);
      ctx.fill();
      if (n.path === focusPath) {
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 2 / view.k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r * display.nodeSize + 3 / view.k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Labels: constant on-screen size, faded by the animated per-node alpha.
    const fontPx = 12 / view.k;
    ctx.font = `${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const n of nodes) {
      if (n.la <= 0.02) continue;
      ctx.globalAlpha = n.la;
      const label = n.label.length > 40 ? n.label.slice(0, 38) + "…" : n.label;
      const y = n.y + n.r * display.nodeSize + 3 / view.k;
      // Halo for legibility over links.
      ctx.lineWidth = 3 / view.k;
      ctx.strokeStyle = colors.bg;
      ctx.strokeText(label, n.x, y);
      ctx.fillStyle = n === focusNode || n.match || (focusNode && focusNode.nbrs.has(n)) ? colors.ink : colors.muted;
      ctx.fillText(label, n.x, y);
    }
    ctx.globalAlpha = 1;
  }

  // ---------- interaction ----------
  const pointers = new Map();
  let pinch = null;
  let downAt = null;

  function local(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId);
    const [sx, sy] = local(e);
    pointers.set(e.pointerId, [sx, sy]);
    if (pointers.size === 2) {
      // Start pinch; cancel drag/pan.
      if (drag) { drag.fx = drag.fy = null; drag = null; alphaTarget = 0; }
      pan = null;
      const [[ax, ay], [bx, by]] = [...pointers.values()];
      pinch = { d: Math.hypot(bx - ax, by - ay), k: view.k, cx: (ax + bx) / 2, cy: (ay + by) / 2, vx: view.x, vy: view.y };
      return;
    }
    downAt = [sx, sy];
    const n = nodeAt(sx, sy);
    if (n) {
      drag = n;
      n.fx = n.x; n.fy = n.y;
      alphaTarget = 0.25;
      start();
    } else {
      pan = { sx, sy, x: view.x, y: view.y };
    }
  });

  canvas.addEventListener("pointermove", (e) => {
    const [sx, sy] = local(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [sx, sy]);
    if (pinch && pointers.size === 2) {
      const [[ax, ay], [bx, by]] = [...pointers.values()];
      const k = clampK(pinch.k * (Math.hypot(bx - ax, by - ay) / (pinch.d || 1)));
      const wx = (pinch.cx - pinch.vx) / pinch.k, wy = (pinch.cy - pinch.vy) / pinch.k;
      const cx = (ax + bx) / 2, cy = (ay + by) / 2;
      view = { k, x: cx - wx * k, y: cy - wy * k };
      start();
      return;
    }
    if (drag) {
      const [wx, wy] = toWorld(sx, sy);
      drag.fx = wx; drag.fy = wy;
      start();
      return;
    }
    if (pan) {
      view.x = pan.x + (sx - pan.sx);
      view.y = pan.y + (sy - pan.sy);
      draw();
      return;
    }
    if (e.pointerType === "mouse") {
      const n = nodeAt(sx, sy);
      if (n !== hover) {
        hover = n;
        canvas.style.cursor = n ? "pointer" : "grab";
        canvas.title = n ? n.path : "";
        start();
      }
    }
  });

  function endPointer(e) {
    const [sx, sy] = local(e);
    pointers.delete(e.pointerId);
    if (pinch) { if (pointers.size < 2) pinch = null; return; }
    const moved = downAt ? Math.hypot(sx - downAt[0], sy - downAt[1]) : 99;
    if (drag) {
      const n = drag;
      drag = null;
      n.fx = n.fy = null;
      alphaTarget = 0;
      if (moved < 5 && e.type === "pointerup") {
        window.location.href = n.url;
        return;
      }
    }
    pan = null;
    downAt = null;
  }
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && hover && !drag) { hover = null; start(); }
  });

  const clampK = (k) => Math.min(8, Math.max(0.03, k));

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    const [sx, sy] = local(e);
    const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018));
    const k = clampK(view.k * factor);
    view.x = sx - ((sx - view.x) * k) / view.k;
    view.y = sy - ((sy - view.y) * k) / view.k;
    view.k = k;
    start();
  }, { passive: false });

  // ---------- controls ----------
  function applySearch() {
    for (const n of nodes) n.match = query.length > 0 && n.label.toLowerCase().includes(query);
  }

  searchEl.addEventListener("input", () => {
    query = searchEl.value.trim().toLowerCase();
    applySearch();
    start();
  });
  searchEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const m = nodes.find((n) => n.match);
      if (m) { centerOn(m, Math.max(view.k, 1.4)); draw(); }
    } else if (e.key === "Escape") {
      searchEl.value = ""; query = ""; applySearch(); draw();
    }
  });
  filesEl.addEventListener("change", () => data && rebuild(false));
  orphansEl.addEventListener("change", () => data && rebuild(false));
  resetEl.addEventListener("click", () => { fit(); draw(); });

  // ---------- groups ----------
  // A group is a search query and a colour. Nodes take the colour of the first group they match.
  // Queries: plain text (matches name or path), `path:Topics`, or `file:lesson`.
  const PALETTE = ["#fb464c", "#e9973f", "#e0de71", "#44cf6e", "#53dfdd", "#027aff", "#a882ff", "#fa99cd"];
  const groupsList = wrap.querySelector("[data-groups-list]");
  const groupAddEl = wrap.querySelector("[data-group-add]");
  let groups = readPref("groups", []);
  if (!Array.isArray(groups)) groups = [];
  groups = groups
    .filter((g) => g && typeof g.q === "string" && /^#[0-9a-f]{6}$/i.test(g.color || ""))
    .slice(0, 20);

  function groupMatches(n, raw) {
    const q = raw.trim().toLowerCase();
    if (!q) return false;
    const m = q.match(/^(path|file):\s*(.*)$/);
    if (m) {
      const v = m[2];
      if (!v) return false;
      return m[1] === "path" ? n.path.toLowerCase().includes(v) : n.label.toLowerCase().includes(v);
    }
    return n.label.toLowerCase().includes(q) || n.path.toLowerCase().includes(q);
  }

  function applyGroups() {
    for (const n of nodes) {
      n.gc = null;
      for (const g of groups) {
        if (groupMatches(n, g.q)) { n.gc = g.color; break; }
      }
    }
  }

  function renderGroups() {
    if (!groupsList) return;
    groupsList.textContent = "";
    groups.forEach((g, i) => {
      const row = document.createElement("div");
      row.className = "group-row";
      const q = document.createElement("input");
      q.type = "text";
      q.value = g.q;
      q.placeholder = "path:Topics";
      q.maxLength = 100;
      q.setAttribute("aria-label", "Group query");
      q.addEventListener("input", () => { g.q = q.value; savePref("groups", groups); applyGroups(); start(); });
      const c = document.createElement("input");
      c.type = "color";
      c.value = g.color;
      c.setAttribute("aria-label", "Group colour");
      c.addEventListener("input", () => { g.color = c.value; savePref("groups", groups); applyGroups(); start(); });
      const x = document.createElement("button");
      x.type = "button";
      x.className = "icon-btn";
      x.title = "Delete group";
      x.setAttribute("aria-label", "Delete group");
      x.textContent = "×";
      x.addEventListener("click", () => { groups.splice(i, 1); savePref("groups", groups); renderGroups(); applyGroups(); start(); });
      row.append(q, c, x);
      groupsList.appendChild(row);
    });
  }
  renderGroups();
  if (groupAddEl) {
    groupAddEl.addEventListener("click", () => {
      if (groups.length >= 20) return;
      groups.push({ q: "", color: PALETTE[groups.length % PALETTE.length] });
      savePref("groups", groups);
      renderGroups();
      const inputs = groupsList.querySelectorAll('input[type="text"]');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
  }

  // ---------- forces ----------
  const sliders = wrap.querySelectorAll("[data-force]");
  function syncSliders() {
    sliders.forEach((el) => { el.value = String(forces[el.dataset.force]); });
  }
  function reheat() {
    alpha = Math.max(alpha, 0.6);
    start();
  }
  sliders.forEach((el) => {
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      if (!Number.isFinite(v)) return;
      forces[el.dataset.force] = v;
      savePref("forces", forces);
      reheat();
    });
  });
  const forcesReset = wrap.querySelector("[data-forces-reset]");
  if (forcesReset) {
    forcesReset.addEventListener("click", () => {
      Object.assign(forces, FORCE_DEFAULTS);
      savePref("forces", forces);
      syncSliders();

  // ---------- display ----------
  const displaySliders = wrap.querySelectorAll("[data-display]");
  function syncDisplay() {
    displaySliders.forEach((el) => { el.value = String(display[el.dataset.display]); });
  }
  displaySliders.forEach((el) => {
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      if (!Number.isFinite(v)) return;
      display[el.dataset.display] = v;
      savePref("display", display);
      start();
    });
  });
  const arrowsEl = wrap.querySelector("[data-display-toggle='arrows']");
  if (arrowsEl) {
    arrowsEl.checked = !!display.arrows;
    arrowsEl.addEventListener("change", () => { display.arrows = arrowsEl.checked ? 1 : 0; savePref("display", display); start(); });
  }
  const displayReset = wrap.querySelector("[data-display-reset]");
  if (displayReset) {
    displayReset.addEventListener("click", () => {
      Object.assign(display, DISPLAY_DEFAULTS);
      savePref("display", display);
      if (arrowsEl) arrowsEl.checked = false;
      syncDisplay();
      start();
    });
  }
  // Animate: put every node back on the starting spiral and let the layout play out again.
  const animateEl = wrap.querySelector("[data-display-animate]");
  if (animateEl) {
    animateEl.addEventListener("click", () => {
      nodes.forEach((n, j) => {
        const rad = 12 * Math.sqrt(j + 0.5), ang = j * 2.39996323;
        n.x = rad * Math.cos(ang); n.y = rad * Math.sin(ang); n.vx = n.vy = 0;
      });
      view = { x: width / 2, y: height / 2, k: 1.2 };
      alpha = 1;
      start();
    });
  }
  syncDisplay();
      reheat();
    });
  }
  syncSliders();
})();
