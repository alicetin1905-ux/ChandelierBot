// OKX Demo executor — turns the bot's decisions into demo orders (okxDemo.js),
// the same way TradeBot runs its Bybit demo account:
//
//   1. Reconcile every tracked position with OKX: book realized fills (OKX's
//      own fill P&L, net of fees), detect T1/T2 fills from the shrinking
//      position, move the stop to breakeven after T1, and forget positions
//      OKX has fully closed.
//   2. Open new positions into free slots: market entry, then a
//      position-level stop (closes whatever is left) and reduce-only limit
//      orders for T1/T2/T3 (40/35/25%).
//
// Stops and targets live ON OKX, so they keep working between hourly runs.
// Signal levels are carried over as % distances from OKX's actual fill.
'use strict';

const config = require('../config');
const signal = require('./signal');
const broker = require('./broker');

const P = config.PORTFOLIO;
const DAY_MS = 86400000;

function decimals(stepStr) { return (String(stepStr).split('.')[1] || '').length; }
function floorStep(x, step, stepStr) { return +(Math.floor(x / step + 1e-9) * step).toFixed(decimals(stepStr)); }
function roundStep(x, step, stepStr) { return +(Math.round(x / step) * step).toFixed(decimals(stepStr)); }

// T1/T2/T3 contracts on the lot step; a slice below the minimum folds into the next one.
function splitTargets(contracts, inst, split = config.TARGET_SPLIT) {
  let c1 = floorStep(contracts * split[0], inst.lotSz, inst.lotStr);
  let c2 = floorStep(contracts * split[1], inst.lotSz, inst.lotStr);
  if (c1 < inst.minSz) { c2 += c1; c1 = 0; }
  if (c2 < inst.minSz) c2 = 0;
  const c3 = +(contracts - c1 - c2).toFixed(decimals(inst.lotStr));
  return [c1, c2, c3];
}

function reasonFor(pos, ordId) {
  const o = pos.orders || {};
  if (ordId === o.t1) return pos.beAfter === 't1' ? 'T1 hit, stop moved to breakeven' : 'T1 hit';
  if (ordId === o.t2) return 'T2 hit';
  if (ordId === o.t3) return 'T3 hit, position closed';
  if (ordId && ordId === o.close) return pos.closedBy || 'closed at market';
  return pos.breakeven ? 'breakeven stop hit' : 'stop hit';
}

// Books new closing fills of `pos` (grouped per order) into the trade log and
// balance. Each carries its share of the entry fee. Returns coins booked.
async function recordFills(client, st, pos, events) {
  const fills = await client.getFills(pos.symbol, pos.openedAt - 60000);
  const seen = new Set(st.seenTrades);
  // Orders of other trades on the same coin (a newer one opened after this
  // one closed) never count for this one; nor does anything well after its close.
  const foreign = new Set();
  for (const p of [...Object.values(st.positions), ...Object.values(st.closing)]) {
    if (p !== pos && p.symbol === pos.symbol) Object.values(p.orders || {}).forEach(id => foreign.add(id));
  }
  const until = pos.closedDetectedAt ? pos.closedDetectedAt + 5 * 60000 : Infinity;
  const groups = {};
  for (const f of fills) {
    if (seen.has(f.tradeId) || f.ordId === pos.orders.entry || foreign.has(f.ordId) || f.at > until) continue;
    st.seenTrades.push(f.tradeId);
    const g = groups[f.ordId] = groups[f.ordId] || { ordId: f.ordId, coins: 0, value: 0, pnl: 0, fee: 0, at: 0 };
    const coins = f.contracts * pos.ctVal;
    g.coins += coins; g.value += coins * f.px; g.pnl += f.pnl; g.fee += f.fee; g.at = Math.max(g.at, f.at);
  }
  if (st.seenTrades.length > 2000) st.seenTrades = st.seenTrades.slice(-2000);
  let booked = 0;
  for (const g of Object.values(groups).sort((a, b) => a.at - b.at)) {
    const entryFeeShare = pos.entryFee * Math.min(1, g.coins / pos.qtyTotal);
    const pnl = g.pnl + g.fee - entryFeeShare; // OKX fees are negative numbers
    const reason = reasonFor(pos, g.ordId);
    const exit = g.value / g.coins;
    st.trades.push({
      symbol: pos.symbol, bias: pos.bias, entry: pos.entry, exit, qty: g.coins, pnl,
      fee: entryFeeShare - g.fee, reason, openedAt: pos.openedAt, closedAt: g.at,
    });
    st.account.balance += pnl;
    pos.closedCoins = (pos.closedCoins || 0) + g.coins;
    booked += g.coins;
    events.push({ symbol: pos.symbol, type: /^T[12] hit/.test(reason) ? 'partial' : 'exit', reason, pnl, price: exit });
  }
  return booked;
}

