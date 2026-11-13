// Finding a coin's pools (DexScreener, GeckoTerminal as backup), sorting what each pool is paired with,
// and ranking pools by the dollar value of the PAIR side only.
import { getJson } from './rpc.js';
import { getCode, readDepthNow, tokenFacts, sortTokens } from './chain.js';
import * as K from './constants.js';

// A pool with less than this on its dollar side is too thin to price a stock or a pair coin
// (dev/tools/build_stocks.py uses the same floor).
export const MIN_USD_POOL = 100;
// A dollar pool this deep is preferred over a two-step route through ETH or a stock.
export const GOOD_USD_POOL = 1000;
// GeckoTerminal pools measured on-chain per lookup (the deepest by its own figure).
const GECKO_MEASURE_MAX = 12;

const lower = (a) => String(a || '').toLowerCase();
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : 0; };
const amount = (x) => { if (x == null || x === '') return null; const n = Number(x); return Number.isFinite(n) && n >= 0 ? n : null; };

// What kind of asset an address is: 'stable' | 'eth' | 'stock' | 'coin' (stocks: Map from stocks.js).
export function classifyAddress(addr, stocks) {
  if (K.STABLES[addr]) return { kind: 'stable', symbol: K.STABLES[addr] };
  if (K.ETH_TOKENS[addr]) return { kind: 'eth', symbol: K.ETH_TOKENS[addr] };
  const s = stocks && stocks.get(addr);
  if (s) return { kind: 'stock', symbol: s.symbol };
  return { kind: 'coin', symbol: null };
}

function versionOf(id, isV3) {
  if (id.length === 66) return 'v4';                 // 32-byte pool id in the v4 PoolManager
  if (id.length === 42 && isV3) return 'v3';         // v3-style pool contract (answers slot0)
  return null;                                       // v2, bonding curves, other designs: not readable
}

// DexScreener token-pairs response -> candidate pools for `coin`.
export function parseDexScreener(coin, pairs, stocks) {
  const out = [];
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (!p || !p.baseToken || !p.quoteToken || !p.pairAddress) continue;
    if (p.chainId && p.chainId !== 'robinhood') continue;
    const base = lower(p.baseToken.address), quote = lower(p.quoteToken.address);
    const liq = p.liquidity || {};
    const priceNative = num(p.priceNative), priceUsd = num(p.priceUsd);
    let coinTok, pairTok, pairAmount, pairUsd;
    // pairAmount null = DexScreener gave no amount (new pools often have no "liquidity" yet): unknown, not $0.
    if (base === coin && quote !== coin) {
      coinTok = p.baseToken; pairTok = p.quoteToken; pairAmount = amount(liq.quote);
      pairUsd = priceNative > 0 ? priceUsd / priceNative : 0;      // quote token's dollar price
    } else if (quote === coin && base !== coin) {
      coinTok = p.quoteToken; pairTok = p.baseToken; pairAmount = amount(liq.base);
      pairUsd = priceUsd;                                           // base token's dollar price
    } else continue;
    const pairAddr = lower(pairTok.address);
    const cls = classifyAddress(pairAddr, stocks);
    if (cls.kind === 'stable') pairUsd = 1;
    const id = lower(p.pairAddress);
    const labels = Array.isArray(p.labels) ? p.labels : [];
    const version = versionOf(id, labels.includes('v3'));
    out.push({
      id, version, readable: !!version, uniswap: !!version && p.dexId === 'uniswap',
      dex: [p.dexId, labels.join(' ')].filter(Boolean).join(' '),
      coin: { address: coin, symbol: coinTok.symbol || '', name: coinTok.name || '' },
      pair: { address: pairAddr, symbol: cls.symbol || pairTok.symbol || '', name: pairTok.name || '', kind: cls.kind },
      pairAmount, pairSideUsd: pairAmount == null ? 0 : pairAmount * pairUsd,
      createdAt: num(p.pairCreatedAt) > 0 ? Math.floor(num(p.pairCreatedAt) / 1000) : null,
      source: 'dexscreener',
    });
  }
  return out;
}

