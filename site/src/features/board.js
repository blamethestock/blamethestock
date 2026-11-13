// Stock-Paired Board: every coin on the list in board-list.js (coins whose main pool is paired with a Robinhood
// stock token), ranked by its own move after taking out the stock's move: r = (1 + c) / (1 + q) − 1.
// Same method as the tool (dev/SPEC.md §5): ONE end block (latest − 5) and ONE start block shared by every coin;
// every coin pool and every stock's dollar pool read at both blocks in batches (official RPC for the end, the
// dRPC archive for the start, Swap logs as the fallback). A row whose reads fail is dropped, never guessed.
// Loaded by src/ui/page.js only when SETTINGS.features.stockBoard is on. DOM is built with textContent only.
import { SETTINGS } from '../../settings.js';
import { USDG, RPC } from '../data/constants.js';
import { rpcBatch } from '../data/rpc.js';
import {
  headBlock, blockTime, blockAtTime, readSqrtMany, sqrtFromLogs, findInitialize, tokenFacts, priceOf, sortTokens,
  ethCall, slot0Call, wordAt,
} from '../data/chain.js';
import { STOCKS } from '../data/stocks.js';
import { BOARD_COINS, BOARD_SCANNED_AT } from './board-list.js';
import { changes, shareFromPair, classify, bar, parseWindow, WINDOW_SECONDS } from '../core/math.js';
import { pct, arrow, asOfTime, fill } from '../core/format.js';

export const CACHE_SECONDS = 60;       // a window's board is reused for a minute (tabs flip back instantly)
const DEC_CHUNK = 6;                   // decimals are read in groups (one RPC batch each); a failed group drops its coins

// Words used when settings.js has none (SETTINGS.board.wording overrides any of them).
export const BOARD_WORDS = {
  title: 'Stock-paired board',
  intro: "Coins paired with a stock token, ranked by their own move: what's left after taking out the stock's move.",
  loading: 'Reading {count} coins from Robinhood Chain…',
  failed: "Couldn't load the board right now.",
  tryAgain: 'Try again',
  listNote: 'List of coins checked on {date}. Coins whose main pool is paired with a Robinhood stock token.',
  ownMove: 'Own move',
  coin: 'Coin',
  tapHint: 'Pick a coin to see its full split.',
  inDollars: '{coin} in $',
  legendPair: "the stock's part",
  legendCoin: "the coin's own part",
  leftOutFailed: "{count} more couldn't be read just now, so they're left out.",
  leftOutFailedOne: "1 more couldn't be read just now, so it's left out.",
  leftOutYoung: "{count} started trading less than {window} ago, so they're left out.",
  leftOutYoungOne: "1 started trading less than {window} ago, so it's left out.",
  loaded: 'Board loaded: {count} coins.',
  rowLabel: '{rank}. {coin} against {stock}: own move {own}. {coin} in dollars {coinPct}, {stock} {stockPct}. Opens the full split.',
  windows: 'Time window',
};

const HEX40 = /^0x[0-9a-f]{40}$/;
const POOL_ID = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const lower = (s) => String(s == null ? '' : s).trim().toLowerCase();
const tickerKey = (s) => lower(s).replace(/^\$/, '');
const shortAddr = (a) => (a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a);
const goodSqrt = (x) => typeof x === 'bigint' && x > 0n;

// ---- settings ---------------------------------------------------------------------------------
export function boardSettings(settings = SETTINGS) {
  const S = settings || SETTINGS;
  const b = (S.board && typeof S.board === 'object') ? S.board : {};
  const words = { ...BOARD_WORDS };
  for (const [k, v] of Object.entries(b.wording || {})) if (typeof v === 'string' && v.trim()) words[k] = v;
  const max = Number(b.maxRows);
  const wins = Array.isArray(S.windows) && S.windows.length ? S.windows.filter((w) => WINDOW_SECONDS[w]) : ['1h', '6h', '24h', '7d'];
  return {
    window: parseWindow(typeof b.window === 'string' ? b.window : '', S),
    maxRows: Number.isFinite(max) && max >= 1 ? Math.min(100, Math.floor(max)) : 25,
    hide: Array.isArray(b.hide) ? b.hide : [],
    words,
    windows: wins.length ? wins : ['1h', '6h', '24h', '7d'],
    limits: S.limits || SETTINGS.limits,
    asOf: (S.wording && S.wording.asOf) || SETTINGS.wording.asOf,
  };
}

