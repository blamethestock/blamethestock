// fetchPriceInput(address, window, opts) -> PriceInput | ErrorResult   (contract: dev/SPEC.md 3.1, method: 5)
// Every price comes from Robinhood Chain at stated blocks. DexScreener/GeckoTerminal only find the pools.
import { SETTINGS } from '../../settings.js';
import * as K from './constants.js';
import { stats, resetStats, rpcBatch } from './rpc.js';
import {
  headBlock, blockTime, blockAtTime, readSqrtMany, findInitialize, sqrtFromLogs, tokenFacts, getCode,
  priceOf, sortTokens, clearChainCaches, findBlockAtTime, blockTimes, ethCall, wordAt, slot0Call, parseSwapLog, toHex,
} from './chain.js';
import { classifyAddress, findPools, pickUsdPool, otherChainPairCount } from './discover.js';
import { detectCurve, readCurve, findCurveStart, curvePrice, symbolOf, clearCurveCache, SEL_GET_RESERVES } from './curve.js';

class DataError extends Error {
  constructor(code, extra = {}) { super(code); this.code = code; this.extra = extra; }
}
const fail = (code, extra) => { throw new DataError(code, extra); };

const cache = { pools: new Map(), end: null };

export function clearDataCache() {
  cache.pools.clear();
  cache.end = null;
  clearChainCaches();
  clearCurveCache();
  routes.clear();
  atTime.clear();
  offReads.clear();
}

// Request counters for the test page: { requests, retries, byHost, byMethod }.
export function dataStats() { return JSON.parse(JSON.stringify(stats)); }
export function resetDataStats() { resetStats(); }

// stocks.js (~16 KB) loads on the first lookup, not with the page.
let stocksP = null;
function loadStocks() {
  if (!stocksP) stocksP = import('./stocks.js').then((m) => m.STOCKS, (e) => { stocksP = null; throw e; });
  return stocksP;
}

export async function fetchPriceInput(address, window, opts = {}) {
  try {
    return await lookup(address, window, opts);
  } catch (e) {
    if (e instanceof DataError) {
      const out = { ok: false, code: e.code };
      if (e.extra && e.extra.symbol) out.symbol = e.extra.symbol;
      if (e.extra && e.extra.detail) out.detail = e.extra.detail;
      return out;
    }
    return { ok: false, code: 'rpc-failed', detail: String((e && e.message) || e) };
  }
}

function normalizeAddress(s) {
  const a = String(s == null ? '' : s).trim();
  return /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : null;
}

// Pools per token, cached 5 minutes (the promise is cached so parallel lookups share one request).
function poolsFor(token, stocks) {
  const hit = cache.pools.get(token);
  if (hit && Date.now() - hit.at < K.POOL_CACHE_SECONDS * 1000) return hit.p;
  const p = findPools(token, stocks);
  cache.pools.set(token, { at: Date.now(), p });
  // A search that failed (neither source answered) must not stick for 5 minutes: drop it so the next try asks again.
  const drop = () => { if (cache.pools.get(token) && cache.pools.get(token).p === p) cache.pools.delete(token); };
  p.then((r) => { if (!r || !r.available) drop(); }, drop);
  return p;
}

// End of the window: latest block - 5 (shared for 15 s so window tabs line up), or a pinned block.
async function getEnd(pinned) {
  if (pinned != null) {
    const block = Number(pinned);
    return { block, time: await blockTime(block) };
  }
  if (cache.end && Date.now() - cache.end.at < K.HEAD_CACHE_SECONDS * 1000) return cache.end.p;
  const p = headBlock().then(async (h) => ({ block: h.number - 5, time: await blockTime(h.number - 5) }));
  cache.end = { at: Date.now(), p };
  p.catch(() => { cache.end = null; });
  return p;
}

function makeLeg(pool, base, quote) {
  const [token0, token1] = sortTokens(base, quote);
  return { id: pool.id, version: pool.version, uniswap: pool.uniswap !== false, base, quote, token0, token1, dec0: null, dec1: null, createdAt: pool.createdAt || null };
}
const poolVersion = (id) => (id.length === 66 ? 'v4' : 'v3');

