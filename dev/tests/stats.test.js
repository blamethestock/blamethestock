// Tests for site/src/ui/stats.js (the blame counter on the site).
import { suite, test, eq, ok } from './harness.js';
import { SETTINGS } from '../../site/settings.js';
import { statsText, statsLines, showStats, countBlame, countEvent, _resetStats } from '../../site/src/ui/stats.js';

suite('blame counter (site)');

const answer = (body, okay = true) => ({ ok: okay, json: async () => body });

test('the hero line: hidden until there is at least one blame; grouped numbers; "blame" for one', () => {
  eq(statsText(null), '');
  eq(statsText({ today: 0, total: 0 }), '');
  eq(statsText({ today: 1, total: 1 }), '1 blame run today (UTC) · 1 in total');
  eq(statsText({ today: 1234, total: 56789 }), '1,234 blames run today (UTC) · 56,789 in total');
});

test('countBlame: one POST to /v1/count per coin and window per page view, no body, no cookies', async () => {
  _resetStats();
  const calls = [];
  const fetchFn = async (url, o) => { calls.push([url, o]); return answer({ ok: true }); };
  const A = '0x' + 'a'.repeat(40);
  eq(await countBlame(A, '24h', { fetchFn }), true);
  eq(await countBlame(A.toUpperCase().replace('0X', '0x'), '24h', { fetchFn }), false, 'same coin and window again');
  eq(await countBlame(A, '1h', { fetchFn }), true, 'another window is another blame');
  eq(calls.length, 2);
  eq(calls[0][0], SETTINGS.trust.apiBase + '/v1/count');
  eq(calls[0][1].method, 'POST');
  eq(calls[0][1].credentials, 'omit');
  ok(!('body' in calls[0][1]), 'nothing is sent');
  eq(await countBlame('', '24h', { fetchFn }), false);
  eq(await countBlame('0x' + 'b'.repeat(40), '24h', { fetchFn: async () => { throw new Error('offline'); } }), false, 'offline: quietly nothing');
});

test('showStats: reads /v1/stats; refuses impossible numbers; never goes backwards on a cached answer', async () => {
  _resetStats();
  eq(await showStats({ fetchFn: async () => answer({ ok: true, today: 5, total: 3 }) }), null, 'today > total');
  eq(await showStats({ fetchFn: async () => answer({ ok: false }) }), null);
  eq(await showStats({ fetchFn: async () => answer({}, false) }), null);
  eq(await showStats({ fetchFn: async () => { throw new Error('offline'); } }), null);
  eq(await showStats({ fetchFn: async () => answer({ ok: true, today: 4, total: 10 }) }), { today: 4, total: 10, checks: { today: 0, total: 0 }, flags: { today: 0, total: 0 } });
  eq(await countBlame('0x' + 'c'.repeat(40), '24h', { fetchFn: async () => answer({ ok: true }) }), true);
  eq(await showStats({ fetchFn: async () => answer({ ok: true, today: 4, total: 10 }) }), { today: 5, total: 11, checks: { today: 0, total: 0 }, flags: { today: 0, total: 0 } }, 'own blame kept');
});

test('statsLines: today and all time, for blames, coins checked and copies flagged', () => {
  eq(statsLines(null), []);
  eq(statsLines({ today: 3, total: 40, checks: { today: 1, total: 12 }, flags: { today: 0, total: 1500 } }), [
    'Today (UTC): 3 blames · 1 coin checked · 0 copies flagged',
    'All time: 40 blames · 12 coins checked · 1,500 copies flagged',
  ]);
  eq(statsLines({ today: 1, total: 1 })[1], 'All time: 1 blame · 0 coins checked · 0 copies flagged', 'older API answer: counters at 0');
});

test('countEvent: once per kind and coin per page view, at most 10, only check or flag; never says who', async () => {
  _resetStats();
  const calls = [];
  const fetchFn = async (url, init) => { calls.push([url, init]); return { ok: true }; };
  const A = '0x' + 'ab'.repeat(20);
  eq(await countEvent('check', 1, A, { fetchFn }), true);
  eq(await countEvent('check', 1, A.toUpperCase().replace('0X', '0x'), { fetchFn }), false, 'same coin again: not counted');
  eq(await countEvent('flag', 25, A, { fetchFn }), true);
  eq(await countEvent('visitor', 1, A, { fetchFn }), false);
  eq(await countEvent('flag', 0, 'OBSYN', { fetchFn }), false);
  eq(calls.map((c) => c[0]), ['https://api.blamethestock.com/v1/count?kind=check&n=1', 'https://api.blamethestock.com/v1/count?kind=flag&n=10']);
  ok(calls.every((c) => c[1].method === 'POST' && c[1].credentials === 'omit' && c[1].body === undefined), 'no body, no cookies');
  _resetStats();
});
