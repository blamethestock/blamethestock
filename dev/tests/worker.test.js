// API Worker core (api/src/worker.js via its default export's `internals`, api/src/budget.js): routing, CORS, rate limit, caching, staged copy check,
// report/link jobs, the cron, and the subrequest budget. Runs in jsc with fakes: no network, no Cloudflare.
import { suite, test, eq, ok } from './harness.js';
import worker, { alertsFromRows, SQL_ALERTS, radarFrom, SQL_RADAR } from '../../api/src/worker.js';
import { createBudget, refusal, isRefusal, wrapDb, BudgetExceeded } from '../../api/src/budget.js';
import { _setTransport, byHealth } from '../../site/src/data/rpc.js';
import { runCopyCheck } from '../../site/src/trust/copycheck.js';
import { loadFixture, replayFetch, fixtureIndex, runScenario, OBSYN } from './fixtures/obsyn/replay.js';

const W = worker.internals;
const noSleep = async () => {};
const NOW = 1794991000 * 1000;
const TOKEN = '0x5d992fa5b7da8efde5fd36d24e81097ed6ad4351';

// ---- fakes ------------------------------------------------------------------------------------------------
// D1 that understands exactly the statements the Worker sends. Anything else throws,
// so a new query shows up here first.
function fakeD1({ meta = {}, oldest = null } = {}) {
  const cache = new Map();   // key -> { body, expires }
  const jobs = new Map();    // key -> row
  const counts = new Map();  // day -> n (the blame counter)
  const events = new Map();  // 'day|kind' -> n (coins checked, copies flagged)
  const db = { cache, jobs, meta, counts, events, queries: 0, log: [] };
  const exec = (sql, a) => {
    db.log.push(sql);
    if (W.SQL_SCHEMA.includes(sql)) return { results: [] };
    switch (sql) {
      case W.SQL_CACHE_GET: { const r = cache.get(a[0]); return { results: r && r.expires > a[1] ? [{ body: r.body }] : [] }; }
      case W.SQL_CACHE_PUT: cache.set(a[0], { body: a[1], expires: a[2] }); return { results: [] };
      case W.SQL_CACHE_PURGE: for (const [k, v] of [...cache]) if (v.expires <= a[0]) cache.delete(k); return { results: [] };
      case W.SQL_JOBS_PURGE: for (const [k, j] of [...jobs]) if (j.created <= a[0]) jobs.delete(k); return { results: [] };
      case W.SQL_META: return { results: Object.entries(meta).map(([key, value]) => ({ key, value: String(value) })) };
      case W.SQL_OLDEST_TIME: return { results: oldest && oldest.block >= a[0] ? [{ time: oldest.time }] : [] };
      case W.SQL_COUNT_ADD: counts.set(a[0], (counts.get(a[0]) || 0) + 1); return { results: [] };
      case W.SQL_COUNT_GET: {
        if (!counts.size) return { results: [{ total: 0, today: 0, since: null }] };
        const total = [...counts.values()].reduce((x, y) => x + y, 0);
        return { results: [{ total, today: counts.get(a[0]) || 0, since: Math.min(...counts.keys()) }] };
      }
      case W.SQL_EVENT_ADD: events.set(a[0] + '|' + a[1], (events.get(a[0] + '|' + a[1]) || 0) + a[2]); return { results: [] };
      case W.SQL_EVENT_GET: {
        const by = new Map();
        for (const [k, n] of events) {
          const [day, kind] = k.split('|');
          const x = by.get(kind) || { kind, total: 0, today: 0 };
          x.total += n; if (Number(day) === a[0]) x.today += n; by.set(kind, x);
        }
        return { results: [...by.values()] };
      }
      default: throw new Error('fake D1: unexpected SQL ' + sql.slice(0, 80));
    }
  };
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    first: async () => { db.queries++; return exec(sql, args).results[0] || null; },
    all: async () => { db.queries++; return exec(sql, args); },
    run: async () => { db.queries++; exec(sql, args); return { success: true }; },
    raw: async () => { db.queries++; return exec(sql, args).results.map((r) => Object.values(r)); },
  });
  db.prepare = (sql) => stmt(sql);
  db.batch = async (list) => { db.queries++; return list.map((s) => exec(s.sql, s.args)); };
  db.exec = async () => { db.queries++; return {}; };
  return db;
}