// How to price `pair` in dollars: a list of legs whose prices multiply to the pair's dollar price.
async function usdRoute(pair, stocks, depth = 0) {
  if (pair.kind === 'stable') return { legs: [], via: null };
  if (pair.kind === 'eth') {
    const leg = makeLeg({ id: K.WETH_USDG_POOL, version: 'v3', uniswap: true }, K.WETH, K.USDG);
    return { legs: [leg], via: { id: K.WETH_USDG_POOL, label: 'WETH/USDG' } };
  }
  if (pair.kind === 'stock') {
    const s = stocks.get(pair.address);
    let pool = s && s.pool ? { id: s.pool, version: poolVersion(s.pool), uniswap: true } : null;
    if (!pool) {                                   // not precomputed: ask DexScreener (same rule as the build tool)
      const found = await poolsFor(pair.address, stocks);
      pool = pickUsdPool(found.cands, { usdgOnly: true, uniswapOnly: true });
      if (!pool) fail('unsupported-pool', { detail: 'no dollar pool for ' + pair.symbol });
    }
    return { legs: [makeLeg(pool, pair.address, K.USDG)], via: { id: pool.id, label: pair.symbol + '/USDG' } };
  }
  // another coin: one level deep only
  if (depth > 0) fail('unsupported-pool', { detail: 'pair route too deep' });
  const found = await poolsFor(pair.address, stocks);
  const pick = pickUsdPool(found.cands);
  if (!pick) fail('unsupported-pool', { detail: 'no dollar route for ' + pair.symbol });
  const first = makeLeg(pick, pair.address, pick.pair.address);
  const label = pair.symbol + '/' + pick.pair.symbol;
  if (pick.pair.kind === 'stable') return { legs: [first], via: { id: pick.id, label } };
  const next = await usdRoute(pick.pair, stocks, depth + 1);
  return { legs: [first, ...next.legs], via: { id: pick.id, label, via: next.via } };
}

// A non-stock, non-stable pair whose ticker copies a stock, a stablecoin or ETH (e.g. a copycat "NVDA").
function lookalike(pair, stocks) {
  if (pair.kind !== 'coin') return false;
  const s = String(pair.symbol || '').toUpperCase().replace(/^\$/, '');
  if (!s) return false;
  if (s === 'ETH' || s === 'WETH' || Object.values(K.STABLES).some((x) => x.toUpperCase() === s)) return true;
  for (const v of stocks.values()) if (v.symbol === s) return true;
  return false;
}

const routePrice = (legs, sqrts) => legs.reduce((p, leg, i) => p * priceOf(leg.base, leg, sqrts[i]), 1);

