// Tests for off-hours mode: site/src/features/offhours.js (pure maths and words) and fetchOffHours() in
// site/src/data/index.js (against a mock Robinhood Chain: no network).
import { suite, test, eq, near, ok } from './harness.js';
import { SETTINGS } from '../../site/settings.js';
import { splitWindow } from '../../site/src/features/markethours.js';
import {
  piecesFromPrices, summarize, offHoursView, sentenceKey, span, endLabel,
} from '../../site/src/features/offhours.js';
import { buildResult } from '../../site/src/core/verdict.js';
import * as K from '../../site/src/data/constants.js';
import { _setTransport } from '../../site/src/data/rpc.js';
import { fetchPriceInput, fetchOffHours, clearDataCache } from '../../site/src/data/index.js';
import {
  SEL_CURVE, SEL_TOKEN, SEL_PAIR_TOKEN, SEL_GRADUATED, SEL_GET_RESERVES, SEL_REAL_QUOTE,
} from '../../site/src/data/curve.js';

const u = (iso) => Date.parse(iso) / 1000;
const NY = 'America/New_York';
const W = SETTINGS.wording.offHours;
const HOUR = 3600;

// Prices at every point of a split, from per-stretch moves [r, q] (coin vs pair, pair in dollars), cycled.
function pointsFor(split, moves, { dollar = false } = {}) {
  const pts = [{ coinInPair: 0.0123, pairUsd: dollar ? null : 187.5 }];
  split.pieces.forEach((p, i) => {
    const [r, q] = moves[i % moves.length];
    const a = pts[pts.length - 1];
    pts.push({ coinInPair: a.coinInPair * (1 + r), pairUsd: dollar ? null : a.pairUsd * (1 + q) });
  });
  return pts;
}
// The whole window's c, q, r straight from the first and last prices (the card's own maths).
function whole(pts) {
  const a = pts[0], b = pts[pts.length - 1];
  const r = b.coinInPair / a.coinInPair - 1;
  const q = a.pairUsd == null ? 0 : b.pairUsd / a.pairUsd - 1;
  return { c: (1 + q) * (1 + r) - 1, q, r };
}
// A small deterministic random walk.
function walk(n, seed = 7) {
  let s = seed;
  const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 - 0.5; };
  return Array.from({ length: n }, () => [rnd() * 0.3, rnd() * 0.08]);
}
// Hand-made stretches: [open, hours, c, q] -> pieces back to back.
function mk(list, start = u('2026-11-12T05:37:28Z')) {
  let t = start;
  return list.map(([open, hours, c, q]) => {
    const p = { from: t, to: t + hours * HOUR, open, c, q, r: (1 + c) / (1 + q) - 1 };
    t = p.to;
    return p;
  });
}
const compound = (pieces, k) => pieces.reduce((m, p) => m * (1 + p[k]), 1) - 1;
// A minimal Result for the words: what offHoursView reads from the card's Result.
function res(pieces, { coin = 'ZOLVA', kind = 'eth', pair = 'ETH' } = {}) {
  return { ok: true, c: compound(pieces, 'c'), q: compound(pieces, 'q'), coin: { symbol: coin }, pair: { kind, short: pair, symbol: pair } };
}
const view = (pieces, o) => offHoursView({ ok: true, pieces }, res(pieces, o), SETTINGS, { timeZone: NY });

// ---------------------------------------------------------------------------------------------
suite('offhours: maths');

test('24h: closed and open stretches multiply back to the whole window\'s c, q and r (1e-12)', () => {
  const split = splitWindow(u('2026-11-12T05:37:28Z'), u('2026-11-13T05:37:28Z'));
  const pts = pointsFor(split, [[-0.05, 0.01], [0.02, -0.03], [-0.07, 0.004]]);
  const pieces = piecesFromPrices(split, pts);
  eq(pieces.map((p) => p.open), [false, true, false]);
  const t = summarize(pieces), w = whole(pts);
  near((1 + t.cClosed) * (1 + t.cOpen) - 1, w.c, 1e-12, 'c');
  near((1 + t.qClosed) * (1 + t.qOpen) - 1, w.q, 1e-12, 'q');
  near((1 + t.rClosed) * (1 + t.rOpen) - 1, w.r, 1e-12, 'r');
  near(t.cOpen, (1 + 0.02) * (1 - 0.03) - 1, 1e-15, 'open stretch = the middle piece');
  eq([t.closedSeconds, t.openSeconds], [17.5 * HOUR, 6.5 * HOUR]);
  near(t.closedShare, 17.5 / 24, 1e-15, 'closed for 73% of the time');
  for (const p of pieces) near(p.c, (1 + p.q) * (1 + p.r) - 1, 1e-15, 'each piece: (1+c) = (1+q)(1+r)');
});

