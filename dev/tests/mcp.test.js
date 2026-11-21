// MCP tools (api/src/mcp.js) and the stdio package (mcp/): tool texts, summaries, links as a separate field,
// "building" answers, plain-message errors, never-advice wording, proof links, and the package's listing files.
// Offline: the copy check replays the recorded OBSYN fixtures; the launch report is a contract-shaped OBSYN
// report with the verified headline numbers (the report's own numbers are tested by the report builder's tests).
import { suite, test, eq, ok } from './harness.js';
import * as M from '../../api/src/mcp.js';
import { createBudget } from '../../api/src/budget.js';
import { WINDOW_SECONDS } from '../../site/src/core/math.js';
import * as P from '../../mcp/src/tools.js';
import { callRemoteTool, parseRpcBody, apiBase, PROTOCOL_VERSION } from '../../mcp/src/remote.js';
import { loadFixture, runScenario, replayFetch, fixtureIndex, OBSYN } from './fixtures/obsyn/replay.js';
import { loadReportFixture } from './fixtures/obsyn/report-replay.js';
import { copyMatches } from '../../api/src/copies.js';
import { localTools, _resetShared } from '../../mcp/src/local.js';

const PROOF_RE = /https:\/\/robinhoodchain\.blockscout\.com\/(tx|address|token|block)\/[0-9a-fx]+/g;
const PROOF_ONE = /^https:\/\/robinhoodchain\.blockscout\.com\/(tx\/0x[0-9a-f]{64}|address\/0x[0-9a-f]{40}|token\/0x[0-9a-f]{40}|block\/\d+)$/;
const text = (r) => r.content[0].text;
const H = (c) => '0x' + c.repeat(64);
const W = (n) => '0x' + String(n).padStart(40, '0');
const REAL = '0x5d992fa5b7da8efde5fd36d24e81097ed6ad4351';
const DEV = '0x03412baadd3d3207506e89cebb051ab713295c32';
const LATE = '0x0a70fea3ee47c8e64ea960135cb469afaab4fb49';
const EXPLORER = 'https://robinhoodchain.blockscout.com';

function proofsOk(s, what) {
  const urls = s.match(PROOF_RE) || [];
  ok(urls.length > 0, what + ': has proof links');
  for (const u of urls) ok(PROOF_ONE.test(u), what + ': proof link ' + u);
}
function wordsOk(s, what) {
  ok(!M.BANNED_WORDS.test(s), what + ': no advice / scam / safe words: ' + (s.match(M.BANNED_WORDS) || [''])[0]);
  ok(s.trim().endsWith(M.NOT_ADVICE), what + ': ends with the not-advice line');
}

// A contract-shaped ReportResult for the real OBSYN (verified headline numbers; filler wallets and tx hashes).
function obsynReport() {
  const snipers = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ address: W(i), tokens: 25000000, pct: 2.5, block: 116638986 + 33 + (i % 4), secondsAfterLaunch: 3, status: 'sold-on-curve', soldPct: 100, sellTx: H(String(i)) }));
  snipers.push({ address: LATE, tokens: 5132042, pct: 0.51, block: 116639022, secondsAfterLaunch: 3, status: 'sold-after-graduation', soldPct: 100, sellTx: H('9') });
  return {
    ok: true, status: 'done',
    token: { address: REAL, name: 'obsyn', symbol: 'OBSYN', isOfficial: false,
      pons: { factory: W('7ed598bc'), curve: '0x1d6a7a3fab6592cb5e6aa5873b915bc6f93b0499', launchTx: '0xec919f76f60857d7e76be568966af6e3e1f8b3b0e590d77276c5bbb37419df0c', launchBlock: 116638986, launchTime: '2026-11-17T14:14:00Z' } },
    asOf: '2026-11-18T09:00:00Z',
    dev: { address: DEV, viaMulticall: false,
      buy: { eth: 0.02, tokens: 11421611.03, pct: 1.142161, tx: '0xec919f76f60857d7e76be568966af6e3e1f8b3b0e590d77276c5bbb37419df0c' },
      moves: [
        { type: 'send', tokens: 5100000, pct: 0.51, to: '0xf80b926e549e8dff2ade45132afbdbb240e354e9', time: '2026-11-17T14:53:10Z', tx: '0x0b7d5493c96988a1b62a30eae84f2feccadd5b9ef4a42633db2b2abd51bb0a55', afterGraduation: false },
        { type: 'burn', tokens: 6321611.03, pct: 0.632161, time: '2026-11-17T15:21:11Z', tx: '0xc899805eec47c3cf4bf0f46ab7df7a2ce93e189daa796c55a93ca7d9f5ae1365', afterGraduation: false },
        { type: 'buy', tokens: 900000, pct: 0.09, eth: 0.02, time: '2026-11-17T20:10:00Z', tx: H('a'), afterGraduation: true },
        { type: 'buy', tokens: 800000, pct: 0.08, eth: 0.02, time: '2026-11-17T21:10:00Z', tx: H('b'), afterGraduation: true },
        { type: 'buy', tokens: 836012.41, pct: 0.0836, eth: 0.02, time: '2026-11-17T22:10:00Z', tx: H('c'), afterGraduation: true },
        { type: 'buy', tokens: 800000, pct: 0.08, eth: 0.015, time: '2026-11-17T23:10:00Z', tx: H('d'), afterGraduation: true },
        { type: 'burn', tokens: 3336012.41, pct: 0.3336, time: '2026-11-18T01:13:18Z', tx: '0x08bc2484378786a48a3a2c3956209451e55b1cb8cbebed9916242186346f5f5e', afterGraduation: true },
      ],
      fees: { claimedEth: 2.073536, unclaimedEth: 0.05, claims: [
        { tx: '0xba5556baa33222e28368d7766be2337079df82220a74b8ebff36af797ef6e386', time: '2026-11-17T19:27:05Z', eth: 0.482236 },
        { tx: H('e'), time: '2026-11-18T08:28:18Z', eth: 1.5913 }] },
      bridges: [{ via: 'MetaBridge (Across)', eth: 0.18, time: '2026-11-17T20:06:56Z', tx: H('f'), destChainId: 8453, destChainConfirmed: true }],
      soldPct: 0 },
    snipers: { windowBlocks: 48, windowSeconds: 5, totalPct: 20.513204, wallets: snipers, clusters: [{ block: 116639019, wallets: [W(4), W(8), W(1)] }] },
    graduation: { time: '2026-11-17T19:31:25Z', tx: '0x493778200eb20f599eead6f8fcfa9dce5dc8935d0a900a696d544b57b83497d4' },
    activity: { hours: [{ hourStart: '2026-11-17T14:00:00Z', buys: 120, newWallets: 80 }, { hourStart: '2026-11-17T15:00:00Z', buys: 60, newWallets: 30 }] },
    verdict: 'Heavily sniped by bots (20.5% in 3 s; 8 of 9 sold before graduation, 1 just after). No dev link found. Dev claimed fees and sold nothing.',
    notes: [], caveats: ['Wallets funded through exchanges, bridges or privacy tools can\'t be linked.'], missing: [],
    proof: { token: EXPLORER + '/token/' + REAL, creator: EXPLORER + '/address/' + DEV, launchTx: EXPLORER + '/tx/0xec919f76f60857d7e76be568966af6e3e1f8b3b0e590d77276c5bbb37419df0c' },
  };
}
const noLinks = () => ({ ok: true, status: 'done', funders: [], links: [], ignored: [], caveat: M.LINKS_CAVEAT });

