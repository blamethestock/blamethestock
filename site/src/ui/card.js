// Blame the Stock: the result card. Renders a Result, an error or the loading state into #result.
// Builds DOM with textContent only (coin names come from the chain and are never trusted as HTML).
import { SETTINGS } from '../../settings.js';
import { xIntentUrl, copyLink, saveImage, prepareShareImage } from './share.js';

// Button and label words on the card. The sentences themselves come from settings.js (wording).
const LABELS = {
  post: 'Post on X',
  newTab: ' (opens in a new tab)',
  save: 'Save image',
  saving: 'Saving…',
  saveFailed: "Couldn't save",
  copy: 'Copy link',
  copied: 'Copied',
  copyFailed: "Couldn't copy",
  theCoin: 'The coin',
  nothingToSplit: 'Nothing to split.',
  tryAnother: 'Try another coin',
  tryAgain: 'Try again',
  windows: 'Time window',
  loading: 'Looking it up…',
  vs: 'vs',
  proof: 'Check it on the explorer:',
  pool: 'pool',
  curve: 'launch curve',
  startBlock: 'start block',
  endBlock: 'end block',
};

// Proof links: every number on the card comes from these (the coin, its pair, the pool, the window's two blocks).
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const PROOF_ADDR = /^0x[0-9a-f]{40}$/;
function proofRow(result) {
  const p = result.proof || {};
  const coinSym = (result.coin && result.coin.symbol) || 'coin';
  const pairSym = (result.pair && (result.pair.short || result.pair.symbol)) || 'pair';
  const items = [];
  const addr = (a, label, kind) => { if (PROOF_ADDR.test(String(a || ''))) items.push([label, `${EXPLORER}/${kind}/${a}`]); };
  const blk = (n, label) => { if (Number.isInteger(n) && n > 0) items.push([label, `${EXPLORER}/block/${n}`]); };
  addr(p.coin, coinSym, 'token');
  addr(p.pair, pairSym, 'token');
  addr(p.pool, p.onCurve ? LABELS.curve : LABELS.pool, 'address');
  blk(p.startBlock, LABELS.startBlock);
  blk(p.endBlock, LABELS.endBlock);
  if (!items.length) return null;
  const row = h('p', { class: 'bts-proof' }, LABELS.proof);
  items.forEach(([label, url]) => row.append(' ', h('a', {
    href: url, target: '_blank', rel: 'noopener noreferrer', class: 'bts-proof-link',
  }, label + ' ↗', h('span', { class: 'bts-sr', text: LABELS.newTab }))));
  return row;
}

const COUNT_MS = 900;          // headline number counts up
const BAR_MS = 700;            // split bar slides from the middle (timing lives in card.css)
const RETRY_CODES = ['rpc-failed', 'stale', 'search-failed'];   // worth a second try: "Try again" + the window tabs
const WINDOW_CODES = ['pair-too-new'];

let uid = 0;
const running = new WeakMap(); // el -> cancel function for its animations

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
};
const coarsePointer = () => {
  try { return window.matchMedia('(pointer: coarse)').matches; } catch (e) { return false; }
};

// Tiny element helper: h('p', { class: 'x', text: 'hi' }, child, 'more text')
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
  for (const kid of kids.flat()) if (kid != null && kid !== false && kid !== '') el.append(kid);
  return el;
}

function prepare(el) {
  if (!el.hasAttribute('aria-live')) el.setAttribute('aria-live', 'polite');
  const stop = running.get(el);
  if (stop) { stop(); running.delete(el); }
}

function currentCard(el) {
  const c = el.firstElementChild;
  return c && c.classList.contains('bts-card') ? c : null;
}

const shortAddr = (a) => (typeof a === 'string' && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a || '');