// ---- the list ---------------------------------------------------------------------------------
// The coins to show: the list minus `hide` (tickers in any case, "$" optional, or full 0x addresses).
// Two coins with the same ticker get a short address (tag) so they can be told apart.
export function visibleCoins(list = BOARD_COINS, hide = []) {
  const hideSyms = new Set(), hideAddrs = new Set();
  for (const x of Array.isArray(hide) ? hide : []) {
    const k = lower(x);
    if (HEX40.test(k)) hideAddrs.add(k); else if (k) hideSyms.add(tickerKey(k));
  }
  const out = [], seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    if (!c) continue;
    const address = lower(c.address);
    if (seen.has(address)) continue;
    seen.add(address);
    if (hideAddrs.has(address) || hideSyms.has(tickerKey(c.symbol))) continue;
    out.push({
      symbol: String(c.symbol == null ? '' : c.symbol).trim(), address, pool: lower(c.pool),
      stock: String(c.stock == null ? '' : c.stock).trim(), stockAddress: lower(c.stockAddress), tag: '',
    });
  }
  const count = new Map();
  for (const c of out) count.set(tickerKey(c.symbol), (count.get(tickerKey(c.symbol)) || 0) + 1);
  for (const c of out) if (count.get(tickerKey(c.symbol)) > 1) c.tag = shortAddr(c.address);
  return out;
}

function makeLeg(id, base, quote) {
  const [token0, token1] = sortTokens(base, quote);
  return { id, version: id.length === 66 ? 'v4' : 'v3', uniswap: true, base, quote, token0, token1, dec0: null, dec1: null };
}

// One leg per coin pool, and one per stock dollar pool (shared by every coin on that stock).
export function planBoard(coins, stocks = STOCKS) {
  const stockLegs = new Map(), rows = [];
  for (const coin of coins) {
    const s = stocks.get(coin.stockAddress);
    if (!(HEX40.test(coin.address) && POOL_ID.test(coin.pool) && s && s.pool && POOL_ID.test(s.pool))) {
      rows.push({ coin, leg: null, stockLeg: null });
      continue;
    }
    coin.stock = s.symbol || coin.stock;                     // the official ticker
    if (!stockLegs.has(coin.stockAddress)) stockLegs.set(coin.stockAddress, makeLeg(s.pool, coin.stockAddress, USDG));
    rows.push({ coin, leg: makeLeg(coin.pool, coin.address, coin.stockAddress), stockLeg: stockLegs.get(coin.stockAddress) });
  }
  return { rows, stockLegs: [...stockLegs.values()] };
}

// ---- maths (the card's own functions) ---------------------------------------------------------
// Prices in, one row out. Anything missing or impossible -> { ok: false } (the row is dropped).
export function boardRow(coin, coinInPair, pairUsd, limits = SETTINGS.limits) {
  const vals = [coinInPair && coinInPair.start, coinInPair && coinInPair.end, pairUsd && pairUsd.start, pairUsd && pairUsd.end];
  if (!vals.every((v) => Number.isFinite(v) && v > 0)) return { ok: false, coin, why: 'price' };
  const { c, q, r } = changes({ coinInPair, pairUsd });
  if (![c, q, r].every(Number.isFinite)) return { ok: false, coin, why: 'price' };
  const share = shareFromPair(c, q);
  const caseName = classify({ c, q, r, kind: 'stock', share }, limits);
  return { ok: true, coin, c, q, r, share, caseName, bar: bar(caseName, share), traded: coinInPair.start !== coinInPair.end };
}

// Biggest own move first (ties: ticker, then address), at most maxRows, numbered from 1.
export function rankRows(rows, maxRows = 25) {
  const key = (x) => [String(x.coin.symbol || ''), String(x.coin.address || '')];
  return (Array.isArray(rows) ? rows : [])
    .filter((x) => x && x.ok && Number.isFinite(x.r))
    .sort((a, b) => (b.r - a.r) || (key(a)[0] < key(b)[0] ? -1 : key(a)[0] > key(b)[0] ? 1 : 0)
      || (key(a)[1] < key(b)[1] ? -1 : key(a)[1] > key(b)[1] ? 1 : 0))
    .slice(0, Math.max(0, maxRows))
    .map((x, i) => ({ ...x, rank: i + 1 }));
}

