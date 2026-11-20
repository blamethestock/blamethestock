// Per-coin facts for the copy check, read from Robinhood Chain (RPC) and Blockscout. Read-only.
//
//   gatherFacts(row, ctx)          -> facts for one launch-index row (see normalizeRow for the row shape)
//   launchRowFromChain(token, ctx) -> a launch row built from the chain (for a coin the index doesn't have yet)
//   tokenMeta(token)               -> { name, symbol } (empty strings when the address isn't a token)
//   makeContext({ fetch, sleep, settings, factories })  -> ctx (reads the head block once)
//
// Network: RPC calls go through site/src/data/rpc.js (retries, backoff, endpoint cooling; tests swap the transport
// with _setTransport). Blockscout calls use ctx.fetch with 'Accept: application/json' and a generic User-Agent;
// on a Cloudflare challenge or a 429 we back off once and then call the explorer "unavailable" for the rest of
// the request. We never try to get around a challenge.
//
// Every fact that can't be read is left null and named in facts.missing; the rules never flag on a missing fact.
import { rpc, RpcError, logOpts } from '../data/rpc.js';
import { headBlock, blockTimes, batchLatest, ethCall, wordAt, toHex, readDepthNow, priceOf, sortTokens, slot0Call, tokenFacts, getCode } from '../data/chain.js';
import { detectCurve, findCurveStart, SEL_REAL_QUOTE } from '../data/curve.js';
import { inRangeAmount } from '../data/discover.js';
import * as K from '../data/constants.js';
import { STOCKS } from '../data/stocks.js';
import { trustSettings, EXPLORER, txUrl, addressUrl, tokenUrl } from './rules.js';

// ---- fixed facts (checked read-only on chain 4663, 2026-11-18; topics recomputed with dev/tools/keccak.py) ----
export const TOPIC = {
  TRANSFER: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',        // Transfer(address,address,uint256)
  TOKEN_LAUNCHED: '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607',  // TokenLaunched(address,address,address,address,uint256,uint256)
  LAUNCHED: '0xdcacba5e347ae7abd91cb519eb877af8fa7774e347b85dd3ddcd24a2ba8cdf37',        // Launched(address,address,address,address,uint256,uint256) (LaunchAndBuy)
  CURVE_BUY: '0xec36bf571f136799e8dc0b0b8bea4b04d8bd3d43de838aab0d5fc21d4cbfc455',       // CurveBuy(address buyer, address recipient, quoteIn, tokensOut, fee, tax)
  CURVE_SELL: '0x8113d738abdcb6b38357e9d53a54a7157861a09031b453651f0fe7fe151f59df',      // CurveSell(address, address, tokensIn, quoteOut, fee, tax)
  CURVE_COMPLETED: '0xf8d37a90738ae063b8b8058b66f5880cf3cf7ab0c5d4fa78219696591dfbfb67', // CurveCompleted(address,uint256,uint256) = graduation
  GRADUATED: '0x0a44ef75df69c534f43cd6c1aa3ef8983065fe5fe79ef9e79f6494e6f258c259',       // factory: graduation (topic1 token; [tokenId, tokens, quote])
  CLAIMED: '0xd8138f8a3f377c5259ca548e70e4c2de94f129f5a11036a15b69513cba2b426a',         // FeeEscrow Claimed(address indexed, uint256)
  L2_TO_L1: '0x3e7aafa77dbf186b7fd488006beff893744caa3c4f6f299e8a709fa2087374fc',        // ArbSys L2ToL1Tx(caller, dest, hash, position, ..., callvalue, data)
  FUNDS_DEPOSITED: '0x32ed1a409ef04c7b0227189c3a103dc5ac10e775a15b785dcc510201f7c25ad3', // Across FundsDeposited (topic1 dest chain, topic3 depositor)
  METABRIDGE_BRIDGE: '0x831bac9533a2034226daa21109dbd4f887674f0fe4877e1a8b35b3ffe1bdce76', // MetaBridge route event: data [user, adapter, destChainId, ...]
                                                                                          // (emitted by its router 0x15598285, not by 0x19ba492a itself)
};

export const ADDR = {
  ZERO: '0x0000000000000000000000000000000000000000',
  DEAD: '0x000000000000000000000000000000000000dead',
  FACTORY_V2: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e',
  FEE_ESCROW: '0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e',        // PonsV2FeeEscrow (V2 factory only)
  ROUTER: '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc',            // Pons router: hides the trader in CurveBuy/CurveSell
  LAUNCH_AND_BUY: '0xe33e9e479df8802cb0866d5d05258bec4cf62948',
  MULTICALL3: '0xca11bde05977b3631167028862be2a173976ca11',
  ARBSYS: '0x0000000000000000000000000000000000000064',
  ACROSS_SPOKE: '0xd29c85f15df544ba632c9e25829fd29d767d7978',
  METABRIDGE: '0x19ba492a2fa0734f4b44c139dff4fbaca48907d6',
  RELAY_DEPOSITORY: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
  LAUNCH_LOCKER_PREFIX: '0x267444d0',
  HOOK: '0xe5e702641ea86f4ae6cc3cdaed2b886f976be044',
};
const SEL_NAME = '0x06fdde03';
const SEL_BALANCE_OF = '0x70a08231';
export const EXPLORER_UA = 'Mozilla/5.0 (compatible; blamethestock)';
const BRIDGE_WINDOW_SECONDS = 7 * 86400;      // bridges are looked for in the first 7 days after launch
const ARBSYS_FROM_LOOKUPS = 24;               // at most this many ArbSys withdrawals checked for tx.from
const SELL_RECEIPT_LOOKUPS = 6;               // dev transfers to unknown contracts checked for a sell
const DEV_TX_PAGES = 2;                       // pages (50 each) of the dev's own transactions from the explorer
const LOG_SPAN_ONE = 9999999, LOG_SPAN_OR = 99999;

