// Blame the Stock API: the Cloudflare Worker at https://api.blamethestock.com. Read-only.
//
//   GET  /v1/health                    the launch index: last block, oldest block, indexed from, complete?
//   GET  /v1/copies?q=OBSYN|0x…        copy check (api/src/copies.js)
//   GET  /v1/report/{token}            launch report (api/src/report.js)
//   GET  /v1/report/{token}/links      wallet links, loaded after the report (api/src/links.js)
//   POST|GET|DELETE /mcp               MCP, Streamable HTTP (api/src/mcp.js)
//   scheduled()                        every minute: the launch indexer, then queued report/link jobs
//
// Built for the Workers FREE plan: at most 50 subrequests (fetch, Cache API), 50 D1 queries and ~10 ms of CPU per
// request. Every request and cron run gets a budget (api/src/budget.js) that counts what it spends. Heavy answers
// are built in small persisted steps: a request does what fits, saves it in D1 and answers
//   { ok: true, status: 'building', progress: 0..1 }   (HTTP 202, never cached)
// and the client asks again in a couple of seconds. The cron also moves queued report/link jobs on.
//
// Caching: finished answers go to the Cache API (this data centre) and to the D1 table api_cache (everywhere),
// keyed only by the token or the query. Never by anything about the visitor.
//
// Privacy: no IP address or user agent is ever logged or stored. The rate limit (60 requests a minute) is kept
// in this isolate's memory only, keyed by a hash of the IP, and forgotten every minute.
//
// The pure parts (URL parsing, CORS, rate limit, routing, caching rules, staging, jobs) take their platform
// pieces as `deps`, so dev/tests/worker.test.js runs them in jsc with fakes.
import { createBudget, DEFAULT_LIMIT, DEFAULT_D1_LIMIT } from './budget.js';
import { copyCheck, d1Index } from './copies.js';
import { runIndexer } from './indexer.js';
import { INDEX_FLOOR } from './env.js';
import { SETTINGS } from '../../site/settings.js';
import { _setTransport, _setLaneScope } from '../../site/src/data/rpc.js';
import { gatherFacts } from '../../site/src/trust/facts.js';

const VERSION = '0.1.0';
const DEFAULT_ORIGINS = ['https://blamethestock.com', 'https://www.blamethestock.com', 'http://localhost:8765'];

const RATE = { perMinute: 60, windowMs: 60000, maxKeys: 10000 };

// Seconds a finished answer is kept (shared cache: Cache API + D1). Browsers keep it for BROWSER_SECONDS.
const TTL = {
  copies: 300,          // live facts (holders, liquidity, sells): 5 minutes
  report: 120,          // launch report: 2 minutes here (report.js keeps its own 5-minute cache and refreshes it)
  links: 21600,         // wallet links: who funded the first buyers doesn't change; 6 hours
  facts: 300,           // one coin's facts inside a copy check that is being built
  partialFacts: 60,     // a coin whose facts didn't fit even a whole request: kept as they are for a minute
};
const BROWSER_SECONDS = 60;
const HEALTH_SECONDS = 15;

// Staged copy check: one coin's full read takes about 16-20 subrequests (measured on the OBSYN fixtures).
const FACT_RESERVE = 20;
// A poll where no coin fitted although earlier polls read some (the search itself cost more this time, e.g. RPC
// retries or the slower fallback node): answer 'building' again up to this many times before giving the partial
// answer, so a passing slow-down doesn't turn into a half-blank result.
const COPIES_STALLS = 3;
const STALL_SECONDS = 120;

// Queued report/link jobs, moved on by the cron.
const JOBS = { perRun: 4, minRoom: 10, maxAttempts: 40, maxAgeSeconds: 1800 };

// The cron: the indexer may use this many subrequests; the rest goes to queued jobs. A run reads at most
// INDEXER_MAX_BLOCKS blocks (under 100k, so one eth_getLogs covers every factory) and writes at most
// INDEXER_MAX_ROWS launches, so their block times fit a few batches (the official node takes 6 per batch).
// A normal minute is ~575 blocks and ~0.5 launches; after an outage it catches up ~30 launches a minute.
const INDEXER_SUBREQUESTS = 25;
const INDEXER_MAX_BLOCKS = 50000;
const INDEXER_MAX_ROWS = 30;

