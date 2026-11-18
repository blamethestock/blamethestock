// The three tools, run on this machine: the chain is read from here (Robinhood Chain's public RPC and explorer),
// the hosted API is asked only for its launch index (the list of same-name launches and a coin's launch row).
// The tool runners and their summaries are the hosted server's own (shared/api/src/mcp.js, a copy made by
// dev/tools/sync_mcp.sh), so both servers word their answers the same way.
//
//   const tools = localTools({ base, fetch, settings });
//   await tools.run('check_copycats', { query: 'OBSYN' })   -> MCP CallToolResult
//
// Nothing here can trade, sign or touch a wallet; nothing about the user is sent anywhere (only the tool's input).
import { runBlameSplit, runCheckCopycats, runLaunchReport, settingsFor, toolError } from './shared/api/src/mcp.js';
import { runCopyCheck } from './shared/site/src/trust/copycheck.js';
import { buildReportLocal, buildLinksLocal, _resetPageStore } from './shared/site/src/trust/local.js';
import { _setTransport } from './shared/site/src/data/rpc.js';
import { clearChainCaches } from './shared/site/src/data/chain.js';
import { DEFAULT_API_BASE } from './tools.js';

export const API_TIMEOUT_MS = 20000;
export const REPORT_TIMEOUT_MS = 240000;    // a big launch report can take a few minutes to read

const isAddr = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s.trim());

// GET <base><path> -> JSON body | null (unreachable, busy or not JSON)
async function getJson(fetchFn, url, userAgent) {
  try {
    const init = { method: 'GET', headers: { accept: 'application/json', 'user-agent': userAgent } };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') init.signal = AbortSignal.timeout(API_TIMEOUT_MS);
    const res = await fetchFn(url, init);
    if (!res || res.status === 429) return null;
    return await res.json();
  } catch (e) { return null; }
}

// The api object the runners take (deps.api): the same answers as the hosted routes, with the chain facts read here.
export function localApi({ base = DEFAULT_API_BASE, fetch: fetchFn = null, settings = null, userAgent = 'blamethestock-mcp', sleep } = {}) {
  const f = fetchFn || ((...a) => fetch(...a));
  const root = String(base).replace(/\/+$/, '');
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const listing = async (q, hint) => {
    const extra = hint ? '&name=' + encodeURIComponent(String(hint.name || '').slice(0, 100)) + '&symbol=' + encodeURIComponent(String(hint.symbol || '').slice(0, 100)) : '';
    for (let i = 0; i < 30; i++) {
      const body = await getJson(f, root + '/v1/copies?q=' + encodeURIComponent(q) + extra, userAgent);
      if (!body || typeof body !== 'object') return null;
      if (!(body.ok === true && body.status === 'building')) return body.ok === true && !Array.isArray(body.matches) ? null : body;
      await wait(2000);             // an older API still building its answer
    }
    return null;
  };
  return {
    async copies(q) {
      const r = await runCopyCheck(q, { api: listing, settings, sleep, fetch: f });
      return r || { ok: false, code: 'unavailable', message: 'Couldn\'t reach the Blame the Stock launch index (' + root + '). Try again in a minute.' };
    },
    async report(token) {
      if (!isAddr(token)) return { ok: false, code: 'bad-address', message: 'That isn\'t a coin address.' };
      const t = token.trim().toLowerCase();
      const basics = await getJson(f, root + '/v1/report/' + t, userAgent);
      const started = Date.now();
      const r = await buildReportLocal(t, {
        settings, basics: basics && basics.ok === true && basics.status === 'basics' ? basics : null, sleep, fetch: f,
        live: () => Date.now() - started < REPORT_TIMEOUT_MS,
      });
      return r === undefined ? { ok: true, status: 'building', progress: null } : r;
    },
    async links(token) {
      const r = await buildLinksLocal(String(token).trim().toLowerCase(), { settings, sleep, fetch: f });
      return r || { ok: true, status: 'unavailable', funders: [], links: [], ignored: [] };
    },
  };
}

// transport: { sleep, backoff, timeouts } for the chain reads (tests); with fetch given, the chain is read through it.
export function localTools({ base = DEFAULT_API_BASE, fetch: fetchFn = null, settings = null, userAgent, sleep, env = {}, transport = null } = {}) {
  const s = settings || settingsFor(env);
  if (fetchFn || transport) _setTransport({ ...(transport || {}), ...(fetchFn ? { fetch: fetchFn } : {}) });
  const api = localApi({ base, fetch: fetchFn, settings: s, userAgent, sleep });
  const deps = { settings: s, api, hosted: false, cache: null, now: Date.now() };
  const runners = { blame_split: runBlameSplit, check_copycats: runCheckCopycats, launch_report: runLaunchReport };
  return {
    api,
    async run(name, args) {
      const fn = runners[name];
      if (!fn) return toolError('Unknown tool: ' + name);
      try { return await fn(args || {}, { ...deps, now: Date.now() }); } catch (e) {
        return toolError('Something went wrong reading Robinhood Chain. Try again in a minute.');
      }
    },
  };
}

// Tests: a fresh start for the shared copies' caches (block times, the page store).
export function _resetShared() { clearChainCaches(); _resetPageStore(); }
