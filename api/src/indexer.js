// The launch indexer: reads TokenLaunched events from every Pons factory, adds what the event lacks
// (the real dev for Multicall3 launches, name()/symbol(), block time), and upserts one row per launch into D1.
//
//   runIndexer(env, { fromBlock?, maxBlocks?, maxRows?, head?, log?, logSpan?, maxLogRequests? }) -> summary
//
// Two ways to read the TokenLaunched logs:
//  - default (local tools, tests): the official node, long ranges (it allows 100k blocks for a list of addresses);
//  - logSpan set (the API Worker's cron): dRPC in pieces of at most logSpan blocks (its free plan allows 100 blocks
//    per eth_getLogs and 3 calls per batch), at most maxLogRequests HTTP requests per run. The official node is
//    only a last resort there: it answers HTTP 429 to every call from Cloudflare's network. A run that can't
//    read a piece stops at the last block it fully read, so the cursor never skips anything, and the next runs
//    catch up (about 575 new blocks a minute; a run reads up to logSpan x 3 x maxLogRequests blocks).
//
// env.DB is a D1 database (prepare/bind/all/first/run/batch). Chain reads go through the site's rpc.js
// (retries, 429 backoff, endpoint cooling); tests swap the network with rpc.js _setTransport and pass a fake DB.
// Read-only on the chain. Plain ES module: runs in Workers, browsers and jsc.
import { rpc, rpcBatch, byHealth, logOpts, RpcError } from '../../site/src/data/rpc.js';
import { blockTimes, headBlock, toHex, wordAt } from '../../site/src/data/chain.js';
import { skeleton } from '../../site/src/trust/skeleton.js';
import * as E from './env.js';

const FACTORY_SET = new Set(E.FACTORY_ADDRESSES);
const lower = (s) => String(s || '').toLowerCase();
const addrFromWord = (w) => '0x' + lower(w).replace(/^0x/, '').padStart(64, '0').slice(-40);

// ---- decoding ----------------------------------------------------------------------------------

// One TokenLaunched log -> launch fields, or null when it isn't one (wrong topic, unknown factory, removed).
export function decodeLaunchLog(log) {
  if (!log || log.removed === true) return null;
  const t = log.topics || [];
  if (t.length !== 4 || lower(t[0]) !== E.TOPIC_TOKEN_LAUNCHED) return null;
  const factory = lower(log.address);
  if (!FACTORY_SET.has(factory)) return null;
  const data = String(log.data || '');
  if (data.replace(/^0x/, '').length < 64 * 3) return null;
  return {
    token: addrFromWord(t[1]),
    factory,
    curve: addrFromWord(t[2]),
    creator: addrFromWord(t[3]),
    pair_token: addrFromWord('0x' + data.replace(/^0x/, '').slice(0, 64)),
    graduation_threshold: wordAt(data, 2).toString(),
    block: parseInt(log.blockNumber, 16),
    log_index: parseInt(log.logIndex, 16),
    tx: lower(log.transactionHash),
  };
}

// One factory graduation log -> { token, block, tx }, or null.
export function decodeGraduationLog(log) {
  if (!log || log.removed === true) return null;
  const t = log.topics || [];
  if (t.length < 2 || lower(t[0]) !== E.TOPIC_GRADUATED || !FACTORY_SET.has(lower(log.address))) return null;
  return { token: addrFromWord(t[1]), block: parseInt(log.blockNumber, 16), tx: lower(log.transactionHash) };
}
// The coin's name and skeletons come from its launch row (graduation always follows the launch, so it is indexed).
export const SQL_GRADUATION_ADD = 'INSERT OR IGNORE INTO graduations (token, block, tx, symbol, name, sym_skel, name_skel) '
  + 'SELECT ?1, ?2, ?3, l.symbol, l.name, l.sym_skel, l.name_skel FROM (SELECT 1) LEFT JOIN launches l ON l.token = ?1';
export const SQL_GRADUATIONS_TABLE = 'CREATE TABLE IF NOT EXISTS graduations (token TEXT PRIMARY KEY, block INTEGER NOT NULL, tx TEXT NOT NULL, '
  + 'symbol TEXT, name TEXT, sym_skel TEXT, name_skel TEXT)';