// ---- D1: the Worker's own two tables (created on first use; also in docs/API.md) ----------------------------
const SQL_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS api_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache (expires)',
  'CREATE TABLE IF NOT EXISTS api_jobs (key TEXT PRIMARY KEY, kind TEXT NOT NULL, token TEXT NOT NULL, created INTEGER NOT NULL, touched INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress REAL)',
  'CREATE INDEX IF NOT EXISTS idx_api_jobs_touched ON api_jobs (touched)',
  'CREATE INDEX IF NOT EXISTS idx_api_jobs_created ON api_jobs (created)',
];
const SQL_META = 'SELECT key, value FROM meta';
const SQL_OLDEST_TIME = 'SELECT time FROM launches WHERE block >= ?1 ORDER BY block ASC LIMIT 1';
const SQL_NEWEST_AT = 'SELECT block, time FROM launches WHERE block <= ?1 ORDER BY block DESC LIMIT 1';
const BLOCK_SECONDS = 0.1045;    // Robinhood Chain's average block time (same figure as copies.js)
const BEHIND_SECONDS = 600;
const SQL_CACHE_GET = 'SELECT body FROM api_cache WHERE key = ?1 AND expires > ?2';
const SQL_CACHE_PUT = 'INSERT INTO api_cache (key, body, expires) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET body = excluded.body, expires = excluded.expires';
const SQL_CACHE_PURGE = 'DELETE FROM api_cache WHERE key IN (SELECT key FROM api_cache WHERE expires <= ?1 LIMIT 500)';
const SQL_JOB_UPSERT = 'INSERT INTO api_jobs (key, kind, token, created, touched, attempts, progress) VALUES (?1, ?2, ?3, ?4, ?4, 0, ?5) ON CONFLICT(key) DO UPDATE SET progress = excluded.progress';
const SQL_JOBS_NEXT = 'SELECT key, kind, token, created, attempts FROM api_jobs ORDER BY touched ASC LIMIT ?1';
const SQL_JOB_TOUCH = 'UPDATE api_jobs SET touched = ?2, attempts = attempts + 1, progress = ?3 WHERE key = ?1';
const SQL_JOB_DELETE = 'DELETE FROM api_jobs WHERE key = ?1';
const SQL_JOBS_PURGE = 'DELETE FROM api_jobs WHERE key IN (SELECT key FROM api_jobs WHERE created <= ?1 LIMIT 500)';

// =============================================================================================================
// Small pure helpers
// =============================================================================================================
const isAddr = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
const nowSeconds = (ms) => Math.floor(ms / 1000);
const iso = (unix) => (unix == null || !Number.isFinite(Number(unix)) ? null : new Date(Number(unix) * 1000).toISOString().replace('.000Z', 'Z'));
const errText = (e) => String((e && e.message) || e).slice(0, 200);

