// Blame the Stock: the tool. Reads ?ca and ?w, wires the paste box, the example coins and the window tabs,
// asks the data layer for prices, turns them into words (core) and shows the card (ui/card.js).
import { SETTINGS } from '../settings.js';
import { fetchPriceInput, clearDataCache, fetchOffHours } from './data/index.js';
import { buildResult, buildError } from './core/verdict.js';
import { validateAddress, parseWindow } from './core/math.js';
import { renderLoading, renderResult, renderError, focusInput, renderOffHours, clearCard } from './ui/card.js';

const FIRST_STEP = 'Finding the pool…';
const OPEN_EVENT = 'bts:open';                 // features/board.js opens a coin with { detail: { address, window } }

let seq = 0;                                   // every lookup gets a number; only the newest may draw
let shown = { address: null, window: parseWindow(null, SETTINGS) };
let fetcher = fetchPriceInput;                 // tests swap the data layer out (_setFetcher)
export function _setFetcher(f) { fetcher = typeof f === 'function' ? f : fetchPriceInput; }

const $ = (id) => document.getElementById(id);
const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
};
const coarsePointer = () => {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
};

function toError(res) {
  const raw = res && res.ok === false ? res : { ok: false, code: 'rpc-failed' };
  try {
    return buildError(raw, SETTINGS);
  } catch (e) {
    const errors = SETTINGS.wording.errors;
    return { ok: false, code: raw.code, message: errors[raw.code] || errors['rpc-failed'] };
  }
}

// The address bar matches what's on screen: ?ca=…&w=… for a coin, no ?ca after an entry that isn't one.
function setUrl(address, w) {
  try {
    const u = new URL(location.href);
    if (address) u.searchParams.set('ca', address); else u.searchParams.delete('ca');
    u.searchParams.delete('q');
    u.searchParams.delete('view');
    u.searchParams.set('w', w);
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  } catch (e) { /* file:// or locked-down browsers: the link still works from Copy link */ }
}

// Bring the card into view unless it's already fully on screen (#result's scroll-margin clears the menu).
function reveal(out) {
  const r = (out.firstElementChild || out).getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  if (r.top >= 72 && r.bottom <= vh) return;
  try { out.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }); }
  catch (e) { out.scrollIntoView(); }
}

// A shared link brings its card into view only if the visitor hasn't scrolled or clicked into anything meanwhile.
export function untouched() {
  try {
    const y = window.scrollY || document.documentElement.scrollTop || 0;
    const a = document.activeElement;
    return y < 1 && (!a || a === document.body || a === document.documentElement);
  } catch (e) { return false; }
}

// The Blame button shows a lookup is running (styled in card.css), even when the card is below the fold.
function busy(on) {
  const b = $('paste-submit');
  if (!b) return;
  if (on) b.setAttribute('aria-busy', 'true'); else b.removeAttribute('aria-busy');
}