// ---- small helpers ----------------------------------------------------------------------------------------
export const pad = (a) => '0x' + '0'.repeat(24) + String(a).toLowerCase().replace(/^0x/, '');
export const addrOf = (word) => ('0x' + String(word || '').slice(-40)).toLowerCase();
const num = (h) => parseInt(h, 16);
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const units = (big, dec) => Number(BigInt(big)) / 10 ** dec;
const pctOf = (part, whole) => (whole > 0n ? Number((BigInt(part) * 10n ** 12n) / BigInt(whole)) / 1e10 : null);   // % of supply
export const iso = (unix) => (unix == null ? null : new Date(unix * 1000).toISOString().replace('.000Z', 'Z'));
const secsOf = (s) => (s == null ? null : Date.parse(s) / 1000);
const isEthPair = (p) => p === ADDR.ZERO || p === K.WETH;

// ABI string (or bytes32) -> text. Hidden characters are kept (the copy check needs them); control chars dropped.
export function decodeText(hex, max = 256) {
  try {
    const h = String(hex || '').replace(/^0x/, '');
    let bytes;
    if (h.length === 64) bytes = h.replace(/(00)+$/, '');                  // bytes32-style name
    else {
      if (h.length < 128) return '';
      const len = Number(wordAt('0x' + h, 1));
      if (!(len > 0 && len <= max)) return '';
      bytes = h.slice(128, 128 + 2 * len);
    }
    let s = '';
    for (let i = 0; i < bytes.length; i += 2) s += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
    s = decodeURIComponent(escape(s));
    return s.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  } catch (e) { return ''; }
}

// A launch-index row (D1 snake_case, see api/schema.sql, or camelCase) -> one shape, addresses lowercase.
export function normalizeRow(row) {
  const g = (...ks) => { for (const k of ks) if (row[k] != null) return row[k]; return null; };
  const low = (v) => (v == null ? null : String(v).toLowerCase());
  return {
    token: low(g('token', 'address')),
    factory: low(g('factory')),
    curve: low(g('curve')),
    creator: low(g('creator')),
    txFrom: low(g('tx_from', 'txFrom')),
    dev: low(g('dev')),
    pairToken: low(g('pair_token', 'pairToken')) || ADDR.ZERO,
    block: Number(g('block')),
    time: g('time') == null ? null : Number(g('time')),
    tx: low(g('tx')),
    name: g('name') == null ? '' : String(g('name')),
    symbol: g('symbol') == null ? '' : String(g('symbol')),
    symSkel: g('sym_skel', 'symSkel'),
    nameSkel: g('name_skel', 'nameSkel'),
  };
}

// ---- explorer (Blockscout) ----------------------------------------------------------------------------------
// A web page can't set User-Agent (some browsers drop it, others make it a CORS preflight): the generic one is
// sent only outside a page (the Worker, the local MCP package, tests).
const IN_PAGE = typeof window !== 'undefined' && typeof document !== 'undefined';
export function makeExplorer({ fetch: fetchFn, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), base = EXPLORER, userAgent = IN_PAGE ? null : EXPLORER_UA } = {}) {
  const headers = userAgent ? { accept: 'application/json', 'user-agent': userAgent } : { accept: 'application/json' };
  let down = false;
  const cache = new Map();
  async function get(path) {
    if (down) return { ok: false, reason: 'unavailable' };
    if (cache.has(path)) return cache.get(path);
    for (let attempt = 0; attempt < 2; attempt++) {
      let res;
      try {
        res = await fetchFn(base + path, { method: 'GET', headers });
      } catch (e) {
        if (attempt === 0) { await sleep(1000); continue; }
        break;
      }
      const hdr = (k) => (res.headers && typeof res.headers.get === 'function' ? res.headers.get(k) || '' : '');
      if (res.status === 404) { const v = { ok: false, reason: 'not-found' }; cache.set(path, v); return v; }
      if (res.status === 403 || /challenge/i.test(hdr('cf-mitigated'))) break;          // never get around a challenge
      if (res.status === 429 || res.status >= 500) {
        if (attempt === 0) { await sleep(2000); continue; }
        break;
      }
      if (!res.ok || /text\/html/i.test(hdr('content-type'))) break;
      try {
        const v = { ok: true, json: await res.json() };
        cache.set(path, v);
        return v;
      } catch (e) { break; }
    }
    down = true;
    return { ok: false, reason: 'unavailable' };
  }
  return { get, isDown: () => down };
}

