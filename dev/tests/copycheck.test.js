// Copy check ("Is this the real one?"): name skeletons, near-match keys, the flag rules and their thresholds,
// verdict wording, per-coin facts from the chain, and the API route logic.
// Offline. The OBSYN case replays answers recorded once from Robinhood Chain and Blockscout
// (dev/tests/fixtures/obsyn/*.json, made by dev/tools/record_obsyn.py) through an injected fetch.
import { suite, test, eq, near, ok } from './harness.js';
import { skeleton, nearKeys, isHiddenChar, isLookalikeChar } from '../../site/src/trust/skeleton.js';
import * as R from '../../site/src/trust/rules.js';
import { makeExplorer, holdersFromTransfers, decodeText, normalizeRow, gatherFacts, makeContext, ADDR, TOPIC, pad } from '../../site/src/trust/facts.js';
import { copyCheck, d1Index, MAX_KEYS } from '../../api/src/copies.js';
import { _setTransport } from '../../site/src/data/rpc.js';
import { FACTORY_ADDRESSES } from '../../api/src/env.js';
import { loadFixture, runScenario, replayFetch, fixtureIndex, SCENARIOS, OBSYN } from './fixtures/obsyn/replay.js';

const EXPLORER = 'https://robinhoodchain.blockscout.com';
const PROOF = /^https:\/\/robinhoodchain\.blockscout\.com\/(tx|address|token)\/0x[0-9a-f]+$/;
const BLAME = '0x00000000000000000000000000000000000b1a3e';
const noSleep = async () => {};
const codes = (m) => m.flags.map((f) => f.code).sort();
const warnCodes = (m) => m.flags.filter((f) => f.severity === 'warn').map((f) => f.code).sort();

// =========================================================================================================
suite('copy check › skeleton');

test('hidden word joiners, $, fullwidth and plain all give usdg', () => {
  for (const s of ['U\u2060S\u2060DG', 'U\u206FS\u206FDG', 'USDG', '$usdg', 'ＵＳＤＧ', ' usdg ', 'U\u200BSD\uFEFFG', 'US\u00ADDG', 'U\u034FSDG', 'USDG\uFE0F', '𝐔𝐒𝐃𝐆']) {
    eq(skeleton(s), 'usdg', JSON.stringify(s));
  }
});

test('Cyrillic and Greek look-alikes map to Latin', () => {
  eq(skeleton('U\u0405DG'), 'usdg', 'Cyrillic capital DZE');
  eq(skeleton('u\u0455dg'), 'usdg', 'Cyrillic small dze');
  eq(skeleton('\u041EBSYN'), 'obsyn', 'Cyrillic capital O');
  eq(skeleton('\u039FBSYN'), 'obsyn', 'Greek capital Omicron');
  eq(skeleton('\u043Ebsyn'), 'obsyn', 'Cyrillic small o');
  const cyr = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'к': 'k', 'м': 'm', 'н': 'h', 'т': 't', 'в': 'b' };
  for (const [ch, to] of Object.entries(cyr)) eq(skeleton(ch), to, 'Cyrillic ' + ch);
  const grk = { 'Α': 'a', 'Β': 'b', 'Ε': 'e', 'Ζ': 'z', 'Η': 'h', 'Ι': 'i', 'Κ': 'k', 'Μ': 'm', 'Ν': 'n', 'Ο': 'o', 'Ρ': 'p', 'Τ': 't', 'Χ': 'x', 'Υ': 'y', 'ο': 'o', 'ν': 'v', 'ι': 'i' };
  for (const [ch, to] of Object.entries(grk)) eq(skeleton(ch), to, 'Greek ' + ch);
});

test('punctuation, spaces and case are dropped; digits stay digits', () => {
  eq(skeleton('Blame the Stock!'), 'blamethestock');
  eq(skeleton('$B.L-A_M E'), 'blame');
  eq(skeleton('USD0'), 'usd0');
  ok(skeleton('USD0') !== skeleton('USDO'), '0 and O stay different (found as near matches instead)');
  eq(skeleton(''), '');
  eq(skeleton(null), '');
  eq(skeleton('$$$ !!'), '');
});

test('near keys: one character dropped, one look-alike swapped', () => {
  const k = nearKeys('obsyn');
  for (const want of ['bsyn', 'osyn', 'obyn', 'obsn', 'obsy', '0bsyn', 'ob5yn']) ok(k.includes(want), want);
  ok(!k.includes('obsyn'), 'not the skeleton itself');
  ok(nearKeys('usd0').includes('usdo') && nearKeys('usdo').includes('usd0'), '0 <-> o both ways');
  eq(nearKeys('abc').filter((x) => x.length === 2), [], 'no deletions under 4 characters');
  ok(nearKeys('mirn').includes('mim') && nearKeys('mim').includes('mirn'), 'rn <-> m');
});

test('display helpers show hidden and look-alike characters', () => {
  eq(R.nameShown('U\u2060S\u2060DG'), 'U·S·DG');
  eq(R.symbolShown('U\u206FS\u206FDG'), 'U·S·DG');
  eq(R.nameShown('\u041EBSYN'), '‹\u041E›BSYN');
  eq(R.nameShown('OBSYN'), 'OBSYN');
  eq(R.nameShown('Café'), 'Café', 'accented Latin is not marked');
  ok(isHiddenChar('\u2060') && isHiddenChar('\uFEFF') && !isHiddenChar('a') && !isHiddenChar(' '));
  ok(isLookalikeChar('\u0405') && isLookalikeChar('Ｕ') && !isLookalikeChar('U') && !isLookalikeChar('é'));
  eq(R.oddChars('U\u2060S\u2060DG', '\u041EBS'), { hidden: 2, lookalike: 1 });
});

// =========================================================================================================
suite('copy check › rules');

