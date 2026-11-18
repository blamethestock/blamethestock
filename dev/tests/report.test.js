// Launch report and wallet links: the pure rules (sniper statuses, same-block groups, dev moves, verdict wording),
// the step-by-step builder (free-plan budget, D1 jobs and cache, refresh, errors) and the wallet-links lookup.
// Offline. The OBSYN cases replay answers recorded once from Robinhood Chain and Blockscout
// (dev/tests/fixtures/obsyn/report-*.json, made by `dev/tools/record_obsyn.py --report`) through an injected fetch.
import { suite, test, eq, near, ok } from './harness.js';
import * as RR from '../../site/src/trust/report-rules.js';
import { ADDR, TOPIC } from '../../site/src/trust/facts.js';
import { POOL_MANAGER } from '../../site/src/data/constants.js';
import { _setTransport } from '../../site/src/data/rpc.js';
import { clearChainCaches } from '../../site/src/data/chain.js';
import { launchReport, memoryStore, d1Store, receiptInfo, advanceReportJobs, scopedBudget, REPORT_TTL, SQL } from '../../api/src/report.js';
import { walletLinks, buildLinks, advanceLinkJobs, IGNORED, labelOf } from '../../api/src/links.js';
import { createBudget } from '../../api/src/budget.js';
import { runLaunchReport } from '../../api/src/mcp.js';
import { replayFetch } from './fixtures/obsyn/replay.js';
import { loadReportFixture, runReportScenario, REPORT_SCENARIOS, OBSYN } from './fixtures/obsyn/report-replay.js';

const PROOF = /^https:\/\/robinhoodchain\.blockscout\.com\/(tx|address|token)\/0x[0-9a-f]+$/;
const HASH = /^0x[0-9a-f]{64}$/;
const BANNED = /\b(scam|scammer|safe|unsafe|rug|rugged|rugpull|should|buy now|sell now)\b/i;
const noSleep = async () => {};
const E18 = 10n ** 18n;
const raw = (tokens) => (BigInt(Math.round(tokens * 1e6)) * E18 / 1000000n).toString();
const SUPPLY = (10n ** 27n).toString();
const ad = (n) => '0x' + String(n).padStart(40, '0');
const tx = (n) => '0x' + String(n).padStart(64, '0');
const CURVE = ad(777);
const T0 = Date.parse('2026-11-17T14:14:00Z') / 1000;
const SNIPER_REAL = '0x0a70fea3ee47c8e64ea960135cb469afaab4fb49';

// =========================================================================================================
suite('launch report › rules');

test('addresses the rules use match facts.js and constants.js', () => {
  eq([RR.R_ADDR.ZERO, RR.R_ADDR.DEAD, RR.R_ADDR.ROUTER, RR.R_ADDR.LAUNCH_AND_BUY, RR.R_ADDR.POOL_MANAGER],
    [ADDR.ZERO, ADDR.DEAD, ADDR.ROUTER, ADDR.LAUNCH_AND_BUY, POOL_MANAGER]);
});

test('dev moves: burn, sell, send, buy; the launch buy and tokens from other wallets are not moves', () => {
  const dev = ad(1);
  const transfers = [
    { dir: 'in', other: CURVE, raw: raw(1000), tx: tx(1), block: 100, li: 1 },                  // the launch buy
    { dir: 'out', other: ad(9), raw: raw(300), tx: tx(2), block: 110, li: 0 },                   // send
    { dir: 'out', other: ADDR.DEAD, raw: raw(200), tx: tx(3), block: 120, li: 0 },               // burn
    { dir: 'out', other: ADDR.ZERO, raw: raw(50), tx: tx(4), block: 125, li: 0 },                // burn (to 0x0)
    { dir: 'out', other: ADDR.ROUTER, raw: raw(100), tx: tx(5), block: 130, li: 0 },             // sell via the router
    { dir: 'out', other: ad(8), raw: raw(100), tx: tx(6), block: 140, li: 0 },                   // sell through an aggregator
    { dir: 'out', other: ad(8), raw: raw(100), tx: tx(6), block: 140, li: 3 },                   //   (same tx: one move)
    { dir: 'in', other: POOL_MANAGER, raw: raw(500), tx: tx(7), block: 300, li: 0 },             // buy after graduation
    { dir: 'in', other: ad(5), raw: raw(42), tx: tx(8), block: 310, li: 0 },                     // a gift: not a move
  ];
  const txInfo = {
    [tx(5)]: { curveSell: (2n * 10n ** 16n).toString(), curveBuy: null, v4Quote: null, swap: false },
    [tx(6)]: { curveSell: null, curveBuy: null, v4Quote: (3n * 10n ** 16n).toString(), swap: true },
    [tx(7)]: { curveSell: null, curveBuy: null, v4Quote: (5n * 10n ** 16n).toString(), swap: true },
    [tx(2)]: { curveSell: null, curveBuy: null, v4Quote: null, swap: false },
  };
  const times = { 110: T0 + 10, 120: T0 + 20, 125: T0 + 25, 130: T0 + 30, 140: T0 + 40, 300: T0 + 3000 };
  const r = RR.devMoves({ transfers, txInfo, times, curve: CURVE, launchTx: tx(1), grad: { block: 200, time: T0 + 2000 }, supplyRaw: SUPPLY });
  eq(r.moves.map((m) => [m.type, m.tokens, m.to || null, m.afterGraduation]), [
    ['send', 300, ad(9), false], ['burn', 200, null, false], ['burn', 50, null, false], ['sell', 100, null, false],
    ['sell', 200, null, false], ['buy', 500, null, true]]);
  eq(r.moves.map((m) => m.eth === undefined ? 'none' : m.eth), ['none', 'none', 'none', 0.02, 0.03, 0.05]);
  near(r.moves[0].pct, 0.00003, 1e-12);
  eq(r.moves[0].time, '2026-11-17T14:14:10Z');
  near(r.soldPct, 0.00003, 1e-12, '300 tokens sold of 1,000,000,000');
  eq(r.received, { tokens: 42, wallets: [ad(5)] });
  ok(r.moves.every((m) => m.tx && m.block), 'each move has its proof tx and block');
});

test('sniper status: holding, partly sold, sold on the curve, sold after graduation, moved is not sold', () => {
  const grad = { block: 200, time: T0 + 2000 };
  const times = { 150: T0 + 1500, 205: T0 + 2023, 210: T0 + 2026 };
  const S = (flow) => RR.sniperStatus(flow, { grad, times });
  eq(S({ receivedRaw: raw(100), movedRaw: '0', sells: [] }).status, 'holding');
  eq(S(undefined).status, 'holding');
  const part = S({ receivedRaw: raw(100), movedRaw: '0', sells: [{ raw: raw(40), block: 150, tx: tx(1) }] });
  eq([part.status, part.soldPct, part.sellTx], ['partly-sold', 40, tx(1)]);
  const curve = S({ receivedRaw: raw(100), movedRaw: '0', sells: [{ raw: raw(60), block: 140, tx: tx(1) }, { raw: raw(40), block: 150, tx: tx(2) }] });
  eq([curve.status, curve.soldPct, curve.sellTx, curve.sellTime], ['sold-on-curve', 100, tx(2), '2026-11-17T14:39:00Z']);
  const after = S({ receivedRaw: raw(100), movedRaw: '0', sells: [{ raw: raw(75), block: 150, tx: tx(1) }, { raw: raw(10), block: 205, tx: tx(2) }, { raw: raw(15), block: 210, tx: tx(3) }] });
  eq([after.status, after.secondsAfterGraduation, after.firstSellAfterGraduationSeconds, after.soldAfterGraduationPct], ['sold-after-graduation', 26, 23, 25]);
  // 0.1% left is dust (sold all); 0.2% left is not
  eq(S({ receivedRaw: raw(1000), movedRaw: '0', sells: [{ raw: raw(999), block: 150, tx: tx(1) }] }).status, 'sold-on-curve');
  eq(S({ receivedRaw: raw(1000), movedRaw: '0', sells: [{ raw: raw(998), block: 150, tx: tx(1) }] }).status, 'partly-sold');
  // sent most of it to another wallet and sold a little: not "sold all"
  const moved = S({ receivedRaw: raw(100), movedRaw: raw(90), sells: [{ raw: raw(10), block: 150, tx: tx(1) }] });
  eq([moved.status, moved.movedPct, moved.soldPct], ['partly-sold', 90, 10]);
  eq(RR.sniperStatus({ receivedRaw: raw(10), movedRaw: '0', sells: [{ raw: raw(10), block: 250, tx: tx(1) }] }, { grad: null }).status, 'sold-on-curve', 'never graduated: every sell is on the curve');
});

