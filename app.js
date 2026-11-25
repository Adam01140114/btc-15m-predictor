import { windowFeatures, predictUp, windowUp, takerFee, maxPrice } from './core.js';

const BINANCE = 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=1000';
const GAMMA = 'https://gamma-api.polymarket.com/events?slug=btc-updown-15m-';
const BOOK = 'https://clob.polymarket.com/book?token_id=';
const BARS_NEEDED = 1441 + 96 * 15 + 30; // features need a day of history; track record covers 24 h
const $ = (id) => document.getElementById(id);
const et = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const etTime = (minute) => et.format(new Date(minute * 60000));
const cents = (p) => (p == null ? '—' : `${(p * 100).toFixed(1)}¢`);

const settings = (() => {
  try { return { feeRate: 0.05, margin: 0.02, ...JSON.parse(localStorage.getItem('btc15m') || '{}') }; } catch { return { feeRate: 0.05, margin: 0.02 }; }
})();
const save = () => { try { localStorage.setItem('btc15m', JSON.stringify(settings)); } catch { /* private mode */ } };

let model, bars = null, barsMinute = -1, market = { window: null, tokens: null, up: null, down: null, at: 0 };
let current = null; // latest call, used to pre-fill the trade log
const OPEN_SECONDS = 20;

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

// Closed 1-minute candles only, oldest first, as column arrays.
async function loadBars() {
  const nowMin = Math.floor(Date.now() / 60000);
  let end = nowMin * 60000 - 1;
  let rows = [];
  while (rows.length < BARS_NEEDED) {
    const chunk = await getJson(`${BINANCE}&endTime=${end}`);
    if (!chunk.length) break;
    rows = chunk.concat(rows);
    end = chunk[0][0] - 1;
  }
  const first = Math.floor(rows[0][0] / 60000), last = Math.floor(rows.at(-1)[0] / 60000);
  const n = last - first + 1;
  const b = { first, n, open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n), takerBuy: new Float64Array(n), trades: new Float64Array(n) };
  const byMin = new Map(rows.map((r) => [Math.floor(r[0] / 60000), r]));
  let prev = +rows[0][4];
  for (let i = 0; i < n; i++) {
    const r = byMin.get(first + i);
    if (r) { b.open[i] = +r[1]; b.high[i] = +r[2]; b.low[i] = +r[3]; b.close[i] = prev = +r[4]; b.volume[i] = +r[5]; b.trades[i] = +r[8]; b.takerBuy[i] = +r[9]; }
    else { b.open[i] = b.high[i] = b.low[i] = b.close[i] = prev; }
  }
  return b;
}

async function loadMarket(windowStart) {
  if (market.window !== windowStart) {
    market = { window: windowStart, tokens: null, up: null, down: null, at: 0 };
    const ev = await getJson(GAMMA + windowStart * 60);
    const m = ev?.[0]?.markets?.[0];
    if (!m) return;
    const outcomes = JSON.parse(m.outcomes), tokens = JSON.parse(m.clobTokenIds);
    market.tokens = { up: tokens[outcomes.indexOf('Up')], down: tokens[outcomes.indexOf('Down')] };
    market.feeRate = m.feeSchedule?.rate;
  }
  if (!market.tokens || Date.now() - market.at < 8000) return;
  const bestAsk = async (token) => {
    const book = await getJson(BOOK + token);
    const asks = (book.asks || []).map((a) => +a.price);
    return asks.length ? Math.min(...asks) : null;
  };
  [market.up, market.down] = await Promise.all([bestAsk(market.tokens.up), bestAsk(market.tokens.down)]);
  market.at = Date.now();
}

function confidence(p) {
  const e = Math.abs(p - 0.5);
  return e >= 0.05 ? ['high', 'High confidence'] : e >= 0.02 ? ['medium', 'Medium confidence'] : ['low', 'Low confidence'];
}

