// Launch report: launchReport({ token, env, settings, now, budget }) -> ReportResult | building | ErrorResult
//
//   token     a Pons coin address (0x + 40 hex)
//   env       the Worker env: env.DB = the D1 binding (api/schema.sql + api/schema-reports.sql)
//   settings  SETTINGS (uses .trust: sniperWindowBlocks, official list) or the trust block itself
//   now       ms (Date.now())
//   budget    this request's createBudget() (api/src/budget.js). The report uses at most REPORT_SUBREQUESTS of it.
//   optional: fetch (base fetch when no budget is given), sleep (explorer back-off; tests), store (in place of
//             env.DB, see memoryStore), refresh (false = never start a refresh of a finished report)
//
// Free-plan design (10 ms CPU, 50 subrequests per request): the report is built in small steps (launch, graduation,
// first buyers, dev transfers, receipts, fees, bridges, first buyers' transfers, hourly activity, block times).
// Each step is persisted in D1 (report_jobs) as soon as it finishes; when the request's budget runs low the answer
// is { ok:true, status:'building', progress } and the next call (or the cron, advanceReportJobs) carries on where
// it stopped. A finished report is cached in report_cache for REPORT_TTL seconds; after that the next call refreshes
// it incrementally (only blocks after the last build are read) and, until the refresh is done, serves the previous
// report. Nothing about the visitor is read or stored: jobs and caches are keyed by the coin only.
//
// scheduled() should call advanceReportJobs() (here) and advanceLinkJobs() (links.js) after runIndexer().
import { createBudget, BudgetExceeded } from './budget.js';
import { d1Index } from './copies.js';
import { FACTORY_ADDRESSES } from './env.js';
import { _setTransport, rpcBatch, RpcError, logOpts } from '../../site/src/data/rpc.js';
import { batchLatest, blockTimes, getCode, headBlock, toHex, wordAt, ethCall, tokenFacts } from '../../site/src/data/chain.js';
import * as K from '../../site/src/data/constants.js';
import { TOPIC, ADDR, pad, addrOf, iso, makeExplorer, normalizeRow, launchRowFromChain, tokenMeta, getLogsAll, decodeText } from '../../site/src/trust/facts.js';
import { trustSettings } from '../../site/src/trust/rules.js';
import * as RR from '../../site/src/trust/report-rules.js';

export const REPORT_TTL = 300;              // s: a finished report is served this long, then refreshed
export const ERROR_TTL = 3600;              // s: "not a Pons coin" answers are kept this long
export const KEEP_SECONDS = 30 * 86400;     // cache rows are purged after this
export const REPORT_SUBREQUESTS = 40;       // at most this many fetches per request for the report
export const LEASE_SECONDS = 25;            // one worker at a time per job
export const MAX_TRIES = 3;                 // failed tries of one step before it is skipped (and named in `missing`)
const SNIPERS_PER_STEP = 6;                 // wallets whose Transfers are read per step (2 calls each, one request per 6)
const TX_PER_STEP = 12;                     // receipts per step
const CHECK_PER_WALLET = 10;                // a first buyer's biggest transfers to other addresses checked for a sale
const MAX_SNIPER_TX = 120;                  // receipts read for those checks in one build (the rest stay "moved")
export const STATE_V = 2;                   // job state version: an older state is rebuilt from scratch
const TIMES_PER_STEP = 30;                  // block times per step
const MAX_SNIPERS = 60;                     // first buyers followed (largest first); the rest are noted
const MAX_DEV_TRANSFERS = 400;              // dev Transfer logs kept
const BRIDGE_DAYS = 7;
const ACT_SPAN = { start: 20000, min: 500, max: 400000, many: 1500, few: 300 };
const SEEN_CAP = 6000;                      // buyer wallets remembered for "new wallets" (10-hex prefixes; keeps the state small)
const DEV_TX_PAGES = 2;
const SEL_BALANCE_OF = '0x70a08231';

const STEP_COST = { head: 2, launch: 10, graduation: 3, snipers: 4, dev: 2, devTx: 3, fees: 2, bridges: 6, sniperMoves: 3, sniperTx: 2, activity: 2, times: 6, finalize: 0 };

const fail = (code, message) => ({ ok: false, code, message });
const MESSAGES = {
  'bad-address': 'That isn\'t a coin address. Paste a Pons coin address: 0x followed by 40 letters or numbers.',
  'not-found': 'We couldn\'t find a coin at this address on Robinhood Chain.',
  'not-pons': 'This coin wasn\'t launched on Pons, so there is no launch report for it.',
  'rpc-failed': 'Robinhood Chain didn\'t answer. Try again in a moment.',
  unavailable: 'The launch report is unavailable right now. Try again in a minute.',
};
const lower = (a) => (a == null ? null : String(a).toLowerCase());
const num = (h) => parseInt(h, 16);
const nowSec = (now) => Math.floor(Number(now == null ? Date.now() : now) / 1000);

// =============================================================================================================
// Storage: D1 (report_jobs, report_cache from api/schema-reports.sql; launches from api/schema.sql)
// =============================================================================================================
export const SQL = {
  GET_JOB: 'SELECT key, kind, token, status, step, progress, state, attempts, created_at, updated_at, lease_until FROM report_jobs WHERE key = ?1',
  // Insert a new job holding the lease, or take the lease of an existing one when nobody holds it.
  CLAIM_JOB: 'INSERT INTO report_jobs (key, kind, token, status, step, progress, state, attempts, created_at, updated_at, lease_until) '
    + 'VALUES (?1, ?2, ?3, \'queued\', NULL, 0, \'{}\', 0, ?4, ?4, ?5) '
    + 'ON CONFLICT(key) DO UPDATE SET lease_until = excluded.lease_until '
    + 'WHERE report_jobs.lease_until IS NULL OR report_jobs.lease_until < excluded.updated_at',
  SAVE_JOB: 'UPDATE report_jobs SET status = ?2, step = ?3, progress = ?4, state = ?5, attempts = ?6, updated_at = ?7, lease_until = ?8 WHERE key = ?1',
  QUEUED: 'SELECT key, kind, token FROM report_jobs WHERE kind = ?1 AND status IN (\'queued\', \'building\') '
    + 'AND (lease_until IS NULL OR lease_until < ?2) ORDER BY updated_at ASC LIMIT ?3',
  PUT_CACHE: 'INSERT INTO report_cache (key, value, created_at, expires_at) VALUES (?1, ?2, ?3, ?4) '
    + 'ON CONFLICT(key) DO UPDATE SET value = excluded.value, created_at = excluded.created_at, expires_at = excluded.expires_at',
  PURGE_CACHE: 'DELETE FROM report_cache WHERE key IN (SELECT key FROM report_cache WHERE expires_at IS NOT NULL AND expires_at < ?1 LIMIT ?2)',
  PURGE_JOBS: 'DELETE FROM report_jobs WHERE key IN (SELECT key FROM report_jobs WHERE updated_at < ?1 LIMIT ?2)',
};
const getCachesSql = (n) => 'SELECT key, value, created_at, expires_at FROM report_cache WHERE key IN ('
  + Array.from({ length: n }, (_, i) => '?' + (i + 1)).join(', ') + ')';

const parse = (s, dflt) => { try { return s == null ? dflt : JSON.parse(s); } catch (e) { return dflt; } };
function jobFromRow(r) {
  return {
    key: r.key, kind: r.kind, token: r.token, status: r.status, step: r.step, progress: Number(r.progress) || 0,
    state: parse(r.state, {}), attempts: Number(r.attempts) || 0, createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
    leaseUntil: r.lease_until == null ? null : Number(r.lease_until),
  };
}