// Bytes -> text, the WHATWG UTF-8 decoder (bad bytes become U+FFFD, like Python's errors='replace').
export function utf8Decode(bytes) {
  let out = '', need = 0, cp = 0, lo = 0x80, hi = 0xbf;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (need === 0) {
      if (b <= 0x7f) out += String.fromCharCode(b);
      else if (b >= 0xc2 && b <= 0xdf) { need = 1; cp = b & 0x1f; }
      else if (b >= 0xe0 && b <= 0xef) { if (b === 0xe0) lo = 0xa0; if (b === 0xed) hi = 0x9f; need = 2; cp = b & 0x0f; }
      else if (b >= 0xf0 && b <= 0xf4) { if (b === 0xf0) lo = 0x90; if (b === 0xf4) hi = 0x8f; need = 3; cp = b & 0x07; }
      else out += '�';
      continue;
    }
    if (b < lo || b > hi) {
      need = 0; cp = 0; lo = 0x80; hi = 0xbf;
      out += '�';
      i--;                         // look at this byte again as a new start
      continue;
    }
    lo = 0x80; hi = 0xbf;
    cp = (cp << 6) | (b & 0x3f);
    if (--need === 0) out += String.fromCodePoint(cp);
  }
  if (need) out += '�';
  return out;
}

function hexBytes(h) {
  const out = new Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(2 * i, 2), 16);
  return out;
}

export const MAX_TEXT = 200;   // characters kept from a name or symbol

// Control characters go (they break pages and SQL dumps); invisible "format" characters such as U+2060 stay,
// because they are how look-alike names hide (the copy check shows them).
export function cleanText(s) {
  const t = String(s).replace(/[\u0000-\u001f\u007f]/g, '').replace(/^[ ]+|[ ]+$/g, '');
  const cps = Array.from(t);
  return cps.length > MAX_TEXT ? cps.slice(0, MAX_TEXT).join('') : t;
}

// name()/symbol() return data -> text. Handles ABI strings (any offset) and bytes32 (old-style tokens).
// '' when there is nothing readable.
export function decodeText(hex) {
  const h = String(hex || '').replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]*$/.test(h) || h.length % 2) return '';
  const n = h.length / 2;
  if (n >= 64) {
    const off = Number(wordAt(h, 0));
    if (off % 32 === 0 && off + 32 <= n) {
      const len = Number(BigInt('0x' + h.slice(off * 2, off * 2 + 64)));
      if (len <= 4096 && off + 32 + len <= n) return cleanText(utf8Decode(hexBytes(h.slice(off * 2 + 64, off * 2 + 64 + len * 2))));
    }
  }
  if (n === 32) {
    const bytes = hexBytes(h);
    const end = bytes.indexOf(0);
    return cleanText(utf8Decode(end < 0 ? bytes : bytes.slice(0, end)));
  }
  return '';
}

// ---- Multicall3 aggregate3 --------------------------------------------------------------------
const word = (n) => BigInt(n).toString(16).padStart(64, '0');

// calls: [{ target, data }] (allowFailure = true for all) -> calldata for aggregate3((address,bool,bytes)[]).
export function encodeAggregate3(calls) {
  const tuples = calls.map((c) => {
    const d = String(c.data).replace(/^0x/, '');
    const padded = d.padEnd(Math.ceil(d.length / 64) * 64, '0');
    return word(BigInt(c.target)) + word(1) + word(0x60) + word(d.length / 2) + padded;
  });
  let head = '', offset = 32 * tuples.length;
  for (const t of tuples) { head += word(offset); offset += t.length / 2; }
  return E.SEL_AGGREGATE3 + word(0x20) + word(tuples.length) + head + tuples.join('');
}

// aggregate3 return data -> [{ success, data: '0x…' }].
export function decodeAggregate3(hex) {
  const h = String(hex || '').replace(/^0x/, '');
  const at = (byte) => Number(BigInt('0x' + (h.slice(byte * 2, byte * 2 + 64) || '0')));
  const arr = at(0);
  const n = at(arr);
  const base = arr + 32;
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = base + at(base + 32 * i);
    const success = at(t) !== 0;
    const b = t + at(t + 32);
    const len = at(b);
    if ((b + 32 + len) * 2 > h.length) throw new Error('aggregate3: short answer');
    out.push({ success, data: '0x' + h.slice((b + 32) * 2, (b + 32 + len) * 2) });
  }
  return out;
}

// ---- chain reads -------------------------------------------------------------------------------

