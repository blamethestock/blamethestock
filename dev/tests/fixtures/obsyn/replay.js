// Offline replay of the OBSYN copy check: recorded Robinhood Chain RPC answers and Blockscout answers, served
// through an injected fetch, so the copy-check tests never touch the network.
//
// Files next to this one (written by dev/tools/record_obsyn.py, never by hand):
//   rpc.json       { "<method>|<JSON params>": result | { "__error": { code, message } } }
//   explorer.json  { "<path after https://robinhoodchain.blockscout.com>": { status, json } }
//   index.json     { recordedAt, head: { number, time }, rows: [launch-index rows, api/schema.sql columns] }
//
// The recorder runs SCENARIOS below with record mode on: every request the code makes that isn't in the
// files yet is listed as a "miss", fetched once from the chain/explorer, saved, and the scenarios run again
// until nothing is missing. The tests run the same scenarios, so they ask for exactly what was recorded.
import { skeleton } from '../../../../site/src/trust/skeleton.js';
import { copyCheck } from '../../../../api/src/copies.js';
import { gatherFacts, makeContext } from '../../../../site/src/trust/facts.js';
import { _setTransport } from '../../../../site/src/data/rpc.js';
import { FACTORY_ADDRESSES } from '../../../../api/src/env.js';

export const EXPLORER = 'https://robinhoodchain.blockscout.com';
export const OBSYN = {
  real: '0x5d992fa5b7da8efde5fd36d24e81097ed6ad4351',
  copy: '0x7a2aec4da4e23ca727ac42aa4e37f24de480475e',
  early: '0x0188929e6fa918b406a4d22f564c2226df8a4503',
};

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---- loading -------------------------------------------------------------------------------------------
function here() { return import.meta.url; }
async function readJson(name) {
  const url = here();
  if (typeof read === 'function' && /^file:/.test(url)) {                 // jsc
    const dir = decodeURIComponent(url.replace(/^file:\/\//, '')).replace(/[^/]*$/, '');
    let text;
    try { text = read(dir + name); } catch (e) { return null; }
    return JSON.parse(text);
  }
  const res = await fetch(new URL('./' + name, url));                     // browser
  return res.ok ? res.json() : null;
}

let cached = null;
export function loadFixture({ fresh = false } = {}) {
  if (!cached || fresh) {
    cached = (async () => ({
      rpc: (await readJson('rpc.json')) || {},
      explorer: (await readJson('explorer.json')) || {},
      index: (await readJson('index.json')) || { rows: [], head: null },
    }))();
  }
  return cached;
}

// ---- fake HTTP response --------------------------------------------------------------------------------
function response(status, body, headers = {}) {
  const h = Object.fromEntries(Object.entries({ 'content-type': 'application/json', ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (has(h, String(k).toLowerCase()) ? h[String(k).toLowerCase()] : null) },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

// fetch replaying the fixture. explorer: 'ok' | 'down' (429) | 'challenge' (Cloudflare page).
// misses (record mode): { rpc: Map, explorer: Set } collects what isn't recorded yet.
// log: optional array; every request key is pushed to it (tests count requests with it).
export function replayFetch(fx, { explorer = 'ok', misses = null, log = null } = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith(EXPLORER)) {
      const path = u.slice(EXPLORER.length);
      if (log) log.push('GET ' + path);
      if (explorer === 'down') return response(429, { message: 'Too Many Requests' });
      if (explorer === 'challenge') return response(403, '<!DOCTYPE html><title>Just a moment...</title>', { 'content-type': 'text/html', 'cf-mitigated': 'challenge' });
      if (!has(fx.explorer, path)) {
        if (misses) misses.explorer.add(path);
        return response(503, { message: 'fixture miss' });
      }
      const hit = fx.explorer[path];
      return response(hit.status, hit.json);
    }
    const body = JSON.parse(init.body);
    const list = Array.isArray(body) ? body : [body];
    const out = list.map((c) => {
      const key = c.method + '|' + JSON.stringify(c.params);
      if (log) log.push(key);
      if (has(fx.rpc, key)) {
        const v = fx.rpc[key];
        if (v && typeof v === 'object' && !Array.isArray(v) && has(v, '__error')) return { jsonrpc: '2.0', id: c.id, error: v.__error };
        return { jsonrpc: '2.0', id: c.id, result: v };
      }
      if (misses) misses.rpc.set(key, { key, method: c.method, params: c.params });
      return { jsonrpc: '2.0', id: c.id, error: { code: -32000, message: 'fixture miss: ' + key.slice(0, 160) } };
    });
    return response(200, Array.isArray(body) ? out : out[0]);
  };
}

// ---- the launch index ----------------------------------------------------------------------------------
// The same interface api/src/copies.js builds over D1 (d1Index), over the recorded rows. Skeletons are
// computed here with the real skeleton() (the recorder is Python and leaves them out).
export function fixtureIndex(rows, { lastBlock, lastRun, oldestBlock = 20000000 } = {}) {
  const all = rows.map((r) => ({
    ...r,
    sym_skel: r.sym_skel != null ? r.sym_skel : (r.symbol == null ? null : skeleton(r.symbol)),
    name_skel: r.name_skel != null ? r.name_skel : (r.name == null ? null : skeleton(r.name)),
  }));
  const oldest = all.slice().sort((a, b) => a.block - b.block)[0];
  return {
    calls: [],
    async findByToken(addr) { this.calls.push(['token', addr]); return all.find((r) => r.token === addr) || null; },
    async findBySkeletons(keys, limit = 500) {
      this.calls.push(['skeletons', keys.slice()]);
      return all.filter((r) => keys.includes(r.sym_skel) || keys.includes(r.name_skel))
        .sort((a, b) => b.block - a.block).slice(0, limit);
    },
    async state() {
      return { lastBlock, oldestBlock, lastRun, oldestTime: oldest ? oldest.time : null };
    },
  };
}

// ---- what the recorder records and the tests replay ----------------------------------------------------
// Each scenario: { name, query, explorer } for copyCheck, or { name, facts: token, explorer } for gatherFacts.
export const SCENARIOS = [
  { name: 'ticker OBSYN', query: 'OBSYN' },
  { name: 'copycat address', query: OBSYN.copy },
  { name: 'real address', query: OBSYN.real },
  { name: '09:08 OBSYN address', query: OBSYN.early },
  { name: 'copycat, explorer down', facts: OBSYN.copy, explorer: 'down' },
];

const noSleep = async () => {};

// Runs one scenario against the fixture. opts: { misses, log, settings, explorer } (explorer overrides the
// scenario's). Returns the CopyCheckResult (query scenarios) or the facts object (facts scenarios).
export async function runScenario(sc, fx, { misses = null, log = null, settings = null, explorer = null } = {}) {
  const fetchFn = replayFetch(fx, { explorer: explorer || sc.explorer || 'ok', misses, log });
  _setTransport({ fetch: fetchFn, sleep: noSleep, backoff: [0], timeouts: false });
  const head = fx.index.head || { number: null, time: null };
  const index = fixtureIndex(fx.index.rows || [], { lastBlock: head.number, lastRun: head.time });
  if (sc.query != null) {
    return copyCheck({ query: sc.query, db: index, fetch: fetchFn, settings, now: (head.time || 0) * 1000, sleep: noSleep });
  }
  const ctx = await makeContext({ fetch: fetchFn, sleep: noSleep, settings, factories: FACTORY_ADDRESSES });
  const row = await index.findByToken(sc.facts);
  if (!row) throw new Error('no index row for ' + sc.facts);
  return gatherFacts(row, ctx);
}
