// fetchPriceInput(address, window, opts) -> PriceInput | ErrorResult   (contract: dev/SPEC.md 3.1, method: 5)
// Every price comes from Robinhood Chain at stated blocks. DexScreener/GeckoTerminal only find the pools.
import { SETTINGS } from '../../settings.js';
import * as K from './constants.js';
import { stats, resetStats } from './rpc.js';
import {
  headBlock, blockTime, blockAtTime, readSqrtMany, findInitialize, sqrtFromLogs, tokenFacts, getCode,
  priceOf, sortTokens, clearChainCaches,
} from './chain.js';
import { classifyAddress, findPools, pickUsdPool, otherChainPairCount } from './discover.js';
import { detectCurve, readCurve, findCurveStart, curvePrice, symbolOf, clearCurveCache } from './curve.js';

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
  return {
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
  };
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

  return {
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
  };
}