export function d1Store(db) {
  const index = d1Index(db);
  return {
    async launchRow(token) { return index.findByToken(token); },
    async getJob(key) {
      const r = await db.prepare(SQL.GET_JOB).bind(key).first();
      return r ? jobFromRow(r) : null;
    },
    async claimJob(key, kind, token, nowS, leaseS = LEASE_SECONDS) {
      const r = await db.prepare(SQL.CLAIM_JOB).bind(key, kind, token, nowS, nowS + leaseS).run();
      return !!(r && r.meta && r.meta.changes > 0);
    },
    async saveJob(job, { release = false } = {}) {
      await db.prepare(SQL.SAVE_JOB).bind(job.key, job.status, job.step || null, job.progress || 0, JSON.stringify(job.state || {}),
        job.attempts || 0, job.updatedAt, release ? null : job.leaseUntil).run();
    },
    async getCaches(keys) {
      const out = new Map();
      if (!keys.length) return out;
      const res = await db.prepare(getCachesSql(keys.length)).bind(...keys).all();
      for (const r of (res && res.results) || []) {
        out.set(r.key, { value: parse(r.value, null), createdAt: Number(r.created_at), expiresAt: r.expires_at == null ? null : Number(r.expires_at) });
      }
      return out;
    },
    async putCaches(list) {
      if (!list.length) return;
      const st = list.map((c) => db.prepare(SQL.PUT_CACHE).bind(c.key, JSON.stringify(c.value), c.createdAt, c.expiresAt == null ? null : c.expiresAt));
      if (st.length === 1) await st[0].run(); else await db.batch(st);
    },
    async queued(kind, nowS, limit = 5) {
      const res = await db.prepare(SQL.QUEUED).bind(kind, nowS, limit).all();
      return (res && res.results) || [];
    },
    async purge(nowS, limit = 200) {
      await db.batch([db.prepare(SQL.PURGE_CACHE).bind(nowS, limit), db.prepare(SQL.PURGE_JOBS).bind(nowS - KEEP_SECONDS, limit)]);
    },
  };
}

// The same interface in memory (tests; a local run without D1). rows = launch-index rows.
export function memoryStore({ rows = [] } = {}) {
  const jobs = new Map(), cache = new Map();
  const copy = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
  const st = {
    jobs, cache, writes: 0, reads: 0,
    async launchRow(token) { st.reads++; return copy(rows.find((r) => String(r.token).toLowerCase() === token) || null); },
    async getJob(key) { st.reads++; return copy(jobs.get(key) || null); },
    async claimJob(key, kind, token, nowS, leaseS = LEASE_SECONDS) {
      st.writes++;
      const j = jobs.get(key);
      if (!j) {
        jobs.set(key, { key, kind, token, status: 'queued', step: null, progress: 0, state: {}, attempts: 0, createdAt: nowS, updatedAt: nowS, leaseUntil: nowS + leaseS });
        return true;
      }
      if (j.leaseUntil != null && j.leaseUntil >= nowS) return false;
      j.leaseUntil = nowS + leaseS;
      return true;
    },
    async saveJob(job, { release = false } = {}) {
      st.writes++;
      const j = jobs.get(job.key);
      if (!j) return;
      Object.assign(j, copy({ status: job.status, step: job.step || null, progress: job.progress || 0, state: job.state || {}, attempts: job.attempts || 0, updatedAt: job.updatedAt }));
      j.leaseUntil = release ? null : job.leaseUntil;
    },
    async getCaches(keys) {
      st.reads++;
      const out = new Map();
      for (const k of keys) if (cache.has(k)) out.set(k, copy(cache.get(k)));
      return out;
    },
    async putCaches(list) {
      st.writes++;
      for (const c of list) cache.set(c.key, copy({ value: c.value, createdAt: c.createdAt, expiresAt: c.expiresAt == null ? null : c.expiresAt }));
    },
    async queued(kind, nowS, limit = 5) {
      st.reads++;
      return [...jobs.values()].filter((j) => j.kind === kind && (j.status === 'queued' || j.status === 'building') && (j.leaseUntil == null || j.leaseUntil < nowS))
        .sort((a, b) => a.updatedAt - b.updatedAt).slice(0, limit).map((j) => ({ key: j.key, kind: j.kind, token: j.token }));
    },
    async purge(nowS) {
      st.writes++;
      for (const [k, c] of cache) if (c.expiresAt != null && c.expiresAt < nowS) cache.delete(k);
      for (const [k, j] of jobs) if (j.updatedAt < nowS - KEEP_SECONDS) jobs.delete(k);
    },
  };
  return st;
}

export function storeFor({ env = null, store = null, budget = null } = {}) {
  if (store) return store;
  const db = env && env.DB;
  if (!db || typeof db.prepare !== 'function') return null;
  return d1Store(budget && typeof budget.wrapDb === 'function' ? budget.wrapDb(db) : db);
}

// =============================================================================================================
// Chain reads (all through site/src/data/rpc.js, so retries, 429 back-off and the request budget apply)
// =============================================================================================================
class StepError extends Error {}

function must(res) {
  for (const r of res) if (r && r.error) throw r.error;
  return res.map((r) => (r ? r.result : null));
}

// Several eth_getLogs in one JSON-RPC batch on the official node (one HTTP request per 6 calls).
// filters: [{ address, topics, from, to }]. A range wider than the node allows, or an answer over 10,000 logs,
// is read with getLogsAll (split ranges) instead.
export async function logsMany(filters) {
  const out = new Array(filters.length);
  const direct = [];
  filters.forEach((f, i) => {
    if (f.to < f.from) out[i] = [];
    else if (f.to - f.from > 9999999) direct.push(i);
    else out[i] = undefined;
  });
  const idx = filters.map((_, i) => i).filter((i) => out[i] === undefined && !direct.includes(i));
  if (idx.length) {
    const calls = idx.map((i) => ({ method: 'eth_getLogs', params: [{ address: filters[i].address, topics: filters[i].topics, fromBlock: toHex(filters[i].from), toBlock: toHex(filters[i].to) }] }));
    const res = await rpcBatch('official', calls, logOpts());
    idx.forEach((i, k) => {
      const r = res[k];
      if (r && r.error) {
        if (r.error instanceof RpcError && r.error.overCap) direct.push(i);
        else throw r.error;
      } else out[i] = (r && r.result) || [];
    });
  }
  for (const i of direct) {
    const f = filters[i];
    out[i] = await getLogsAll({ address: f.address, topics: f.topics }, f.from, f.to, { maxCalls: 4 });
  }
  return out.map((logs) => logs.slice().sort((x, y) => num(x.blockNumber) - num(y.blockNumber) || num(x.logIndex) - num(y.logIndex)));
}

const tLog = (l) => ({ from: addrOf(l.topics[1]), to: addrOf(l.topics[2]), raw: wordAt(l.data, 0).toString(), tx: l.transactionHash.toLowerCase(), block: num(l.blockNumber), li: num(l.logIndex) });

function signed256(w) { return w >= 1n << 255n ? w - (1n << 256n) : w; }
const abs = (x) => (x < 0n ? -x : x);

// What one receipt shows about a trade of the coin: curve sell (quote out), curve buy for `wallet` (quote in),
// a v4 swap anywhere (sell-like) and the pair-side amount of a swap on the coin's own pool.
export function receiptInfo(rc, { curve, wallet, pool = null, pairToken = null }) {
  const info = { curveSell: null, curveBuy: null, v4Quote: null, swap: false };
  if (!rc) return info;
  let sell = null, buy = null, v4 = null;
  const pairIs0 = pool && pairToken != null ? pool.currency0 === (pairToken === K.WETH ? K.WETH : pairToken) : true;
  for (const l of rc.logs || []) {
    const at = String(l.address).toLowerCase();
    if (at === curve && l.topics[0] === TOPIC.CURVE_SELL) sell = (sell || 0n) + wordAt(l.data, 1);
    if (at === curve && l.topics[0] === TOPIC.CURVE_BUY && addrOf(l.topics[2]) === wallet) buy = (buy || 0n) + wordAt(l.data, 0);
    if (at === K.POOL_MANAGER && l.topics[0] === K.TOPIC_V4_SWAP) {
      info.swap = true;
      if (pool && String(l.topics[1]).toLowerCase() === pool.id) v4 = (v4 || 0n) + abs(signed256(wordAt(l.data, pairIs0 ? 0 : 1)));
    }
  }
  if (sell != null) info.curveSell = sell.toString();
  if (buy != null) info.curveBuy = buy.toString();
  if (v4 != null) info.v4Quote = v4.toString();
  return info;
}

