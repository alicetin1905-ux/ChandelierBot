// Entry/exit signal: Chandelier Exit (everget) + ZLSMA + MACD on closed
// signal-timeframe candles. The indicator math is the shared kit in
// ./indicators.js — its chandelier() is everget's Chandelier Exit
// (ATR-based, extremums taken from closes, "use close price" on) and its
// zlsma() is the Zero Lag LSMA, the same functions ATLAS/TradeBot use.
//
//   Long:  Chandelier Exit flips to buy, close > ZLSMA, MACD line > signal
//   Short: Chandelier Exit flips to sell, close < ZLSMA, MACD line < signal
//
// The ZLSMA/MACD confirmations may come up to CONFIRM_BARS candles after the
// flip; each flip is traded at most once (the caller remembers flipAt).
'use strict';

const I = require('./indicators');

const nn = (x) => x !== null && x !== undefined && !Number.isNaN(x);

// candles: oldest-first, the LAST one still forming (it's dropped here so
// nothing repaints intrabar). Returns null without enough history.
function analyse(candles, cfg) {
  const k = candles.slice(0, -1);
  const need = Math.max(cfg.ZLSMA_LENGTH * 2, cfg.MACD_SLOW + cfg.MACD_SIGNAL, cfg.ATR_LENGTH, cfg.CE_LENGTH) + 2;
  if (k.length < need) return null;

  const close = k.map(c => c.c);
  const ce = I.chandelier(k, cfg.CE_LENGTH, cfg.CE_MULT);
  const zl = I.zlsma(close, cfg.ZLSMA_LENGTH);
  const md = I.macd(close, cfg.MACD_FAST, cfg.MACD_SLOW, cfg.MACD_SIGNAL);
  const atr = I.atr(k, cfg.ATR_LENGTH);
  const i = k.length - 1;
  if (![ce.dir[i], zl[i], md.line[i], md.signal[i], atr[i]].every(nn)) return null;

  const dir = ce.dir[i];
  // Most recent Chandelier flip into the current direction.
  let f = i;
  while (f > 0 && ce.dir[f - 1] === dir) f--;
  const flipKnown = f > 0 && nn(ce.dir[f - 1]);
  const barsSinceFlip = i - f;

  const zlsmaOk = dir === 1 ? close[i] > zl[i] : close[i] < zl[i];
  const macdOk = dir === 1 ? md.line[i] > md.signal[i] : md.line[i] < md.signal[i];
  const inWindow = flipKnown && barsSinceFlip <= cfg.CONFIRM_BARS;
  const ready = inWindow && zlsmaOk && macdOk;

  return {
    bias: dir,                      // Chandelier direction on the last closed candle
    ready,                          // entry signal on the last closed candle
    flipAt: flipKnown ? k[f].t : null,
    barsSinceFlip,
    inWindow,
    zlsmaOk, macdOk,
    close: close[i],
    zlsma: zl[i],
    macd: { line: md.line[i], signal: md.signal[i], hist: md.hist[i] },
    ceLongStop: ce.longStop[i],
    ceShortStop: ce.shortStop[i],
    ceStop: dir === 1 ? ce.longStop[i] : ce.shortStop[i],
    atr: atr[i],
    closedAt: k[i].t,               // open time of the last closed candle
    // Ranks competing entries: MACD histogram in ATRs, direction-signed.
    strength: (md.hist[i] * dir) / atr[i],
  };
}

// Stop and targets for an entry at `entry` (TradeBot's rule): stop at
// STOP_ATR x ATR, widened to the Chandelier stop when that's further away
// and on the right side of entry; T1/T2/T3 at TARGETS_R multiples of it.
function plan(analysis, entry, cfg) {
  const bias = analysis.bias;
  let stop = entry - bias * cfg.STOP_ATR * analysis.atr;
  if (bias === 1 && analysis.ceLongStop < entry) stop = Math.min(stop, analysis.ceLongStop);
  if (bias === -1 && analysis.ceShortStop > entry) stop = Math.max(stop, analysis.ceShortStop);
  const d = Math.abs(entry - stop);
  const [r1, r2, r3] = cfg.TARGETS_R;
  return {
    bias, entry, stop,
    t1: entry + bias * d * r1,
    t2: entry + bias * d * r2,
    t3: entry + bias * d * r3,
    stopDist: d / entry,
  };
}

module.exports = { analyse, plan };
