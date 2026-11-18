// Launch indexer (api/src/indexer.js): decoding, log range splitting, Multicall3 dev fallback, names via
// Multicall3 aggregate3, skeleton columns, idempotent upserts and the meta cursor.
// Offline: a mock Robinhood Chain behind fetch (rpc.js _setTransport) and a fake D1 (env.DB).
// Real data: dev/tests/fixtures/launches/sample.json (made by dev/tools/backfill_launches.py).
import { suite, test, eq, ok } from './harness.js';
import { _setTransport } from '../../site/src/data/rpc.js';
import { clearChainCaches } from '../../site/src/data/chain.js';
import { RPC } from '../../site/src/data/constants.js';
import { skeleton } from '../../site/src/trust/skeleton.js';
import * as IX from '../../api/src/indexer.js';
import * as E from '../../api/src/env.js';
import * as SF from '../../site/src/trust/factories.js';

suite('indexer');

// ---- fixture -------------------------------------------------------------------------------------
let samplePromise = null;
function sample() {
  if (!samplePromise) {
    samplePromise = (async () => {
      const here = import.meta.url;
      if (typeof read === 'function' && /^file:/.test(here)) {          // jsc
        const dir = decodeURIComponent(here.replace(/^file:\/\//, '')).replace(/[^/]*$/, '');
        return JSON.parse(read(dir + 'fixtures/launches/sample.json'));
      }
      const res = await fetch(new URL('./fixtures/launches/sample.json', here));   // browser
      return res.json();
    })();
  }
  return samplePromise;
}

const OBSYN_REAL = '0x5d992fa5b7da8efde5fd36d24e81097ed6ad4351';
const OBSYN_COPY = '0x7a2aec4da4e23ca727ac42aa4e37f24de480475e';

// ---- encoding helpers ----------------------------------------------------------------------------
const w = (x) => BigInt(x).toString(16).padStart(64, '0');
const hex = (n) => '0x' + n.toString(16);
function utf8Hex(s) {
  const bin = unescape(encodeURIComponent(s));
  let h = '';
  for (let i = 0; i < bin.length; i++) h += bin.charCodeAt(i).toString(16).padStart(2, '0');
  return h;
}
function abiString(s) {
  const h = utf8Hex(s);
  return '0x' + w(32) + w(h.length / 2) + h.padEnd(Math.ceil(h.length / 64) * 64 || 0, '0');
}
function launchLog(r) {
  return {
    address: r.factory,
    topics: [E.TOPIC_TOKEN_LAUNCHED, '0x' + w(r.token), '0x' + w(r.curve), '0x' + w(r.creator)],
    data: '0x' + w(r.pair_token) + w(0) + w(r.graduation_threshold),
    blockNumber: hex(r.block), logIndex: hex(r.log_index), transactionHash: r.tx, removed: false,
  };
}
// aggregate3 calldata -> [{ target, sel }]
function parseAgg(data) {
  ok(data.slice(0, 10) === E.SEL_AGGREGATE3, 'aggregate3 selector');
  const h = data.slice(10);
  const at = (b) => Number(BigInt('0x' + h.slice(b * 2, b * 2 + 64)));
  const arr = at(0), n = at(arr), base = arr + 32, out = [];
  for (let i = 0; i < n; i++) {
    const t = base + at(base + 32 * i);
    const b = t + at(t + 64), len = at(b);
    out.push({ target: '0x' + h.slice(t * 2 + 24, t * 2 + 64), allow: at(t + 32), sel: '0x' + h.slice((b + 32) * 2, (b + 32 + len) * 2) });
  }
  return out;
}
// [{ success, data }] -> aggregate3 return data
function aggResult(items) {
  const tuples = items.map((it) => {
    const d = it.data.replace(/^0x/, '');
    return w(it.success ? 1 : 0) + w(0x40) + w(d.length / 2) + d.padEnd(Math.ceil(d.length / 64) * 64, '0');
  });
  let head = '', off = 32 * tuples.length;
  for (const t of tuples) { head += w(off); off += t.length / 2; }
  return '0x' + w(0x20) + w(items.length) + head + tuples.join('');
}

// ---- mock chain ----------------------------------------------------------------------------------
// rows: table rows the chain should produce. opts: head, cap (logs per answer), drpcDown (archive eth_call
// always says "Unknown state"), blind (Set of tokens a 'latest' node can't see yet), failTimes.
// Cloudflare-like options: official429 (the official node answers HTTP 429 to everything), drpcLogsDown (dRPC's
// eth_getLogs fails), drpcLogsFailFrom (dRPC's eth_getLogs fails from this block on), avoid (rpc.js avoid list).
// dRPC behaves like its free plan: eth_getLogs over more than 101 blocks and batches over 3 calls are refused.
function mockChain(rows, opts = {}) {
  const o = { cap: 10000, drpcDown: false, blind: new Set(), failTimes: false, official429: false, drpcLogsDown: false, drpcLogsFailFrom: null, ...opts };
  const logs = rows.map(launchLog);
  const byToken = new Map(rows.map((r) => [r.token, r]));
  const timeByBlock = new Map(rows.map((r) => [r.block, r.time]));
  const txFrom = new Map(rows.filter((r) => r.tx_from).map((r) => [r.tx, r.tx_from]));
  const calls = [];
  const fail = (message, code = -32000) => { throw Object.assign(new Error(message), { code }); };
  const timeOf = (n) => (timeByBlock.has(n) ? timeByBlock.get(n) : 1794000000 + Math.floor(n / 10));
  function handle(ep, method, params) {
    if (method === 'eth_getBlockByNumber') {
      if (o.failTimes && params[0] !== 'latest') fail('header not found');
      const n = params[0] === 'latest' ? o.head : parseInt(params[0], 16);
      return { number: hex(n), timestamp: hex(timeOf(n)) };
    }
    if (method === 'eth_getLogs') {
      const f = params[0];
      const a = parseInt(f.fromBlock, 16), b = parseInt(f.toBlock, 16);
      const many = Array.isArray(f.address);
      if (ep === 'drpc' && (o.drpcLogsDown || (o.drpcLogsFailFrom != null && b >= o.drpcLogsFailFrom))) fail('upstream unavailable');
      if (ep === 'drpc' && b - a > 100) fail('ranges over 100 blocks are not supported on free plan', 35);
      if (b - a > (many ? 99999 : 9999999)) fail('query spans ' + (b - a + 1) + ' blocks, but only 100000 are allowed', -32602);
      const addrs = new Set(many ? f.address : [f.address]);
      const hit = logs.filter((l) => addrs.has(l.address) && l.topics[0] === f.topics[0]
        && parseInt(l.blockNumber, 16) >= a && parseInt(l.blockNumber, 16) <= b);
      if (hit.length > o.cap) fail('logs matched by query exceeds limit of 10000');
      return hit;
    }
    if (method === 'eth_getTransactionByHash') {
      const r = rows.find((x) => x.tx === params[0]);
      return r ? { hash: r.tx, from: txFrom.get(r.tx) || r.creator } : null;
    }
    if (method === 'eth_call') {
      const [{ to, data }, at] = params;
      if (to !== E.MULTICALL3) fail('execution reverted', 3);
      if (ep === 'drpc' && o.drpcDown) fail('Unknown state. First available state is 1');
      const items = parseAgg(data).map(({ target, sel }) => {
        const r = byToken.get(target);
        // No code there (yet): an unknown address, a 'latest' node that lags, or a block before the launch.
        if (!r || (at === 'latest' && o.blind.has(target)) || (at !== 'latest' && parseInt(at, 16) < r.block)) return { success: true, data: '0x' };
        const v = sel === E.SEL_NAME ? r.name : r.symbol;
        if (v === '' || v === null) return { success: false, data: '0x' };
        return { success: true, data: abiString(v) };
      });
      return aggResult(items);
    }
    fail('mock: unsupported ' + method);
  }
  const requests = [];
  const fetch = async (url, init) => {
    const ep = Object.keys(RPC).find((k) => RPC[k].url === url);
    const body = JSON.parse(init.body);
    const list = Array.isArray(body) ? body : [body];
    requests.push({ ep, methods: list.map((x) => x.method) });
    if (ep === 'official' && o.official429) return { ok: false, status: 429, json: async () => ({ message: 'rate limited' }) };
    if (ep === 'drpc' && list.length > 3) {
      const out = list.map((req) => ({ jsonrpc: '2.0', id: req.id, error: { code: 31, message: 'Batch of more than 3 requests are not allowed on free plan' } }));
      return { ok: true, status: 200, json: async () => out };
    }
    const out = list.map((req) => {
      calls.push({ ep, method: req.method, params: req.params });
      try { return { jsonrpc: '2.0', id: req.id, result: handle(ep, req.method, req.params) }; } catch (e) {
        return { jsonrpc: '2.0', id: req.id, error: { code: e.code, message: e.message } };
      }
    });
    return { ok: true, status: 200, json: async () => (Array.isArray(body) ? out : out[0]) };
  };
  _setTransport({ fetch, sleep: async () => {}, backoff: [0], timeouts: false, avoid: o.avoid });
  clearChainCaches();
  return { calls, requests, setOpt: (k, v) => { o[k] = v; } };
}

// ---- fake D1 -------------------------------------------------------------------------------------
// Implements exactly the statements indexer.js sends, with the same rules as the real SQL (that SQL is run on a
// real SQLite with api/schema.sql by `python3 -I dev/tools/backfill_launches.py <scratch dir> check`).
// Unknown SQL throws.
function fakeDB() {
  const launches = new Map(), meta = new Map(), sqlLog = [];
  const num = (v) => Number(v);
  function exec(sql, a) {
    sqlLog.push(sql);
    if (sql === IX.SQL_META_ALL) return { results: [...meta].map(([key, value]) => ({ key, value })) };
    if (sql === IX.SQL_UPSERT) {
      const row = {};
      IX.COLUMNS.forEach((c, i) => { row[c] = a[i]; });
      const old = launches.get(row.token);
      if (old) {
        if (row.tx_from === null) row.tx_from = old.tx_from;
        if (row.time === null) row.time = old.time;
        if (row.name === null) { row.name = old.name; row.name_skel = old.name_skel; }
        if (row.symbol === null) { row.symbol = old.symbol; row.sym_skel = old.sym_skel; }
      }
      launches.set(row.token, row);
      return { success: true };
    }
    if (sql === IX.SQL_META_ADVANCE) {
      const [to, from] = a;
      if (!meta.has('last_block')) meta.set('last_block', to);
      else if (num(meta.get('last_block')) < num(to) && num(meta.get('last_block')) >= from - 1) meta.set('last_block', to);
      return { success: true };
    }
    if (sql === IX.SQL_META_OLDEST_INIT) { if (!meta.has('oldest_block')) meta.set('oldest_block', a[0]); return { success: true }; }
    if (sql === IX.SQL_META_SET) { meta.set(a[0], a[1]); return { success: true }; }
    if (sql === IX.SQL_PENDING_NAMES) {
      const res = [...launches.values()].filter((r) => r.name === null || r.symbol === null)
        .sort((x, y) => y.block - x.block).slice(0, a[0]).map((r) => ({ token: r.token, block: r.block }));
      return { results: res };
    }
    if (sql === IX.SQL_SET_NAMES) {
      const r = launches.get(a[0]);
      if (r) {
        if (a[1] !== null) { r.name = a[1]; r.name_skel = a[3]; }
        if (a[2] !== null) { r.symbol = a[2]; r.sym_skel = a[4]; }
      }
      return { success: true };
    }
    throw new Error('fake DB: unknown SQL ' + sql.slice(0, 60));
  }
  const stmt = (sql, args) => ({
    sql, args,
    bind: (...b) => stmt(sql, b),
    all: async () => exec(sql, args), first: async () => (exec(sql, args).results || [])[0] || null, run: async () => exec(sql, args),
  });
  return {
    launches, meta, sqlLog, batches: 0,
    prepare: (sql) => stmt(sql, []),
    async batch(list) { this.batches++; return list.map((s) => exec(s.sql, s.args)); },
  };
}

const span = (rows) => [Math.min(...rows.map((r) => r.block)), Math.max(...rows.map((r) => r.block))];
const pick = (r, cols) => Object.fromEntries(cols.map((c) => [c, r[c]]));
const BASE_COLS = ['token', 'factory', 'curve', 'creator', 'tx_from', 'pair_token', 'graduation_threshold', 'block', 'log_index', 'time', 'tx', 'name', 'symbol'];

// Small synthetic launches (V2 factory) for the cursor tests.
function synth(n, startBlock, step = 1000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const id = (i + 1).toString(16).padStart(4, '0');
    out.push({
      token: '0x' + 'a'.repeat(36) + id, factory: E.FACTORY_ADDRESSES[0], curve: '0x' + 'c'.repeat(36) + id,
      creator: '0x' + 'd'.repeat(36) + id, tx_from: null, pair_token: '0x' + '0'.repeat(40),
      graduation_threshold: '4200000000000000000', block: startBlock + i * step, log_index: 3,
      time: 1794000000 + i * 100, tx: '0x' + 'e'.repeat(60) + id, name: 'Coin ' + i, symbol: 'C' + i,
    });
  }
  return out;
}

// ---- tests ---------------------------------------------------------------------------------------

test('env: 8 factories (lowercase, unique, V2 first), topic, Multicall3, floor below the first launch', () => {
  eq(E.FACTORY_ADDRESSES.length, 8);
  eq(new Set(E.FACTORY_ADDRESSES).size, 8);
  ok(E.FACTORY_ADDRESSES.every((a) => /^0x[0-9a-f]{40}$/.test(a)), 'lowercase addresses');
  eq(E.FACTORY_ADDRESSES[0], '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e');
  eq(E.TOPIC_TOKEN_LAUNCHED, '0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607');
  eq(E.MULTICALL3, '0xca11bde05977b3631167028862be2a173976ca11');
  ok(E.FACTORIES.every((f) => f.first > E.INDEX_FLOOR), 'every first launch is above INDEX_FLOOR');
});

test('fixture: real launches incl. the three OBSYNs and a Multicall3 launch', async () => {
  const s = await sample();
  ok(s.rows.length >= 40, 'about 50 rows: ' + s.rows.length);
  const obsyn = s.rows.filter((r) => r.symbol && skeleton(r.symbol) === 'obsyn');
  ok(obsyn.length >= 3, 'three OBSYN launches: ' + obsyn.length);
  ok(s.rows.some((r) => r.token === OBSYN_REAL) && s.rows.some((r) => r.token === OBSYN_COPY));
  const mc = s.rows.find((r) => r.creator === E.MULTICALL3);
  ok(mc && /^0x[0-9a-f]{40}$/.test(mc.tx_from) && mc.tx_from !== E.MULTICALL3, 'Multicall3 launch has its tx sender');
  const real = s.rows.find((r) => r.token === OBSYN_REAL), copy = s.rows.find((r) => r.token === OBSYN_COPY);
  eq(real.block, 116638986);
  eq(real.creator, '0x03412baadd3d3207506e89cebb051ab713295c32');
  eq(copy.time, real.time - 705, 'copy launched 11 min 45 s earlier');
});

test('decodeLaunchLog: real TokenLaunched logs give the stored rows', async () => {
  const s = await sample();
  ok(s.raw.logs.length >= 4, 'raw logs for the OBSYNs and the Multicall3 launch');
  for (const lg of s.raw.logs) {
    const d = IX.decodeLaunchLog(lg);
    const row = s.rows.find((r) => r.token === d.token);
    ok(row, 'row for ' + d.token);
    eq(d, pick(row, ['token', 'factory', 'curve', 'creator', 'pair_token', 'graduation_threshold', 'block', 'log_index', 'tx']));
  }
});

test('decodeLaunchLog: ignores other topics, unknown factories, removed logs and short data', async () => {
  const s = await sample();
  const lg = s.raw.logs[0];
  ok(IX.decodeLaunchLog(lg));
  eq(IX.decodeLaunchLog({ ...lg, topics: ['0x' + '1'.repeat(64), ...lg.topics.slice(1)] }), null);
  eq(IX.decodeLaunchLog({ ...lg, address: '0x' + '9'.repeat(40) }), null);
  eq(IX.decodeLaunchLog({ ...lg, removed: true }), null);
  eq(IX.decodeLaunchLog({ ...lg, data: '0x' + w(0) }), null);
  eq(IX.decodeLaunchLog({ ...lg, address: lg.address.toUpperCase().replace('0X', '0x') }).factory, lg.address.toLowerCase());
});

test('decodeText: real name()/symbol() answers, ABI strings, bytes32, empty and junk', async () => {
  const s = await sample();
  for (const [token, raw] of Object.entries(s.raw.names)) {
    const row = s.rows.find((r) => r.token === token);
    eq(IX.decodeText(raw.name), row.name, 'name of ' + token);
    eq(IX.decodeText(raw.symbol), row.symbol, 'symbol of ' + token);
  }
  eq(IX.decodeText(abiString('obsyn')), 'obsyn');
  eq(IX.decodeText(abiString('Ünïcode 🚀')), 'Ünïcode 🚀');
  eq(IX.decodeText('0x' + utf8Hex('USDC').padEnd(64, '0')), 'USDC', 'bytes32 symbol');
  eq(IX.decodeText('0x' + w(64) + w(0) + w(3) + utf8Hex('abc').padEnd(64, '0')), 'abc', 'string at a non-standard offset');
  eq(IX.decodeText('0x'), '');
  eq(IX.decodeText(''), '');
  eq(IX.decodeText('0x1234'), '', 'too short to be anything');
  eq(IX.decodeText('0x' + w(32) + w(1000)), '', 'length runs past the data');
  eq(IX.decodeText('0xzz'), '');
});

test('decodeText: hidden characters kept, control characters dropped, long names capped', () => {
  eq(IX.decodeText(abiString('U⁠S⁠DG')), 'U⁠S⁠DG', 'word joiners stay (the copy check shows them)');
  eq(IX.decodeText(abiString('U⁯S⁯DG')), 'U⁯S⁯DG');
  eq(IX.decodeText(abiString('\u0000AB\nC\u0007 ')), 'ABC');
  eq(IX.decodeText(abiString('  spaced  ')), 'spaced');
  const long = 'x'.repeat(250);
  eq(IX.decodeText(abiString(long)).length, IX.MAX_TEXT);
  eq(Array.from(IX.decodeText(abiString('🚀'.repeat(250)))).length, IX.MAX_TEXT, 'cap counts characters, not halves');
});

test('utf8Decode: bad bytes become U+FFFD exactly like Python errors="replace"', () => {
  const F = '�';
  eq(IX.utf8Decode([0xe0, 0x80]), F + F);
  eq(IX.utf8Decode([0xf0, 0x9f, 0x98]), F);
  eq(IX.utf8Decode([0x61, 0x62, 0x63, 0xff]), 'abc' + F);
  eq(IX.utf8Decode([0xed, 0xa0, 0x80, 0x78]), F + F + F + 'x');
  eq(IX.utf8Decode([0xc3, 0xa9]), 'é');
  eq(IX.utf8Decode([0xf0, 0x9f, 0x9a, 0x80]), '🚀');
});

test('aggregate3: calldata layout and answers (incl. a failed call)', () => {
  const t1 = '0x' + '1'.repeat(40), t2 = '0x' + '2'.repeat(40);
  const data = IX.encodeAggregate3([{ target: t1, data: E.SEL_NAME }, { target: t2, data: E.SEL_SYMBOL }]);
  // selector, array offset, length 2, two offsets (0x40, 0x40 + 160), then two 160-byte tuples
  eq(data.slice(0, 10 + 64 * 4), E.SEL_AGGREGATE3 + w(0x20) + w(2) + w(0x40) + w(0x40 + 160));
  eq(data.length, 10 + 2 * (32 * 4 + 160 * 2));
  eq(parseAgg(data), [{ target: t1, allow: 1, sel: E.SEL_NAME }, { target: t2, allow: 1, sel: E.SEL_SYMBOL }]);
  const ans = aggResult([{ success: true, data: abiString('Pons') }, { success: false, data: '0x' }, { success: true, data: '0x' }]);
  eq(IX.decodeAggregate3(ans), [{ success: true, data: abiString('Pons') }, { success: false, data: '0x' }, { success: true, data: '0x' }]);
  let threw = false;
  try { IX.decodeAggregate3(ans.slice(0, ans.length - 64)); } catch (e) { threw = true; }
  ok(threw, 'a cut-off answer throws');
});

test('getLogsSplit: a range over the log cap is halved until every piece fits; nothing lost or doubled', async () => {
  const rows = synth(20, 50000000, 7);
  const chain = mockChain(rows, { cap: 3, head: 50001000 });
  const logs = await IX.getLogsSplit({ address: E.FACTORY_ADDRESSES, topics: [E.TOPIC_TOKEN_LAUNCHED] }, 50000000, 50000200);
  eq(logs.map((l) => IX.decodeLaunchLog(l).token), rows.map((r) => r.token));
  const gl = chain.calls.filter((c) => c.method === 'eth_getLogs');
  ok(gl.length > 7, 'split into several calls: ' + gl.length);
  ok(gl.every((c) => c.ep === 'official'), 'over-cap answers are split, not sent to another node');
});

test('fetchLaunchLogs: short range = one call for all factories; long range = per factory in <=10M pieces', async () => {
  const chain = mockChain([], { head: 90000000 });
  await IX.fetchLaunchLogs(E.FACTORY_ADDRESSES, 60000000, 60000000 + E.LOG_SPAN_MANY);
  let gl = chain.calls.filter((c) => c.method === 'eth_getLogs');
  eq(gl.length, 1);
  eq(gl[0].params[0].address, E.FACTORY_ADDRESSES);
  chain.calls.length = 0;
  await IX.fetchLaunchLogs(E.FACTORY_ADDRESSES, 30000000, 54999999);
  gl = chain.calls.filter((c) => c.method === 'eth_getLogs');
  eq(gl.length, 8 * 3, '25M blocks = 3 pieces per factory');
  ok(gl.every((c) => typeof c.params[0].address === 'string'), 'one address per call');
  ok(gl.every((c) => parseInt(c.params[0].toBlock, 16) - parseInt(c.params[0].fromBlock, 16) <= E.LOG_SPAN_ONE), 'each piece <= 10M blocks');
  eq(new Set(gl.map((c) => c.params[0].address)).size, 8);
});

test('runIndexer: the real sample is rebuilt exactly from the chain (end to end, fake D1)', async () => {
  const s = await sample();
  const [lo, hi] = span(s.rows);
  const chain = mockChain(s.rows, { head: hi + E.CONFIRMATIONS + 5 });
  const db = fakeDB();
  const res = await IX.runIndexer({ DB: db }, { fromBlock: lo, maxBlocks: hi - lo + 1, maxRows: 1000, head: hi + E.CONFIRMATIONS + 5 });
  eq(res.found, s.rows.length);
  eq(res.written, s.rows.length);
  eq(db.launches.size, s.rows.length);
  for (const r of s.rows) {
    const got = db.launches.get(r.token);
    eq(pick(got, BASE_COLS), pick(r, BASE_COLS), r.token);
    eq(got.sym_skel, skeleton(r.symbol));
    eq(got.name_skel, skeleton(r.name));
  }
  eq(db.meta.get('last_block'), String(hi));
  eq(db.meta.get('oldest_block'), String(lo));
  ok(chain.calls.filter((c) => c.method === 'eth_getTransactionByHash').length >= 1);
});

test('runIndexer: Multicall3 launches get the tx sender as dev; others need no tx lookup', async () => {
  const s = await sample();
  const mc = s.rows.find((r) => r.creator === E.MULTICALL3);
  const rows = synth(3, 70000000, 10);
  rows[1] = { ...rows[1], creator: E.MULTICALL3, tx_from: mc.tx_from };
  const chain = mockChain(rows, { head: 70001000 });
  const db = fakeDB();
  const res = await IX.runIndexer({ DB: db }, { fromBlock: 70000000, head: 70001000 });
  eq(res.viaMulticall, 1);
  const txCalls = chain.calls.filter((c) => c.method === 'eth_getTransactionByHash');
  eq(txCalls.map((c) => c.params[0]), [rows[1].tx], 'only the Multicall3 launch is looked up');
  eq(db.launches.get(rows[1].token).tx_from, mc.tx_from);
  eq(IX.devOf(db.launches.get(rows[1].token)), mc.tx_from);
  eq(db.launches.get(rows[0].token).tx_from, null);
  eq(IX.devOf(db.launches.get(rows[0].token)), rows[0].creator);
  eq(IX.devOf(s.rows.find((r) => r.token === mc.token)), mc.tx_from, 'real Multicall3 launch: dev = tx sender');
});

test('runIndexer: skeleton columns come from skeleton.js (look-alikes, hidden characters, $)', async () => {
  const rows = synth(3, 71000000, 10);
  rows[0] = { ...rows[0], name: 'U⁠S⁠DG', symbol: '$U⁯S⁯DG' };
  rows[1] = { ...rows[1], name: 'Obsyn', symbol: '$ОBSYN' };          // Cyrillic capital O
  rows[2] = { ...rows[2], name: 'ＯＢＳＹＮ', symbol: 'obsyn' };              // fullwidth
  mockChain(rows, { head: 71001000 });
  const db = fakeDB();
  await IX.runIndexer({ DB: db }, { fromBlock: 71000000, head: 71001000 });
  const got = rows.map((r) => db.launches.get(r.token));
  eq(got.map((r) => r.sym_skel), ['usdg', 'obsyn', 'obsyn']);
  eq(got.map((r) => r.name_skel), ['usdg', 'obsyn', 'obsyn']);
  eq(got[0].name, 'U⁠S⁠DG', 'the stored name keeps its hidden characters');
  ok(got.every((r) => r.sym_skel === skeleton(r.symbol) && r.name_skel === skeleton(r.name)));
});

test('runIndexer: archive node down -> names read at latest; a coin it cannot see yet is filled in later', async () => {
  const rows = synth(4, 72000000, 10);
  const chain = mockChain(rows, { head: 72001000, drpcDown: true, blind: new Set([rows[3].token]) });
  const db = fakeDB();
  const r1 = await IX.runIndexer({ DB: db }, { fromBlock: 72000000, head: 72001000 });
  eq(r1.namesUnread, 1);
  eq(db.launches.get(rows[0].token).name, 'Coin 0');
  eq(db.launches.get(rows[3].token).name, null, 'not visible yet: left empty, not guessed');
  eq(db.launches.get(rows[3].token).sym_skel, null);
  ok(chain.calls.some((c) => c.method === 'eth_call' && c.ep === 'official' && c.params[1] === 'latest'));
  chain.setOpt('blind', new Set());
  const r2 = await IX.runIndexer({ DB: db }, { head: 72001100 });
  eq(r2.pending.filled, 1);
  eq(db.launches.get(rows[3].token).name, 'Coin 3');
  eq(db.launches.get(rows[3].token).sym_skel, skeleton('C3'));
});

test('runIndexer: an unread name on a row newer than this run (backfill import) is read at its own block', async () => {
  const rows = synth(3, 72500000, 1000);
  mockChain(rows, { head: 72600000 });
  const db = fakeDB();
  db.meta.set('last_block', '72500500');          // the Worker is behind the backfill's newest rows
  db.meta.set('oldest_block', '72400000');
  for (const r of rows) db.launches.set(r.token, { ...r, name: null, symbol: null, sym_skel: null, name_skel: null });
  const res = await IX.runIndexer({ DB: db }, { head: 72600000, maxBlocks: 100 });   // blocks 72500501-72500600
  eq(res.to, 72500600);
  eq(res.pending.filled, 3);
  eq(db.launches.get(rows[2].token).name, 'Coin 2', 'not "" from reading before the coin existed');
  eq(db.launches.get(rows[2].token).sym_skel, skeleton('C2'));
});

test('runIndexer: a token whose name() reverts is stored as "" (read, nothing there), not retried', async () => {
  const rows = synth(2, 73000000, 10);
  rows[1] = { ...rows[1], name: '', symbol: '' };
  mockChain(rows, { head: 73001000 });
  const db = fakeDB();
  await IX.runIndexer({ DB: db }, { fromBlock: 73000000, head: 73001000 });
  eq(db.launches.get(rows[1].token).name, '');
  eq(db.launches.get(rows[1].token).name_skel, '');
  const r2 = await IX.runIndexer({ DB: db }, { head: 73001100 });
  eq(r2.pending.tried, 0);
});

test('runIndexer: idempotent — the same range twice gives the same table; a failed name read never wipes one', async () => {
  const rows = synth(5, 74000000, 100);
  const chain = mockChain(rows, { head: 74001000 });
  const db = fakeDB();
  await IX.runIndexer({ DB: db }, { fromBlock: 74000000, head: 74001000 });
  const first = JSON.stringify([...db.launches.values()]);
  const metaBefore = JSON.stringify([...db.meta].filter(([k]) => k !== 'last_run'));
  await IX.runIndexer({ DB: db }, { fromBlock: 74000000, head: 74001000 });
  eq(JSON.stringify([...db.launches.values()]), first);
  eq(JSON.stringify([...db.meta].filter(([k]) => k !== 'last_run')), metaBefore);
  // Third pass: every node fails eth_call -> names unknown (null) -> stored names stay.
  chain.setOpt('drpcDown', true);
  chain.setOpt('blind', new Set(rows.map((r) => r.token)));
  await IX.runIndexer({ DB: db }, { fromBlock: 74000000, head: 74001000, pending: false });
  eq(JSON.stringify([...db.launches.values()]), first);
});

test('runIndexer: cursor — continues after last_block, says up to date, never jumps over a gap', async () => {
  const rows = synth(6, 75000000, 1000);
  mockChain(rows, { head: 75010000 });
  const db = fakeDB();
  const r1 = await IX.runIndexer({ DB: db }, { fromBlock: 75000000, maxBlocks: 2500, head: 75010000 });
  eq([r1.from, r1.to, r1.written], [75000000, 75002499, 3]);
  eq(db.meta.get('last_block'), '75002499');
  eq(db.meta.get('oldest_block'), '75000000');
  const r2 = await IX.runIndexer({ DB: db }, { head: 75010000 });
  eq(r2.from, 75002500, 'starts one past last_block');
  eq(r2.written, 3);
  eq(db.meta.get('last_block'), String(75010000 - E.CONFIRMATIONS));
  const r3 = await IX.runIndexer({ DB: db }, { head: 75010000 });
  ok(r3.upToDate && r3.written === 0, 'nothing new');
  // A manual run far ahead leaves a hole behind it: last_block must not move.
  const r4 = await IX.runIndexer({ DB: db }, { fromBlock: 75009990, head: 75020000 });
  ok(r4.to > 75009990);
  eq(db.meta.get('last_block'), String(75010000 - E.CONFIRMATIONS));
  eq(db.meta.get('oldest_block'), '75000000', 'oldest_block is set once and kept');
});

test('runIndexer: empty table, no fromBlock -> starts about a minute back from the head', async () => {
  mockChain([], { head: 76000000 });
  const db = fakeDB();
  const r = await IX.runIndexer({ DB: db });                          // head read from the chain
  eq(r.head, 76000000);
  eq(r.to, 76000000 - E.CONFIRMATIONS);
  eq(r.from, 76000000 - E.CONFIRMATIONS - E.FIRST_RUN_LOOKBACK + 1);
  eq(db.meta.get('oldest_block'), String(r.from));
});

test('runIndexer: maxRows cuts at a block edge (whole blocks only) and the next run picks up the rest', async () => {
  const rows = synth(7, 77000000, 10);
  rows[3] = { ...rows[3], block: rows[2].block, log_index: 9 };      // two launches in one block
  mockChain(rows, { head: 77001000 });
  const db = fakeDB();
  const r1 = await IX.runIndexer({ DB: db }, { fromBlock: 77000000, maxRows: 3, head: 77001000 });
  eq(r1.to, rows[2].block, 'cut after the block of the 3rd launch');
  eq(r1.written, 4, 'that block is written whole');
  eq(db.meta.get('last_block'), String(rows[2].block));
  const r2 = await IX.runIndexer({ DB: db }, { head: 77001000 });
  eq(r2.from, rows[2].block + 1);
  eq(db.launches.size, 7);
});

test('runIndexer: chain failure mid-run throws and leaves the cursor where it was', async () => {
  const rows = synth(3, 78000000, 10);
  mockChain(rows, { head: 78001000, failTimes: true });
  const db = fakeDB();
  db.meta.set('last_block', '77999999');
  let err = null;
  try { await IX.runIndexer({ DB: db }, { head: 78001000 }); } catch (e) { err = e; }
  ok(err, 'throws');
  eq(db.meta.get('last_block'), '77999999');
  eq(db.launches.size, 0, 'nothing half written');
});

// ---- the API Worker's cron: dRPC in 100-block pieces (the official node refuses Cloudflare) ----------------
const WORKER = { logSpan: 100, maxLogRequests: 22, maxRows: 15, maxBlocks: 6600 };      // worker.js INDEXER_*

test('chunked (Worker): dRPC in <=100-block pieces, 3 per request, the official node never asked; same rows as the default', async () => {
  const rows = synth(7, 79000000, 300);
  const head = 79002200 + E.CONFIRMATIONS;
  const chain = mockChain(rows, { head, official429: true, avoid: ['official'] });
  const db = fakeDB();
  const r = await IX.runIndexer({ DB: db }, { fromBlock: 79000000, ...WORKER });       // head read from the chain
  eq(r.head, head);
  eq([r.from, r.to, r.written], [79000000, 79002200, 7]);
  const gl = chain.calls.filter((c) => c.method === 'eth_getLogs');
  ok(gl.every((c) => c.ep === 'drpc'), 'logs from dRPC only');
  ok(gl.every((c) => parseInt(c.params[0].toBlock, 16) - parseInt(c.params[0].fromBlock, 16) <= 99), 'pieces of at most 100 blocks');
  eq(gl.length, 23, '2,201 blocks = 23 pieces');
  eq(r.logRequests, 8, '3 pieces per request');
  ok(chain.requests.every((q) => q.ep !== 'drpc' || q.methods.length <= 3), 'dRPC batches of at most 3');
  eq(chain.requests.filter((q) => q.ep === 'official').length, 0, 'the official node is never asked when the others answer');
  for (const row of rows) eq(pick(db.launches.get(row.token), BASE_COLS), pick(row, BASE_COLS), row.token);
  eq(db.meta.get('last_block'), '79002200');
});

test('chunked (Worker): a long gap (the cron stuck since 20:37) is caught up over a few runs, each under 40 subrequests', async () => {
  const gap = 21000;                                     // ~36 minutes of chain
  const rows = synth(21, 80000000, 1000);
  const head = 80000000 + gap + E.CONFIRMATIONS;
  const chain = mockChain(rows, { head, official429: true, avoid: ['official'] });
  const db = fakeDB();
  db.meta.set('last_block', '79999999');
  db.meta.set('oldest_block', '20000000');
  const perRun = [];
  for (let i = 0; i < 10; i++) {
    const before = chain.requests.length;
    const r = await IX.runIndexer({ DB: db }, { ...WORKER });
    perRun.push(chain.requests.length - before);
    if (r.upToDate) break;
    ok(r.to - r.from + 1 <= WORKER.maxBlocks, 'at most ' + WORKER.maxBlocks + ' blocks a run');
  }
  ok(perRun.every((n) => n <= 40), 'subrequests per run: ' + perRun.join(', '));
  eq(perRun.length, 5, '4 runs to catch up 21,000 blocks, then up to date');
  eq(db.meta.get('last_block'), String(80000000 + gap));
  eq(db.launches.size, 21, 'every launch in the gap, none twice');
  for (const row of rows) eq(db.launches.get(row.token).time, row.time);
  ok(chain.calls.filter((c) => c.method === 'eth_getLogs').every((c) => c.ep === 'drpc'));
});

test('chunked (Worker): many launches stop the scan early and the run ends at a block edge (maxRows)', async () => {
  const rows = synth(40, 81000000, 20);                  // 40 launches in 800 blocks
  const chain = mockChain(rows, { head: 81005000, official429: true, avoid: ['official'] });
  const db = fakeDB();
  const r = await IX.runIndexer({ DB: db }, { fromBlock: 81000000, ...WORKER, head: 81005000 });
  eq(r.written, 15);
  eq(r.to, 81000299, 'the end of the batch that brought the 15th launch');
  eq(r.logRequests, 1, 'stopped reading once 15 launches were seen');
  ok(chain.requests.length <= 12, String(chain.requests.length));
  const r2 = await IX.runIndexer({ DB: db }, { ...WORKER, head: 81005000 });
  eq(r2.from, 81000300);
  eq(r2.written, 15);
});

test('chunked (Worker): dRPC down -> the official node as a last resort; both down mid-run -> stop at the last piece read', async () => {
  const rows = synth(5, 82000000, 100);
  let chain = mockChain(rows, { head: 82001000, drpcLogsDown: true, avoid: ['official'] });
  let db = fakeDB();
  let r = await IX.runIndexer({ DB: db }, { fromBlock: 82000000, ...WORKER, head: 82001000 });
  eq(r.written, 5);
  ok(chain.calls.some((c) => c.method === 'eth_getLogs' && c.ep === 'official'), 'official asked after dRPC failed');
  // dRPC fails from block 82000350 on and the official node refuses: the run keeps the pieces before it
  chain = mockChain(rows, { head: 82001000, drpcLogsFailFrom: 82000350, official429: true, avoid: ['official'] });
  db = fakeDB();
  db.meta.set('last_block', '81999999');
  r = await IX.runIndexer({ DB: db }, { ...WORKER, head: 82001000 });
  eq(r.to, 82000299, 'the last whole batch before the failing one');
  eq(db.meta.get('last_block'), '82000299');
  eq(db.launches.size, 3);
  // nothing readable at all: throws, the cursor stays
  chain = mockChain(rows, { head: 82001000, drpcLogsDown: true, official429: true, avoid: ['official'] });
  db = fakeDB();
  db.meta.set('last_block', '81999999');
  let err = null;
  try { await IX.runIndexer({ DB: db }, { ...WORKER, head: 82001000 }); } catch (e) { err = e; }
  ok(err, 'throws');
  eq(db.meta.get('last_block'), '81999999');
});

test('chunked (Worker): names from dRPC (archive, Multicall3 aggregate3), block times from dRPC', async () => {
  const rows = synth(3, 83000000, 50);
  const chain = mockChain(rows, { head: 83001000, official429: true, avoid: ['official'] });
  const db = fakeDB();
  await IX.runIndexer({ DB: db }, { fromBlock: 83000000, ...WORKER, head: 83001000 });
  const calls = chain.calls.filter((c) => c.method === 'eth_call');
  ok(calls.length >= 1 && calls.every((c) => c.ep === 'drpc' && c.params[1] !== 'latest'), 'archive reads on dRPC');
  ok(chain.calls.filter((c) => c.method === 'eth_getBlockByNumber').every((c) => c.ep === 'drpc'), 'block times on dRPC');
  eq([...db.launches.values()].map((x) => x.symbol), ['C0', 'C1', 'C2']);
});

test('the browser\'s factory list and floor are the same as the indexer\'s (site/src/trust/factories.js = api/src/env.js)', () => {
  eq(SF.FACTORY_ADDRESSES, E.FACTORY_ADDRESSES);
  eq(SF.INDEX_FLOOR, E.INDEX_FLOOR);
});

test('runIndexer: needs a DB binding', async () => {
  let err = null;
  try { await IX.runIndexer({}, { head: 1 }); } catch (e) { err = e; }
  ok(err && /DB/.test(err.message));
});

test('fixture skeletons equal skeleton.js today (else re-run backfill_launches.py reskel --all)', async () => {
  const s = await sample();
  const off = s.rows.filter((r) => r.sym_skel !== skeleton(r.symbol) || r.name_skel !== skeleton(r.name));
  eq(off.map((r) => r.token), []);
});
