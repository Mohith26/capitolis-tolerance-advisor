// Tolerance Advisor core: multilateral FX SA-CCR optimization as a min-cost
// flow per currency pair, plus exact tolerance shadow prices, the cheapest
// residual cycle that explains each shadow price, parametric savings curves,
// and an exact-on-grid tolerance budget allocator.
//
// Units: notionals in USD millions. Pure ES module, no dependencies; runs in
// the browser and under `node --test`.

// ---------------------------------------------------------------- SA-CCR ---
// Margined FX netting sets (VM CSA, MPOR 10 business days).
export const SACCR = {
  alpha: 1.4,
  sfFX: 0.04, // supervisory factor, FX
  mfMargined: 1.5 * Math.sqrt(10 / 250), // maturity factor for margined sets = 0.3
};
// EAD per $1 of hedging-set effective notional (multiplier taken as 1, RC
// unchanged because new trades are at-market).
export const EAD_PER_NOTIONAL = SACCR.alpha * SACCR.sfFX * SACCR.mfMargined; // 0.0168

// Small cost per $M of residual position a participant is left with, so the
// optimizer only uses tolerance when it actually releases exposure. Expressed in
// RWA $M per $M residual. It is ~3% of the cheapest edge weight in the data.
export const RESIDUAL_PENALTY = 1e-4;

// ------------------------------------------------------------ min-cost flow ---
class Graph {
  constructor(n) {
    this.n = n;
    this.adj = Array.from({ length: n }, () => []);
    this.to = []; this.cap = []; this.cost = []; this.flow = []; this.tag = [];
  }
  addArc(u, v, cap, cost, tag) {
    const a = this.to.length;
    this.to.push(v, u); this.cap.push(cap, 0); this.cost.push(cost, -cost);
    this.flow.push(0, 0); this.tag.push(tag, null);
    this.adj[u].push(a); this.adj[v].push(a + 1);
    return a;
  }
  from(a) { return this.to[a ^ 1]; }
  resid(a) { return this.cap[a] - this.flow[a]; }
  push(a, d) { this.flow[a] += d; this.flow[a ^ 1] -= d; }
}

const EPS = 1e-9;