// ---- context ------------------------------------------------------------------------------------------------
// One per copy check: the head block (every range ends there), settings, the explorer client and shared memos.
export async function makeContext({ fetch: fetchFn, sleep, settings, factories = null, head = null } = {}) {
  const f = fetchFn || ((...a) => fetch(...a));
  return {
    head: head || await headBlock(),
    trust: trustSettings(settings),
    explorer: makeExplorer({ fetch: f, sleep }),
    factories: factories ? factories.map((a) => a.toLowerCase()) : null,
    memo: new Map(),
    problems: new Set(),
  };
}

function memo(ctx, key, fn) {
  if (!ctx.memo.has(key)) ctx.memo.set(key, fn().catch((e) => { ctx.memo.delete(key); throw e; }));
  return ctx.memo.get(key);
}

// ---- RPC helpers --------------------------------------------------------------------------------------------
// All logs for `filter` in [from, to] (official node), oldest first. Spans are cut to the node's limit and split
// in halves when one answer would hold more than 10,000 logs. More than maxCalls calls -> RpcError (overCap).
export async function getLogsAll(filter, from, to, { maxCalls = 6 } = {}) {
  const orList = (filter.topics || []).some((t) => Array.isArray(t)) || Array.isArray(filter.address);
  const span = orList ? LOG_SPAN_OR : LOG_SPAN_ONE;
  const todo = [];
  for (let a = Math.max(0, from); a <= to; a += span + 1) todo.push([a, Math.min(to, a + span)]);
  const out = [];
  let calls = 0;
  while (todo.length) {
    const [a, b] = todo.shift();
    if (++calls > maxCalls) throw new RpcError('too many logs', { overCap: true });
    try {
      const logs = await rpc('official', 'eth_getLogs', [{ ...filter, fromBlock: toHex(a), toBlock: toHex(b) }], logOpts());
      out.push(...(logs || []));
    } catch (e) {
      if (!(e instanceof RpcError && e.overCap) || a === b) throw e;
      const mid = Math.floor((a + b) / 2);
      todo.unshift([a, mid], [mid + 1, b]);
    }
  }
  return out.sort((x, y) => num(x.blockNumber) - num(y.blockNumber) || num(x.logIndex) - num(y.logIndex));
}

// Transactions and receipts by hash, in one batch (official node, then dRPC). Missing ones come back null.
async function byHash(method, hashes) {
  if (!hashes.length) return [];
  const res = await batchLatest(hashes.map((h) => ({ method, params: [h] })));
  return res.map((r) => (r && r.result) || null);
}
const txsByHash = (h) => byHash('eth_getTransactionByHash', h);
const receiptsByHash = (h) => byHash('eth_getTransactionReceipt', h);

async function timesOf(blocks) {
  const uniq = [...new Set(blocks)];
  const ts = await blockTimes(uniq);
  const m = new Map(uniq.map((b, i) => [b, ts[i]]));
  return (b) => m.get(b);
}

export async function tokenMeta(token) {
  const [n, s] = await batchLatest([ethCall(token, SEL_NAME), ethCall(token, K.SEL_SYMBOL)]);
  return { name: decodeText(n && n.result), symbol: decodeText(s && s.result, 64) };
}

// ---- launch row from the chain (coin not in the index yet) ----------------------------------------------------
// token.curve() + curve.token() check (detectCurve), the curve's birth block (its Initialized log), then the
// TokenLaunched log in that one block. null when the address isn't a Pons launch from a known factory.
export async function launchRowFromChain(token, ctx) {
  const c = await detectCurve(token);
  if (!c) return null;
  const born = await findCurveStart(c.curve, ctx.head.number);
  if (born == null) return null;
  const logs = await rpc('official', 'eth_getLogs', [{ topics: [TOPIC.TOKEN_LAUNCHED, pad(token)], fromBlock: toHex(born), toBlock: toHex(born) }], logOpts());
  const log = (logs || []).find((l) => !ctx.factories || ctx.factories.includes(String(l.address).toLowerCase()));
  if (!log) return null;
  const [meta, times] = await Promise.all([tokenMeta(token), blockTimes([born])]);
  return {
    token, factory: log.address.toLowerCase(), curve: addrOf(log.topics[2]), creator: addrOf(log.topics[3]), tx_from: null,
    pair_token: addrOf(wordAt(log.data, 0).toString(16).padStart(40, '0')), block: born, log_index: num(log.logIndex),
    time: times[0], tx: log.transactionHash.toLowerCase(), name: meta.name, symbol: meta.symbol,
  };
}

// ---- the pair token: decimals, symbol, dollar price ----------------------------------------------------------
export async function pairInfo(pair, ctx) {
  return memo(ctx, 'pair:' + pair, async () => {
    let decimals = 18, symbol = '?';
    if (pair === ADDR.ZERO) symbol = 'ETH';
    else if (pair === K.WETH) symbol = 'WETH';
    else if (K.STABLES[pair]) { symbol = K.STABLES[pair]; decimals = pair === K.USDG ? 6 : null; }
    else if (STOCKS.has(pair)) symbol = STOCKS.get(pair).symbol;
    if (pair !== ADDR.ZERO && pair !== K.WETH && pair !== K.USDG) {
      const f = await tokenFacts([pair]);
      decimals = f.get(pair).decimals;
      if (symbol === '?') symbol = (await tokenMeta(pair)).symbol || '?';
    }
    let usd = null;
    try { usd = await pairUsd(pair, decimals); } catch (e) { usd = null; }
    return { decimals, symbol, usd };
  });
}