// One eth_getLogs, official node first (patient tries: it 429s in bursts), dRPC as a fallback.
// A range with too many logs throws an RpcError with overCap = true.
async function getLogsOnce(filter) {
  let last = null;
  for (const [ep, opts] of byHealth([['official', logOpts()], ['drpc', { tries: 2 }]])) {
    try {
      const logs = await rpc(ep, 'eth_getLogs', [filter], opts);
      if (!Array.isArray(logs)) throw new RpcError('bad eth_getLogs answer', { endpoint: ep, retryable: true });
      if (logs.length >= E.LOG_CAP) throw new RpcError('logs at the cap', { endpoint: ep, overCap: true });
      return logs;
    } catch (e) {
      if (e && e.overCap) throw e;          // splitting is the fix, not another node
      last = e;
    }
  }
  throw last || new RpcError('no node answered eth_getLogs');
}

// Logs for one filter over [from, to], halving the range whenever the answer is over the 10k cap.
export async function getLogsSplit(base, from, to, depth = 0) {
  try {
    return await getLogsOnce({ ...base, fromBlock: toHex(from), toBlock: toHex(to) });
  } catch (e) {
    if (!(e && e.overCap) || to <= from || depth > 40) throw e;
    const mid = Math.floor((from + to) / 2);
    const a = await getLogsSplit(base, from, mid, depth + 1);
    const b = await getLogsSplit(base, mid + 1, to, depth + 1);
    return a.concat(b);
  }
}

// Every TokenLaunched log of the given factories in [from, to]. A short range asks all factories in one call
// (a list of addresses may span 100k blocks); a long one asks each factory in 10M-block pieces.
export async function fetchLaunchLogs(addresses, from, to) {
  const topics = [E.TOPIC_TOKEN_LAUNCHED];
  if (to < from) return [];
  if (to - from <= E.LOG_SPAN_MANY) return getLogsSplit({ address: addresses, topics }, from, to);
  const out = [];
  for (const address of addresses) {
    for (let a = from; a <= to; a += E.LOG_SPAN_ONE + 1) {
      out.push(...await getLogsSplit({ address, topics }, a, Math.min(to, a + E.LOG_SPAN_ONE)));
    }
  }
  return out;
}

// Chunked reading (the Worker): every factory's TokenLaunched logs in [from, to], `span` blocks per eth_getLogs, three
// calls per batch request on dRPC (its free plan's batch limit), at most maxRequests requests. A batch dRPC can't
// answer is asked once on the official node (last resort). Stops early, at a batch edge, once maxLogs launches
// were seen. -> { logs, to: last block fully read (from - 1 when nothing was), requests }
export const CHUNK_BATCH = 3;
export async function fetchLaunchLogsChunked(addresses, from, to, { span = 100, maxRequests = 20, maxLogs = Infinity } = {}) {
  const topics = [[E.TOPIC_TOKEN_LAUNCHED, E.TOPIC_GRADUATED]];   // launches and graduations, same requests
  const pieces = [];
  for (let a = from; a <= to; a += span) pieces.push([a, Math.min(to, a + span - 1)]);
  const out = { logs: [], to: from - 1, requests: 0 };
  for (let i = 0; i < pieces.length; i += CHUNK_BATCH) {
    if (out.requests >= maxRequests || out.logs.length >= maxLogs) break;
    const group = pieces.slice(i, i + CHUNK_BATCH);
    const calls = group.map(([a, b]) => ({ method: 'eth_getLogs', params: [{ address: addresses, topics, fromBlock: toHex(a), toBlock: toHex(b) }] }));
    let got = null;
    for (const [ep, tries] of [['drpc', 2], ['official', 1]]) {
      if (out.requests >= maxRequests) break;
      out.requests++;
      try {
        const res = await rpcBatch(ep, calls, { tries });
        if (res.every((r) => r && Array.isArray(r.result) && r.result.length < E.LOG_CAP)) { got = res.map((r) => r.result); break; }
      } catch (e) { /* next node */ }
    }
    if (!got) {
      if (out.to < from) throw new RpcError('no node answered eth_getLogs for blocks ' + from + '-' + group[group.length - 1][1]);
      break;                                  // keep what was read; the next run carries on from here
    }
    for (const list of got) out.logs.push(...list);
    out.to = group[group.length - 1][1];
  }
  return out;
}

// Block times for the Worker: dRPC first (archive; publicnode only knows the last ~100 blocks), then the usual order.
async function launchTimes(blocks, chunked) {
  if (!chunked || !blocks.length) return blockTimes(blocks);
  try {
    const res = await rpcBatch('drpc', blocks.map((b) => ({ method: 'eth_getBlockByNumber', params: [toHex(b), false] })), { tries: 2 });
    if (res.every((r) => r && r.result && r.result.timestamp)) return res.map((r) => parseInt(r.result.timestamp, 16));
  } catch (e) { /* the usual order below */ }
  return blockTimes(blocks);
}

