// Launch report card: the words and links it shows (reportView / linksView, no page needed), the API calls and the
// polling while the API builds the report (fake fetch, no timers), the drawn card on a tiny stand-in page (text only,
// every link a Blockscout proof), and the settings/page wiring.
// The OBSYN reports are the real report and wallet links replayed offline (dev/tests/fixtures/obsyn/report-*.json).
import { suite, test, eq, ok } from './harness.js';
import {
  reportView, linksView, linkedVerdict, checkReport, checkLinks, fetchReport, fetchLinks, loadReport, errorText, retryable,
  renderReport, renderReportLoading, renderLinks, showReport, tokensText, pctText, words, MAX_WAIT_MS,
} from '../../site/src/ui/report-card.js';
import { SETTINGS } from '../../site/settings.js';
import { loadReportFixture, runReportScenario, REPORT_SCENARIOS, OBSYN } from './fixtures/obsyn/report-replay.js';

suite('launch report › card');

const PROOF = /^https:\/\/robinhoodchain\.blockscout\.com\/(tx|address|token)\/0x[0-9a-f]+$/;
const NY = { timeZone: 'America/New_York' };
const BANNED = /\b(scam|scams|scammer|safe|unsafe|safety|rug|rugged|rugpull|should|buy now|sell now)\b/i;
const SNIPER_LATE = '0x0a70fea3ee47c8e64ea960135cb469afaab4fb49';
const REAL_VERDICT = 'Heavily sniped by bots (20.5% in 3 s; 8 of 9 sold before graduation, 1 just after). No dev link found. Dev claimed 2.07 ETH in fees, bridged 0.18 ETH out and sold nothing.';

const recorded = {};
async function obsyn(name) {
  if (!recorded[name]) {
    const sc = REPORT_SCENARIOS.find((s) => s.name === name);
    recorded[name] = await runReportScenario(sc, await loadReportFixture());
  }
  return recorded[name];
}
function viewUrls(v) {
  const out = [v.tokenUrl, v.activity.graduation.url, v.activity.proof, v.dev.moreUrl];
  for (const f of v.dev.facts) out.push(f.url);
  for (const s of v.dev.steps) out.push(s.url, s.toUrl);
  for (const r of v.snipers.rows) out.push(r.url, r.buyUrl, r.sellUrl);
  return out.filter((u) => u != null);
}

// ---- recorded OBSYN ---------------------------------------------------------------------------------------------
test('real OBSYN: title, verdict, dev facts and the dev step list in time order, each with its transaction', async () => {
  const { again } = await obsyn('real OBSYN');
  const v = reportView(again, SETTINGS, NY);
  eq(v.title, 'Launch report');
  eq(v.query, '$OBSYN · 0x5d99…4351');
  eq(v.verdict, REAL_VERDICT);
  eq(v.official, null);
  eq(v.dev.facts.map((f) => [f.key, f.text]), [
    ['wallet', '0x0341…5c32'], ['buy', '1.14%'], ['sold', 'nothing'], ['fees', '2.07 ETH'], ['unclaimed', '0.1931 ETH'], ['bridged', '0.18 ETH']]);
  eq(v.dev.steps.map((s) => s.kind), ['launch', 'send', 'burn', 'claim', 'graduated', 'buy', 'bridge', 'buy', 'buy', 'buy', 'burn', 'buy', 'claim']);
  const t = v.dev.steps.map((s) => s.text);
  eq(t[0], 'Launched the coin and bought 1.14% of supply (11.4M tokens) for 0.02 ETH');
  eq(t[1], 'Sent 5.1M tokens (0.51%) to 0xf80b…54e9');
  eq(t[2], 'Burned 6.32M tokens (0.63%)');
  eq(t[3], 'Claimed 0.4822 ETH in fees');
  eq(t[4], 'The coin graduated');
  eq(t[6], 'Bridged 0.18 ETH out through MetaBridge/Across to Base');
  eq(t[10], 'Burned 3.34M tokens (0.33%)');
  eq(t[12], 'Claimed 1.59 ETH in fees');
  eq(v.dev.steps[0].rel, 'launch');
  eq(v.dev.steps[1].rel, '+39 min 10 s');
  eq(v.dev.steps[1].when, 'Nov 17, 9:53 AM EST');
  eq(v.dev.steps[10].when, 'Nov 17, 8:13 PM EST', 'the burn of the post-graduation buys (01:13:18 UTC on Nov 18)');
  eq(v.dev.steps.filter((s) => s.after).map((s) => s.kind), ['buy', 'buy', 'buy', 'buy', 'burn', 'buy']);
  ok(!v.dev.steps.some((s) => s.warn), 'the dev never sold: no vermilion step');
  ok(v.dev.steps.every((s) => s.url && PROOF.test(s.url)), 'every step links its transaction');
  eq(v.dev.steps[1].toUrl, 'https://robinhoodchain.blockscout.com/address/0xf80b926e549e8dff2ade45132afbdbb240e354e9');
  eq(v.dev.more, null);
});

