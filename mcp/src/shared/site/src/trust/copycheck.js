// Copy check ("Is this the real one?") in two halves, so the chain is read where it can be read:
//
//   1. listMatches(...)    the launch index only (no chain): every Pons launch whose name or symbol skeleton is the
//                          query's (exact) or one step away (near). The API Worker answers GET /v1/copies with it
//                          (api/src/copies.js copyMatches); the official RPC refuses Cloudflare's network, so the
//                          Worker reads nothing from the chain.
//   2. completeCopies(...) the chain facts of the most relevant matches, read where the visitor is (the browser,
//                          or the local MCP package), a couple of coins at a time, then the flags and the verdict.
//
//   runCopyCheck(query, { api, fetch, settings, onProgress, live })  the browser flow: the Worker's list, then 2.
//   copyCheck({ query, db, fetch, settings, now, gather, sleep })    both halves in one go over an index object
//                                                                    (tests, and anything with its own index)
//
// Read-only; nothing about the visitor is read or kept.
import { skeleton, nearKeys } from './skeleton.js';
import { trustSettings, applyFlags, buildVerdict, buildNotes, CAVEATS, nameShown, symbolShown, oddChars, tokenUrl, addressUrl, txUrl } from './rules.js';
import { gatherFacts, launchRowFromChain, tokenMeta, makeContext, normalizeRow, pairInfo, iso } from './facts.js';
import { batchLatest, ethCall, wordAt } from '../data/chain.js';
import { _setTransport } from '../data/rpc.js';
import { SEL_GRADUATED, SEL_REAL_QUOTE } from '../data/curve.js';
import { FACTORY_ADDRESSES, INDEX_FLOOR } from './factories.js';

export const MAX_ROWS = 500;          // index rows read per query (spam names can have hundreds)
export const PRERANK_ROWS = 60;       // rows ranked by a cheap on-chain read before the full read (also: rows listed)
export const MAX_KEYS = 90;           // skeleton keys per query (D1 allows 100 bound values)
export const FACT_LANES = 2;          // coins read in full at the same time (polite to the public nodes)
export const BEHIND_SECONDS = 600;    // index older than this -> a note
const BLOCK_SECONDS = 0.1045;
export const FACT_KEYS = ['creator', 'devBuy', 'devSold', 'fees', 'bridges', 'holders', 'liquidity', 'graduated', 'snipers'];
export const FACTS_NOTE = 'Chain facts (dev buy and sells, fees, bridges, holders, liquidity, graduation) and the flags are read '
  + 'from Robinhood Chain by the website in your browser, or by the local MCP package (npx blamethestock-mcp). '
  + 'This list comes from our launch index.';
export const NOT_IN_INDEX_NOTE = 'This coin isn\'t in our launch index yet, so its launch was read straight from the chain.';
export const NOT_PONS_NOTE = 'This coin wasn\'t launched on Pons, so it isn\'t in the list itself. Pons coins with the same name are below.';

const fail = (code, message) => ({ ok: false, code, message });
const RPC_FAILED = () => fail('rpc-failed', 'Robinhood Chain didn\'t answer. Try again in a moment.');
const isAddr = (s) => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);
const secsOf = (s) => { const t = Date.parse(s); return Number.isFinite(t) ? t / 1000 : null; };

// Runs fn over items, at most `lanes` at a time, keeping the order.
export async function pool(items, lanes, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, items.length)) }, worker));
  return out;
}

// The query -> { input, isAddr } or an error.
export function checkQuery(query) {
  const input = String(query == null ? '' : query).trim();
  if (!input) return fail('bad-input', 'Paste a ticker or a coin address.');
  if (input.length > 100) return fail('bad-input', 'That\'s too long for a ticker or an address.');
  const addr = isAddr(input);
  if (/^0x[0-9a-fA-F]*$/.test(input) && !addr && input.length > 6) return fail('bad-input', 'That address isn\'t complete: it should be 0x and 40 characters.');
  return { ok: true, input, isAddr: addr };
}

