// Blame the Stock API: the Cloudflare Worker at https://api.blamethestock.com. Read-only.
//
//   GET  /v1/health                    the launch index: last block, oldest block, indexed from, complete?
//   GET  /v1/copies?q=OBSYN|0x…        copy check: the same-name launches from the D1 index (api/src/copies.js)
//   GET  /v1/report/{token}            the coin's launch basics from the D1 index (the report is built in the browser)
//   GET  /v1/report/{token}/links      a note: wallet links are checked in the browser
//   POST|GET|DELETE /mcp               MCP, Streamable HTTP (api/src/mcp.js)
//   scheduled()                        every minute: the launch indexer (dRPC in 100-block pieces)
//
// Chain reading happens where the visitor is. The official Robinhood Chain RPC answers HTTP 429 to every call from
// Cloudflare's network, publicnode serves only the newest blocks and dRPC caps eth_getLogs at 100 blocks, so the
// Worker answers from D1 only and marks it (facts: 'client'); the website reads the chain facts, the launch
// report and the wallet links in the visitor's browser (site/src/trust/copycheck.js, site/src/trust/local.js),
// and the local MCP package does the same on the user's machine. Only the cron indexer reads the chain here.
//
// Built for the Workers FREE plan: at most 50 subrequests (fetch, Cache API), 50 D1 queries and ~10 ms of CPU per
// request. Every request and cron run gets a budget (api/src/budget.js) that counts what it spends.
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
import { copyMatches, d1Index } from './copies.js';
import { runIndexer, encodeAggregate3, decodeAggregate3 } from './indexer.js';
import { MULTICALL3 } from './env.js';
import { rpcBatch } from '../../site/src/data/rpc.js';
import { INDEX_FLOOR } from './env.js';
import { SETTINGS } from '../../site/settings.js';
import { _setTransport, _setLaneScope } from '../../site/src/data/rpc.js';
import { iso as isoOf } from '../../site/src/trust/facts.js';
import { tokenUrl, txUrl, addressUrl } from '../../site/src/trust/rules.js';

const VERSION = '0.1.0';
const DEFAULT_ORIGINS = ['https://blamethestock.com', 'https://www.blamethestock.com', 'http://localhost:8765'];

const RATE = { perMinute: 60, windowMs: 60000, maxKeys: 10000 };

// Seconds a finished answer is kept (shared cache: Cache API + D1). Browsers keep it for BROWSER_SECONDS.
const TTL = {
  copies: 60,           // the same-name launches from the index (a new launch can join them any minute)
  report: 60,           // a coin's launch basics
};
const BROWSER_SECONDS = 60;
const HEALTH_SECONDS = 15;

// The cron: the indexer may use this many subrequests (of the 50 a run has). It reads TokenLaunched logs on dRPC in
// INDEXER_LOG_SPAN-block pieces, 3 per batch request, at most INDEXER_LOG_REQUESTS requests (6,600 blocks, ~11 min of
// chain), and writes at most INDEXER_MAX_ROWS launches; the rest of the share goes to the head block (1), the
// Multicall3 senders and block times (3 per request, up to 5 each), names (1) and pending names (1).
// A normal minute is ~575 blocks (2 requests) and ~0.5 launches; after an outage it catches up ~6,000 blocks a minute.
const INDEXER_SUBREQUESTS = 40;
const INDEXER_LOG_SPAN = 100;
const INDEXER_LOG_REQUESTS = 22;
const INDEXER_MAX_BLOCKS = INDEXER_LOG_SPAN * 3 * INDEXER_LOG_REQUESTS;
const INDEXER_MAX_ROWS = 15;
// Endpoints the Worker asks last (only when nothing else answered): the official node refuses Cloudflare.
const AVOID = ['official'];
const JOBS_MAX_AGE = 1800;     // leftover rows of the old report/link job queue are purged after this

