// Copy check ("Is this the real one?"): copyCheck({ query, db, fetch, settings, now }) -> CopyCheckResult | ErrorResult
//
//   query     a ticker ('OBSYN', '$obsyn') or a token address (0x + 40 hex)
//   db        the D1 binding with the launch index (api/schema.sql), or an index object
//             { findByToken(addr), findBySkeletons(keys, limit), state() } (tests use one)
//   fetch     optional fetch for RPC (through site/src/data/rpc.js) and Blockscout
//   settings  SETTINGS (uses .trust) or the trust block itself; thresholds + official list (rules.js defaults)
//   now       ms; only used to say how far behind the index is
//   gather    optional replacement for gatherFacts (tests)
//
// Steps: skeleton of the query -> index rows whose symbol or name skeleton is the query's (exact) or one step away
// (near: one character deleted or one look-alike swapped) -> the top `maxFacts` rows are read in full from the chain
// (graduated first, then the most money on the curve or pool, then newest; the pasted coin and the official coin
// always) -> rules.js adds flags and the verdict. Read-only; never stores anything about the visitor.
import { skeleton, nearKeys } from '../../site/src/trust/skeleton.js';
import { trustSettings, applyFlags, buildVerdict, buildNotes, CAVEATS, nameShown, symbolShown, oddChars, tokenUrl, addressUrl, txUrl } from '../../site/src/trust/rules.js';
import { gatherFacts, launchRowFromChain, tokenMeta, makeContext, normalizeRow, pairInfo, iso } from '../../site/src/trust/facts.js';
import { _setTransport } from '../../site/src/data/rpc.js';
import { batchLatest, ethCall, wordAt } from '../../site/src/data/chain.js';
import { SEL_GRADUATED, SEL_REAL_QUOTE } from '../../site/src/data/curve.js';
import { FACTORY_ADDRESSES, INDEX_FLOOR } from './env.js';

export const MAX_ROWS = 500;          // index rows read per query (spam names can have hundreds)
export const PRERANK_ROWS = 60;       // rows ranked by a cheap on-chain read before the full read
export const MAX_KEYS = 90;           // skeleton keys per query (D1 allows 100 bound values)
const FACT_LANES = 3;                 // coins read in full at the same time
const BEHIND_SECONDS = 600;           // index older than this -> a note

const COLS = 'token, factory, curve, creator, tx_from, pair_token, block, log_index, time, tx, name, symbol, sym_skel, name_skel';

// The D1 launch index (api/schema.sql) as an index object.
export function d1Index(db) {
  return {
    async findByToken(addr) {
      return (await db.prepare('SELECT ' + COLS + ' FROM launches WHERE token = ?1').bind(addr).first()) || null;
    },
    async findBySkeletons(keys, limit = MAX_ROWS) {
      if (!keys.length) return [];
      const ph = keys.map((_, i) => '?' + (i + 1)).join(', ');
      const sql = 'SELECT ' + COLS + ' FROM launches WHERE sym_skel IN (' + ph + ') OR name_skel IN (' + ph + ')'
        + ' ORDER BY block DESC LIMIT ' + Math.max(1, Math.floor(limit));
      const res = await db.prepare(sql).bind(...keys).all();
      return (res && res.results) || [];
    },
    async state() {
      const res = await db.prepare('SELECT key, value FROM meta').all();
      const m = {};
      for (const r of (res && res.results) || []) m[r.key] = Number(r.value);
      const ok = (v) => (Number.isFinite(v) ? v : null);
      // the first launch of the unbroken indexed range (a stray older row doesn't count), same as /v1/health
      const oldest = Number.isFinite(m.oldest_block)
        ? await db.prepare('SELECT block, time FROM launches WHERE block >= ?1 ORDER BY block ASC LIMIT 1').bind(m.oldest_block).first()
        : await db.prepare('SELECT block, time FROM launches ORDER BY block ASC LIMIT 1').first();
      return { lastBlock: ok(m.last_block), oldestBlock: ok(m.oldest_block), lastRun: ok(m.last_run), oldestTime: oldest ? ok(Number(oldest.time)) : null };
    },
  };
}
const asIndex = (db) => (!db ? null : typeof db.findBySkeletons === 'function' ? db : typeof db.prepare === 'function' ? d1Index(db) : null);

