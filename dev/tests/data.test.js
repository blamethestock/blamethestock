// Tests for site/src/data/*.js (DATA builder). No network: fetch is replaced by a mock chain + mock APIs.
import { suite, test, eq, near, ok } from './harness.js';
import * as K from '../../site/src/data/constants.js';
import {
  _setTransport, rpcBatch, classifyRpcError, byHealth, markCooling, isCooling, logOpts, LOG_BACKOFF,
} from '../../site/src/data/rpc.js';
import {
  sqrtToPrice, priceOf, sortTokens, wordAt, parseSwapLog, parseInitLog, findBlockAtTime,
} from '../../site/src/data/chain.js';
import { classifyAddress, parseDexScreener, parseGecko, rankCandidates, pickUsdPool } from '../../site/src/data/discover.js';
import { fetchPriceInput, fetchOffHours, clearDataCache } from '../../site/src/data/index.js';
import {
  SEL_CURVE, SEL_TOKEN, SEL_PAIR_TOKEN, SEL_GRADUATED, SEL_GET_RESERVES, SEL_REAL_QUOTE, SEL_SYMBOL, TOPIC_CURVE_INITIALIZED,
} from '../../site/src/data/curve.js';
import { buildResult } from '../../site/src/core/verdict.js';
import { STOCKS } from '../../site/src/data/stocks.js';
import DS from './fixtures/dexscreener.js';
import LOGS from './fixtures/logs.js';

const NVDA = '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec';
const MSTR = '0xec262a75e413fafd0df80480274532c79d42da09';
const COPY_NVDA = '0xa3284897ad7c8fed700b04f573cf64e4f6c10f2c';     // copycat "NVDA" (fails the factory check)
const FAKE_USDG = '0x5db4e79e4d055c273bd0e093fa8e235861e9f877';     // fake 18-decimal "USDG"
const rel = (a, b) => Math.abs(a / b - 1);
const Q96 = 2 ** 96;
// sqrtPriceX96 for a human price of token0 in token1
const sqrtFor = (p, dec0, dec1) => BigInt(Math.round(Math.sqrt(p * 10 ** (dec1 - dec0)) * Q96));

// ---------------------------------------------------------------------------------------------
suite('data: sqrtPrice -> price');

test('2^96 is price 1 with equal decimals; 2*2^96 is 4', () => {
  eq(sqrtToPrice(2n ** 96n, 18, 18), 1);
  eq(sqrtToPrice(2n ** 97n, 18, 18), 4);
});

test('WETH/USDG v3 (token0 WETH 18, token1 USDG 6) matches Python on a real Swap log', () => {
  const sqrt = parseSwapLog(LOGS.v3swap).sqrt;
  eq(sqrt, 3464859747414113754546176n);
  const leg = { token0: K.WETH, token1: K.USDG, dec0: 18, dec1: 6 };
  near(priceOf(K.WETH, leg, sqrt), 1912.5471555721172, 1e-9);           // Python: (sp/2**96)**2 * 10**12
  near(priceOf(K.USDG, leg, sqrt) * 1912.5471555721172, 1, 1e-12);
});

test('USDG as token0 (6) vs an 18-decimal coin, both orientations (ORBIO/USDG v4 getSlot0)', () => {
  const sqrt = 482884957284763881783769837840214748n;
  const ORBIO = '0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3';
  const [t0, t1] = sortTokens(ORBIO, K.USDG);
  eq(t0, K.USDG);
  const leg = { token0: t0, token1: t1, dec0: 6, dec1: 18 };
  ok(rel(priceOf(ORBIO, leg, sqrt), 0.026919799092020677) < 1e-14, 'ORBIO in USDG (Python 0.026919799092020677)');
  ok(rel(priceOf(K.USDG, leg, sqrt), 37.14737976244447) < 1e-14, 'USDG in ORBIO (Python 37.14737976244447)');
});

test('NVDA/USDG pool with USDG as token0: $180 round-trips; a fake 18-decimal USDG is off by 10^12', () => {
  const sqrt = sqrtFor(1 / 180, 6, 18);                                   // price of USDG in NVDA
  const leg = { token0: K.USDG, token1: NVDA, dec0: 6, dec1: 18 };
  ok(rel(priceOf(NVDA, leg, sqrt), 180) < 1e-12, 'NVDA = $180');
  const fake = { token0: K.USDG, token1: NVDA, dec0: 18, dec1: 18 };
  ok(rel(priceOf(NVDA, fake, sqrt), 180e-12) < 1e-12, 'decimals change the answer by 10^12');
});

test('native ETH (0x0) always sorts first; ZOLVA price from the real Initialize log matches Python', () => {
  const ZOLVA = '0x8e04549484d0612be8373a0263b11928a5f7681f';
  eq(sortTokens(ZOLVA, K.ETH_NATIVE), [K.ETH_NATIVE, ZOLVA]);
  const init = parseInitLog(LOGS.v4init, 'v4');
  const leg = { token0: K.ETH_NATIVE, token1: ZOLVA, dec0: 18, dec1: 18 };
  ok(rel(priceOf(ZOLVA, leg, init.sqrt), 2.0580000000000003e-08) < 1e-14, 'ZOLVA in ETH');
});

// ---------------------------------------------------------------------------------------------
suite('data: log parsing');

test('v4 Initialize: block, sqrtPrice (word 3), currencies from topics', () => {
  const r = parseInitLog(LOGS.v4init, 'v4');
  eq(r.block, 111005949);
  eq(r.sqrt, 552276925551777199029135893109927n);
  eq(r.currency0, K.ETH_NATIVE);
  eq(r.currency1, '0x8e04549484d0612be8373a0263b11928a5f7681f');
});

test('v4 Swap: sqrtPrice is word 2 (negative amount1 in word 1 does not matter)', () => {
  const r = parseSwapLog(LOGS.v4swap);
  eq(r.block, 112338016);
  eq(r.sqrt, 8117678890236037944712087221435n);
  ok(wordAt(LOGS.v4swap.data, 1) > 2n ** 255n, 'amount1 is a two\'s-complement negative');
});

test('v3 Initialize: sqrtPrice is word 0', () => {
  const r = parseInitLog(LOGS.v3init, 'v3');
  eq(r.block, 1506281);
  eq(r.sqrt, 3265105038418150813503220n);
});

test('wordAt: missing words are 0', () => {
  eq(wordAt('0x', 0), 0n);
  eq(wordAt('0x' + '0'.repeat(63) + '7', 0), 7n);
  eq(wordAt('0x' + '0'.repeat(63) + '7', 1), 0n);
});

// ---------------------------------------------------------------------------------------------
suite('data: block search');

// A chain whose block time drifts (0.1 s ± 0.0003 s) so the 0.1045 s guess is off by minutes.
const T0 = 1700000000;
const tsOf = (n) => T0 + Math.floor(n * 0.1 + 300 * Math.sin(n / 2e6));
function truth(T) {           // last block with ts <= T, by plain binary search
  let lo = 0, hi = 30000000;
  while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (tsOf(m) <= T) lo = m; else hi = m; }
  return lo;
}

test('finds the exact last block at or before T for 1h, 6h, 24h and 7d (few round trips)', async () => {
  const head = { number: 20000000, time: tsOf(20000000) };
  for (const secs of [3600, 21600, 86400, 604800, 600, 1]) {
    let trips = 0;
    const getTimes = async (ns) => { trips++; ok(ns.length <= 6, 'batch of at most 6'); return ns.map(tsOf); };
    const T = head.time - secs;
    const b = await findBlockAtTime(T, head, getTimes);
    eq(b, truth(T), 'window ' + secs + ' s');
    ok(trips <= 7, 'window ' + secs + ' s took ' + trips + ' round trips');
  }
});

test('T equal to a block timestamp picks the LAST block of that second; T >= head time returns head', async () => {
  const head = { number: 5000000, time: tsOf(5000000) };
  const T = tsOf(4000000);
  eq(await findBlockAtTime(T, head, async (ns) => ns.map(tsOf)), truth(T));
  ok(tsOf(truth(T) + 1) > T, 'next block is later');
  eq(await findBlockAtTime(head.time, head, async () => { throw new Error('no calls needed'); }), 5000000);
});

// ---------------------------------------------------------------------------------------------
suite('data: classification');

test('official list: real NVDA is a stock; copycat NVDA and other lookalikes are plain coins', () => {
  eq(STOCKS.size, 212);
  eq(classifyAddress(NVDA, STOCKS), { kind: 'stock', symbol: 'NVDA' });
  eq(classifyAddress(COPY_NVDA, STOCKS).kind, 'coin');
  eq(classifyAddress('0x1076f47f9632d726cf0ff93ad1616c45cbb8b94d', STOCKS).kind, 'coin');   // exact official name, fake
});

test('USDG is the dollar; a fake 18-decimal USDG and yield wrappers are not', () => {
  eq(classifyAddress(K.USDG, STOCKS), { kind: 'stable', symbol: 'USDG' });
  eq(classifyAddress(FAKE_USDG, STOCKS).kind, 'coin');
  eq(classifyAddress('0x40858070814a57fdf33a613ae84fe0a8b4a874f7', STOCKS).kind, 'coin');    // syrupUSDG (not $1)
  eq(classifyAddress('0x00000000d61733e7a393a10a5b48c311abe8f1e5', STOCKS).kind, 'stable');  // frxUSD
});

test('WETH and native ETH are "eth"', () => {
  eq(classifyAddress(K.WETH, STOCKS), { kind: 'eth', symbol: 'WETH' });
  eq(classifyAddress(K.ETH_NATIVE, STOCKS), { kind: 'eth', symbol: 'ETH' });
});

