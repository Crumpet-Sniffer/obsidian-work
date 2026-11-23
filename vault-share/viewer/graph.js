// Graph view: force-directed layout of notes and the links between them, drawn on a canvas.
//
// The layout uses d3-force (MIT) tuned to look like Obsidian's graph. Measured on Obsidian's own graph of the same
// vault: every node keeps ~44px between itself and its nearest neighbour whatever its size (a collision force of
// radius 22), the graph spreads to a roughly round cloud, and node size follows the number of links in a
// concave curve (RADIUS_KNOTS). World units are pixels at zoom 1, which is where the graph opens.
import { forceSimulation, forceLink, forceManyBody, forceX, forceY, forceCollide } from "d3-force";

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
  let data = null;               // { nodes: [{label, path, url, kind}], links: [[from, to]] }
  let nodes = [];                // simulated nodes
  let links = [];                // [from, to, highlight 0..1, direction bits]
  let view = { x: 0, y: 0, k: 1 }; // screen = world * k + (x, y), in CSS pixels
  let sim = null;
  let zoomAnim = null;           // smooth wheel zoom: { k, sx, sy }
  let autoFit = false;           // while true the view follows the graph (set when forces change)
  let hover = null, drag = null, pan = null, pressed = null;
  let dragVel = null;            // pointer velocity while dragging a node (world px per ms), for the throw on release
  let query = "";
  let running = false;
  let colors = {};
  let width = 0, height = 0;
  const dpr = () => window.devicePixelRatio || 1;

  // Settings (filters, groups, display, forces) are kept on the server for each account in each vault, and sent a
  // moment after every change. Until they have arrived, the ones last used in this browser are shown; those are
  // also what an account starts from the first time it opens this vault's graph. (localStorage may be
  // unavailable, so every access is guarded.)
  const settingsApi = wrap.dataset.api || "";
  const csrf = wrap.dataset.csrf || "";
  let settingsLoaded = false;
  let saveTimer = 0;
  function readPref(key, fallback) {
    try {
      const v = localStorage.getItem("vault-share:graph:" + key);
      return v ? JSON.parse(v) : fallback;
    } catch { return fallback; }
  }
  function savePref(key, value) {
    try { localStorage.setItem("vault-share:graph:" + key, JSON.stringify(value)); } catch { /* ignore */ }
    scheduleSave();
  }
  function scheduleSave() {
    if (!settingsApi || !settingsLoaded) return;
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(saveNow, 700);
  }
  function saveNow() {
    saveTimer = 0;
    fetch(`${settingsApi}/settings`, {
      method: "PUT",
      credentials: "same-origin",
      keepalive: true,
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ settings: collectSettings() }),
    }).catch(() => { /* kept in this browser; sent again with the next change */ });
  }
  // A change made just before leaving the page is still saved.
  window.addEventListener("pagehide", () => { if (saveTimer) { window.clearTimeout(saveTimer); saveNow(); } });

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

  // ---------- forces and display options ----------
  // Slider values; the simulation strengths below are derived from them.
  const FORCE_DEFAULTS = { center: 0.3, repel: 10, link: 1, dist: 60 };
  const forces = Object.assign({}, FORCE_DEFAULTS);
  const savedForces = readPref("forces", {});
  for (const k of Object.keys(FORCE_DEFAULTS)) if (Number.isFinite(savedForces[k])) forces[k] = savedForces[k];

  // Display options (Display panel): when labels appear, node size, link thickness, arrows.
  const DISPLAY_DEFAULTS = { fade: 0.45, nodeSize: 1, linkWidth: 1, arrows: 0 };
  const display = Object.assign({}, DISPLAY_DEFAULTS);
  const savedDisplay = readPref("display", {});
  for (const k of Object.keys(DISPLAY_DEFAULTS)) if (Number.isFinite(savedDisplay[k])) display[k] = savedDisplay[k];
  // Zoom level at which labels start to fade in: higher threshold slider = labels appear when zoomed out further.
  const labelZoomStart = () => 2.2 - 2.0 * display.fade;

  // Node radius (px at zoom 1) by number of links, measured on Obsidian's graph by matching radius rank to link-count rank.
  const RADIUS_KNOTS = [[0, 4], [1, 4.4], [5, 5.4], [8, 6.8], [10, 7.9], [15, 9.3], [19, 10.5], [25, 12.3], [31, 13.4], [48, 15], [119, 18]];
  function radiusFor(deg) {
    const K = RADIUS_KNOTS;
    if (deg >= K[K.length - 1][0]) return Math.min(26, K[K.length - 1][1] + (deg - K[K.length - 1][0]) * 0.02);
    for (let i = 1; i < K.length; i++) {
      if (deg <= K[i][0]) {
        const [d0, r0] = K[i - 1], [d1, r1] = K[i];
        return r0 + ((deg - d0) / (d1 - d0)) * (r1 - r0);
      }
    }
    return K[0][1];
  }

  // ---------- data ----------
  const getJson = (url) => fetch(url, { credentials: "same-origin", headers: { Accept: "application/json" } })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
  // The graph and this account's settings arrive together, so the first layout already uses the settings.
  const settingsP = settingsApi ? getJson(`${settingsApi}/settings`).catch(() => null) : Promise.resolve(null);
  Promise.all([getJson(wrap.dataset.src), settingsP])
    .then(([d, st]) => {
      data = d;
      annotate(d);
      if (st) {
        presetLists(st);
        if (st.current) applySettings(st.current, false);
      }
      settingsLoaded = !!st;
      // First visit to this vault's graph: start from what this browser last used, and keep it for this account.
      if (st && !st.current) scheduleSave();
      rebuild(true);
    })
    .catch(() => { statusEl.textContent = "Could not load the graph. Try reloading the page."; });

  function rebuild(initial) {
    const old = new Map(nodes.map((n) => [n.path, n]));
    const withFiles = filesEl.checked;
    const withOrphans = orphansEl.checked;
    const shown = data.nodes.map((n) => n.kind === "note" || withFiles);
    // Files a group with a closed eye matches are left out, with their links.
    const included = data.nodes.map((n, i) => shown[i] && !hiddenByGroups(n));
    const hiddenCount = included.reduce((c, inc, i) => c + (shown[i] && !inc ? 1 : 0), 0);
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
    // Like Obsidian, every open starts from a different random scatter, so the layout settles differently each time.
    const spread = 34 * Math.sqrt(data.nodes.length);
    const rnd = () => (Math.random() * 2 - 1) * spread;
    data.nodes.forEach((n, i) => {
      if (!included[i]) return;
      if (!withOrphans && deg[i] === 0 && n.path !== focusPath) return;
      const prev = old.get(n.path);
      map.set(i, nodes.length);
      nodes.push({
        ...n,
        deg: deg[i],
        r: radiusFor(deg[i]),
        // New nodes start at a random spot; existing ones keep their position.
        x: prev ? prev.x : rnd(),
        y: prev ? prev.y : rnd(),
        px: 0, py: 0, dx: 0, dy: 0, // position before the latest tick, and the position drawn this frame
        vx: 0, vy: 0, fx: null, fy: null,
        nbrs: new Set(),
        match: false,
        la: 0, da: 1, ha: 0, gc: null, // animated label alpha, dimming alpha and hover amount; group colour
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
      ` · ${links.length} link${links.length === 1 ? "" : "s"}` +
      (hiddenCount ? ` · ${hiddenCount} hidden by groups` : "");

    buildSim();
    if (initial) {
      sim.alpha(1);
      // Run the first part of the layout off-screen, then let the rest play out on screen like Obsidian does.
      const warm = Math.min(120, Math.max(20, Math.floor(30000 / Math.max(1, nodes.length))));
      for (let i = 0; i < warm; i++) sim.tick();
      syncPrev();
      const f = nodes.find((n) => n.path === focusPath);
      if (f) centerOn(f, 1.6); else fit();
    } else {
      syncPrev();
      reheat(0.6);
    }
    start();
  }

  // ---------- simulation (d3-force) ----------
  const COLLIDE = 22; // every node keeps this much room, regardless of size
  // How hard the centre slider pulls. The repel force reaches right across the graph, and when it outweighs the pull to
  // the centre the cloud stretches into a slab (about 1.6 times longer than wide at 0.1). At 0.6 it stays close to round
  // (about 1.2, less with attachments shown) and the spacing between nodes is unchanged.
  const CENTER_PULL = 0.6;

  // Links are weaker for well-connected nodes (so hubs do not collapse), except around a node being dragged:
  // those get a firm pull so its neighbours follow the pointer instead of being pushed away.
  // The switch between the two is eased (`grip` runs 0..1), so grabbing and letting go never jolts the layout.
  let held = null, grip = 0, gripTarget = 0;
  const GRIP_IN = 0.12, GRIP_OUT = 0.035; // per tick: takes hold in roughly 0.2s, lets go over roughly 0.7s
  const isHeldLink = (l) => held && (l.source === held || l.target === held);
  const restStrength = (l) => forces.link / Math.max(1, Math.min(l.source.deg, l.target.deg));
  const linkStrength = (l) => {
    const s = restStrength(l);
    return isHeldLink(l) ? s + (Math.min(1, 0.3 * forces.link) - s) * grip : s;
  };
  // The neighbours of a held node must also fit around it: pulling dozens of them to the normal link distance would
  // pack them into a tight clump, so their rest distance grows with how many there are (hex packing of 44px cells).
  const linkDistance = (l) =>
    isHeldLink(l) ? forces.dist + (Math.max(forces.dist, 23 * Math.sqrt(held.deg)) - forces.dist) * grip : forces.dist;
  function setHeld(n) {
    if (n) {
      if (held && held !== n) grip = 0;
      held = n; gripTarget = 1;
    } else gripTarget = 0;
  }
  // Runs once per simulation tick.
  function stepGrip() {
    if (!held || grip === gripTarget) return;
    grip += (gripTarget - grip) * (gripTarget ? GRIP_IN : GRIP_OUT);
    if (Math.abs(gripTarget - grip) < 0.01) grip = gripTarget;
    if (grip === 0) held = null;
    sim.force("link").distance(linkDistance).strength(linkStrength);
  }

  function buildSim() {
    if (sim) sim.stop();
    const simLinks = links.map((l) => ({ source: l[0], target: l[1] }));
    sim = forceSimulation(nodes)
      .stop()
      .randomSource(Math.random)
      .alphaDecay(0.0228)
      .velocityDecay(0.4)
      .force("link", forceLink(simLinks).distance(linkDistance).strength(linkStrength))
      .force("charge", forceManyBody().strength(-forces.repel * 10))
      .force("x", forceX(0).strength(forces.center * CENTER_PULL))
      .force("y", forceY(0).strength(forces.center * CENTER_PULL))
      .force("collide", forceCollide(COLLIDE).iterations(2));
  }

  // Push the slider values into the running simulation.
  function applyForces() {
    if (!sim) return;
    sim.force("link").distance(linkDistance).strength(linkStrength);
    sim.force("charge").strength(-forces.repel * 10);
    sim.force("x").strength(forces.center * CENTER_PULL);
    sim.force("y").strength(forces.center * CENTER_PULL);
  }

  function reheat(a = 0.6) {
    if (sim) sim.alpha(Math.max(sim.alpha(), a));
    start();
  }

  function start() {
    if (running) return;
    running = true;
    lastFrame = 0;
    requestAnimationFrame(frame);
  }

  // The simulation advances at a fixed rate whatever the display's refresh rate (one tick per frame would run the
  // layout six times faster on a 360Hz screen than on a 60Hz one). Frames that fall between two ticks draw the nodes
  // part-way between them, so motion stays smooth at any refresh rate.
  const TICK_MS = 1000 / 120;
  let lastFrame = 0, tickDebt = 0, blend = 1;

  function syncPrev() {
    for (const n of nodes) { n.px = n.x; n.py = n.y; }
    blend = 1; tickDebt = 0;
  }

  function stepSim(dt) {
    const simulating = !!sim && (sim.alpha() > sim.alphaMin() || sim.alphaTarget() > 0 || (!!held && grip !== gripTarget));
    if (!simulating) { blend = 1; tickDebt = 0; return false; }
    tickDebt += dt;
    const began = performance.now();
    let n = 0;
    while (tickDebt >= TICK_MS) {
      // A layout too heavy to keep up drops time instead of freezing the page.
      if (n++ >= 6 || performance.now() - began > 12) { tickDebt = 0; break; }
      for (const m of nodes) { m.px = m.x; m.py = m.y; }
      stepGrip();
      sim.tick();
      tickDebt -= TICK_MS;
    }
    blend = Math.min(1, tickDebt / TICK_MS);
    return true;
  }

  // Where each node is drawn this frame. A dragged node sits exactly under the pointer.
  function place() {
    for (const n of nodes) {
      if (n === drag) { n.dx = n.fx; n.dy = n.fy; continue; }
      n.dx = n.px + (n.x - n.px) * blend;
      n.dy = n.py + (n.y - n.py) * blend;
    }
  }

  // Fraction of the way to a target to move this frame, for an ease with the given time constant.
  const easeBy = (dt, tau) => 1 - Math.exp(-dt / tau);

  function frame(now) {
    const dt = lastFrame ? Math.min(100, now - lastFrame) : TICK_MS;
    lastFrame = now;
    const simulating = stepSim(dt);
    const following = stepFollow(simulating, dt);
    const zooming = stepZoom(dt);
    const fading = stepFades(dt);
    draw();
    if (simulating || following || zooming || fading) requestAnimationFrame(frame);
    else running = false;
  }

  // After a force change the graph can grow or drift past the edge of the screen. Until the layout settles
  // (or you grab the view), ease the view so the whole graph stays in sight and centred.
  function stepFollow(simulating, dt) {
    if (!autoFit || drag || pan || pinch) return false;
    const t = fitView();
    if (!t) { autoFit = false; return false; }
    const e = easeBy(dt, 130);
    view.k += (t.k - view.k) * e;
    view.x += (t.x - view.x) * e;
    view.y += (t.y - view.y) * e;
    const close = Math.abs(t.k - view.k) < 0.002 && Math.abs(t.x - view.x) < 0.5 && Math.abs(t.y - view.y) < 0.5;
    if (!simulating && close) { autoFit = false; return false; }
    return true;
  }

  // ---------- smooth zoom ----------
  function stepZoom(dt) {
    if (!zoomAnim) return false;
    const k = view.k + (zoomAnim.k - view.k) * easeBy(dt, 60);
    const done = Math.abs(zoomAnim.k - k) < 0.0005 * zoomAnim.k;
    const nk = done ? zoomAnim.k : k;
    // keep the world point under the cursor fixed
    view.x = zoomAnim.sx - ((zoomAnim.sx - view.x) * nk) / view.k;
    view.y = zoomAnim.sy - ((zoomAnim.sy - view.y) * nk) / view.k;
    view.k = nk;
    if (done) zoomAnim = null;
    return !done;
  }

  // ---------- fades ----------
  // Labels, dimming and highlighted links ease toward their targets instead of switching instantly,
  // so labels fade in when you hover a node and fade out when you leave it.
  const FADE_MS = 75;

  function currentFocus() {
    return hover || nodes.find((n) => n.path === focusPath) || null;
  }

  function approach(cur, target, e) {
    const next = cur + (target - cur) * e;
    return Math.abs(target - next) < 0.01 ? target : next;
  }

  function stepFades(dt) {
    const e = easeBy(dt, FADE_MS);
    const focus = currentFocus();
    const searching = query.length > 0;
    const zoomFade = Math.min(1, Math.max(0, (view.k - labelZoomStart()) / 0.5));
    let moving = false;
    for (const n of nodes) {
      const lit = !focus || n === focus || focus.nbrs.has(n);
      const dim = (focus && !lit) || (searching && !n.match);
      const important = n === focus || n.match; // neighbours are highlighted but not labelled
      const daT = dim ? 0.2 : 1;
      const laT = (important ? 1 : zoomFade) * (dim ? 0.25 : 1);
      const haT = n === hover || n === drag ? 1 : 0;
      const da = approach(n.da, daT, e), la = approach(n.la, laT, e), ha = approach(n.ha, haT, e);
      if (da !== daT || la !== laT || ha !== haT) moving = true;
      n.da = da; n.la = la; n.ha = ha;
    }
    for (const l of links) {
      const hotT = focus && (l[0] === focus || l[1] === focus) ? 1 : 0;
      l[2] = approach(l[2], hotT, e);
      if (l[2] !== hotT) moving = true;
    }
    return moving;
  }

  // ---------- view helpers ----------
  const toWorld = (sx, sy) => [(sx - view.x) / view.k, (sy - view.y) / view.k];

  // The view that shows the whole graph: zoom 1 centred on the cloud, shrinking only if it would not fit.
  // Obsidian opens the graph like this.
  function fitView() {
    if (!nodes.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of nodes) {
      if (!Number.isFinite(n.x) || !Number.isFinite(n.y)) continue;
      x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r);
      x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r);
    }
    if (!Number.isFinite(x0)) return null;
    const pad = 40;
    const k = Math.min(1, Math.max(0.05, Math.min((width - pad * 2) / (x1 - x0 || 1), (height - pad * 2) / (y1 - y0 || 1))));
    return { k, x: width / 2 - ((x0 + x1) / 2) * k, y: height / 2 - ((y0 + y1) / 2) * k };
  }

  function fit() {
    zoomAnim = null;
    view = fitView() || { x: width / 2, y: height / 2, k: 1 };
  }

  function centerOn(n, k) {
    zoomAnim = null;
    view = { k, x: width / 2 - n.x * k, y: height / 2 - n.y * k };
  }

  function nodeAt(sx, sy) {
    const [wx, wy] = toWorld(sx, sy);
    const slop = 6 / view.k;
    let best = null, bestD = Infinity;
    for (const n of nodes) {
      const dx = n.dx - wx, dy = n.dy - wy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < n.r * display.nodeSize + slop && d < bestD) { best = n; bestD = d; }
    }
    return best;
  }

  // ---------- drawing ----------
  // Drawn radius: a node swells slightly while the pointer is on it.
  const drawnR = (n) => n.r * display.nodeSize * (1 + 0.12 * n.ha);

  function arrowhead(from, to) {
    const dx = to.dx - from.dx, dy = to.dy - from.dy;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const r = drawnR(to) + 2 / view.k;
    const tx = to.dx - ux * r, ty = to.dy - uy * r;
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

    place();
    const focusNode = currentFocus();

    // Links: one world unit thick at zoom 1, scaling with zoom like Obsidian's.
    // Brightness runs 0.3 (dimmed) .. 0.9, matching Obsidian's links. Links at either end of that range and not
    // highlighted (nearly all of them, nearly all the time) are stroked together as one path each; the few that are
    // mid-fade or highlighted are drawn one by one afterwards, on top.
    const rest = [], dimmed = [], special = [];
    for (const l of links) {
      const lit = Math.min(l[0].da, l[1].da);
      if (l[2] === 0 && lit === 1) rest.push(l);
      else if (l[2] === 0 && lit === 0.2) dimmed.push(l);
      else special.push(l);
    }
    const strokeTogether = (list, alpha) => {
      if (!list.length) return;
      ctx.strokeStyle = ctx.fillStyle = colors.line;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = display.linkWidth;
      ctx.beginPath();
      for (const l of list) { ctx.moveTo(l[0].dx, l[0].dy); ctx.lineTo(l[1].dx, l[1].dy); }
      ctx.stroke();
      if (display.arrows) {
        for (const l of list) {
          if (l[3] & 1) arrowhead(l[0], l[1]);
          if (l[3] & 2) arrowhead(l[1], l[0]);
        }
      }
    };
    strokeTogether(dimmed, 0.3);
    strokeTogether(rest, 0.9);
    for (const l of special) {
      const a = l[0], b = l[1], h = l[2];
      const lit = Math.min(a.da, b.da);               // 0.2 (dimmed) .. 1
      const base = 0.3 + 0.6 * ((lit - 0.2) / 0.8);
      ctx.strokeStyle = h > 0.5 ? colors.accent : colors.line;
      ctx.globalAlpha = base + (1 - base) * h;
      ctx.lineWidth = (1 + 0.6 * h) * display.linkWidth;
      ctx.beginPath();
      ctx.moveTo(a.dx, a.dy);
      ctx.lineTo(b.dx, b.dy);
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
      ctx.arc(n.dx, n.dy, drawnR(n), 0, Math.PI * 2);
      ctx.fill();
      if (n.path === focusPath) {
        ctx.strokeStyle = colors.accent;
        ctx.lineWidth = 2 / view.k;
        ctx.beginPath();
        ctx.arc(n.dx, n.dy, drawnR(n) + 3 / view.k, 0, Math.PI * 2);
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
      const y = n.dy + drawnR(n) + 3 / view.k;
      // Halo for legibility over links.
      ctx.lineWidth = 3 / view.k;
      ctx.lineJoin = "round";
      ctx.strokeStyle = colors.bg;
      ctx.strokeText(label, n.dx, y);
      ctx.fillStyle = n === focusNode || n.match ? colors.ink : colors.muted;
      ctx.fillText(label, n.dx, y);
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
    zoomAnim = null;
    autoFit = false;
    if (pointers.size === 2) {
      // Start pinch; cancel drag/pan.
      if (drag) { drag.fx = drag.fy = null; drag = null; dragVel = null; setHeld(null); sim && sim.alphaTarget(0); }
      pressed = null;
      pan = null;
      const [[ax, ay], [bx, by]] = [...pointers.values()];
      pinch = { d: Math.hypot(bx - ax, by - ay), k: view.k, cx: (ax + bx) / 2, cy: (ay + by) / 2, vx: view.x, vy: view.y };
      return;
    }
    downAt = [sx, sy];
    const n = nodeAt(sx, sy);
    if (n) {
      pressed = n;       // a plain click or hold only highlights it; the layout is untouched until it is dragged
      hover = n;
      autoFit = false;
      start();
    } else {
      pan = { sx, sy, x: view.x, y: view.y };
      canvas.style.cursor = "grabbing";
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
    if (pressed && !drag && downAt && Math.hypot(sx - downAt[0], sy - downAt[1]) > 5) {
      drag = pressed;     // moved far enough: now it is a drag, so pin the node and let its neighbours follow
      drag.fx = drag.x; drag.fy = drag.y;
      dragVel = { x: 0, y: 0, t: e.timeStamp };
      canvas.style.cursor = "grabbing";
      setHeld(drag);
      sim && sim.alphaTarget(0.3);
    }
    if (drag) {
      const [wx, wy] = toWorld(sx, sy);
      // Smoothed pointer velocity, so a node let go mid-swing carries on a little instead of stopping dead.
      const dt = e.timeStamp - dragVel.t;
      if (dt > 0) {
        const w = Math.min(1, dt / 50);
        dragVel.x += ((wx - drag.fx) / dt - dragVel.x) * w;
        dragVel.y += ((wy - drag.fy) / dt - dragVel.y) * w;
        dragVel.t = e.timeStamp;
      }
      drag.fx = wx; drag.fy = wy;
      start();
      return;
    }
    if (pressed) return; // holding a node still: keep it highlighted, do nothing else
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
      // Let go where the pointer is. If it was still moving, the node keeps some of that speed (none if the
      // pointer had already come to rest), capped so a hard flick cannot fling it across the graph.
      n.x = n.px = n.fx; n.y = n.py = n.fy;
      n.fx = n.fy = null;
      if (dragVel && e.type === "pointerup" && e.timeStamp - dragVel.t < 80) {
        const cap = 14, vx = dragVel.x * TICK_MS, vy = dragVel.y * TICK_MS, v = Math.hypot(vx, vy);
        const s = v > cap ? cap / v : 1;
        n.vx = vx * s; n.vy = vy * s;
      }
      dragVel = null;
      setHeld(null);
      sim && sim.alphaTarget(0);
      start();
    } else if (pressed && moved < 5 && e.type === "pointerup") {
      window.location.href = pressed.url; // a click opens the note
      pressed = null;
      return;
    }
    pressed = null;
    pan = null;
    downAt = null;
    canvas.style.cursor = e.pointerType === "mouse" && nodeAt(sx, sy) ? "pointer" : "grab";
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
    autoFit = false;
    const from = zoomAnim ? zoomAnim.k : view.k;
    zoomAnim = { k: clampK(from * factor), sx, sy };
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
      searchEl.value = ""; query = ""; applySearch(); start();
    }
  });
  filesEl.addEventListener("change", () => { scheduleSave(); if (data) rebuild(false); });
  orphansEl.addEventListener("change", () => { scheduleSave(); if (data) rebuild(false); });
  resetEl.addEventListener("click", () => { fit(); start(); });

  // ---------- groups ----------
  // A group picks files by folder, file type, name, topic or search, and gives them a colour; nodes take the colour
  // of the first group they match. A group's eye hides the files it matches from the graph (any hidden group they
  // match hides them). Groups live in this browser, like the other graph settings.
  const PALETTE = ["#fb464c", "#e9973f", "#e0de71", "#44cf6e", "#53dfdd", "#027aff", "#a882ff", "#fa99cd"];
  const KINDS = [
    { id: "folder", label: "Folder", hint: "Unit 1/Section A" },
    { id: "type", label: "File type", hint: "md, pptx, png" },
    { id: "name", label: "Name", hint: "part of a file name" },
    { id: "topic", label: "Topic", hint: "a topic's name" },
    { id: "search", label: "Search", hint: "text, path:… or file:…" },
  ];
  const topicsFolder = (wrap.dataset.topics || "Topics").replace(/^\/+|\/+$/g, "");
  const groupsList = wrap.querySelector("[data-groups-list]");
  const groupAddEl = wrap.querySelector("[data-group-add]");

  function normalizeGroups(list) {
    if (!Array.isArray(list)) return [];
    return list
      // Groups saved before there were kinds were searches.
      .map((g) => (g && typeof g.q === "string" && !g.type ? { type: "search", value: g.q, color: g.color, hidden: false } : g))
      .filter((g) => g && KINDS.some((k) => k.id === g.type) && typeof g.value === "string" && /^#[0-9a-f]{6}$/i.test(g.color || ""))
      .map((g) => ({ type: g.type, value: g.value.slice(0, 200), color: g.color, hidden: !!g.hidden }))
      .slice(0, 20);
  }
  let groups = normalizeGroups(readPref("groups", []));
  const saveGroups = () => savePref("groups", groups);

  // What groups match on, worked out once per node when the graph loads: its folder, file type and topics (the
  // topic pages it links to, or its own name if it is one).
  function annotate(d) {
    const prefix = topicsFolder.toLowerCase() + "/";
    const isTopic = (n) => n.kind === "note" && n.path.toLowerCase().startsWith(prefix);
    for (const n of d.nodes) {
      const slash = n.path.lastIndexOf("/");
      n.folder = slash >= 0 ? n.path.slice(0, slash) : "";
      const name = n.path.slice(slash + 1);
      n.ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
      n.topics = isTopic(n) ? [n.label] : [];
    }
    for (const [f, t] of d.links) {
      const a = d.nodes[f], b = d.nodes[t];
      if (isTopic(b) && !a.topics.includes(b.label)) a.topics.push(b.label);
    }
    fillSuggestions(d);
  }

  // Suggestions for each kind of group, from what is in this vault.
  const lists = {};
  for (const k of ["folder", "type", "topic"]) {
    const dl = document.createElement("datalist");
    dl.id = `graph-group-${k}`;
    wrap.appendChild(dl);
    lists[k] = dl;
  }
  function fillSuggestions(d) {
    const folders = new Set(), types = new Set(), topics = new Set();
    for (const n of d.nodes) {
      const segs = n.folder ? n.folder.split("/") : [];
      for (let i = 1; i <= segs.length; i++) folders.add(segs.slice(0, i).join("/"));
      if (n.ext) types.add(n.ext);
      for (const t of n.topics) topics.add(t);
    }
    const fill = (dl, values) => dl.replaceChildren(...[...values].sort((a, b) => a.localeCompare(b)).slice(0, 500).map((v) => {
      const o = document.createElement("option");
      o.value = v;
      return o;
    }));
    fill(lists.folder, folders);
    fill(lists.type, types);
    fill(lists.topic, topics);
  }

  function searchMatches(n, q) {
    const m = q.match(/^(path|file):\s*(.*)$/);
    if (m) {
      const v = m[2];
      if (!v) return false;
      return m[1] === "path" ? n.path.toLowerCase().includes(v) : n.label.toLowerCase().includes(v);
    }
    return n.label.toLowerCase().includes(q) || n.path.toLowerCase().includes(q);
  }

  function groupMatches(n, g) {
    const v = g.value.trim().toLowerCase();
    if (!v) return false;
    switch (g.type) {
      case "folder": {
        // The folder and everything inside it.
        const f = v.replace(/^\/+|\/+$/g, "");
        const nf = n.folder.toLowerCase();
        return nf === f || nf.startsWith(f + "/");
      }
      case "type":
        // One or more types: "pptx", ".pptx", "png jpg"; "note" means Markdown notes.
        return v.split(/[\s,]+/).filter(Boolean).some((t) => {
          const e = t.replace(/^\./, "");
          return (e === "note" || e === "notes" ? "md" : e) === n.ext;
        });
      case "name":
        return n.label.toLowerCase().includes(v);
      case "topic":
        return n.topics.some((t) => t.toLowerCase() === v);
      default:
        return searchMatches(n, v);
    }
  }

  // Hidden by a group whose eye is closed.
  function hiddenByGroups(n) {
    for (const g of groups) if (g.hidden && groupMatches(n, g)) return true;
    return false;
  }

  function applyGroups() {
    for (const n of nodes) {
      n.gc = null;
      for (const g of groups) {
        if (groupMatches(n, g)) { n.gc = g.color; break; }
      }
    }
    updateCounts();
  }

  // After a change: colours only, or (when what is hidden may have changed) a rebuild of the graph. Typing is
  // debounced so the layout is not rebuilt on every key.
  let rebuildTimer = 0;
  function groupsChanged(structural) {
    saveGroups();
    if (structural && data) {
      window.clearTimeout(rebuildTimer);
      rebuildTimer = window.setTimeout(() => { rebuild(false); start(); }, 250);
    } else {
      applyGroups();
      start();
    }
  }

  const rowRefs = [];
  function updateCounts() {
    if (!data) return;
    groups.forEach((g, i) => {
      const r = rowRefs[i];
      if (!r) return;
      const n = g.value.trim() ? data.nodes.filter((x) => groupMatches(x, g)).length : 0;
      r.count.textContent = g.value.trim() ? String(n) : "";
      r.count.title = `${n} file${n === 1 ? "" : "s"} match`;
      r.eye.hidden = !g.value.trim();
    });
  }

  function svgIcon(id) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("class", "ic");
    const use = document.createElementNS(ns, "use");
    use.setAttribute("href", `#${id}`);
    svg.appendChild(use);
    return svg;
  }

  function setEye(btn, hidden) {
    btn.replaceChildren(svgIcon(hidden ? "i-eye-off" : "i-eye"));
    btn.setAttribute("aria-pressed", hidden ? "true" : "false");
    btn.title = hidden ? "Hidden from the graph: show these files" : "Hide these files from the graph";
    btn.setAttribute("aria-label", btn.title);
    btn.classList.toggle("is-off", hidden);
  }

  function renderGroups() {
    if (!groupsList) return;
    groupsList.textContent = "";
    rowRefs.length = 0;
    groups.forEach((g, i) => {
      const row = document.createElement("div");
      row.className = "group-row";

      const kind = document.createElement("select");
      kind.setAttribute("aria-label", "What the group matches");
      for (const k of KINDS) {
        const o = document.createElement("option");
        o.value = k.id;
        o.textContent = k.label;
        kind.appendChild(o);
      }
      kind.value = g.type;

      const count = document.createElement("span");
      count.className = "group-count muted small";

      const c = document.createElement("input");
      c.type = "color";
      c.value = g.color;
      c.setAttribute("aria-label", "Group colour");
      c.addEventListener("input", () => { g.color = c.value; groupsChanged(false); });

      const eye = document.createElement("button");
      eye.type = "button";
      eye.className = "icon-btn group-eye";
      setEye(eye, g.hidden);
      eye.addEventListener("click", () => {
        g.hidden = !g.hidden;
        setEye(eye, g.hidden);
        window.clearTimeout(rebuildTimer);
        saveGroups();
        if (data) { rebuild(false); start(); }
      });

      const x = document.createElement("button");
      x.type = "button";
      x.className = "icon-btn";
      x.title = "Delete group";
      x.setAttribute("aria-label", "Delete group");
      x.textContent = "×";
      x.addEventListener("click", () => {
        const wasHidden = g.hidden;
        groups.splice(i, 1);
        renderGroups();
        groupsChanged(wasHidden);
      });

      const q = document.createElement("input");
      q.type = "text";
      q.className = "group-value";
      q.value = g.value;
      q.maxLength = 200;
      q.spellcheck = false;
      q.setAttribute("aria-label", "Group value");
      const setKind = () => {
        const k = KINDS.find((k) => k.id === g.type);
        q.placeholder = k.hint;
        if (lists[g.type]) q.setAttribute("list", lists[g.type].id);
        else q.removeAttribute("list");
      };
      setKind();
      q.addEventListener("input", () => { g.value = q.value; groupsChanged(g.hidden); });
      kind.addEventListener("change", () => { g.type = kind.value; setKind(); groupsChanged(g.hidden); });

      row.append(kind, count, c, eye, x, q);
      groupsList.appendChild(row);
      rowRefs.push({ count, eye });
    });
    updateCounts();
  }
  renderGroups();
  if (groupAddEl) {
    groupAddEl.addEventListener("click", () => {
      if (groups.length >= 20) return;
      groups.push({ type: "folder", value: "", color: PALETTE[groups.length % PALETTE.length], hidden: false });
      saveGroups();
      renderGroups();
      const inputs = groupsList.querySelectorAll(".group-value");
      if (inputs.length) inputs[inputs.length - 1].focus();
    });
  }

  // ---------- forces panel ----------
  // The force ID field (further down) is set up after the sliders; until then only the sliders are synced.
  var forceIdReady = false; // eslint-disable-line no-var
  const sliders = wrap.querySelectorAll("[data-force]");
  function syncSliders() {
    sliders.forEach((el) => { el.value = String(forces[el.dataset.force]); });
    if (forceIdReady) showForceId();
  }
  sliders.forEach((el) => {
    el.addEventListener("input", () => {
      const v = parseFloat(el.value);
      if (!Number.isFinite(v)) return;
      forces[el.dataset.force] = v;
      savePref("forces", forces);
      applyForces();
      autoFit = true;
      reheat(0.6);
    });
  });
  const forcesReset = wrap.querySelector("[data-forces-reset]");
  if (forcesReset) {
    forcesReset.addEventListener("click", () => {
      Object.assign(forces, FORCE_DEFAULTS);
      savePref("forces", forces);
      syncSliders();
      applyForces();
      autoFit = true;
      reheat(0.6);
    });
  }
  syncSliders();

  // ---------- display panel ----------
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
  // Animate: scatter the nodes and let the layout play out again.
  const animateEl = wrap.querySelector("[data-display-animate]");
  if (animateEl) {
    animateEl.addEventListener("click", () => {
      const spread = 34 * Math.sqrt(Math.max(1, nodes.length));
      nodes.forEach((n) => {
        n.x = (Math.random() * 2 - 1) * spread; n.y = (Math.random() * 2 - 1) * spread; n.vx = n.vy = 0;
      });
      syncPrev();
      view = { x: width / 2, y: height / 2, k: 1 };
      zoomAnim = null;
      autoFit = true;
      if (sim) sim.alpha(1);
      start();
    });
  }
  syncDisplay();

  // ---------- force ID ----------
  // The four forces as one short code, like a colour's hex code: "centre,repel,link,distance", for example
  // "0.30,10.0,1.00,60". It can be copied to share a layout's forces, or pasted or typed in to use someone's.
  const FORCE_ORDER = ["center", "repel", "link", "dist"];
  const forceIdEl = wrap.querySelector("[data-force-id]");
  const forceIdHelp = wrap.querySelector("[data-force-id-help]");
  const forceIdHelpText = forceIdHelp ? forceIdHelp.textContent : "";
  const sliderFor = (k) => wrap.querySelector(`[data-force="${k}"]`);
  const decimals = (k) => {
    const step = sliderFor(k) ? sliderFor(k).step : "1";
    return step.includes(".") ? step.split(".")[1].length : 0;
  };
  function forceId(f = forces) {
    return FORCE_ORDER.map((k) => Number(f[k]).toFixed(decimals(k))).join(",");
  }
  /** The forces a code stands for (clamped to what the sliders allow), or null if it is not four numbers. */
  function parseForceId(text) {
    const parts = String(text).trim().replace(/^[[(]|[\])]$/g, "").split(/\s*[,;\s]\s*/).filter(Boolean);
    if (parts.length !== 4) return null;
    const out = {};
    for (let i = 0; i < 4; i++) {
      const v = Number(parts[i]);
      if (!Number.isFinite(v)) return null;
      const el = sliderFor(FORCE_ORDER[i]);
      const lo = el ? parseFloat(el.min) : -Infinity, hi = el ? parseFloat(el.max) : Infinity;
      out[FORCE_ORDER[i]] = Math.min(hi, Math.max(lo, v));
    }
    return out;
  }
  function showForceId() {
    if (forceIdEl && document.activeElement !== forceIdEl) {
      forceIdEl.value = forceId();
      forceIdEl.classList.remove("is-bad");
    }
  }
  let helpTimer = 0;
  function forceHelp(text, bad = false) {
    if (!forceIdHelp) return;
    forceIdHelp.textContent = text;
    forceIdHelp.classList.toggle("is-bad", bad);
    window.clearTimeout(helpTimer);
    helpTimer = window.setTimeout(() => { forceIdHelp.textContent = forceIdHelpText; forceIdHelp.classList.remove("is-bad"); }, 2500);
  }
  function useForceId() {
    const f = parseForceId(forceIdEl.value);
    if (!f) {
      forceIdEl.classList.add("is-bad");
      forceHelp("A force ID is four numbers separated by commas: centre, repel, link, distance.", true);
      return;
    }
    forceIdEl.classList.remove("is-bad");
    Object.assign(forces, f);
    savePref("forces", forces);
    sliders.forEach((el) => { el.value = String(forces[el.dataset.force]); });
    forceIdEl.value = forceId();
    applyForces();
    autoFit = true;
    reheat(0.6);
  }
  if (forceIdEl) {
    forceIdEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); useForceId(); forceIdEl.select(); }
      else if (e.key === "Escape") { forceIdEl.value = forceId(); forceIdEl.classList.remove("is-bad"); forceIdEl.blur(); }
    });
    forceIdEl.addEventListener("change", useForceId);
    // A pasted code is used at once.
    forceIdEl.addEventListener("paste", () => window.setTimeout(() => { if (parseForceId(forceIdEl.value)) useForceId(); }, 0));
    forceIdEl.addEventListener("focus", () => forceIdEl.select());
  }
  const forceCopyEl = wrap.querySelector("[data-force-id-copy]");
  if (forceCopyEl) {
    forceCopyEl.addEventListener("click", async () => {
      const code = forceId();
      try {
        await navigator.clipboard.writeText(code);
      } catch {
        forceIdEl.value = code;
        forceIdEl.select();
        try { document.execCommand("copy"); } catch { /* the code is selected for copying by hand */ }
      }
      forceHelp(`Copied ${code}`);
    });
  }
  sliders.forEach((el) => el.addEventListener("input", showForceId));
  forceIdReady = true;
  showForceId();

  // ---------- settings: collect and apply ----------
  function collectSettings() {
    return {
      v: 1,
      filters: { files: filesEl.checked, orphans: orphansEl.checked },
      groups: groups.map((g) => ({ type: g.type, value: g.value, color: g.color, hidden: !!g.hidden })),
      display: Object.assign({}, display),
      forces: Object.assign({}, forces),
    };
  }

  /** Use a whole set of settings (saved, or a preset). Anything a preset leaves out goes back to its default. */
  function applySettings(st, relayout = true) {
    if (!st || typeof st !== "object") return;
    const f = st.filters || {};
    filesEl.checked = typeof f.files === "boolean" ? f.files : false;
    orphansEl.checked = typeof f.orphans === "boolean" ? f.orphans : true;
    groups = normalizeGroups(st.groups);
    Object.assign(display, DISPLAY_DEFAULTS);
    for (const k of Object.keys(DISPLAY_DEFAULTS)) if (st.display && Number.isFinite(st.display[k])) display[k] = st.display[k];
    Object.assign(forces, FORCE_DEFAULTS);
    for (const k of Object.keys(FORCE_DEFAULTS)) if (st.forces && Number.isFinite(st.forces[k])) forces[k] = st.forces[k];
    try {
      localStorage.setItem("vault-share:graph:groups", JSON.stringify(groups));
      localStorage.setItem("vault-share:graph:display", JSON.stringify(display));
      localStorage.setItem("vault-share:graph:forces", JSON.stringify(forces));
    } catch { /* ignore */ }
    renderGroups();
    syncSliders();
    syncDisplay();
    if (arrowsEl) arrowsEl.checked = !!display.arrows;
    applyForces();
    if (relayout && data) {
      rebuild(false);
      autoFit = true;
      reheat(0.6);
    }
  }

  // ---------- presets ----------
  // Each account saves named presets of its graph settings for this vault. "Other presets" lists everyone else's
  // presets for this vault; loading one copies it into your own settings (theirs is not changed).
  const presetMineEl = wrap.querySelector("[data-preset-mine]");
  const presetNameEl = wrap.querySelector("[data-preset-name]");
  const presetSaveEl = wrap.querySelector("[data-preset-save]");
  const presetDeleteEl = wrap.querySelector("[data-preset-delete]");
  const presetOthersEl = wrap.querySelector("[data-preset-others]");
  const presetMenuEl = wrap.querySelector("[data-preset-menu]");
  const presetStatusEl = wrap.querySelector("[data-preset-status]");
  let mine = [], others = [];

  const say = (text) => { if (presetStatusEl) presetStatusEl.textContent = text; };

  async function presetApi(method, path, body) {
    const res = await fetch(`${settingsApi}/${path}`, {
      method,
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf, Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let out = null;
    try { out = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new Error((out && out.error) || `The server answered ${res.status}.`);
    return out;
  }

  function presetLists(st) {
    mine = Array.isArray(st.mine) ? st.mine : [];
    others = Array.isArray(st.others) ? st.others : [];
    renderPresets();
  }

  async function reloadPresets(selectId) {
    try {
      presetLists(await presetApi("GET", "settings"));
      if (selectId !== undefined && presetMineEl) {
        presetMineEl.value = String(selectId);
        presetDeleteEl.disabled = !presetMineEl.value;
      }
    } catch (e) { say(`Could not load the presets: ${e.message}`); }
  }

  function renderPresets() {
    if (presetMineEl) {
      const keep = presetMineEl.value;
      presetMineEl.replaceChildren(new Option(mine.length ? "Choose a preset to load…" : "No presets yet", ""));
      for (const p of mine) presetMineEl.appendChild(new Option(p.name, String(p.id)));
      presetMineEl.value = mine.some((p) => String(p.id) === keep) ? keep : "";
      presetDeleteEl.disabled = !presetMineEl.value;
    }
    if (presetOthersEl) presetOthersEl.firstChild.textContent = `Other presets${others.length ? ` (${others.length})` : ""} `;
    if (!presetMenuEl) return;
    presetMenuEl.textContent = "";
    if (!others.length) {
      presetMenuEl.appendChild(Object.assign(document.createElement("div"), { className: "pm-empty", textContent: "Nobody else has saved a preset for this vault yet." }));
      return;
    }
    let user = null;
    for (const p of others) {
      if (p.by !== user) {
        user = p.by;
        presetMenuEl.appendChild(Object.assign(document.createElement("div"), { className: "pm-user", textContent: user }));
      }
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.textContent = p.name;
      b.title = `Load ${p.by}'s preset "${p.name}" (forces ${forceId(Object.assign({}, FORCE_DEFAULTS, p.settings && p.settings.forces))})`;
      b.addEventListener("click", () => {
        applySettings(p.settings);
        scheduleSave();
        closeMenu();
        if (presetMineEl) { presetMineEl.value = ""; presetDeleteEl.disabled = true; }
        if (presetNameEl) presetNameEl.value = p.name;
        say(`Loaded ${p.by}'s preset "${p.name}". Save it to keep a copy of your own.`);
      });
      presetMenuEl.appendChild(b);
    }
  }

  function closeMenu() {
    if (!presetMenuEl || presetMenuEl.hidden) return;
    presetMenuEl.hidden = true;
    presetOthersEl.setAttribute("aria-expanded", "false");
  }
  if (presetOthersEl && presetMenuEl) {
    presetOthersEl.addEventListener("click", () => {
      const open = presetMenuEl.hidden;
      presetMenuEl.hidden = !open;
      presetOthersEl.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) { const first = presetMenuEl.querySelector("button"); if (first) first.focus(); }
    });
    document.addEventListener("pointerdown", (e) => { if (!presetMenuEl.hidden && !e.target.closest(".preset-others")) closeMenu(); });
    presetMenuEl.addEventListener("keydown", (e) => {
      const items = [...presetMenuEl.querySelectorAll("button")];
      const i = items.indexOf(document.activeElement);
      if (e.key === "Escape") { closeMenu(); presetOthersEl.focus(); }
      else if (e.key === "ArrowDown" && items.length) { e.preventDefault(); items[(i + 1) % items.length].focus(); }
      else if (e.key === "ArrowUp" && items.length) { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    });
  }

  if (presetMineEl) {
    presetMineEl.addEventListener("change", () => {
      const p = mine.find((x) => String(x.id) === presetMineEl.value);
      presetDeleteEl.disabled = !p;
      if (!p) return;
      applySettings(p.settings);
      scheduleSave();
      if (presetNameEl) presetNameEl.value = p.name;
      say(`Loaded "${p.name}".`);
    });
  }
  async function savePreset() {
    const name = presetNameEl.value.trim();
    if (!name) { say("Type a name for the preset first."); presetNameEl.focus(); return; }
    const replacing = mine.some((p) => p.name === name);
    presetSaveEl.disabled = true;
    try {
      const r = await presetApi("POST", "presets", { name, settings: collectSettings() });
      await reloadPresets(r.id);
      say(replacing ? `Updated "${r.name}".` : `Saved "${r.name}". Others using this vault can load it too.`);
    } catch (e) {
      say(`Not saved: ${e.message}`);
    } finally {
      presetSaveEl.disabled = false;
    }
  }
  if (presetSaveEl && presetNameEl) {
    presetSaveEl.addEventListener("click", savePreset);
    presetNameEl.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); savePreset(); } });
  }
  if (presetDeleteEl) {
    presetDeleteEl.addEventListener("click", async () => {
      const p = mine.find((x) => String(x.id) === presetMineEl.value);
      if (!p || !window.confirm(`Delete the preset "${p.name}"? Others will no longer be able to load it.`)) return;
      try {
        await presetApi("DELETE", `presets/${p.id}`);
        await reloadPresets("");
        say(`Deleted "${p.name}".`);
      } catch (e) { say(`Not deleted: ${e.message}`); }
    });
  }
  if (!settingsApi) {
    const sec = wrap.querySelector("[data-presets]");
    if (sec) sec.hidden = true;
  }

  // Read-only snapshot for debugging and measurements: positions in screen pixels.
  wrap.vsDebug = () => ({
    w: width, h: height, k: view.k,
    nodes: nodes.map((n) => ({ x: n.dx * view.k + view.x, y: n.dy * view.k + view.y, r: drawnR(n) * view.k, deg: n.deg, la: n.la, da: n.da })),
    links: links.map((l) => [nodes.indexOf(l[0]), nodes.indexOf(l[1])]),
  });
})();
