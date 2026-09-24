#!/usr/bin/env node
// One small round-trip on the OKX demo account to prove every order type the
// bot uses works there: market entry, whole-position stop, three reduce-only
// target limits, moving the stop to breakeven, cancel-all and a market close.
// Doesn't touch the bot's state. Aborts if the coin already has a position.
//
//   node scripts/test-trade.js [BTCUSDT] [notional USDC, default 100]
'use strict';

const config = require('../config');
const okxDemo = require('../src/okxDemo');
const notify = require('../src/notify');
const { splitTargets } = require('../src/exchange');
const okx = require('../src/okx');

const symbol = process.argv.find(a => /USDT$/.test(a)) || 'BTCUSDT';
const notional = +process.argv.find(a => /^\d+(\.\d+)?$/.test(a)) || 100;
const lines = [];
const log = (m) => { console.log(m); lines.push(m); };
const decimals = (s) => (String(s).split('.')[1] || '').length;
const tick = (x, i) => +(Math.round(x / i.tickSz) * i.tickSz).toFixed(decimals(i.tickStr));

async function main() {
  const client = await okxDemo.connect(process.env, { settle: config.SETTLE_CCY, market: config.OKX_MARKET });
  const inst = await client.getInstrument(symbol);
  log(`OKX demo on ${client.site} · ${inst.instId} · ctVal ${inst.ctVal} · lot ${inst.lotSz}`);
  if ((await client.getPositions())[symbol]) throw new Error(`${inst.instId} already has an open position — not testing on top of it`);

  let opened = false;
  try {
    await client.setLeverage(symbol, config.PORTFOLIO.LEVERAGE);
    log(`1. leverage set to ${config.PORTFOLIO.LEVERAGE}x ✓`);

    const w = await client.getWallet();
    // Sizing price from the USDT perp, like the bot (X-Perps aren't in OKX's public market data).
    const markPx = (await okx.getKlines(symbol, '60', 1)).pop().c;
    const lot = inst.lotSz;
    const contracts = Math.max(inst.minSz * 3, +(Math.floor(notional / markPx / inst.ctVal / lot) * lot).toFixed(decimals(inst.lotStr)));
    log(`   ${config.SETTLE_CCY} available ${w.available.toFixed(2)} · price ${markPx} · size ${contracts} contracts (≈$${(contracts * inst.ctVal * markPx).toFixed(0)})`);

    const entryId = await client.openMarket({ symbol, bias: 1, contracts });
    opened = true;
    const ord = await client.getOrder(symbol, entryId);
    const entry = ord.avgPx || (await client.getPositions())[symbol].avgPx;
    log(`2. market BUY filled @ ${entry} (fee ${ord.fee}) ✓`);

    const stopPx = tick(entry * 0.97, inst);
    const algoId = await client.placeStop({ symbol, bias: 1, triggerPx: stopPx });
    log(`3. stop (closes whole position) @ ${stopPx} ✓`);

    const [c1, c2, c3] = splitTargets(contracts, inst);
    const tps = [1.015, 1.03, 1.045].map(m => tick(entry * m, inst));
    for (const [k, c, px] of [['T1', c1, tps[0]], ['T2', c2, tps[1]], ['T3', c3, tps[2]]]) {
      if (c <= 0) continue;
      await client.placeTarget({ symbol, bias: 1, contracts: c, px });
      log(`4. ${k} reduce-only limit ${c} @ ${px} ✓`);
    }

    // Live, the stop goes to entry once T1 has filled (price 1.5R above it).
    // Right after entry price can sit a tick under it, where OKX refuses a
    // stop — so the test moves it up to 1.5% under entry instead.
    const moved = tick(entry * 0.985, inst);
    await client.amendStop({ symbol, algoId, triggerPx: moved });
    log(`5. stop moved up to ${moved} (same call as the breakeven move) ✓`);

    await client.cancelAll(symbol);
    log('6. all orders and the stop cancelled ✓');
    const live = (await client.getPositions())[symbol];
    if (live) await client.closeMarket({ symbol, bias: 1, contracts: live.contracts });
    opened = false;
    const after = (await client.getPositions())[symbol];
    if (after) throw new Error(`position still open after close: ${after.contracts}`);
    const fills = await client.getFills(symbol, Date.now() - 10 * 60000);
    const pnl = fills.reduce((s, f) => s + f.pnl + f.fee, 0);
    log(`7. closed at market ✓ · round-trip result ${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} ${config.SETTLE_CCY} (incl. fees)`);
    log('TEST TRADE PASSED — every order type the bot uses works on this account.');
    await notify.push([{ title: 'Chandelier test trade passed ✓', message: lines.slice(1).join('\n'), tags: ['white_check_mark'] }]);
  } finally {
    if (opened) {
      // Something failed half-way: never leave the test position behind.
      try {
        await client.cancelAll(symbol);
        const live = (await client.getPositions())[symbol];
        if (live) await client.closeMarket({ symbol, bias: 1, contracts: live.contracts });
        log('cleanup: test position closed');
      } catch (e) { log(`cleanup FAILED — close ${inst.instId} by hand: ${e.message}`); }
    }
  }
}

main().catch(async (err) => {
  log(`TEST TRADE FAILED: ${err.message}`);
  await notify.push([{ title: 'Chandelier test trade FAILED', message: lines.join('\n'), tags: ['warning'] }]);
  process.exit(1);
});
