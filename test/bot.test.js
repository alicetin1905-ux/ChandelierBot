// Offline tests: node --test test/
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const config = require('../config');
const signal = require('../src/signal');
const broker = require('../src/broker');
const { step } = require('../src/run');

const H = 3600000;
const cfg = { ...config, FLIP_EXIT: false };

function candles(closes, tf, t0 = 0) {
  return closes.map((c, i) => ({ t: t0 + i * tf, o: c, h: c * 1.002, l: c * 0.998, c, v: 1 }));
}
// Long downtrend, then a sharp turn up on the last closed candle.
function reversal(n = 200) {
  const xs = [];
  for (let i = 0; i < n; i++) xs.push(100 - i * 0.2 + Math.sin(i / 3) * 0.3);
  const last = xs[xs.length - 1];
  xs.push(last + 3, last + 3.2); // closed breakout candle + forming candle
  return xs;
}
const emptyState = () => ({ account: { startingBalance: 1000, balance: 1000 }, positions: {}, trades: [], signals: {}, used: {}, equity: [], notify: {} });

test('size: 50 USDT at the stop, capped at 200 margin x 10', () => {
  const wide = broker.size({ entry: 100, stop: 96, stopDist: 0.04 }, config.PORTFOLIO);
  assert.ok(Math.abs(wide.notional - 1250) < 1e-9);
  assert.ok(Math.abs(wide.riskAmt - 50) < 1e-9);
  assert.ok(Math.abs(wide.margin - 125) < 1e-9);
  const tight = broker.size({ entry: 100, stop: 99, stopDist: 0.01 }, config.PORTFOLIO);
  assert.strictEqual(tight.notional, 2000);
  assert.ok(Math.abs(tight.riskAmt - 20) < 1e-9);
});

test('plan: 1.5 ATR stop widened to the CE stop, targets at 1.5/3/4.5R', () => {
  const a = { bias: 1, atr: 2, ceLongStop: 95, ceShortStop: 110 };
  const p = signal.plan(a, 100, config);
  assert.strictEqual(p.stop, 95);
  assert.strictEqual(p.t1, 107.5);
  assert.strictEqual(p.t2, 115);
  assert.strictEqual(p.t3, 122.5);
  const p2 = signal.plan({ ...a, ceLongStop: 99 }, 100, config);
  assert.strictEqual(p2.stop, 97);
});

test('analyse: CE buy flip with ZLSMA and MACD confirmation is an entry', () => {
  const a = signal.analyse(candles(reversal(), 4 * H), config);
  assert.strictEqual(a.bias, 1);
  assert.strictEqual(a.barsSinceFlip, 0);
  assert.ok(a.zlsmaOk && a.macdOk && a.ready);
});

test('replay: T1 fill moves stop to breakeven, then breakeven stop closes the rest', () => {
  const pos = broker.openPosition({
    symbol: 'BTCUSDT', plan: { bias: 1, entry: 100, stop: 96, t1: 106, t2: 112, t3: 118 },
    sized: { qty: 10, notional: 1000, margin: 100, riskAmt: 40 }, analysis: { flipAt: 0, closedAt: 0 }, now: 0, cfg,
  });
  const r = broker.replay(pos, [
    { t: 0, h: 107, l: 99, c: 106 },
    { t: H, h: 105, l: 99.5, c: 100 },
  ], cfg);
  assert.strictEqual(r.closed, true);
  assert.deepStrictEqual(r.trades.map(t => t.reason), ['T1 hit, stop moved to breakeven', 'breakeven stop hit']);
  const gross = r.trades.reduce((s, t) => s + t.pnl + t.fee, 0);
  assert.ok(Math.abs(gross - 24) < 1e-9); // 4 x (106 - 100) + 6 x 0
});

test('replay: stop is checked before targets inside one candle', () => {
  const pos = broker.openPosition({
    symbol: 'BTCUSDT', plan: { bias: -1, entry: 100, stop: 104, t1: 94, t2: 88, t3: 82 },
    sized: { qty: 1, notional: 100, margin: 10, riskAmt: 4 }, analysis: { flipAt: 0, closedAt: 0 }, now: 0, cfg,
  });
  const r = broker.replay(pos, [{ t: 0, h: 105, l: 93, c: 100 }], cfg);
  assert.strictEqual(r.trades[0].reason, 'stop hit');
  assert.strictEqual(r.trades[0].exit, 104);
});

test('step: opens once per flip, only right after the 4H close', () => {
  const entry = candles(reversal(), 4 * H);
  const lastClosed = entry[entry.length - 2].t;
  const exit = candles(Array(50).fill(entry[entry.length - 1].c), H, lastClosed + 4 * H - 49 * H);
  const market = { BTCUSDT: { entry, exit } };
  const c = { ...cfg, SYMBOLS: ['BTCUSDT'] };
  const now = lastClosed + 4 * H + 7 * 60000;

  const late = emptyState();
  step({ st: late, market, now: now + 3 * H, cfg: c });
  assert.strictEqual(Object.keys(late.positions).length, 0);
  assert.strictEqual(late.signals.BTCUSDT.wait, 'stale');

  const st = emptyState();
  const r = step({ st, market, now, cfg: c });
  assert.strictEqual(r.events.filter(e => e.type === 'enter').length, 1);
  const pos = st.positions.BTCUSDT;
  assert.ok(Math.abs(pos.riskAmt - 50) < 1e-6 || pos.margin === 200);
  delete st.positions.BTCUSDT;
  const again = step({ st, market, now: now + 60000, cfg: c });
  assert.strictEqual(again.events.filter(e => e.type === 'enter').length, 0);
  assert.strictEqual(st.signals.BTCUSDT.wait, 'used');
});

test('step: max 3 in one direction, max 5 open, daily loss limit', () => {
  const entry = candles(reversal(), 4 * H);
  const lastClosed = entry[entry.length - 2].t;
  const exit = candles(Array(50).fill(entry[entry.length - 1].c), H, lastClosed + 4 * H - 49 * H);
  const market = Object.fromEntries(config.SYMBOLS.map(s => [s, { entry, exit }]));
  const now = lastClosed + 4 * H + 7 * 60000;

  const st = emptyState();
  step({ st, market, now, cfg });
  assert.strictEqual(Object.keys(st.positions).length, 3);
  assert.strictEqual(Object.values(st.signals).filter(s => s.wait === 'direction').length, 5);

  const hit = emptyState();
  hit.account.balance = 790;
  hit.trades.push({ symbol: 'BTCUSDT', pnl: -210, fee: 0, closedAt: now - 60000, openedAt: 0 });
  step({ st: hit, market, now, cfg });
  assert.strictEqual(Object.keys(hit.positions).length, 0);
  assert.ok(Object.values(hit.signals).every(s => s.wait === 'daily'));
});