test('7d: 11 stretches (5 sessions), still exact to 1e-12; a dollar pair has q = 0 everywhere', () => {
  const split = splitWindow(u('2026-11-06T05:37:28Z'), u('2026-11-13T05:37:28Z'));
  eq([split.pieces.length, split.boundaries.length, split.pieces.filter((p) => p.open).length], [11, 10, 5]);
  const pts = pointsFor(split, walk(11));
  const pieces = piecesFromPrices(split, pts);
  const t = summarize(pieces), w = whole(pts);
  near((1 + t.cClosed) * (1 + t.cOpen) - 1, w.c, 1e-12, 'c');
  near((1 + t.qClosed) * (1 + t.qOpen) - 1, w.q, 1e-12, 'q');
  eq([t.openSeconds, t.closedSeconds], [5 * 6.5 * HOUR, (168 - 32.5) * HOUR]);
  const dollar = piecesFromPrices(split, pointsFor(split, walk(11, 3), { dollar: true }));
  ok(dollar.every((p) => p.q === 0 && p.c === p.r), 'dollar pair: c = r, q = 0');
});

test('weekend window: one closed stretch, no opens or closes to read', () => {
  const split = splitWindow(u('2026-11-14T10:00:00Z'), u('2026-11-15T10:00:00Z'));
  eq([split.pieces.length, split.boundaries], [1, []]);
  const pts = pointsFor(split, [[-0.1, 0.02]]);
  const pieces = piecesFromPrices(split, pts);
  near(pieces[0].c, whole(pts).c, 1e-15);
  const v = view(pieces, { kind: 'stock', pair: 'NVDA', coin: 'AI' });
  eq([v.ok, v.key, v.sentence, v.line], [true, 'allClosed', W.allClosed, '']);
  eq(v.legend, [{ open: false, label: 'Market closed', time: '24h' }]);
  eq([v.startText, v.endText], ['Sat 5:00 AM', 'Sun 5:00 AM']);
});

test('Thanksgiving: the holiday itself is all closed; that week has 4 sessions and a 1 PM close on Friday', () => {
  const day = splitWindow(u('2026-11-26T05:00:00Z'), u('2026-11-27T05:00:00Z'));
  eq([day.pieces.length, day.openSeconds], [1, 0]);
  const wk = splitWindow(u('2026-11-22T17:00:00Z'), u('2026-11-29T17:00:00Z'));
  const open = wk.pieces.filter((p) => p.open);
  eq(open.length, 4);
  eq(open[3], { from: u('2026-11-27T14:30:00Z'), to: u('2026-11-27T18:00:00Z'), open: true }, 'Friday 9:30 AM to 1:00 PM');
  eq(wk.boundaries.length, 8);
  const pts = pointsFor(wk, walk(9, 11));
  const pieces = piecesFromPrices(wk, pts);
  const t = summarize(pieces), w = whole(pts);
  near((1 + t.cClosed) * (1 + t.cOpen) - 1, w.c, 1e-12, 'c');
  near((1 + t.qClosed) * (1 + t.qOpen) - 1, w.q, 1e-12, 'q');
  const v = view(pieces);
  ok(v.ok, 'view');
  eq(v.legend.map((k) => k.time), ['145h', '23h']);
  eq([v.startText, v.endText], ['Nov 22', 'Nov 29']);
});

test('piecesFromPrices refuses bad input (never part of the numbers)', () => {
  const split = splitWindow(u('2026-11-12T05:37:28Z'), u('2026-11-13T05:37:28Z'));
  const pts = pointsFor(split, [[-0.05, 0.01]]);
  eq(piecesFromPrices(split, pts.slice(1)), null, 'one point short');
  eq(piecesFromPrices(split, pts.map((p, i) => (i === 2 ? { ...p, coinInPair: 0 } : p))), null, 'a zero price');
  eq(piecesFromPrices(split, pts.map((p, i) => (i === 1 ? { ...p, coinInPair: NaN } : p))), null, 'NaN');
  eq(piecesFromPrices(split, pts.map((p, i) => (i === 3 ? { ...p, pairUsd: null } : p))), null, 'pair price missing at one point');
  eq(piecesFromPrices({ pieces: [] }, []), null, 'empty window');
});

