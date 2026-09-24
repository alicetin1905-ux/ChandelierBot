#!/usr/bin/env node
// Chandelier bot — one hourly run: fetch OKX candles for every coin, manage
// open paper positions (stops/targets on closed 1H candles, flip exit on the
// 4H Chandelier Exit), open new trades on fresh CE + ZLSMA + MACD signals,
// save state, push ntfy alerts. Scheduled by .github/workflows/bot.yml.
'use strict';

const config = require('../config');
const okx = require('./okx');
const signal = require('./signal');
const broker = require('./broker');
const state = require('./state');
const notify = require('./notify');

const P = config.PORTFOLIO;
const TF_MS = { '60': 3600000, '240': 4 * 3600000 };

// Pure core of a run, so it can be tested offline.
// market: { SYMBOL: { entry: 4H candles, exit: 1H candles } } (oldest-first, last one forming)
function step({ st, market, now = Date.now(), cfg = config }) {
  const events = [];
  const prices = {};
  const analyses = {};

  // 1) Read the signal and manage whatever is open.
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

    const pos = st.positions[symbol];
    if (!pos) continue;
    const r = broker.replay(pos, m.exit.slice(0, -1), cfg, TF_MS[cfg.EXIT_TF]);
    book(st, r.trades);
    events.push(...r.events);
    if (r.closed) { delete st.positions[symbol]; continue; }
    st.positions[symbol] = r.position;

    if (cfg.FLIP_EXIT && a.bias !== r.position.bias && a.closedAt >= r.position.signalAt) {
      const c = broker.closeAtMarket(r.position, prices[symbol], `Chandelier Exit flipped ${a.bias === 1 ? 'to buy' : 'to sell'}`, now, cfg);
      book(st, [c.trade]);
      events.push(c.event);
      delete st.positions[symbol];
    }
  }

  // 2) New entries, strongest MACD histogram first.
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
  candidates.sort((x, y) => y.a.strength - x.a.strength);

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

  // 3) Equity point for the dashboard chart.
  const upnl = Object.values(st.positions).reduce((s, p) => s + (prices[p.symbol] != null ? broker.unrealized(p, prices[p.symbol]) : 0), 0);
  st.equity.push([now, round2(st.account.balance), round2(st.account.balance + upnl)]);
  st.account.updatedAt = now;
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

async function main() {
  const st = state.load(config);
  const fetchEvents = [];
  const market = await fetchMarket(config, fetchEvents);
  if (!Object.keys(market).length) throw new Error('no market data for any coin: ' + fetchEvents.map(e => e.reason).join('; '));
  const { events, prices } = step({ st, market });
  events.unshift(...fetchEvents);
  const scheduled = notify.scheduled(st, prices);
  state.save(st);
  printSummary(events, st, prices);
  await notify.push(notify.messagesFor(events, st));
  if (scheduled) await notify.push([scheduled]);
}

if (require.main === module) {
  main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { step };
