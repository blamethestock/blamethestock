// Blame the Stock: the copy check card ("Is this the real one?"). Shows a CopyCheckResult from our API
// (api/src/copies.js) in #copies, under the blame card. Loaded by app.js only when it is needed.
//
//   fetchCopies(query, settings, { fetch }) -> CopyCheckResult | { ok:false, code, message } | null (API unreachable)
//   copyView(result, settings, { timeZone }) -> plain object with every string and link the card shows (no DOM)
//   renderCopiesLoading(el, settings) / renderCopies(el, resultOrErrorOrNull, settings, { timeZone })
//
// Everything from the API is treated as data: text goes in with textContent only, and every link is rebuilt here
// from an address or transaction hash that has been checked, so a bad answer can't point a link anywhere else.
import { SETTINGS } from '../../settings.js';
import { fill, usd } from '../core/format.js';
import { duration, markSegments } from '../trust/rules.js';

export const EXPLORER = 'https://robinhoodchain.blockscout.com';
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const PROOF = /^https:\/\/robinhoodchain\.blockscout\.com\/(tx|address|token)\/(0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64})$/;
const TIMEOUT_MS = 25000;
const MAX_TEXT = 400;           // longest sentence taken from the API
const MAX_NAME = 64;            // longest coin name or symbol shown

const isAddr = (a) => typeof a === 'string' && ADDR.test(a);
const isHash = (h) => typeof h === 'string' && HASH.test(h);
export const tokenUrl = (a) => (isAddr(a) ? EXPLORER + '/token/' + a.toLowerCase() : null);
export const addressUrl = (a) => (isAddr(a) ? EXPLORER + '/address/' + a.toLowerCase() : null);
export const txUrl = (h) => (isHash(h) ? EXPLORER + '/tx/' + h.toLowerCase() : null);
export const shortAddr = (a) => (isAddr(a) ? a.slice(0, 6) + '…' + a.slice(-4) : '');
const text = (s, max = MAX_TEXT) => (typeof s === 'string' ? s.slice(0, max) : '');
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const secs = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t / 1000 : null; };
// A word from a settings table, only when the table really has it (so a code like 'constructor' finds nothing).
const own = (table, key) => (table && Object.prototype.hasOwnProperty.call(table, key) && typeof table[key] === 'string' ? table[key] : null);

// The card's words: settings.trust.wording, with the same words built in as a fallback.
const WORDS = {
  title: 'Is this the real one?',
  checking: 'Looking for coins with the same name…',
  unavailable: 'Copy check unavailable right now.',
  official: 'Official {symbol}',
  copy: 'Copy', copied: 'Copied', copyFailed: "Couldn't copy",
  explorer: 'Explorer',
  yours: 'Yours', officialTag: 'Official', near: 'Similar name',
  launched: 'Launched {time}',
  beforeYours: '{gap} before yours', afterYours: '{gap} after yours', sameAsYours: 'same minute as yours',
  beforeOfficial: '{gap} before the official one', afterOfficial: '{gap} after the official one',
  holders: 'Holders', liquidity: 'Money in it', underOneDollar: 'under $1',
  graduated: 'Graduated', graduatedYes: 'Yes, {time}', graduatedNo: 'Not yet',
  dev: 'Dev', unknown: "can't read",
  quietOne: '1 quiet copy', quietMany: '{count} quiet copies',
  quietHint: 'Never graduated, almost no money left and no recent trades.',
  indexing: 'Searching Pons launches since {date}.',
  asOf: 'Chain data as of {time}',
  proof: 'proof',
  howTitle: 'How we got this',
  how: [
    'We list every Pons launch with the same name, after removing hidden characters and look-alike letters.',
    "Then we read each coin's launch, dev wallet, trades, fee claims and bridge transfers from Robinhood Chain.",
  ],
  flags: {
    'launched-just-before': 'Launched just before', 'dev-dumped-fast': 'Dev sold fast',
    'fees-and-left': 'Took fees and left', 'dead-copy': 'Quiet copy',
    'same-snipers': 'Same first buyers', 'name-of-official': 'Uses the official name',
  },
  errors: {},
};
export function words(settings = SETTINGS) {
  const w = (settings && settings.trust && settings.trust.wording) || {};
  return { ...WORDS, ...w, flags: { ...WORDS.flags, ...(w.flags || {}) }, errors: { ...WORDS.errors, ...(w.errors || {}) } };
}