// GeckoTerminal tokens/<coin>/pools response -> candidate pools. It has no per-side amounts, so the pair
// side starts as half the pool's total (pairAmount null marks the estimate). That total can be fake (the
// coin's own side valued at the pool's own price), so measureGecko() replaces it with an on-chain figure.
export function parseGecko(coin, json, stocks) {
  const out = [];
  for (const x of (json && Array.isArray(json.data)) ? json.data : []) {
    const a = x.attributes || {}, r = x.relationships || {};
    const idOf = (rel) => lower(((rel || {}).data || {}).id).replace(/^robinhood_/, '');
    const baseId = idOf(r.base_token), quoteId = idOf(r.quote_token);
    const dexId = String(((r.dex || {}).data || {}).id || '');
    const names = String(a.name || '').split(' / ');
    const baseSym = (names[0] || '').trim(), quoteSym = (names[1] || '').trim().split(' ')[0];
    let pairAddr, pairSym, coinSym, pairUsd;
    if (baseId === coin) { pairAddr = quoteId; pairSym = quoteSym; coinSym = baseSym; pairUsd = num(a.quote_token_price_usd); }
    else if (quoteId === coin) { pairAddr = baseId; pairSym = baseSym; coinSym = quoteSym; pairUsd = num(a.base_token_price_usd); }
    else continue;
    const id = lower(a.address);
    const version = versionOf(id, /v3/.test(dexId));
    const cls = classifyAddress(pairAddr, stocks);
    const created = Date.parse(a.pool_created_at || '');
    out.push({
      id, version, readable: !!version, uniswap: !!version && (/^uniswap/.test(dexId) || dexId === 'pons-v2-dex'),
      dex: dexId,
      coin: { address: coin, symbol: coinSym, name: coinSym },
      pair: { address: pairAddr, symbol: cls.symbol || pairSym, name: pairSym, kind: cls.kind },
      pairAmount: null, pairSideUsd: num(a.reserve_in_usd) / 2, pairUsdGuess: cls.kind === 'stable' ? 1 : pairUsd,
      createdAt: Number.isFinite(created) ? Math.floor(created / 1000) : null,
      source: 'geckoterminal',
    });
  }
  return out;
}

// Pair-token amount (human units) behind a pool's current price: the virtual reserves of its in-range
// liquidity L at price √P (amount0 = L / √P, amount1 = L · √P). 0 when the pool has no liquidity in range.
export function inRangeAmount(pairIsToken0, sqrt, liquidity, decimals) {
  const sp = Number(BigInt(sqrt || 0n)) / 2 ** 96, L = Number(BigInt(liquidity || 0n));
  if (!(sp > 0) || !(L > 0)) return 0;
  return (pairIsToken0 ? L / sp : L * sp) / Number('1e' + decimals);
}

// Replaces GeckoTerminal's half-of-total estimate with the pair side measured on-chain (one batch).
// If the chain doesn't answer, the estimates stay for ranking but are never shown (pairAmount stays null).
export async function measureGecko(cands) {
  const gecko = cands.filter((c) => c.source === 'geckoterminal' && c.readable)
    .sort((a, b) => b.pairSideUsd - a.pairSideUsd);
  const todo = gecko.slice(0, GECKO_MEASURE_MAX);
  if (!todo.length) return;
  let depth, facts;
  try {
    [depth, facts] = await Promise.all([readDepthNow(todo), tokenFacts([...new Set(todo.map((c) => c.pair.address))])]);
  } catch (e) { return; }
  todo.forEach((c, i) => {
    const d = depth[i], dec = facts.get(c.pair.address).decimals;
    if (!d || dec == null) return;
    const [t0] = sortTokens(c.coin.address, c.pair.address);
    c.pairAmount = inRangeAmount(c.pair.address === t0, d.sqrt, d.liquidity, dec);
    c.pairSideUsd = c.pairAmount * (Number.isFinite(c.pairUsdGuess) ? c.pairUsdGuess : 0);
  });
  for (const c of gecko.slice(GECKO_MEASURE_MAX)) c.pairSideUsd = 0;   // not measured: last
}

