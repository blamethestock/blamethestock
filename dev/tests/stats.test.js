// Tests for site/src/ui/stats.js (the blame counter on the site).
import { suite, test, eq, ok } from './harness.js';
import { SETTINGS } from '../../site/settings.js';
import { statsText, showStats, countBlame, _resetStats } from '../../site/src/ui/stats.js';

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
  eq(await showStats({ fetchFn: async () => answer({ ok: true, today: 4, total: 10 }) }), { today: 4, total: 10 });
  eq(await countBlame('0x' + 'c'.repeat(40), '24h', { fetchFn: async () => answer({ ok: true }) }), true);
  eq(await showStats({ fetchFn: async () => answer({ ok: true, today: 4, total: 10 }) }), { today: 5, total: 11 }, 'own blame kept');
});
