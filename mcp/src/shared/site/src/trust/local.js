// The launch report and the wallet links, built where the visitor is (the browser, or the local MCP package).
//
// The official Robinhood Chain RPC refuses Cloudflare's network, so the API Worker no longer reads the chain: it
// gives the coin's launch row from its index (GET /v1/report/{token}, status 'basics'), and the same step-by-step
// code the Worker used (report-build.js, wallet-links.js) runs here with an in-memory store and this page's fetch.
//
//   buildReportLocal(token, { settings, basics, onProgress, live, sleep, fetch, store }) -> ReportResult | ErrorResult
//       | { ok:false, code:'still-building' } | undefined (live() turned false)
//   buildLinksLocal(token, { settings, onProgress, live, sleep, fetch, store }) -> links answer (done | unavailable)
//       | ErrorResult | undefined
//
// basics: the API's launch row (or null: then the launch is read from the chain too).
// The store is shared by the page (one per tab): a finished report is served from it for 5 minutes, the wallet
// links reuse the report's dev and first buyers, and funders already found are not asked again.
// Read-only; nothing about the visitor is kept beyond this tab.
import { launchReport, memoryStore } from './report-build.js';
import { walletLinks } from './wallet-links.js';
import { createBudget } from './budget.js';

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const MAX_REPORT_CALLS = 400;   // safety stop (each call runs up to 200 steps); a real report needs 1-3
export const MAX_LINK_CALLS = 30;      // each call asks the explorer up to 16 times
export const LINK_PAUSE_MS = 800;      // between those calls (the explorer allows ~150 requests per 5 minutes)
export const WAIT_MS = 250;            // another call is building the same report right now: ask again after this

let shared = null;
// One store per page: launch rows from the API, jobs, finished reports, funders.
export function pageStore() {
  if (!shared) {
    const rows = [];
    shared = { rows, store: memoryStore({ rows }) };
  }
  return shared;
}
export function _resetPageStore() { shared = null; }

// This tab's budget for one call: no subrequest limit (the Worker's free-plan limits don't apply here), marked as
// scoped so report-build.js leaves the page's RPC transport alone (the blame card and the copy check share it).
function pageBudget(fetchFn) {
  const b = createBudget({ limit: Infinity, d1Limit: Infinity, fetch: fetchFn || null });
  b.__scoped = true;
  return b;
}

// The store with a hook on job saves, so the card can show how far the report is (every step saves its job).
function watched(store, onProgress) {
  if (!onProgress) return store;
  return {
    ...store,
    async saveJob(job, opts) {
      await store.saveJob(job, opts);
      if (String(job.key || '').startsWith('report:') && Number.isFinite(job.progress)) {
        try { onProgress(Math.max(0, Math.min(0.99, job.progress))); } catch (e) { /* the card's problem */ }
      }
    },
  };
}

const isAddr = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);

// The API's launch row -> the store (only when it is this coin's row).
export function addBasics(token, basics, st = pageStore()) {
  const row = basics && basics.launch;
  if (!row || !isAddr(row.token) || String(row.token).toLowerCase() !== String(token).toLowerCase()) return false;
  const addr = row.token.toLowerCase();
  if (st.rows.some((r) => String(r.token).toLowerCase() === addr)) return true;
  st.rows.push({ ...row, token: addr });
  return true;
}

export async function buildReportLocal(token, { settings = null, basics = null, onProgress = null, live = () => true, sleep = realSleep, fetch: fetchFn = null, store = null, now = () => Date.now() } = {}) {
  const st = store || pageStore();
  if (basics && isAddr(token)) addBasics(token, basics, st);
  const s = watched(st.store, onProgress);
  for (let i = 0; i < MAX_REPORT_CALLS; i++) {
    const r = await launchReport({ token, store: s, settings, now: now(), budget: pageBudget(fetchFn), sleep });
    if (!live()) return undefined;
    if (!r || r.ok !== true || r.status !== 'building') return r;
    if (onProgress && Number.isFinite(r.progress)) onProgress(Math.max(0, Math.min(0.99, r.progress)));
    await sleep(r.progress === 0 && i > 0 ? WAIT_MS : 0);
    if (!live()) return undefined;
  }
  return { ok: false, code: 'still-building' };
}

export async function buildLinksLocal(token, { settings = null, onProgress = null, live = () => true, sleep = realSleep, fetch: fetchFn = null, store = null, now = () => Date.now() } = {}) {
  const st = store || pageStore();
  for (let i = 0; i < MAX_LINK_CALLS; i++) {
    const r = await walletLinks({ token, store: st.store, settings, now: now(), budget: pageBudget(fetchFn), sleep, maxSubrequests: Infinity });
    if (!live()) return undefined;
    if (!r || r.ok !== true || r.status !== 'building') return r;
    if (onProgress && Number.isFinite(r.progress)) onProgress(r.progress);
    await sleep(LINK_PAUSE_MS);
    if (!live()) return undefined;
  }
  return { ok: true, status: 'unavailable', funders: [], links: [], ignored: [] };
}