function render() {
  if (!bars || !model) return;
  const now = Date.now();
  const W = Math.floor(now / 900000) * 15; // current window start (minutes)
  const secsIn = Math.floor(now / 1000) - W * 60;
  const t = W - bars.first;
  if (t - 1 >= bars.n) return; // candles not caught up yet
  const f = windowFeatures(bars, t, W);
  if (!f) return;
  const p = predictUp(model, f);
  const sideUp = p >= 0.5, prob = sideUp ? p : 1 - p;

  $('window').textContent = `${etTime(W)} – ${etTime(W + 15)} ET`;
  const left = 900 - secsIn;
  $('countdown').textContent = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left in this window`;
  $('call').textContent = sideUp ? '↑ UP' : '↓ DOWN';
  $('call').className = `call ${sideUp ? 'up' : 'down'}`;
  $('prob').textContent = `${(prob * 100).toFixed(1)}% chance it closes ${sideUp ? 'up' : 'down'}`;
  const [cls, txt] = confidence(p);
  $('conf').className = `chip ${cls}`;
  $('conf').textContent = txt;

  // Price check
  const rate = settings.feeRate, margin = settings.margin;
  const limit = maxPrice(prob, rate, margin);
  const ask = sideUp ? market.up : market.down;
  $('askUp').textContent = cents(market.up);
  $('askDown').textContent = cents(market.down);
  $('maxLabel').textContent = `Worth paying for ${sideUp ? 'Up' : 'Down'}`;
  $('maxPrice').textContent = limit > 0.01 ? `≤ ${cents(limit)}` : 'nothing';
  // Backtest: the market absorbs this call within ~10–20 s of the open, so the edge only matters then.
  const fresh = secsIn <= OPEN_SECONDS;
  const edge = ask != null && fresh ? prob - ask - takerFee(ask, rate) : null;
  $('edge').textContent = edge == null ? '—' : `${edge >= 0 ? '+' : ''}${(edge * 100).toFixed(1)}¢`;
  const v = $('verdict');
  if (!fresh) {
    v.className = 'verdict wait';
    v.textContent = `Window is ${secsIn >= 60 ? `${Math.floor(secsIn / 60)} min` : `${secsIn} s`} in; the market has caught up. Next call at ${etTime(W + 15)} ET.`;
    $('phase').textContent = 'The call only matters in the first seconds after a window opens.';
  } else if (ask == null) {
    v.className = 'verdict pass';
    v.textContent = `No live price. Only buy ${sideUp ? 'Up' : 'Down'} at ${cents(limit)} or less.`;
    $('phase').textContent = 'Window just opened: the market usually catches up within ~15 seconds.';
  } else if (edge >= margin) {
    v.className = 'verdict go';
    v.textContent = `Buy ${sideUp ? 'Up' : 'Down'} at ${cents(limit)} or less (now ${cents(ask)}).`;
    $('phase').textContent = 'Window just opened: the market usually catches up within ~15 seconds.';
  } else {
    v.className = 'verdict pass';
    v.textContent = `Pass. ${sideUp ? 'Up' : 'Down'} costs ${cents(ask)}, above the ${cents(limit)} it's worth.`;
    $('phase').textContent = 'Window just opened: the market usually catches up within ~15 seconds.';
  }
  current = { W, sideUp, prob, askUp: market.up, askDown: market.down };
  if (market.feeRate != null && market.feeRate !== rate) $('mktSrc').textContent = `global market · live fee rate ${market.feeRate}`;

  // Early read for the next window: features as if it opened after the latest closed candle.
  const fe = windowFeatures(bars, bars.n, W + 15);
  $('nextTime').textContent = `opens ${etTime(W + 15)} ET`;
  if (fe) { const pn = predictUp(model, fe); $('nextCall').textContent = `${pn >= 0.5 ? '↑ Up' : '↓ Down'} ${(Math.max(pn, 1 - pn) * 100).toFixed(1)}%`; }

  // Track record over finished windows (last 24 h).
  const past = [];
  for (let k = 96; k >= 1; k--) {
    const Wk = W - 15 * k, tk = Wk - bars.first;
    if (tk - 1441 < 0 || tk + 14 >= bars.n) continue;
    const pk = predictUp(model, windowFeatures(bars, tk, Wk));
    past.push({ p: pk, hit: (pk >= 0.5) === windowUp(bars, tk) });
  }
  const acc = (arr) => (arr.length ? arr.filter((x) => x.hit).length / arr.length : null);
  const conf = past.filter((x) => Math.abs(x.p - 0.5) >= 0.05);
  $('acc24').textContent = past.length ? `${(acc(past) * 100).toFixed(0)}%` : '—';
  $('n24').textContent = `${past.filter((x) => x.hit).length} of ${past.length} right`;
  $('accConf').textContent = conf.length ? `${(acc(conf) * 100).toFixed(0)}%` : '—';
  $('nConf').textContent = `${conf.filter((x) => x.hit).length} of ${conf.length} right`;
  $('strip').innerHTML = past.slice(-24).map((x) => `<span class="${x.hit ? 'hit' : 'miss'}" title="${(Math.max(x.p, 1 - x.p) * 100).toFixed(0)}% ${x.p >= 0.5 ? 'Up' : 'Down'}: ${x.hit ? 'right' : 'wrong'}"></span>`).join('');
}