test('stocks.js has the SPEC example pools (NVDA v3, TSLA v3, SPY v4) and MSTR', () => {
  eq(STOCKS.get(NVDA).pool, '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3');
  eq(STOCKS.get('0x322f0929c4625ed5bad873c95208d54e1c003b2d').pool, '0xf4acdaeeb7022862a763c9b1b885e11191c889e3');
  eq(STOCKS.get('0x117cc2133c37b721f49de2a7a74833232b3b4c0c').pool, '0xfe2a80bb5618fd14984b92ca6d45bf5ba67443ddb1435e28b2e48df2fc1526cd');
  eq(STOCKS.get(MSTR).symbol, 'MSTR');
});

test('a pool paired with the fake USDG is classified "coin", keeps its ticker, and is not priced at $1', () => {
  const coin = '0x9999999999999999999999999999999999999999';
  const c = parseDexScreener(coin, [{ chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: '0x' + 'cd'.repeat(32),
    baseToken: { address: coin, symbol: 'X', name: 'X' }, quoteToken: { address: FAKE_USDG, symbol: 'USDG', name: 'Global Dollar' },
    priceNative: '0.5', priceUsd: '0.0000005', liquidity: { usd: 2000000, base: 10, quote: 1000000 } }], STOCKS)[0];
  eq(c.pair.kind, 'coin');
  eq(c.pair.symbol, 'USDG');
  ok(c.pairSideUsd < 2, 'pair side valued at DexScreener\'s price for the fake, not $1: ' + c.pairSideUsd);
});

// ---------------------------------------------------------------------------------------------
suite('data: pool ranking (saved DexScreener responses)');

const AI = '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18';
const ORBIO = '0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3';
const ZOLVA = '0x8e04549484d0612be8373a0263b11928a5f7681f';
const SHRP = '0xb961886115fb9e4f732e20e89efd6d0406c3527f';
const STRATEGY = '0x168661c52e5922288dfb2b3f323b6cf90eb21e18';

test('AI: main pool is AI/NVDA (stock, the real NVDA)', () => {
  const top = rankCandidates(parseDexScreener(AI, DS.AI, STOCKS))[0];
  eq(top.id, '0xcbdfea90430a30ee4469c9902e120a77e7c7e4711d5643671c1d1957f2f1ce27');
  eq(top.pair, { address: NVDA, symbol: 'NVDA', name: 'NVIDIA • Robinhood Token', kind: 'stock' });
  ok(top.pairSideUsd > 500000 && top.pairSideUsd < 700000, 'NVDA side only, not DexScreener\'s $1.4M total');
});

test('ZOLVA -> ZOLVA/ETH (native), SHRP -> SHRP/ORBIO, STRATEGY -> STRATEGY/MSTR', () => {
  const z = rankCandidates(parseDexScreener(ZOLVA, DS.ZOLVA, STOCKS))[0];
  eq([z.id.slice(0, 10), z.pair.kind, z.pair.symbol, z.version], ['0x417e1f53', 'eth', 'ETH', 'v4']);
  const s = rankCandidates(parseDexScreener(SHRP, DS.SHRP, STOCKS))[0];
  eq([s.id.slice(0, 10), s.pair.kind, s.pair.symbol], ['0xfd46728c', 'coin', 'ORBIO']);
  const t = rankCandidates(parseDexScreener(STRATEGY, DS.STRATEGY, STOCKS))[0];
  eq([t.id.slice(0, 10), t.pair.kind, t.pair.symbol], ['0xa6975f47', 'stock', 'MSTR']);
});

test('ORBIO: by pair-side dollars its NVDA pool ($188k) beats its USDG pool ($132k)', () => {
  const r = rankCandidates(parseDexScreener(ORBIO, DS.ORBIO, STOCKS));
  eq(r[0].id.slice(0, 10), '0xa95b1fbd');
  eq(r[1].id.slice(0, 10), '0xea9f200e');
});

test('pricing ORBIO in dollars (as SHRP\'s pair) uses its deepest USDG pool, 0xea9f…', () => {
  eq(pickUsdPool(parseDexScreener(ORBIO, DS.ORBIO, STOCKS)).id, '0xea9f200e13055b82f175f44f592c4c13dd8c9d9320a66487d3c5cd90d68550ef');
});

test('stock rule: NVDA\'s deepest Uniswap USDG pool, not a deeper non-Uniswap one', () => {
  const pick = pickUsdPool(parseDexScreener(NVDA, DS.NVDA, STOCKS), { usdgOnly: true, uniswapOnly: true });
  eq(pick.id, '0xd4eb21209c4d6093f80b5b84f5c45cc093ea14a3');
});

test('fake liquidity: PAT/NVDA shows $1.41M but has $1.4k of NVDA, so PAT/WETH with $9.5k of ETH wins', () => {
  const PAT = '0x7777777777777777777777777777777777777777';
  const pools = [
    { chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: '0x' + '11'.repeat(32),
      baseToken: { address: PAT, symbol: 'PAT', name: 'Pat' }, quoteToken: { address: NVDA, symbol: 'NVDA', name: 'NVIDIA • Robinhood Token' },
      priceNative: '0.01', priceUsd: '1.65', liquidity: { usd: 1410000, base: 853800, quote: 8.5 } },
    { chainId: 'robinhood', dexId: 'uniswap', labels: ['v3'], pairAddress: '0x' + '22'.repeat(20),
      baseToken: { address: PAT, symbol: 'PAT', name: 'Pat' }, quoteToken: { address: K.WETH, symbol: 'WETH', name: 'Wrapped Ether' },
      priceNative: '0.00085', priceUsd: '1.615', liquidity: { usd: 19000, base: 5882, quote: 5 } },
    { chainId: 'robinhood', dexId: 'uniswap', labels: ['v2'], pairAddress: '0x' + '33'.repeat(20),     // deep but unreadable (v2)
      baseToken: { address: PAT, symbol: 'PAT', name: 'Pat' }, quoteToken: { address: K.USDG, symbol: 'USDG', name: 'Global Dollar' },
      priceNative: '1.6', priceUsd: '1.6', liquidity: { usd: 100000, base: 31250, quote: 50000 } },
  ];
  const c = parseDexScreener(PAT, pools, STOCKS);
  near(c[0].pairSideUsd, 8.5 * 165, 1e-6);
  near(c[1].pairSideUsd, 5 * 1900, 1e-6);
  const r = rankCandidates(c);
  eq(r.map((x) => x.id.slice(0, 4)), ['0x22', '0x11']);
  eq(c[2].readable, false);
});

test('GeckoTerminal backup: pools parsed, Pons bonding curve (pons-v2, 20-byte) is not readable', () => {
  const gt = { data: [
    { attributes: { address: '0xfd46728cb5b138debe72342f622fcefb1754bbe194ba7a1a389a74fe1e9ec235', name: 'ORBIO / SHRP', reserve_in_usd: '3752.66', pool_created_at: '2026-10-31T18:59:41Z', base_token_price_usd: '0.0327', quote_token_price_usd: '0.00000303' },
      relationships: { base_token: { data: { id: 'robinhood_' + ORBIO } }, quote_token: { data: { id: 'robinhood_' + SHRP } }, dex: { data: { id: 'pons-v2-dex' } } } },
    { attributes: { address: '0xed9719d501ad0000000000000000000000000000', name: 'SHRP / ORBIO', reserve_in_usd: '0.0', pool_created_at: '2026-10-31T18:59:19Z' },
      relationships: { base_token: { data: { id: 'robinhood_' + SHRP } }, quote_token: { data: { id: 'robinhood_' + ORBIO } }, dex: { data: { id: 'pons-v2' } } } },
  ] };
  const c = parseGecko(SHRP, gt, STOCKS);
  eq(c.length, 2);
  eq([c[0].version, c[0].uniswap, c[0].pair.symbol, c[0].coin.symbol, c[0].createdAt], ['v4', true, 'ORBIO', 'SHRP', Date.parse('2026-10-31T18:59:41Z') / 1000]);
  near(c[0].pairSideUsd, 3752.66 / 2, 1e-9);
  eq(c[1].readable, false);
  eq(rankCandidates(c).length, 1);
});

// ---------------------------------------------------------------------------------------------
suite('data: RPC error handling');

test('error sorting: dRPC "Unknown state" retries; revert does not; >10k logs splits; no state falls over', () => {
  ok(classifyRpcError({ code: -32000, message: 'Unknown state. First available state is 1' }).retryable);
  ok(!classifyRpcError({ code: 3, message: 'execution reverted' }).retryable);
  const cap = classifyRpcError({ code: -32005, message: 'query returned more than 10000 results' });
  ok(cap.overCap && !cap.retryable);
  const st = classifyRpcError({ code: -32000, message: 'historical state 0xab12 is not available' });
  ok(st.noState && !st.retryable);
  ok(classifyRpcError({ code: -32005, message: 'rate limit exceeded' }).retryable);
});

test('rpcBatch: retries only the items that failed, splits dRPC batches into 3s', async () => {
  let n = 0, sizes = [];
  _setTransport({ sleep: async () => {}, timeouts: false, fetch: async (url, init) => {
    const body = JSON.parse(init.body); const list = Array.isArray(body) ? body : [body];
    sizes.push(list.length); n++;
    const out = list.map((r) => (r.id === 1 && n === 1)
      ? { jsonrpc: '2.0', id: r.id, error: { code: -32000, message: 'Unknown state. First available state is 1' } }
      : { jsonrpc: '2.0', id: r.id, result: '0x' + r.id.toString(16) });
    return { ok: true, status: 200, json: async () => (Array.isArray(body) ? out : out[0]) };
  } });
  const res = await rpcBatch('drpc', [0, 1, 2, 3, 4].map(() => ({ method: 'eth_call', params: [] })));
  eq(res.map((r) => r.result), ['0x0', '0x1', '0x2', '0x3', '0x4']);
  ok(sizes[0] === 3 && sizes[1] === 2, 'batches of 3 then 2: ' + sizes);
  eq(sizes[2], 1, 'only the failed item is retried');
});