// ---- D1: the Worker's own two tables (created on first use; also in docs/API.md) ----------------------------
const SQL_SCHEMA = [
  'CREATE TABLE IF NOT EXISTS api_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache (expires)',
  'CREATE TABLE IF NOT EXISTS api_jobs (key TEXT PRIMARY KEY, kind TEXT NOT NULL, token TEXT NOT NULL, created INTEGER NOT NULL, touched INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress REAL)',
  'CREATE INDEX IF NOT EXISTS idx_api_jobs_touched ON api_jobs (touched)',
  'CREATE INDEX IF NOT EXISTS idx_api_jobs_created ON api_jobs (created)',
  // Blame counter: one row per UTC day, just a number (no IPs, no coins, nothing about the visitor).
  'CREATE TABLE IF NOT EXISTS blame_counts (day INTEGER PRIMARY KEY, n INTEGER NOT NULL)',
  // Coins checked (copy checks and launch reports) and copies flagged: one number per UTC day and kind, nothing else.
  'CREATE TABLE IF NOT EXISTS event_counts (day INTEGER NOT NULL, kind TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (day, kind))',
];
// One row write per counted blame (INTEGER PRIMARY KEY: no extra index to write).
const SQL_COUNT_ADD = 'INSERT INTO blame_counts (day, n) VALUES (?, 1) ON CONFLICT(day) DO UPDATE SET n = n + 1';
const SQL_EVENT_ADD = 'INSERT INTO event_counts (day, kind, n) VALUES (?1, ?2, ?3) ON CONFLICT(day, kind) DO UPDATE SET n = n + ?3';
const SQL_EVENT_GET = 'SELECT kind, COALESCE(SUM(n), 0) AS total, COALESCE(SUM(CASE WHEN day = ?1 THEN n ELSE 0 END), 0) AS today FROM event_counts GROUP BY kind';
export const COUNT_KINDS = ['blame', 'check', 'flag'];
const COUNT_MAX = 10;                       // one request adds at most this much (a copy check flags a few coins)
const SQL_COUNT_GET = 'SELECT COALESCE(SUM(n), 0) AS total, COALESCE(SUM(CASE WHEN day = ? THEN n ELSE 0 END), 0) AS today, MIN(day) AS since FROM blame_counts';
const STATS_SECONDS = 30;          // the counter answer is cached this long (Cloudflare and browsers)
const SQL_META = 'SELECT key, value FROM meta';
const SQL_OLDEST_TIME = 'SELECT time FROM launches WHERE block >= ?1 ORDER BY block ASC LIMIT 1';
const SQL_NEWEST_AT = 'SELECT block, time FROM launches WHERE block <= ?1 ORDER BY block DESC LIMIT 1';
const BLOCK_SECONDS = 0.1045;    // Robinhood Chain's average block time (same figure as copies.js)
const BEHIND_SECONDS = 600;
const SQL_CACHE_GET = 'SELECT body FROM api_cache WHERE key = ?1 AND expires > ?2';
const SQL_CACHE_PUT = 'INSERT INTO api_cache (key, body, expires) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET body = excluded.body, expires = excluded.expires';
const SQL_CACHE_PURGE = 'DELETE FROM api_cache WHERE key IN (SELECT key FROM api_cache WHERE expires <= ?1 LIMIT 500)';
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

// The site's SETTINGS (official coin from token.contractAddress); a non-empty OFFICIAL var (wrangler.toml) overrides it.
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
  _setTransport({ fetch: routedFetch, avoid: AVOID });
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
// GET /v1/copies?q=   (the launch index only; the browser reads the chain facts)
// =============================================================================================================
// The launch-index search of a copy check, kept in D1 for a minute: a common name's search reads hundreds of
// launch rows (D1 bills rows read), and the same ticker is often asked many times in a row.
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

// hint: { name, symbol } the browser read from the chain for an address the index doesn't have (search words only).
async function copiesBody(rawQuery, deps, hint = null) {
  const query = String(rawQuery == null ? '' : rawQuery).trim();
  if (!query) return fail('bad-input', 'Paste a ticker or a coin address.');
  if (query.length > 100) return fail('bad-input', 'That\'s too long for a ticker or an address.');
  const h = hint && isAddr(query) && (hint.name != null || hint.symbol != null)
    ? { name: String(hint.name || '').slice(0, 200), symbol: String(hint.symbol || '').slice(0, 200) } : null;
  const key = 'copies:' + (isAddr(query) ? query.toLowerCase() : query) + (h ? '|' + hashKey(h.name + '\u0000' + h.symbol) : '');
  const hit = await cacheGet(deps, key);
  if (hit) return { status: 200, body: hit, cacheSeconds: BROWSER_SECONDS };
  let r;
  try {
    r = await (deps.copyMatches || copyMatches)({
      query, db: rowCachedIndex(deps.index || (deps.db ? d1Index(deps.db) : null), deps), settings: deps.settings, now: deps.now, hint: h,
    });
  } catch (e) { r = null; }
  if (!r) return fail('unavailable', 'The copy check is unavailable right now. Try again in a minute.');
  if (r.ok !== true) return { status: statusFor(r.code), body: { ok: false, code: r.code || 'unavailable', message: r.message || 'The copy check is unavailable right now.' } };
  const body = { ...r, status: 'done' };
  await cachePut(deps, key, body, TTL.copies);
  return { status: 200, body, cacheSeconds: BROWSER_SECONDS };
}