// A PriceInput (site/src/data contract) for blame_split.
function priceInput() {
  const T_END = 1794924000;
  return {
    ok: true,
    coin: { address: REAL, symbol: 'OBSYN', name: 'obsyn' },
    pair: { address: '0x0bd7473cbbf81d9dd936c61117ed230d95006ca2', symbol: 'ETH', kind: 'eth' },
    pool: { id: H('7'), dex: 'uniswap', label: 'OBSYN/ETH', pairSideUsd: 7500, createdAt: null, source: 'dexscreener' },
    window: '24h', windowSeconds: WINDOW_SECONDS['24h'],
    start: { block: 116638986, time: T_END - 86400 }, end: { block: 117441250, time: T_END },
    sinceLaunch: false,
    coinInPair: { start: 1e-8, end: 7.68e-8 },
    pairUsd: { start: 3000, end: 2946 },
    pairVia: null,
    tradedInWindow: true,
  };
}

// =========================================================================================================
suite('mcp › tool texts');

test('three tools, each says read-only and not financial advice, with read-only annotations', () => {
  eq(Object.keys(M.TOOLS).sort(), ['blame_split', 'check_copycats', 'launch_report']);
  for (const [name, t] of Object.entries(M.TOOLS)) {
    ok(/^Read-only\./.test(t.description), name + ' starts with Read-only');
    ok(/Not financial advice\./.test(t.description), name + ' says not financial advice');
    ok(!M.BANNED_WORDS.test(t.description), name + ' has no banned words');
  }
  eq(M.ANNOTATIONS, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
  ok(/launch_report/.test(M.INSTRUCTIONS) && /never "scam" or "safe"/.test(M.INSTRUCTIONS), 'instructions');
});

test('number wording', () => {
  eq(M.pctText(1.1421611), '1.14%');
  eq(M.pctText(20.513204), '20.51%');
  eq(M.pctText(100, 0), '100%');
  eq(M.pctText(100), '100%');
  eq(M.pctText(10, 0), '10%');
  eq(M.pctText(2.5), '2.5%');
  eq(M.pctText(0.004), '<0.01%');
  eq(M.pctText(0), '0%');
  eq(M.pctText(null), '?');
  eq(M.tokensText(6321611.029), '6,321,611.03');
  eq(M.tokensText(5100000), '5,100,000');
  eq(M.ethText(0.48223591), '0.4822 ETH');
  eq(M.ethText(1.5913), '1.5913 ETH');
  eq(M.ethText(0.18), '0.18 ETH');
  eq(M.ethText(0.025814298), '0.02581 ETH');
  eq(M.ethText(0), '0 ETH');
  eq(M.utc('2026-11-17T14:14:00Z'), '2026-11-17 14:14:00 UTC');
  eq(M.utc(1794924000), '2026-11-17 14:00:00 UTC');
  eq(M.utc(null), null);
  eq(M.utc('nonsense'), null);
});

test('settingsFor puts env.OFFICIAL on the official list (and ignores a bad address)', () => {
  const s = M.settingsFor({ OFFICIAL: '0x00000000000000000000000000000000000B1A3E' });
  eq(s.trust.official, [{ symbol: 'BLAME', address: '0x00000000000000000000000000000000000b1a3e' }]);
  const t = M.settingsFor({ OFFICIAL: 'soon' });
  ok(!t.trust.official || !t.trust.official.some((o) => o.address === 'soon'), 'bad address not added');
});

// =========================================================================================================
suite('mcp › launch_report');

test('OBSYN: summary states the verified facts, with proof links, links as a separate field', async () => {
  const r = await M.runLaunchReport({ token: '0x5D992fa5B7Da8EFde5FD36d24e81097Ed6aD4351' }, { launchReport: async () => obsynReport(), walletLinks: async () => noLinks() });
  ok(!r.isError, 'not an error');
  const s = text(r);
  for (const want of [
    'Launch report for OBSYN (obsyn) ' + REAL,
    'Heavily sniped by bots (20.5% in 3 s; 8 of 9 sold before graduation, 1 just after).',
    'Launch: 2026-11-17 14:14:00 UTC, block 116638986',
    'Dev: ' + DEV,
    'Dev buy: 1.14% of supply (11,421,611.03 tokens for 0.02 ETH)',
    '2026-11-17 14:53:10 UTC: sent 5,100,000 tokens (0.51% of supply) to 0xf80b926e549e8dff2ade45132afbdbb240e354e9',
    '2026-11-17 15:21:11 UTC: burned 6,321,611.03 tokens',
    'bought 900,000 tokens (0.09% of supply) for 0.02 ETH, after graduation',
    '2026-11-18 01:13:18 UTC: burned 3,336,012.41 tokens (0.33% of supply), after graduation',
    'Dev sold: nothing.',
    'Dev fees: claimed 2.0735 ETH in 2 claims, unclaimed 0.05 ETH.',
    '2026-11-17 19:27:05 UTC: 0.4822 ETH',
    '2026-11-18 08:28:18 UTC: 1.5913 ETH',
    '2026-11-17 20:06:56 UTC: 0.18 ETH via MetaBridge (Across) to chain 8453',
    '9 wallets took 20.51% of supply. 8 sold on the curve before graduation, 1 sold after graduation.',
    LATE + ': 0.51% at +3 s, sold after graduation',
    'Same-block groups: 3 wallets in block 116639019.',
    'Graduated: 2026-11-17 19:31:25 UTC ' + EXPLORER + '/tx/0x493778200eb20f599eead6f8fcfa9dce5dc8935d0a900a696d544b57b83497d4',
    'Activity: 180 curve buys and 110 new wallets over 2 hours',
    'Wallet links: no shared funder found between the dev and the first buyers.',
  ]) ok(s.includes(want), 'summary has: ' + want);
  eq(s.split(M.LINKS_CAVEAT).length - 1, 1, 'the exchanges/bridges caveat appears exactly once');
  ok(!/destination not confirmed/.test(s), 'confirmed destination not hedged');
  proofsOk(s, 'launch_report');
  wordsOk(s, 'launch_report');
  const j = r.structuredContent;
  eq(j.links_status, 'ok');
  eq(j.links.status, 'done');
  eq(j.links.links, []);
  eq(j.dev.soldPct, 0);
  eq(j.snipers.wallets.length, 9);
  eq(j.graduation.time, '2026-11-17T19:31:25Z');
  eq(j.disclaimer, M.NOT_ADVICE);
  eq(JSON.parse(r.content[1].text), j, 'second text block is the same JSON');
});

test('links found: listed with reason and proof', async () => {
  const links = { ok: true, status: 'done', funders: [], ignored: [], caveat: M.LINKS_CAVEAT,
    links: [{ wallets: [W(1), W(2)], reason: 'same funder ' + W(99), proof: [EXPLORER + '/tx/' + H('1')] }] };
  const r = await M.runLaunchReport({ token: REAL }, { launchReport: async () => obsynReport(), walletLinks: async () => links });
  const s = text(r);
  ok(s.includes('Wallet links: 1 link found'), 'count');
  ok(s.includes(W(1) + ', ' + W(2) + ': same funder ' + W(99) + ' ' + EXPLORER + '/tx/' + H('1')), 'link line');
  eq(r.structuredContent.links.links.length, 1);
});

test('wallet links failing never breaks the report: links_status unavailable', async () => {
  for (const wl of [async () => { throw new Error('explorer 429'); }, async () => ({ ok: true, status: 'unavailable' }), async () => ({ ok: false, code: 'x' })]) {
    const r = await M.runLaunchReport({ token: REAL }, { launchReport: async () => obsynReport(), walletLinks: wl });
    ok(!r.isError, 'report still answers');
    eq(r.structuredContent.links_status, 'unavailable');
    eq(r.structuredContent.links, null);
    ok(text(r).includes('Wallet links: unavailable right now'), 'says unavailable');
    ok(text(r).includes('Dev buy: 1.14% of supply'), 'rest of the report is there');
    ok(text(r).includes(M.LINKS_CAVEAT), 'caveat still there');
  }
});

test('wallet links still building: links_status building', async () => {
  const r = await M.runLaunchReport({ token: REAL }, { launchReport: async () => obsynReport(), walletLinks: async () => ({ ok: true, status: 'building', progress: 0.3 }) });
  eq(r.structuredContent.links_status, 'building');
  eq(r.structuredContent.links, { status: 'building' });
  ok(text(r).includes('Wallet links: still checking'), 'says still checking');
});

test('report building: status building + progress, call again; links not fetched', async () => {
  let linksCalled = false;
  const r = await M.runLaunchReport({ token: REAL }, { launchReport: async () => ({ ok: true, status: 'building', progress: 0.4 }), walletLinks: async () => { linksCalled = true; return noLinks(); } });
  ok(!r.isError);
  eq(r.structuredContent.status, 'building');
  eq(r.structuredContent.progress, 0.4);
  eq(r.structuredContent.links_status, 'building');
  ok(/Still building this answer \(40% done\)\. Call launch_report again/.test(text(r)), text(r));
  ok(!linksCalled, 'links wait for the report');
});

test('report errors come back as a plain message, never a crash', async () => {
  const a = await M.runLaunchReport({ token: REAL }, { launchReport: async () => ({ ok: false, code: 'not-pons', message: 'This coin wasn\'t launched on Pons, so there is no launch report.' }) });
  eq(a.isError, true);
  eq(text(a), 'This coin wasn\'t launched on Pons, so there is no launch report.');
  eq(a.structuredContent.code, 'not-pons');
  const b = await M.runLaunchReport({ token: REAL }, { launchReport: async () => { throw new Error('boom'); } });
  eq(b.isError, true);
  ok(/unavailable right now/.test(text(b)), text(b));
  const c = await M.runLaunchReport({ token: '0x123' }, {});
  eq(c.isError, true);
  eq(c.structuredContent.code, 'bad-address');
});

test('the api hook (route-shared cache/jobs) is used when given', async () => {
  const seen = [];
  const api = { report: async (t) => { seen.push(['report', t]); return obsynReport(); }, links: async (t) => { seen.push(['links', t]); return noLinks(); } };
  const r = await M.runLaunchReport({ token: '0x5D992fa5B7Da8EFde5FD36d24e81097Ed6aD4351' }, { api });
  eq(seen, [['report', REAL], ['links', REAL]]);
  eq(r.structuredContent.links_status, 'ok');
});

test('launch report gets the request budget, env and settings', async () => {
  const budget = createBudget({ limit: 7 });
  let got = null;
  await M.runLaunchReport({ token: REAL }, { budget, env: { DB: 'db' }, now: 123, launchReport: async (a) => { got = a; return obsynReport(); }, walletLinks: async () => noLinks() });
  ok(got.budget === budget, 'same budget');
  eq(got.token, REAL);
  eq(got.env, { DB: 'db' });
  eq(got.now, 123);
  ok(got.settings && got.settings.trust, 'settings');
});

// =========================================================================================================
suite('mcp › check_copycats');

test('OBSYN ticker (recorded fixtures): every coin, flags, proof links, caveats', async () => {
  const fx = await loadFixture();
  const r = await M.runCheckCopycats({ query: 'OBSYN' }, { api: { copies: (q) => runScenario({ query: q }, fx) } });
  ok(!r.isError, text(r));
  const s = text(r);
  ok(s.startsWith('Copy check for "OBSYN"'), 'header');
  for (const a of [OBSYN.real, OBSYN.copy, OBSYN.early]) ok(s.includes(a), 'lists ' + a);
  ok(s.indexOf(OBSYN.early) < s.indexOf(OBSYN.copy) && s.indexOf(OBSYN.copy) < s.indexOf(OBSYN.real), 'earliest first');
  ok(/FLAG: Launched 11 min 45 s before/.test(s), 'launched-just-before flag on the copycat');
  ok(s.includes('dev sold 100% of it (first sale 1 min 11 s after launch)'), 'dev sold wording');
  ok(s.includes('graduated 2026-11-17 19:31:25 UTC'), 'real one graduated');
  ok(/First doesn't mean real/.test(s), 'never picks a winner');
  proofsOk(s, 'check_copycats');
  wordsOk(s, 'check_copycats');
  eq(r.structuredContent.disclaimer, M.NOT_ADVICE);
  ok(r.structuredContent.matches.length >= 3, 'matches in JSON');
});

test('copycat address: the asked-about coin is tagged', async () => {
  const fx = await loadFixture();
  const r = await M.runCheckCopycats({ query: OBSYN.copy }, { api: { copies: (q) => runScenario({ query: q }, fx) } });
  ok(text(r).includes(OBSYN.copy + ' [the one you asked about]'), 'tag');
});

test('empty input, copy-check errors and throws are plain messages', async () => {
  const a = await M.runCheckCopycats({ query: '  ' }, {});
  eq(a.isError, true);
  eq(a.structuredContent.code, 'bad-input');
  const b = await M.runCheckCopycats({ query: 'OBSYN' }, { api: { copies: async () => ({ ok: false, code: 'index-behind', message: 'The launch index is still being built. Try again in a few minutes.' }) } });
  eq(b.isError, true);
  eq(text(b), 'The launch index is still being built. Try again in a few minutes.');
  const c = await M.runCheckCopycats({ query: 'OBSYN' }, { api: { copies: async () => { throw new Error('d1 down'); } } });
  eq(c.isError, true);
  ok(/unavailable right now/.test(text(c)));
  const d = await M.runCheckCopycats({ query: 'OBSYN' }, { api: { copies: async () => ({ ok: true, status: 'building', progress: 0.5 }) } });
  ok(!d.isError);
  eq(d.structuredContent.status, 'building');
});

test('without the api hook: copyCheck gets the budgeted D1 and the budget fetch', async () => {
  const budget = createBudget({ limit: 5 });
  let got = null;
  const db = { prepare() { return {}; } };
  await M.runCheckCopycats({ query: 'OBSYN' }, { budget, env: { DB: db }, copyCheck: async (a) => { got = a; return { ok: false, code: 'x', message: 'm' }; } });
  ok(got.fetch === budget.fetch, 'budget fetch');
  ok(got.db && got.db.__budgeted && got.db.__raw === db, 'budgeted D1');
  eq(got.query, 'OBSYN');
});

// =========================================================================================================
suite('mcp › blame_split');

test('summary + JSON with proof links and the card link', async () => {
  const r = await M.runBlameSplit({ token: REAL, window: '24h' }, { fetchPriceInput: async () => priceInput(), cache: null });
  ok(!r.isError, text(r));
  const s = text(r);
  ok(s.startsWith('OBSYN (' + REAL + '), '), s.slice(0, 80));
  ok(s.includes('Card: https://blamethestock.com/?ca=' + REAL + '&w=24h'), 'card link');
  ok(s.includes(EXPLORER + '/block/116638986') && s.includes(EXPLORER + '/block/117441250'), 'block proofs');
  proofsOk(s, 'blame_split');
  wordsOk(s, 'blame_split');
  const j = r.structuredContent;
  eq(j.window, '24h');
  ok(Math.abs(j.coinChange - (7.68 * 2946 / 3000 - 1)) < 1e-9, 'c');
  ok(Math.abs(j.pairChange - (2946 / 3000 - 1)) < 1e-9, 'q');
  eq(j.blocks.start.block, 116638986);
  eq(j.proof.token, EXPLORER + '/token/' + REAL);
});

test('window defaults to 24h; unknown window and bad address are plain errors', async () => {
  let asked = null;
  await M.runBlameSplit({ token: REAL }, { fetchPriceInput: async (a, w) => { asked = w; return priceInput(); }, cache: null });
  eq(asked, '24h');
  const a = await M.runBlameSplit({ token: REAL, window: '2d' }, { cache: null });
  eq(a.isError, true);
  eq(a.structuredContent.code, 'bad-window');
  ok(text(a).includes('1h, 6h, 24h, 7d'));
  const b = await M.runBlameSplit({ token: 'OBSYN' }, { cache: null });
  eq(b.structuredContent.code, 'bad-address');
});

test('data errors use the site\'s wording; a throw is rpc-failed, never a crash', async () => {
  const a = await M.runBlameSplit({ token: REAL }, { fetchPriceInput: async () => ({ ok: false, code: 'no-pool' }), cache: null });
  eq(a.isError, true);
  eq(a.structuredContent.code, 'no-pool');
  ok(text(a).length > 10, text(a));
  const b = await M.runBlameSplit({ token: REAL }, { fetchPriceInput: async () => { throw new Error('net'); }, cache: null });
  eq(b.isError, true);
  eq(b.structuredContent.code, 'rpc-failed');
});

test('a cached answer is served without reading the chain', async () => {
  const store = {};
  const first = await M.runBlameSplit({ token: REAL }, { fetchPriceInput: async () => priceInput(), cache: null });
  const cache = { match: async (k) => (store[k] ? { json: async () => store[k] } : null) };
  store['https://api.blamethestock.com/__mcp/split/' + REAL + '/24h'] = first.structuredContent;
  let called = false;
  const r = await M.runBlameSplit({ token: REAL }, { fetchPriceInput: async () => { called = true; return priceInput(); }, cache });
  ok(!called, 'no chain read');
  eq(r.structuredContent, first.structuredContent);
});

// =========================================================================================================
suite('mcp › server wiring');

// A tiny stand-in for zod (enough for buildServer) and McpServer (records registrations).
function fakeSdk() {
  const chain = (desc) => {
    const o = { desc };
    for (const m of ['describe', 'default', 'max']) o[m] = (...a) => chain({ ...desc, [m]: a[0] });
    return o;
  };
  const z = { string: () => chain({ type: 'string' }), enum: (v) => chain({ type: 'enum', values: v }), object: (shape) => chain({ type: 'object', shape }) };
  class McpServer {
    constructor(info, opts) { this.info = info; this.opts = opts; this.tools = {}; }
    registerTool(name, config, cb) { this.tools[name] = { config, cb }; }
  }
  return { McpServer, z };
}

test('buildServer registers the three tools read-only, with inputs, and wires them to the runners', async () => {
  const S = fakeSdk();
  const srv = M.buildServer(S, { launchReport: async () => obsynReport(), walletLinks: async () => noLinks(), cache: null, fetchPriceInput: async () => priceInput() });
  eq(srv.info.name, 'blamethestock');
  eq(srv.opts.instructions, M.INSTRUCTIONS);
  eq(Object.keys(srv.tools).sort(), ['blame_split', 'check_copycats', 'launch_report']);
  for (const [name, t] of Object.entries(srv.tools)) {
    eq(t.config.description, M.TOOLS[name].description);
    eq(t.config.annotations, M.ANNOTATIONS);
  }
  eq(srv.tools.blame_split.config.inputSchema.desc.shape.window.desc.default, '24h');
  eq(srv.tools.blame_split.config.inputSchema.desc.shape.window.desc.values, ['1h', '6h', '24h', '7d']);
  eq(srv.tools.check_copycats.config.inputSchema.desc.shape.query.desc.max, 100);
  const rep = await srv.tools.launch_report.cb({ token: REAL });
  eq(rep.structuredContent.links_status, 'ok');
  const split = await srv.tools.blame_split.cb({ token: REAL, window: '24h' });
  ok(!split.isError);
});

test('both servers say the tool list never changes (a stateless Worker cannot send list_changed)', async () => {
  const hosted = M.buildServer(fakeSdk(), {});
  eq(hosted.opts.capabilities, { tools: { listChanged: false } });
});

test('a 405 from /mcp names the methods that work; CORS only for site origins; never cached', () => {
  if (typeof Headers !== 'function' || typeof Response !== 'function') return;   // jsc: no fetch classes
  const req = (origin) => ({ headers: new Headers(origin ? { origin } : {}) });
  const r = M.finishHeaders(new Response('{}', { status: 405, headers: { 'access-control-allow-origin': 'https://blamethestock.com' } }), req('https://evil.example'));
  eq(r.status, 405);
  eq(r.headers.get('allow'), 'POST, OPTIONS');
  eq(r.headers.get('access-control-allow-origin'), null);
  eq(r.headers.get('cache-control'), 'no-store');
  const ok200 = M.finishHeaders(new Response('{}', { status: 200 }), req('https://www.blamethestock.com'));
  eq(ok200.headers.get('access-control-allow-origin'), 'https://www.blamethestock.com');
  eq(ok200.headers.get('allow'), null);
});

test('allowed browser origins are the site and local preview only', () => {
  eq(M.ALLOWED_ORIGINS, ['https://blamethestock.com', 'https://www.blamethestock.com', 'http://localhost:8765']);
});

// =========================================================================================================
suite('mcp › stdio package');

test('tool names, descriptions, instructions and annotations match the hosted server word for word', () => {
  eq(Object.keys(P.TOOLS), Object.keys(M.TOOLS));
  for (const k of Object.keys(M.TOOLS)) {
    eq(P.TOOLS[k].title, M.TOOLS[k].title, k + ' title');
    eq(P.TOOLS[k].description, M.TOOLS[k].description, k + ' description');
  }
  eq(P.INSTRUCTIONS, M.INSTRUCTIONS);
  eq(P.ANNOTATIONS, M.ANNOTATIONS);
  eq(P.NOT_ADVICE, M.NOT_ADVICE);
  eq(P.SERVER_NAME, M.SERVER_NAME);
  eq(P.WINDOWS, Object.keys(WINDOW_SECONDS));
  eq(Object.keys(P.INPUTS.blame_split), ['token', 'window']);
  eq(P.INPUTS.check_copycats.query.maxLength, 100);
});

test('the package inputs build the same schema as the hosted server', () => {
  const S = fakeSdk();
  const hosted = M.buildServer(S, {});
  for (const [name, inputs] of Object.entries(P.INPUTS)) {
    const shape = hosted.tools[name].config.inputSchema.desc.shape;
    eq(Object.keys(shape), Object.keys(inputs), name + ' fields');
    for (const [k, spec] of Object.entries(inputs)) {
      eq(shape[k].desc.describe, spec.description, name + '.' + k + ' description');
      if (spec.default !== undefined) eq(shape[k].desc.default, spec.default, name + '.' + k + ' default');
      if (spec.maxLength) eq(shape[k].desc.max, spec.maxLength, name + '.' + k + ' max');
    }
  }
});

test('BTS_API_BASE: default, override, trailing slash and /mcp trimmed, junk ignored', () => {
  eq(apiBase({}), 'https://api.blamethestock.com');
  eq(apiBase({ BTS_API_BASE: 'http://localhost:8787/' }), 'http://localhost:8787');
  eq(apiBase({ BTS_API_BASE: 'http://localhost:8787/mcp' }), 'http://localhost:8787');
  eq(apiBase({ BTS_API_BASE: 'ftp://x' }), 'https://api.blamethestock.com');
});

test('parses JSON and SSE answers', () => {
  const result = { content: [{ type: 'text', text: 'hi' }] };
  eq(parseRpcBody(JSON.stringify({ jsonrpc: '2.0', id: 3, result }), 'application/json', 3).result, result);
  const sse = 'event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: 4, result }) + '\n\n';
  eq(parseRpcBody(sse, 'text/event-stream', 4).result, result);
  eq(parseRpcBody(': keepalive\n\n' + sse, 'text/event-stream; charset=utf-8', 4).result, result);
  eq(parseRpcBody('<html>', 'text/html', 1), null);
  eq(parseRpcBody(JSON.stringify({ jsonrpc: '2.0', id: 9, result }), 'application/json', 1), null, 'other id');
});

function fakeFetch(status, body, contentType = 'application/json', seen = []) {
  return async (url, init) => {
    seen.push({ url, init });
    return { ok: status >= 200 && status < 300, status, headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) }, text: async () => (typeof body === 'function' ? body(JSON.parse(init.body)) : body) };
  };
}

