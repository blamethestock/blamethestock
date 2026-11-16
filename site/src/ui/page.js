// Fills every section of the page from settings.js, loads the chosen font, and starts the motion.
// The result card (#result) is filled by src/app.js, not here.
import { SETTINGS } from '../../settings.js';
import { initMotion, prefersReducedMotion } from './motion.js';

const S = SETTINGS || {};

const FONTS = {
  archivo: {
    family: 'Archivo',
    href: 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&display=swap',
  },
  robotoflex: {
    family: 'Roboto Flex',
    href: 'https://fonts.googleapis.com/css2?family=Roboto+Flex:opsz,wdth,wght@8..144,25..151,100..1000&display=swap',
  },
};
const FALLBACK_FONTS = "'Arial Narrow', 'Helvetica Neue', Arial, sans-serif";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const byId = (id) => document.getElementById(id);
const text = (v) => (typeof v === 'string' ? v.trim() : '');

// Tiny element helper: h('a', { class: 'x', href }, 'label', child, …)
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) el.append(child);
  }
  return el;
}

function siteName() {
  return text(S.site && S.site.name) || 'Blame the Stock';
}

// Accepts "name", "@name" or a pasted profile link ("https://x.com/name"); anything else hides the link.
function xUrl() {
  const handle = text(S.xHandle)
    .replace(/^(?:https?:\/\/)?(?:www\.|mobile\.)?(?:x|twitter)\.com\//i, '')
    .replace(/^@+/, '')
    .replace(/[/?#].*$/, '');
  return /^[A-Za-z0-9_]{1,15}$/.test(handle) ? `https://x.com/${handle}` : '';
}

// ---- font: only the family chosen in settings.js is downloaded ----
export function loadFont(choice = S.font) {
  const key = FONTS[text(choice).toLowerCase()] ? text(choice).toLowerCase() : 'archivo';
  const font = FONTS[key];
  const root = document.documentElement;
  root.dataset.font = key;
  root.style.setProperty('--font', `'${font.family}', ${FALLBACK_FONTS}`);

  const preconnects = [['https://fonts.googleapis.com', false], ['https://fonts.gstatic.com', true]];
  for (const [href, cross] of preconnects) {
    if (!document.querySelector(`link[rel="preconnect"][href="${href}"]`)) {
      document.head.append(h('link', { rel: 'preconnect', href, crossorigin: cross ? '' : null }));
    }
  }
  let css = document.querySelector(`link[rel="stylesheet"][href="${font.href}"]`);
  const fresh = !css;
  if (fresh) css = h('link', { rel: 'stylesheet', href: font.href });
  const cssLoaded = new Promise((resolve) => {
    if (!fresh && css.sheet) return resolve();
    css.addEventListener('load', () => resolve(), { once: true });
    css.addEventListener('error', () => resolve(), { once: true });
  });
  if (fresh) document.head.append(css);
  const ready = cssLoaded
    .then(() => (document.fonts
      ? Promise.all([
        document.fonts.load(`900 100px "${font.family}"`),
        document.fonts.load(`400 16px "${font.family}"`),
      ])
      : null))
    .catch(() => null);
  return { family: font.family, ready };
}

// ---- 1. menu ----
function fillMenu() {
  const mark = byId('menu-wordmark');
  if (mark) {
    mark.textContent = siteName().toUpperCase();
    mark.setAttribute('aria-label', `${siteName()}, back to top`);
  }
  const x = xUrl();
  for (const id of ['menu-x', 'footer-x']) {
    const link = byId(id);
    if (!link) continue;
    if (x) {
      link.href = x;
      link.hidden = false;
      link.setAttribute('aria-label', `${siteName()} on X`);
    } else {
      link.hidden = true;
      link.removeAttribute('href');
    }
  }
}

// ---- 2. hero ----
function fillHero() {
  const headline = byId('headline');
  if (headline) {
    let lines = [S.headline && S.headline.line1, S.headline && S.headline.line2].map(text).filter(Boolean);
    if (!lines.length) lines = [siteName()];
    const parts = [];
    lines.forEach((line, i) => {
      if (i) parts.push(' ');
      parts.push(h('span', { class: 'line', style: `--i:${i}` },
        h('span', { class: 'line-box' },
          h('span', { class: 'line-text' }, line),
          h('span', { class: 'line-wipe', 'aria-hidden': 'true' }))));
    });
    headline.replaceChildren(...parts);
  }

  const examples = byId('examples');
  if (examples) {
    examples.querySelectorAll('.example-coin').forEach((b) => b.remove());
    const list = Array.isArray(S.examples) ? S.examples : [];
    let count = 0;
    for (const ex of list) {
      const address = text(ex && ex.address);
      if (!ADDRESS.test(address)) continue;
      const label = text(ex.label) || `${address.slice(0, 6)}…${address.slice(-4)}`;
      examples.append(h('button', {
        type: 'button',
        class: 'example-coin',
        'data-ca': address,
        'aria-label': `Try ${label}`,
      }, label));
      count++;
    }
    examples.hidden = count === 0;
  }
}

// ---- 5. giant sliding line ----
function fillMarquee() {
  const section = byId('marquee');
  const line = byId('marquee-line');
  if (!section || !line) return;
  let words = typeof S.marquee === 'string' ? S.marquee : '';
  if (!words.trim()) {
    section.hidden = true;
    return;
  }
  if (!/\s$/.test(words)) words += '  ';
  const copies = [];
  for (let i = 0; i < 3; i++) {
    const copy = h('span', { class: 'marquee-copy' });
    words.split('·').forEach((part, j, all) => {
      copy.append(part);
      if (j < all.length - 1) copy.append(h('span', { class: 'marquee-dot' }, '·'));
    });
    copies.push(copy);
  }
  line.replaceChildren(...copies);
}

// ---- 6. token ----
async function copyText(value) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch (e) { /* fall through */ }
  try {
    const area = h('textarea', { readonly: true, style: 'position:fixed;top:0;left:0;opacity:0' });
    area.value = value;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch (e) {
    return false;
  }
}

function copyButton(value, what) {
  const button = h('button', { type: 'button', class: 'token-copy', 'aria-label': `Copy ${what}` }, 'Copy');
  let timer = 0;
  button.addEventListener('click', async () => {
    const ok = await copyText(value);
    button.textContent = ok ? 'Copied' : 'Copy failed';
    clearTimeout(timer);
    timer = setTimeout(() => { button.textContent = 'Copy'; }, 1600);
  });
  return button;
}

function tokenRow(label, ...value) {
  return h('div', { class: 'token-row' }, h('dt', {}, label), h('dd', {}, ...value));
}

function fillToken() {
  const t = S.token || {};
  const ticker = text(t.ticker) || '$BLAME';
  const tickerEl = byId('token-ticker');
  if (tickerEl) tickerEl.textContent = ticker;

  const body = byId('token-body');
  if (body) {
    const contract = text(t.contractAddress);
    // Only ever show an address when the switch is on AND the address is well-formed.
    const live = t.launched === true && ADDRESS.test(contract);
    if (!live) {
      body.replaceChildren(h('p', { class: 'token-status' },
        h('strong', {}, 'Not live yet.'), ` Any address claiming to be ${ticker} is not ours.`));
    } else {
      const rows = [tokenRow('Contract', h('code', { class: 'token-addr' }, contract), copyButton(contract, 'contract address'))];
      const pons = text(t.ponsUrl);
      if (/^https:\/\/[^\s"'<>]+$/i.test(pons)) {
        rows.push(tokenRow('Pons', h('a', { class: 'token-link', href: pons, target: '_blank', rel: 'noopener noreferrer' }, `${ticker} on Pons`)));
      }
      const dev = text(t.devWallet);
      if (ADDRESS.test(dev)) rows.push(tokenRow('Dev wallet', h('code', { class: 'token-addr' }, dev), copyButton(dev, 'dev wallet address')));
      const buy = text(t.devBuy);
      if (buy) rows.push(tokenRow('Dev buy', h('span', {}, buy)));
      body.replaceChildren(
        h('p', { class: 'token-status' }, h('strong', {}, `This is the only ${ticker}.`), ' Any other address is not ours.'),
        h('dl', { class: 'token-rows' }, rows),
      );
    }
  }
  const free = byId('token-free');
  if (free) free.textContent = `The tool is free. You never need to hold ${ticker}.`;
}

// ---- 7. update log ----
function niceDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value));
  if (!m) return text(value);
  try {
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
      .toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  } catch (e) {
    return text(value);
  }
}

function fillUpdates() {
  const section = byId('updates');
  const list = byId('updates-list');
  if (!section || !list) return;
  const launched = !!(S.token && S.token.launched === true);
  // Entries marked whenLaunched stay hidden until token.launched is switched on.
  const items = (Array.isArray(S.updates) ? S.updates : [])
    .filter((u) => u && text(u.text) && (u.whenLaunched !== true || launched));
  section.hidden = items.length === 0;
  list.replaceChildren(...items.map((u) => h('li', {},
    h('time', { datetime: /^\d{4}-\d{2}-\d{2}$/.test(text(u.date)) ? text(u.date) : null }, niceDate(u.date)),
    h('p', {}, text(u.text)))));
}

// ---- 8. footer ----
function fillFooter() {
  const mark = byId('footer-mark');
  if (mark) mark.textContent = siteName().toUpperCase();
  const name = byId('footer-name');
  if (name) {
    let host = '';
    try { host = new URL(text(S.site && S.site.url)).host; } catch (e) { /* no url */ }
    name.textContent = host || siteName();
  }
}

// ---- "Paste a coin": bring the paste box into view and put the cursor in it ----
// src/app.js owns this button. This is only a fallback for when app.js did not load:
// it listens on window (after app.js's document listener) and stands down if app.js handled the click.
function wirePasteButtons() {
  window.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const trigger = e.target instanceof Element ? e.target.closest('[data-action="paste-a-coin"]') : null;
    if (!trigger) return;
    e.preventDefault();
    const form = byId('paste-form');
    const input = byId('ca-input');
    if (!form || !input) return;
    form.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    try {
      input.focus({ preventScroll: true });
    } catch (err) {
      input.focus();
    }
  });
}