// =============================================================================================================
// GET /v1/alerts: Pons launches of the last 24 h that use the name or ticker of a coin that already graduated
// =============================================================================================================
// Reference = graduated Pons coins (graduating takes real buys up to the curve's threshold, unlike volume numbers,
// which are easy to fake here). Facts only: never "real", never "scam". Skeletons ignore hidden characters and
// look-alike letters; very short names (under 3 characters) are left out because they collide by chance.
export const ALERT_HOURS = 24;
export const ALERT_LIMIT = 40;
const ALERT_SECONDS = 120;
export const ALERT_BLOCKS = Math.round((ALERT_HOURS * 3600) / 0.1045);   // ~24 h of Robinhood Chain blocks
export const SQL_ALERTS = `
WITH recent AS (
  SELECT token, symbol, name, time, block, creator, tx_from, tx, sym_skel, name_skel FROM launches
  WHERE block >= (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'last_block') - ?1
),
hits AS (
  SELECT r.token AS c, g.token AS o, g.block AS gb, 'ticker' AS kind FROM recent r
    JOIN graduations g ON g.sym_skel = r.sym_skel
    WHERE length(r.sym_skel) >= 3 AND g.token <> r.token AND g.block < r.block
  UNION ALL
  SELECT r.token, g.token, g.block, 'name' FROM recent r
    JOIN graduations g ON g.name_skel = r.name_skel
    WHERE length(r.name_skel) >= 3 AND g.token <> r.token AND g.block < r.block
)
SELECT r.token, r.symbol, r.name, r.time, r.block, r.creator, r.tx_from, r.tx,
       g.token AS o_token, g.symbol AS o_symbol, g.name AS o_name, g.block AS o_grad_block, g.tx AS o_grad_tx,
       h.kind AS kind, (SELECT COUNT(DISTINCT h2.o) FROM hits h2 WHERE h2.c = h.c) AS o_count
FROM hits h
JOIN recent r ON r.token = h.c
JOIN graduations g ON g.token = h.o
WHERE h.gb = (SELECT MIN(h3.gb) FROM hits h3 WHERE h3.c = h.c)
ORDER BY r.block DESC
LIMIT ?2`;

export function alertsFromRows(rows, nowSec) {
  const seen = new Set();
  const out = [];
  for (const x of rows || []) {
    if (!x || !isAddr(x.token) || !isAddr(x.o_token) || seen.has(x.token)) continue;
    seen.add(x.token);
    out.push({
      copy: { address: x.token, symbol: x.symbol ?? null, name: x.name ?? null, time: x.time == null ? null : Number(x.time),
        ageSeconds: x.time == null ? null : Math.max(0, nowSec - Number(x.time)), dev: isAddr(x.tx_from) ? x.tx_from : x.creator, tx: x.tx },
      graduated: { address: x.o_token, symbol: x.o_symbol ?? null, name: x.o_name ?? null, graduationBlock: Number(x.o_grad_block), graduationTx: x.o_grad_tx },
      matchedOn: x.kind === 'name' ? 'name' : 'ticker',
      graduatedSameName: Number(x.o_count) || 1,
    });
  }
  return out;
}

