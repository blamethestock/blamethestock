// Off-hours mode: did the coin's move happen while the US stock market was closed?
// Pure (no DOM, no network). The data layer (data/index.js fetchOffHours) reads the same pools as the card at
// every market open and close inside the window; this file turns those prices into stretches, totals and the
// words on the card. Market hours themselves live in features/markethours.js. Wording: SETTINGS.wording.offHours.
import { SETTINGS } from '../../settings.js';
import { pct, fill } from '../core/format.js';

const isNum = Number.isFinite;
const above0 = (x) => isNum(x) && x > 0;

// Sentence edges: the share of the coin's move (in log terms, like the card's split) that came while closed.
export const ALMOST_ALL = 0.9;          // >= 90%: "Almost all of this move…"
export const MOSTLY = 0.6;              // >  60%: "Most of this move…"; 40%..60%: "about evenly"
// "Went one way, then the other": both stretches moved at least the flat edge in opposite directions,
// and the smaller move is at least this big next to the larger one (else the larger one tells the story).
export const OPPOSITE_RATIO = 0.25;

// Prices at the window's points -> one stretch per piece of the market calendar.
//   split  = splitWindow(start, end) from markethours.js  ({ pieces: [{ from, to, open }] })
//   points = [{ coinInPair, pairUsd }] at the start, at each open/close, and at the end (pieces.length + 1).
//            pairUsd is null at every point for a dollar pair.
// Returns [{ from, to, open, c, q, r }] (same maths as the card: r against the pair, c in dollars), or null.
export function piecesFromPrices(split, points) {
  const ps = split && Array.isArray(split.pieces) ? split.pieces : null;
  if (!ps || !ps.length || !Array.isArray(points) || points.length !== ps.length + 1) return null;
  const dollar = !!points[0] && points[0].pairUsd == null;
  for (const p of points) {
    if (!p || !above0(p.coinInPair)) return null;
    if (dollar ? p.pairUsd != null : !above0(p.pairUsd)) return null;
  }
  const out = [];
  for (let i = 0; i < ps.length; i++) {
    const a = points[i], b = points[i + 1];
    const r = b.coinInPair / a.coinInPair - 1;
    const q = dollar ? 0 : b.pairUsd / a.pairUsd - 1;
    const c = (1 + q) * (1 + r) - 1;
    if (![c, q, r].every(isNum) || !(ps[i].to > ps[i].from)) return null;
    out.push({ from: ps[i].from, to: ps[i].to, open: !!ps[i].open, c, q, r });
  }
  return out;
}

// Closed and open stretches multiplied together: (1 + x) across the pieces of each kind.
export function summarize(pieces) {
  const side = () => ({ c: 1, q: 1, r: 1, seconds: 0, count: 0 });
  const t = { closed: side(), open: side() };
  for (const p of Array.isArray(pieces) ? pieces : []) {
    const s = p.open ? t.open : t.closed;
    s.c *= 1 + p.c; s.q *= 1 + p.q; s.r *= 1 + p.r;
    s.seconds += p.to - p.from; s.count++;
  }
  for (const s of [t.closed, t.open]) { s.c -= 1; s.q -= 1; s.r -= 1; }
  const total = t.closed.seconds + t.open.seconds;
  return {
    closed: t.closed, open: t.open,
    cClosed: t.closed.c, cOpen: t.open.c, qClosed: t.closed.q, qOpen: t.open.q, rClosed: t.closed.r, rOpen: t.open.r,
    closedSeconds: t.closed.seconds, openSeconds: t.open.seconds,
    closedShare: total > 0 ? t.closed.seconds / total : null,     // fraction of the window's TIME the market was shut
    hasClosed: t.closed.count > 0, hasOpen: t.open.count > 0,
  };
}

// '17h 30m', '6h', '45m', '135h 30m' (whole minutes; calendar time, so it adds up exactly).
export function span(seconds) {
  const m = isNum(seconds) && seconds > 0 ? Math.round(seconds / 60) : 0;
  const hh = Math.floor(m / 60), mm = m % 60;
  if (!hh) return mm + 'm';
  return hh + 'h' + (mm ? ' ' + mm + 'm' : '');
}

