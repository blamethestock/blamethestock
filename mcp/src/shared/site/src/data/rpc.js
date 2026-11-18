// JSON-RPC and JSON GET over fetch, with timeouts, a per-endpoint limit on requests in flight,
// retries with backoff, batch splitting, and request counters.
import { RPC } from './constants.js';

let fetchFn = (...a) => fetch(...a);
let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));
let backoffMs = [400, 800, 1600];
let useTimeouts = true;
let pageUrl = null;            // tests: stands in for location.href (serverTime)
let avoid = [];                // endpoints asked last, always (the API Worker: the official node 429s Cloudflare)

// Tests swap the network out: _setTransport({ fetch, sleep, backoff, timeouts: false, pageUrl, avoid })
// (also forgets which endpoints were cooling, so one test's outage doesn't steer the next).
// avoid: endpoint names every fallback order asks last (a last resort), until the next _setTransport. The API
// Worker passes ['official']: that node answers HTTP 429 to every call from Cloudflare's network.
export function _setTransport({ fetch: f, sleep, backoff, timeouts, pageUrl: page, avoid: av } = {}) {
  if (f) fetchFn = f;
  if (sleep) sleepFn = sleep;
  if (backoff) backoffMs = backoff;
  if (timeouts !== undefined) useTimeouts = !!timeouts;
  if (page !== undefined) pageUrl = page;
  avoid = Array.isArray(av) ? av.slice() : [];
  resetHealth();
}
export const avoided = (name) => avoid.includes(name);

// ---- endpoint health ---------------------------------------------------------------------------
// After a timeout or a network error (the official node's 429 also looks like one in a browser) an endpoint
// "cools" for a while: every fallback order asks it last, so a hanging node costs one timeout, not one per step.
export const COOL_MS = 45000;
const coolUntil = {};
export function resetHealth() { for (const k of Object.keys(coolUntil)) delete coolUntil[k]; }
export function markCooling(name) { coolUntil[name] = Date.now() + COOL_MS; }
export function isCooling(name) { return (coolUntil[name] || 0) > Date.now(); }
// Same order, cooling endpoints moved to the end, avoided ones after those. Items are names or [name, tries] pairs.
export function byHealth(list) {
  const name = (x) => (Array.isArray(x) ? x[0] : x);
  const av = (x) => avoid.includes(name(x));
  const cool = (x) => !av(x) && isCooling(name(x));
  return list.filter((x) => !av(x) && !cool(x)).concat(list.filter(cool), list.filter(av));
}

// eth_getLogs has no other source than the official node: wait longer between tries (a 429 burst passes).
// While it is cooling (a 429 also cools it) up to 3 tries, so an unreachable node costs at most 1 + 2 s here;
// a hanging node is asked once anyway (a timed-out request is never retried on the same node).
export const LOG_BACKOFF = [1000, 2000, 4000, 8000];
export function logOpts(tries = 4) {
  return { tries: isCooling('official') ? Math.min(tries, 3) : tries, backoff: LOG_BACKOFF };
}

// requests = HTTP requests (a JSON-RPC batch is one); calls = JSON-RPC calls inside them.
export const stats = { requests: 0, calls: 0, retries: 0, byHost: {}, byMethod: {} };
export function resetStats() {
  stats.requests = 0; stats.calls = 0; stats.retries = 0; stats.byHost = {}; stats.byMethod = {};
}
function count(host, methods) {
  stats.requests++;
  stats.byHost[host] = (stats.byHost[host] || 0) + 1;
  for (const m of methods) { stats.calls++; stats.byMethod[m] = (stats.byMethod[m] || 0) + 1; }
}

export class RpcError extends Error {
  constructor(message, { endpoint = '', code = null, retryable = false, overCap = false, noState = false } = {}) {
    super(message);
    this.name = 'RpcError';
    this.endpoint = endpoint;
    this.code = code;
    this.retryable = retryable;
    this.overCap = overCap;     // eth_getLogs: too many results for one call -> split the range
    this.noState = noState;     // node has no state for that block -> ask an archive node
  }
}

