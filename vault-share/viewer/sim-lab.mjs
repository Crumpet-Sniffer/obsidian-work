// Headless measurements of the graph layout physics (not shipped; run with: node sim-lab.mjs path/to/graph.json).
// Mirrors the force setup in graph.js so changes can be compared with numbers instead of by eye.
import { readFileSync } from "node:fs";
import { forceSimulation, forceLink, forceManyBody, forceX, forceY, forceCollide } from "d3-force";

const data = JSON.parse(readFileSync(process.argv[2], "utf8"));
const variant = process.argv[3] || "current";
const OPT = variant.startsWith("{") ? JSON.parse(variant) : {};

const RADIUS_KNOTS = [[0, 4], [1, 4.4], [5, 5.4], [8, 6.8], [10, 7.9], [15, 9.3], [19, 10.5], [25, 12.3], [31, 13.4], [48, 15], [119, 18]];
function radiusFor(deg) {
  const K = RADIUS_KNOTS;
  if (deg >= K[K.length - 1][0]) return K[K.length - 1][1];
  for (let i = 1; i < K.length; i++) if (deg <= K[i][0]) { const [d0, r0] = K[i - 1], [d1, r1] = K[i]; return r0 + ((deg - d0) / (d1 - d0)) * (r1 - r0); }
  return 4;
}

// Seeded RNG so runs are comparable.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

function build(seed, withFiles = !!process.env.FILES) {
  const rand = rng(seed);
  const included = data.nodes.map((n) => n.kind === "note" || withFiles);
  const pairs = new Map();
  for (const [f, t] of data.links) {
    if (!(included[f] && included[t])) continue;
    const lo = Math.min(f, t), hi = Math.max(f, t);
    pairs.set(lo + "|" + hi, [lo, hi]);
  }
  const deg = new Array(data.nodes.length).fill(0);
  for (const [a, b] of pairs.values()) { deg[a]++; deg[b]++; }
  const map = new Map(), nodes = [];
  const spread = 34 * Math.sqrt(data.nodes.length);
  data.nodes.forEach((n, i) => {
    if (!included[i]) return;
    map.set(i, nodes.length);
    let x = (rand() * 2 - 1) * spread, y = (rand() * 2 - 1) * spread;
    if (OPT.disc) { const a = rand() * Math.PI * 2, r = Math.sqrt(rand()) * spread * 1.13; x = Math.cos(a) * r; y = Math.sin(a) * r; }
    nodes.push({ label: n.label, deg: deg[i], r: radiusFor(deg[i]), x, y });
  });
  const links = [...pairs.values()].map(([a, b]) => ({ source: nodes[map.get(a)], target: nodes[map.get(b)] }));
  return { nodes, links, rand };
}

const F = { center: 0.3, repel: 10, link: 1, dist: 60 };
const VARIANTS = {
  current: (nodes, links, rand, held) => forceSimulation(nodes).stop().randomSource(rand)
    .alphaDecay(0.0228).velocityDecay(0.4)
    .force("link", forceLink(links)
      .distance((l) => (held.n && (l.source === held.n || l.target === held.n) ? Math.max(F.dist, 23 * Math.sqrt(held.n.deg)) : F.dist))
      .strength((l) => (held.n && (l.source === held.n || l.target === held.n) ? Math.min(1, 0.3 * F.link) : F.link / Math.max(1, Math.min(l.source.deg, l.target.deg)))))
    .force("charge", forceManyBody().strength(-F.repel * 10))
    .force("x", forceX(0).strength(F.center * 0.1))
    .force("y", forceY(0).strength(F.center * 0.1))
    .force("collide", forceCollide(22).iterations(2)),
};

