// Checks that the live feature code (web/core.js) matches the training features (src/features.mjs)
// on random historical windows. Usage: node src/test_parity.mjs
import assert from 'node:assert/strict';
import { loadMinutes } from './data.mjs';
import { buildDataset } from './features.mjs';
import { windowFeatures, windowUp } from '../web/core.js';

const d = loadMinutes();
const ds = buildDataset(d, { lag: 0 });
let worst = 0, checked = 0;
for (let s = 0; s < 3000; s++) {
  const r = Math.floor(Math.random() * ds.rows);
  const t = ds.T[r] - d.first;
  const f = windowFeatures(d, t, ds.T[r]);
  for (let j = 0; j < ds.k; j++) {
    const a = ds.X[r * ds.k + j], b = f[j];
    worst = Math.max(worst, Math.abs(a - b) / Math.max(1, Math.abs(b)));
  }
  assert.equal(windowUp(d, t) ? 1 : 0, ds.y[r]);
  checked++;
}
assert.ok(worst < 1e-4, `largest feature difference ${worst}`);
console.log(`ok  live features match training features on ${checked} random windows (largest difference ${worst.toExponential(1)})`);
