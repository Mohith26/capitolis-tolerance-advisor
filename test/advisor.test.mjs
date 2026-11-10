import test from 'node:test';
import assert from 'node:assert/strict';
import {
  solvePair, evaluate, toleranceShadow, toleranceCurve, allocateBudget,
  generateRun, solveRun, mulberry32, RESIDUAL_PENALTY, minBudgetFor, freeTightenTo, pairValue,
} from '../core/advisor.mjs';

const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b));

function feasible(problem, sol) {
  const { n, edges, tol } = problem;
  const bal = new Float64Array(n);
  edges.forEach((e, k) => {
    assert.ok(Math.abs(sol.x[k]) <= e.L + 1e-6, `edge ${k} over limit`);
    bal[e.i] += sol.x[k]; bal[e.j] -= sol.x[k];
  });
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(bal[i]) <= tol[i] + 1e-6, `bank ${i} residual ${bal[i]} > tol ${tol[i]}`);
    assert.ok(close(bal[i], sol.residual[i], 1e-6), 'residual bookkeeping');
  }
}

// Optimality certificate for min-cost flow: no negative-cost cycle in the residual graph.
function noNegativeCycle(sol) {
  const g = sol.g, N = g.n;
  const d = new Float64Array(N).fill(0);
  for (let it = 0; it < N + 1; it++) {
    let changed = false;
    for (let u = 0; u < N; u++) for (const a of g.adj[u]) {
      if (g.cap[a] - g.flow[a] <= 1e-9) continue;
      const v = g.to[a];
      if (d[u] + g.cost[a] < d[v] - 1e-9) { d[v] = d[u] + g.cost[a]; changed = true; }
    }
    if (!changed) return true;
  }
  return false;
}

function randomProblem(seed, n = 7) {
  const r = mulberry32(seed);
  const edges = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (r() < 0.35) continue;
    const a = Math.round((r() - 0.5) * 400);
    const wi = 0.005 + r() * 0.01, wj = 0.005 + r() * 0.01;
    edges.push({ i, j, a, wi, wj, w: wi + wj, L: Math.round(50 + r() * 300) });
  }
  const tol = Array.from({ length: n }, () => [0, 0, 10, 25, 60][Math.floor(r() * 5)]);
  return { n, edges, tol };
}

test('fully circular exposure compresses to zero with zero tolerance', () => {
  const w = 0.01;
  const problem = { n: 3, tol: [0, 0, 0], edges: [
    { i: 0, j: 1, a: 100, wi: w / 2, wj: w / 2, w, L: 500 },
    { i: 1, j: 2, a: 100, wi: w / 2, wj: w / 2, w, L: 500 },
    { i: 0, j: 2, a: -100, wi: w / 2, wj: w / 2, w, L: 500 },
  ] };
  const sol = solvePair(problem);
  feasible(problem, sol);
  const ev = evaluate(problem, sol.x);
  assert.ok(close(ev.after, 0, 1e-9));
  assert.deepEqual(sol.x.map((v) => Math.round(v)), [-100, -100, 100]);
});

test('non-circular exposure needs tolerance; shadow price prices it exactly', () => {
  // bank 0 long 100 vs bank 1, nothing else: cannot reduce without residual risk
  const w = 0.01;
  const base = { n: 2, edges: [{ i: 0, j: 1, a: 100, wi: w / 2, wj: w / 2, w, L: 500 }] };
  const tight = solvePair({ ...base, tol: [0, 0] });
  assert.equal(tight.x[0], 0);
  const sp = toleranceShadow(tight, 0);
  // one more $M of tolerance for bank 0 still needs bank 1 to absorb -> 0
  assert.equal(sp.price, 0);
  const both = solvePair({ ...base, tol: [30, 30] });
  assert.ok(close(both.x[0], -30));
  // with bank 1 loose, bank 0's tolerance is worth w - 2*penalty per $M
  const loose1 = solvePair({ ...base, tol: [30, 1000] });
  const sp0 = toleranceShadow(loose1, 0);
  assert.ok(close(sp0.price, w - 2 * RESIDUAL_PENALTY, 1e-9), `price ${sp0.price}`);
});

test('random instances: feasible and optimal (no negative residual cycle)', () => {
  for (let s = 1; s <= 60; s++) {
    const p = randomProblem(1000 + s, 5 + (s % 5));
    const sol = solvePair(p);
    feasible(p, sol);
    assert.ok(noNegativeCycle(sol), `seed ${s} not optimal`);
    const ev = evaluate(p, sol.x);
    assert.ok(ev.after <= ev.before + 1e-9, 'never worse than doing nothing');
  }
});

test('shadow price equals the finite-difference slope of the re-solved optimum', () => {
  let checked = 0;
  for (let s = 1; s <= 80 && checked < 25; s++) {
    const p = randomProblem(5000 + s, 7);
    const sol = solvePair(p);
    const obj = (q, so) => evaluate(q, so.x).after + RESIDUAL_PENALTY * so.residual.reduce((z, r) => z + Math.abs(r), 0);
    const base = obj(p, sol);
    for (let i = 0; i < p.n; i++) {
      const sp = toleranceShadow(sol, i);
      const delta = Math.min(1e-3, sp.price > 0 ? sp.bottleneck / 2 : 1e-3);
      const tol2 = p.tol.slice(); tol2[i] += delta;
      const p2 = { ...p, tol: tol2 };
      const sol2 = solvePair(p2);
      const slope = (base - obj(p2, sol2)) / delta;
      assert.ok(Math.abs(slope - sp.price) < 1e-6, `seed ${s} bank ${i}: dual ${sp.price} vs fd ${slope}`);
      if (sp.price > 0) checked++;
    }
  }
  assert.ok(checked >= 10, `only ${checked} binding tolerances exercised`);
});