// ---- Keyboard focus across re-renders ---------------------------------------------------------
// A new card replaces the old one, and with it the button that had focus ("Try again", a tab…). Without help
// the focus drops to the page and the next Tab starts again at the top. focusIn() notes where it was before
// the swap ('tab', 'other', or null when it wasn't in the card); refocus() puts it back on the new card:
// the selected tab when it was on a tab, else the first button, else the card itself.
function focusIn(card) {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (!card || !a || !card.contains(a)) return null;
  return a.getAttribute && a.getAttribute('role') === 'tab' ? 'tab' : 'other';
}
function refocus(card, was) {
  if (!was || !card) return;
  const tab = card.querySelector('[role="tab"][aria-selected="true"]');
  const btn = card.querySelector('.bts-btn:not([aria-disabled="true"])');
  const target = (was === 'tab' && tab) || btn || tab || card;
  try { target.focus({ preventScroll: true }); } catch (e) { target.focus(); }
}

// ---- Window tabs ------------------------------------------------------------------------------
function windowTabs(id, current, onWindow, settings) {
  const wins = (settings && Array.isArray(settings.windows) && settings.windows.length)
    ? settings.windows : ['1h', '6h', '24h', '7d'];
  const list = h('div', { class: 'bts-tabs', role: 'tablist', 'aria-label': LABELS.windows });
  for (const w of wins) {
    const on = w === current;
    const tab = h('button', {
      type: 'button', class: 'bts-tab', role: 'tab', id: `${id}-tab-${w}`, 'data-window': w,
      'aria-selected': String(on), 'aria-controls': `${id}-panel`, tabindex: on ? '0' : '-1', text: w,
    });
    tab.addEventListener('click', () => {
      if (tab.getAttribute('aria-selected') === 'true') return;
      selectTab(list, w);
      if (typeof onWindow === 'function') onWindow(w);
    });
    list.append(tab);
  }
  // Arrow keys move between tabs (roving focus); Enter or Space picks one.
  list.addEventListener('keydown', (e) => {
    const tabs = [...list.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j === null) return;
    e.preventDefault();
    tabs.forEach((t, k) => t.setAttribute('tabindex', k === j ? '0' : '-1'));
    tabs[j].focus();
  });
  return list;
}

function selectTab(list, w) {
  for (const t of list.querySelectorAll('[role="tab"]')) {
    const on = t.dataset.window === w;
    t.setAttribute('aria-selected', String(on));
    t.setAttribute('tabindex', on ? '0' : '-1');
  }
}

function topRow(id, label, windowName, onWindow, settings) {
  return h('header', { class: 'bts-top' },
    h('p', { class: 'bts-pairline' }, label),
    windowTabs(id, windowName, onWindow, settings));
}

function pairLabel(coin, pair) {
  return [coin, h('span', { class: 'bts-vs', text: ` ${LABELS.vs} ` }), pair];
}

// ---- Verdict with the counting number ---------------------------------------------------------
// Finds the first percentage in the lead ("You're down 12%.") so it can count up from 0.
const NUM_RE = /([+−-]?)(\d[\d,]*(?:\.\d+)?)%/;

function verdict(id, result) {
  const lead = String(result.lead || '');
  const blame = String(result.blame || '');
  const full = String(result.verdict || [lead, blame].filter(Boolean).join(' '));
  const shown = h('span', { 'aria-hidden': 'true' });
  const m = lead.match(NUM_RE);
  let count = null;
  if (m) {
    // Keep the number glued to the punctuation around it ("(−0.3%)." never breaks inside).
    const before = lead.slice(0, m.index), after = lead.slice(m.index + m[0].length);
    const pre = before.match(/\S*$/)[0], post = after.match(/^\S*/)[0];
    count = h('span', { class: 'bts-count', text: m[0] });
    shown.append(h('span', { class: 'bts-lead' },
      before.slice(0, before.length - pre.length),
      h('span', { class: 'bts-nobr' }, pre, count, post),
      after.slice(post.length)));
  } else {
    shown.append(h('span', { class: 'bts-lead', text: lead }));
  }
  if (blame) shown.append(' ', h('span', { class: 'bts-blame', text: blame }));
  const el = h('h2', { class: 'bts-verdict', id: `${id}-verdict` }, h('span', { class: 'bts-sr', text: full }), shown);
  return { el, count, match: m };
}