// A short line right under the paste box (for an entry that isn't an address). '' clears it.
function hint(text) {
  const p = $('paste-hint'), input = $('ca-input');
  if (p) p.textContent = text;
  if (input) { if (text) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid'); }
  return !!p;
}

// scroll: true (the visitor asked: show the card now), false (tabs, Try again: stay put),
// or 'if-untouched' (a shared link: show the card when it's drawn, unless the visitor got busy meanwhile).
export async function lookup(raw, win, { scroll = true } = {}) {
  const out = $('result');
  if (!out) return;
  const entry = typeof raw === 'string' ? raw.trim() : '';
  if (!entry && scroll === true) { focusInput(); return; }  // an empty Blame: just the cursor (a lookup running carries on)
  const my = ++seq;
  const w = parseWindow(win, SETTINGS);
  const address = validateAddress(entry);
  hint('');

  if (!address) {
    // Said right under the box (the card's place may be below the fold), without moving the page.
    shown = { address: null, window: w };
    busy(false);
    setUrl(null, w);
    copies(null);
    report(null);
    const err = toError({ ok: false, code: 'bad-address' });
    if (hint(err.message)) clearCard(out);
    else renderError(out, err, { onAnother: focusInput });
    if (scroll === true) focusInput();
    return;
  }

  shown = { address, window: w };
  setUrl(address, w);
  copies(address);                               // its own card under this one; never holds this one up
  report(address);                               // the launch report: its own card under that, also on its own
  busy(true);
  const view = { coin: address, window: w };
  renderLoading(out, FIRST_STEP, view);
  if (scroll === true) reveal(out);              // show the work starting, not only when it's done

  let res;
  try {
    res = await fetcher(address, w, {
      onProgress: (text) => { if (my === seq && text) renderLoading(out, String(text), view); },
      cancelled: () => my !== seq,               // a newer lookup started: the data layer may stop early
    });
  } catch (e) {
    res = { ok: false, code: 'rpc-failed', detail: String((e && e.message) || e) };
  }
  if (my !== seq) return;                       // the visitor started another lookup meanwhile
  busy(false);

  const again = (w2) => lookup(address, w2, { scroll: false });
  let result = null;
  if (res && res.ok) {
    try { result = buildResult(res, SETTINGS); } catch (e) { result = toError({ ok: false, code: 'rpc-failed' }); }
  } else {
    result = toError(res);
  }

  if (result && result.ok) {
    const off = offHoursOn();
    renderResult(out, result, { onWindow: again, settings: SETTINGS, offHours: off });
    import('./ui/stats.js').then((m) => m.countBlame(address, w)).catch(() => { /* the counter never matters to the card */ });
    if (off) showOffHours(out, res, result, my).catch(() => { /* the card itself is already drawn */ });
  } else {
    renderError(out, result && result.message ? result : toError(result), {
      // "Try again" means a fresh look: drop cached answers (a failed pool search stays cached otherwise).
      onRetry: () => {
        try { clearDataCache(); } catch (e) { /* nothing cached */ }
        lookup(address, w, { scroll: false });
      },
      onAnother: focusInput,
      onWindow: again,
      window: w,
      coin: address,
      settings: SETTINGS,
    });
  }
  if (scroll === true || (scroll === 'if-untouched' && untouched())) reveal(out);
}

// ---- Off-hours mode (settings.features.offHoursMode) -------------------------------------------
// On the owner's own computer only (localhost), ?dev-offhours=1 turns it on for testing.
function offHoursOn() {
  if (SETTINGS.features && SETTINGS.features.offHoursMode === true) return true;
  try {
    const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    return local && new URLSearchParams(location.search).get('dev-offhours') === '1';
  } catch (e) { return false; }
}

// Runs after the card is drawn and never holds it up: a small block under the numbers, or one grey line.
async function showOffHours(out, priceInput, result, my) {
  const W = (SETTINGS.wording && SETTINGS.wording.offHours) || {};
  const live = () => my === seq;
  renderOffHours(out, { state: 'loading', title: W.title, text: W.checking });
  let view = null;
  try {
    const [off, mod] = await Promise.all([
      fetchOffHours(priceInput, { cancelled: () => !live() }),
      import('./features/offhours.js'),
    ]);
    if (!live()) return;
    view = mod.offHoursView(off, result, SETTINGS);
  } catch (e) { view = null; }
  if (!live()) return;
  renderOffHours(out, view && view.ok ? view : { ok: false, text: W.unavailable });
}

// ---- Copy check, "Is this the real one?" (settings.trust) ---------------------------------------
// Its own card in #copies, under the blame card: the same-name launches from our API, each coin's facts read from
// the chain in this browser. It loads on its own and never holds up or breaks
// the blame card: if the API can't be reached it says so in one grey line.
let copySeq = 0;
let copyFor = null;                             // the query on screen (or on its way), so tab switches don't re-ask
const copiesOn = () => !!(SETTINGS.trust && SETTINGS.trust.enabled !== false && SETTINGS.trust.apiBase && $('copies'));

// A ticker: one word (no spaces), not starting with 0x, up to 32 characters, with a letter or number in it.
export function tickerOf(entry) {
  const s = typeof entry === 'string' ? entry.trim() : '';
  if (!s || s.length > 32 || /\s/.test(s) || /^0x/i.test(s)) return null;
  return /[\p{L}\p{N}]/u.test(s) ? s : null;
}

// query: an address or a ticker; null clears the card. reveal: called once the card's place is drawn.
function copies(query, { reveal: show = null } = {}) {
  const out = $('copies');
  if (!out || !copiesOn()) return;
  if (!query) { copySeq++; copyFor = null; out.textContent = ''; return; }
  if (query === copyFor) return;
  const my = ++copySeq;
  copyFor = query;
  const live = () => my === copySeq;
  import('./ui/copycheck-card.js').then(async (card) => {
    if (!live()) return;
    card.renderCopiesLoading(out, SETTINGS);
    if (show) show(out);
    // the list from our API, then each coin's chain facts read here: the rows fill in as they arrive
    const res = await card.loadCopies(query, SETTINGS, { live, onProgress: (p) => {
      if (!live()) return;
      if (typeof p === 'number') card.renderCopiesLoading(out, SETTINGS, p); else card.renderCopies(out, p, SETTINGS);
    } });
    if (res === undefined || !live()) return;
    if (!res || res.ok !== true) copyFor = null;   // the next lookup of the same coin asks again
    card.renderCopies(out, res, SETTINGS);
    if (show) show(out);                         // a ticker search: bring the finished card into view
    if (res && res.ok === true && res.status !== 'reading') countChecked(res, query);
  }).catch(() => {
    if (!live()) return;
    copyFor = null;
    const p = document.createElement('p');
    p.className = 'cc-line';
    p.textContent = (SETTINGS.trust.wording && SETTINGS.trust.wording.unavailable) || 'Copy check unavailable right now.';
    out.textContent = '';
    out.append(p);
  });
}

// The live counter: one "coin checked" per coin (or ticker) per page view, and the copies this check flagged.
function countChecked(res, query) {
  const flagged = (Array.isArray(res.matches) ? res.matches : [])
    .filter((m) => m && !m.isQuery && !m.isOfficial && Array.isArray(m.flags) && m.flags.some((f) => f && f.severity === 'warn')).length;
  const key = String(query || '').toLowerCase();
  import('./ui/stats.js').then((m) => {
    m.countEvent('check', 1, key);
    if (flagged) m.countEvent('flag', flagged, key);
  }).catch(() => { /* the counter never matters to the card */ });
}

// ---- Launch report (settings.trust.report) -------------------------------------------------------
// Its own card in #report, under the copy check: built in this browser from the chain (our API gives the launch row),
// with progress, then the wallet links separately, after the report is on screen. Never holds up or breaks the
// blame card or the copy check: if the API can't be reached it says so in one grey line, with "Try again".
let reportSeq = 0;
let reportFor = null;                           // the coin on screen (or on its way), so tab switches don't re-ask
const reportOn = () => !!(copiesOn() && $('report')
  && !(SETTINGS.trust.report && SETTINGS.trust.report.enabled === false));

function report(address) {
  const out = $('report');
  if (!out || !reportOn()) return;
  if (!address) { reportSeq++; reportFor = null; out.textContent = ''; return; }
  if (address === reportFor) return;
  const my = ++reportSeq;
  reportFor = address;
  const live = () => my === reportSeq;
  import('./ui/report-card.js').then(async (card) => {
    if (!live()) return;
    const res = await card.showReport(out, address, SETTINGS, { live });
    if (live() && (!res || res.ok !== true)) reportFor = null;   // the next lookup of the same coin asks again
    if (live() && res && res.ok === true) import('./ui/stats.js').then((m) => m.countEvent('check', 1, address)).catch(() => {});
  }).catch(() => {
    if (!live()) return;
    reportFor = null;
    const p = document.createElement('p');
    p.className = 'cc-line rc-line';
    const w = SETTINGS.trust.report && SETTINGS.trust.report.wording;
    p.textContent = (w && w.unavailable) || 'Launch report unavailable right now.';
    out.textContent = '';
    out.append(p);
  });
}

// A ticker in the box (or ?q=): the copy check only, no blame card.
function tickerLookup(ticker, { scroll = true } = {}) {
  ++seq;                                        // a blame lookup still running may no longer draw
  shown = { address: null, window: shown.window };
  busy(false);
  hint('');
  const out = $('result');
  if (out) clearCard(out);
  report(null);                                 // a ticker has no launch report (it can match several coins)
  try {
    const u = new URL(location.href);
    u.searchParams.delete('ca');
    u.searchParams.delete('view');
    u.searchParams.set('q', ticker);
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  } catch (e) { /* the card still shows */ }
  copyFor = null;                               // a ticker asked again is asked again
  const show = scroll === true ? reveal
    : scroll === 'if-untouched' ? (o) => { if (untouched()) reveal(o); } : null;   // a shared link: not if they got busy
  copies(ticker, { reveal: show });
}

// Local development only: ?dev-api=http://localhost:8787 points the copy check and the launch report at a Worker
// running on this machine. Honoured only when the page itself is served from this machine (localhost, 127.0.0.1),
// and only for an http://localhost:PORT or http://127.0.0.1:PORT address; ignored everywhere else.
export function devApi(loc = typeof location !== 'undefined' ? location : null, settings = SETTINGS) {
  try {
    if (!loc || !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(String(loc.hostname || ''))) return null;
    const m = /[?&]dev-api=([^&#]*)/.exec(String(loc.search || ''));
    const base = m ? decodeURIComponent(m[1].replace(/\+/g, ' ')).trim().replace(/\/+$/, '') : '';
    if (!/^http:\/\/(localhost|127\.0\.0\.1):\d{2,5}$/.test(base) || !settings.trust) return null;
    settings.trust.apiBase = base;
    return base;
  } catch (e) { return null; }
}

// A section link: ?ca=0x…&view=copies|report (or ?q=TICKER&view=copies) opens on that card instead of the blame card.
// The card fills in bit by bit and the cards above it grow, so it is brought into view when it first appears and
// again each time something above it changes, until the visitor scrolls, touches, clicks or types (then the page
// stays put; the browser's own scroll corrections don't count), or after a minute.
export function viewOf(raw) {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return v === 'copies' || v === 'report' ? v : null;
}
function followSection(id, { ms = 60000 } = {}) {
  const target = $(id);
  if (!target || typeof MutationObserver === 'undefined') return false;
  let first = true, done = false;
  const stop = () => {
    if (done) return;
    done = true;
    try { obs.disconnect(); } catch (e) { /* already stopped */ }
    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((t) => window.removeEventListener(t, stop, true));
  };
  const go = () => {
    if (done || !target.firstElementChild) return;
    if (first && !untouched()) { stop(); return; }   // they were already reading something else
    first = false;
    try { target.scrollIntoView({ behavior: 'auto', block: 'start' }); } catch (e) { target.scrollIntoView(); }
  };
  // One scroll per burst of changes. A timer, not an animation frame, so a link opened in a background tab still lands.
  let timer = null;
  const soon = () => { if (!timer) timer = setTimeout(() => { timer = null; go(); }, 60); };
  const obs = new MutationObserver(soon);
  ['result', 'copies', 'report'].forEach((k) => { const el = $(k); if (el) obs.observe(el, { childList: true, subtree: true }); });
  ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach((t) => window.addEventListener(t, stop, true));
  setTimeout(stop, ms);
  return true;
}

function submitFromInput({ blur = true } = {}) {
  const input = $('ca-input');
  if (!input) return;
  const ticker = validateAddress(input.value) ? null : tickerOf(input.value);
  if (ticker && copiesOn()) {
    if (blur && coarsePointer()) input.blur();
    tickerLookup(ticker, { scroll: true });
    return;
  }
  // Close the phone keyboard so the card can be seen (not when the entry isn't an address: they'll fix it).
  if (blur && coarsePointer() && validateAddress(input.value)) input.blur();
  lookup(input.value, shown.window, { scroll: true });
}

export function boot() {
  devApi();
  // Paste box (delegated, so it works even if the hero is re-drawn)
  document.addEventListener('submit', (e) => {
    if (!e.target || e.target.id !== 'paste-form') return;
    e.preventDefault();
    submitFromInput();
  });
  // Typing again clears the "doesn't look like an address" line.
  document.addEventListener('input', (e) => {
    if (e.target && e.target.id === 'ca-input') hint('');
  });
  // The Stock-Paired Board opens a coin in its own window, in place (no page reload).
  document.addEventListener(OPEN_EVENT, (e) => {
    const d = (e && e.detail) || {};
    if (typeof d.address !== 'string') return;
    const input = $('ca-input');
    if (input) input.value = d.address;
    lookup(d.address, d.window || shown.window, { scroll: true });
  });

  // Pasting a full address runs it straight away.
  document.addEventListener('paste', (e) => {
    const input = $('ca-input');
    if (!input || e.target !== input) return;
    setTimeout(() => {
      const a = validateAddress(input.value);
      if (a && !(a === shown.address && document.querySelector('#result .bts-card'))) submitFromInput();
    }, 0);
  });

  document.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target : null;
    if (!t) return;
    // Example coins fill the box and run.
    const ex = t.closest('.example-coin[data-ca]');
    if (ex) {
      e.preventDefault();
      const input = $('ca-input');
      if (input) input.value = ex.getAttribute('data-ca');
      lookup(ex.getAttribute('data-ca'), shown.window, { scroll: true });
      return;
    }
    // Menu "Paste a coin": go to the paste box.
    if (t.closest('[data-action="paste-a-coin"]')) {
      e.preventDefault();
      focusInput();
    }
  });

  // A shared link: ?ca=0x…&w=24h runs on load. Its card is often below the fold on a laptop, so the page
  // scrolls to it once it's drawn, unless the visitor has scrolled or clicked into something by then.
  const params = new URLSearchParams(location.search);
  const ca = params.get('ca');
  shown.window = parseWindow(params.get('w'), SETTINGS);
  const view = viewOf(params.get('view'));
  if (ca) {
    const input = $('ca-input');
    if (input) input.value = ca.trim();
    const section = view && copiesOn() && (view === 'copies' || reportOn()) && validateAddress(ca) ? view : null;
    const following = section ? followSection(section) : false;
    lookup(ca, shown.window, { scroll: following ? false : 'if-untouched' });
  } else if (tickerOf(params.get('q')) && copiesOn()) {
    const input = $('ca-input');
    if (input) input.value = params.get('q').trim();
    tickerLookup(tickerOf(params.get('q')), { scroll: 'if-untouched' });
  }
}

if (typeof document !== 'undefined') boot();   // (jsc tests import this file without a page, then call boot())
