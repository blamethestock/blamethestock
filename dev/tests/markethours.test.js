// Tests for site/src/features/markethours.js (US market hours, used by off-hours mode).
import { suite, test, eq } from './harness.js';
import { isMarketOpen, sessionFor, splitWindow } from '../../site/src/features/markethours.js';

suite('markethours');
const u = (iso) => Date.parse(iso) / 1000;

test('regular day, winter time (EST)', () => {
  eq(isMarketOpen(u('2026-11-13T14:30:00Z')), true, 'open at 9:30 ET');
  eq(isMarketOpen(u('2026-11-13T14:29:59Z')), false, 'closed at 9:29 ET');
  eq(isMarketOpen(u('2026-11-13T20:59:59Z')), true, 'open at 3:59 PM ET');
  eq(isMarketOpen(u('2026-11-13T21:00:00Z')), false, 'closed at 4:00 PM ET');
});
test('weekend and holidays', () => {
  eq(isMarketOpen(u('2026-11-14T15:00:00Z')), false, 'Saturday');
  eq(isMarketOpen(u('2026-11-26T16:00:00Z')), false, 'Thanksgiving');
  eq(sessionFor(Date.parse('2026-07-03T15:00:00Z')), null, 'Independence Day observed');
});
test('early close the day after Thanksgiving', () => {
  eq(isMarketOpen(u('2026-11-27T17:59:00Z')), true, '12:59 PM');
  eq(isMarketOpen(u('2026-11-27T18:00:00Z')), false, '1:00 PM');
});
test('summer time (EDT) and the switch week', () => {
  eq(isMarketOpen(u('2026-07-01T13:30:00Z')), true, 'EDT open 13:30Z');
  eq(isMarketOpen(u('2026-07-01T13:29:00Z')), false, 'EDT closed 13:29Z');
  eq(isMarketOpen(u('2026-03-09T13:30:00Z')), true, 'first EDT Monday');
});
test('24h window split into open and closed time', () => {
  const w = splitWindow(u('2026-11-12T05:37:28Z'), u('2026-11-13T05:37:28Z'));
  eq(w.openSeconds, 6.5 * 3600);
  eq(w.closedSeconds, 17.5 * 3600);
  eq(w.boundaries, [u('2026-11-12T14:30:00Z'), u('2026-11-12T21:00:00Z')]);
});
test('weekend window is all closed; a 7d window has 5 sessions', () => {
  const we = splitWindow(u('2026-11-14T10:00:00Z'), u('2026-11-15T10:00:00Z'));
  eq([we.openSeconds, we.pieces.length], [0, 1]);
  const wk = splitWindow(u('2026-11-06T05:37:28Z'), u('2026-11-13T05:37:28Z'));
  eq(wk.pieces.filter((p) => p.open).length, 5);
});