// URL -> { origin, pathname, params } without the URL class (jsc has none).
function parseUrl(url) {
  const m = /^([a-z][a-z0-9+.-]*:)\/\/([^/?#]*)([^?#]*)(?:\?([^#]*))?/i.exec(String(url || ''));
  if (!m) return { origin: '', pathname: '/', params: { get: () => null, has: () => false } };
  const map = new Map();
  for (const part of (m[4] || '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = dec(i < 0 ? part : part.slice(0, i));
    const v = dec(i < 0 ? '' : part.slice(i + 1));
    if (k !== null && v !== null && !map.has(k)) map.set(k, v);
  }
  return {
    origin: (m[1] + '//' + m[2]).toLowerCase(),
    pathname: m[3] || '/',
    params: { get: (k) => (map.has(k) ? map.get(k) : null), has: (k) => map.has(k) },
  };
}
function dec(s) {
  try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch (e) { return null; }
}

// SITE_ORIGINS var ("https://a, https://b") -> list; the three defaults when unset.
function allowedOrigins(env) {
  const raw = env && typeof env.SITE_ORIGINS === 'string' ? env.SITE_ORIGINS : '';
  const list = raw.split(/[\s,]+/).map((s) => s.trim().replace(/\/+$/, '').toLowerCase()).filter((s) => /^https?:\/\/[^/]+$/.test(s));
  return list.length ? list : DEFAULT_ORIGINS.slice();
}

// CORS headers for one request. Only the listed site origins get Access-Control-Allow-Origin; other callers
// (scripts, MCP clients) get the JSON without it, which is fine for anything that isn't a browser.
function corsHeaders(origin, allowed) {
  const h = { vary: 'Origin' };
  if (origin && allowed.includes(String(origin))) h['access-control-allow-origin'] = origin;   // exact (browsers send it lowercase)
  return h;
}
function preflightHeaders(origin, allowed) {
  return {
    ...corsHeaders(origin, allowed),
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'Content-Type, Accept',
    'access-control-max-age': '86400',
  };
}

// FNV-1a (32 bit): the rate limit's key, so not even this isolate's memory holds the address itself.
function hashKey(s) {
  let h = 0x811c9dc5;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'k' + h.toString(36);
}

// Fixed one-minute window, in memory, per isolate. Everything is forgotten when the minute turns.
function createRateLimiter({ limit = RATE.perMinute, windowMs = RATE.windowMs, maxKeys = RATE.maxKeys } = {}) {
  let windowStart = -1;
  let counts = new Map();
  return {
    hit(ip, nowMs) {
      const w = Math.floor(nowMs / windowMs) * windowMs;
      if (w !== windowStart) { windowStart = w; counts = new Map(); }
      const key = hashKey(ip);
      if (!counts.has(key) && counts.size >= maxKeys) counts = new Map();   // memory stays bounded
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      return { ok: n <= limit, limit, remaining: Math.max(0, limit - n), resetSeconds: Math.max(1, Math.ceil((w + windowMs - nowMs) / 1000)) };
    },
    size() { return counts.size; },
    keys() { return [...counts.keys()]; },
  };
}

// The site's SETTINGS with the API's OFFICIAL address (wrangler.toml [vars]) as the official list.
function settingsFor(env, base = SETTINGS) {
  const official = String((env && env.OFFICIAL) || '').trim().toLowerCase();
  const trust = { ...(base.trust || {}) };
  if (isAddr(official)) trust.official = [{ symbol: 'BLAME', address: official }];
  return { ...base, trust };
}

// Error code -> HTTP status.
const STATUS_OF = {
  'bad-input': 400, 'bad-address': 400, 'bad-window': 400,
  'not-found': 404, 'not-a-token': 404, 'not-pons': 404, 'no-launch': 404,
  'rate-limited': 429,
  'rpc-failed': 502,
  'index-behind': 503, unavailable: 503, budget: 503,
};
function statusFor(code) { return STATUS_OF[code] || 502; }

function fail(code, message, extra = {}) { return { status: statusFor(code), body: { ok: false, code, message, ...extra } }; }

// A plain answer: { status, headers, body (string|null) }. toResponse() makes the platform Response.
function jsonAnswer(status, body, { cacheSeconds = 0, headers = {} } = {}) {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheSeconds > 0 ? 'public, max-age=' + cacheSeconds : 'no-store',
      'x-content-type-options': 'nosniff',
      ...headers,
    },
    body: status === 204 || body == null ? null : JSON.stringify(body),
  };
}
function toResponse(a) {
  if (a && a.raw) return a.raw;
  return new Response(a.body, { status: a.status, headers: a.headers });
}

// =============================================================================================================
// Budget plumbing: rpc.js keeps one fetch for the whole isolate, so it is pointed at a dispatcher that sends each
// call to the budget of the request it belongs to (AsyncLocalStorage when the platform has it).
// =============================================================================================================
let als = null;
let alsTried = false;
let current = null;            // fallback when there is no AsyncLocalStorage (jsc tests): the running budget

// entry.js hands AsyncLocalStorage over at startup (a static import), so the first requests of a fresh isolate
// don't race a dynamic import and fall back to the shared `current` budget.
function useAsyncLocalStorage(Als) {
  if (typeof Als === 'function') { als = new Als(); alsTried = true; }
}

async function getAls() {
  if (!alsTried) {
    alsTried = true;
    try {
      const m = await import('node:async_hooks');
      als = m && m.AsyncLocalStorage ? new m.AsyncLocalStorage() : null;
    } catch (e) { als = null; }
  }
  return als;
}

function activeBudget() {
  const b = als ? als.getStore() : null;
  return b || current;
}

// The one fetch rpc.js and the trust code use: counted on the active request's budget.
function routedFetch(input, init) {
  const b = activeBudget();
  if (b) return b.fetch(input, init);
  return fetch(input, init);
}

// rpc.js limits requests in flight per endpoint with waiting promises; each request gets its own table of them
// (one request may not wake another request's promise in a Worker: the waiter would be cancelled and hang).
// A module's scoped budget (below) shares its request's table.
const laneTables = new WeakMap();
function requestLanes() {
  const a = activeBudget();
  if (!a) return null;
  const b = a.__root || a;
  let t = laneTables.get(b);
  if (!t) { t = {}; laneTables.set(b, t); }
  return t;
}

// Runs fn with `budget` as the active budget.
async function withBudget(budget, fn) {
  const store = await getAls();
  _setTransport({ fetch: routedFetch });
  _setLaneScope(requestLanes);
  if (store) return store.run(budget, fn);
  const prev = current;
  current = budget;
  try { return await fn(); } finally { current = prev; }
}

// The budget handed to other modules: same counters, but its fetch follows the active request (so a module
// that points rpc.js at budget.fetch can't make another request's calls count here).
function moduleBudget(budget) {
  const view = Object.create(budget);
  view.fetch = (input, init) => (activeBudget() || budget).fetch(input, init);
  return view;
}

// The budget report.js / links.js get: a child of the request's budget (it spends from it, capped at `cap`),
// marked as already scoped. report.js scopedBudget() then uses it as it is. Without the mark it would make its own
// counter and point rpc.js's transport, which is shared by the whole isolate, at it: every other request running
// in this isolate at that moment would then count its RPC calls on this request's counter and get this request's
// refusals (half-read facts cached as complete, a report stopped early). The child is also the active budget while
// the module runs (inScope), so its RPC calls, through routedFetch, count on it and on the request.
function scopedChild(budget, cap = Infinity) {
  const child = budget.child(Math.max(0, Math.min(cap, budget.remaining())));
  child.__scoped = true;
  child.__root = budget.__root || budget;
  return child;
}
async function inScope(budget, fn) {
  const store = await getAls();
  if (store) return store.run(budget, fn);
  const prev = current;
  current = budget;
  try { return await fn(); } finally { current = prev; }
}

function budgetHeader(budget) {
  const s = budget.snapshot();
  return 'sub=' + s.used + '/' + s.limit + '; d1=' + s.d1Used + '/' + s.d1Limit + '; refused=' + s.refused;
}

// =============================================================================================================
// Shared cache: Cache API first (no D1 query), then D1 api_cache. Bodies are JSON; keys are 'kind:token|query'.
// =============================================================================================================
let tablesReady = false;
function _resetForTests() { tablesReady = false; current = null; }

async function ensureTables(db) {
  if (tablesReady || !db) return;
  await db.batch(SQL_SCHEMA.map((s) => db.prepare(s)));
  tablesReady = true;
}

// The Cache API, counted as subrequests. `base` is this request's origin (cache keys must be URLs).
function cfCache(budget, base, ctx) {
  let c = null;
  try { c = typeof caches !== 'undefined' && caches && caches.default ? caches.default : null; } catch (e) { c = null; }
  if (!c || typeof Response !== 'function') return null;
  const url = (key) => base + '/__cache/' + encodeURIComponent(key);
  return {
    async get(key) {
      if (!budget.take(1)) return null;
      try { const hit = await c.match(url(key)); return hit ? await hit.json() : null; } catch (e) { return null; }
    },
    async put(key, body, seconds) {
      if (!budget.take(1)) return;
      try {
        const p = c.put(url(key), new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=' + seconds },
        }));
        if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(p.catch(() => {}));
        else await p;
      } catch (e) { /* the cache is a nice-to-have */ }
    },
  };
}