// Solve one currency pair. problem = { n, edges:[{i,j,a,w,L}], tol:[T_i] }.
//   a = effective notional of netting set (i,j) from i's side ($M, signed)
//   w = RWA $M per $M of |effective notional| on this netting set (both sides)
//   L = max new notional the pair may trade in this run
//   T_i = participant i's tolerance: max |net new position| it will accept
// New trade x_e > 0 raises i's position vs j (and lowers j's): flow j -> i.
export function solvePair(problem) {
  const { n, edges, tol } = problem;
  const S = n; // residual-risk sink/source (participants' tolerance)
  const g = new Graph(n + 1);
  const upArcs = [], downArcs = [];
  edges.forEach((e, k) => {
    const { i, j, a, w, L } = e;
    upArcs[k] = []; downArcs[k] = [];
    // up: x > 0 (flow j -> i). Reduces |a + x| while a < 0.
    const upFirst = a < 0 ? Math.min(L, -a) : 0;
    if (upFirst > EPS) upArcs[k].push(g.addArc(j, i, upFirst, -w, { edge: k, dir: 1 }));
    if (L - upFirst > EPS) upArcs[k].push(g.addArc(j, i, L - upFirst, w, { edge: k, dir: 1 }));
    // down: x < 0 (flow i -> j). Reduces |a + x| while a > 0.
    const dnFirst = a > 0 ? Math.min(L, a) : 0;
    if (dnFirst > EPS) downArcs[k].push(g.addArc(i, j, dnFirst, -w, { edge: k, dir: -1 }));
    if (L - dnFirst > EPS) downArcs[k].push(g.addArc(i, j, L - dnFirst, w, { edge: k, dir: -1 }));
  });
  const tolArcs = [];
  for (let i = 0; i < n; i++) {
    const out = g.addArc(i, S, tol[i], RESIDUAL_PENALTY, { tol: i, dir: 1 }); // i left long
    const inn = g.addArc(S, i, tol[i], RESIDUAL_PENALTY, { tol: i, dir: -1 }); // i left short
    tolArcs[i] = { out, inn };
  }

  // 1) saturate negative-cost arcs -> pseudo-flow with nonnegative residual costs
  const excess = new Float64Array(n + 1);
  for (let a = 0; a < g.to.length; a += 2) {
    if (g.cost[a] < 0 && g.cap[a] > EPS) {
      const c = g.cap[a];
      g.push(a, c);
      excess[g.to[a]] += c; excess[g.from(a)] -= c;
    }
  }
  // 2) successive shortest paths (Dijkstra with potentials) excess -> deficit
  const N = n + 1;
  const pi = new Float64Array(N);
  let guard = 0;
  for (;;) {
    let s = -1;
    for (let v = 0; v < N; v++) if (excess[v] > 1e-7) { s = v; break; }
    if (s < 0) break;
    if (++guard > 100000) throw new Error('SSP did not converge');
    const dist = new Float64Array(N).fill(Infinity);
    const prevArc = new Int32Array(N).fill(-1);
    const done = new Uint8Array(N);
    dist[s] = 0;
    for (;;) {
      let u = -1, best = Infinity;
      for (let v = 0; v < N; v++) if (!done[v] && dist[v] < best) { best = dist[v]; u = v; }
      if (u < 0) break;
      done[u] = 1;
      for (const a of g.adj[u]) {
        if (g.resid(a) <= EPS) continue;
        const v = g.to[a];
        const rc = g.cost[a] + pi[u] - pi[v];
        const nd = dist[u] + Math.max(0, rc); // clamp tiny negative float noise
        if (nd < dist[v] - 1e-15) { dist[v] = nd; prevArc[v] = a; }
      }
    }
    // nearest deficit node
    let t = -1, dt = Infinity;
    for (let v = 0; v < N; v++) if (excess[v] < -1e-7 && dist[v] < dt) { dt = dist[v]; t = v; }
    if (t < 0) throw new Error('infeasible: excess cannot reach a deficit');
    let d = Math.min(excess[s], -excess[t]);
    for (let v = t; v !== s; v = g.from(prevArc[v])) d = Math.min(d, g.resid(prevArc[v]));
    for (let v = t; v !== s; v = g.from(prevArc[v])) g.push(prevArc[v], d);
    excess[s] -= d; excess[t] += d;
    for (let v = 0; v < N; v++) pi[v] += Math.min(dist[v], dt);
  }

  // extract trades
  const x = edges.map((e, k) => {
    let v = 0;
    for (const a of upArcs[k]) v += g.flow[a];
    for (const a of downArcs[k]) v -= g.flow[a];
    return Math.abs(v) < 1e-7 ? 0 : v;
  });
  const residual = new Float64Array(n);
  for (let i = 0; i < n; i++) residual[i] = g.flow[tolArcs[i].out] - g.flow[tolArcs[i].inn];
  return { g, x, residual, tolArcs, S, problem };
}

// Objective pieces for a solution (true convex cost, using netted trades).
export function evaluate(problem, x) {
  const { n, edges } = problem;
  let before = 0, after = 0;
  const own = new Float64Array(n); // RWA $M released per participant
  const ownEad = new Float64Array(n);
  edges.forEach((e, k) => {
    const b = Math.abs(e.a), f = Math.abs(e.a + x[k]);
    before += e.w * b; after += e.w * f;
    own[e.i] += e.wi * (b - f); own[e.j] += e.wj * (b - f);
    ownEad[e.i] += EAD_PER_NOTIONAL * (b - f); ownEad[e.j] += EAD_PER_NOTIONAL * (b - f);
  });
  return { before, after, released: before - after, own, ownEad };
}

// Bellman-Ford on the residual graph of an optimal flow, from `src`, skipping
// one arc pair (the tolerance arc being priced). Returns dist and predecessor arcs.
function residualShortest(g, src, skip) {
  const N = g.n;
  const dist = new Float64Array(N).fill(Infinity);
  const prev = new Int32Array(N).fill(-1);
  dist[src] = 0;
  for (let it = 0; it < N; it++) {
    let changed = false;
    for (let u = 0; u < N; u++) {
      if (dist[u] === Infinity) continue;
      for (const a of g.adj[u]) {
        if ((a >> 1) === (skip >> 1)) continue;
        if (g.resid(a) <= EPS) continue;
        const v = g.to[a];
        const nd = dist[u] + g.cost[a];
        if (nd < dist[v] - 1e-12) { dist[v] = nd; prev[v] = a; changed = true; }
      }
    }
    if (!changed) break;
  }
  return { dist, prev };
}

