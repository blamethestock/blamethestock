// Blame the Stock: the launch report card. Shows a ReportResult in #report, under the copy check, and then the wallet
// links, which load separately once the report is drawn. Both are read from Robinhood Chain in the visitor's browser
// (../trust/local.js runs the report steps of report-build.js and wallet-links.js); our API only gives the coin's
// launch row from its index. Loaded by app.js only when it is needed.
//
//   fetchBasics(token, settings, { fetch }) -> the API's launch row | null (unreachable, unknown or not indexed)
//   loadReport(token, settings, { fetch, sleep, live, onProgress, maxWaitMs })  builds it here, with progress
//   loadLinks(token, settings, { sleep, live })                                 the wallet links, after the report
//   reportView(report, settings, { timeZone }) / linksView(links, report, settings, { timeZone })  -> plain objects
//                                                 holding every string and link the card shows (no DOM)
//   linkedVerdict(report, links)                  the verdict line once the links are in ("No dev link found.")
//   renderReportLoading(el, settings, progress) / renderReport(el, res, settings, { onRetry, timeZone })
//   renderLinks(card, linksOrState, report, settings, { onRetry, timeZone })
//   showReport(el, token, settings, { fetch, sleep, live, timeZone })  the whole flow: report, then links
//
// Everything from the API and the chain is treated as data: text goes in with textContent only, and every link is rebuilt here
// from an address or transaction hash that has been checked (or must match the explorer's own URL pattern), so a
// bad answer can't point a link anywhere else. Never advice: we say what was observed, and what we can't link.
import { SETTINGS } from '../../settings.js';
import { fill } from '../core/format.js';
import { duration, ethAmount } from '../trust/rules.js';
import { buildVerdict, linkSentence } from '../trust/report-rules.js';
import { tokenUrl, addressUrl, txUrl, shortAddr, when, apiBaseOf } from './copycheck-card.js';
import { buildReportLocal, buildLinksLocal } from '../trust/local.js';
import { reportShare } from './x-share.js';

const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const PROOF = /^https:\/\/robinhoodchain\.blockscout\.com\/(tx|address|token)\/(0x[0-9a-fA-F]{40}|0x[0-9a-fA-F]{64})$/;
const TIMEOUT_MS = 25000;
const MAX_TEXT = 400;
const MAX_SYMBOL = 32;
export const MAX_WAIT_MS = 300000;     // stop building a report that still isn't done after 5 minutes
export const POLL_MIN_S = 1.5;
export const POLL_MAX_S = 10;
const MAX_SNIPER_ROWS = 10;            // first buyers listed straight away; the rest behind "Show N more"
const MAX_STEPS = 60;                  // dev steps listed straight away

const isAddr = (a) => typeof a === 'string' && ADDR.test(a);
const isHash = (h) => typeof h === 'string' && HASH.test(h);
const text = (s, max = MAX_TEXT) => (typeof s === 'string' ? s.slice(0, max) : '');
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const secs = (iso) => { const t = Date.parse(iso); return Number.isFinite(t) ? t / 1000 : null; };
const arr = (x) => (Array.isArray(x) ? x : []);
const proof = (u) => (typeof u === 'string' && PROOF.test(u) ? u : null);
const own = (table, key) => (table && Object.prototype.hasOwnProperty.call(table, key) && typeof table[key] === 'string' ? table[key] : null);
const lower = (a) => String(a).toLowerCase();

// ---- words ----------------------------------------------------------------------------------------------
// settings.trust.report.wording, with the same words built in as a fallback.
const WORDS = {
  title: 'Launch report',
  checking: 'Building the launch report…',
  building: 'Building the launch report… {pct}',
  unavailable: 'Launch report unavailable right now.',
  stillBuilding: 'The launch report is still being built.',
  tryAgain: 'Try again',
  official: 'Official {symbol}',
  devTitle: 'Dev',
  sniperTitle: 'First buyers',
  activityTitle: 'Activity',
  linksTitle: 'Wallet links',
  // dev
  devWallet: 'Dev wallet', launchBuy: 'Launch buy', soldFact: 'Sold', soldNothing: 'nothing', ofSupply: '{pct} of supply',
  feesClaimed: 'Fees claimed', feesUnclaimed: 'Fees not yet claimed', bridgedOut: 'Bridged out',
  viaMulticall: 'Launched through Multicall3, so the dev is the wallet that sent the launch transaction.',
  stepLaunch: 'Launched the coin and bought {pct} of supply ({tokens}) for {eth}',
  stepLaunchNoBuy: 'Launched the coin',
  stepSend: 'Sent {tokens} ({pct}) to {to}',
  stepBurn: 'Burned {tokens} ({pct})',
  stepSell: 'Sold {tokens} ({pct}) for {eth}',
  stepSellNoEth: 'Sold {tokens} ({pct})',
  stepBuy: 'Bought {tokens} ({pct}) for {eth}',
  stepBuyNoEth: 'Bought {tokens} ({pct})',
  stepClaim: 'Claimed {eth} in fees',
  stepBridge: 'Bridged {eth} out through {via}{dest}',
  bridgeTo: ' to {chain}',
  bridgeToUnconfirmed: ' to {chain} (not confirmed)',
  stepGraduated: 'The coin graduated',
  afterGraduation: 'after graduation',
  atLaunch: 'launch',
  moreMoves: '{count} more moves not listed. Every move is on the explorer.',
  movesUnread: 'The dev\'s moves couldn\'t be read this time.',
  // snipers
  sniperLead: '{count} took {pct} of supply in the first {span}',
  sniperLeadOne: '1 wallet took {pct} of supply in the first {span}',
  sniperNone: 'No first buyers besides the dev in the first {span}.',
  barSold: 'Sold', barSoldOrMoved: 'Sold or moved', barHeld: 'Still held', barRest: 'Rest of supply',
  blocksAfter: 'block +{n}',
  soldBeforeGraduation: 'Sold before graduation',
  soldOnCurve: 'Sold on the curve',
  soldAfterGraduation: 'Sold {gap} after graduation',
  soldAfterGraduationNoGap: 'Sold after graduation',
  partlySold: 'Sold {pct} of it, holds the rest',
  holding: 'Still holding',
  moved: 'moved {pct} to other wallets',
  sellProof: 'sell',
  buyProof: 'buy',
  sameBlock: 'Same block: {groups}.',
  sameBlockGroup: '{count} wallets at block +{n}',
  showMore: 'Show {count} more',
  // activity
  graduatedAt: 'Graduated {time}, {gap} after launch',
  notGraduated: 'Not graduated yet',
  buysPerHour: 'Buys per hour',
  buysWord: 'buys',
  newWallets: 'first-time buyers',
  activityTotal: '{buys} buys, {wallets} first-time buyers',
  activitySoFar: 'so far',
  activityNote: 'Curve buys only, for the first 24 hours or until graduation.',
  hourTitle: '{time}: {buys} buys, {wallets} first-time buyers',
  // links
  linksChecking: 'Checking wallet links…',
  linksUnavailable: 'Wallet links unavailable right now.',
  linksNone: 'No funding links found between the dev and the {count} first buyers we checked.',
  linksNoneDev: 'No funding link found for the dev.',
  devFunder: 'The dev\'s first ETH came from {who} ({eth}, {time}).',
  devFunderUnknown: 'We couldn\'t see where the dev\'s first ETH came from.',
  publicService: '{name}, a public service',
  aWallet: 'wallet {address}',
  weak: 'Can be chance',
  strong: 'Same funder',
  devTag: 'Dev',
  ignoredTitle: 'Left out as public services ({count})',
  // footer
  missing: 'Some parts couldn\'t be read this time: {parts}. Ask again in a minute.',
  refreshing: 'Updating…',
  asOf: 'Chain data as of {time}',
  proof: 'proof',
  explorer: 'Explorer',
  howTitle: 'How we got this',
  errors: { 'rpc-failed': 'Robinhood Chain didn\'t answer.', unavailable: 'Launch report unavailable right now.' },
};
export function words(settings = SETTINGS) {
  const r = (settings && settings.trust && settings.trust.report) || {};
  const w = r.wording || {};
  return { ...WORDS, ...w, errors: { ...WORDS.errors, ...(w.errors || {}) } };
}