// ---------------------------------------------------------------------------------------------
suite('offhours: words');

test('the brief\'s example: mostly closed, stock pair shows both numbers', () => {
  const pieces = mk([[false, 17.5, -0.081, -0.004], [true, 6.5, -0.042, -0.046]]);
  const v = view(pieces, { coin: 'ZOLVA', kind: 'stock', pair: 'NVDA' });
  eq(v.key, 'mostlyClosed');
  eq(v.sentence, 'Most of this move happened while the US stock market was closed.');
  eq(v.line, 'While closed: ZOLVA −8.1%, NVDA −0.4%. While open: ZOLVA −4.2%, NVDA −4.6%.');
  eq(v.legend, [{ open: false, label: 'Market closed', time: '17h 30m' }, { open: true, label: 'Market open', time: '6h 30m' }]);
  eq(v.aria, 'Market closed 17h 30m, Market open 6h 30m');
  near(v.segments[0].share + v.segments[1].share, 1, 1e-15);
  eq([v.startText, v.endText], ['Thu 12:37 AM', 'Fri 12:37 AM']);
});

test('non-stock pairs keep the numbers about the coin', () => {
  const pieces = mk([[false, 17.5, -0.081, -0.004], [true, 6.5, -0.042, -0.046]]);
  eq(view(pieces, { kind: 'eth', pair: 'ETH' }).line, 'While closed: ZOLVA −8.1%. While open: ZOLVA −4.2%.');
  eq(view(pieces, { kind: 'coin', pair: 'ORBIO', coin: 'SHRP' }).line, 'While closed: SHRP −8.1%. While open: SHRP −4.2%.');
  const flatPair = mk([[false, 17.5, 0.12, 0], [true, 6.5, 0.03, 0]]);
  eq(view(flatPair, { kind: 'stable', pair: 'USDG', coin: 'ORBIO' }).line, 'While closed: ORBIO +12%. While open: ORBIO +3.0%.');
});

test('every sentence', () => {
  const two = (cc, co, q = 0) => mk([[false, 17.5, cc, q], [true, 6.5, co, q]]);
  const cases = [
    [two(-0.15, -0.003), 'almostAllClosed', 'Almost all of this move happened while the US stock market was closed.'],
    [two(-0.20, 0.01), 'almostAllClosed', 'Almost all of this move happened while the US stock market was closed.'],   // tiny bounce back
    [two(-0.05, -0.05), 'even', 'This move was split about evenly between market hours and closed hours.'],
    [two(-0.02, -0.06), 'mostlyOpen', 'Most of this move happened while the US stock market was open.'],
    [two(-0.002, -0.09), 'almostAllOpen', 'Almost all of this move happened while the US stock market was open.'],
    [two(0.30, 0.08), 'mostlyClosed', 'Most of this move happened while the US stock market was closed.'],
    [two(-0.08, 0.04), 'opposite', 'ZOLVA fell while the US stock market was closed and rose while it was open.'],
    [two(0.06, -0.03), 'opposite', 'ZOLVA rose while the US stock market was closed and fell while it was open.'],
    [two(0.002, -0.001), 'flat', 'ZOLVA barely moved, whether the US stock market was open or closed.'],
    [two(-0.006, 0.003), 'flat', 'ZOLVA barely moved, whether the US stock market was open or closed.'],   // card says "barely moved"
    // two small stretches the same way add up to a real move: the card says "You're down 0.8%", so no "barely moved"
    [two(-0.004, -0.004), 'even', 'This move was split about evenly between market hours and closed hours.'],
    [two(0.0045, 0.001), 'mostlyClosed', 'Most of this move happened while the US stock market was closed.'],   // +0.55% in all
    [mk([[true, 1, -0.04, -0.01]]), 'allOpen', 'The US stock market was open for this whole window.'],
    [mk([[false, 24, -0.04, -0.01]]), 'allClosed', 'The US stock market was closed for this whole window.'],
  ];
  for (const [pieces, key, sentence] of cases) {
    const v = view(pieces);
    eq([v.key, v.sentence], [key, sentence], key + ' ' + pieces.map((p) => p.c).join('/'));
  }
});

