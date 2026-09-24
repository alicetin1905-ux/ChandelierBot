// OKX public REST client — same exported shape as the Bybit/Binance clients
// it replaces. Both of those block GitHub Actions' hosted runners outright
// (Bybit: CloudFront geo-block; Binance: a "restricted location" eligibility
// block, both confirmed against real run logs) — OKX's public market-data
// endpoints don't carry either restriction.
'use strict';

const BASE = 'https://www.okx.com';
const BAR = { '30': '30m', '60': '1H', '240': '4H', 'D': '1D' };

// Bybit/Binance-style "BTCUSDT" -> OKX's "BTC-USDT-SWAP" / bare "BTC".
function instId(symbol) { return symbol.replace('USDT', '') + '-USDT-SWAP'; }
function ccy(symbol) { return symbol.replace('USDT', ''); }

async function api(path) {
  const r = await fetch(BASE + path);
  const d = await r.json();
  if (d.code !== '0') throw new Error(`${path} -> ${d.msg || 'OKX API error ' + d.code}`);
  return d.data;
}

async function getKlines(symbol, interval, limit) {
  const bar = BAR[interval] || interval;
  // OKX caps /market/candles at 300 per call regardless of what's asked for.
  const rows = await api(`/api/v5/market/candles?instId=${instId(symbol)}&bar=${bar}&limit=${Math.min(limit, 300)}`);
  // OKX returns newest-first: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
  return rows.slice().reverse().map(k => ({ t: +k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[6] }));
}

async function getTicker(symbol) {
  const rows = await api(`/api/v5/public/funding-rate?instId=${instId(symbol)}`);
  const r = rows[0];
  return r ? { fundingRate: r.fundingRate } : null;
}

async function getOpenInterest(symbol) {
  // Aggregated across all of this currency's instruments (not swap-only),
  // but same spirit as Bybit's 24h open-interest series: oldest-first trend.
  // OKX ignores the limit param on this endpoint (always returns ~30 days),
  // so the last-24 slice below is what actually keeps this a same-day window.
  const rows = await api(`/api/v5/rubik/stat/contracts/open-interest-volume?ccy=${ccy(symbol)}&period=1H&limit=24`);
  return rows.slice().reverse().slice(-24).map(r => ({ openInterest: r[1], timestamp: r[0] }));
}

async function getAccountRatio(symbol) {
  const rows = await api(`/api/v5/rubik/stat/contracts/long-short-account-ratio-contract?instId=${instId(symbol)}&period=1H&limit=1`);
  const r = rows[0];
  if (!r) return null;
  // OKX gives one long/short ratio, not separate percentages — rebuild both
  // from it: ratio = long/short, so buyRatio = ratio/(ratio+1).
  const ratio = +r[1];
  return { buyRatio: String(ratio / (ratio + 1)), sellRatio: String(1 / (ratio + 1)) };
}

async function getOrderbook(symbol) {
  const rows = await api(`/api/v5/market/books?instId=${instId(symbol)}&sz=100`);
  const r = rows[0];
  return r ? { b: r.bids, a: r.asks } : null;
}

async function getRecentTrades(symbol) {
  const rows = await api(`/api/v5/market/trades?instId=${instId(symbol)}&limit=500`);
  return rows.map(t => ({ S: t.side === 'buy' ? 'Buy' : 'Sell', v: t.sz }));
}

// Fetches everything analyse() needs for one symbol in one go.
async function loadSymbolData(symbol, mtfTfs, entryTf) {
  const tfSet = Array.from(new Set([...mtfTfs, entryTf, 'D']));
  const klineEntries = await Promise.all(
    tfSet.map(async (tf) => [tf, await getKlines(symbol, tf, 500)])
  );
  const candles = Object.fromEntries(klineEntries);
  const [ticker, oi, ratio, book, tape] = await Promise.all([
    getTicker(symbol).catch(() => null),
    getOpenInterest(symbol).catch(() => []),
    getAccountRatio(symbol).catch(() => null),
    getOrderbook(symbol).catch(() => null),
    getRecentTrades(symbol).catch(() => null),
  ]);
  return { symbol, candles, ticker, oi, ratio, book, tape };
}

module.exports = { api, getKlines, getTicker, getOpenInterest, getAccountRatio, getOrderbook, getRecentTrades, loadSymbolData };