// A Pons coin still on its launch curve: coin price in the curve's pair token from the curve's reserves,
// the pair's dollar price from the usual pools, both at the same start and end blocks.
async function curveLookup({ coin, curve, win, secs, endP, startP, stocks, pinned, progress }) {
  progress('Reading the Pons launch curve…');
  const pc = classifyAddress(curve.pairToken, stocks);
  const pair = { address: curve.pairToken, kind: pc.kind, symbol: pc.symbol };
  if (pair.kind === 'coin') pair.symbol = (await symbolOf(pair.address).catch(() => '')) || pair.address.slice(0, 6) + '…';
  let route = await usdRoute(pair, stocks);
  const isNative = pair.address === K.ETH_NATIVE;
  const tokens = [...new Set([coin, ...(isNative ? [] : [pair.address]), ...route.legs.flatMap((l) => [l.token0, l.token1])])];
  const facts = await tokenFacts(tokens, { checkStock: pair.kind === 'coin' ? [pair.address] : [] });
  if (pair.kind === 'coin' && facts.get(pair.address).isStock) {        // a stock listed after stocks.js was built
    pair.kind = 'stock';
    route = await usdRoute(pair, stocks);
    const more = route.legs.flatMap((l) => [l.token0, l.token1]).filter((t) => !facts.has(t));
    if (more.length) for (const [t, f] of await tokenFacts(more)) facts.set(t, f);
  }
  for (const leg of route.legs) {
    leg.dec0 = facts.get(leg.token0).decimals;
    leg.dec1 = facts.get(leg.token1).decimals;
    if (leg.dec0 == null || leg.dec1 == null) fail('unsupported-pool', { detail: 'unknown decimals' });
  }
  const decCoin = facts.get(coin).decimals;
  const decQuote = isNative ? 18 : facts.get(pair.address).decimals;
  if (decCoin == null || decQuote == null) fail('unsupported-pool', { detail: 'unknown decimals' });

  const end = await endP;
  if (!pinned && Date.now() / 1000 - end.time > SETTINGS.limits.staleSeconds) fail('stale');
  progress('Reading prices…');
  const [eCurve, eLegs] = await Promise.all([
    readCurve(curve.curve, end.block, { archive: pinned, withReal: true }),
    readSqrtMany(route.legs.map((pool) => ({ pool, block: end.block })), { archive: pinned }),
  ]);
  if (!eCurve) fail('rpc-failed', { detail: 'curve unreadable at end' });
  if (eLegs.some((x) => x === 0n)) fail('unsupported-pool', { detail: 'pair price pool unreadable' });

  let startBlock = await startP;
  let sinceLaunch = false;
  let sCurve = await readCurve(curve.curve, startBlock, { archive: true });
  if (!sCurve) {                                                // the curve is younger than the window
    const born = await findCurveStart(curve.curve, end.block);
    if (!born) fail('rpc-failed', { detail: 'curve start not found' });
    if (born > startBlock) { startBlock = born; sinceLaunch = true; }
    sCurve = await readCurve(curve.curve, startBlock, { archive: true });
    if (!sCurve) fail('rpc-failed', { detail: 'curve unreadable at start' });
  }
  const sLegs = await readSqrtMany(route.legs.map((pool) => ({ pool, block: startBlock })), { archive: true });
  if (sLegs.some((x) => x === 0n)) fail('pair-too-new');
  const startTime = await blockTime(startBlock);

  const coinInPair = { start: curvePrice(sCurve, decCoin, decQuote), end: curvePrice(eCurve, decCoin, decQuote) };
  const pairUsd = route.legs.length ? { start: routePrice(route.legs, sLegs), end: routePrice(route.legs, eLegs) } : null;
  for (const v of [coinInPair.start, coinInPair.end, ...(pairUsd ? [pairUsd.start, pairUsd.end] : [])]) {
    if (!(v > 0 && Number.isFinite(v))) fail('unsupported-pool', { detail: 'price out of range' });
  }
  const realQuote = eCurve.real != null ? Number(eCurve.real) / 10 ** decQuote : null;
  const pairSideUsd = realQuote != null ? realQuote * (pairUsd ? pairUsd.end : 1) : null;
  const sym = curve.symbol || '';
  return remember({
    ok: true,
    coin: { address: coin, symbol: sym, name: sym },
    pair: { address: pair.address, symbol: pair.symbol, kind: pair.kind, lookalike: lookalike(pair, stocks) },
    pool: {
      id: curve.curve, dex: 'pons-curve', label: sym + '/' + pair.symbol,
      pairSideUsd: Number.isFinite(pairSideUsd) ? pairSideUsd : null,
      createdAt: sinceLaunch ? startTime : null,
      source: 'pons-curve',
    },
    window: win,
    windowSeconds: secs,
    start: { block: startBlock, time: startTime },
    end: { block: end.block, time: end.time },
    sinceLaunch,
    coinInPair,
    pairUsd,
    pairVia: route.via,
    tradedInWindow: sCurve.quote !== eCurve.quote || sCurve.token !== eCurve.token,
  }, { type: 'curve', curve: curve.curve, decCoin, decQuote, routeLegs: route.legs });
}

// Why there is no pool: another chain, not a token, or just no pool.
async function diagnose(coin, found) {
  let code = found.code;
  if (code == null) {
    try { code = await getCode(coin); } catch (e) { fail('rpc-failed', { detail: 'getCode' }); }
  }
  if (!found.available && code !== '0x') fail('rpc-failed', { detail: 'pool search unavailable' });
  if (code && code !== '0x') {
    const facts = await tokenFacts([coin]);
    fail(facts.get(coin).decimals == null ? 'not-a-token' : 'no-pool');
  }
  const elsewhere = await otherChainPairCount(coin);
  fail(elsewhere > 0 ? 'wrong-chain' : 'not-a-token');
}