// The board shows only when no more than half of the coins it tried failed.
// Coins younger than the window are left out and count neither way.
export function boardOutcome(results) {
  const list = Array.isArray(results) ? results : [];
  const good = list.filter((x) => x && x.ok).length;
  const young = list.filter((x) => x && !x.ok && x.why === 'young').length;
  const failed = list.length - good - young;
  const tried = list.length - young;
  return { ok: good > 0 && failed * 2 <= tried, good, failed, young };
}

// ---- prices at the start block --------------------------------------------------------------------
// The archive node first, but only after one small batch shows it is answering. When it says "unknown state" it
// keeps saying it for minutes, and asking it again for every pool (with retries) only adds ~80 requests and ~3 s.
// Then each pool's last trade at or before the start block comes from the official node's swap records, a couple
// of pools at a time (that node rate-limits bursts of log searches, so they are not sent all at once).
// items: [{ pool, block }] -> [BigInt sqrtPriceX96 (0n = no pool at that block) | null (no answer: row dropped)]
// net: { probe(items) -> [BigInt | undefined (no answer)], read(items) -> [BigInt | null], fromLogs(item) -> BigInt }
export const LOG_LANES = 2;
export async function readStartPrices(items, net) {
  if (!items.length) return [];
  const n = Math.min(items.length, RPC.drpc.batchMax);
  const first = await net.probe(items.slice(0, n));
  const out = items.map(() => null);
  if (first.some((x) => x !== undefined)) {
    // It answers: the rest as usual (a pool it still can't answer falls back to its swap records there).
    const redo = [];
    first.forEach((x, i) => { if (x === undefined) redo.push(i); else out[i] = x; });
    for (let i = n; i < items.length; i++) redo.push(i);
    const res = redo.length ? await net.read(redo.map((i) => items[i])) : [];
    redo.forEach((i, k) => { out[i] = res[k]; });
  } else {
    let next = 0;
    const lane = async () => {
      while (next < items.length) {
        const i = next++;
        try { out[i] = await net.fromLogs(items[i]); } catch (e) { out[i] = null; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LOG_LANES, items.length) }, lane));
  }
  return out.map((x) => (typeof x === 'bigint' && x >= 0n ? x : null));
}

const START_NET = {
  async probe(items) {
    try {
      const res = await rpcBatch('drpc', items.map(({ pool, block }) => {
        const c = slot0Call(pool);
        return ethCall(c.to, c.data, block);
      }), { tries: 2 });
      return res.map((r) => {
        if (r && r.result !== undefined) return wordAt(r.result, 0);     // '0x' (nothing there yet) -> 0n
        return r && r.error && /revert/i.test(r.error.message) ? 0n : undefined;
      });
    } catch (e) {
      return items.map(() => undefined);
    }
  },
  read: (items) => readEach(REAL_IO, items, { archive: true }),
  fromLogs: ({ pool, block }) => sqrtFromLogs(pool, block),
};

// ---- reading the chain ------------------------------------------------------------------------
const REAL_IO = {
  headBlock, blockTime, blockAtTime, readSqrtMany, sqrtFromLogs, findInitialize, tokenFacts,
  readStart: (items) => readStartPrices(items, START_NET),
};
const failWith = (why) => Object.assign(new Error(why), { why });

async function readDecimals(io, tokens) {
  const out = new Map();
  const groups = [];
  for (let i = 0; i < tokens.length; i += DEC_CHUNK) groups.push(tokens.slice(i, i + DEC_CHUNK));
  await Promise.all(groups.map(async (g) => {
    try {
      const facts = await io.tokenFacts(g);
      for (const t of g) out.set(t, facts.get(t) ? facts.get(t).decimals : null);
    } catch (e) {
      for (const t of g) out.set(t, null);
    }
  }));
  return out;
}

// Prices for every item; when one read fails for good, the rest are asked again one by one (reads that
// worked are cached in chain.js), so a failure only drops its own row. null = no answer.
async function readEach(io, items, opts) {
  if (!items.length) return [];
  try {
    return await io.readSqrtMany(items, opts);
  } catch (e) {
    return Promise.all(items.map((it) => io.readSqrtMany([it], opts).then((r) => r[0], () => null)));
  }
}

