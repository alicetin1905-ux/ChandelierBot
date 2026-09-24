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

// What the usual key/setup errors mean, added to the error message.
const HINTS = {
  50101: 'this is a live-trading key; create the key inside OKX Demo Trading instead',
  50105: 'wrong passphrase: OKX_API_PASSPHRASE must be the passphrase you chose when creating this key',
  50111: 'OKX_API_KEY is not a valid key',
  50113: 'signature rejected: check OKX_API_SECRET (the "Secret key" shown once when the key was created)',
  50119: 'OKX does not know this key at this address: check OKX_API_KEY, that the key was created in Demo Trading and still exists, and — if your account is on a regional OKX site (e.g. EEA my.okx.com, US app.okx.com) — set the repository variable OKX_API_BASE to that site',
};

// The bot names coins "BTCUSDT" etc. internally (signals come from OKX's
// USDT perps); orders go to the perp settled in `settle` (config.SETTLE_CCY).
function instId(symbol, settle = 'USDT') { return symbol.replace('USDT', '') + '-' + settle + '-SWAP'; }
function symbolOf(id, settle = 'USDT') { return id.replace('-' + settle + '-SWAP', 'USDT'); }

function createClient({ apiKey, apiSecret, passphrase, base = 'https://www.okx.com', settle = 'USDT', fetchImpl = fetch } = {}) {
  if (!apiKey || !apiSecret || !passphrase) throw new Error('OKX demo keys missing: set OKX_API_KEY, OKX_API_SECRET and OKX_API_PASSPHRASE');
  base = base.replace(/\/+$/, '');
  let posMode = null; // 'net_mode' | 'long_short_mode'
  const instCache = {};
  const inst = (symbol) => instId(symbol, settle);

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
      throw new Error(`${method} ${path.split('?')[0]} -> OKX ${d.code}: ${d.msg || ''}${detail ? ' (' + detail + ')' : ''}${HINTS[d.code] ? ' — ' + HINTS[d.code] : ''}`);
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
    sign, getConfig, settle, instId: inst,

    async getWallet() {
      const [b] = await call('GET', '/api/v5/account/balance', { ccy: settle });
      const u = (b && b.details || []).find(d => d.ccy === settle) || {};
      const equity = +(u.eq || 0);
      const available = +(u.availEq || u.availBal || 0);
      return { equity, available };
    },

    async getInstrument(symbol) {
      if (instCache[symbol]) return instCache[symbol];
      // The account's own list: only what this account (region, mode) may trade.
      const [i] = await call('GET', '/api/v5/account/instruments', { instType: 'SWAP', instId: inst(symbol) }).catch((err) => {
        if (/OKX (51001|51000)/.test(err.message)) return []; // unknown / unavailable instrument
        throw err;
      });
      if (!i) throw new Error(`${inst(symbol)} is not available to this OKX account`);
      return (instCache[symbol] = { ctVal: +i.ctVal, lotSz: +i.lotSz, minSz: +i.minSz, tickSz: +i.tickSz, lotStr: i.lotSz, tickStr: i.tickSz });
    },

    // Diagnostics for --check: every swap this account may trade, and every non-zero balance.
    async listSwaps(instType = 'SWAP') {
      const rows = await call('GET', '/api/v5/account/instruments', { instType });
      return rows.map(i => ({ instId: i.instId, settle: i.settleCcy || i.quoteCcy, state: i.state, raw: i }));
    },
    async balances() {
      const [b] = await call('GET', '/api/v5/account/balance');
      return { totalEq: +(b && b.totalEq || 0), details: (b && b.details || []).filter(d => +d.eq).map(d => ({ ccy: d.ccy, eq: +d.eq, eqUsd: +d.eqUsd || 0, avail: +(d.availEq || d.availBal || 0) })) };
    },

    // { SYMBOL: { bias, contracts, avgPx, markPx, upl } } for every open swap settled in `settle`.
    async getPositions() {
      const rows = await call('GET', '/api/v5/account/positions', { instType: 'SWAP' });
      const out = {};
      for (const p of rows) {
        const n = +p.pos;
        if (!n || !p.instId.endsWith('-' + settle + '-SWAP')) continue;
        const bias = p.posSide === 'long' ? 1 : p.posSide === 'short' ? -1 : Math.sign(n);
        out[symbolOf(p.instId, settle)] = { bias, contracts: Math.abs(n), avgPx: +p.avgPx, markPx: +p.markPx, upl: +p.upl };
      }
      return out;
    },

    async setLeverage(symbol, lever) {
      await call('POST', '/api/v5/account/set-leverage', { instId: inst(symbol), lever: String(lever), mgnMode: 'cross' });
    },

    async openMarket({ symbol, bias, contracts }) {
      const [o] = await call('POST', '/api/v5/trade/order', { instId: inst(symbol), tdMode: 'cross', ordType: 'market', sz: String(contracts), ...(await sides(bias, false)) });
      return o.ordId;
    },

    async closeMarket({ symbol, bias, contracts }) {
      const [o] = await call('POST', '/api/v5/trade/order', { instId: inst(symbol), tdMode: 'cross', ordType: 'market', sz: String(contracts), ...(await sides(bias, true)) });
      return o.ordId;
    },

    async placeTarget({ symbol, bias, contracts, px }) {
      const [o] = await call('POST', '/api/v5/trade/order', { instId: inst(symbol), tdMode: 'cross', ordType: 'limit', px: String(px), sz: String(contracts), ...(await sides(bias, true)) });
      return o.ordId;
    },

    // Position-level stop: closes the WHOLE remaining position at market when
    // last price crosses triggerPx, whatever size is left after targets fill.
    async placeStop({ symbol, bias, triggerPx }) {
      const s = await sides(bias, true);
      const [o] = await call('POST', '/api/v5/trade/order-algo', {
        instId: inst(symbol), tdMode: 'cross', ordType: 'conditional', closeFraction: '1',
        slTriggerPx: String(triggerPx), slOrdPx: '-1', slTriggerPxType: 'last', ...s,
      });
      return o.algoId;
    },

    async amendStop({ symbol, algoId, triggerPx }) {
      await call('POST', '/api/v5/trade/amend-algos', { instId: inst(symbol), algoId, newSlTriggerPx: String(triggerPx), newSlOrdPx: '-1' });
    },

    async getOrder(symbol, ordId) {
      const [o] = await call('GET', '/api/v5/trade/order', { instId: inst(symbol), ordId });
      return { state: o.state, avgPx: +o.avgPx || 0, filledContracts: +o.accFillSz || 0, fee: +o.fee || 0 };
    },

    // Cancels every pending order and stop on this coin.
    async cancelAll(symbol) {
      const id = inst(symbol);
      const orders = await call('GET', '/api/v5/trade/orders-pending', { instType: 'SWAP', instId: id });
      if (orders.length) await call('POST', '/api/v5/trade/cancel-batch-orders', orders.map(o => ({ instId: id, ordId: o.ordId })));
      const algos = await call('GET', '/api/v5/trade/orders-algo-pending', { ordType: 'conditional', instId: id });
      if (algos.length) await call('POST', '/api/v5/trade/cancel-algos', algos.map(a => ({ instId: id, algoId: a.algoId })));
    },

    // Fills on this coin since `sinceMs` (last 3 days), oldest first.
    async getFills(symbol, sinceMs) {
      const rows = await call('GET', '/api/v5/trade/fills', { instType: 'SWAP', instId: inst(symbol), begin: String(sinceMs), limit: '100' });
      return rows.map(f => ({
        tradeId: f.tradeId, ordId: f.ordId, px: +f.fillPx, contracts: +f.fillSz,
        pnl: +(f.fillPnl || 0), fee: +(f.fee || 0), at: +f.ts,
      })).sort((a, b) => a.at - b.at);
    },
  };
}

