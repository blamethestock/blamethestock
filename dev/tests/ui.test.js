// Tests for the page side: the card keeps keyboard focus when it is redrawn, errors worth retrying keep
// "Try again" and the window tabs, app.js (empty and bad entries, the busy Blame button, the loading card shown
// straight away, shared links, cancelled lookups, the address bar, opening a coin from the board), the board's
// open event, off-hours minutes, and the wording for the pool search and for curve-then-pool coins.
//
// app.js and card.js need a page. jsc has none, so these tests build a small fake one (below) for each test and
// take it away afterwards. A browser's own page can't be swapped out, so in dev/tests/ those tests are skipped.
import { suite, test, eq, ok } from './harness.js';
import { buildResult, buildError } from '../../site/src/core/verdict.js';
import { age } from '../../site/src/core/format.js';
import { span } from '../../site/src/features/offhours.js';
import { openCoin, OPEN_EVENT } from '../../site/src/features/board.js';
import { renderLoading, renderResult, renderError, clearCard, focusInput } from '../../site/src/ui/card.js';
import { lookup, boot, untouched, _setFetcher } from '../../site/src/app.js';
import { SETTINGS } from '../../site/settings.js';

suite('ui');

const ZOLVA = '0x8e04549484d0612be8373a0263b11928a5f7681f';
const SHRP = '0xb961886115fb9e4f732e20e89efd6d0406c3527f';
const T_END = 1794548248;
const NY = { timeZone: 'America/New_York' };

function pi({ address = ZOLVA, sym = 'ZOLVA', source = 'dexscreener', label = sym + '/ETH', sinceLaunch = false, liq = 50000, win = '24h' } = {}) {
  return {
    ok: true,
    coin: { address, symbol: sym, name: sym },
    pair: { address: '0x0000000000000000000000000000000000000000', symbol: 'ETH', kind: 'eth' },
    pool: { id: '0x' + '7e'.repeat(32), dex: 'uniswap', label, pairSideUsd: liq, createdAt: sinceLaunch ? T_END - 7200 : null, source },
    window: win, windowSeconds: { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 }[win],
    start: { block: 1, time: sinceLaunch ? T_END - 7200 : T_END - 86400 }, end: { block: 2, time: T_END },
    sinceLaunch,
    coinInPair: { start: 1, end: 0.9 }, pairUsd: { start: 100, end: 95 },
    pairVia: null, tradedInWindow: true,
  };
}

// ---- wording (no page needed) ------------------------------------------------------------------
test('off-hours minutes round down, like the age in the notes (26 minutes = "26m", not "27m")', () => {
  const s = 26 * 60 + 50;
  eq(span(s), '26m');
  eq(age(s), '26 minutes');
  eq([span(89), span(17.5 * 3600 + 59), span(59)], ['1m', '17h 30m', '0m']);
});

test('pool search down: its own sentence', () => {
  eq(buildError({ ok: false, code: 'search-failed' }).message, "We couldn't reach the pool search just now. Try again in a minute.");
});

test('graduated Pons coin measured on its curve, then its pool: says so; low money is the pool line, the age is the coin\'s', () => {
  const res = buildResult(pi({ source: 'pons-curve-then-pool', label: 'BLAME/ETH', sym: 'BLAME', liq: 900 }), undefined, NY);
  eq(res.notes[res.notes.length - 1], 'Measured on its Pons launch curve, then its BLAME/ETH pool.');
  eq(res.warnings, ['Only $900 on the ETH side of its main pool, so these numbers are shaky.']);
  // Since launch, the window starts at the curve's birth (the coin's launch), so the 2 hours are the coin's age:
  // its pool is younger than that and must not be called 2 hours old.
  const young = buildResult(pi({ source: 'pons-curve-then-pool', label: 'BLAME/ETH', sym: 'BLAME', sinceLaunch: true }), undefined, NY);
  eq(young.notes[0], 'This coin is only 2 hours old, so this covers its whole life, not the full 24h.');
  eq(young.windowLabel, 'since launch');
  // A plain pool coin since launch keeps the pool sentence.
  eq(buildResult(pi({ sinceLaunch: true }), undefined, NY).notes[0],
    "This coin's pool is only 2 hours old, so this covers its whole life, not the full 24h.");
  // Plain pool coins and curve coins keep their own notes.
  eq(buildResult(pi({}), undefined, NY).notes.slice(-1)[0], 'Measured in the ZOLVA/ETH pool.');
  eq(buildResult(pi({ source: 'pons-curve' }), undefined, NY).notes.slice(-1)[0],
    "Measured on its Pons launch curve. It hasn't moved to a trading pool yet.");
});