function findPool(rc, token) {
  for (const x of (rc && rc.logs) || []) {
    if (String(x.address).toLowerCase() !== K.POOL_MANAGER || x.topics[0] !== K.TOPIC_V4_INITIALIZE || x.topics.length < 4) continue;
    const c0 = addrOf(x.topics[2]), c1 = addrOf(x.topics[3]);
    if (c0 === token || c1 === token) return { id: x.topics[1].toLowerCase(), currency0: c0, currency1: c1 };
  }
  return null;
}

// =============================================================================================================
// The steps. Each reads a little, writes into the job state S and returns; S is saved after every step.
// S.target = the head block this build reads up to ({ number, time }).
// =============================================================================================================
function newState(token) {
  return { v: STATE_V, token, target: null, built: null, row: null, launch: null, grad: null, gradThrough: null, snipers: null,
    flows: {}, flowThrough: {}, sniperTxRead: 0, dev: null, txInfo: {}, fees: null, bridges: null, activity: null, times: {},
    missing: [], problems: [], tries: {}, skip: {}, error: null };
}

const H = (S) => S.target.number;
const pushOnce = (list, v) => { if (!list.includes(v)) list.push(v); };

// Blocks whose times the report shows.
function neededBlocks(S) {
  const need = new Set();
  if (!S.launch || !S.target) return [];
  const launchTx = S.row.tx;
  for (const t of S.dev ? S.dev.transfers : []) if (!(t.dir === 'in' && t.tx === launchTx)) need.add(t.block);
  for (const c of S.fees ? S.fees.claims : []) need.add(c.block);
  for (const b of S.bridges ? S.bridges.list : []) if (b.time == null && b.block != null) need.add(b.block);
  if (S.snipers) {
    for (const b of S.snipers.buys) need.add(b.block);
    const end = S.row.block + S.snipers.windowBlocks;
    if (end <= H(S)) need.add(end);
    for (const b of S.snipers.buys) {
      const f = S.flows[b.wallet];
      if (!f || !f.sells.length) continue;
      need.add(f.sells[f.sells.length - 1].block);
      if (S.grad) { const a = f.sells.find((x) => x.block > S.grad.block); if (a) need.add(a.block); }
    }
  }
  return [...need].filter((b) => b != null && S.times[b] == null && b <= H(S)).sort((a, b) => a - b);
}

function devTxNeeded(S) {
  if (!S.dev) return [];
  const out = new Set();
  for (const t of S.dev.transfers) {
    if (t.dir === 'in' && t.tx === S.row.tx) continue;
    if (t.dir === 'out' && (t.other === ADDR.ZERO || t.other === ADDR.DEAD)) continue;
    if (!S.txInfo[t.tx]) out.add(t.tx);
  }
  return [...out];
}

// Receipts still to read for first buyers' transfers to other addresses (an aggregator or a bot contract that sells).
function sniperTxNeeded(S) {
  if (!S.snipers) return [];
  const out = new Set();
  for (const b of S.snipers.buys) {
    const f = S.flows[b.wallet];
    if (f && f.check) for (const c of f.check) out.add(c.tx);
  }
  return [...out];
}

function activityEnd(S) {
  return S.grad ? Math.min(H(S), S.grad.block) : H(S);
}

const STEPS = [
  { name: 'head', pending: (S) => !S.target, run: stepHead },
  { name: 'launch', pending: (S) => !S.launch, run: stepLaunch },
  { name: 'graduation', pending: (S) => !S.grad && (S.gradThrough == null || S.gradThrough < H(S)), run: stepGraduation },
  { name: 'snipers', pending: (S) => !S.snipers || (!S.snipers.final && S.snipers.through < H(S)), run: stepSnipers },
  { name: 'dev', pending: (S) => S.dev.through < H(S), run: stepDev },
  { name: 'devTx', pending: (S) => devTxNeeded(S).length > 0, run: stepDevTx },
  { name: 'fees', pending: (S) => !!S.fees && S.fees.through < H(S), run: stepFees },
  { name: 'bridges', pending: (S) => !S.bridges || (!S.bridges.final && S.bridges.through < H(S)), run: stepBridges },
  { name: 'sniperMoves', pending: (S) => !!S.snipers && S.snipers.buys.some((b) => (S.flowThrough[b.wallet] == null ? -1 : S.flowThrough[b.wallet]) < H(S)), run: stepSniperMoves },
  { name: 'sniperTx', pending: (S) => sniperTxNeeded(S).length > 0, run: stepSniperTx },
  { name: 'activity', pending: (S) => !S.activity.complete && S.activity.through < activityEnd(S), run: stepActivity },
  { name: 'times', pending: (S) => neededBlocks(S).length > 0, run: stepTimes },
];

async function stepHead(S) {
  const h = await headBlock();
  if (S.built && h.number <= S.built.number) S.target = { ...S.built };
  else S.target = h;
}

async function stepLaunch(S, cx) {
  const token = S.token;
  let row = await cx.store.launchRow(token);
  if (!row) {
    row = await launchRowFromChain(token, { head: S.target, factories: FACTORY_ADDRESSES.map(lower) });
    if (!row) {
      const meta = await tokenMeta(token);
      S.error = meta.name || meta.symbol ? 'not-pons' : 'not-found';
      return;
    }
    pushOnce(S.problems, 'This coin isn\'t in our launch index yet, so its launch was read straight from the chain.');
  }
  const r = normalizeRow(row);
  const calls = [{ method: 'eth_getTransactionByHash', params: [r.tx] }, { method: 'eth_getTransactionReceipt', params: [r.tx] }];
  const noNames = !r.name && !r.symbol;
  if (noNames) calls.push(ethCall(token, '0x06fdde03'), ethCall(token, K.SEL_SYMBOL));
  const res = must(await batchLatest(calls));
  const [tx, rc] = res;
  if (!tx || !rc) throw new StepError('launch tx not found');
  if (noNames) { r.name = decodeText(res[2]); r.symbol = decodeText(res[3], 64); }
  const from = String(tx.from).toLowerCase();
  let dev, viaMulticall = false;
  if (r.creator === ADDR.MULTICALL3) { dev = r.txFrom || from; viaMulticall = true; }
  else if (r.creator && r.creator !== from) {
    const code = await getCode(r.creator);                       // a contract launched it (smart wallet, batcher)
    dev = code && code !== '0x' ? from : r.creator;
  } else dev = r.creator || from;
  let supply = 0n, quoteRaw = null, tokensRaw = null;
  for (const l of rc.logs || []) {
    const at = String(l.address).toLowerCase();
    if (at === r.token && l.topics[0] === TOPIC.TRANSFER && addrOf(l.topics[1]) === ADDR.ZERO) supply += wordAt(l.data, 0);
    if (at === r.curve && l.topics[0] === TOPIC.CURVE_BUY && addrOf(l.topics[2]) === dev) {
      quoteRaw = (quoteRaw || 0n) + wordAt(l.data, 0); tokensRaw = (tokensRaw || 0n) + wordAt(l.data, 1);
    }
  }
  if (supply === 0n) supply = 10n ** 27n;                        // every Pons launch mints 1,000,000,000 (18 decimals)
  if (tokensRaw == null) {
    const l = (rc.logs || []).find((x) => x.topics[0] === TOPIC.LAUNCHED && addrOf(wordAt(x.data, 0).toString(16).padStart(40, '0')) === dev);
    if (l) { quoteRaw = wordAt(l.data, 1); tokensRaw = wordAt(l.data, 2); }
  }
  const isEth = r.pairToken === ADDR.ZERO || r.pairToken === K.WETH;
  let quoteDecimals = 18;
  if (!isEth) {
    quoteDecimals = K.KNOWN_DECIMALS[r.pairToken];
    if (quoteDecimals == null) quoteDecimals = (await tokenFacts([r.pairToken])).get(r.pairToken).decimals;
  }
  const time = r.time != null ? r.time : (await blockTimes([r.block]))[0];
  S.row = { token: r.token, factory: r.factory, curve: r.curve, creator: r.creator, pairToken: r.pairToken, block: r.block, time, tx: r.tx, name: r.name, symbol: r.symbol };
  S.launch = {
    dev, from, viaMulticall, supplyRaw: supply.toString(), isEth, quoteDecimals,
    buy: tokensRaw != null && tokensRaw > 0n ? { quoteRaw: quoteRaw.toString(), tokensRaw: tokensRaw.toString() } : null,
  };
  S.times[r.block] = time;
  S.dev = { through: r.block - 1, transfers: [] };
  S.fees = !r.factory || r.factory === ADDR.FACTORY_V2 ? { through: r.block - 1, claims: [], unclaimedRaw: null } : null;
  S.activity = { through: r.block - 1, last: { block: r.block, time }, span: ACT_SPAN.start, counts: {}, seen: [], buys: 0, complete: false };
}