async function alertsBody(deps) {
  if (!deps.db) return fail('unavailable', 'Copycat alerts are unavailable right now.');
  const nowSec = Math.floor(deps.now / 1000);
  const hit = await cacheGet(deps, 'alerts');
  if (hit) return { status: 200, body: hit, cacheSeconds: ALERT_SECONDS };
  try {
    const res = await deps.db.prepare(SQL_ALERTS).bind(ALERT_BLOCKS, ALERT_LIMIT * 3).all();
    const alerts = alertsFromRows(res && res.results, nowSec).slice(0, ALERT_LIMIT);
    const body = { ok: true, hours: ALERT_HOURS, asOf: new Date(deps.now).toISOString(), alerts,
      about: 'Pons launches of the last 24 hours using the name or ticker of a Pons coin that already graduated. '
        + 'Same name is a fact, not proof of a scam; a graduated coin is not proof of the original either.' };
    await cachePut(deps, 'alerts', body, ALERT_SECONDS);
    return { status: 200, body, cacheSeconds: ALERT_SECONDS };
  } catch (e) {
    return fail('unavailable', 'Copycat alerts are unavailable right now.');
  }
}

// =============================================================================================================
// GET /v1/radar: ETH-paired Pons coins of the last 48 h closest to graduating (ETH in the curve / its threshold)
// =============================================================================================================
// One D1 read (indexed by block) and a few Multicall3 batches of realQuoteReserve() + graduated() on dRPC.
// Holders, dev % and first-buyer % are read by the website in the visitor's browser for the top rows.
export const RADAR_HOURS = 48;
export const RADAR_TOP = 15;
const RADAR_SECONDS = 120;
const RADAR_PER_CALL = 200;
const SEL_REAL_QUOTE = '0x4f1f58fd';
const SEL_GRADUATED = '0xe7c2b772';
const ETH = '0x0000000000000000000000000000000000000000';
export const SQL_RADAR = `
SELECT token, curve, symbol, name, block, time, creator, tx_from, tx, graduation_threshold FROM launches
WHERE block >= (SELECT CAST(value AS INTEGER) FROM meta WHERE key = 'last_block') - ?1
  AND pair_token = '${ETH}'
  AND NOT EXISTS (SELECT 1 FROM graduations g WHERE g.token = launches.token)`;

// rows + [{ quote (bigint wei) | null, graduated (bool) | null }] -> the top coins by % of their threshold.
export function radarFrom(rows, reads, nowSec, top = RADAR_TOP) {
  const out = [];
  rows.forEach((r, i) => {
    const x = reads[i];
    if (!x || x.quote == null || x.graduated !== false || !isAddr(r.token) || !isAddr(r.curve)) return;
    let th;
    try { th = BigInt(r.graduation_threshold); } catch (e) { return; }
    if (th <= 0n || x.quote <= 0n) return;
    const pct = Math.min(100, Number((x.quote * 100000n) / th) / 1000);
    out.push({
      address: r.token, curve: r.curve, symbol: r.symbol ?? null, name: r.name ?? null,
      launch: { block: Number(r.block), time: r.time == null ? null : Number(r.time), tx: r.tx },
      ageSeconds: r.time == null ? null : Math.max(0, nowSec - Number(r.time)),
      dev: isAddr(r.tx_from) ? r.tx_from : r.creator,
      ethIn: Number(x.quote) / 1e18, thresholdEth: Number(th) / 1e18, pct,
    });
  });
  return out.sort((a, b) => b.pct - a.pct || b.launch.block - a.launch.block).slice(0, top);
}

export async function readCurves(curves) {
  const reads = new Array(curves.length).fill(null);
  const word = (hex) => (hex && hex.length >= 66 ? BigInt(hex.slice(0, 66)) : null);
  const groups = [];
  for (let i = 0; i < curves.length; i += RADAR_PER_CALL) groups.push(i);
  for (let g = 0; g < groups.length; g += 3) {                 // dRPC: 3 calls per batch request
    const batch = groups.slice(g, g + 3).map((i) => ({ i, list: curves.slice(i, i + RADAR_PER_CALL) }));
    const calls = batch.map(({ list }) => ({ method: 'eth_call', params: [{ to: MULTICALL3,
      data: encodeAggregate3(list.flatMap((c) => [{ target: c, data: SEL_REAL_QUOTE }, { target: c, data: SEL_GRADUATED }])) }, 'latest'] }));
    const res = await rpcBatch('drpc', calls, { tries: 3 });
    batch.forEach(({ i, list }, k) => {
      const r = res[k];
      if (!r || !r.result) return;
      const items = decodeAggregate3(r.result);
      list.forEach((c, j) => {
        const q = items[2 * j], gr = items[2 * j + 1];
        reads[i + j] = { quote: q && q.success ? word(q.data) : null, graduated: gr && gr.success && word(gr.data) != null ? word(gr.data) !== 0n : null };
      });
    });
  }
  return reads;
}