async function d1Get(deps, key) {
  if (!deps.db) return null;
  try {
    await ensureTables(deps.db);
    const row = await deps.db.prepare(SQL_CACHE_GET).bind(key, nowSeconds(deps.now)).first();
    return row && row.body ? JSON.parse(row.body) : null;
  } catch (e) { return null; }
}
async function d1Put(deps, key, body, seconds) {
  if (!deps.db) return;
  try {
    await ensureTables(deps.db);
    await deps.db.prepare(SQL_CACHE_PUT).bind(key, JSON.stringify(body), nowSeconds(deps.now) + seconds).run();
  } catch (e) { /* a full or busy database never breaks an answer */ }
}

async function cacheGet(deps, key) {
  if (deps.cache) {
    const hit = await deps.cache.get(key);
    if (hit) return hit;
  }
  const row = await d1Get(deps, key);
  if (row && deps.cache) await deps.cache.put(key, row, BROWSER_SECONDS);
  return row;
}
async function cachePut(deps, key, body, seconds) {
  if (deps.cache) await deps.cache.put(key, body, seconds);
  await d1Put(deps, key, body, seconds);
}

// =============================================================================================================
// GET /v1/health
// =============================================================================================================
// meta (last_block, oldest_block, last_run) + the time of the first launch of the unbroken range (a stray older
// row added by hand doesn't count). Two indexed reads.
async function indexState(db) {
  const res = await db.prepare(SQL_META).all();
  const m = {};
  for (const r of (res && res.results) || []) m[r.key] = Number(r.value);
  const num = (v) => (Number.isFinite(v) ? v : null);
  const s = { lastBlock: num(m.last_block), oldestBlock: num(m.oldest_block), lastRun: num(m.last_run), oldestTime: null, lastBlockTime: null };
  if (s.oldestBlock != null) {
    const row = await db.prepare(SQL_OLDEST_TIME).bind(s.oldestBlock).first();
    s.oldestTime = row ? num(Number(row.time)) : null;
  }
  // About when last_block was made: the newest launch at or before it, plus the blocks since at ~0.1 s each.
  if (s.lastBlock != null) {
    try {
      const row = await db.prepare(SQL_NEWEST_AT).bind(s.lastBlock).first();
      if (row && Number.isFinite(Number(row.time)) && Number.isFinite(Number(row.block))) {
        s.lastBlockTime = Math.round(Number(row.time) + (s.lastBlock - Number(row.block)) * BLOCK_SECONDS);
      }
    } catch (e) { /* the estimate is extra; health answers without it */ }
  }
  return s;
}

async function healthBody(deps) {
  if (!deps.db) return fail('unavailable', 'The launch index isn\'t connected.');
  let s;
  try { s = await indexState(deps.db); } catch (e) { return fail('index-behind', 'The launch index isn\'t ready yet.'); }
  const now = nowSeconds(deps.now);
  const ago = s.lastRun != null ? Math.max(0, now - s.lastRun) : null;
  // The cron can run every minute and still be hours behind the chain (catching up after an outage).
  const lag = s.lastBlockTime != null ? Math.max(0, now - s.lastBlockTime) : null;
  return {
    status: 200,
    body: {
      ok: true,
      service: 'bts-api',
      version: VERSION,
      time: iso(now),
      index: {
        ready: s.lastBlock != null,
        lastBlock: s.lastBlock,
        oldestBlock: s.oldestBlock,
        indexedFrom: s.oldestTime != null ? iso(s.oldestTime) : null,
        indexComplete: s.oldestBlock != null && s.oldestBlock <= INDEX_FLOOR,
        floorBlock: INDEX_FLOOR,
        lastRun: s.lastRun != null ? iso(s.lastRun) : null,
        lastRunAgoSeconds: ago,
        lagSeconds: lag,
        behind: ago == null || ago > BEHIND_SECONDS || (lag != null && lag > BEHIND_SECONDS),
      },
      rateLimitPerMinute: RATE.perMinute,
    },
  };
}

// =============================================================================================================
// GET /v1/copies?q=   (staged: each request reads as many coins as its budget fits; facts are kept in D1)
// =============================================================================================================
function stagedGather(deps, stage) {
  const gather = deps.gather || gatherFacts;
  return async (row, ctx) => {
    stage.total++;
    const token = String((row && row.token) || '').toLowerCase();
    const key = 'facts:' + token;
    const hit = await d1Get(deps, key);
    if (hit) { stage.done++; return hit; }
    const release = deps.budget.reserve(FACT_RESERVE);
    if (!release) { stage.pending++; return null; }
    stage.started++;
    const before = deps.budget.refused;
    let facts = null;
    try { facts = await gather(row, ctx); } catch (e) { facts = null; } finally { release(); }
    if (facts && deps.budget.refused === before) {
      stage.done++;
      stage.fresh++;
      await d1Put(deps, key, facts, TTL.facts);
      return facts;
    }
    stage.pending++;
    if (facts) stage.partials.push({ key, facts });
    return facts;
  };
}