function nnStats(nodes) {
  const nn = nodes.map((a, i) => { let m = 1e9; for (let j = 0; j < nodes.length; j++) if (i !== j) m = Math.min(m, Math.hypot(a.x - nodes[j].x, a.y - nodes[j].y)); return m; }).sort((a, b) => a - b);
  const q = (p) => +nn[Math.floor(p * (nn.length - 1))].toFixed(1);
  return { min: q(0), p10: q(0.1), p50: q(0.5), p90: q(0.9), max: q(1), touching: +(nn.filter((d) => d < 45).length / nn.length).toFixed(2) };
}
function shape(nodes) {
  const mx = nodes.reduce((s, n) => s + n.x, 0) / nodes.length, my = nodes.reduce((s, n) => s + n.y, 0) / nodes.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const n of nodes) { sxx += (n.x - mx) ** 2; syy += (n.y - my) ** 2; sxy += (n.x - mx) * (n.y - my); }
  const tr = sxx + syy, det = sxx * syy - sxy * sxy, d = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  return { aspect: +Math.sqrt((tr / 2 + d) / (tr / 2 - d)).toFixed(2), rms: Math.round(Math.sqrt(tr / nodes.length)) };
}
function topo(nodes, links) {
  let s = 0, c = 0, gap = 1e9;
  for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) { const d = Math.hypot(nodes[i].x - nodes[j].x, nodes[i].y - nodes[j].y); s += d; c++; gap = Math.min(gap, d - nodes[i].r - nodes[j].r); }
  const ml = links.reduce((a, k) => a + Math.hypot(k.source.x - k.target.x, k.source.y - k.target.y), 0) / links.length;
  return { linkOverPair: +(ml / (s / c)).toFixed(3), minGap: +gap.toFixed(1) };
}
function linkLen(links) {
  const l = links.map((k) => Math.hypot(k.source.x - k.target.x, k.source.y - k.target.y)).sort((a, b) => a - b);
  return { p10: Math.round(l[Math.floor(l.length * 0.1)]), p50: Math.round(l[l.length >> 1]), p90: Math.round(l[Math.floor(l.length * 0.9)]) };
}
function step(sim, nodes) {
  const before = nodes.map((n) => [n.x, n.y]);
  sim.tick();
  let mx = 0, sum = 0;
  nodes.forEach((n, i) => { const d = Math.hypot(n.x - before[i][0], n.y - before[i][1]); mx = Math.max(mx, d); sum += d; });
  return [mx, sum / nodes.length];
}

function param(o) {
  return (nodes, links, rand, held) => {
    const isHeld = (l) => held.n && (l.source === held.n || l.target === held.n);
    const base = (l) => F.link / Math.max(1, (o.linkDeg === "max" ? Math.max : Math.min)(l.source.deg, l.target.deg)) * (o.linkMul || 1);
    const sim = forceSimulation(nodes).stop().randomSource(rand)
      .alphaDecay(o.alphaDecay ?? 0.0228).velocityDecay(o.velocityDecay ?? 0.4)
      .force("link", forceLink(links)
        .distance((l) => (isHeld(l) ? Math.max(F.dist, (o.heldDist ?? 23) * Math.sqrt(held.n.deg)) : F.dist))
        .strength((l) => (isHeld(l) ? Math.max(base(l), o.heldStrength ?? 0.3) : base(l))))
      .force("charge", forceManyBody().strength(o.charge ?? -100).distanceMax(o.distanceMax ?? Infinity).theta(o.theta ?? 0.9))
      .force("x", forceX(0).strength(o.center ?? 0.03))
      .force("y", forceY(0).strength(o.center ?? 0.03));
    if (o.collide !== 0) sim.force("collide", forceCollide(o.collideR ?? 22).strength(o.collide ?? 1).iterations(o.collideIt ?? 2));
    if (o.anneal != null) {
      const tick = sim.tick.bind(sim);
      sim.tick = () => {
        // soft while hot (nodes can flow past each other), firm once cool
        const a = sim.alpha(), t = Math.min(1, Math.max(0, (a - (o.annealLo ?? 0.05)) / ((o.annealHi ?? 0.5) - (o.annealLo ?? 0.05))));
        sim.force("collide").strength((o.collide ?? 1) + (o.anneal - (o.collide ?? 1)) * t);
        return tick();
      };
    }
    return sim;
  };
}
const make = VARIANTS[variant] || param(JSON.parse(variant));
const out = {};