async function radarBody(deps) {
  if (!deps.db) return fail('unavailable', 'The graduation radar is unavailable right now.');
  const hit = await cacheGet(deps, 'radar');
  if (hit) return { status: 200, body: hit, cacheSeconds: RADAR_SECONDS };
  try {
    const res = await deps.db.prepare(SQL_RADAR).bind(Math.round((RADAR_HOURS * 3600) / 0.1045)).all();
    const rows = (res && res.results) || [];
    const reads = await (deps.readCurves || readCurves)(rows.map((r) => r.curve));
    const all = radarFrom(rows, reads, Math.floor(deps.now / 1000), Infinity);
    const coins = all.slice(0, RADAR_TOP);
    const offs = new Set(((deps.settings && deps.settings.trust && deps.settings.trust.official) || []).map((o) => String(o.address).toLowerCase()));
    const oi = all.findIndex((c) => offs.has(c.address));
    const official = oi >= 0 ? { ...all[oi], rank: oi + 1 } : null;
    const body = { ok: true, hours: RADAR_HOURS, checked: rows.length, asOf: new Date(deps.now).toISOString(), coins, official,
      about: 'ETH-paired Pons coins launched in the last 48 hours that have not graduated, by ETH in their launch curve '
        + 'compared with the curve\'s graduation threshold (4.2 ETH). Read from Robinhood Chain; not financial advice.' };
    await cachePut(deps, 'radar', body, RADAR_SECONDS);
    return { status: 200, body, cacheSeconds: RADAR_SECONDS };
  } catch (e) {
    return fail('unavailable', 'The graduation radar is unavailable right now.');
  }
}

// =============================================================================================================
// GET /v1/report/{token} and /v1/report/{token}/links
// =============================================================================================================
const REPORT_NOTE = 'The launch report (dev moves, first buyers, fees, bridges, activity) is read from Robinhood Chain '
  + 'by the website in your browser, or by the local MCP package (npx blamethestock-mcp). This answer holds the coin\'s '
  + 'launch from our index.';
const LINKS_NOTE = 'Wallet links are checked by the website in your browser, or by the local MCP package '
  + '(npx blamethestock-mcp), after the launch report.';

// The coin's launch row from the index -> the report's basics (status 'basics'; nothing read from the chain).
function reportBasicsOf(row, addr, deps) {
  const official = ((deps.settings && deps.settings.trust && deps.settings.trust.official) || []).some((o) => String(o.address).toLowerCase() === addr);
  if (!row) {
    return { ok: true, status: 'basics', clientSide: true, inIndex: false, token: { address: addr, isOfficial: official }, launch: null,
      note: 'This coin isn\'t in our launch index (yet, or it wasn\'t launched on Pons). ' + REPORT_NOTE };
  }
  const time = row.time == null ? null : Number(row.time);
  const launch = {};
  for (const k of ['token', 'factory', 'curve', 'creator', 'tx_from', 'pair_token', 'block', 'log_index', 'time', 'tx', 'name', 'symbol']) launch[k] = row[k] === undefined ? null : row[k];
  return {
    ok: true, status: 'basics', clientSide: true, inIndex: true,
    token: {
      address: addr, name: row.name, symbol: row.symbol, isOfficial: official,
      pons: { factory: row.factory, curve: row.curve, launchTx: row.tx, launchBlock: Number(row.block), launchTime: isoOf(time), pairToken: row.pair_token },
    },
    launch,
    proof: { token: tokenUrl(addr), launchTx: txUrl(row.tx), curve: addressUrl(row.curve) },
    note: REPORT_NOTE,
  };
}

