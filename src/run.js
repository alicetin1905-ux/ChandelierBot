#!/usr/bin/env node
// Chandelier bot — one hourly run: fetch OKX candles for every coin, manage
// open positions, open new trades on fresh CE + ZLSMA + MACD signals, save
// state, push ntfy alerts. Scheduled by .github/workflows/bot.yml.
//
// Two modes, picked by whether the OKX demo keys are set:
//   paper     simulated fills (stops/targets replayed on closed 1H candles)
//   okx-demo  real orders on the OKX demo account (src/exchange.js)
//
//   node src/run.js              one run
//   node src/run.js --check      OKX demo: check keys/account, no trading
//   node src/run.js --close-all  OKX demo: cancel all orders, close all positions
'use strict';

const config = require('../config');
const okx = require('./okx');
const signal = require('./signal');
const broker = require('./broker');
const state = require('./state');
const notify = require('./notify');
const okxDemo = require('./okxDemo');
const exchange = require('./exchange');

const P = config.PORTFOLIO;
const TF_MS = { '60': 3600000, '240': 4 * 3600000 };

// Reads every coin's 4H signal into st.signals; returns { analyses, prices, events }.
// market: { SYMBOL: { entry: 4H candles, exit: 1H candles } } (oldest-first, last one forming)
function readSignals({ st, market, now, cfg }) {
  const events = [], prices = {}, analyses = {};
  for (const symbol of cfg.SYMBOLS) {
    const m = market[symbol];
    if (!m) continue;
    prices[symbol] = m.exit[m.exit.length - 1].c;
    const a = signal.analyse(m.entry, cfg);
    if (!a) { events.push({ symbol, type: 'skip', reason: 'not enough candle history yet' }); continue; }
    analyses[symbol] = a;
    st.signals[symbol] = {
      bias: a.bias, ready: a.ready, flipAt: a.flipAt, barsSinceFlip: a.barsSinceFlip,
      zlsmaOk: a.zlsmaOk, macdOk: a.macdOk, close: a.close, zlsma: a.zlsma,
      macd: a.macd, ceStop: a.ceStop, atr: a.atr, closedAt: a.closedAt, price: prices[symbol], at: now,
    };
  }
  return { analyses, prices, events };
}

// Paper positions: replay closed 1H candles against stop/targets, then the flip exit.
function managePaper({ st, market, analyses, prices, events, now, cfg }) {
  for (const symbol of Object.keys(st.positions)) {
    const pos = st.positions[symbol], m = market[symbol], a = analyses[symbol];
    if (!m) continue;
    const r = broker.replay(pos, m.exit.slice(0, -1), cfg, TF_MS[cfg.EXIT_TF]);
    book(st, r.trades);
    events.push(...r.events);
    if (r.closed) { delete st.positions[symbol]; continue; }
    st.positions[symbol] = r.position;
    if (cfg.FLIP_EXIT && a && a.bias !== r.position.bias && a.closedAt >= r.position.signalAt) {
      const c = broker.closeAtMarket(r.position, prices[symbol], `Chandelier Exit flipped ${a.bias === 1 ? 'to buy' : 'to sell'}`, now, cfg);
      book(st, [c.trade]);
      events.push(c.event);
      delete st.positions[symbol];
    }
  }
}

// Coins with no open position and a fresh, unused signal — strongest MACD histogram first.
function pickCandidates({ st, analyses, events, now, cfg }) {
  const candidates = [];
  for (const [symbol, a] of Object.entries(analyses)) {
    const sig = st.signals[symbol];
    if (st.positions[symbol]) continue;
    const hold = (wait, reason) => { sig.wait = wait; events.push({ symbol, type: 'hold', reason }); };
    if (!a.ready) {
      sig.wait = !a.inWindow ? 'noflip' : 'confirm';
      events.push({ symbol, type: 'flat', reason: waitText(a, cfg) });
      continue;
    }
    if (st.used[symbol] === a.flipAt) { hold('used', 'already traded this Chandelier flip — waits for the next one'); continue; }
    const closedAgo = now - (a.closedAt + TF_MS[cfg.ENTRY_TF]);
    if (cfg.ENTRY_FRESH_MIN != null && closedAgo > cfg.ENTRY_FRESH_MIN * 60000) {
      hold('stale', `signal candle closed ${Math.round(closedAgo / 60000)} min ago — entries only right after a 4H close`);
      continue;
    }
    candidates.push({ symbol, a });
  }
  return candidates.sort((x, y) => y.a.strength - x.a.strength);
}