async function pairUsd(pair, decimals) {
  if (K.STABLES[pair]) return 1;
  if (isEthPair(pair)) {
    const [r] = await batchLatest([ethCall(K.WETH_USDG_POOL, K.SEL_SLOT0)]);
    const sqrt = wordAt(r && r.result, 0);
    if (sqrt === 0n) return null;
    return priceOf(K.WETH, { token0: K.WETH, token1: K.USDG, dec0: 18, dec1: 6 }, sqrt);
  }
  const s = STOCKS.get(pair);
  if (s && s.pool && decimals != null) {
    const pool = { id: s.pool, version: s.pool.length === 66 ? 'v4' : 'v3' };
    const call = slot0Call(pool);
    const [r] = await batchLatest([ethCall(call.to, call.data)]);
    const sqrt = wordAt(r && r.result, 0);
    if (sqrt === 0n) return null;
    const [token0, token1] = sortTokens(pair, K.USDG);
    return priceOf(pair, { token0, token1, dec0: token0 === pair ? decimals : 6, dec1: token1 === pair ? decimals : 6 }, sqrt);
  }
  return null;
}

// ---- the facts ----------------------------------------------------------------------------------------------
// Launch tx + receipt -> dev wallet, dev buy, total supply.
async function readLaunch(r, ctx) {
  const [[tx], [rc]] = await Promise.all([txsByHash([r.tx]), receiptsByHash([r.tx])]);
  if (!tx || !rc) throw new RpcError('launch tx not found');
  const from = String(tx.from).toLowerCase();
  let dev = r.dev;
  if (!dev) {
    if (r.creator === ADDR.MULTICALL3) dev = r.txFrom || from;
    else if (r.creator && r.creator !== from) {
      const code = await getCode(r.creator);                 // a contract launched it (smart wallet, batcher)
      dev = code && code !== '0x' ? from : r.creator;
    } else dev = r.creator || from;
  }
  let supply = 0n;
  for (const l of rc.logs || []) {
    if (String(l.address).toLowerCase() === r.token && l.topics[0] === TOPIC.TRANSFER && addrOf(l.topics[1]) === ADDR.ZERO) supply += wordAt(l.data, 0);
  }
  if (supply === 0n) supply = 10n ** 27n;                    // every Pons launch mints 1,000,000,000 (18 decimals)
  let quoteRaw = null, tokensRaw = null;
  for (const l of rc.logs || []) {
    const at = String(l.address).toLowerCase();
    if (at === r.curve && l.topics[0] === TOPIC.CURVE_BUY && addrOf(l.topics[2]) === dev) {
      quoteRaw = (quoteRaw || 0n) + wordAt(l.data, 0); tokensRaw = (tokensRaw || 0n) + wordAt(l.data, 1);
    }
  }
  if (tokensRaw == null) {
    const l = (rc.logs || []).find((x) => x.topics[0] === TOPIC.LAUNCHED && addrOf(wordAt(x.data, 0).toString(16).padStart(40, '0')) === dev);
    if (l) { quoteRaw = wordAt(l.data, 1); tokensRaw = wordAt(l.data, 2); }
  }
  let devBuy = null;
  if (tokensRaw != null && tokensRaw > 0n) {
    const p = await pairInfo(r.pairToken, ctx);
    const quote = p.decimals == null ? null : units(quoteRaw, p.decimals);
    devBuy = {
      eth: isEthPair(r.pairToken) ? quote : null, quote, quoteSymbol: p.symbol,
      tokens: units(tokensRaw, 18), pctSupply: pctOf(tokensRaw, supply), tx: r.tx,
    };
  }
  const time = r.time != null ? r.time : (await blockTimes([r.block]))[0];
  return { dev, from, devBuy, supply, time };
}