const T0 = Date.parse('2026-11-17T14:00:00Z') / 1000;
const at = (s) => new Date((T0 + s) * 1000).toISOString().replace('.000Z', 'Z');
const tx = (n) => '0x' + String(n).padStart(64, '0');
const ad = (n) => '0x' + String(n).padStart(40, '0');
function mk(o = {}) {
  return {
    address: ad(o.n || 1), name: 'X', symbol: 'X', match: 'exact', isQuery: false, isOfficial: false, curve: ad(900 + (o.n || 1)),
    launch: { tx: tx(o.n || 1), block: 100 + (o.t || 0), time: at(o.t || 0) },
    devBuy: { tokens: 1000, pctSupply: 1, tx: tx(o.n || 1) }, devSold: null, fees: null, bridges: [], holders: null,
    liquidity: null, graduated: null, snipers: [], tradesRecent: null, missing: [], flags: [], ...o,
  };
}
const flagged = (code, matches, opts = {}) => R.applyFlags(matches, opts).map((m) => m.flags.some((f) => f.code === code));

test('settings: defaults, overrides from settings.trust, bad values ignored', () => {
  const t = R.trustSettings(null);
  eq([t.launchedJustBeforeMinutes, t.devDumpPct, t.devDumpMinutes, t.feesAndLeftMinutes, t.deadCopyUsd, t.sameSnipersMin, t.sniperWindowBlocks],
    [60, 90, 10, 60, 500, 3, 48]);
  eq(t.official, []);
  const u = R.trustSettings({ trust: { deadCopyUsd: 1000, devDumpPct: 'x', sameSnipersMin: -2, official: [{ symbol: '$BLAME', address: BLAME.toUpperCase().replace('0X', '0x') }, { symbol: 'BAD', address: '0x12' }] } });
  eq([u.deadCopyUsd, u.devDumpPct, u.sameSnipersMin], [1000, 90, 3]);
  eq(u.official, [{ symbol: 'BLAME', address: BLAME, skeleton: 'blame' }]);
  eq(R.trustSettings({ deadCopyUsd: 50 }).deadCopyUsd, 50, 'the trust block itself works too');
});

test('launched just before: up to 60 min before the graduated coin, exact matches only', () => {
  const ref = () => mk({ n: 2, t: 3600, graduated: { time: at(9000), tx: tx(99) } });
  eq(flagged('launched-just-before', [mk({ n: 1, t: 0 }), ref()]), [true, false], 'exactly 60 min');
  eq(flagged('launched-just-before', [mk({ n: 1, t: -1 }), ref()]), [false, false], '60 min 1 s');
  eq(flagged('launched-just-before', [mk({ n: 1, t: 4000 }), ref()]), [false, false], 'after it');
  eq(flagged('launched-just-before', [mk({ n: 1, t: 100, match: 'near' }), ref()]), [false, false], 'near match');
  eq(flagged('launched-just-before', [mk({ n: 1, t: 0 }), mk({ n: 2, t: 600 })]), [false, false], 'no graduated or most-held coin');
  const held = [mk({ n: 1, t: 0, holders: { count: 2 } }), mk({ n: 2, t: 600, holders: { count: 300 } })];
  eq(flagged('launched-just-before', held), [true, false], 'most-held coin as reference');
  const off = [mk({ n: 1, t: 0 }), mk({ n: 2, t: 1800, isOfficial: true })];
  R.applyFlags(off);
  ok(/official coin/.test(off[0].flags[0].text), off[0].flags[0].text);
});

test('dev dumped fast: 90% of the dev buy within 10 min', () => {
  const sold = (pct, s) => ({ pctOfDevBuy: pct, firstSellSecondsAfterLaunch: s, tx: tx(7), sells: [{ tx: tx(7), time: at(s), tokens: pct * 10 }] });
  eq(flagged('dev-dumped-fast', [mk({ devSold: sold(90, 600) })]), [true], '90% at 10:00');
  eq(flagged('dev-dumped-fast', [mk({ devSold: sold(89.9, 60) })]), [false], '89.9%');
  eq(flagged('dev-dumped-fast', [mk({ devSold: sold(100, 601) })]), [false], '10:01');
  eq(flagged('dev-dumped-fast', [mk({ devSold: sold(99.9999999, 71) })]), [true], 'dust left over');
  eq(flagged('dev-dumped-fast', [mk({ devSold: null })]), [false], 'never sold');
  const split = mk({ devSold: { pctOfDevBuy: 100, sells: [{ tx: tx(7), time: at(60), tokens: 500 }, { tx: tx(8), time: at(500), tokens: 450 }, { tx: tx(9), time: at(5000), tokens: 50 }] } });
  R.applyFlags([split]);
  eq(split.flags[0].text, 'Dev sold 95% of their launch buy 8 min 20 s after launch.');
  eq(R.applyFlags([mk({ devSold: sold(95, 60) })], { settings: { trust: { devDumpPct: 96 } } })[0].flags, [], 'threshold from settings');
});

test('took fees and left: a fee claim AND a bridge out, both within 60 min', () => {
  const fees = (s) => ({ claimedEth: 0.02, unclaimedEth: 0, claims: [{ tx: tx(5), time: at(s), eth: 0.02 }] });
  const br = (s) => [{ via: 'MetaBridge/Relay', eth: 0.04, time: at(s), tx: tx(6) }];
  eq(flagged('fees-and-left', [mk({ fees: fees(100), bridges: br(3600) })]), [true]);
  eq(flagged('fees-and-left', [mk({ fees: fees(100), bridges: br(3601) })]), [false], 'bridge after 60 min');
  eq(flagged('fees-and-left', [mk({ fees: fees(100), bridges: [] })]), [false], 'no bridge');
  eq(flagged('fees-and-left', [mk({ fees: null, bridges: br(10) })]), [false], 'no fees');
  const m = mk({ fees: fees(105), bridges: br(192) });
  R.applyFlags([m]);
  eq(m.flags[0].text, 'Dev claimed 0.02 ETH in fees and bridged 0.04 ETH out, all within 3 min 12 s of launch.');
});

test('dead copy: never graduated, under $500 and no recent trades', () => {
  const liq = (usd) => ({ quote: 0, quoteSymbol: 'ETH', usd, source: 'curve' });
  eq(flagged('dead-copy', [mk({ liquidity: liq(499), tradesRecent: 0 })]), [true]);
  eq(flagged('dead-copy', [mk({ liquidity: liq(500), tradesRecent: 0 })]), [false], '$500');
  eq(flagged('dead-copy', [mk({ liquidity: liq(10), tradesRecent: 3 })]), [false], 'still trading');
  eq(flagged('dead-copy', [mk({ liquidity: liq(10), tradesRecent: 0, graduated: { time: at(5), tx: tx(5) } })]), [false], 'graduated');
  eq(flagged('dead-copy', [mk({ liquidity: null, tradesRecent: 0 })]), [false], 'liquidity unknown');
  eq(flagged('dead-copy', [mk({ liquidity: liq(10), tradesRecent: 0, missing: ['graduated'] })]), [false], 'graduation unknown');
  const m = mk({ liquidity: liq(0.002), tradesRecent: 0 });
  R.applyFlags([m]);
  ok(/less than \$1 left/.test(m.flags[0].text), m.flags[0].text);
});