async function reportBody(rawToken, deps) {
  const token = String(rawToken || '').trim();
  if (!isAddr(token)) return fail('bad-address', 'That isn\'t a coin address: it should be 0x and 40 letters or numbers.');
  const addr = token.toLowerCase();
  const index = deps.index || (deps.db ? d1Index(deps.db) : null);
  if (!index) return fail('unavailable', 'The launch index isn\'t connected.');
  let row;
  try { row = await index.findByToken(addr); } catch (e) { return fail('unavailable', 'The launch index is unavailable right now. Try again in a minute.'); }
  return { status: 200, body: reportBasicsOf(row, addr, deps), cacheSeconds: BROWSER_SECONDS };
}

function linksBody(rawToken) {
  const token = String(rawToken || '').trim();
  if (!isAddr(token)) return fail('bad-address', 'That isn\'t a coin address: it should be 0x and 40 letters or numbers.');
  return { status: 200, body: { ok: true, status: 'client', clientSide: true, token: token.toLowerCase(), funders: [], links: [], ignored: [],
    caveat: 'Wallets funded through exchanges, bridges or privacy tools can\'t be linked.', note: LINKS_NOTE }, cacheSeconds: 300 };
}

// =============================================================================================================
// The router
// =============================================================================================================
const RATE_LIMITED = (path) => path === '/mcp' || path === '/v1/alerts' || path === '/v1/radar' || path === '/v1/count' || path.startsWith('/v1/copies') || path.startsWith('/v1/report');

// ---- the blame counter ----------------------------------------------------------------------------------------
// POST /v1/count: the site sends one after each blame card it draws (no body; nothing about the visitor is kept,
// the rate limit counts in memory only). GET /v1/stats: { today, total, since } with today = the current UTC day.
const dayOf = (ms) => Math.floor(ms / 86400000);
async function countBody(deps, params = null) {
  if (!deps.db) return { status: 503, body: { ok: false, code: 'unavailable', message: 'Counter unavailable right now.' } };
  const kind = (params && params.get('kind')) || 'blame';
  const n = params && params.has('n') ? Number(params.get('n')) : 1;
  if (!COUNT_KINDS.includes(kind) || !Number.isInteger(n) || n < 1 || n > COUNT_MAX) {
    return { status: 400, body: { ok: false, code: 'bad-input', message: 'kind must be blame, check or flag; n 1 to ' + COUNT_MAX + '.' } };
  }
  try {
    await ensureTables(deps.db);
    if (kind === 'blame') await deps.db.prepare(SQL_COUNT_ADD).bind(dayOf(deps.now)).run();
    else await deps.db.prepare(SQL_EVENT_ADD).bind(dayOf(deps.now), kind, n).run();
    return { status: 200, body: { ok: true } };
  } catch (e) {
    return { status: 503, body: { ok: false, code: 'unavailable', message: 'Counter unavailable right now.' } };
  }
}
async function statsBody(deps) {
  if (!deps.db) return { status: 503, body: { ok: false, code: 'unavailable', message: 'Stats unavailable right now.' } };
  try {
    await ensureTables(deps.db);
    const r = await deps.db.prepare(SQL_COUNT_GET).bind(dayOf(deps.now)).first();
    const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Math.floor(Number(v)) : 0);
    const since = r && r.since != null && Number.isFinite(Number(r.since)) ? new Date(Number(r.since) * 86400000).toISOString().slice(0, 10) : null;
    const ev = await deps.db.prepare(SQL_EVENT_GET).bind(dayOf(deps.now)).all();
    const of = (k) => { const x = ((ev && ev.results) || []).find((e) => e.kind === k); return { today: num(x && x.today), total: num(x && x.total) }; };
    return { status: 200, body: { ok: true, today: num(r && r.today), total: num(r && r.total), since, day: 'UTC',
      checks: of('check'), flags: of('flag') }, cacheSeconds: STATS_SECONDS };
  } catch (e) {
    return { status: 503, body: { ok: false, code: 'unavailable', message: 'Stats unavailable right now.' } };
  }
}