// Cache API stand-in with the Worker's { get, put } interface; counts like the real one.
function fakeCache(budget) {
  const store = new Map();
  const c = {
    store, gets: 0, puts: 0,
    bind(b) { return { get: async (k) => { if (!b.take(1)) return null; c.gets++; return store.has(k) ? JSON.parse(store.get(k)) : null; },
      put: async (k, v) => { if (!b.take(1)) return; c.puts++; store.set(k, JSON.stringify(v)); } }; },
  };
  return c;
}

function req(path, { method = 'GET', origin = null, ip = '203.0.113.7' } = {}) {
  const h = { origin, 'cf-connecting-ip': ip };
  return { method, url: 'http://localhost:8787' + path, headers: { get: (k) => (h[String(k).toLowerCase()] ?? null) } };
}

// One request through handle(), the way the Worker's fetch() runs it (inside its budget).
async function call(path, o = {}) {
  const budget = createBudget({ limit: o.limit || 45, d1Limit: 45, fetch: o.fetch || (async () => { throw new Error('no network in tests'); }) });
  const db = o.db ? budget.wrapDb(o.db) : null;
  const deps = {
    now: o.now || NOW, budget, db, settings: o.settings || W.settingsFor({}),
    cache: o.cache ? o.cache.bind(budget) : null, limiter: o.limiter || null, index: o.index, copyMatches: o.copyMatches,
    mcp: o.mcp, origins: o.origins, rateBinding: o.rateBinding || null,
  };
  const r = await W.withBudget(budget, () => W.handle(req(path, o), o.env || {}, null, deps));
  return { ...r, json: r.body ? JSON.parse(r.body) : null, budget };
}

// =========================================================================================================
suite('worker › basics');

test('parseUrl: path, decoded query, + as space, bad escapes ignored', () => {
  const u = W.parseUrl('https://api.blamethestock.com/v1/copies?q=%24OB+SYN&x=%E0%A4&q=second');
  eq(u.origin, 'https://api.blamethestock.com');
  eq(u.pathname, '/v1/copies');
  eq(u.params.get('q'), '$OB SYN');
  eq(u.params.get('x'), null);
  eq(u.params.get('nope'), null);
  eq(W.parseUrl('not a url').pathname, '/');
});

test('allowed origins: the three defaults, or SITE_ORIGINS', () => {
  eq(W.allowedOrigins({}), ['https://blamethestock.com', 'https://www.blamethestock.com', 'http://localhost:8765']);
  eq(W.allowedOrigins({ SITE_ORIGINS: 'https://a.example, https://b.example/ ,junk' }), ['https://a.example', 'https://b.example']);
});

test('CORS: listed origins are echoed, others get no allow-origin header; Vary: Origin always', async () => {
  const db = fakeD1({ meta: { last_block: 117271519, oldest_block: 115578971, last_run: 1794990990 } });
  for (const o of ['https://blamethestock.com', 'https://www.blamethestock.com', 'http://localhost:8765']) {
    const r = await call('/v1/health', { db, origin: o });
    eq(r.headers['access-control-allow-origin'], o);
    eq(r.headers.vary, 'Origin');
  }
  const bad = await call('/v1/health', { db, origin: 'https://blamethestock.com.evil.example' });
  eq(bad.headers['access-control-allow-origin'], undefined);
  eq(bad.status, 200, 'the JSON still answers');
  const none = await call('/v1/health', { db });
  eq(none.headers['access-control-allow-origin'], undefined);
});

test('preflight: 204, methods and headers, no body', async () => {
  const r = await call('/v1/copies?q=x', { method: 'OPTIONS', origin: 'https://blamethestock.com' });
  eq(r.status, 204);
  eq(r.body, null);
  eq(r.headers['access-control-allow-origin'], 'https://blamethestock.com');
  ok(/GET/.test(r.headers['access-control-allow-methods']) && /POST/.test(r.headers['access-control-allow-methods']));
  eq(r.headers['access-control-max-age'], '86400');
});

test('unknown path 404 and wrong method 405, both JSON and never cached', async () => {
  const a = await call('/v2/nothing');
  eq(a.status, 404);
  eq(a.json.ok, false);
  eq(a.headers['cache-control'], 'no-store');
  const b = await call('/v1/health', { method: 'DELETE' });
  eq(b.status, 405);
  eq(b.json.code, 'method');
  eq(b.headers['content-type'], 'application/json; charset=utf-8');
});

test('error codes map to HTTP statuses', () => {
  eq(W.statusFor('bad-input'), 400);
  eq(W.statusFor('not-found'), 404);
  eq(W.statusFor('rate-limited'), 429);
  eq(W.statusFor('rpc-failed'), 502);
  eq(W.statusFor('index-behind'), 503);
  eq(W.statusFor('something-new'), 502);
});