// Forgets a closed position; keeps it around (st.closing) only while some of
// its closing fills haven't been booked yet.
function moveToClosing(st, sym, pos, now) {
  pos.closedDetectedAt = now;
  if ((pos.closedCoins || 0) < pos.qtyTotal * 0.999) st.closing[sym + ':' + pos.openedAt] = pos;
  delete st.positions[sym];
}

async function reconcile({ client, st, exPos, analyses, events, now, cfg }) {
  // Closed positions whose last fills may land a little late.
  for (const [key, pos] of Object.entries(st.closing)) {
    try {
      await recordFills(client, st, pos, events);
      if ((pos.closedCoins || 0) >= pos.qtyTotal * 0.999 || now - pos.closedDetectedAt > DAY_MS) delete st.closing[key];
    } catch (err) { events.push({ symbol: pos.symbol, type: 'error', reason: err.message }); }
  }

  for (const sym of Object.keys(st.positions)) {
    const pos = st.positions[sym];
    try {
      await recordFills(client, st, pos, events);
      const live = exPos[sym];
      if (!live || live.bias !== pos.bias) {
        await client.cancelAll(sym); // leftover target orders / stop
        if (!events.some(e => e.symbol === sym && e.type === 'exit')) {
          events.push({ symbol: sym, type: 'info', reason: 'closed on OKX — final fill not booked yet, retrying next run' });
        }
        moveToClosing(st, sym, pos, now);
        continue;
      }

      pos.contractsRemaining = live.contracts;
      pos.qtyRemaining = live.contracts * pos.ctVal;
      pos.markPrice = live.markPx;
      pos.unrealisedPnl = live.upl;
      const eps = pos.contractsTotal * 1e-6;
      if (!pos.filled.t1 && pos.c1 > 0 && live.contracts <= pos.contractsTotal - pos.c1 + eps) pos.filled.t1 = true;
      if (!pos.filled.t2 && pos.c2 > 0 && live.contracts <= pos.c3 + eps) pos.filled.t2 = true;

      // A stop that failed to place earlier: try again every run.
      if (!pos.orders.stop) {
        pos.orders.stop = await client.placeStop({ symbol: sym, bias: pos.bias, triggerPx: pos.stop });
        events.push({ symbol: sym, type: 'info', reason: `stop placed on OKX at ${pos.stop}` });
      }

      if (pos.beAfter !== 'off' && pos.filled[pos.beAfter] && !pos.breakeven) {
        const be = roundStep(pos.entry, pos.tickSz, pos.tickStr);
        try {
          await client.amendStop({ symbol: sym, algoId: pos.orders.stop, triggerPx: be });
          pos.stop = be;
          pos.breakeven = true;
          events.push({ symbol: sym, type: 'info', reason: `${pos.beAfter.toUpperCase()} filled, OKX stop moved to breakeven` });
        } catch (err) {
          // Usually: price is already back through entry, so a breakeven
          // stop would have triggered — close what's left now.
          await client.cancelAll(sym);
          pos.orders.close = await client.closeMarket({ symbol: sym, bias: pos.bias, contracts: live.contracts });
          pos.closedBy = 'closed at market (breakeven stop could not be set)';
          pos.breakeven = true;
          events.push({ symbol: sym, type: 'info', reason: `couldn't move stop to breakeven (${err.message}) — closed at market` });
          await recordFills(client, st, pos, events);
          moveToClosing(st, sym, pos, now);
          delete exPos[sym];
          continue;
        }
      }

      const a = analyses[sym];
      if (cfg.FLIP_EXIT && a && a.bias !== pos.bias && a.closedAt >= pos.signalAt) {
        await client.cancelAll(sym);
        pos.orders.close = await client.closeMarket({ symbol: sym, bias: pos.bias, contracts: live.contracts });
        pos.closedBy = `Chandelier Exit flipped ${a.bias === 1 ? 'to buy' : 'to sell'}`;
        await recordFills(client, st, pos, events);
        moveToClosing(st, sym, pos, now);
        delete exPos[sym];
      }
    } catch (err) {
      events.push({ symbol: sym, type: 'error', reason: err.message });
    }
  }
}