function openPaper({ st, candidates, prices, events, now, cfg }) {
  const daily = candidates.length && broker.dailyLossHit(st, cfg, now);
  for (const { symbol, a } of candidates) {
    const sig = st.signals[symbol];
    const hold = (wait, reason) => { sig.wait = wait; events.push({ symbol, type: 'hold', reason }); };
    if (daily) { hold('daily', `daily loss limit (${cfg.DAILY_LOSS_LIMIT_PCT}%) reached — no new entries until 00:00 UTC`); continue; }
    const open = Object.values(st.positions);
    if (open.length >= P.MAX_OPEN_POSITIONS) { hold('slots', `all ${P.MAX_OPEN_POSITIONS} position slots in use`); continue; }
    const same = open.filter(p => p.bias === a.bias).length;
    if (same >= P.MAX_SAME_DIRECTION) { hold('direction', `already ${same} ${a.bias === 1 ? 'longs' : 'shorts'} open (max ${P.MAX_SAME_DIRECTION})`); continue; }

    const plan = signal.plan(a, prices[symbol], cfg);
    const sized = broker.size(plan, P);
    const free = st.account.balance - broker.usedMargin(st.positions);
    if (free < sized.margin * 0.99) { hold('margin', `not enough free margin for a full $${sized.margin.toFixed(0)} trade ($${Math.max(0, free).toFixed(0)} free)`); continue; }

    st.positions[symbol] = broker.openPosition({ symbol, plan, sized, analysis: a, now, cfg });
    st.used[symbol] = a.flipAt;
    delete sig.wait;
    events.push({
      symbol, type: 'enter', bias: a.bias, entry: plan.entry, stop: plan.stop, t1: plan.t1, t2: plan.t2, t3: plan.t3,
      qty: sized.qty, margin: sized.margin, riskAmt: sized.riskAmt, zlsma: a.zlsma, hist: a.macd.hist,
    });
  }
}

// Equity point for the dashboard chart.
function equityPoint(st, prices, now) {
  const upnl = Object.values(st.positions).reduce((s, p) => s + (prices[p.symbol] != null ? broker.unrealized(p, prices[p.symbol]) : 0), 0);
  st.equity.push([now, round2(st.account.balance), round2(st.account.balance + upnl)]);
  st.account.updatedAt = now;
}

// Paper run — pure, so it can be tested offline and replayed by the backtest.
function step({ st, market, now = Date.now(), cfg = config }) {
  const { analyses, prices, events } = readSignals({ st, market, now, cfg });
  managePaper({ st, market, analyses, prices, events, now, cfg });
  const candidates = pickCandidates({ st, analyses, events, now, cfg });
  openPaper({ st, candidates, prices, events, now, cfg });
  equityPoint(st, prices, now);
  return { events, prices };
}

// OKX demo run: same signals and entry gates, orders placed on OKX demo.
async function stepDemo({ client, st, market, now = Date.now(), cfg = config }) {
  const { analyses, prices, events } = readSignals({ st, market, now, cfg });
  const wallet = await client.getWallet();
  const exPos = await client.getPositions();
  await exchange.reconcile({ client, st, exPos, analyses, events, now, cfg });
  const candidates = pickCandidates({ st, analyses, events, now, cfg }).filter(({ symbol }) => {
    if (!client.tradable || client.tradable.has(symbol)) return true;
    st.signals[symbol].wait = 'unavailable';
    events.push({ symbol, type: 'hold', reason: `${client.instId(symbol)} isn't available to this OKX account` });
    return false;
  });
  await exchange.openEntries({ client, st, exPos, wallet, candidates, prices, events, now, cfg });
  st.account.exchangeEquity = wallet.equity;
  equityPoint(st, prices, now);
  return { events, prices };
}

function book(st, trades) {
  for (const t of trades) { st.trades.push(t); st.account.balance += t.pnl; }
}