// =========================================================================================================
suite('worker › blame counter');

test('POST /v1/count adds one to today (UTC); GET /v1/stats gives today, total and the first day; nothing about the visitor', async () => {
  const db = fakeD1();
  const empty = await call('/v1/stats', { db });
  eq([empty.status, empty.json], [200, { ok: true, today: 0, total: 0, since: null, day: 'UTC', checks: { today: 0, total: 0 }, flags: { today: 0, total: 0 } }]);
  const DAY = 86400000, now = Date.UTC(2026, 10, 20, 15, 0, 0);
  for (let i = 0; i < 3; i++) eq((await call('/v1/count', { db, method: 'POST', now: now - DAY })).status, 200);
  for (let i = 0; i < 2; i++) eq((await call('/v1/count', { db, method: 'POST', now, origin: 'https://blamethestock.com' })).json, { ok: true });
  const st = await call('/v1/stats', { db, now, origin: 'https://blamethestock.com' });
  eq(st.json, { ok: true, today: 2, total: 5, since: '2026-11-19', day: 'UTC', checks: { today: 0, total: 0 }, flags: { today: 0, total: 0 } });
  eq(st.headers['access-control-allow-origin'], 'https://blamethestock.com');
  ok(/max-age=30/.test(st.headers['cache-control'] || ''), String(st.headers['cache-control']));
  eq([...db.counts.keys()].length, 2, 'one row per day, holding only a number');
  ok(db.log.every((q) => !/203\.0\.113\.7/.test(q)), 'no IP in any query');
});

test('the counter: POST only, rate limited, and a D1 failure is a quiet 503 (the site carries on)', async () => {
  eq((await call('/v1/count', { db: fakeD1() })).status, 405);
  const limiter = W.createRateLimiter({ limit: 2 });
  const db = fakeD1();
  for (let i = 0; i < 2; i++) eq((await call('/v1/count', { db, limiter, method: 'POST' })).status, 200);
  eq((await call('/v1/count', { db, limiter, method: 'POST' })).status, 429);
  eq(db.counts.size === 1 && [...db.counts.values()][0], 2, 'the refused one is not counted');
  const broken = fakeD1();
  broken.prepare = () => { throw new Error('D1 down'); };
  eq((await call('/v1/count', { db: broken, method: 'POST' })).json.code, 'unavailable');
  eq((await call('/v1/stats', { db: broken })).status, 503);
  eq((await call('/v1/count', { method: 'POST' })).status, 503, 'no database bound');
});

suite('worker › rate limit');

test('60 a minute per IP, then 429 with Retry-After; the next minute starts over', async () => {
  const limiter = W.createRateLimiter();
  const modules = { report: async () => ({ ok: false, code: 'not-found', message: 'x' }) };
  let last;
  for (let i = 0; i < 60; i++) {
    last = await call('/v1/report/' + TOKEN, { limiter, modules, now: NOW + i });
    ok(last.status !== 429, 'request ' + (i + 1) + ' allowed');
  }
  const over = await call('/v1/report/' + TOKEN, { limiter, modules, now: NOW + 61, origin: 'https://blamethestock.com' });
  eq(over.status, 429);
  eq(over.json.code, 'rate-limited');
  ok(Number(over.headers['retry-after']) >= 1 && Number(over.headers['retry-after']) <= 60);
  eq(over.headers['access-control-allow-origin'], 'https://blamethestock.com', 'the site can read the 429');
  const other = await call('/v1/report/' + TOKEN, { limiter, modules, now: NOW + 62, ip: '198.51.100.1' });
  ok(other.status !== 429, 'another visitor is not affected');
  const later = await call('/v1/report/' + TOKEN, { limiter, modules, now: NOW + 60000 });
  ok(later.status !== 429, 'a new minute');
});

test('health is never rate limited; MCP is', async () => {
  const limiter = W.createRateLimiter({ limit: 2 });
  const db = fakeD1({ meta: { last_block: 1 } });
  for (let i = 0; i < 5; i++) eq((await call('/v1/health', { limiter, db })).status, 200);
  let mcpCalls = 0;
  const mcp = async () => { mcpCalls++; return { fake: true }; };
  await call('/mcp', { limiter, mcp, method: 'POST' });
  await call('/mcp', { limiter, mcp, method: 'POST' });
  const third = await call('/mcp', { limiter, mcp, method: 'POST' });
  eq(third.status, 429);
  eq(mcpCalls, 2);
});