// Exact right-derivative of the optimal objective w.r.t. participant i's
// tolerance: the most negative residual cycle through i's tolerance arc.
// Returns RWA $M released per extra $M of tolerance, the direction (long/short)
// and the route of the improving cycle (participants it trades through).
export function toleranceShadow(sol, i) {
  const { g, tolArcs, S } = sol;
  let best = { price: 0, eadPrice: 0, dir: 0, route: [], bottleneck: 0 };
  for (const [arc, dir] of [[tolArcs[i].out, 1], [tolArcs[i].inn, -1]]) {
    if (g.resid(arc) > 1e-7) continue; // not binding in this direction
    const u = g.from(arc), v = g.to[arc];
    // extra capacity on u->v, then cheapest residual path v ~> u
    const { dist, prev } = residualShortest(g, v, arc);
    if (dist[u] === Infinity) continue;
    const gain = -(g.cost[arc] + dist[u]);
    if (gain > best.price + 1e-12) {
      const path = [];
      let bott = Infinity;
      for (let w = u; w !== v; w = g.from(prev[w])) { path.push(prev[w]); bott = Math.min(bott, g.resid(prev[w])); }
      path.reverse();
      // Cycle: extra tolerance arc u->v, then path v ~> u. Report the trade chain
      // starting at the participant and ending at whoever absorbs the residual.
      let nodes = [v, ...path.map((a) => g.to[a])].filter((z) => z !== S);
      if (nodes[0] !== i) nodes = nodes.reverse();
      // EAD view of the same cycle: every netting-set arc moves |EN| by 1 on both sides.
      let eadPrice = 0;
      for (const a of path) if (!g.tag[a & ~1] || g.tag[a & ~1].edge !== undefined) eadPrice -= Math.sign(g.cost[a]) * 2 * EAD_PER_NOTIONAL;
      best = { price: gain, eadPrice, dir, route: nodes, arcs: path, bottleneck: bott };
    }
  }
  return best;
}

// --------------------------------------------------------------- full run ---
export function solveRun(run, tolOverride) {
  const out = run.pairs.map((p, h) => {
    const tol = run.banks.map((b, i) => (tolOverride && tolOverride[i] && tolOverride[i][h] != null) ? tolOverride[i][h] : run.tol[i][h]);
    const problem = { n: run.banks.length, edges: run.edges[h], tol };
    const sol = solvePair(problem);
    return { sol, ev: evaluate(problem, sol.x) };
  });
  const before = out.reduce((s, o) => s + o.ev.before, 0);
  const after = out.reduce((s, o) => s + o.ev.after, 0);
  return { pairs: out, before, after, released: before - after };
}

// Savings for participant `me` (and network) as a function of its tolerance in
// currency pair h, holding everything else fixed. Exact re-solve per point.
export function toleranceCurve(run, me, h, grid) {
  const n = run.banks.length;
  return grid.map((T) => {
    const tol = run.banks.map((b, i) => (i === me ? T : run.tol[i][h]));
    const problem = { n, edges: run.edges[h], tol };
    const sol = solvePair(problem);
    const ev = evaluate(problem, sol.x);
    // value = the LP objective being maximized (RWA released minus the small
    // residual-risk penalty); exactly concave in T. network = RWA released.
    const value = ev.released - RESIDUAL_PENALTY * sol.residual.reduce((s, r) => s + Math.abs(r), 0);
    const networkEad = run.edges[h].reduce((s, e, k) => s + 2 * EAD_PER_NOTIONAL * (Math.abs(e.a) - Math.abs(e.a + sol.x[k])), 0);
    return { T, value, network: ev.released, networkEad, own: ev.own[me], ownEad: ev.ownEad[me], residual: sol.residual[me] };
  });
}