test('rpcBatch: a network error / 429 is retried with backoff, then thrown', async () => {
  let n = 0;
  _setTransport({ sleep: async () => {}, timeouts: false, fetch: async () => { n++; throw new TypeError('Failed to fetch'); } });
  let err = null;
  try { await rpcBatch('official', [{ method: 'eth_blockNumber', params: [] }], { tries: 3 }); } catch (e) { err = e; }
  ok(err && err.retryable, 'throws a retryable RpcError');
  eq(n, 3);
  n = 0;
  _setTransport({ fetch: async () => { n++; return { ok: false, status: 429, json: async () => ({}) }; } });
  err = null;
  try { await rpcBatch('official', [{ method: 'eth_blockNumber', params: [] }], { tries: 2 }); } catch (e) { err = e; }
  ok(err && err.code === 429 && n === 2, 'HTTP 429 retried then thrown');
});

// ---------------------------------------------------------------------------------------------
// A mock Robinhood Chain + DexScreener + GeckoTerminal behind fetch().
const MOCK = '0x1111111111111111111111111111111111111111';
const P1 = '0x' + 'ab'.repeat(32);                 // MOCK/WETH v4 pool (the real main pool)
const P2 = '0x' + 'cd'.repeat(32);                 // MOCK/NVDA v4 pool with fake liquidity
const H = 2000000;
const hex = (n) => '0x' + n.toString(16);
const w = (x) => BigInt(x).toString(16).padStart(64, '0');
const rpcErr = (message, code = -32000) => Object.assign(new Error(message), { code });

// Each new mock world retires the previous one: an answer still on its way from an old world (work a failed
// lookup left running) fails to parse instead of landing in the new world's caches.
let worldGen = 0;
function mockWorld(o = {}) {
  const gen = ++worldGen;
  const now = Math.floor(Date.now() / 1000);
  const T0m = now - (o.lag || 2) - Math.floor(H * 0.1046);
  const ts = (n) => T0m + Math.floor(n * 0.1046);
  const endBlock = H - 5;
  const startT = ts(endBlock) - (o.secs || 86400);
  let S = 0; { let lo = 0, hi = H; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts(m) <= startT) lo = m; else hi = m; } S = lo; }
  const created = o.created || 100000;              // P1 Initialize block
  const coinStart = 1e-6, coinEnd = 0.9e-6, ethStart = 2000, ethEnd = 1900;
  // MOCK (0x11…) sorts after WETH (0x0b…): token0 = WETH, price of WETH in MOCK = 1 / coin price
  const sqrtP1 = (b) => (b < created ? 0n : sqrtFor(1 / (b <= S ? coinStart : coinEnd), 18, 18));
  const ethFrom = o.ethPoolCreated || 0;
  const sqrtEth = (b) => (b < ethFrom ? 0n : sqrtFor(b <= S ? ethStart : ethEnd, 18, 6));
  const calls = [];
  const ds = o.ds !== undefined ? o.ds : [
    { chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: P1, pairCreatedAt: ts(created) * 1000,
      baseToken: { address: MOCK, symbol: 'MOCK', name: 'Mock Coin' }, quoteToken: { address: K.WETH, symbol: 'WETH', name: 'Wrapped Ether' },
      priceNative: '0.0000009', priceUsd: '0.00171', liquidity: { usd: 19000, base: 5.5e9, quote: 5 } },
    { chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: P2, pairCreatedAt: ts(created) * 1000,
      baseToken: { address: MOCK, symbol: 'MOCK', name: 'Mock Coin' }, quoteToken: { address: NVDA, symbol: 'NVDA', name: 'NVIDIA • Robinhood Token' },
      priceNative: '0.00001', priceUsd: '0.00165', liquidity: { usd: 1410000, base: 8.5e8, quote: 8.5 } },
  ];
  const logsFor = (f) => {
    const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
    if (to - from > 10000000) throw rpcErr('block range too large');
    const out = [];
    if (f.topics[0] === K.TOPIC_V4_INITIALIZE && f.topics[1] === P1 && created >= from && created <= to) {
      out.push({ blockNumber: hex(created), logIndex: '0x0', topics: [K.TOPIC_V4_INITIALIZE, P1, '0x' + w(K.WETH), '0x' + w(MOCK)],
        data: '0x' + w(0) + w(200) + w(0) + w(sqrtFor(1 / 1.2e-6, 18, 18)) + w(0) });
    }
    if (f.topics[0] === K.TOPIC_V3_INITIALIZE && f.address === K.WETH_USDG_POOL && ethFrom >= from && ethFrom <= to) {
      out.push({ blockNumber: hex(ethFrom), logIndex: '0x0', topics: [K.TOPIC_V3_INITIALIZE], data: '0x' + w(sqrtEth(ethFrom)) + w(0) });
    }
    if (f.topics[0] === K.TOPIC_V4_SWAP && f.topics[1] === P1) {          // one swap 500 blocks before the start
      for (const b of [S - 500, S + 1000]) if (b >= from && b <= to) out.push({ blockNumber: hex(b), logIndex: '0x3', topics: f.topics, data: '0x' + w(1) + w(2) + w(sqrtP1(b)) + w(0) + w(0) + w(0) });
    }
    if (f.topics[0] === K.TOPIC_V3_SWAP && f.address === K.WETH_USDG_POOL) {   // a swap in every block: forces range splits
      if (to - from + 1 > 1000) throw rpcErr('query returned more than 1000 results', -32005);
      for (let b = Math.max(from, ethFrom); b <= to; b++) out.push({ blockNumber: hex(b), logIndex: '0x1', topics: f.topics, data: '0x' + w(1) + w(2) + w(sqrtEth(b)) + w(0) + w(0) });
    }
    return out;
  };
  const rpc = (host, m, p) => {
    if (m === 'eth_getBlockByNumber') {
      const n = p[0] === 'latest' ? H : parseInt(p[0], 16);
      return n > H ? null : { number: hex(n), timestamp: hex(ts(n)) };
    }
    if (m === 'eth_getCode') return (o.code && o.code[p[0]]) || '0x';
    if (m === 'eth_getLogs') return logsFor(p[0]);
    if (m === 'eth_call') {
      const { to, data } = p[0];
      const b = p[1] === 'latest' ? H : parseInt(p[1], 16);
      if (host === 'official' && H - b > 6000) throw rpcErr('historical state 0x1234 is not available');
      if (data === K.SEL_DECIMALS) {
        const d = to === MOCK ? 18 : (o.decimals || {})[to];
        if (d == null) throw rpcErr('execution reverted', 3);
        return '0x' + w(d);
      }
      if (data === K.SEL_UID) {
        if (o.stockUid && o.stockUid[to]) return '0x' + w(o.stockUid[to]);
        throw rpcErr('execution reverted', 3);
      }
      if (to === K.STOCK_FACTORY && data.startsWith(K.SEL_TOKEN_ADDRESS)) return '0x' + w((o.factory || {})[BigInt('0x' + data.slice(10)).toString()] || 0);
      if (to === K.STATE_VIEW && data.startsWith(K.SEL_GET_LIQUIDITY)) return '0x' + w((o.liq || {})['0x' + data.slice(10)] || 0);
      if (data === K.SEL_LIQUIDITY) return '0x' + w((o.liq || {})[to] || 0);
      if (to === K.STATE_VIEW && data.startsWith(K.SEL_GET_SLOT0)) {
        const id = '0x' + data.slice(10);
        const extra = (o.sqrt || {})[id];
        return '0x' + w(id === P1 ? sqrtP1(b) : extra ? extra(b) : 0n) + w(0) + w(0) + w(0);
      }
      if (data === K.SEL_SLOT0) {
        const extra = (o.sqrt || {})[to];
        return to === K.WETH_USDG_POOL ? '0x' + w(sqrtEth(b)) + w(0) : extra ? '0x' + w(extra(b)) + w(0) : '0x';
      }
      throw rpcErr('execution reverted', 3);
    }
    throw rpcErr('method not found', -32601);
  };
  const fetchMock = async (url, init) => {
    const host = url.includes('drpc') ? 'drpc' : url.includes('publicnode') ? 'publicnode' : url.includes('robinhood.com') ? 'official'
      : url.includes('dexscreener') ? 'dexscreener' : url.includes('geckoterminal') ? 'geckoterminal' : 'other';
    calls.push(host + ' ' + (init.body ? (JSON.parse(init.body).method || 'batch') : url.split('/').slice(3).join('/')));
    if ((o.down || []).includes(host)) throw new TypeError('Failed to fetch');
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => { if (gen !== worldGen) throw new Error('old world'); return body; } });
    if (host === 'dexscreener') {
      if (url.includes('/token-pairs/')) return reply(200, url.endsWith(MOCK) ? ds : (o.dsOther || []));
      return reply(200, { pairs: o.otherChains || null });
    }
    if (host === 'geckoterminal') return o.gecko ? reply(200, o.gecko) : reply(404, { errors: [{ status: '404' }] });
    const body = JSON.parse(init.body);
    const one = (r) => { try { return { jsonrpc: '2.0', id: r.id, result: rpc(host, r.method, r.params) }; } catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: e.code, message: e.message } }; } };
    return reply(200, Array.isArray(body) ? body.map(one) : one(body));
  };
  _setTransport({ fetch: fetchMock, sleep: async () => {}, backoff: [0], timeouts: false });
  clearDataCache();
  return { S, ts, endBlock, calls, coinStart, coinEnd, ethStart, ethEnd, created, fetchMock };
}