// The archive said "no price" at the start block: the pool's first log decides. 0n = born after the start.
async function startFromLogs(io, leg, startBlock, endBlock) {
  try {
    const init = await io.findInitialize(leg, { maxBlock: endBlock });
    if (!init) return null;
    if (init.block > startBlock) return 0n;
    const sqrt = await io.sqrtFromLogs(leg, startBlock);
    return sqrt > 0n ? sqrt : null;                      // it existed, so "no price" is a failed read
  } catch (e) {
    return null;
  }
}

// loadBoard(window, { endBlock?, coins?, stocks?, settings?, io?, now? })
//   -> { ok: true, window, start, end, rows (ranked), results, good, failed, young, total }
//   |  { ok: false, why: 'stale' | 'failed' | 'rpc', ... }
export async function loadBoard(win, opts = {}) {
  try {
    return await load(win, opts);
  } catch (e) {
    return { ok: false, why: (e && e.why) || 'rpc', detail: String((e && e.message) || e) };
  }
}

async function load(win, opts) {
  const io = { ...REAL_IO, ...(opts.io || {}) };
  // A swapped-in readSqrtMany (tests) also answers the start-block reads, unless a readStart is given too.
  if (opts.io && opts.io.readSqrtMany && !opts.io.readStart) io.readStart = (items) => readEach(io, items, { archive: true });
  const cfg = opts.cfg || boardSettings(opts.settings);
  const w = WINDOW_SECONDS[win] ? win : cfg.window;
  const secs = WINDOW_SECONDS[w];
  const coins = (opts.coins || visibleCoins(BOARD_COINS, cfg.hide)).map((c) => ({ ...c }));
  const plan = planBoard(coins, opts.stocks || STOCKS);
  const legs = [...plan.rows.filter((x) => x.leg).map((x) => x.leg), ...plan.stockLegs];
  const pinned = opts.endBlock != null;
  const now = opts.now != null ? opts.now : Date.now() / 1000;
  if (!legs.length) throw failWith('failed');

  // Decimals run while the blocks are found.
  const decP = readDecimals(io, [...new Set(legs.flatMap((l) => [l.token0, l.token1]))]);
  const endBlock = pinned ? Number(opts.endBlock) : (await io.headBlock()).number - 5;
  const endTime = await io.blockTime(endBlock);
  if (!Number.isFinite(endTime)) throw failWith('rpc');
  if (!pinned && now - endTime > cfg.limits.staleSeconds) throw failWith('stale');
  const startBlock = await io.blockAtTime(endTime - secs, { number: endBlock, time: endTime });
  const [startTime, dec] = await Promise.all([io.blockTime(startBlock), decP]);
  if (!Number.isFinite(startTime)) throw failWith('rpc');

  for (const l of legs) { l.dec0 = dec.get(l.token0); l.dec1 = dec.get(l.token1); }
  const ready = legs.filter((l) => l.dec0 != null && l.dec1 != null);
  // Every price at the same two blocks: the end on the official RPC (archive when pinned), the start on the
  // archive (swap records when the archive isn't answering; see readStartPrices).
  const [e, s] = await Promise.all([
    readEach(io, ready.map((pool) => ({ pool, block: endBlock })), { archive: pinned }),
    io.readStart(ready.map((pool) => ({ pool, block: startBlock }))),
  ]);
  const at = new Map(ready.map((l, i) => [l, { end: e[i], start: s[i] }]));
  await Promise.all(ready.filter((l) => at.get(l).start === 0n && goodSqrt(at.get(l).end))
    .map(async (l) => { at.get(l).start = await startFromLogs(io, l, startBlock, endBlock); }));

  const results = plan.rows.map(({ coin, leg, stockLeg }) => {
    if (!leg) return { ok: false, coin, why: 'list' };
    const a = at.get(leg), b = at.get(stockLeg);
    if (!a || !b) return { ok: false, coin, why: 'decimals' };
    if (a.start === 0n && goodSqrt(a.end)) return { ok: false, coin, why: 'young' };
    if (![a.start, a.end, b.start, b.end].every(goodSqrt)) return { ok: false, coin, why: 'read' };
    const coinInPair = { start: priceOf(coin.address, leg, a.start), end: priceOf(coin.address, leg, a.end) };
    const pairUsd = { start: priceOf(coin.stockAddress, stockLeg, b.start), end: priceOf(coin.stockAddress, stockLeg, b.end) };
    return boardRow(coin, coinInPair, pairUsd, cfg.limits);
  });
  const outcome = boardOutcome(results);
  if (!outcome.ok) return { ok: false, why: 'failed', ...outcome, total: results.length };
  return {
    ok: true, window: w,
    start: { block: startBlock, time: startTime }, end: { block: endBlock, time: endTime },
    rows: rankRows(results, cfg.maxRows), results, ...outcome, total: results.length,
  };
}