test('real OBSYN: 9 first buyers took 20.5% in 3 s; 8 sold before graduation, 0x0a70 sold 26 s after; same-block groups', async () => {
  const { again } = await obsyn('real OBSYN');
  const s = reportView(again, SETTINGS, NY).snipers;
  eq(s.title, 'First buyers');
  eq(s.lead, '9 wallets took 20.5% of supply in the first 3 s');
  eq(s.rows.length, 9);
  eq(s.rows.filter((r) => r.statusText === 'Sold before graduation').length, 8);
  const late = s.rows.find((r) => r.address === SNIPER_LATE);
  eq([late.status, late.statusText, late.at], ['sold-after-graduation', 'Sold 26 s after graduation', 'block +36 · 3 s']);
  ok(s.rows.every((r) => r.sold && r.sellUrl && PROOF.test(r.sellUrl)), 'every wallet sold, each with its sell tx');
  ok(Math.abs(s.bar.gone - 0.20513) < 0.0001, String(s.bar.gone));
  eq(s.bar.held, 0);
  eq(s.legend.map((l) => [l.label, l.value]), [['Sold', '20.5%'], ['Still held', '0%'], ['Rest of supply', '79.5%']]);
  eq(s.clusters, 'Same block: 5 wallets at block +33, 3 wallets at block +36.');
  eq(s.rows.filter((r) => r.group === 1).length, 5);
  eq(s.shown, 9);
});

test('real OBSYN: activity shows graduation and six grey hourly bars; every link in the view is a Blockscout proof', async () => {
  const { again } = await obsyn('real OBSYN');
  const v = reportView(again, SETTINGS, NY);
  const a = v.activity;
  eq(a.graduation.text, 'Graduated Nov 17, 2:31 PM EST, 5 h 17 min after launch');
  eq(a.graduation.url, 'https://robinhoodchain.blockscout.com/tx/0x493778200eb20f599eead6f8fcfa9dce5dc8935d0a900a696d544b57b83497d4');
  eq(a.hours.length, 6);
  eq(a.ends, ['9 AM', '2 PM']);
  eq(a.hours.map((h) => h.buys), [54, 22, 46, 83, 176, 68]);
  eq(a.hours[4].height, 1, 'the busiest hour is full height');
  eq(a.total, '449 buys, 98 first-time buyers');
  eq(a.hours[0].title, '9 AM: 54 buys, 37 first-time buyers');
  const urls = viewUrls(v);
  ok(urls.length > 30, String(urls.length));
  for (const u of urls) ok(PROOF.test(u), u);
  eq(v.caveats[0], 'Wallets funded through exchanges, bridges or privacy tools can\'t be linked.');
  ok(v.caveats.includes('Facts from Robinhood Chain; not financial advice.'));
  eq(v.how.title, 'How we got this');
  eq(v.how.items.length, 6);
  eq(v.asOf, 'Chain data as of Nov 18, 3:46 AM EST');
  eq(v.missing, null);
});