// Secrets pasted with a stray space or newline would otherwise fail as "key doesn't exist".
const clean = (v) => (v || '').trim();
function fromEnv(env = process.env, settle = 'USDT') {
  return createClient({ apiKey: clean(env.OKX_API_KEY), apiSecret: clean(env.OKX_API_SECRET), passphrase: clean(env.OKX_API_PASSPHRASE), base: clean(env.OKX_API_BASE) || undefined, settle });
}
function hasKeys(env = process.env) { return !!(clean(env.OKX_API_KEY) && clean(env.OKX_API_SECRET) && clean(env.OKX_API_PASSPHRASE)); }

// OKX's own sites: a key only exists on the site its account belongs to.
const SITES = ['https://www.okx.com', 'https://my.okx.com', 'https://app.okx.com', 'https://tr.okx.com'];

// Client from the environment. Without OKX_API_BASE, if www.okx.com doesn't
// know the key (50119), tries OKX's regional sites and uses the one that does.
async function connect(env = process.env, { log = console.log, create = createClient, settle = 'USDT' } = {}) {
  const keys = { apiKey: clean(env.OKX_API_KEY), apiSecret: clean(env.OKX_API_SECRET), passphrase: clean(env.OKX_API_PASSPHRASE), settle };
  const fixed = clean(env.OKX_API_BASE);
  const client = create({ ...keys, base: fixed || SITES[0] });
  try {
    client.config = await client.getConfig();
    client.site = fixed || SITES[0];
    return client;
  } catch (err) {
    if (fixed || !/OKX 50119/.test(err.message)) throw err;
    const tried = [SITES[0]];
    for (const base of SITES.slice(1)) {
      tried.push(base);
      try {
        const c = create({ ...keys, base });
        c.config = await c.getConfig();
        c.site = base;
        log(`OKX key found on ${base} — set the repository variable OKX_API_BASE=${base} to skip this lookup`);
        return c;
      } catch (e) { /* not this site */ }
    }
    throw new Error(`${err.message} (tried ${tried.join(', ')})`);
  }
}

module.exports = { createClient, fromEnv, connect, hasKeys, sign, instId, SITES };
