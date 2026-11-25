// Downloads Binance BTCUSDT 1-minute candles (monthly archives from data.binance.vision, plus daily
// archives for the current month) and stores them as compact binary columns in data/.
// Binance is used because its candles include taker-buy volume (who was aggressive: buyers or sellers).
// Usage: node src/download_binance.mjs [startYYYY-MM]
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const CACHE = join(DATA, 'binance_zip');
mkdirSync(CACHE, { recursive: true });
const BASE = 'https://data.binance.vision/data/spot';
const SYMBOL = process.env.SYMBOL || 'BTCUSDT';
const START = process.argv[2] || '2019-01';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal single-file zip reader: central directory → local header → raw deflate data.
function unzipFirst(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('not a zip');
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10);
  const csize = buf.readUInt32LE(cd + 20);
  const local = buf.readUInt32LE(cd + 42);
  const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + csize);
  return method === 0 ? data : inflateRawSync(data);
}

async function fetchZip(url, file) {
  const path = join(CACHE, file);
  if (existsSync(path)) return readFileSync(path);
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(path, buf);
      return buf;
    }
    await sleep(1500 * attempt);
  }
  throw new Error(`failed ${url}`);
}

const months = [];
const now = new Date();
for (let d = new Date(`${START}-01T00:00:00Z`); d < new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); d.setUTCMonth(d.getUTCMonth() + 1)) {
  months.push(d.toISOString().slice(0, 7));
}
const days = [];
for (let d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); d < new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())); d.setUTCDate(d.getUTCDate() + 1)) {
  days.push(d.toISOString().slice(0, 10));
}

const rows = new Map(); // minute index → [open, high, low, close, volume, takerBuyVolume, trades]
let files = 0, missing = [];
async function load(kind, stamp) {
  const file = `${SYMBOL}-1m-${stamp}.zip`;
  const buf = await fetchZip(`${BASE}/${kind}/klines/${SYMBOL}/1m/${file}`, file);
  if (!buf) { missing.push(stamp); return; }
  const text = unzipFirst(buf).toString('utf8');
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('open_time')) continue;
    const f = line.split(',');
    let t = Number(f[0]);
    if (t > 1e14) t = Math.floor(t / 1000); // archives from 2025 on use microseconds
    rows.set(Math.floor(t / 60000), [+f[1], +f[2], +f[3], +f[4], +f[5], +f[9], +f[8]]);
  }
  files++;
}
// A few downloads at a time keeps this quick without hammering the server.
const jobs = [...months.map((m) => ['monthly', m]), ...days.map((d) => ['daily', d])];
for (let i = 0; i < jobs.length; i += 6) {
  await Promise.all(jobs.slice(i, i + 6).map(([k, s]) => load(k, s)));
  process.stdout.write(`\r${Math.min(i + 6, jobs.length)}/${jobs.length} archives`);
}
console.log();

// Dense minute grid; gaps (exchange outages) carry the last close forward with zero volume.
const keys = [...rows.keys()].sort((a, b) => a - b);
const first = keys[0], last = keys.at(-1), n = last - first + 1;
const cols = { open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), volume: new Float32Array(n), takerBuy: new Float32Array(n), trades: new Float32Array(n) };
let filled = 0, prevClose = rows.get(first)[3];
for (let i = 0; i < n; i++) {
  const r = rows.get(first + i);
  if (r) {
    [cols.open[i], cols.high[i], cols.low[i], cols.close[i], cols.volume[i], cols.takerBuy[i], cols.trades[i]] = r;
    prevClose = r[3];
  } else {
    cols.open[i] = cols.high[i] = cols.low[i] = cols.close[i] = prevClose;
    filled++;
  }
}
const out = join(DATA, `${SYMBOL.toLowerCase()}_1m`);
mkdirSync(out, { recursive: true });
for (const [name, arr] of Object.entries(cols)) writeFileSync(join(out, `${name}.bin`), Buffer.from(arr.buffer));
const meta = { symbol: SYMBOL, firstMinute: first, minutes: n, first: new Date(first * 60000).toISOString(), last: new Date(last * 60000).toISOString(), archives: files, missingArchives: missing, filledMinutes: filled, types: Object.fromEntries(Object.entries(cols).map(([k, v]) => [k, v.constructor.name])) };
writeFileSync(join(out, 'meta.json'), JSON.stringify(meta, null, 2));
console.log(JSON.stringify(meta, null, 2));
