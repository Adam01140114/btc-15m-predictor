// Loads the 1-minute candle columns written by download_binance.mjs.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function loadMinutes(symbol = 'btcusdt') {
  const dir = join(ROOT, 'data', `${symbol}_1m`);
  const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
  const d = { first: meta.firstMinute, n: meta.minutes, meta };
  for (const [name, type] of Object.entries(meta.types)) {
    const bytes = new Uint8Array(readFileSync(join(dir, `${name}.bin`))); // copy → aligned buffer
    d[name] = type === 'Float64Array' ? new Float64Array(bytes.buffer) : new Float32Array(bytes.buffer);
  }
  return d;
}

// Minute index (minutes since 1970-01-01 UTC) → ISO string.
export const minuteIso = (m) => new Date(m * 60000).toISOString();
