// Reads from Robinhood Chain: blocks and their times, pool prices (sqrtPriceX96) at a given block,
// Swap/Initialize logs as a fallback, token decimals, and the stock-token check.
import { rpc, rpcBatch, rpcAny, RpcError } from './rpc.js';
import * as K from './constants.js';

const tsCache = new Map();      // block -> unix seconds
const decCache = new Map(Object.entries(K.KNOWN_DECIMALS));
const readCache = new Map();    // 'poolId@block' -> BigInt sqrtPriceX96
const initCache = new Map();    // poolId -> { block, sqrt }
const stockCache = new Map();   // token -> true/false (on-chain stock-token check)

export function clearChainCaches() {
  tsCache.clear(); readCache.clear(); initCache.clear(); stockCache.clear();
  decCache.clear();
  for (const [a, d] of Object.entries(K.KNOWN_DECIMALS)) decCache.set(a, d);
}

// ---- pure helpers ---------------------------------------------------------------------------
export const toHex = (n) => '0x' + Math.floor(n).toString(16);
const pad32 = (h) => h.replace(/^0x/, '').padStart(64, '0');

export function sortTokens(a, b) {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

// 32-byte word i of ABI data ('0x…') as an unsigned BigInt (0n when missing).
export function wordAt(data, i) {
  const h = (data || '').replace(/^0x/, '');
  const w = h.slice(64 * i, 64 * i + 64);
  return w.length === 64 ? BigInt('0x' + w) : 0n;
}

const POW10 = {};
function pow10(n) {                    // exact powers of ten (string parse is correctly rounded)
  if (!(n in POW10)) POW10[n] = Number('1e' + n);
  return POW10[n];
}

// Price of token0 in token1, in human units: (sqrtPriceX96 / 2^96)^2 * 10^(dec0 - dec1).
export function sqrtToPrice(sqrt, dec0, dec1) {
  const x = Number(BigInt(sqrt)) / 2 ** 96;
  return x * x * pow10(dec0 - dec1);
}

// Price of `token` in the other token of a pool { token0, token1, dec0, dec1 }.
export function priceOf(token, leg, sqrt) {
  const p01 = sqrtToPrice(sqrt, leg.dec0, leg.dec1);
  return token === leg.token0 ? p01 : 1 / p01;
}

// v4 Swap data: amount0, amount1, sqrtPriceX96, liquidity, tick, fee (topics: Swap, poolId, sender)
// v3 Swap data: amount0, amount1, sqrtPriceX96, liquidity, tick       (emitted by the pool)
export function parseSwapLog(log) {
  return { block: parseInt(log.blockNumber, 16), index: parseInt(log.logIndex, 16), sqrt: wordAt(log.data, 2) };
}

// v4 Initialize data: fee, tickSpacing, hooks, sqrtPriceX96, tick (topics: Initialize, id, currency0, currency1)
// v3 Initialize data: sqrtPriceX96, tick
export function parseInitLog(log, version) {
  const out = { block: parseInt(log.blockNumber, 16), sqrt: wordAt(log.data, version === 'v4' ? 3 : 0) };
  if (version === 'v4' && log.topics && log.topics.length >= 4) {
    out.currency0 = '0x' + log.topics[2].slice(-40);
    out.currency1 = '0x' + log.topics[3].slice(-40);
  }
  return out;
}

export function slot0Call(pool) {
  return pool.version === 'v4'
    ? { to: K.STATE_VIEW, data: K.SEL_GET_SLOT0 + pad32(pool.id) }
    : { to: pool.id, data: K.SEL_SLOT0 };
}

// ---- blocks -------------------------------------------------------------------------------------
export async function headBlock() {
  const b = await rpcAny(['official', 'publicnode', 'drpc'], 'eth_getBlockByNumber', ['latest', false]);
  const number = parseInt(b.number, 16), time = parseInt(b.timestamp, 16);
  tsCache.set(number, time);
  return { number, time };
}

// Timestamps for several blocks (cached), one batch on the official RPC, then the others.
export async function blockTimes(ns) {
  const need = [...new Set(ns.filter((n) => !tsCache.has(n)))];
  if (need.length) {
    const calls = need.map((n) => ({ method: 'eth_getBlockByNumber', params: [toHex(n), false] }));
    let res = null;
    // One quick try per endpoint: on a 429 it is faster to ask the next one than to wait.
    for (const [ep, tries] of [['official', 1], ['publicnode', 2], ['drpc', 3]]) {
      try {
        res = await rpcBatch(ep, calls, { tries });
        if (res.every((r) => r.result)) break;
      } catch (e) { res = null; }
    }
    if (!res || !res.every((r) => r.result)) throw new RpcError('block headers unavailable');
    need.forEach((n, i) => tsCache.set(n, parseInt(res[i].result.timestamp, 16)));
  }
  return ns.map((n) => tsCache.get(n));
}
export const blockTime = async (n) => (await blockTimes([n]))[0];

// The last block whose timestamp is <= T. ref = { number, time } with time > T (usually the end block).
// getTimes(ns) -> timestamps (one round trip per call; injectable for tests). One probe from the average
// block time, then batches of 6 probes around the interpolated spot, then one batch for the last few.
export async function findBlockAtTime(T, ref, getTimes, secondsPerBlock = K.BLOCK_SECONDS) {
  let hi = { n: ref.number, t: ref.time };
  if (hi.t <= T) return hi.n;
  let lo = null, last = null;
  const take = (ns, ts) => ns.forEach((n, i) => {
    if (ts[i] <= T) { if (!lo || n > lo.n) lo = { n, t: ts[i] }; } else if (n < hi.n) hi = { n, t: ts[i] };
  });
  const first = Math.max(0, hi.n - Math.round((hi.t - T) / secondsPerBlock));
  const [t0] = await getTimes([first]);
  take([first], [t0]);
  last = { n: first, t: t0 };
  for (let round = 0; round < 30; round++) {
    if (lo && hi.n - lo.n <= 1) return lo.n;
    let ns = [];
    if (lo && hi.n - lo.n <= 7) {
      for (let n = lo.n + 1; n < hi.n; n++) ns.push(n);
    } else {
      let center, spread;
      if (lo) {
        const perSec = (hi.n - lo.n) / Math.max(1, hi.t - lo.t);
        center = lo.n + Math.round((T + 0.5 - lo.t) * perSec);
        spread = 5 + Math.round(0.03 * Math.min(T - lo.t + 1, hi.t - T) * perSec);
      } else {
        center = last.n - Math.round((last.t - T) / secondsPerBlock);
        spread = 5 + Math.round(0.03 * (last.t - T) / secondsPerBlock);
      }
      const min = lo ? lo.n + 1 : 0, max = hi.n - 1;
      const step = Math.max(1, Math.round(spread / 5));
      for (const k of [-5, -3, -1, 1, 3, 5]) {                 // six probes: one official-RPC batch
        const n = Math.max(min, Math.min(max, center + Math.round(k * step)));
        if (!ns.includes(n)) ns.push(n);
      }
    }
    const ts = await getTimes(ns);
    take(ns, ts);
    last = { n: ns[0], t: ts[0] };
  }
  throw new RpcError('block search did not converge');
}
export const blockAtTime = (T, ref) => findBlockAtTime(T, ref, blockTimes);

// ---- tokens ---------------------------------------------------------------------------------------
// One batch of 'latest' calls: the official RPC first, then dRPC, so a down or rate-limited official
// node doesn't stop every lookup. Throws when an item still has a retryable error on both.
async function batchLatest(calls) {
  let last = null;
  for (const [ep, tries] of [['official', 2], ['drpc', 3]]) {
    try {
      const res = await rpcBatch(ep, calls, { tries });
      const bad = res.find((r) => r.error && r.error.retryable);
      if (!bad) return res;
      last = bad.error;
    } catch (e) { last = e; }
  }
  throw last || new RpcError('no node answered');
}

// decimals() and the stock-token check (uid() then StockFactory.tokenAddress(uid) == token) in one batch.
// Returns Map token -> { decimals: number|null, isStock: boolean }.
export async function tokenFacts(tokens, { checkStock = [] } = {}) {
  const calls = [], plan = [];
  for (const t of tokens) {
    if (!decCache.has(t)) { plan.push(['dec', t]); calls.push(ethCall(t, K.SEL_DECIMALS)); }
  }
  for (const t of checkStock) if (!stockCache.has(t)) { plan.push(['uid', t]); calls.push(ethCall(t, K.SEL_UID)); }
  const facts = new Map(tokens.concat(checkStock).map((t) => [t, { decimals: null, isStock: stockCache.get(t) === true }]));
  if (calls.length) {
    const res = await batchLatest(calls);
    const uids = [];
    plan.forEach(([what, t], i) => {
      const r = res[i];
      if (what === 'dec' && r.error && r.error.retryable) throw r.error;   // the RPC is failing, not the token
      if (what === 'dec' && r.result && r.result.length >= 66) {
        const d = Number(wordAt(r.result, 0));
        if (d <= 77) decCache.set(t, d);
      }
      if (what === 'uid') {
        if (r.result && r.result.length === 66 && BigInt(r.result) !== 0n) uids.push([t, r.result]);
        else if (r.result !== undefined || (r.error && !r.error.retryable)) stockCache.set(t, false);
      }
    });
    if (uids.length) {
      const res2 = await batchLatest(uids.map(([, uid]) => ethCall(K.STOCK_FACTORY, K.SEL_TOKEN_ADDRESS + pad32(uid))));
      uids.forEach(([t], i) => {
        const r = res2[i];
        const yes = !!(r.result && ('0x' + r.result.slice(-40)).toLowerCase() === t);
        facts.get(t).isStock = yes;
        if (r.result !== undefined) stockCache.set(t, yes);
      });
    }
  }
  for (const t of tokens) facts.get(t).decimals = decCache.has(t) ? decCache.get(t) : null;
  return facts;
}
export const knownDecimals = (t) => (decCache.has(t) ? decCache.get(t) : null);

export async function getCode(address) {
  return rpcAny(['official', 'publicnode', 'drpc'], 'eth_getCode', [address, 'latest']);
}

function ethCall(to, data, block = 'latest') {
  return { method: 'eth_call', params: [{ to, data }, typeof block === 'number' ? toHex(block) : block] };
}

// ---- pool prices at a block ----------------------------------------------------------------
// items: [{ pool: { id, version, uniswap }, block }]  ->  [BigInt sqrtPriceX96]  (0n = pool not there yet)
// archive=false: official RPC first (it keeps ~10 min of state), then dRPC, then logs.
// archive=true:  dRPC (full archive) first, then logs.
export async function readSqrtMany(items, { archive = false } = {}) {
  const out = new Array(items.length);
  let todo = [];
  items.forEach((it, i) => {
    const key = it.pool.id + '@' + it.block;
    if (readCache.has(key)) out[i] = readCache.get(key); else todo.push(i);
  });
  const order = archive ? [['drpc', 4]] : [['official', 2], ['drpc', 4]];
  for (const [ep, tries] of order) {
    if (!todo.length) break;
    let res;
    try {
      res = await rpcBatch(ep, todo.map((i) => ethCall(slot0Call(items[i].pool).to, slot0Call(items[i].pool).data, items[i].block)), { tries });
    } catch (e) { continue; }
    const left = [];
    todo.forEach((i, j) => {
      const r = res[j];
      if (r && r.result !== undefined) {
        out[i] = wordAt(r.result, 0);                          // '0x' (no contract yet) -> 0n
        if (out[i] !== 0n) readCache.set(items[i].pool.id + '@' + items[i].block, out[i]);
      } else if (r && r.error && /revert/i.test(r.error.message)) {
        out[i] = 0n;                                            // not a readable pool at that block
      } else left.push(i);
    });
    todo = left;
  }
  for (const i of todo) {                                       // last resort: the chain's own trade records
    const { pool, block } = items[i];
    if (!pool.uniswap) throw new RpcError('price read failed for ' + pool.id);
    out[i] = await sqrtFromLogs(pool, block);
    if (out[i] !== 0n) readCache.set(pool.id + '@' + block, out[i]);
  }
  return out;
}

// Price and in-range liquidity of pools now: [{ sqrt, liquidity } (BigInt; 0n = nothing there) | null (no answer)].
export async function readDepthNow(pools) {
  const calls = [];
  for (const p of pools) {
    const s = slot0Call(p);
    calls.push(ethCall(s.to, s.data));
    calls.push(p.version === 'v4' ? ethCall(K.STATE_VIEW, K.SEL_GET_LIQUIDITY + pad32(p.id)) : ethCall(p.id, K.SEL_LIQUIDITY));
  }
  const res = await batchLatest(calls);
  return pools.map((p, i) => {
    const a = res[2 * i], b = res[2 * i + 1];
    if (!a || !b) return null;
    if (a.result === undefined || b.result === undefined) return { sqrt: 0n, liquidity: 0n };   // reverted: not a pool we read
    return { sqrt: wordAt(a.result, 0), liquidity: wordAt(b.result, 0) };
  });
}

// ---- logs fallback ----------------------------------------------------------------------------
function swapFilter(pool) {
  return pool.version === 'v4'
    ? { address: K.POOL_MANAGER, topics: [K.TOPIC_V4_SWAP, pool.id] }
    : { address: pool.id, topics: [K.TOPIC_V3_SWAP] };
}
function initFilter(pool) {
  return pool.version === 'v4'
    ? { address: K.POOL_MANAGER, topics: [K.TOPIC_V4_INITIALIZE, pool.id] }
    : { address: pool.id, topics: [K.TOPIC_V3_INITIALIZE] };
}

// Last log matching filter in [from, to] on the official RPC; splits the range if it holds too many logs.
async function lastLogIn(filter, from, to, depth = 0) {
  if (from > to) return null;
  try {
    const logs = await rpc('official', 'eth_getLogs', [{ ...filter, fromBlock: toHex(from), toBlock: toHex(to) }]);
    if (!logs.length) return null;
    return logs.reduce((a, b) => (parseInt(b.blockNumber, 16) > parseInt(a.blockNumber, 16) ||
      (b.blockNumber === a.blockNumber && parseInt(b.logIndex, 16) > parseInt(a.logIndex, 16)) ? b : a));
  } catch (e) {
    if (!(e instanceof RpcError && e.overCap) || depth > 12 || to === from) throw e;
    const mid = Math.floor((from + to) / 2);
    return (await lastLogIn(filter, mid + 1, to, depth + 1)) || lastLogIn(filter, from, mid, depth + 1);
  }
}

// The pool's Initialize log (its creation block and first price). hintBlock narrows the search.
export async function findInitialize(pool, { maxBlock, hintBlock = null } = {}) {
  if (initCache.has(pool.id)) return initCache.get(pool.id);
  const f = initFilter(pool);
  let log = null;
  if (hintBlock != null) {
    log = await lastLogIn(f, Math.max(0, hintBlock - 400000), Math.min(maxBlock, hintBlock + 400000));
  }
  for (let to = maxBlock; !log && to >= 0; to -= 10000000) {
    log = await lastLogIn(f, Math.max(0, to - 9999999), to);
  }
  const res = log ? parseInitLog(log, pool.version) : null;
  if (res) initCache.set(pool.id, res);      // "not found" depends on maxBlock, so only hits are cached
  return res;
}

// Price at a block from the last Swap at or before it; with no swap since creation, the Initialize price.
// Returns 0n when the pool was created after `block`.
export async function sqrtFromLogs(pool, block) {
  const f = swapFilter(pool);
  const floor = pool.createdBlock || 0;
  const edges = [0, 2000, 20000, 200000, 2000000];
  for (let k = 1; ; k++) {
    const nearEdge = k < edges.length ? edges[k - 1] : edges[edges.length - 1] + (k - edges.length) * 10000000;
    const farEdge = k < edges.length ? edges[k] : nearEdge + 10000000;
    const to = block - nearEdge, from = Math.max(floor, block - farEdge + 1);
    if (to < floor || to < 0) break;
    const log = await lastLogIn(f, from, to);
    if (log) return parseSwapLog(log).sqrt;
    if (from <= floor) break;
  }
  const init = await findInitialize(pool, { maxBlock: block });
  return init && init.block <= block ? init.sqrt : 0n;
}
