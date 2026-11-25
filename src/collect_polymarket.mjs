// Collects past Polymarket "Bitcoin Up or Down" 15-minute markets: the official outcome, the fee
// schedule, and the Up share's price history from 10 minutes before the window opens until it closes.
// This is what the model has to beat: the price you would actually have paid.
// Usage: node src/collect_polymarket.mjs [days=60]   (resumable; appends to data/polymarket_15m.jsonl)
import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'polymarket_15m.jsonl');
mkdirSync(dirname(OUT), { recursive: true });
const DAYS = Number(process.argv[2] || 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
      if (res.ok) return await res.json();
      if (res.status !== 429 && res.status < 500) return null;
    } catch { /* timeout or network: retry */ }
    await sleep(1000 * attempt);
  }
  return null;
}

const done = new Set();
if (existsSync(OUT)) for (const l of readFileSync(OUT, 'utf8').split('\n')) if (l) done.add(JSON.parse(l).t);

const lastWindow = Math.floor((Date.now() / 1000 - 1800) / 900) * 900; // only windows that have settled
const windows = [];
for (let t = lastWindow; t > lastWindow - DAYS * 86400; t -= 900) if (!done.has(t)) windows.push(t);

async function collect(t) {
  const ev = await getJson(`https://gamma-api.polymarket.com/events?slug=btc-updown-15m-${t}`);
  const m = ev?.[0]?.markets?.[0];
  if (!m) return { t, missing: true };
  const outcomes = JSON.parse(m.outcomes || '[]');
  const tokens = JSON.parse(m.clobTokenIds || '[]');
  const prices = JSON.parse(m.outcomePrices || '[]').map(Number);
  const up = outcomes.indexOf('Up');
  const hist = await getJson(`https://clob.polymarket.com/prices-history?market=${tokens[up]}&startTs=${t - 600}&endTs=${t + 900}&fidelity=1`);
  return {
    t,
    resolvedUp: m.closed ? prices[up] === 1 : null,
    feeRate: m.feeSchedule?.rate ?? null,
    feeType: m.feeType ?? null,
    volume: Number(m.volumeNum ?? 0),
    history: (hist?.history ?? []).map((p) => [p.t, p.p]),
  };
}

let n = 0;
for (let i = 0; i < windows.length; i += 6) {
  const batch = await Promise.all(windows.slice(i, i + 6).map(collect));
  for (const r of batch) appendFileSync(OUT, JSON.stringify(r) + '\n');
  n += batch.length;
  if (n % 120 === 0 || i + 6 >= windows.length) process.stdout.write(`\r${n}/${windows.length} windows`);
}
console.log(`\nSaved to ${OUT}`);