// ---- 1. the launch index ----------------------------------------------------------------------------------
// index: { findByToken(addr), findBySkeletons(keys, limit), state() } (D1 or a fixture).
// hint: { name, symbol } for an address the index doesn't have (read from the chain by the caller), so the
// same-name launches can still be listed. queryRow: that coin's launch row when the caller read it from the chain.
// -> listing (the CopyCheckResult shape with every chain fact left out: facts: 'pending') | ErrorResult
export async function listMatches({ query, index, settings = null, now = Date.now(), hint = null, queryRow: chainRow = null }) {
  const c = checkQuery(query);
  if (!c.ok) return c;
  const t = trustSettings(settings);
  if (!index) return fail('index-behind', 'The launch index isn\'t ready yet. Try again in a few minutes.');
  let state;
  try { state = await index.state(); } catch (e) { state = null; }
  if (!state || state.lastBlock == null) return fail('index-behind', 'The launch index is still being built. Try again in a few minutes.');

  const notes = [];
  const q = { input: c.input, kind: c.isAddr ? 'address' : 'ticker', skeleton: '' };
  let queryRow = null, nameSkel = '';
  if (c.isAddr) {
    const addr = c.input.toLowerCase();
    q.address = addr;
    queryRow = await index.findByToken(addr);
    q.inIndex = !!queryRow;
    if (!queryRow && chainRow) { queryRow = chainRow; notes.push(NOT_IN_INDEX_NOTE); }
    const hn = hint && typeof hint.name === 'string' ? hint.name.slice(0, 200) : null;
    const hs = hint && typeof hint.symbol === 'string' ? hint.symbol.slice(0, 200) : null;
    q.name = (queryRow && queryRow.name != null ? queryRow.name : hn) || '';
    q.symbol = (queryRow && queryRow.symbol != null ? queryRow.symbol : hs) || '';
    // Pons? Known when the index (or the chain) has its launch; unknown while nobody has read the chain.
    q.isPons = queryRow ? true : (hint ? false : null);
    q.skeleton = skeleton(q.symbol) || skeleton(q.name);
    nameSkel = skeleton(q.name);
  } else {
    q.skeleton = skeleton(c.input);
    if (!q.skeleton) return fail('bad-input', 'That ticker has no letters or numbers to search for.');
  }

  const exactKeys = [...new Set([q.skeleton, nameSkel].filter(Boolean))];
  const near = [...new Set(exactKeys.flatMap((k) => nearKeys(k)))].filter((k) => !exactKeys.includes(k));
  const keys = exactKeys.concat(near).slice(0, MAX_KEYS);
  const official = t.official.find((o) => o.address === q.address || exactKeys.includes(o.skeleton)) || null;

  let rows = q.skeleton ? await index.findBySkeletons(keys, MAX_ROWS) : [];
  const capped = rows.length >= MAX_ROWS;
  const seen = new Set(rows.map((r) => String(r.token).toLowerCase()));
  if (queryRow && !seen.has(q.address)) { rows.unshift(queryRow); seen.add(q.address); }
  if (official && !seen.has(official.address)) {
    const o = await index.findByToken(official.address);
    if (o) { rows.push(o); seen.add(official.address); }
  }
  rows = rows.map((r) => {
    const n = normalizeRow(r);
    const sym = n.symSkel != null ? n.symSkel : skeleton(n.symbol), nm = n.nameSkel != null ? n.nameSkel : skeleton(n.name);
    return { n, match: exactKeys.includes(sym) || exactKeys.includes(nm) ? 'exact' : 'near',
      isQuery: n.token === q.address, isOfficial: !!official && n.token === official.address };
  });
  // most relevant first: the pasted and the official coin, then exact before near, then newest
  const must = rows.filter((x) => x.isQuery || x.isOfficial);
  const rest = rows.filter((x) => !x.isQuery && !x.isOfficial)
    .sort((a, b) => (a.match === b.match ? 0 : a.match === 'exact' ? -1 : 1) || b.n.block - a.n.block);
  const listed = must.concat(rest.slice(0, PRERANK_ROWS));
  const totals = { exact: rows.filter((x) => x.match === 'exact').length, near: rows.filter((x) => x.match === 'near').length, total: rows.length, listed: listed.length };

  const nowS = now / 1000;
  const lastBlockTime = Number.isFinite(state.lastBlockTime) ? state.lastBlockTime : null;
  if ((state.lastRun != null && nowS - state.lastRun > BEHIND_SECONDS) || (lastBlockTime != null && nowS - lastBlockTime > BEHIND_SECONDS)) {
    notes.push(behindNote(state.lastBlock));
  }
  if (capped) notes.push('This name is very common: only the newest ' + MAX_ROWS + ' launches were searched.');
  const indexComplete = state.oldestBlock != null && state.oldestBlock <= INDEX_FLOOR;
  const indexedFrom = state.oldestTime != null ? iso(state.oldestTime) : null;
  const matches = listed.map((x) => pendingMatch(x));
  return {
    ok: true,
    status: 'done',
    facts: 'pending',
    query: q,
    asOf: null,
    indexAsOf: state.lastRun != null ? iso(state.lastRun) : null,
    index: { lastBlock: state.lastBlock, lastRun: state.lastRun != null ? state.lastRun : null },
    indexedFrom,
    indexComplete,
    official: official ? { symbol: official.symbol, address: official.address } : null,
    matches,
    totals,
    capped,
    verdict: buildVerdict({ query: q, matches, official, totals }),
    notes,
    caveats: CAVEATS.slice(),
  };
}
const behindNote = (lastBlock) => 'The launch index is catching up: launches after block ' + lastBlock + ' aren\'t searched yet.';