// The launch-index search of a copy check, kept in D1 for 5 minutes. A copy check being built is asked again every
// few seconds, and a common name's search reads hundreds of launch rows each time (D1 bills rows read): the
// polls after the first read one cached row instead.
function rowCachedIndex(index, deps) {
  if (!index || typeof index.findBySkeletons !== 'function' || !deps.db) return index;
  return {
    findByToken: (addr) => index.findByToken(addr),
    state: () => index.state(),
    async findBySkeletons(keys, limit) {
      const joined = keys.join(',');
      const key = 'rows:' + limit + ':' + hashKey(joined) + hashKey('|' + joined) + ':' + keys.length;
      const hit = await d1Get(deps, key);
      if (Array.isArray(hit)) return hit;
      const rows = await index.findBySkeletons(keys, limit);
      if (Array.isArray(rows) && rows.length) await d1Put(deps, key, rows, TTL.copies);
      return rows;
    },
  };
}

async function copiesBody(rawQuery, deps) {
  const query = String(rawQuery == null ? '' : rawQuery).trim();
  if (!query) return fail('bad-input', 'Paste a ticker or a coin address.');
  if (query.length > 100) return fail('bad-input', 'That\'s too long for a ticker or an address.');
  const key = 'copies:' + (isAddr(query) ? query.toLowerCase() : query);
  const hit = await cacheGet(deps, key);
  if (hit) return { status: 200, body: hit, cacheSeconds: BROWSER_SECONDS };

  const stage = { total: 0, done: 0, fresh: 0, started: 0, pending: 0, partials: [] };
  let r;
  try {
    r = await (deps.copyCheck || copyCheck)({
      query, db: rowCachedIndex(deps.index || (deps.db ? d1Index(deps.db) : null), deps), fetch: routedFetch, settings: deps.settings, now: deps.now, gather: stagedGather(deps, stage),
    });
  } catch (e) { r = null; }
  if (!r) return fail('unavailable', 'The copy check is unavailable right now. Try again in a minute.');
  if (r.ok !== true) return { status: statusFor(r.code), body: { ok: false, code: r.code || 'unavailable', message: r.message || 'The copy check is unavailable right now.' } };

  if (stage.pending > 0) {
    // Nothing new finished in this request: keep what the cut-off reads got, so every request moves forward.
    if (stage.fresh === 0 && stage.partials.length) {
      for (const p of stage.partials) await d1Put(deps, p.key, p.facts, TTL.partialFacts);
      stage.done += stage.partials.length;
    }
    if (stage.fresh > 0 || stage.partials.length) {
      return { status: 202, body: { ok: true, status: 'building', step: 'copies', progress: progressOf(stage), retryAfterSeconds: 2 } };
    }
    // Not even one coin fitted. If earlier polls got some, the search was just costly this time: try again a few times.
    if (stage.done > 0 && deps.db) {
      const stallKey = 'stall:' + key;
      const seen = await d1Get(deps, stallKey);
      const n = (seen && Number(seen.n)) || 0;
      if (n < COPIES_STALLS) {
        await d1Put(deps, stallKey, { n: n + 1 }, STALL_SECONDS);
        return { status: 202, body: { ok: true, status: 'building', step: 'copies', progress: progressOf(stage), retryAfterSeconds: 3 } };
      }
    }
    // The budget went on the search itself: answer what there is, briefly cached.
    const body = { ...r, status: 'done', notes: (r.notes || []).concat('Some facts couldn\'t be read in time; ask again in a minute for the rest.') };
    if (deps.cache) await deps.cache.put(key, body, TTL.partialFacts);
    return { status: 200, body, cacheSeconds: 0 };
  }
  const body = { ...r, status: 'done' };
  await cachePut(deps, key, body, TTL.copies);
  return { status: 200, body, cacheSeconds: BROWSER_SECONDS };
}
const progressOf = (st) => (st.total ? Math.round(Math.min(0.99, st.done / st.total) * 100) / 100 : 0);

// =============================================================================================================
// GET /v1/report/{token} and /v1/report/{token}/links
// =============================================================================================================
// cap: subrequests one call may use (report.js REPORT_SUBREQUESTS, links.js LINK_SUBREQUESTS).
const KINDS = {
  report: { fn: 'launchReport', advance: 'advanceReportJobs', ttl: TTL.report, what: 'The launch report', cap: 40 },
  links: { fn: 'walletLinks', advance: 'advanceLinkJobs', ttl: TTL.links, what: 'Wallet links', cap: 30 },
};