suite('data: fetchPriceInput (mock chain)');

test('normal lookup: picks the real pool, reads the same blocks for coin and pair, right shape', async () => {
  const m = mockWorld();
  const progress = [];
  const r = await fetchPriceInput(MOCK, '24h', { onProgress: (t) => progress.push(t) });
  ok(r.ok, JSON.stringify(r));
  eq(r.pool.id, P1, 'fake-liquidity NVDA pool is not chosen');
  eq([r.coin.symbol, r.pair.symbol, r.pair.kind, r.pool.label, r.pool.source, r.pair.lookalike], ['MOCK', 'WETH', 'eth', 'MOCK/WETH', 'dexscreener', false]);
  eq(r.window, '24h'); eq(r.windowSeconds, 86400);
  eq(r.end.block, m.endBlock); eq(r.end.time, m.ts(m.endBlock));
  eq(r.start.block, m.S); eq(r.start.time, m.ts(m.S));
  ok(r.start.time <= r.end.time - 86400 && m.ts(m.S + 1) > r.end.time - 86400, 'start = last block at or before end - 24h');
  ok(rel(r.coinInPair.start, m.coinStart) < 1e-12 && rel(r.coinInPair.end, m.coinEnd) < 1e-12, 'coin priced in WETH');
  ok(rel(r.pairUsd.start, m.ethStart) < 1e-12 && rel(r.pairUsd.end, m.ethEnd) < 1e-12, 'WETH priced in USDG');
  eq(r.pairVia, { id: K.WETH_USDG_POOL, label: 'WETH/USDG' });
  eq([r.sinceLaunch, r.tradedInWindow], [false, true]);
  near(r.pool.pairSideUsd, 5 * m.ethEnd, 1e-6);
  eq(progress, ['Finding the pool…', 'Reading prices…']);
  const c = (r.coinInPair.end * r.pairUsd.end) / (r.coinInPair.start * r.pairUsd.start) - 1;
  near(c, -0.145, 1e-9);
});

test('second window for the same coin reuses pools, decimals and the end block', async () => {
  const m = mockWorld();
  await fetchPriceInput(MOCK, '24h');
  const before = m.calls.length;
  const r = await fetchPriceInput(MOCK, '6h');
  ok(r.ok && r.end.block === m.endBlock, 'same end block');
  const extra = m.calls.slice(before);
  ok(!extra.some((x) => x.startsWith('dexscreener')), 'no new pool search: ' + extra.join(', '));
  ok(extra.length <= 6, 'few requests: ' + extra.length);
});

test('pinned end block: reads the past through the archive node', async () => {
  const m = mockWorld();
  const r = await fetchPriceInput(MOCK, '1h', { endBlock: 1500000 });
  ok(r.ok, JSON.stringify(r));
  eq(r.end.block, 1500000);
  ok(m.calls.some((x) => x.startsWith('drpc')), 'used dRPC');
});

test('pool younger than the window: starts at the pool\'s first block (since launch)', async () => {
  const m = mockWorld({ created: H - 100000 });
  const r = await fetchPriceInput(MOCK, '24h');
  ok(r.ok, JSON.stringify(r));
  eq(r.sinceLaunch, true);
  eq(r.start.block, H - 100000);
  eq(r.start.time, m.ts(H - 100000));
});

test('archive node down: start prices come from Swap logs (splitting a busy range), same answer', async () => {
  const m = mockWorld({ down: ['drpc'] });
  const r = await fetchPriceInput(MOCK, '24h');
  ok(r.ok, JSON.stringify(r));
  ok(rel(r.coinInPair.start, m.coinStart) < 1e-12, 'coin start from the last swap before the start');
  ok(rel(r.pairUsd.start, m.ethStart) < 1e-12, 'ETH start from a split log range');
  ok(m.calls.filter((x) => x === 'official eth_getLogs').length >= 3, 'used logs');
});

test('the pair\'s dollar pool is younger than the window -> pair-too-new', async () => {
  mockWorld({ ethPoolCreated: H - 1000 });
  const r = await fetchPriceInput(MOCK, '24h');
  eq(r, { ok: false, code: 'pair-too-new' });
});

test('chain data too old -> stale (not when pinned)', async () => {
  mockWorld({ lag: 600 });
  eq((await fetchPriceInput(MOCK, '24h')).code, 'stale');
  mockWorld({ lag: 600 });
  ok((await fetchPriceInput(MOCK, '24h', { endBlock: H - 5 })).ok, 'pinned lookups skip the stale check');
});

test('official RPC down: decimals, head and prices come from the other nodes, same answer', async () => {
  const m = mockWorld({ down: ['official'] });
  const r = await fetchPriceInput(MOCK, '24h');
  ok(r.ok, JSON.stringify(r));
  eq([r.pool.id, r.start.block, r.end.block], [P1, m.S, m.endBlock]);
  ok(rel(r.coinInPair.start, m.coinStart) < 1e-12 && rel(r.coinInPair.end, m.coinEnd) < 1e-12, 'coin prices');
  ok(rel(r.pairUsd.start, m.ethStart) < 1e-12 && rel(r.pairUsd.end, m.ethEnd) < 1e-12, 'ETH prices');
});

test('a DexScreener pool with no liquidity figure ranks last and its pair side is unknown (null), never $0', async () => {
  const noLiq = (x) => { const y = { ...x }; delete y.liquidity; return y; };
  const ds = [{ chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: P1,
    baseToken: { address: MOCK, symbol: 'MOCK', name: 'Mock Coin' }, quoteToken: { address: K.WETH, symbol: 'WETH', name: 'Wrapped Ether' },
    priceNative: '0.0000009', priceUsd: '0.00171' }];
  const c = parseDexScreener(MOCK, ds, STOCKS)[0];
  eq([c.pairAmount, c.pairSideUsd], [null, 0]);
  mockWorld({ ds: ds.map(noLiq) });
  const r = await fetchPriceInput(MOCK, '24h');
  ok(r.ok, JSON.stringify(r));
  eq(r.pool.pairSideUsd, null);
});

test('GeckoTerminal only: a fake $2.8M pool total loses to the pool whose pair side is real (measured on-chain)', async () => {
  const gecko = (id, quote, qsym, reserve, qprice) => ({
    attributes: { address: id, name: 'MOCK / ' + qsym, reserve_in_usd: String(reserve), pool_created_at: '2026-01-01T00:00:00Z',
      base_token_price_usd: '0.0017', quote_token_price_usd: String(qprice) },
    relationships: { base_token: { data: { id: 'robinhood_' + MOCK } }, quote_token: { data: { id: 'robinhood_' + quote } }, dex: { data: { id: 'uniswap-v4-robinhood' } } } });
  // P1 = MOCK/WETH: WETH is token0, so the WETH side is L / sqrtP. Choose L for 5 WETH at the current price.
  const L = BigInt(Math.round(5e18 * Math.sqrt(1 / 0.9e-6)));
  const m = mockWorld({
    ds: [], code: { [MOCK]: '0x6080' }, decimals: { [NVDA]: 18 },
    gecko: { data: [gecko(P2, NVDA, 'NVDA', 2800000, 180), gecko(P1, K.WETH, 'WETH', 3000, 1900)] },
    sqrt: { [P2]: () => sqrtFor(0.00001, 18, 18) },          // P2 has a price but no liquidity in range
    liq: { [P1]: L },
  });
  const r = await fetchPriceInput(MOCK, '24h');
  ok(r.ok, JSON.stringify(r));
  eq([r.pool.id, r.pool.source, r.pair.kind], [P1, 'geckoterminal', 'eth']);
  ok(Math.abs(r.pool.pairSideUsd - 5 * m.ethEnd) < 1e-6 * 5 * m.ethEnd, '5 WETH x $1900, got ' + r.pool.pairSideUsd);
  ok(rel(r.coinInPair.start, m.coinStart) < 1e-12 && rel(r.pairUsd.end, m.ethEnd) < 1e-12, 'prices from the chain');
});

test('GeckoTerminal only and the chain can\'t measure the pools: estimates rank but are never shown', async () => {
  const m = mockWorld({
    ds: [], code: { [MOCK]: '0x6080' },
    gecko: { data: [{ attributes: { address: P1, name: 'MOCK / WETH', reserve_in_usd: '3000', pool_created_at: '2026-01-01T00:00:00Z', base_token_price_usd: '0.0017', quote_token_price_usd: '1900' },
      relationships: { base_token: { data: { id: 'robinhood_' + MOCK } }, quote_token: { data: { id: 'robinhood_' + K.WETH } }, dex: { data: { id: 'uniswap-v4-robinhood' } } } }] },
  });
  // in-range liquidity reads fail on every node (decimals and prices still work)
  const inner = m.fetchMock;
  _setTransport({ fetch: async (url, init) => {
    if (init.body && init.body.includes(K.SEL_GET_LIQUIDITY.slice(2))) throw new TypeError('Failed to fetch');
    return inner(url, init);
  } });
  const r = await fetchPriceInput(MOCK, '24h');
  ok(r.ok, JSON.stringify(r));
  eq([r.pool.id, r.pool.pairSideUsd], [P1, null]);
});

suite('data: error codes');