test('Cloudflare rate-limit binding: shared count blocks, a broken binding never blocks, only the IP is sent', async () => {
  const modules = { report: async () => ({ ok: false, code: 'not-found', message: 'x' }) };
  const seen = [];
  let allow = true;
  const rateBinding = { limit: async (o) => { seen.push(o); return { success: allow }; } };
  const a = await call('/v1/report/' + TOKEN, { limiter: W.createRateLimiter(), modules, rateBinding });
  ok(a.status !== 429);
  eq(seen, [{ key: '203.0.113.7' }], 'one call per request, keyed by IP only');
  allow = false;
  const b = await call('/v1/report/' + TOKEN, { limiter: W.createRateLimiter(), modules, rateBinding, origin: 'https://blamethestock.com' });
  eq([b.status, b.json.code, b.headers['retry-after']], [429, 'rate-limited', '60']);
  eq(b.headers['access-control-allow-origin'], 'https://blamethestock.com');
  const broken = { limit: async () => { throw new Error('binding down'); } };
  ok((await call('/v1/report/' + TOKEN, { limiter: W.createRateLimiter(), modules, rateBinding: broken })).status !== 429);
  const n = seen.length;
  eq((await call('/v1/health', { db: fakeD1({ meta: { last_block: 1 } }), rateBinding })).status, 200, 'health is never limited');
  eq(seen.length, n, 'health does not touch the binding');
  let mcpCalls = 0;
  eq((await call('/mcp', { rateBinding, mcp: async () => { mcpCalls++; return { fake: true }; }, method: 'POST' })).status, 429);
  eq(mcpCalls, 0);
});