function groupDigits(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

function countUp(span, m, track) {
  if (!span || !m || reducedMotion()) return;
  const sign = m[1];
  const digits = m[2];
  const decimals = (digits.split('.')[1] || '').length;
  const target = parseFloat(digits.replace(/,/g, ''));
  if (!(target > 0)) return;
  const grouped = digits.includes(',');
  const final = m[0];
  const fmt = (v0) => {
    const v = Math.max(0, v0);   // never a stray "-" while counting
    const s = decimals ? v.toFixed(decimals) : (grouped ? groupDigits(Math.round(v)) : String(Math.round(v)));
    return (parseFloat(s.replace(/,/g, '')) === 0 ? '' : sign) + s + '%';
  };
  // Reserve the final width so the line doesn't reflow while counting.
  const w = span.getBoundingClientRect().width;
  if (w > 0) span.style.minWidth = `${Math.ceil(w)}px`;
  span.textContent = fmt(0);
  const t0 = performance.now();
  let raf = 0;
  const done = () => { cancelAnimationFrame(raf); clearTimeout(safety); span.textContent = final; };
  const tick = (now) => {
    if (!span.isConnected) return;
    // The first frame's timestamp can be a little earlier than t0; clamp so the count never runs below 0.
    const t = Math.min(1, Math.max(0, (now - t0) / COUNT_MS));
    const eased = 1 - Math.pow(1 - t, 3);
    if (t < 1) { span.textContent = fmt(target * eased); raf = requestAnimationFrame(tick); } else done();
  };
  // If frames are held back (background tab, hidden window), still end on the real number.
  const safety = setTimeout(done, COUNT_MS + 400);
  raf = requestAnimationFrame(tick);
  track(done);
}

// ---- Split bar --------------------------------------------------------------------------------
function splitBar(result) {
  const wrap = h('div', { class: 'bts-split' });
  const b = result.bar;
  if (!b || !Number.isFinite(b.pair)) {
    wrap.append(h('div', { class: 'bts-bar is-flat', 'aria-hidden': 'true' }),
      h('p', { class: 'bts-nothing', text: LABELS.nothingToSplit }));
    return { wrap, bar: null };
  }
  const pairPct = Math.round(Math.min(1, Math.max(0, b.pair)) * 100);
  const coinPct = 100 - pairPct;
  const pairName = (result.pair && (result.pair.short || result.pair.symbol)) || '';
  const bar = h('div', {
    class: 'bts-bar', role: 'img',
    'aria-label': `${pairName} ${pairPct}%, ${LABELS.theCoin.toLowerCase()} ${coinPct}%`,
  }, h('span', { class: 'bts-seg bts-seg-pair' }), h('span', { class: 'bts-seg bts-seg-coin' }));
  bar.dataset.pair = String(pairPct);
  bar.dataset.coin = String(coinPct);
  const legend = h('ul', { class: 'bts-legend', 'aria-hidden': 'true' },
    h('li', { class: 'bts-key' }, h('i', { class: 'bts-dot bts-dot-pair' }),
      h('span', { class: 'bts-key-name', text: pairName }), h('b', { text: `${pairPct}%` })),
    h('li', { class: 'bts-key' }, h('i', { class: 'bts-dot bts-dot-coin' }),
      h('span', { class: 'bts-key-name', text: LABELS.theCoin }), h('b', { text: `${coinPct}%` })));
  wrap.append(bar, legend);
  return { wrap, bar };
}

function slideBar(bar, track) {
  if (!bar) return;
  const [segPair, segCoin] = bar.children;
  const p = Number(bar.dataset.pair), c = Number(bar.dataset.coin);
  const finish = () => {
    segPair.style.flexGrow = String(p);
    segCoin.style.flexGrow = String(c);
    bar.classList.toggle('is-whole', p === 0 || c === 0);
  };
  if (reducedMotion()) { finish(); return; }
  // Start as one bar split at the middle, then slide to the real split.
  segPair.style.flexGrow = '50';
  segCoin.style.flexGrow = '50';
  let r1 = 0, r2 = 0;
  const stop = () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); clearTimeout(safety); finish(); };
  r1 = requestAnimationFrame(() => {
    void bar.offsetWidth;
    r2 = requestAnimationFrame(stop);
  });
  // Frames held back (background tab): still end on the real split.
  const safety = setTimeout(stop, 400);
  track(stop);
}