// Every token transfer out of the dev wallet since launch, sorted into sells, burns and sends.
// A sell = tokens to the curve, the Pons router or the Uniswap v4 PoolManager, or to another contract in a tx
// that also has a CurveSell on this curve or a v4 Swap (an aggregator or a smart-wallet batch).
async function readDevSells(r, launch, ctx) {
  const logs = await getLogsAll({ address: r.token, topics: [TOPIC.TRANSFER, pad(launch.dev)] }, r.block, ctx.head.number);
  const sellTo = new Set([r.curve, ADDR.ROUTER, K.POOL_MANAGER]);
  const items = logs.map((l) => ({ to: addrOf(l.topics[2]), raw: wordAt(l.data, 0), tx: l.transactionHash.toLowerCase(), block: num(l.blockNumber) }));
  const unknown = items.filter((x) => x.to !== ADDR.ZERO && x.to !== ADDR.DEAD && !sellTo.has(x.to));
  const checkTx = [...new Set(unknown.map((x) => x.tx))].slice(0, SELL_RECEIPT_LOOKUPS);
  if (unknown.length && new Set(unknown.map((x) => x.tx)).size > checkTx.length) ctx.problems.add('Some dev transfers weren\'t checked for sells (too many).');
  const rcs = await receiptsByHash(checkTx);
  const sellTx = new Set();
  rcs.forEach((rc, i) => {
    if (rc && (rc.logs || []).some((l) => (String(l.address).toLowerCase() === r.curve && l.topics[0] === TOPIC.CURVE_SELL)
      || (String(l.address).toLowerCase() === K.POOL_MANAGER && l.topics[0] === K.TOPIC_V4_SWAP))) sellTx.add(checkTx[i]);
  });
  const sells = items.filter((x) => sellTo.has(x.to) || sellTx.has(x.tx));
  const timeOf = await timesOf(sells.map((x) => x.block));
  const buy = launch.devBuy ? launch.devBuy.tokens : null;
  const list = sells.map((x) => {
    const tokens = units(x.raw, 18);
    return { tx: x.tx, time: iso(timeOf(x.block)), tokens, pctOfDevBuy: buy ? round6((tokens / buy) * 100) : null };
  });
  if (!list.length) return null;                             // read, and the dev never sold
  const sold = list.reduce((s, x) => s + x.tokens, 0);
  return {
    pctOfDevBuy: buy ? round6((sold / buy) * 100) : null,   // rounded: float sums of token amounts read 99.99999999999991
    firstSellSecondsAfterLaunch: timeOf(sells[0].block) - launch.time,
    tx: list[0].tx,
    sells: list,
  };
}

// Fee claims by the dev wallet since launch, and what the escrow still holds for it (V2 escrow only).
async function readFees(r, launch, ctx) {
  if (r.factory && r.factory !== ADDR.FACTORY_V2) return null;
  const [logs, bal] = await Promise.all([
    getLogsAll({ address: ADDR.FEE_ESCROW, topics: [TOPIC.CLAIMED, pad(launch.dev)] }, r.block, ctx.head.number),
    batchLatest([ethCall(ADDR.FEE_ESCROW, SEL_BALANCE_OF + pad(launch.dev).slice(2))]),
  ]);
  if (!bal[0] || bal[0].result === undefined) throw new RpcError('escrow balance unreadable');
  const timeOf = await timesOf(logs.map((l) => num(l.blockNumber)));
  const claims = logs.map((l) => ({ tx: l.transactionHash.toLowerCase(), time: iso(timeOf(num(l.blockNumber))), eth: units(wordAt(l.data, 0), 18) }));
  return {
    claimedEth: claims.reduce((s, c) => s + c.eth, 0),
    unclaimedEth: units(wordAt(bal[0].result, 0), 18),
    claims,
    escrow: ADDR.FEE_ESCROW,
  };
}

