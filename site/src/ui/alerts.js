// Copycat alerts: Pons launches of the last 24 h that use the name or ticker of a Pons coin that already graduated.
// From our API (/v1/alerts, cached 2 min). Facts only: never "real", never "scam". Loads when the section comes into
// view; if the API can't be reached the section says so in one grey line.
import { SETTINGS } from '../../settings.js';
import { xPostUrl, viewLink } from './x-share.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const SHOW = 8;

function base(settings = SETTINGS) {
  const b = String((settings.trust && settings.trust.apiBase) || '').replace(/\/+$/, '');
  return /^https?:\/\/[^\s"'<>]+$/.test(b) ? b : '';
}
const clean = (s, max = 32) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const tickerOk = (s) => /^[A-Za-z0-9._-]{1,20}$/.test(String(s || '').replace(/^\$/, ''));
export const short = (a) => (ADDR.test(a || '') ? a.slice(0, 6) + '…' + a.slice(-4) : '');

export function ago(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  if (sec < 90) return 'just now';
  if (sec < 3600) return Math.round(sec / 60) + ' min ago';
  const h = Math.floor(sec / 3600);
  return h + (h === 1 ? ' hour ago' : ' hours ago');
}

// One alert -> what the row shows and the ready-to-post warning.
export function alertView(a, settings = SETTINGS) {
  if (!a || !a.copy || !a.graduated || !ADDR.test(a.copy.address || '') || !ADDR.test(a.graduated.address || '')) return null;
  const sym = clean(a.copy.symbol, 20).replace(/^\$/, '');
  const gsym = clean(a.graduated.symbol, 20).replace(/^\$/, '');
  const what = a.matchedOn === 'name' ? 'name' : 'ticker';
  const label = tickerOk(gsym) ? '$' + gsym : 'this ' + what;
  const others = Number(a.graduatedSameName) > 1 ? ` (${a.graduatedSameName} graduated coins use this ${what}; showing the first one)` : '';
  const copy = a.copy.address.toLowerCase(), grad = a.graduated.address.toLowerCase();
  const post = `⚠️ Same ${what}, different coin. A new Pons launch uses ${label}:\n${copy}\n\nThe ${label} that graduated on Pons:\n${grad}\n\nCheck before you buy:`;
  return {
    copy, grad,
    title: (sym ? '$' + sym : short(copy)) + (clean(a.copy.name) && clean(a.copy.name) !== sym ? ' · ' + clean(a.copy.name) : ''),
    when: ago(a.copy.ageSeconds),
    line: `Same ${what} as ${label}, which graduated on Pons${others}.`,
    copyUrl: EXPLORER + '/token/' + copy,
    gradUrl: EXPLORER + '/token/' + grad,
    gradTxUrl: /^0x[0-9a-f]{64}$/.test(a.graduated.graduationTx || '') ? EXPLORER + '/tx/' + a.graduated.graduationTx : null,
    checkUrl: viewLink({ address: copy, view: 'copies' }, settings),
    postUrl: xPostUrl(post, tickerOk(gsym) ? viewLink({ ticker: gsym }, settings) : viewLink({ address: copy, view: 'copies' }, settings)),
  };
}

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null) continue;
    if (k === 'text') el.textContent = v; else el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k);
  return el;
}
const ext = (href, cls, text) => h('a', { href, class: cls, target: '_blank', rel: 'noopener noreferrer', text });

function rowEl(v) {
  return h('li', { class: 'al-row' },
    h('p', { class: 'al-head' }, ext(v.copyUrl, 'al-sym', v.title + ' ↗'), h('span', { class: 'al-when', text: v.when })),
    h('p', { class: 'al-addr' }, h('span', { class: 'al-k', text: 'New: ' }), h('code', { text: v.copy })),
    h('p', { class: 'al-line', text: v.line }),
    h('p', { class: 'al-addr' }, h('span', { class: 'al-k', text: 'Graduated: ' }), ext(v.gradUrl, 'al-code', v.grad),
      v.gradTxUrl ? [' ', ext(v.gradTxUrl, 'al-proof', 'graduation ↗')] : null),
    h('p', { class: 'al-tools' }, ext(v.checkUrl, 'cc-tool', 'Check it'), ' ', ext(v.postUrl, 'cc-tool', 'Post warning ↗')));
}

export function renderAlerts(el, body, settings = SETTINGS) {
  el.textContent = '';
  if (!body || body.ok !== true) {
    el.append(h('p', { class: 'al-note', text: 'Copycat alerts are unavailable right now. Try again in a few minutes.' }));
    return;
  }
  const views = (Array.isArray(body.alerts) ? body.alerts : []).map((a) => alertView(a, settings)).filter(Boolean);
  el.append(h('p', { class: 'al-intro', text: 'New Pons coins from the last 24 hours that use the name or ticker of a Pons coin that already graduated. Same name is a fact, not proof of a scam, and graduating is not proof of being the original. Check both before you buy.' }));
  if (!views.length) { el.append(h('p', { class: 'al-note', text: 'No new copies of graduated coins in the last 24 hours.' })); return; }
  const list = h('ol', { class: 'al-list' }, views.slice(0, SHOW).map(rowEl));
  el.append(list);
  if (views.length > SHOW) {
    const more = h('button', { type: 'button', class: 'cc-tool al-more', text: `Show all ${views.length}` });
    more.addEventListener('click', () => { views.slice(SHOW).forEach((v) => list.append(rowEl(v))); more.remove(); });
    el.append(more);
  }
  if (body.asOf) el.append(h('p', { class: 'al-note', text: 'Updated ' + new Date(body.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ' · Pons launches only' }));
}

export async function showAlerts(el, { fetchFn = typeof fetch === 'function' ? fetch : null, settings = SETTINGS } = {}) {
  const b = base(settings);
  if (!el || !b || !fetchFn) return;
  el.textContent = '';
  el.append(h('p', { class: 'al-note', text: 'Checking new launches…' }));
  let body = null;
  try {
    const r = await fetchFn(b + '/v1/alerts', { credentials: 'omit' });
    body = r ? await r.json() : null;
  } catch (e) { body = null; }
  renderAlerts(el, body, settings);
}
