// Copy check card ("Is this the real one?"): the words and links it shows (copyView, no page needed), the API call
// (fetchCopies with a fake fetch), the ticker test in app.js, and the settings/page/safety-rule wiring.
// The OBSYN results are the real copy check replayed offline (dev/tests/fixtures/obsyn).
import { suite, test, eq, ok } from './harness.js';
import { copyView, fetchCopies, checkAnswer, errorText, relative, when, words, shortAddr } from '../../site/src/ui/copycheck-card.js';
import { tickerOf } from '../../site/src/app.js';
import { SETTINGS } from '../../site/settings.js';
import { TRUST_DEFAULTS, trustSettings, CAVEATS } from '../../site/src/trust/rules.js';
import { loadFixture, runScenario, OBSYN } from './fixtures/obsyn/replay.js';

suite('copy check › card');

const PROOF = /^https:\/\/robinhoodchain\.blockscout\.com\/(tx|address|token)\/0x[0-9a-f]+$/;
const NY = { timeZone: 'America/New_York' };
const BLAME = '0x00000000000000000000000000000000000b1a3e';
const recorded = {};
async function obsyn(name, query) {
  if (!recorded[name]) recorded[name] = await runScenario({ query }, await loadFixture());
  return recorded[name];
}
const allRows = (v) => v.rows.concat(v.quiet);
function urlsOf(v) {
  const out = [];
  if (v.official) out.push(v.official.url);
  for (const r of allRows(v)) {
    out.push(r.tokenUrl, r.launched.url);
    for (const f of r.facts) out.push(f.url);
    for (const f of r.flags) out.push(...f.proofs);
  }
  return out.filter((u) => u != null);
}

// ---- recorded OBSYN ------------------------------------------------------------------------------------
test('ticker OBSYN: earliest first, the abandoned one folded into "1 quiet copy", every link is a Blockscout proof', async () => {
  const v = copyView(await obsyn('ticker', 'OBSYN'), SETTINGS, NY);
  eq(v.title, 'Is this the real one?');
  eq(v.query, '$OBSYN');
  eq(v.verdict, '4 Pons coins use this name. 2 look like quick copies.');
  eq(v.rows.map((r) => r.address), [OBSYN.early, OBSYN.copy, OBSYN.real]);
  eq(v.quiet.map((r) => r.short), ['0x17e2…5121']);
  eq(v.quietLabel, '1 quiet copy');
  eq(v.rows.map((r) => r.warn), [true, true, false]);
  ok(v.rows.every((r) => r.launched.rel === null), 'a ticker search has no "yours" to compare with');
  const urls = urlsOf(v);
  ok(urls.length > 30, String(urls.length));
  for (const u of urls) ok(PROOF.test(u), u);
  eq(v.official, null);
  ok(v.caveats.includes('Facts from Robinhood Chain; not financial advice.'));
  eq(v.indexing, null, 'index complete in the recording');
});

test('pasted copycat: highlighted, the others timed against it, its facts and flags in plain words', async () => {
  const v = copyView(await obsyn('copy', OBSYN.copy), SETTINGS, NY);
  eq(v.query, '0x7a2a…475e');
  eq(v.verdict, '3 other coins use this name. 1 looks like a quick copy. The coin you pasted has warning flags.');
  const mine = v.rows.find((r) => r.isQuery);
  eq(mine.address, OBSYN.copy);
  eq(mine.tags, ['Yours']);
  eq(mine.launched.text, 'Launched Nov 17, 9:02 AM EST');
  eq(mine.launched.rel, null);
  const real = v.rows.find((r) => r.address === OBSYN.real);
  eq(real.launched.rel, '11 min 45 s after yours');
  eq(v.rows.find((r) => r.address === OBSYN.early).launched.rel, '4 h 53 min before yours');
  const facts = Object.fromEntries(real.facts.map((f) => [f.key, f.text]));
  eq(facts, { holders: '287', liquidity: '$7.5k', graduated: 'Yes, Nov 17, 2:31 PM EST', dev: '0x0341…5c32' });
  eq(real.facts.find((f) => f.key === 'graduated').url, 'https://robinhoodchain.blockscout.com/tx/0x493778200eb20f599eead6f8fcfa9dce5dc8935d0a900a696d544b57b83497d4');
  const copyFacts = Object.fromEntries(mine.facts.map((f) => [f.key, f.text]));
  eq([copyFacts.liquidity, copyFacts.graduated, copyFacts.holders], ['under $1', 'Not yet', '2']);
  eq(mine.flags.map((f) => f.label), ['Launched just before', 'Dev sold fast', 'Took fees and left', 'Quiet copy', 'Same first buyers']);
  eq(mine.flags.map((f) => f.severity), ['warn', 'warn', 'warn', 'info', 'info']);
  ok(!mine.quiet, 'the pasted coin is never folded away');
  for (const u of urlsOf(v)) ok(PROOF.test(u), u);
});

