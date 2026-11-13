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
    for (const [a, b] of data.links) {
      if (included[a] && included[b]) { deg[a]++; deg[b]++; kept.push([a, b]); }
    }
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
      });
    });
    links = [];
    for (const [a, b] of kept) {
      const ia = map.get(a), ib = map.get(b);
      if (ia === undefined || ib === undefined) continue;
      const A = nodes[ia], B = nodes[ib];
      links.push([A, B]);
      A.nbrs.add(B); B.nbrs.add(A);
    }
    applySearch();
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
  const LINK_DIST = 55, CHARGE = -160, GRAVITY = 0.035, DECAY = 0.4, THETA2 = 0.81, MAX_D2 = 900 * 900;

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
      const w = (CHARGE * alpha * m) / d2;
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
      l = ((l - LINK_DIST) / l) * alpha * strength * 0.7;
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
      n.vx -= n.x * GRAVITY * alpha;
      n.vy -= n.y * GRAVITY * alpha;
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
    if (alpha > 0.003 || alphaTarget > 0) {
      tick();
      draw();
      requestAnimationFrame(frame);
    } else {
      running = false;
      draw();
    }
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
      if (d < n.r + slop && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  // ---------- drawing ----------
  function draw() {
    if (!width) return;
    const s = dpr();
    ctx.setTransform(s, 0, 0, s, 0, 0);
    ctx.clearRect(0, 0, width, height);
    if (!nodes.length) return;
    ctx.setTransform(s * view.k, 0, 0, s * view.k, s * view.x, s * view.y);

    const focusNode = hover || nodes.find((n) => n.path === focusPath) || null;
    const searching = query.length > 0;
    const lit = (n) => !focusNode || n === focusNode || focusNode.nbrs.has(n);

    // Links
    ctx.lineWidth = 1 / view.k;
    for (const [a, b] of links) {
      const hot = focusNode && (a === focusNode || b === focusNode);
      ctx.strokeStyle = hot ? colors.accent : colors.line;
      ctx.globalAlpha = hot ? 0.9 : focusNode || searching ? 0.25 : 0.8;
      if (hot) ctx.lineWidth = 1.6 / view.k;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      if (hot) ctx.lineWidth = 1 / view.k;
    }

    // Nodes
    for (const n of nodes) {
      const dim = (focusNode && !lit(n)) || (searching && !n.match);
      ctx.globalAlpha = dim ? 0.2 : 1;
      ctx.fillStyle =
        n === focusNode || n.match ? colors.accent : n.kind === "file" ? colors.file : colors.muted;
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fill();
      if (n.path === focusPath) {
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 2 / view.k;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r + 3 / view.k, 0, Math.PI * 2);
        ctx.stroke();
      }
    }

    // Labels: constant on-screen size; shown when zoomed in, for hubs, and for highlighted nodes.
    const fontPx = 12 / view.k;
    ctx.font = `${fontPx}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const zoomFade = Math.min(1, Math.max(0, (view.k - 1.3) / 0.5));
    for (const n of nodes) {
      const important = n === focusNode || n.match || (focusNode && focusNode.nbrs.has(n));
      const hub = false;
      let a = important ? 1 : hub ? Math.max(zoomFade, 0.75) : zoomFade;
      if ((focusNode && !lit(n)) || (searching && !n.match)) a *= 0.25;
      if (a <= 0.02) continue;
      ctx.globalAlpha = a;
      const label = n.label.length > 40 ? n.label.slice(0, 38) + "…" : n.label;
      const y = n.y + n.r + 3 / view.k;
      // Halo for legibility over links.
      ctx.lineWidth = 3 / view.k;
      ctx.strokeStyle = colors.bg;
      ctx.strokeText(label, n.x, y);
      ctx.fillStyle = important ? colors.ink : colors.muted;
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
      draw();
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
        draw();
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
    if (e.pointerType === "mouse" && hover && !drag) { hover = null; draw(); }
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
    draw();
  }, { passive: false });

  // ---------- controls ----------
  function applySearch() {
    for (const n of nodes) n.match = query.length > 0 && n.label.toLowerCase().includes(query);
  }

  searchEl.addEventListener("input", () => {
    query = searchEl.value.trim().toLowerCase();
    applySearch();
    draw();
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
})();