const apiBase = (settings) => apiBaseOf(settings);   // https only (or a Worker on this machine, local dev)

// ---- the API and the local build ---------------------------------------------------------------------------
// Our API gives only the coin's launch row from its index (GET /v1/report/{token}, status 'basics'): the official
// Robinhood Chain RPC refuses Cloudflare's network, so the report and the wallet links are read from the chain
// here, in the visitor's browser (../trust/local.js, the same step code the API used to run).
async function getJson(url, { fetch: f = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  if (typeof f !== 'function') return null;
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl && typeof setTimeout === 'function' ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  try {
    const res = await f(url, {
      method: 'GET', headers: { Accept: 'application/json' }, credentials: 'omit',
      ...(ctrl ? { signal: ctrl.signal } : {}),
    });
    if (!res || res.status === 429) return null;          // busy: same as unreachable
    try { return await res.json(); } catch (e) { return null; }
  } catch (e) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const progressOf = (p) => { const v = Number(p); return Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0; };
const waitOf = (s) => { const v = Number(s); return Number.isFinite(v) ? Math.max(POLL_MIN_S, Math.min(POLL_MAX_S, v)) : 2; };

// Only the shapes of the contract get through.
export function checkReport(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.ok === true && body.status === 'building') {
    return { ok: true, status: 'building', progress: progressOf(body.progress), retryAfterSeconds: waitOf(body.retryAfterSeconds) };
  }
  if (body.ok === true && body.status === 'done' && body.token && typeof body.token === 'object' && isAddr(body.token.address)) return body;
  if (body.ok === false && typeof body.code === 'string' && /^[a-z-]{2,40}$/.test(body.code)) {
    return { ok: false, code: body.code, message: text(body.message) };
  }
  return null;
}
export function checkLinks(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.ok === true && body.status === 'building') {
    return { ok: true, status: 'building', progress: progressOf(body.progress), retryAfterSeconds: waitOf(body.retryAfterSeconds) };
  }
  if (body.ok === true && body.status === 'done' && Array.isArray(body.funders) && Array.isArray(body.links)) return body;
  if (body.ok === true && body.status === 'unavailable') return { ok: true, status: 'unavailable' };
  if (body.ok === false) return { ok: true, status: 'unavailable' };   // any error: the card offers a retry
  return null;
}
// The API's launch basics: only a launch row for this very coin, with a real transaction hash and block, gets through.
export function checkBasics(body, token) {
  if (!body || typeof body !== 'object' || body.ok !== true || body.status !== 'basics') return null;
  const r = body.launch;
  if (!r || typeof r !== 'object' || !isAddr(r.token) || lower(r.token) !== lower(token)) return null;
  if (!isHash(r.tx) || !Number.isInteger(Number(r.block)) || !isAddr(r.curve)) return null;
  const pick = {};
  for (const k of ['token', 'factory', 'curve', 'creator', 'tx_from', 'pair_token', 'tx']) pick[k] = r[k] == null ? null : lower(r[k]);
  pick.block = Number(r.block);
  pick.log_index = Number.isFinite(Number(r.log_index)) ? Number(r.log_index) : 0;
  pick.time = Number.isFinite(Number(r.time)) && r.time != null ? Number(r.time) : null;
  pick.name = typeof r.name === 'string' ? r.name.slice(0, 200) : null;
  pick.symbol = typeof r.symbol === 'string' ? r.symbol.slice(0, 200) : null;
  return { ok: true, status: 'basics', launch: pick };
}

export const BASICS_TIMEOUT_MS = 8000;   // the launch row only: don't hold the report up for long (it can read it itself)
export async function fetchBasics(token, settings = SETTINGS, opts = {}) {
  const base = apiBase(settings);
  if (!base || !isAddr(token)) return null;
  return checkBasics(await getJson(base + '/v1/report/' + lower(token), { timeoutMs: BASICS_TIMEOUT_MS, ...opts }), token);
}

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The launch report, built here. opts: { fetch (our API), live, onProgress(0..1), sleep, maxWaitMs, buildReport }
// (buildReport replaces the local builder; tests). Returns the report, an error, { ok:false, code:'still-building' }
// after maxWaitMs, or undefined when live() turned false (a newer lookup took over).
export async function loadReport(token, settings = SETTINGS, opts = {}) {
  const { live = () => true, onProgress = null, sleep = realSleep, maxWaitMs = MAX_WAIT_MS } = opts;
  if (!isAddr(token)) return { ok: false, code: 'bad-address', message: '' };
  const basics = await fetchBasics(token, settings, opts);       // null is fine: the launch is read from the chain
  if (!live()) return undefined;
  const build = opts.buildReport || buildReportLocal;
  const started = Date.now();
  const stillLive = () => live() && Date.now() - started <= maxWaitMs;
  let res;
  try {
    res = await build(lower(token), { settings, basics, live: stillLive, onProgress: (p) => { if (live() && onProgress) onProgress(progressOf(p)); }, sleep });
  } catch (e) {
    res = null;
  }
  if (!live()) return undefined;
  if (res === undefined) return { ok: false, code: 'still-building' };
  const ok = checkReport(res);
  if (ok && ok.status === 'building') return { ok: false, code: 'still-building' };
  return ok;
}

