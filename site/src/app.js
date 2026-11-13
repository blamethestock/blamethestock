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
    const err = toError({ ok: false, code: 'bad-address' });
    if (hint(err.message)) clearCard(out);
    else renderError(out, err, { onAnother: focusInput });
    if (scroll === true) focusInput();
    return;
  }

  shown = { address, window: w };
  setUrl(address, w);
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

function submitFromInput({ blur = true } = {}) {
  const input = $('ca-input');
  if (!input) return;
  // Close the phone keyboard so the card can be seen (not when the entry isn't an address: they'll fix it).
  if (blur && coarsePointer() && validateAddress(input.value)) input.blur();
  lookup(input.value, shown.window, { scroll: true });
}

export function boot() {
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
  if (ca) {
    const input = $('ca-input');
    if (input) input.value = ca.trim();
    lookup(ca, shown.window, { scroll: 'if-untouched' });
  }
}

if (typeof document !== 'undefined') boot();   // (jsc tests import this file without a page, then call boot())
