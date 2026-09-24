// Paper broker with TradeBot's money rules: one shared balance, a fixed
// dollar loss at the stop per trade (capped margin at 10x), max open
// positions / per direction, scaled T1/T2/T3 exit with the stop moved to
// breakeven after T1, flip exit, and a daily loss limit. No real orders.
'use strict';

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

// Position size for one trade: sized so hitting the stop loses RISK_USDT,
// never more than MARGIN_USDT x LEVERAGE of position value.
function size(plan, P) {
  const maxNotional = P.MARGIN_USDT * P.LEVERAGE;
  const notional = P.RISK_USDT != null && plan.stopDist > 0
    ? Math.min(P.RISK_USDT / plan.stopDist, maxNotional)
    : maxNotional;
  const qty = notional / plan.entry;
  return { qty, notional, margin: notional / P.LEVERAGE, riskAmt: qty * Math.abs(plan.entry - plan.stop) };
}

function usedMargin(positions) {
  return Object.values(positions).reduce((s, p) => s + p.margin * (p.qtyRemaining / p.qtyTotal), 0);
}

function realizedToday(st, now) {
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  return st.trades.filter(t => t.closedAt >= dayStart).reduce((s, t) => s + t.pnl, 0);
}

function dailyLossHit(st, cfg, now) {
  const today = realizedToday(st, now);
  const startOfDay = st.account.balance - today;
  return today < 0 && -today >= startOfDay * cfg.DAILY_LOSS_LIMIT_PCT / 100;
}

function openPosition({ symbol, plan, sized, analysis, now, cfg }) {
  const split = cfg.TARGET_SPLIT;
  return {
    symbol,
    bias: plan.bias,
    entry: plan.entry,
    stop: plan.stop,
    initialStop: plan.stop,
    t1: plan.t1, t2: plan.t2, t3: plan.t3,
    qtyTotal: sized.qty,
    qtyRemaining: sized.qty,
    qtyT1: sized.qty * split[0],
    qtyT2: sized.qty * split[1],
    qtyT3: sized.qty * split[2],
    margin: sized.margin,
    notional: sized.notional,
    riskAmt: sized.riskAmt,
    entryFee: sized.notional * cfg.FEES.TAKER,
    filled: { t1: false, t2: false, t3: false },
    breakeven: false,
    beAfter: cfg.BREAKEVEN_AFTER,
    flipAt: analysis.flipAt,
    signalAt: analysis.closedAt,
    openedAt: now,
    // First exit-timeframe candle to replay: the one the entry happened in.
    nextCheck: Math.floor(now / HOUR_MS) * HOUR_MS,
  };
}

// Closes `qty` of `pos` at `price` and returns the booked trade. Each slice
// carries its share of the entry fee plus its own exit fee.
function closeSlice(pos, qty, price, feeRate, reason, closedAt) {
  const gross = (price - pos.entry) * pos.bias * qty;
  const fee = pos.entryFee * (qty / pos.qtyTotal) + qty * price * feeRate;
  pos.qtyRemaining = Math.max(0, pos.qtyRemaining - qty);
  return {
    symbol: pos.symbol, bias: pos.bias, entry: pos.entry, exit: price, qty,
    pnl: gross - fee, fee, reason, openedAt: pos.openedAt, closedAt,
  };
}

// Replays closed exit-timeframe candles since the last check against the
// stop and remaining targets. On each candle: stop first (worst case when a
// candle touches both), then T1 -> T2 -> T3. Returns { position, trades, events, closed }.
function replay(position, candles, cfg, tfMs = HOUR_MS) {
  const pos = { ...position, filled: { ...position.filled } };
  const trades = [], events = [];
  const F = cfg.FEES;
  const be = (k) => {
    if (pos.beAfter === k && !pos.breakeven) { pos.stop = pos.entry; pos.breakeven = true; return ', stop moved to breakeven'; }
    return '';
  };

  for (const c of candles) {
    if (c.t < pos.nextCheck) continue;
    const at = c.t + tfMs;
    pos.nextCheck = at;

    const hitStop = pos.bias === 1 ? c.l <= pos.stop : c.h >= pos.stop;
    if (hitStop) {
      const reason = pos.breakeven ? 'breakeven stop hit' : 'stop hit';
      const t = closeSlice(pos, pos.qtyRemaining, pos.stop, F.TAKER, reason, at);
      trades.push(t);
      events.push({ symbol: pos.symbol, type: 'exit', reason, pnl: t.pnl, price: pos.stop });
      return { position: pos, trades, events, closed: true };
    }

    for (const k of ['t1', 't2', 't3']) {
      if (pos.filled[k]) continue;
      const hit = pos.bias === 1 ? c.h >= pos[k] : c.l <= pos[k];
      if (!hit) break;
      const qty = k === 't3' ? pos.qtyRemaining : pos['qty' + k.toUpperCase()];
      pos.filled[k] = true;
      if (k === 't3') {
        const t = closeSlice(pos, qty, pos.t3, F.MAKER, 'T3 hit, position closed', at);
        trades.push(t);
        events.push({ symbol: pos.symbol, type: 'exit', reason: t.reason, pnl: t.pnl, price: pos.t3 });
        return { position: pos, trades, events, closed: true };
      }
      const reason = k.toUpperCase() + ' hit' + be(k);
      const t = closeSlice(pos, qty, pos[k], F.MAKER, reason, at);
      trades.push(t);
      events.push({ symbol: pos.symbol, type: 'partial', reason, pnl: t.pnl, price: pos[k] });
    }
  }
  return { position: pos, trades, events, closed: false };
}

// Market close of whatever is left (flip exit / manual close).
function closeAtMarket(pos, price, reason, now, cfg) {
  const p = { ...pos, filled: { ...pos.filled } };
  const t = closeSlice(p, p.qtyRemaining, price, cfg.FEES.TAKER, reason, now);
  return { trade: t, event: { symbol: pos.symbol, type: 'exit', reason, pnl: t.pnl, price } };
}

function unrealized(pos, price) {
  return (price - pos.entry) * pos.bias * pos.qtyRemaining;
}

module.exports = { size, usedMargin, realizedToday, dailyLossHit, openPosition, replay, closeAtMarket, unrealized, HOUR_MS, DAY_MS };
