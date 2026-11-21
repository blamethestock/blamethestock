// The MCP endpoint (https://api.blamethestock.com/mcp): three read-only research tools for AI agents.
//
//   blame_split({ token, window })   how much of a coin's move came from what it's paired with (the site's card)
//   check_copycats({ query })        Pons coins with the same (or a look-alike) name, with facts and flags
//   launch_report({ token })         what a coin's dev and first buyers did; wallet links as a separate field
//
// Hosted (the API Worker on Cloudflare) the tools can't read Robinhood Chain: its official RPC answers HTTP 429 to
// every call from Cloudflare's network. So there (options.hosted):
//   check_copycats  the same-name launches from the launch index (launch time, tx, dev wallet hints, proof links)
//                   plus a note that the chain facts and flags are read by the website or the local package;
//   launch_report   the coin's launch basics from the index plus the same note;
//   blame_split     a note pointing to the website card and the local package (it needs prices at exact blocks).
// The local package (mcp/, npx blamethestock-mcp) runs these same runners with full facts read on the user's machine.
//
// Every tool answers with a short plain-text summary, the same facts as JSON (a second text block and
// structuredContent), and Blockscout proof links. Nothing here writes to the chain, asks for a wallet or gives
// advice. Errors come back as a plain message (isError), never a crash.
//
// Wiring (worker.js):
//   import { McpServer, localhostAllowedHostnames } from '@modelcontextprotocol/server';
//   import { createMcpHandler } from 'agents/mcp/server';
//   import { z } from 'zod';
//   import { handleMcp, setMcpSdk } from './mcp.js';
//   setMcpSdk({ McpServer, createMcpHandler, localhostAllowedHostnames, z });   // at module load (see setMcpSdk)
//   if (url.pathname === '/mcp') return handleMcp(request, env, ctx, { settings, budget, now, api });
//     settings  SETTINGS with the OFFICIAL list filled in (default: settingsFor(env))
//     budget    this request's createBudget() (default: a fresh one)
//     api       optional { copies(q), report(token), links(token) } -> the same JSON bodies as
//               GET /v1/copies?q=, /v1/report/{token} and /v1/report/{token}/links, so MCP shares the
//               routes' cache and job tables. Without it the tools call copies.js / report.js / links.js.
//   Rate limiting (per isolate, in memory) is the Worker's job, before handleMcp is called.
//
// Transport: Streamable HTTP through createMcpHandler (agents/mcp/server) + McpServer (@modelcontextprotocol/server,
// SDK v2), stateless: a new handler and McpServer per request. 2025-era clients (initialize first) are served by
// the handler's stateless fallback. The SDK and zod are never imported statically here, so the pure parts of
// this file (tool runners and summaries) load in jsc for dev/tests/mcp.test.js. Needs the nodejs_compat flag
// (the agents handler uses AsyncLocalStorage).
//
// Privacy: nothing about the caller is read, logged or stored.
import { SETTINGS } from '../../site/settings.js';
import { fetchPriceInput } from '../../site/src/data/index.js';
import { buildResult } from '../../site/src/core/verdict.js';
import { validateAddress, WINDOW_SECONDS } from '../../site/src/core/math.js';
import { _setTransport } from '../../site/src/data/rpc.js';
import { tokenUrl, addressUrl, txUrl, EXPLORER } from '../../site/src/trust/rules.js';
import { copyCheck } from './copies.js';
import { createBudget } from './budget.js';

export const SERVER_NAME = 'blamethestock';
export const SERVER_VERSION = '0.1.0';
export const SITE = 'https://blamethestock.com';
export const NOT_ADVICE = 'Read-only on-chain facts from Robinhood Chain; not financial advice.';
export const LINKS_CAVEAT = 'Wallets funded through exchanges, bridges or privacy tools can\'t be linked.';
export const LOCAL_PACKAGE = 'npx -y blamethestock-mcp';
export const HOSTED_NOTE = 'The hosted server can\'t read Robinhood Chain right now (its public RPC refuses Cloudflare\'s network), so '
  + 'this answer comes from our launch index only. For the full facts and flags, open ' + SITE + ' (your browser reads the chain).';
const SPLIT_CACHE_SECONDS = 60;
const WINDOWS = Object.keys(WINDOW_SECONDS);   // ['1h', '6h', '24h', '7d']
const MAX_TEXT_ROWS = 8;                       // matches / moves / wallets listed in the text summary (JSON has all)

export const INSTRUCTIONS = 'Blame the Stock: read-only research on Robinhood Chain coins (chain id 4663). '
  + 'blame_split splits a coin\'s price move into the part from what it is paired with and the coin\'s own part. '
  + 'check_copycats finds Pons coins using the same or a look-alike name and flags patterns. '
  + 'launch_report shows what a Pons coin\'s dev and first buyers did. Facts, flags and proof links only: '
  + 'never a buy/sell call, never "scam" or "safe". Nothing here can trade, sign or touch a wallet.';

