// The real test: the frozen model (logistic regression, λ=0.01, all features, retrained monthly on the
// previous 24 months) against actual Polymarket 15-minute markets: official outcomes, the price the
// market was charging when you'd have bet, and the 0.05 × p × (1 − p) taker fee.
// These windows (Sep–Nov 2026) were never used to choose the model.
// Usage: node src/evaluate_polymarket.mjs [lag=0]   (lag -1 = decide one minute before the window opens)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMinutes, ROOT, minuteIso } from './data.mjs';
import { buildDataset } from './features.mjs';
import { fitLogistic, score } from './models.mjs';

const LAG = Number(process.argv[2] || 0);
const d = loadMinutes();
const ds = buildDataset(d, { lag: LAG });
const month = (i) => minuteIso(ds.T[i]).slice(0, 7);
const months = [...new Set(Array.from({ length: ds.rows }, (_, i) => month(i)))];
const byMonth = new Map(months.map((m) => [m, []]));
for (let i = 0; i < ds.rows; i++) byMonth.get(month(i)).push(i);
const rowOf = new Map(Array.from({ length: ds.rows }, (_, i) => [ds.T[i], i]));

// Walk-forward predictions for the evaluation months only.
const pm = readFileSync(join(ROOT, 'data', 'polymarket_15m.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((w) => w.resolvedUp !== null && !w.missing && w.history?.length);
const evalMonths = [...new Set(pm.map((w) => new Date(w.t * 1000).toISOString().slice(0, 7)))].sort();
const pred = new Map();
for (const em of evalMonths) {
  const mi = months.indexOf(em);
  if (mi < 24) continue;
  const model = fitLogistic(ds, months.slice(mi - 24, mi).flatMap((m) => byMonth.get(m)), { lambda: 1e-2 });
  for (const i of byMonth.get(em) ?? []) pred.set(ds.T[i], model.predict(i));
}

// Market price of "Up" as of a moment: the latest history point at or before it (no older than 90 s).
function priceAt(hist, ts) {
  let best = null;
  for (const [t, p] of hist) if (t <= ts && ts - t <= 90) best = p;
  return best;
}
const fee = (p, rate) => rate * p * (1 - p); // per share

const windows = pm.map((w) => {
  const minute = w.t / 60;
  const i = rowOf.get(minute);
  return { ...w, minute, row: i, p: pred.get(minute), proxyUp: i !== undefined ? ds.y[i] === 1 : null };
}).filter((w) => w.p !== undefined && w.row !== undefined);

// 1) Does our Binance-based label match Polymarket's official Chainlink result?
const agree = windows.filter((w) => w.proxyUp === w.resolvedUp).length;
console.log(`${windows.length} settled Polymarket windows with model predictions (${minuteIso(windows.at(-1).minute)} → ${minuteIso(windows[0].minute)})`);
console.log(`Binance label matches official result: ${(100 * agree / windows.length).toFixed(1)}%`);
console.log(`Official Up rate: ${(100 * windows.filter((w) => w.resolvedUp).length / windows.length).toFixed(1)}%`);

// 2) Model accuracy against official results.
const s = score(windows.map((w) => w.p), windows.map((w) => (w.resolvedUp ? 1 : 0)));
console.log(`Model vs official results: acc ${(100 * s.acc).toFixed(2)}% (z=${s.z.toFixed(1)}), AUC ${s.auc.toFixed(4)}`);
for (const b of s.buckets) console.log(`   edge ≥ ${(100 * b.minEdge).toFixed(0)}%: ${b.n} windows, acc ${(100 * b.acc).toFixed(2)}%`);

// 3) Against the market's price. For each entry moment, bet the model's side only when the model's
//    probability beats the price + fee + a half-cent spread by `margin`.
const SPREAD = 0.005;
const results = [];
// Only entry moments at or after the decision time (when the model's inputs actually exist).
for (const offset of [-120, -90, -60, -45, -30, -15, 0, 15, 30, 60].filter((o) => o >= LAG * 60)) {
  for (const rate of [0.05, 0.01]) {
    for (const margin of [0, 0.02, 0.04, 0.06]) {
      let bets = 0, wins = 0, cost = 0, pnl = 0;
      const pts = [];
      for (const w of windows) {
        const up = priceAt(w.history, w.t + offset);
        if (up === null) continue;
        pts.push([w.p, up]);
        const sideUp = w.p >= 0.5;
        const ask = (sideUp ? up : 1 - up) + SPREAD;
        if (ask <= 0.01 || ask >= 0.99) continue;
        const prob = sideUp ? w.p : 1 - w.p;
        const all = ask + fee(ask, rate);
        if (prob - all < margin) continue;
        const won = sideUp === w.resolvedUp;
        bets++; wins += won; cost += all; pnl += (won ? 1 : 0) - all;
      }
      results.push({ offset, feeRate: rate, margin, windowsPriced: pts.length, bets, winRate: bets ? wins / bets : NaN, avgCost: bets ? cost / bets : NaN, profitPerShare: bets ? pnl / bets : NaN, roiPerBet: cost ? pnl / cost : NaN, totalProfitPer1ShareBets: pnl, corr: corr(pts) });
    }
  }
}
function corr(pts) {
  const n = pts.length; if (n < 3) return NaN;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n, my = pts.reduce((a, p) => a + p[1], 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pts) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}
console.log('\nBetting the model against the market price (spread 0.5¢ added to every buy):');
console.log('offset  fee   margin  priced  bets   win%   avgCost  profit/share  ROI/bet  corr(model,mkt)');
for (const r of results) {
  console.log(`${String(r.offset).padStart(5)}s  ${r.feeRate.toFixed(2)}  ${r.margin.toFixed(2)}   ${String(r.windowsPriced).padStart(5)}  ${String(r.bets).padStart(5)}  ${(100 * r.winRate).toFixed(1).padStart(5)}  ${r.avgCost.toFixed(3).padStart(7)}  ${r.profitPerShare.toFixed(4).padStart(10)}  ${(100 * r.roiPerBet).toFixed(1).padStart(6)}%  ${r.corr.toFixed(3)}`);
}
writeFileSync(join(ROOT, 'results', `polymarket_eval_lag${LAG}.json`), JSON.stringify({ lag: LAG, windows: windows.length, labelAgreement: agree / windows.length, modelScore: s, results }, null, 2));