// ---- Buttons ----------------------------------------------------------------------------------
// Swap a button's words for a moment (width held so the row doesn't jump). ms = 0 keeps them.
function flash(btn, text, ms = 1600) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  if (!btn.style.minWidth) btn.style.minWidth = `${Math.ceil(btn.getBoundingClientRect().width)}px`;
  btn.textContent = text;
  clearTimeout(btn._btsTimer);
  if (ms > 0) btn._btsTimer = setTimeout(() => restore(btn), ms);
}
function restore(btn) {
  clearTimeout(btn._btsTimer);
  if (btn.dataset.label) btn.textContent = btn.dataset.label;
  btn.style.minWidth = '';
}

function actions(result, settings) {
  const post = h('a', {
    class: 'bts-btn is-primary', href: xIntentUrl(result), target: '_blank', rel: 'noopener noreferrer',
  }, LABELS.post, h('span', { class: 'bts-sr', text: LABELS.newTab }));
  const save = h('button', { type: 'button', class: 'bts-btn', 'data-action': 'save-image', text: LABELS.save });
  const copy = h('button', { type: 'button', class: 'bts-btn', 'data-action': 'copy-link', text: LABELS.copy });

  save.addEventListener('click', async () => {
    if (save.getAttribute('aria-busy') === 'true') return;
    save.setAttribute('aria-busy', 'true');
    flash(save, LABELS.saving, 0);
    let ok = false;
    try { ok = await saveImage(result, settings); } catch (e) { ok = false; }
    save.removeAttribute('aria-busy');
    if (ok === false) flash(save, LABELS.saveFailed, 2200);
    else restore(save);   // saved, or the share sheet was closed
  });
  copy.addEventListener('click', async () => {
    let ok = false;
    try { ok = await copyLink(result); } catch (e) { ok = false; }
    flash(copy, ok ? LABELS.copied : LABELS.copyFailed, ok ? 1600 : 2200);
    if (!copy.isConnected) return;
    if (document.activeElement !== copy && document.activeElement === document.body) copy.focus();
  });
  return h('footer', { class: 'bts-actions' }, post, save, copy);
}