// The wallet links, checked here after the report is drawn. Same opts (buildLinks replaces the local builder).
export async function loadLinks(token, settings = SETTINGS, opts = {}) {
  const { live = () => true, onProgress = null, sleep = realSleep } = opts;
  const build = opts.buildLinks || buildLinksLocal;
  let res;
  try { res = await build(lower(token), { settings, live, onProgress, sleep }); } catch (e) { res = null; }
  if (!live()) return undefined;
  const ok = checkLinks(res);
  return ok && ok.status === 'building' ? { ok: true, status: 'unavailable' } : ok;
}

// ---- numbers ---------------------------------------------------------------------------------------------
const trimZeros = (s) => s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
// 11421611 -> '11.4M tokens', 5100000 -> '5.1M tokens', 950 -> '950 tokens'
export function tokensText(n) {
  const v = num(n);
  if (v == null || v < 0) return '?';
  let s;
  if (v >= 1e9) s = trimZeros((v / 1e9).toPrecision(3)) + 'B';
  else if (v >= 1e6) s = trimZeros((v / 1e6).toPrecision(3)) + 'M';
  else if (v >= 1e4) s = trimZeros((v / 1e3).toPrecision(3)) + 'k';
  else s = Math.round(v).toLocaleString('en-US');
  return s + ' tokens';
}
const fillPct = (tpl, pct) => String(tpl || '{pct}').replace('{pct}', pct);

// % of supply: 20.513 -> '20.5%', 1.1421 -> '1.14%', 0.0458 -> '0.046%'
export function pctText(x) {
  const v = num(x);
  if (v == null) return '?';
  if (v === 0) return '0%';
  if (v < 0.001) return '<0.001%';
  if (v >= 10) return trimZeros(v.toFixed(1)) + '%';
  if (v >= 0.1) return trimZeros(v.toFixed(2)) + '%';
  return trimZeros(v.toPrecision(2)) + '%';
}
const CHAINS = { 1: 'Ethereum', 10: 'Optimism', 56: 'chain 56', 137: 'Polygon', 8453: 'Base', 42161: 'Arbitrum One' };
const chainName = (id) => (Number.isInteger(id) ? CHAINS[id] || 'chain ' + id : null);

// ---- the view (pure: no DOM) -----------------------------------------------------------------------------
function devView(r, W, tz) {
  const d = r.dev && typeof r.dev === 'object' ? r.dev : {};
  const pons = (r.token && r.token.pons) || {};
  const t0 = secs(pons.launchTime);
  const buy = d.buy && typeof d.buy === 'object' ? d.buy : null;
  const fees = d.fees && typeof d.fees === 'object' ? d.fees : {};
  const bridges = arr(d.bridges).filter((b) => b && typeof b === 'object');
  const moves = Array.isArray(d.moves) ? d.moves.filter((m) => m && typeof m === 'object') : null;
  const grad = r.graduation && typeof r.graduation === 'object' ? r.graduation : null;
  const bridged = bridges.reduce((s, b) => s + (num(b.eth) || 0), 0);
  const claimed = num(fees.claimedEth);
  const unclaimed = num(fees.unclaimedEth);
  const escrow = proof(r.proof && r.proof.escrow);

  const facts = [
    { key: 'wallet', label: W.devWallet, text: isAddr(d.address) ? shortAddr(d.address) : '?', url: addressUrl(d.address), title: isAddr(d.address) ? lower(d.address) : null },
    { key: 'buy', label: W.launchBuy, text: buy && num(buy.pct) != null ? fillPct(W.ofSupply, pctText(buy.pct)) : '?', url: txUrl(buy && buy.tx) || txUrl(pons.launchTx) },
    { key: 'sold', label: W.soldFact, text: moves == null ? '?' : num(d.soldPct) > 0 ? fillPct(W.ofSupply, pctText(d.soldPct)) : W.soldNothing, url: addressUrl(d.address) },
    { key: 'fees', label: W.feesClaimed, text: claimed == null ? '?' : ethAmount(claimed), url: escrow || addressUrl(d.address) },
  ];
  if (unclaimed != null && unclaimed > 0) facts.push({ key: 'unclaimed', label: W.feesUnclaimed, text: ethAmount(unclaimed), url: escrow });
  facts.push({ key: 'bridged', label: W.bridgedOut, text: ethAmount(bridged), url: bridges.length ? txUrl(bridges[0].tx) : addressUrl(d.address) });

  // the step list: launch, every move, fee claims, bridges and graduation, in time order
  const steps = [];
  const step = (o) => {
    const t = secs(o.time);
    steps.push({ ...o, t, when: when(o.time, tz), rel: t0 != null && t != null ? (t - t0 <= 0 ? W.atLaunch : '+' + duration(t - t0)) : '' });
  };
  step({
    kind: 'launch',
    text: buy && num(buy.pct) != null && num(buy.tokens) != null
      ? fill(W.stepLaunch, { pct: pctText(buy.pct), tokens: tokensText(buy.tokens), eth: ethAmount(num(buy.eth) || 0) })
      : W.stepLaunchNoBuy,
    time: pons.launchTime, url: txUrl(pons.launchTx) || txUrl(buy && buy.tx),
  });
  for (const m of moves || []) {
    const vars = { tokens: tokensText(m.tokens), pct: pctText(m.pct), eth: num(m.eth) != null ? ethAmount(m.eth) : '', to: isAddr(m.to) ? shortAddr(m.to) : '?' };
    const tpl = m.type === 'send' ? W.stepSend : m.type === 'burn' ? W.stepBurn
      : m.type === 'sell' ? (vars.eth ? W.stepSell : W.stepSellNoEth)
        : m.type === 'buy' ? (vars.eth ? W.stepBuy : W.stepBuyNoEth) : null;
    if (!tpl) continue;
    step({ kind: m.type, text: fill(tpl, vars), time: m.time, url: txUrl(m.tx), toUrl: m.type === 'send' ? addressUrl(m.to) : null,
      after: !!m.afterGraduation, warn: m.type === 'sell' });
  }
  for (const c of arr(fees.claims)) {
    if (!c || num(c.eth) == null) continue;
    step({ kind: 'claim', text: fill(W.stepClaim, { eth: ethAmount(c.eth) }), time: c.time, url: txUrl(c.tx) });
  }
  for (const b of bridges) {
    const chain = chainName(b.destChainId);
    const dest = chain ? fill(b.destChainConfirmed ? W.bridgeTo : W.bridgeToUnconfirmed, { chain }) : '';
    step({ kind: 'bridge', text: fill(W.stepBridge, { eth: ethAmount(num(b.eth) || 0), via: text(b.via, 40) || '?', dest }), time: b.time, url: txUrl(b.tx) });
  }
  if (grad && grad.time) step({ kind: 'graduated', text: W.stepGraduated, time: grad.time, url: txUrl(grad.tx), neutral: true });
  const order = { launch: 0, graduated: 2 };
  steps.sort((a, b) => (a.t == null ? Infinity : a.t) - (b.t == null ? Infinity : b.t) || (order[a.kind] || 1) - (order[b.kind] || 1));
  const notShown = Math.max(0, num(d.movesNotShown) || 0) + Math.max(0, steps.length - MAX_STEPS);
  return {
    title: W.devTitle,
    address: isAddr(d.address) ? lower(d.address) : null,
    facts,
    steps: steps.slice(0, MAX_STEPS).map(({ t, ...s }) => s),
    more: notShown ? fill(W.moreMoves, { count: notShown }) : null,
    moreUrl: addressUrl(d.address),
    note: moves == null ? W.movesUnread : d.viaMulticall ? W.viaMulticall : null,
  };
}