// Ends of the timeline in the visitor's time: 'Thu 12:37 AM' (or 'Nov 6' for windows of two days or more).
export function endLabel(unixSeconds, long, timeZone) {
  if (!isNum(unixSeconds)) return '';
  const opts = long ? { month: 'short', day: 'numeric' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' };
  for (const tz of [timeZone, undefined]) {
    try {
      return new Intl.DateTimeFormat('en-US', tz ? { ...opts, timeZone: tz } : opts).format(new Date(unixSeconds * 1000))
        .replace(/[  ]/g, ' ').replace(',', '');
    } catch (e) { /* bad time zone: the visitor's own */ }
  }
  return '';
}

// Which sentence: 'allClosed' | 'allOpen' | 'opposite' | 'flat' | 'almostAllClosed' | 'mostlyClosed' | 'even'
// | 'mostlyOpen' | 'almostAllOpen'. t = summarize(pieces), c = the card's whole-window dollar move.
export function sentenceKey(t, c, flatEdge) {
  if (!t.hasOpen) return 'allClosed';
  if (!t.hasClosed) return 'allOpen';
  const big = (x) => Math.abs(x) >= flatEdge;
  const lc = Math.log1p(t.cClosed), lo = Math.log1p(t.cOpen);
  if (big(t.cClosed) && big(t.cOpen) && t.cClosed * t.cOpen < 0
      && Math.min(Math.abs(lc), Math.abs(lo)) >= OPPOSITE_RATIO * Math.max(Math.abs(lc), Math.abs(lo))) return 'opposite';
  // "Barely moved" only when the card itself says so (|c| under the flat edge). Two small stretches in the same
  // direction can add up to a real move (−0.4% and −0.4% = "You're down 0.8%"): that one is split like any other.
  if (Math.abs(c) < flatEdge) return 'flat';
  let share = lc / (lc + lo);
  if (!isNum(share)) share = Math.abs(t.cClosed) / (Math.abs(t.cClosed) + Math.abs(t.cOpen));   // a −100% stretch
  share = Math.min(1, Math.max(0, isNum(share) ? share : 0.5));
  if (share >= ALMOST_ALL) return 'almostAllClosed';
  if (share > MOSTLY) return 'mostlyClosed';
  if (share >= 1 - MOSTLY) return 'even';
  if (share > 1 - ALMOST_ALL) return 'mostlyOpen';
  return 'almostAllOpen';
}

// fetchOffHours() answer + the card's Result -> what the card shows:
//   { ok: true, key, title, sentence, line, segments: [{ open, from, to, share }], legend: [{ open, label, time }],
//     aria, startText, endText, totals }
// or { ok: false, text } (text = the grey "unavailable" line). Never returns numbers that don't multiply back
// to the card's own c and q. opts.timeZone only changes the timeline's end labels (tests).
export function offHoursView(off, result, settings = SETTINGS, opts = {}) {
  const S = settings || SETTINGS;
  const W = { ...((SETTINGS.wording && SETTINGS.wording.offHours) || {}), ...((S.wording && S.wording.offHours) || {}) };
  const fail = { ok: false, text: W.unavailable || '' };
  if (!off || off.ok !== true || !result || result.ok !== true) return fail;
  const ps = off.pieces;
  if (!Array.isArray(ps) || !ps.length || !isNum(result.c) || !isNum(result.q)) return fail;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (!p || !(p.to > p.from) || (i && p.from !== ps[i - 1].to) || ![p.c, p.q, p.r].every(isNum)) return fail;
  }
  const t = summarize(ps);
  // Self-check: the stretches multiply back to the card's numbers (they share the start and end prices).
  const same = (a, b) => Math.abs(a - b) <= 1e-9 * (1 + Math.abs(b));
  if (!same((1 + t.cClosed) * (1 + t.cOpen) - 1, result.c) || !same((1 + t.qClosed) * (1 + t.qOpen) - 1, result.q)) return fail;

  const limits = S.limits || SETTINGS.limits;
  const edge = (isNum(limits && limits.flatPercent) ? limits.flatPercent : SETTINGS.limits.flatPercent) / 100;
  const coin = (result.coin && result.coin.symbol) || 'Your coin';
  const pair = result.pair || {};
  const key = sentenceKey(t, result.c, edge);
  const way = (x) => (x < 0 ? 'fell' : 'rose');
  const sentence = fill(W[key], { coin, closedWay: way(t.cClosed), openWay: way(t.cOpen) });

  // Numbers only when the window has both kinds of stretch (otherwise they are the card's own numbers).
  const sideT = pair.kind === 'stock' ? W.sideStock : W.side;
  const side = (c, q) => fill(sideT, { coin, coinPct: pct(c), pair: pair.short || pair.symbol || '', pairPct: pct(q) });
  const line = t.hasClosed && t.hasOpen ? fill(W.numbers, { closed: side(t.cClosed, t.qClosed), open: side(t.cOpen, t.qOpen) }) : '';

  const total = t.closedSeconds + t.openSeconds;
  const segments = ps.map((p) => ({ open: p.open, from: p.from, to: p.to, share: (p.to - p.from) / total }));
  const legend = [];
  if (t.hasClosed) legend.push({ open: false, label: W.closedLabel, time: span(t.closedSeconds) });
  if (t.hasOpen) legend.push({ open: true, label: W.openLabel, time: span(t.openSeconds) });
  const long = total >= 2 * 86400;
  return {
    ok: true, key,
    title: W.title || '',
    sentence, line, segments, legend,
    aria: legend.map((k) => k.label + ' ' + k.time).join(', '),
    startText: endLabel(ps[0].from, long, opts.timeZone),
    endText: endLabel(ps[ps.length - 1].to, long, opts.timeZone),
    totals: t,
  };
}