test('copycat OBSYN: the dev sell is the one vermilion step; unconfirmed bridge; never graduated; activity "so far"', async () => {
  const { again } = await obsyn('copycat OBSYN');
  const v = reportView(again, SETTINGS, NY);
  eq(v.query, '$OBSYN · 0x7a2a…475e');
  ok(/^Heavily sniped by bots \(21% in 5 s; all 10 sold on the curve\)\./.test(v.verdict), v.verdict);
  eq(v.dev.steps.map((s) => s.kind), ['launch', 'sell', 'claim', 'bridge']);
  const sell = v.dev.steps[1];
  eq([sell.text, sell.rel, !!sell.warn], ['Sold 8.59M tokens (0.86%) for 0.0163 ETH', '+1 min 11 s', true]);
  eq(v.dev.steps[3].text, 'Bridged 0.0473 ETH out through MetaBridge/Relay to chain 56 (not confirmed)');
  eq(v.dev.facts.find((f) => f.key === 'sold').text, '0.86%');
  ok(!v.dev.facts.some((f) => f.key === 'unclaimed'), 'nothing left unclaimed: no fact for it');
  ok(v.snipers.rows.every((r) => r.statusText === 'Sold on the curve'), 'no graduation: "on the curve"');
  eq(v.activity.graduation.text, 'Not graduated yet');
  ok(PROOF.test(v.activity.graduation.url), 'links the curve instead');
  ok(/\(so far\)$/.test(v.activity.total), v.activity.total);
  for (const u of viewUrls(v)) ok(PROOF.test(u), u);
});

test('wallet links (real OBSYN): dev funder named as a public service, one "can be chance" link, verdict gains "No dev link found."', async () => {
  const { report, links } = await obsyn('real OBSYN');
  ok(!/No dev link found/.test(report.verdict), 'the first report has no links sentence yet');
  const v = linksView(links, report, SETTINGS, NY);
  eq(v.state, 'done');
  eq(v.devFunder.text, 'The dev\'s first ETH came from Across MulticallHandler, a public service (0.0417 ETH, Nov 17, 9:10 AM EST).');
  ok(PROOF.test(v.devFunder.url));
  eq(v.items.length, 1);
  eq([v.items[0].weak, v.items[0].tag, v.items[0].dev], [true, 'Can be chance', false]);
  eq(v.items[0].wallets.map((w) => w.short), ['0xcbd2…1fd3', '0x213c…5c93']);
  ok(v.items[0].proofs.length === 3 && v.items[0].proofs.every((u) => PROOF.test(u)));
  eq(v.none, 'No funding links found between the dev and the 9 first buyers we checked.');
  eq(v.ignored.length, 3);
  eq(v.ignoredTitle, 'Left out as public services (3)');
  eq(v.caveat, 'Wallets funded through exchanges, bridges or privacy tools can\'t be linked.');
  eq(v.verdict, REAL_VERDICT);
  eq(linkedVerdict(report, links), REAL_VERDICT);
  const { again } = await obsyn('real OBSYN');
  eq(linkedVerdict(again, links), REAL_VERDICT, 'already in the cached verdict: not added twice');
});

test('wallet links: checking, building and unavailable states; a strong dev link is listed first', () => {
  eq(linksView('checking', null, SETTINGS).text, 'Checking wallet links…');
  eq(linksView({ ok: true, status: 'building', progress: 0.4 }, null, SETTINGS).state, 'checking');
  for (const x of [null, { ok: true, status: 'unavailable' }, { ok: false, code: 'unavailable' }]) {
    const v = linksView(x, null, SETTINGS);
    eq([v.state, v.text, v.retry], ['unavailable', 'Wallet links unavailable right now.', 'Try again']);
  }
  const dev = '0x' + '1'.repeat(40), a = '0x' + '2'.repeat(40), b = '0x' + '3'.repeat(40), f = '0x' + '4'.repeat(40);
  const links = {
    ok: true, status: 'done', dev, caveat: 'c',
    funders: [{ wallet: dev, role: 'dev', funder: f, kind: 'wallet', eth: 0.5, time: '2026-11-17T14:00:00Z', tx: '0x' + 'a'.repeat(64) },
      { wallet: a, role: 'sniper', funder: f, kind: 'wallet' }],
    links: [
      { wallets: [a, b], strength: 'weak', involvesDev: false, reason: 'weak one', proof: [] },
      { wallets: [dev, a], strength: 'strong', involvesDev: true, reason: 'Same funder.', proof: ['https://robinhoodchain.blockscout.com/address/' + f, 'javascript:alert(1)'] },
    ],
    ignored: [],
  };
  const v = linksView(links, null, SETTINGS, NY);
  eq(v.devFunder.text, 'The dev\'s first ETH came from wallet 0x4444…4444 (0.5 ETH, Nov 17, 9:00 AM EST).');
  eq(v.items.map((i) => i.tag), ['Same funder', 'Can be chance']);
  eq(v.items[0].wallets.map((w) => w.dev), [true, false]);
  eq(v.items[0].proofs, ['https://robinhoodchain.blockscout.com/address/' + f], 'a non-explorer "proof" is dropped');
  eq(v.none, null, 'a dev link: no "no links" line');
});