function statusText(w, grad, W) {
  switch (w.status) {
    case 'sold-on-curve': return grad ? W.soldBeforeGraduation : W.soldOnCurve;
    case 'sold-after-graduation':
      return num(w.secondsAfterGraduation) != null ? fill(W.soldAfterGraduation, { gap: duration(w.secondsAfterGraduation) }) : W.soldAfterGraduationNoGap;
    case 'partly-sold': return fill(W.partlySold, { pct: Math.round(num(w.soldPct) || 0) + '%' });
    default: return W.holding;
  }
}

function sniperView(r, W, tz) {
  const s = r.snipers && typeof r.snipers === 'object' ? r.snipers : {};
  const grad = r.graduation && r.graduation.time ? r.graduation : null;
  const span = duration(num(s.windowSeconds) != null ? s.windowSeconds : 5);
  const ws = arr(s.wallets).filter((w) => w && isAddr(w.address));
  const total = num(s.totalPct) || 0;
  let sold = 0, moved = 0;
  const rows = ws.map((w) => {
    const pct = num(w.pct) || 0;
    const sp = Math.max(0, Math.min(100, num(w.soldPct) || 0));
    const mp = Math.max(0, Math.min(100 - sp, num(w.movedPct) || 0));
    sold += pct * sp / 100;
    moved += pct * mp / 100;
    const st = ['sold-on-curve', 'sold-after-graduation', 'partly-sold', 'holding'].includes(w.status) ? w.status : 'holding';
    const blocks = num(w.blocksAfterLaunch);
    return {
      address: lower(w.address),
      short: shortAddr(w.address),
      url: addressUrl(w.address),
      pct: pctText(pct),
      at: blocks != null ? fill(W.blocksAfter, { n: blocks }) + (num(w.secondsAfterLaunch) != null ? ' · ' + duration(w.secondsAfterLaunch) : '') : '',
      buyUrl: txUrl(w.buyTx),
      status: st,
      statusText: statusText({ ...w, status: st }, grad, W) + (mp > 0 ? ', ' + fill(W.moved, { pct: Math.round(mp) + '%' }) : ''),
      sellUrl: txUrl(w.sellTx),
      sellWhen: w.sellTime ? when(w.sellTime, tz) : '',
      sold: st !== 'holding',
    };
  });
  const launchBlock = num(r.token && r.token.pons && r.token.pons.launchBlock);
  const groups = arr(s.clusters).filter((c) => c && arr(c.wallets).length)
    .map((c) => fill(W.sameBlockGroup, { count: arr(c.wallets).length, n: launchBlock != null && num(c.block) != null ? c.block - launchBlock : '?' }));
  const clusterOf = {};
  arr(s.clusters).forEach((c, i) => { for (const a of arr(c && c.wallets)) if (isAddr(a)) clusterOf[lower(a)] = i + 1; });
  for (const row of rows) row.group = clusterOf[row.address] || 0;
  const goneShare = Math.min(total, sold + moved);
  const spanText = num(s.spanSeconds) != null ? duration(Math.max(1, Math.round(s.spanSeconds))) : span;
  return {
    title: W.sniperTitle,
    lead: rows.length ? fill(rows.length === 1 ? W.sniperLeadOne : W.sniperLead, { count: rows.length + ' wallets', pct: pctText(total), span: spanText }) : null,
    none: rows.length ? null : fill(W.sniperNone, { span }),
    bar: rows.length ? { gone: goneShare / 100, held: Math.max(0, total - goneShare) / 100 } : null,
    legend: rows.length ? [
      { key: 'gone', label: moved > 0 ? W.barSoldOrMoved : W.barSold, value: pctText(goneShare) },
      { key: 'held', label: W.barHeld, value: pctText(Math.max(0, total - goneShare)) },
      { key: 'rest', label: W.barRest, value: pctText(Math.max(0, 100 - total)) },
    ] : [],
    rows,
    shown: Math.min(rows.length, MAX_SNIPER_ROWS),
    clusters: groups.length ? fill(W.sameBlock, { groups: groups.join(', ') }) : null,
  };
}

function hourLabel(iso, tz) {
  const s = secs(iso);
  if (s == null) return '';
  for (const z of [tz, undefined]) {
    try { return new Intl.DateTimeFormat('en-US', { hour: 'numeric', ...(z ? { timeZone: z } : {}) }).format(new Date(s * 1000)); }
    catch (e) { /* bad zone: the visitor's own */ }
  }
  return new Date(s * 1000).toISOString().slice(11, 13) + ':00 UTC';
}