// ETH the dev bridged out in the first 7 days after launch:
//  - Arbitrum native bridge: ArbSys L2ToL1Tx logs where the caller (data word 0) or the tx sender is the dev;
//  - Across: SpokePool FundsDeposited with depositor (topic3) = dev, WETH/ETH input only;
//  - MetaBridge (routes to Across or Relay) and RelayDepository: the dev's own transactions from the explorer.
async function readBridges(r, launch, ctx) {
  const endTime = launch.time + BRIDGE_WINDOW_SECONDS;
  const to = Math.min(ctx.head.number, r.block + Math.ceil(BRIDGE_WINDOW_SECONDS / K.BLOCK_SECONDS));
  const dev = launch.dev;
  const found = new Map();      // tx -> bridge
  const blocks = new Map();     // tx -> block (for times)
  const [arb, across, mine] = await Promise.all([
    getLogsAll({ address: ADDR.ARBSYS, topics: [TOPIC.L2_TO_L1] }, r.block, to, { maxCalls: 3 }),
    getLogsAll({ address: ADDR.ACROSS_SPOKE, topics: [TOPIC.FUNDS_DEPOSITED, null, null, pad(dev)] }, r.block, to, { maxCalls: 3 }),
    devTransactions(dev, launch.time, endTime, ctx),
  ]);
  // ArbSys: caller match first; then tx.from for the remaining ETH-carrying withdrawals (gateways call ArbSys).
  const arbRows = arb.map((l) => ({ l, caller: addrOf(wordAt(l.data, 0).toString(16).padStart(40, '0')), value: wordAt(l.data, 4) }));
  const needFrom = arbRows.filter((x) => x.caller !== dev && x.value > 0n);
  const look = needFrom.slice(0, ARBSYS_FROM_LOOKUPS);
  if (needFrom.length > look.length) ctx.problems.add('Some native-bridge withdrawals weren\'t checked (too many).');
  const froms = await txsByHash([...new Set(look.map((x) => x.l.transactionHash))]);
  const fromOf = new Map(froms.filter(Boolean).map((t) => [t.hash.toLowerCase(), String(t.from).toLowerCase()]));
  for (const x of arbRows) {
    const h = x.l.transactionHash.toLowerCase();
    if (x.caller === dev || fromOf.get(h) === dev) {
      found.set(h, { via: 'Arbitrum native bridge', eth: units(x.value, 18), time: null, tx: h });
      blocks.set(h, num(x.l.blockNumber));
    }
  }
  for (const l of across) {
    const input = addrOf(l.data.slice(2, 66));
    if (input !== K.WETH && input !== ADDR.ZERO) continue;
    const h = l.transactionHash.toLowerCase();
    found.set(h, { via: 'Across', eth: units(wordAt(l.data, 2), 18), time: null, tx: h, destChainId: Number(BigInt(l.topics[1])), destChainConfirmed: true });
    blocks.set(h, num(l.blockNumber));
  }
  // MetaBridge / Relay calls from the dev's own transaction list.
  const meta = mine.filter((t) => t.to === ADDR.METABRIDGE || t.to === ADDR.RELAY_DEPOSITORY);
  const rcs = await receiptsByHash(meta.filter((t) => t.to === ADDR.METABRIDGE).map((t) => t.hash));
  let k = 0;
  for (const t of meta) {
    const b = { via: 'Relay', eth: t.value, time: t.time, tx: t.hash };
    if (t.to === ADDR.METABRIDGE) {
      const rc = rcs[k++];
      const logs = (rc && rc.logs) || [];
      const at = (a) => logs.filter((l) => String(l.address).toLowerCase() === a);
      const acrossLog = at(ADDR.ACROSS_SPOKE).find((l) => l.topics[0] === TOPIC.FUNDS_DEPOSITED);
      const mb = logs.find((l) => l.topics[0] === TOPIC.METABRIDGE_BRIDGE && addrOf(wordAt(l.data, 0).toString(16).padStart(40, '0')) === dev)
        || logs.find((l) => l.topics[0] === TOPIC.METABRIDGE_BRIDGE);
      if (acrossLog) { b.via = 'MetaBridge/Across'; b.destChainId = Number(BigInt(acrossLog.topics[1])); b.destChainConfirmed = true; }
      else if (at(ADDR.RELAY_DEPOSITORY).length) b.via = 'MetaBridge/Relay';
      else b.via = 'MetaBridge';
      if (b.destChainId == null && mb) {                          // MetaBridge's own event: data word 2 = destination chain
        const d = Number(wordAt(mb.data, 2));
        if (d > 0 && d < 1e12) { b.destChainId = d; b.destChainConfirmed = false; }   // the Relay side doesn't confirm it
      }
      if (rc) blocks.set(t.hash, num(rc.blockNumber));
    }
    found.set(t.hash, b);
  }
  const need = [...found.values()].filter((b) => !b.time);
  const timeOf = await timesOf(need.map((b) => blocks.get(b.tx)));
  for (const b of need) b.time = iso(timeOf(blocks.get(b.tx)));
  const list = [...found.values()].sort((a, b) => secsOf(a.time) - secsOf(b.time));
  return { list, partial: mine.partial === true };
}

// The dev's own outgoing transactions between two times (explorer). [] with a note when the explorer is down.
async function devTransactions(dev, fromTime, toTime, ctx) {
  const out = [];
  let q = '';
  for (let page = 0; page < DEV_TX_PAGES; page++) {
    const r = await ctx.explorer.get('/api/v2/addresses/' + dev + '/transactions?filter=from' + q);
    if (!r.ok) {
      if (r.reason !== 'not-found') {
        ctx.problems.add('The explorer was unavailable, so MetaBridge/Relay bridges weren\'t checked.');
        out.partial = true;
      }
      break;
    }
    const items = (r.json && r.json.items) || [];
    let older = false;
    for (const it of items) {
      const t = Date.parse(it.timestamp) / 1000;
      if (!Number.isFinite(t)) continue;
      if (t < fromTime) { older = true; continue; }
      if (t > toTime) continue;
      if (it.status && it.status !== 'ok') continue;
      const toAddr = it.to && it.to.hash ? it.to.hash.toLowerCase() : null;
      out.push({ hash: String(it.hash).toLowerCase(), to: toAddr, value: units(BigInt(it.value || '0'), 18), time: iso(t) });
    }
    const next = r.json && r.json.next_page_params;
    if (older || !next || !items.length) break;
    q = '&' + Object.keys(next).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(next[k] == null ? '' : String(next[k]))).join('&');
  }
  return out;
}

// Graduation: the curve's CurveCompleted log; the v4 pool from the Initialize log in that tx (early graduations
// used a second tx: then the factory's graduation log is followed).
async function readGraduation(r, ctx) {
  const logs = await getLogsAll({ address: r.curve, topics: [TOPIC.CURVE_COMPLETED] }, r.block, ctx.head.number);
  if (!logs.length) return null;
  const l = logs[0];
  const tx = l.transactionHash.toLowerCase(), block = num(l.blockNumber);
  const findPool = (rc) => {
    for (const x of (rc && rc.logs) || []) {
      if (String(x.address).toLowerCase() !== K.POOL_MANAGER || x.topics[0] !== K.TOPIC_V4_INITIALIZE || x.topics.length < 4) continue;
      const c0 = addrOf(x.topics[2]), c1 = addrOf(x.topics[3]);
      if (c0 === r.token || c1 === r.token) return { id: x.topics[1].toLowerCase(), currency0: c0, currency1: c1, hooks: addrOf(wordAt(x.data, 2).toString(16).padStart(40, '0')) };
    }
    return null;
  };
  let [rc] = await receiptsByHash([tx]);
  let pool = findPool(rc);
  if (!pool && r.factory) {
    const g = await getLogsAll({ address: r.factory, topics: [TOPIC.GRADUATED, pad(r.token)] }, r.block, ctx.head.number);
    if (g.length) { [rc] = await receiptsByHash([g[0].transactionHash]); pool = findPool(rc); }
  }
  const [t] = await blockTimes([block]);
  return { time: iso(t), tx, block, pool };
}

