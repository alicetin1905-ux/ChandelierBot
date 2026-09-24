# Chandelier Bot

A paper-trading bot, separate from UltimateTradingBot and TradeBot (own
state, own workflow, own ntfy topic, own dashboard). It trades the
same eight coins as [TradeBot](https://github.com/alicetin1905-ux/TradeBot)
(BTC, ETH, SOL, XRP, BNB, DOGE, HYPE, SUI perps) with TradeBot's money
rules, but its signal comes from three indicators only:

- **Chandelier Exit (everget)** — ATR period **4**, multiplier **2**, extremums from closes.
- **ZLSMA** — Zero Lag LSMA, length **38**.
- **MACD** — fast **5**, slow **35**, signal **5**.

Paper trading only: OKX public market data, simulated fills, no API keys,
no exchange account, no real orders.

## Entry

On closed **4H** candles (nothing repaints intrabar):

- **Long:** the Chandelier Exit flips to *buy*, the close is **above** ZLSMA 38
  and the MACD line is **above** its signal line.
- **Short:** the Chandelier Exit flips to *sell*, the close is **below** ZLSMA 38
  and the MACD line is **below** its signal line.

ZLSMA/MACD may confirm up to 3 candles after the flip (`CONFIRM_BARS`), as
long as the Chandelier hasn't flipped back. Each flip is traded once. Entries
only happen on the run right after a 4H close (00/04/08/12/16/20 UTC), at the
current price. When more coins qualify than there are slots, the biggest
MACD histogram (in ATRs) goes first.

## Risk, SL and TP (same as TradeBot)

- One shared **1000 USDT** balance.
- **50 USDT loss at the stop** per trade; position capped at **200 USDT margin
  at 10x** (2000 USDT), so a stop tighter than 2.5% risks less than 50.
- **Max 5 open**, **max 3 in one direction**; a trade only opens if the full
  margin is free.
- **Stop:** entry ∓ 1.5 × ATR(14), widened to the Chandelier Exit stop when that's further.
- **Targets:** T1 / T2 / T3 at **1.5R / 3R / 4.5R**, closing **40% / 35% / 25%**.
  Stop moves to **breakeven** when T1 fills.
- **Daily loss limit:** no new entries for the rest of the UTC day once today's
  realized loss reaches 20% of the day's starting balance.
- Bybit fees are simulated (0.055% taker on entry/stop, 0.02% maker on targets).

Stops and targets are checked on every closed **1H** candle, stop first when
one candle touches both.

One difference from TradeBot: **no flip exit** (`FLIP_EXIT: false`). CE 4/2
flips much more often than TradeBot's ATLAS score, and closing on every flip
did clearly worse in the replay below. Set it to `true` in `config.js` to
turn it on.

## Backtest

`node scripts/backtest.js [days] [--flip-exit]` replays the
live `step()` hour by hour over OKX history. Results on 2026-09-24:

| Window | Flip exit | Trades | Win | Result | Max drawdown |
|---|---|---:|---:|---:|---:|
| 120 days | off (live) | 44 | 43% | +29% | 29% |
| 120 days | on | 141 | 34% | −36% | 70% |
| 240 days | off (live) | 97 | 43% | +54% | 33% |
| 240 days | on | 274 | 38% | +40% | 46% |

It's an approximation (no slippage, fills at exact levels), and past results
don't predict future ones.

## Phone alerts (ntfy)

Install the **ntfy** app and subscribe to the topic
**`chandelierbot-q7m3xk9vte2p`** (server `ntfy.sh`). It's a separate topic from
TradeBot's. You'll get:

- every entry (entry, SL, T1–T3, margin, loss at stop), T1/T2 fill and exit;
- a quiet status after every 4H close (open trades with live P&L, balance, slots, CE direction per coin);
- a daily summary at 05:00 UTC (08:00 Istanbul).

Change the topic in `config.js` → `NOTIFY.NTFY_TOPIC`, or set an
`NTFY_TOPIC` environment variable (`off` disables alerts).

## Running

```
node src/run.js                  # one run (npm start)
node --test test/*.test.js       # offline tests (npm test)
node scripts/backtest.js 120     # replay (npm run backtest)
node src/reset.js [--clear-history]
```

Requires Node 18+ (native `fetch`), no dependencies, no API keys.

`.github/workflows/bot.yml` runs it every hour at :07 and commits
`state/*.json` back to the repo. **Reset** on the dashboard opens
`.github/workflows/reset.yml` → *Run workflow* (tick "Also wipe the
closed-trade history" to start completely fresh).

Dashboard: `index.html`, on GitHub Pages (Settings → Pages → branch `main`, root) at
<https://alicetin1905-ux.github.io/ChandelierBot/>.

## Layout

```
config.js            every knob: indicators, risk, targets, fees, ntfy
src/signal.js        CE + ZLSMA + MACD read, stop/target plan
src/broker.js        sizing, T1/T2/T3 replay, breakeven, daily loss limit
src/run.js           hourly run (step() is the pure core, also used by the backtest)
src/notify.js        ntfy pushes
src/state.js         state/*.json
src/reset.js         back to 1000 USDT
src/indicators.js    indicator math (CE, ZLSMA, MACD, ATR, ...) from ATLAS
src/okx.js           OKX public REST client (no API key)
scripts/backtest.js  hour-by-hour replay over OKX history
test/                offline tests
```