// ---- numbers --------------------------------------------------------------------------------------------------
test('numbers: tokens and % of supply in short plain form', () => {
  eq([tokensText(11421611.03), tokensText(5100000), tokensText(950), tokensText(25000), tokensText(1.2e9), tokensText(-1)],
    ['11.4M tokens', '5.1M tokens', '950 tokens', '25k tokens', '1.2B tokens', '?']);
  eq([pctText(20.513204), pctText(1.1421611), pctText(0.51), pctText(0.045823), pctText(0), pctText(0.0001), pctText(null)],
    ['20.5%', '1.14%', '0.51%', '0.046%', '0%', '<0.001%', '?']);
});

// ---- the API -----------------------------------------------------------------------------------------------------
const TOKEN = '0x5D992fa5B7Da8EFde5FD36d24e81097Ed6aD4351';
function fakeFetch(answers) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a instanceof Error) throw a;
    return { status: a.status || 200, json: async () => { if (a.body === undefined) throw new Error('not json'); return a.body; } };
  };
  f.calls = calls;
  return f;
}

test('answers: only the contract\'s shapes get through', () => {
  eq(checkReport(null), null);
  eq(checkReport({ ok: true, status: 'done' }), null, 'no token');
  eq(checkReport({ ok: true, status: 'done', token: { address: 'javascript:1' } }), null);
  eq(checkReport({ ok: true, status: 'building', progress: 7, retryAfterSeconds: 99 }), { ok: true, status: 'building', progress: 1, retryAfterSeconds: 10 });
  eq(checkReport({ ok: true, status: 'building' }), { ok: true, status: 'building', progress: 0, retryAfterSeconds: 2 });
  eq(checkReport({ ok: false, code: 'not-pons', message: 'x' }), { ok: false, code: 'not-pons', message: 'x' });
  eq(checkReport({ ok: false, code: '<b>' }), null);
  eq(checkLinks({ ok: true, status: 'unavailable', progress: 0.5 }), { ok: true, status: 'unavailable' });
  eq(checkLinks({ ok: false, code: 'rate-limited' }), { ok: true, status: 'unavailable' });
  eq(checkLinks({ ok: true, status: 'done' }), null, 'no funders/links arrays');
});

test('fetchReport / fetchLinks: the right URL, no cookies; busy or broken answers are "unreachable" (null)', async () => {
  const f = fakeFetch([{ body: { ok: true, status: 'building', progress: 0.3 } }]);
  eq((await fetchReport(TOKEN, SETTINGS, { fetch: f })).progress, 0.3);
  eq(f.calls[0].url, 'https://api.blamethestock.com/v1/report/0x5d992fa5b7da8efde5fd36d24e81097ed6ad4351');
  eq(f.calls[0].init.credentials, 'omit');
  await fetchLinks(TOKEN, SETTINGS, { fetch: f });
  eq(f.calls[1].url, 'https://api.blamethestock.com/v1/report/0x5d992fa5b7da8efde5fd36d24e81097ed6ad4351/links');
  eq(await fetchReport(TOKEN, SETTINGS, { fetch: fakeFetch([{ status: 429, body: { ok: false, code: 'rate-limited' } }]) }), null);
  eq(await fetchReport(TOKEN, SETTINGS, { fetch: fakeFetch([{ status: 502 }]) }), null, 'not JSON');
  eq(await fetchReport(TOKEN, SETTINGS, { fetch: fakeFetch([new Error('offline')]) }), null);
  const none = fakeFetch([{ body: {} }]);
  eq(await fetchReport('0x123', SETTINGS, { fetch: none }), null);
  eq(await fetchReport(TOKEN, { trust: { apiBase: 'http://example.com' } }, { fetch: none }), null, 'https only');
  eq(none.calls.length, 0);
});

