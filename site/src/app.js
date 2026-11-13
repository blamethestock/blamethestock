// Blame the Stock: the tool. Reads ?ca and ?w, wires the paste box, the example coins and the window tabs,
// asks the data layer for prices, turns them into words (core) and shows the card (ui/card.js).
import { SETTINGS } from '../settings.js';
import { fetchPriceInput, clearDataCache, fetchOffHours } from './data/index.js';
import { buildResult, buildError } from './core/verdict.js';
import { validateAddress, parseWindow } from './core/math.js';
import { renderLoading, renderResult, renderError, focusInput, renderOffHours } from './ui/card.js';

const FIRST_STEP = 'Finding the pool…';

let seq = 0;                                   // every lookup gets a number; only the newest may draw
let shown = { address: null, window: parseWindow(null, SETTINGS) };

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

function setUrl(address, w) {
  try {
    const u = new URL(location.href);
    u.searchParams.set('ca', address);
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

async function lookup(raw, win, { scroll = true } = {}) {
  const out = $('result');
  if (!out) return;
  const my = ++seq;
  const w = parseWindow(win, SETTINGS);
  const address = validateAddress(typeof raw === 'string' ? raw : '');

  if (!address) {
    shown = { address: null, window: w };
    renderError(out, toError({ ok: false, code: 'bad-address' }), { onAnother: focusInput });
    if (scroll) reveal(out);
    return;
  }

  shown = { address, window: w };
  setUrl(address, w);
  const view = { coin: address, window: w };
  renderLoading(out, FIRST_STEP, view);

  let res;
  try {
    res = await fetchPriceInput(address, w, {
      onProgress: (text) => { if (my === seq && text) renderLoading(out, String(text), view); },
    });
  } catch (e) {
    res = { ok: false, code: 'rpc-failed', detail: String((e && e.message) || e) };
  }
  if (my !== seq) return;                       // the visitor started another lookup meanwhile

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
  if (scroll) reveal(out);
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
  if (blur && coarsePointer()) input.blur();   // close the phone keyboard so the card can be seen
  lookup(input.value, shown.window, { scroll: true });
}

function boot() {
  // Paste box (delegated, so it works even if the hero is re-drawn)
  document.addEventListener('submit', (e) => {
    if (!e.target || e.target.id !== 'paste-form') return;
    e.preventDefault();
    submitFromInput();
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

  // A shared link: ?ca=0x…&w=24h runs on load, without scrolling the page.
  const params = new URLSearchParams(location.search);
  const ca = params.get('ca');
  shown.window = parseWindow(params.get('w'), SETTINGS);
  if (ca) {
    const input = $('ca-input');
    if (input) input.value = ca.trim();
    lookup(ca, shown.window, { scroll: false });
  }
}

boot();