test('same-block groups: 3 or more first buyers in one block', () => {
  const w = (n, block) => ({ address: ad(n), block });
  eq(RR.sameBlockClusters([w(1, 5), w(2, 5), w(3, 5), w(4, 6), w(5, 6), w(6, 7)]), [{ block: 5, wallets: [ad(1), ad(2), ad(3)] }]);
  eq(RR.sameBlockClusters([w(1, 5), w(2, 5)]), []);
});

test('sniper report: totals, seconds after launch, window seconds, statuses', () => {
  const buys = [{ wallet: ad(1), raw: raw(1e8), block: 133, tx: tx(1) }, { wallet: ad(2), raw: raw(5e7), block: 136, tx: tx(2) }];
  const flows = { [ad(1)]: { receivedRaw: raw(1e8), movedRaw: '0', sells: [] } };
  const times = { 100: T0, 133: T0 + 3, 136: T0 + 4, 148: T0 + 5 };
  const s = RR.sniperReport({ buys, flows, times, launch: { block: 100, time: T0 }, supplyRaw: SUPPLY, windowBlocks: 48 });
  eq([s.windowBlocks, s.windowSeconds, s.totalPct, s.spanSeconds], [48, 5, 15, 4]);
  eq(s.wallets.map((w) => [w.address, w.pct, w.blocksAfterLaunch, w.secondsAfterLaunch, w.status]), [[ad(1), 10, 33, 3, 'holding'], [ad(2), 5, 36, 4, null]],
    'a wallet whose transfers were not read has no status');
});

test('verdict: sniper sentence by share, graduation and how fast they sold', () => {
  const ws = (list) => list.map(([status, sec], i) => ({ address: ad(i), status, secondsAfterGraduation: sec }));
  const sn = (totalPct, list, spanSeconds = 3) => ({ totalPct, spanSeconds, windowSeconds: 5, wallets: ws(list) });
  const grad = { time: '2026-11-17T19:31:25Z' };
  const nine = Array(8).fill(['sold-on-curve']).concat([['sold-after-graduation', 26]]);
  eq(RR.sniperSentence(sn(20.5132, nine), grad), 'Heavily sniped by bots (20.5% in 3 s; 8 of 9 sold before graduation, 1 just after).');
  eq(RR.sniperSentence(sn(20.5132, Array(8).fill(['sold-on-curve']).concat([['sold-after-graduation', 61]])), grad),
    'Heavily sniped by bots (20.5% in 3 s; 8 of 9 sold before graduation, 1 after graduation).', '61 s is no longer "just after"');
  eq(RR.sniperSentence(sn(10, [['holding'], ['partly-sold']]), null), 'Heavily sniped by bots (10% in 3 s; 1 of 2 partly sold, 1 still holding).');
  eq(RR.sniperSentence(sn(9.99, [['sold-on-curve'], ['sold-on-curve']]), null), 'Sniped by bots (10% in 3 s; all 2 sold on the curve).');
  eq(RR.sniperSentence(sn(3, [['sold-on-curve'], ['holding']]), null), 'Sniped by bots (3% in 3 s; 1 of 2 sold on the curve, 1 still holding).');
  eq(RR.sniperSentence(sn(2.99, [['holding']], 0), null), 'Lightly sniped by bots (3% in 1 s by 1 wallet; 1 of 1 still holding).');
  eq(RR.sniperSentence(sn(0.04, [[null]]), null), 'Lightly sniped by bots (0.04% in 3 s by 1 wallet).');
  eq(RR.sniperSentence({ totalPct: 0, wallets: [], windowSeconds: 5 }, null), 'No first buyers besides the dev in the first 5 s.');
});

test('verdict: dev sentence and wallet-links sentence', () => {
  const base = { address: ad(1), buy: { pct: 1 }, moves: [], soldPct: 0, fees: { claimedEth: 2.0735 }, bridges: [{ eth: 0.18 }] };
  eq(RR.devSentence(base), 'Dev claimed 2.07 ETH in fees, bridged 0.18 ETH out and sold nothing.');
  eq(RR.devSentence({ ...base, fees: { claimedEth: 0 }, bridges: [] }), 'Dev sold nothing.');
  const fast = { ...base, launchTime: '2026-11-17T14:02:15Z', soldPct: 0.8586, buy: { pct: 0.8586 }, moves: [{ type: 'sell', time: '2026-11-17T14:03:26Z' }], fees: { claimedEth: 0.0258 }, bridges: [{ eth: 0.0473 }] };
  eq(RR.devSentence(fast), 'Dev claimed 0.0258 ETH in fees, bridged 0.0473 ETH out and sold their whole launch buy 1 min 11 s after launch.');
  eq(RR.devSentence({ ...fast, soldPct: 0.4293 }), 'Dev claimed 0.0258 ETH in fees, bridged 0.0473 ETH out and sold 50% of their launch buy.');
  eq(RR.devSentence({ ...base, moves: null }), 'Dev claimed 2.07 ETH in fees and bridged 0.18 ETH out.', 'moves unread: nothing said about selling');
  eq(RR.devSentence(null), 'The dev\'s moves couldn\'t be read right now.');
  const links = (list) => ({ ok: true, status: 'done', dev: ad(1), links: list });
  eq(RR.linkSentence(links([])), 'No dev link found.');
  eq(RR.linkSentence(links([{ wallets: [ad(1), ad(2), ad(3)], involvesDev: true, strength: 'strong' }])), 'Dev linked by funding to 2 first buyers.');
  eq(RR.linkSentence(links([{ wallets: [ad(1), ad(2)], involvesDev: true, strength: 'weak' }])), 'No dev link found.', 'a busy service paying both is not a link');
  eq(RR.linkSentence({ ok: true, status: 'building' }), '');
  eq(RR.linkSentence(null), '');
});

test('activity: every hour from launch, zero hours filled; times between known blocks', () => {
  const h = RR.hourStart(T0);
  eq(RR.activityHours({ [h]: { buys: 5, newWallets: 4 }, [h + 7200]: { buys: 1, newWallets: 0 } }, T0, T0 + 2.5 * 3600), [
    { hourStart: '2026-11-17T14:00:00Z', buys: 5, newWallets: 4 }, { hourStart: '2026-11-17T15:00:00Z', buys: 0, newWallets: 0 },
    { hourStart: '2026-11-17T16:00:00Z', buys: 1, newWallets: 0 }]);
  eq(RR.interpolateTime(150, { block: 100, time: 1000 }, { block: 200, time: 1010 }), 1005);
  eq(RR.activityHours({}, null, 5), []);
});