// ---- made-up rows (edge cases) -----------------------------------------------------------------------------
const A = (n) => '0x' + n.toString(16).padStart(40, '0');
const H = (n) => '0x' + n.toString(16).padStart(64, '0');
function match(n, o = {}) {
  return { address: A(n), name: 'Blame', symbol: 'BLAME', match: 'exact', isQuery: false, isOfficial: false, isPons: true,
    curve: A(5000 + n), creator: A(7000 + n), launch: { tx: H(n), block: 100 + n, time: new Date((1794990000 + n * 600) * 1000).toISOString() },
    holders: { count: 10, source: 'blockscout' }, liquidity: { usd: 900, source: 'curve' }, graduated: null, flags: [], missing: [], ...o };
}
const result = (matches, o = {}) => ({ ok: true, query: { input: 'BLAME', kind: 'ticker', skeleton: 'blame' }, asOf: '2026-11-18T08:46:07Z',
  indexedFrom: '2026-09-18T00:00:00Z', indexComplete: true, official: null, matches, verdict: 'x', notes: [], caveats: CAVEATS.slice(), ...o });

test('official $BLAME: a badge with the full address, times said against the official coin', () => {
  const v = copyView(result([match(1), match(2, { address: BLAME, isOfficial: true }), match(3, { match: 'near', symbol: 'BLAM' })],
    { official: { symbol: 'BLAME', address: BLAME } }), SETTINGS, NY);
  eq(v.official, { label: '✅ Official $BLAME', address: BLAME, url: 'https://robinhoodchain.blockscout.com/token/' + BLAME });
  eq(v.rows.map((r) => r.tags), [[], ['Official'], ['Similar name']]);
  eq(v.rows.map((r) => r.launched.rel), ['10 min before the official one', null, '10 min after the official one']);
});

test('hidden and look-alike characters are marked; "$" is not doubled; unread facts say so and link nowhere', () => {
  const v = copyView(result([match(1, { symbol: '$BLАME', name: 'U⁠S⁠DG', holders: null, liquidity: null, creator: null, missing: ['graduated'] })]), SETTINGS);
  const r = v.rows[0];
  eq(r.symbol.map((s) => s.kind), ['plain', 'lookalike', 'plain']);
  eq(r.dollar, false);
  eq(r.name.map((s) => s.text).join(''), 'U·S·DG');
  for (const f of r.facts) eq([f.text, f.url], ["can't read", null], f.key);
});

test('bad data from the API never becomes a link, and over-long text is cut', () => {
  const evil = match(1, { flags: [{ code: 'dev-dumped-fast', severity: 'warn', text: 'x'.repeat(5000),
    proof: ['javascript:alert(1)', 'https://evil.example/tx/0x' + 'a'.repeat(64), 'https://robinhoodchain.blockscout.com/tx/0x' + 'b'.repeat(64)] }],
    launch: { tx: 'not-a-hash', block: 1, time: '2026-11-18T00:00:00Z' }, creator: 'javascript:void(0)' });
  const v = copyView(result([evil, { address: 'nope' }, null]), SETTINGS);
  eq(v.rows.length, 1, 'rows without a real address are dropped');
  const r = v.rows[0];
  eq(r.flags[0].proofs, ['https://robinhoodchain.blockscout.com/tx/0x' + 'b'.repeat(64)]);
  eq(r.flags[0].text.length, 400);
  eq(r.launched.url, null);
  eq(r.facts.find((f) => f.key === 'dev').url, null);
});