// ---- Public: result ---------------------------------------------------------------------------
// renderResult(el, result, { onWindow, settings, enter })
export function renderResult(el, result, opts = {}) {
  if (!el || !result) return null;
  const settings = opts.settings || SETTINGS;
  const before = currentCard(el);
  const sameCoin = before && before.dataset.coin && result.coin && before.dataset.coin === result.coin.address;
  const hadFocus = focusIn(before);
  prepare(el);

  const id = `bts${++uid}`;
  const stops = [];
  const track = (fn) => stops.push(fn);

  const coinSym = (result.coin && result.coin.symbol) || shortAddr(result.coin && result.coin.address);
  const pairSym = (result.pair && (result.pair.short || result.pair.symbol)) || '';
  const top = topRow(id, pairLabel(coinSym, pairSym), result.window, opts.onWindow, settings);

  const v = verdict(id, result);
  const split = splitBar(result);
  const body = h('div', {
    class: 'bts-body', id: `${id}-panel`, role: 'tabpanel', 'aria-labelledby': `${id}-tab-${result.window}`,
  }, v.el);
  if (result.subline) body.append(h('p', { class: 'bts-subline', text: result.subline }));
  body.append(split.wrap);

  const nums = Array.isArray(result.numbers) ? result.numbers : [];
  if (nums.length) {
    body.append(h('dl', { class: 'bts-numbers' }, nums.map((n) =>
      h('div', { class: 'bts-num', 'data-key': n.key },
        h('dt', { text: n.label }),
        h('dd', null, h('span', { class: 'bts-arrow', 'aria-hidden': 'true', text: n.arrow || '' }), n.text)))));
  }
  // Off-hours mode: an empty slot under the numbers, filled later by renderOffHours().
  if (opts.offHours) body.append(h('section', { class: 'bts-off', hidden: true }));
  const notes = (result.notes || []).filter(Boolean);
  const warnings = (result.warnings || []).filter(Boolean);
  if (notes.length) body.append(h('ul', { class: 'bts-notes' }, notes.map((t) => h('li', { text: t }))));
  if (warnings.length) body.append(h('ul', { class: 'bts-warnings' }, warnings.map((t) => h('li', { text: t }))));
  if (result.asOfText) body.append(h('p', { class: 'bts-asof', text: result.asOfText }));
  const proof = proofRow(result);
  if (proof) body.append(proof);

  const card = h('article', {
    class: 'bts-card', 'data-state': 'result', 'data-case': result.caseName, 'data-kind': result.pair && result.pair.kind,
    'data-coin': result.coin && result.coin.address, 'data-window': result.window, 'aria-labelledby': `${id}-verdict`,
  }, top, body, actions(result, settings));
  if (opts.enter !== false && !sameCoin && !reducedMotion()) card.classList.add('is-entering');

  el.replaceChildren(card);
  countUp(v.count, v.match, track);
  slideBar(split.bar, track);
  running.set(el, () => stops.forEach((fn) => fn()));

  refocus(card, hadFocus && 'tab');      // a result always has tabs: focus goes back to the selected one
  // On phones the share sheet needs the picture ready the moment "Save image" is tapped.
  if (opts.prepareImage !== false && coarsePointer()) {
    setTimeout(() => { if (card.isConnected) prepareShareImage(result, settings); }, COUNT_MS + BAR_MS);
  }
  return card;
}

// ---- Public: off-hours block (settings.features.offHoursMode) -----------------------------------
// renderOffHours(el, view): fills the slot that renderResult(..., { offHours: true }) left under the numbers.
//   { state: 'loading', title, text }   'Checking market hours…'
//   { ok: true, title, sentence, line, segments, legend, aria, startText, endText }   (features/offhours.js)
//   { ok: false, text }                 one grey line; no text = the block stays hidden
// Touches nothing else on the card. Returns the slot, or null when this card has none.
export function renderOffHours(el, view) {
  const card = el && el.classList && el.classList.contains('bts-card') ? el : el ? currentCard(el) : null;
  const slot = card && card.dataset.state === 'result' ? card.querySelector('.bts-off') : null;
  if (!slot) return null;
  const v = view || {};
  const title = () => h('p', { class: 'bts-off-title', text: v.title || 'Off-hours' });
  slot.removeAttribute('aria-busy');
  slot.classList.remove('is-in');
  if (v.state === 'loading') {
    slot.dataset.state = 'loading';
    slot.setAttribute('aria-busy', 'true');
    slot.replaceChildren(title(), h('p', { class: 'bts-off-progress', text: v.text || '' }));
  } else if (!v.ok) {
    slot.dataset.state = 'error';
    slot.replaceChildren(...(v.text ? [h('p', { class: 'bts-off-note', text: v.text })] : []));
    if (!v.text) { slot.hidden = true; return slot; }
  } else {
    slot.dataset.state = 'ready';
    const segs = (v.segments || []).map((s) => h('span', {
      class: 'bts-off-seg ' + (s.open ? 'is-open' : 'is-closed'),
      style: `flex-grow:${Math.max(0, Number(s.share) || 0)}`,
    }));
    slot.replaceChildren(...[
      title(),
      h('p', { class: 'bts-off-sentence', text: v.sentence || '' }),
      v.line ? h('p', { class: 'bts-off-line', text: v.line }) : null,
      h('div', { class: 'bts-off-bar', role: 'img', 'aria-label': v.aria || '' }, segs),
      h('div', { class: 'bts-off-ends', 'aria-hidden': 'true' }, h('span', { text: v.startText || '' }), h('span', { text: v.endText || '' })),
      h('ul', { class: 'bts-off-legend' }, (v.legend || []).map((k) => h('li', null,
        h('i', { class: 'bts-off-dot ' + (k.open ? 'is-open' : 'is-closed'), 'aria-hidden': 'true' }),
        h('span', { text: k.label || '' }), ' ', h('b', { text: k.time || '' })))),
    ].filter(Boolean));   // replaceChildren() would write a null out as the word "null"
    if (!reducedMotion()) slot.classList.add('is-in');
  }
  slot.hidden = false;
  return slot;
}