test('wording: no scam/safe/advice words in notes, caveats or verdicts', () => {
  const texts = RR.REPORT_CAVEATS.concat(RR.howWeGotThis({ viaMulticall: true }));
  texts.push(RR.sniperSentence({ totalPct: 30, spanSeconds: 2, wallets: [{ address: ad(1), status: 'holding' }] }, null));
  for (const t of texts) ok(!BANNED.test(t), t);
  ok(RR.REPORT_CAVEATS.some((c) => /exchanges, bridges or privacy tools can't be linked/.test(c)));
  ok(RR.REPORT_CAVEATS.some((c) => /not financial advice/.test(c)));
});

test('receipt info: curve sell, curve buy for the wallet, swaps on the coin\'s pool (signed amounts)', () => {
  const w = (v) => (v < 0n ? (1n << 256n) + v : v).toString(16).padStart(64, '0');
  const pool = { id: '0x' + 'ab'.repeat(32), currency0: ADDR.ZERO, currency1: ad(5) };
  const rc = { logs: [
    { address: CURVE, topics: [TOPIC.CURVE_SELL, '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)], data: '0x' + w(7n) + w(16n) },
    { address: CURVE, topics: [TOPIC.CURVE_BUY, '0x' + '0'.repeat(64), '0x' + '0'.repeat(24) + ad(1).slice(2)], data: '0x' + w(20n) + w(99n) },
    { address: POOL_MANAGER, topics: ['0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', pool.id], data: '0x' + w(-25n) + w(1000n) },
    { address: POOL_MANAGER, topics: ['0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', '0x' + 'cd'.repeat(32)], data: '0x' + w(-5n) + w(1n) },
  ] };
  eq(receiptInfo(rc, { curve: CURVE, wallet: ad(1), pool, pairToken: ADDR.ZERO }), { curveSell: '16', curveBuy: '20', v4Quote: '25', swap: true });
  eq(receiptInfo(null, { curve: CURVE, wallet: ad(1) }), { curveSell: null, curveBuy: null, v4Quote: null, swap: false });
});

// =========================================================================================================
suite('launch report › OBSYN (recorded from the chain)');

const results = new Map();
async function scenario(name) {
  if (!results.has(name)) {
    const fx = await loadReportFixture();
    const sc = REPORT_SCENARIOS.find((s) => s.name === name);
    const misses = { rpc: new Map(), explorer: new Set() };
    const r = await runReportScenario(sc, fx, { misses });
    if (misses.rpc.size || misses.explorer.size) {
      throw new Error('request not in the fixture (re-record with dev/tools/record_obsyn.py --report): ' + [...misses.rpc.keys(), ...misses.explorer][0]);
    }
    results.set(name, r);
  }
  return results.get(name);
}

test('fixture: pinned to the copy check\'s head block', async () => {
  const fx = await loadReportFixture();
  eq(fx.index.head.number, 117273262);
  ok(Object.keys(fx.rpc).length > 50 && Object.keys(fx.explorer).length > 10);
});

test('real OBSYN: launch, dev wallet and the dev buy (1.142161%)', async () => {
  const { again: r } = await scenario('real OBSYN');
  eq([r.ok, r.status], [true, 'done']);
  eq(r.token.address, OBSYN.real);
  eq([r.token.symbol, r.token.name, r.token.isOfficial], ['OBSYN', 'obsyn', false]);
  eq(r.token.pons, { factory: '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e', curve: '0x1d6a7a3fab6592cb5e6aa5873b915bc6f93b0499',
    launchTx: '0xec919f76f60857d7e76be568966af6e3e1f8b3b0e590d77276c5bbb37419df0c', launchBlock: 116638986, launchTime: '2026-11-17T14:14:00Z', pairToken: '0x0000000000000000000000000000000000000000' });
  eq([r.asOfBlock, r.asOf], [117273262, '2026-11-18T08:46:07Z']);
  eq([r.dev.address, r.dev.viaMulticall], ['0x03412baadd3d3207506e89cebb051ab713295c32', false]);
  near(r.dev.buy.pct, 1.142161, 1e-6);
  near(r.dev.buy.tokens, 11421611.03, 0.01);
  near(r.dev.buy.eth, 0.02, 1e-12);
  eq(r.dev.buy.tx, r.token.pons.launchTx);
});

test('real OBSYN: dev sent 5.1M, burned 6.32M, bought after graduation, burned those, never sold', async () => {
  const { again: r } = await scenario('real OBSYN');
  const m = r.dev.moves;
  eq([m[0].type, m[0].tokens, m[0].to, m[0].time, m[0].afterGraduation], ['send', 5100000, '0xf80b926e549e8dff2ade45132afbdbb240e354e9', '2026-11-17T14:53:10Z', false]);
  eq([m[1].type, m[1].time, m[1].tx], ['burn', '2026-11-17T15:21:11Z', '0xc899805eec47c3cf4bf0f46ab7df7a2ce93e189daa796c55a93ca7d9f5ae1365']);
  near(m[1].tokens, 6321611.03, 0.01);
  const buys = m.slice(2, 6);
  eq(buys.map((x) => [x.type, x.time, x.afterGraduation]), [['buy', '2026-11-17T19:48:21Z', true], ['buy', '2026-11-17T20:36:05Z', true],
    ['buy', '2026-11-18T00:09:09Z', true], ['buy', '2026-11-18T01:08:57Z', true]]);
  near(buys.reduce((s, x) => s + x.tokens, 0), 3336012.41, 0.01, 'the 4 buys add up to what was burned at 01:13:18');
  near(buys.reduce((s, x) => s + x.eth, 0), 0.0720, 0.0005, 'ETH into the pool (the 0.075 sent includes the buying contract\'s cut)');
  eq([m[6].type, m[6].time, m[6].afterGraduation], ['burn', '2026-11-18T01:13:18Z', true]);
  near(m[6].tokens, 3336012.41, 0.01);
  // recorded after the research: one more buy at 06:49:47 on 18 Nov (still held at the recorded block)
  eq(m.slice(7).map((x) => [x.type, x.time]), [['buy', '2026-11-18T06:49:47Z']]);
  ok(!m.some((x) => x.type === 'sell'), 'no sells');
  eq(r.dev.soldPct, 0);
  for (const x of m) ok(HASH.test(x.tx), x.tx);
});

test('real OBSYN: fees claimed 0.482236 at 19:27:05 (+1.5913 at 08:28:18), bridged 0.18 ETH to Base at 20:06:56', async () => {
  const { again: r } = await scenario('real OBSYN');
  eq(r.dev.fees.claims.map((c) => c.time), ['2026-11-17T19:27:05Z', '2026-11-18T08:28:18Z']);
  near(r.dev.fees.claims[0].eth, 0.482236, 1e-6);
  near(r.dev.fees.claims[1].eth, 1.591307, 1e-6);
  near(r.dev.fees.claimedEth, 2.073543, 1e-6);
  // unclaimed is the escrow's live balance when the fixture was recorded (moves with every trade)
  ok(r.dev.fees.unclaimedEth >= 0 && r.dev.fees.unclaimedEth < 1, String(r.dev.fees.unclaimedEth));
  eq(r.dev.bridges, [{ via: 'MetaBridge/Across', eth: 0.18, time: '2026-11-17T20:06:56Z', tx: '0xb3eeafcb1ee0689d4d53b115e3f5b399be923531c79c6e878d95e4ae7408131b', destChainId: 8453, destChainConfirmed: true }]);
});

test('real OBSYN: exactly 9 first buyers took 20.51% in 3 s; 8 sold on the curve, 0x0a70 sold 23-26 s after graduation', async () => {
  const { again: r } = await scenario('real OBSYN');
  const s = r.snipers;
  eq([s.windowBlocks, s.windowSeconds, s.spanSeconds], [48, 5, 3]);
  eq(s.wallets.length, 9);
  near(s.totalPct, 20.5132, 0.0001);
  ok(s.wallets.every((w) => w.blocksAfterLaunch >= 33 && w.blocksAfterLaunch <= 36 && w.secondsAfterLaunch === 3));
  const ws = s.wallets.map((w) => w.address);
  ok(!ws.includes(ADDR.ROUTER) && !ws.includes(ADDR.LAUNCH_AND_BUY) && !ws.includes(r.dev.address), 'no router, LaunchAndBuy or dev');
  eq(s.wallets.filter((w) => w.status === 'sold-on-curve').length, 8);
  const late = s.wallets.find((w) => w.status === 'sold-after-graduation');
  eq([late.address, late.firstSellAfterGraduationSeconds, late.secondsAfterGraduation, late.sellTx],
    [SNIPER_REAL, 23, 26, '0x25e51f845e0bb4c9ddf42541f397f50ef76901ff42adf431cf4dfc83a89c32c7']);
  near(late.soldAfterGraduationPct, 25, 0.001, 'its last quarter');
  ok(s.wallets.every((w) => w.soldPct === 100));
  for (const w of s.wallets.filter((x) => x.status === 'sold-on-curve')) ok(Date.parse(w.sellTime) < Date.parse(r.graduation.time), w.address);
  eq(s.clusters.map((c) => [c.block - 116638986, c.wallets.length]), [[33, 5], [36, 3]]);
});

test('real OBSYN: graduation 19:31:25 (block 116825292), hourly activity until then', async () => {
  const { again: r } = await scenario('real OBSYN');
  eq(r.graduation, { time: '2026-11-17T19:31:25Z', tx: '0x493778200eb20f599eead6f8fcfa9dce5dc8935d0a900a696d544b57b83497d4', block: 116825292 });
  const h = r.activity.hours;
  eq(h.map((x) => x.hourStart.slice(11, 13)), ['14', '15', '16', '17', '18', '19']);
  eq([r.activity.complete, r.activity.until, r.activity.curveBuysOnly], [true, '2026-11-17T19:31:25Z', true]);
  ok(h[0].buys >= 10 && h[0].newWallets >= 10, 'the dev and the 9 first buyers are in the first hour');
  ok(h.every((x) => x.buys >= x.newWallets));
  ok(PROOF.test(r.activity.proof));
});

test('real OBSYN: the verdict (links included once they are done)', async () => {
  const { report, links, again } = await scenario('real OBSYN');
  eq(report.verdict, 'Heavily sniped by bots (20.5% in 3 s; 8 of 9 sold before graduation, 1 just after). Dev claimed 2.07 ETH in fees, bridged 0.18 ETH out and sold nothing.',
    'first answer: the links are not in yet');
  eq(links.status, 'done');
  eq(again.verdict, 'Heavily sniped by bots (20.5% in 3 s; 8 of 9 sold before graduation, 1 just after). No dev link found. Dev claimed 2.07 ETH in fees, bridged 0.18 ETH out and sold nothing.');
  ok(!BANNED.test(again.verdict));
});

test('real OBSYN: every number has a Blockscout proof; notes, caveats, nothing missing', async () => {
  const { again: r } = await scenario('real OBSYN');
  for (const k of ['token', 'creator', 'launchTx', 'curve', 'graduationTx', 'escrow']) ok(PROOF.test(r.proof[k]), k + ' ' + r.proof[k]);
  const hashes = [r.dev.buy.tx, ...r.dev.moves.map((m) => m.tx), ...r.dev.fees.claims.map((c) => c.tx), ...r.dev.bridges.map((b) => b.tx),
    ...r.snipers.wallets.flatMap((w) => [w.buyTx, w.sellTx]), r.graduation.tx];
  for (const h of hashes) ok(HASH.test(h), String(h));
  eq(r.missing, []);
  ok(r.notes.length >= 6 && r.notes.some((n) => /^First buyers: CurveBuy events in the launch block and the next 48 blocks/.test(n)));
  ok(r.caveats.some((c) => /exchanges, bridges or privacy tools can't be linked/.test(c)));
  for (const t of r.notes.concat(r.caveats)) ok(!BANNED.test(t), t);
});

test('copycat 0x7a2A: dev sold the whole buy at +71 s, claimed 0.0258 ETH, bridged 0.0473 ETH via Relay, never graduated', async () => {
  const { again: r } = await scenario('copycat OBSYN');
  eq([r.token.address, r.token.pons.launchTime, r.dev.address], [OBSYN.copy, '2026-11-17T14:02:15Z', '0xf67bb00a4cd3862fa68a0fe151fbcfec291eb2fd']);
  near(r.dev.buy.pct, 0.858635, 1e-6);
  const sells = r.dev.moves.filter((m) => m.type === 'sell');
  eq(sells.map((m) => [m.time, m.tx]), [['2026-11-17T14:03:26Z', '0x9ce4cb2b18fbbf25ea6e1e353ad56525f554a8d29cf23e6838cff2267affc4f7']]);
  near(sells[0].eth, 0.016305, 1e-6);
  near(r.dev.soldPct, r.dev.buy.pct, 1e-6, 'the whole launch buy');
  eq(r.dev.fees.claims.map((c) => c.time), ['2026-11-17T14:04:00Z']);
  near(r.dev.fees.claimedEth, 0.025814, 1e-6);
  eq(r.dev.bridges.map((b) => [b.via, b.time, b.destChainId, b.destChainConfirmed]), [['MetaBridge/Relay', '2026-11-17T14:05:27Z', 56, false]]);
  near(r.dev.bridges[0].eth, 0.047287, 1e-6);
  eq(r.graduation, null);
  eq(r.snipers.wallets.length, 10);
  ok(r.snipers.wallets.every((w) => w.status === 'sold-on-curve'));
  eq(r.activity.complete, false, 'never graduated and younger than 24 h at the recorded block');
  eq(r.verdict, 'Heavily sniped by bots (21% in 5 s; all 10 sold on the curve). No dev link found. Dev claimed 0.0258 ETH in fees, bridged 0.0473 ETH out and sold their whole launch buy 1 min 11 s after launch.');
});

test('the same 9 wallets first-bought the copycat and the real OBSYN', async () => {
  const real = (await scenario('real OBSYN')).again.snipers.wallets.map((w) => w.address);
  const copy = (await scenario('copycat OBSYN')).again.snipers.wallets.map((w) => w.address);
  eq(real.filter((w) => copy.includes(w)).sort(), real.slice().sort());
  eq(copy.filter((w) => !real.includes(w)), ['0x17dcb7e012a9957e26f9948ff47fef6452aa59db']);
});

// =========================================================================================================
suite('launch report › wallet links (recorded)');

test('real OBSYN: who funded the dev and the 9 first buyers; public services link nobody; no dev link', async () => {
  const { links: l, linkCalls } = await scenario('real OBSYN');
  eq(linkCalls.map((x) => x.status), ['building', 'done'], 'a first look takes two calls (explorer pages per call are capped)');
  eq([l.ok, l.status, l.dev], [true, 'done', '0x03412baadd3d3207506e89cebb051ab713295c32']);
  eq(l.funders.length, 10);
  const dev = l.funders[0];
  eq([dev.role, dev.funder, dev.kind, dev.label, dev.time, dev.tx], ['dev', '0xa8ad2e87e2043711d8bec77e8bc3e2683c0ab6bd', 'public-service', 'Across MulticallHandler',
    '2026-11-17T14:10:13Z', '0x9161425c5df5cf1aa0e958e848df438b7ba3ee21937efb110f732a9701b568a6']);
  near(dev.eth, 0.041721, 1e-6);
  ok(l.funders.slice(1).every((f) => f.role === 'sniper' && f.funder && ['wallet', 'public-service'].includes(f.kind)));
  eq(l.links.filter((x) => x.involvesDev), [], 'the sniper funded by the same Across handler got it 32 min earlier: no link');
  eq(l.links.filter((x) => x.strength === 'strong'), []);
  ok(l.ignored.some((x) => x.address === '0xa8ad2e87e2043711d8bec77e8bc3e2683c0ab6bd'));
  ok(l.ignored.some((x) => x.address === '0x53091256ebd2d8aa37b45536a5fd864ca764f32f' && /too many transactions since 2026-11-17/.test(x.why)),
    'a funder too busy to count is a public service (the recorded pages never reach the funding day, so "paid more than 25" isn\'t claimed)');
  eq(l.caveat, 'Wallets funded through exchanges, bridges or privacy tools can\'t be linked.');
  for (const f of l.funders) ok(HASH.test(f.tx), f.wallet);
  for (const x of l.links) for (const u of x.proof) ok(PROOF.test(u), u);
});

test('copycat: the dev was funded by Across\'s SpokePool, also a public service', async () => {
  const { links: l } = await scenario('copycat OBSYN');
  eq([l.status, l.funders[0].funder, l.funders[0].kind, l.funders[0].time], ['done', '0xd29c85f15df544ba632c9e25829fd29d767d7978', 'public-service', '2026-11-17T13:43:01Z']);
  eq(l.funders.length, 11);
  eq(l.links.filter((x) => x.involvesDev && x.strength === 'strong'), []);
});

test('links are cached: asking again reads nothing from the network', async () => {
  const { store } = await scenario('real OBSYN');
  const fx = await loadReportFixture();
  const log = [];
  const f = replayFetch(fx, { log });
  _setTransport({ fetch: f, sleep: noSleep, backoff: [0], timeouts: false });
  const now = (fx.index.head.time + 3600) * 1000;
  const r = await walletLinks({ token: OBSYN.real, store, now, budget: createBudget({ fetch: f }), sleep: noSleep });
  eq([r.status, log.length], ['done', 0]);
});

test('explorer busy (429) or a Cloudflare challenge: links "unavailable", never a throw; the report still works', async () => {
  const fx = await loadReportFixture();
  for (const mode of ['down', 'challenge']) {
    const log = [];
    const r = await runReportScenario(REPORT_SCENARIOS[0], fx, { explorer: mode, log });
    eq([r.report.ok, r.report.status], [true, 'done'], mode);
    eq(r.links.status, 'unavailable', mode);
    eq([r.links.ok, r.links.links, r.links.funders], [true, [], []]);
    ok(/Try again/.test(r.links.message));
    // with the explorer down, MetaBridge calls can't be seen: the Across log still shows the bridge (amount after fees)
    eq(r.report.dev.bridges.map((b) => [b.via, b.destChainId]), [['Across', 8453]], mode);
    near(r.report.dev.bridges[0].eth, 0.178425, 1e-6);
    eq(r.report.missing, ['bridges'], mode);
    ok(r.report.notes.some((n) => /explorer was unavailable/.test(n)));
    const explorerCalls = log.filter((k) => k.startsWith('GET '));
    if (mode === 'challenge') eq(explorerCalls.length, 2, 'one request each for the report and the links: a challenge is never retried');
    ok(!/No dev link found/.test(r.again.verdict), 'no link sentence without finished links');
  }
});

test('buildLinks: same funder = link; a public service only within 60 s, as a weak link', () => {
  const f = (wallet, funder, kind, time, role = 'sniper') => ({ wallet, role, funder, kind, time, tx: tx(wallet.slice(-2)) });
  const T = (s) => new Date((T0 + s) * 1000).toISOString().replace('.000Z', 'Z');
  const fs = [f(ad(1), ad(50), 'wallet', T(0), 'dev'), f(ad(2), ad(50), 'wallet', T(5000)), f(ad(3), IGNORED && '0xd29c85f15df544ba632c9e25829fd29d767d7978', 'public-service', T(100)),
    f(ad(4), '0xd29c85f15df544ba632c9e25829fd29d767d7978', 'public-service', T(160)), f(ad(5), '0xd29c85f15df544ba632c9e25829fd29d767d7978', 'public-service', T(221)),
    f(ad(6), null, 'unknown', null)];
  fs[2].label = 'Across SpokePool';
  const { links, ignored } = buildLinks(fs, { dev: ad(1) });
  eq(links.map((l) => [l.strength, l.wallets, l.involvesDev]), [['strong', [ad(1), ad(2)], true], ['weak', [ad(3), ad(4)], false]]);
  ok(/within 60 s of each other/.test(links[1].reason) && /chance/.test(links[1].reason));
  eq(ignored.map((x) => x.address), ['0xd29c85f15df544ba632c9e25829fd29d767d7978']);
  for (const l of links) for (const u of l.proof) ok(PROOF.test(u), u);
  eq(labelOf({ hash: ad(1), name: 'OutputSettlerSimple' }), 'OutputSettlerSimple');
  eq(labelOf({ hash: ad(1), public_tags: [{ display_name: 'Exchange 7' }] }), 'Exchange 7');
  eq(labelOf({ hash: ad(1) }), null);
});

test('ignore list holds the services the plan names', () => {
  for (const a of ['0xd29c85f15df544ba632c9e25829fd29d767d7978', '0xa8ad2e87e2043711d8bec77e8bc3e2683c0ab6bd', ADDR.ROUTER, ADDR.METABRIDGE, ADDR.RELAY_DEPOSITORY, ADDR.MULTICALL3, ADDR.LAUNCH_AND_BUY]) {
    ok(IGNORED[a], a);
  }
});

// =========================================================================================================
suite('launch report › free plan (budget, steps, D1)');

// Calls launchReport until it is done, each call with a fresh budget of `limit` fetches.
async function inSteps(token, limit, { store = null, max = 40 } = {}) {
  const fx = await loadReportFixture();
  clearChainCaches();
  const log = [];
  const f = replayFetch(fx, { log });
  _setTransport({ fetch: f, sleep: noSleep, backoff: [0], timeouts: false });
  const st = store || memoryStore({ rows: fx.index.rows });
  const now = (fx.index.head.time + 60) * 1000;
  const calls = [];
  for (let i = 0; i < max; i++) {
    const b = createBudget({ limit, fetch: f });
    const before = log.length;
    const r = await launchReport({ token, store: st, now: now + i * 1000, budget: b, sleep: noSleep });
    calls.push({ r, fetches: b.used, refused: b.refused, keys: log.length - before });
    if (r.status !== 'building') break;
  }
  return { calls, store: st, log };
}

test('every call stays under its subrequest budget; with a small one the report is built over several calls, the same', async () => {
  const whole = await inSteps(OBSYN.real, 45);
  for (const c of whole.calls) ok(c.fetches <= 40, 'the report never takes more than 40 of a request\'s 50: ' + c.fetches);
  eq(whole.calls[whole.calls.length - 1].r.status, 'done');
  const { calls } = await inSteps(OBSYN.real, 8);
  ok(calls.length >= 3, 'several calls: ' + calls.length);
  for (const c of calls) ok(c.fetches <= 8, 'fetches ' + c.fetches);
  const building = calls.slice(0, -1).map((c) => c.r);
  ok(building.every((r) => r.ok && r.status === 'building' && r.progress >= 0 && r.progress < 1), JSON.stringify(building.map((r) => r.progress)));
  for (let i = 1; i < building.length; i++) ok(building[i].progress >= building[i - 1].progress, 'progress never goes back');
  const last = calls[calls.length - 1].r;
  const one = (await scenario('real OBSYN')).report;
  eq(last, one, 'same report as one big call');
});

test('the report\'s share of a request budget: its own cap, the request\'s room, refusals from either', async () => {
  let n = 0;
  const base = async () => { n++; return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) }; };
  const parent = createBudget({ limit: 5, fetch: base });
  const s = scopedBudget(parent, null, 3);
  await s.fetch('x', {});
  await s.fetch('x', {});
  eq([s.used, parent.used, s.remaining(), s.has(1), s.has(2)], [2, 2, 1, true, false]);
  await s.fetch('x', {});
  const refused = await s.fetch('x', {});
  eq([n, s.refused, parent.used, refused.headers.get('x-budget')], [3, 1, 3, 'exhausted'], 'over its own cap: refused, never sent');
  const s2 = scopedBudget(parent, null, 40);
  eq(s2.remaining(), 2, 'never more than the request has left');
  await parent.fetch('y', {});                      // someone else in the request spends one
  await s2.fetch('x', {});
  await s2.fetch('x', {});
  eq([n, parent.refused, s2.refused], [5, 1, 1], 'the request\'s own limit refuses too, and the report sees it');
  ok(scopedBudget(s2, null, 10) === s2, 'wrapping twice changes nothing');
});

test('a small budget (12 subrequests a call) still finishes, never over budget', async () => {
  const fx = await loadReportFixture();
  clearChainCaches();
  const f = replayFetch(fx, {});
  _setTransport({ fetch: f, sleep: noSleep, backoff: [0], timeouts: false });
  const st = memoryStore({ rows: fx.index.rows });
  const now = (fx.index.head.time + 60) * 1000;
  let r, n = 0;
  for (; n < 80; n++) {
    const parent = createBudget({ limit: 12, fetch: f });
    r = await launchReport({ token: OBSYN.copy, store: st, now: now + n * 1000, budget: parent, sleep: noSleep });
    ok(parent.used <= 12, 'used ' + parent.used);
    if (r.status !== 'building') break;
  }
  eq(r.status, 'done', 'after ' + n + ' calls');
  eq(r.verdict, (await scenario('copycat OBSYN')).report.verdict);
});

test('cache: a finished report is served without fetching; after 5 minutes it refreshes from the last block read', async () => {
  const fx = await loadReportFixture();
  const { store } = await scenario('real OBSYN');
  const log = [];
  const f = replayFetch(fx, { log });
  _setTransport({ fetch: f, sleep: noSleep, backoff: [0], timeouts: false });
  const t = (fx.index.head.time + 60) * 1000;
  const a = await launchReport({ token: OBSYN.real, store, now: t + 60000, budget: createBudget({ fetch: f }), sleep: noSleep });
  eq([a.status, log.length], ['done', 0], 'fresh: no fetch');
  const b = await launchReport({ token: OBSYN.real, store, now: t + (REPORT_TTL + 120) * 1000, budget: createBudget({ fetch: f }), sleep: noSleep });
  eq(b.status, 'done');
  eq(log, ['eth_getBlockByNumber|["latest",false]'], 'stale: the head is read; it hasn\'t moved, so nothing else');
  eq(b.verdict, a.verdict);
});

test('one worker per job: while another request holds it, answer "building" (or the old report) without fetching', async () => {
  const fx = await loadReportFixture();
  const st = memoryStore({ rows: fx.index.rows });
  const nowS = fx.index.head.time;
  ok(await st.claimJob('report:' + OBSYN.real, 'report', OBSYN.real, nowS));
  const log = [];
  const f = replayFetch(fx, { log });
  _setTransport({ fetch: f, sleep: noSleep, backoff: [0], timeouts: false });
  const r = await launchReport({ token: OBSYN.real, store: st, now: (nowS + 5) * 1000, budget: createBudget({ fetch: f }), sleep: noSleep });
  eq([r.ok, r.status, log.length], [true, 'building', 0]);
});

test('cron: a report someone asked for is finished by advanceReportJobs, then the links by advanceLinkJobs', async () => {
  const fx = await loadReportFixture();
  clearChainCaches();
  const f = replayFetch(fx, {});
  _setTransport({ fetch: f, sleep: noSleep, backoff: [0], timeouts: false });
  const st = memoryStore({ rows: fx.index.rows });
  const t = (fx.index.head.time + 60) * 1000;
  const first = await launchReport({ token: OBSYN.copy, store: st, now: t, budget: createBudget({ limit: 10, fetch: f }), sleep: noSleep });
  eq(first.status, 'building');
  let done = false;
  for (let i = 1; i < 30 && !done; i++) {
    const out = await advanceReportJobs({ store: st, now: t + i * 60000, budget: createBudget({ limit: 45, fetch: f }), sleep: noSleep });
    done = out.done.includes(OBSYN.copy);
  }
  ok(done, 'the cron finished it');
  const r = await launchReport({ token: OBSYN.copy, store: st, now: t + 31 * 60000 - REPORT_TTL * 1000 + 1000, budget: createBudget({ limit: 0, fetch: f }), sleep: noSleep });
  eq(r.status, 'done');
  const l1 = await walletLinks({ token: OBSYN.copy, store: st, now: t + 40 * 60000, budget: createBudget({ limit: 6, fetch: f }), sleep: noSleep });
  eq(l1.status, 'building');
  let ldone = false;
  for (let i = 1; i < 10 && !ldone; i++) {
    const out = await advanceLinkJobs({ store: st, now: t + (40 + i) * 60000, budget: createBudget({ limit: 45, fetch: f }), sleep: noSleep });
    ldone = out.done.includes(OBSYN.copy);
  }
  ok(ldone, 'the cron finished the links');
});

// A tiny chain for error cases: the head, and every eth_call answering `call(to, data)`.
function fakeChain({ call = () => '0x', down = false } = {}) {
  return async (url, init) => {
    if (down) return { ok: false, status: 503, headers: { get: () => null }, json: async () => ({}) };
    const body = JSON.parse(init.body);
    const list = Array.isArray(body) ? body : [body];
    const out = list.map((c) => {
      if (c.method === 'eth_getBlockByNumber') return { jsonrpc: '2.0', id: c.id, result: { number: '0x6fd8b2e', timestamp: '0x6b032f8f', hash: '0x' + '1'.repeat(64) } };
      if (c.method === 'eth_call') return { jsonrpc: '2.0', id: c.id, result: call(c.params[0].to, c.params[0].data) };
      if (c.method === 'eth_getLogs') return { jsonrpc: '2.0', id: c.id, result: [] };
      return { jsonrpc: '2.0', id: c.id, result: null };
    });
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => (Array.isArray(body) ? out : out[0]) };
  };
}
const abiString = (s) => '0x' + (32).toString(16).padStart(64, '0') + s.length.toString(16).padStart(64, '0') + [...s].map((c) => c.charCodeAt(0).toString(16)).join('').padEnd(64, '0');

test('errors: bad address, not a token, not a Pons coin (cached for an hour), chain down (not cached)', async () => {
  eq((await launchReport({ token: '0x123' })).code, 'bad-address');
  eq((await walletLinks({ token: 'OBSYN' })).code, 'bad-address');
  clearChainCaches();
  const none = fakeChain();
  _setTransport({ fetch: none, sleep: noSleep, backoff: [0], timeouts: false });
  const st = memoryStore();
  const a = await launchReport({ token: ad(4242), store: st, now: 1794991567000, budget: createBudget({ fetch: none }), sleep: noSleep });
  eq([a.ok, a.code], [false, 'not-found']);
  const named = fakeChain({ call: (to, data) => (data === '0x06fdde03' || data === '0x95d89b41' ? abiString('FOO') : '0x') });
  _setTransport({ fetch: named, sleep: noSleep, backoff: [0], timeouts: false });
  const b = await launchReport({ token: ad(4343), store: st, now: 1794991567000, budget: createBudget({ fetch: named }), sleep: noSleep });
  eq([b.ok, b.code], [false, 'not-pons']);
  ok(!BANNED.test(b.message));
  let n = 0;
  const counting = async (u, i) => { n++; return named(u, i); };
  _setTransport({ fetch: counting, sleep: noSleep, backoff: [0], timeouts: false });
  eq((await launchReport({ token: ad(4343), store: st, now: 1794991567000 + 60000, budget: createBudget({ fetch: counting }), sleep: noSleep })).code, 'not-pons');
  eq(n, 0, 'answered from the cache');
  const down = fakeChain({ down: true });
  _setTransport({ fetch: down, sleep: noSleep, backoff: [0], timeouts: false });
  const c = await launchReport({ token: ad(4444), store: st, now: 1794991567000, budget: createBudget({ fetch: down }), sleep: noSleep });
  eq([c.ok, c.code], [false, 'rpc-failed']);
  eq(st.cache.has('report:' + ad(4444)), false, 'a chain outage is not remembered');
  const l = await walletLinks({ token: ad(4444), store: st, now: 1794991567000 + 1000, budget: createBudget({ fetch: down }), sleep: noSleep });
  ok(l.ok === false || l.status === 'unavailable' || l.status === 'building', JSON.stringify(l));
});

test('D1: the SQL the report uses (placeholders, upsert with a lease, batch writes)', async () => {
  const seen = [];
  const db = {
    prepare(sql) {
      const s = { sql, args: [], bind(...a) { s.args = a; return s; },
        async first() { seen.push(['first', sql, s.args]); return null; },
        async all() { seen.push(['all', sql, s.args]); return { results: [{ key: 'report:x', value: '{"ok":true}', created_at: 5, expires_at: null }] }; },
        async run() { seen.push(['run', sql, s.args]); return { meta: { changes: 1 } }; } };
      return s;
    },
    async batch(list) { seen.push(['batch', list.map((x) => x.sql), list.map((x) => x.args)]); return []; },
  };
  const st = d1Store(db);
  eq(await st.claimJob('report:x', 'report', '0xx', 100, 25), true);
  eq(seen[0][2], ['report:x', 'report', '0xx', 100, 125]);
  ok(/ON CONFLICT\(key\) DO UPDATE SET lease_until = excluded\.lease_until WHERE report_jobs\.lease_until IS NULL OR report_jobs\.lease_until < excluded\.updated_at/.test(seen[0][1]));
  const got = await st.getCaches(['report:x', 'links:x']);
  ok(/WHERE key IN \(\?1, \?2\)$/.test(seen[1][1]), seen[1][1]);
  eq(got.get('report:x'), { value: { ok: true }, createdAt: 5, expiresAt: null });
  await st.putCaches([{ key: 'a', value: { x: 1 }, createdAt: 1, expiresAt: 2 }, { key: 'b', value: 2, createdAt: 1, expiresAt: null }]);
  eq(seen[2][0], 'batch', 'two cache rows: one D1 batch');
  eq(seen[2][2], [['a', '{"x":1}', 1, 2], ['b', '2', 1, null]]);
  await st.saveJob({ key: 'report:x', status: 'building', step: 'dev', progress: 0.5, state: { v: 1 }, attempts: 0, updatedAt: 9, leaseUntil: 30 }, { release: true });
  eq(seen[3][2], ['report:x', 'building', 'dev', 0.5, '{"v":1}', 0, 9, null], 'released: lease_until NULL');
  for (const sql of Object.values(SQL)) ok(!/\bip\b|user_agent|useragent/i.test(sql), 'no visitor data: ' + sql);
});

test('MCP launch_report: summary text from the report and the links, no banned words', async () => {
  const { store } = await scenario('real OBSYN');
  const fx = await loadReportFixture();
  const f = replayFetch(fx, {});
  _setTransport({ fetch: f, sleep: noSleep, backoff: [0], timeouts: false });
  const now = (fx.index.head.time + 120) * 1000;
  const deps = {
    now, budget: createBudget({ fetch: f }),
    launchReport: (args) => launchReport({ ...args, store, sleep: noSleep }),
    walletLinks: (args) => walletLinks({ ...args, store, sleep: noSleep }),
  };
  const res = await runLaunchReport({ token: OBSYN.real }, deps);
  const text = res.content.map((c) => c.text || '').join('\n');
  ok(/Heavily sniped by bots \(20\.5% in 3 s; 8 of 9 sold before graduation, 1 just after\)\. No dev link found\./.test(text), text.slice(0, 400));
  ok(/0x0a70fea3ee47c8e64ea960135cb469afaab4fb49/.test(text));
  ok(!BANNED.test(text.replace(/sold|sell/g, '')), 'no banned words');
  const json = res.structuredContent || JSON.parse(res.content[res.content.length - 1].text);
  eq([json.links_status, json.status], ['ok', 'done']);
});

// =========================================================================================================
suite('launch report › bundled launches and sales through other apps (synthetic chain)');

test('rules: wallets the dev\'s own transaction bought for are told apart from bots', () => {
  const buys = [
    { wallet: ad(11), raw: raw(5e7), block: 100, tx: tx(1), byDev: true },
    { wallet: ad(12), raw: raw(3e7), block: 100, tx: tx(1), byDev: true },
    { wallet: ad(13), raw: raw(4e7), block: 105, tx: tx(2) },
  ];
  const flows = {
    [ad(11)]: { receivedRaw: raw(5e7), movedRaw: '0', sells: [{ raw: raw(5e7), block: 120, tx: tx(9) }] },
    [ad(12)]: { receivedRaw: raw(3e7), movedRaw: '0', sells: [] },
    [ad(13)]: { receivedRaw: raw(4e7), movedRaw: '0', sells: [{ raw: raw(4e7), block: 130, tx: tx(8) }] },
  };
  const times = { 100: T0, 105: T0 + 1, 148: T0 + 5, 120: T0 + 60, 130: T0 + 90 };
  const s = RR.sniperReport({ buys, flows, times, launch: { block: 100, time: T0 }, supplyRaw: SUPPLY, windowBlocks: 48 });
  eq(s.wallets.map((w) => [w.address, !!w.boughtByDev]), [[ad(11), true], [ad(12), true], [ad(13), false]]);
  eq(s.boughtByDev, { wallets: 2, pct: 8, txs: [tx(1)] });
  eq(s.totalPct, 12, 'the total still counts every first buyer');
  eq(RR.sniperSentence(s, null), 'Sniped by bots (4% in 1 s by 1 wallet; 1 of 1 sold on the curve).', 'bots: only the wallets the dev did not pay for');
  eq(RR.devBundleSentence(s, null), 'The dev\'s own transaction also bought 8% for 2 other wallets (1 of 2 sold on the curve, 1 still holding).');
  const report = { snipers: s, graduation: null, dev: { address: ad(1), buy: { pct: 1 }, moves: [], soldPct: 0, fees: null, bridges: [] }, token: { pons: { launchTime: '2026-11-17T14:14:00Z' } } };
  const links = { ok: true, status: 'done', dev: ad(1), links: [{ wallets: [ad(1), ad(11), ad(12)], involvesDev: true, strength: 'strong', kind: 'same-tx' }] };
  eq(RR.buildVerdict(report, links),
    'Sniped by bots (4% in 1 s by 1 wallet; 1 of 1 sold on the curve). The dev\'s own transaction also bought 8% for 2 other wallets (1 of 2 sold on the curve, 1 still holding). Dev sold nothing.',
    'no "No dev link found." next to a bundled launch; the same-transaction link is not called a funding link');
  const onlyDev = RR.sniperReport({ buys: buys.slice(0, 2), flows, times, launch: { block: 100, time: T0 }, supplyRaw: SUPPLY, windowBlocks: 48 });
  eq(RR.sniperSentence(onlyDev, null), 'No other first buyers besides the dev in the first 5 s.');
  eq(RR.sniperSentence({ totalPct: 0, wallets: [{ status: 'holding', pct: 1 }, { status: 'holding', pct: 1 }, { status: 'holding', pct: 1 }], spanSeconds: 1 }, null),
    'Lightly sniped by bots (0% in 1 s; all 3 still holding).', 'all n, not "3 of 3"');
  eq(RR.linkSentence({ ok: true, status: 'done', dev: ad(1), links: [] }, { bundled: true }), '');
  eq(RR.linkSentence({ ok: true, status: 'done', dev: ad(1), links: [{ wallets: [ad(1), ad(13)], involvesDev: true, strength: 'strong', kind: 'same-funder' }] }, { bundled: true }),
    'Dev linked by funding to 1 first buyer.');
});

test('links: a bundled launch links the dev to the wallets it bought for, with the transaction as proof', () => {
  const { links } = buildLinks([{ wallet: ad(1), role: 'dev', funder: null, kind: 'unknown' }], { dev: ad(1), sameTx: [{ wallet: ad(11), tx: tx(1) }, { wallet: ad(12), tx: tx(1) }] });
  eq(links.length, 1);
  eq([links[0].kind, links[0].strength, links[0].involvesDev, links[0].wallets], ['same-tx', 'strong', true, [ad(1), ad(11), ad(12)]]);
  ok(/dev's own transaction/.test(links[0].reason), links[0].reason);
  ok(links[0].proof.includes('https://robinhoodchain.blockscout.com/tx/' + tx(1)));
  eq(buildLinks([], { dev: ad(1), sameTx: [] }).links, []);
});

// A tiny chain served through the RPC transport: one launch whose launch transaction also bought for two wallets,
// a router buy, an aggregator buy, a later bundle paid by the dev, sales through an aggregator, a plain send and a
// dev sale through the Pons router.
function hex(n) { return '0x' + BigInt(n).toString(16); }
function word(v) { return BigInt(v).toString(16).padStart(64, '0'); }
const topicOf = (a) => '0x' + '0'.repeat(24) + a.slice(2);
function syntheticChain() {
  const TOKEN = '0x' + 'ab'.repeat(20), C = CURVE, D = ad(1), AGG = ad(500), BUNDLER = ad(600), SELLER_APP = ad(700), FRIEND = ad(800);
  const W1 = ad(11), W2 = ad(12), W3 = ad(13), W4 = ad(14), W5 = ad(15);
  const E = (t) => BigInt(Math.round(t)) * E18;
  const logs = [];
  const receipts = {};
  const txFrom = {};
  let li = 0;
  const add = (address, topics, data, block, h) => {
    const l = { address, topics, data: '0x' + data, blockNumber: hex(block), logIndex: hex(li++), transactionHash: h };
    logs.push(l);
    (receipts[h] || (receipts[h] = { transactionHash: h, blockNumber: hex(block), status: '0x1', logs: [] })).logs.push(l);
  };
  const transfer = (from, to, amt, block, h) => add(TOKEN, [TOPIC.TRANSFER, topicOf(from), topicOf(to)], word(amt), block, h);
  const buy = (buyer, rec, quote, amt, block, h) => add(C, [TOPIC.CURVE_BUY, topicOf(buyer), topicOf(rec)], word(quote) + word(amt) + word(0) + word(0), block, h);
  const sell = (amt, quote, block, h) => add(C, [TOPIC.CURVE_SELL, topicOf(ADDR.ROUTER), topicOf(ADDR.ROUTER)], word(amt) + word(quote) + word(0) + word(0), block, h);
  // launch (block 1000, tx 1, sent by the dev): mint, the dev's buy, and two more buys the dev's wallet paid for
  txFrom[tx(1)] = D;
  transfer(ADDR.ZERO, C, 10n ** 27n, 1000, tx(1));
  buy(ADDR.LAUNCH_AND_BUY, D, E18 / 100n, E(1e7), 1000, tx(1)); transfer(C, D, E(1e7), 1000, tx(1));
  buy(D, W1, E18 / 10n, E(5e7), 1000, tx(1)); transfer(C, W1, E(5e7), 1000, tx(1));
  buy(D, W2, E18 / 10n, E(3e7), 1000, tx(1)); transfer(C, W2, E(3e7), 1000, tx(1));
  // a router buy (block 1005), an aggregator buy for its sender (1006), a bundle the dev paid for (1007)
  txFrom[tx(2)] = W3; buy(ADDR.ROUTER, W3, E18 / 10n, E(4e7), 1005, tx(2)); transfer(C, W3, E(4e7), 1005, tx(2));
  txFrom[tx(3)] = W4; buy(AGG, AGG, E18 / 10n, E(2e7), 1006, tx(3)); transfer(C, AGG, E(2e7), 1006, tx(3)); transfer(AGG, W4, E(2e7), 1006, tx(3));
  txFrom[tx(4)] = D; buy(BUNDLER, W5, E18 / 100n, E(5e6), 1007, tx(4)); transfer(C, W5, E(5e6), 1007, tx(4));
  // W1 sells everything through another app (its receipt shows a CurveSell); W2 sends everything to a friend;
  // W3 sells through the Pons router; W4 sells half through the app; the dev sells through the router
  txFrom[tx(10)] = ad(999); transfer(W1, SELLER_APP, E(5e7), 1100, tx(10)); transfer(SELLER_APP, ADDR.ROUTER, E(5e7), 1100, tx(10)); sell(E(5e7), E18 / 20n, 1100, tx(10));
  txFrom[tx(11)] = W2; transfer(W2, FRIEND, E(3e7), 1200, tx(11));
  txFrom[tx(12)] = W3; transfer(W3, ADDR.ROUTER, E(4e7), 1300, tx(12)); sell(E(4e7), E18 / 20n, 1300, tx(12));
  txFrom[tx(13)] = D; transfer(D, ADDR.ROUTER, E(1e7), 1400, tx(13)); sell(E(1e7), E18 / 200n, 1400, tx(13));
  txFrom[tx(14)] = W4; transfer(W4, SELLER_APP, E(1e7), 1500, tx(14)); sell(E(1e7), E18 / 100n, 1500, tx(14));
  const HEAD = 2000;
  const timeOf = (b) => T0 + Math.floor((b - 1000) / 10);
  const block = (b) => ({ number: hex(b), timestamp: hex(timeOf(b)), hash: tx(100000 + b) });
  const match = (l, f) => {
    const b = parseInt(l.blockNumber, 16);
    if (f.address && String(f.address).toLowerCase() !== l.address) return false;
    if (b < parseInt(f.fromBlock, 16) || b > parseInt(f.toBlock, 16)) return false;
    return (f.topics || []).every((t, i) => t == null || (Array.isArray(t) ? t.includes(l.topics[i]) : t === l.topics[i]));
  };
  const answer = (c) => {
    const p = c.params;
    switch (c.method) {
      case 'eth_getBlockByNumber': return block(p[0] === 'latest' ? HEAD : parseInt(p[0], 16));
      case 'eth_blockNumber': return hex(HEAD);
      case 'eth_getLogs': return logs.filter((l) => match(l, p[0]));
      case 'eth_getTransactionByHash': return txFrom[p[0]] ? { hash: p[0], from: txFrom[p[0]], to: C, blockNumber: receipts[p[0]].blockNumber } : null;
      case 'eth_getTransactionReceipt': return receipts[p[0]] || null;
      case 'eth_getCode': return '0x';
      case 'eth_call': return '0x' + word(0);
      default: throw new Error('no ' + c.method);
    }
  };
  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  const fetchFn = async (url, init = {}) => {
    if (String(url).startsWith('https://robinhoodchain.blockscout.com')) return res(404, { message: 'Not found' });
    const body = JSON.parse(init.body);
    const list = Array.isArray(body) ? body : [body];
    const out = list.map((c) => { try { return { jsonrpc: '2.0', id: c.id, result: answer(c) }; } catch (e) { return { jsonrpc: '2.0', id: c.id, error: { code: -32601, message: String(e) } }; } });
    return res(200, Array.isArray(body) ? out : out[0]);
  };
  const row = { token: TOKEN, factory: ADDR.FACTORY_V2, curve: C, creator: D, tx_from: D, pair_token: ADDR.ZERO, block: 1000, time: T0, tx: tx(1), name: 'Synthetic', symbol: 'SYN' };
  return { fetchFn, row, TOKEN, D, W: { W1, W2, W3, W4, W5 }, HEAD, timeOf };
}

test('synthetic chain: bundled buys are marked, sales through other apps count, router attribution, dev sold via the router', async () => {
  clearChainCaches();
  const ch = syntheticChain();
  _setTransport({ fetch: ch.fetchFn, sleep: noSleep, backoff: [0], timeouts: false });
  const st = memoryStore({ rows: [ch.row] });
  const now = (ch.timeOf(ch.HEAD) + 30) * 1000;
  let r = null;
  for (let i = 0; i < 6; i++) {
    r = await launchReport({ token: ch.TOKEN, store: st, now: now + i * 1000, budget: createBudget({ limit: 100000, fetch: ch.fetchFn }), sleep: noSleep });
    if (!r || r.status !== 'building') break;
  }
  eq([r.ok, r.status], [true, 'done'], JSON.stringify(r).slice(0, 300));
  const by = Object.fromEntries(r.snipers.wallets.map((w) => [w.address, w]));
  eq(Object.keys(by).sort(), Object.values(ch.W).sort(), 'router buy -> recipient, aggregator buy -> sender, bundles -> recipients; the dev is left out');
  eq([!!by[ch.W.W1].boughtByDev, !!by[ch.W.W2].boughtByDev, !!by[ch.W.W5].boughtByDev, !!by[ch.W.W3].boughtByDev, !!by[ch.W.W4].boughtByDev], [true, true, true, false, false]);
  eq(by[ch.W.W1].status, 'sold-on-curve', 'sold through another app: its receipt shows the CurveSell');
  eq(by[ch.W.W1].sellTx, tx(10));
  eq([by[ch.W.W2].status, by[ch.W.W2].movedPct], ['holding', 100], 'a plain send to another wallet is "moved", not sold');
  eq(by[ch.W.W3].status, 'sold-on-curve', 'sold through the Pons router');
  eq([by[ch.W.W4].status, by[ch.W.W4].soldPct], ['partly-sold', 50]);
  eq(r.snipers.boughtByDev.wallets, 3);
  near(r.snipers.boughtByDev.pct, 8.5, 1e-9);
  eq(r.snipers.boughtByDev.txs.sort(), [tx(1), tx(4)].sort());
  const sells = r.dev.moves.filter((m) => m.type === 'sell');
  eq(sells.length, 1, 'the dev sold through the Pons router');
  eq([sells[0].tx, sells[0].tokens], [tx(13), 1e7]);
  near(sells[0].eth, 0.005, 1e-12);
  eq(r.dev.buy.tokens, 1e7);
  ok(/^Sniped by bots \(6% in 1 s; 1 of 2 sold on the curve, 1 partly sold\)\. The dev's own transactions also bought 8\.5% for 3 other wallets \(1 of 3 sold on the curve, 2 still holding\)\. Dev sold their whole launch buy/.test(r.verdict), r.verdict);
  ok(!BANNED.test(r.verdict.replace(/sold|sell/g, '')));
  const links = await walletLinks({ token: ch.TOKEN, store: st, now: now + 10000, budget: createBudget({ limit: 100000, fetch: ch.fetchFn }), sleep: noSleep });
  eq(links.status, 'done');
  const same = links.links.find((l) => l.kind === 'same-tx');
  ok(same && same.involvesDev && same.wallets.length === 4, JSON.stringify(links.links));
  ok(same.proof.includes('https://robinhoodchain.blockscout.com/tx/' + tx(4)));
});

test('links: a first buyer funded by the dev is linked to the dev directly, however busy the dev wallet is', () => {
  const f = (wallet, role, funder, kind = 'wallet', t = '2026-09-03T16:31:11Z') => ({ wallet, role, funder, kind, eth: 1.8, time: t, tx: tx(Number(wallet.slice(-2))) });
  const funders = [f(ad(1), 'dev', ad(90)), f(ad(11), 'sniper', ad(1)), f(ad(12), 'sniper', ad(1)), f(ad(13), 'sniper', ad(91)), f(ad(14), 'sniper', ad(13))];
  const { links, ignored } = buildLinks(funders, { dev: ad(1) });
  const dev = links.find((l) => l.funder === ad(1));
  eq([dev.kind, dev.strength, dev.involvesDev, dev.wallets], ['direct-funding', 'strong', true, [ad(1), ad(11), ad(12)]]);
  eq(dev.reason, 'The dev sent the first ETH to these 2 wallets.');
  ok(dev.proof.includes('https://robinhoodchain.blockscout.com/tx/' + tx(11)));
  const other = links.find((l) => l.funder === ad(13));
  eq([other.kind, other.involvesDev, other.wallets, other.reason], ['direct-funding', false, [ad(13), ad(14)], 'First buyer 0x0000…0013 sent the first ETH to this wallet.']);
  eq(ignored, []);
  eq(RR.linkSentence({ ok: true, status: 'done', dev: ad(1), links }), 'Dev linked by funding to 2 first buyers.');
  // even when an earlier step called the dev wallet a public service (too busy to count), it is still a direct link
  const busy = funders.map((x) => (x.funder === ad(1) ? { ...x, kind: 'public-service', why: 'busy' } : x));
  const again = buildLinks(busy, { dev: ad(1) });
  ok(again.links.some((l) => l.kind === 'direct-funding' && l.involvesDev), JSON.stringify(again.links));
  eq(again.ignored, [], 'the dev is never listed as an ignored public service');
});