test('same snipers: 3 shared first buyers flag both coins (info only)', () => {
  const s = (...ws) => ws.map((w) => ({ wallet: ad(w) }));
  const a = mk({ n: 1, snipers: s(11, 12, 13, 14) }), b = mk({ n: 2, snipers: s(11, 12, 13) }), c = mk({ n: 3, snipers: s(11, 12, 99) });
  R.applyFlags([a, b, c]);
  eq([codes(a), codes(b), codes(c)], [['same-snipers'], ['same-snipers'], []]);
  eq(a.flags[0].severity, 'info');
  eq(a.flags[0].wallets.length, 3);
});

test('name of an official coin: every other exact match, never the official one', () => {
  const official = { symbol: 'BLAME', address: BLAME, skeleton: 'blame' };
  const ms = [mk({ n: 1, symbol: '$BLAME' }), mk({ n: 2, address: BLAME, isOfficial: true, symbol: 'BLAME' }), mk({ n: 3, match: 'near', symbol: 'BLAM' }),
    mk({ n: 4, symbol: 'X', name: 'Blame' }), mk({ n: 5, symbol: 'FOO', name: 'Foo' })];
  eq(flagged('name-of-official', ms, { official }), [true, false, false, true, false]);
  ok(ms[0].flags[0].text.includes(BLAME));
  eq(ms[0].flags[0].severity, 'warn');
});

test('verdict: near matches and rows not read in full are counted, but never as "this name"', () => {
  const q = { kind: 'ticker' };
  const ex = (n) => mk({ n }), nr = (n) => mk({ n, match: 'near' });
  eq(R.buildVerdict({ query: q, matches: [ex(1), ex(2), nr(3)], official: null }), '2 Pons coins use this name. 1 more has a similar name.');
  eq(R.buildVerdict({ query: q, matches: [nr(1), nr(2)], official: null }), 'No Pons coin uses this name. 2 have a similar name.');
  eq(R.buildVerdict({ query: q, matches: [ex(1), ex(2)], official: null, totals: { exact: 15, near: 4 } }), '15 Pons coins use this name. 4 more have a similar name.');
  const qa = { kind: 'address', address: ad(1), isPons: true };
  eq(R.buildVerdict({ query: qa, matches: [mk({ n: 1, isQuery: true }), nr(2)], official: null }), 'No other Pons coin uses this name. 1 has a similar name.');
});

test('verdict wording', () => {
  const q = { kind: 'ticker' };
  const quick = mk({ n: 1, flags: [{ code: 'dev-dumped-fast' }] });
  eq(R.buildVerdict({ query: q, matches: [], official: null }), 'No Pons coin uses this name.');
  eq(R.buildVerdict({ query: q, matches: [quick, mk({ n: 2 }), mk({ n: 3 })], official: null }), '3 Pons coins use this name. 1 had its dev sell within minutes.');
  const qa = { kind: 'address', address: ad(2), isPons: true };
  eq(R.buildVerdict({ query: qa, matches: [quick, mk({ n: 2, isQuery: true })], official: null }), '1 other coin uses this name. 1 had its dev sell within minutes.');
  // "quick copy" = launched just before a same-name coin, or uses the official coin's name; never only "dev sold fast"
  const copy = mk({ n: 4, flags: [{ code: 'launched-just-before' }, { code: 'dev-dumped-fast' }] });
  const left = mk({ n: 5, flags: [{ code: 'fees-and-left' }] });
  eq(R.buildVerdict({ query: q, matches: [quick, copy, left, mk({ n: 6 })], official: null }),
    '4 Pons coins use this name. 1 looks like a quick copy. 1 had its dev sell within minutes. 1 had its dev take fees and bridge out within the hour.');
  const quick2 = mk({ n: 7, flags: [{ code: 'dev-dumped-fast' }] });
  eq(R.buildVerdict({ query: q, matches: [quick, quick2], official: null }), '2 Pons coins use this name. 2 had their devs sell within minutes.');
  eq(R.buildVerdict({ query: qa, matches: [mk({ n: 2, isQuery: true, flags: [{ code: 'dev-dumped-fast' }] }), mk({ n: 8 })], official: null }),
    '1 other coin uses this name. The coin you pasted has warning flags.');
  eq(R.buildVerdict({ query: { kind: 'address', address: ad(5), isPons: false }, matches: [], official: null }), 'This coin wasn\'t launched on Pons. No Pons coin uses this name.');
  const official = { symbol: 'BLAME', address: BLAME };
  eq(R.buildVerdict({ query: { kind: 'address', address: BLAME, isPons: true }, matches: [mk({ n: 2, isOfficial: true, isQuery: true })], official }),
    'This is the official $BLAME. No other Pons coin uses this name.');
});

test('wording never says scam or safe, and never gives advice', () => {
  const texts = R.CAVEATS.slice();
  const m = mk({ n: 1, t: 0, devSold: { pctOfDevBuy: 100, sells: [{ tx: tx(7), time: at(60), tokens: 1000 }] },
    fees: { claims: [{ tx: tx(5), time: at(100), eth: 0.1 }] }, bridges: [{ via: 'Across', eth: 0.1, time: at(200), tx: tx(6) }],
    liquidity: { usd: 3 }, tradesRecent: 0, snipers: [{ wallet: ad(1) }, { wallet: ad(2) }, { wallet: ad(3) }] });
  const r = mk({ n: 2, t: 600, graduated: { time: at(900), tx: tx(9) }, snipers: [{ wallet: ad(1) }, { wallet: ad(2) }, { wallet: ad(3) }] });
  R.applyFlags([m, r], { official: { symbol: 'X', address: BLAME } });
  for (const f of m.flags.concat(r.flags)) texts.push(f.text);
  texts.push(R.buildVerdict({ query: { kind: 'ticker' }, matches: [m, r], official: null }));
  for (const t of texts) ok(!/\b(scam|safe|rug|buy now|sell now|should)\b/i.test(t), t);
  eq(codes(m), ['dev-dumped-fast', 'fees-and-left', 'launched-just-before', 'name-of-official', 'same-snipers', 'dead-copy'].sort());
});