test('bad-address for junk, short, long; spaces and capitals are fine', async () => {
  mockWorld();
  for (const s of ['hello', '0x' + 'a'.repeat(39), '0x' + 'a'.repeat(41), '', null, '0xZZ' + 'a'.repeat(38)]) {
    eq((await fetchPriceInput(s, '24h')).code, 'bad-address', String(s));
  }
  ok((await fetchPriceInput('  ' + MOCK.toUpperCase().replace('0X', '0x') + ' ', '24h')).ok, 'trimmed + any case');
});

test('is-pair-asset with the ticker for NVDA, USDG, WETH, ETH, frxUSD — no network needed', async () => {
  const m = mockWorld();
  eq(await fetchPriceInput(NVDA, '24h'), { ok: false, code: 'is-pair-asset', symbol: 'NVDA' });
  eq(await fetchPriceInput(K.USDG, '24h'), { ok: false, code: 'is-pair-asset', symbol: 'USDG' });
  eq(await fetchPriceInput(K.WETH, '24h'), { ok: false, code: 'is-pair-asset', symbol: 'WETH' });
  eq(await fetchPriceInput(K.ETH_NATIVE, '24h'), { ok: false, code: 'is-pair-asset', symbol: 'ETH' });
  eq((await fetchPriceInput('0x00000000d61733e7a393a10a5b48c311abe8f1e5', '7d')).symbol, 'frxUSD');
  eq(m.calls.length, 0);
});

test('a stock token newer than stocks.js is caught on-chain (uid -> factory) as is-pair-asset', async () => {
  mockWorld({ stockUid: { [MOCK]: 77 }, factory: { 77: MOCK } });
  eq(await fetchPriceInput(MOCK, '24h'), { ok: false, code: 'is-pair-asset', symbol: 'MOCK' });
});

test('wallet address (no code, no pools anywhere) -> not-a-token', async () => {
  mockWorld({ ds: [] });
  eq((await fetchPriceInput(MOCK, '24h')).code, 'not-a-token');
});

test('token with pools only on other chains -> wrong-chain', async () => {
  mockWorld({ ds: [], otherChains: [{ chainId: 'ethereum', pairAddress: '0x' + '44'.repeat(20) }] });
  eq((await fetchPriceInput(MOCK, '24h')).code, 'wrong-chain');
});

test('token contract here with no pools -> no-pool; a contract that is not a token -> not-a-token', async () => {
  const other = '0x2222222222222222222222222222222222222222';
  mockWorld({ ds: [], code: { [other]: '0x6080' }, decimals: { [other]: 18 } });
  eq((await fetchPriceInput(other, '24h')).code, 'no-pool');
  mockWorld({ ds: [], code: { [other]: '0x6080' } });
  eq((await fetchPriceInput(other, '24h')).code, 'not-a-token');
});

test('only pools we can\'t read (v2) -> unsupported-pool', async () => {
  mockWorld({ ds: [{ chainId: 'robinhood', dexId: 'uniswap', labels: ['v2'], pairAddress: '0x' + '55'.repeat(20),
    baseToken: { address: MOCK, symbol: 'MOCK', name: 'Mock' }, quoteToken: { address: K.WETH, symbol: 'WETH', name: 'Wrapped Ether' },
    priceNative: '1', priceUsd: '2000', liquidity: { usd: 10000, base: 2.5, quote: 2.5 } }] });
  eq((await fetchPriceInput(MOCK, '24h')).code, 'unsupported-pool');
});

test('everything unreachable -> rpc-failed', async () => {
  mockWorld({ down: ['official', 'drpc', 'publicnode', 'dexscreener', 'geckoterminal'] });
  eq((await fetchPriceInput(MOCK, '24h')).code, 'rpc-failed');
});

test('deepest pool is paired with a coin we can\'t price in dollars: the next pool is used, not an error', async () => {
  const Y = '0x3333333333333333333333333333333333333333', P3 = '0x' + 'ef'.repeat(32);
  const m = mockWorld({ ds: [
    { chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: P3,
      baseToken: { address: MOCK, symbol: 'MOCK', name: 'Mock Coin' }, quoteToken: { address: Y, symbol: 'YYY', name: 'No route' },
      priceNative: '0.0000009', priceUsd: '0.00171', liquidity: { usd: 400000, base: 5.5e9, quote: 100 } },
    { chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: P1,
      baseToken: { address: MOCK, symbol: 'MOCK', name: 'Mock Coin' }, quoteToken: { address: K.WETH, symbol: 'WETH', name: 'Wrapped Ether' },
      priceNative: '0.0000009', priceUsd: '0.00171', liquidity: { usd: 19000, base: 5.5e9, quote: 5 } },
  ], dsOther: [] });
  const r = await fetchPriceInput(MOCK, '24h');
  ok(r.ok, JSON.stringify(r));
  eq([r.pool.id, r.pair.kind], [P1, 'eth']);
  ok(rel(r.coinInPair.end, m.coinEnd) < 1e-12, 'priced in the MOCK/WETH pool');
  // with no other pool, the same coin is an honest unsupported-pool
  mockWorld({ ds: [{ chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: P3,
    baseToken: { address: MOCK, symbol: 'MOCK', name: 'Mock Coin' }, quoteToken: { address: Y, symbol: 'YYY', name: 'No route' },
    priceNative: '0.0000009', priceUsd: '0.00171', liquidity: { usd: 400000, base: 5.5e9, quote: 100 } }], dsOther: [] });
  eq((await fetchPriceInput(MOCK, '24h')).code, 'unsupported-pool');
});

test('copycat "NVDA" as the pair: plain coin, flagged lookalike, priced through its own dollar pool', async () => {
  const pool = '0x' + '66'.repeat(32), usdPool = '0x' + '77'.repeat(20);
  mockWorld({
    ds: [{ chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: pool,
      baseToken: { address: MOCK, symbol: 'MOCK', name: 'Mock' }, quoteToken: { address: COPY_NVDA, symbol: 'NVDA', name: 'NVIDIA Robinhood Token' },
      priceNative: '1', priceUsd: '0.01', liquidity: { usd: 10000, base: 500000, quote: 500000 } }],
    dsOther: [{ chainId: 'robinhood', dexId: 'uniswap', labels: ['v3'], pairAddress: usdPool,
      baseToken: { address: COPY_NVDA, symbol: 'NVDA', name: 'x' }, quoteToken: { address: K.USDG, symbol: 'USDG', name: 'Global Dollar' },
      priceNative: '0.01', priceUsd: '0.01', liquidity: { usd: 2000, base: 100000, quote: 1000 } }],
    decimals: { [COPY_NVDA]: 18 },
    sqrt: { [pool]: () => 2n ** 96n, [usdPool]: () => sqrtFor(100, 6, 18) },   // MOCK = 1 copy-NVDA; copy-NVDA = $0.01
  });
  const r = await fetchPriceInput(MOCK, '24h');
  ok(r.ok, JSON.stringify(r));
  eq([r.pair.kind, r.pair.symbol, r.pair.lookalike, r.pairVia.label], ['coin', 'NVDA', true, 'NVDA/USDG']);
  ok(rel(r.pairUsd.end, 0.01) < 1e-12 && rel(r.coinInPair.end, 1) < 1e-12, 'priced at its own $0.01, not the stock');
  eq(r.tradedInWindow, false);
});

// ---------------------------------------------------------------------------------------------
// Review fixes: failed lookups that must be retryable, pool-search failures, freshness, endpoint health.
suite('data: retryable failures (mock chain)');

const Y = '0x3333333333333333333333333333333333333333';
const P3 = '0x' + 'ef'.repeat(32);
const yPool = { chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: P3,
  baseToken: { address: MOCK, symbol: 'MOCK', name: 'Mock Coin' }, quoteToken: { address: Y, symbol: 'YYY', name: 'Pair coin' },
  priceNative: '0.0000009', priceUsd: '0.00171', liquidity: { usd: 400000, base: 5.5e9, quote: 100 } };
const wethPool = { chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: P1,
  baseToken: { address: MOCK, symbol: 'MOCK', name: 'Mock Coin' }, quoteToken: { address: K.WETH, symbol: 'WETH', name: 'Wrapped Ether' },
  priceNative: '0.0000009', priceUsd: '0.00171', liquidity: { usd: 19000, base: 5.5e9, quote: 5 } };
// Wraps a world's fetch: `rule(url, init)` may return a reply, throw, or return undefined (= the world answers).
function intercept(m, rule) {
  _setTransport({ fetch: async (url, init) => {
    const r = await rule(url, init || {});
    return r === undefined ? m.fetchMock(url, init) : r;
  } });
}
const httpReply = (status, body, headers = {}) => ({ ok: status < 400, status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] || null } });

test('the pair coin\'s pool search gets no answer -> search-failed (retry), never another main pool or "can\'t read"', async () => {
  const run = async (ds) => {
    const m = mockWorld({ ds, dsOther: [] });
    intercept(m, (url) => {
      if (url.includes('dexscreener') && url.endsWith(Y)) return httpReply(503, {});
      if (url.includes('geckoterminal')) return httpReply(429, {});
    });
    return fetchPriceInput(MOCK, '24h');
  };
  eq(await run([yPool]), { ok: false, code: 'search-failed', detail: 'pool search unavailable for YYY' });
  const r = await run([yPool, wethPool]);
  eq([r.ok, r.code], [false, 'search-failed'], 'the smaller MOCK/WETH pool is not used in its place: ' + JSON.stringify(r));
});