test('a −100% stretch does not break the words', () => {
  const t = summarize(mk([[false, 17.5, -1, 0], [true, 6.5, -0.02, 0]]));
  eq(sentenceKey(t, -1, 0.005), 'almostAllClosed');
});

test('one grey line instead of numbers: failed fetch, bad pieces, or pieces that don\'t match the card', () => {
  const pieces = mk([[false, 17.5, -0.081, -0.004], [true, 6.5, -0.042, -0.046]]);
  const r = res(pieces);
  const fail = { ok: false, text: 'Off-hours split unavailable right now.' };
  eq(offHoursView({ ok: false, code: 'rpc-failed' }, r), fail);
  eq(offHoursView(null, r), fail);
  eq(offHoursView({ ok: true, pieces }, { ok: false, code: 'stale' }), fail);
  eq(offHoursView({ ok: true, pieces: [] }, r), fail);
  eq(offHoursView({ ok: true, pieces }, { ...r, c: r.c + 0.001 }), fail, 'c off by 0.1%');
  eq(offHoursView({ ok: true, pieces }, { ...r, q: r.q - 0.001 }), fail, 'q off by 0.1%');
  eq(offHoursView({ ok: true, pieces: [pieces[0], { ...pieces[1], from: pieces[1].from + 60 }] }, r), fail, 'a gap');
  eq(offHoursView({ ok: true, pieces: [pieces[0], { ...pieces[1], c: NaN }] }, r), fail, 'NaN');
});

test('works on a real Result from buildResult (same c and q as the card)', () => {
  const split = splitWindow(u('2026-11-12T05:37:28Z'), u('2026-11-13T05:37:28Z'));
  const pts = pointsFor(split, [[-0.09, 0.012], [0.01, 0.015], [-0.02, -0.006]]);
  const pi = {
    ok: true,
    coin: { address: '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18', symbol: 'AI', name: 'AI' },
    pair: { address: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', symbol: 'NVDA', kind: 'stock' },
    pool: { id: '0xpool', dex: 'uniswap v4', label: 'AI/NVDA', pairSideUsd: 600000, createdAt: null, source: 'dexscreener' },
    window: '24h', windowSeconds: 86400,
    start: { block: 1, time: split.pieces[0].from }, end: { block: 2, time: split.pieces[2].to },
    sinceLaunch: false,
    coinInPair: { start: pts[0].coinInPair, end: pts[3].coinInPair },
    pairUsd: { start: pts[0].pairUsd, end: pts[3].pairUsd },
    pairVia: null, tradedInWindow: true,
  };
  const result = buildResult(pi, SETTINGS, { timeZone: NY });
  const v = offHoursView({ ok: true, pieces: piecesFromPrices(split, pts) }, result, SETTINGS, { timeZone: NY });
  ok(v.ok, JSON.stringify(v));
  eq(v.key, 'almostAllClosed', 'a small bounce while open does not make it "the other way"');
  eq(v.line, 'While closed: AI −10%, NVDA +0.6%. While open: AI +2.5%, NVDA +1.5%.');
});

test('durations', () => {
  eq([span(17.5 * HOUR), span(6 * HOUR), span(45 * 60), span(135.5 * HOUR), span(0), span(NaN), span(89)], ['17h 30m', '6h', '45m', '135h 30m', '0m', '0m', '1m']);
  eq(endLabel(u('2026-11-13T05:37:28Z'), false, NY), 'Fri 12:37 AM');
  eq(endLabel(u('2026-11-13T05:37:28Z'), true, NY), 'Nov 13');
  eq(endLabel(NaN), '');
});

// ---------------------------------------------------------------------------------------------
// fetchOffHours against a mock chain. Blocks every ~0.1045 s with a slow drift (so the first guess is off),
// end block pinned at 2026-11-13 05:37:28 UTC (Friday 12:37 AM in New York).
suite('offhours: fetchOffHours (mock chain)');

const MOCK = '0x1111111111111111111111111111111111111111';      // pool coin, paired with WETH
const PONS = '0x4444444444444444444444444444444444444444';      // coin still on its Pons curve (pair: native ETH)
const CURVE = '0x5555555555555555555555555555555555555555';
const P1 = '0x' + 'ab'.repeat(32);
const END_BLOCK = 20000000;
const END_TIME = u('2026-11-13T05:37:28Z');
const drift = (n) => n * 0.1045 + 200 * Math.sin(n / 2e6);
const T0 = END_TIME - Math.floor(drift(END_BLOCK));
const ts = (n) => T0 + Math.floor(drift(n));
const coinPrice = (b) => 1e-6 * (1 + 0.2 * Math.sin(b / 1.3e6));        // MOCK in WETH
const ethPrice = (b) => 2000 * (1 + 0.1 * Math.cos(b / 2.1e6));          // WETH in USDG
const curveQuote = (b) => BigInt(Math.round(1e18 * (2 + Math.sin(b / 1e6))));
const CURVE_TOKEN = 8n * 10n ** 26n;
const sqrtFor = (p, dec0, dec1) => BigInt(Math.round(Math.sqrt(p * 10 ** (dec1 - dec0)) * 2 ** 96));
const hex = (n) => '0x' + n.toString(16);
const word = (x) => BigInt(x).toString(16).padStart(64, '0');
const lastAtOrBefore = (T) => { let lo = 0, hi = END_BLOCK + 10; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts(m) <= T) lo = m; else hi = m; } return lo; };