// ---- tool descriptions (also copied into the stdio package, mcp/src/tools.js) -----------------------------
export const TOOLS = {
  blame_split: {
    title: 'Blame split',
    description: 'Read-only. For a Robinhood Chain coin address, splits its price move over a time window into the '
      + 'part from what it is paired with (a stock token, ETH or another coin) and the coin\'s own part. '
      + 'Prices are read on-chain at stated blocks. Returns a short summary plus JSON with proof links. Not financial advice.',
  },
  check_copycats: {
    title: 'Check copycats',
    description: 'Read-only. Given a ticker (e.g. OBSYN) or a coin address, lists Pons launches on Robinhood Chain '
      + 'with the same or a look-alike name, with launch time, dev buy and sells, fees, bridges, holders and '
      + 'liquidity, and flags such as "launched just before" or "dev dumped fast". Shows facts, never picks the '
      + '"real" coin. Summary plus JSON with proof links. Not financial advice.',
  },
  launch_report: {
    title: 'Launch report',
    description: 'Read-only. For a Pons coin address on Robinhood Chain: the launch, the dev\'s buy and every later '
      + 'move (sends, burns, sells, fees claimed, ETH bridged out), the first buyers ("snipers") and whether they '
      + 'sold, graduation and hourly activity, plus wallet links (shared funders) in a separate field with '
      + 'links_status. Heavy reports may answer status "building": call again in about 20 seconds. Summary plus '
      + 'JSON with proof links. Not financial advice.',
  },
};
export const ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

// ---- small helpers ------------------------------------------------------------------------------------------
const isNum = Number.isFinite;
const isAddr = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
const isHash = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s);
const short = (a) => (typeof a === 'string' && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : String(a || ''));
const blockUrl = (n) => EXPLORER + '/block/' + n;
const proofTx = (h) => (isHash(h) ? txUrl(h.toLowerCase()) : null);
const proofAddr = (a) => (isAddr(a) ? addressUrl(a.toLowerCase()) : null);
const proofToken = (a) => (isAddr(a) ? tokenUrl(a.toLowerCase()) : null);

// '2026-11-17T14:14:00Z' or unix seconds -> '2026-11-17 14:14:00 UTC'
export function utc(t) {
  if (t == null || t === '') return null;
  const d = typeof t === 'number' ? new Date(t * 1000) : new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC').replace(/Z$/, ' UTC');
}
const iso = (t) => {
  if (t == null) return null;
  const d = typeof t === 'number' ? new Date(t * 1000) : new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().replace(/\.\d+Z$/, 'Z');
};

