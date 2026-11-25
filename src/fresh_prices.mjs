// Is the at-open edge real, or an artifact of stale price samples? Uses only Polymarket prices
// recorded AFTER the window opened, grouped by how many seconds after the open they were recorded.
// Usage: node src/fresh_prices.mjs [lag=0]   (lag = minutes after the open when you decide)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMinutes, ROOT, minuteIso } from './data.mjs';
import { buildDataset } from './features.mjs';
import { fitLogistic } from './models.mjs';

const LAG = Number(process.argv[2] || 0);
const ds = buildDataset(loadMinutes(), { lag: LAG });
const decide = (w) => w.t + LAG * 60; // decision moment (seconds)
const month = (i) => minuteIso(ds.T[i]).slice(0, 7);
const months = [...new Set(Array.from({ length: ds.rows }, (_, i) => month(i)))];
const byMonth = new Map(months.map((m) => [m, []]));
for (let i = 0; i < ds.rows; i++) byMonth.get(month(i)).push(i);
const pm = readFileSync(join(ROOT, 'data', 'polymarket_15m.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((w) => w.resolvedUp !== null && w.history?.length);
const pred = new Map();
for (const em of new Set(pm.map((w) => new Date(w.t * 1000).toISOString().slice(0, 7)))) {
  const mi = months.indexOf(em);
  const model = fitLogistic(ds, months.slice(mi - 24, mi).flatMap((m) => byMonth.get(m)), { lambda: 1e-2 });
  for (const i of byMonth.get(em) ?? []) pred.set(ds.T[i], model.predict(i));
}
const fee = (p) => 0.05 * p * (1 - p);
const buckets = [[1, 10], [11, 20], [21, 30], [31, 45], [46, 60]];
console.log(`Decision ${LAG} min after the open. First price recorded after that moment`);
console.log('(fee 0.05, +0.5¢ spread, bet when model beats cost by ≥ 2¢):');
if (0) console.log(' (fee 0.05, +0.5¢ spread, bet when model beats cost by ≥ 2¢):');
console.log('secs after open  windows  bets   win%   avgCost  profit/share  ROI    95% range of profit/share');
for (const [lo, hi] of buckets) {
  let n = 0, bets = 0, wins = 0, cost = 0, pnl = 0, pnl2 = 0;
  for (const w of pm) {
    const p = pred.get(w.t / 60);
    if (p === undefined) continue;
    const pt = w.history.find(([t]) => t > decide(w));
    if (!pt || pt[0] - decide(w) < lo || pt[0] - decide(w) > hi) continue;
    n++;
    const up = pt[1], sideUp = p >= 0.5, prob = sideUp ? p : 1 - p;
    const ask = (sideUp ? up : 1 - up) + 0.005;
    if (ask <= 0.01 || ask >= 0.99) continue;
    const all = ask + fee(ask);
    if (prob - all < 0.02) continue;
    const r = (sideUp === w.resolvedUp ? 1 : 0) - all;
    bets++; wins += r > 0; cost += all; pnl += r; pnl2 += r * r;
  }
  const mean = pnl / bets, se = Math.sqrt((pnl2 / bets - mean * mean) / bets);
  console.log(`${String(lo).padStart(5)}–${String(hi).padEnd(3)}s      ${String(n).padStart(5)}  ${String(bets).padStart(5)}  ${(100 * wins / bets).toFixed(1).padStart(5)}  ${(cost / bets).toFixed(3)}   ${mean.toFixed(4).padStart(8)}   ${(100 * pnl / cost).toFixed(1).padStart(5)}%   ${(mean - 2 * se).toFixed(4)} to ${(mean + 2 * se).toFixed(4)}`);
}