async function openEntries({ client, st, exPos, wallet, candidates, prices, events, now, cfg }) {
  if (!candidates.length) return;
  const daily = broker.dailyLossHit(st, cfg, now);
  let available = wallet.available;
  for (const { symbol: sym, a } of candidates) {
    const sig = st.signals[sym];
    const hold = (wait, reason) => { sig.wait = wait; events.push({ symbol: sym, type: 'hold', reason }); };
    try {
      if (daily) { hold('daily', `daily loss limit (${cfg.DAILY_LOSS_LIMIT_PCT}%) reached — no new entries until 00:00 UTC`); continue; }
      if (exPos[sym]) { hold('slots', 'a position is already open on OKX for this coin'); continue; }
      const open = Object.values(exPos);
      if (open.length >= P.MAX_OPEN_POSITIONS) { hold('slots', `all ${P.MAX_OPEN_POSITIONS} position slots in use`); continue; }
      const same = open.filter(p => p.bias === a.bias).length;
      if (same >= P.MAX_SAME_DIRECTION) { hold('direction', `already ${same} ${a.bias === 1 ? 'longs' : 'shorts'} open (max ${P.MAX_SAME_DIRECTION})`); continue; }

      const plan = signal.plan(a, prices[sym], cfg);
      const sized = broker.size(plan, P);
      const base = Math.max(0, Math.min(st.account.balance, wallet.equity));
      const free = Math.min(base - broker.usedMargin(st.positions), available * 0.95);
      if (free < sized.margin * 0.99) { hold('margin', `not enough free margin for a full $${sized.margin.toFixed(0)} trade ($${Math.max(0, free).toFixed(0)} free)`); continue; }

      const inst = await client.getInstrument(sym);
      const contracts = floorStep(sized.qty / inst.ctVal, inst.lotSz, inst.lotStr);
      if (contracts < inst.minSz) { hold('margin', `size ${contracts} contracts is below OKX's minimum ${inst.minSz}`); continue; }

      await client.setLeverage(sym, P.LEVERAGE);
      const entryId = await client.openMarket({ symbol: sym, bias: a.bias, contracts });
      const ord = await client.getOrder(sym, entryId);
      const after = await client.getPositions();
      const live = after[sym];
      if (!live) { events.push({ symbol: sym, type: 'error', reason: `entry order ${entryId} sent but no position showed up` }); continue; }

      const entry = ord.avgPx || live.avgPx;
      const lvl = (x) => roundStep(entry * (x / plan.entry), inst.tickSz, inst.tickStr);
      const stop = lvl(plan.stop), tps = [lvl(plan.t1), lvl(plan.t2), lvl(plan.t3)];
      const orders = { entry: entryId };
      try {
        orders.stop = await client.placeStop({ symbol: sym, bias: a.bias, triggerPx: stop });
      } catch (err) {
        // Never leave a position without a stop.
        orders.close = await client.closeMarket({ symbol: sym, bias: a.bias, contracts: live.contracts });
        events.push({ symbol: sym, type: 'error', reason: `stop order failed (${err.message}) — position closed at market` });
        continue;
      }
      const [c1, c2, c3] = splitTargets(live.contracts, inst);
      for (const [k, c, px] of [['t1', c1, tps[0]], ['t2', c2, tps[1]], ['t3', c3, tps[2]]]) {
        if (c <= 0) continue;
        try { orders[k] = await client.placeTarget({ symbol: sym, bias: a.bias, contracts: c, px }); } catch (err) {
          events.push({ symbol: sym, type: 'error', reason: `${k.toUpperCase()} order failed (stop is in place): ${err.message}` });
        }
      }

      const qty = live.contracts * inst.ctVal;
      const margin = (qty * entry) / P.LEVERAGE;
      st.positions[sym] = {
        symbol: sym, bias: a.bias, entry, stop, initialStop: stop, t1: tps[0], t2: tps[1], t3: tps[2],
        qtyTotal: qty, qtyRemaining: qty, contractsTotal: live.contracts, contractsRemaining: live.contracts,
        c1, c2, c3, ctVal: inst.ctVal, tickSz: inst.tickSz, tickStr: inst.tickStr,
        margin, notional: qty * entry, riskAmt: qty * Math.abs(entry - stop), entryFee: -ord.fee,
        filled: { t1: c1 === 0, t2: c2 === 0, t3: false }, breakeven: false, beAfter: cfg.BREAKEVEN_AFTER,
        flipAt: a.flipAt, signalAt: a.closedAt, openedAt: now, orders,
        markPrice: live.markPx || entry, unrealisedPnl: live.upl || 0,
      };
      st.used[sym] = a.flipAt;
      exPos[sym] = live;
      available -= margin;
      delete sig.wait;
      events.push({
        symbol: sym, type: 'enter', bias: a.bias, entry, stop, t1: tps[0], t2: tps[1], t3: tps[2],
        qty, margin, riskAmt: st.positions[sym].riskAmt, zlsma: a.zlsma, hist: a.macd.hist,
      });
    } catch (err) {
      events.push({ symbol: sym, type: 'error', reason: err.message });
    }
  }
}