// The same answer for a minute per window (and per pinned block); failures are never kept.
const cache = new Map();
export function getBoard(win, opts = {}) {
  const key = win + '@' + (opts.endBlock != null ? opts.endBlock : 'live');
  const hit = cache.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < CACHE_SECONDS * 1000) return hit.p;
  const p = loadBoard(win, opts);
  cache.set(key, { at: Date.now(), p });
  const drop = () => { if (cache.get(key) && cache.get(key).p === p) cache.delete(key); };
  p.then((res) => { if (!res || !res.ok) drop(); }, drop);
  return p;
}
export function clearBoardCache() { cache.clear(); }

// ---- words for one row -----------------------------------------------------------------------
export function rowView(row, words = BOARD_WORDS) {
  const W = { ...BOARD_WORDS, ...words };
  const coin = row.coin || {};
  const sym = coin.symbol || shortAddr(coin.address || '');
  const stock = coin.stock || '';
  const pairPct = row.bar && Number.isFinite(row.bar.pair) ? Math.round(Math.min(1, Math.max(0, row.bar.pair)) * 100) : null;
  const vars = { rank: row.rank, coin: sym, stock, own: pct(row.r), coinPct: pct(row.c), stockPct: pct(row.q) };
  return {
    rank: String(row.rank),
    symbol: sym,
    tag: coin.tag || '',
    vs: 'vs ' + stock,
    own: pct(row.r), ownArrow: arrow(row.r),
    coinLabel: fill(W.inDollars, { coin: sym }), coinText: pct(row.c),
    stockLabel: stock, stockText: pct(row.q),
    bar: pairPct === null ? null : { pair: pairPct, coin: 100 - pairPct },
    aria: fill(W.rowLabel, vars),
  };
}

// 'Nov 13' from the list's scan time (UTC day).
export function scannedDate(iso = BOARD_SCANNED_AT) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(t));
  } catch (e) {
    return new Date(t).toISOString().slice(0, 10);
  }
}

// ---- tapping a row: run the main tool for that coin ------------------------------------------
// Same window as the card is showing: fill the paste box and submit it (src/app.js does the rest).
// Different window: open ?ca=…&w=… so the card uses the board's window.
export function openCoin(address, w) {
  const input = document.getElementById('ca-input');
  const form = document.getElementById('paste-form');
  let shownWindow = null;
  try { shownWindow = parseWindow(new URLSearchParams(location.search).get('w'), SETTINGS); } catch (e) { /* none */ }
  if (input && form && shownWindow === w) {
    input.value = address;
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const out = document.getElementById('result');
    if (out && out.firstElementChild) {
      try { out.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); } catch (e) { out.scrollIntoView(); }
    }
    return;
  }
  try { sessionStorage.setItem(HANDOFF, address); } catch (e) { /* no storage: the card still loads, unscrolled */ }
  try {
    const u = new URL(location.href);
    u.searchParams.set('ca', address);
    u.searchParams.set('w', w);
    u.hash = '';
    location.assign(u.pathname + u.search);
  } catch (e) {
    location.assign('?ca=' + encodeURIComponent(address) + '&w=' + encodeURIComponent(w));
  }
}

// After that reload, src/app.js draws the card for ?ca on its own (without scrolling): bring it into view once.
const HANDOFF = 'bts-board-open';
export function finishHandoff() {
  let want = null;
  try { want = sessionStorage.getItem(HANDOFF); sessionStorage.removeItem(HANDOFF); } catch (e) { return; }
  let ca = null;
  try { ca = (new URLSearchParams(location.search).get('ca') || '').trim().toLowerCase(); } catch (e) { /* none */ }
  const out = document.getElementById('result');
  if (!want || want !== ca || !out) return;
  const go = () => {
    try { out.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); } catch (e) { out.scrollIntoView(); }
  };
  if (out.firstElementChild) { go(); return; }
  if (typeof MutationObserver !== 'function') return;
  const mo = new MutationObserver(() => { if (out.firstElementChild) { mo.disconnect(); go(); } });
  mo.observe(out, { childList: true });
  setTimeout(() => mo.disconnect(), 10000);
}