function activityView(r, W, tz) {
  const a = r.activity && typeof r.activity === 'object' ? r.activity : {};
  const grad = r.graduation && r.graduation.time ? r.graduation : null;
  const t0 = secs(r.token && r.token.pons && r.token.pons.launchTime);
  const hours = arr(a.hours).filter((h) => h && secs(h.hourStart) != null).map((h) => ({
    start: h.hourStart, buys: Math.max(0, num(h.buys) || 0), wallets: Math.max(0, num(h.newWallets) || 0),
  }));
  const max = hours.reduce((m, h) => Math.max(m, h.buys), 0);
  const buys = hours.reduce((s, h) => s + h.buys, 0);
  const wallets = hours.reduce((s, h) => s + h.wallets, 0);
  const gt = grad ? secs(grad.time) : null;
  return {
    title: W.activityTitle,
    graduation: grad
      ? { text: fill(W.graduatedAt, { time: when(grad.time, tz), gap: gt != null && t0 != null ? duration(gt - t0) : '?' }), url: txUrl(grad.tx), done: true }
      : { text: W.notGraduated, url: proof(r.proof && r.proof.curve), done: false },
    label: W.buysPerHour,
    hours: hours.map((h) => ({
      buys: h.buys, wallets: h.wallets,
      height: max ? h.buys / max : 0,
      inner: h.buys ? Math.min(1, h.wallets / h.buys) : 0,
      title: fill(W.hourTitle, { time: hourLabel(h.start, tz), buys: h.buys, wallets: h.wallets }),
    })),
    ends: hours.length ? [hourLabel(hours[0].start, tz), hourLabel(hours[hours.length - 1].start, tz)] : [],
    total: hours.length ? fill(W.activityTotal, { buys: buys.toLocaleString('en-US'), wallets: wallets.toLocaleString('en-US') }) + (a.complete === false ? ' (' + W.activitySoFar + ')' : '') : '',
    note: W.activityNote,
    proof: proof(a.proof) || proof(r.proof && r.proof.curve),
  };
}

const symbolOf = (r) => '$' + text(String((r.token && r.token.symbol) || '').replace(/^\$/, ''), MAX_SYMBOL);

export function reportView(r, settings = SETTINGS, { timeZone } = {}) {
  const W = words(settings);
  const tok = r.token || {};
  const missing = arr(r.missing).map((m) => text(m, 40)).filter((m) => /^[a-z0-9 -]+$/i.test(m));
  return {
    title: W.title,
    query: symbolOf(r) + (isAddr(tok.address) ? ' · ' + shortAddr(tok.address) : ''),
    address: isAddr(tok.address) ? lower(tok.address) : null,
    tokenUrl: tokenUrl(tok.address),
    official: tok.isOfficial === true ? { label: '✅ ' + fill(W.official, { symbol: symbolOf(r) }) } : null,
    verdict: text(r.verdict),
    dev: devView(r, W, timeZone),
    snipers: sniperView(r, W, timeZone),
    activity: activityView(r, W, timeZone),
    missing: missing.length ? fill(W.missing, { parts: missing.join(', ') }) : null,
    caveats: arr(r.caveats).map((c) => text(c)).filter(Boolean),
    how: { title: W.howTitle, items: arr(r.notes).map((n) => text(n)).filter(Boolean) },
    asOf: r.asOf ? fill(W.asOf, { time: when(r.asOf, timeZone) }) + (r.refreshing ? ' · ' + W.refreshing : '') : '',
    words: W,
  };
}

// The verdict once the wallet links are in. The API adds "No dev link found." itself once it has the links; until
// its cache catches up the card adds the same sentence, built by the same rules (report-rules.js).
export function linkedVerdict(report, links) {
  const v = text(report && report.verdict);
  const add = linkSentence(links);
  if (!add || v.includes(add)) return v;
  try {
    if (buildVerdict(report, null) === v) return buildVerdict(report, links);
  } catch (e) { /* keep the API's sentence */ }
  return v;
}

export function linksView(links, report, settings = SETTINGS, { timeZone } = {}) {
  const W = words(settings);
  if (links === 'checking' || (links && links.ok === true && links.status === 'building')) {
    return { state: 'checking', text: W.linksChecking, progress: links && links.status === 'building' ? links.progress : null };
  }
  if (!links || links.ok !== true || links.status !== 'done') return { state: 'unavailable', text: W.linksUnavailable, retry: W.tryAgain };
  const dev = isAddr(links.dev) ? lower(links.dev) : (report && report.dev && isAddr(report.dev.address) ? lower(report.dev.address) : null);
  const funders = arr(links.funders).filter((f) => f && isAddr(f.wallet));
  const devF = funders.find((f) => f.role === 'dev' || lower(f.wallet) === dev);
  let devFunder;
  if (devF && isAddr(devF.funder)) {
    const who = devF.kind === 'public-service'
      ? fill(W.publicService, { name: text(devF.label, 60) || shortAddr(devF.funder) })
      : fill(W.aWallet, { address: shortAddr(devF.funder) });
    devFunder = { text: fill(W.devFunder, { who, eth: num(devF.eth) != null ? ethAmount(devF.eth) : '?', time: when(devF.time, timeZone) || '?' }),
      url: txUrl(devF.tx) || addressUrl(devF.funder) };
  } else {
    devFunder = { text: W.devFunderUnknown, url: null };
  }
  const items = arr(links.links).filter((l) => l && arr(l.wallets).length).map((l) => {
    const weak = l.strength === 'weak';
    return {
      weak,
      dev: !!l.involvesDev,
      tag: weak ? W.weak : W.strong,
      text: text(l.reason),
      wallets: arr(l.wallets).filter(isAddr).map((a) => ({ short: shortAddr(a), url: addressUrl(a), dev: lower(a) === dev })),
      proofs: arr(l.proof).map(proof).filter(Boolean).slice(0, 6),
    };
  }).sort((a, b) => (a.weak - b.weak) || (b.dev - a.dev));
  const checked = funders.filter((f) => f.role !== 'dev').length;
  const strongDev = items.some((i) => i.dev && !i.weak);
  return {
    state: 'done',
    devFunder,
    items,
    none: strongDev ? null : items.some((i) => !i.weak) ? W.linksNoneDev : fill(W.linksNone, { count: checked }),
    ignored: arr(links.ignored).filter((g) => g && isAddr(g.address)).map((g) => ({ short: shortAddr(g.address), url: addressUrl(g.address), why: text(g.why, 160) })),
    ignoredTitle: fill(W.ignoredTitle, { count: arr(links.ignored).filter((g) => g && isAddr(g.address)).length }),
    caveat: text(links.caveat),
    notes: arr(links.notes).map((n) => text(n)).filter(Boolean),
    verdict: linkedVerdict(report, links),
  };
}

