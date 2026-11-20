// "Share to X" for the copy check and the launch report: a short post with the coin and a link back to the same view.
// Pure (no DOM): the cards turn the result into an <a> that opens X's post box in a new tab. Nothing is sent anywhere.
import { SETTINGS } from '../../settings.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const MAX_TEXT = 200;   // X counts the link as 23, so text + link stays well under 280

export function siteUrl(settings = SETTINGS) {
  const u = String((settings && settings.site && settings.site.url) || 'https://blamethestock.com').replace(/\/+$/, '');
  return /^https:\/\//.test(u) ? u : 'https://blamethestock.com';
}

// The deep link that reopens this exact view: an address (?ca=…&view=copies|report) or a ticker (?q=…).
export function viewLink({ address = null, ticker = null, view = null } = {}, settings = SETTINGS) {
  const base = siteUrl(settings) + '/';
  if (address && ADDR.test(address)) return base + '?ca=' + address.toLowerCase() + (view ? '&view=' + view : '');
  const t = String(ticker || '').replace(/^\$/, '').trim();
  if (t && /^[A-Za-z0-9._-]{1,32}$/.test(t)) return base + '?q=' + encodeURIComponent(t);
  return base;
}

export function clip(s, max = MAX_TEXT) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : t.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

export function xPostUrl(text, link) {
  return 'https://x.com/intent/post?text=' + encodeURIComponent(clip(text)) + (link ? '&url=' + encodeURIComponent(link) : '');
}

const sym = (s) => { const t = String(s || '').replace(/^\$/, '').trim(); return /^[A-Za-z0-9._-]{1,20}$/.test(t) ? '$' + t : ''; };

// Launch report: "Launch report for $OBSYN: <verdict>"
export function reportShare(res, settings = SETTINGS) {
  const tok = (res && res.token) || {};
  const s = sym(tok.symbol);
  const text = (s ? `Launch report for ${s}: ` : 'Launch report: ') + String((res && res.verdict) || '');
  return xPostUrl(text, viewLink({ address: tok.address, view: 'report' }, settings));
}

// Copy check: "Is this the real $OBSYN? <verdict>"
export function copiesShare(res, settings = SETTINGS) {
  const q = (res && res.query) || {};
  const pasted = (res && Array.isArray(res.matches) ? res.matches : []).find((m) => m && m.isQuery);
  const s = sym((pasted && pasted.symbol) || q.input);
  const text = (s ? `Is this the real ${s}? ` : 'Is this the real one? ') + String((res && res.verdict) || '');
  const link = q.kind === 'address' && ADDR.test(q.address || '')
    ? viewLink({ address: q.address, view: 'copies' }, settings)
    : viewLink({ ticker: q.input }, settings);
  return xPostUrl(text, link);
}
