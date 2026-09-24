#!/usr/bin/env node
// Replays the live bot hour by hour over OKX history:
//   node scripts/backtest.js [days=120] [--flip-exit]
// Every hour it calls the same step() the hourly run uses, with only the
// candles that existed at that time, so entries, sizing, fees, targets and
// the daily loss limit all behave as live. Approximation: fills at the
// hourly price / exact stop and target levels, no slippage, stop first
// when one candle touches both.
'use strict';

const okx = require('../src/okx');
const config = require('../config');
const { step } = require('../src/run');

const H = 3600000;
const days = +process.argv.find(a => /^\d+$/.test(a)) || 120;
if (process.argv.includes('--flip-exit')) config.FLIP_EXIT = true;

async function history(symbol, bar, n) {
  const out = [];
  let after = '';
  while (out.length < n) {
    const rows = await okx.api(`/api/v5/market/history-candles?instId=${symbol.replace('USDT', '')}-USDT-SWAP&bar=${bar}&limit=100${after ? '&after=' + after : ''}`);
    if (!rows.length) break;
    out.push(...rows);
    after = rows[rows.length - 1][0];
  }
  return out.reverse().map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] }));
}

async function main() {
  const data = {};
  for (const s of config.SYMBOLS) {
    data[s] = { entry: await history(s, '4H', days * 6 + 200), exit: await history(s, '1H', days * 24 + 50) };
  }
  const b = config.PORTFOLIO.STARTING_BALANCE;
  const st = { account: { startingBalance: b, balance: b }, positions: {}, trades: [], signals: {}, used: {}, equity: [], notify: {} };
  const end = Math.floor(Date.now() / H) * H - H;
  let entries = 0, peak = b, maxDd = 0;
  for (let T = end - days * 24 * H; T <= end; T += H) {
    const market = {};
    for (const s of config.SYMBOLS) {
      const e = data[s].entry.filter(c => c.t <= T), x = data[s].exit.filter(c => c.t <= T);
      if (e.length >= 100 && x.length >= 2) market[s] = { entry: e.slice(-300), exit: x.slice(-300) };
    }
    const { events } = step({ st, market, now: T + 7 * 60000 });
    entries += events.filter(e => e.type === 'enter').length;
    const eq = st.equity[st.equity.length - 1][2];
    peak = Math.max(peak, eq);
    maxDd = Math.max(maxDd, 1 - eq / peak);
    st.equity = [];
  }
  const byTrade = {};
  for (const t of st.trades) byTrade[t.symbol + t.openedAt] = (byTrade[t.symbol + t.openedAt] || 0) + t.pnl;
  const res = Object.values(byTrade);
  const reasons = {};
  for (const t of st.trades) reasons[t.reason] = (reasons[t.reason] || 0) + 1;
  console.log(`${days} days · flip exit ${config.FLIP_EXIT ? 'on' : 'off'}`);
  console.log(`entries ${entries} · closed ${res.length} · wins ${res.filter(x => x > 0).length}`);
  console.log(`balance $${st.account.balance.toFixed(2)} (${((st.account.balance / b - 1) * 100).toFixed(1)}%) · max drawdown ${(maxDd * 100).toFixed(1)}% · fees $${st.trades.reduce((s, t) => s + t.fee, 0).toFixed(2)} · still open ${Object.keys(st.positions).length}`);
  console.log('exits:', reasons);
}

main().catch((err) => { console.error(err); process.exit(1); });