// LP objective of one pair (RWA released minus the residual-risk penalty) with
// participant `me` at tolerance T and everyone else at their submissions.
export function pairValue(run, me, h, T) {
  const tol = run.banks.map((b, i) => (i === me ? T : run.tol[i][h]));
  const problem = { n: run.banks.length, edges: run.edges[h], tol };
  const sol = solvePair(problem);
  return evaluate(problem, sol.x).released - RESIDUAL_PENALTY * sol.residual.reduce((s, r) => s + Math.abs(r), 0);
}

// Smallest tolerance that keeps the pair's optimum (within 1e-7), found by
// bisection on exact re-solves. Valid because the value is non-decreasing in T.
export function freeTightenTo(run, me, h, T, iters = 30) {
  const target = pairValue(run, me, h, T) - 1e-7;
  if (pairValue(run, me, h, 0) >= target) return 0;
  let lo = 0, hi = T;
  for (let k = 0; k < iters; k++) {
    const mid = (lo + hi) / 2;
    if (pairValue(run, me, h, mid) >= target) hi = mid; else lo = mid;
  }
  return hi;
}

// Allocate a residual-risk budget B (sum_h vol_h * T_h, $M of 1-day 1-sigma P&L)
// across currency pairs to maximize network RWA released. Each pair's optimal
// value is concave piecewise-linear in T_h (LP right-hand-side parametrics), so
// greedy by marginal-gain-per-unit-risk over grid segments is exact on the grid.
export function allocateBudget(curves, vols, B) {
  const H = curves.length;
  const idx = new Array(H).fill(0);
  let spent = 0;
  const T = new Array(H).fill(0);
  for (let guard = 0; guard < 100000; guard++) {
    let bestH = -1, bestRatio = 1e-12;
    for (let h = 0; h < H; h++) {
      const c = curves[h];
      if (idx[h] + 1 >= c.length) continue;
      const dT = c[idx[h] + 1].T - c[idx[h]].T;
      const dV = c[idx[h] + 1].value - c[idx[h]].value;
      const ratio = dV / (dT * vols[h]);
      if (ratio > bestRatio) { bestRatio = ratio; bestH = h; }
    }
    if (bestH < 0) break;
    const c = curves[bestH];
    const dT = c[idx[bestH] + 1].T - c[idx[bestH]].T;
    const room = B - spent;
    if (room <= 1e-12) break;
    if (dT * vols[bestH] <= room + 1e-12) {
      idx[bestH]++; T[bestH] = c[idx[bestH]].T; spent += dT * vols[bestH];
    } else {
      T[bestH] = c[idx[bestH]].T + room / vols[bestH]; spent = B; break;
    }
  }
  return { T, spent };
}

// Inverse question: the least residual-risk budget that buys at least `target`
// of objective value (sum over pairs of curve value above its T=0 value).
// Same greedy order, so it is exact on the grid by the same concavity argument.
export function minBudgetFor(curves, vols, target) {
  const H = curves.length;
  const idx = new Array(H).fill(0);
  const T = new Array(H).fill(0);
  let spent = 0, got = 0;
  if (target <= 1e-12) return { T, spent, got };
  for (let guard = 0; guard < 100000; guard++) {
    let bestH = -1, bestRatio = 1e-12;
    for (let h = 0; h < H; h++) {
      const c = curves[h];
      if (idx[h] + 1 >= c.length) continue;
      const ratio = (c[idx[h] + 1].value - c[idx[h]].value) / ((c[idx[h] + 1].T - c[idx[h]].T) * vols[h]);
      if (ratio > bestRatio) { bestRatio = ratio; bestH = h; }
    }
    if (bestH < 0) break;
    const c = curves[bestH], k = idx[bestH];
    const dV = c[k + 1].value - c[k].value, dT = c[k + 1].T - c[k].T;
    if (got + dV >= target - 1e-12) {
      const f = (target - got) / dV;
      T[bestH] = c[k].T + f * dT; spent += f * dT * vols[bestH]; got = target; break;
    }
    idx[bestH]++; T[bestH] = c[idx[bestH]].T; spent += dT * vols[bestH]; got += dV;
  }
  return { T, spent, got };
}

