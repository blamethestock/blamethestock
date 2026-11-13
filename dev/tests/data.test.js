// Tests for site/src/data/*.js (DATA builder). No network: fetch is replaced by a mock chain + mock APIs.
import { suite, test, eq, near, ok } from './harness.js';
import * as K from '../../site/src/data/constants.js';
import { _setTransport, rpcBatch, classifyRpcError } from '../../site/src/data/rpc.js';
import {
  sqrtToPrice, priceOf, sortTokens, wordAt, parseSwapLog, parseInitLog, findBlockAtTime,
} from '../../site/src/data/chain.js';
import { classifyAddress, parseDexScreener, parseGecko, rankCandidates, pickUsdPool } from '../../site/src/data/discover.js';
import { fetchPriceInput, clearDataCache } from '../../site/src/data/index.js';
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

function mockWorld(o = {}) {
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
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
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