const fail = (code, message) => ({ ok: false, code, message });

// The RPC transport is module state in rpc.js: point it at this request's fetch every time (another caller,
// a test, may have swapped it since the last copy check).
function useFetch(f) {
  if (f) _setTransport({ fetch: f });
}

// Runs fn over items, at most `lanes` at a time, keeping the order.
async function pool(items, lanes, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, worker));
  return out;
}

// A cheap ranking read for many rows: graduated() and realQuoteReserve() on each curve (one batch).
async function prerank(rows, ctx) {
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

export async function copyCheck({ query, db, fetch: fetchFn = null, settings = null, now = Date.now(), gather = gatherFacts, sleep } = {}) {
  const input = String(query == null ? '' : query).trim();
  if (!input) return fail('bad-input', 'Paste a ticker or a coin address.');
  if (input.length > 100) return fail('bad-input', 'That\'s too long for a ticker or an address.');
  const isAddr = /^0x[0-9a-fA-F]{40}$/.test(input);
  if (/^0x[0-9a-fA-F]*$/.test(input) && !isAddr && input.length > 6) return fail('bad-input', 'That address isn\'t complete: it should be 0x and 40 characters.');
  const t = trustSettings(settings);
  const index = asIndex(db);
  if (!index) return fail('index-behind', 'The launch index isn\'t ready yet. Try again in a few minutes.');
  let state;
  try { state = await index.state(); } catch (e) { state = null; }
  if (!state || state.lastBlock == null) return fail('index-behind', 'The launch index is still being built. Try again in a few minutes.');

  useFetch(fetchFn);
  let ctx;
  try {
    ctx = await makeContext({ fetch: fetchFn, sleep, settings: t, factories: FACTORY_ADDRESSES });
  } catch (e) { return fail('rpc-failed', 'Robinhood Chain didn\'t answer. Try again in a moment.'); }

  try {
    return await run({ input, isAddr, index, state, ctx, t, now, gather });
  } catch (e) {
    return fail('rpc-failed', 'Robinhood Chain didn\'t answer. Try again in a moment.');
  }
}

async function run({ input, isAddr, index, state, ctx, t, now, gather }) {
  const notes = [];
  const q = { input, kind: isAddr ? 'address' : 'ticker', skeleton: '' };
  let queryRow = null, nameSkel = '';
  if (isAddr) {
    const addr = input.toLowerCase();
    q.address = addr;
    queryRow = await index.findByToken(addr);
    if (!queryRow) {
      try { queryRow = await launchRowFromChain(addr, ctx); } catch (e) { queryRow = null; }
      if (queryRow) notes.push('This coin isn\'t in our launch index yet, so its launch was read straight from the chain.');
    }
    let name = queryRow ? queryRow.name : null, symbol = queryRow ? queryRow.symbol : null;
    if (name == null || symbol == null) {
      const meta = await tokenMeta(addr);
      if (name == null) name = meta.name;
      if (symbol == null) symbol = meta.symbol;
    }
    if (!queryRow && !name && !symbol) return fail('not-found', 'We couldn\'t find a coin at this address on Robinhood Chain.');
    q.name = name || '';
    q.symbol = symbol || '';
    q.isPons = !!queryRow;
    q.skeleton = skeleton(q.symbol) || skeleton(q.name);
    nameSkel = skeleton(q.name);
  } else {
    q.skeleton = skeleton(input);
    if (!q.skeleton) return fail('bad-input', 'That ticker has no letters or numbers to search for.');
  }

  // keys: exact = the symbol skeleton (and the name skeleton for an address); near = one step away
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
    return { raw: r, n, match: exactKeys.includes(sym) || exactKeys.includes(nm) ? 'exact' : 'near',
      isQuery: n.token === q.address, isOfficial: !!official && n.token === official.address };
  });

  // pick the rows to read in full
  const must = rows.filter((x) => x.isQuery || x.isOfficial);
  let rest = rows.filter((x) => !x.isQuery && !x.isOfficial)
    .sort((a, b) => (a.match === b.match ? 0 : a.match === 'exact' ? -1 : 1) || b.n.block - a.n.block);
  const room = Math.max(0, t.maxFacts - must.length);
  if (rest.length > room) {
    const head = rest.slice(0, PRERANK_ROWS);
    const scores = await prerank(head.map((x) => x.n), ctx);
    head.forEach((x, i) => { x.score = scores[i]; });
    head.sort((a, b) => (a.match === b.match ? 0 : a.match === 'exact' ? -1 : 1) || b.score - a.score || b.n.block - a.n.block);
    rest = head.concat(rest.slice(PRERANK_ROWS));
  }
  const chosen = must.concat(rest.slice(0, room));
  const totalCount = rows.length;

  const facts = await pool(chosen, FACT_LANES, async (x) => {
    try { return await gather(x.raw, ctx); } catch (e) { return null; }
  });
  const matches = chosen.map((x, i) => toMatch(x, facts[i]));
  applyFlags(matches, { official, settings: t });
  matches.sort((a, b) => (a.launch.block || 0) - (b.launch.block || 0));

  const behind = state.lastRun != null && now / 1000 - state.lastRun > BEHIND_SECONDS;
  if (behind || (state.lastBlock != null && ctx.head.number - state.lastBlock > Math.round(BEHIND_SECONDS / 0.1045))) {
    notes.push('The launch index is catching up: launches after block ' + state.lastBlock + ' aren\'t searched yet.');
  }
  if (q.kind === 'address' && !q.isPons) notes.push('This coin wasn\'t launched on Pons, so it isn\'t in the list itself. Pons coins with the same name are below.');
  if (capped) notes.push('This name is very common: only the newest ' + MAX_ROWS + ' launches were searched.');
  const problems = [...ctx.problems];
  if (matches.some((m) => m.holders && m.holders.source === 'transfers')) problems.push('The explorer was unavailable, so holders were counted from the chain\'s transfer records.');
  if (matches.some((m) => m.missing.length)) problems.push('Some facts couldn\'t be read right now and are left blank; no flag is raised on a blank.');

  return {
    ok: true,
    query: q,
    asOf: iso(ctx.head.time),
    indexedFrom: state.oldestTime != null ? iso(state.oldestTime) : null,
    indexComplete: state.oldestBlock != null && state.oldestBlock <= INDEX_FLOOR,
    official: official ? { symbol: official.symbol, address: official.address } : null,
    matches,
    verdict: buildVerdict({ query: q, matches, official, totals: {
      exact: rows.filter((x) => x.match === 'exact').length, near: rows.filter((x) => x.match === 'near').length } }),
    notes: notes.concat(buildNotes({
      shownCount: matches.length, totalCount, indexComplete: state.oldestBlock != null && state.oldestBlock <= INDEX_FLOOR,
      indexedFrom: state.oldestTime != null ? iso(state.oldestTime) : null, problems,
    })),
    caveats: CAVEATS.slice(),
  };
}

