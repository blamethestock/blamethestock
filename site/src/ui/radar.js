// Graduation radar: ETH-paired Pons coins of the last 48 h closest to graduating (from our API, /v1/radar, cached
// 2 min), then for each row, one at a time, the facts the browser reads from Robinhood Chain: dev buy %, first
// buyers' % (first ~5 s) and holders. Every coin links to its launch report. Facts only, not financial advice.
import { SETTINGS } from '../../settings.js';
import { viewLink } from './x-share.js';
import { ago, short } from './alerts.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const EXPLORER = 'https://robinhoodchain.blockscout.com';
const FACT_ROWS = 10;

function base(settings = SETTINGS) {
  const b = String((settings.trust && settings.trust.apiBase) || '').replace(/\/+$/, '');
  return /^https?:\/\/[^\s"'<>]+$/.test(b) ? b : '';
}
const clean = (s, max = 32) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
const pctText = (x, digits = 1) => (Number.isFinite(x) ? (x >= 10 || digits === 0 ? Math.round(x) : x.toFixed(digits)) + '%' : '…');

export function radarView(c, settings = SETTINGS) {
  if (!c || !ADDR.test(c.address || '') || !Number.isFinite(c.pct)) return null;
  const sym = clean(c.symbol, 20).replace(/^\$/, '');
  const name = clean(c.name);
  return {
    address: c.address.toLowerCase(),
    title: (sym ? '$' + sym : short(c.address)) + (name && name !== sym ? ' · ' + name : ''),
    pct: Math.max(0, Math.min(100, c.pct)),
    pctLabel: pctText(c.pct, 0) + ' to graduation',
    eth: Number.isFinite(c.ethIn) && Number.isFinite(c.thresholdEth) ? `${c.ethIn.toFixed(2)} of ${c.thresholdEth.toFixed(1)} ETH` : '',
    when: c.ageSeconds == null ? '' : 'launched ' + ago(c.ageSeconds),
    tokenUrl: EXPLORER + '/token/' + c.address.toLowerCase(),
    curveUrl: ADDR.test(c.curve || '') ? EXPLORER + '/address/' + c.curve.toLowerCase() : null,
    reportUrl: viewLink({ address: c.address, view: 'report' }, settings),
    row: { token: c.address, curve: c.curve, dev: c.dev, block: c.launch && c.launch.block, time: c.launch && c.launch.time, tx: c.launch && c.launch.tx, pair_token: '0x' + '0'.repeat(40) },
  };
}

export function factsText(f) {
  if (!f) return { dev: '…', snipers: '…', holders: '…' };
  return {
    dev: f.devPct == null ? 'unknown' : pctText(f.devPct),
    snipers: f.sniperPct == null ? 'unknown' : pctText(f.sniperPct) + (f.snipers ? ` (${f.snipers})` : ''),
    holders: f.holders == null ? 'unknown' : String(f.holders),
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

function fact(label, key) {
  return h('div', { class: 'rd-fact' }, h('dt', { text: label }), h('dd', { 'data-key': key, text: '…' }));
}

function rowEl(v) {
  const bar = h('span', { class: 'rd-fill' });
  bar.style.width = v.pct + '%';
  return h('li', { class: 'rd-row', 'data-address': v.address },
    h('p', { class: 'rd-head' }, ext(v.tokenUrl, 'rd-sym', v.title + ' ↗'), h('span', { class: 'rd-when', text: v.when })),
    h('div', { class: 'rd-bar', role: 'img', 'aria-label': v.pctLabel }, bar),
    h('p', { class: 'rd-pct' }, h('b', { text: v.pctLabel }), ' ', v.curveUrl ? ext(v.curveUrl, 'rd-eth', v.eth + ' ↗') : h('span', { text: v.eth })),
    h('dl', { class: 'rd-facts' }, fact('Holders', 'holders'), fact('Dev bought', 'dev'), fact('First buyers', 'snipers')),
    h('p', { class: 'rd-tools' }, ext(v.reportUrl, 'cc-tool', 'Launch report')));
}

function fill(li, f) {
  const t = factsText(f);
  for (const k of ['holders', 'dev', 'snipers']) { const dd = li.querySelector(`[data-key="${k}"]`); if (dd) dd.textContent = t[k]; }
}

export function renderRadar(el, body, settings = SETTINGS) {
  el.textContent = '';
  if (!body || body.ok !== true) {
    el.append(h('p', { class: 'al-note', text: 'The graduation radar is unavailable right now. Try again in a few minutes.' }));
    return [];
  }
  const views = (Array.isArray(body.coins) ? body.coins : []).map((c) => radarView(c, settings)).filter(Boolean);
  el.append(h('p', { class: 'al-intro', text: `ETH-paired Pons coins from the last ${body.hours || 48} hours closest to graduating: ETH in the launch curve against its 4.2 ETH threshold. "First buyers" = wallets that bought in the first ~5 seconds. Facts from Robinhood Chain, not financial advice.` }));
  const off = body.official && ADDR.test(body.official.address || '') ? radarView(body.official, settings) : null;
  if (off) {
    el.append(h('p', { class: 'rd-official' }, h('b', { text: '✅ ' + off.title.split(' · ')[0] + ': ' }),
      `${off.pctLabel} (${off.eth}), #${body.official.rank} of ${body.checked || 0}. `, ext(off.reportUrl, 'rd-eth', 'Launch report ↗')));
  }
  if (!views.length) { el.append(h('p', { class: 'al-note', text: 'No coin is on its way to graduating right now.' })); return []; }
  const list = h('ol', { class: 'rd-list' }, views.map(rowEl));
  el.append(list);
  if (body.asOf) el.append(h('p', { class: 'al-note', text: `Updated ${new Date(body.asOf).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${body.checked || 0} coins checked` }));
  return views.map((v, i) => ({ v, li: list.children[i] }));
}

export async function showRadar(el, { fetchFn = typeof fetch === 'function' ? fetch : null, settings = SETTINGS } = {}) {
  const b = base(settings);
  if (!el || !b || !fetchFn) return;
  el.textContent = '';
  el.append(h('p', { class: 'al-note', text: 'Reading launch curves…' }));
  let body = null;
  try { const r = await fetchFn(b + '/v1/radar', { credentials: 'omit' }); body = r ? await r.json() : null; } catch (e) { body = null; }
  const rows = renderRadar(el, body, settings);
  if (!rows.length) return;
  // The three facts, one coin at a time (the chain nodes limit bursts). A coin that can't be read says "unknown".
  let ctx = null;
  try {
    const [{ makeContext, radarFacts }, { FACTORY_ADDRESSES }] = await Promise.all([import('../trust/facts.js'), import('../trust/factories.js')]);
    ctx = await makeContext({ settings, factories: FACTORY_ADDRESSES });
    for (const { v, li } of rows.slice(0, FACT_ROWS)) {
      let f = null;
      try { f = await radarFacts(v.row, ctx); } catch (e) { f = { devPct: null, sniperPct: null, holders: null }; }
      fill(li, f);
    }
  } catch (e) { /* facts unavailable */ }
  for (const { li } of rows) for (const dd of li.querySelectorAll('.rd-fact dd')) if (dd.textContent === '…') dd.textContent = 'unknown';
}