// ---- 4b. Stock-Paired Board: its code loads only when the switch in settings.js is on ----
// (On localhost only, ?dev-board=1 shows it with the switch off, for checking before launch.)
function startBoard() {
  const section = byId('board');
  if (!section) return;
  let on = !!(S.features && S.features.stockBoard === true);
  try {
    if (!on && /^(localhost|127\.0\.0\.1)$/.test(location.hostname)) {
      on = new URLSearchParams(location.search).get('dev-board') === '1';
    }
  } catch (e) { /* no flag */ }
  if (!on) return;
  section.hidden = false;                 // shown now so the page below it doesn't jump later
  // Its stylesheet too is fetched only when the board is on (nothing extra loads while the switch is off).
  const css = h('link', { rel: 'stylesheet', href: new URL('../features/board.css', import.meta.url).href });
  const cssReady = new Promise((resolve) => {
    css.addEventListener('load', resolve, { once: true });
    css.addEventListener('error', resolve, { once: true });
  });
  document.head.append(css);
  // The board's code (and its coin list) loads once the page has settled; its prices load near the section.
  const later = window.requestIdleCallback || ((fn) => setTimeout(fn, 300));
  later(() => {
    Promise.all([import('../features/board.js'), cssReady])
      .then(([m]) => m.initBoard(section))
      .catch((e) => {
        section.hidden = true;
        console.error('[board]', e);
      });
  }, { timeout: 2000 });
}

function safely(step) {
  try {
    step();
  } catch (e) {
    console.error('[page]', e);
  }
}

function boot() {
  let font = { ready: Promise.resolve() };
  safely(() => { font = loadFont(); });
  [fillMenu, fillHero, fillMarquee, fillToken, fillUpdates, fillFooter, wirePasteButtons, startBoard].forEach(safely);
  safely(() => initMotion({ ratio: S.headline && S.headline.widthOfScreen, fontReady: font.ready }));
  document.documentElement.classList.add('page-ok');

  // Stickers are decoration: load them after the page settles, and the page works without them.
  if (!prefersReducedMotion()) {
    const later = window.requestIdleCallback || ((fn) => setTimeout(fn, 400));
    later(() => {
      import('./trail.js')
        .then((m) => m.initTrail(byId('hero'), { avoid: [byId('hero-tool')] }))
        .catch(() => { /* stickers unavailable: no trail */ });
    }, { timeout: 1500 });
  }
}

boot();