// An index row -> a match with its launch facts and every chain fact still to read.
function pendingMatch(x) {
  const n = x.n;
  return {
    address: n.token,
    name: n.name,
    symbol: n.symbol,
    nameShown: nameShown(n.name),
    symbolShown: symbolShown(n.symbol),
    oddChars: oddChars(n.name, n.symbol),
    match: x.match,
    isQuery: x.isQuery,
    isOfficial: x.isOfficial,
    isPons: true,
    factory: n.factory,
    curve: n.curve,
    pairToken: n.pairToken,
    launch: { tx: n.tx, block: n.block, time: iso(n.time) },
    launchCreator: n.creator,           // the TokenLaunched creator (Multicall3 for some launches)
    txFrom: n.txFrom,                   // the launch transaction's sender, when the index has it
    creator: null,                      // the dev wallet: read from the launch transaction
    devBuy: null, devSold: null, fees: null, bridges: null, holders: null, liquidity: null, graduated: null, snipers: null,
    tradesRecent: null,
    missing: FACT_KEYS.slice(),
    pending: true,
    flags: [],
    proof: { token: tokenUrl(n.token), creator: null, launchTx: txUrl(n.tx), curve: addressUrl(n.curve) },
  };
}

// A listed match -> the launch row gatherFacts() reads.
export function rowOfMatch(m) {
  return {
    token: m.address, factory: m.factory, curve: m.curve, creator: m.launchCreator != null ? m.launchCreator : null,
    tx_from: m.txFrom != null ? m.txFrom : null, pair_token: m.pairToken, block: m.launch && m.launch.block,
    time: m.launch && m.launch.time ? secsOf(m.launch.time) : null, tx: m.launch && m.launch.tx, name: m.name, symbol: m.symbol,
  };
}

// An address the index didn't have, read from the chain: added to the listing as the pasted coin.
export function withChainRow(listing, row) {
  const n = normalizeRow(row);
  const q = { ...listing.query, isPons: true, name: listing.query.name || n.name, symbol: listing.query.symbol || n.symbol };
  if (listing.matches.some((m) => m.address === n.token)) return { ...listing, query: q };
  const m = pendingMatch({ n, match: 'exact', isQuery: true, isOfficial: !!listing.official && listing.official.address === n.token });
  const totals = { ...listing.totals, exact: listing.totals.exact + 1, total: listing.totals.total + 1, listed: listing.totals.listed + 1 };
  return { ...listing, query: q, matches: [m].concat(listing.matches), totals, notes: [NOT_IN_INDEX_NOTE].concat(listing.notes || []) };
}

// ---- 2. the chain facts -----------------------------------------------------------------------------------
// A cheap ranking read for many rows: graduated() and realQuoteReserve() on each curve (one batch).
export async function prerank(rows, ctx) {
  const calls = [];
  for (const r of rows) calls.push(ethCall(r.curve, SEL_GRADUATED), ethCall(r.curve, SEL_REAL_QUOTE));
  let res;
  try { res = await batchLatest(calls); } catch (e) { return rows.map(() => 0); }
  const scores = [];
  for (let i = 0; i < rows.length; i++) {
    const g = res[2 * i], q = res[2 * i + 1];
    if (g && g.result && wordAt(g.result, 0) !== 0n) { scores.push(1e15); continue; }
    let usd = 0;
    try {
      const p = await pairInfo(rows[i].pairToken, ctx);
      if (q && q.result && p.decimals != null && p.usd != null) usd = (Number(wordAt(q.result, 0)) / 10 ** p.decimals) * p.usd;
    } catch (e) { usd = 0; }
    scores.push(usd);
  }
  return scores;
}

