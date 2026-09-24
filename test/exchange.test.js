// Offline tests of the OKX demo order logic against a fake OKX account.
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const config = require('../config');
const exchange = require('../src/exchange');
const okxDemo = require('../src/okxDemo');

const cfg = { ...config, FLIP_EXIT: false };
const INST = { ctVal: 1, lotSz: 0.01, minSz: 0.01, tickSz: 0.1, lotStr: '0.01', tickStr: '0.1' };

// Minimal fake of okxDemo's client: one-way (net) account, instant market fills.
function fakeOkx({ fillPx = 100, failStop = false } = {}) {
  let id = 0;
  const f = {
    positions: {}, orders: {}, stops: {}, fills: [], calls: [], wallet: { equity: 5000, available: 5000 },
    async getWallet() { return f.wallet; },
    async getInstrument() { return INST; },
    async getPositions() { return JSON.parse(JSON.stringify(f.positions)); },
    async setLeverage(sym, lev) { f.calls.push(['lev', sym, lev]); },
    async openMarket({ symbol, bias, contracts }) {
      const ordId = 'o' + (++id);
      f.positions[symbol] = { bias, contracts, avgPx: fillPx, markPx: fillPx, upl: 0 };
      f.orders[ordId] = { state: 'filled', avgPx: fillPx, filledContracts: contracts, fee: -contracts * INST.ctVal * fillPx * 0.0005 };
      return ordId;
    },
    async getOrder(sym, ordId) { return f.orders[ordId]; },
    async placeStop({ symbol, triggerPx }) {
      if (failStop) throw new Error('stop rejected');
      const algoId = 'a' + (++id); f.stops[algoId] = { symbol, triggerPx }; return algoId;
    },
    async amendStop({ algoId, triggerPx }) { f.stops[algoId].triggerPx = triggerPx; f.calls.push(['amend', triggerPx]); },
    async placeTarget({ symbol, contracts, px }) { const ordId = 'o' + (++id); f.orders[ordId] = { symbol, contracts, px, state: 'live' }; return ordId; },
    async closeMarket({ symbol, contracts }) { const ordId = 'o' + (++id); delete f.positions[symbol]; f.calls.push(['close', symbol, contracts]); return ordId; },
    async cancelAll(sym) { f.calls.push(['cancelAll', sym]); },
    async getFills() { return f.fills.slice(); },
    // Test helper: an order/stop fills `contracts` at px with OKX-style pnl/fee.
    fill(symbol, ordId, contracts, px, at) {
      const p = f.positions[symbol];
      const coins = contracts * INST.ctVal;
      f.fills.push({ tradeId: 't' + (++id), ordId, px, contracts, pnl: (px - p.avgPx) * p.bias * coins, fee: -coins * px * 0.0002, at });
      p.contracts = +(p.contracts - contracts).toFixed(2);
      if (p.contracts <= 0) delete f.positions[symbol];
    },
  };
  return f;
}

const st0 = () => ({ account: { startingBalance: 1000, balance: 1000, mode: 'okx-demo' }, positions: {}, trades: [], signals: { BTCUSDT: {} }, used: {}, equity: [], notify: {}, closing: {}, seenTrades: [] });
// Long signal: stop from 1.5 x ATR 2 = 3 below 100 -> 97 (3%), targets 104.5 / 109 / 113.5.
const cand = { symbol: 'BTCUSDT', a: { bias: 1, atr: 2, ceLongStop: 98, ceShortStop: 120, flipAt: 1, closedAt: 1, zlsma: 99, macd: { hist: 1 } } };

async function openOne(client, st) {
  const events = [];
  await exchange.openEntries({ client, st, exPos: await client.getPositions(), wallet: await client.getWallet(), candidates: [cand], prices: { BTCUSDT: 100 }, events, now: 1000, cfg });
  return events;
}

test('splitTargets: 40/35/25 on the lot step, remainder to T3', () => {
  assert.deepStrictEqual(exchange.splitTargets(16.66, INST), [6.66, 5.83, 4.17]);
  assert.deepStrictEqual(exchange.splitTargets(0.02, INST), [0, 0, 0.02]);
});

