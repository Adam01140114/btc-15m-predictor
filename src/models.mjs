// Small, dependency-free models and scoring.

const sigmoid = (z) => 1 / (1 + Math.exp(-z));

// Ridge-penalised logistic regression fitted with Newton's method (IRLS) on standardised features.
export function fitLogistic(ds, idx, { lambda = 1e-3, iters = 8 } = {}) {
  const { X, y, k } = ds;
  const mean = new Float64Array(k), sd = new Float64Array(k);
  for (const r of idx) for (let j = 0; j < k; j++) mean[j] += X[r * k + j];
  for (let j = 0; j < k; j++) mean[j] /= idx.length;
  for (const r of idx) for (let j = 0; j < k; j++) sd[j] += (X[r * k + j] - mean[j]) ** 2;
  for (let j = 0; j < k; j++) sd[j] = Math.sqrt(sd[j] / idx.length) || 1;
  const m = k + 1; // last weight is the intercept
  const w = new Float64Array(m);
  const x = new Float64Array(m);
  x[k] = 1;
  for (let it = 0; it < iters; it++) {
    const H = new Float64Array(m * m), g = new Float64Array(m);
    for (const r of idx) {
      let z = w[k];
      for (let j = 0; j < k; j++) { x[j] = (X[r * k + j] - mean[j]) / sd[j]; z += w[j] * x[j]; }
      const p = sigmoid(z), wt = p * (1 - p), res = y[r] - p;
      for (let a = 0; a < m; a++) {
        g[a] += res * x[a];
        const wa = wt * x[a];
        for (let b = a; b < m; b++) H[a * m + b] += wa * x[b];
      }
    }
    const pen = lambda * idx.length;
    for (let a = 0; a < k; a++) { H[a * m + a] += pen; g[a] -= pen * w[a]; }
    for (let a = 0; a < m; a++) for (let b = 0; b < a; b++) H[a * m + b] = H[b * m + a];
    const step = solveSpd(H, g, m);
    let maxStep = 0;
    for (let a = 0; a < m; a++) { w[a] += step[a]; maxStep = Math.max(maxStep, Math.abs(step[a])); }
    if (maxStep < 1e-7) break;
  }
  return {
    mean, sd, w,
    predict(r) {
      let z = w[k];
      for (let j = 0; j < k; j++) z += (w[j] * (X[r * k + j] - mean[j])) / sd[j];
      return sigmoid(z);
    },
  };
}

// Solve A x = b for symmetric positive-definite A (Cholesky).
function solveSpd(A, b, m) {
  const L = new Float64Array(m * m);
  for (let i = 0; i < m; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i * m + j];
      for (let q = 0; q < j; q++) s -= L[i * m + q] * L[j * m + q];
      L[i * m + j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j * m + j];
    }
  }
  const z = new Float64Array(m), x = new Float64Array(m);
  for (let i = 0; i < m; i++) { let s = b[i]; for (let q = 0; q < i; q++) s -= L[i * m + q] * z[q]; z[i] = s / L[i * m + i]; }
  for (let i = m - 1; i >= 0; i--) { let s = z[i]; for (let q = i + 1; q < m; q++) s -= L[q * m + i] * x[q]; x[i] = s / L[i * m + i]; }
  return x;
}

// Accuracy, log loss, AUC, and accuracy when only acting on confident predictions.
export function score(p, y, thresholds = [0, 0.01, 0.02, 0.03, 0.05, 0.08]) {
  const n = p.length;
  let hit = 0, ll = 0, brier = 0;
  for (let i = 0; i < n; i++) {
    if ((p[i] >= 0.5 ? 1 : 0) === y[i]) hit++;
    const q = Math.min(Math.max(p[i], 1e-6), 1 - 1e-6);
    ll -= y[i] ? Math.log(q) : Math.log(1 - q);
    brier += (p[i] - y[i]) ** 2;
  }
  const order = [...Array(n).keys()].sort((a, b) => p[a] - p[b]);
  let rankSum = 0, pos = 0;
  order.forEach((i, rank) => { if (y[i]) { rankSum += rank + 1; pos++; } });
  const auc = pos && pos < n ? (rankSum - (pos * (pos + 1)) / 2) / (pos * (n - pos)) : NaN;
  const buckets = thresholds.map((th) => {
    let m = 0, h = 0;
    for (let i = 0; i < n; i++) if (Math.abs(p[i] - 0.5) >= th) { m++; if ((p[i] >= 0.5 ? 1 : 0) === y[i]) h++; }
    return { minEdge: th, n: m, share: m / n, acc: m ? h / m : NaN, z: m ? (h / m - 0.5) / Math.sqrt(0.25 / m) : NaN };
  });
  return { n, acc: hit / n, z: (hit / n - 0.5) / Math.sqrt(0.25 / n), logloss: ll / n, brier: brier / n, auc, buckets };
}