// ---- a small fake page (jsc only) ----------------------------------------------------------------
const FAKE_OK = typeof document === 'undefined';
const pageTest = FAKE_OK ? test : (name) => test(name + ' (skipped in the browser: needs the jsc fake page)', () => {});

// Selectors: compound only (tag, #id, .class, [attr], [attr="v"], :not(...)), comma lists. No descendants.
function compile(sel) {
  const alts = String(sel).split(',').map((x) => x.trim()).filter(Boolean).map(compound);
  return (el) => alts.some((f) => f(el));
}
function compound(src) {
  const checks = [];
  let s = src, m;
  while (s) {
    if ((m = s.match(/^:not\(([^)]*)\)/))) { const inner = compound(m[1]); checks.push((el) => !inner(el)); }
    else if ((m = s.match(/^\[([\w-]+)(?:="([^"]*)")?\]/))) { const [, k, v] = m; checks.push((el) => el.hasAttribute(k) && (v === undefined || el.getAttribute(k) === v)); }
    else if ((m = s.match(/^\.([\w-]+)/))) { const c = m[1]; checks.push((el) => el.classList.contains(c)); }
    else if ((m = s.match(/^#([\w-]+)/))) { const id = m[1]; checks.push((el) => el.getAttribute('id') === id); }
    else if ((m = s.match(/^([a-zA-Z][\w-]*)/))) { const t = m[1].toUpperCase(); checks.push((el) => el.tagName === t); }
    else throw new Error('fake page: selector not supported: ' + src);
    s = s.slice(m[0].length);
  }
  return (el) => el.nodeType === 1 && checks.every((f) => f(el));
}
const kebab = (k) => k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

class FakeEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; this.bubbles = !!init.bubbles; this.defaultPrevented = false; this.target = null; }
  preventDefault() { this.defaultPrevented = true; }
}
function listen(node, type, fn) { if (!node.listeners.has(type)) node.listeners.set(type, []); node.listeners.get(type).push(fn); }
function dispatch(node, e) {
  if (!e.target) e.target = node;
  for (let x = node; x; x = x.parentNode) {
    for (const fn of (x.listeners && x.listeners.get(e.type)) || []) fn.call(x, e);
    if (!e.bubbles) break;
  }
  return !e.defaultPrevented;
}

class FakeEl {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = String(tag).toUpperCase(); this.nodeType = 1;
    this.attrs = new Map(); this.childNodes = []; this.parentNode = null; this.listeners = new Map(); this.style = {};
    this.value = ''; this.rect = null;
    const self = this;
    const classes = () => (self.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    this.classList = {
      add: (...c) => self.setAttribute('class', [...new Set([...classes(), ...c])].join(' ')),
      remove: (...c) => self.setAttribute('class', classes().filter((x) => !c.includes(x)).join(' ')),
      contains: (c) => classes().includes(c),
      toggle: (c, on) => { const want = on === undefined ? !classes().includes(c) : !!on; if (want) self.classList.add(c); else self.classList.remove(c); return want; },
    };
    this.dataset = new Proxy({}, {
      get: (t, k) => (typeof k === 'string' && self.hasAttribute('data-' + kebab(k)) ? self.getAttribute('data-' + kebab(k)) : undefined),
      set: (t, k, v) => { self.setAttribute('data-' + kebab(k), String(v)); return true; },
    });
  }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get hidden() { return this.hasAttribute('hidden'); }
  set hidden(v) { if (v) this.setAttribute('hidden', ''); else this.removeAttribute('hidden'); }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get firstElementChild() { return this.children[0] || null; }
  get textContent() { return this.childNodes.map((n) => (n.nodeType === 3 ? n.data : n.textContent)).join(''); }
  set textContent(v) { this.replaceChildren(...(v === '' || v == null ? [] : [String(v)])); }
  adopt(kid) {
    const n = typeof kid === 'string' ? { nodeType: 3, data: kid, parentNode: null } : kid;
    if (n.parentNode) n.parentNode.childNodes = n.parentNode.childNodes.filter((x) => x !== n);
    n.parentNode = this;
    return n;
  }
  append(...kids) { for (const k of kids) this.childNodes.push(this.adopt(k)); }
  replaceChildren(...kids) { for (const n of this.childNodes) n.parentNode = null; this.childNodes = []; this.append(...kids); }
  replaceWith(other) {
    const p = this.parentNode;
    if (!p) return;
    const n = p.adopt(other);
    p.childNodes[p.childNodes.indexOf(this)] = n;
    this.parentNode = null;
  }
  remove() { if (this.parentNode) { this.parentNode.childNodes = this.parentNode.childNodes.filter((x) => x !== this); this.parentNode = null; } }
  contains(n) { for (let x = n; x; x = x.parentNode) if (x === this) return true; return false; }
  get isConnected() { return this.ownerDocument.documentElement.contains(this); }
  all() { const out = []; const walk = (e) => { for (const c of e.children) { out.push(c); walk(c); } }; walk(this); return out; }
  querySelectorAll(sel) { return this.all().filter(compile(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  matches(sel) { return compile(sel)(this); }
  closest(sel) { const f = compile(sel); for (let x = this; x && x.nodeType === 1; x = x.parentNode) if (f(x)) return x; return null; }
  addEventListener(type, fn) { listen(this, type, fn); }
  dispatchEvent(e) { return dispatch(this, e); }
  click() { this.dispatchEvent(new FakeEvent('click', { bubbles: true })); }
  focus() {
    const can = ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName) || (this.tagName === 'A' && this.hasAttribute('href')) || this.hasAttribute('tabindex');
    if (can && this.isConnected) this.ownerDocument.active = this;
  }
  blur() { if (this.ownerDocument.active === this) this.ownerDocument.active = null; }
  select() {}
  scrollIntoView() { this.ownerDocument.scrolls.push(this.id || this.tagName.toLowerCase()); }
  getBoundingClientRect() { return this.rect || { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }
  get offsetWidth() { return 0; }
  toJSON() { return '<' + this.tagName.toLowerCase() + (this.id ? '#' + this.id : '') + (this.className ? '.' + this.className.split(' ').join('.') : '') + '>' + this.textContent.slice(0, 30); }
}

class FakeDoc {
  constructor() {
    this.listeners = new Map(); this.scrolls = []; this.active = null;
    this.documentElement = new FakeEl(this, 'html');
    this.documentElement.parentNode = this;      // events bubble from the page up to the document
    this.body = new FakeEl(this, 'body');
    this.documentElement.append(this.body);
    this.documentElement.parentNode = this;
  }
  get activeElement() { return this.active && this.active.isConnected ? this.active : this.body; }   // like a browser
  createElement(tag) { return new FakeEl(this, tag); }
  getElementById(id) { return this.documentElement.querySelector('#' + id); }
  querySelector(sel) { return this.documentElement.querySelector(sel); }
  addEventListener(type, fn) { listen(this, type, fn); }
  dispatchEvent(e) { return dispatch(this, e); }
}

class FakeSearchParams {
  constructor(s = '') {
    this.list = String(s).replace(/^\?/, '').split('&').filter(Boolean).map((p) => {
      const i = p.indexOf('=');
      return i < 0 ? [decodeURIComponent(p), ''] : [decodeURIComponent(p.slice(0, i)), decodeURIComponent(p.slice(i + 1))];
    });
  }
  get(k) { const x = this.list.find((p) => p[0] === k); return x ? x[1] : null; }
  has(k) { return this.list.some((p) => p[0] === k); }
  set(k, v) { const x = this.list.find((p) => p[0] === k); if (x) x[1] = String(v); else this.list.push([k, String(v)]); }
  delete(k) { this.list = this.list.filter((p) => p[0] !== k); }
  toString() { return this.list.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&'); }
}
const splitUrl = (href) => {
  const m = String(href).match(/^(\w+:\/\/[^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/);
  return { origin: m[1], pathname: m[2] || '/', search: m[3] || '', hash: m[4] || '' };
};
class FakeURL {
  constructor(href) { const p = splitUrl(href); this.pathname = p.pathname; this.hash = p.hash; this.searchParams = new FakeSearchParams(p.search); }
  get search() { const s = this.searchParams.toString(); return s ? '?' + s : ''; }
}

const GLOBALS = ['document', 'window', 'location', 'history', 'URL', 'URLSearchParams', 'CustomEvent'];

// The parts of index.html that app.js and card.js use. The paste box sits on screen (a laptop at the top).
function installPage({ url = 'http://localhost:8765/site/', scrollY = 0 } = {}) {
  const saved = GLOBALS.map((n) => [n, Object.getOwnPropertyDescriptor(globalThis, n)]);
  const doc = new FakeDoc();
  const el = (tag, id) => { const e = doc.createElement(tag); if (id) e.id = id; return e; };
  const form = el('form', 'paste-form'), input = el('input', 'ca-input'), submit = el('button', 'paste-submit');
  const hintP = el('p', 'paste-hint'), result = el('section', 'result');
  form.append(input, submit);
  doc.body.append(form, hintP, result);
  input.rect = { top: 600, bottom: 652, left: 380, right: 1060, width: 680, height: 52 };
  const win = { scrollY, innerHeight: 900, matchMedia: (q) => ({ matches: /reduce/.test(q) }) };   // reduced motion: no timers
  const loc = { hostname: 'localhost' };
  const setLoc = (href) => { Object.assign(loc, splitUrl(href), { href }); };
  setLoc(url);
  const hist = { state: null, calls: 0, replaceState(st, t, path) { this.state = st; this.calls++; setLoc(loc.origin + path); } };
  Object.assign(globalThis, { document: doc, window: win, location: loc, history: hist, URL: FakeURL, URLSearchParams: FakeSearchParams, CustomEvent: FakeEvent });
  return {
    doc, win, loc, hist, input, submit, hint: hintP, result,
    card: () => result.firstElementChild,
    restore() {
      for (const [n, d] of saved) { if (d) Object.defineProperty(globalThis, n, d); else delete globalThis[n]; }
    },
  };
}
async function onPage(opts, fn) {
  const page = installPage(opts);
  try { await fn(page); } finally { page.restore(); _setFetcher(null); }
}

// The data layer swapped for one we answer by hand: calls[i].answer(PriceInput | ErrorResult).
function fakeFetcher() {
  const calls = [];
  _setFetcher((address, w, opts) => new Promise((resolve) => { calls.push({ address, w, opts, answer: resolve }); }));
  return calls;
}
const tabsOf = (card) => card.querySelectorAll('[role="tab"]').map((t) => t.dataset.window);
const selectedTab = (card) => card.querySelector('[role="tab"][aria-selected="true"]');
const buttonTexts = (card) => card.querySelectorAll('.bts-btn').map((b) => b.textContent);

// ---- card.js -------------------------------------------------------------------------------------
pageTest('errors worth retrying keep "Try again" and the window tabs; others don\'t', () => onPage({}, (p) => {
  const opts = { onRetry: () => {}, onWindow: () => {}, window: '6h', coin: SHRP, settings: SETTINGS };
  for (const code of ['rpc-failed', 'stale', 'search-failed']) {
    const card = renderError(p.result, buildError({ ok: false, code }), opts);
    eq(tabsOf(card), ['1h', '6h', '24h', '7d'], code);
    eq(selectedTab(card).dataset.window, '6h', code);
    eq(buttonTexts(card), ['Try again', 'Try another coin'], code);
    eq(card.querySelector('.bts-error').textContent, SETTINGS.wording.errors[code], code);
  }
  eq(buttonTexts(renderError(p.result, buildError({ ok: false, code: 'pair-too-new' }), opts)), ['Try another coin']);
  eq(tabsOf(p.card()).length, 4, 'pair-too-new keeps its tabs');
  for (const code of ['unsupported-pool', 'no-pool', 'not-a-token']) {
    const card = renderError(p.result, buildError({ ok: false, code }), opts);
    eq(tabsOf(card), [], code);
    eq(buttonTexts(card), ['Try another coin'], code);
  }
}));

pageTest('"Try again" keeps keyboard focus on the card (the selected tab), through loading and the answer', () => onPage({}, (p) => {
  const opts = { onRetry: () => {}, onWindow: () => {}, window: '24h', coin: ZOLVA, settings: SETTINGS };
  const err = renderError(p.result, buildError({ ok: false, code: 'rpc-failed' }), opts);
  const again = err.querySelectorAll('.bts-btn')[0];
  again.focus();
  eq(p.doc.activeElement, again);
  renderLoading(p.result, 'Finding the pool…', { coin: ZOLVA, window: '24h' });   // the button is gone now
  eq(p.doc.activeElement, selectedTab(p.card()));
  eq(p.doc.activeElement.dataset.window, '24h');
  renderError(p.result, buildError({ ok: false, code: 'stale' }), opts);
  eq(p.doc.activeElement, selectedTab(p.card()), 'it was on a tab, so it stays on the tab');
  const res = renderResult(p.result, buildResult(pi({}), SETTINGS, NY), { onWindow: () => {}, settings: SETTINGS, prepareImage: false });
  eq(p.doc.activeElement, selectedTab(res));
}));

pageTest('an error card without tabs: focus goes to the loading card, then to the first button', () => onPage({}, (p) => {
  const err = renderError(p.result, buildError({ ok: false, code: 'rpc-failed' }), { onRetry: () => {} });
  eq(tabsOf(err), []);
  err.querySelector('.bts-btn').focus();
  const loading = renderLoading(p.result, 'Finding the pool…', { coin: ZOLVA, window: '24h' });
  eq(p.doc.activeElement, loading, 'the loading card itself holds focus (tabindex -1)');
  eq(loading.getAttribute('tabindex'), '-1');
  const err2 = renderError(p.result, buildError({ ok: false, code: 'rpc-failed' }), { onRetry: () => {} });
  eq(p.doc.activeElement, err2.querySelector('.bts-btn'));
  eq(p.doc.activeElement.textContent, 'Try again');
  const res = renderResult(p.result, buildResult(pi({}), SETTINGS, NY), { onWindow: () => {}, settings: SETTINGS, prepareImage: false });
  eq(p.doc.activeElement, selectedTab(res), 'a result puts it on the selected tab');
}));

pageTest('focus outside the card (the paste box) is never moved by a redraw', () => onPage({}, (p) => {
  p.input.focus();
  renderLoading(p.result, 'Finding the pool…', { coin: ZOLVA, window: '24h' });
  renderError(p.result, buildError({ ok: false, code: 'rpc-failed' }), { onRetry: () => {}, onWindow: () => {}, window: '24h', coin: ZOLVA });
  renderLoading(p.result, 'Finding the pool…', { coin: ZOLVA, window: '24h' });
  renderResult(p.result, buildResult(pi({}), SETTINGS, NY), { onWindow: () => {}, settings: SETTINGS, prepareImage: false });
  eq(p.doc.activeElement, p.input);
}));

pageTest('clearCard empties the slot; focusInput scrolls only when the box is off screen', () => onPage({}, (p) => {
  renderError(p.result, buildError({ ok: false, code: 'rpc-failed' }), {});
  clearCard(p.result);
  eq(p.result.children.length, 0);
  focusInput();
  eq(p.doc.activeElement, p.input);
  eq(p.doc.scrolls, [], 'already on screen: no scroll');
  p.input.blur();
  p.input.rect = { top: -400, bottom: -348 };
  focusInput();
  eq(p.doc.activeElement, p.input);
  eq(p.doc.scrolls, ['ca-input']);
}));

// ---- app.js --------------------------------------------------------------------------------------
pageTest('a lookup shows its loading card right away, scrolls to it and marks the Blame button busy', () => onPage({}, async (p) => {
  const calls = fakeFetcher();
  const run = lookup(ZOLVA, '24h', { scroll: true });
  eq(calls.length, 1);
  eq([calls[0].address, calls[0].w], [ZOLVA, '24h']);
  eq(p.card().dataset.state, 'loading');
  eq(p.doc.scrolls, ['result'], 'scrolled while loading, not only when done');
  eq(p.submit.getAttribute('aria-busy'), 'true');
  ok(/[?&]ca=0x8e04549484d0612be8373a0263b11928a5f7681f/.test(p.loc.search), p.loc.search);
  calls[0].answer(pi({}));
  await run;
  eq(p.card().dataset.state, 'result');
  eq(p.submit.getAttribute('aria-busy'), null);
}));

pageTest('a newer lookup cancels the older one: only the newest draws, and the button stays busy until it ends', () => onPage({}, async (p) => {
  const calls = fakeFetcher();
  const first = lookup(ZOLVA, '24h', { scroll: true });
  eq(calls[0].opts.cancelled(), false);
  const second = lookup(SHRP, '1h', { scroll: true });
  eq(calls[0].opts.cancelled(), true, 'the data layer is told the first one is no longer wanted');
  eq(calls[1].opts.cancelled(), false);
  calls[0].answer(pi({}));
  await first;
  eq([p.card().dataset.state, p.card().dataset.coin], ['loading', SHRP], 'the old answer is dropped');
  eq(p.submit.getAttribute('aria-busy'), 'true');
  calls[1].answer({ ok: false, code: 'search-failed' });
  await second;
  eq([p.card().dataset.state, p.card().dataset.code], ['error', 'search-failed']);
  eq(buttonTexts(p.card()), ['Try again', 'Try another coin']);
  eq(tabsOf(p.card()), ['1h', '6h', '24h', '7d']);
  eq(p.submit.getAttribute('aria-busy'), null);
}));

pageTest('"Try again" from app.js: no scrolling, focus stays on the card, and a failed tab switch keeps its tabs', () => onPage({}, async (p) => {
  const calls = fakeFetcher();
  const run = lookup(SHRP, '24h', { scroll: true });
  calls[0].answer({ ok: false, code: 'rpc-failed' });
  await run;
  const scrolls = p.doc.scrolls.length;
  const again = p.card().querySelector('.bts-btn');
  again.focus();
  again.click();
  eq(calls.length, 2);
  eq(p.doc.scrolls.length, scrolls, 'Try again stays put');
  eq(p.doc.activeElement, selectedTab(p.card()));
  calls[1].answer(pi({ address: SHRP, sym: 'SHRP' }));
  await new Promise((r) => setTimeout(r, 0));
  eq(p.card().dataset.state, 'result');
  eq(p.doc.activeElement, selectedTab(p.card()));
  // Now a tab switch that fails: the error keeps the tabs, so the visitor can go back.
  p.card().querySelector('[data-window="6h"]').click();
  eq(calls[2].w, '6h');
  calls[2].answer({ ok: false, code: 'rpc-failed' });
  await new Promise((r) => setTimeout(r, 0));
  eq(p.card().dataset.state, 'error');
  eq(selectedTab(p.card()).dataset.window, '6h');
  p.card().querySelector('[data-window="24h"]').click();
  eq(calls[3].w, '24h');
  calls[3].answer(pi({ address: SHRP, sym: 'SHRP' }));
  await new Promise((r) => setTimeout(r, 0));
  eq([p.card().dataset.state, p.card().dataset.window], ['result', '24h']);
}));

pageTest('an empty Blame just puts the cursor in the box; a lookup already running carries on', () => onPage({}, async (p) => {
  const calls = fakeFetcher();
  const run = lookup(ZOLVA, '24h', { scroll: true });
  const scrolls = p.doc.scrolls.length;
  await lookup('   ', '24h', { scroll: true });
  eq(calls.length, 1, 'no new lookup');
  eq(p.doc.activeElement, p.input);
  eq(p.doc.scrolls.length, scrolls, 'the page did not move');
  eq(p.hint.textContent, '');
  calls[0].answer(pi({}));
  await run;
  eq(p.card().dataset.state, 'result', 'the running lookup still drew its card');
}));

pageTest('an entry that isn\'t an address: a line under the box, no card, no ?ca, and the page stays put', () => onPage({ url: 'http://localhost:8765/site/?w=1h' }, async (p) => {
  boot();
  const calls = fakeFetcher();
  const run = lookup(SHRP, '1h', { scroll: true });
  calls[0].answer(pi({ address: SHRP, sym: 'SHRP' }));
  await run;
  ok(p.loc.search.includes('ca=' + SHRP), p.loc.search);
  const scrolls = p.doc.scrolls.length;
  p.input.value = 'not an address';
  await lookup(p.input.value, '1h', { scroll: true });
  eq(p.hint.textContent, SETTINGS.wording.errors['bad-address']);
  eq(p.input.getAttribute('aria-invalid'), 'true');
  eq(p.result.children.length, 0, 'the old card is gone');
  eq(p.loc.search, '?w=1h', 'the address bar no longer points at SHRP');
  eq(p.doc.scrolls.length, scrolls, 'no scrolling away from the box');
  eq(p.doc.activeElement, p.input);
  eq(calls.length, 1);
  // Typing again clears the line.
  p.input.dispatchEvent(new FakeEvent('input', { bubbles: true }));
  eq(p.hint.textContent, '');
  eq(p.input.getAttribute('aria-invalid'), null);
}));

pageTest('a shared link scrolls to its card once it is drawn', () => onPage({ url: 'http://localhost:8765/site/?ca=' + ZOLVA + '&w=1h' }, async (p) => {
  const calls = fakeFetcher();
  ok(untouched());
  boot();
  eq([calls[0].address, calls[0].w], [ZOLVA, '1h']);
  eq(p.input.value, ZOLVA);
  eq(p.doc.scrolls, [], 'not while loading: the headline shows first');
  calls[0].answer(pi({}));
  await new Promise((r) => setTimeout(r, 0));
  eq(p.card().dataset.state, 'result');
  eq(p.doc.scrolls, ['result']);
}));

pageTest('a shared link does not scroll when the visitor scrolled or clicked into the box meanwhile', async () => {
  for (const touch of ['scroll', 'focus']) {
    await onPage({ url: 'http://localhost:8765/site/?ca=' + ZOLVA }, async (p) => {
      const calls = fakeFetcher();
      boot();
      if (touch === 'scroll') p.win.scrollY = 240; else p.input.focus();
      eq(untouched(), false, touch);
      calls[0].answer({ ok: false, code: 'rpc-failed' });
      await new Promise((r) => setTimeout(r, 0));
      eq(p.card().dataset.state, 'error', touch);
      eq(p.doc.scrolls, [], touch);
    });
  }
});

pageTest('a shared link that isn\'t an address: the line under the box, and ?ca is dropped', () => onPage({ url: 'http://localhost:8765/site/?ca=hello&w=6h' }, async (p) => {
  const calls = fakeFetcher();
  boot();
  await new Promise((r) => setTimeout(r, 0));
  eq(calls.length, 0);
  eq(p.hint.textContent, SETTINGS.wording.errors['bad-address']);
  eq(p.loc.search, '?w=6h');
  eq(p.doc.activeElement, p.doc.body, 'no focus grab on load (it would open a phone keyboard)');
}));

// ---- board.js -> app.js --------------------------------------------------------------------------
pageTest('a board row opens its coin in place, in the board\'s window (no reload)', () => onPage({ url: 'http://localhost:8765/site/?ca=' + SHRP + '&w=24h' }, async (p) => {
  const calls = fakeFetcher();
  boot();
  calls[0].answer(pi({ address: SHRP, sym: 'SHRP' }));
  await new Promise((r) => setTimeout(r, 0));
  p.loc.assign = () => { throw new Error('the page reloaded'); };
  openCoin(ZOLVA, '7d');
  eq(calls.length, 2);
  eq([calls[1].address, calls[1].w], [ZOLVA, '7d']);
  eq(p.input.value, ZOLVA);
  ok(p.loc.search.includes('ca=' + ZOLVA) && p.loc.search.includes('w=7d'), p.loc.search);
  eq(p.card().dataset.state, 'loading');
  ok(p.doc.scrolls.includes('result'), 'brought into view');
  calls[1].answer(pi({ win: '7d' }));
  await new Promise((r) => setTimeout(r, 0));
  eq([p.card().dataset.coin, p.card().dataset.window], [ZOLVA, '7d']);
}));

pageTest('openCoin sends one bts:open event with the address and window', () => onPage({}, () => {
  const seen = [];
  const target = { dispatchEvent: (e) => { seen.push(e); return true; } };
  openCoin(ZOLVA, '6h', target);
  eq(OPEN_EVENT, 'bts:open');
  eq(seen.length, 1);
  eq([seen[0].type, seen[0].detail], ['bts:open', { address: ZOLVA, window: '6h' }]);
}));