test('small formatters', () => {
  eq([R.duration(71), R.duration(705), R.duration(3600), R.duration(5 * 3600 + 17 * 60), R.duration(86400 * 3)], ['1 min 11 s', '11 min 45 s', '1 h', '5 h 17 min', '3 days']);
  eq([R.ethAmount(0.025814298), R.ethAmount(0.18), R.ethAmount(2.0735), R.ethAmount(0), R.ethAmount(0.00001)], ['0.0258 ETH', '0.18 ETH', '2.07 ETH', '0 ETH', '<0.0001 ETH']);
  eq([R.usdAmount(499.6), R.usdAmount(7471.7), R.usdAmount(41937), R.usdAmount(1.4e6)], ['$500', '$7.5k', '$42k', '$1.4M']);
  eq([R.pctText(99.9999), R.pctText(1.14216), R.pctText(20.5)], ['100%', '1.1%', '21%']);
});

// =========================================================================================================
suite('copy check › chain helpers');

function fakeRes(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] || null }, json: async () => body };
}

test('explorer: Accept JSON + generic UA; a challenge is never retried', async () => {
  const seen = [];
  const ex = makeExplorer({ fetch: async (url, init) => { seen.push([url, init.headers]); return fakeRes(403, null, { 'content-type': 'text/html', 'cf-mitigated': 'challenge' }); }, sleep: noSleep });
  eq(await ex.get('/api/v2/tokens/0x1'), { ok: false, reason: 'unavailable' });
  eq(seen.length, 1, 'one request, no retry');
  eq(seen[0][0], EXPLORER + '/api/v2/tokens/0x1');
  eq(seen[0][1].accept, 'application/json');
  ok(/^Mozilla\/5\.0 \(compatible; blamethestock\)$/.test(seen[0][1]['user-agent']));
  eq(await ex.get('/api/v2/tokens/0x2'), { ok: false, reason: 'unavailable' });
  eq(seen.length, 1, 'stays unavailable for the rest of the request');
});

test('explorer: 429 backs off once, then unavailable; 404 is an answer', async () => {
  let n = 0;
  const waits = [];
  const ex = makeExplorer({ fetch: async () => { n++; return fakeRes(429, {}); }, sleep: async (ms) => { waits.push(ms); } });
  eq((await ex.get('/x')).reason, 'unavailable');
  eq([n, waits], [2, [2000]]);
  const ex2 = makeExplorer({ fetch: async (u) => (u.endsWith('/a') ? fakeRes(404, {}) : fakeRes(200, { holders_count: '7' }, { 'content-type': 'application/json' })), sleep: noSleep });
  eq(await ex2.get('/a'), { ok: false, reason: 'not-found' });
  eq((await ex2.get('/b')).json.holders_count, '7');
  ok(!ex2.isDown());
});

test('holders from Transfer logs leave out curve, pool, burn and zero addresses', () => {
  const w = (n) => BigInt(n).toString(16).padStart(64, '0');
  const tr = (from, to, v) => ({ topics: [TOPIC.TRANSFER, pad(from), pad(to)], data: '0x' + w(v) });
  const curve = ad(77);
  const logs = [tr(ADDR.ZERO, curve, 1000), tr(curve, ad(1), 300), tr(curve, ad(2), 200), tr(ad(2), curve, 200), tr(ad(1), ADDR.DEAD, 100), tr(ad(1), ad(3), 1)];
  eq(holdersFromTransfers(logs, { curve }), 2);
});

test('token names keep hidden characters; rows normalise', () => {
  const s = 'U\u2060S\u2060DG';
  const bytes = unescape(encodeURIComponent(s));
  let h = '';
  for (let i = 0; i < bytes.length; i++) h += bytes.charCodeAt(i).toString(16).padStart(2, '0');
  const enc = '0x' + (32).toString(16).padStart(64, '0') + (h.length / 2).toString(16).padStart(64, '0') + h.padEnd(64, '0');
  eq(decodeText(enc), s);
  eq(decodeText('0x'), '');
  const r = normalizeRow({ token: '0xABC', tx_from: '0xDEF', pair_token: null, block: '5', time: 9 });
  eq([r.token, r.txFrom, r.pairToken, r.block, r.time], ['0xabc', '0xdef', ADDR.ZERO, 5, 9]);
});

// =========================================================================================================
suite('copy check › OBSYN (recorded from the chain)');

const results = new Map();
async function scenario(name) {
  if (!results.has(name)) {
    const fx = await loadFixture();
    const sc = SCENARIOS.find((s) => s.name === name);
    const misses = { rpc: new Map(), explorer: new Set() };
    const r = await runScenario(sc, fx, { misses });
    if (misses.rpc.size || misses.explorer.size) {
      throw new Error('request not in the fixture (re-record with dev/tools/record_obsyn.py): ' + [...misses.rpc.keys(), ...misses.explorer][0]);
    }
    results.set(name, r);
  }
  return results.get(name);
}
const row = (res, a) => res.matches.find((m) => m.address === a);

test('fixture: index rows are the 4 Pons OBSYN launches, recorded at one head block', async () => {
  const fx = await loadFixture();
  eq(fx.index.rows.map((r) => r.token), [OBSYN.early, OBSYN.copy, OBSYN.real, '0x17e222c5cdc77be5c20159f192255eec72525121']);
  ok(fx.index.head.number > 117000000);
  for (const r of fx.index.rows) eq(skeleton(r.symbol), 'obsyn');
});

