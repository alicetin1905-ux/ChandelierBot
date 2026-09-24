// OKX Demo Trading client (signed REST, v5). Every request carries
// `x-simulated-trading: 1`, so orders only ever reach OKX's demo
// environment — a live-trading key is rejected by OKX with this header
// (code 50101). There is no real-money mode in this build.
//
// Keys come from the environment (GitHub Actions secrets):
//   OKX_API_KEY, OKX_API_SECRET, OKX_API_PASSPHRASE
//   OKX_API_BASE (optional, default https://www.okx.com)
//
// Sizes: OKX swaps trade in contracts (ctVal coins each). This client takes
// and returns contracts; exchange.js converts to coins.
'use strict';

const crypto = require('crypto');

function sign(secret, ts, method, path, body) {
  return crypto.createHmac('sha256', secret).update(ts + method + path + body).digest('base64');
}

function instId(symbol) { return symbol.replace('USDT', '') + '-USDT-SWAP'; }
function symbolOf(id) { return id.replace('-USDT-SWAP', 'USDT'); }

function createClient({ apiKey, apiSecret, passphrase, base = 'https://www.okx.com', fetchImpl = fetch } = {}) {
  if (!apiKey || !apiSecret || !passphrase) throw new Error('OKX demo keys missing: set OKX_API_KEY, OKX_API_SECRET and OKX_API_PASSPHRASE');
  base = base.replace(/\/+$/, '');
  let posMode = null; // 'net_mode' | 'long_short_mode'
  const instCache = {};

  async function call(method, path, params) {
    let body = '';
    if (method === 'GET' && params) {
      const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null && v !== '')).toString();
      if (q) path += '?' + q;
    } else if (params) {
      body = JSON.stringify(params);
    }
    const ts = new Date().toISOString();
    const res = await fetchImpl(base + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'OK-ACCESS-KEY': apiKey,
        'OK-ACCESS-SIGN': sign(apiSecret, ts, method, path, body),
        'OK-ACCESS-TIMESTAMP': ts,
        'OK-ACCESS-PASSPHRASE': passphrase,
        'x-simulated-trading': '1',
      },
      body: method === 'GET' ? undefined : body,
    });
    let d;
    try { d = await res.json(); } catch (e) { throw new Error(`${method} ${path} -> HTTP ${res.status}`); }
    if (d.code !== '0') {
      const detail = (d.data || []).map(x => x.sMsg || x.sCode).filter(Boolean).join('; ');
      throw new Error(`${method} ${path.split('?')[0]} -> OKX ${d.code}: ${d.msg || ''}${detail ? ' (' + detail + ')' : ''}`);
    }
    // Batch/order endpoints report per-item failures inside data.
    for (const x of d.data || []) {
      if (x && x.sCode && x.sCode !== '0') throw new Error(`${method} ${path.split('?')[0]} -> OKX ${x.sCode}: ${x.sMsg}`);
    }
    return d.data || [];
  }

  async function getConfig() {
    const [c] = await call('GET', '/api/v5/account/config');
    posMode = c.posMode;
    return { posMode: c.posMode, acctLv: +c.acctLv, uid: c.uid };
  }
  async function mode() { if (!posMode) await getConfig(); return posMode; }
  // Order side fields for opening (reduce=false) or closing a `bias` position.
  async function sides(bias, reduce) {
    const hedge = (await mode()) === 'long_short_mode';
    const side = (bias === 1) !== reduce ? 'buy' : 'sell';
    return hedge ? { side, posSide: bias === 1 ? 'long' : 'short' } : { side, ...(reduce ? { reduceOnly: true } : {}) };
  }

  return {
    sign, getConfig,

    async getWallet() {
      const [b] = await call('GET', '/api/v5/account/balance', { ccy: 'USDT' });
      const u = (b && b.details || []).find(d => d.ccy === 'USDT') || {};
      const equity = +(u.eq || 0);
      const available = +(u.availEq || u.availBal || 0);
      return { equity, available };
    },

    async getInstrument(symbol) {
      if (instCache[symbol]) return instCache[symbol];
      const [i] = await call('GET', '/api/v5/public/instruments', { instType: 'SWAP', instId: instId(symbol) });
      if (!i) throw new Error(`no OKX instrument ${instId(symbol)}`);
      return (instCache[symbol] = { ctVal: +i.ctVal, lotSz: +i.lotSz, minSz: +i.minSz, tickSz: +i.tickSz, lotStr: i.lotSz, tickStr: i.tickSz });
    },

    // { SYMBOL: { bias, contracts, avgPx, markPx, upl } } for every open USDT swap.
    async getPositions() {
      const rows = await call('GET', '/api/v5/account/positions', { instType: 'SWAP' });
      const out = {};
      for (const p of rows) {
        const n = +p.pos;
        if (!n || !/-USDT-SWAP$/.test(p.instId)) continue;
        const bias = p.posSide === 'long' ? 1 : p.posSide === 'short' ? -1 : Math.sign(n);
        out[symbolOf(p.instId)] = { bias, contracts: Math.abs(n), avgPx: +p.avgPx, markPx: +p.markPx, upl: +p.upl };
      }
      return out;
    },

    async setLeverage(symbol, lever) {
      await call('POST', '/api/v5/account/set-leverage', { instId: instId(symbol), lever: String(lever), mgnMode: 'cross' });
    },

    async openMarket({ symbol, bias, contracts }) {
      const [o] = await call('POST', '/api/v5/trade/order', { instId: instId(symbol), tdMode: 'cross', ordType: 'market', sz: String(contracts), ...(await sides(bias, false)) });
      return o.ordId;
    },

    async closeMarket({ symbol, bias, contracts }) {
      const [o] = await call('POST', '/api/v5/trade/order', { instId: instId(symbol), tdMode: 'cross', ordType: 'market', sz: String(contracts), ...(await sides(bias, true)) });
      return o.ordId;
    },

    async placeTarget({ symbol, bias, contracts, px }) {
      const [o] = await call('POST', '/api/v5/trade/order', { instId: instId(symbol), tdMode: 'cross', ordType: 'limit', px: String(px), sz: String(contracts), ...(await sides(bias, true)) });
      return o.ordId;
    },

    // Position-level stop: closes the WHOLE remaining position at market when
    // last price crosses triggerPx, whatever size is left after targets fill.
    async placeStop({ symbol, bias, triggerPx }) {
      const s = await sides(bias, true);
      const [o] = await call('POST', '/api/v5/trade/order-algo', {
        instId: instId(symbol), tdMode: 'cross', ordType: 'conditional', closeFraction: '1',
        slTriggerPx: String(triggerPx), slOrdPx: '-1', slTriggerPxType: 'last', ...s,
      });
      return o.algoId;
    },

    async amendStop({ symbol, algoId, triggerPx }) {
      await call('POST', '/api/v5/trade/amend-algos', { instId: instId(symbol), algoId, newSlTriggerPx: String(triggerPx), newSlOrdPx: '-1' });
    },

    async getOrder(symbol, ordId) {
      const [o] = await call('GET', '/api/v5/trade/order', { instId: instId(symbol), ordId });
      return { state: o.state, avgPx: +o.avgPx || 0, filledContracts: +o.accFillSz || 0, fee: +o.fee || 0 };
    },

    // Cancels every pending order and stop on this coin.
    async cancelAll(symbol) {
      const id = instId(symbol);
      const orders = await call('GET', '/api/v5/trade/orders-pending', { instType: 'SWAP', instId: id });
      if (orders.length) await call('POST', '/api/v5/trade/cancel-batch-orders', orders.map(o => ({ instId: id, ordId: o.ordId })));
      const algos = await call('GET', '/api/v5/trade/orders-algo-pending', { ordType: 'conditional', instId: id });
      if (algos.length) await call('POST', '/api/v5/trade/cancel-algos', algos.map(a => ({ instId: id, algoId: a.algoId })));
    },

    // Fills on this coin since `sinceMs` (last 3 days), oldest first.
    async getFills(symbol, sinceMs) {
      const rows = await call('GET', '/api/v5/trade/fills', { instType: 'SWAP', instId: instId(symbol), begin: String(sinceMs), limit: '100' });
      return rows.map(f => ({
        tradeId: f.tradeId, ordId: f.ordId, px: +f.fillPx, contracts: +f.fillSz,
        pnl: +(f.fillPnl || 0), fee: +(f.fee || 0), at: +f.ts,
      })).sort((a, b) => a.at - b.at);
    },
  };
}

function fromEnv(env = process.env) {
  return createClient({ apiKey: env.OKX_API_KEY, apiSecret: env.OKX_API_SECRET, passphrase: env.OKX_API_PASSPHRASE, base: env.OKX_API_BASE || undefined });
}
function hasKeys(env = process.env) { return !!(env.OKX_API_KEY && env.OKX_API_SECRET && env.OKX_API_PASSPHRASE); }

module.exports = { createClient, fromEnv, hasKeys, sign, instId };