async function lookup(address, window, opts) {
  const progress = (t) => { try { if (opts.onProgress) opts.onProgress(t); } catch (e) { /* ignore */ } };
  const coin = normalizeAddress(address);
  if (!coin) fail('bad-address');
  const win = K.WINDOW_SECONDS[window] ? window : (K.WINDOW_SECONDS[SETTINGS.defaultWindow] ? SETTINGS.defaultWindow : '24h');
  const secs = K.WINDOW_SECONDS[win];
  const pinned = opts.endBlock != null;

  const stocks = await loadStocks();
  const own = classifyAddress(coin, stocks);
  if (own.kind !== 'coin') fail('is-pair-asset', { symbol: own.symbol });

  progress('Finding the pool…');
  const endP = getEnd(opts.endBlock);
  const startP = endP.then((end) => blockAtTime(end.time - secs, { number: end.block, time: end.time }));   // runs while the pool search runs
  endP.catch(() => {}); startP.catch(() => {});

  // A Pons coin still on its launch curve has no pool yet: its price lives on the curve.
  const curveP = detectCurve(coin).catch(() => null);
  const poolsP = poolsFor(coin, stocks);
  poolsP.catch(() => {});
  const curve = await curveP;
  if (curve && !curve.graduated) return curveLookup({ coin, curve, win, secs, endP, startP, stocks, pinned, progress });

  const found = await poolsP;
  if (!found.cands.length) await diagnose(coin, found);
  let ranked = found.ranked;
  if (opts.poolId) ranked = found.cands.filter((c) => c.id === String(opts.poolId).toLowerCase() && c.readable);
  if (!ranked.length) fail('unsupported-pool', { detail: 'no readable pool' });

  const end = await endP;
  if (!pinned && Date.now() / 1000 - end.time > SETTINGS.limits.staleSeconds) fail('stale');
  progress('Reading prices…');

  // Main pool: the deepest readable one whose price answers at the end block and whose pair we can
  // price in dollars (a pool paired with a coin that has no dollar route falls through to the next one).
  let chosen = null, firstErr = null;
  for (const cand of ranked.slice(0, 3)) try {
    const pair = { ...cand.pair };
    const coinLeg = makeLeg(cand, coin, pair.address);
    let route = await usdRoute(pair, stocks);
    const tokens = [...new Set([coin, pair.address, ...route.legs.flatMap((l) => [l.token0, l.token1])])];
    const facts = await tokenFacts(tokens, { checkStock: pair.kind === 'coin' ? [coin, pair.address] : [coin] });
    if (facts.get(coin).isStock) fail('is-pair-asset', { symbol: cand.coin.symbol || 'a stock token' });
    if (pair.kind === 'coin' && facts.get(pair.address).isStock) {          // a stock listed after stocks.js was built
      pair.kind = 'stock';
      route = await usdRoute(pair, stocks);
      const more = route.legs.flatMap((l) => [l.token0, l.token1]).filter((t) => !facts.has(t));
      if (more.length) for (const [t, f] of await tokenFacts(more)) facts.set(t, f);
    }
    const legs = [coinLeg, ...route.legs];
    for (const leg of legs) {
      leg.dec0 = facts.get(leg.token0).decimals;
      leg.dec1 = facts.get(leg.token1).decimals;
      if (leg.dec0 == null || leg.dec1 == null) {
        if (facts.get(coin).decimals == null) fail('not-a-token');
        fail('unsupported-pool', { detail: 'unknown decimals' });
      }
    }
    const e = await readSqrtMany(legs.map((pool) => ({ pool, block: end.block })), { archive: pinned });
    if (e[0] === 0n) continue;                                  // this pool doesn't answer: try the next one
    if (e.slice(1).some((x) => x === 0n)) fail('unsupported-pool', { detail: 'pair price pool unreadable' });
    chosen = { cand, pair, coinLeg, route, legs, endSqrt: e };
    break;
  } catch (err) {
    if (!(err instanceof DataError && err.code === 'unsupported-pool')) throw err;
    firstErr = firstErr || err;
  }
  if (!chosen) throw firstErr || new DataError('unsupported-pool', { detail: 'main pool unreadable' });
  const { cand, pair, coinLeg, route, legs } = chosen;

  // Start of the window (or the pool's first block when it is younger than the window).
  const startTarget = end.time - secs;
  let startBlock = await startP;
  let sinceLaunch = false;
  const hint = cand.createdAt ? end.block - Math.round((end.time - cand.createdAt) / K.BLOCK_SECONDS) : null;
  let created = null;
  if (cand.createdAt && cand.createdAt > startTarget - 3600) {
    created = await findInitialize(coinLeg, { maxBlock: end.block, hintBlock: hint });
    if (created && created.block > startBlock) { startBlock = created.block; sinceLaunch = true; }
  }
  let s = await readSqrtMany(legs.map((pool) => ({ pool, block: startBlock })), { archive: true });
  if (s[0] === 0n && !sinceLaunch) {
    created = created || await findInitialize(coinLeg, { maxBlock: end.block, hintBlock: hint });
    if (!created) fail('rpc-failed', { detail: 'pool start not found' });
    if (created.block > startBlock) {
      startBlock = created.block; sinceLaunch = true;
      s = await readSqrtMany(legs.map((pool) => ({ pool, block: startBlock })), { archive: true });
    } else if (coinLeg.uniswap) {
      s[0] = await sqrtFromLogs(coinLeg, startBlock);          // the archive said "no pool" but it existed
    }
  }
  if (s[0] === 0n) fail('rpc-failed', { detail: 'no start price' });
  for (let i = 1; i < legs.length; i++) {
    if (s[i] !== 0n) continue;
    const legHint = legs[i].createdAt ? end.block - Math.round((end.time - legs[i].createdAt) / K.BLOCK_SECONDS) : null;
    const init = await findInitialize(legs[i], { maxBlock: end.block, hintBlock: legHint });
    if (!init || init.block > startBlock) fail('pair-too-new');
    if (legs[i].uniswap) s[i] = await sqrtFromLogs(legs[i], startBlock);
    if (s[i] === 0n) fail('pair-too-new');
  }
  const startTime = await blockTime(startBlock);

  const e = chosen.endSqrt;
  const coinInPair = { start: priceOf(coin, coinLeg, s[0]), end: priceOf(coin, coinLeg, e[0]) };
  const routeLegs = legs.slice(1);
  const pairUsd = routeLegs.length
    ? { start: routePrice(routeLegs, s.slice(1)), end: routePrice(routeLegs, e.slice(1)) }
    : null;
  for (const v of [coinInPair.start, coinInPair.end, ...(pairUsd ? [pairUsd.start, pairUsd.end] : [])]) {
    if (!(v > 0 && Number.isFinite(v))) fail('unsupported-pool', { detail: 'price out of range' });
  }
  // Only a measured amount is shown (DexScreener's per-side amount, or the on-chain figure for a
  // GeckoTerminal pool), priced at the pair's on-chain dollar price. Unknown = null, never a guess.
  const pairSideUsd = cand.pairAmount != null ? cand.pairAmount * (pairUsd ? pairUsd.end : 1) : null;
  const coinSymbol = cand.coin.symbol || '';

  return remember({
    ok: true,
    coin: { address: coin, symbol: coinSymbol, name: cand.coin.name || coinSymbol },
    pair: { address: pair.address, symbol: pair.symbol, kind: pair.kind, lookalike: lookalike(pair, stocks) },
    pool: {
      id: cand.id, dex: cand.dex, label: coinSymbol + '/' + pair.symbol,
      pairSideUsd: Number.isFinite(pairSideUsd) ? pairSideUsd : null,
      createdAt: sinceLaunch ? startTime : cand.createdAt,     // since launch: the chain's own creation time
      source: cand.source,
    },
    window: win,
    windowSeconds: secs,
    start: { block: startBlock, time: startTime },
    end: { block: end.block, time: end.time },
    sinceLaunch,
    coinInPair,
    pairUsd,
    pairVia: route.via,
    tradedInWindow: s[0] !== e[0],
  }, { type: 'pool', coin, coinLeg, routeLegs });
}