// A project file (jsc only; null in a browser, where this check is skipped).
function readText(rel) {
  const url = import.meta.url;
  if (typeof read === 'function' && /^file:/.test(url)) {
    const dir = decodeURIComponent(url.replace(/^file:\/\//, '')).replace(/[^/]*$/, '');
    try { return read(dir + '../../' + rel); } catch (e) { return null; }
  }
  return null;
}

test('wrangler.toml has the rate-limit binding (60 a minute)', () => {
  const toml = readText('api/wrangler.toml');
  if (toml === null) return;
  ok(/\[\[ratelimits\]\]\s*\nname = "RATE_LIMITER"\s*\nnamespace_id = "\d+"\s*\nsimple = \{ limit = 60, period = 60 \}/.test(toml));
});

test('the limiter keeps only hashed keys, and forgets them each minute', () => {
  const l = W.createRateLimiter();
  l.hit('203.0.113.7', NOW);
  l.hit('2001:db8::1', NOW);
  eq(l.size(), 2);
  ok(l.keys().every((k) => !/203\.0\.113|2001:db8/.test(k)), 'no address in memory');
  l.hit('203.0.113.7', NOW + 60000);
  eq(l.size(), 1);
  const small = W.createRateLimiter({ maxKeys: 3 });
  for (let i = 0; i < 10; i++) small.hit('ip' + i, NOW);
  ok(small.size() <= 3, 'memory stays bounded');
});

// =========================================================================================================
suite('worker › health');

test('health shows the index: last block, oldest block, indexed from, complete, behind', async () => {
  const db = fakeD1({ meta: { last_block: 117271519, oldest_block: 115578971, last_run: 1794990990 }, oldest: { block: 115578971, time: 1794812800 } });
  const r = await call('/v1/health', { db });
  eq(r.status, 200);
  eq(r.json.ok, true);
  eq(r.json.index.lastBlock, 117271519);
  eq(r.json.index.oldestBlock, 115578971);
  eq(r.json.index.indexedFrom, '2026-11-16T07:06:40Z');
  eq(r.json.index.indexComplete, false);
  eq(r.json.index.lastRunAgoSeconds, 10);
  eq(r.json.index.behind, false);
  eq(r.headers['cache-control'], 'public, max-age=15');
  const stray = await call('/v1/health', { db: fakeD1({ meta: { last_block: 117271519, oldest_block: 116000000, last_run: 1794990990 }, oldest: { block: 101106733, time: 1793000000 } }) });
  eq(stray.json.index.indexedFrom, null, 'an older stray row is not the start of the indexed range');
  const done = await call('/v1/health', { db: fakeD1({ meta: { last_block: 5, oldest_block: 20000000, last_run: 1 } }) });
  eq(done.json.index.indexComplete, true);
  eq(done.json.index.behind, true);
});

test('health without a database or with an empty index', async () => {
  const none = await call('/v1/health');
  eq(none.status, 503);
  eq(none.json.ok, false);
  const empty = await call('/v1/health', { db: fakeD1() });
  eq(empty.json.index.ready, false);
  eq(empty.json.index.lastBlock, null);
});

// =========================================================================================================
suite('worker › copy check');

test('bad input answers 400 before any work', async () => {
  for (const q of ['', '%20%20', 'x'.repeat(101)]) {
    const r = await call('/v1/copies?q=' + q, { db: fakeD1() });
    eq(r.status, 400, 'q=' + q.slice(0, 10));
    eq(r.json.code, 'bad-input');
    eq(r.budget.used, 0);
  }
});

test('OBSYN: the four launches from the index in one request, no chain read, marked "facts: client", then cached', async () => {
  const fx = await loadFixture();
  const head = fx.index.head;
  const index = fixtureIndex(fx.index.rows, { lastBlock: head.number, lastRun: head.time });
  const db = fakeD1();
  const cache = fakeCache();
  const noNet = async () => { throw new Error('the Worker must not read the chain for a copy check'); };
  const r = await call('/v1/copies?q=OBSYN', { db, cache, index, fetch: noNet, now: head.time * 1000 });
  eq(r.status, 200);
  eq(r.json.status, 'done');
  eq(r.json.facts, 'client');
  ok(/browser/.test(r.json.factsNote) && /npx blamethestock-mcp/.test(r.json.factsNote), r.json.factsNote);
  eq(r.json.matches.length, 4);
  eq(r.json.totals, { exact: 4, near: 0, total: 4, listed: 4 });
  eq(r.budget.used, 2, 'one Cache API read and one write: nothing from the chain');
  const copy = r.json.matches.find((m) => m.address === OBSYN.copy);
  ok(copy && copy.pending === true && copy.match === 'exact' && copy.isOfficial === false);
  ok(/^0x[0-9a-f]{64}$/.test(copy.launch.tx) && Number.isFinite(copy.launch.block) && /Z$/.test(copy.launch.time));
  ok(/^0x[0-9a-f]{40}$/.test(copy.launchCreator) && /^0x[0-9a-f]{40}$/.test(copy.curve) && /^0x[0-9a-f]{40}$/.test(copy.factory));
  eq(copy.pairToken, '0x0000000000000000000000000000000000000000');
  eq(copy.creator, null, 'the dev wallet is read from the launch transaction, in the browser');
  ok(copy.missing.includes('devBuy') && copy.flags.length === 0);
  ok(/robinhoodchain\.blockscout\.com\/tx\//.test(copy.proof.launchTx) && /\/token\//.test(copy.proof.token));
  eq(r.json.verdict, '4 Pons coins use this name.');
  ok(r.json.caveats.some((c) => /Pons launches only/.test(c)));

  const again = await call('/v1/copies?q=OBSYN', { db, cache, index, fetch: noNet, now: head.time * 1000 });
  eq(again.status, 200);
  eq(again.json.matches.length, 4);
  eq(again.budget.used, 1, 'one Cache API read, nothing else');
  eq(again.headers['cache-control'], 'public, max-age=60');
  ok(db.cache.has('copies:OBSYN'), 'also kept in D1 for other data centres');
});

test('the browser\'s list + its own chain read give the same answer as reading everything in one place', async () => {
  const fx = await loadFixture();
  const direct = JSON.parse(JSON.stringify(await runScenario({ query: 'OBSYN' }, fx)));
  const head = fx.index.head;
  const index = fixtureIndex(fx.index.rows, { lastBlock: head.number, lastRun: head.time });
  const listing = (await call('/v1/copies?q=OBSYN', { db: fakeD1(), index, now: head.time * 1000 })).json;
  const fetchFn = replayFetch(fx);
  _setTransport({ fetch: fetchFn, sleep: noSleep, backoff: [0], timeouts: false });
  const progress = [];
  const r = await runCopyCheck('OBSYN', { api: async () => listing, fetch: fetchFn, sleep: noSleep, onProgress: (p) => progress.push(p.reading) });
  eq(JSON.stringify(r), JSON.stringify(direct), 'same CopyCheckResult');
  eq(progress[0], { done: 0, total: 4 });
  eq(progress[progress.length - 1], { done: 4, total: 4 });
});

test('an address the index doesn\'t have: the browser\'s name/symbol hint lists the same-name launches', async () => {
  const fx = await loadFixture();
  const head = fx.index.head;
  const index = fixtureIndex(fx.index.rows, { lastBlock: head.number, lastRun: head.time });
  const other = '0x00000000000000000000000000000000000000aa';
  const plain = await call('/v1/copies?q=' + other, { db: fakeD1(), index, now: head.time * 1000 });
  eq(plain.json.query.inIndex, false);
  eq(plain.json.query.isPons, null, 'unknown until the chain is read');
  eq(plain.json.matches.length, 0);
  const hinted = await call('/v1/copies?q=' + other + '&name=Obsyn&symbol=OBSYN', { db: fakeD1(), index, now: head.time * 1000 });
  eq(hinted.json.matches.length, 4);
  eq(hinted.json.query.isPons, false);
  eq(hinted.json.query.symbol, 'OBSYN');
});

test('a ticker whose search finds nothing is answered at once and cached', async () => {
  const fx = await loadFixture();
  const head = fx.index.head;
  const index = fixtureIndex(fx.index.rows, { lastBlock: head.number, lastRun: head.time });
  const db = fakeD1();
  const r = await call('/v1/copies?q=ZZQXNOTHING', { db, index, now: head.time * 1000 });
  eq(r.status, 200);
  eq(r.json.matches.length, 0);
  ok(db.cache.has('copies:ZZQXNOTHING'));
});

test('copy-check errors keep their code and are not cached', async () => {
  const db = fakeD1();
  const r = await call('/v1/copies?q=OBSYN', { db, index: { state: async () => ({ lastBlock: null }), findBySkeletons: async () => [], findByToken: async () => null } });
  eq(r.status, 503);
  eq(r.json.code, 'index-behind');
  eq(r.headers['cache-control'], 'no-store');
  eq(db.cache.size, 0);
});

test('index behind (cron stalled): the list says the index is catching up', async () => {
  const fx = await loadFixture();
  const head = fx.index.head;
  const index = fixtureIndex(fx.index.rows, { lastBlock: head.number, lastRun: head.time - 3600 });
  const r = await call('/v1/copies?q=OBSYN', { db: fakeD1(), index, now: head.time * 1000 });
  ok(r.json.notes.some((n) => /catching up/.test(n)), JSON.stringify(r.json.notes));
});

// =========================================================================================================
suite('worker › launch report and wallet links');

test('bad token: 400', async () => {
  const r = await call('/v1/report/0x1234', { db: fakeD1() });
  eq(r.status, 400);
  eq(r.json.code, 'bad-address');
  const l = await call('/v1/report/0x1234/links', { db: fakeD1() });
  eq(l.status, 400);
});

test('report: the launch basics from the index (no chain read) with a note that the browser builds the report', async () => {
  const fx = await loadFixture();
  const index = fixtureIndex(fx.index.rows, { lastBlock: 1, lastRun: 1 });
  const r = await call('/v1/report/' + TOKEN.toUpperCase().replace('0X', '0x'), { db: fakeD1(), index, fetch: async () => { throw new Error('no chain'); } });
  eq(r.status, 200);
  eq(r.json.status, 'basics');
  eq(r.json.clientSide, true);
  eq(r.json.inIndex, true);
  eq(r.json.token.address, TOKEN);
  eq(r.json.token.symbol, 'OBSYN');
  eq(r.json.token.pons.launchTime, '2026-11-17T14:14:00Z');
  eq(r.json.launch.token, TOKEN);
  ok(/^0x[0-9a-f]{64}$/.test(r.json.launch.tx) && Number.isFinite(r.json.launch.time));
  ok(/browser/.test(r.json.note) && /npx blamethestock-mcp/.test(r.json.note));
  eq(r.headers['cache-control'], 'public, max-age=60');
  eq(r.budget.used, 0);
  const none = await call('/v1/report/0x00000000000000000000000000000000000000aa', { db: fakeD1(), index });
  eq([none.status, none.json.status, none.json.inIndex, none.json.launch], [200, 'basics', false, null]);
});

test('links: a note that wallet links are checked in the browser', async () => {
  const r = await call('/v1/report/' + TOKEN + '/links', { db: fakeD1() });
  eq(r.status, 200);
  eq(r.json.status, 'client');
  ok(/browser/.test(r.json.note));
  eq(r.json.links, []);
});

// =========================================================================================================
suite('worker › MCP route');

test('/mcp goes to the MCP handler with the shared routes as its api', async () => {
  let got = null;
  const mcp = async (request, env, ctx, opts) => { got = opts; return { fake: 'response' }; };
  const db = fakeD1();
  const r = await call('/mcp', { method: 'POST', mcp, db });
  eq(r.raw, { fake: 'response' });
  ok(got && typeof got.api.copies === 'function' && typeof got.api.report === 'function' && typeof got.api.links === 'function');
  ok(got.budget && got.settings && typeof got.now === 'number');
});

test('MCP api.report and api.copies answer from the index', async () => {
  const fx = await loadFixture();
  const head = fx.index.head;
  const index = fixtureIndex(fx.index.rows, { lastBlock: head.number, lastRun: head.time });
  let got = null;
  const mcp = async (request, env, ctx, opts) => { got = opts; return {}; };
  await call('/mcp', { method: 'POST', mcp, db: fakeD1(), index, now: head.time * 1000 });
  const a = await got.api.report(TOKEN);
  eq([a.status, a.token.symbol], ['basics', 'OBSYN']);
  const c = await got.api.copies('OBSYN');
  eq([c.facts, c.matches.length], ['client', 4]);
  eq((await got.api.links(TOKEN)).status, 'client');
});

// =========================================================================================================
suite('worker › cron');

test('scheduled: the indexer runs in its own 40-subrequest share, dRPC in 100-block pieces, then old rows are purged', async () => {
  const db = fakeD1();
  let indexerEnv = null, opts = null;
  const runIndexer = async (env, o) => { indexerEnv = env; opts = o; await env.DB.prepare(W.SQL_META).all(); return { ok: true, from: 1, to: 2, written: 0 }; };
  const budget = createBudget({ limit: 45, d1Limit: 45 });
  const out = await W.withBudget(budget, () => W.runScheduled({ DB: db }, { now: NOW, budget, runIndexer, log: () => {} }));
  ok(indexerEnv && indexerEnv.DB.__budgeted, 'the indexer gets a counted DB');
  eq(out.indexer.written, 0);
  eq(out.indexerBudget.limit, 40);
  eq([opts.logSpan, opts.maxLogRequests, opts.maxRows, opts.maxBlocks], [100, 22, 15, 6600]);
  ok(out.purged);
  ok(out.budget.d1Used <= 45);
});

test('scheduled: an indexer failure is reported, not thrown; no DB is reported, not thrown', async () => {
  const db = fakeD1();
  const lines = [];
  const out = await W.runScheduled({ DB: db }, { now: NOW, runIndexer: async () => { throw new Error('rpc down'); }, log: (t) => lines.push(t) });
  eq(out.indexer.ok, false);
  ok(out.purged);
  ok(lines.some((l) => /rpc down/.test(l)));
  const none = await W.runScheduled({}, { now: NOW, log: () => {} });
  eq(none.indexer.ok, false);
});

test('the Worker asks the official node last (it answers 429 to Cloudflare)', async () => {
  const budget = createBudget({ limit: 45 });
  let order = null;
  await W.withBudget(budget, async () => { order = byHealth(['official', 'publicnode', 'drpc']); });
  eq(order, ['publicnode', 'drpc', 'official']);
  _setTransport({});
  eq(byHealth(['official', 'publicnode', 'drpc']), ['official', 'publicnode', 'drpc'], 'the site keeps its own order');
});

// =========================================================================================================
suite('worker › budget');

test('fetches past the limit are refused without a network call; JSON-RPC calls get a per-call error', async () => {
  let real = 0;
  const b = createBudget({ limit: 2, fetch: async () => { real++; return { ok: true, status: 200 }; } });
  await b.fetch('https://x');
  await b.fetch('https://x');
  const rpcBody = JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }, { jsonrpc: '2.0', id: 2, method: 'eth_chainId', params: [] }]);
  const res = await b.fetch('https://rpc', { method: 'POST', body: rpcBody });
  eq(real, 2);
  eq(b.refused, 1);
  ok(b.exhausted);
  ok(isRefusal(res));
  const body = await res.json();
  eq(body.map((x) => x.id), [1, 2]);
  eq(body[0].error.code, -32099);
  const plain = await b.fetch('https://explorer/api');
  eq(plain.status, 503);
  eq(refusal(undefined).status, 503);
});

