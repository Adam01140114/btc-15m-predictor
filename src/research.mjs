// Step 1 of the research: how predictable is the 15-minute direction at all?
// - base rates, single-feature signals (and whether they hold year after year)
// - walk-forward logistic regression: retrain monthly on the previous 24 months, predict the next month
// Development period ends 2026-08; Sep 2026 onward is held out for a final, one-time check.
// Usage: node src/research.mjs [lag=0]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadMinutes, ROOT, minuteIso } from './data.mjs';
import { buildDataset } from './features.mjs';
import { fitLogistic, score } from './models.mjs';

const LAG = Number(process.argv[2] || 0);
const OUT = join(ROOT, 'results');
mkdirSync(OUT, { recursive: true });
console.time('total');
const d = loadMinutes();
const ds = buildDataset(d, { lag: LAG });
const month = (i) => minuteIso(ds.T[i]).slice(0, 7);
const year = (i) => minuteIso(ds.T[i]).slice(0, 4);
const HOLDOUT = '2026-09';
console.log(`${ds.rows} windows, ${minuteIso(ds.T[0])} → ${minuteIso(ds.T[ds.rows - 1])}, ${ds.k} features, decision at window open + ${LAG} min`);

// ---------- base rates ----------
const years = [...new Set(Array.from({ length: ds.rows }, (_, i) => year(i)))];
const upRate = (pred) => { let n = 0, u = 0; for (let i = 0; i < ds.rows; i++) if (pred(i)) { n++; u += ds.y[i]; } return u / n; };
console.log('Up rate by year:', years.map((yr) => `${yr} ${(100 * upRate((i) => year(i) === yr)).toFixed(1)}%`).join('  '));

// ---------- single features: sign rule accuracy per year (development period only) ----------
const dev = [], hold = [];
for (let i = 0; i < ds.rows; i++) (month(i) < HOLDOUT ? dev : hold).push(i);
const single = ds.names.map((name, j) => {
  const perYear = years.filter((yr) => yr < '2026' || true).map((yr) => {
    let n = 0, hit = 0;
    for (const i of dev) {
      if (year(i) !== yr) continue;
      const v = ds.X[i * ds.k + j];
      if (v === 0) continue;
      n++;
      if ((v > 0 ? 1 : 0) === ds.y[i]) hit++;
    }
    return n ? hit / n : NaN;
  });
  const valid = perYear.filter(Number.isFinite);
  const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
  const sameSide = valid.filter((a) => (a - 0.5) * (avg - 0.5) > 0).length;
  return { name, avg, sameSide, years: valid.length, perYear };
}).sort((a, b) => Math.abs(b.avg - 0.5) - Math.abs(a.avg - 0.5));
console.log('\nSingle features ("feature > 0 means Up"), development years', years.join(' '));
for (const s of single) console.log(`  ${s.name.padEnd(10)} avg ${(100 * s.avg).toFixed(2)}%  same direction ${s.sameSide}/${s.years}  ${s.perYear.map((a) => (Number.isFinite(a) ? (100 * a).toFixed(1) : ' -- ')).join(' ')}`);

// ---------- walk-forward logistic regression ----------
const months = [...new Set(Array.from({ length: ds.rows }, (_, i) => month(i)))];
const byMonth = new Map(months.map((m) => [m, []]));
for (let i = 0; i < ds.rows; i++) byMonth.get(month(i)).push(i);
const TRAIN_MONTHS = 24;
function walkForward(lambda, featureMask = null) {
  const view = featureMask ? project(ds, featureMask) : ds;
  const preds = new Float64Array(ds.rows).fill(NaN);
  for (let mi = TRAIN_MONTHS; mi < months.length; mi++) {
    const trainIdx = months.slice(mi - TRAIN_MONTHS, mi).flatMap((m) => byMonth.get(m));
    const model = fitLogistic(view, trainIdx, { lambda });
    for (const i of byMonth.get(months[mi])) preds[i] = model.predict(i);
  }
  return preds;
}
function project(src, cols) {
  const k = cols.length, X = new Float32Array(src.rows * k);
  for (let i = 0; i < src.rows; i++) cols.forEach((j, q) => { X[i * k + q] = src.X[i * src.k + j]; });
  return { ...src, X, k, names: cols.map((j) => src.names[j]) };
}
const evalOn = (preds, idx) => score(idx.map((i) => preds[i]), idx.map((i) => ds.y[i]));
const tested = (idx, preds) => idx.filter((i) => Number.isFinite(preds[i]));

const runs = {};
for (const lambda of [1e-4, 1e-2]) {
  const preds = walkForward(lambda);
  runs[`logistic λ=${lambda}`] = preds;
  const s = evalOn(preds, tested(dev, preds));
  console.log(`\nLogistic (λ=${lambda}), development ${months[TRAIN_MONTHS]} → 2026-08: n=${s.n} acc ${(100 * s.acc).toFixed(2)}% (z=${s.z.toFixed(1)}) logloss ${s.logloss.toFixed(5)} AUC ${s.auc.toFixed(4)}`);
  for (const b of s.buckets) console.log(`   edge ≥ ${(100 * b.minEdge).toFixed(0)}%: ${b.n} windows (${(100 * b.share).toFixed(1)}%), acc ${(100 * b.acc).toFixed(2)}%, z=${b.z.toFixed(1)}`);
  const perYear = years.map((yr) => { const idx = tested(dev, preds).filter((i) => year(i) === yr); return idx.length ? `${yr} ${(100 * evalOn(preds, idx).acc).toFixed(2)}%` : null; }).filter(Boolean);
  console.log('   by year:', perYear.join('  '));
}

// Save development-period predictions (holdout stays unscored until the final check).
const best = runs['logistic λ=0.01'];
const lines = ['minute,iso,p_up,y'];
for (let i = 0; i < ds.rows; i++) if (Number.isFinite(best[i])) lines.push(`${ds.T[i]},${minuteIso(ds.T[i])},${best[i].toFixed(5)},${ds.y[i]}`);
writeFileSync(join(OUT, `predictions_lag${LAG}.csv`), lines.join('\n') + '\n');
writeFileSync(join(OUT, `single_features_lag${LAG}.json`), JSON.stringify(single, null, 2));
console.log(`\nHoldout windows (not scored yet): ${hold.length}`);
console.timeEnd('total');