async function stepGraduation(S) {
  const from = S.gradThrough == null ? S.row.block : S.gradThrough + 1;
  const [logs] = await logsMany([{ address: S.row.curve, topics: [TOPIC.CURVE_COMPLETED], from, to: H(S) }]);
  if (logs.length) {
    const l = logs[0];
    const tx = l.transactionHash.toLowerCase(), block = num(l.blockNumber);
    const [rc, blk] = must(await batchLatest([{ method: 'eth_getTransactionReceipt', params: [tx] }, { method: 'eth_getBlockByNumber', params: [toHex(block), false] }]));
    if (!blk) throw new StepError('graduation block not found');
    S.grad = { block, tx, time: num(blk.timestamp), pool: findPool(rc, S.row.token) };
    S.times[block] = S.grad.time;
  }
  S.gradThrough = H(S);
}

// First buyers: CurveBuy in launch block + 0..W. The wallet is the recipient when the Pons router or LaunchAndBuy
// bought for it; for direct and aggregator buys (buyer == recipient) and the rare buy whose recipient is a Pons
// contract it is the tx sender. The dev and the launch creator are left out (same rules as the copy check).
async function stepSnipers(S, cx) {
  const W = cx.trust.sniperWindowBlocks;
  const to = Math.min(H(S), S.row.block + W);
  const [logs] = await logsMany([{ address: S.row.curve, topics: [TOPIC.CURVE_BUY], from: S.row.block, to }]);
  const rows = logs.map((l) => ({ buyer: addrOf(l.topics[1]), recipient: addrOf(l.topics[2]), raw: wordAt(l.data, 1), tx: l.transactionHash.toLowerCase(), block: num(l.blockNumber) }));
  const pons = (a) => a === ADDR.ROUTER || a === ADDR.LAUNCH_AND_BUY;
  const needFrom = (x) => (!pons(x.buyer) && x.buyer === x.recipient) || pons(x.recipient);
  // A contract that is not Pons buying for another wallet (a bundler): its sender says who paid for the buy.
  const bundler = (x) => !pons(x.buyer) && x.buyer !== x.recipient;
  const hashes = [...new Set(rows.filter((x) => (needFrom(x) || bundler(x)) && x.tx !== S.row.tx).map((x) => x.tx))];
  const txs = hashes.length ? must(await batchLatest(hashes.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })))) : [];
  const fromOf = new Map(txs.filter(Boolean).map((t) => [t.hash.toLowerCase(), String(t.from).toLowerCase()]));
  fromOf.set(S.row.tx, S.launch.from);
  const by = new Map();
  for (const x of rows) {
    const wallet = needFrom(x) ? (fromOf.get(x.tx) || x.recipient) : x.recipient;
    if (wallet === S.launch.dev || wallet === S.row.creator || pons(wallet)) continue;
    const cur = by.get(wallet) || { wallet, raw: 0n, block: x.block, tx: x.tx };
    cur.raw += x.raw;
    // bought in the launch transaction itself, or in a transaction the dev sent: the dev paid for these coins
    const sender = fromOf.get(x.tx);
    if (x.tx === S.row.tx || sender === S.launch.dev) cur.byDev = true;
    by.set(wallet, cur);
  }
  let buys = [...by.values()].sort((a, b) => (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0));
  if (buys.length > MAX_SNIPERS) {
    pushOnce(S.problems, 'Only the ' + MAX_SNIPERS + ' biggest of ' + buys.length + ' first buyers are followed.');
    buys = buys.slice(0, MAX_SNIPERS);
  }
  buys = buys.map((b) => ({ wallet: b.wallet, raw: b.raw.toString(), block: b.block, tx: b.tx, ...(b.byDev ? { byDev: true } : {}) })).sort((a, b) => a.block - b.block || (a.wallet < b.wallet ? -1 : 1));
  S.snipers = { windowBlocks: W, buys, through: to, final: to === S.row.block + W };
  for (const b of buys) if (S.flowThrough[b.wallet] == null) S.flowThrough[b.wallet] = S.row.block - 1;
}

async function stepDev(S) {
  const dev = S.launch.dev, from = S.dev.through + 1, to = H(S);
  const [outs, ins] = await logsMany([
    { address: S.row.token, topics: [TOPIC.TRANSFER, pad(dev)], from, to },
    { address: S.row.token, topics: [TOPIC.TRANSFER, null, pad(dev)], from, to },
  ]);
  const list = S.dev.transfers;
  for (const l of outs) { const t = tLog(l); if (t.to !== dev) list.push({ dir: 'out', other: t.to, raw: t.raw, tx: t.tx, block: t.block, li: t.li }); }
  for (const l of ins) { const t = tLog(l); if (t.from !== dev) list.push({ dir: 'in', other: t.from, raw: t.raw, tx: t.tx, block: t.block, li: t.li }); }
  list.sort((a, b) => a.block - b.block || a.li - b.li);
  if (list.length > MAX_DEV_TRANSFERS) {
    pushOnce(S.problems, 'The dev wallet moved this coin more than ' + MAX_DEV_TRANSFERS + ' times; only the first ' + MAX_DEV_TRANSFERS + ' are shown.');
    S.dev.transfers = list.slice(0, MAX_DEV_TRANSFERS);
  }
  S.dev.through = to;
}

async function stepDevTx(S) {
  const todo = devTxNeeded(S).slice(0, TX_PER_STEP);
  const rcs = must(await batchLatest(todo.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] }))));
  todo.forEach((h, i) => {
    S.txInfo[h] = receiptInfo(rcs[i], { curve: S.row.curve, wallet: S.launch.dev, pool: S.grad && S.grad.pool, pairToken: S.row.pairToken });
  });
}

async function stepFees(S) {
  const dev = S.launch.dev, from = S.fees.through + 1, to = H(S);
  const calls = [ethCall(ADDR.FEE_ESCROW, SEL_BALANCE_OF + pad(dev).slice(2))];
  const span = to - from;
  if (span >= 0 && span <= 9999999) calls.push({ method: 'eth_getLogs', params: [{ address: ADDR.FEE_ESCROW, topics: [TOPIC.CLAIMED, pad(dev)], fromBlock: toHex(from), toBlock: toHex(to) }] });
  const res = await rpcBatch('official', calls, logOpts());
  if (res[0].error) throw res[0].error;
  let logs;
  if (calls.length > 1) {
    if (res[1].error && !(res[1].error instanceof RpcError && res[1].error.overCap)) throw res[1].error;
    logs = res[1].error ? null : res[1].result || [];
  }
  if (logs == null) logs = span < 0 ? [] : await getLogsAll({ address: ADDR.FEE_ESCROW, topics: [TOPIC.CLAIMED, pad(dev)] }, from, to, { maxCalls: 3 });
  for (const l of logs) S.fees.claims.push({ tx: l.transactionHash.toLowerCase(), block: num(l.blockNumber), raw: wordAt(l.data, 0).toString() });
  S.fees.unclaimedRaw = wordAt(res[0].result, 0).toString();
  S.fees.through = to;
}