test('reserve, child budgets and D1 counting', async () => {
  const b = createBudget({ limit: 45, d1Limit: 3, fetch: async () => ({ ok: true }) });
  const r1 = b.reserve(20), r2 = b.reserve(20), r3 = b.reserve(20);
  ok(r1 && r2 && !r3, 'only two coins fit at once');
  r1();
  r1();
  eq(b.reserved, 20, 'release is idempotent');
  r2();
  const c = b.child(10);
  for (let i = 0; i < 12; i++) await c.fetch('x');
  eq(c.used, 10);
  eq(b.used, 10, 'a child spends from its parent');
  const db = wrapDb(fakeD1(), b);
  await db.prepare(W.SQL_META).all();
  await db.batch([]);
  await db.prepare(W.SQL_META).first();
  let threw = null;
  try { await db.prepare(W.SQL_META).all(); } catch (e) { threw = e; }
  ok(threw instanceof BudgetExceeded, 'over the D1 limit');
  eq(b.d1Used, 3);
});

test('requests from another isolate task are counted on their own budget (dispatcher)', async () => {
  const a = createBudget({ limit: 5, fetch: async () => ({ ok: true }) });
  const b = createBudget({ limit: 5, fetch: async () => ({ ok: true }) });
  await W.withBudget(a, () => W.routedFetch('x'));
  await W.withBudget(b, async () => { await W.routedFetch('x'); await W.routedFetch('y'); });
  eq(a.used, 1);
  eq(b.used, 2);
});