// Pair-side money behind the coin now: the curve's realQuoteReserve() before graduation, the v4 pool's in-range
// pair amount after. usd = that amount x the pair's dollar price (null when the pair has no dollar price).
async function readLiquidity(r, grad, ctx) {
  const p = await pairInfo(r.pairToken, ctx);
  if (p.decimals == null) return null;
  let quote, source;
  if (!grad) {
    const [res] = await batchLatest([ethCall(r.curve, SEL_REAL_QUOTE)]);
    if (!res || res.result === undefined || res.result.length < 66) throw new RpcError('curve unreadable');
    quote = units(wordAt(res.result, 0), p.decimals);
    source = 'curve';
  } else if (grad.pool) {
    const [d] = await readDepthNow([{ id: grad.pool.id, version: 'v4' }]);
    if (!d) throw new RpcError('pool unreadable');
    const pair = r.pairToken === K.WETH ? K.WETH : r.pairToken;
    quote = inRangeAmount(grad.pool.currency0 === pair, d.sqrt, d.liquidity, p.decimals);
    source = 'pool';
  } else return null;
  return { quote, quoteSymbol: p.symbol, usd: p.usd == null ? null : quote * p.usd, source };
}

// Holders: the explorer's holders_count; when the explorer is down, counted from the token's Transfer logs
// (balances above zero, leaving out the zero and dead addresses, the curve, the PoolManager, the locker and hook).
async function readHolders(r, grad, ctx) {
  const ex = await ctx.explorer.get('/api/v2/tokens/' + r.token);
  if (ex.ok && ex.json) {
    const n = Number(ex.json.holders_count != null ? ex.json.holders_count : ex.json.holders);
    if (Number.isFinite(n)) return { count: n, source: 'blockscout' };
  }
  const logs = await getLogsAll({ address: r.token, topics: [TOPIC.TRANSFER] }, r.block, ctx.head.number, { maxCalls: 6 });
  return { count: holdersFromTransfers(logs, { curve: r.curve, factory: r.factory, hook: grad && grad.pool ? grad.pool.hooks : null }), source: 'transfers' };
}

export function holdersFromTransfers(logs, { curve = null, factory = null, hook = null } = {}) {
  const bal = new Map();
  const add = (a, v) => bal.set(a, (bal.get(a) || 0n) + v);
  for (const l of logs) {
    if (l.topics[0] !== TOPIC.TRANSFER || l.topics.length < 3) continue;
    const v = wordAt(l.data, 0);
    add(addrOf(l.topics[1]), -v);
    add(addrOf(l.topics[2]), v);
  }
  const skip = new Set([ADDR.ZERO, ADDR.DEAD, K.POOL_MANAGER, ADDR.HOOK, curve, factory, hook].filter(Boolean));
  let n = 0;
  for (const [a, v] of bal) if (v > 0n && !skip.has(a) && !a.startsWith(ADDR.LAUNCH_LOCKER_PREFIX)) n++;
  return n;
}

// First buyers: CurveBuy logs in launch block + 0..sniperWindowBlocks. The buyer is the recipient (topic2) when the
// Pons router or LaunchAndBuy bought for them; when buyer == recipient (a direct call or an aggregator) it is the
// tx sender. The dev (and the launch creator) are left out.
async function readSnipers(r, launch, ctx) {
  const w = ctx.trust.sniperWindowBlocks;
  const logs = await getLogsAll({ address: r.curve, topics: [TOPIC.CURVE_BUY] }, r.block, Math.min(ctx.head.number, r.block + w));
  const rows = logs.map((l) => ({ buyer: addrOf(l.topics[1]), recipient: addrOf(l.topics[2]), raw: wordAt(l.data, 1), tx: l.transactionHash.toLowerCase(), block: num(l.blockNumber) }));
  const isPonsContract = (a) => a === ADDR.ROUTER || a === ADDR.LAUNCH_AND_BUY;
  const viaContract = (x) => isPonsContract(x.buyer);
  // tx sender needed: direct/aggregator calls (buyer == recipient), and the rare buy whose recipient is the
  // router itself (the router must never be named as a buyer).
  const needFrom = (x) => (!viaContract(x) && x.buyer === x.recipient) || isPonsContract(x.recipient);
  const need = [...new Set(rows.filter(needFrom).map((x) => x.tx))];
  const txs = await txsByHash(need);
  const fromOf = new Map(txs.filter(Boolean).map((t) => [t.hash.toLowerCase(), String(t.from).toLowerCase()]));
  const by = new Map();
  for (const x of rows) {
    const wallet = needFrom(x) ? (fromOf.get(x.tx) || x.recipient) : x.recipient;
    if (wallet === launch.dev || wallet === r.creator) continue;
    const cur = by.get(wallet) || { wallet, raw: 0n, block: x.block, tx: x.tx };
    cur.raw += x.raw;
    by.set(wallet, cur);
  }
  return [...by.values()].map((s) => ({
    wallet: s.wallet, tokens: units(s.raw, 18), pctSupply: pctOf(s.raw, launch.supply),
    block: s.block, blocksAfterLaunch: s.block - r.block, tx: s.tx,
  })).sort((a, b) => a.block - b.block || (a.wallet < b.wallet ? -1 : 1));
}

