// Indicator math ported verbatim from ATLAS (alicetin1905-ux/atlas index.html)
// so this bot's scoring is byte-for-byte the same logic already shown on the
// dashboard, not a re-derivation of it.
'use strict';

const nn = (x) => x !== null && x !== undefined && !Number.isNaN(x);

function sma(v, p) {
  const o = Array(v.length).fill(null); let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i]; if (i >= p) s -= v[i - p];
    if (i >= p - 1) o[i] = s / p;
  } return o;
}
function ema(v, p) {
  const o = Array(v.length).fill(null), k = 2 / (p + 1); let s = 0;
  for (let i = 0; i < v.length; i++) {
    if (i < p - 1) { s += v[i]; continue; }
    if (i === p - 1) { s += v[i]; o[i] = s / p; continue; }
    o[i] = v[i] * k + o[i - 1] * (1 - k);
  } return o;
}
function rma(v, p) {
  const o = Array(v.length).fill(null); let s = 0, n = 0, started = false;
  for (let i = 0; i < v.length; i++) {
    if (!nn(v[i])) continue;
    if (!started) {
      s += v[i]; n++;
      if (n === p) { o[i] = s / p; started = true; }
      continue;
    }
    o[i] = (o[i - 1] * (p - 1) + v[i]) / p;
  } return o;
}
function stdev(v, p) {
  const o = Array(v.length).fill(null), m = sma(v, p);
  for (let i = p - 1; i < v.length; i++) {
    let s = 0; for (let k = i - p + 1; k <= i; k++) s += (v[k] - m[i]) ** 2;
    o[i] = Math.sqrt(s / p);
  } return o;
}
function highest(v, p) {
  const o = Array(v.length).fill(null);
  for (let i = p - 1; i < v.length; i++) { let m = -Infinity; for (let k = i - p + 1; k <= i; k++) m = Math.max(m, v[k]); o[i] = m; }
  return o;
}
function lowest(v, p) {
  const o = Array(v.length).fill(null);
  for (let i = p - 1; i < v.length; i++) { let m = Infinity; for (let k = i - p + 1; k <= i; k++) m = Math.min(m, v[k]); o[i] = m; }
  return o;
}
function linreg(v, p) {
  const o = Array(v.length).fill(null);
  for (let i = p - 1; i < v.length; i++) {
    let sx = 0, sy = 0, sxy = 0, sxx = 0, ok = true;
    for (let k = 0; k < p; k++) {
      const y = v[i - p + 1 + k]; if (!nn(y)) { ok = false; break; }
      sx += k; sy += y; sxy += k * y; sxx += k * k;
    }
    if (!ok) continue;
    const d = p * sxx - sx * sx; if (d === 0) continue;
    const slope = (p * sxy - sx * sy) / d, intercept = (sy - slope * sx) / p;
    o[i] = intercept + slope * (p - 1);
  } return o;
}
function trueRange(c) {
  const o = Array(c.length).fill(null);
  for (let i = 0; i < c.length; i++) {
    o[i] = i === 0 ? c[i].h - c[i].l
      : Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c));
  } return o;
}
const atr = (c, p) => rma(trueRange(c), p);