test('index still filling: one "Searching Pons launches since" line, not the same note twice', () => {
  const v = copyView(result([], { indexComplete: false, notes: ['Still indexing older launches: searching launches since 2026-09-18.', 'Other note.'] }), SETTINGS, NY);
  eq(v.indexing, 'Searching Pons launches since Sep 17, 2026.');
  eq(v.notes, ['Other note.']);
  eq([v.rows, v.quiet], [[], []]);
  eq(v.how.title, 'How we got this');
  ok(v.how.items.some((s) => /removing hidden characters and look-alike letters/.test(s)));
  ok(v.how.items.some((s) => /launch, dev wallet, trades, fee claims and bridge transfers from Robinhood Chain/.test(s)));
  eq(v.asOf, 'Chain data as of Nov 18, 3:46 AM EST');
});

test('times: same minute, before, after; a bad date is left out', () => {
  const W = words(SETTINGS);
  eq(relative('2026-11-18T00:00:30Z', '2026-11-18T00:00:00Z', W), 'same minute as yours');
  eq(relative('2026-11-17T23:00:00Z', '2026-11-18T00:00:00Z', W), '1 h before yours');
  eq(relative('2026-11-20T00:00:00Z', '2026-11-18T00:00:00Z', W), '2 days after yours');
  eq(relative('nope', '2026-11-18T00:00:00Z', W), null);
  eq(when('nope'), '');
  eq(when('2026-11-18T08:46:07Z', 'UTC'), 'Nov 18, 8:46 AM UTC');
  eq(shortAddr(OBSYN.real), '0x5d99…4351');
});

// ---- the API call ----------------------------------------------------------------------------------------
function fakeFetch(answer) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    const [status, body] = answer;
    return { status, ok: status < 300, json: async () => (typeof body === 'string' ? JSON.parse(body) : body) };
  };
  f.calls = calls;
  return f;
}

test('fetchCopies asks GET {apiBase}/v1/copies?q=… with no cookies, and passes only the two contract shapes', async () => {
  const good = result([match(1)]);
  const f = fakeFetch([200, good]);
  eq(await fetchCopies(' $OBSYN ', SETTINGS, { fetch: f }), good);
  eq(f.calls[0].url, 'https://api.blamethestock.com/v1/copies?q=%24OBSYN');
  eq([f.calls[0].init.method, f.calls[0].init.credentials, f.calls[0].init.headers.Accept], ['GET', 'omit', 'application/json']);
  eq(await fetchCopies('X', SETTINGS, { fetch: fakeFetch([404, { ok: false, code: 'not-found', message: 'm' }]) }), { ok: false, code: 'not-found', message: 'm' });
  eq(await fetchCopies('X', SETTINGS, { fetch: fakeFetch([503, { ok: false, code: 'index-behind', message: '' }]) }), { ok: false, code: 'index-behind', message: '' });
  for (const bad of [[429, { ok: false, code: 'busy' }], [500, '<html>'], [200, { hello: 1 }], [200, { ok: true }], [200, null], new TypeError('offline')]) {
    eq(await fetchCopies('X', SETTINGS, { fetch: fakeFetch(bad) }), null, JSON.stringify(String(bad)));
  }
  eq(await fetchCopies('X', { trust: { apiBase: 'http://insecure.example' } }, { fetch: fakeFetch([200, good]) }), null, 'https only');
  eq(await fetchCopies('', SETTINGS, { fetch: fakeFetch([200, good]) }), null);
  eq(await fetchCopies('X', SETTINGS, { fetch: null }), null);
  eq(checkAnswer({ ok: false, code: '<b>', message: 'x' }), null);
});

