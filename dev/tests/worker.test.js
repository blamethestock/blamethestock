// API Worker core (api/src/worker.js via its default export's `internals`, api/src/budget.js): routing, CORS, rate limit, caching, staged copy check,
// report/link jobs, the cron, and the subrequest budget. Runs in jsc with fakes: no network, no Cloudflare.
import { suite, test, eq, ok } from './harness.js';
import worker from '../../api/src/worker.js';
import { createBudget, refusal, isRefusal, wrapDb, BudgetExceeded } from '../../api/src/budget.js';
import { _setTransport } from '../../site/src/data/rpc.js';
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
  const db = { cache, jobs, meta, queries: 0, log: [] };
  const exec = (sql, a) => {
    db.log.push(sql);
    if (W.SQL_SCHEMA.includes(sql)) return { results: [] };
    switch (sql) {
      case W.SQL_CACHE_GET: { const r = cache.get(a[0]); return { results: r && r.expires > a[1] ? [{ body: r.body }] : [] }; }
      case W.SQL_CACHE_PUT: cache.set(a[0], { body: a[1], expires: a[2] }); return { results: [] };
      case W.SQL_CACHE_PURGE: for (const [k, v] of [...cache]) if (v.expires <= a[0]) cache.delete(k); return { results: [] };
      case W.SQL_JOB_UPSERT: {
        const j = jobs.get(a[0]);
        if (j) j.progress = a[4];
        else jobs.set(a[0], { key: a[0], kind: a[1], token: a[2], created: a[3], touched: a[3], attempts: 0, progress: a[4] });
        return { results: [] };
      }
      case W.SQL_JOBS_NEXT: return { results: [...jobs.values()].sort((x, y) => x.touched - y.touched).slice(0, a[0]).map((j) => ({ ...j })) };
      case W.SQL_JOB_TOUCH: { const j = jobs.get(a[0]); if (j) { j.touched = a[1]; j.attempts++; j.progress = a[2]; } return { results: [] }; }
      case W.SQL_JOB_DELETE: jobs.delete(a[0]); return { results: [] };
      case W.SQL_JOBS_PURGE: for (const [k, j] of [...jobs]) if (j.created <= a[0]) jobs.delete(k); return { results: [] };
      case W.SQL_META: return { results: Object.entries(meta).map(([key, value]) => ({ key, value: String(value) })) };
      case W.SQL_OLDEST_TIME: return { results: oldest && oldest.block >= a[0] ? [{ time: oldest.time }] : [] };
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
    now: o.now || NOW, budget, db, moduleEnv: { DB: db }, settings: o.settings || W.settingsFor({}),
    cache: o.cache ? o.cache.bind(budget) : null, limiter: o.limiter || null, index: o.index, modules: o.modules,
    mcp: o.mcp, origins: o.origins,
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

test('OBSYN under a 45-subrequest budget: built in steps, same answer as one big run, then cached', async () => {
  const fx = await loadFixture();
  const direct = JSON.parse(JSON.stringify(await runScenario({ query: 'OBSYN' }, fx)));
  ok(direct.ok && direct.matches.length === 4, 'fixture answer');

  _setTransport({ sleep: noSleep, backoff: [0], timeouts: false });
  const head = fx.index.head;
  const index = fixtureIndex(fx.index.rows, { lastBlock: head.number, lastRun: head.time });
  const db = fakeD1();
  const cache = fakeCache();
  const seen = [];
  let r;
  for (let i = 0; i < 10; i++) {
    r = await call('/v1/copies?q=OBSYN', { db, cache, index, fetch: replayFetch(fx), now: head.time * 1000 });
    seen.push(r.status);
    ok(r.budget.used <= 45, 'request ' + (i + 1) + ' stayed within 45 subrequests (' + r.budget.used + ')');
    if (r.status !== 202) break;
    eq(r.json.status, 'building');
    eq(r.headers['cache-control'], 'no-store');
    ok(r.json.progress >= 0 && r.json.progress < 1);
  }
  ok(seen.length >= 2 && seen[0] === 202, 'needed more than one request: ' + seen.join(','));
  eq(r.status, 200);
  eq(r.json.status, 'done');
  const { status, ...rest } = r.json;
  eq(JSON.stringify(rest), JSON.stringify(direct), 'staged answer equals the direct one');
  ok(r.json.verdict.length > 0);

  const again = await call('/v1/copies?q=OBSYN', { db, cache, index, fetch: async () => { throw new Error('should not fetch'); }, now: head.time * 1000 });
  eq(again.status, 200);
  eq(again.json.matches.length, 4);
  eq(again.budget.used, 1, 'one Cache API read, nothing else');
  eq(again.headers['cache-control'], 'public, max-age=60');
  ok(db.cache.has('copies:OBSYN'), 'also kept in D1 for other data centres');
});

test('a ticker whose search finds nothing is answered at once and cached', async () => {
  const fx = await loadFixture();
  _setTransport({ sleep: noSleep, backoff: [0], timeouts: false });
  const head = fx.index.head;
  const index = fixtureIndex(fx.index.rows, { lastBlock: head.number, lastRun: head.time });
  const db = fakeD1();
  const r = await call('/v1/copies?q=ZZQXNOTHING', { db, index, fetch: replayFetch(fx), now: head.time * 1000 });
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

test('staged gather: a coin that never fits keeps its partial facts so polling always ends', async () => {
  const budget = createBudget({ limit: 45 });
  const db = fakeD1();
  const stage = { total: 0, done: 0, fresh: 0, started: 0, pending: 0, partials: [] };
  const gather = W.stagedGather({ db: budget.wrapDb(db), now: NOW, budget, gather: async () => { budget.take(budget.hardRoom()); budget.fetch('x'); return { missing: ['holders'] }; } }, stage);
  const f = await gather({ token: '0xAB' }, {});
  eq(f, { missing: ['holders'] });
  eq(stage.pending, 1);
  eq(stage.partials.length, 1);
  eq(stage.fresh, 0);
});

// =========================================================================================================
suite('worker › launch report and wallet links');

test('report module not there yet: 503 unavailable, nothing cached', async () => {
  const db = fakeD1();
  const r = await call('/v1/report/' + TOKEN, { db, modules: { report: null } });
  eq(r.status, 503);
  eq(r.json.code, 'unavailable');
  eq(db.cache.size, 0);
});

test('bad token: 400 and the module is never called', async () => {
  let called = 0;
  const r = await call('/v1/report/0x1234', { modules: { report: async () => { called++; } } });
  eq(r.status, 400);
  eq(r.json.code, 'bad-address');
  eq(called, 0);
});

test('report: building -> 202 + queued job; done -> 200 + cached, the module is not asked again', async () => {
  const db = fakeD1();
  const cache = fakeCache();
  let step = 0;
  const seen = [];
  const report = async (args) => {
    seen.push(args);
    step++;
    return step < 3 ? { ok: true, status: 'building', progress: step / 3 } : { ok: true, status: 'done', token: { address: args.token }, verdict: 'v' };
  };
  const a = await call('/v1/report/' + TOKEN.toUpperCase().replace('0X', '0x'), { db, cache, modules: { report } });
  eq(a.status, 202);
  eq(a.json.status, 'building');
  eq(a.headers['cache-control'], 'no-store');
  ok(db.jobs.has('report:' + TOKEN), 'job queued under the lowercase token');
  eq(seen[0].token, TOKEN);
  ok(seen[0].budget && typeof seen[0].budget.fetch === 'function' && seen[0].env && seen[0].env.DB, 'contract args');
  ok(typeof seen[0].now === 'number' && seen[0].settings && seen[0].settings.trust);
  await call('/v1/report/' + TOKEN, { db, cache, modules: { report } });
  eq(db.jobs.get('report:' + TOKEN).progress, 2 / 3, 'the job keeps the latest progress');
  const c = await call('/v1/report/' + TOKEN, { db, cache, modules: { report } });
  eq(c.status, 200);
  eq(c.json.status, 'done');
  eq(c.headers['cache-control'], 'public, max-age=60');
  ok(/^sub=\d+\/45; d1=\d+\/45; refused=0$/.test(c.headers['x-bts-budget']));
  const d = await call('/v1/report/' + TOKEN, { db, cache, modules: { report } });
  eq(d.json.verdict, 'v');
  eq(step, 3, 'served from the cache');
});

test('report errors keep their code; a crash is a plain 503', async () => {
  const nf = await call('/v1/report/' + TOKEN, { db: fakeD1(), modules: { report: async () => ({ ok: false, code: 'not-pons', message: 'Not a Pons coin.' }) } });
  eq(nf.status, 404);
  eq(nf.json, { ok: false, code: 'not-pons', message: 'Not a Pons coin.' });
  const boom = await call('/v1/report/' + TOKEN, { db: fakeD1(), modules: { report: async () => { throw new Error('x'); } } });
  eq(boom.status, 503);
  eq(boom.json.ok, false);
});

test('links: "unavailable" is answered as is, not cached and not queued', async () => {
  const db = fakeD1();
  const links = async () => ({ ok: true, status: 'unavailable', funders: [], links: [], ignored: [], caveat: 'c' });
  const r = await call('/v1/report/' + TOKEN + '/links', { db, modules: { links } });
  eq(r.status, 200);
  eq(r.json.status, 'unavailable');
  eq(r.headers['cache-control'], 'no-store');
  eq(db.cache.size, 0);
  eq(db.jobs.size, 0);
  const done = await call('/v1/report/' + TOKEN + '/links', { db, modules: { links: async () => ({ ok: true, status: 'done', funders: [], links: [], ignored: [], caveat: 'c' }) } });
  eq(done.status, 200);
  ok(db.cache.has('links:' + TOKEN));
});

// =========================================================================================================
suite('worker › MCP route');

test('/mcp goes to the MCP handler with the shared routes as its api', async () => {
  let got = null;
  const mcp = async (request, env, ctx, opts) => { got = opts; return { fake: 'response' }; };
  const db = fakeD1();
  const r = await call('/mcp', { method: 'POST', mcp, db, modules: { report: async () => ({ ok: true, status: 'done', verdict: 'x' }) } });
  eq(r.raw, { fake: 'response' });
  ok(got && typeof got.api.copies === 'function' && typeof got.api.report === 'function' && typeof got.api.links === 'function');
  ok(got.budget && got.settings && typeof got.now === 'number');
});

test('MCP api.report shares the route cache', async () => {
  let got = null, n = 0;
  const mcp = async (request, env, ctx, opts) => { got = opts; return {}; };
  const db = fakeD1();
  const modules = { report: async () => { n++; return { ok: true, status: 'done', verdict: 'x' }; } };
  await call('/mcp', { method: 'POST', mcp, db, modules });
  const a = await got.api.report(TOKEN);
  eq(a.verdict, 'x');
  const b = await call('/v1/report/' + TOKEN, { db, modules });
  eq(b.json.verdict, 'x');
  eq(n, 1, 'the route read the answer the MCP call cached');
});

// =========================================================================================================
suite('worker › cron');

test('scheduled: indexer runs inside its own share of the budget, then jobs move on', async () => {
  const db = fakeD1();
  db.jobs.set('report:a', { key: 'report:a', kind: 'report', token: '0xa', created: NOW / 1000 - 10, touched: 1, attempts: 0, progress: 0 });
  db.jobs.set('links:b', { key: 'links:b', kind: 'links', token: '0xb', created: NOW / 1000 - 10, touched: 2, attempts: 0, progress: 0 });
  db.jobs.set('report:old', { key: 'report:old', kind: 'report', token: '0xc', created: NOW / 1000 - 4000, touched: 0, attempts: 0, progress: 0 });
  let indexerEnv = null;
  const runIndexer = async (env) => { indexerEnv = env; await env.DB.prepare(W.SQL_META).all(); return { ok: true, from: 1, to: 2, written: 0 }; };
  const modules = {
    report: async ({ token, budget }) => { ok(budget.remaining() > 0); return { ok: true, status: 'building', progress: 0.5 }; },
    links: async () => ({ ok: true, status: 'done', funders: [], links: [] }),
  };
  const budget = createBudget({ limit: 45, d1Limit: 45 });
  const out = await W.withBudget(budget, () => W.runScheduled({ DB: db }, { now: NOW, budget, runIndexer, modules, log: () => {} }));
  ok(indexerEnv && indexerEnv.DB.__budgeted, 'the indexer gets a counted DB');
  eq(out.indexer.written, 0);
  eq(out.jobs.map((j) => j.result), ['dropped', 'building', 'done']);
  eq(db.jobs.get('report:a').attempts, 1);
  eq(db.jobs.get('report:a').progress, 0.5);
  ok(!db.jobs.has('links:b') && db.cache.has('links:0xb'), 'finished job cached and removed');
  ok(!db.jobs.has('report:old'), 'too old: dropped');
  ok(out.purged);
  ok(out.budget.d1Used <= 45);
});

test('scheduled: an indexer failure does not stop the jobs; no DB is reported, not thrown', async () => {
  const db = fakeD1();
  db.jobs.set('links:b', { key: 'links:b', kind: 'links', token: '0xb', created: NOW / 1000, touched: 2, attempts: 0, progress: 0 });
  const lines = [];
  const out = await W.runScheduled({ DB: db }, { now: NOW, runIndexer: async () => { throw new Error('rpc down'); }, modules: { report: null, links: async () => ({ ok: true, status: 'done' }) }, log: (t) => lines.push(t) });
  eq(out.indexer.ok, false);
  eq(out.jobs[0].result, 'done');
  ok(lines.some((l) => /rpc down/.test(l)));
  const none = await W.runScheduled({}, { now: NOW, log: () => {} });
  eq(none.indexer.ok, false);
});

test('scheduled: stops starting jobs when the budget is nearly spent', async () => {
  const db = fakeD1();
  for (let i = 0; i < 3; i++) db.jobs.set('report:' + i, { key: 'report:' + i, kind: 'report', token: '0x' + i, created: NOW / 1000, touched: i, attempts: 0, progress: 0 });
  const budget = createBudget({ limit: 45 });
  let calls = 0;
  const modules = { links: null, report: async ({ budget: b }) => { calls++; b.take(b.hardRoom() - 5); return { ok: true, status: 'building', progress: 0.1 }; } };
  await W.runScheduled({ DB: db }, { now: NOW, budget, runIndexer: async () => ({ ok: true }), modules, log: () => {} });
  eq(calls, 1);
  ok(budget.used <= 45);
});

// =========================================================================================================
test('modules with their own job table: the cron calls their advancers; requests don\'t queue in api_jobs', async () => {
  const db = fakeD1();
  const got = {};
  const mk = (kind) => ({
    [kind === 'report' ? 'launchReport' : 'walletLinks']: async () => ({ ok: true, status: 'building', progress: 0.2 }),
    [kind === 'report' ? 'advanceReportJobs' : 'advanceLinkJobs']: async (args) => { got[kind] = args; args.budget.fetch('x'); return { advanced: ['0xa'], done: [] }; },
  });
  const modules = { report: mk('report'), links: mk('links') };
  const r = await call('/v1/report/' + TOKEN, { db, modules });
  eq(r.status, 202);
  eq(db.jobs.size, 0, 'report.js keeps its own queue');
  const budget = createBudget({ limit: 45, fetch: async () => ({ ok: true }) });
  const out = await W.runScheduled({ DB: db }, { now: NOW, budget, runIndexer: async () => ({ ok: true }), modules, log: () => {} });
  ok(got.report && got.links, 'both advancers ran');
  ok(got.report.env.DB.__budgeted && typeof got.report.settings === 'object' && got.report.now === NOW);
  ok(got.report.budget.limit < 45 && got.report.budget.limit >= 10, 'the report gets a share, not everything: ' + got.report.budget.limit);
  eq(budget.used, 2, 'their fetches count on the cron budget');
  eq(out.jobs.map((j) => j.result), ['advanced 1, done 0', 'advanced 1, done 0']);
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