// ---- Off-hours mode (settings.features.offHoursMode) -------------------------------------------
// fetchOffHours(priceInput, { cancelled }) -> { ok: true, pieces, totals, start, end } | { ok: false, code }
//   pieces: [{ from, to, open, fromBlock, toBlock, c, q, r }] — one per stretch of US market time (open or closed),
//   totals: features/offhours.js summarize(pieces) (closed and open stretches multiplied together).
// Splits the window at every US market open and close (features/markethours.js), finds the block at each one (the
// last block at or before that second, the same rule as the window's start) and reads the SAME pools (or Pons
// curve) as the lookup that produced priceInput, at those blocks. The start and end prices are the card's own, so
// the stretches multiply back to the card's c and q exactly. Any failure -> { ok: false }: never part of the numbers.
const routes = new Map();      // 'coin|window|end block' -> the legs that lookup read (the last few lookups)
const atTime = new Map();      // a market open/close (unix s) -> promise of its block (a fixed fact once found)
const routeKey = (pi) => pi.coin.address + '|' + pi.window + '|' + pi.end.block;

function remember(pi, route) {
  routes.set(routeKey(pi), route);
  while (routes.size > 12) routes.delete(routes.keys().next().value);
  return pi;
}

export async function fetchOffHours(priceInput, opts = {}) {
  try {
    return await offHours(priceInput, opts);
  } catch (e) {
    return { ok: false, code: 'rpc-failed', detail: String((e && e.message) || e) };
  }
}