test('ticker OBSYN: every Pons OBSYN, earliest first, with the verdict', async () => {
  const r = await scenario('ticker OBSYN');
  eq(r.ok, true);
  eq(r.query, { input: 'OBSYN', kind: 'ticker', skeleton: 'obsyn' });
  eq(r.matches.map((m) => m.address), [OBSYN.early, OBSYN.copy, OBSYN.real, '0x17e222c5cdc77be5c20159f192255eec72525121']);
  ok(r.matches.every((m) => m.match === 'exact' && !m.isQuery && !m.isOfficial && m.isPons));
  eq(r.official, null);
  // the copycat is the quick copy; 0x0188 (the earliest) only had its dev sell fast, so it is not called a copy
  eq(r.verdict, '4 Pons coins use this name. 1 looks like a quick copy. 1 had its dev sell within minutes.');
  eq(r.indexComplete, true);
  eq(r.indexedFrom, '2026-11-17T09:08:22Z');
  ok(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(r.asOf), r.asOf);
  ok(r.caveats.some((c) => /Pons launches only/.test(c)) && r.caveats.some((c) => /not financial advice/.test(c)));
  eq(r.matches.map((m) => m.missing), [[], [], [], []], 'every fact was read');
});

test('copycat 0x7a2A: launched 11 min 45 s before, dev dumped in 71 s, fees and left, dead', async () => {
  const r = await scenario('copycat address');
  const c = row(r, OBSYN.copy), real = row(r, OBSYN.real);
  ok(c.isQuery);
  eq(r.query.isPons, true);
  eq([r.query.name, r.query.symbol], ['Obsyn', 'OBSYN']);
  eq(c.launch, { tx: '0x4bc46deb3992adf8fe404f7833e91dfbe273f1a87368e5a8725b2e581a49cc05', block: 116632087, time: '2026-11-17T14:02:15Z' });
  eq(Date.parse(real.launch.time) - Date.parse(c.launch.time), (11 * 60 + 45) * 1000);
  eq(c.creator, '0xf67bb00a4cd3862fa68a0fe151fbcfec291eb2fd');
  near(c.devBuy.eth, 0.015, 1e-12);
  near(c.devBuy.pctSupply, 0.859, 0.0005);
  near(c.devSold.pctOfDevBuy, 100, 1e-6, 'the whole launch buy (chain: same raw amount in and out)');
  eq(c.devSold.firstSellSecondsAfterLaunch, 71);
  eq(c.devSold.tx, '0x9ce4cb2b18fbbf25ea6e1e353ad56525f554a8d29cf23e6838cff2267affc4f7');
  near(c.fees.claimedEth, 0.025814, 1e-6);
  eq(c.fees.claims.map((x) => x.time), ['2026-11-17T14:04:00Z']);
  eq(c.bridges.length, 1);
  eq([c.bridges[0].via, c.bridges[0].time, c.bridges[0].destChainId, c.bridges[0].destChainConfirmed], ['MetaBridge/Relay', '2026-11-17T14:05:27Z', 56, false],
    'chain 56 comes from MetaBridge\'s own event only');
  near(c.bridges[0].eth, 0.047287, 1e-6);
  eq(c.graduated, null);
  ok(c.liquidity.usd < 1, 'nothing left on the curve');
  eq(c.holders.source, 'blockscout');
  eq(warnCodes(c), ['dev-dumped-fast', 'fees-and-left', 'launched-just-before']);
  eq(codes(c), ['dead-copy', 'dev-dumped-fast', 'fees-and-left', 'launched-just-before', 'same-snipers']);
  eq(c.flags.find((f) => f.code === 'launched-just-before').text, 'Launched 11 min 45 s before a coin with the same name that later graduated (0x5d99…4351).');
  eq(c.flags.find((f) => f.code === 'dev-dumped-fast').text, 'Dev sold 100% of their launch buy 1 min 11 s after launch.');
  eq(c.flags.find((f) => f.code === 'fees-and-left').text, 'Dev claimed 0.0258 ETH in fees and bridged 0.0473 ETH out, all within 3 min 12 s of launch.');
  eq(r.verdict, '3 other coins use this name. 1 had its dev sell within minutes. The coin you pasted has warning flags.');
});

test('real 0x5D99: dev bought 1.142%, never sold, fees claimed, bridged to Base, graduated, no warnings', async () => {
  const r = await scenario('real address');
  const m = row(r, OBSYN.real);
  ok(m.isQuery);
  eq(m.launch.time, '2026-11-17T14:14:00Z');
  eq(m.creator, '0x03412baadd3d3207506e89cebb051ab713295c32');
  near(m.devBuy.tokens, 11421611.03, 0.01);
  near(m.devBuy.pctSupply, 1.142, 0.0005);
  eq(m.devSold, null, 'never sold');
  eq(m.fees.claims[0].time, '2026-11-17T19:27:05Z');
  near(m.fees.claims[0].eth, 0.482236, 1e-6);
  // Recorded 2026-11-18 ~08:46 UTC: the dev claimed the ~1.59 ETH that had built up (08:28:18), so nothing was
  // left unclaimed at that block. These two numbers move with every trade; re-recording changes them.
  eq(m.fees.claims.map((x) => x.time), ['2026-11-17T19:27:05Z', '2026-11-18T08:28:18Z']);
  near(m.fees.claimedEth, 2.073543, 1e-6);
  near(m.fees.unclaimedEth, 0, 1e-12);
  eq(m.bridges.map((b) => [b.via, b.eth, b.time, b.destChainId, b.destChainConfirmed]), [['MetaBridge/Across', 0.18, '2026-11-17T20:06:56Z', 8453, true]]);
  eq(m.graduated, { time: '2026-11-17T19:31:25Z', tx: '0x493778200eb20f599eead6f8fcfa9dce5dc8935d0a900a696d544b57b83497d4' });
  eq(m.liquidity.source, 'pool');
  ok(m.liquidity.usd > 1000 && m.liquidity.quoteSymbol === 'ETH');
  eq(m.holders, { count: 287, source: 'blockscout' });
  eq(warnCodes(m), [], 'no warning flags');
  eq(codes(m), ['same-snipers']);
  eq(r.verdict, '3 other coins use this name. 1 looks like a quick copy. 1 had its dev sell within minutes.');
});

