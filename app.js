import {
  generateRun, solveRun, toleranceShadow, toleranceCurve, allocateBudget, minBudgetFor,
  freeTightenTo, EAD_PER_NOTIONAL,
} from './core/advisor.mjs';

const run = generateRun(20261112);
const ME = run.me;
const vols = run.pairs.map((p) => p.vol);
const GRID = Array.from({ length: 41 }, (_, k) => k * 5); // $0mm .. $200mm tolerance
const TMAX = GRID[GRID.length - 1];
const state = { pair: 2, tol: run.tol[ME].slice(), budgetScale: 1 };
// Curves depend only on the other participants' submissions, so they are computed once.
const curves = run.pairs.map((p, h) => toleranceCurve(run, ME, h, GRID));

const $ = (s) => document.querySelector(s);
const fmtMM = (v, d = 1) => `$${v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}mm`;
const fmtK = (v, d = 0) => `$${(v * 1000).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}k`;
const fmtAuto = (v) => (Math.abs(v) >= 1 ? fmtMM(v, 2) : fmtK(v));
const fmtRisk = (v) => (v >= 1 ? fmtMM(v, 2) : fmtK(v)); // $M of 1-day 1-sigma P&L
const fmtT = (t) => (Math.abs(t - Math.round(t)) < 0.05 ? String(Math.round(t)) : t.toFixed(1));
const code = (i) => run.banks[i].code;
const relEad = (pairs) => pairs.reduce((s, o) => s + o.sol.problem.edges.reduce((z, e, k) => z + 2 * EAD_PER_NOTIONAL * (Math.abs(e.a) - Math.abs(e.a + o.sol.x[k])), 0), 0);
const zeroSol = solveRun(run, { [ME]: run.pairs.map(() => 0) });

function computeAll() {
  const sol = solveRun(run, { [ME]: state.tol });
  const submittedRisk = state.tol.reduce((s, T, h) => s + T * vols[h], 0);
  const budget = submittedRisk * state.budgetScale;
  const alloc = allocateBudget(curves, vols, budget);
  const recSol = solveRun(run, { [ME]: alloc.T });
  const bought = sol.released - zeroSol.released; // network RWA your tolerances buy
  const recBought = recSol.released - zeroSol.released;
  const least = minBudgetFor(curves, vols, Math.max(0, bought));
  const rows = run.pairs.map((p, h) => {
    const ps = sol.pairs[h];
    const sp = toleranceShadow(ps.sol, ME);
    const tol = state.tol[h];
    return {
      h, name: p.name, vol: p.vol, tol, residual: ps.sol.residual[ME],
      price: sp.price, eadPrice: sp.eadPrice, route: sp.route, bottleneck: sp.bottleneck,
      ownRwa: ps.ev.own[ME], rec: alloc.T[h],
      free: sp.price > 0 ? tol : freeTightenTo(run, ME, h, Math.min(tol, TMAX)),
      trades: ps.sol.x.filter((v, k) => Math.abs(v) > 1e-6 && (run.edges[h][k].i === ME || run.edges[h][k].j === ME)).length,
      exposures: run.edges[h].filter((e) => e.i === ME || e.j === ME).length,
    };
  });
  const ownRwa = rows.reduce((s, r) => s + r.ownRwa, 0);
  const ownEad = sol.pairs.reduce((s, o) => s + o.ev.ownEad[ME], 0);
  const nTrades = rows.reduce((s, r) => s + r.trades, 0);
  const nExp = rows.reduce((s, r) => s + r.exposures, 0);
  return { sol, recSol, budget, submittedRisk, alloc, bought, recBought, least, rows, ownRwa, ownEad, nTrades, nExp };
}

