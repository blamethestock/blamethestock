// Blame the Stock: the blame counter. After each blame card it draws, the site tells our API "one more" (no body,
// nothing about the visitor), and the hero shows "N blames today (UTC) · M in total" from /v1/stats.
// Never holds anything up: if the API can't be reached the line simply stays hidden.
import { SETTINGS } from '../../settings.js';

const counted = new Set();      // coin + window pairs already counted on this page view
let shown = null;               // { today, total } on screen

function base(settings = SETTINGS) {
  const b = String((settings.trust && settings.trust.apiBase) || '').replace(/\/+$/, '');
  return /^https?:\/\/[^\s"'<>]+$/.test(b) ? b : '';
}
const group = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

export function statsText(s) {
  if (!s || !Number.isFinite(s.today) || !Number.isFinite(s.total) || s.total < 1) return '';
  return `${group(s.today)} ${s.today === 1 ? 'blame' : 'blames'} run today (UTC) · ${group(s.total)} in total`;
}

function draw() {
  const el = typeof document !== 'undefined' ? document.getElementById('blame-stats') : null;
  if (!el) return;
  const t = statsText(shown);
  el.textContent = t;
  el.hidden = !t;
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
    shown = shown ? { today: Math.max(today, shown.today), total: Math.max(total, shown.total) } : { today, total };
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
    if (shown) { shown = { today: shown.today + 1, total: shown.total + 1 }; draw(); }
    return true;
  } catch (e) { return false; }
}

export function _resetStats() { counted.clear(); shown = null; }