// ETH the dev bridged out in the first 7 days: ArbSys withdrawals to the dev's own L1 address and Across deposits by
// the dev (logs), plus the dev's own MetaBridge / RelayDepository / ArbSys / Across calls from the explorer.
async function stepBridges(S, cx) {
  const dev = S.launch.dev, launchTime = S.row.time, end = launchTime + BRIDGE_DAYS * 86400;
  const toBlock = Math.min(H(S), S.row.block + Math.ceil((BRIDGE_DAYS * 86400 * 1.5) / K.BLOCK_SECONDS));
  const [arb, across] = await logsMany([
    { address: ADDR.ARBSYS, topics: [TOPIC.L2_TO_L1, pad(dev)], from: S.row.block, to: toBlock },
    { address: ADDR.ACROSS_SPOKE, topics: [TOPIC.FUNDS_DEPOSITED, null, null, pad(dev)], from: S.row.block, to: toBlock },
  ]);
  const found = new Map();
  for (const l of arb) {
    const h = l.transactionHash.toLowerCase();
    found.set(h, { via: 'Arbitrum native bridge', eth: Number(wordAt(l.data, 4)) / 1e18, block: num(l.blockNumber), time: null, tx: h });
  }
  for (const l of across) {
    const input = addrOf(l.data.slice(2, 66));
    if (input !== K.WETH && input !== ADDR.ZERO) continue;
    const h = l.transactionHash.toLowerCase();
    found.set(h, { via: 'Across', eth: Number(wordAt(l.data, 2)) / 1e18, block: num(l.blockNumber), time: null, tx: h, destChainId: Number(BigInt(l.topics[1])), destChainConfirmed: true });
  }
  // the dev's own calls (explorer)
  const mine = [];
  let partial = false, q = '';
  for (let page = 0; page < DEV_TX_PAGES; page++) {
    if (!cx.budget.has(3)) throw new BudgetExceeded();          // retried by the next call with a fresh budget
    const r = await cx.explorer.get('/api/v2/addresses/' + dev + '/transactions?filter=from' + q);
    if (!r.ok) { if (r.reason !== 'not-found') partial = true; break; }
    const items = (r.json && r.json.items) || [];
    let older = false;
    for (const it of items) {
      const t = Date.parse(it.timestamp) / 1000;
      if (!Number.isFinite(t)) continue;
      if (t < launchTime) { older = true; continue; }
      if (t > end || (it.block_number != null && Number(it.block_number) > H(S))) continue;
      if (it.status && it.status !== 'ok') continue;
      const to = it.to && it.to.hash ? it.to.hash.toLowerCase() : null;
      if (![ADDR.METABRIDGE, ADDR.RELAY_DEPOSITORY, ADDR.ARBSYS, ADDR.ACROSS_SPOKE].includes(to)) continue;
      mine.push({ hash: String(it.hash).toLowerCase(), to, value: Number(BigInt(it.value || '0')) / 1e18, time: t, block: it.block_number != null ? Number(it.block_number) : null });
    }
    const next = r.json && r.json.next_page_params;
    if (older || !next || !items.length) break;
    q = '&' + Object.keys(next).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(next[k] == null ? '' : String(next[k]))).join('&');
  }
  // A MetaBridge call the Across log already showed: the dev's own call says how much left the wallet.
  for (const t of mine) {
    const b = found.get(t.hash);
    if (t.to === ADDR.METABRIDGE && b && b.via === 'Across') { b.via = 'MetaBridge/Across'; b.eth = t.value; b.time = t.time; }
  }
  const meta = mine.filter((t) => t.to === ADDR.METABRIDGE && !found.has(t.hash));
  const rcs = meta.length ? must(await batchLatest(meta.map((t) => ({ method: 'eth_getTransactionReceipt', params: [t.hash] })))) : [];
  meta.forEach((t, i) => {
    const logs = (rcs[i] && rcs[i].logs) || [];
    const at = (a) => logs.filter((l) => String(l.address).toLowerCase() === a);
    const b = { via: 'MetaBridge', eth: t.value, block: t.block, time: t.time, tx: t.hash };
    const acrossLog = at(ADDR.ACROSS_SPOKE).find((l) => l.topics[0] === TOPIC.FUNDS_DEPOSITED);
    const mb = logs.find((l) => l.topics[0] === TOPIC.METABRIDGE_BRIDGE && addrOf(wordAt(l.data, 0).toString(16).padStart(40, '0')) === dev)
      || logs.find((l) => l.topics[0] === TOPIC.METABRIDGE_BRIDGE);
    if (acrossLog) { b.via = 'MetaBridge/Across'; b.destChainId = Number(BigInt(acrossLog.topics[1])); b.destChainConfirmed = true; }
    else if (at(ADDR.RELAY_DEPOSITORY).length) b.via = 'MetaBridge/Relay';
    if (b.destChainId == null && mb) {
      const d = Number(wordAt(mb.data, 2));
      if (d > 0 && d < 1e12) { b.destChainId = d; b.destChainConfirmed = false; }
    }
    found.set(t.hash, b);
  });
  for (const t of mine) {
    if (found.has(t.hash) || t.to === ADDR.METABRIDGE) continue;
    if (t.to === ADDR.RELAY_DEPOSITORY) found.set(t.hash, { via: 'Relay', eth: t.value, block: t.block, time: t.time, tx: t.hash });
    else if (t.to === ADDR.ARBSYS && t.value > 0) found.set(t.hash, { via: 'Arbitrum native bridge', eth: t.value, block: t.block, time: t.time, tx: t.hash });
  }
  for (const b of found.values()) if (b.time == null && S.times[b.block] != null) b.time = S.times[b.block];
  S.bridges = { list: [...found.values()], partial, through: H(S), final: S.target.time >= end && !partial };
  if (partial) pushOnce(S.problems, 'The explorer was unavailable, so MetaBridge/Relay bridges weren\'t checked.');
}

// The first buyers' own Transfers of the coin since launch (out = topic1, in = topic2), SNIPERS_PER_STEP wallets a
// step. Out to the curve, router or PoolManager is a sell; out anywhere else is "moved"; in adds to what it got.
async function stepSniperMoves(S) {
  const sellTo = new Set([S.row.curve, ADDR.ROUTER, K.POOL_MANAGER]);
  const todo = S.snipers.buys.map((b) => b.wallet).filter((w) => (S.flowThrough[w] == null ? -1 : S.flowThrough[w]) < H(S)).slice(0, SNIPERS_PER_STEP);
  const filters = [];
  for (const w of todo) {
    const from = (S.flowThrough[w] == null ? S.row.block - 1 : S.flowThrough[w]) + 1;
    filters.push({ address: S.row.token, topics: [TOPIC.TRANSFER, pad(w)], from, to: H(S) }, { address: S.row.token, topics: [TOPIC.TRANSFER, null, pad(w)], from, to: H(S) });
  }
  const res = await logsMany(filters);
  todo.forEach((w, i) => {
    const f = S.flows[w] || { receivedRaw: '0', movedRaw: '0', sells: [] };
    let received = BigInt(f.receivedRaw), moved = BigInt(f.movedRaw);
    for (const l of res[2 * i]) {
      const t = tLog(l);
      if (t.to === w) continue;
      if (sellTo.has(t.to)) f.sells.push({ raw: t.raw, block: t.block, li: t.li, tx: t.tx });
      else {
        moved += BigInt(t.raw);
        // To another contract or wallet: an aggregator or a bot contract may have sold it. Its receipt says
        // (stepSniperTx); burns are never sales.
        if (t.to !== ADDR.ZERO && t.to !== ADDR.DEAD) (f.check || (f.check = [])).push({ raw: t.raw, block: t.block, li: t.li, tx: t.tx });
      }
    }
    if (f.check) {
      const room = Math.max(0, Math.min(CHECK_PER_WALLET, MAX_SNIPER_TX - S.sniperTxRead));
      if (f.check.length > room) {
        f.check.sort((x, y) => (BigInt(y.raw) > BigInt(x.raw) ? 1 : BigInt(y.raw) < BigInt(x.raw) ? -1 : 0));
        f.check = f.check.slice(0, room);
        pushOnce(S.problems, 'Some first buyers moved their coins in many transactions; only the biggest were checked for sales through other apps.');
      }
      S.sniperTxRead += f.check.length;
      if (!f.check.length) delete f.check;
    }
    for (const l of res[2 * i + 1]) { const t = tLog(l); if (t.from !== w) received += BigInt(t.raw); }
    f.receivedRaw = received.toString();
    f.movedRaw = moved.toString();
    S.flows[w] = f;
    S.flowThrough[w] = H(S);
  });
}