// ---- the API ---------------------------------------------------------------------------------------------
// GET {apiBase}/v1/copies?q=… . Returns the result, an error the API explained, or null when the API couldn't be
// reached or answered something we don't understand (the card then shows one grey line).
export async function fetchCopies(query, settings = SETTINGS, { fetch: f = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const t = (settings && settings.trust) || {};
  const base = String(t.apiBase || '').replace(/\/+$/, '');
  const q = String(query == null ? '' : query).trim().slice(0, 100);
  if (!/^https:\/\/[^/?#]+$/.test(base) || !q || typeof f !== 'function') return null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl && typeof setTimeout === 'function' ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await f(base + '/v1/copies?q=' + encodeURIComponent(q), {
      method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit',
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    if (!res || res.status === 429) return null;        // busy: same as unreachable
    let body;                                           // an error the API explains comes with any status
    try { body = await res.json(); } catch (e) { return null; }
    return checkAnswer(body);
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Only the two shapes of the contract get through.
export function checkAnswer(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.ok === true && Array.isArray(body.matches) && body.query && typeof body.query === 'object') return body;
  if (body.ok === false && typeof body.code === 'string' && /^[a-z-]{2,40}$/.test(body.code)) {
    return { ok: false, code: body.code, message: text(body.message) };
  }
  return null;
}

// ---- times -----------------------------------------------------------------------------------------------
// 'Nov 17, 2:02 PM EST' in the visitor's own time zone (or the one given), English like the rest of the page.
export function when(iso, timeZone) {
  const s = secs(iso);
  if (s == null) return '';
  const opts = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  for (const tz of [timeZone, undefined]) {
    try {
      // Put together from parts: browsers differ on the joint ("Nov 17, 9:02 AM" vs "Nov 17 at 9:02 AM").
      const p = {};
      for (const x of new Intl.DateTimeFormat('en-US', tz ? { ...opts, timeZone: tz } : opts).formatToParts(new Date(s * 1000))) p[x.type] = x.value;
      return (p.month + ' ' + p.day + ', ' + p.hour + ':' + p.minute + ' ' + (p.dayPeriod || '') + ' ' + (p.timeZoneName || ''))
        .replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
    } catch (e) { /* bad zone: try the visitor's own */ }
  }
  return new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
function day(iso, timeZone) {
  const s = secs(iso);
  if (s == null) return '';
  const opts = { month: 'short', day: 'numeric', year: 'numeric' };
  for (const tz of [timeZone, undefined]) {
    try { return new Intl.DateTimeFormat('en-US', tz ? { ...opts, timeZone: tz } : opts).format(new Date(s * 1000)); }
    catch (e) { /* next */ }
  }
  return String(iso).slice(0, 10);
}

// '11 min 45 s before yours', 'same minute as yours', or null.
export function relative(a, b, W, kind = 'Yours') {
  const x = secs(a), y = secs(b);
  if (x == null || y == null) return null;
  const gap = x - y;
  if (Math.abs(gap) < 60 && kind === 'Yours') return W.sameAsYours;
  return fill(gap < 0 ? W['before' + kind] : W['after' + kind], { gap: duration(Math.abs(gap)) });
}

// ---- the view (pure: no DOM) -----------------------------------------------------------------------------
const odd = (s) => markSegments(text(s, MAX_NAME));

function money(liq, W) {
  const v = liq ? num(liq.usd) : null;
  if (v == null) return W.unknown;
  return v < 1 ? W.underOneDollar : usd(v);
}

function rowView(m, ref, refKind, W, tz) {
  const missing = Array.isArray(m.missing) ? m.missing : [];
  const flags = (Array.isArray(m.flags) ? m.flags : []).filter((f) => f && typeof f.code === 'string').map((f) => ({
    code: f.code,
    severity: f.severity === 'warn' ? 'warn' : 'info',
    label: own(W.flags, f.code) || text(f.code, 40),
    text: text(f.text),
    proofs: (Array.isArray(f.proof) ? f.proof : []).filter((u) => typeof u === 'string' && PROOF.test(u)).slice(0, 6),
  }));
  const launch = m.launch || {};
  const tags = [];
  if (m.isQuery) tags.push(W.yours);
  if (m.isOfficial) tags.push(W.officialTag);
  if (m.match === 'near') tags.push(W.near);
  const holders = m.holders && num(m.holders.count) != null ? m.holders.count : null;
  const gradKnown = !missing.includes('graduated');
  const g = m.graduated && typeof m.graduated === 'object' ? m.graduated : null;
  return {
    address: m.address.toLowerCase(),
    short: shortAddr(m.address),
    tokenUrl: tokenUrl(m.address),
    isQuery: !!m.isQuery,
    isOfficial: !!m.isOfficial,
    near: m.match === 'near',
    warn: flags.some((f) => f.severity === 'warn'),
    quiet: !m.isQuery && !m.isOfficial && flags.some((f) => f.code === 'dead-copy') && !flags.some((f) => f.severity === 'warn'),
    tags,
    symbol: odd(m.symbol),
    dollar: !/^\s*\$/.test(text(m.symbol, MAX_NAME)),   // '$' in front, unless the symbol already has one
    name: odd(m.name),
    launched: {
      text: fill(W.launched, { time: when(launch.time, tz) || W.unknown }),
      url: txUrl(launch.tx),
      rel: ref && ref !== m && launch.time ? relative(launch.time, ref.launch && ref.launch.time, W, refKind) : null,
    },
    facts: [
      { key: 'holders', label: W.holders, text: holders == null ? W.unknown : holders.toLocaleString('en-US'), url: holders == null ? null : tokenUrl(m.address) },
      { key: 'liquidity', label: W.liquidity, text: money(m.liquidity, W),
        url: m.liquidity && num(m.liquidity.usd) != null ? (m.liquidity.source === 'curve' ? addressUrl(m.curve) : null) || tokenUrl(m.address) : null },
      { key: 'graduated', label: W.graduated,
        text: g ? fill(W.graduatedYes, { time: when(g.time, tz) }) : gradKnown ? W.graduatedNo : W.unknown,
        url: g ? txUrl(g.tx) : gradKnown ? addressUrl(m.curve) : null },
      { key: 'dev', label: W.dev, text: isAddr(m.creator) ? shortAddr(m.creator) : W.unknown, url: addressUrl(m.creator) },
    ],
    flags,
    time: secs(launch.time),
  };
}

export function copyView(result, settings = SETTINGS, { timeZone } = {}) {
  const W = words(settings);
  const all = (result.matches || []).filter((m) => m && isAddr(m.address));
  const queryRow = all.find((m) => m.isQuery) || null;
  const officialRow = all.find((m) => m.isOfficial) || null;
  const ref = queryRow || officialRow;
  const refKind = queryRow ? 'Yours' : 'Official';
  const rows = all.map((m) => rowView(m, ref, refKind, W, timeZone))
    .sort((a, b) => (a.time == null ? Infinity : a.time) - (b.time == null ? Infinity : b.time));
  const quiet = rows.filter((r) => r.quiet);
  const o = result.official && isAddr(result.official.address) ? result.official : null;
  const sym = o ? '$' + text(String(o.symbol || '').replace(/^\$/, ''), 20) : '';
  const indexing = result.indexComplete === false && result.indexedFrom ? fill(W.indexing, { date: day(result.indexedFrom, timeZone) }) : null;
  return {
    title: W.title,
    query: result.query && result.query.kind === 'address' && isAddr(result.query.address)
      ? shortAddr(result.query.address)
      : '$' + text(String((result.query && result.query.input) || '').replace(/^\$/, ''), 32),
    verdict: text(result.verdict),
    official: o ? { label: '✅ ' + fill(W.official, { symbol: sym }), address: o.address.toLowerCase(), url: tokenUrl(o.address) } : null,
    rows: rows.filter((r) => !r.quiet),
    quiet,
    quietLabel: quiet.length === 1 ? W.quietOne : fill(W.quietMany, { count: quiet.length }),
    quietHint: W.quietHint,
    notes: (Array.isArray(result.notes) ? result.notes : []).map((n) => text(n))
      .filter((n) => n && !(indexing && /^Still indexing/.test(n))),
    indexing,
    caveats: (Array.isArray(result.caveats) ? result.caveats : []).map((c) => text(c)).filter(Boolean),
    how: { title: W.howTitle, items: (Array.isArray(W.how) ? W.how : [W.how]).map(String) },
    asOf: result.asOf ? fill(W.asOf, { time: when(result.asOf, timeZone) }) : '',
    words: W,
  };
}

// The words for an error from the API (settings first, then the API's own sentence).
export function errorText(err, settings = SETTINGS) {
  const W = words(settings);
  if (!err) return W.unavailable;
  return own(W.errors, err.code) || text(err.message) || W.unavailable;
}

// ---- DOM -------------------------------------------------------------------------------------------------
const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
};

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false && kid !== '') el.append(kid);
  return el;
}
const ext = (href, props, ...kids) => (href
  ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', ...props }, ...kids)
  : h('span', props, ...kids));

function swap(el, node) {
  el.textContent = '';
  if (node) el.append(node);
}

// Hidden characters as a grey '·', look-alike letters underlined (both with a tooltip saying what they are).
function marked(segs, cls) {
  return h('span', { class: cls }, segs.map((s) => (s.kind === 'plain' ? s.text
    : h('mark', { class: 'cc-odd cc-odd-' + s.kind, title: s.kind === 'hidden' ? 'hidden character' : 'look-alike letter', text: s.text }))));
}

async function copyText(value) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(value); return true; }
  } catch (e) { /* fall through */ }
  return false;
}