// Which listed matches are read in full (the pasted and the official coin always, then up to maxFacts in all:
// graduated first, then the most money on the curve or pool, then newest), in the order they are read.
export async function chooseMatches(listing, ctx, t) {
  const xs = listing.matches.map((m) => ({ m, n: normalizeRow(rowOfMatch(m)) }));
  const must = xs.filter((x) => x.m.isQuery || x.m.isOfficial);
  let rest = xs.filter((x) => !x.m.isQuery && !x.m.isOfficial);
  const room = Math.max(0, t.maxFacts - must.length);
  if (rest.length > room) {
    const head = rest.slice(0, PRERANK_ROWS);
    const scores = await prerank(head.map((x) => x.n), ctx);
    head.forEach((x, i) => { x.score = scores[i]; });
    head.sort((a, b) => (a.m.match === b.m.match ? 0 : a.m.match === 'exact' ? -1 : 1) || b.score - a.score || b.n.block - a.n.block);
    rest = head.concat(rest.slice(PRERANK_ROWS));
  }
  return must.concat(rest.slice(0, room)).map((x) => x.m);
}

// One listed match + its facts (null when the read failed) -> the CopyCheckResult match.
export function factsMatch(m, f) {
  const base = f || {
    creator: null, devBuy: null, devSold: null, fees: null, bridges: null, holders: null, liquidity: null, graduated: null,
    snipers: null, tradesRecent: null, missing: FACT_KEYS.slice(), launch: m.launch,
    proof: { token: tokenUrl(m.address), creator: null, launchTx: txUrl(m.launch.tx), curve: addressUrl(m.curve) },
  };
  return {
    address: m.address, name: m.name, symbol: m.symbol, nameShown: m.nameShown, symbolShown: m.symbolShown, oddChars: m.oddChars,
    match: m.match, isQuery: m.isQuery, isOfficial: m.isOfficial, isPons: true, factory: m.factory, curve: m.curve,
    pairToken: m.pairToken,
    launch: base.launch || m.launch,
    creator: base.creator, devBuy: base.devBuy, devSold: base.devSold, fees: base.fees, bridges: base.bridges,
    holders: base.holders, liquidity: base.liquidity, graduated: base.graduated, snipers: base.snipers,
    tradesRecent: base.tradesRecent, missing: base.missing, flags: [], proof: base.proof,
    ...(base.pool ? { pool: base.pool } : {}),
  };
}

// listing (from listMatches, possibly through the API) -> CopyCheckResult.
//   ctx         makeContext(...) (the head block, explorer client, memos)
//   lanes       coins read at the same time (default 2)
//   onProgress  called with a partial result (status 'reading', reading: { done, total }) before the first read
//               and after each coin, rows in the order they will be shown; read rows have their facts
//   live        () => false stops early (a newer lookup took over): returns undefined
export async function completeCopies(listing, { ctx, settings = null, gather = gatherFacts, lanes = FACT_LANES, onProgress = null, live = () => true } = {}) {
  const t = trustSettings(settings);
  const official = listing.official ? t.official.find((o) => o.address === listing.official.address) || { ...listing.official, skeleton: skeleton(listing.official.symbol) } : null;
  const chosen = await chooseMatches(listing, ctx, t);
  if (!live()) return undefined;
  const done = new Array(chosen.length).fill(null);
  let count = 0;
  const partial = () => {
    const matches = chosen.map((m, i) => (done[i] ? done[i] : { ...m })).sort(byBlock);
    return { ...listing, status: 'reading', facts: 'reading', asOf: iso(ctx.head.time), matches, reading: { done: count, total: chosen.length } };
  };
  if (onProgress) onProgress(partial());
  await pool(chosen, lanes, async (m, i) => {
    if (!live()) return;
    let f = null;
    try { f = await gather(rowOfMatch(m), ctx); } catch (e) { f = null; }
    done[i] = factsMatch(m, f);
    count++;
    if (onProgress && live()) onProgress(partial());
  });
  if (!live()) return undefined;

  const matches = done.slice();
  applyFlags(matches, { official, settings: t });
  matches.sort(byBlock);
  const notes = (listing.notes || []).slice();
  const lastBlock = listing.index && listing.index.lastBlock;
  if (Number.isFinite(lastBlock) && ctx.head.number - lastBlock > Math.round(BEHIND_SECONDS / BLOCK_SECONDS) && !notes.some((n) => /catching up/.test(n))) {
    notes.push(behindNote(lastBlock));
  }
  const q = listing.query;
  if (q.kind === 'address' && !q.isPons) notes.push(NOT_PONS_NOTE);
  const problems = [...ctx.problems];
  if (matches.some((m) => m.holders && m.holders.source === 'transfers')) problems.push('The explorer was unavailable, so holders were counted from the chain\'s transfer records.');
  if (matches.some((m) => m.missing.length)) problems.push('Some facts couldn\'t be read right now and are left blank; no flag is raised on a blank.');
  const totals = listing.totals || { exact: matches.filter((m) => m.match === 'exact').length, near: matches.filter((m) => m.match === 'near').length, total: matches.length };
  const query = { ...q };
  delete query.inIndex;
  return {
    ok: true,
    status: 'done',
    query,
    asOf: iso(ctx.head.time),
    indexedFrom: listing.indexedFrom,
    indexComplete: listing.indexComplete,
    official: listing.official,
    matches,
    verdict: buildVerdict({ query, matches, official, totals: { exact: totals.exact, near: totals.near } }),
    notes: notes.concat(buildNotes({
      shownCount: matches.length, totalCount: totals.total, indexComplete: listing.indexComplete, indexedFrom: listing.indexedFrom, problems,
    })),
    caveats: CAVEATS.slice(),
  };
}
const byBlock = (a, b) => (a.launch.block || 0) - (b.launch.block || 0);

