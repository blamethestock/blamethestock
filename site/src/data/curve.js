// Pons launch curves. A coin launched on Pons trades on its own bonding curve (PonsV2BondingCurve)
// until it "graduates" into a Uniswap v4 pool. Before that, its price lives only on the curve:
// price of the coin in the curve's pair token = quoteReserve / tokenReserve (constant-product curve).
import { rpc, rpcBatch } from './rpc.js';
import { batchLatest, ethCall, wordAt, toHex } from './chain.js';

export const SEL_CURVE = '0x7165485d';          // curve()            on a Pons launch token
export const SEL_TOKEN = '0xfc0c546a';          // token()            on the curve
export const SEL_PAIR_TOKEN = '0x3de35b79';     // pairToken()        0x0 = native ETH
export const SEL_GRADUATED = '0xe7c2b772';      // graduated()
export const SEL_GET_RESERVES = '0x0902f1ac';   // getReserves() -> (quoteReserve, tokenReserve), virtual
export const SEL_REAL_QUOTE = '0x4f1f58fd';     // realQuoteReserve() -> quote actually held
export const SEL_SYMBOL = '0x95d89b41';         // symbol()
export const TOPIC_CURVE_INITIALIZED = '0x908408e307fc569b417f6cbec5d5a06f44a0a505ac0479b47d421a4b2fd6a1e6'; // Initialized(address)

const addrOf = (word) => ('0x' + String(word).slice(-40)).toLowerCase();

// ABI-encoded string -> text ('' when it isn't one).
export function decodeString(hex) {
  try {
    if (!hex || hex.length < 130) return '';
    const len = Number(wordAt(hex, 1));
    if (!(len > 0 && len < 64)) return '';
    const bytes = hex.slice(130, 130 + 2 * len);
    let s = '';
    for (let i = 0; i < bytes.length; i += 2) s += String.fromCharCode(parseInt(bytes.slice(i, i + 2), 16));
    s = decodeURIComponent(escape(s));                       // UTF-8 bytes -> text
    return s.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  } catch (e) { return ''; }
}

const curveCache = new Map();
export function clearCurveCache() { curveCache.clear(); }

// Is `coin` a Pons launch token? -> { curve, pairToken, graduated, symbol } | null.
// Two small batches; any token without a matching curve() returns null.
export async function detectCurve(coin) {
  const hit = curveCache.get(coin);
  if (hit && Date.now() - hit.at < 60000) return hit.v;
  const [c, sym] = await batchLatest([ethCall(coin, SEL_CURVE), ethCall(coin, SEL_SYMBOL)]);
  let v = null;
  if (c && c.result && c.result.length >= 66 && BigInt(c.result) !== 0n) {
    const curve = addrOf(c.result.slice(0, 66));
    const [t, g, p] = await batchLatest([ethCall(curve, SEL_TOKEN), ethCall(curve, SEL_GRADUATED), ethCall(curve, SEL_PAIR_TOKEN)]);
    if (t && t.result && t.result.length >= 66 && addrOf(t.result.slice(0, 66)) === coin
        && g && g.result && g.result.length >= 66 && p && p.result && p.result.length >= 66) {
      v = { curve, pairToken: addrOf(p.result.slice(0, 66)), graduated: BigInt(g.result.slice(0, 66)) !== 0n, symbol: decodeString(sym && sym.result) };
    }
  }
  curveCache.set(coin, { at: Date.now(), v });
  return v;
}

export async function symbolOf(token) {
  const [r] = await batchLatest([ethCall(token, SEL_SYMBOL)]);
  return decodeString(r && r.result);
}

// Curve reserves at a block -> { quote, token, real } (BigInt) | null when the curve didn't exist yet.
// archive=false: official RPC first (recent state), then dRPC. archive=true: dRPC (full history).
export async function readCurve(curve, block, { archive = false, withReal = false } = {}) {
  const calls = [ethCall(curve, SEL_GET_RESERVES, block)];
  if (withReal) calls.push(ethCall(curve, SEL_REAL_QUOTE, block));
  const order = archive ? [['drpc', 4]] : [['official', 2], ['drpc', 4]];
  let lastErr = null;
  for (const [ep, tries] of order) {
    let res;
    try { res = await rpcBatch(ep, calls, { tries }); } catch (e) { lastErr = e; continue; }
    const r = res[0];
    if (r && r.result !== undefined) {
      if (!r.result || r.result.length < 130) return null;           // no contract at that block yet
      const out = { quote: wordAt(r.result, 0), token: wordAt(r.result, 1), real: null };
      if (withReal && res[1] && res[1].result && res[1].result.length >= 66) out.real = wordAt(res[1].result, 0);
      return out;
    }
    if (r && r.error && /revert/i.test(r.error.message || '')) return null;
    lastErr = (r && r.error) || lastErr;
  }
  throw lastErr || new Error('curve read failed');
}

// The block where the curve was created (its Initialized event), searching back from maxBlock.
export async function findCurveStart(curve, maxBlock) {
  const ranges = [[Math.max(0, maxBlock - 2000000), maxBlock]];
  for (let to = maxBlock - 2000001; to >= 0; to -= 10000000) ranges.push([Math.max(0, to - 9999999), to]);
  for (const [from, to] of ranges) {
    const logs = await rpc('official', 'eth_getLogs', [{ address: curve, topics: [TOPIC_CURVE_INITIALIZED], fromBlock: toHex(from), toBlock: toHex(to) }]);
    if (logs && logs.length) return parseInt(logs[0].blockNumber, 16);
  }
  return null;
}

// Price of the coin in the pair token from reserves (decimals: coin's and pair token's).
export function curvePrice(res, decCoin, decQuote) {
  if (!res || res.token === 0n) return NaN;
  return (Number(res.quote) / Number(res.token)) * 10 ** (decCoin - decQuote);
}
