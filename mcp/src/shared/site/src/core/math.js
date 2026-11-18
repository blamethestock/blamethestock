// Blame the Stock — the maths (pure: no DOM, no network).
//   c = coin's change in dollars, q = pair's change in dollars, r = coin's change against its pair.
//   (1 + c) = (1 + q) * (1 + r)      share from the pair = ln(1 + q) / ln(1 + c)
import { SETTINGS } from '../../settings.js';

export const WINDOW_SECONDS = Object.freeze({ '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 });

// Fixed edges of the cases (the "basically flat" edge lives in SETTINGS.limits.flatPercent).
export const OPPOSITE_MIN = 0.001;   // the pair must have moved at least 0.1% the other way
export const MOSTLY_LOW = 0.95;      // share 95%..105% = "almost all of that is the pair"
export const MOSTLY_HIGH = 1.05;

const isNum = Number.isFinite;
const noNegZero = (x) => (x === 0 ? 0 : x);

// Prices in, changes out. q = 0 when pairUsd is null (dollar-paired coin).
export function changes({ coinInPair, pairUsd } = {}) {
  const r = coinInPair.end / coinInPair.start - 1;
  const q = pairUsd ? pairUsd.end / pairUsd.start - 1 : 0;
  const c = (1 + q) * (1 + r) - 1;
  return { c: noNegZero(c), q: noNegZero(q), r: noNegZero(r) };
}

// Share of the coin's dollar move that came from the pair: ln(1+q)/ln(1+c). null if not a real number.
export function shareFromPair(c, q) {
  const s = Math.log1p(q) / Math.log1p(c);
  return isNum(s) ? noNegZero(s) : null;
}

function flatEdge(limits) {
  const p = limits && isNum(limits.flatPercent) ? limits.flatPercent : SETTINGS.limits.flatPercent;
  return p / 100;
}

// Which sentence to show. Pass { c, q, r, kind } (and optionally a precomputed share).
export function classify({ c, q, r, kind, share } = {}, limits = SETTINGS.limits) {
  if (kind === 'stable') return 'stable';
  if (Math.abs(c) < flatEdge(limits)) return 'flat';
  const pq = isNum(q) ? q : 0;
  if (c * pq < 0 && Math.abs(pq) >= OPPOSITE_MIN) return 'opposite';
  const s = share === undefined ? shareFromPair(c, pq) : share;
  if (!isNum(s)) return c <= -1 && pq <= -1 ? 'mostly-pair' : 'none'; // both wiped out: it was the pair
  if (Math.round(s * 100) <= 0) return 'none';
  if (s < MOSTLY_LOW) return 'normal';
  if (s <= MOSTLY_HIGH) return 'mostly-pair';
  return 'pair-bigger';
}

// The split bar: fractions 0..1 that add up to 1. null = no bar ('flat').
export function bar(caseName, share) {
  let pair;
  switch (caseName) {
    case 'normal': pair = share; break;
    case 'mostly-pair': pair = isNum(share) ? Math.min(share, 1) : 1; break;
    case 'pair-bigger': pair = 1; break;
    case 'none': case 'opposite': case 'stable': pair = 0; break;
    default: return null;
  }
  pair = isNum(pair) ? Math.min(1, Math.max(0, pair)) : 0;
  return { pair, coin: 1 - pair };
}

// '0x…' + 40 hex in any case, spaces anywhere are ignored. Returns lowercase or null.
export function validateAddress(str) {
  if (typeof str !== 'string') return null;
  // Spaces, zero-width characters, left/right marks and other invisible bidi controls, word joiner, BOM:
  // apps add these when copying. What is left must still be exactly 0x + 40 hex.
  const s = str.replace(/[\s\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '');
  return /^0[xX][0-9a-fA-F]{40}$/.test(s) ? '0x' + s.slice(2).toLowerCase() : null;
}

// '1h' | '6h' | '24h' | '7d' (any case, spaces ignored); anything else -> the default window.
export function parseWindow(str, settings = SETTINGS) {
  const allowed = settings && Array.isArray(settings.windows) ? settings.windows : Object.keys(WINDOW_SECONDS);
  const known = (w) => Object.prototype.hasOwnProperty.call(WINDOW_SECONDS, w);
  const w = typeof str === 'string' ? str.trim().toLowerCase() : '';
  if (known(w) && allowed.includes(w)) return w;
  const d = settings && settings.defaultWindow;
  return known(d) ? d : '24h';
}
