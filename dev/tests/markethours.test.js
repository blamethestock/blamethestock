// Tests for site/src/features/markethours.js (runs under jsc: jsc -m dev/tests/markethours.test.js)
import { isMarketOpen, sessionFor, splitWindow } from '../../site/src/features/markethours.js';

const out = typeof print === 'function' ? print : (s) => console.log(s);
let pass = 0, fail = 0;
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  out(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `  got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}
const u = (iso) => Date.parse(iso) / 1000;

// Fri 13 Nov 2026 is a normal trading day; New York is on EST (UTC-5).
eq('open at 9:30 ET (14:30Z)', isMarketOpen(u('2026-11-13T14:30:00Z')), true);
eq('closed at 9:29 ET', isMarketOpen(u('2026-11-13T14:29:59Z')), false);
eq('open at 3:59 PM ET', isMarketOpen(u('2026-11-13T20:59:59Z')), true);
eq('closed at 4:00 PM ET', isMarketOpen(u('2026-11-13T21:00:00Z')), false);
eq('closed Saturday', isMarketOpen(u('2026-11-14T15:00:00Z')), false);
eq('closed Thanksgiving', isMarketOpen(u('2026-11-26T16:00:00Z')), false);
eq('early close day after Thanksgiving: open 12:59 PM', isMarketOpen(u('2026-11-27T17:59:00Z')), true);
eq('early close day after Thanksgiving: closed 1:00 PM', isMarketOpen(u('2026-11-27T18:00:00Z')), false);
// Summer time (EDT, UTC-4): Wed 1 Jul 2026 opens 13:30Z.
eq('EDT open 13:30Z', isMarketOpen(u('2026-07-01T13:30:00Z')), true);
eq('EDT closed 13:29Z', isMarketOpen(u('2026-07-01T13:29:00Z')), false);
eq('Independence Day observed Fri 3 Jul 2026', sessionFor(Date.parse('2026-07-03T15:00:00Z')), null);
// DST switch week: Mon 9 Mar 2026 is EDT (switch on Sun 8 Mar).
eq('first EDT Monday opens 13:30Z', isMarketOpen(u('2026-03-09T13:30:00Z')), true);

// 24h window ending Fri 13 Nov 2026 05:37Z covers Thu 12 Nov's session (14:30Z-21:00Z).
const w = splitWindow(u('2026-11-12T05:37:28Z'), u('2026-11-13T05:37:28Z'));
eq('24h window open seconds = 6.5h', w.openSeconds, 6.5 * 3600);
eq('24h window closed seconds = 17.5h', w.closedSeconds, 17.5 * 3600);
eq('24h window boundaries', w.boundaries, [u('2026-11-12T14:30:00Z'), u('2026-11-12T21:00:00Z')]);
// Weekend window: Sat 14 Nov 10:00Z to Sun 15 Nov 10:00Z is all closed.
const we = splitWindow(u('2026-11-14T10:00:00Z'), u('2026-11-15T10:00:00Z'));
eq('weekend window fully closed', [we.openSeconds, we.pieces.length], [0, 1]);
// 7d window has 5 sessions (Thanksgiving week would have fewer).
const wk = splitWindow(u('2026-11-06T05:37:28Z'), u('2026-11-13T05:37:28Z'));
eq('7d window has 5 open pieces', wk.pieces.filter(p => p.open).length, 5);

out(`\n${pass} passed, ${fail} failed`);
if (fail) throw new Error(`${fail} market-hours tests failed`);
