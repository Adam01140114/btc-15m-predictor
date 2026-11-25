// Turns 1-minute candles into one row per 15-minute Polymarket window.
//
// Window starting at minute T (aligned to :00/:15/:30/:45 UTC). Polymarket resolves it with
// Chainlink's 60-second TWAP: "price to beat" = average over the minute before T, final price =
// average over the window's last minute. We approximate each 60-second average with the minute
// candle's (open+high+low+close)/4. Label: final >= price to beat → Up (ties resolve Up).
//
// Features use only candles that have closed by the decision time (T + lag minutes). A negative lag
// means deciding before the window opens (e.g. lag -1: one minute early, last closed candle T-2).
export const RET_LAGS = [1, 2, 3, 5, 10, 15, 30, 60, 240, 1440];
export const IMB_LAGS = [1, 5, 15, 60, 240];

export function featureNames(lag = 0) {
  return [
    'head', 'prevWindow',
    ...RET_LAGS.map((k) => `ret${k}`),
    ...IMB_LAGS.map((k) => `imb${k}`),
    'volZ15', 'tradesZ15', 'volRatio', 'range60', 'range240', 'sma60', 'sma240', 'sma1440',
    'barPos', 'barRange', 'hourSin', 'hourCos', 'weekend',
    ...(lag > 0 ? ['dist', 'distLast'] : []),
  ];
}

export function buildDataset(d, { lag = 0 } = {}) {
  const { n, first, open: o, high: h, low: l, close: c, volume: v, takerBuy: tb, trades: tr } = d;
  const twap = new Float64Array(n);
  const P = { lr2: new Float64Array(n + 1), vol: new Float64Array(n + 1), tb: new Float64Array(n + 1), tr: new Float64Array(n + 1), c: new Float64Array(n + 1) };
  for (let i = 0; i < n; i++) {
    twap[i] = (o[i] + h[i] + l[i] + c[i]) / 4;
    const lr = i ? Math.log(c[i] / c[i - 1]) : 0;
    P.lr2[i + 1] = P.lr2[i] + lr * lr;
    P.vol[i + 1] = P.vol[i] + v[i];
    P.tb[i + 1] = P.tb[i] + tb[i];
    P.tr[i + 1] = P.tr[i] + tr[i];
    P.c[i + 1] = P.c[i] + c[i];
  }
  const sum = (A, a, b) => A[b + 1] - A[a]; // inclusive a..b
  const names = featureNames(lag);
  const k = names.length;
  const start = Math.ceil((first + 1500) / 15) * 15 - first; // leave a day of history
  const rows = Math.floor((n - 15 - start) / 15);
  const X = new Float32Array(rows * k), y = new Uint8Array(rows), T = new Int32Array(rows), move = new Float32Array(rows);
  let r = 0;
  for (let t = start; t + 14 < n; t += 15) {
    const e = t - 1 + lag; // last closed candle at decision time
    const sig = Math.sqrt(sum(P.lr2, e - 59, e) / 60);
    const sigD = Math.sqrt(sum(P.lr2, e - 1439, e) / 1440);
    if (!(sig > 0) || !(sigD > 0)) continue;
    const s15 = sig * Math.sqrt(15);
    const f = X.subarray(r * k, r * k + k);
    let j = 0;
    const a = Math.min(t - 1, e); // newest candle the "head start" can use (before the open, that's e)
    f[j++] = Math.log(c[a] / twap[a]) / s15; // head start: last close vs that minute's average
    f[j++] = Math.log(twap[a] / twap[a - 15]) / s15; // previous 15 minutes' move
    for (const q of RET_LAGS) f[j++] = Math.log(c[e] / c[e - q]) / (sig * Math.sqrt(q));
    for (const q of IMB_LAGS) {
      const vol = sum(P.vol, e - q + 1, e);
      f[j++] = vol > 0 ? (2 * sum(P.tb, e - q + 1, e)) / vol - 1 : 0;
    }
    f[j++] = Math.log((sum(P.vol, e - 14, e) / 15 + 1e-9) / (sum(P.vol, e - 1439, e) / 1440 + 1e-9));
    f[j++] = Math.log((sum(P.tr, e - 14, e) / 15 + 1) / (sum(P.tr, e - 1439, e) / 1440 + 1));
    f[j++] = Math.log(sig / sigD);
    for (const w of [60, 240]) {
      let lo = Infinity, hi = -Infinity;
      for (let i = e - w + 1; i <= e; i++) { if (c[i] < lo) lo = c[i]; if (c[i] > hi) hi = c[i]; }
      f[j++] = hi > lo ? (c[e] - lo) / (hi - lo) - 0.5 : 0;
    }
    for (const w of [60, 240, 1440]) f[j++] = Math.log(c[e] / (sum(P.c, e - w + 1, e) / w)) / (sig * Math.sqrt(w / 2));
    f[j++] = h[e] > l[e] ? (c[e] - l[e]) / (h[e] - l[e]) - 0.5 : 0;
    f[j++] = Math.log(h[e] / l[e]) / sig;
    const minuteOfDay = (first + t) % 1440;
    f[j++] = Math.sin((2 * Math.PI * minuteOfDay) / 1440);
    f[j++] = Math.cos((2 * Math.PI * minuteOfDay) / 1440);
    const dow = (Math.floor((first + t) / 1440) + 4) % 7; // 0 = Sunday (1970-01-01 was a Thursday)
    f[j++] = dow === 0 || dow === 6 ? 1 : 0;
    if (lag > 0) {
      f[j++] = Math.log(c[e] / twap[t - 1]) / (sig * Math.sqrt(15 - lag)); // where price sits vs the price to beat
      f[j++] = Math.log(twap[e] / twap[t - 1]) / (sig * Math.sqrt(15 - lag));
    }
    y[r] = twap[t + 14] >= twap[t - 1] ? 1 : 0;
    move[r] = Math.log(twap[t + 14] / twap[t - 1]) / s15;
    T[r] = first + t;
    r++;
  }
  return { names, k, rows: r, X: X.subarray(0, r * k), y: y.subarray(0, r), T: T.subarray(0, r), move: move.subarray(0, r) };
}