function waitText(a, cfg) {
  const dir = a.bias === 1 ? 'buy' : 'sell';
  if (!a.inWindow) return `Chandelier on ${dir} for ${a.barsSinceFlip} candles — waits for the next flip`;
  const miss = [!a.zlsmaOk && `close ${a.bias === 1 ? 'above' : 'below'} ZLSMA ${cfg.ZLSMA_LENGTH}`, !a.macdOk && `MACD ${a.bias === 1 ? 'above' : 'below'} signal`].filter(Boolean);
  return `Chandelier ${dir} flip ${a.barsSinceFlip} candle(s) ago — waiting for ${miss.join(' and ')}`;
}

function round2(x) { return Math.round(x * 100) / 100; }

async function fetchMarket(cfg, events) {
  const market = {};
  for (const symbol of cfg.SYMBOLS) {
    try {
      const [entry, exit] = await Promise.all([okx.getKlines(symbol, cfg.ENTRY_TF, 300), okx.getKlines(symbol, cfg.EXIT_TF, 300)]);
      market[symbol] = { entry, exit };
    } catch (err) {
      events.push({ symbol, type: 'error', reason: err.message });
    }
  }
  return market;
}

function printSummary(events, st, prices) {
  console.log(`\n=== Chandelier bot run @ ${new Date().toISOString()} ===\n`);
  for (const ev of events) {
    const tag = `[${ev.symbol}]`;
    if (ev.type === 'enter') {
      console.log(`${tag} ENTER ${ev.bias === 1 ? 'LONG' : 'SHORT'} @ ${fmt(ev.entry)} | SL ${fmt(ev.stop)} T1 ${fmt(ev.t1)} T2 ${fmt(ev.t2)} T3 ${fmt(ev.t3)} | margin $${fmt(ev.margin)} loss at stop $${fmt(ev.riskAmt)}`);
    } else if (ev.type === 'partial' || ev.type === 'exit') {
      console.log(`${tag} ${ev.type === 'exit' ? 'EXIT — ' : ''}${ev.reason} | pnl ${money(ev.pnl)}${ev.price ? ' @ ' + fmt(ev.price) : ''}`);
    } else {
      console.log(`${tag} ${ev.type} — ${ev.reason}`);
    }
  }
  const upnl = Object.values(st.positions).reduce((s, p) => s + broker.unrealized(p, prices[p.symbol] ?? p.entry), 0);
  console.log(`\nBalance $${fmt(st.account.balance)} · open P&L ${money(upnl)} · ${Object.keys(st.positions).length}/${P.MAX_OPEN_POSITIONS} open (started $${fmt(st.account.startingBalance)})`);
}

function fmt(x) { return (Math.round(x * 10000) / 10000).toLocaleString('en-US', { maximumFractionDigits: 4 }); }
function money(x) { return `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`; }

// 'okx-demo' when the OKX demo keys are set (GitHub secrets / env), else 'paper'.
function currentMode() { return okxDemo.hasKeys() ? 'okx-demo' : 'paper'; }