function addrTools(address, W, { full = false } = {}) {
  const btn = h('button', { type: 'button', class: 'cc-tool', 'aria-label': W.copy + ' ' + address, text: W.copy });
  let t = null;
  btn.addEventListener('click', async () => {
    const ok = await copyText(address);
    btn.textContent = ok ? W.copied : W.copyFailed;
    clearTimeout(t);
    t = setTimeout(() => { btn.textContent = W.copy; }, 1600);
  });
  return h('span', { class: 'cc-addr' + (full ? ' is-full' : '') },
    ext(tokenUrl(address), { class: 'cc-addr-text', title: address },
      full ? h('span', { class: 'cc-addr-full', text: address }) : null,
      h('span', { class: 'cc-addr-short', text: shortAddr(address) })),
    btn,
    ext(tokenUrl(address), { class: 'cc-tool', 'aria-label': W.explorer + ' (opens in a new tab)' }, W.explorer, h('span', { 'aria-hidden': 'true', text: ' ↗' })));
}

function rowEl(r, W) {
  const cls = ['cc-row'];
  if (r.isQuery) cls.push('is-query');
  if (r.isOfficial) cls.push('is-official');
  if (r.warn) cls.push('is-warn');
  return h('li', { class: cls.join(' '), 'data-address': r.address },
    h('span', { class: 'cc-node', 'aria-hidden': 'true' }),
    h('div', { class: 'cc-main' },
      h('div', { class: 'cc-name-line' },
        ext(r.tokenUrl, { class: 'cc-symbol' }, r.symbol.length ? [r.dollar ? '$' : null, marked(r.symbol, 'cc-sym-text')] :marked(r.name, 'cc-sym-text')),
        r.symbol.length && r.name.length ? marked(r.name, 'cc-name') : null,
        r.tags.map((t) => h('span', { class: 'cc-tag' + (t === W.yours ? ' is-yours' : t === W.officialTag ? ' is-official' : ''), text: t }))),
      addrTools(r.address, W, { full: true }),
      h('p', { class: 'cc-when' },
        ext(r.launched.url, { class: 'cc-link' }, r.launched.text),
        r.launched.rel ? [' ', h('span', { class: 'cc-rel', text: r.launched.rel })] : null),
      h('dl', { class: 'cc-facts' }, r.facts.map((f) => h('div', { class: 'cc-fact', 'data-key': f.key },
        h('dt', { text: f.label }),
        h('dd', null, ext(f.url, { class: f.url ? 'cc-link' : 'cc-unknown' }, f.text))))),
      r.flags.length ? h('ul', { class: 'cc-flags' }, r.flags.map((f) => h('li', { class: 'cc-flag is-' + f.severity, 'data-code': f.code },
        h('span', { class: 'cc-dot', 'aria-hidden': 'true' }),
        h('span', { class: 'cc-flag-body' },
          h('b', { class: 'cc-flag-label', text: f.label }), ' ',
          h('span', { class: 'cc-flag-text', text: f.text }),
          f.proofs.map((u, i) => [' ', ext(u, { class: 'cc-proof', 'aria-label': W.proof + ' ' + (i + 1) + ' (opens in a new tab)' },
            i === 0 ? W.proof + ' ↗' : String(i + 1))]))))) : null));
}