// Loads report.js / links.js on first use -> { run, advance } (either may be null). A missing or broken module
// answers 'unavailable' instead of taking the whole API down.
const loaded = {};
async function loadKind(kind) {
  if (!(kind in loaded)) {
    loaded[kind] = (async () => {
      try { return kind === 'report' ? await import('./report.js') : await import('./links.js'); } catch (e) { return null; }
    })();
  }
  return pick(kind, await loaded[kind]);
}
function pick(kind, mod) {
  if (typeof mod === 'function') return { run: mod, advance: null };            // tests: just the function
  const fn = (name) => (mod && typeof mod[name] === 'function' ? mod[name] : null);
  return { run: fn(KINDS[kind].fn), advance: fn(KINDS[kind].advance) };
}
async function kindModule(kind, deps) {
  if (deps.modules && deps.modules[kind] !== undefined) return pick(kind, deps.modules[kind]);
  return loadKind(kind);
}

// null = the module isn't there.
async function runKind(kind, token, deps, mod = null) {
  const m = mod || await kindModule(kind, deps);
  if (!m.run) return null;
  const b = scopedChild(deps.budget, deps.moduleCap != null ? deps.moduleCap : KINDS[kind].cap);
  return inScope(b, () => m.run({ token, env: deps.moduleEnv, settings: deps.settings, now: deps.now, budget: b }));
}

async function kindBody(kind, rawToken, deps) {
  const K = KINDS[kind];
  const token = String(rawToken || '').trim();
  if (!isAddr(token)) return fail('bad-address', 'That isn\'t a coin address: it should be 0x and 40 letters or numbers.');
  const addr = token.toLowerCase();
  const key = kind + ':' + addr;
  const hit = await cacheGet(deps, key);
  if (hit) return { status: 200, body: hit, cacheSeconds: BROWSER_SECONDS };

  const mod = await kindModule(kind, deps);
  let r;
  try { r = await runKind(kind, addr, deps, mod); } catch (e) { r = undefined; }
  if (r === null) return fail('unavailable', K.what + ' isn\'t available yet.');
  if (!r || typeof r !== 'object') return fail('unavailable', K.what + ' is unavailable right now. Try again in a minute.');
  if (r.ok !== true) return { status: statusFor(r.code), body: { ok: false, code: r.code || 'unavailable', message: r.message || (K.what + ' is unavailable right now.') } };
  if (r.status === 'building') {
    if (!mod.advance) await enqueue(deps, kind, addr, r.progress);   // a module with its own job table queues itself
    return { status: 202, body: { ...r, retryAfterSeconds: r.retryAfterSeconds || 3 } };
  }
  if (r.status === 'done') {
    await cachePut(deps, key, r, K.ttl);
    return { status: 200, body: r, cacheSeconds: BROWSER_SECONDS };
  }
  return { status: 200, body: r };   // e.g. links 'unavailable' (explorer busy): not cached, the card offers a retry
}

async function enqueue(deps, kind, token, progress) {
  if (!deps.db) return;
  try {
    await ensureTables(deps.db);
    const p = Number.isFinite(progress) ? progress : null;
    await deps.db.prepare(SQL_JOB_UPSERT).bind(kind + ':' + token, kind, token, nowSeconds(deps.now), p).run();
  } catch (e) { /* the client's own polling still moves it on */ }
}

// =============================================================================================================
// The router
// =============================================================================================================
const RATE_LIMITED = (path) => path === '/mcp' || path.startsWith('/v1/copies') || path.startsWith('/v1/report');

async function handle(request, env, ctx, deps) {
  const url = parseUrl(request.url);
  const method = String(request.method || 'GET').toUpperCase();
  const origin = request.headers.get('origin');
  const allowed = deps.origins || allowedOrigins(env);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const cors = corsHeaders(origin, allowed);

  if (path === '/mcp') {
    if (method !== 'OPTIONS' && !limit(request, deps).ok) return rateLimited(cors, deps);
    return mcpAnswer(request, env, ctx, deps);
  }
  if (method === 'OPTIONS') return jsonAnswer(204, null, { headers: preflightHeaders(origin, allowed) });

  const out = (r, extra = {}) => jsonAnswer(r.status, r.body, {
    cacheSeconds: r.status === 200 ? (r.cacheSeconds || 0) : 0,
    headers: { ...cors, 'x-bts-budget': budgetHeader(deps.budget), ...extra },
  });

  if (method !== 'GET' && method !== 'HEAD') {
    return jsonAnswer(405, { ok: false, code: 'method', message: 'Only GET here.' }, { headers: { ...cors, allow: 'GET, OPTIONS' } });
  }
  if (RATE_LIMITED(path)) {
    const rl = limit(request, deps);
    if (!rl.ok) return rateLimited(cors, deps, rl);
  }

  if (path === '/' || path === '/v1') {
    return jsonAnswer(200, {
      ok: true, service: 'bts-api', version: VERSION,
      about: 'Read-only facts about Robinhood Chain coins. Not financial advice.',
      endpoints: ['/v1/health', '/v1/copies?q=TICKER|0xADDRESS', '/v1/report/0xTOKEN', '/v1/report/0xTOKEN/links', '/mcp'],
      site: 'https://blamethestock.com',
    }, { cacheSeconds: 300, headers: cors });
  }
  if (path === '/v1/health') {
    const r = await healthBody(deps);
    return jsonAnswer(r.status, r.body, { cacheSeconds: r.status === 200 ? HEALTH_SECONDS : 0, headers: cors });
  }
  if (path === '/v1/copies') return out(await copiesBody(url.params.get('q'), deps));

  const m = /^\/v1\/report\/([^/]+)(\/links)?$/.exec(path);
  if (m) {
    const token = dec(m[1]);
    return out(await kindBody(m[2] ? 'links' : 'report', token, deps));
  }
  return jsonAnswer(404, { ok: false, code: 'not-found', message: 'Nothing here. See /v1/health.' }, { headers: cors });
}