// 1.1421611 -> '1.14%'; 20.5130 -> '20.51%'; 0.0004 -> '<0.01%'
export function pctText(x, digits = 2) {
  if (!isNum(x)) return '?';
  if (x !== 0 && Math.abs(x) < 0.01) return '<0.01%';
  const t = (Math.round(x * 10 ** digits) / 10 ** digits).toFixed(digits);
  return (t.includes('.') ? t.replace(/0+$/, '').replace(/\.$/, '') : t) + '%';
}
// 6321611.029 -> '6,321,611.03'
export function tokensText(x) {
  if (!isNum(x)) return '?';
  const [i, f] = (Math.round(x * 100) / 100).toFixed(2).split('.');
  const int = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return f === '00' ? int : int + '.' + f;
}
// 0.48223591 -> '0.4822 ETH'; 0.000029 -> '0.000029 ETH'
export function ethText(x, unit = 'ETH') {
  if (!isNum(x)) return '? ' + unit;
  if (x === 0) return '0 ' + unit;
  const a = Math.abs(x);
  const digits = a >= 1 ? 4 : Math.min(8, Math.max(4, 1 - Math.floor(Math.log10(a)) + 2));
  return Number(x.toFixed(digits)).toString() + ' ' + unit;
}
const usdText = (x) => (!isNum(x) ? '?' : x < 1 ? 'under $1' : x < 1000 ? '$' + Math.round(x) : x < 1e6 ? '$' + (x / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : '$' + (x / 1e6).toFixed(1).replace(/\.0$/, '') + 'M');
const seconds = (s) => {
  if (!isNum(s)) return '?';
  s = Math.round(s);
  if (s < 60) return s + ' s';
  const m = Math.floor(s / 60), r = s % 60;
  if (m < 60) return m + ' min' + (r ? ' ' + r + ' s' : '');
  const h = Math.floor(m / 60), mm = m % 60;
  return h + ' h' + (mm ? ' ' + mm + ' min' : '');
};
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

// Words a summary must never use about a coin (the site's rule): checked by the tests.
export const BANNED_WORDS = /\b(scam|scammer|safe|unsafe|rug|rugged|rugpull|should|buy now|sell now)\b/i;

// The settings the tools use: the site's SETTINGS with the API's OFFICIAL address (wrangler.toml [vars]).
export function settingsFor(env, base = SETTINGS) {
  const official = String((env && env.OFFICIAL) || '').trim().toLowerCase();
  const trust = { ...(base.trust || {}) };
  if (isAddr(official)) trust.official = [{ symbol: 'BLAME', address: official }];
  return { ...base, trust };
}

// ---- tool results -------------------------------------------------------------------------------------------
// MCP CallToolResult: the summary, then the JSON (for clients that ignore structuredContent), then structuredContent.
export function toolResult(summary, json, { isError = false } = {}) {
  const out = {
    content: [
      { type: 'text', text: summary },
      { type: 'text', text: JSON.stringify(json, null, 2) },
    ],
    structuredContent: json,
  };
  if (isError) out.isError = true;
  return out;
}
export function toolError(message, extra = {}) {
  const json = { ok: false, message, ...extra };
  return { content: [{ type: 'text', text: message }], structuredContent: json, isError: true };
}

// =============================================================================================================
// blame_split
// =============================================================================================================
export function normalizeWindow(w) {
  const s = String(w == null ? '24h' : w).trim().toLowerCase();
  return WINDOWS.includes(s) ? s : null;
}

// PriceInput + Result -> the tool's JSON
export function splitJson(pi, res) {
  const pool = pi.pool || {};
  const poolProof = isAddr(pool.id) ? proofAddr(pool.id) : null;
  return {
    ok: true,
    token: { address: res.coin.address, symbol: res.coin.symbol, name: (pi.coin && pi.coin.name) || null },
    window: res.window,
    windowLabel: res.windowLabel,
    sinceLaunch: !!pi.sinceLaunch,
    coinChange: res.c,               // c: the coin's dollar change (0.05 = +5%)
    pairChange: res.q,               // q: the pair's dollar change
    ownChange: res.r,                // r = (1+c)/(1+q) - 1
    shareFromPair: res.share,        // ln(1+q)/ln(1+c), raw (null when not meaningful)
    sharePct: res.sharePct,
    caseName: res.caseName,
    verdict: res.blame,
    subline: res.subline || null,
    pair: { address: res.pair.address, symbol: res.pair.symbol, kind: res.pair.kind, name: res.pair.name },
    pool: { id: pool.id || null, label: pool.label || null, dex: pool.dex || null, source: pool.source || null,
      pairSideUsd: isNum(pool.pairSideUsd) ? pool.pairSideUsd : null },
    blocks: { start: pi.start || null, end: pi.end || null },
    asOf: iso(res.asOf),
    notes: res.notes || [],
    warnings: res.warnings || [],
    link: res.link,
    proof: {
      token: proofToken(res.coin.address),
      pair: proofToken(res.pair.address),
      pool: poolProof,
      startBlock: pi.start && isNum(pi.start.block) ? blockUrl(pi.start.block) : null,
      endBlock: pi.end && isNum(pi.end.block) ? blockUrl(pi.end.block) : null,
    },
    howWeGotThis: 'The coin\'s price in its pair and the pair\'s dollar price are read from Robinhood Chain at the '
      + 'same start and end blocks. c = coin\'s dollar change, q = pair\'s dollar change, own move r = (1+c)/(1+q) - 1, '
      + 'share from the pair = ln(1+q)/ln(1+c). A stock token\'s price is its on-chain price, not the real share price.',
    disclaimer: NOT_ADVICE,
  };
}

export function splitSummary(j) {
  const sign = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + pctText(Math.abs(x * 100), Math.abs(x) < 0.1 ? 1 : 0);
  const sym = j.token.symbol || short(j.token.address);
  const lines = [
    sym + ' (' + j.token.address + '), ' + j.windowLabel + ': coin ' + sign(j.coinChange) + ' in dollars, '
      + (j.pair.symbol || 'pair') + ' ' + sign(j.pairChange) + ', coin vs pair ' + sign(j.ownChange) + '.',
    j.verdict + (j.subline ? ' ' + j.subline : ''),
  ];
  for (const n of j.warnings) lines.push('Warning: ' + n);
  for (const n of j.notes) lines.push('Note: ' + n);
  const b = j.blocks;
  if (b.start && b.end) lines.push('Prices as of ' + utc(b.end.time) + ' (blocks ' + b.start.block + ' to ' + b.end.block + ').');
  lines.push('Proof: ' + [j.proof.token, j.proof.pool, j.proof.startBlock, j.proof.endBlock].filter(Boolean).join(' '));
  lines.push('Card: ' + j.link);
  lines.push(NOT_ADVICE);
  return lines.join('\n');
}

export async function runBlameSplit({ token, window } = {}, deps = {}) {
  const addr = validateAddress(String(token == null ? '' : token));
  if (!addr) return toolError('That isn\'t a coin address. Paste a Robinhood Chain token address: 0x followed by 40 letters or numbers.', { code: 'bad-address' });
  const w = normalizeWindow(window);
  if (!w) return toolError('Unknown window. Use one of: ' + WINDOWS.join(', ') + '.', { code: 'bad-window' });
  const settings = deps.settings || SETTINGS;
  if (deps.hosted) {
    // Measured from a Worker: with the official RPC refusing Cloudflare, the price reads at exact blocks fail
    // (publicnode keeps only the newest blocks, dRPC caps logs at 100 blocks). Say so instead of failing slowly.
    const link = SITE + '/?ca=' + addr + '&w=' + w;
    const json = { ok: false, status: 'unavailable-hosted', token: addr, window: w, link,
      message: 'blame_split needs prices read from Robinhood Chain at exact blocks, which the hosted server can\'t do right now.',
      note: HOSTED_NOTE, disclaimer: NOT_ADVICE };
    const text = json.message + ' Open the card on the website: ' + link + ' (your browser reads the chain). ' + NOT_ADVICE;
    return toolResult(text, json);
  }

  const cacheKey = 'https://api.blamethestock.com/__mcp/split/' + addr + '/' + w;
  const cached = await cacheGet(deps, cacheKey);
  if (cached && cached.ok) return toolResult(splitSummary(cached), cached);

  const fetchPI = deps.fetchPriceInput || fetchPriceInput;
  const counted = deps.fetch || (deps.budget && deps.budget.fetch);
  if (counted) _setTransport({ fetch: counted });
  let pi;
  try { pi = await fetchPI(addr, w, {}); } catch (e) { pi = { ok: false, code: 'rpc-failed' }; }
  const res = buildResult(pi, settings, { locale: 'en-US', timeZone: 'UTC' });
  if (!res || res.ok !== true) {
    const msg = (res && res.message) || 'Robinhood Chain didn\'t answer. Try again in a moment.';
    return toolError(msg, { code: (res && res.code) || 'rpc-failed' });
  }
  const json = splitJson(pi, res);
  await cachePut(deps, cacheKey, json, SPLIT_CACHE_SECONDS);
  return toolResult(splitSummary(json), json);
}

// Cloudflare Cache API (when there is one): blame_split answers are kept for a minute so agents asking again
// don't spend the RPC budget. Keyed by token and window only.
async function cacheGet(deps, key) {
  const c = deps.cache === undefined ? defaultCache() : deps.cache;
  if (!c) return null;
  try {
    const hit = await c.match(key);
    return hit ? await hit.json() : null;
  } catch (e) { return null; }
}
async function cachePut(deps, key, json, ttl) {
  const c = deps.cache === undefined ? defaultCache() : deps.cache;
  if (!c || typeof Response !== 'function') return;
  try {
    const p = c.put(key, new Response(JSON.stringify(json), { headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=' + ttl } }));
    if (deps.ctx && typeof deps.ctx.waitUntil === 'function') deps.ctx.waitUntil(p.catch(() => {}));
    else await p;
  } catch (e) { /* the cache is a nice-to-have */ }
}
function defaultCache() {
  try { return typeof caches !== 'undefined' && caches && caches.default ? caches.default : null; } catch (e) { return null; }
}

// =============================================================================================================
// check_copycats
// =============================================================================================================
function matchLine(m, i) {
  const sym = m.symbolShown || m.symbol || '?';
  const name = m.nameShown || m.name || '';
  const tags = [m.isOfficial ? 'OFFICIAL' : '', m.isQuery ? 'the one you asked about' : '', m.match === 'near' ? 'similar name' : ''].filter(Boolean);
  const head = (i + 1) + '. ' + sym + (name && name !== sym ? ' (' + name + ')' : '') + ' ' + m.address
    + (tags.length ? ' [' + tags.join(', ') + ']' : '');
  const facts = [];
  if (m.launch && m.launch.time) facts.push('launched ' + utc(m.launch.time));
  if (m.devBuy && isNum(m.devBuy.pctSupply)) facts.push('dev bought ' + pctText(m.devBuy.pctSupply));
  if (m.devSold && isNum(m.devSold.pctOfDevBuy)) facts.push('dev sold ' + pctText(m.devSold.pctOfDevBuy, 0) + ' of it' + (isNum(m.devSold.firstSellSecondsAfterLaunch) ? ' (first sale ' + seconds(m.devSold.firstSellSecondsAfterLaunch) + ' after launch)' : ''));
  else if (m.devBuy && m.devSold === null && !(m.missing || []).includes('devSold')) facts.push('dev sold none of it');
  if (m.fees && isNum(m.fees.claimedEth) && m.fees.claimedEth > 0) facts.push('dev fees claimed ' + ethText(m.fees.claimedEth));
  if (Array.isArray(m.bridges) && m.bridges.length) facts.push('dev bridged ' + ethText(m.bridges.reduce((s, b) => s + (isNum(b.eth) ? b.eth : 0), 0)) + ' out');
  if (m.graduated && m.graduated.time) facts.push('graduated ' + utc(m.graduated.time));
  else if (m.graduated === null && !(m.missing || []).includes('graduated')) facts.push('not graduated');
  if (m.holders && isNum(m.holders.count)) facts.push(plural(m.holders.count, 'holder', 'holders'));
  if (m.liquidity && isNum(m.liquidity.usd)) facts.push('liquidity ' + usdText(m.liquidity.usd));
  const flags = (m.flags || []).map((f) => (f.severity === 'warn' ? 'FLAG: ' : 'Info: ') + f.text);
  if (m.pending) facts.push('launch block ' + (m.launch && m.launch.block) + '; chain facts not read here');
  return [head, '   ' + (facts.join('; ') || 'facts unavailable right now') + '.', ...flags.map((f) => '   ' + f),
    '   Proof: ' + [m.proof && m.proof.token, m.proof && m.proof.launchTx].filter(Boolean).join(' ')].join('\n');
}

export function copiesSummary(r) {
  const q = r.query || {};
  const what = q.kind === 'address' ? (q.symbol || short(q.address)) + ' (' + q.address + ')' : '"' + (q.input || '') + '"';
  const fromIndex = r.facts === 'client' || r.facts === 'pending';
  const lines = ['Copy check for ' + what + (r.asOf ? ', facts as of ' + utc(r.asOf) : fromIndex && r.indexAsOf ? ', launch index as of ' + utc(r.indexAsOf) : '') + ':', r.verdict];
  if (fromIndex) lines.push('Note: ' + HOSTED_NOTE);
  if (r.indexComplete === false && r.indexedFrom) lines.push('Searching Pons launches since ' + (utc(r.indexedFrom) || r.indexedFrom) + ' (older history is still being added).');
  if (r.official) lines.push('Official $' + r.official.symbol + ': ' + r.official.address + ' ' + tokenUrl(r.official.address));
  const ms = r.matches || [];
  // the pasted / official coin and flagged coins first, then the rest by launch order
  const order = ms.slice().sort((a, b) => rank(b) - rank(a) || (a.launch.block || 0) - (b.launch.block || 0));
  const shown = order.slice(0, MAX_TEXT_ROWS).sort((a, b) => (a.launch.block || 0) - (b.launch.block || 0));
  if (shown.length) lines.push('', 'Earliest first:');
  shown.forEach((m, i) => lines.push(matchLine(m, i)));
  if (ms.length > shown.length) lines.push('(' + (ms.length - shown.length) + ' more in the JSON.)');
  for (const n of r.notes || []) lines.push('Note: ' + n);
  lines.push('', ...(r.caveats || []).filter((c) => !/financial advice/i.test(c)));
  lines.push(NOT_ADVICE);
  return lines.join('\n');
}
const rank = (m) => (m.isQuery || m.isOfficial ? 100 : 0) + (m.flags || []).filter((f) => f.severity === 'warn').length * 10 + (m.graduated ? 5 : 0);

export async function runCheckCopycats({ query } = {}, deps = {}) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return toolError('Give a ticker (like OBSYN) or a coin address.', { code: 'bad-input' });
  let r;
  try {
    if (deps.api && typeof deps.api.copies === 'function') r = await deps.api.copies(q);
    else {
      const budget = deps.budget || createBudget();
      const db = deps.env && deps.env.DB ? budget.wrapDb(deps.env.DB) : (deps.db || null);
      r = await (deps.copyCheck || copyCheck)({ query: q, db, fetch: deps.fetch || budget.fetch, settings: deps.settings || SETTINGS, now: deps.now || Date.now() });
    }
  } catch (e) {
    r = { ok: false, code: 'unavailable', message: 'The copy check is unavailable right now. Try again in a minute.' };
  }
  if (!r || r.ok !== true) {
    if (r && r.status === 'building') return buildingResult('check_copycats', r.progress, { query: q });
    return toolError((r && r.message) || 'The copy check is unavailable right now. Try again in a minute.', { code: (r && r.code) || 'unavailable' });
  }
  if (r.status === 'building') return buildingResult('check_copycats', r.progress, { query: q });
  const json = r.facts === 'client' || r.facts === 'pending' ? { ...r, note: HOSTED_NOTE, disclaimer: NOT_ADVICE } : { ...r, disclaimer: NOT_ADVICE };
  return toolResult(copiesSummary(r), json);
}

// =============================================================================================================
// launch_report (+ wallet links as a separate field)
// =============================================================================================================
export function buildingResult(tool, progress, extra = {}) {
  const p = isNum(progress) ? Math.max(0, Math.min(1, progress)) : null;
  const json = { ok: true, status: 'building', progress: p, retryAfterSeconds: 20, ...extra };
  const text = 'Still building this answer' + (p != null ? ' (' + Math.round(p * 100) + '% done)' : '') + '. Call '
    + tool + ' again with the same input in about 20 seconds. ' + NOT_ADVICE;
  return toolResult(text, json);
}

const MOVE_WORDS = { send: 'sent', burn: 'burned', sell: 'sold', buy: 'bought' };
function moveLine(m) {
  const what = MOVE_WORDS[m.type] || m.type;
  let s = '- ' + (utc(m.time) || '?') + ': ' + what + ' ' + tokensText(m.tokens) + ' tokens';
  if (isNum(m.pct)) s += ' (' + pctText(m.pct) + ' of supply)';
  if (m.type === 'send' && m.to) s += ' to ' + m.to;
  if (isNum(m.eth) && (m.type === 'sell' || m.type === 'buy')) s += ' for ' + ethText(m.eth);
  if (m.afterGraduation) s += ', after graduation';
  const p = proofTx(m.tx);
  return s + (p ? ' ' + p : '');
}

export function linksSummary(links, status) {
  if (status === 'building') return 'Wallet links: still checking who funded the dev and the first buyers. Call launch_report again shortly.';
  if (status !== 'ok' || !links) return 'Wallet links: unavailable right now (the explorer is busy). Try again later; the rest of the report doesn\'t depend on it.';
  const L = links.links || [];
  const out = [];
  if (!L.length) out.push('Wallet links: no shared funder found between the dev and the first buyers.');
  else {
    out.push('Wallet links: ' + plural(L.length, 'link', 'links') + ' found (same funder, or funded within 60 s from the same source):');
    for (const l of L.slice(0, MAX_TEXT_ROWS)) {
      out.push('- ' + (l.wallets || []).join(', ') + ': ' + (l.reason || '') + ((l.proof || []).length ? ' ' + l.proof.slice(0, 3).join(' ') : ''));
    }
  }
  return out.join('\n');
}

export function reportSummary(r, links, linksStatus) {
  const t = r.token || {};
  const p = t.pons || {};
  const d = r.dev || {};
  const s = r.snipers || {};
  const sym = t.symbol || short(t.address);
  const lines = [];
  lines.push('Launch report for ' + sym + (t.name && t.name !== t.symbol ? ' (' + t.name + ')' : '') + ' ' + t.address
    + (t.isOfficial ? ' [OFFICIAL]' : '') + (r.asOf ? ', facts as of ' + utc(r.asOf) : '') + '.');
  if (r.verdict) lines.push(r.verdict);
  lines.push('');
  lines.push('Launch: ' + (utc(p.launchTime) || '?') + ', block ' + (p.launchBlock != null ? p.launchBlock : '?')
    + (proofTx(p.launchTx) ? ' ' + proofTx(p.launchTx) : ''));
  if (d.address) {
    lines.push('Dev: ' + d.address + (d.viaMulticall ? ' (launched through Multicall3, so the dev is the transaction sender)' : '') + ' ' + proofAddr(d.address));
  }
  if (d.buy) {
    lines.push('Dev buy: ' + pctText(d.buy.pct) + ' of supply (' + tokensText(d.buy.tokens) + ' tokens'
      + (isNum(d.buy.eth) ? ' for ' + ethText(d.buy.eth) : '') + ')' + (proofTx(d.buy.tx) ? ' ' + proofTx(d.buy.tx) : ''));
  }
  const moves = Array.isArray(d.moves) ? d.moves : [];
  if (moves.length) {
    lines.push('Dev moves after the launch buy:');
    for (const m of moves.slice(0, MAX_TEXT_ROWS)) lines.push(moveLine(m));
    if (moves.length > MAX_TEXT_ROWS) lines.push('(' + (moves.length - MAX_TEXT_ROWS) + ' more in the JSON.)');
  } else if (d.address) lines.push('Dev moves after the launch buy: none observed.');
  if (isNum(d.soldPct)) lines.push(d.soldPct === 0 ? 'Dev sold: nothing.' : 'Dev sold: ' + pctText(d.soldPct) + ' of supply in total.');
  if (d.fees) {
    const claims = Array.isArray(d.fees.claims) ? d.fees.claims : [];
    let f = 'Dev fees: claimed ' + ethText(d.fees.claimedEth) + (claims.length ? ' in ' + plural(claims.length, 'claim', 'claims') : '')
      + ', unclaimed ' + ethText(d.fees.unclaimedEth) + '.';
    for (const c of claims.slice(0, 4)) f += '\n- ' + (utc(c.time) || '?') + ': ' + ethText(c.eth) + (proofTx(c.tx) ? ' ' + proofTx(c.tx) : '');
    lines.push(f);
  }
  const bridges = Array.isArray(d.bridges) ? d.bridges : [];
  if (bridges.length) {
    lines.push('ETH bridged out by the dev:');
    for (const b of bridges.slice(0, MAX_TEXT_ROWS)) {
      lines.push('- ' + (utc(b.time) || '?') + ': ' + ethText(b.eth) + ' via ' + (b.via || '?')
        + (b.destChainId != null ? ' to chain ' + b.destChainId + (b.destChainConfirmed ? '' : ' (destination not confirmed)') : '')
        + (proofTx(b.tx) ? ' ' + proofTx(b.tx) : ''));
    }
  } else if (Array.isArray(d.bridges)) lines.push('ETH bridged out by the dev: none seen (exchanges and some bridges can\'t be seen).');

  const wallets = Array.isArray(s.wallets) ? s.wallets : [];
  lines.push('');
  if (wallets.length) {
    const count = (st) => wallets.filter((w) => w.status === st).length;
    const parts = [
      count('sold-on-curve') && count('sold-on-curve') + ' sold on the curve before graduation',
      count('sold-after-graduation') && count('sold-after-graduation') + ' sold after graduation',
      count('partly-sold') && count('partly-sold') + ' partly sold',
      count('holding') && count('holding') + ' still holding',
    ].filter(Boolean);
    lines.push('First buyers ("snipers", first ' + (s.windowBlocks != null ? s.windowBlocks + ' blocks' : 'blocks')
      + (isNum(s.windowSeconds) ? ', about ' + seconds(s.windowSeconds) : '') + '): ' + plural(wallets.length, 'wallet', 'wallets')
      + ' took ' + pctText(s.totalPct) + ' of supply. ' + (parts.length ? parts.join(', ') + '.' : ''));
    for (const w of wallets.slice(0, MAX_TEXT_ROWS + 2)) {
      lines.push('- ' + w.address + ': ' + pctText(w.pct) + (isNum(w.secondsAfterLaunch) ? ' at +' + seconds(w.secondsAfterLaunch) : '')
        + ', ' + String(w.status || '?').replace(/-/g, ' ') + (proofTx(w.sellTx) ? ' ' + proofTx(w.sellTx) : ' ' + proofAddr(w.address)));
    }
    if (wallets.length > MAX_TEXT_ROWS + 2) lines.push('(' + (wallets.length - MAX_TEXT_ROWS - 2) + ' more in the JSON.)');
    const clusters = Array.isArray(s.clusters) ? s.clusters : [];
    if (clusters.length) lines.push('Same-block groups: ' + clusters.map((c) => (c.wallets || []).length + ' wallets in block ' + c.block).join('; ') + '.');
  } else if (r.snipers) lines.push('First buyers ("snipers"): none other than the dev in the first blocks.');

  lines.push(r.graduation && r.graduation.time
    ? 'Graduated: ' + utc(r.graduation.time) + (proofTx(r.graduation.tx) ? ' ' + proofTx(r.graduation.tx) : '')
    : 'Graduated: not yet.');
  const hours = r.activity && Array.isArray(r.activity.hours) ? r.activity.hours : [];
  if (hours.length) {
    const buys = hours.reduce((a, h) => a + (isNum(h.buys) ? h.buys : 0), 0);
    const fresh = hours.reduce((a, h) => a + (isNum(h.newWallets) ? h.newWallets : 0), 0);
    lines.push('Activity: ' + buys + ' curve buys and ' + fresh + ' new wallets over ' + plural(hours.length, 'hour', 'hours') + ' (per hour in the JSON).');
  }
  lines.push('');
  lines.push(linksSummary(links, linksStatus));
  for (const n of r.notes || []) lines.push('Note: ' + n);
  if ((r.missing || []).length) lines.push('Couldn\'t read right now: ' + r.missing.join(', ') + '.');
  const caveats = (r.caveats || []).filter((c) => !/financial advice/i.test(c));
  if (!caveats.some((c) => /exchanges/i.test(c))) caveats.push(LINKS_CAVEAT);
  lines.push('', ...caveats);
  if (r.proof) lines.push('Proof: ' + [r.proof.token, r.proof.creator, r.proof.launchTx].filter(Boolean).join(' '));
  lines.push(NOT_ADVICE);
  return lines.join('\n');
}

// The hosted answer: the coin's launch from the index, and where to get the full report.
export function basicsSummary(b) {
  const t = b.token || {};
  const p = t.pons || {};
  const sym = t.symbol || short(t.address);
  const lines = [];
  if (b.inIndex === false) {
    lines.push('Launch report for ' + t.address + ': this coin isn\'t in our launch index (yet, or it wasn\'t launched on Pons).');
  } else {
    lines.push('Launch basics for ' + sym + (t.name && t.name !== t.symbol ? ' (' + t.name + ')' : '') + ' ' + t.address + (t.isOfficial ? ' [OFFICIAL]' : '') + '.');
    lines.push('Launch: ' + (utc(p.launchTime) || '?') + ', block ' + (p.launchBlock != null ? p.launchBlock : '?') + (proofTx(p.launchTx) ? ' ' + proofTx(p.launchTx) : ''));
    const l = b.launch || {};
    const launcher = l.creator === '0xca11bde05977b3631167028862be2a173976ca11' ? l.tx_from : l.creator;
    if (isAddr(launcher)) lines.push('Launched by ' + launcher + ' ' + proofAddr(launcher));
  }
  lines.push('Note: ' + HOSTED_NOTE);
  lines.push(LINKS_CAVEAT);
  lines.push(NOT_ADVICE);
  return lines.join('\n');
}

export async function runLaunchReport({ token } = {}, deps = {}) {
  const addr = validateAddress(String(token == null ? '' : token));
  if (!addr) return toolError('That isn\'t a coin address. Paste a Pons coin address: 0x followed by 40 letters or numbers.', { code: 'bad-address' });
  const budget = deps.budget || createBudget();
  const args = { token: addr, env: deps.env, settings: deps.settings || SETTINGS, now: deps.now || Date.now(), budget };

  let report;
  try {
    if (deps.api && typeof deps.api.report === 'function') report = await deps.api.report(addr);
    else {
      const fn = deps.launchReport || (await import('./report.js')).launchReport;
      report = await fn(args);
    }
  } catch (e) {
    report = { ok: false, code: 'unavailable', message: 'The launch report is unavailable right now. Try again in a minute.' };
  }
  if (!report || report.ok !== true) {
    return toolError((report && report.message) || 'The launch report is unavailable right now. Try again in a minute.', { code: (report && report.code) || 'unavailable' });
  }
  if (report.status === 'building') return buildingResult('launch_report', report.progress, { token: addr, links: null, links_status: 'building' });
  if (report.status === 'basics') {
    const json = { ...report, links: null, links_status: 'client', note: HOSTED_NOTE, disclaimer: NOT_ADVICE };
    return toolResult(basicsSummary(report), json);
  }

  // Wallet links: separate, never blocks or breaks the report.
  let links = null, linksStatus = 'unavailable';
  try {
    if (deps.api && typeof deps.api.links === 'function') links = await deps.api.links(addr);
    else {
      const fn = deps.walletLinks || (await import('./links.js')).walletLinks;
      links = await fn(args);
    }
    if (links && links.ok === true) linksStatus = links.status === 'done' ? 'ok' : links.status === 'building' ? 'building' : 'unavailable';
  } catch (e) { links = null; }
  if (linksStatus !== 'ok') links = links && links.ok === true ? { ...links, links: links.links || [] } : null;

  const json = { ...report, links: linksStatus === 'ok' ? links : (links && linksStatus === 'building' ? { status: 'building' } : null), links_status: linksStatus, disclaimer: NOT_ADVICE };
  return toolResult(reportSummary(report, linksStatus === 'ok' ? links : null, linksStatus), json);
}

// =============================================================================================================
// The MCP server and the HTTP handler
// =============================================================================================================
let sdk = null;   // { McpServer, createMcpHandler, localhostAllowedHostnames, z } once loaded

// worker.js should hand the SDK over at module load (top-level static imports), so the SDK and zod are
// evaluated at Worker startup and not inside the first /mcp request's 10 ms of CPU (free plan):
//   import { McpServer, localhostAllowedHostnames } from '@modelcontextprotocol/server';
//   import { createMcpHandler } from 'agents/mcp/server';
//   import { z } from 'zod';
//   setMcpSdk({ McpServer, createMcpHandler, localhostAllowedHostnames, z });
// Without it the first call imports them lazily (fine locally; costs CPU once per isolate).
export function setMcpSdk(s) {
  if (s && s.McpServer && s.createMcpHandler && s.z) sdk = { localhostAllowedHostnames: () => ['localhost', '127.0.0.1', '[::1]'], ...s };
}

async function loadSdk() {
  if (!sdk) {
    const [server, agents, zod] = await Promise.all([
      import('@modelcontextprotocol/server'),
      import('agents/mcp/server'),
      import('zod'),
    ]);
    sdk = { McpServer: server.McpServer, createMcpHandler: agents.createMcpHandler, localhostAllowedHostnames: server.localhostAllowedHostnames, z: zod.z || zod };
  }
  return sdk;
}

// One McpServer with the three tools. deps: what the tool runners get (env, settings, budget, now, api, ctx).
export function buildServer({ McpServer, z }, deps) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION, title: 'Blame the Stock', websiteUrl: SITE },
    // listChanged: false. The tool list never changes, and a stateless Worker couldn't deliver the notice anyway.
    { capabilities: { tools: { listChanged: false } }, instructions: INSTRUCTIONS });
  const addr = z.string().describe('Token contract address on Robinhood Chain: 0x followed by 40 hex characters.');
  server.registerTool('blame_split', {
    ...TOOLS.blame_split,
    inputSchema: z.object({
      token: addr,
      window: z.enum(WINDOWS).default('24h').describe('Time window: 1h, 6h, 24h (default) or 7d.'),
    }),
    annotations: ANNOTATIONS,
  }, async (args) => runBlameSplit(args, deps));
  server.registerTool('check_copycats', {
    ...TOOLS.check_copycats,
    inputSchema: z.object({
      query: z.string().max(100).describe('A ticker such as OBSYN or $OBSYN, or a token address (0x + 40 hex).'),
    }),
    annotations: ANNOTATIONS,
  }, async (args) => runCheckCopycats(args, deps));
  server.registerTool('launch_report', {
    ...TOOLS.launch_report,
    inputSchema: z.object({ token: addr.describe('The Pons coin\'s token address on Robinhood Chain (0x + 40 hex).') }),
    annotations: ANNOTATIONS,
  }, async (args) => runLaunchReport(args, deps));
  return server;
}

