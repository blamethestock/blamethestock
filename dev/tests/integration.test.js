// Tests for the joining-up work: Pons launch curves, stock-token note, lookalike warning, X-post wording.
import { suite, test, eq, near, ok } from './harness.js';
import { buildResult } from '../../site/src/core/verdict.js';
import { decodeString, curvePrice } from '../../site/src/data/curve.js';
import { _setTransport, rpcBatch } from '../../site/src/data/rpc.js';

suite('integration');

const T_END = 1794548248;
function pi({ kind = 'eth', sym = 'ETH', r = -0.1, q = -0.05, source = 'dexscreener', sinceLaunch = false, liq = 50000, lookalike = false, traded = true }) {
  return {
    ok: true,
    coin: { address: '0x0f4f432500c86d93a0e000858e44347b1f730783', symbol: 'CATTT', name: 'CATTT' },
    pair: { address: kind === 'eth' ? '0x0000000000000000000000000000000000000000' : '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', symbol: sym, kind, lookalike },
    pool: { id: '0x2f4ea524bfa678dcfff271f567864abd95748899', dex: source === 'pons-curve' ? 'pons-curve' : 'uniswap', label: 'CATTT/' + sym, pairSideUsd: liq, createdAt: sinceLaunch ? T_END - 7200 : null, source },
    window: '24h', windowSeconds: 86400,
    start: { block: 1, time: sinceLaunch ? T_END - 7200 : T_END - 86400 }, end: { block: 2, time: T_END },
    sinceLaunch,
    coinInPair: { start: 1, end: traded ? 1 + r : 1 },
    pairUsd: kind === 'stable' ? null : { start: 100, end: 100 * (1 + q) },
    pairVia: null, tradedInWindow: traded,
  };
}
const NY = { timeZone: 'America/New_York' };

test('curve: since-launch note talks about the coin, not a pool', () => {
  const res = buildResult(pi({ source: 'pons-curve', sinceLaunch: true }), undefined, NY);
  eq(res.notes[0], "This coin is only 2 hours old, so this covers its whole life, not the full 24h.");
  eq(res.notes[res.notes.length - 1], "Measured on its Pons launch curve. It hasn't moved to a trading pool yet.");
});

test('curve: low money warning names the launch curve', () => {
  const res = buildResult(pi({ source: 'pons-curve', liq: 0.33 }), undefined, NY);
  eq(res.warnings, ['Only $0.33 has gone into its launch curve so far, so these numbers are shaky.']);
});

test('pool coins keep the pool wording', () => {
  const res = buildResult(pi({ sinceLaunch: true, liq: 900 }), undefined, NY);
  eq(res.notes[0], "This coin's pool is only 2 hours old, so this covers its whole life, not the full 24h.");
  eq(res.warnings, ['Only $900 on the ETH side of its main pool, so these numbers are shaky.']);
});

test('stock pair: says the price is the token price on Robinhood Chain', () => {
  const res = buildResult(pi({ kind: 'stock', sym: 'NVDA' }), undefined, NY);
  ok(res.notes.includes('NVDA here is its token price on Robinhood Chain, which can differ from the share price.'), JSON.stringify(res.notes));
});

test('ETH pair: no stock-token note', () => {
  const res = buildResult(pi({}), undefined, NY);
  ok(!res.notes.some((n) => /token price/.test(n)), JSON.stringify(res.notes));
});

test('lookalike pair gets a warning', () => {
  const res = buildResult(pi({ kind: 'coin', sym: 'NVDA', lookalike: true }), undefined, NY);
  ok(res.warnings.includes("Heads up: this NVDA isn't Robinhood's NVDA stock token. It's another coin using the same name."), JSON.stringify(res.warnings));
});

test('opposite: short sentence', () => {
  const res = buildResult(pi({ r: -0.12, q: 0.03 }), undefined, NY);
  eq(res.blame, "Ethereum went the other way (+3.0%), so it's all the coin.");
});

test('X post speaks as the visitor when the pair fell more', () => {
  const res = buildResult(pi({ r: 0.05, q: -0.08 }), undefined, NY);
  eq(res.caseName, 'pair-bigger');
  eq(res.blame, 'Ethereum fell 8.0%, so your coin actually held up better.');
  eq(res.shareText, 'My $CATTT is down 3.4% (24h). Ethereum fell 8.0%, so mine actually held up better.');
});

test('flat coin: pair move uses fell/rose', () => {
  const res = buildResult(pi({ r: 0.06, q: -0.056 }), undefined, NY);
  eq(res.caseName, 'flat');
  eq(res.blame, 'Ethereum fell 5.6% in the same time.');
});

test('decodeString reads an ABI string', () => {
  const hex = '0x' + '0'.repeat(62) + '20' + '0'.repeat(63) + '5' + '434154545400000000000000000000000000000000000000000000000000000000'.slice(0, 64);
  eq(decodeString(hex), 'CATTT');
  eq(decodeString('0x'), '');
  eq(decodeString(null), '');
});

test('curvePrice = quote / token reserves, decimals applied', () => {
  near(curvePrice({ quote: 1680172858019835616n, token: 999897118907134748340192351n }, 18, 18), 1.6803457338253231e-9, 1e-20);
  near(curvePrice({ quote: 2000000n, token: 1000000000000000000n }, 18, 6), 2, 1e-12);   // USDG (6 decimals) pair
  ok(Number.isNaN(curvePrice({ quote: 1n, token: 0n }, 18, 18)));
});

test('archive "Unknown state" sent with HTTP 400 is retried, not treated as final', async () => {
  let n = 0;
  _setTransport({ sleep: async () => {}, backoff: [0], timeouts: false, fetch: async () => {
    n++;
    if (n === 1) return { ok: false, status: 400, json: async () => ({ jsonrpc: '2.0', id: 0, error: { code: 27, message: 'Unknown state. First available state is 1' } }) };
    return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 0, result: '0x01' }) };
  } });
  const out = await rpcBatch('drpc', [{ method: 'eth_call', params: [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }, '0x1'] }], { tries: 3 });
  eq(out[0].result, '0x01');
  eq(n, 2);
});

test('a real HTTP 400 that is not a JSON-RPC error still fails without retrying', async () => {
  let n = 0;
  _setTransport({ sleep: async () => {}, backoff: [0], timeouts: false, fetch: async () => {
    n++;
    return { ok: false, status: 400, json: async () => { throw new Error('not json'); } };
  } });
  let threw = false;
  try { await rpcBatch('drpc', [{ method: 'eth_call', params: [{ to: '0x0000000000000000000000000000000000000001', data: '0x' }, '0x1'] }], { tries: 3 }); }
  catch (e) { threw = /HTTP 400/.test(e.message); }
  ok(threw, 'should throw HTTP 400');
  eq(n, 1);
});
