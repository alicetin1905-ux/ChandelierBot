// Phone alerts via ntfy (https://ntfy.sh) on the bot's own topic
// (config.NOTIFY.NTFY_TOPIC — separate from TradeBot's). One push per
// entry, T1/T2 fill and exit, a quiet status after every 4H close and a
// daily summary. NTFY_TOPIC in the environment overrides the topic;
// NTFY_TOPIC=off disables alerts. A failed push is logged, never fatal.
'use strict';

const config = require('../config');
const broker = require('./broker');

const coin = (s) => s.replace('USDT', '');
const P = config.PORTFOLIO;

function px(x) {
  const a = Math.abs(x);
  const dp = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : 5;
  return (+x).toFixed(dp);
}
function money(x) { return `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`; }

function messagesFor(events, st) {
  const out = [];
  for (const ev of events) {
    const c = coin(ev.symbol || '');
    if (ev.type === 'enter') {
      out.push({
        title: `${c} ${ev.bias === 1 ? 'LONG' : 'SHORT'} opened`,
        message: `Entry ${px(ev.entry)} · SL ${px(ev.stop)}\nT1 ${px(ev.t1)} · T2 ${px(ev.t2)} · T3 ${px(ev.t3)}\nMargin $${ev.margin.toFixed(0)} · loss at stop $${ev.riskAmt.toFixed(0)}\nCE ${ev.bias === 1 ? 'buy' : 'sell'} · ZLSMA ${px(ev.zlsma)} · MACD hist ${ev.hist.toPrecision(3)}`,
        tags: [ev.bias === 1 ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'],
      });
    } else if (ev.type === 'partial') {
      out.push({ title: `${c} ${ev.reason.split(',')[0]} ${money(ev.pnl)}`, message: `${ev.reason} @ ${px(ev.price)}`, tags: ['dart'] });
    } else if (ev.type === 'exit') {
      out.push({ title: `${c} closed ${money(ev.pnl)}`, message: `${ev.reason}${ev.price ? ' @ ' + px(ev.price) : ''}`, tags: [ev.pnl >= 0 ? 'white_check_mark' : 'x'] });
    }
  }
  if (out.length && st) {
    const foot = `\nBalance $${st.account.balance.toFixed(2)} · ${Object.keys(st.positions).length}/${P.MAX_OPEN_POSITIONS} open`;
    for (const m of out) m.message += foot;
  }
  return out;
}

function positionLines(st, prices) {
  const open = Object.values(st.positions);
  let upnl = 0;
  const lines = open.map((p) => {
    const u = prices[p.symbol] != null ? broker.unrealized(p, prices[p.symbol]) : 0;
    upnl += u;
    const hits = ['t1', 't2'].filter(k => p.filled[k]).map(k => k.toUpperCase() + '✓');
    return `${coin(p.symbol)} ${p.bias === 1 ? 'long' : 'short'} ${money(u)} (${((u / p.margin) * 100).toFixed(1)}%)${hits.length ? ' · ' + hits.join(' ') : ''}${p.breakeven ? ' · SL at entry' : ''}`;
  });
  return { lines, upnl, open };
}

function status(st, prices, now = Date.now()) {
  const a = st.account;
  const { lines, upnl, open } = positionLines(st, prices);
  const equity = a.balance + upnl;
  const pct = (equity / a.startingBalance - 1) * 100;
  if (!open.length) lines.push('No open trades');
  lines.push(`Open P&L ${money(upnl)} · realized today ${money(broker.realizedToday(st, now))}`);
  lines.push(`Slots ${open.length}/${P.MAX_OPEN_POSITIONS} · balance $${a.balance.toFixed(2)}`);
  const trend = Object.entries(st.signals)
    .filter(([s]) => !st.positions[s])
    .map(([s, v]) => `${coin(s)} ${v.bias === 1 ? '▲' : '▼'}${v.zlsmaOk && v.macdOk ? '✓' : ''}`);
  if (trend.length) lines.push(`CE: ${trend.join(' ')}`);
  return { title: `Chandelier $${equity.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)`, message: lines.join('\n'), tags: ['clock3'], priority: 2 };
}

// One P&L per position: the T1/T2/T3 slices of one trade are grouped.
function positionResults(trades) {
  const g = {};
  for (const t of trades) {
    const k = t.symbol + ':' + t.openedAt;
    g[k] = (g[k] || 0) + t.pnl;
  }
  return Object.values(g);
}

function daily(st, prices, now = Date.now()) {
  const a = st.account;
  const last = st.notify.summaryBalance;
  const since = last != null ? a.balance - last : a.balance - a.startingBalance;
  const day = st.trades.filter(t => t.closedAt >= now - broker.DAY_MS).reduce((s, t) => s + t.pnl, 0);
  const res = positionResults(st.trades);
  const wins = res.filter(p => p > 0.005).length, losses = res.filter(p => p < -0.005).length;
  const { lines: posLines, upnl } = positionLines(st, prices);
  const lines = [
    `Balance $${a.balance.toFixed(2)} (${money(since)} since ${last != null ? 'yesterday' : 'start'}; started $${a.startingBalance.toFixed(0)})`,
    `Last 24h realized: ${money(day)} · open P&L ${money(upnl)}`,
    res.length ? `All trades: ${wins}W / ${losses}L (${Math.round((wins / res.length) * 100)}% win)` : 'No closed trades yet',
    ...(posLines.length ? posLines : [`Open 0/${P.MAX_OPEN_POSITIONS}`]),
  ];
  return { title: `Chandelier daily · ${money(since)}`, message: lines.join('\n'), tags: ['bar_chart'] };
}

// Returns the scheduled push for this run (daily summary, else the 4H
// status, else null) and marks it sent in st.notify.
function scheduled(st, prices, now = Date.now()) {
  const d = new Date(now);
  const today = d.toISOString().slice(0, 10);
  if (d.getUTCHours() >= config.NOTIFY.DAILY_SUMMARY_HOUR_UTC && st.notify.summaryDate !== today) {
    const msg = daily(st, prices, now);
    st.notify.summaryDate = today;
    st.notify.summaryBalance = st.account.balance;
    return msg;
  }
  const every = config.NOTIFY.STATUS_EVERY_H;
  const slot = Math.floor(now / (every * broker.HOUR_MS));
  if (every && d.getUTCHours() % every === 0 && st.notify.statusSlot !== slot) {
    st.notify.statusSlot = slot;
    return status(st, prices, now);
  }
  return null;
}

function topic() {
  const t = (process.env.NTFY_TOPIC || config.NOTIFY.NTFY_TOPIC || '').trim();
  return /^(off|none|false|0)?$/i.test(t) ? null : t;
}

async function push(messages, { fetchImpl = fetch, log = console.log } = {}) {
  const t = topic();
  if (!t) return 0;
  let sent = 0;
  for (const m of messages) {
    try {
      const res = await fetchImpl(config.NOTIFY.SERVER, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: t, click: config.NOTIFY.CLICK_URL, ...m }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      sent++;
    } catch (err) {
      log(`ntfy push failed (${m.title}): ${err.message}`);
    }
  }
  return sent;
}

module.exports = { messagesFor, status, daily, scheduled, push, topic };