// Browser origins allowed to call /mcp (non-browser MCP clients send no Origin and are always fine).
export const ALLOWED_ORIGINS = ['https://blamethestock.com', 'https://www.blamethestock.com', 'http://localhost:8765'];

// Worker entry for /mcp (POST, GET, DELETE, OPTIONS). Stateless: a new handler and McpServer per request, so
// two requests in one isolate never share a budget, ctx or settings.
//   options: { settings, budget, now, api, fetch, sdk } (+ test hooks launchReport, walletLinks, copyCheck,
//            fetchPriceInput, cache)
export async function handleMcp(request, env, ctx, options = {}) {
  let S;
  try { S = options.sdk || await loadSdk(); } catch (e) {
    return finishHeaders(jsonRpcError(500, 'The MCP server is unavailable right now.'), request);
  }
  const deps = {
    env,
    ctx,
    settings: options.settings || settingsFor(env),
    budget: options.budget || createBudget(),
    now: options.now || Date.now(),
    api: options.api || null,
    hosted: options.hosted !== undefined ? !!options.hosted : !!options.api,   // the Worker always passes its routes
  };
  if (options.fetch) deps.fetch = options.fetch;
  for (const k of ['launchReport', 'walletLinks', 'copyCheck', 'fetchPriceInput', 'cache']) if (options[k] !== undefined) deps[k] = options[k];

  const local = typeof S.localhostAllowedHostnames === 'function' ? S.localhostAllowedHostnames() : ['localhost', '127.0.0.1', '[::1]'];
  let res;
  try {
    const handler = S.createMcpHandler(() => buildServer(S, deps), {
      route: '/mcp',
      corsOptions: {
        origin: ALLOWED_ORIGINS[0],
        headers: 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Mcp-Method, Mcp-Name, Last-Event-ID',
        methods: 'GET, POST, DELETE, OPTIONS',
        exposeHeaders: 'Mcp-Session-Id',
        maxAge: 86400,
      },
      allowedHostnames: ['api.blamethestock.com', ...local],
      allowedOriginHostnames: ['blamethestock.com', 'www.blamethestock.com', ...local],
      onerror: (err) => { try { console.error('mcp: ' + String((err && err.message) || err).slice(0, 200)); } catch (e) { /* ignore */ } },
    });
    res = await handler(request, env, ctx || { waitUntil() {}, passThroughOnException() {}, props: {} });
  } catch (e) { return finishHeaders(jsonRpcError(500, 'The MCP server hit an error. Try again.'), request); }
  return finishHeaders(res, request);
}

// CORS only for the three site origins (the SDK sets one fixed origin), never cached by browsers or Cloudflare.
// A 405 (GET or DELETE: no standalone stream, no sessions) names the methods that work, as HTTP requires.
export function finishHeaders(res, request) {
  const h = new Headers(res.headers);
  if (res.status === 405) h.set('Allow', 'POST, OPTIONS');
  const origin = request.headers.get('origin');
  if (origin && ALLOWED_ORIGINS.includes(origin)) h.set('Access-Control-Allow-Origin', origin);
  else h.delete('Access-Control-Allow-Origin');
  h.append('Vary', 'Origin');
  h.set('Cache-Control', 'no-store');
  h.set('X-Content-Type-Options', 'nosniff');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function jsonRpcError(status, message) {
  return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message }, id: null }), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