function head(view) {
  return h('header', { class: 'cc-head' },
    h('h2', { class: 'cc-title', text: view.title }),
    view.query ? h('p', { class: 'cc-query', text: view.query }) : null);
}

function card(state, ...kids) {
  const el = h('article', { class: 'bts-card cc-card', 'data-state': state }, ...kids);
  if (!reducedMotion()) el.classList.add('is-entering');
  return el;
}

export function renderCopiesLoading(el, settings = SETTINGS) {
  const W = words(settings);
  if (!el) return null;
  const c = card('loading', head({ title: W.title }), h('p', { class: 'bts-progress cc-progress', text: W.checking }));
  c.setAttribute('aria-busy', 'true');
  swap(el, c);
  return c;
}

// One grey line: the API couldn't be reached, or answered with an error.
function line(el, words) {
  const p = h('p', { class: 'cc-line', 'data-state': 'unavailable', text: words });
  swap(el, p);
  return p;
}

export function renderCopies(el, res, settings = SETTINGS, { timeZone } = {}) {
  if (!el) return null;
  if (!res) return line(el, words(settings).unavailable);
  if (res.ok !== true) {
    const p = line(el, errorText(res, settings));
    p.setAttribute('data-state', 'error');
    p.setAttribute('data-code', res.code || '');
    return p;
  }
  const view = copyView(res, settings, { timeZone });
  const W = view.words;
  const c = card('result',
    head(view),
    h('p', { class: 'cc-verdict', text: view.verdict }),
    view.official ? h('div', { class: 'cc-official' },
      h('span', { class: 'cc-badge', text: view.official.label }),
      addrTools(view.official.address, W, { full: true })) : null,
    view.rows.length ? h('ol', { class: 'cc-timeline' }, view.rows.map((r) => rowEl(r, W))) : null,
    view.quiet.length ? h('details', { class: 'cc-quiet' },
      h('summary', null, h('span', { class: 'cc-quiet-label', text: view.quietLabel }), h('span', { class: 'cc-quiet-hint', text: view.quietHint })),
      h('ol', { class: 'cc-timeline' }, view.quiet.map((r) => rowEl(r, W)))) : null,
    view.notes.length ? h('ul', { class: 'cc-notes' }, view.notes.map((n) => h('li', { text: n }))) : null,
    h('footer', { class: 'cc-foot' },
      view.indexing ? h('p', { class: 'cc-indexing', text: view.indexing }) : null,
      view.caveats.length ? h('ul', { class: 'cc-caveats' }, view.caveats.map((n) => h('li', { text: n }))) : null,
      h('details', { class: 'cc-how' },
        h('summary', { text: view.how.title }),
        view.how.items.map((s) => h('p', { text: s }))),
      view.asOf ? h('p', { class: 'cc-asof', text: view.asOf }) : null));
  swap(el, c);
  return c;
}