test('open: market entry, whole-position stop and three reduce-only targets, sized to $50 at the stop', async () => {
  const client = fakeOkx({ fillPx: 101 });
  const st = st0();
  const ev = await openOne(client, st);
  const pos = st.positions.BTCUSDT;
  assert.strictEqual(ev[0].type, 'enter');
  assert.strictEqual(pos.contractsTotal, 16.66);            // 1666.67 USDT / 100, floored to the lot step
  assert.ok(Math.abs(pos.riskAmt - 50) < 0.6);
  assert.strictEqual(pos.entry, 101);                        // levels carried over as % from the fill
  assert.strictEqual(pos.stop, 98);                          // 101 x 0.97 = 97.97 -> tick 0.1
  assert.deepStrictEqual([pos.t1, pos.t2, pos.t3], [105.5, 110.1, 114.6]);
  assert.ok(pos.orders.stop && pos.orders.t1 && pos.orders.t2 && pos.orders.t3);
  assert.deepStrictEqual(client.calls[0], ['lev', 'BTCUSDT', 10]);
  assert.strictEqual(st.used.BTCUSDT, 1);
});

test('open: a failed stop closes the new position at once', async () => {
  const client = fakeOkx({ failStop: true });
  const st = st0();
  const ev = await openOne(client, st);
  assert.ok(!st.positions.BTCUSDT);
  assert.ok(client.calls.some(c => c[0] === 'close'));
  assert.ok(ev.some(e => e.type === 'error' && /stop order failed/.test(e.reason)));
});

test('reconcile: T1 fill is booked, stop moved to breakeven; stop-out books the rest and closes', async () => {
  const client = fakeOkx({ fillPx: 100 });
  const st = st0();
  await openOne(client, st);
  const pos = st.positions.BTCUSDT;

  client.fill('BTCUSDT', pos.orders.t1, pos.c1, pos.t1, 2000);
  let events = [];
  await exchange.reconcile({ client, st, exPos: await client.getPositions(), analyses: {}, events, now: 3000, cfg });
  assert.strictEqual(events[0].type, 'partial');
  assert.strictEqual(events[0].reason, 'T1 hit, stop moved to breakeven');
  assert.ok(st.positions.BTCUSDT.filled.t1 && st.positions.BTCUSDT.breakeven);
  assert.strictEqual(client.stops[pos.orders.stop].triggerPx, 100);
  const t1Pnl = events[0].pnl;
  assert.ok(t1Pnl > 29 && t1Pnl < 30); // 6.66 x 4.5 = 29.97 minus fees

  client.fill('BTCUSDT', 'triggered-stop', client.positions.BTCUSDT.contracts, 100, 4000);
  events = [];
  await exchange.reconcile({ client, st, exPos: await client.getPositions(), analyses: {}, events, now: 5000, cfg });
  assert.strictEqual(events[0].reason, 'breakeven stop hit');
  assert.ok(!st.positions.BTCUSDT);
  assert.ok(client.calls.some(c => c[0] === 'cancelAll'));
  assert.strictEqual(Object.keys(st.closing).length, 0); // fully booked
  assert.ok(Math.abs(st.account.balance - (1000 + st.trades.reduce((s, t) => s + t.pnl, 0))) < 1e-9);
});

test('open: slot limits count every OKX position, tracked or not', async () => {
  const client = fakeOkx();
  for (const s of ['ETHUSDT', 'SOLUSDT', 'XRPUSDT']) client.positions[s] = { bias: 1, contracts: 1, avgPx: 1, markPx: 1, upl: 0 };
  const st = st0();
  const ev = await openOne(client, st);
  assert.ok(!st.positions.BTCUSDT);
  assert.strictEqual(st.signals.BTCUSDT.wait, 'direction');
  assert.ok(/already 3 longs/.test(ev[0].reason));
});

test('client: signs requests and always sends the demo-trading header', async () => {
  let seen;
  const client = okxDemo.createClient({
    apiKey: 'k', apiSecret: 's', passphrase: 'p',
    fetchImpl: async (url, opts) => { seen = { url, opts }; return { json: async () => ({ code: '0', data: [{ details: [{ ccy: 'USDT', eq: '1234.5', availEq: '1000' }] }] }) }; },
  });
  const w = await client.getWallet();
  assert.deepStrictEqual(w, { equity: 1234.5, available: 1000 });
  const h = seen.opts.headers;
  assert.strictEqual(h['x-simulated-trading'], '1');
  const expect = crypto.createHmac('sha256', 's').update(h['OK-ACCESS-TIMESTAMP'] + 'GET' + '/api/v5/account/balance?ccy=USDT').digest('base64');
  assert.strictEqual(h['OK-ACCESS-SIGN'], expect);
  assert.strictEqual(seen.url, 'https://www.okx.com/api/v5/account/balance?ccy=USDT');
});

test('client: OKX errors surface with their code', async () => {
  const client = okxDemo.createClient({ apiKey: 'k', apiSecret: 's', passphrase: 'p', fetchImpl: async () => ({ json: async () => ({ code: '50101', msg: 'APIKey does not match current environment', data: [] }) }) });
  await assert.rejects(client.getWallet(), /OKX 50101/);
});
