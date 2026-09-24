// Central knobs for the Chandelier bot. Everything else reads from here.
//
// Signals: Chandelier Exit (everget, ATR 4 / x2), ZLSMA 38, MACD 5/35/5.
// Money rules, stop and targets: the same as TradeBot (alicetin1905-ux/TradeBot
// config.js -> PORTFOLIO, TARGETS_R, STOP_ATR, BREAKEVEN_AFTER, EXECUTION).
'use strict';

module.exports = {
  // Same eight coins as TradeBot.
  SYMBOLS: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT', 'DOGEUSDT', 'HYPEUSDT', 'SUIUSDT'],

  // Signal timeframe: entries and flip exits are decided on closed 4H candles
  // (OKX "4H", UTC-aligned), like TradeBot. Stops/targets are checked on
  // every closed 1H candle in between.
  ENTRY_TF: '240',
  EXIT_TF: '60',
  // New entries only on the run right after a 4H close (within this many
  // minutes of it), like TradeBot — a signal isn't chased hours later.
  ENTRY_FRESH_MIN: 90,

  // ---- Indicators ----
  // Chandelier Exit by everget: ATR period 4, multiplier 2, extremums from closes.
  CE_LENGTH: 4,
  CE_MULT: 2,
  // Zero Lag LSMA length.
  ZLSMA_LENGTH: 38,
  // MACD fast / slow / signal.
  MACD_FAST: 5,
  MACD_SLOW: 35,
  MACD_SIGNAL: 5,

  // Entry rule: a Chandelier Exit buy (sell) flip, confirmed by close above
  // (below) ZLSMA 38 and MACD line above (below) its signal line. The
  // confirmations may arrive up to this many 4H candles after the flip, as
  // long as the Chandelier Exit hasn't flipped back in between.
  CONFIRM_BARS: 3,

  // ---- Stop / targets (TradeBot) ----
  // Stop = entry -/+ STOP_ATR x ATR(14), widened to the Chandelier Exit stop when that's further.
  ATR_LENGTH: 14,
  STOP_ATR: 1.5,
  // T1 / T2 / T3 at these multiples of the stop distance (R) from entry.
  TARGETS_R: [1.5, 3, 4.5],
  // Share of the position closed at T1 / T2 / T3 (must sum to 1).
  TARGET_SPLIT: [0.40, 0.35, 0.25],
  // Move the stop to entry once T1 fills.
  BREAKEVEN_AFTER: 't1',
  // Close at market when the 4H Chandelier Exit flips against an open trade.
  // Off: CE 4/2 flips far more often than TradeBot's ATLAS score, and in a
  // replay of the last 120 / 240 days (4H signals, 1H exits, fees) closing on
  // every flip turned +29% / +54% into -36% / +40% with a much deeper drawdown.
  FLIP_EXIT: false,

  // ---- Money rules (TradeBot PORTFOLIO) ----
  PORTFOLIO: {
    STARTING_BALANCE: 1000, // USDT, one shared balance for all coins
    RISK_USDT: 50,          // loss at the stop per trade: position sized so a stop costs this much
    MARGIN_USDT: 200,       // max margin per trade (so max position = 200 x 10 = 2000 USDT)
    LEVERAGE: 10,
    MAX_OPEN_POSITIONS: 5,
    MAX_SAME_DIRECTION: 3,  // at most 3 longs and 3 shorts at once
  },
  // No new entries for the rest of the UTC day once today's realized loss
  // reaches this % of the day's starting balance (TradeBot EXECUTION).
  DAILY_LOSS_LIMIT_PCT: 20,

  // Paper fills: Bybit fees, so the balance tracks what TradeBot would book.
  // Market entries / stops / flip exits pay taker, target limit orders pay maker.
  FEES: { TAKER: 0.00055, MAKER: 0.0002 },

  // ---- Phone alerts via ntfy (src/notify.js) ----
  // Subscribe to this topic in the ntfy app. The NTFY_TOPIC environment
  // variable overrides it; NTFY_TOPIC=off disables alerts.
  NOTIFY: {
    SERVER: 'https://ntfy.sh/',
    NTFY_TOPIC: 'chandelierbot-q7m3xk9vte2p',
    CLICK_URL: 'https://alicetin1905-ux.github.io/ChandelierBot/',
    // Quiet status push on the run right after every 4H close.
    STATUS_EVERY_H: 4,
    // Daily summary on the first run at/after this UTC hour (5 UTC = 08:00 Istanbul).
    DAILY_SUMMARY_HOUR_UTC: 5,
  },
};