function kpis(m) {
  const lift = m.recBought - m.bought;
  const mult = m.bought > 1e-9 ? m.recBought / m.bought : null;
  const saved = m.submittedRisk > 0 ? 1 - m.least.spent / m.submittedRisk : 0;
  $('#kpis').innerHTML = `
    <div class="kpi"><div class="kpi-label">Network RWA reduction <i data-lucide="info"></i></div>
      <div class="kpi-value">${fmtMM(m.sol.released)}</div>
      <div class="kpi-sub">${(100 * m.sol.released / m.sol.before).toFixed(1)}% of ${fmtMM(m.sol.before)} in scope</div></div>
    <div class="kpi"><div class="kpi-label">Your RWA reduction</div>
      <div class="kpi-value">${fmtMM(m.ownRwa)}</div>
      <div class="kpi-sub">EAD ${fmtMM(m.ownEad)} · ${m.nTrades} new trades for you</div></div>
    <div class="kpi"><div class="kpi-label">Bought by your tolerances <i data-lucide="info"></i></div>
      <div class="kpi-value">${fmtAuto(m.bought)}</div>
      <div class="kpi-sub">vs. zero tolerances · ${fmtRisk(m.submittedRisk)}/day 1σ risk</div></div>
    <div class="kpi kpi-dark"><div class="kpi-label">Same risk, re-allocated</div>
      <div class="kpi-value">${fmtAuto(m.recBought)}<span class="delta ${lift >= -1e-9 ? 'up' : 'down'}">${lift >= 0 ? '+' : ''}${fmtAuto(lift)}${mult && state.budgetScale === 1 && lift > 1e-6 ? ` · ${mult.toFixed(1)}×` : ''}</span></div>
      <div class="kpi-sub">${state.budgetScale === 1 ? `or keep ${fmtAuto(m.bought)} for ${fmtRisk(m.least.spent)}/day of risk (${saved > 0 ? '−' : ''}${Math.round(100 * saved)}%)` : `budget set to ${Math.round(state.budgetScale * 100)}% of submitted risk`}</div></div>`;
}

function chainHtml(r) {
  return `<span class="route">${r.route.map((z) => `<span class="chip ${z === ME ? 'me' : ''}">${code(z)}</span>`).join('<span class="arr">→</span>')}</span>`;
}

function table(m) {
  $('#tol-body').innerHTML = m.rows.map((r) => {
    const bind = r.price > 0;
    const status = bind ? '<span class="badge bind">Binding</span>' : (r.tol === 0 ? '<span class="badge zero">Zero</span>' : '<span class="badge slack">Slack</span>');
    const recDiff = r.rec - r.tol;
    const same = Math.abs(recDiff) < 0.05;
    const freeTxt = bind || r.tol === 0 ? '<span class="muted">·</span>' : (r.free < r.tol - 0.05 ? `<b>${fmtT(r.free)}</b> <span class="muted">(−${fmtT(r.tol - r.free)})</span>` : fmtT(r.tol));
    return `<tr data-h="${r.h}" class="${r.h === state.pair ? 'sel' : ''}">
      <td class="pair">${r.name}</td>
      <td class="num"><input class="tol" data-h="${r.h}" type="number" min="0" max="${TMAX}" step="5" value="${fmtT(r.tol)}" aria-label="${r.name} tolerance"></td>
      <td class="num">${Math.abs(r.residual) < 0.05 ? '0.0' : (r.residual > 0 ? '+' : '') + r.residual.toFixed(1)}</td>
      <td>${status}</td>
      <td class="num strong">${bind ? fmtK(r.price, 2) : '<span class="muted">·</span>'}</td>
      <td class="num">${bind ? fmtK(r.eadPrice, 1) : '<span class="muted">·</span>'}</td>
      <td class="num">${bind ? (r.bottleneck === Infinity ? 'unbounded' : `next $${r.bottleneck.toFixed(1)}mm`) : '<span class="muted">·</span>'}</td>
      <td>${bind ? chainHtml(r) : '<span class="muted">Nothing to release</span>'}</td>
      <td class="num">${freeTxt}</td>
      <td class="num rec ${same ? '' : recDiff > 0 ? 'up' : 'down'}">${fmtT(r.rec)}${same ? '' : ` <span class="d">(${recDiff > 0 ? '+' : '−'}${fmtT(Math.abs(recDiff))})</span>`}</td>
    </tr>`;
  }).join('');
  document.querySelectorAll('#tol-body tr').forEach((tr) => tr.addEventListener('click', (ev) => {
    if (ev.target.tagName === 'INPUT') return;
    state.pair = +tr.dataset.h; render();
  }));
  document.querySelectorAll('input.tol').forEach((inp) => inp.addEventListener('change', () => {
    const v = Math.min(TMAX, Math.max(0, +inp.value || 0));
    state.tol[+inp.dataset.h] = v; state.pair = +inp.dataset.h; render();
  }));
}