function limit(request, deps) {
  if (!deps.limiter) return { ok: true };
  if (deps.limitResult) return deps.limitResult;     // one count per request
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
  deps.limitResult = deps.limiter.hit(ip, deps.now);
  return deps.limitResult;
}
function rateLimited(cors, deps, rl = deps.limitResult) {
  const wait = (rl && rl.resetSeconds) || 60;
  return jsonAnswer(429, { ok: false, code: 'rate-limited', message: 'Too many requests. Try again in a minute.', retryAfterSeconds: wait },
    { headers: { ...cors, 'retry-after': String(wait) } });
}

async function mcpAnswer(request, env, ctx, deps) {
  let handler = deps.mcp;
  if (!handler) {
    try { handler = (await import('./mcp.js')).handleMcp; } catch (e) { handler = null; }
  }
  if (typeof handler !== 'function') {
    return jsonAnswer(503, { jsonrpc: '2.0', error: { code: -32603, message: 'The MCP server is unavailable right now.' }, id: null });
  }
  const api = {
    copies: async (q) => (await copiesBody(q, deps)).body,
    report: async (t) => (await kindBody('report', t, deps)).body,
    links: async (t) => (await kindBody('links', t, deps)).body,
  };
  try {
    const res = await handler(request, env, ctx, { settings: deps.settings, budget: moduleBudget(deps.budget), now: deps.now, api, fetch: routedFetch });
    return { raw: res };
  } catch (e) {
    return jsonAnswer(500, { jsonrpc: '2.0', error: { code: -32603, message: 'The MCP server hit an error. Try again.' }, id: null });
  }
}

// =============================================================================================================
// The cron: indexer first, then queued report/link jobs, then old cache rows out.
// =============================================================================================================
async function runScheduled(env, deps = {}) {
  const now = deps.now != null ? deps.now : Date.now();
  const budget = deps.budget || createBudget({ limit: DEFAULT_LIMIT, d1Limit: DEFAULT_D1_LIMIT });
  const rawDb = env && env.DB;
  const db = budget.wrapDb(rawDb);
  const log = deps.log || ((t) => console.log(t));
  const out = { indexer: null, jobs: [], purged: false, budget: null };
  if (!rawDb) { out.indexer = { ok: false, error: 'DB binding missing' }; return out; }

  // 1. the launch index
  const ib = budget.child(INDEXER_SUBREQUESTS);
  try {
    out.indexer = await withBudget(ib, () => (deps.runIndexer || runIndexer)({ ...env, DB: ib.wrapDb(rawDb) }, { maxBlocks: INDEXER_MAX_BLOCKS, maxRows: INDEXER_MAX_ROWS, log, now: () => now }));
  } catch (e) {
    out.indexer = { ok: false, error: errText(e) };
    log('indexer: stopped: ' + errText(e));
  }

  // 2. report/link jobs. A module with its own job table (report.js advanceReportJobs, links.js advanceLinkJobs)
  //    moves its own queue on; otherwise the Worker's api_jobs queue is used. The report gets ~60% of what is left.
  const jd = { db, now, settings: deps.settings || settingsFor(env), modules: deps.modules, budget };
  const mods = { report: await kindModule('report', jd), links: await kindModule('links', jd) };
  for (const kind of ['report', 'links']) {
    const adv = mods[kind].advance;
    if (!adv) continue;
    const room = budget.remaining();
    if (room < JOBS.minRoom) break;
    const jb = scopedChild(budget, kind === 'report' ? Math.max(JOBS.minRoom, Math.floor(room * 0.6)) : room);
    try {
      const r = await withBudget(jb, () => adv({ env: { ...env, DB: jb.wrapDb(rawDb) }, settings: jd.settings, now, budget: jb }));
      out.jobs.push({ key: kind + ':*', result: 'advanced ' + ((r && r.advanced && r.advanced.length) || 0) + ', done ' + ((r && r.done && r.done.length) || 0) });
    } catch (e) {
      log(kind + ' jobs: stopped: ' + errText(e));
    }
  }
  try {
    await ensureTables(db);
    const res = await db.prepare(SQL_JOBS_NEXT).bind(JOBS.perRun).all();
    for (const j of (res && res.results) || []) {
      const nowS = nowSeconds(now);
      const mod = KINDS[j.kind] ? mods[j.kind] : null;
      if (!mod || mod.advance || j.attempts >= JOBS.maxAttempts || nowS - j.created > JOBS.maxAgeSeconds) {
        await db.prepare(SQL_JOB_DELETE).bind(j.key).run();
        out.jobs.push({ key: j.key, result: 'dropped' });
        continue;
      }
      if (budget.remaining() < JOBS.minRoom) break;
      const jb = budget.child(budget.remaining());
      const d = { ...jd, budget: jb, db: jb.wrapDb(rawDb), moduleEnv: { ...env, DB: jb.wrapDb(rawDb) }, moduleCap: Infinity };
      let r;
      try { r = await withBudget(jb, () => runKind(j.kind, j.token, d, mod)); } catch (e) { r = undefined; }
      if (r && r.ok === true && r.status === 'building') {
        await db.prepare(SQL_JOB_TOUCH).bind(j.key, nowS, Number.isFinite(r.progress) ? r.progress : null).run();
        out.jobs.push({ key: j.key, result: 'building', progress: r.progress });
      } else if (r && r.ok === true && r.status === 'done') {
        await d1Put({ db, now }, j.kind + ':' + j.token, r, KINDS[j.kind].ttl);
        await db.prepare(SQL_JOB_DELETE).bind(j.key).run();
        out.jobs.push({ key: j.key, result: 'done' });
      } else if (r === null) {
        out.jobs.push({ key: j.key, result: 'module-missing' });
        break;
      } else {
        // an error or 'unavailable': the job ends; the next visitor's request starts it again if needed
        await db.prepare(SQL_JOB_DELETE).bind(j.key).run();
        out.jobs.push({ key: j.key, result: (r && (r.code || r.status)) || 'error' });
      }
    }
  } catch (e) {
    log('jobs: stopped: ' + errText(e));
  }

  // 3. expired cache rows and abandoned jobs
  try {
    const nowS = nowSeconds(now);
    await db.batch([db.prepare(SQL_CACHE_PURGE).bind(nowS), db.prepare(SQL_JOBS_PURGE).bind(nowS - JOBS.maxAgeSeconds)]);
    out.purged = true;
  } catch (e) { /* next minute */ }

  out.budget = budget.snapshot();
  if (out.jobs.length) log('jobs: ' + out.jobs.map((j) => j.key.slice(0, 18) + '… ' + j.result).join(', '));
  return out;
}