// ---------- trade log (stored on this device only) ----------
const LOG_KEY = 'btc15m-trades';
let trades = (() => { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; } })();
const saveTrades = () => { try { localStorage.setItem(LOG_KEY, JSON.stringify(trades)); } catch { /* private mode */ } };
let logSide = null;

function tradePnl(tr) {
  const cost = tr.shares * tr.price + tr.shares * takerFee(tr.price, tr.feeRate);
  return tr.result == null ? null : (tr.result === tr.side ? tr.shares : 0) - cost;
}

// Official result from Polymarket once the window has settled; until then, the same 1-minute
// estimate the model is scored on (it matched the official result 97% of the time in testing).
async function settleTrades() {
  const nowMin = Date.now() / 60000;
  let changed = false;
  for (const tr of trades) {
    if (tr.source === 'official' || tr.window + 15 > nowMin - 1) continue;
    try {
      const m = (await getJson(GAMMA + tr.window * 60))?.[0]?.markets?.[0];
      if (m?.closed) {
        const outcomes = JSON.parse(m.outcomes), prices = JSON.parse(m.outcomePrices).map(Number);
        tr.result = outcomes[prices.indexOf(1)];
        tr.source = 'official';
        changed = true;
        continue;
      }
    } catch { /* try again later */ }
    const t = tr.window - (bars?.first ?? Infinity);
    if (bars && tr.result == null && t - 1 >= 0 && t + 14 < bars.n) { tr.result = windowUp(bars, t) ? 'Up' : 'Down'; tr.source = 'estimate'; changed = true; }
  }
  if (changed) { saveTrades(); renderTrades(); }
}

function renderTrades() {
  const done = trades.filter((t) => t.result != null);
  const wins = done.filter((t) => t.result === t.side).length;
  const staked = done.reduce((a, t) => a + t.shares * t.price, 0);
  const pnl = done.reduce((a, t) => a + tradePnl(t), 0);
  $('tWins').textContent = done.length ? `${wins} of ${done.length}` : '—';
  $('tRate').textContent = done.length ? `${((wins / done.length) * 100).toFixed(0)}% won` : 'no settled trades yet';
  $('tPnl').textContent = done.length ? `${pnl >= 0 ? '+' : '−'}$${Math.abs(pnl).toFixed(2)}` : '—';
  $('tPnl').style.color = done.length ? (pnl >= 0 ? 'var(--up)' : 'var(--down)') : '';
  $('tRoi').textContent = staked ? `${pnl >= 0 ? '+' : '−'}${Math.abs((pnl / staked) * 100).toFixed(1)}% on $${staked.toFixed(2)} staked` : '';
  $('tList').innerHTML = trades.slice().reverse().slice(0, 30).map((t) => {
    const p = tradePnl(t);
    const res = t.result == null ? '<span class="small">pending</span>'
      : `<strong style="color:${t.result === t.side ? 'var(--up)' : 'var(--down)'}">${t.result === t.side ? 'Won' : 'Lost'}</strong>${t.source === 'estimate' ? '<span class="small"> (est.)</span>' : ''}`;
    return `<li><span>${etTime(t.window)} · ${t.side} · ${t.shares} @ ${(t.price * 100).toFixed(1)}¢</span><span>${res}${p != null ? ` ${p >= 0 ? '+' : '−'}$${Math.abs(p).toFixed(2)}` : ''} <button class="x" data-id="${t.id}" aria-label="Delete trade">×</button></span></li>`;
  }).join('');
}

