// US stock market hours (NYSE/Nasdaq regular session), used by off-hours mode.
// Regular session: 9:30 AM to 4:00 PM New York time, Monday to Friday,
// closed on market holidays, and closing at 1:00 PM on early-close days.
// UPDATE EACH YEAR: add next year's holidays and early closes below.

const HOLIDAYS = new Set([
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19',
  '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18',
  '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
]);
const EARLY_CLOSE = new Set(['2026-11-27', '2026-12-24', '2027-11-26']); // close at 1:00 PM

const NY = 'America/New_York';
let fmt;
function nyParts(ms) {
  fmt ||= new Intl.DateTimeFormat('en-US', {
    timeZone: NY, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p = {};
  for (const { type, value } of fmt.formatToParts(new Date(ms))) p[type] = value;
  return {
    date: `${p.year}-${p.month}-${p.day}`, y: +p.year, m: +p.month, d: +p.day,
    h: +p.hour, min: +p.minute, s: +p.second, weekday: p.weekday,
  };
}

// UTC milliseconds for a New York wall-clock time on a given date.
function nyToUtc(y, m, d, h, min) {
  const guess = Date.UTC(y, m - 1, d, h, min);
  let utc = guess + 5 * 3600e3; // start from EST
  for (let i = 0; i < 3; i++) {
    const p = nyParts(utc);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
    const diff = asUtc - guess;
    if (diff === 0) break;
    utc -= diff;
  }
  return utc;
}

// The regular session for the New York calendar day containing `ms`,
// as [openMs, closeMs], or null when the market is shut all day.
export function sessionFor(ms) {
  const p = nyParts(ms);
  if (p.weekday === 'Sat' || p.weekday === 'Sun' || HOLIDAYS.has(p.date)) return null;
  const open = nyToUtc(p.y, p.m, p.d, 9, 30);
  const close = EARLY_CLOSE.has(p.date) ? nyToUtc(p.y, p.m, p.d, 13, 0) : nyToUtc(p.y, p.m, p.d, 16, 0);
  return [open, close];
}

export function isMarketOpen(unixSeconds) {
  const ms = unixSeconds * 1000;
  const s = sessionFor(ms);
  return !!s && ms >= s[0] && ms < s[1];
}

// Split [start, end] (unix seconds) into open and closed stretches.
// Returns { pieces: [{ from, to, open }], openSeconds, closedSeconds, boundaries: [unix seconds] }.
export function splitWindow(start, end) {
  const pieces = [];
  if (!(end > start)) return { pieces, openSeconds: 0, closedSeconds: 0, boundaries: [] };
  // Collect session edges overlapping the window (scan each NY day once).
  const edges = [];
  const dayMs = 86400e3;
  for (let t = (start - 86400) * 1000; t <= (end + 86400) * 1000; t += dayMs) {
    const s = sessionFor(t);
    if (s) edges.push(s);
  }
  const uniq = [];
  for (const s of edges) if (!uniq.some(u => u[0] === s[0])) uniq.push(s);
  uniq.sort((a, b) => a[0] - b[0]);
  let cursor = start;
  for (const [o, c] of uniq.map(([o, c]) => [o / 1000, c / 1000])) {
    if (c <= start || o >= end) continue;
    const from = Math.max(o, start), to = Math.min(c, end);
    if (from > cursor) pieces.push({ from: cursor, to: from, open: false });
    pieces.push({ from, to, open: true });
    cursor = to;
  }
  if (cursor < end) pieces.push({ from: cursor, to: end, open: false });
  let openSeconds = 0, closedSeconds = 0;
  for (const p of pieces) (p.open ? (openSeconds += p.to - p.from) : (closedSeconds += p.to - p.from));
  const boundaries = pieces.slice(1).map(p => p.from);
  return { pieces, openSeconds, closedSeconds, boundaries };
}