// ---- Public: loading --------------------------------------------------------------------------
// renderLoading(el, text, { coin, window, onWindow, settings })
// Same coin already on screen + a new window: keeps the top row and tabs, swaps the body for a skeleton.
export function renderLoading(el, text, opts = {}) {
  if (!el) return null;
  const msg = text || LABELS.loading;
  const cur = currentCard(el);
  const state = cur && cur.dataset.state;

  if (cur && (state === 'loading' || state === 'refreshing')
      && (!opts.coin || cur.dataset.coin === opts.coin)
      && (!opts.window || cur.dataset.window === opts.window)) {
    const p = cur.querySelector('.bts-progress');
    if (p && p.textContent !== msg) p.textContent = msg;
    return cur;
  }
  prepare(el);
  const hadFocus = focusIn(cur);

  const tabs = cur && cur.querySelector('[role="tablist"]');
  if (cur && tabs && opts.coin && cur.dataset.coin === opts.coin && opts.window) {
    selectTab(tabs, opts.window);
    const body = cur.querySelector('.bts-body');
    const fresh = skeletonBody(msg);
    if (body) {
      fresh.id = body.id;
      fresh.setAttribute('role', 'tabpanel');
      const sel = tabs.querySelector('[aria-selected="true"]');
      if (sel) fresh.setAttribute('aria-labelledby', sel.id);
      body.replaceWith(fresh);
    }
    cur.dataset.state = 'refreshing';
    cur.dataset.window = opts.window;
    cur.classList.remove('is-entering');
    const act = cur.querySelector('.bts-actions');
    if (act && state === 'error') act.remove();   // "Try another coin" makes no sense mid-lookup
    else if (act) {
      for (const a of act.querySelectorAll('a, button')) {
        a.setAttribute('aria-disabled', 'true');
        a.setAttribute('tabindex', '-1');
      }
    }
    refocus(cur, hadFocus);
    return cur;
  }

  const card = h('article', {
    class: 'bts-card', 'data-state': 'loading', 'data-coin': opts.coin || '', 'data-window': opts.window || '',
    'aria-label': msg, tabindex: '-1',   // can hold keyboard focus while it has no buttons
  },
  h('div', { class: 'bts-top', 'aria-hidden': 'true' },
    h('span', { class: 'bts-skel bts-skel-tag' }), h('span', { class: 'bts-skel bts-skel-tabs' })),
  skeletonBody(msg));
  if (!cur && !reducedMotion()) card.classList.add('is-entering');
  el.replaceChildren(card);
  refocus(card, hadFocus);
  return card;
}