test('snipers: 9 wallets took 20.5% in 3 s; routed buys name the buyer, not the router', async () => {
  const r = await scenario('real address');
  const m = row(r, OBSYN.real);
  eq(m.snipers.length, 9);
  near(m.snipers.reduce((s, x) => s + x.pctSupply, 0), 20.513, 0.001);
  ok(m.snipers.every((s) => s.blocksAfterLaunch >= 33 && s.blocksAfterLaunch <= 36));
  const ws = m.snipers.map((s) => s.wallet);
  ok(!ws.includes(ADDR.ROUTER) && !ws.includes(ADDR.LAUNCH_AND_BUY) && !ws.includes(m.creator), 'no router, LaunchAndBuy or dev');
  ok(ws.some((w) => w.startsWith('0x3e9e388b')) && ws.includes('0x0a70fea3ee47c8e64ea960135cb469afaab4fb49'));
});

test('same snipers: the same 9 wallets hit the copycat and the real one (info on both)', async () => {
  const r = await scenario('ticker OBSYN');
  const c = row(r, OBSYN.copy), m = row(r, OBSYN.real);
  const fc = c.flags.find((f) => f.code === 'same-snipers' && f.text.includes('0x5d99')), fm = m.flags.find((f) => f.code === 'same-snipers');
  eq([fc.severity, fm.severity], ['info', 'info']);
  eq(fc.wallets.length, 9);
  eq(fc.wallets.slice().sort(), m.snipers.map((s) => s.wallet).sort());
  eq(c.snipers.length, 10, 'plus one more wallet on the copycat');
  ok(/one bot operator; it doesn't link either dev/.test(fc.text));
});

test('0x0188 (09:08 UTC): earlier Pons OBSYN, dev sold all in 60 s and bridged out via Relay, no fee claim', async () => {
  const r = await scenario('09:08 OBSYN address');
  const m = row(r, OBSYN.early);
  ok(m.isQuery);
  eq(m.launch.time, '2026-11-17T09:08:22Z');
  eq(m.creator, '0x14540149914083c571dfc98a9ac48a06eff5c5bd');
  near(m.devBuy.eth, 0.025, 1e-12);
  near(m.devBuy.pctSupply, 1.4518, 0.0001);
  eq(m.devSold.firstSellSecondsAfterLaunch, 60);
  near(m.devSold.pctOfDevBuy, 100, 1e-6);
  eq(m.fees.claims, []);
  eq(m.bridges.map((b) => [b.via, b.time]), [['Relay', '2026-11-17T09:12:24Z'], ['Relay', '2026-11-17T09:12:33Z']]);
  near(m.bridges[0].eth, 0.02947, 1e-5);
  eq(m.graduated, null);
  eq(m.holders, { count: 4, source: 'blockscout' });
  // 5 h 6 min before the graduated coin: too early for "launched just before"; no claim: no "fees and left".
  eq(codes(m), ['dead-copy', 'dev-dumped-fast', 'same-snipers']);
  ok(m.flags.find((f) => f.code === 'same-snipers').text.includes('0x17e2…5121'));
  eq(r.verdict, '3 other coins use this name. 1 looks like a quick copy. The coin you pasted has warning flags.');
});

test('every number has a Blockscout proof link', async () => {
  const r = await scenario('ticker OBSYN');
  for (const m of r.matches) {
    for (const k of ['token', 'creator', 'launchTx']) ok(PROOF.test(m.proof[k]), m.address + ' ' + k + ' ' + m.proof[k]);
    for (const f of m.flags) {
      ok(f.proof.length > 0, f.code);
      for (const u of f.proof) ok(PROOF.test(u), f.code + ' ' + u);
    }
    for (const b of m.bridges) ok(/^0x[0-9a-f]{64}$/.test(b.tx));
    if (m.fees) for (const c of m.fees.claims) ok(/^0x[0-9a-f]{64}$/.test(c.tx));
  }
});

test('explorer down: holders counted from Transfer logs, MetaBridge bridges marked unknown', async () => {
  const f = await scenario('copycat, explorer down');
  eq(f.holders.source, 'transfers');
  eq(f.holders.count, 1, 'the dev\'s dust (the curve itself is left out)');
  eq(f.bridges, []);
  ok(f.missing.includes('bridges'), 'bridges are partial, not "none"');
  near(f.devSold.pctOfDevBuy, 100, 1e-6, 'dev moves need no explorer');
  near(f.fees.claimedEth, 0.025814, 1e-6);
  const [m] = R.applyFlags([{ ...f, match: 'exact', isQuery: true, isOfficial: false }]);
  ok(!codes(m).includes('fees-and-left'), 'no flag on a fact that could not be read');
});

test('Multicall3 launches: the dev is the tx sender', async () => {
  const fx = await loadFixture();
  const fetchFn = replayFetch(fx);
  _setTransport({ fetch: fetchFn, sleep: noSleep, backoff: [0], timeouts: false });
  const ctx = await makeContext({ fetch: fetchFn, sleep: noSleep, factories: FACTORY_ADDRESSES });
  const r = fx.index.rows.find((x) => x.token === OBSYN.copy);
  const f = await gatherFacts({ ...r, creator: ADDR.MULTICALL3 }, ctx);
  eq(f.creator, '0xf67bb00a4cd3862fa68a0fe151fbcfec291eb2fd');
  near(f.devBuy.pctSupply, 0.859, 0.0005);
});

// =========================================================================================================
suite('copy check › API route');

// A tiny chain: a head block, '0x' for every eth_call (no contract), nothing in logs.
function tinyChain({ head = 117000000, time = 1794990000, fail = false } = {}) {
  return async (url, init) => {
    if (fail) throw new TypeError('network down');
    if (String(url).startsWith(EXPLORER)) return fakeRes(404, {});
    const body = JSON.parse(init.body);
    const list = Array.isArray(body) ? body : [body];
    const out = list.map((c) => {
      let result = '0x';
      if (c.method === 'eth_getBlockByNumber') result = { number: '0x' + head.toString(16), timestamp: '0x' + time.toString(16), hash: '0x1' };
      if (c.method === 'eth_getLogs') result = [];
      return { jsonrpc: '2.0', id: c.id, result };
    });
    return fakeRes(200, Array.isArray(body) ? out : out[0]);
  };
}
function blameRow(n, o = {}) {
  return { token: n === 0 ? BLAME : ad(n), factory: FACTORY_ADDRESSES[0], curve: ad(5000 + n), creator: ad(7000 + n), tx_from: ad(7000 + n),
    pair_token: ADDR.ZERO, block: 117000000 - 1000 + n, log_index: 0, time: 1794990000 - 100 + n, tx: tx(n + 1), name: 'Blame', symbol: 'BLAME', ...o };
}
const stubGather = async (raw) => {
  const r = normalizeRow(raw);
  return { address: r.token, name: r.name, symbol: r.symbol, factory: r.factory, curve: r.curve, launch: { tx: r.tx, block: r.block, time: new Date(r.time * 1000).toISOString().replace('.000Z', 'Z') },
    creator: r.creator, devBuy: null, devSold: null, fees: null, bridges: [], holders: null, liquidity: null, graduated: null, snipers: [], tradesRecent: null, missing: [],
    proof: { token: R.tokenUrl(r.token), creator: R.addressUrl(r.creator), launchTx: R.txUrl(r.tx) } };
};
const OFFICIAL = { trust: { official: [{ symbol: 'BLAME', address: BLAME }] } };
function route(query, rows, o = {}) {
  const db = fixtureIndex(rows, { lastBlock: 117000000, lastRun: 1794990000, ...(o.state || {}) });
  return copyCheck({ query, db: o.db === undefined ? db : o.db, fetch: o.fetch || tinyChain(), settings: o.settings === undefined ? OFFICIAL : o.settings,
    now: 1794990000 * 1000, gather: o.gather || stubGather, sleep: noSleep }).then((r) => ({ r, db }));
}

test('official $BLAME: official set, the official row marked, every other same-name row flagged', async () => {
  const rows = [blameRow(0), blameRow(1), blameRow(2, { symbol: '$BL\u0410ME' }), blameRow(3, { symbol: 'BLAM', name: 'Blam' })];
  for (const q of ['BLAME', '$blame', 'ＢＬＡＭＥ']) {
    const { r } = await route(q, rows);
    eq(r.ok, true, q);
    eq(r.official, { symbol: 'BLAME', address: BLAME }, q);
    const off = r.matches.filter((m) => m.isOfficial);
    eq(off.map((m) => m.address), [BLAME], q);
    eq(off[0].flags, [], 'the official coin gets no name flag');
    for (const m of r.matches.filter((x) => !x.isOfficial && x.match === 'exact')) ok(codes(m).includes('name-of-official'), q + ' ' + m.address);
    const nearRow = r.matches.find((m) => m.address === ad(3));
    eq(nearRow.match, 'near');
    eq(r.matches.find((m) => m.address === ad(2)).symbolShown, '$BL‹\u0410›ME');
    ok(r.verdict.startsWith('The official $BLAME is 0x0000…1a3e.'), r.verdict);
  }
});

test('official $BLAME by address, and a same-name coin by address', async () => {
  const rows = [blameRow(0), blameRow(1)];
  const a = (await route(BLAME, rows)).r;
  eq(a.verdict, 'This is the official $BLAME. 1 other coin uses this name. 1 looks like a quick copy.', 'it uses the official name');
  ok(a.matches.find((m) => m.address === BLAME).isQuery);
  const b = (await route(ad(1).toUpperCase().replace('0X', '0x'), rows)).r;
  ok(b.verdict.startsWith('This is not the official $BLAME. The official one is 0x0000…1a3e.'), b.verdict);
  ok(codes(b.matches.find((m) => m.isQuery)).includes('name-of-official'));
});

test('no official list (before launch): no badge, no name flag', async () => {
  const { r } = await route('BLAME', [blameRow(0), blameRow(1)], { settings: null });
  eq(r.official, null);
  ok(r.matches.every((m) => !m.isOfficial && !codes(m).includes('name-of-official')));
});

test('index lookups: exact + near keys from the query, capped for D1', async () => {
  const { db } = await route('OBSYN', []);
  const keys = db.calls.find((c) => c[0] === 'skeletons')[1];
  eq(keys[0], 'obsyn');
  for (const k of ['bsyn', 'obsy', '0bsyn', 'ob5yn']) ok(keys.includes(k), k);
  ok(keys.length <= MAX_KEYS);
  const long = (await route('ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRST', [])).db;
  ok(long.calls.find((c) => c[0] === 'skeletons')[1].length <= MAX_KEYS);
});

test('more than 12 matches: top 12 read in full, the rest noted', async () => {
  const rows = [];
  for (let i = 1; i <= 15; i++) rows.push(blameRow(i));
  let n = 0;
  const { r } = await route('BLAME', rows, { settings: null, gather: (raw) => { n++; return stubGather(raw); } });
  eq([n, r.matches.length], [12, 12]);
  ok(r.notes.some((x) => /Showing the top 12 of 15 matches.*3 more matches not shown/.test(x)), JSON.stringify(r.notes));
});

test('index still filling and index behind: said in notes', async () => {
  const rows = [blameRow(1)];
  const { r } = await route('BLAME', rows, { settings: null, state: { oldestBlock: 110000000, lastRun: 1794990000 - 3600 } });
  eq(r.indexComplete, false);
  ok(r.notes.some((x) => /Still indexing older launches: searching launches since \d{4}-\d\d-\d\d/.test(x)), JSON.stringify(r.notes));
  ok(r.notes.some((x) => /catching up/.test(x)));
});

test('errors: bad input, not found, index not ready, chain down', async () => {
  for (const q of ['', '   ', 'x'.repeat(101), '0x1234567', '$$$ !!']) eq((await route(q, [])).r.code, 'bad-input', JSON.stringify(q));
  eq((await route(ad(4242), [])).r.code, 'not-found');
  eq((await route('BLAME', [], { db: null })).r.code, 'index-behind');
  eq((await route('BLAME', [], { state: { lastBlock: null } })).r.code, 'index-behind');
  const down = (await route('BLAME', [blameRow(1)], { fetch: tinyChain({ fail: true }) })).r;
  eq([down.ok, down.code], [false, 'rpc-failed']);
  for (const e of [down]) ok(typeof e.message === 'string' && e.message.length > 5);
});

test('D1 index: one placeholder per key, bound once, rows and state read back', async () => {
  const seen = [];
  const db = {
    prepare(sql) {
      const st = { sql, args: [] };
      seen.push(st);
      return {
        bind(...a) { st.args = a; return this; },
        async all() {
          if (/FROM meta/.test(sql)) return { results: [{ key: 'last_block', value: '117000000' }, { key: 'oldest_block', value: '20000000' }, { key: 'last_run', value: '1794990000' }] };
          return { results: [blameRow(1)] };
        },
        async first() { return /ORDER BY block ASC/.test(sql) ? { block: 23350512, time: 1780000000 } : null; },
      };
    },
  };
  const ix = d1Index(db);
  const rows = await ix.findBySkeletons(['blame', 'blam', 'b1ame'], 500);
  eq(rows.length, 1);
  const q = seen[seen.length - 1];
  ok(/WHERE sym_skel IN \(\?1, \?2, \?3\) OR name_skel IN \(\?1, \?2, \?3\)/.test(q.sql), q.sql);
  eq(q.args, ['blame', 'blam', 'b1ame']);
  ok(/LIMIT 500$/.test(q.sql));
  eq(await ix.state(), { lastBlock: 117000000, oldestBlock: 20000000, lastRun: 1794990000, oldestTime: 1780000000 });
  eq(await ix.findByToken(ad(1)), null);
});

// =========================================================================================================
suite('copy check › verifier regressions');

test('more look-alikes from Unicode confusables: Lisu, Cherokee, Canadian, more Cyrillic/Greek, lunate sigma, stroked letters', () => {
  for (const s of ['ꓳBSYN', 'OBꓢYN', 'OᗷSYN', 'ØBSYN', 'øbsyn']) eq(skeleton(s), 'obsyn', JSON.stringify(s));
  eq(skeleton('ᎪᎷᎠ'), 'amd', 'Cherokee A M D');
  eq(skeleton('г'), 'r', 'Cyrillic small ghe looks like r');
  eq(skeleton('ш'), 'w', 'Cyrillic small sha looks like w');
  eq(skeleton('σ'), 'o', 'Greek small sigma looks like o');
  eq([skeleton('Ϲ'), skeleton('ϲ')], ['c', 'c'], 'lunate sigma looks like c (NFKC would make it a sigma)');
  eq(skeleton('BꓲG'), 'big', 'Lisu I');
  eq(skeleton('١'), '1', 'Arabic-Indic one stays a digit');
  ok(isLookalikeChar('ꓳ') && isLookalikeChar('г') && isLookalikeChar('Ϲ'), 'marked as look-alikes');
  ok(!isLookalikeChar('é') && !isLookalikeChar('e'), 'accents and ASCII are not');
});

test('near matches only drop a character from the query: OBSYNX finds OBSYN, OBSYN does not find OBSYNX', () => {
  ok(nearKeys(skeleton('OBSYNX')).includes('obsyn'));
  ok(!nearKeys('obsyn').includes('obsynx'));
  ok(skeleton('OBSYNX') !== skeleton('OBSYN'), 'never an exact match');
});

test('official name flag only on rows that use the official name (address query with a different name)', async () => {
  // pasted coin: symbol BLAME, name Obsyn -> rows matched through "obsyn" must not get the official-name flag
  const rows = [blameRow(0), blameRow(1, { name: 'Obsyn' }), blameRow(2, { symbol: 'OBSYN', name: 'Obsyn' }), blameRow(3, { symbol: 'OBSYN', name: 'obsyn' })];
  const { r } = await route(ad(1), rows);
  eq(r.official && r.official.address, BLAME);
  const flaggedRows = r.matches.filter((m) => codes(m).includes('name-of-official')).map((m) => m.address).sort();
  eq(flaggedRows, [ad(1)]);
  ok(r.verdict.startsWith('This is not the official $BLAME.'), r.verdict);
});

test('verdict counts every index row, not only the 12 read in full', async () => {
  const rows = [];
  for (let i = 1; i <= 15; i++) rows.push(blameRow(i));
  rows.push(blameRow(16, { symbol: 'BLAM', name: 'Blam' }));
  const { r } = await route('BLAME', rows, { settings: null });
  eq(r.matches.length, 12);
  ok(r.verdict.startsWith('15 Pons coins use this name. 1 more has a similar name.'), r.verdict);
});

test('router as recipient: the buy is credited to the tx sender, never the router', async () => {
  const curve = ad(5501), token = ad(501), dev = ad(7501), bot = ad(8888), ROUTER = ADDR.ROUTER;
  const hx = (n) => '0x' + n.toString(16);
  const buy = (blk, buyer, recipient, n) => ({ address: curve, topics: [TOPIC.CURVE_BUY, pad(buyer), pad(recipient)], blockNumber: hx(blk), logIndex: '0x0',
    transactionHash: tx(n), data: '0x' + (10n ** 18n).toString(16).padStart(64, '0') + (10n ** 25n).toString(16).padStart(64, '0') + '0'.repeat(128) });
  const logs = [buy(1000010, ROUTER, ROUTER, 61), buy(1000011, ROUTER, ad(4242), 62)];
  const fetchFn = async (url, init) => {
    if (String(url).startsWith(EXPLORER)) return fakeRes(404, {});
    const body = JSON.parse(init.body);
    const list = Array.isArray(body) ? body : [body];
    const out = list.map((c) => {
      let result = '0x';
      const p = c.params && c.params[0];
      if (c.method === 'eth_getBlockByNumber') result = { number: hx(1100000), timestamp: hx(1794990000), hash: '0x1' };
      if (c.method === 'eth_getLogs') result = p.address === curve && p.topics && p.topics[0] === TOPIC.CURVE_BUY ? logs : [];
      if (c.method === 'eth_getTransactionByHash') result = { hash: c.params[0], from: c.params[0] === tx(61) ? bot : dev };
      if (c.method === 'eth_getTransactionReceipt') result = { blockNumber: hx(1000000), logs: [] };
      return { jsonrpc: '2.0', id: c.id, result };
    });
    return fakeRes(200, Array.isArray(body) ? out : out[0]);
  };
  _setTransport({ fetch: fetchFn, sleep: noSleep, backoff: [0], timeouts: false });
  const ctx = await makeContext({ fetch: fetchFn, sleep: noSleep, factories: FACTORY_ADDRESSES });
  const f = await gatherFacts({ token, curve, factory: FACTORY_ADDRESSES[0], creator: dev, tx_from: dev, pair_token: ADDR.ZERO, block: 1000000, time: 1794900000, tx: tx(60), name: 'T', symbol: 'T' }, ctx);
  eq(f.snipers.map((s) => s.wallet).sort(), [ad(4242), bot].sort());
});