test('savings curve is non-decreasing and concave in own tolerance', () => {
  const run = generateRun(20261112);
  const grid = Array.from({ length: 21 }, (_, k) => k * 10);
  for (let h = 0; h < run.pairs.length; h++) {
    const c = toleranceCurve(run, 0, h, grid);
    for (let k = 1; k < c.length; k++) assert.ok(c[k].value >= c[k - 1].value - 1e-9);
    for (let k = 1; k + 1 < c.length; k++) {
      const s1 = c[k].value - c[k - 1].value, s2 = c[k + 1].value - c[k].value;
      assert.ok(s2 <= s1 + 1e-7, `pair ${h} not concave at ${k}`);
    }
  }
});

test('budget allocator respects the risk budget and beats the submitted mix', () => {
  const run = generateRun(20261112);
  const me = 0;
  const vols = run.pairs.map((p) => p.vol);
  const budget = run.tol[me].reduce((s, T, h) => s + T * vols[h], 0);
  const grid = Array.from({ length: 41 }, (_, k) => k * 5);
  const curves = run.pairs.map((p, h) => toleranceCurve(run, me, h, grid));
  const { T, spent } = allocateBudget(curves, vols, budget);
  assert.ok(spent <= budget + 1e-9);
  const used = T.reduce((s, t, h) => s + t * vols[h], 0);
  assert.ok(used <= budget + 1e-9);
  const cur = solveRun(run);
  const opt = solveRun(run, { [me]: T });
  assert.ok(opt.released >= cur.released - 1e-9, `${opt.released} < ${cur.released}`);
});

test('generator is deterministic and internally consistent', () => {
  const a = generateRun(7), b = generateRun(7);
  assert.deepEqual(JSON.stringify(a), JSON.stringify(b));
  for (const list of a.edges) for (const e of list) {
    assert.ok(e.i < e.j && e.L >= Math.abs(e.a) - 1e-9 && close(e.w, e.wi + e.wj));
  }
});

test('improving trade chain starts at the participant and ends at a counterparty with spare tolerance', () => {
  let seen = 0;
  for (let s = 1; s <= 60; s++) {
    const p = randomProblem(9000 + s, 7);
    const sol = solvePair(p);
    for (let i = 0; i < p.n; i++) {
      const sp = toleranceShadow(sol, i);
      if (!(sp.price > 0)) continue;
      seen++;
      assert.equal(sp.route[0], i, 'chain starts at the participant');
      const last = sp.route[sp.route.length - 1];
      assert.notEqual(last, i);
      // the absorber still has tolerance room on the opposite side of the participant's move
      if (sp.dir === 1) assert.ok(sol.residual[last] > -p.tol[last] + 1e-9, 'absorber has short-side room');
      else assert.ok(sol.residual[last] < p.tol[last] - 1e-9, 'absorber has long-side room');
      // consecutive participants in the chain share a netting set in this pair
      for (let k = 0; k + 1 < sp.route.length; k++) {
        const [u, v] = [sp.route[k], sp.route[k + 1]];
        assert.ok(p.edges.some((e) => (e.i === u && e.j === v) || (e.i === v && e.j === u)), `no netting set ${u}-${v}`);
      }
    }
  }
  assert.ok(seen >= 10, `only ${seen} chains checked`);
});

test('least-risk budget reproduces the current tolerance-driven release', () => {
  const run = generateRun(20261112);
  const me = 0;
  const vols = run.pairs.map((p) => p.vol);
  const grid = Array.from({ length: 41 }, (_, k) => k * 5);
  const curves = run.pairs.map((p, h) => toleranceCurve(run, me, h, grid));
  const zero = solveRun(run, { [me]: run.pairs.map(() => 0) });
  const cur = solveRun(run, { [me]: run.tol[me] });
  const target = cur.released - zero.released;
  assert.ok(target > 0);
  const budget = run.tol[me].reduce((s, T, h) => s + T * vols[h], 0);
  const { T, spent } = minBudgetFor(curves, vols, target * 0.999);
  assert.ok(spent < budget, `${spent} >= ${budget}`);
  const re = solveRun(run, { [me]: T });
  assert.ok(re.released - zero.released >= target * 0.995, `${re.released - zero.released} < ${target}`);
});

test('free-to-tighten level keeps the optimum and anything lower loses value', () => {
  const run = generateRun(20261112);
  let strict = 0;
  for (let h = 0; h < run.pairs.length; h++) {
    const T = run.tol[0][h];
    const t = freeTightenTo(run, 0, h, T);
    assert.ok(t <= T + 1e-9);
    assert.ok(pairValue(run, 0, h, t) >= pairValue(run, 0, h, T) - 1e-6, `pair ${h}`);
    if (t > 0.01) { strict++; assert.ok(pairValue(run, 0, h, t - 0.01) < pairValue(run, 0, h, T) - 1e-9, `pair ${h} could go lower`); }
  }
  assert.ok(strict >= 1);
});
