#!/usr/bin/env node
// Resets the Chandelier bot to its starting balance and drops all open
// positions without recording trades for them. Trade history is kept unless
// run with --clear-history. Run via .github/workflows/reset.yml.
'use strict';

const config = require('../config');
const state = require('./state');

const clear = process.argv.includes('--clear-history');
const st = state.load(config);
st.account = { ...state.freshAccount(config), mode: st.account.mode || 'paper' };
st.closing = {};
st.positions = {};
st.used = {};
st.equity = [];
st.notify = {};
if (clear) st.trades = [];
state.save(st);
console.log(`Chandelier bot reset to $${config.PORTFOLIO.STARTING_BALANCE} — positions dropped${clear ? ', trade history cleared' : ''}.`);
