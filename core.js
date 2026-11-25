// Live feature calculation and prediction, shared by the web app and the tests.
// Must produce exactly what src/features.mjs builds for training (bot/test checks this).
// bars: { open, high, low, close, volume, takerBuy, trades } arrays of closed 1-minute candles.
// t: index of the window's first minute (bars[t - 1] is the last closed candle); needs t >= 1441.

export const RET_LAGS = [1, 2, 3, 5, 10, 15, 30, 60, 240, 1440];
export const IMB_LAGS = [1, 5, 15, 60, 240];

const twapAt = (b, i) => (b.open[i] + b.high[i] + b.low[i] + b.close[i]) / 4;
const sumRange = (a, from, to) => { let s = 0; for (let i = from; i <= to; i++) s += a[i]; return s; };

export function windowFeatures(b, t, windowStartMinute) {
  const c = b.close, e = t - 1;
  if (e - 1440 < 0) return null;
  let s60 = 0, sD = 0;
  for (let i = e - 1439; i <= e; i++) {
    const lr = Math.log(c[i] / c[i - 1]);
    sD += lr * lr;
    if (i > e - 60) s60 += lr * lr;
  }
  const sig = Math.sqrt(s60 / 60), sigD = Math.sqrt(sD / 1440);
  if (!(sig > 0) || !(sigD > 0)) return null;
  const s15 = sig * Math.sqrt(15);
  const f = [];
  f.push(Math.log(c[t - 1] / twapAt(b, t - 1)) / s15);
  f.push(Math.log(twapAt(b, t - 1) / twapAt(b, t - 16)) / s15);
  for (const q of RET_LAGS) f.push(Math.log(c[e] / c[e - q]) / (sig * Math.sqrt(q)));
  for (const q of IMB_LAGS) {
    const vol = sumRange(b.volume, e - q + 1, e);
    f.push(vol > 0 ? (2 * sumRange(b.takerBuy, e - q + 1, e)) / vol - 1 : 0);
  }
  f.push(Math.log((sumRange(b.volume, e - 14, e) / 15 + 1e-9) / (sumRange(b.volume, e - 1439, e) / 1440 + 1e-9)));
  f.push(Math.log((sumRange(b.trades, e - 14, e) / 15 + 1) / (sumRange(b.trades, e - 1439, e) / 1440 + 1)));
  f.push(Math.log(sig / sigD));
  for (const w of [60, 240]) {
    let lo = Infinity, hi = -Infinity;
    for (let i = e - w + 1; i <= e; i++) { if (c[i] < lo) lo = c[i]; if (c[i] > hi) hi = c[i]; }
    f.push(hi > lo ? (c[e] - lo) / (hi - lo) - 0.5 : 0);
  }
  for (const w of [60, 240, 1440]) f.push(Math.log(c[e] / (sumRange(c, e - w + 1, e) / w)) / (sig * Math.sqrt(w / 2)));
  const h = b.high[e], l = b.low[e];
  f.push(h > l ? (c[e] - l) / (h - l) - 0.5 : 0);
  f.push(Math.log(h / l) / sig);
  const minuteOfDay = ((windowStartMinute % 1440) + 1440) % 1440;
  f.push(Math.sin((2 * Math.PI * minuteOfDay) / 1440));
  f.push(Math.cos((2 * Math.PI * minuteOfDay) / 1440));
  const dow = (Math.floor(windowStartMinute / 1440) + 4) % 7;
  f.push(dow === 0 || dow === 6 ? 1 : 0);
  return f;
}

// model: { names, mean, sd, w } from model.json (w has one extra entry: the intercept).
export function predictUp(model, f) {
  let z = model.w[f.length];
  for (let j = 0; j < f.length; j++) z += (model.w[j] * (f[j] - model.mean[j])) / model.sd[j];
  return 1 / (1 + Math.exp(-z));
}

// Polymarket-style result of a finished window, from the same 1-minute candles.
export const windowUp = (b, t) => twapAt(b, t + 14) >= twapAt(b, t - 1);

// Polymarket taker fee per share at price p (rate 0.05 on BTC 15-minute markets as of Nov 2026).
export const takerFee = (p, rate = 0.05) => rate * p * (1 - p);

// Highest share price worth paying for a side the model gives probability `prob`, keeping `margin`
// of expected edge after the taker fee. Solves prob - price - fee(price) = margin.
export function maxPrice(prob, rate = 0.05, margin = 0.02) {
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (prob - mid - takerFee(mid, rate) >= margin) lo = mid; else hi = mid;
  }
  return lo;
}