// Sorts a JSON-RPC error object into what the caller should do about it.
export function classifyRpcError(err, endpoint = '') {
  const msg = String((err && err.message) || err || '');
  const code = err && typeof err.code === 'number' ? err.code : null;
  const m = msg.toLowerCase();
  const overCap = /more than \d+ (results|logs)|too many (results|logs)|response size|exceed(s|ed)? .*(results|logs|limit)|log response/.test(m);
  const noState = /historical state|missing trie node|state .* not available|state is not available|pruned/.test(m);
  const reverted = /revert/.test(m) || code === 3;
  const retryable = !overCap && !noState && !reverted && (
    /unknown state|first available state|timeout|timed out|rate|too many requests|busy|temporar|try again|internal|header not found|upstream|unavailable|overload|capacity|throttl|429|gateway/.test(m) ||
    code === -32603 || code === -32005 || code === 429);
  return new RpcError(msg || 'RPC error', { endpoint, code, retryable, overCap, noState });
}

// ---- concurrency limit per endpoint --------------------------------------------------------
const lanes = {};
// The API Worker gives every request its own lane table: a Worker may not wake one request's waiting promise from
// another request (the runtime cancels the waiter and the request hangs). The page keeps the one shared table.
let laneScope = null;
export function _setLaneScope(fn) { laneScope = typeof fn === 'function' ? fn : null; }
function lane(name, max) {
  const table = (laneScope && laneScope()) || lanes;
  if (!table[name]) table[name] = { busy: 0, max, waiting: [] };
  return table[name];
}
async function inLane(name, max, fn) {
  const l = lane(name, max);
  if (l.busy >= l.max) await new Promise((r) => l.waiting.push(r));
  l.busy++;
  try { return await fn(); } finally {
    l.busy--;
    const next = l.waiting.shift();
    if (next) next();
  }
}

// ---- one HTTP request with a timeout ------------------------------------------------------
async function request(url, init, timeoutMs, raw = false) {
  const ctrl = useTimeouts && typeof AbortController === 'function' ? new AbortController() : null;
  let timer = null;
  const racers = [fetchFn(url, ctrl ? { ...init, signal: ctrl.signal } : init)];
  if (useTimeouts) {
    racers.push(new Promise((_, rej) => {
      timer = setTimeout(() => {
        // Reject first: aborting rejects fetch() at once, and the race must report the timeout, not the abort.
        rej(Object.assign(new RpcError('timeout', { retryable: true }), { transport: true, timedOut: true }));
        if (ctrl) ctrl.abort();
      }, timeoutMs);
    }));
  }
  try {
    const res = await Promise.race(racers);
    if (raw) return res;
    if (!res.ok) {
      // dRPC sends some JSON-RPC errors (e.g. "Unknown state", which passes in a moment) with HTTP 400 when the
      // request wasn't a batch. Hand those on as normal JSON-RPC errors so they are classified (and retried) like
      // the same error inside a batch.
      if (res.status === 400 && !raw) {
        let parsed = null;
        try { parsed = await res.json(); } catch (e) { /* not JSON */ }
        const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
        if (items.length && items.every((x) => x && x.jsonrpc && x.error)) return parsed;
      }
      const retryable = res.status === 429 || res.status === 408 || res.status >= 500;
      throw new RpcError('HTTP ' + res.status, { code: res.status, retryable });
    }
    try { return await res.json(); } catch (e) { throw new RpcError('bad JSON', { retryable: true }); }
  } catch (e) {
    if (e instanceof RpcError) throw e;
    // fetch() rejects with a TypeError on network failures; the official RPC's 429 also lands here
    // because its CORS header is malformed. Treat all of them as "back off and try again".
    throw Object.assign(new RpcError('network: ' + ((e && e.message) || e), { retryable: true }), { transport: true });
  } finally {
    if (timer !== null && typeof clearTimeout === 'function') clearTimeout(timer);
  }
}

// ---- JSON-RPC ------------------------------------------------------------------------------
// calls: [{ method, params }]. Returns one entry per call: { result } or { error: RpcError }.
// Transport failures (after retries) throw an RpcError.
// backoff: waits between tries (ms), default the transport's.
export async function rpcBatch(endpointName, calls, { tries = 4, timeoutMs = endpointName === 'official' ? 5000 : 10000, backoff = null } = {}) {
  // The official node answers fast or not at all, so give up on it sooner and fall over to the others.
  const ep = RPC[endpointName];
  if (!ep) throw new Error('unknown endpoint ' + endpointName);
  const out = new Array(calls.length);
  const chunks = [];
  for (let i = 0; i < calls.length; i += ep.batchMax) chunks.push(calls.slice(i, i + ep.batchMax).map((c, j) => ({ ...c, i: i + j })));
  await Promise.all(chunks.map((chunk) => sendChunk(endpointName, ep, chunk, out, tries, timeoutMs, backoff || backoffMs)));
  return out;
}