test('DexScreener down: GeckoTerminal is asked right after its first failed try; DexScreener is tried twice at most', async () => {
  const L = BigInt(Math.round(5e18 * Math.sqrt(1 / 0.9e-6)));
  const m = mockWorld({
    ds: [], code: { [MOCK]: '0x6080' }, down: ['dexscreener'], liq: { [P1]: L },
    gecko: { data: [{ attributes: { address: P1, name: 'MOCK / WETH', reserve_in_usd: '3000', pool_created_at: '2026-01-01T00:00:00Z', base_token_price_usd: '0.0017', quote_token_price_usd: '1900' },
      relationships: { base_token: { data: { id: 'robinhood_' + MOCK } }, quote_token: { data: { id: 'robinhood_' + K.WETH } }, dex: { data: { id: 'uniswap-v4-robinhood' } } } }] },
  });
  const r = await fetchPriceInput(MOCK, '24h');
  ok(r.ok, JSON.stringify(r));
  eq([r.pool.id, r.pool.source], [P1, 'geckoterminal']);
  const search = m.calls.filter((x) => /^(dexscreener|geckoterminal)/.test(x)).map((x) => x.split(' ')[0]);
  eq(search, ['dexscreener', 'geckoterminal', 'dexscreener']);
});

test('both pool searches unreachable (the chain answers) -> search-failed, not a chain error', async () => {
  mockWorld({ ds: [], code: { [MOCK]: '0x6080' }, down: ['dexscreener', 'geckoterminal'] });
  eq(await fetchPriceInput(MOCK, '24h'), { ok: false, code: 'search-failed', detail: 'pool search unavailable' });
});

test('a lookup the caller has given up on stops early: rpc-failed / cancelled, fewer requests', async () => {
  const m = mockWorld();
  let gone = false;
  const r = await fetchPriceInput(MOCK, '24h', { onProgress: () => { gone = true; }, cancelled: () => gone });
  eq(r, { ok: false, code: 'rpc-failed', detail: 'cancelled' });
  const used = m.calls.length;
  const m2 = mockWorld();
  ok((await fetchPriceInput(MOCK, '24h', { cancelled: () => false })).ok, 'cancelled() returning false changes nothing');
  ok(used < m2.calls.length, 'stopped early: ' + used + ' vs ' + m2.calls.length + ' requests');
});

test('the chain head and the Pons check are asked before the pool search starts', async () => {
  const m = mockWorld();
  ok((await fetchPriceInput(MOCK, '24h')).ok);
  const first = m.calls.findIndex((x) => x.startsWith('dexscreener'));
  ok(first > 1 && m.calls.slice(0, first).every((x) => x.startsWith('official')), m.calls.slice(0, 4).join(', '));
});

test('young pool, archive down: the trade-log search stops at the pool\'s first block', async () => {
  const created = H - 100000;
  const m = mockWorld({ created, down: ['drpc'] });
  const asked = [];
  intercept(m, (url, init) => {
    const b = init.body ? JSON.parse(init.body) : null;
    for (const x of b ? (Array.isArray(b) ? b : [b]) : []) if (x.method === 'eth_getLogs' && x.params[0].topics[0] === K.TOPIC_V4_SWAP) asked.push(parseInt(x.params[0].fromBlock, 16));
  });
  const r = await fetchPriceInput(MOCK, '24h');
  ok(r.ok && r.sinceLaunch && r.start.block === created, JSON.stringify(r));
  ok(asked.length > 0 && asked.every((b) => b >= created), 'swap searches from blocks ' + asked.join(', '));
});

suite('data: fresh enough? (mock chain)');

test('a visitor clock 5 minutes fast: the web server\'s Date header says the chain is fresh -> numbers', async () => {
  const realNow = Date.now;
  const m = mockWorld();
  let heads = 0;
  try {
    Date.now = () => realNow() + 300000;
    _setTransport({ pageUrl: 'https://blamethestock.xyz/' });
    intercept(m, (url, init) => {
      if (url === 'https://blamethestock.xyz/') { heads++; eq(init.method, 'HEAD'); return httpReply(200, null, { date: new Date(realNow()).toUTCString() }); }
    });
    const r = await fetchPriceInput(MOCK, '24h');
    ok(r.ok, JSON.stringify(r));
    eq([r.end.block, heads], [m.endBlock, 1]);
    ok((await fetchPriceInput(MOCK, '6h')).ok && heads === 1, 'the clock difference is remembered: no second HEAD');
    clearDataCache();
    _setTransport({ pageUrl: null });
    eq((await fetchPriceInput(MOCK, '24h')).code, 'stale', 'no trusted clock: the old rule');
  } finally { Date.now = realNow; _setTransport({ pageUrl: null }); }
});

test('really stale (the server\'s clock agrees) -> stale', async () => {
  const m = mockWorld({ lag: 600 });
  _setTransport({ pageUrl: 'https://blamethestock.xyz/' });
  intercept(m, (url) => { if (url === 'https://blamethestock.xyz/') return httpReply(200, null, { date: new Date().toUTCString() }); });
  try { eq((await fetchPriceInput(MOCK, '24h')).code, 'stale'); } finally { _setTransport({ pageUrl: null }); }
});

test('the official node\'s head lags 5 minutes but the others are current: the newer head is used, not "stale"', async () => {
  const m = mockWorld();
  const LAG = 3000;
  intercept(m, (url, init) => {
    if (!url.includes('robinhood.com')) return;
    const b = JSON.parse(init.body);
    if (!Array.isArray(b) && b.method === 'eth_getBlockByNumber' && b.params[0] === 'latest') {
      return httpReply(200, { jsonrpc: '2.0', id: b.id, result: { number: hex(H - LAG), timestamp: hex(m.ts(H - LAG)) } });
    }
  });
  const r = await fetchPriceInput(MOCK, '24h');
  ok(r.ok, JSON.stringify(r));
  eq([r.end.block, r.start.block], [m.endBlock, m.S], 'end from the current head, start from that end');
  ok(rel(r.coinInPair.end, m.coinEnd) < 1e-12 && rel(r.pairUsd.start, m.ethStart) < 1e-12, 'same prices as a healthy lookup');
});

suite('data: endpoint health');

test('a timed-out or unreachable endpoint is asked last for a while; trade logs get 3 tries while it cools', async () => {
  _setTransport({ sleep: async () => {}, timeouts: false, fetch: async () => { throw new TypeError('Failed to fetch'); } });
  eq(byHealth(['official', 'publicnode', 'drpc']), ['official', 'publicnode', 'drpc']);
  eq(logOpts(), { tries: 4, backoff: LOG_BACKOFF });
  try { await rpcBatch('official', [{ method: 'eth_blockNumber', params: [] }], { tries: 1 }); } catch (e) { /* expected */ }
  ok(isCooling('official'), 'cooling after a network error');
  eq(byHealth(['official', 'publicnode', 'drpc']), ['publicnode', 'drpc', 'official']);
  eq(byHealth([['official', 2], ['drpc', 3]]), [['drpc', 3], ['official', 2]]);
  eq(logOpts(), { tries: 3, backoff: LOG_BACKOFF });
  eq(logOpts(2), { tries: 2, backoff: LOG_BACKOFF });
  markCooling('drpc');
  eq(byHealth(['official', 'publicnode', 'drpc']), ['publicnode', 'official', 'drpc']);
  _setTransport({});
  ok(!isCooling('official') && !isCooling('drpc'), 'a new transport starts healthy');
});

test('a request that times out is not retried on the same node (and the node cools)', async () => {
  let n = 0;
  // like a browser: aborting the request rejects fetch() straight away (jsc has no AbortController: a tiny stand-in)
  const hadAbort = Object.prototype.hasOwnProperty.call(globalThis, 'AbortController'), RealAbort = globalThis.AbortController;
  globalThis.AbortController = class {
    constructor() { const fns = []; this.signal = { addEventListener: (t, f) => fns.push(f) }; this.abort = () => fns.forEach((f) => f()); }
  };
  try {
    _setTransport({ sleep: async () => {}, timeouts: true, fetch: (url, init) => { n++; return new Promise((_, rej) => { init.signal.addEventListener('abort', () => rej(new Error('aborted'))); }); } });
    let err = null;
    try { await rpcBatch('publicnode', [{ method: 'eth_blockNumber', params: [] }], { tries: 3, timeoutMs: 5 }); } catch (e) { err = e; }
    ok(err && err.message === 'timeout', 'reported as a timeout, not as the abort: ' + String(err));
    eq(n, 1);
    ok(isCooling('publicnode'));
  } finally {
    if (hadAbort) globalThis.AbortController = RealAbort; else delete globalThis.AbortController;
    _setTransport({ timeouts: false });
  }
});

test('trade-log requests wait 1, 2, 4 s between tries (a 429 burst passes); other calls keep the short backoff', async () => {
  const waits = [];
  _setTransport({ sleep: async (ms) => { waits.push(ms); }, backoff: [400, 800, 1600], timeouts: false,
    fetch: async (url, init) => { const b = JSON.parse(init.body); return httpReply(200, { jsonrpc: '2.0', id: b.id, error: { code: -32005, message: 'rate limit exceeded' } }); } });
  const res = await rpcBatch('official', [{ method: 'eth_getLogs', params: [{}] }], logOpts());
  ok(res[0].error, 'still an error after 4 tries');
  eq(waits, [1000, 2000, 4000]);
  waits.length = 0;
  await rpcBatch('official', [{ method: 'eth_call', params: [] }], { tries: 3 });
  eq(waits, [400, 800]);
  _setTransport({ backoff: [0] });
});