test('polling: asks again while "building" (progress shown, the API\'s wait respected), stops when done, cancelled or too long', async () => {
  const done = { ok: true, status: 'done', token: { address: TOKEN } };
  const f = fakeFetch([{ status: 202, body: { ok: true, status: 'building', progress: 0.2, retryAfterSeconds: 2 } },
    { status: 202, body: { ok: true, status: 'building', progress: 0.6, retryAfterSeconds: 3 } }, { body: done }]);
  const slept = [], seen = [];
  const res = await loadReport(TOKEN, SETTINGS, { fetch: f, sleep: async (ms) => { slept.push(ms); }, onProgress: (p) => seen.push(p) });
  eq(res.status, 'done');
  eq(seen, [0.2, 0.6]);
  eq(slept, [2000, 3000]);
  // too long
  const slow = fakeFetch([{ status: 202, body: { ok: true, status: 'building', progress: 0.1, retryAfterSeconds: 10 } }]);
  let total = 0;
  const late = await loadReport(TOKEN, SETTINGS, { fetch: slow, sleep: async (ms) => { total += ms; } });
  eq(late, { ok: false, code: 'still-building' });
  ok(total <= MAX_WAIT_MS && total >= MAX_WAIT_MS - 10000, String(total));
  eq(errorText(late, SETTINGS), 'The launch report is still being built.');
  // a newer lookup took over
  let alive = true;
  const gone = await loadReport(TOKEN, SETTINGS, { fetch: slow, sleep: async () => { alive = false; }, live: () => alive });
  eq(gone, undefined);
});

test('errors: settings words first; only busy errors offer "Try again"', () => {
  eq(errorText({ ok: false, code: 'not-pons', message: 'api words' }, SETTINGS), 'This coin wasn\'t launched on Pons, so there\'s no launch report for it.');
  eq(errorText({ ok: false, code: 'odd-thing', message: 'The API explains.' }, SETTINGS), 'The API explains.');
  eq(errorText({ ok: false, code: 'constructor' }, SETTINGS), 'Launch report unavailable right now.');
  eq(errorText(null, SETTINGS), 'Launch report unavailable right now.');
  eq([retryable(null), retryable({ code: 'unavailable' }), retryable({ code: 'rpc-failed' }), retryable({ code: 'not-pons' }), retryable({ code: 'not-found' })],
    [true, true, true, false, false]);
});

