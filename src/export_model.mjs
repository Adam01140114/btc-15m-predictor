// Trains the production model on the most recent 24 complete months and writes web/model.json.
// Re-run monthly (after node src/download_binance.mjs) to keep the model current.
// Usage: node src/export_model.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadMinutes, ROOT, minuteIso } from './data.mjs';
import { buildDataset } from './features.mjs';
import { fitLogistic, score } from './models.mjs';

const LAMBDA = 1e-2, MONTHS = 24;
const ds = buildDataset(loadMinutes(), { lag: 0 });
const month = (i) => minuteIso(ds.T[i]).slice(0, 7);
const lastFull = (() => { const d = new Date(ds.T[ds.rows - 1] * 60000); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 1); return d.toISOString().slice(0, 7); })();
const from = (() => { const d = new Date(`${lastFull}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - (MONTHS - 1)); return d.toISOString().slice(0, 7); })();
const idx = [];
for (let i = 0; i < ds.rows; i++) { const m = month(i); if (m >= from && m <= lastFull) idx.push(i); }
const model = fitLogistic(ds, idx, { lambda: LAMBDA });
const fit = score(idx.map((i) => model.predict(i)), idx.map((i) => ds.y[i]));
const out = {
  kind: 'logistic',
  names: ds.names,
  mean: [...model.mean],
  sd: [...model.sd],
  w: [...model.w],
  lambda: LAMBDA,
  trainedFrom: from,
  trainedTo: lastFull,
  windows: idx.length,
  inSampleAccuracy: +fit.acc.toFixed(4),
  generated: new Date().toISOString(),
};
writeFileSync(join(ROOT, 'web', 'model.json'), JSON.stringify(out, null, 1));
console.log(`model.json: trained ${from} → ${lastFull} on ${idx.length} windows (in-sample accuracy ${(100 * fit.acc).toFixed(2)}%)`);