function chart(m) {
  const h = state.pair, c = curves[h], r = m.rows[h];
  const W = 680, H = 250, L = 58, R = 18, T = 18, B = 36;
  const base = c[0].value;
  const ys = c.map((p) => (p.value - base) * 1000); // $k network RWA released by your tolerance
  const ymaxRaw = Math.max(...ys, 1);
  const step = [1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => ymaxRaw / s <= 5) || 1000;
  const ymax = Math.ceil(ymaxRaw * 1.08 / step) * step;
  const X = (v) => L + (v / TMAX) * (W - L - R);
  const Y = (v) => T + (1 - v / ymax) * (H - T - B);
  const interp = (t) => { const k = Math.min(GRID.length - 2, Math.floor(t / 5)); const f = (t - GRID[k]) / 5; return ys[k] + f * (ys[k + 1] - ys[k]); };
  const line = ys.map((v, k) => `${k ? 'L' : 'M'}${X(GRID[k]).toFixed(1)},${Y(v).toFixed(1)}`).join('');
  const area = `${line}L${X(TMAX).toFixed(1)},${Y(0).toFixed(1)}L${X(0).toFixed(1)},${Y(0).toFixed(1)}Z`;
  const gy = [];
  for (let v = 0; v <= ymax + 1e-9; v += step) gy.push(`<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="grid"/><text x="${L - 8}" y="${Y(v) + 4}" class="ax" text-anchor="end">$${v.toLocaleString('en-US')}k</text>`);
  const gx = [0, 25, 50, 75, 100, 125, 150, 175, 200].map((v) => `<text x="${X(v)}" y="${H - 16}" class="ax" text-anchor="middle">${v}</text>`).join('');
  const cur = Math.min(state.tol[h], TMAX), rec = m.alloc.T[h];
  const showRec = Math.abs(rec - cur) > 0.05;
  const labelSide = (x) => (x > W - 140 ? 'end' : 'start');
  const lx = (x) => (x > W - 140 ? x - 6 : x + 6);
  $('#chart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Network RWA released vs your tolerance">
    <defs><linearGradient id="fillg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#FF2EA3" stop-opacity=".18"/><stop offset="1" stop-color="#FF2EA3" stop-opacity="0"/></linearGradient></defs>
    ${gy.join('')}${gx}
    <text x="${(L + W - R) / 2}" y="${H - 1}" class="ax" text-anchor="middle">Your ${r.name} tolerance ($mm of net new position)</text>
    <path d="${area}" class="area"/><path d="${line}" class="ln"/>
    <line x1="${X(cur)}" x2="${X(cur)}" y1="${T}" y2="${H - B}" class="mk cur"/>
    <text x="${lx(X(cur))}" y="${T + 10}" class="mklab" fill="#404040" text-anchor="${labelSide(X(cur))}">Submitted ${fmtT(cur)}</text>
    ${showRec ? `<line x1="${X(rec)}" x2="${X(rec)}" y1="${T}" y2="${H - B}" class="mk rec"/><text x="${lx(X(rec))}" y="${T + 24}" class="mklab" fill="#1411DF" text-anchor="${labelSide(X(rec))}">Suggested ${fmtT(rec)}</text><circle cx="${X(rec)}" cy="${Y(interp(rec))}" r="4.5" class="dot rec"/>` : ''}
    <circle cx="${X(cur)}" cy="${Y(interp(cur))}" r="4.5" class="dot cur"/>
    <line class="hover-line" x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/><circle class="hover-dot" r="4" visibility="hidden"/>
    <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" class="hit"/>
  </svg>`;
  const svg = $('#chart svg'), tip = $('#tip'), hl = svg.querySelector('.hover-line'), hd = svg.querySelector('.hover-dot');
  svg.querySelector('.hit').addEventListener('mousemove', (ev) => {
    const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    const k = Math.max(0, Math.min(GRID.length - 1, Math.round(((p.x - L) / (W - L - R)) * TMAX / 5)));
    const slope = k < GRID.length - 1 ? (ys[k + 1] - ys[k]) / 5 : 0;
    hl.setAttribute('x1', X(GRID[k])); hl.setAttribute('x2', X(GRID[k])); hl.setAttribute('visibility', 'visible');
    hd.setAttribute('cx', X(GRID[k])); hd.setAttribute('cy', Y(ys[k])); hd.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.style.left = `${ev.clientX + 14}px`; tip.style.top = `${ev.clientY - 10}px`;
    tip.innerHTML = `Tolerance <b>$${GRID[k]}mm</b> · releases <b>$${Math.round(ys[k]).toLocaleString('en-US')}k</b> RWA<br>next $1mm: ${slope > 0.005 ? `$${slope.toFixed(2)}k` : 'nothing'}`;
  });
  svg.querySelector('.hit').addEventListener('mouseleave', () => { tip.hidden = true; hl.setAttribute('visibility', 'hidden'); hd.setAttribute('visibility', 'hidden'); });
  $('#chart-title').textContent = `${r.name} · release vs. your tolerance`;
  let note;
  if (r.price > 0) {
    const chain = r.route.map(code).join(' → ');
    const absorber = code(r.route[r.route.length - 1]);
    note = `The next $1mm of ${r.name} tolerance releases <b>${fmtK(r.price, 2)}</b> of network RWA (${fmtK(r.eadPrice, 1)} EAD). The optimizer would spend it on the trade chain <b>${chain}</b>, with ${absorber} taking the offsetting position inside its own tolerance. The price holds for the next ${r.bottleneck === Infinity ? 'unbounded amount' : `$${r.bottleneck.toFixed(1)}mm`}, then steps down.`;
  } else if (r.tol === 0) {
    note = `You submitted zero ${r.name} tolerance and there is no value in adding any: no counterparty in this run can absorb the other side of a trade that would release capital.`;
  } else {
    note = `Your ${r.name} tolerance is slack: loosening it releases nothing${r.free < r.tol - 0.05 ? `, and tightening it from ${fmtT(r.tol)} to <b>${fmtT(r.free)}</b> gives up nothing either (verified by re-solve). That is ${fmtK((r.tol - r.free) * r.vol)}/day of 1σ risk you could carry elsewhere` : ''}.`;
  }
  $('#chart-note').innerHTML = note;
}

function allocPanel(m) {
  const scale = Math.max(TMAX / 2, ...m.rows.map((r) => Math.max(r.tol, r.rec)));
  $('#alloc').innerHTML = m.rows.map((r) => `
    <span class="nm">${r.name}</span>
    <span class="bar" title="Submitted ${fmtT(r.tol)} · suggested ${fmtT(r.rec)}"><span class="r" style="width:${(100 * r.rec / scale).toFixed(1)}%"></span><span class="s" style="width:${(100 * Math.min(r.tol, scale) / scale).toFixed(1)}%"></span></span>
    <span class="v">${fmtT(r.tol)} → <b>${fmtT(r.rec)}</b></span>`).join('');
}

function render() {
  const t0 = performance.now();
  const m = computeAll();
  kpis(m); table(m); chart(m); allocPanel(m);
  $('#budget-val').textContent = `${Math.round(state.budgetScale * 100)}% of submitted · ${fmtRisk(m.budget)}/day 1σ`;
  $('#solve-ms').textContent = `${run.pairs.length} pairs · ${run.pairs.length * GRID.length} curve re-solves (cached) · re-run in ${Math.round(performance.now() - t0)} ms`;
  window.__advisor = m;
  if (window.lucide) window.lucide.createIcons();
}

$('#budget').addEventListener('input', (e) => { state.budgetScale = +e.target.value / 100; render(); });
$('#apply').addEventListener('click', () => {
  const m = window.__advisor;
  state.tol = m.alloc.T.map((t) => Math.round(t * 10) / 10);
  state.budgetScale = 1; $('#budget').value = 100; render();
});
$('#reset').addEventListener('click', () => { state.tol = run.tol[ME].slice(); state.budgetScale = 1; $('#budget').value = 100; render(); });
$('#participant').textContent = `${run.banks[ME].name}`;
render();