// tx hash -> sender, for launches whose creator is Multicall3. Missing entries were not answered.
export async function fetchTxFrom(hashes) {
  const out = new Map();
  let todo = [...new Set(hashes)];
  for (const [ep, tries] of byHealth([['official', 3], ['drpc', 3]])) {
    if (!todo.length) break;
    try {
      const res = await rpcBatch(ep, todo.map((h) => ({ method: 'eth_getTransactionByHash', params: [h] })), { tries });
      todo.forEach((h, i) => { const r = res[i]; if (r && r.result && r.result.from) out.set(h, lower(r.result.from)); });
    } catch (e) { /* next node */ }
    todo = todo.filter((h) => !out.has(h));
  }
  if (todo.length) throw new RpcError('launch transactions unavailable (' + todo.length + ')');
  return out;
}

const callOf = (to, data, block) => ({ method: 'eth_call', params: [{ to, data }, block] });

// name()/symbol() for many tokens via Multicall3. Returns Map token -> { name, symbol } where a value is
//   text  — read (may be '' when the token returns nothing readable)
//   null  — not known yet (no node answered, or only a 'latest' node that doesn't see the token yet)
// block: the state to read at (archive dRPC first, so the answer is final), then 'latest' on the others.
export async function readNames(tokens, block) {
  const out = new Map(tokens.map((t) => [t, { name: null, symbol: null }]));
  for (let i = 0; i < tokens.length; i += E.NAMES_PER_CALL) {
    const chunk = tokens.slice(i, i + E.NAMES_PER_CALL);
    const data = encodeAggregate3(chunk.flatMap((t) => [{ target: t, data: E.SEL_NAME }, { target: t, data: E.SEL_SYMBOL }]));
    const plans = [
      { ep: 'drpc', at: toHex(block), tries: 4, final: true },        // archive: the state at `block` is final
      { ep: 'official', at: 'latest', tries: 2, final: false },
      { ep: 'publicnode', at: 'latest', tries: 2, final: false },
    ];
    for (const [ep, { at, tries, final }] of byHealth(plans.map((p) => [p.ep, p]))) {
      let res;
      try {
        const [r] = await rpcBatch(ep, [callOf(E.MULTICALL3, data, at)], { tries });
        if (!r || r.error || !r.result) continue;
        res = decodeAggregate3(r.result);
      } catch (e) { continue; }
      if (res.length !== chunk.length * 2) continue;
      let open = 0;
      chunk.forEach((t, j) => {
        const cur = out.get(t);
        for (const [k, item] of [['name', res[2 * j]], ['symbol', res[2 * j + 1]]]) {
          if (cur[k] !== null) continue;
          if (!item.success) { cur[k] = ''; continue; }              // the token reverts: nothing to read
          const empty = item.data === '0x';
          if (empty && !final) { open++; continue; }                 // a 'latest' node may not see it yet
          cur[k] = decodeText(item.data);
        }
      });
      if (!open) break;
    }
  }
  return out;
}

// ---- rows and SQL -------------------------------------------------------------------------------
export const COLUMNS = ['token', 'factory', 'curve', 'creator', 'tx_from', 'pair_token', 'graduation_threshold',
  'block', 'log_index', 'time', 'tx', 'name', 'symbol', 'sym_skel', 'name_skel'];

// The wallet that launched the coin: tx.from when the factory was called through Multicall3.
export function devOf(row) {
  return row.creator === E.MULTICALL3 && row.tx_from ? row.tx_from : row.creator;
}

export function buildRow(launch, { txFrom = null, name = null, symbol = null, time = null } = {}) {
  return {
    token: launch.token, factory: launch.factory, curve: launch.curve, creator: launch.creator,
    tx_from: txFrom, pair_token: launch.pair_token, graduation_threshold: launch.graduation_threshold,
    block: launch.block, log_index: launch.log_index, time, tx: launch.tx,
    name, symbol,
    sym_skel: symbol === null ? null : skeleton(symbol),
    name_skel: name === null ? null : skeleton(name),
  };
}