// ---- the drawn card (a tiny stand-in page) ------------------------------------------------------------------------
class Node0 { constructor() { this.parentNode = null; } }
class TextNode extends Node0 {
  constructor(t) { super(); this.data = String(t); }
  get textContent() { return this.data; }
}
class El extends Node0 {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase(); this.childNodes = []; this.attrs = {}; this.listeners = {};
    const self = this;
    this.style = { props: {}, setProperty(k, v) { this.props[k] = v; } };
    this.classList = {
      add(...c) { self.className = (self.className ? self.className + ' ' : '') + c.join(' '); },
      contains(c) { return String(self.className || '').split(/\s+/).includes(c); },
    };
    this.className = '';
  }
  set innerHTML(v) { throw new Error('innerHTML used'); }
  append(...kids) { for (const k of kids) { const n = typeof k === 'string' ? new TextNode(k) : k; n.parentNode = this; this.childNodes.push(n); } }
  replaceWith(n) { const p = this.parentNode; const i = p.childNodes.indexOf(this); n.parentNode = p; p.childNodes[i] = n; }
  get children() { return this.childNodes.filter((n) => n instanceof El); }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(v) { this.childNodes = []; if (v !== '' && v != null) this.append(String(v)); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  click() { for (const fn of this.listeners.click || []) fn({}); }
  all() { const out = []; for (const c of this.children) { out.push(c, ...c.all()); } return out; }
  querySelectorAll(sel) {
    const cls = sel.replace(/^\./, '').split('.');
    return this.all().filter((e) => (sel === 'a' ? e.tagName === 'A' : sel === 'button' ? e.tagName === 'BUTTON' : cls.every((c) => e.classList.contains(c))));
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
}
async function withDoc(fn) {
  const had = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = { createElement: (t) => new El(t) };
  try { return await fn(new El('section')); } finally { if (had) Object.defineProperty(globalThis, 'document', had); else delete globalThis.document; }
}

test('drawn card: verdict big, Dev / First buyers / Activity / Wallet links blocks, every link a new-tab Blockscout proof', async () => {
  const { again, links } = await obsyn('real OBSYN');
  await withDoc(async (mount) => {
    const c = renderReport(mount, again, SETTINGS, NY);
    eq(mount.firstElementChild, c);
    eq(c.getAttribute('data-state'), 'result');
    eq(c.querySelector('.cc-title').textContent, 'Launch report');
    eq(c.querySelector('.rc-verdict').textContent, REAL_VERDICT);
    eq(c.querySelectorAll('.rc-block-title').map((e) => e.textContent), ['Dev', 'First buyers', 'Activity', 'Wallet links']);
    eq(c.querySelectorAll('.rc-step').length, 13);
    eq(c.querySelectorAll('.rc-wallet').length, 9);
    eq(c.querySelectorAll('.rc-hour').length, 6);
    eq(c.querySelector('.rc-seg.rc-seg-gone').style.props.width, '20.513%');
    eq(c.querySelectorAll('.rc-seg-held').length, 0, 'nothing held: no blue segment');
    ok(c.querySelector('.cc-how') && c.querySelector('.cc-caveats'), 'caveats and "How we got this"');
    const as = c.querySelectorAll('a');
    ok(as.length > 30, String(as.length));
    for (const a of as) {
      ok(PROOF.test(a.getAttribute('href')), a.getAttribute('href'));
      eq([a.getAttribute('target'), a.getAttribute('rel')], ['_blank', 'noopener noreferrer']);
    }
    renderLinks(c, links, again, SETTINGS, NY);
    eq(c.querySelector('.rc-links').getAttribute('data-state'), 'done');
    ok(/Across MulticallHandler/.test(c.querySelector('.rc-funder').textContent));
    eq(c.querySelector('.rc-links-none').textContent, 'No funding links found between the dev and the 9 first buyers we checked.');
  });
});

test('drawn card: text from the API stays text; a bad link is not drawn as a link', async () => {
  const { again } = await obsyn('copycat OBSYN');
  const evil = JSON.parse(JSON.stringify(again));
  evil.verdict = '<img src=x onerror=alert(1)>';
  evil.token.symbol = '<b>X</b>';
  evil.dev.moves[0].tx = 'javascript:alert(1)';
  evil.activity.proof = 'https://evil.example/tx/0x' + 'a'.repeat(64);
  evil.proof.curve = 'https://evil.example/address/0x' + 'a'.repeat(40);
  await withDoc(async (mount) => {
    const c = renderReport(mount, evil, SETTINGS, NY);
    eq(c.querySelector('.rc-verdict').textContent, '<img src=x onerror=alert(1)>');
    eq(c.querySelector('.cc-query').textContent, '$<b>X</b> · 0x7a2a…475e');
    for (const a of c.querySelectorAll('a')) ok(PROOF.test(a.getAttribute('href')), a.getAttribute('href'));
    const sell = c.querySelectorAll('.rc-step')[1];
    eq(sell.querySelectorAll('a').length, 0, 'the sell step has no link now');
  });
});

test('drawn states: building updates in place; errors are one grey line, with "Try again" only when worth it', async () => {
  await withDoc(async (mount) => {
    const a = renderReportLoading(mount, SETTINGS, null, { query: '0x5d99…4351' });
    eq(a.querySelector('.rc-building').textContent, 'Building the launch report…');
    const b = renderReportLoading(mount, SETTINGS, 0.42);
    eq(b, a, 'same card, updated');
    eq(b.querySelector('.rc-building').textContent, 'Building the launch report… 42%');
    eq(b.querySelector('.rc-progress').getAttribute('aria-valuenow'), '42');
    let retried = 0;
    const p = renderReport(mount, null, SETTINGS, { onRetry: () => { retried++; } });
    eq(p.textContent, 'Launch report unavailable right now. Try again');
    p.querySelector('button').click();
    eq(retried, 1);
    const q = renderReport(mount, { ok: false, code: 'not-pons' }, SETTINGS, { onRetry: () => { retried++; } });
    eq(q.querySelectorAll('button').length, 0);
    eq(q.getAttribute('data-code'), 'not-pons');
  });
});

test('whole flow: building -> report drawn -> links checked after it; links unavailable -> Try again -> links drawn', async () => {
  const { again, links } = await obsyn('real OBSYN');
  const seen = [];
  const answers = [
    { status: 202, body: { ok: true, status: 'building', progress: 0.5, retryAfterSeconds: 2 } },
    { body: again },
    { body: { ok: true, status: 'unavailable' } },
    { body: links },
  ];
  const f = async (url) => {
    seen.push(url.replace('https://api.blamethestock.com', ''));
    const a = answers.shift();
    return { status: a.status || 200, json: async () => a.body };
  };
  await withDoc(async (mount) => {
    let reportShown = 0;
    const res = await showReport(mount, TOKEN, SETTINGS, { fetch: f, sleep: async () => {}, timeZone: NY.timeZone, onReport: () => { reportShown++; } });
    eq(res.status, 'done');
    eq(reportShown, 1);
    const tok = TOKEN.toLowerCase();
    eq(seen, ['/v1/report/' + tok, '/v1/report/' + tok, '/v1/report/' + tok + '/links'], 'links only after the report');
    const c = mount.firstElementChild;
    eq(c.querySelector('.rc-links').getAttribute('data-state'), 'unavailable');
    const btn = c.querySelector('.rc-links').querySelector('button');
    eq(btn.textContent, 'Try again');
    eq(c.querySelector('.rc-verdict').textContent, REAL_VERDICT, 'the cached verdict already has the links sentence');
    btn.click();
    for (let i = 0; i < 5; i++) await null;
    eq(c.querySelector('.rc-links').getAttribute('data-state'), 'done');
    eq(seen.length, 4);
  });
});

test('whole flow: a newer lookup stops it (nothing more drawn)', async () => {
  let alive = true;
  const f = async () => { alive = false; return { status: 202, json: async () => ({ ok: true, status: 'building', progress: 0.1 }) }; };
  await withDoc(async (mount) => {
    const res = await showReport(mount, TOKEN, SETTINGS, { fetch: f, sleep: async () => {}, live: () => alive });
    eq(res, undefined);
    eq(mount.firstElementChild.getAttribute('data-state'), 'loading', 'still the first drawing');
  });
});

// ---- settings, page and code rules -------------------------------------------------------------------------------
const ROOT = (() => { try { return decodeURIComponent(import.meta.url.replace(/^file:\/\//, '')).replace(/dev\/tests\/[^/]*$/, ''); } catch (e) { return null; } })();
const readText = (rel) => { try { return typeof read === 'function' && ROOT ? read(ROOT + rel) : null; } catch (e) { return null; } };

test('settings: report switch and words; plain words, never advice, never "scam", "safe" or "rug"', async () => {
  const r = SETTINGS.trust.report;
  eq(r.enabled, true);
  eq(r.wording.title, 'Launch report');
  const W = words(SETTINGS);
  ok(!BANNED.test(JSON.stringify(W)), JSON.stringify(W).match(BANNED));
  for (const name of ['real OBSYN', 'copycat OBSYN']) {
    const { again, links } = await obsyn(name);
    const all = JSON.stringify([reportView(again, SETTINGS, NY), linksView(links, again, SETTINGS, NY)]);
    ok(!BANNED.test(all), name + ': ' + (all.match(BANNED) || [])[0]);
  }
});

test('page: report.css linked, #report right after #copies, the paste box says addresses or tickers work', () => {
  const html = readText('site/index.html');
  if (html == null) return;                       // browser runner: no file access
  ok(html.includes('<link rel="stylesheet" href="src/ui/report.css">'));
  ok(/<section id="copies"[^>]*><\/section>\s*(<!--[^]*?-->\s*)?<section id="report"/.test(html), '#report follows #copies');
  ok(html.includes('placeholder="Paste a coin address (0x…) or ticker"'));
});

test('code: the card writes text only (no innerHTML), app.js loads it after the copy check and clears it for tickers', () => {
  const src = readText('site/src/ui/report-card.js');
  const app = readText('site/src/app.js');
  if (src == null || app == null) return;
  ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(src));
  ok(/copies\(address\);[^\n]*\n\s*report\(address\);/.test(app), 'report(address) right after copies(address)');
  ok(/import\('\.\/ui\/report-card\.js'\)/.test(app), 'loaded only when needed');
  ok((app.match(/report\(null\)/g) || []).length >= 2, 'cleared for a bad entry and for a ticker');
});