test('official node unreachable: after its first failures every step goes to the other nodes first', async () => {
  const m = mockWorld({ down: ['official'] });
  const r = await fetchPriceInput(MOCK, '24h');
  ok(r.ok, JSON.stringify(r));
  const official = m.calls.filter((x) => x.startsWith('official')).length;
  ok(official <= 5, 'official asked ' + official + ' times (13 before endpoint health)');
});

// ---------------------------------------------------------------------------------------------
// A Pons launch coin: its curve (born at o.born) and, once it graduates (state.grad), a v4 pool against native ETH.
suite('data: Pons curve, then pool (mock chain)');

const PCOIN = '0xb1a3e00000000000000000000000000000000b1a';
const PCURVE = '0x' + 'c0'.repeat(20);
const PPOOL = '0x' + '7e'.repeat(32);
const CURVE_TOKEN = 10n ** 27n;

function ponsWorld(o = {}) {
  const gen = ++worldGen;
  const endTime = o.endTime || Math.floor(Date.now() / 1000) - 2;
  const T0p = endTime - Math.floor(H * 0.1046);
  const ts = (n) => T0p + Math.floor(n * 0.1046);
  const lastAt = (T) => { let lo = 0, hi = H; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts(m) <= T) lo = m; else hi = m; } return lo; };
  const endBlock = H - 5;
  const S = lastAt(ts(endBlock) - (o.secs || 86400));
  const born = o.born != null ? o.born : S - 100000;
  const state = { grad: o.grad != null ? o.grad : null, ds: o.ds || 'auto', failCurveCheck: !!o.failCurveCheck };
  const curvePrice = (b) => 1e-9 * (1 + (b - born) / 1e6);                       // coin in ETH on its curve
  const poolPrice = (b) => 4e-9 * (1 - 0.25 * (b - state.grad) / 1e6);            // coin in ETH in its pool
  const ethUsd = (b) => 1500 + b / 2000;                                          // WETH in USDG
  const graduated = (b) => state.grad != null && b >= state.grad;
  const calls = [];
  const revert = () => rpcErr('execution reverted', 3);
  const abiStr = (t) => '0x' + w(32) + w(t.length) + [...t].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join('').padEnd(64, '0');
  const call = (host, to, data, b) => {
    if (host === 'official' && H - b > 5700) throw rpcErr('historical state 0x1234 is not available');
    if (host === 'publicnode' && H - b > 100) throw rpcErr('missing trie node');
    if (host === 'drpc' && o.drpcUnknown && b < H - 20) throw rpcErr('Unknown state. First available state is 1');
    if (data === K.SEL_DECIMALS) { if (to === PCOIN) return '0x' + w(18); throw revert(); }
    if (to === PCOIN && data === SEL_CURVE) return '0x' + w(PCURVE);
    if (to === PCOIN && data === SEL_SYMBOL) return abiStr('BLAME');
    if (to === PCURVE) {
      if (b < born) return '0x';                                                  // no contract yet
      if (data === SEL_TOKEN) return '0x' + w(PCOIN);
      if (data === SEL_GRADUATED) return '0x' + w(graduated(b) ? 1 : 0);
      if (data === SEL_PAIR_TOKEN) return '0x' + w(o.pairToken || 0);
      if (data === SEL_GET_RESERVES) return graduated(b) ? '0x' + w(5n * 10n ** 18n) + w(0) : '0x' + w(BigInt(Math.round(curvePrice(b) * 1e27))) + w(CURVE_TOKEN);
      if (data === SEL_REAL_QUOTE) return '0x' + w(3n * 10n ** 18n);
    }
    if (to === K.STATE_VIEW && data === K.SEL_GET_SLOT0 + PPOOL.slice(2)) {
      return '0x' + w(graduated(b) ? sqrtFor(1 / poolPrice(b), 18, 18) : 0n) + w(0) + w(0) + w(0);   // ETH (0x0) is token0
    }
    if (to === K.WETH_USDG_POOL && data === K.SEL_SLOT0) {
      if (host === 'drpc' && o.drpcZeroEth && b < H - 6000) return '0x';         // the archive wrongly says "no pool"
      return '0x' + w(sqrtFor(ethUsd(b), 18, 6)) + w(0);
    }
    throw revert();
  };
  const logs = (f) => {
    const from = parseInt(f.fromBlock, 16), to = parseInt(f.toBlock, 16);
    if (to - from > 10000000) throw rpcErr('block range too large');
    const out = [];
    if (f.address === PCURVE && f.topics[0] === TOPIC_CURVE_INITIALIZED && born >= from && born <= to) out.push({ blockNumber: hex(born), logIndex: '0x0', topics: f.topics, data: '0x' });
    if (state.grad != null && f.topics[0] === K.TOPIC_V4_INITIALIZE && f.topics[1] === PPOOL && state.grad >= from && state.grad <= to) {
      out.push({ blockNumber: hex(state.grad), logIndex: '0x0', topics: [K.TOPIC_V4_INITIALIZE, PPOOL, '0x' + w(0), '0x' + w(PCOIN)],
        data: '0x' + w(0) + w(200) + w(0) + w(sqrtFor(1 / poolPrice(state.grad), 18, 18)) + w(0) });
    }
    if (f.address === K.WETH_USDG_POOL && f.topics[0] === K.TOPIC_V3_INITIALIZE && from <= 1000 && to >= 1000) {
      out.push({ blockNumber: hex(1000), logIndex: '0x0', topics: f.topics, data: '0x' + w(sqrtFor(ethUsd(1000), 18, 6)) + w(0) });
    }
    if (f.address === K.WETH_USDG_POOL && f.topics[0] === K.TOPIC_V3_SWAP && to >= 1000) {      // a trade in every block
      out.push({ blockNumber: hex(to), logIndex: '0x1', topics: f.topics, data: '0x' + w(1) + w(2) + w(sqrtFor(ethUsd(to), 18, 6)) + w(0) + w(0) });
    }
    return out;
  };
  const rpc = (host, m, p) => {
    if (m === 'eth_getBlockByNumber') { const n = p[0] === 'latest' ? H : parseInt(p[0], 16); return n > H ? null : { number: hex(n), timestamp: hex(ts(n)) }; }
    if (m === 'eth_getCode') return '0x6080';
    if (m === 'eth_getLogs') { if (host !== 'official') throw rpcErr('range limit'); return logs(p[0]); }
    if (m === 'eth_call') return call(host, p[0].to, p[0].data, p[1] === 'latest' ? H : parseInt(p[1], 16));
    throw rpcErr('method not found', -32601);
  };
  const dsList = () => {
    if (state.ds === 'none') return [];
    if (state.ds === 'curve' || state.grad == null) {
      return [{ chainId: 'robinhood', dexId: 'pons', pairAddress: PCURVE, baseToken: { address: PCOIN, symbol: 'BLAME', name: 'Blame' },
        quoteToken: { address: K.ETH_NATIVE, symbol: 'ETH', name: 'Ether' }, priceNative: '0.000000002', priceUsd: '0.000004' }];
    }
    return [{ chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress: PPOOL, pairCreatedAt: ts(state.grad) * 1000,
      baseToken: { address: PCOIN, symbol: 'BLAME', name: 'Blame' }, quoteToken: { address: K.ETH_NATIVE, symbol: 'ETH', name: 'Ether' },
      priceNative: '0.000000004', priceUsd: '0.000008', liquidity: { usd: 60000, base: 5e12, quote: 15 } }];
  };
  const fetchMock = async (url, init) => {
    const host = url.includes('drpc') ? 'drpc' : url.includes('publicnode') ? 'publicnode' : url.includes('robinhood.com') ? 'official'
      : url.includes('dexscreener') ? 'dexscreener' : url.includes('geckoterminal') ? 'geckoterminal' : 'other';
    const body = init.body ? JSON.parse(init.body) : null;
    const list = body ? (Array.isArray(body) ? body : [body]) : [];
    calls.push({ host, list });
    if ((o.down || []).includes(host)) throw new TypeError('Failed to fetch');
    if (state.failCurveCheck && list.some((r) => r.method === 'eth_call' && r.params[0].data === SEL_CURVE)) throw new TypeError('Failed to fetch');
    const reply = (status, json) => ({ ok: status < 400, status, json: async () => { if (gen !== worldGen) throw new Error('old world'); return json; } });
    if (host === 'dexscreener') return url.includes('/token-pairs/') ? reply(200, url.endsWith(PCOIN) ? dsList() : []) : reply(200, { pairs: null });
    if (host === 'geckoterminal') return reply(404, {});
    const one = (r) => { try { return { jsonrpc: '2.0', id: r.id, result: rpc(host, r.method, r.params) }; } catch (e) { return { jsonrpc: '2.0', id: r.id, error: { code: e.code, message: e.message } }; } };
    return reply(200, Array.isArray(body) ? body.map(one) : one(body));
  };
  _setTransport({ fetch: fetchMock, sleep: async () => {}, backoff: [0], timeouts: false, pageUrl: null });
  clearDataCache();
  const logCalls = (filter) => calls.filter((c) => c.list.some((r) => r.method === 'eth_getLogs' && (!filter || filter(r.params[0])))).length;
  return { S, ts, endBlock, born, state, calls, curvePrice, poolPrice, ethUsd, logCalls, lastAt, fetchMock };
}