async function offHours(pi, opts) {
  const no = (code) => ({ ok: false, code });
  if (!pi || pi.ok !== true || !pi.coin || !pi.start || !pi.end || !pi.coinInPair) return no('no-input');
  const route = routes.get(routeKey(pi));
  if (!route) return no('no-route');
  const cancelled = () => typeof opts.cancelled === 'function' && !!opts.cancelled();
  const [{ splitWindow }, { piecesFromPrices, summarize }] = await Promise.all([
    import('../features/markethours.js'), import('../features/offhours.js'),
  ]);
  const split = splitWindow(pi.start.time, pi.end.time);
  if (!split.pieces.length) return no('empty-window');

  // Blocks at the opens and closes. First guess from this window's own average block time.
  const ref = { number: pi.end.block, time: pi.end.time };
  const spb = (pi.end.time - pi.start.time) / (pi.end.block - pi.start.block);
  const getTimes = sharedTimes();
  const mids = await Promise.all(split.boundaries.map((T) => blockAt(T, ref, spb > 0 && spb < 10 ? spb : K.BLOCK_SECONDS, getTimes)));
  const blocks = [pi.start.block, ...mids, pi.end.block];
  for (let i = 1; i < blocks.length; i++) if (!(blocks[i] >= blocks[i - 1])) return no('block-order');
  if (cancelled()) return no('cancelled');

  const prices = mids.length ? await pricesAt(route, mids) : [];
  if (cancelled()) return no('cancelled');
  const ends = (k) => ({ coinInPair: pi.coinInPair[k], pairUsd: pi.pairUsd ? pi.pairUsd[k] : null });
  const pieces = piecesFromPrices(split, [ends('start'), ...prices, ends('end')]);
  if (!pieces) return no('bad-prices');
  pieces.forEach((p, i) => { p.fromBlock = blocks[i]; p.toBlock = blocks[i + 1]; });
  return { ok: true, coin: pi.coin.address, window: pi.window, start: pi.start, end: pi.end, pieces, totals: summarize(pieces) };
}

function blockAt(T, ref, secondsPerBlock, getTimes) {
  if (!(T < ref.time)) return Promise.resolve(ref.number);
  let p = atTime.get(T);
  if (!p) {
    p = findBlockAtTime(T, ref, getTimes, secondsPerBlock);
    atTime.set(T, p);
    p.catch(() => { if (atTime.get(T) === p) atTime.delete(T); });
  }
  return p;
}

// Block searches running side by side share their header requests: each round's probes go out as one batch
// (blockTimes splits it into the official node's batch size), instead of one small request per search.
function sharedTimes() {
  let queue = null;
  return (ns) => new Promise((resolve, reject) => {
    if (!queue) {
      const q = queue = [];
      Promise.resolve().then(() => {               // every search asks in the same turn: send them together
        queue = null;
        const all = [...new Set(q.flatMap((x) => x.ns))];
        blockTimes(all).then((ts) => {
          const at = new Map(all.map((n, i) => [n, ts[i]]));
          for (const x of q) x.resolve(x.ns.map((n) => at.get(n)));
        }, (e) => { for (const x of q) x.reject(e); });
      });
    }
    queue.push({ ns, resolve, reject });
  });
}

// [{ coinInPair, pairUsd }] at each block, from the remembered legs (archive node; pools fall back to swap logs).
async function pricesAt(route, blocks) {
  const legs = route.type === 'pool' ? [route.coinLeg, ...route.routeLegs] : route.routeLegs;
  const n = legs.length;
  const [sqrts, curves] = await Promise.all([
    n ? sqrtsAt(blocks.flatMap((block) => legs.map((pool) => ({ pool, block })))) : [],
    route.type === 'curve' ? curvesAt(route.curve, blocks) : null,
  ]);
  return blocks.map((block, i) => {
    const s = sqrts.slice(i * n, (i + 1) * n);
    const coinInPair = route.type === 'pool' ? priceOf(route.coin, route.coinLeg, s[0]) : curvePrice(curves[i], route.decCoin, route.decQuote);
    const pairS = route.type === 'pool' ? s.slice(1) : s;
    return { coinInPair, pairUsd: route.routeLegs.length ? routePrice(route.routeLegs, pairS) : null };
  });
}