// Idempotent: running the same range twice changes nothing. A NULL never overwrites a value already read.
export const SQL_UPSERT =
  'INSERT INTO launches (' + COLUMNS.join(', ') + ') VALUES (' + COLUMNS.map(() => '?').join(', ') + ')' +
  ' ON CONFLICT(token) DO UPDATE SET factory = excluded.factory, curve = excluded.curve, creator = excluded.creator,' +
  ' tx_from = COALESCE(excluded.tx_from, launches.tx_from), pair_token = excluded.pair_token,' +
  ' graduation_threshold = excluded.graduation_threshold, block = excluded.block, log_index = excluded.log_index,' +
  ' time = COALESCE(excluded.time, launches.time), tx = excluded.tx,' +
  ' name = COALESCE(excluded.name, launches.name), symbol = COALESCE(excluded.symbol, launches.symbol),' +
  ' sym_skel = CASE WHEN excluded.symbol IS NULL THEN launches.sym_skel ELSE excluded.sym_skel END,' +
  ' name_skel = CASE WHEN excluded.name IS NULL THEN launches.name_skel ELSE excluded.name_skel END';

export const SQL_META_ALL = 'SELECT key, value FROM meta';
// Moves last_block up to ?1 only when this run joined on (?2 = its first block <= last_block + 1) and it is newer.
export const SQL_META_ADVANCE =
  "INSERT INTO meta (key, value) VALUES ('last_block', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value" +
  ' WHERE CAST(meta.value AS INTEGER) < CAST(excluded.value AS INTEGER) AND CAST(meta.value AS INTEGER) >= ?2 - 1';
export const SQL_META_OLDEST_INIT = "INSERT INTO meta (key, value) VALUES ('oldest_block', ?1) ON CONFLICT(key) DO NOTHING";
export const SQL_META_SET = 'INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
// Uses the partial index idx_launches_pending (api/schema.sql): keep this WHERE identical to the index's.
export const SQL_PENDING_NAMES = 'SELECT token, block FROM launches WHERE name IS NULL OR symbol IS NULL ORDER BY block DESC LIMIT ?1';
export const SQL_SET_NAMES =
  'UPDATE launches SET name = COALESCE(?2, name), symbol = COALESCE(?3, symbol),' +
  ' name_skel = CASE WHEN ?2 IS NULL THEN name_skel ELSE ?4 END, sym_skel = CASE WHEN ?3 IS NULL THEN sym_skel ELSE ?5 END' +
  ' WHERE token = ?1';

export function upsertStatement(db, row) {
  return db.prepare(SQL_UPSERT).bind(...COLUMNS.map((c) => (row[c] === undefined ? null : row[c])));
}

// meta table -> { last_block, oldest_block, last_run } (numbers or null)
export async function readMeta(db) {
  const res = await db.prepare(SQL_META_ALL).all();
  const m = { last_block: null, oldest_block: null, last_run: null };
  for (const r of (res && res.results) || []) {
    if (r.key in m) { const n = Number(r.value); m[r.key] = Number.isFinite(n) ? n : null; }
  }
  return m;
}

async function runBatches(db, stmts) {
  for (let i = 0; i < stmts.length; i += E.D1_BATCH) await db.batch(stmts.slice(i, i + E.D1_BATCH));
}

// Rows whose name or symbol could not be read yet: read again (at block `at`, or the newest row's block when
// that is later) and fill them in.
export async function fillPendingNames(db, at, limit = E.PENDING_NAMES_PER_RUN) {
  const res = await db.prepare(SQL_PENDING_NAMES).bind(limit).all();
  const rows = (res && res.results) || [];
  if (!rows.length) return { tried: 0, filled: 0 };
  // Never read a coin at a block before its launch: the archive node would answer "nothing there" for good.
  // (A backfill import can hold rows newer than this run's last block.)
  const readAt = Math.max(Number(at), ...rows.map((r) => Number(r.block) || 0));
  const names = await readNames(rows.map((r) => r.token), readAt);
  const stmts = [];
  for (const r of rows) {
    const n = names.get(r.token);
    if (!n || (n.name === null && n.symbol === null)) continue;
    stmts.push(db.prepare(SQL_SET_NAMES).bind(r.token, n.name, n.symbol,
      n.name === null ? null : skeleton(n.name), n.symbol === null ? null : skeleton(n.symbol)));
  }
  await runBatches(db, stmts);
  return { tried: rows.length, filled: stmts.length };
}