// =============================================================================================================
// The Worker
// =============================================================================================================
const limiter = createRateLimiter();

function requestDeps(request, env, ctx, extra = {}) {
  const budget = extra.budget || createBudget({ limit: DEFAULT_LIMIT, d1Limit: DEFAULT_D1_LIMIT });
  const rawDb = env && env.DB ? env.DB : null;
  const db = rawDb ? budget.wrapDb(rawDb) : null;
  const url = parseUrl(request.url);
  return {
    now: Date.now(),
    budget,
    db,
    moduleEnv: { ...(env || {}), DB: db },
    settings: settingsFor(env),
    cache: cfCache(budget, url.origin, ctx),
    limiter,
    ...extra,
  };
}

// The entry module may export only the handler (workerd treats every named export as an entrypoint), so the
// testable parts ride along as `internals` (workerd ignores keys it doesn't know). dev/tests/worker.test.js uses them.
const internals = {
  VERSION, DEFAULT_ORIGINS, RATE, TTL, BROWSER_SECONDS, HEALTH_SECONDS, FACT_RESERVE, JOBS, INDEXER_SUBREQUESTS,
  INDEXER_MAX_BLOCKS, INDEXER_MAX_ROWS, KINDS,
  SQL_SCHEMA, SQL_META, SQL_OLDEST_TIME, SQL_NEWEST_AT, SQL_CACHE_GET, SQL_CACHE_PUT, SQL_CACHE_PURGE, SQL_JOB_UPSERT, SQL_JOBS_NEXT, SQL_JOB_TOUCH,
  SQL_JOB_DELETE, SQL_JOBS_PURGE,
  COPIES_STALLS, rowCachedIndex, scopedChild, inScope, parseUrl, allowedOrigins, corsHeaders, preflightHeaders, hashKey, createRateLimiter, settingsFor, statusFor,
  jsonAnswer, toResponse, routedFetch, withBudget, useAsyncLocalStorage, requestLanes, _resetForTests, ensureTables, cfCache, d1Get, d1Put, cacheGet,
  cachePut, healthBody, stagedGather, copiesBody, loadKind, kindModule, kindBody, enqueue, handle, runScheduled, requestDeps,
};

export default {
  internals,

  async fetch(request, env, ctx) {
    const deps = requestDeps(request, env, ctx);
    let answer;
    try {
      answer = await withBudget(deps.budget, () => handle(request, env, ctx, deps));
    } catch (e) {
      console.error('request failed: ' + errText(e));     // the error only; nothing about the visitor
      answer = jsonAnswer(500, { ok: false, code: 'internal', message: 'Something went wrong on our side. Try again.' },
        { headers: corsHeaders(request.headers.get('origin'), allowedOrigins(env)) });
    }
    if (String(request.method).toUpperCase() === 'HEAD' && !answer.raw) answer = { ...answer, body: null };
    return toResponse(answer);
  },

  async scheduled(controller, env, ctx) {
    const now = controller && Number.isFinite(controller.scheduledTime) ? controller.scheduledTime : Date.now();
    const budget = createBudget({ limit: DEFAULT_LIMIT, d1Limit: DEFAULT_D1_LIMIT });
    const out = await withBudget(budget, () => runScheduled(env, { now, budget }));
    console.log('cron: ' + JSON.stringify({ indexer: out.indexer && { from: out.indexer.from, to: out.indexer.to, written: out.indexer.written, error: out.indexer.error }, jobs: out.jobs.length, budget: out.budget }));
  },
};