function rsi(v, p) {
  const g = Array(v.length).fill(null), l = Array(v.length).fill(null);
  for (let i = 1; i < v.length; i++) { const d = v[i] - v[i - 1]; g[i] = Math.max(d, 0); l[i] = Math.max(-d, 0); }
  const ag = rma(g, p), al = rma(l, p), o = Array(v.length).fill(null);
  for (let i = 0; i < v.length; i++) {
    if (!nn(ag[i])) continue;
    o[i] = al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i]);
  } return o;
}
function macd(v, f, s, sig) {
  const ef = ema(v, f), es = ema(v, s), line = Array(v.length).fill(null);
  for (let i = 0; i < v.length; i++) if (nn(ef[i]) && nn(es[i])) line[i] = ef[i] - es[i];
  const first = line.findIndex(nn);
  const sl = ema(line.slice(first).map(x => x || 0), sig);
  const signal = Array(first).fill(null).concat(sl);
  const hist = line.map((x, i) => (nn(x) && nn(signal[i])) ? x - signal[i] : null);
  return { line, signal, hist };
}
function adx(c, p) {
  const n = c.length, pdm = Array(n).fill(0), ndm = Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = c[i].h - c[i - 1].h, dn = c[i - 1].l - c[i].l;
    pdm[i] = (up > dn && up > 0) ? up : 0;
    ndm[i] = (dn > up && dn > 0) ? dn : 0;
  }
  const tr = rma(trueRange(c), p), sp = rma(pdm, p), sn = rma(ndm, p);
  const pdi = Array(n).fill(null), ndi = Array(n).fill(null), dx = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (!nn(tr[i]) || tr[i] === 0) continue;
    pdi[i] = 100 * sp[i] / tr[i]; ndi[i] = 100 * sn[i] / tr[i];
    const sum = pdi[i] + ndi[i];
    dx[i] = sum === 0 ? 0 : 100 * Math.abs(pdi[i] - ndi[i]) / sum;
  }
  return { adx: rma(dx, p), pdi, ndi };
}
function supertrend(c, p, mult) {
  const n = c.length, a = atr(c, p), dir = Array(n).fill(null), st = Array(n).fill(null);
  let fu = null, fl = null, prevDir = 1;
  for (let i = 0; i < n; i++) {
    if (!nn(a[i])) continue;
    const basis = (c[i].h + c[i].l) / 2, up = basis + mult * a[i], lo = basis - mult * a[i];
    fu = (fu === null || up < fu || c[i - 1].c > fu) ? up : fu;
    fl = (fl === null || lo > fl || c[i - 1].c < fl) ? lo : fl;
    let d = prevDir;
    if (c[i].c > fu) d = 1; else if (c[i].c < fl) d = -1;
    dir[i] = d; st[i] = d === 1 ? fl : fu; prevDir = d;
  }
  return { dir, st };
}
/* Chandelier Exit (everget), useClose = true */
function chandelier(c, len, mult) {
  const n = c.length, closes = c.map(x => x.c), a = atr(c, len);
  const hh = highest(closes, len), ll = lowest(closes, len);
  const longStop = Array(n).fill(null), shortStop = Array(n).fill(null), dir = Array(n).fill(null);
  let pl = null, ps = null, pd = 1;
  for (let i = 0; i < n; i++) {
    if (!nn(a[i]) || !nn(hh[i])) continue;
    let ls = hh[i] - a[i] * mult, ss = ll[i] + a[i] * mult;
    if (pl !== null) ls = c[i - 1].c > pl ? Math.max(ls, pl) : ls;
    if (ps !== null) ss = c[i - 1].c < ps ? Math.min(ss, ps) : ss;
    let d = pd;
    if (ps !== null && c[i].c > ps) d = 1; else if (pl !== null && c[i].c < pl) d = -1;
    longStop[i] = ls; shortStop[i] = ss; dir[i] = d;
    pl = ls; ps = ss; pd = d;
  }
  return { longStop, shortStop, dir };
}
function zlsma(v, len) {
  const l1 = linreg(v, len), l2 = linreg(l1, len), o = Array(v.length).fill(null);
  for (let i = 0; i < v.length; i++) if (nn(l1[i]) && nn(l2[i])) o[i] = l1[i] + (l1[i] - l2[i]);
  return o;
}
function stochRsi(v, rlen, slen, k, d) {
  const r = rsi(v, rlen), n = v.length, raw = Array(n).fill(null);
  const hi = highest(r.map(x => nn(x) ? x : 0), slen), lo = lowest(r.map(x => nn(x) ? x : 0), slen);
  for (let i = 0; i < n; i++) {
    if (!nn(r[i]) || !nn(hi[i])) continue;
    raw[i] = hi[i] === lo[i] ? 50 : 100 * (r[i] - lo[i]) / (hi[i] - lo[i]);
  }
  const first = raw.findIndex(nn);
  if (first < 0) return { k: raw, d: raw };
  const kk = Array(first).fill(null).concat(sma(raw.slice(first), k));
  const dd = Array(first).fill(null).concat(sma(kk.slice(first).map(x => nn(x) ? x : 0), d));
  return { k: kk, d: dd };
}
function cci(c, p) {
  const tp = c.map(x => (x.h + x.l + x.c) / 3), m = sma(tp, p), o = Array(c.length).fill(null);
  for (let i = p - 1; i < c.length; i++) {
    let dev = 0; for (let k = i - p + 1; k <= i; k++) dev += Math.abs(tp[k] - m[i]);
    dev /= p; o[i] = dev === 0 ? 0 : (tp[i] - m[i]) / (0.015 * dev);
  } return o;
}
function willr(c, p) {
  const hi = highest(c.map(x => x.h), p), lo = lowest(c.map(x => x.l), p), o = Array(c.length).fill(null);
  for (let i = 0; i < c.length; i++) if (nn(hi[i]) && hi[i] !== lo[i]) o[i] = -100 * (hi[i] - c[i].c) / (hi[i] - lo[i]);
  return o;
}
function mfi(c, p) {
  const n = c.length, pos = Array(n).fill(0), neg = Array(n).fill(0), o = Array(n).fill(null);
  const tp = c.map(x => (x.h + x.l + x.c) / 3);
  for (let i = 1; i < n; i++) {
    const f = tp[i] * c[i].v;
    if (tp[i] > tp[i - 1]) pos[i] = f; else if (tp[i] < tp[i - 1]) neg[i] = f;
  }
  for (let i = p; i < n; i++) {
    let sp = 0, sn = 0;
    for (let k = i - p + 1; k <= i; k++) { sp += pos[k]; sn += neg[k]; }
    o[i] = sn === 0 ? 100 : 100 - 100 / (1 + sp / sn);
  } return o;
}
function obv(c) {
  const o = Array(c.length).fill(0);
  for (let i = 1; i < c.length; i++) o[i] = o[i - 1] + (c[i].c > c[i - 1].c ? c[i].v : c[i].c < c[i - 1].c ? -c[i].v : 0);
  return o;
}
function bollinger(v, p, m) {
  const b = sma(v, p), s = stdev(v, p);
  return {
    mid: b,
    up: b.map((x, i) => nn(x) ? x + m * s[i] : null),
    dn: b.map((x, i) => nn(x) ? x - m * s[i] : null)
  };
}
function keltner(c, p, m) {
  const mid = ema(c.map(x => x.c), p), a = atr(c, p);
  return {
    mid,
    up: mid.map((x, i) => nn(x) && nn(a[i]) ? x + m * a[i] : null),
    dn: mid.map((x, i) => nn(x) && nn(a[i]) ? x - m * a[i] : null)
  };
}
function ichimoku(c) {
  const n = c.length, h = c.map(x => x.h), l = c.map(x => x.l);
  const mid = (p) => { const hi = highest(h, p), lo = lowest(l, p); return hi.map((x, i) => nn(x) ? (x + lo[i]) / 2 : null); };
  const tenkan = mid(9), kijun = mid(26), b = mid(52);
  const spanA = tenkan.map((x, i) => nn(x) && nn(kijun[i]) ? (x + kijun[i]) / 2 : null);
  const i = n - 1, s = i - 26;
  return {
    tenkan: tenkan[i], kijun: kijun[i],
    cloudTop: s >= 0 && nn(spanA[s]) && nn(b[s]) ? Math.max(spanA[s], b[s]) : null,
    cloudBot: s >= 0 && nn(spanA[s]) && nn(b[s]) ? Math.min(spanA[s], b[s]) : null
  };
}
function vwapAnchored(c, tf) {
  const o = Array(c.length).fill(null);
  let pv = 0, vv = 0, day = null;
  for (let i = 0; i < c.length; i++) {
    const d = new Date(c[i].t).getUTCDate();
    if (tf !== 'D' && d !== day) { pv = 0; vv = 0; day = d; }
    const tp = (c[i].h + c[i].l + c[i].c) / 3;
    pv += tp * c[i].v; vv += c[i].v;
    o[i] = vv > 0 ? pv / vv : null;
  } return o;
}
/* swing structure via 5-bar fractals */
function structure(c) {
  const hs = [], ls = [];
  for (let i = 2; i < c.length - 2; i++) {
    if (c[i].h > c[i - 1].h && c[i].h > c[i - 2].h && c[i].h > c[i + 1].h && c[i].h > c[i + 2].h) hs.push(c[i].h);
    if (c[i].l < c[i - 1].l && c[i].l < c[i - 2].l && c[i].l < c[i + 1].l && c[i].l < c[i + 2].l) ls.push(c[i].l);
  }
  const h2 = hs.slice(-2), l2 = ls.slice(-2);
  let dir = 0, label = 'unclear';
  if (h2.length === 2 && l2.length === 2) {
    const hh = h2[1] > h2[0], hl = l2[1] > l2[0];
    if (hh && hl) { dir = 1; label = 'higher highs + higher lows'; }
    else if (!hh && !hl) { dir = -1; label = 'lower highs + lower lows'; }
    else { dir = 0; label = 'mixed / ranging'; }
  }
  return { dir, label, lastHigh: h2[h2.length - 1] || null, lastLow: l2[l2.length - 1] || null };
}

module.exports = {
  nn, sma, ema, rma, stdev, highest, lowest, linreg, trueRange, atr, rsi, macd, adx,
  supertrend, chandelier, zlsma, stochRsi, cci, willr, mfi, obv, bollinger, keltner,
  ichimoku, vwapAnchored, structure,
};