test('forwards one tools/call to <base>/mcp and returns the hosted result unchanged', async () => {
  const seen = [];
  const result = { content: [{ type: 'text', text: 'summary' }, { type: 'text', text: '{}' }], structuredContent: { ok: true } };
  const f = fakeFetch(200, (msg) => 'event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n\n', 'text/event-stream', seen);
  const r = await callRemoteTool('launch_report', { token: REAL }, { base: 'http://localhost:8787', fetch: f, timeoutMs: 0 });
  eq(r, result);
  eq(seen.length, 1);
  eq(seen[0].url, 'http://localhost:8787/mcp');
  const body = JSON.parse(seen[0].init.body);
  eq(body.method, 'tools/call');
  eq(body.params, { name: 'launch_report', arguments: { token: REAL } });
  eq(seen[0].init.headers['mcp-protocol-version'], PROTOCOL_VERSION);
  ok(/text\/event-stream/.test(seen[0].init.headers.accept), 'accepts SSE');
  ok(!Object.keys(seen[0].init.headers).some((k) => /cookie|authorization|x-forwarded/i.test(k)), 'sends nothing about the user');
});

test('network failure, 429, HTTP error page and JSON-RPC error all become plain tool errors', async () => {
  const net = await callRemoteTool('blame_split', { token: REAL }, { fetch: async () => { throw new TypeError('fetch failed'); }, timeoutMs: 0 });
  eq(net.isError, true);
  ok(/Couldn't reach Blame the Stock/.test(net.content[0].text), net.content[0].text);
  const busy = await callRemoteTool('blame_split', { token: REAL }, { fetch: fakeFetch(429, '{}'), timeoutMs: 0 });
  ok(/busy/.test(busy.content[0].text) && busy.isError, 'busy');
  const page = await callRemoteTool('blame_split', { token: REAL }, { fetch: fakeFetch(502, '<html>bad gateway</html>', 'text/html'), timeoutMs: 0 });
  ok(/HTTP 502/.test(page.content[0].text) && page.isError, 'http error');
  const rpcErr = await callRemoteTool('nope', {}, { fetch: fakeFetch(200, (m) => JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'Tool nope not found' } })), timeoutMs: 0 });
  eq(rpcErr.content[0].text, 'Tool nope not found');
  eq(rpcErr.isError, true);
});