// The words for an error (settings first, then the API's own sentence).
export function errorText(err, settings = SETTINGS) {
  const W = words(settings);
  if (!err) return W.unavailable;
  if (err.code === 'still-building') return W.stillBuilding;
  return own(W.errors, err.code) || text(err.message) || W.unavailable;
}
// Errors worth a "Try again" (the coin itself is fine; something was busy).
export const retryable = (err) => !err || !['bad-address', 'not-found', 'not-a-token', 'not-pons', 'no-launch', 'bad-input'].includes(err.code);

// ---- DOM -------------------------------------------------------------------------------------------------
const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
};

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style') { for (const [p, x] of Object.entries(v)) el.style.setProperty(p, x); }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false && kid !== '') el.append(kid);
  return el;
}
const ext = (href, props, ...kids) => (href
  ? h('a', { href, target: '_blank', rel: 'noopener noreferrer', ...props }, ...kids)
  : h('span', props, ...kids));
const proofLink = (url, W, label = W.proof) => (url ? ext(url, { class: 'cc-proof', 'aria-label': label + ' (opens in a new tab)' }, label + ' ↗') : null);

function swap(el, node) {
  el.textContent = '';
  if (node) el.append(node);
}

function head(title, query) {
  return h('header', { class: 'cc-head' },
    h('h2', { class: 'cc-title', text: title }),
    query ? h('p', { class: 'cc-query', text: query }) : null);
}

function card(state, ...kids) {
  const el = h('article', { class: 'bts-card cc-card rc-card', 'data-state': state }, ...kids);
  if (!reducedMotion()) el.classList.add('is-entering');
  return el;
}

function block(key, title, ...kids) {
  return h('section', { class: 'rc-block rc-' + key, 'aria-label': title },
    h('h3', { class: 'rc-block-title', text: title }), ...kids);
}