// An address the index doesn't have: its launch row (a Pons launch) and/or its name and symbol, from the chain.
// -> { row, name, symbol } | null (no coin there)
export async function readUnindexed(addr, ctx) {
  let row = null;
  try { row = await launchRowFromChain(addr, ctx); } catch (e) { row = null; }
  let name = row ? row.name : null, symbol = row ? row.symbol : null;
  if (name == null || symbol == null) {
    const meta = await tokenMeta(addr);
    if (name == null) name = meta.name;
    if (symbol == null) symbol = meta.symbol;
  }
  if (!row && !name && !symbol) return null;
  return { row, name: name || '', symbol: symbol || '' };
}

// ---- both halves --------------------------------------------------------------------------------------------
// The browser flow. api(query, hint) -> listing | ErrorResult | null (unreachable); hint = { name, symbol } for an
// address the index doesn't have. -> CopyCheckResult | ErrorResult | null | undefined (live() turned false)
export async function runCopyCheck(query, { api, fetch: fetchFn = null, settings = null, sleep, onProgress = null, live = () => true, lanes = FACT_LANES, gather = gatherFacts } = {}) {
  let listing = await api(query, null);
  if (!live()) return undefined;
  if (!listing || listing.ok !== true) return listing || null;
  let ctx;
  try {
    ctx = await makeContext({ fetch: fetchFn, sleep, settings, factories: FACTORY_ADDRESSES });
  } catch (e) { return RPC_FAILED(); }
  if (!live()) return undefined;
  try {
    if (listing.query && listing.query.kind === 'address' && listing.query.inIndex === false) {
      const got = await readUnindexed(listing.query.address, ctx);
      if (!got) return fail('not-found', 'We couldn\'t find a coin at this address on Robinhood Chain.');
      const again = await api(query, { name: got.name, symbol: got.symbol });
      if (!live()) return undefined;
      if (!again || again.ok !== true) return again || null;
      listing = got.row ? withChainRow(again, got.row) : again;
    }
    return await completeCopies(listing, { ctx, settings, gather, lanes, onProgress, live });
  } catch (e) {
    return RPC_FAILED();
  }
}

// Both halves over one index object (D1 or a fixture), reading the chain from here.
export async function copyCheck({ query, db, index = null, fetch: fetchFn = null, settings = null, now = Date.now(), gather = gatherFacts, sleep, lanes = 3, onProgress = null } = {}) {
  const idx = index || db;
  // rpc.js keeps one transport for everything on the page/isolate: point it at this caller's fetch (tests replay
  // recorded answers through it). The browser flow (runCopyCheck) leaves the page's transport alone.
  if (fetchFn) _setTransport({ fetch: fetchFn });
  const c = checkQuery(query);
  if (!c.ok) return c;
  if (!idx) return fail('index-behind', 'The launch index isn\'t ready yet. Try again in a few minutes.');
  const api = (q, hint) => listMatches({ query: q, index: idx, settings, now, hint });
  const first = await api(query, null);
  if (!first || first.ok !== true) return first;
  return runCopyCheck(query, { api: async (q, hint) => (hint ? api(q, hint) : first), fetch: fetchFn, settings, sleep, onProgress, lanes, gather });
}