// First buyers' transfers to addresses other than the curve, router or PoolManager: when the transaction shows a
// CurveSell on the coin's curve or a v4 swap (on the coin's own pool when it is known), the transfer was a sale through
// another app (an aggregator, a bot contract) and counts as sold; otherwise it stays "moved".
async function stepSniperTx(S) {
  const todo = sniperTxNeeded(S).slice(0, TX_PER_STEP);
  const rcs = must(await batchLatest(todo.map((h) => ({ method: 'eth_getTransactionReceipt', params: [h] }))));
  const pool = S.grad && S.grad.pool;
  const sale = new Set();
  todo.forEach((h, i) => {
    const info = receiptInfo(rcs[i], { curve: S.row.curve, wallet: null, pool, pairToken: S.row.pairToken });
    if (info.curveSell != null || (pool ? info.v4Quote != null : info.swap)) sale.add(h);
  });
  const done = new Set(todo);
  for (const b of S.snipers.buys) {
    const f = S.flows[b.wallet];
    if (!f || !f.check) continue;
    const keep = [];
    for (const c of f.check) {
      if (!done.has(c.tx)) { keep.push(c); continue; }
      if (sale.has(c.tx)) {
        f.sells.push({ raw: c.raw, block: c.block, li: c.li, tx: c.tx });
        f.movedRaw = (BigInt(f.movedRaw) - BigInt(c.raw)).toString();
      }
    }
    if (keep.length) f.check = keep; else delete f.check;
  }
}

// Hourly curve buys and first-time buyers, read in block chunks sized so each answer stays small. Logs carry no
// usable timestamp here, so each buy's time is interpolated between the chunk's first and last block times.
async function stepActivity(S, cx) {
  const A = S.activity;
  const limit = S.row.time + RR.REPORT_DEFAULTS.activityHours * 3600;
  const end = activityEnd(S);
  const a = A.through + 1, b = Math.min(end, a + A.span - 1);
  const calls = [
    { method: 'eth_getLogs', params: [{ address: S.row.curve, topics: [TOPIC.CURVE_BUY], fromBlock: toHex(a), toBlock: toHex(b) }] },
    { method: 'eth_getBlockByNumber', params: [toHex(b), false] },
  ];
  const res = await rpcBatch('official', calls, logOpts());
  if (res[0].error) {
    if (res[0].error instanceof RpcError && res[0].error.overCap && A.span > ACT_SPAN.min) { A.span = Math.max(ACT_SPAN.min, Math.floor(A.span / 4)); return; }
    throw res[0].error;
  }
  if (res[1].error || !res[1].result) throw res[1].error || new StepError('block not found');
  const logs = res[0].result || [];
  const tb = num(res[1].result.timestamp);
  const seen = new Set(A.seen);
  const pons = (x) => x === ADDR.ROUTER || x === ADDR.LAUNCH_AND_BUY;
  let past = false;
  for (const l of logs) {
    const block = num(l.blockNumber);
    const t = RR.interpolateTime(block, A.last, { block: b, time: tb });
    if (t > limit) { past = true; continue; }
    const h = RR.hourStart(t);
    const c = A.counts[h] || (A.counts[h] = { buys: 0, newWallets: 0 });
    c.buys++;
    A.buys++;
    const recipient = addrOf(l.topics[2]);
    if (pons(recipient)) continue;
    const key = recipient.slice(2, 12);
    if (!seen.has(key)) {
      if (seen.size < SEEN_CAP) { seen.add(key); c.newWallets++; }
      else pushOnce(S.problems, 'More than ' + SEEN_CAP + ' different wallets bought; first-time buyers after that aren\'t counted.');
    }
  }
  A.seen = [...seen];
  A.through = b;
  A.last = { block: b, time: tb };
  S.times[b] = tb;
  if (logs.length > ACT_SPAN.many) A.span = Math.max(ACT_SPAN.min, Math.floor(A.span / 2));
  else if (logs.length < ACT_SPAN.few) A.span = Math.min(ACT_SPAN.max, A.span * 2);
  if (past || tb >= limit || (S.grad && b >= S.grad.block)) A.complete = true;
}

async function stepTimes(S) {
  const todo = neededBlocks(S).slice(0, TIMES_PER_STEP);
  const ts = await blockTimes(todo);
  todo.forEach((b, i) => { S.times[b] = ts[i]; });
  for (const br of S.bridges ? S.bridges.list : []) if (br.time == null && S.times[br.block] != null) br.time = S.times[br.block];
}

// =============================================================================================================
// The report from the state (pure apart from the settings)
// =============================================================================================================
export function buildReport(S, { trust }) {
  const r = S.row, L = S.launch, T = S.times;
  const units = (raw, dec = 18) => Number(BigInt(raw)) / 10 ** dec;
  const dm = RR.devMoves({ transfers: S.dev.transfers, txInfo: S.txInfo, times: T, curve: r.curve, launchTx: r.tx,
    grad: S.grad, supplyRaw: L.supplyRaw, quoteDecimals: L.quoteDecimals, isEth: L.isEth });
  const fees = S.fees ? {
    claimedEth: S.fees.claims.reduce((s, c) => s + units(c.raw), 0),
    unclaimedEth: S.fees.unclaimedRaw == null ? null : units(S.fees.unclaimedRaw),
    claims: S.fees.claims.map((c) => ({ tx: c.tx, time: RR.isoOf(T[c.block]), eth: units(c.raw) })),
  } : null;
  const end = r.time + BRIDGE_DAYS * 86400;
  const bridges = S.bridges ? S.bridges.list.filter((b) => b.time == null || (b.time >= r.time && b.time <= end))
    .sort((a, b) => (a.time || 0) - (b.time || 0))
    .map((b) => {
      const o = { via: b.via, eth: b.eth, time: RR.isoOf(b.time), tx: b.tx };
      if (b.destChainId != null) { o.destChainId = b.destChainId; o.destChainConfirmed = !!b.destChainConfirmed; }
      else o.destChainConfirmed = false;
      return o;
    }) : null;
  const dev = {
    address: L.dev,
    viaMulticall: !!L.viaMulticall,
    buy: L.buy ? {
      eth: L.isEth ? units(L.buy.quoteRaw, L.quoteDecimals) : null,
      ...(L.isEth ? {} : { quote: units(L.buy.quoteRaw, L.quoteDecimals) }),
      tokens: units(L.buy.tokensRaw), pct: RR.pctOfRaw(L.buy.tokensRaw, L.supplyRaw), tx: r.tx,
    } : null,
    moves: S.skip.dev ? null : dm.moves,
    fees,
    bridges,
    soldPct: S.skip.dev ? null : dm.soldPct,
  };
  if (dm.more) dev.movesNotShown = dm.more;
  if (dm.received.tokens > 0) dev.receivedFromOthers = { tokens: dm.received.tokens, wallets: dm.received.wallets.slice(0, 10) };
  const grad = S.grad ? { time: RR.isoOf(S.grad.time), tx: S.grad.tx, block: S.grad.block } : null;
  const snipers = S.snipers ? RR.sniperReport({
    buys: S.snipers.buys, flows: S.skip.sniperMoves ? {} : S.flows, times: T, launch: { block: r.block, time: r.time },
    grad: S.grad ? { block: S.grad.block, time: S.grad.time } : null, supplyRaw: L.supplyRaw, windowBlocks: S.snipers.windowBlocks,
  }) : null;
  const A = S.activity;
  const activity = A && !S.skip.activity ? {
    hours: RR.activityHours(A.counts, r.time, A.last.time),
    until: RR.isoOf(A.last.time),
    complete: !!A.complete,
    curveBuysOnly: true,
    proof: RR.reportProof({ token: r.token, launchTx: r.tx, curve: r.curve }).curve,
  } : null;
  const missing = S.missing.slice();
  if (S.bridges && S.bridges.partial) pushOnce(missing, 'bridges');
  const official = (trust.official || []).some((o) => o.address === r.token);
  const report = {
    ok: true,
    status: 'done',
    token: {
      address: r.token, name: r.name, symbol: r.symbol, isOfficial: official,
      pons: { factory: r.factory, curve: r.curve, launchTx: r.tx, launchBlock: r.block, launchTime: RR.isoOf(r.time), pairToken: r.pairToken },
    },
    asOf: RR.isoOf(S.target.time),
    asOfBlock: S.target.number,
    dev,
    snipers,
    graduation: grad,
    activity,
    verdict: '',
    notes: RR.howWeGotThis({ windowBlocks: S.snipers ? S.snipers.windowBlocks : trust.sniperWindowBlocks, viaMulticall: L.viaMulticall }).concat(S.problems),
    caveats: RR.REPORT_CAVEATS.slice(),
    missing,
    proof: RR.reportProof({ token: r.token, creator: L.dev, launchTx: r.tx, curve: r.curve, graduationTx: S.grad ? S.grad.tx : null, escrow: S.fees ? ADDR.FEE_ESCROW : null }),
  };
  report.verdict = RR.buildVerdict(report);
  return report;
}