async function handle(request, env, ctx, deps) {
  const url = parseUrl(request.url);
  const method = String(request.method || 'GET').toUpperCase();
  const origin = request.headers.get('origin');
  const allowed = deps.origins || allowedOrigins(env);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const cors = corsHeaders(origin, allowed);

  if (path === '/mcp') {
    if (method !== 'OPTIONS' && !(await limit(request, deps)).ok) return rateLimited(cors, deps);
    return mcpAnswer(request, env, ctx, deps);
  }
  if (method === 'OPTIONS') return jsonAnswer(204, null, { headers: preflightHeaders(origin, allowed) });

  const out = (r, extra = {}) => jsonAnswer(r.status, r.body, {
    cacheSeconds: r.status === 200 ? (r.cacheSeconds || 0) : 0,
    headers: { ...cors, 'x-bts-budget': budgetHeader(deps.budget), ...extra },
  });

  if (path === '/v1/count') {
    if (method !== 'POST') {
      return jsonAnswer(405, { ok: false, code: 'method', message: 'Only POST here.' }, { headers: { ...cors, allow: 'POST, OPTIONS' } });
    }
    const rl = await limit(request, deps);
    if (!rl.ok) return rateLimited(cors, deps, rl);
    const r = await countBody(deps, url.params);
    return jsonAnswer(r.status, r.body, { headers: cors });
  }
  if (method !== 'GET' && method !== 'HEAD') {
    return jsonAnswer(405, { ok: false, code: 'method', message: 'Only GET here.' }, { headers: { ...cors, allow: 'GET, OPTIONS' } });
  }
  if (RATE_LIMITED(path)) {
    const rl = await limit(request, deps);
    if (!rl.ok) return rateLimited(cors, deps, rl);
  }

  if (path === '/' || path === '/v1') {
    return jsonAnswer(200, {
      ok: true, service: 'bts-api', version: VERSION,
      about: 'Read-only facts about Robinhood Chain coins. Not financial advice. The launch index is served here; chain facts are read by the website in your browser.',
      endpoints: ['/v1/health', '/v1/stats', '/v1/alerts', '/v1/radar', '/v1/copies?q=TICKER|0xADDRESS', '/v1/report/0xTOKEN', '/v1/report/0xTOKEN/links', '/mcp'],
      site: 'https://blamethestock.com',
    }, { cacheSeconds: 300, headers: cors });
  }
  if (path === '/v1/health') {
    const r = await healthBody(deps);
    return jsonAnswer(r.status, r.body, { cacheSeconds: r.status === 200 ? HEALTH_SECONDS : 0, headers: cors });
  }
  if (path === '/v1/stats') {
    const r = await statsBody(deps);
    return jsonAnswer(r.status, r.body, { cacheSeconds: r.status === 200 ? r.cacheSeconds : 0, headers: cors });
  }
  if (path === '/v1/alerts') return out(await alertsBody(deps));
  if (path === '/v1/radar') return out(await radarBody(deps));
  if (path === '/v1/copies') {
    const p = url.params;
    const hint = p.has('name') || p.has('symbol') ? { name: p.get('name'), symbol: p.get('symbol') } : null;
    return out(await copiesBody(p.get('q'), deps, hint));
  }

  const m = /^\/v1\/report\/([^/]+)(\/links)?$/.exec(path);
  if (m) {
    const token = dec(m[1]);
    return out(m[2] ? linksBody(token) : await reportBody(token, deps));
  }
  return jsonAnswer(404, { ok: false, code: 'not-found', message: 'Nothing here. See /v1/health.' }, { headers: cors });
}

// Two layers, both in memory only (nothing about the visitor is stored):
//  1. this copy of the Worker's own counter (cheap, catches a burst that lands on one copy);
//  2. Cloudflare's rate-limit binding (env.RATE_LIMITER, see wrangler.toml), shared by every copy of the Worker in
//     a Cloudflare location, so many requests spread over many copies are still counted together.
// If the binding is missing or fails, the request is let through on the first layer alone (never a false 429).
async function limit(request, deps) {
  if (deps.limitResult) return deps.limitResult;     // one count per request
  const ip = request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || 'unknown';
  let res = deps.limiter ? deps.limiter.hit(ip, deps.now) : { ok: true };
  if (res.ok && deps.rateBinding && typeof deps.rateBinding.limit === 'function') {
    try {
      const out = await deps.rateBinding.limit({ key: ip });
      if (out && out.success === false) res = { ok: false, resetSeconds: 60 };
    } catch (e) { /* binding unavailable: the first layer stands */ }
  }
  deps.limitResult = res;
  return res;
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
    report: async (t) => (await reportBody(t, deps)).body,
    links: async (t) => linksBody(t).body,
  };
  try {
    const res = await handler(request, env, ctx, { settings: deps.settings, budget: moduleBudget(deps.budget), now: deps.now, api, fetch: routedFetch });
    return { raw: res };
  } catch (e) {
    return jsonAnswer(500, { jsonrpc: '2.0', error: { code: -32603, message: 'The MCP server hit an error. Try again.' }, id: null });
  }
}