// 1. Settle from a random scatter.
{
  const { nodes, links, rand } = build(1);
  const held = { n: null };
  const sim = make(nodes, links, rand, held);
  const tr = [];
  while (sim.alpha() > sim.alphaMin()) tr.push(step(sim, nodes));
  const at = (i) => tr[i] ? [i, +tr[i][0].toFixed(2), +tr[i][1].toFixed(3)] : null;
  out.settle = {
    ticks: tr.length,
    speed_tick_max_mean: [0, 20, 60, 100, 150, 200, 250, 299].map(at),
    lastTickAbove: { "1px": tr.map((t, i) => (t[0] > 1 ? i : -1)).filter((i) => i >= 0).pop(), "0.25px": tr.map((t, i) => (t[0] > 0.25 ? i : -1)).filter((i) => i >= 0).pop(), "0.05px": tr.map((t, i) => (t[0] > 0.05 ? i : -1)).filter((i) => i >= 0).pop() },
    nn: nnStats(nodes), shape: shape(nodes), link: linkLen(links), topo: topo(nodes, links),
  };
  // 2. Was that an equilibrium, or just where the cooling stopped? Reheat without moving anything and see how far it goes.
  const frozen = nodes.map((n) => [n.x, n.y]);
  sim.alpha(1);
  while (sim.alpha() > sim.alphaMin()) sim.tick();
  const moved = nodes.map((n, i) => Math.hypot(n.x - frozen[i][0], n.y - frozen[i][1])).sort((a, b) => a - b);
  out.reheat = { moved_p50: +moved[moved.length >> 1].toFixed(1), moved_p90: +moved[Math.floor(moved.length * 0.9)].toFixed(1), moved_max: +moved[moved.length - 1].toFixed(1), shape: shape(nodes), nn: nnStats(nodes) };

  // 3. Drag the biggest hub 300px in 30 ticks, hold 60 ticks, release.
  const hub = nodes.reduce((a, b) => (b.deg > a.deg ? b : a));
  const nb = links.filter((l) => l.source === hub || l.target === hub).map((l) => (l.source === hub ? l.target : l.source));
  const meanNb = () => nb.reduce((s, n) => s + Math.hypot(n.x - hub.x, n.y - hub.y), 0) / nb.length;
  const home = [hub.x, hub.y], d0 = meanNb();
  const cen0 = [nb.reduce((s, n) => s + n.x, 0) / nb.length, nb.reduce((s, n) => s + n.y, 0) / nb.length];
  held.n = hub; sim.force("link").distance(sim.force("link").distance()).strength(sim.force("link").strength());
  sim.alphaTarget(0.3);
  hub.fx = hub.x; hub.fy = hub.y;
  const dragTrace = [];
  for (let i = 1; i <= 90; i++) {
    if (i <= 30) hub.fx = home[0] + 10 * i;
    sim.tick();
    if (i % 15 === 0) dragTrace.push([i, Math.round(meanNb())]);
  }
  const cen1 = [nb.reduce((s, n) => s + n.x, 0) / nb.length, nb.reduce((s, n) => s + n.y, 0) / nb.length];
  held.n = null; sim.force("link").distance(sim.force("link").distance()).strength(sim.force("link").strength());
  hub.fx = hub.fy = null; sim.alphaTarget(0);
  const rel = []; let t = 0;
  while (sim.alpha() > sim.alphaMin()) { const s = step(sim, nodes); t++; if (t % 40 === 0) rel.push([t, Math.round(Math.hypot(hub.x - home[0], hub.y - home[1])), +s[0].toFixed(2)]); }
  out.drag = {
    hubDeg: hub.deg, neighbourMeanDist_before: Math.round(d0), duringDrag_tick_meanDist: dragTrace,
    neighbourCentroidFollowed_px: Math.round(Math.hypot(cen1[0] - cen0[0], cen1[1] - cen0[1])),
    afterRelease_tick_hubFromHome_maxSpeed: rel, ticksToCool: t, nn: nnStats(nodes),
  };
}

// 4. Repeatability across seeds: shape and time.
out.seeds = [2, 3, 4, 5].map((s) => {
  const { nodes, links, rand } = build(s);
  const sim = make(nodes, links, rand, { n: null });
  const t0 = performance.now(); let n = 0;
  while (sim.alpha() > sim.alphaMin()) { sim.tick(); n++; }
  return { ...shape(nodes), touching: nnStats(nodes).touching, msPerTick: +((performance.now() - t0) / n).toFixed(2) };
});

console.log(JSON.stringify(out, null, 1));
