// fetchPriceInput(address, window, opts) -> PriceInput | ErrorResult   (contract: dev/SPEC.md 3.1, method: 5)
// Every price comes from Robinhood Chain at stated blocks. DexScreener/GeckoTerminal only find the pools.
import { SETTINGS } from '../../settings.js';
import * as K from './constants.js';
import { stats, resetStats, rpcBatch, logOpts, serverTime } from './rpc.js';
import {
  headBlock, otherHead, blockTime, blockAtTime, readSqrtMany, findInitialize, sqrtFromLogs, tokenFacts, getCode,
  priceOf, sortTokens, clearChainCaches, findBlockAtTime, blockTimes, ethCall, wordAt, slot0Call, parseSwapLog, toHex,
} from './chain.js';
import { classifyAddress, findPools, pickUsdPool, otherChainPairCount } from './discover.js';
import { detectCurve, readCurve, findCurveStart, curvePrice, symbolOf, clearCurveCache, forgetCurve, SEL_GET_RESERVES } from './curve.js';

class DataError extends Error {
  constructor(code, extra = {}) { super(code); this.code = code; this.extra = extra; }
}
const fail = (code, extra) => { throw new DataError(code, extra); };

const cache = { pools: new Map(), end: null };

export function clearDataCache() {
  cache.pools.clear();
  cache.end = null;
  clockSkew = 0;
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
let stocksNow = null;          // the list, once loaded
function loadStocks() {
  if (!stocksP) stocksP = import('./stocks.js').then((m) => (stocksNow = m.STOCKS), (e) => { stocksP = null; throw e; });
  return stocksP;
}

// opts.cancelled?() -> true once the caller no longer wants this answer (the visitor started another lookup):
// the lookup stops at its next step with { ok: false, code: 'rpc-failed', detail: 'cancelled' }.
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
  p.then((r) => { if (!r || !r.available) forgetPools(token, p); }, () => forgetPools(token, p));
  return p;
}
function forgetPools(token, p) {             // p: only that search (a newer one may have started meanwhile)
  const hit = cache.pools.get(token);
  if (hit && (p === undefined || hit.p === p)) cache.pools.delete(token);
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

// Is the end block recent enough to show? The visitor's clock can be off and one node can lag, so before
// saying "stale": ask the other nodes for their head (a newer one becomes the end), then judge the age by the
// web server's clock (the Date header of a same-origin HEAD request) instead of this device's.
let clockSkew = 0;             // seconds this device's clock runs ahead of the web server's (once measured)
async function freshEnd(end) {
  const limit = SETTINGS.limits.staleSeconds;
  const age = () => Date.now() / 1000 - clockSkew - end.time;
  if (age() <= limit) return end;
  const head = await otherHead().catch(() => null);
  if (head && head.number - 5 > end.block) {
    const block = head.number - 5;
    end = { block, time: await blockTime(block) };
    cache.end = { at: Date.now(), p: Promise.resolve(end) };
    if (age() <= limit) return end;
  }
  const server = await serverTime();
  if (server != null) {
    clockSkew = Date.now() / 1000 - server;
    if (server - end.time <= limit) return end;
  }
  return fail('stale');
}

// The window's end block (checked for freshness unless pinned) and its start block (the last block at or before
// end - secs). The start search begins as soon as the end is known, alongside the pool search.
function windowSpan(endP, secs, pinned) {
  const startOf = (end) => blockAtTime(end.time - secs, { number: end.block, time: end.time });
  let startP = endP.then(startOf);
  endP.catch(() => {}); startP.catch(() => {});
  return {
    async end() {
      const first = await endP;
      if (pinned) return first;
      const end = await freshEnd(first);
      if (end.block !== first.block) { startP = startOf(end); startP.catch(() => {}); }
      return end;
    },
    start: () => startP,
  };
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
  // A pool search that got no answer must not read as "no dollar pool": that would quietly switch the coin to
  // another main pool, or call it unreadable. Say the search failed (try again) instead.
  const search = async () => {
    const found = await poolsFor(pair.address, stocks);
    if (!found.available) fail('search-failed', { detail: 'pool search unavailable for ' + (pair.symbol || pair.address) });
    return found;
  };
  if (pair.kind === 'stock') {
    const s = stocks.get(pair.address);
    let pool = s && s.pool ? { id: s.pool, version: poolVersion(s.pool), uniswap: true } : null;
    if (!pool) {                                   // not precomputed: ask DexScreener (same rule as the build tool)
      pool = pickUsdPool((await search()).cands, { usdgOnly: true, uniswapOnly: true });
      if (!pool) fail('unsupported-pool', { detail: 'no dollar pool for ' + pair.symbol });
    }
    return { legs: [makeLeg(pool, pair.address, K.USDG)], via: { id: pool.id, label: pair.symbol + '/USDG' } };
  }
  // another coin: one level deep only
  if (depth > 0) fail('unsupported-pool', { detail: 'pair route too deep' });
  const pick = pickUsdPool((await search()).cands);
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

// A pair-pricing leg whose archive read at `block` came back empty. The archive can say "no pool" wrongly, so
// check the pool's birth: born at or before `block` -> its last trade at or before it (the trade log stops at the
// birth). Born later (or never found) -> the pair's dollar pool is too new for this window.
async function legAt(leg, block, end) {
  const hint = leg.createdAt ? end.block - Math.round((end.time - leg.createdAt) / K.BLOCK_SECONDS) : null;
  const init = await findInitialize(leg, { maxBlock: end.block, hintBlock: hint });
  if (!init || init.block > block) fail('pair-too-new');
  leg.createdBlock = init.block;
  const s = leg.uniswap ? await sqrtFromLogs(leg, block) : 0n;
  if (s === 0n) fail('pair-too-new');
  return s;
}

// Where a window starts for a coin priced on its Pons launch curve -> { block, sinceLaunch, reserves }.
// The curve's birth comes first (the official node's log, kept per curve). A curve born inside the window starts
// at its birth (a real launch: since launch); its state there is read on the official node while that node still
// holds it (~10 min), so a brand-new coin doesn't depend on the archive node. If the log can't be read, the
// archive says whether the curve already existed at the window's start.
async function curveStart(curve, windowStart, endBlock) {
  let born = null, logs = true;
  try { born = await findCurveStart(curve, endBlock, { minBlock: windowStart + 1 }); } catch (e) { logs = false; }
  const block = born != null ? born : windowStart;
  const reserves = await readCurve(curve, block, { archive: endBlock - block > 5000 });
  if (!reserves) fail('rpc-failed', { detail: logs ? 'curve unreadable at start' : 'curve start not found' });
  return { block, sinceLaunch: born != null, reserves };
}

// A Pons coin still on its launch curve: coin price in the curve's pair token from the curve's reserves,
// the pair's dollar price from the usual pools, both at the same start and end blocks.
async function curveLookup({ coin, curve, win, secs, span, stocks, pinned, progress, step }) {
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

  const end = await span.end();
  step();
  progress('Reading prices…');
  const [eCurve, eLegs] = await Promise.all([
    readCurve(curve.curve, end.block, { archive: pinned, withReal: true }),
    readSqrtMany(route.legs.map((pool) => ({ pool, block: end.block })), { archive: pinned }),
  ]);
  if (!eCurve) fail('rpc-failed', { detail: 'curve unreadable at end' });
  if (eCurve.token === 0n) {                    // it graduated a moment ago (the Pons check was cached): look again
    forgetCurve(coin);
    forgetPools(coin);                          // the pool search from before graduation doesn't list its new pool
    fail('rpc-failed', { detail: 'curve just graduated' });
  }
  if (eLegs.some((x) => x === 0n)) fail('unsupported-pool', { detail: 'pair price pool unreadable' });

  const { block: startBlock, sinceLaunch, reserves: sCurve } = await curveStart(curve.curve, await span.start(), end.block);
  step();
  const sLegs = await readSqrtMany(route.legs.map((pool) => ({ pool, block: startBlock })), { archive: true });
  for (let i = 0; i < sLegs.length; i++) if (sLegs[i] === 0n) sLegs[i] = await legAt(route.legs[i], startBlock, end);
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
  if (!found.available && code !== '0x') fail('search-failed', { detail: 'pool search unavailable' });
  if (code && code !== '0x') {
    const facts = await tokenFacts([coin]);
    fail(facts.get(coin).decimals == null ? 'not-a-token' : 'no-pool');
  }
  const elsewhere = await otherChainPairCount(coin);
  fail(elsewhere > 0 ? 'wrong-chain' : 'not-a-token');
}

async function lookup(address, window, opts) {
  const progress = (t) => { try { if (opts.onProgress) opts.onProgress(t); } catch (e) { /* ignore */ } };
  const step = () => {
    let gone = false;
    try { gone = typeof opts.cancelled === 'function' && !!opts.cancelled(); } catch (e) { /* ignore */ }
    if (gone) fail('rpc-failed', { detail: 'cancelled' });
  };
  const coin = normalizeAddress(address);
  if (!coin) fail('bad-address');
  const win = K.WINDOW_SECONDS[window] ? window : (K.WINDOW_SECONDS[SETTINGS.defaultWindow] ? SETTINGS.defaultWindow : '24h');
  const secs = K.WINDOW_SECONDS[win];
  const pinned = opts.endBlock != null;

  // Dollar coins, ETH and (once stocks.js has loaded) stock tokens are known without asking anyone.
  const quick = classifyAddress(coin, stocksNow);
  if (quick.kind !== 'coin') fail('is-pair-asset', { symbol: quick.symbol });

  progress('Finding the pool…');
  // The chain's head and the Pons check start straight away, while stocks.js loads.
  const span = windowSpan(getEnd(opts.endBlock), secs, pinned);
  // A Pons coin still on its launch curve has no pool yet: its price lives on the curve. A failed check is kept
  // as a failure (never read as "not a Pons coin").
  const curveP = detectCurve(coin).then((v) => ({ v }), (err) => ({ err }));
  const stocks = await loadStocks();
  step();
  const own = classifyAddress(coin, stocks);
  if (own.kind !== 'coin') fail('is-pair-asset', { symbol: own.symbol });
  const poolsP = poolsFor(coin, stocks);
  poolsP.catch(() => {});
  const cr = await curveP;
  step();
  if (cr.v && !cr.v.graduated) return curveLookup({ coin, curve: cr.v, win, secs, span, stocks, pinned, progress, step });

  const found = await poolsP;
  step();
  if (!found.ranked.length) {
    // Nothing readable listed: don't keep that answer (a pool created a minute ago gets listed soon). If the Pons
    // check failed, or the coin just left its curve (its new pool isn't listed yet), the answer may be one try
    // away: never call it a coin we can't read.
    forgetPools(coin, poolsP);
    if (cr.err) fail('rpc-failed', { detail: 'curve check failed' });
    if (cr.v && cr.v.graduated) fail(found.available ? 'rpc-failed' : 'search-failed', { detail: 'new pool not listed yet' });
  }
  if (!found.cands.length) await diagnose(coin, found);
  let ranked = found.ranked;
  if (opts.poolId) ranked = found.cands.filter((c) => c.id === String(opts.poolId).toLowerCase() && c.readable);
  if (!ranked.length) fail('unsupported-pool', { detail: 'no readable pool' });

  const end = await span.end();
  step();
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
  const routeLegs = legs.slice(1);
  step();

  // Start of the window (or a later block when the pool is younger than the window).
  const startTarget = end.time - secs;
  const windowStart = await span.start();
  let startBlock = windowStart, sinceLaunch = false, created = null, onCurve = null, s = null;
  const hint = cand.createdAt ? end.block - Math.round((end.time - cand.createdAt) / K.BLOCK_SECONDS) : null;
  const poolBirth = async () => {
    if (!created) created = await findInitialize(coinLeg, { maxBlock: end.block, hintBlock: hint });
    if (created) coinLeg.createdBlock = created.block;          // the trade-log search stops at the pool's birth
    return created;
  };
  if (cand.createdAt && cand.createdAt > startTarget - 3600) await poolBirth();
  if (!(created && created.block > windowStart)) {
    s = await readSqrtMany(legs.map((pool) => ({ pool, block: windowStart })), { archive: true });
    if (s[0] === 0n) {                                          // the archive says "no pool" at the start
      if (!(await poolBirth())) fail('rpc-failed', { detail: 'pool start not found' });
      if (created.block <= windowStart && coinLeg.uniswap) s[0] = await sqrtFromLogs(coinLeg, windowStart);   // it was wrong
    }
  }
  if (created && created.block > windowStart) {                // the pool is younger than the window
    // A Pons coin traded on its launch curve before this pool: the window starts on the curve, at the window's
    // own start, or at the curve's birth when the coin itself is younger than the window (a real launch).
    // Otherwise the window starts at the pool's first block (since launch).
    let ponsCurve = cr.v;
    if (cr.err) ponsCurve = await detectCurve(coin).catch(() => fail('rpc-failed', { detail: 'curve check failed' }));
    if (ponsCurve && ponsCurve.graduated && ponsCurve.pairToken === pair.address) {
      onCurve = await curveStart(ponsCurve.curve, windowStart, end.block);
      onCurve.curve = ponsCurve.curve;
      startBlock = onCurve.block; sinceLaunch = onCurve.sinceLaunch;
      s = [0n, ...(await readSqrtMany(routeLegs.map((pool) => ({ pool, block: startBlock })), { archive: true }))];
    } else {
      startBlock = created.block; sinceLaunch = true;
      s = await readSqrtMany(legs.map((pool) => ({ pool, block: startBlock })), { archive: true });
    }
  }
  if (!onCurve && s[0] === 0n) fail('rpc-failed', { detail: 'no start price' });
  for (let i = 1; i < legs.length; i++) if (s[i] === 0n) s[i] = await legAt(legs[i], startBlock, end);
  const startTime = await blockTime(startBlock);

  const e = chosen.endSqrt;
  const [decCoin, decPair] = coin === coinLeg.token0 ? [coinLeg.dec0, coinLeg.dec1] : [coinLeg.dec1, coinLeg.dec0];
  const coinInPair = {
    start: onCurve ? curvePrice(onCurve.reserves, decCoin, decPair) : priceOf(coin, coinLeg, s[0]),
    end: priceOf(coin, coinLeg, e[0]),
  };
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
      // 'pons-curve-then-pool': the start price is on the coin's Pons launch curve, the end price in this pool.
      source: onCurve ? 'pons-curve-then-pool' : cand.source,
    },
    window: win,
    windowSeconds: secs,
    start: { block: startBlock, time: startTime },
    end: { block: end.block, time: end.time },
    sinceLaunch,
    coinInPair,
    pairUsd,
    pairVia: route.via,
    tradedInWindow: onCurve ? coinInPair.start !== coinInPair.end : s[0] !== e[0],
  }, onCurve
    ? { type: 'pool', coin, coinLeg, routeLegs, curve: onCurve.curve, poolBlock: created.block, decCoin, decQuote: decPair }
    : { type: 'pool', coin, coinLeg, routeLegs });
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
// The coin is priced on its Pons curve at every block for a curve coin, and before its pool's first block for a
// coin measured on its curve, then its pool.
async function pricesAt(route, blocks) {
  const onCurve = (b) => route.type === 'curve' || (route.curve != null && b < route.poolBlock);
  const items = [];
  for (const block of blocks) {
    if (!onCurve(block)) items.push({ pool: route.coinLeg, block });
    for (const pool of route.routeLegs) items.push({ pool, block });
  }
  const curveBlocks = blocks.filter(onCurve);
  const [sqrts, curves] = await Promise.all([
    items.length ? sqrtsAt(items) : [],
    curveBlocks.length ? curvesAt(route.curve, curveBlocks) : [],
  ]);
  let k = 0, c = 0;
  return blocks.map((block) => {
    const coinInPair = onCurve(block) ? curvePrice(curves[c++], route.decCoin, route.decQuote) : priceOf(route.coin, route.coinLeg, sqrts[k++]);
    const pairS = route.routeLegs.map(() => sqrts[k++]);
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
      }), logOpts(3));
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