// ---- DOM ----------------------------------------------------------------------------------------
const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
};

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false && kid !== '') el.append(kid);
  return el;
}

function windowTabs(wins, current, onPick, label) {
  const list = h('div', { class: 'board-tabs', role: 'tablist', 'aria-label': label });
  const select = (w) => {
    for (const t of list.children) {
      const on = t.dataset.window === w;
      t.setAttribute('aria-selected', String(on));
      t.setAttribute('tabindex', on ? '0' : '-1');
    }
  };
  for (const w of wins) {
    const tab = h('button', {
      type: 'button', class: 'board-tab', role: 'tab', id: 'board-tab-' + w, 'data-window': w,
      'aria-controls': 'board-panel', 'aria-selected': String(w === current), tabindex: w === current ? '0' : '-1', text: w,
    });
    tab.addEventListener('click', () => {
      if (tab.getAttribute('aria-selected') === 'true') return;
      select(w);
      onPick(w);
    });
    list.append(tab);
  }
  list.addEventListener('keydown', (e) => {
    const tabs = [...list.children];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const j = e.key === 'ArrowRight' ? (i + 1) % tabs.length : e.key === 'ArrowLeft' ? (i - 1 + tabs.length) % tabs.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : null;
    if (j === null) return;
    e.preventDefault();
    tabs.forEach((t, k) => t.setAttribute('tabindex', k === j ? '0' : '-1'));
    tabs[j].focus();
  });
  return list;
}

function miniBar(b) {
  if (!b) return h('span', { class: 'board-bar is-flat', 'aria-hidden': 'true' });
  const pair = h('i', { class: 'board-seg board-seg-pair' }), coin = h('i', { class: 'board-seg board-seg-coin' });
  pair.style.flexGrow = String(b.pair);
  coin.style.flexGrow = String(b.coin);
  return h('span', { class: 'board-bar' + (b.pair === 0 || b.coin === 0 ? ' is-whole' : ''), 'aria-hidden': 'true' }, pair, coin);
}

function rowEl(row, W, onOpen) {
  const v = rowView(row, W);
  const btn = h('button', { type: 'button', class: 'board-row', 'data-ca': row.coin.address, 'aria-label': v.aria },
    h('span', { class: 'board-rank', text: v.rank }),
    h('span', { class: 'board-coin' },
      h('span', { class: 'board-sym', text: v.symbol }),
      h('span', { class: 'board-vs', text: v.vs }),
      v.tag ? h('span', { class: 'board-tag', text: v.tag }) : null),
    miniBar(v.bar),
    h('span', { class: 'board-small' },
      h('span', { class: 'board-small-item' }, h('span', { class: 'board-small-label', text: v.coinLabel }), ' ', v.coinText),
      h('span', { class: 'board-small-item' }, h('span', { class: 'board-small-label', text: v.stockLabel }), ' ', v.stockText)),
    h('span', { class: 'board-own' }, h('span', { class: 'board-arrow', text: v.ownArrow }), v.own));
  btn.addEventListener('click', () => onOpen(row.coin.address));
  return h('li', { class: 'board-item' }, btn);
}