// Rough share of the work done (for 'building' answers).
export function progressOf(S) {
  if (!S || !S.target) return 0;
  if (!S.launch) return 0.05;
  let done = 0, total = 0;
  const part = (w, f) => { total += w; done += w * Math.max(0, Math.min(1, f)); };
  part(1, 1);
  part(1, S.grad || (S.gradThrough != null && S.gradThrough >= H(S)) ? 1 : 0);
  part(1, S.snipers ? 1 : 0);
  part(1, S.dev.through >= H(S) ? 1 : 0);
  part(1, devTxNeeded(S).length ? 0 : 1);
  part(1, !S.fees || S.fees.through >= H(S) ? 1 : 0);
  part(1, S.bridges ? 1 : 0);
  const ws = S.snipers ? S.snipers.buys : [];
  part(2, ws.length ? ws.filter((b) => S.flowThrough[b.wallet] >= H(S)).length / ws.length : (S.snipers ? 1 : 0));
  part(1, sniperTxNeeded(S).length ? 0 : 1);
  const A = S.activity, end = activityEnd(S);
  part(3, A.complete || A.through >= end ? 1 : (A.through - S.row.block) / Math.max(1, end - S.row.block));
  part(1, neededBlocks(S).length ? 0 : 1);
  return Math.round((done / total) * 0.97 * 100) / 100;
}

// =============================================================================================================
// The engine: run pending steps while the budget allows, saving after each
// =============================================================================================================
// returns 'done' | 'budget' | 'error'
// A step that was refused a fetch (budget) is rolled back and retried by the next call; a step that failed for any
// other reason is retried MAX_TRIES times, then skipped and named in `missing`.
const MISSING_NAMES = { devTx: 'dev trade amounts', sniperTx: 'first buyers\' sales through other apps', sniperMoves: 'first buyers\' sales' };

function snapshot(S) {
  const seen = S.activity ? S.activity.seen : null;        // the biggest part, never changed in place: kept by reference
  if (seen) S.activity.seen = null;
  const text = JSON.stringify(S);
  if (seen) S.activity.seen = seen;
  return () => { const back = JSON.parse(text); if (back.activity) back.activity.seen = seen; return back; };
}

async function advance(job, cx, { only = null } = {}) {
  let S = job.state;
  const room = cx.budget.remaining();      // a step costing more than a whole call's budget is still tried with all of it
  for (let guard = 0; guard < 200; guard++) {
    if (S.error) return 'error';
    const step = STEPS.find((s) => (!only || only.has(s.name)) && !S.skip[s.name] && (s.name === 'head' || s.name === 'launch' || S.launch) && s.pending(S));
    if (!step) return only ? 'done' : 'finalize';
    if (!cx.budget.has(Math.min(STEP_COST[step.name], room))) return 'budget';
    const restore = snapshot(S);
    const refused = cx.budget.refused;
    try {
      await step.run(S, cx);
      if (cx.budget.refused > refused) { S = job.state = restore(); return 'budget'; }
      S.tries[step.name] = 0;
    } catch (e) {
      S = job.state = restore();
      if (e instanceof BudgetExceeded || cx.budget.refused > refused) return 'budget';
      S.tries[step.name] = (S.tries[step.name] || 0) + 1;
      if (S.tries[step.name] >= MAX_TRIES) {
        if (step.name === 'head' || step.name === 'launch') { S.error = 'rpc-failed'; }
        else { S.skip[step.name] = true; pushOnce(S.missing, MISSING_NAMES[step.name] || step.name); }
      }
    }
    job.step = step.name;
    job.progress = progressOf(S);
    job.updatedAt = cx.nowS;
    job.status = 'building';
    await cx.store.saveJob(job);
    if (S.error) return 'error';
  }
  return 'budget';
}

// A new build (first one, or a refresh of a finished or failed one): read up to a new head block. Facts that
// never change (launch, first buyers, finished windows) are kept; everything else carries on from where the last
// build stopped.
function startBuild(job) {
  const fresh = !job.state || job.state.v !== STATE_V;
  const S = fresh ? newState(job.token) : job.state;
  if (!fresh) {
    if (S.target && job.status === 'done') S.built = S.target;
    S.target = null;
    S.tries = {};
    S.skip = {};
    S.missing = [];
    S.error = null;
    S.problems = S.problems.filter((p) => /in our launch index yet|biggest of|only the biggest were checked/.test(p));
  }
  job.state = S;
  job.status = 'building';
}

function contextFor({ token, store, budget, settings, now, sleep }) {
  return {
    token, store, budget, nowS: nowSec(now), trust: trustSettings(settings),
    explorer: makeExplorer({ fetch: budget.fetch, sleep: sleep || undefined }),
  };
}

// This module's share of the request's budget: at most `limit` fetches, and never more than the request has left.
// Fetches go through the request budget's own fetch (in the Worker that one follows the active request, so even
// with requests running side by side in one isolate each request's calls count against its own budget); the
// local cap is counted on top. rpc.js is pointed at it, so every RPC call is counted. Pass this object on.
export function scopedBudget(budget, fetchFn, limit) {
  if (budget && budget.__scoped) return budget;
  if (!budget) {
    const b = createBudget({ limit, fetch: fetchFn || null });
    b.__scoped = true;
    _setTransport({ fetch: b.fetch });
    return b;
  }
  const own = createBudget({ limit: Math.max(0, Math.min(limit, budget.remaining())), d1Limit: 1e9, fetch: (i, n) => budget.fetch(i, n) });
  const b = {
    __scoped: true,
    limit: own.limit,
    fetch: own.fetch,
    get used() { return own.used; },
    get refused() { return own.refused + (budget.refused || 0); },
    get exhausted() { return own.exhausted || budget.exhausted; },
    remaining: () => Math.min(own.remaining(), budget.remaining()),
    has: (n = 1) => own.has(n) && budget.has(n),
    canSpend: (n = 1) => own.has(n) && budget.has(n),
    wrapDb: (db) => (typeof budget.wrapDb === 'function' ? budget.wrapDb(db) : db),
    snapshot: () => ({ ...own.snapshot(), parent: typeof budget.snapshot === 'function' ? budget.snapshot() : null }),
  };
  _setTransport({ fetch: b.fetch });
  return b;
}
const useBudget = scopedBudget;

function isAddress(s) { return typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s.trim()); }

