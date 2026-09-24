// Persistence for the paper broker. GitHub Actions runners are ephemeral, so
// everything the bot remembers between runs lives in state/*.json,
// committed back to the repo by .github/workflows/bot.yml.
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'state');
const KEYS = ['account', 'positions', 'trades', 'signals', 'used', 'equity', 'notify', 'closing', 'seenTrades'];
const EQUITY_KEEP = 24 * 90; // ~90 days of hourly points

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, name + '.json'), 'utf8')); } catch (e) { return fallback; }
}
function writeJson(name, data) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(path.join(DIR, name + '.json'), JSON.stringify(data, null, 2) + '\n');
}

function freshAccount(config, now = Date.now()) {
  const b = config.PORTFOLIO.STARTING_BALANCE;
  return { startingBalance: b, balance: b, createdAt: now, updatedAt: now, mode: 'paper' };
}

function load(config) {
  return {
    account: readJson('account', null) || freshAccount(config),
    positions: readJson('positions', {}),  // symbol -> open position
    trades: readJson('trades', []),        // closed slices (T1/T2/T3/stop/flip), append-only
    signals: readJson('signals', {}),      // symbol -> latest indicator read, for the dashboard
    used: readJson('used', {}),            // symbol -> flipAt of the last Chandelier flip traded
    equity: readJson('equity', []),        // [time, balance, equity incl. open P&L]
    notify: readJson('notify', {}),        // which scheduled pushes went out
    closing: readJson('closing', {}),      // OKX demo: closed positions whose last fills may still land
    seenTrades: readJson('seenTrades', []), // OKX demo: fill ids already booked
  };
}

function save(st) {
  if (st.equity.length > EQUITY_KEEP) st.equity = st.equity.slice(-EQUITY_KEEP);
  for (const k of KEYS) writeJson(k, st[k]);
}

module.exports = { load, save, freshAccount, DIR };