function skeletonBody(msg) {
  return h('div', { class: 'bts-body is-loading', 'aria-busy': 'true' },
    h('span', { class: 'bts-skel bts-skel-line', style: 'width:78%', 'aria-hidden': 'true' }),
    h('span', { class: 'bts-skel bts-skel-line', style: 'width:52%', 'aria-hidden': 'true' }),
    h('span', { class: 'bts-skel bts-skel-bar', 'aria-hidden': 'true' }),
    h('div', { class: 'bts-skel-nums', 'aria-hidden': 'true' },
      h('span', { class: 'bts-skel' }), h('span', { class: 'bts-skel' }), h('span', { class: 'bts-skel' })),
    h('p', { class: 'bts-progress', text: msg }));
}

// ---- Public: error ----------------------------------------------------------------------------
// renderError(el, { code, message }, { onRetry, onAnother, onWindow, window, coin, settings })
export function renderError(el, err, opts = {}) {
  if (!el) return null;
  const settings = opts.settings || SETTINGS;
  const e = err || {};
  const message = e.message
    || (settings.wording && settings.wording.errors && settings.wording.errors[e.code])
    || SETTINGS.wording.errors['rpc-failed'];
  const cur = currentCard(el);
  const hadFocus = focusIn(cur);
  prepare(el);

  const id = `bts${++uid}`;
  const parts = [];
  // Tabs stay on errors where another window (or the same one, a moment later) can still work.
  const showTabs = (WINDOW_CODES.includes(e.code) || RETRY_CODES.includes(e.code))
    && typeof opts.onWindow === 'function' && opts.window;
  if (showTabs) {
    const who = e.symbol ? e.symbol : h('span', { class: 'bts-addr', text: shortAddr(opts.coin) });
    parts.push(topRow(id, who, opts.window, opts.onWindow, settings));
  }

  const body = h('div', { class: 'bts-body' }, h('p', { class: 'bts-error', id: `${id}-msg`, text: message }));
  if (showTabs) {
    body.id = `${id}-panel`;
    body.setAttribute('role', 'tabpanel');
    body.setAttribute('aria-labelledby', `${id}-tab-${opts.window}`);
  }
  parts.push(body);

  const buttons = [];
  if (RETRY_CODES.includes(e.code) && typeof opts.onRetry === 'function') {
    buttons.push(h('button', { type: 'button', class: 'bts-btn is-primary', text: LABELS.tryAgain, onclick: () => opts.onRetry() }));
  }
  buttons.push(h('button', {
    type: 'button', class: buttons.length ? 'bts-btn' : 'bts-btn is-primary', text: LABELS.tryAnother,
    onclick: () => (typeof opts.onAnother === 'function' ? opts.onAnother() : focusInput()),
  }));
  parts.push(h('footer', { class: 'bts-actions' }, buttons));

  const card = h('article', {
    class: 'bts-card', 'data-state': 'error', 'data-code': e.code || '', 'data-coin': opts.coin || '',
    'data-window': opts.window || '', 'aria-labelledby': `${id}-msg`,
  }, parts);
  if (!cur && !reducedMotion()) card.classList.add('is-entering');
  el.replaceChildren(card);
  refocus(card, hadFocus);
  return card;
}

// ---- Public: empty the slot (an entry that isn't an address says so under the paste box instead) ----
export function clearCard(el) {
  if (!el) return;
  prepare(el);
  el.replaceChildren();
}

// Puts the cursor back in the paste box (used by "Try another coin", the menu and an empty "Blame").
// The page only scrolls when the box isn't already on screen.
export function focusInput() {
  const input = document.getElementById('ca-input');
  if (!input) return;
  if (!onScreen(input)) {
    try {
      input.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    } catch (e) { /* old browsers */ }
  }
  try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
  try { input.select(); } catch (e) { /* not selectable */ }
}

// Fully visible, below the floating menu (~72px).
function onScreen(node) {
  try {
    const r = node.getBoundingClientRect();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    return r.top >= 72 && r.bottom <= vh;
  } catch (e) { return false; }
}