// Serve a cached report: the official badge from the current settings, the verdict with the wallet links when
// they have finished (they load separately and never hold the report back).
function serveReport(report, links, trust, extra = null) {
  const out = { ...report, token: { ...report.token, isOfficial: (trust.official || []).some((o) => o.address === report.token.address) } };
  out.verdict = RR.buildVerdict(report, links && links.ok === true && links.status === 'done' ? links : null);
  if (extra) Object.assign(out, extra);
  return out;
}

export async function launchReport({ token, env = null, settings = null, now = Date.now(), budget = null, fetch: fetchFn = null, sleep = null, store = null, refresh = true, maxSubrequests = REPORT_SUBREQUESTS } = {}) {
  if (!isAddress(String(token == null ? '' : token))) return fail('bad-address', MESSAGES['bad-address']);
  const addr = String(token).trim().toLowerCase();
  const nowS = nowSec(now);
  const b = useBudget(budget, fetchFn, maxSubrequests);
  const st = storeFor({ env, store, budget: b }) || memoryStore();
  const trust = trustSettings(settings);
  const key = 'report:' + addr;
  try {
    const caches = await st.getCaches([key, 'links:' + addr]);
    const cached = caches.get(key) || null;
    const links = caches.get('links:' + addr) ? caches.get('links:' + addr).value : null;
    if (cached && cached.value && cached.value.ok === false) {
      if (nowS - cached.createdAt < ERROR_TTL) return cached.value;
    } else if (cached && cached.value && (nowS - cached.createdAt < REPORT_TTL || !refresh)) {
      return serveReport(cached.value, links, trust);
    }
    const stale = cached && cached.value && cached.value.ok ? cached.value : null;

    if (!(await st.claimJob(key, 'report', addr, nowS))) {
      // another request is building it right now
      if (stale) return serveReport(stale, links, trust, { refreshing: true });
      const j = await st.getJob(key);
      return { ok: true, status: 'building', progress: j ? j.progress || 0 : 0 };
    }
    const job = (await st.getJob(key)) || { key, kind: 'report', token: addr, status: 'queued', state: {}, attempts: 0 };
    job.leaseUntil = nowS + LEASE_SECONDS;
    if (job.status !== 'building' || !job.state || job.state.v !== STATE_V) startBuild(job);
    const cx = contextFor({ token: addr, store: st, budget: b, settings, now, sleep });
    const out = await advance(job, cx);
    const S = job.state;
    if (out === 'error') {
      const code = S.error || 'rpc-failed';
      const err = fail(code, MESSAGES[code] || MESSAGES.unavailable);
      job.status = 'failed';
      job.updatedAt = nowS;
      await st.saveJob(job, { release: true });
      if (code === 'not-pons' || code === 'not-found') await st.putCaches([{ key, value: err, createdAt: nowS, expiresAt: nowS + ERROR_TTL }]);
      return stale && code === 'rpc-failed' ? serveReport(stale, links, trust, { refreshing: false }) : err;
    }
    if (out === 'finalize') {
      const report = buildReport(S, { trust });
      S.built = S.target;
      job.status = 'done';
      job.progress = 1;
      job.step = 'finalize';
      job.updatedAt = nowS;
      await st.putCaches([{ key, value: report, createdAt: nowS, expiresAt: nowS + KEEP_SECONDS }]);
      await st.saveJob(job, { release: true });
      return serveReport(report, links, trust);
    }
    await st.saveJob(job, { release: true });
    if (stale) return serveReport(stale, links, trust, { refreshing: true });
    return { ok: true, status: 'building', progress: job.progress || progressOf(S) };
  } catch (e) {
    if (e instanceof BudgetExceeded) return { ok: true, status: 'building', progress: 0 };
    return fail('unavailable', MESSAGES.unavailable);
  }
}

// For links.js: the dev and the first buyers of a coin (from the report's job, running only the launch and
// first-buyer steps when they aren't done yet). -> { ok:true, status:'done', dev, launch, snipers } |
// { ok:true, status:'building', progress } | ErrorResult
export async function reportBasics({ token, env = null, settings = null, now = Date.now(), budget = null, fetch: fetchFn = null, sleep = null, store = null } = {}) {
  if (!isAddress(String(token == null ? '' : token))) return fail('bad-address', MESSAGES['bad-address']);
  const addr = String(token).trim().toLowerCase();
  const nowS = nowSec(now);
  const b = useBudget(budget, fetchFn, REPORT_SUBREQUESTS);
  const st = storeFor({ env, store, budget: b }) || memoryStore();
  const key = 'report:' + addr;
  const pick = (S) => ({
    ok: true, status: 'done', dev: S.launch.dev, viaMulticall: !!S.launch.viaMulticall,
    launch: { block: S.row.block, time: S.row.time, tx: S.row.tx, curve: S.row.curve, creator: S.row.creator },
    snipers: (S.snipers ? S.snipers.buys : []).map((x) => ({ wallet: x.wallet, block: x.block, tx: x.tx, ...(x.byDev ? { byDev: true } : {}) })),
  });
  const ready = (S) => !!(S && S.v === STATE_V && S.launch && (S.snipers || (S.skip && S.skip.snipers)));
  try {
    let job = await st.getJob(key);
    if (job && ready(job.state)) return pick(job.state);
    if (job && job.status === 'failed' && job.state && job.state.error) return fail(job.state.error, MESSAGES[job.state.error] || MESSAGES.unavailable);
    if (!(await st.claimJob(key, 'report', addr, nowS))) return { ok: true, status: 'building', progress: job ? job.progress || 0 : 0 };
    job = (await st.getJob(key)) || { key, kind: 'report', token: addr, status: 'queued', state: {}, attempts: 0 };
    job.leaseUntil = nowS + LEASE_SECONDS;
    if (job.status !== 'building' || !job.state || job.state.v !== STATE_V) startBuild(job);
    const cx = contextFor({ token: addr, store: st, budget: b, settings, now, sleep });
    const out = await advance(job, cx, { only: new Set(['head', 'launch', 'snipers']) });
    if (out === 'error') {
      job.status = 'failed';
      await st.saveJob(job, { release: true });
      return fail(job.state.error, MESSAGES[job.state.error] || MESSAGES.unavailable);
    }
    await st.saveJob(job, { release: true });
    if (out === 'done' && ready(job.state)) return pick(job.state);
    return { ok: true, status: 'building', progress: 0 };
  } catch (e) {
    if (e instanceof BudgetExceeded) return { ok: true, status: 'building', progress: 0 };
    return fail('unavailable', MESSAGES.unavailable);
  }
}

// A queued job whose answer is final (done, or an error such as a bad address) leaves the queue.
export async function settle(st, key, status, nowS) {
  try {
    const j = await st.getJob(key);
    if (j && (j.status === 'queued' || j.status === 'building') && !(j.leaseUntil != null && j.leaseUntil >= nowS)) {
      await st.saveJob({ ...j, status, updatedAt: nowS }, { release: true });
    }
  } catch (e) { /* the next run tries again */ }
}

// Cron: carry on with reports someone asked for that are still building, and purge expired cache rows.
// -> { advanced: [token], done: [token] }
export async function advanceReportJobs({ env = null, settings = null, now = Date.now(), budget = null, store = null, max = 3, perJob = 20, fetch: fetchFn = null, sleep = null } = {}) {
  const b = budget || createBudget({ fetch: fetchFn || null });
  const st = storeFor({ env, store, budget: b });
  const out = { advanced: [], done: [] };
  if (!st) return out;
  const nowS = nowSec(now);
  try {
    const list = await st.queued('report', nowS, max);
    for (const j of list) {
      if (!b.has(8)) break;
      const r = await launchReport({ token: j.token, store: st, settings, now, budget: b, maxSubrequests: Math.min(perJob, b.remaining()), sleep });
      out.advanced.push(j.token);
      if (r && r.ok && r.status === 'done') out.done.push(j.token);
      if (!r || r.status !== 'building') await settle(st, j.key, r && r.ok ? 'done' : 'failed', nowS);
    }
    await st.purge(nowS, 200);
  } catch (e) { /* the next minute tries again */ }
  return out;
}