test('error words come from settings, then the API, then "unavailable"', () => {
  eq(errorText(null), 'Copy check unavailable right now.');
  eq(errorText({ ok: false, code: 'index-behind', message: 'api words' }), SETTINGS.trust.wording.errors['index-behind']);
  eq(errorText({ ok: false, code: 'new-code', message: 'api words' }), 'api words');
  eq(errorText({ ok: false, code: 'new-code', message: '' }), 'Copy check unavailable right now.');
  // A code that happens to be a built-in name finds no words of ours (not the text of a built-in function).
  eq(errorText(checkAnswer({ ok: false, code: 'constructor', message: 'api words' })), 'api words');
  const odd = copyView(result([match(1, { flags: [{ code: 'constructor', severity: 'info', text: 't', proof: [] },
    { code: 'z'.repeat(500), severity: 'info', text: 't', proof: [] }] })]), SETTINGS);
  eq(odd.rows.concat(odd.quiet)[0].flags.map((f) => f.label), ['constructor', 'z'.repeat(40)]);
});

// ---- app.js: what counts as a ticker -----------------------------------------------------------------------
test('a ticker is one word, not 0x…, up to 32 characters, with a letter or number', () => {
  for (const s of ['OBSYN', '$obsyn', ' BLAME ', 'ＢＬＡＭＥ', 'U⁠S⁠DG', 'AI']) ok(tickerOf(s), JSON.stringify(s));
  for (const s of ['', '   ', 'not an address', '0x123', '0x' + 'a'.repeat(40), '$$$', 'x'.repeat(33), null, 42]) eq(tickerOf(s), null, JSON.stringify(s));
});

// ---- settings, page and safety rules ----------------------------------------------------------------------
test('settings.trust mirrors the logic\'s thresholds; the official list is empty until launch, then holds the coin', () => {
  const t = SETTINGS.trust;
  for (const k of Object.keys(TRUST_DEFAULTS)) if (k !== 'official' && k !== 'maxFacts') eq(t[k], TRUST_DEFAULTS[k], k);
  eq(trustSettings(SETTINGS).launchedJustBeforeMinutes, 60);
  eq(t.apiBase, 'https://api.blamethestock.com');
  ok(Array.isArray(t.official));
  const addr = String(SETTINGS.token.contractAddress || '').toLowerCase();
  if (SETTINGS.token.launched && addr) {
    ok(trustSettings(SETTINGS).official.some((o) => o.address === addr && o.skeleton === 'blame'), 'official list must hold token.contractAddress');
  } else {
    eq(t.official, [], 'nothing official before launch');
  }
});

test('card words: plain, never advice, never "scam", "safe" or "rug"', () => {
  const all = JSON.stringify(SETTINGS.trust.wording);
  ok(!/\b(scam|scams|safe|safety|rug|rugged|should|must buy|sell now)\b/i.test(all), all.match(/\b(scam|safe|rug|should)\b/i));
  eq(SETTINGS.trust.wording.title, 'Is this the real one?');
});

const ROOT = (() => { try { return decodeURIComponent(import.meta.url.replace(/^file:\/\//, '')).replace(/dev\/tests\/[^/]*$/, ''); } catch (e) { return null; } })();
const readText = (rel) => (typeof read === 'function' && ROOT ? read(ROOT + rel) : null);

test('page: trust.css linked, #copies right after #result, the read-only line under the box and in the footer', () => {
  const html = readText('site/index.html');
  if (html == null) return;                       // browser runner: no file access
  ok(html.includes('<link rel="stylesheet" href="src/ui/trust.css">'));
  ok(/<section id="result"[^>]*><\/section>\s*(<!--[^]*?-->\s*)?<section id="copies"/.test(html), '#copies follows #result');
  const line = 'Read-only. We never ask you to connect a wallet, sign or approve anything.';
  eq(html.split(line).length - 1, 2, 'hero and footer');
  ok(html.includes('Facts from Robinhood Chain; not financial advice.'));
});

test('safety rules: the API is allowed to be fetched, and nothing else changed (no new script or frame sources)', () => {
  const h = readText('site/_headers');
  if (h == null) return;
  const csp = h.split('\n').find((l) => /Content-Security-Policy:/.test(l));
  const part = (name) => (csp.match(new RegExp(name + ' ([^;]*)')) || [])[1];
  ok(part('connect-src').split(' ').includes('https://api.blamethestock.com'));
  eq(part('script-src'), "'self'");
  eq(part('default-src'), "'self'");
  ok(!part('img-src').includes('blamethestock'));
});
