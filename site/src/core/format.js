// Blame the Stock — number and text formatting (pure: no DOM, no network).
// Every function here returns a plain string and never returns "NaN" or "Infinity":
// a value that is not a real number becomes DASH.

export const MINUS = '−';   // the real minus sign "−" (not a hyphen)
export const DASH = '—';    // shown in place of a number we don't have
const isNum = Number.isFinite;

// 1234567.4 -> "1,234,567" (n >= 0; Intl also writes 1e23 as "100,000,…" instead of "1e+23")
let grouper;
function group(n) {
  try {
    grouper = grouper || new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
    return grouper.format(n);
  } catch (e) {
    return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
}

// Percent digits without a sign: under 10% one decimal, otherwise none.
// Returns '' when the value rounds to 0.0%.
function pctDigits(x) {
  const v = Math.abs(x) * 100;
  const one = Math.round(v * 10) / 10;
  if (one === 0) return '';
  return one < 10 ? one.toFixed(1) : group(v);
}

// pct(-0.12) -> '−12%', pct(0.046) -> '+4.6%', pct(0.0001) -> '0.0%'
// { sign: false } drops the "+" on rises (falls keep "−").
export function pct(x, { sign = true } = {}) {
  if (!isNum(x)) return DASH;
  const d = pctDigits(x);
  if (!d) return '0.0%';
  return (x < 0 ? MINUS : sign ? '+' : '') + d + '%';
}

// pctAbs(-0.12) -> '12%'
export function pctAbs(x) {
  if (!isNum(x)) return DASH;
  return (pctDigits(x) || '0.0') + '%';
}

// '↑' up, '↓' down, '→' when it shows as 0.0%
export function arrow(x) {
  if (!isNum(x) || !pctDigits(x)) return '→';
  return x < 0 ? '↓' : '↑';
}

// 'down 12%' | 'up 4.6%' | 'flat'
export function moveWords(x) {
  if (!isNum(x) || !pctDigits(x)) return 'flat';
  return (x < 0 ? 'down ' : 'up ') + pctAbs(x);
}

// Dollar amounts, short: '$950', '$1.4k', '$26k', '$1.4M', '$2.5B'
export function usd(n) {
  if (!isNum(n)) return DASH;
  const sign = n < 0 ? MINUS : '';
  const a = Math.abs(n);
  if (a === 0) return '$0';
  if (a < 1) return sign + '$' + a.toFixed(2);
  if (Math.round(a) < 1000) return sign + '$' + Math.round(a);
  const units = [[1e3, 'k'], [1e6, 'M'], [1e9, 'B'], [1e12, 'T']];
  let i = 0;
  while (i < units.length - 1 && a >= units[i + 1][0]) i++;
  for (; i < units.length; i++) {
    const m = a / units[i][0];
    const one = Math.round(m * 10) / 10;
    const text = one < 10 ? String(one) : group(m);       // String(1.0) is "1"
    if (Math.round(m) >= 1000 && i < units.length - 1) continue; // 999.96k -> 1M
    return sign + '$' + text + units[i][1];
  }
  return sign + '$' + group(a); // not reached
}

// How long ago, rounded down so it never overstates: '40 minutes', '3 hours', '2 days'.
// Under 48 hours is said in hours; anything under a minute is '1 minute'.
export function age(seconds) {
  const s = isNum(seconds) && seconds > 0 ? seconds : 0;
  const plural = (n, word) => n + ' ' + word + (n === 1 ? '' : 's');
  if (s < 3600) return plural(Math.max(1, Math.floor(s / 60)), 'minute');
  if (s < 48 * 3600) return plural(Math.floor(s / 3600), 'hour');
  return plural(Math.floor(s / 86400), 'day');
}

// '12:37 AM EST'. Visitor's own time zone unless one is given; English by default
// so it matches the rest of the page.
export function asOfTime(unixSeconds, locale, timeZone) {
  if (!isNum(unixSeconds)) return '';
  const date = new Date(unixSeconds * 1000);
  const opts = { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };
  // A bad locale falls back to English but keeps the time zone; a bad time zone falls back to the visitor's own.
  const tries = [[locale || 'en-US', timeZone], ['en-US', timeZone], ['en-US', undefined]];
  let s = '';
  for (const [loc, tz] of tries) {
    try { s = new Intl.DateTimeFormat(loc, tz ? { ...opts, timeZone: tz } : opts).format(date); break; }
    catch (e) { /* try the next one */ }
  }
  if (!s) s = date.toISOString().slice(11, 16) + ' UTC';
  // No-break / narrow no-break spaces -> plain spaces. Zones without a short name come out as "GMT-5":
  // use the real minus there too ("GMT−5"), like every other negative number on the card.
  return s.replace(/[\u00A0\u202F]/g, ' ').replace(/-(?=\d)/g, MINUS);
}

// Fill a wording template: fill('You\'re {move}.', { move: 'down 12%' }).
// One pass only (a value that itself contains "{x}" is not filled again).
// A {name} with no value is left as-is so a typo in settings.js is easy to spot.
export function fill(template, vars = {}) {
  if (typeof template !== 'string') return '';
  return template.replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) && vars[key] != null ? String(vars[key]) : whole);
}