function setLogSide(side) {
  logSide = side;
  for (const s of ['Up', 'Down']) $(`log${s}`).setAttribute('aria-pressed', String(side === s));
  const ask = side === 'Up' ? current?.askUp : current?.askDown;
  if (ask != null && !$('logPrice').value) $('logPrice').value = (ask * 100).toFixed(1);
}

function initTradeLog() {
  $('logUp').addEventListener('click', () => setLogSide('Up'));
  $('logDown').addEventListener('click', () => setLogSide('Down'));
  $('logAdd').addEventListener('click', () => {
    const price = Number($('logPrice').value) / 100, shares = Number($('logShares').value);
    if (!logSide || !(price > 0 && price < 1) || !(shares > 0)) { $('logMsg').textContent = 'Pick Up or Down, then enter the price (in cents) and number of shares.'; return; }
    const W = Math.floor(Date.now() / 900000) * 15;
    trades.push({ id: Date.now(), window: W, side: logSide, price, shares, feeRate: settings.feeRate, modelSide: current?.sideUp ? 'Up' : 'Down', modelProb: current?.prob, result: null, source: null });
    saveTrades();
    $('logMsg').textContent = `Logged ${logSide} for the ${etTime(W)} window.`;
    $('logPrice').value = '';
    renderTrades();
  });
  $('tList').addEventListener('click', (ev) => {
    const id = Number(ev.target.dataset?.id);
    if (!id) return;
    trades = trades.filter((t) => t.id !== id);
    saveTrades();
    renderTrades();
  });
  $('logExport').addEventListener('click', () => {
    const rows = [['window_et', 'side', 'price', 'shares', 'fee_rate', 'model_side', 'model_prob', 'result', 'source', 'pnl']]
      .concat(trades.map((t) => [new Date(t.window * 60000).toISOString(), t.side, t.price, t.shares, t.feeRate, t.modelSide, t.modelProb?.toFixed(4), t.result ?? '', t.source ?? '', tradePnl(t)?.toFixed(4) ?? '']));
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([rows.map((r) => r.join(',')).join('\n')], { type: 'text/csv' }));
    a.download = 'btc15m-trades.csv';
    a.click();
  });
  renderTrades();
}

function setStatus(ok, text) {
  $('dot').className = `dot ${ok ? 'ok' : 'err'}`;
  $('liveText').textContent = text;
}

async function tick() {
  const nowMin = Math.floor(Date.now() / 60000);
  try {
    if (nowMin !== barsMinute && Date.now() % 60000 > 2500) { bars = await loadBars(); barsMinute = nowMin; }
    await loadMarket(Math.floor(Date.now() / 900000) * 15).catch(() => {});
    $('err').style.display = 'none';
    setStatus(true, `Live · BTC $${bars ? Math.round(bars.close[bars.n - 1]).toLocaleString('en-US') : '—'}`);
  } catch (e) {
    $('err').style.display = 'block';
    $('err').textContent = `Couldn't load prices (${e.message}). Retrying…`;
    setStatus(false, 'Offline');
  }
  render();
}

async function start() {
  for (const id of ['feeRate', 'margin']) {
    $(id).value = String(settings[id]);
    $(id).addEventListener('change', (ev) => { settings[id] = Number(ev.target.value); save(); render(); });
  }
  try {
    model = await getJson('model.json');
    $('modelInfo').textContent = `Model: logistic regression on ${model.names.length} price, volume and timing features, trained on ${model.windows.toLocaleString('en-US')} windows (${model.trainedFrom} to ${model.trainedTo}).`;
  } catch (e) {
    $('err').style.display = 'block';
    $('err').textContent = `Couldn't load model.json (${e.message}).`;
    return;
  }
  initTradeLog();
  await tick();
  setInterval(tick, 1000);
  settleTrades();
  setInterval(settleTrades, 30000);
}
start();
