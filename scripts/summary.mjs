// Prints the headline numbers the page shows, straight from the seeded run.
// Usage: node scripts/summary.mjs [seed]
import {
  generateRun, solveRun, toleranceShadow, toleranceCurve, allocateBudget, minBudgetFor, freeTightenTo,
} from '../core/advisor.mjs';

const run = generateRun(Number(process.argv[2] || 20261112));
const me = run.me;
const vols = run.pairs.map((p) => p.vol);
const grid = Array.from({ length: 41 }, (_, k) => k * 5);
const cur = solveRun(run, { [me]: run.tol[me] });
const zero = solveRun(run, { [me]: run.pairs.map(() => 0) });
const curves = run.pairs.map((p, h) => toleranceCurve(run, me, h, grid));
const risk = run.tol[me].reduce((s, T, h) => s + T * vols[h], 0);
const alloc = allocateBudget(curves, vols, risk);
const rec = solveRun(run, { [me]: alloc.T });
const bought = cur.released - zero.released;
const least = minBudgetFor(curves, vols, bought);
const k = (v) => `$${(v * 1000).toFixed(0)}k`;
console.log(`run ${run.runId}: ${run.banks.length} participants, ${run.pairs.length} pairs, ${run.edges.flat().length} netting-set/pair exposures`);
console.log(`network RWA before $${cur.before.toFixed(1)}mm, released $${cur.released.toFixed(1)}mm`);
console.log(`${run.banks[me].code} tolerances ${run.tol[me].join('/')} carry ${k(risk)}/day 1-sigma and buy ${k(bought)} of network RWA`);
console.log(`same risk re-allocated (${alloc.T.map((t) => t.toFixed(1)).join('/')}) buys ${k(rec.released - zero.released)}; today's release needs only ${k(least.spent)}/day`);
run.pairs.forEach((p, h) => {
  const sp = toleranceShadow(cur.pairs[h].sol, me);
  const route = sp.route.map((i) => run.banks[i].code).join('>');
  console.log(`  ${p.name.padEnd(8)} tol ${String(run.tol[me][h]).padStart(3)}  price ${k(sp.price).padStart(5)}/+$1mm  ${route || '-'}  free-to-cut-to ${sp.price > 0 ? '-' : freeTightenTo(run, me, h, run.tol[me][h]).toFixed(1)}`);
});