// Curve trades in the last deadCopyQuietMinutes (only asked for coins that never graduated).
async function readRecentTrades(r, ctx) {
  const blocks = Math.ceil((ctx.trust.deadCopyQuietMinutes * 60) / K.BLOCK_SECONDS);
  const from = Math.max(r.block, ctx.head.number - blocks);
  try {
    const logs = await getLogsAll({ address: r.curve, topics: [[TOPIC.CURVE_BUY, TOPIC.CURVE_SELL]] }, from, ctx.head.number, { maxCalls: 2 });
    return logs.length;
  } catch (e) {
    if (e instanceof RpcError && e.overCap) return 10000;      // busy: plenty of trades
    throw e;
  }
}

// ---- all facts for one coin ---------------------------------------------------------------------------------
// The graduation radar's three facts for one coin, lighter than gatherFacts: dev buy % (launch tx), first buyers'
// % (launch block + sniper window) and holders (explorer, else Transfer logs). Each part may come back null.
export async function radarFacts(row, ctx) {
  const r = normalizeRow(row);
  const out = { devPct: null, sniperPct: null, snipers: null, holders: null };
  let launch = null;
  try { launch = await readLaunch(r, ctx); out.devPct = launch.devBuy ? launch.devBuy.pctSupply : 0; } catch (e) { /* unknown */ }
  await Promise.all([
    launch ? readSnipers(r, launch, ctx).then((s) => { out.snipers = s.length; out.sniperPct = s.reduce((a, x) => a + (x.pctSupply || 0), 0); }, () => {}) : null,
    readHolders(r, null, ctx).then((h) => { out.holders = h ? h.count : null; }, () => {}),
  ]);
  return out;
}

export async function gatherFacts(row, ctx) {
  const r = normalizeRow(row);
  const f = {
    address: r.token, name: r.name, symbol: r.symbol, factory: r.factory, curve: r.curve, pairToken: r.pairToken,
    isPons: true,
    launch: { tx: r.tx, block: r.block, time: iso(r.time) },
    creator: null, devBuy: null, devSold: null, fees: null, bridges: null, holders: null, liquidity: null,
    graduated: null, snipers: null, tradesRecent: null, missing: [],
  };
  const miss = (k) => { if (!f.missing.includes(k)) f.missing.push(k); };
  let launch = null;
  try {
    launch = await readLaunch(r, ctx);
    f.creator = launch.dev;
    f.devBuy = launch.devBuy;
    f.launch.time = iso(launch.time);
  } catch (e) { miss('creator'); miss('devBuy'); }

  const tasks = [];
  const run = (key, p, set) => tasks.push(p.then(set, () => miss(key)));
  if (launch) {
    run('devSold', readDevSells(r, launch, ctx), (v) => { f.devSold = v; });
    run('fees', readFees(r, launch, ctx), (v) => { f.fees = v; if (v === null) miss('fees'); });
    run('bridges', readBridges(r, launch, ctx), (v) => { f.bridges = v.list; if (v.partial) miss('bridges'); });
    run('snipers', readSnipers(r, launch, ctx), (v) => { f.snipers = v; });
  } else ['devSold', 'fees', 'bridges', 'snipers'].forEach(miss);
  const later = readGraduation(r, ctx).then((grad) => {
    f.graduated = grad ? { time: grad.time, tx: grad.tx } : null;
    const more = [
      readLiquidity(r, grad, ctx).then((v) => { f.liquidity = v; if (v === null) miss('liquidity'); }, () => miss('liquidity')),
      readHolders(r, grad, ctx).then((v) => { f.holders = v; }, () => miss('holders')),
    ];
    if (!grad) more.push(readRecentTrades(r, ctx).then((n) => { f.tradesRecent = n; }, () => miss('tradesRecent')));
    if (grad && grad.pool) f.pool = grad.pool.id;
    return Promise.all(more);
  }, () => { miss('graduated'); miss('liquidity'); miss('tradesRecent'); return readHolders(r, null, ctx).then((v) => { f.holders = v; }, () => miss('holders')); });
  tasks.push(later);
  await Promise.all(tasks);

  f.proof = {
    token: tokenUrl(r.token),
    creator: f.creator ? addressUrl(f.creator) : null,
    launchTx: txUrl(r.tx),
    curve: addressUrl(r.curve),
    graduationTx: f.graduated ? txUrl(f.graduated.tx) : null,
    escrow: f.fees ? addressUrl(ADDR.FEE_ESCROW) : null,
  };
  return f;
}