// Pool prices (sqrtPriceX96) at the opens and closes. The archive node first, but only after one small batch shows
// it is answering: when it says "unknown state" it keeps saying it for minutes, and asking again for every point
// would only burn requests. Otherwise (or for what it can't answer) the last trade at or before each point, from
// the official node's trade log: every point in one batch, nearest stretch of blocks first.
const offReads = new Map();    // 'pool@block' -> sqrtPriceX96 at an open/close (a fixed fact once read)
const LOG_TIERS = [[0, 2000], [2000, 20000], [20000, 200000]];   // blocks back from the point: ~3 min, ~35 min, ~6 h

async function sqrtsAt(items) {
  const keyOf = (it) => it.pool.id + '@' + it.block;
  const out = items.map((it) => offReads.get(keyOf(it)));
  let todo = items.map((_, i) => i).filter((i) => out[i] === undefined);
  const archive = async (idx) => {
    let res;
    try {
      res = await rpcBatch('drpc', idx.map((i) => {
        const c = slot0Call(items[i].pool);
        return ethCall(c.to, c.data, items[i].block);
      }), { tries: 4 });
    } catch (e) { return false; }
    let all = true;
    idx.forEach((i, j) => {
      const s = res[j] && res[j].result !== undefined ? wordAt(res[j].result, 0) : 0n;
      if (s !== 0n) out[i] = s; else all = false;      // 0n: "no pool" (it can say so wrongly): ask the trade log
    });
    return all;
  };
  const n = K.RPC.drpc.batchMax;
  if (todo.length && (await archive(todo.slice(0, n))) && todo.length > n) await archive(todo.slice(n));
  todo = todo.filter((i) => out[i] === undefined && items[i].pool.uniswap);
  if (todo.length) await fromTradeLogs(items, todo, out);
  return items.map((it, i) => {
    if (out[i] === undefined || out[i] === 0n) fail('rpc-failed', { detail: 'no price at an open/close' });
    offReads.set(keyOf(it), out[i]);
    return out[i];
  });
}

async function fromTradeLogs(items, idx, out) {
  const left = [];
  for (const [near, far] of LOG_TIERS) {
    if (!idx.length) break;
    let res;
    try {
      res = await rpcBatch('official', idx.map((i) => {
        const { pool, block } = items[i];
        const f = pool.version === 'v4'
          ? { address: K.POOL_MANAGER, topics: [K.TOPIC_V4_SWAP, pool.id] }
          : { address: pool.id, topics: [K.TOPIC_V3_SWAP] };
        return { method: 'eth_getLogs', params: [{ ...f, fromBlock: toHex(Math.max(0, block - far + 1)), toBlock: toHex(Math.max(0, block - near)) }] };
      }), { tries: 3 });
    } catch (e) { break; }
    const next = [];
    idx.forEach((i, j) => {
      const logs = res[j] && Array.isArray(res[j].result) ? res[j].result : null;
      if (!logs) { left.push(i); return; }                          // an error (too many logs, node trouble)
      if (!logs.length) { next.push(i); return; }                   // no trade that recent: look further back
      const last = logs.map(parseSwapLog).reduce((a, b) => (b.block > a.block || (b.block === a.block && b.index > a.index) ? b : a));
      if (last.sqrt !== 0n) out[i] = last.sqrt; else left.push(i);
    });
    idx = next;
  }
  // Whatever is left (a very quiet pool, an error above): the one-by-one search, back to the pool's first price.
  for (const i of left.concat(idx)) out[i] = await sqrtFromLogs(items[i].pool, items[i].block);
}

// Curve reserves at the opens and closes (archive node only, as for the window's start). One small batch first,
// so a node that isn't answering is asked once, not once per point.
async function curvesAt(curve, blocks) {
  const read = async (bs) => {
    if (!bs.length) return [];
    const res = await rpcBatch('drpc', bs.map((b) => ethCall(curve, SEL_GET_RESERVES, b)), { tries: 4 });
    return res.map((r) => {
      if (!r || !r.result || r.result.length < 130) fail('rpc-failed', { detail: 'curve unreadable at an open/close' });
      return { quote: wordAt(r.result, 0), token: wordAt(r.result, 1), real: null };
    });
  };
  const n = K.RPC.drpc.batchMax;
  const first = await read(blocks.slice(0, n));
  return first.concat(await read(blocks.slice(n)));
}