// OKX account settings the orders rely on: margin trading enabled (swaps
// don't trade in "Spot" mode) and not Portfolio margin (no close-all stops there).
async function checkAccount(client) {
  const c = client.config || await client.getConfig();
  // Which of the bot's coins this account can trade in SETTLE_CCY.
  if (!client.tradable) {
    client.tradable = new Set();
    client.missing = [];
    for (const s of config.SYMBOLS) {
      try { await client.getInstrument(s); client.tradable.add(s); } catch (e) { client.missing.push(client.instId(s)); }
    }
    if (!client.tradable.size) throw new Error(`none of the bot's coins can be traded in ${config.SETTLE_CCY} on this OKX account (${client.missing.join(', ')}) — change SETTLE_CCY in config.js`);
  }
  if (c.acctLv === 1) throw new Error('OKX account mode is "Spot" — switch the demo account to "Futures" / single-currency margin (Trade settings -> Account mode) so it can trade perpetual swaps');
  if (c.acctLv === 4) throw new Error('OKX account mode is "Portfolio margin" — switch the demo account to single- or multi-currency margin');
  return c;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = currentMode();
  const st = state.load(config);
  const client = mode === 'okx-demo' ? await okxDemo.connect(process.env, { settle: config.SETTLE_CCY }) : null;

  if (args.includes('--check')) {
    if (!client) { console.log('No OKX demo keys set — the bot runs in paper mode.'); return; }
    const c = client.config;
    console.log(`OKX demo key OK on ${client.site} · account mode ${c.acctLv} · position mode ${c.posMode}`);
    const bal = await client.balances();
    console.log(`Balances: ${bal.details.length ? bal.details.map(d => `${d.ccy} ${d.eq} (available ${d.avail})`).join(', ') : 'none'} · total ≈ $${bal.totalEq.toFixed(2)}`);
    const swaps = await client.listSwaps();
    const bySettle = {};
    for (const i of swaps) bySettle[i.settle] = (bySettle[i.settle] || 0) + 1;
    console.log(`Perps this account can trade: ${swaps.length} (${Object.entries(bySettle).map(([k, v]) => `${v} ${k}-margined`).join(', ') || 'none'})`);
    for (const ccy of Object.keys(bySettle)) {
      const have = config.SYMBOLS.filter(sym => swaps.some(i => i.instId === okxDemo.instId(sym, ccy)));
      console.log(`  bot coins as ${ccy}-margined: ${have.length ? have.map(sym => sym.replace('USDT', '')).join(', ') : 'none'}`);
    }
    await checkAccount(client).catch(err => console.log('Bot setting SETTLE_CCY=' + config.SETTLE_CCY + ': ' + err.message));
    if (client.tradable && client.tradable.size) {
      const w = await client.getWallet();
      console.log(`Bot trades ${[...client.tradable].map(sym => client.instId(sym)).join(', ')} · ${config.SETTLE_CCY} available ${w.available.toFixed(2)}`);
      if (client.missing.length) console.log(`Not available (skipped): ${client.missing.join(', ')}`);
      if (w.available < config.PORTFOLIO.MARGIN_USDT) console.log(`WARNING: only ${w.available.toFixed(2)} ${config.SETTLE_CCY} available — the bot can't open trades until the demo Trading account holds more`);
    }
    return;
  }

  if (args.includes('--close-all')) {
    if (!client) throw new Error('--close-all needs the OKX demo keys');
    const events = [];
    await exchange.closeAll({ client, st, events });
    state.save(st);
    printSummary(events, st, {});
    const failed = events.filter(e => e.type === 'error');
    await notify.push([{ title: failed.length ? 'Close-all: some closes failed' : 'All positions closed', message: events.map(e => `${e.symbol.replace('USDT', '')}: ${e.reason}`).join('\n') || 'Nothing was open.', tags: ['octagonal_sign'] }]);
    if (failed.length) process.exit(1);
    return;
  }

  // Switching between paper and OKX demo starts a fresh 1000 USDT account:
  // paper positions don't exist on OKX and vice versa.
  if ((st.account.mode || 'paper') !== mode) {
    const fresh = state.freshAccount(config);
    Object.assign(st, { account: { ...fresh, mode }, positions: {}, trades: [], used: {}, equity: [], closing: {}, seenTrades: [] });
    await notify.push([{ title: `Chandelier bot now in ${mode === 'okx-demo' ? 'OKX DEMO' : 'PAPER'} mode`, message: `Fresh ${config.PORTFOLIO.STARTING_BALANCE} ${mode === 'okx-demo' ? config.SETTLE_CCY : 'USDT'} account.${mode === 'okx-demo' ? ` Orders go to your OKX demo account (${config.SETTLE_CCY}-margined perps).` : ''}`, tags: ['gear'] }]);
  }

  const fetchEvents = [];
  const market = await fetchMarket(config, fetchEvents);
  if (!Object.keys(market).length) throw new Error('no market data for any coin: ' + fetchEvents.map(e => e.reason).join('; '));
  let result;
  if (client) {
    await checkAccount(client);
    result = await stepDemo({ client, st, market });
  } else {
    result = step({ st, market });
  }
  const { events, prices } = result;
  events.unshift(...fetchEvents);
  const scheduled = notify.scheduled(st, prices);
  state.save(st);
  printSummary(events, st, prices);
  await notify.push(notify.messagesFor(events, st));
  const errors = events.filter(e => e.type === 'error' && e.symbol && market[e.symbol]);
  if (errors.length) await notify.push([{ title: 'Chandelier bot: order problem', message: errors.map(e => `${e.symbol.replace('USDT', '')}: ${e.reason}`).join('\n'), tags: ['warning'] }]);
  if (scheduled) await notify.push([scheduled]);
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err);
    await notify.push([{ title: 'Chandelier bot run failed', message: err.message, tags: ['warning'] }]);
    process.exit(1);
  });
}

module.exports = { step, stepDemo, readSignals, pickCandidates };
