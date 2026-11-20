// Blame the Stock: the blame counter. After each blame card it draws, the site tells our API "one more" (no body,
// nothing about the visitor), and the hero shows "N blames today (UTC) · M in total" from /v1/stats.
// Never holds anything up: if the API can't be reached the line simply stays hidden.
import { SETTINGS } from '../../settings.js';

const counted = new Set();      // coin + window pairs already counted on this page view
let shown = null;               // { today, total, checks: { today, total }, flags: { today, total } } on screen

function base(settings = SETTINGS) {
  const b = String((settings.trust && settings.trust.apiBase) || '').replace(/\/+$/, '');
  return /^https?:\/\/[^\s"'<>]+$/.test(b) ? b : '';
}
const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function statsText(s) {
  if (!s || !Number.isFinite(s.today) || !Number.isFinite(s.total) || s.total < 1) return '';
  return `${group(s.today)} ${s.today === 1 ? 'blame' : 'blames'} run today (UTC) · ${group(s.total)} in total`;
}

// Two short lines: today (UTC) and all time, for blames, coins checked and copies flagged.
const pair = (x) => (x && Number.isFinite(x.today) && Number.isFinite(x.total) && x.today >= 0 && x.total >= x.today ? x : { today: 0, total: 0 });
export function statsLines(s) {
  if (!s || !Number.isFinite(s.today) || !Number.isFinite(s.total) || s.total < 1) return [];
  const c = pair(s.checks), f = pair(s.flags);
  const part = (n, one, many) => `${group(n)} ${n === 1 ? one : many}`;
  const line = (b, ch, fl) => [part(b, 'blame', 'blames'), part(ch, 'coin checked', 'coins checked'), part(fl, 'copy flagged', 'copies flagged')].join(' · ');
  return ['Today (UTC): ' + line(s.today, c.today, f.today), 'All time: ' + line(s.total, c.total, f.total)];
}

function draw() {
  const el = typeof document !== 'undefined' ? document.getElementById('blame-stats') : null;
  if (!el) return;
  const lines = statsLines(shown);
  el.textContent = '';
  // each phrase stays on one line ("3 copies flagged" never splits); lines break between phrases
  lines.forEach((t, i) => {
    if (i) el.append(document.createElement('br'));
    t.split(' · ').forEach((part, j) => {
      if (j) el.append(' · ');
      const sp = document.createElement('span');
      sp.className = 'hero-stats-part';
      sp.textContent = part;
      el.append(sp);
    });
  });
  el.hidden = !lines.length;
}

export async function showStats({ fetchFn = typeof fetch === 'function' ? fetch : null, settings = SETTINGS } = {}) {
  const b = base(settings);
  if (!b || !fetchFn) return null;
  try {
    const r = await fetchFn(b + '/v1/stats', { credentials: 'omit' });
    const j = r && r.ok ? await r.json() : null;
    if (!j || j.ok !== true) return null;
    const today = Number(j.today), total = Number(j.total);
    if (!Number.isFinite(today) || !Number.isFinite(total) || today < 0 || total < today) return null;
    // never go backwards on screen because of a cached answer
    const up = (a, b) => { const x = pair(a), y = pair(b); return { today: Math.max(x.today, y.today), total: Math.max(x.total, y.total) }; };
    shown = shown
      ? { today: Math.max(today, shown.today), total: Math.max(total, shown.total), checks: up(j.checks, shown.checks), flags: up(j.flags, shown.flags) }
      : { today, total, checks: pair(j.checks), flags: pair(j.flags) };
    draw();
    return shown;
  } catch (e) { return null; }
}

// Once per coin and window per page view (switching back to a window already seen isn't a new blame).
export async function countBlame(coin, windowName, { fetchFn = typeof fetch === 'function' ? fetch : null, settings = SETTINGS } = {}) {
  const b = base(settings);
  const key = String(coin || '').toLowerCase() + '|' + String(windowName || '');
  if (!b || !fetchFn || !coin || counted.has(key)) return false;
  counted.add(key);
  try {
    const r = await fetchFn(b + '/v1/count', { method: 'POST', credentials: 'omit', keepalive: true });
    if (!r || !r.ok) return false;
    if (shown) { shown = { ...shown, today: shown.today + 1, total: shown.total + 1 }; draw(); }
    return true;
  } catch (e) { return false; }
}

// A coin checked (copy check or launch report: once per coin per page view, so pasting an address that opens both
// counts one) or copies flagged (warning flags in a finished copy check, at most 10). Nothing about the visitor.
export async function countEvent(kind, n, key, { fetchFn = typeof fetch === 'function' ? fetch : null, settings = SETTINGS } = {}) {
  const b = base(settings);
  const k = kind + '|' + String(key || '').toLowerCase();
  const amount = Math.min(10, Math.floor(Number(n)));
  if (!b || !fetchFn || !key || !(amount >= 1) || (kind !== 'check' && kind !== 'flag') || counted.has(k)) return false;
  counted.add(k);
  try {
    const r = await fetchFn(b + '/v1/count?kind=' + kind + '&n=' + amount, { method: 'POST', credentials: 'omit', keepalive: true });
    if (!r || !r.ok) return false;
    if (shown) {
      const field = kind === 'check' ? 'checks' : 'flags';
      const x = pair(shown[field]);
      shown = { ...shown, [field]: { today: x.today + amount, total: x.total + amount } };
      draw();
    }
    return true;
  } catch (e) { return false; }
}

export function _resetStats() { counted.clear(); shown = null; }