// =============================================================================================================
// The cron: the indexer, then old cache rows out.
// =============================================================================================================
async function runScheduled(env, deps = {}) {
  const now = deps.now != null ? deps.now : Date.now();
  const budget = deps.budget || createBudget({ limit: DEFAULT_LIMIT, d1Limit: DEFAULT_D1_LIMIT });
  const rawDb = env && env.DB;
  const db = budget.wrapDb(rawDb);
  const log = deps.log || ((t) => console.log(t));
  const out = { indexer: null, purged: false, budget: null };
  if (!rawDb) { out.indexer = { ok: false, error: 'DB binding missing' }; return out; }

  // 1. the launch index (dRPC in 100-block pieces; the official node only as a last resort)
  const ib = budget.child(INDEXER_SUBREQUESTS);
  try {
    out.indexer = await withBudget(ib, () => (deps.runIndexer || runIndexer)({ ...env, DB: ib.wrapDb(rawDb) }, {
      maxBlocks: INDEXER_MAX_BLOCKS, maxRows: INDEXER_MAX_ROWS, logSpan: INDEXER_LOG_SPAN, maxLogRequests: INDEXER_LOG_REQUESTS, log, now: () => now,
    }));
  } catch (e) {
    out.indexer = { ok: false, error: errText(e) };
    log('indexer: stopped: ' + errText(e));
  }
  out.indexerBudget = ib.snapshot();

  // 2. expired cache rows (and rows left by the old report/link job queue)
  try {
    await ensureTables(db);
    const nowS = nowSeconds(now);
    await db.batch([db.prepare(SQL_CACHE_PURGE).bind(nowS), db.prepare(SQL_JOBS_PURGE).bind(nowS - JOBS_MAX_AGE)]);
    out.purged = true;
  } catch (e) { /* next minute */ }

  out.budget = budget.snapshot();
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
    settings: settingsFor(env),
    cache: cfCache(budget, url.origin, ctx),
    limiter,
    rateBinding: env && env.RATE_LIMITER ? env.RATE_LIMITER : null,
    ...extra,
  };
}

// The entry module may export only the handler (workerd treats every named export as an entrypoint), so the
// testable parts ride along as `internals` (workerd ignores keys it doesn't know). dev/tests/worker.test.js uses them.
const internals = {
  VERSION, DEFAULT_ORIGINS, RATE, TTL, BROWSER_SECONDS, HEALTH_SECONDS, INDEXER_SUBREQUESTS, INDEXER_LOG_SPAN, INDEXER_LOG_REQUESTS,
  INDEXER_MAX_BLOCKS, INDEXER_MAX_ROWS, AVOID, REPORT_NOTE, LINKS_NOTE,
  SQL_SCHEMA, SQL_COUNT_ADD, SQL_COUNT_GET, SQL_EVENT_ADD, SQL_EVENT_GET, STATS_SECONDS, SQL_META, SQL_OLDEST_TIME, SQL_NEWEST_AT, SQL_CACHE_GET, SQL_CACHE_PUT, SQL_CACHE_PURGE, SQL_JOBS_PURGE,
  rowCachedIndex, parseUrl, allowedOrigins, corsHeaders, preflightHeaders, hashKey, createRateLimiter, settingsFor, statusFor,
  jsonAnswer, toResponse, routedFetch, withBudget, useAsyncLocalStorage, requestLanes, _resetForTests, ensureTables, cfCache, d1Get, d1Put, cacheGet,
  cachePut, healthBody, countBody, statsBody, copiesBody, reportBody, linksBody, reportBasicsOf, handle, runScheduled, requestDeps,
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
    console.log('cron: ' + JSON.stringify({ indexer: out.indexer && { from: out.indexer.from, to: out.indexer.to, head: out.indexer.head, written: out.indexer.written, logRequests: out.indexer.logRequests, error: out.indexer.error }, budget: out.budget }));
  },
};