// ----------------------------------------------------------- synthetic data ---
export function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function gauss(rng) { let u = 0; while (u === 0) u = rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()); }

// SA-CCR-relevant counterparty risk weights by external rating (bank exposures).
export const RW_BY_RATING = { 'AA-': 0.2, 'A+': 0.3, A: 0.3, 'A-': 0.3, 'BBB+': 0.5, BBB: 0.5 };

export const BANKS = [
  ['Meridian Bank N.A.', 'MRDN', 'A+'],
  ['Halvard Securities', 'HLVD', 'A'],
  ['Kestrel Capital Markets', 'KSTR', 'A-'],
  ['Northgate Bank', 'NGTE', 'AA-'],
  ['Corvin & Lowe', 'CRVL', 'BBB+'],
  ['Ostrava Banka', 'OSTB', 'A-'],
  ['Pellham Trust', 'PLHM', 'A'],
  ['Saxbury Global', 'SXBY', 'A+'],
  ['Teviot Bank', 'TVIT', 'BBB+'],
  ['Unterberg AG', 'UNTB', 'A'],
  ['Vantor Bancorp', 'VNTR', 'A-'],
  ['Wexley Financial', 'WXLY', 'BBB'],
  ['Yarrow Bank Asia', 'YRRW', 'A'],
  ['Zelmore Markets', 'ZLMR', 'A+'],
];
// Currency pairs with indicative daily vol of a $1M position (1-day 1-sigma, $M).
export const PAIRS = [
  ['EUR/USD', 0.0045], ['USD/JPY', 0.0062], ['GBP/USD', 0.0052], ['AUD/USD', 0.0068],
  ['USD/CAD', 0.0040], ['USD/CHF', 0.0050], ['EUR/GBP', 0.0034], ['USD/CNH', 0.0028],
];
const PAIR_SCALE = [1.0, 0.8, 0.55, 0.4, 0.35, 0.3, 0.3, 0.25]; // relative book sizes

export function generateRun(seed = 20261112) {
  const rng = mulberry32(seed);
  const banks = BANKS.map(([name, code, rating], i) => ({ id: i, name, code, rating, rw: RW_BY_RATING[rating], size: 0.5 + rng() * 1.2 }));
  banks[0].size = 1.35; // viewing participant is a large dealer
  const n = banks.length;
  const pairs = PAIRS.map(([name, vol]) => ({ name, vol }));
  // CSA/ISDA links: dealers mostly connected; a few links absent from the run
  const linked = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (rng() < 0.82 || i === 0) linked.push([i, j]);
  const edges = pairs.map((p, h) => {
    const list = [];
    for (const [i, j] of linked) {
      if (rng() > 0.78) continue; // pair not traded in this netting set
      const mag = Math.exp(Math.log(140) + 1.05 * gauss(rng)) * PAIR_SCALE[h] * Math.sqrt(banks[i].size * banks[j].size);
      const a = Math.round((rng() < 0.5 ? -1 : 1) * mag * 10) / 10;
      const wi = EAD_PER_NOTIONAL * banks[j].rw; // i's RWA per $ |EN| vs j
      const wj = EAD_PER_NOTIONAL * banks[i].rw;
      const L = Math.round(Math.max(Math.abs(a) * 1.6, 120 * PAIR_SCALE[h]) * 10) / 10; // pair credit appetite
      list.push({ i, j, a, wi, wj, w: wi + wj, L });
    }
    return list;
  });
  // Submitted tolerances ($M of net new position, per pair). Typical desks
  // submit round numbers; the viewing bank's are deliberately uneven.
  const steps = [0, 10, 25, 50, 100];
  const tol = banks.map((b, i) => pairs.map((p, h) => {
    if (i === 0) return [50, 50, 5, 10, 25, 25, 25, 0][h]; // generous in majors, tight where it binds
    return Math.round(steps[Math.floor(rng() * steps.length)] * (0.6 + 0.8 * PAIR_SCALE[h]));
  }));
  return { seed, banks, pairs, edges, tol, me: 0, runId: 'FXSACCR-2026-11-12', asOf: '2026-11-11' };
}