test('each request gets its own rpc.js lane table (a Worker may not wake one request\'s promise from another)', async () => {
  const I = worker.internals;
  const a = createBudget({ limit: 5 }), b = createBudget({ limit: 5 });
  let ta, tb, ta2;
  await I.withBudget(a, async () => { ta = I.requestLanes(); ta2 = I.requestLanes(); });
  await I.withBudget(b, async () => { tb = I.requestLanes(); });
  ok(ta && tb && ta !== tb, 'different tables');
  ok(ta === ta2, 'same table within one request');
  eq(I.requestLanes(), null, 'outside a request: the shared table');
});

test('alerts: rows -> one alert per new coin, with the graduated coin and how many graduated coins share the name', () => {
  const a = '0x' + '1'.repeat(40), b = '0x' + '2'.repeat(40), c = '0x' + '3'.repeat(40);
  const rows = [
    { token: a, symbol: 'MEOW', name: 'Meow', time: 1000, tx_from: null, creator: c, tx: '0x' + 'f'.repeat(64), o_token: b, o_symbol: 'MEOW', o_name: 'Meow', o_grad_block: 5, o_grad_tx: '0x' + 'e'.repeat(64), kind: 'ticker', o_count: 26 },
    { token: a, symbol: 'MEOW', name: 'Meow', time: 1000, o_token: b, kind: 'name', o_count: 26 },
    { token: 'nope', o_token: b },
  ];
  const out = alertsFromRows(rows, 1600);
  eq(out.length, 1);
  eq(out[0].copy.ageSeconds, 600);
  eq(out[0].copy.dev, c);
  eq([out[0].graduated.address, out[0].matchedOn, out[0].graduatedSameName], [b, 'ticker', 26]);
  ok(/graduations g ON g\.sym_skel = r\.sym_skel/.test(SQL_ALERTS) && /length\(r\.sym_skel\) >= 3/.test(SQL_ALERTS), 'matched by index, short names left out');
});

