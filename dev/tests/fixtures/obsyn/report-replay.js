// Offline replay of the OBSYN launch report and wallet links: recorded Robinhood Chain RPC and Blockscout answers
// served through an injected fetch, so dev/tests/report.test.js never touches the network.
//
// Files next to this one (written by `dev/tools/record_obsyn.py --report`, never by hand):
//   report-rpc.json       { "<method>|<JSON params>": result | { "__error": {...} } }   (same format as rpc.json)
//   report-explorer.json  { "<path after https://robinhoodchain.blockscout.com>": { status, json } }
//   index.json            shared with the copy check: the launch-index rows and the pinned head block
// The head block is the copy check's (index.json), so both fixtures describe the chain at the same moment.
import { replayFetch, OBSYN } from './replay.js';
import { launchReport, memoryStore } from '../../../../api/src/report.js';
import { walletLinks } from '../../../../api/src/links.js';
import { createBudget } from '../../../../api/src/budget.js';
import { _setTransport } from '../../../../site/src/data/rpc.js';
import { clearChainCaches } from '../../../../site/src/data/chain.js';

export { OBSYN };
export const HEAD_KEY = 'eth_getBlockByNumber|["latest",false]';

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
export function loadReportFixture({ fresh = false } = {}) {
  if (!cached || fresh) {
    cached = (async () => ({
      rpc: (await readJson('report-rpc.json')) || {},
      explorer: (await readJson('report-explorer.json')) || {},
      index: (await readJson('index.json')) || { rows: [], head: null },
    }))();
  }
  return cached;
}

export const REPORT_SCENARIOS = [
  { name: 'real OBSYN', token: OBSYN.real },
  { name: 'copycat OBSYN', token: OBSYN.copy },
];

const noSleep = async () => {};

// One scenario: the report (one call with a large budget), then the wallet links, then the report again (served
// from the cache, its verdict now including the links). opts: { misses, log, limit, explorer: 'ok'|'down'|'challenge' }
export async function runReportScenario(sc, fx, { misses = null, log = null, limit = 100000, explorer = 'ok', store = null } = {}) {
  clearChainCaches();                                    // block-time cache: every scenario asks for what it needs
  const fetchFn = replayFetch(fx, { explorer, misses, log });
  _setTransport({ fetch: fetchFn, sleep: noSleep, backoff: [0], timeouts: false });
  const st = store || memoryStore({ rows: (fx.index && fx.index.rows) || [] });
  const now = ((fx.index && fx.index.head ? fx.index.head.time : 0) + 60) * 1000;
  const budget = () => createBudget({ limit, fetch: fetchFn });
  const report = await launchReport({ token: sc.token, store: st, now, budget: budget(), sleep: noSleep });
  // links: each call reads at most a few explorer pages, so a first look takes a few calls (the site polls)
  const linkCalls = [];
  for (let i = 0; i < 8; i++) {
    const l = await walletLinks({ token: sc.token, store: st, now: now + i * 1000, budget: budget(), sleep: noSleep });
    linkCalls.push(l);
    if (!l || l.status !== 'building') break;
  }
  const links = linkCalls[linkCalls.length - 1];
  const again = await launchReport({ token: sc.token, store: st, now: now + 10000, budget: budget(), sleep: noSleep });
  return { report, links, linkCalls, again, store: st, fetchFn };
}