// Draws one state into the board panel: { kind: 'loading', count } | { kind: 'error' } | { kind: 'result', data }.
export function renderBoardState(panel, state, ctx = {}) {
  const cfg = ctx.cfg || boardSettings(SETTINGS);
  const W = cfg.words;
  const say = (t) => { if (ctx.status) ctx.status.textContent = t; };   // one short line for screen readers
  panel.removeAttribute('aria-busy');
  if (!state || state.kind === 'loading') {
    const skel = [];
    for (let i = 0; i < 6; i++) skel.push(h('span', { class: 'board-skel', 'aria-hidden': 'true' }));
    panel.setAttribute('aria-busy', 'true');
    say(fill(W.loading, { count: state && state.count != null ? state.count : '' }));
    panel.replaceChildren(
      h('p', { class: 'board-loading' }, h('span', { class: 'board-spin', 'aria-hidden': 'true' }),
        fill(W.loading, { count: state && state.count != null ? state.count : '' })),
      h('div', { class: 'board-skels' }, skel));
    return;
  }
  if (state.kind !== 'result' || !state.data || !state.data.ok || !state.data.rows.length) {
    const again = h('button', { type: 'button', class: 'board-again', text: W.tryAgain });
    again.addEventListener('click', () => { if (ctx.retry) ctx.retry(); });
    say(W.failed);
    panel.replaceChildren(h('div', { class: 'board-fail' }, h('p', { class: 'board-error', text: W.failed }), again));
    return;
  }
  const d = state.data;
  const open = ctx.open || ((address) => openCoin(address, d.window));
  const notes = [];
  if (d.failed > 0) notes.push(fill(d.failed === 1 ? W.leftOutFailedOne : W.leftOutFailed, { count: d.failed }));
  if (d.young > 0) notes.push(fill(d.young === 1 ? W.leftOutYoungOne : W.leftOutYoung, { count: d.young, window: d.window }));
  say(fill(W.loaded, { count: d.rows.length }));
  panel.replaceChildren(
    h('div', { class: 'board-head', 'aria-hidden': 'true' },
      h('span', { class: 'board-head-rank', text: '#' }),
      h('span', { class: 'board-head-coin', text: W.coin }),
      h('span', { class: 'board-head-own', text: W.ownMove })),
    h('ol', { class: 'board-list' }, d.rows.map((row) => rowEl(row, W, open))),
    h('div', { class: 'board-foot' },
      h('p', { class: 'board-legend', 'aria-hidden': 'true' },
        h('span', null, h('i', { class: 'board-dot board-dot-pair' }), W.legendPair),
        h('span', null, h('i', { class: 'board-dot board-dot-coin' }), W.legendCoin)),
      notes.length ? h('p', { class: 'board-note', text: notes.join(' ') }) : null,
      h('p', { class: 'board-asof', text: fill(cfg.asOf, { time: asOfTime(d.end.time) }) })));
}

// Run fn once the element is within a screen or so of view (most visitors never scroll this far).
function whenNear(el, fn) {
  if (typeof IntersectionObserver !== 'function') { fn(); return; }
  const io = new IntersectionObserver((entries) => {
    if (entries.some((x) => x.isIntersecting)) { io.disconnect(); fn(); }
  }, { rootMargin: '900px 0px 900px 0px' });
  io.observe(el);
}

// initBoard(section, { settings?, autoload?, load?, open?, endBlock? }) -> { run(window), show(state), panel }
export function initBoard(section, opts = {}) {
  if (!section) return null;
  const settings = opts.settings || SETTINGS;
  const cfg = boardSettings(settings);
  const W = cfg.words;
  const coins = visibleCoins(BOARD_COINS, cfg.hide);
  section.hidden = false;
  const title = section.querySelector('.section-label span');
  if (title) title.textContent = W.title;

  let current = cfg.windows.includes(cfg.window) ? cfg.window : cfg.windows[0], seq = 0;
  const panel = h('div', { class: 'board-panel', id: 'board-panel', role: 'tabpanel', 'aria-labelledby': 'board-tab-' + current });
  const status = h('p', { class: 'visually-hidden', role: 'status', 'aria-live': 'polite' });
  const tabs = windowTabs(cfg.windows, current, (w) => { current = w; run(w); }, W.windows);
  const ctx = { cfg, retry: () => run(current, { fresh: true }), open: opts.open, status };
  const mount = section.querySelector('.board-body') || section;
  mount.replaceChildren(
    h('div', { class: 'board-top' },
      h('div', { class: 'board-lede' }, h('p', { class: 'board-intro', text: W.intro }), h('p', { class: 'board-hint', text: W.tapHint })),
      tabs),
    h('div', { class: 'board-card' }, panel),
    status,
    h('p', { class: 'board-listnote', text: fill(W.listNote, { date: scannedDate() }) }));

  async function run(w, { fresh = false } = {}) {
    const my = ++seq;
    panel.setAttribute('aria-labelledby', 'board-tab-' + w);
    renderBoardState(panel, { kind: 'loading', count: coins.length }, ctx);
    let res;
    try {
      res = await (opts.load || getBoard)(w, { fresh, cfg, coins, endBlock: opts.endBlock });
    } catch (e) {
      res = { ok: false, why: 'rpc' };
    }
    if (my !== seq) return;                               // the visitor picked another window meanwhile
    renderBoardState(panel, { kind: 'result', data: res }, ctx);
  }

  renderBoardState(panel, { kind: 'loading', count: coins.length }, ctx);
  if (opts.autoload !== false) whenNear(section, () => run(current));
  finishHandoff();
  return { run, show: (state) => renderBoardState(panel, state, ctx), panel };
}