// state.down: every node unreachable. state.drpcDown: the archive node answers "Unknown state" to every eth_call.
// state.swapEvery: the trade log has a Swap every that many blocks (the price at that block), plus an older one.
function swapLogs(f, from, to, every) {
  const coinPool = f.address === K.POOL_MANAGER && f.topics[0] === K.TOPIC_V4_SWAP && f.topics[1] === P1;
  const ethPool = f.address === K.WETH_USDG_POOL && f.topics[0] === K.TOPIC_V3_SWAP;
  if (!every || !(coinPool || ethPool)) return [];
  const sqrt = (b) => (coinPool ? sqrtFor(1 / coinPrice(b), 18, 18) : sqrtFor(ethPrice(b), 18, 6));
  const log = (b, i, s) => ({ blockNumber: hex(b), logIndex: hex(i), data: '0x' + word(0) + word(0) + word(s) + word(0) + word(0) });
  const s = Math.floor(to / every) * every;
  if (s < from) return [];
  const out = [log(s, 7, sqrt(s)), log(s, 2, 12345n)];                 // the later log in the block wins
  if (s - every >= from) out.unshift(log(s - every, 9, 777n));          // an older trade in the same range
  return out;
}

function mockChain() {
  const calls = [];
  const state = { down: false, drpcDown: false, swapEvery: 0 };
  const revert = () => Object.assign(new Error('execution reverted'), { code: 3 });
  const call = (to, data, b) => {
    if (data === K.SEL_DECIMALS) { if (to === MOCK || to === PONS) return '0x' + word(18); throw revert(); }
    if (to === PONS && data === SEL_CURVE) return '0x' + word(CURVE);
    if (to === CURVE && data === SEL_TOKEN) return '0x' + word(PONS);
    if (to === CURVE && data === SEL_GRADUATED) return '0x' + word(0);
    if (to === CURVE && data === SEL_PAIR_TOKEN) return '0x' + word(0);
    if (to === CURVE && data === SEL_GET_RESERVES) return '0x' + word(curveQuote(b)) + word(CURVE_TOKEN);
    if (to === CURVE && data === SEL_REAL_QUOTE) return '0x' + word(10n ** 18n);
    if (to === K.STATE_VIEW && data === K.SEL_GET_SLOT0 + P1.slice(2)) return '0x' + word(sqrtFor(1 / coinPrice(b), 18, 18)) + word(0) + word(0) + word(0);
    if (to === K.WETH_USDG_POOL && data === K.SEL_SLOT0) return '0x' + word(sqrtFor(ethPrice(b), 18, 6)) + word(0);
    throw revert();
  };
  const rpc = (m, p) => {
    if (m === 'eth_getBlockByNumber') { const n = p[0] === 'latest' ? END_BLOCK + 5 : parseInt(p[0], 16); return { number: hex(n), timestamp: hex(ts(n)) }; }
    if (m === 'eth_getCode') return '0x6080';
    if (m === 'eth_getLogs') return swapLogs(p[0], parseInt(p[0].fromBlock, 16), parseInt(p[0].toBlock, 16), state.swapEvery);
    if (m === 'eth_call') return call(p[0].to, p[0].data, p[1] === 'latest' ? END_BLOCK + 5 : parseInt(p[1], 16));
    throw Object.assign(new Error('method not found'), { code: -32601 });
  };
  const ds = [{ chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: P1, pairCreatedAt: ts(1000) * 1000,
    baseToken: { address: MOCK, symbol: 'MOCK', name: 'Mock' }, quoteToken: { address: K.WETH, symbol: 'WETH', name: 'Wrapped Ether' },
    priceNative: '0.000001', priceUsd: '0.002', liquidity: { usd: 20000, base: 5e9, quote: 5 } }];
  const fetchMock = async (url, init) => {
    const host = url.includes('drpc') ? 'drpc' : url.includes('publicnode') ? 'publicnode' : url.includes('robinhood.com') ? 'official'
      : url.includes('dexscreener') ? 'dexscreener' : url.includes('geckoterminal') ? 'geckoterminal' : 'other';
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ host, methods: body ? (Array.isArray(body) ? body : [body]).map((x) => x.method) : ['GET'] });
    if (state.down) throw new TypeError('Failed to fetch');
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => json });
    if (host === 'dexscreener') return url.includes('/token-pairs/') ? reply(200, url.endsWith(MOCK) ? ds : []) : reply(200, { pairs: null });
    if (host === 'geckoterminal') return reply(404, { errors: [{ status: '404' }] });
    const one = (r) => {
      if (host === 'drpc' && state.drpcDown && r.method === 'eth_call') return { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'Unknown state. First available state is 1' } };
      try { return { jsonrpc: '2.0', id: r.id, result: rpc(r.method, r.params) }; } catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: e.code, message: e.message } }; }
    };
    return reply(200, Array.isArray(body) ? body.map(one) : one(body));
  };
  _setTransport({ fetch: fetchMock, sleep: async () => {}, backoff: [0], timeouts: false });
  clearDataCache();
  return { calls, state };
}