// ---- the run ------------------------------------------------------------------------------------
// fromBlock: start here (default: one past meta.last_block; empty table: about a minute back).
// maxBlocks: blocks per run. maxRows: launches per run (the range is cut at a block edge so nothing is half done).
// head: a block number to use as the chain head (tests). log(text): progress lines (the Worker passes console.log).
export async function runIndexer(env, opts = {}) {
  const db = env && env.DB;
  if (!db || typeof db.prepare !== 'function') throw new Error('DB binding missing');
  const { fromBlock = null, maxBlocks = E.DEFAULT_MAX_BLOCKS, maxRows = E.DEFAULT_MAX_ROWS, head = null,
    log = () => {}, now = () => Date.now(), pending = true, logSpan = null, maxLogRequests = 20 } = opts;
  const chunked = Number.isFinite(logSpan) && logSpan > 0;
  const started = now();
  const meta = await readMeta(db);
  const headNumber = head !== null ? Number(head) : (await headBlock()).number;
  const settled = headNumber - E.CONFIRMATIONS;
  const from = fromBlock !== null ? Number(fromBlock)
    : meta.last_block !== null ? meta.last_block + 1
      : Math.max(E.INDEX_FLOOR, settled - E.FIRST_RUN_LOOKBACK + 1);
  const summary = { ok: true, head: headNumber, from, to: from - 1, found: 0, written: 0, viaMulticall: 0,
    namesUnread: 0, pending: null, upToDate: false, ms: 0 };
  if (from > settled) { summary.upToDate = true; summary.ms = now() - started; return summary; }
  let to = Math.min(settled, from + Math.max(1, maxBlocks) - 1);

  let logs;
  if (chunked) {
    const got = await fetchLaunchLogsChunked(E.FACTORY_ADDRESSES, from, to, { span: logSpan, maxRequests: maxLogRequests, maxLogs: maxRows });
    logs = got.logs;
    to = got.to;
    summary.logRequests = got.requests;
  } else logs = await fetchLaunchLogs(E.FACTORY_ADDRESSES, from, to);
  const seen = new Set();
  let launches = logs.map(decodeLaunchLog).filter((l) => l && !seen.has(l.token) && seen.add(l.token))
    .sort((a, b) => a.block - b.block || a.log_index - b.log_index);
  if (launches.length > maxRows) {
    const edge = launches[maxRows - 1].block;
    launches = launches.filter((l) => l.block <= edge);
    to = edge;
  }
  summary.to = to;
  summary.found = launches.length;

  if (launches.length) {
    const viaMc = launches.filter((l) => l.creator === E.MULTICALL3);
    const txFrom = viaMc.length ? await fetchTxFrom(viaMc.map((l) => l.tx)) : new Map();
    summary.viaMulticall = viaMc.length;
    const names = await readNames(launches.map((l) => l.token), to);
    const blocks = [...new Set(launches.map((l) => l.block))];
    const times = await launchTimes(blocks, chunked);
    const timeOf = new Map(blocks.map((b, i) => [b, times[i]]));
    const rows = launches.map((l) => {
      const n = names.get(l.token);
      return buildRow(l, { txFrom: txFrom.get(l.tx) || null, name: n.name, symbol: n.symbol, time: timeOf.get(l.block) ?? null });
    });
    summary.namesUnread = rows.filter((r) => r.name === null || r.symbol === null).length;
    await runBatches(db, rows.map((r) => upsertStatement(db, r)));
    summary.written = rows.length;
  }

  // Progress last, in one batch: a run that failed above leaves the cursor where it was (and is redone).
  // Graduations seen in the same logs (only when reading in chunks, the Worker's way), written with the cursor.
  const grads = chunked ? logs.map(decodeGraduationLog).filter((g) => g && g.block <= to) : [];
  summary.graduations = grads.length;
  await db.batch([
    ...(grads.length ? [db.prepare(SQL_GRADUATIONS_TABLE)] : []),
    ...grads.map((g) => db.prepare(SQL_GRADUATION_ADD).bind(g.token, g.block, g.tx)),
    db.prepare(SQL_META_ADVANCE).bind(String(to), from),
    db.prepare(SQL_META_OLDEST_INIT).bind(String(from)),
    db.prepare(SQL_META_SET).bind('last_run', String(Math.floor(now() / 1000))),
  ]);

  if (pending) {
    try { summary.pending = await fillPendingNames(db, to); } catch (e) { summary.pending = { error: String((e && e.message) || e) }; }
  }
  summary.ms = now() - started;
  log('indexer: blocks ' + from + '-' + to + ' (head ' + headNumber + '), ' + summary.written + ' launches, '
    + summary.viaMulticall + ' via Multicall3, ' + summary.namesUnread + ' names pending');
  return summary;
}