// ---- listing files ----------------------------------------------------------------------------------------
function readPkgFile(name) {
  const url = import.meta.url;
  if (typeof read === 'function' && /^file:/.test(url)) {
    const dir = decodeURIComponent(url.replace(/^file:\/\//, '')).replace(/[^/]*$/, '');
    return read(dir + '../../mcp/' + name);
  }
  return null;
}

test('package.json, server.json and glama.json agree (registry name, version, npm id, remote URL)', () => {
  const pj = readPkgFile('package.json');
  if (pj == null) return;                       // browser runner: files aren't readable, nothing to check
  const pkg = JSON.parse(pj);
  const srv = JSON.parse(readPkgFile('server.json'));
  eq(pkg.name, 'blamethestock-mcp');
  eq(pkg.mcpName, 'com.blamethestock/blamethestock');
  eq(srv.name, pkg.mcpName);
  eq(srv.version, pkg.version);
  ok(/^https:\/\/static\.modelcontextprotocol\.io\/schemas\/\d{4}-\d{2}-\d{2}\/server\.schema\.json$/.test(srv.$schema), 'schema URL');
  ok(srv.description.length <= 100, 'description <= 100 chars (' + srv.description.length + ')');
  ok(/read-only/i.test(srv.description) && /not advice/i.test(srv.description), 'description says read-only, not advice');
  eq(srv.packages[0].registryType, 'npm');
  eq(srv.packages[0].identifier, pkg.name);
  eq(srv.packages[0].version, pkg.version);
  eq(srv.packages[0].transport, { type: 'stdio' });
  eq(srv.remotes, [{ type: 'streamable-http', url: 'https://blamethestock.com/mcp' }]);
  eq(pkg.bin['blamethestock-mcp'], 'src/index.js');
  eq(pkg.license, 'MIT');
  ok(/Copyright \(c\) \d{4} Blame the Stock/.test(readPkgFile('LICENSE')), 'LICENSE copyright');
  const glama = JSON.parse(readPkgFile('glama.json'));
  ok(Array.isArray(glama.maintainers) && glama.maintainers.length === 1, 'glama maintainers');
  ok(/^#!\/usr\/bin\/env node\n/.test(readPkgFile('src/index.js')), 'bin has a node shebang');
  const docker = readPkgFile('Dockerfile');
  ok(/ENTRYPOINT \["node", "src\/index\.js"\]/.test(docker), 'Dockerfile runs the stdio server');
});

test('README: install snippets, read-only and not-advice note, no machine paths', () => {
  const md = readPkgFile('README.md');
  if (md == null) return;
  ok(md.includes('claude mcp add --transport http blamethestock https://blamethestock.com/mcp'), 'Claude Code (hosted)');
  ok(md.includes('"args": ["-y", "blamethestock-mcp"]'), 'Claude Desktop JSON');
  ok(md.includes('npx -y blamethestock-mcp'), 'npx stdio');
  ok(/Read-only\. Not financial advice\./.test(md), 'note');
  ok(md.includes('can\'t be linked'), 'linking caveat');
  for (const f of ['README.md', 'package.json', 'server.json', 'src/index.js', 'src/remote.js', 'src/tools.js', 'Dockerfile']) {
    ok(!/\/Users\/|\/home\/|C:\\\\/.test(readPkgFile(f)), f + ' has no machine paths');
  }
});

// A project file (jsc only; null in a browser).
function readText(rel) {
  const url = import.meta.url;
  if (typeof read === 'function' && /^file:/.test(url)) {
    const dir = decodeURIComponent(url.replace(/^file:\/\//, '')).replace(/[^/]*$/, '');
    try { return read(dir + '../../' + rel); } catch (e) { return null; }
  }
  return null;
}

// =========================================================================================================
suite('mcp › hosted (no chain reads on Cloudflare)');

async function obsynListing() {
  const fx = await loadFixture();
  const head = fx.index.head;
  const index = fixtureIndex(fx.index.rows, { lastBlock: head.number, lastRun: head.time });
  return { fx, index, head, listing: { ...(await copyMatches({ query: 'OBSYN', db: index, now: head.time * 1000 })), status: 'done' } };
}

test('check_copycats hosted: the index list with launch info and a clear note where the full facts are read', async () => {
  const { listing } = await obsynListing();
  const r = await M.runCheckCopycats({ query: 'OBSYN' }, { api: { copies: async () => listing }, hosted: true });
  const s = text(r);
  ok(!r.isError);
  ok(s.includes(M.HOSTED_NOTE), s.slice(0, 400));
  ok(/website|blamethestock\.com/.test(M.HOSTED_NOTE) && !M.HOSTED_NOTE.includes('npx'), 'the npm package is not published yet: not offered');
  ok(/launch index as of/.test(s));
  ok(/launched 2026-11-17 14:02:15 UTC; launch block \d+; chain facts not read here/.test(s), s);
  eq(r.structuredContent.facts, 'client');
  eq(r.structuredContent.matches.length, 4);
  eq(r.structuredContent.localPackage, undefined);
  proofsOk(s, 'copycats hosted');
  wordsOk(s, 'copycats hosted');
});

test('launch_report hosted: the launch basics plus the note; links_status "client"; not in the index said plainly', async () => {
  const basics = { ok: true, status: 'basics', clientSide: true, inIndex: true,
    token: { address: REAL, name: 'obsyn', symbol: 'OBSYN', isOfficial: false, pons: { launchTx: '0xec919f76f60857d7e76be568966af6e3e1f8b3b0e590d77276c5bbb37419df0c', launchBlock: 116638986, launchTime: '2026-11-17T14:14:00Z' } },
    launch: { token: REAL, creator: DEV, tx_from: null }, note: 'n' };
  let linksAsked = 0;
  const r = await M.runLaunchReport({ token: REAL }, { api: { report: async () => basics, links: async () => { linksAsked++; return noLinks(); } }, hosted: true });
  const s = text(r);
  ok(s.startsWith('Launch basics for OBSYN (obsyn) ' + REAL), s);
  ok(s.includes('Launch: 2026-11-17 14:14:00 UTC, block 116638986'));
  ok(s.includes('Launched by ' + DEV));
  ok(s.includes(M.HOSTED_NOTE));
  eq([r.structuredContent.status, r.structuredContent.links_status, r.structuredContent.links], ['basics', 'client', null]);
  eq(linksAsked, 0, 'no wallet links asked for hosted');
  proofsOk(s, 'report hosted');
  wordsOk(s, 'report hosted');
  const none = await M.runLaunchReport({ token: REAL }, { api: { report: async () => ({ ok: true, status: 'basics', inIndex: false, token: { address: REAL }, launch: null }) }, hosted: true });
  ok(/isn't in our launch index/.test(text(none)));
  wordsOk(text(none), 'report hosted, not indexed');
});

test('blame_split hosted: a clear note with the card link and the local package, without trying the chain', async () => {
  let called = 0;
  const r = await M.runBlameSplit({ token: REAL, window: '6h' }, { hosted: true, fetchPriceInput: async () => { called++; return priceInput(); }, cache: null });
  eq(called, 0);
  ok(!r.isError);
  eq(r.structuredContent.status, 'unavailable-hosted');
  eq(r.structuredContent.link, 'https://blamethestock.com/?ca=' + REAL + '&w=6h');
  ok(!text(r).includes('npx') && text(r).includes(r.structuredContent.link));
  wordsOk(text(r), 'split hosted');
  const local = await M.runBlameSplit({ token: REAL }, { fetchPriceInput: async () => priceInput(), cache: null });
  ok(local.structuredContent.ok === true, 'outside the Worker it still computes the split');
});

// =========================================================================================================
suite('mcp › local package (reads the chain on the user\'s machine)');

test('check_copycats locally: the hosted list, then full facts and flags read here (same as the website)', async () => {
  const { fx, listing } = await obsynListing();
  const direct = JSON.parse(JSON.stringify(await runScenario({ query: 'OBSYN' }, fx)));
  const chain = replayFetch(fx);
  const urls = [];
  const fetchFn = async (url, init) => {
    if (String(url).startsWith('http://api.test')) { urls.push(url); return { status: 200, json: async () => JSON.parse(JSON.stringify(listing)) }; }
    return chain(url, init);
  };
  _resetShared();
  const tools = localTools({ base: 'http://api.test', fetch: fetchFn, sleep: async () => {}, settings: { trust: {} }, transport: { sleep: async () => {}, backoff: [0], timeouts: false } });
  const r = await tools.run('check_copycats', { query: 'OBSYN' });
  eq(urls, ['http://api.test/v1/copies?q=OBSYN']);
  ok(!r.isError, text(r));
  const { disclaimer, ...rest } = r.structuredContent;
  eq(JSON.stringify(rest.matches), JSON.stringify(direct.matches), 'the same facts as reading everything in one place');
  ok(!text(r).includes(M.HOSTED_NOTE), 'no "facts not read" note: they were read');
  const copy = rest.matches.find((m) => m.address === OBSYN.copy);
  eq(copy.flags.filter((f) => f.severity === 'warn').map((f) => f.code).sort(), ['dev-dumped-fast', 'fees-and-left', 'launched-just-before']);
  wordsOk(text(r), 'copycats local');
});

test('launch_report locally: built here from the hosted launch row, then wallet links (recorded OBSYN)', async () => {
  const fx = await loadReportFixture();
  const row = fx.index.rows.find((x) => x.token === REAL);
  const basics = { ok: true, status: 'basics', inIndex: true, token: { address: REAL }, launch: row };
  const chain = replayFetch(fx);
  const asked = [];
  const fetchFn = async (url, init) => {
    if (String(url).startsWith('http://api.test')) { asked.push(url); return { status: 200, json: async () => basics }; }
    return chain(url, init);
  };
  _resetShared();
  const now = (fx.index.head.time + 60) * 1000;
  const realNow = Date.now;
  Date.now = () => now;
  let r;
  try {
    const tools = localTools({ base: 'http://api.test', fetch: fetchFn, sleep: async () => {}, settings: { trust: {} }, transport: { sleep: async () => {}, backoff: [0], timeouts: false } });
    r = await tools.run('launch_report', { token: REAL });
  } finally { Date.now = realNow; }
  eq(asked, ['http://api.test/v1/report/' + REAL]);
  ok(!r.isError, text(r).slice(0, 300));
  const j = r.structuredContent;
  eq(j.status, 'done');
  eq(j.dev.address, DEV);
  eq(Math.round(j.dev.buy.pct * 1000) / 1000, 1.142);
  eq(j.snipers.wallets.length, 9);
  eq(Math.round(j.snipers.totalPct * 10) / 10, 20.5);
  eq(j.graduation.time, '2026-11-17T19:31:25Z');
  ok(j.dev.fees.claims.length >= 1);
  eq(j.links_status, 'ok');
  ok(!j.notes.some((n) => /isn't in our launch index yet/.test(n)), 'the hosted row was used, not a chain lookup');
  ok(/Heavily sniped by bots \(20\.5% in 3 s/.test(text(r)));
  wordsOk(text(r), 'report local');
});

test('the package\'s shared code is an exact copy of the project\'s (run dev/tools/sync_mcp.sh after a change)', () => {
  const list = readText('mcp/src/shared-files.txt');
  if (list == null) return;                       // browser runner: no file access
  const files = list.split('\n').filter(Boolean);
  ok(files.length >= 25 && files.includes('api/src/mcp.js') && files.includes('site/src/trust/copycheck.js') && files.includes('site/src/trust/local.js'), files.join(' '));
  for (const f of files) {
    const a = readText(f), b = readText('mcp/src/shared/' + f);
    ok(a != null && a === b, f + ' differs from mcp/src/shared/' + f);
  }
  const pkg = JSON.parse(readText('mcp/package.json'));
  ok(pkg.files.includes('src'), 'the copies ship inside src/');
  ok(!/\/Users\//.test(readText('mcp/src/local.js')), 'no machine paths');
});