function progressBar(p) {
  const v = p == null ? null : Math.round(progressOf(p) * 100);
  return h('div', { class: 'rc-progress', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': v == null ? null : String(v) },
    h('span', { class: 'rc-progress-fill', style: { width: (v == null ? 6 : Math.max(6, v)) + '%' } }));
}

export function renderReportLoading(el, settings = SETTINGS, progress = null, { query = null } = {}) {
  if (!el) return null;
  const W = words(settings);
  const old = el.firstElementChild;
  // Polling: update the same card in place (no fade, no jump) while it builds.
  if (old && old.classList && old.classList.contains('rc-card') && old.getAttribute('data-state') === 'loading') {
    const line = old.querySelector('.rc-building');
    if (line) line.textContent = progress == null ? W.checking : fill(W.building, { pct: Math.round(progressOf(progress) * 100) + '%' });
    const bar = old.querySelector('.rc-progress');
    if (bar) bar.replaceWith(progressBar(progress));
    return old;
  }
  const c = card('loading', head(W.title, query),
    h('p', { class: 'bts-progress cc-progress rc-building', text: progress == null ? W.checking : fill(W.building, { pct: Math.round(progressOf(progress) * 100) + '%' }) }),
    progressBar(progress));
  c.setAttribute('aria-busy', 'true');
  swap(el, c);
  return c;
}

// One grey line (with "Try again" when it's worth asking again).
function line(el, words, { code = '', state = 'unavailable', onRetry = null, retryText = 'Try again' } = {}) {
  const p = h('p', { class: 'cc-line rc-line', 'data-state': state, 'data-code': code || null }, h('span', { text: words }),
    onRetry ? [' ', h('button', { type: 'button', class: 'cc-tool rc-retry', onclick: onRetry, text: retryText })] : null);
  swap(el, p);
  return p;
}

function factEl(f) {
  return h('div', { class: 'cc-fact', 'data-key': f.key },
    h('dt', { text: f.label }),
    h('dd', null, ext(f.url, { class: f.url ? 'cc-link' : 'cc-unknown', title: f.title || null }, f.text)));
}

function devEl(d, W) {
  return block('dev', d.title,
    h('dl', { class: 'cc-facts rc-facts' }, d.facts.map(factEl)),
    h('ol', { class: 'rc-steps' }, d.steps.map((s) => h('li', {
      class: 'rc-step is-' + s.kind + (s.after ? ' is-after' : '') + (s.warn ? ' is-warn' : '') + (s.neutral ? ' is-neutral' : ''),
    },
    h('span', { class: 'rc-step-rel', text: s.rel }),
    h('span', { class: 'rc-step-node', 'aria-hidden': 'true' }),
    h('span', { class: 'rc-step-body' },
      h('span', { class: 'rc-step-text' }, ext(s.url, { class: 'cc-link rc-step-link' }, s.text)),
      s.after ? h('span', { class: 'cc-tag rc-after', text: W.afterGraduation }) : null,
      s.when || s.rel ? h('span', { class: 'rc-step-when' }, s.when, s.rel ? h('span', { class: 'rc-step-rel-in', text: (s.when ? ' · ' : '') + s.rel }) : null) : null)))),
    d.more ? h('p', { class: 'rc-more' }, ext(d.moreUrl, { class: 'cc-link' }, d.more)) : null,
    d.note ? h('p', { class: 'rc-note', text: d.note }) : null);
}

function sniperRow(r, W) {
  return h('li', { class: 'rc-wallet is-' + r.status + (r.group ? ' in-group' : ''), 'data-address': r.address, 'data-group': r.group ? String(r.group) : null },
    h('span', { class: 'rc-wallet-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'rc-wallet-main' },
      ext(r.url, { class: 'rc-wallet-addr cc-link', title: r.address }, r.short),
      h('span', { class: 'rc-wallet-at', text: r.at })),
    h('span', { class: 'rc-wallet-pct', text: r.pct }),
    h('span', { class: 'rc-wallet-status' },
      h('span', { text: r.statusText }),
      r.sellUrl ? [' ', proofLink(r.sellUrl, W, W.sellProof)] : r.buyUrl ? [' ', proofLink(r.buyUrl, W, W.buyProof)] : null));
}

function sniperEl(s, W) {
  if (!s.rows.length) return block('snipers', s.title, h('p', { class: 'rc-lead', text: s.none }));
  const g = Math.max(0, Math.min(1, s.bar.gone)), k = Math.max(0, Math.min(1, s.bar.held));
  const head = s.rows.slice(0, s.shown), rest = s.rows.slice(s.shown);
  return block('snipers', s.title,
    h('p', { class: 'rc-lead', text: s.lead }),
    h('div', { class: 'rc-supply', role: 'img', 'aria-label': s.legend.map((l) => l.label + ' ' + l.value).join(', ') },
      g > 0 ? h('span', { class: 'rc-seg rc-seg-gone', style: { width: (g * 100).toFixed(3) + '%' } }) : null,
      k > 0 ? h('span', { class: 'rc-seg rc-seg-held', style: { width: (k * 100).toFixed(3) + '%' } }) : null),
    h('ul', { class: 'rc-legend' }, s.legend.map((l) => h('li', { class: 'rc-key is-' + l.key },
      h('i', { class: 'rc-key-dot', 'aria-hidden': 'true' }), h('span', { text: l.label }), ' ', h('b', { text: l.value })))),
    h('ol', { class: 'rc-wallets' }, head.map((r) => sniperRow(r, W))),
    rest.length ? h('details', { class: 'rc-fold' },
      h('summary', { text: fill(W.showMore, { count: rest.length }) }),
      h('ol', { class: 'rc-wallets' }, rest.map((r) => sniperRow(r, W)))) : null,
    s.clusters ? h('p', { class: 'rc-note', text: s.clusters }) : null);
}

function activityEl(a, W) {
  return block('activity', a.title,
    h('p', { class: 'rc-grad' + (a.graduation.done ? ' is-done' : '') }, ext(a.graduation.url, { class: 'cc-link' }, a.graduation.text)),
    a.hours.length ? h('div', { class: 'rc-hours-wrap' },
      h('p', { class: 'rc-hours-label' }, h('span', { text: a.label }), a.total ? h('span', { class: 'rc-hours-total', text: a.total }) : null),
      h('ol', { class: 'rc-hours', 'aria-label': a.label },
        a.hours.map((x) => h('li', { class: 'rc-hour', title: x.title, 'aria-label': x.title },
          h('span', { class: 'rc-hour-bar', style: { height: (x.height * 100).toFixed(2) + '%' } },
            h('span', { class: 'rc-hour-new', style: { height: (x.inner * 100).toFixed(2) + '%' } }))))),
      h('p', { class: 'rc-hours-ends' }, a.ends.map((e) => h('span', { text: e }))),
      h('ul', { class: 'rc-legend rc-legend-grey' },
        h('li', { class: 'rc-key is-buys' }, h('i', { class: 'rc-key-dot', 'aria-hidden': 'true' }), h('span', { text: W.buysWord })),
        h('li', { class: 'rc-key is-new' }, h('i', { class: 'rc-key-dot', 'aria-hidden': 'true' }), h('span', { text: W.newWallets })))) : null,
    h('p', { class: 'rc-note' }, h('span', { text: a.note }), a.proof ? [' ', proofLink(a.proof, W)] : null));
}

// The links area inside a drawn report card: checking / unavailable (+ Try again) / done.
export function renderLinks(cardEl, links, report, settings = SETTINGS, { onRetry = null, timeZone } = {}) {
  if (!cardEl || !cardEl.querySelector) return null;
  const slot = cardEl.querySelector('.rc-links-body');
  if (!slot) return null;
  const v = linksView(links, report, settings, { timeZone });
  const W = words(settings);
  const box = cardEl.querySelector('.rc-links');
  if (box) box.setAttribute('data-state', v.state);
  if (v.state === 'checking') {
    swap(slot, h('p', { class: 'bts-progress cc-progress rc-links-checking', text: v.text }));
    return v;
  }
  if (v.state === 'unavailable') {
    swap(slot, h('p', { class: 'rc-links-unavailable' }, h('span', { text: v.text }), ' ',
      onRetry ? h('button', { type: 'button', class: 'cc-tool rc-retry', onclick: onRetry, text: v.retry }) : null));
    return v;
  }
  const verdict = cardEl.querySelector('.rc-verdict');
  if (verdict && v.verdict && verdict.textContent !== v.verdict) verdict.textContent = v.verdict;
  swap(slot, h('div', { class: 'rc-links-done' },
    h('p', { class: 'rc-funder' }, ext(v.devFunder.url, { class: v.devFunder.url ? 'cc-link' : null }, v.devFunder.text)),
    v.items.length ? h('ul', { class: 'cc-flags rc-link-list' }, v.items.map((l) => h('li', { class: 'cc-flag ' + (l.weak ? 'is-info' : 'is-warn') },
      h('span', { class: 'cc-dot', 'aria-hidden': 'true' }),
      h('span', { class: 'cc-flag-body' },
        h('b', { class: 'cc-flag-label', text: l.tag }), ' ',
        h('span', { class: 'cc-flag-text', text: l.text }), ' ',
        h('span', { class: 'rc-link-wallets' }, l.wallets.map((w, i) => [i ? ', ' : '', ext(w.url, { class: 'cc-link' }, w.short), w.dev ? ' (' + W.devTag + ')' : ''])),
        l.proofs.map((u, i) => [' ', ext(u, { class: 'cc-proof', 'aria-label': W.proof + ' ' + (i + 1) + ' (opens in a new tab)' }, i === 0 ? W.proof + ' ↗' : String(i + 1))]))))) : null,
    v.none ? h('p', { class: 'rc-links-none', text: v.none }) : null,
    v.ignored.length ? h('details', { class: 'rc-fold rc-ignored' },
      h('summary', { text: v.ignoredTitle }),
      h('ul', { class: 'rc-ignored-list' }, v.ignored.map((g) => h('li', null, ext(g.url, { class: 'cc-link' }, g.short), ' ', h('span', { text: g.why }))))) : null,
    v.caveat && !saidBelow(cardEl, v.caveat) ? h('p', { class: 'rc-note', text: v.caveat }) : null));
  return v;
}

// The links' caveat is usually already in the report's own caveat list at the foot of the card: say it once.
function saidBelow(cardEl, caveat) {
  const list = cardEl && cardEl.querySelector ? cardEl.querySelector('.cc-caveats') : null;
  if (!list) return false;
  return Array.from(list.querySelectorAll('li')).some((li) => li.textContent === caveat);
}

export function renderReport(el, res, settings = SETTINGS, { onRetry = null, timeZone } = {}) {
  if (!el) return null;
  const W = words(settings);
  if (!res || res.ok !== true) {
    const p = line(el, errorText(res, settings), {
      code: res && res.code, state: res ? 'error' : 'unavailable', onRetry: retryable(res) ? onRetry : null, retryText: W.tryAgain,
    });
    return p;
  }
  const v = reportView(res, settings, { timeZone });
  const c = card('result',
    head(v.title, v.query),
    v.official ? h('div', { class: 'cc-official rc-official' }, h('span', { class: 'cc-badge', text: v.official.label }),
      ext(v.tokenUrl, { class: 'cc-tool', 'aria-label': W.explorer + ' (opens in a new tab)' }, W.explorer, h('span', { 'aria-hidden': 'true', text: ' ↗' }))) : null,
    h('p', { class: 'cc-verdict rc-verdict', text: v.verdict }),
    h('p', { class: 'cc-share-row' }, ext(reportShare(res, settings), { class: 'cc-tool cc-share', 'aria-label': 'Share to X (opens in a new tab)' }, 'Share to X', h('span', { 'aria-hidden': 'true', text: ' ↗' }))),
    h('div', { class: 'rc-grid' },
      devEl(v.dev, W),
      sniperEl(v.snipers, W),
      activityEl(v.activity, W),
      h('section', { class: 'rc-block rc-links', 'aria-label': W.linksTitle, 'aria-live': 'polite' },
        h('h3', { class: 'rc-block-title', text: W.linksTitle }),
        h('div', { class: 'rc-links-body' }))),
    h('footer', { class: 'cc-foot' },
      v.missing ? h('p', { class: 'cc-indexing rc-missing', text: v.missing }) : null,
      v.caveats.length ? h('ul', { class: 'cc-caveats' }, v.caveats.map((n) => h('li', { text: n }))) : null,
      v.how.items.length ? h('details', { class: 'cc-how' },
        h('summary', { text: v.how.title }),
        v.how.items.map((s) => h('p', { text: s }))) : null,
      v.asOf ? h('p', { class: 'cc-asof', text: v.asOf }) : null));
  swap(el, c);
  return c;
}

// ---- the whole flow ---------------------------------------------------------------------------------------
// The report first (polling while it builds), then, once it is on screen, the wallet links. Neither ever touches
// anything outside `el`. live(): false once a newer lookup has started (then nothing more is drawn).
export async function showReport(el, token, settings = SETTINGS, opts = {}) {
  const live = opts.live || (() => true);
  const query = isAddr(token) ? shortAddr(token) : null;
  renderReportLoading(el, settings, null, { query });
  const res = await loadReport(token, settings, { ...opts, live, onProgress: (p) => { if (live()) renderReportLoading(el, settings, p, { query }); } });
  if (res === undefined || !live()) return undefined;
  const again = () => showReport(el, token, settings, opts);
  const c = renderReport(el, res, settings, { onRetry: again, timeZone: opts.timeZone });
  if (res && res.ok === true && res.status === 'done' && c) {
    if (opts.onReport) opts.onReport(res);
    await showLinks(c, token, res, settings, { ...opts, live });
  }
  return res;
}

export async function showLinks(c, token, report, settings = SETTINGS, opts = {}) {
  const live = opts.live || (() => true);
  const still = () => live() && c.isConnected !== false;    // the card is still on the page
  renderLinks(c, 'checking', report, settings);
  const links = await loadLinks(token, settings, { ...opts, live: still, onProgress: () => {} });
  if (links === undefined || !still()) return undefined;
  const answer = links && links.ok === false ? null : links;      // 'still-building' etc. -> unavailable + retry
  renderLinks(c, answer, report, settings, { timeZone: opts.timeZone, onRetry: () => showLinks(c, token, report, settings, opts) });
  return answer;
}

// ---- Receipts: the official coin's dev wallet, live from the chain (settings.token.devWallet) -----------------
// The same chain reading as the launch report, showing only the dev block: the launch buy, every later move (sells,
// burns, sends, buys), fee claims and bridges, each linked to its transaction. Shown only when the wallet in
// settings is the wallet that launched the coin on the chain; otherwise one line says so and nothing else is shown.
const RECEIPTS_WORDS = {
  title: 'Receipts',
  intro: 'What the {ticker} dev wallet has done, read live from the chain. Every line links to its transaction.',
  checking: 'Reading the dev wallet from the chain…',
  mismatch: 'The dev wallet in our settings ({set}) isn\'t the wallet that launched {ticker} on the chain ({chain}), so no receipts are shown.',
  unavailable: 'Receipts unavailable right now.',
};
export function receiptsWords(settings = SETTINGS) {
  const custom = settings && settings.receipts && typeof settings.receipts === 'object' ? settings.receipts : {};
  const out = { ...RECEIPTS_WORDS };
  for (const k of Object.keys(out)) if (typeof custom[k] === 'string' && custom[k].trim()) out[k] = custom[k];
  return out;
}

export function receiptsView(res, devWallet, settings = SETTINGS, { timeZone } = {}) {
  const R = receiptsWords(settings);
  const ticker = text((settings.token && settings.token.ticker) || '$BLAME', 20) || '$BLAME';
  if (!res || res.ok !== true) return { state: 'error', text: res ? errorText(res, settings) : R.unavailable, retry: retryable(res) };
  const v = reportView(res, settings, { timeZone });
  const want = isAddr(devWallet) ? lower(devWallet) : null;
  if (!want || !v.dev.address || v.dev.address !== want) {
    return { state: 'mismatch', text: fill(R.mismatch, { ticker, set: want ? shortAddr(want) : '?', chain: v.dev.address ? shortAddr(v.dev.address) : '?' }) };
  }
  return { state: 'done', title: R.title, intro: fill(R.intro, { ticker }), query: v.query, dev: v.dev, asOf: v.asOf, words: v.words };
}

export async function showReceipts(el, token, devWallet, settings = SETTINGS, opts = {}) {
  if (!el) return undefined;
  const live = opts.live || (() => true);
  const R = receiptsWords(settings);
  const loading = card('loading', head(R.title, isAddr(token) ? shortAddr(token) : null),
    h('p', { class: 'bts-progress cc-progress rc-building', text: R.checking }));
  loading.setAttribute('aria-busy', 'true');
  swap(el, loading);
  const res = await loadReport(token, settings, { ...opts, live, onProgress: () => {} });
  if (res === undefined || !live()) return undefined;
  const v = receiptsView(res, devWallet, settings, { timeZone: opts.timeZone });
  if (v.state !== 'done') {
    line(el, v.text, { state: v.state, onRetry: v.retry ? () => showReceipts(el, token, devWallet, settings, opts) : null, retryText: words(settings).tryAgain });
    return v;
  }
  swap(el, card('result', head(v.title, v.query),
    h('p', { class: 'rc-receipts-intro', text: v.intro }),
    devEl(v.dev, v.words),
    v.asOf ? h('footer', { class: 'cc-foot' }, h('p', { class: 'cc-asof', text: v.asOf })) : null));
  return v;
}