async function sendChunk(name, ep, chunk, out, tries, timeoutMs, waits) {
  let pending = chunk;
  let lastErr = null;
  for (let attempt = 0; attempt < tries && pending.length; attempt++) {
    if (attempt > 0) {
      stats.retries++;
      await sleepFn(waits[Math.min(attempt - 1, waits.length - 1)]);
    }
    const body = pending.length === 1
      ? { jsonrpc: '2.0', id: pending[0].i, method: pending[0].method, params: pending[0].params }
      : pending.map((c) => ({ jsonrpc: '2.0', id: c.i, method: c.method, params: c.params }));
    let res;
    try {
      res = await inLane(name, ep.maxInFlight, () => {
        count(name, pending.map((c) => c.method));
        return request(ep.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, timeoutMs);
      });
    } catch (e) {
      lastErr = e instanceof RpcError ? e : new RpcError(String(e), { retryable: true });
      lastErr.endpoint = name;
      if (lastErr.transport) markCooling(name);
      // A node that let a request time out is not asked the same thing again: the caller's next node answers sooner.
      if (!lastErr.retryable || lastErr.timedOut) break;
      continue;
    }
    const list = Array.isArray(res) ? res : [res];
    const byId = new Map(list.map((x) => [x && x.id, x]));
    const again = [];
    for (const c of pending) {
      const r = byId.get(c.i) || (list.length === 1 && pending.length === 1 ? list[0] : null);
      if (r && Object.prototype.hasOwnProperty.call(r, 'result') && !r.error) {
        out[c.i] = { result: r.result };
      } else {
        const err = classifyRpcError(r ? r.error : { message: 'missing response' }, name);
        if (!r) err.retryable = true;
        out[c.i] = { error: err };
        if (err.retryable) again.push(c);
      }
    }
    pending = again;
  }
  if (lastErr && chunk.some((c) => !out[c.i])) {
    for (const c of chunk) if (!out[c.i]) out[c.i] = { error: lastErr };
    // a whole-request failure (network, HTTP) is thrown so callers can fall over to another endpoint
    throw lastErr;
  }
}

export async function rpc(endpointName, method, params, opts) {
  const [r] = await rpcBatch(endpointName, [{ method, params }], opts);
  if (r.error) throw r.error;
  return r.result;
}

// Tries each endpoint in turn until one answers (two tries each: falling over beats waiting out a 429).
// Cooling endpoints are asked last.
export async function rpcAny(endpointNames, method, params, opts = {}) {
  let last;
  for (const name of byHealth(endpointNames)) {
    try { return await rpc(name, method, params, { tries: 2, ...opts }); } catch (e) { last = e; }
  }
  throw last;
}

// The web server's clock (unix s) from a same-origin HEAD request's Date header; null when there is
// no page (jsc), no answer or no usable header. Used to double-check "the chain looks old" against a clock
// that isn't the visitor's.
export async function serverTime() {
  const url = pageUrl || (typeof location !== 'undefined' && location && location.href) || null;
  if (!url || !/^https?:/.test(url)) return null;
  try {
    const res = await request(url, { method: 'HEAD', cache: 'no-store' }, 5000, true);
    const d = Date.parse(res && res.headers && typeof res.headers.get === 'function' ? res.headers.get('date') || '' : '');
    return Number.isFinite(d) ? d / 1000 : null;
  } catch (e) { return null; }
}

// ---- plain JSON GET (DexScreener, GeckoTerminal) ------------------------------------------
// Returns parsed JSON, or null when the service is unavailable (after retries).
export async function getJson(url, { tries = 2, timeoutMs = 5000, host = 'http' } = {}) {
  for (let attempt = 0; attempt < tries; attempt++) {
    if (attempt > 0) { stats.retries++; await sleepFn(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]); }
    try {
      return await inLane(host, 4, () => { count(host, ['GET']); return request(url, { method: 'GET', headers: { accept: 'application/json' } }, timeoutMs); });
    } catch (e) {
      if (e && e.code === 404) return { notFound: true };
      if (!(e && e.retryable)) return null;
    }
  }
  return null;
}