// Checks one fetchOffHours answer against the mock chain and the card's own numbers.
function check(pi, off, expectPieces) {
  ok(off.ok, JSON.stringify(off));
  eq(off.pieces.length, expectPieces, 'pieces');
  eq([off.pieces[0].fromBlock, off.pieces[off.pieces.length - 1].toBlock], [pi.start.block, pi.end.block]);
  for (const p of off.pieces.slice(1)) {
    ok(ts(p.fromBlock) <= p.from && ts(p.fromBlock + 1) > p.from, 'block ' + p.fromBlock + ' is the last one at or before ' + p.from);
  }
  const card = buildResult(pi, SETTINGS);
  near(compound(off.pieces, 'c'), card.c, 1e-12, 'pieces multiply back to the card\'s c');
  near(compound(off.pieces, 'q'), card.q, 1e-12, 'pieces multiply back to the card\'s q');
  near((1 + off.totals.cClosed) * (1 + off.totals.cOpen) - 1, card.c, 1e-12, 'totals: c');
  near((1 + off.totals.qClosed) * (1 + off.totals.qOpen) - 1, card.q, 1e-12, 'totals: q');
  return card;
}

test('24h pool coin: two opens/closes, blocks found exactly, prices read from the same pools', async () => {
  const m = mockChain();
  const pi = await fetchPriceInput(MOCK, '24h', { endBlock: END_BLOCK });
  ok(pi.ok, JSON.stringify(pi));
  const before = m.calls.length;
  const off = await fetchOffHours(pi);
  check(pi, off, 3);
  eq(off.pieces.map((p) => p.open), [false, true, false]);
  const [b1, b2] = [off.pieces[1].fromBlock, off.pieces[2].fromBlock];
  eq([b1, b2], [lastAtOrBefore(u('2026-11-12T14:30:00Z')), lastAtOrBefore(u('2026-11-12T21:00:00Z'))]);
  // the open stretch: coin and ETH prices at exactly those blocks
  near(1 + off.pieces[1].r, coinPrice(b2) / coinPrice(b1), 1e-9, 'coin vs ETH while open');
  near(1 + off.pieces[1].q, ethPrice(b2) / ethPrice(b1), 1e-9, 'ETH in dollars while open');
  const used = m.calls.slice(before);
  ok(used.length <= 12, 'few requests: ' + used.length);
  ok(!used.some((c) => c.host === 'dexscreener' || c.host === 'geckoterminal'), 'no pool search');
  const v = offHoursView(off, buildResult(pi, SETTINGS), SETTINGS, { timeZone: NY });
  ok(v.ok && v.line.startsWith('While closed: MOCK '), JSON.stringify(v));
});