test('graduated inside the window, launched before it: starts ON THE CURVE at the window start (not "since launch")', async () => {
  const m = ponsWorld({ grad: H - 50000 });
  const r = await fetchPriceInput(PCOIN, '24h');
  ok(r.ok, JSON.stringify(r));
  eq([r.pool.source, r.pool.id, r.pool.label, r.pair.kind, r.sinceLaunch], ['pons-curve-then-pool', PPOOL, 'BLAME/ETH', 'eth', false]);
  eq([r.start.block, r.start.time, r.end.block], [m.S, m.ts(m.S), m.endBlock]);
  ok(rel(r.coinInPair.start, m.curvePrice(m.S)) < 1e-12, 'start price from the curve at the window start');
  ok(rel(r.coinInPair.end, m.poolPrice(m.endBlock)) < 1e-12, 'end price from the pool');
  ok(rel(r.pairUsd.start, m.ethUsd(m.S)) < 1e-12 && rel(r.pairUsd.end, m.ethUsd(m.endBlock)) < 1e-12, 'ETH read at the same two blocks');
  eq(r.tradedInWindow, true);
  const res = buildResult(r);
  eq(res.windowLabel, '24h');
  near(res.c, (m.poolPrice(m.endBlock) * m.ethUsd(m.endBlock)) / (m.curvePrice(m.S) * m.ethUsd(m.S)) - 1, 1e-9);
});

test('launched (on its curve) inside the window: starts at the curve\'s birth, since launch, aged from the launch', async () => {
  const born = H - 300000;
  const m = ponsWorld({ born, grad: H - 50000 });
  const r = await fetchPriceInput(PCOIN, '24h');
  ok(r.ok, JSON.stringify(r));
  eq([r.pool.source, r.sinceLaunch, r.start.block, r.start.time, r.pool.createdAt], ['pons-curve-then-pool', true, born, m.ts(born), m.ts(born)]);
  ok(rel(r.coinInPair.start, m.curvePrice(born)) < 1e-12, 'the launch price');
  ok(rel(r.pairUsd.start, m.ethUsd(born)) < 1e-12, 'ETH at the launch block');
  // the 1h window starts after graduation: the pool alone, as before
  const r1 = await fetchPriceInput(PCOIN, '1h');
  ok(r1.ok && r1.pool.source === 'dexscreener' && !r1.sinceLaunch, JSON.stringify(r1));
});

test('graduated before the window: the pool alone, as before (no curve reads)', async () => {
  const m = ponsWorld({ grad: 1000000 });          // S is about 1.17M
  const r = await fetchPriceInput(PCOIN, '24h');
  ok(r.ok, JSON.stringify(r));
  eq([r.pool.source, r.sinceLaunch, r.start.block], ['dexscreener', false, m.S]);
  ok(!m.calls.some((c) => c.list.some((x) => x.method === 'eth_call' && x.params[0].to === PCURVE && x.params[0].data === SEL_GET_RESERVES)), 'curve not read');
});

test('a curve whose pair is not the pool\'s pair is not stitched in', async () => {
  const m = ponsWorld({ grad: H - 50000, pairToken: K.USDG });
  const r = await fetchPriceInput(PCOIN, '24h');
  ok(r.ok, JSON.stringify(r));
  eq([r.pool.source, r.sinceLaunch, r.start.block], ['dexscreener', true, H - 50000]);
});

test('curve-then-pool off-hours: the coin is read on the curve before the pool\'s first block, in the pool after', async () => {
  // End pinned at Friday 2026-11-13 00:37 New York: the 24h window holds Thursday's 9:30 open and 4 PM close.
  const endTime = Date.parse('2026-11-13T05:37:28Z') / 1000;
  const m0 = ponsWorld({ endTime });
  const noon = m0.lastAt(Date.parse('2026-11-12T17:00:00Z') / 1000);   // graduates at Thursday noon NY
  const m = ponsWorld({ endTime, grad: noon });
  const pi = await fetchPriceInput(PCOIN, '24h', { endBlock: m.endBlock });
  ok(pi.ok && pi.pool.source === 'pons-curve-then-pool', JSON.stringify(pi));
  const off = await fetchOffHours(pi);
  ok(off.ok, JSON.stringify(off));
  eq(off.pieces.length, 3);
  const [a, b] = [off.pieces[1].fromBlock, off.pieces[2].fromBlock];   // the 9:30 open (curve) and the 4 PM close (pool)
  ok(a < noon && b >= noon, 'open before graduation, close after: ' + [a, noon, b]);
  const usd = (blk) => (blk < noon ? m.curvePrice(blk) : m.poolPrice(blk)) * m.ethUsd(blk);
  near(off.pieces[0].c, usd(a) / usd(pi.start.block) - 1, 1e-9, 'piece 1 (curve to curve)');
  near(off.pieces[1].c, usd(b) / usd(a) - 1, 1e-9, 'piece 2 (curve to pool)');
  near(off.pieces[2].c, usd(pi.end.block) / usd(b) - 1, 1e-9, 'piece 3 (pool to pool)');
});

test('still on its curve, under 10 minutes old, archive node in an "unknown state" spell: works from the official node', async () => {
  const born = H - 3000;
  const m = ponsWorld({ born, secs: 3600, drpcUnknown: true });
  const r = await fetchPriceInput(PCOIN, '1h');
  ok(r.ok, JSON.stringify(r));
  eq([r.pool.source, r.sinceLaunch, r.start.block], ['pons-curve', true, born]);
  ok(rel(r.coinInPair.start, m.curvePrice(born)) < 1e-12 && rel(r.pairUsd.start, m.ethUsd(born)) < 1e-12, 'launch prices');
});

test('launch day: the official node is cooling after a 429 and the curve\'s birth log meets one more: retried, still works', async () => {
  const born = H - 3000;
  const m = ponsWorld({ born, secs: 3600 });
  let fail = 1;
  intercept(m, (url, init) => {             // a 429 looks like a network error in a browser
    if (url.includes('robinhood.com') && /eth_getLogs/.test(init.body || '') && fail-- > 0) throw new TypeError('Failed to fetch');
  });
  markCooling('official');                  // an earlier 429 in this visit
  const r = await fetchPriceInput(PCOIN, '1h');
  ok(r.ok, JSON.stringify(r));
  eq([r.pool.source, r.sinceLaunch, r.start.block], ['pons-curve', true, born]);
  ok(rel(r.coinInPair.start, m.curvePrice(born)) < 1e-12, 'the launch price');
});

test('the curve\'s birth is looked up once: the next window needs no trade-log request for it', async () => {
  const m = ponsWorld({ born: H - 300000 });
  ok((await fetchPriceInput(PCOIN, '24h')).ok);
  const before = m.logCalls((f) => f.address === PCURVE);
  eq(before, 1);
  const r = await fetchPriceInput(PCOIN, '6h');
  ok(r.ok && r.sinceLaunch === false, JSON.stringify(r));
  const r2 = await fetchPriceInput(PCOIN, '7d');
  ok(r2.ok === false || r2.code !== 'pair-too-new', 'any 7d answer');
  eq(m.logCalls((f) => f.address === PCURVE), before, 'no new curve log requests');
});

test('curve path: the archive wrongly says the ETH dollar pool had no price at the start -> recovered from the trade log', async () => {
  const m = ponsWorld({ drpcZeroEth: true });
  const r = await fetchPriceInput(PCOIN, '24h');
  ok(r.ok, JSON.stringify(r));
  eq(r.pool.source, 'pons-curve');
  ok(rel(r.pairUsd.start, m.ethUsd(m.S)) < 1e-12, 'ETH at the start block, from its last trade');
});

test('the Pons check fails -> rpc-failed (Try again), never "can\'t read" or "no pool"', async () => {
  ponsWorld({ failCurveCheck: true, ds: 'curve' });
  eq(await fetchPriceInput(PCOIN, '24h'), { ok: false, code: 'rpc-failed', detail: 'curve check failed' });
  ponsWorld({ failCurveCheck: true, ds: 'none' });
  eq(await fetchPriceInput(PCOIN, '24h'), { ok: false, code: 'rpc-failed', detail: 'curve check failed' });
  const m = ponsWorld({ failCurveCheck: true, grad: 1000000 });        // a readable pool older than the window: fine
  const r = await fetchPriceInput(PCOIN, '24h');
  ok(r.ok && r.pool.source === 'dexscreener' && r.start.block === m.S, JSON.stringify(r));
  // the pool is younger than the window: without the Pons check the start can't be trusted
  ponsWorld({ failCurveCheck: true, grad: H - 50000 });
  eq(await fetchPriceInput(PCOIN, '24h'), { ok: false, code: 'rpc-failed', detail: 'curve check failed' });
});

test('just graduated, new pool not listed yet -> rpc-failed; the empty search is not kept, so the next try finds the pool', async () => {
  const m = ponsWorld({ grad: H - 500, ds: 'curve' });
  eq(await fetchPriceInput(PCOIN, '24h'), { ok: false, code: 'rpc-failed', detail: 'new pool not listed yet' });
  m.state.ds = 'auto';
  const r = await fetchPriceInput(PCOIN, '24h');
  ok(r.ok && r.pool.source === 'pons-curve-then-pool', JSON.stringify(r));
});

test('graduates while its "still on the curve" answer is cached: rpc-failed once, then the pool path', async () => {
  const m = ponsWorld({});
  const r0 = await fetchPriceInput(PCOIN, '24h');
  ok(r0.ok && r0.pool.source === 'pons-curve', JSON.stringify(r0));
  m.state.grad = H - 50;                                    // it graduates; its curve is emptied (token reserve 0)
  eq(await fetchPriceInput(PCOIN, '6h'), { ok: false, code: 'rpc-failed', detail: 'curve just graduated' });
  const r = await fetchPriceInput(PCOIN, '6h');
  ok(r.ok && r.pool.source === 'pons-curve-then-pool' && r.pool.id === PPOOL, JSON.stringify(r));
});