// facts (or null when the read failed) + the row -> one match in the contract's shape.
function toMatch(x, f) {
  const n = x.n;
  const base = f || {
    address: n.token, name: n.name, symbol: n.symbol, factory: n.factory, curve: n.curve,
    launch: { tx: n.tx, block: n.block, time: iso(n.time) }, creator: null, devBuy: null, devSold: null, fees: null,
    bridges: null, holders: null, liquidity: null, graduated: null, snipers: null, tradesRecent: null,
    missing: ['creator', 'devBuy', 'devSold', 'fees', 'bridges', 'holders', 'liquidity', 'graduated', 'snipers'],
    proof: { token: tokenUrl(n.token), creator: null, launchTx: txUrl(n.tx), curve: addressUrl(n.curve) },
  };
  return {
    address: base.address,
    name: base.name,
    symbol: base.symbol,
    nameShown: nameShown(base.name),
    symbolShown: symbolShown(base.symbol),
    oddChars: oddChars(base.name, base.symbol),
    match: x.match,
    isQuery: x.isQuery,
    isOfficial: x.isOfficial,
    isPons: true,
    factory: base.factory,
    curve: base.curve,
    launch: base.launch,
    creator: base.creator,
    devBuy: base.devBuy,
    devSold: base.devSold,
    fees: base.fees,
    bridges: base.bridges,
    holders: base.holders,
    liquidity: base.liquidity,
    graduated: base.graduated,
    snipers: base.snipers,
    tradesRecent: base.tradesRecent,
    missing: base.missing,
    flags: [],
    proof: base.proof,
  };
}