test('7d: ten opens/closes in a modest number of requests; asking again reuses every block and price', async () => {
  const m = mockChain();
  const pi = await fetchPriceInput(MOCK, '7d', { endBlock: END_BLOCK });
  ok(pi.ok, JSON.stringify(pi));
  const before = m.calls.length;
  const off = await fetchOffHours(pi);
  check(pi, off, 11);
  const used = m.calls.slice(before);
  const reads = used.filter((c) => c.host === 'drpc').length;
  ok(used.length <= 45, 'requests: ' + used.length);
  ok(reads <= 8, 'price reads batched: ' + reads);
  const again = m.calls.length;
  const off2 = await fetchOffHours(pi);
  eq(off2.pieces, off.pieces);
  eq(m.calls.length, again, 'nothing asked twice');
});

test('Pons curve coin: reads the curve at each open/close, same total as the card', async () => {
  mockChain();
  const pi = await fetchPriceInput(PONS, '24h', { endBlock: END_BLOCK });
  ok(pi.ok && pi.pool.source === 'pons-curve', JSON.stringify(pi));
  const off = await fetchOffHours(pi);
  check(pi, off, 3);
  const [b1, b2] = [off.pieces[1].fromBlock, off.pieces[2].fromBlock];
  near(1 + off.pieces[1].r, Number(curveQuote(b2)) / Number(curveQuote(b1)), 1e-12, 'curve price while open');
});

test('archive node saying "unknown state": asked once, then the trade log in a few batches; same totals as the card', async () => {
  const m = mockChain();
  const pi = await fetchPriceInput(MOCK, '7d', { endBlock: END_BLOCK });
  ok(pi.ok, JSON.stringify(pi));
  m.state.drpcDown = true;
  m.state.swapEvery = 5000;                       // so some points need the second, older stretch of the log
  const before = m.calls.length;
  const off = await fetchOffHours(pi);
  check(pi, off, 11);
  const used = m.calls.slice(before);
  const drpc = used.filter((c) => c.host === 'drpc').length;
  const logs = used.filter((c) => c.methods.includes('eth_getLogs')).length;
  ok(drpc <= 4, 'archive node asked once (with its retries), not for every point: ' + drpc);
  ok(logs <= 8, 'trade log asked in batches: ' + logs);
  ok(used.length <= 40, 'requests: ' + used.length);
  // Inside the window each point's price is the last trade at or before it.
  const sw = (b) => Math.floor(b / 5000) * 5000;
  for (const p of off.pieces.slice(1, -1)) {
    near(1 + p.r, coinPrice(sw(p.toBlock)) / coinPrice(sw(p.fromBlock)), 1e-9, 'coin vs ETH from trades');
    near(1 + p.q, ethPrice(sw(p.toBlock)) / ethPrice(sw(p.fromBlock)), 1e-9, 'ETH in dollars from trades');
  }
});

test('Pons curve coin with the archive node down: one small batch, then { ok: false }', async () => {
  const m = mockChain();
  const pi = await fetchPriceInput(PONS, '7d', { endBlock: END_BLOCK });
  ok(pi.ok, JSON.stringify(pi));
  m.state.drpcDown = true;
  const before = m.calls.length;
  const off = await fetchOffHours(pi);
  eq([off.ok, off.code, off.pieces], [false, 'rpc-failed', undefined]);
  const drpc = m.calls.slice(before).filter((c) => c.host === 'drpc').length;
  ok(drpc <= 8, 'one small batch each for the curve and the pair\'s pool (with retries), not one per point: ' + drpc);
});

test('no remembered lookup, a cancelled check, or the chain going down -> { ok: false }, never part of the numbers', async () => {
  const m = mockChain();
  const pi = await fetchPriceInput(MOCK, '24h', { endBlock: END_BLOCK });
  ok(pi.ok);
  eq(await fetchOffHours({ ...pi, end: { block: pi.end.block - 1, time: pi.end.time } }), { ok: false, code: 'no-route' });
  eq(await fetchOffHours(null), { ok: false, code: 'no-input' });
  eq(await fetchOffHours(pi, { cancelled: () => true }), { ok: false, code: 'cancelled' });
  // a fresh chain: the blocks are not known yet, and every node is down
  const m2 = mockChain();
  const pi2 = await fetchPriceInput(MOCK, '24h', { endBlock: END_BLOCK });
  m2.state.down = true;
  const off = await fetchOffHours(pi2);
  eq([off.ok, off.code, off.pieces], [false, 'rpc-failed', undefined]);
  ok(m.calls.length > 0);
});