test('radar: % of the curve threshold, graduated and unread curves left out, highest first', () => {
  const t = (n) => '0x' + String(n).repeat(40);
  const rows = [1, 2, 3, 4].map((n) => ({ token: t(n), curve: t(n + 4), symbol: 'C' + n, block: 100 + n, time: 1000, tx: '0x' + 'a'.repeat(64), creator: t(9), graduation_threshold: '4200000000000000000' }));
  const reads = [
    { quote: 2100000000000000000n, graduated: false },
    { quote: 4200000000000000000n, graduated: true },
    null,
    { quote: 420000000000000000n, graduated: false },
  ];
  const out = radarFrom(rows, reads, 1600);
  eq(out.map((c) => [c.symbol, c.pct]), [['C1', 50], ['C4', 10]]);
  eq([out[0].ethIn, out[0].thresholdEth, out[0].ageSeconds], [2.1, 4.2, 600]);
  ok(/pair_token = '0x0{40}'/.test(SQL_RADAR) && /NOT EXISTS \(SELECT 1 FROM graduations/.test(SQL_RADAR), 'ETH pairs only, graduated coins left out');
});

test('counter: coins checked and copies flagged, one number per day and kind; bad kinds and amounts refused', async () => {
  const db = fakeD1();
  eq((await call('/v1/count?kind=check', { db, method: 'POST' })).status, 200);
  eq((await call('/v1/count?kind=flag&n=3', { db, method: 'POST' })).status, 200);
  eq((await call('/v1/count', { db, method: 'POST' })).status, 200, 'no kind = a blame, as before');
  eq((await call('/v1/count?kind=visitor', { db, method: 'POST' })).status, 400);
  eq((await call('/v1/count?kind=flag&n=50', { db, method: 'POST' })).status, 400);
  eq([...db.events.values()], [1, 3]);
  const j = (await call('/v1/stats', { db })).json;
  eq([j.today, j.checks, j.flags], [1, { today: 1, total: 1 }, { today: 3, total: 3 }]);
});