// Readable pools, deepest pair side first (older pool first on a tie).
export function rankCandidates(cands) {
  return cands.filter((c) => c.readable)
    .sort((a, b) => (b.pairSideUsd - a.pairSideUsd) || ((a.createdAt || 0) - (b.createdAt || 0)));
}

// The pool used to price `token` (whose candidates are `cands`) in dollars:
// its deepest pool against a $1 stablecoin; or, when that is missing or thin, its deepest pool against
// ETH or a stock (then priced through that asset). usdgOnly/uniswapOnly: the stock rule (SPEC 5).
export function pickUsdPool(cands, { usdgOnly = false, uniswapOnly = false } = {}) {
  const ok = rankCandidates(cands).filter((c) => !uniswapOnly || c.uniswap);
  const stable = ok.filter((c) => c.pair.kind === 'stable' && (!usdgOnly || c.pair.address === K.USDG) && c.pairSideUsd >= MIN_USD_POOL);
  const other = usdgOnly ? [] : ok.filter((c) => c.pair.kind === 'eth' || c.pair.kind === 'stock');
  if (stable.length && (stable[0].pairSideUsd >= GOOD_USD_POOL || !other.length || stable[0].pairSideUsd >= other[0].pairSideUsd)) return stable[0];
  return other[0] || null;
}

// All pools for a token on Robinhood Chain. available=false when neither source answered.
// code = the address's contract code when it was looked up (no pools on DexScreener), else null.
export async function findPools(token, stocks) {
  const dsUrl = `${K.DEXSCREENER}/token-pairs/v1/robinhood/${token}`;
  // GeckoTerminal allows ~5 calls a minute per visitor and its 429 has no CORS header: one try only.
  const gecko = () => getJson(`${K.GECKOTERMINAL}/networks/robinhood/tokens/${token}/pools`, { host: 'geckoterminal', tries: 1 });
  let ds = await getJson(dsUrl, { host: 'dexscreener', tries: 1, timeoutMs: 5000 });
  let gtP = null;
  if (ds === null) {               // DexScreener didn't answer: ask GeckoTerminal now, and DexScreener once more alongside
    gtP = gecko();
    ds = await getJson(dsUrl, { host: 'dexscreener', tries: 1, timeoutMs: 5000 });
  }
  let cands = Array.isArray(ds) ? parseDexScreener(token, ds, stocks) : [];
  let available = Array.isArray(ds) || !!(ds && ds.notFound);
  let code = null;
  if (!cands.length) {
    // Nothing on DexScreener. An address with no code on this chain can't have pools here: skip the backup.
    try { code = await getCode(token); } catch (e) { code = null; }
  }
  if (!rankCandidates(cands).length && code !== '0x') {
    // Nothing readable on DexScreener (it can drop quiet pools): the backup.
    const gt = await (gtP || gecko());
    if (gt && Array.isArray(gt.data)) {
      const seen = new Set(cands.map((c) => c.id));
      cands = cands.concat(parseGecko(token, gt, stocks).filter((c) => !seen.has(c.id)));
      available = true;
      await measureGecko(cands);
    } else if (gt && gt.notFound) available = true;
  }
  return { cands, ranked: rankCandidates(cands), available, code };
}

// Number of pools for this address on OTHER chains (null when DexScreener did not answer).
export async function otherChainPairCount(token) {
  const res = await getJson(`${K.DEXSCREENER}/latest/dex/tokens/${token}`, { host: 'dexscreener' });
  if (!res || res.notFound) return res && res.notFound ? 0 : null;
  return (Array.isArray(res.pairs) ? res.pairs : []).filter((p) => p && p.chainId && p.chainId !== 'robinhood').length;
}