async function runExchange({ client, st, analyses, candidates, prices, events, now = Date.now(), cfg = config }) {
  const wallet = await client.getWallet();
  const exPos = await client.getPositions();
  await reconcile({ client, st, exPos, analyses, events, now, cfg });
  await openEntries({ client, st, exPos, wallet, candidates, prices, events, now, cfg });
  st.account.exchangeEquity = wallet.equity;
}

// Emergency flatten: cancel every order and market-close every position on
// the bot's coins, tracked or not.
async function closeAll({ client, st, events, now = Date.now(), cfg = config }) {
  const exPos = await client.getPositions();
  for (const sym of cfg.SYMBOLS) {
    try {
      await client.cancelAll(sym);
      const live = exPos[sym];
      if (!live) continue;
      const id = await client.closeMarket({ symbol: sym, bias: live.bias, contracts: live.contracts });
      events.push({ symbol: sym, type: 'info', reason: `closed ${live.contracts} contracts at market` });
      const pos = st.positions[sym];
      if (pos) {
        pos.orders.close = id;
        pos.closedBy = 'closed by close-all';
        await recordFills(client, st, pos, events);
        moveToClosing(st, sym, pos, now);
      }
    } catch (err) {
      events.push({ symbol: sym, type: 'error', reason: err.message });
    }
  }
}

module.exports = { runExchange, closeAll, splitTargets, reconcile, openEntries };
