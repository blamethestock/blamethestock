// Tests for the Stock-Paired Board (site/src/features/board.js): settings, the list, maths, ranking, the hide
// list, dropping failed reads, the "more than half failed" rule, one shared start/end block, and formatting.
// No network: the chain functions are swapped for fakes (opts.io).
import { suite, test, eq, near, ok } from './harness.js';
import {
  boardSettings, visibleCoins, planBoard, boardRow, rankRows, boardOutcome, loadBoard, rowView, scannedDate, BOARD_WORDS,
  readStartPrices, LOG_LANES,
} from '../../site/src/features/board.js';
import { BOARD_COINS, BOARD_SCANNED_AT } from '../../site/src/features/board-list.js';
import { STOCKS } from '../../site/src/data/stocks.js';
import { SETTINGS } from '../../site/settings.js';
import { USDG } from '../../site/src/data/constants.js';
import { sortTokens } from '../../site/src/data/chain.js';
import { fill } from '../../site/src/core/format.js';

suite('board');

// ---- a small fake chain ----------------------------------------------------------------------
const hex = (ch, n) => '0x' + ch.repeat(n);
const S1 = hex('1', 40), S2 = hex('2', 40);                     // two stock tokens
const STOCKS_FAKE = new Map([
  [S1, { symbol: 'NVDA', pool: hex('c', 64) }],                   // v4 dollar pool
  [S2, { symbol: 'TSLA', pool: hex('d', 40) }],                   // v3 dollar pool
]);
const coin = (ch, symbol, stock) => ({ symbol, address: hex(ch, 40), pool: hex(ch, 64), stock: '', stockAddress: stock });
const COINS = [coin('a', 'AAA', S1), coin('b', 'BBB', S1), coin('e', 'EEE', S1), coin('f', 'FFF', S2)];

const END = 100000, START = END - 86400, NOW = END + 10;      // block n has timestamp n (one second per block)

// price of `base` in `quote` (human units) -> sqrtPriceX96 for a pool of the two
function sqrtOf(base, quote, price, dec = { [USDG]: 6 }) {
  const [t0, t1] = sortTokens(base, quote);
  const p01 = base === t0 ? price : 1 / price;
  const d0 = dec[t0] != null ? dec[t0] : 18, d1 = dec[t1] != null ? dec[t1] : 18;
  return BigInt(Math.round(Math.sqrt(p01 / 10 ** (d0 - d1)) * 2 ** 96));
}

// prices: poolId -> { base, quote, start, end }; fail: Set of 'poolId@block'; logs: poolId -> price at START via logs
function fakeIo({ prices, fail = new Set(), zeroStart = new Set(), init = {}, logs = {}, decNull = null, decThrow = false, stale = false } = {}) {
  const seen = { blocks: new Set(), items: [], archive: [], head: 0, decimals: [] };
  const io = {
    headBlock: async () => { seen.head++; return { number: END + 5, time: END + 5 }; },
    blockTime: async (n) => (stale ? n - 1000 : n),
    blockAtTime: async (T) => Math.floor(T) + (stale ? 1000 : 0),
    tokenFacts: async (tokens) => {
      seen.decimals.push(tokens.length);
      if (decThrow) throw new Error('decimals unavailable');
      return new Map(tokens.map((t) => [t, { decimals: t === decNull ? null : t === USDG ? 6 : 18, isStock: false }]));
    },
    readSqrtMany: async (items, opts) => items.map((it) => {
      const key = it.pool.id + '@' + it.block;
      seen.blocks.add(it.block); seen.items.push(key); seen.archive.push(!!opts.archive);
      if (fail.has(key)) throw new Error('read failed ' + key);
      const p = prices[it.pool.id];
      if (!p) return 0n;
      if (it.block === START && zeroStart.has(it.pool.id)) return 0n;
      return sqrtOf(p.base, p.quote, it.block === START ? p.start : p.end);
    }),
    findInitialize: async (leg) => ({ block: init[leg.id] != null ? init[leg.id] : 1 }),
    sqrtFromLogs: async (leg, block) => {
      const p = prices[leg.id];
      return logs[leg.id] != null ? sqrtOf(p.base, p.quote, logs[leg.id]) : 0n;
    },
  };
  return { io, seen };
}

// coin moves (in its stock) and stock moves (in dollars) -> price table
function table(moves) {
  const prices = {};
  for (const c of COINS) {
    const m = moves[c.symbol];
    if (m) prices[c.pool] = { base: c.address, quote: c.stockAddress, start: 0.002, end: 0.002 * (1 + m) };
  }
  prices[hex('c', 64)] = { base: S1, quote: USDG, start: 180, end: 180 * (1 + (moves.NVDA || 0)) };
  prices[hex('d', 40)] = { base: S2, quote: USDG, start: 400, end: 400 * (1 + (moves.TSLA || 0)) };
  return prices;
}
const MOVES = { AAA: -0.10, BBB: 0.25, EEE: 0.02, FFF: -0.30, NVDA: 0.05, TSLA: -0.04 };
const run = (fake, extra = {}) => loadBoard('24h', { coins: COINS, stocks: STOCKS_FAKE, io: fake.io, now: NOW, ...extra });

// ---- settings and the list ---------------------------------------------------------------------
test('settings: switch off by default, board block has its defaults', () => {
  eq(SETTINGS.features.stockBoard, false);
  eq(SETTINGS.board.window, '24h');
  eq(SETTINGS.board.maxRows, 25);
  eq(SETTINGS.board.hide, []);
  const cfg = boardSettings(SETTINGS);
  eq([cfg.window, cfg.maxRows, cfg.hide.length], ['24h', 25, 0]);
  ok(/\{count\}/.test(cfg.words.loading), 'loading line counts the coins');
  eq(cfg.words.failed, "Couldn't load the board right now.");
});

test('settings: bad values fall back (window, rows, empty wording)', () => {
  const cfg = boardSettings({ ...SETTINGS, board: { window: '2d', maxRows: 'lots', hide: 'x', wording: { failed: '  ' } } });
  eq([cfg.window, cfg.maxRows, cfg.hide], ['24h', 25, []]);
  eq(cfg.words.failed, BOARD_WORDS.failed);
  eq(boardSettings({ ...SETTINGS, board: undefined }).window, '24h');
  eq(boardSettings({ ...SETTINGS, board: { window: '7d', maxRows: 3.7 } }).maxRows, 3);
});

test('list: every coin is well-formed and its stock has a dollar pool', () => {
  ok(BOARD_COINS.length >= 10, 'at least 10 coins');
  ok(Number.isFinite(Date.parse(BOARD_SCANNED_AT)), 'scan time');
  for (const c of BOARD_COINS) {
    ok(/^0x[0-9a-f]{40}$/.test(c.address), 'address ' + c.symbol);
    ok(/^0x([0-9a-f]{40}|[0-9a-f]{64})$/.test(c.pool), 'pool ' + c.symbol);
    const s = STOCKS.get(c.stockAddress);
    ok(s && s.pool, 'stock with a dollar pool for ' + c.symbol);
    eq(s.symbol, c.stock, 'stock ticker for ' + c.symbol);
  }
  const plan = planBoard(visibleCoins(BOARD_COINS, []), STOCKS);
  ok(plan.rows.every((r) => r.leg), 'every listed coin can be read');
  ok(plan.stockLegs.length < plan.rows.length, 'stocks shared between coins are read once');
});

test('hide list: tickers in any case, with or without $, or full addresses', () => {
  const all = visibleCoins(COINS, []);
  eq(all.length, 4);
  eq(visibleCoins(COINS, ['aaa', '$BBB']).map((c) => c.symbol), ['EEE', 'FFF']);
  eq(visibleCoins(COINS, [hex('E', 40)]).map((c) => c.symbol), ['AAA', 'BBB', 'FFF']);
  eq(visibleCoins(COINS, ['', null, 'nope']).length, 4);
  const real = visibleCoins(BOARD_COINS, []);
  const gme = real.filter((c) => c.symbol === 'GME');
  eq(gme.length, 2, 'two coins called GME');
  ok(gme.every((c) => /^0x[0-9a-f]{4}…[0-9a-f]{4}$/.test(c.tag)), 'same-name coins get a short address');
  ok(real.filter((c) => c.symbol !== 'GME').every((c) => c.tag === ''), 'others get none');
  eq(visibleCoins(BOARD_COINS, ['gme']).length, BOARD_COINS.length - 2);
});

// ---- maths, ranking, the failure rule ------------------------------------------------------------
test('row maths: the spec test case, and (1+c) = (1+q)(1+r)', () => {
  const row = boardRow(COINS[0], { start: 1, end: 0.88 / 0.95 }, { start: 100, end: 95 });
  ok(row.ok);
  near(row.c, -0.12, 1e-12); near(row.q, -0.05, 1e-12); near(row.r, 0.88 / 0.95 - 1, 1e-12);
  eq(Math.round(row.share * 100), 40);
  eq(row.caseName, 'normal');
  near(row.bar.pair, row.share, 1e-12);
  const r2 = boardRow(COINS[0], { start: 3, end: 4 }, { start: 7, end: 5 });
  near(1 + r2.c, (1 + r2.q) * (1 + r2.r), 1e-12);
});

test('row maths: missing or impossible prices are dropped, never guessed', () => {
  eq(boardRow(COINS[0], { start: 0, end: 1 }, { start: 1, end: 1 }).ok, false);
  eq(boardRow(COINS[0], { start: 1, end: NaN }, { start: 1, end: 1 }).ok, false);
  eq(boardRow(COINS[0], { start: 1, end: 1 }, null).ok, false);
  eq(boardRow(COINS[0], { start: 1, end: Infinity }, { start: 1, end: 1 }).ok, false);
});

test('ranking: biggest own move first, ties by ticker, failed rows out, capped, numbered', () => {
  const mk = (symbol, r) => ({ ok: true, coin: { symbol, address: hex(symbol[0].toLowerCase(), 40) }, r, c: r, q: 0 });
  const rows = [mk('Bee', 0.1), { ok: false, coin: {}, why: 'read' }, mk('Cat', -0.4), mk('Ant', 0.1), mk('Dog', 0.9), mk('Eel', NaN)];
  const ranked = rankRows(rows, 25);
  eq(ranked.map((x) => x.coin.symbol), ['Dog', 'Ant', 'Bee', 'Cat']);
  eq(ranked.map((x) => x.rank), [1, 2, 3, 4]);
  eq(rankRows(rows, 2).map((x) => x.coin.symbol), ['Dog', 'Ant']);
  eq(rankRows([], 5), []);
});

test('failure rule: more than half failed -> no board; young coins count neither way', () => {
  const okRow = { ok: true }, bad = { ok: false, why: 'read' }, young = { ok: false, why: 'young' };
  eq(boardOutcome([okRow, okRow, okRow, bad, bad, bad]).ok, true, 'exactly half is still shown');
  eq(boardOutcome([okRow, okRow, bad, bad, bad, bad]).ok, false, 'more than half');
  eq(boardOutcome([okRow, bad, young, young, young]).ok, true);
  eq(boardOutcome([young, young]).ok, false, 'nothing to show');
  eq(boardOutcome([okRow, bad, bad, young]), { ok: false, good: 1, failed: 2, young: 1 });
});

// ---- loading with a fake chain ------------------------------------------------------------------
test('load: every coin ranked by its own move, same maths as the card', async () => {
  const fake = fakeIo({ prices: table(MOVES) });
  const res = await run(fake);
  ok(res.ok, 'board loads: ' + res.why);
  eq(res.rows.map((x) => x.coin.symbol), ['BBB', 'EEE', 'AAA', 'FFF']);
  eq([res.good, res.failed, res.young, res.total], [4, 0, 0, 4]);
  eq([res.start.block, res.end.block, res.end.time], [START, END, END]);
  const bbb = res.rows[0];
  near(bbb.r, 0.25, 1e-9); near(bbb.q, 0.05, 1e-9); near(bbb.c, 1.05 * 1.25 - 1, 1e-9);
  eq(bbb.coin.stock, 'NVDA', 'official ticker from the stock list');
  const fff = res.rows[3];
  near(fff.r, -0.30, 1e-9); near(fff.q, -0.04, 1e-9);
  eq(fff.coin.stock, 'TSLA');
});

test('load: one shared start and end block; each stock pool read once per block', async () => {
  const fake = fakeIo({ prices: table(MOVES) });
  await run(fake);
  eq([...fake.seen.blocks].sort((a, b) => a - b), [START, END]);
  const nvdaPool = hex('c', 64);
  eq(fake.seen.items.filter((k) => k === nvdaPool + '@' + END).length, 1);
  eq(fake.seen.items.filter((k) => k === nvdaPool + '@' + START).length, 1);
  eq(fake.seen.items.length, 12, '4 coin pools + 2 stock pools, at 2 blocks');
  eq(fake.seen.head, 1, 'one head lookup');
});

test('load: a failed coin read drops only that row', async () => {
  const fake = fakeIo({ prices: table(MOVES), fail: new Set([hex('a', 64) + '@' + START]) });
  const res = await run(fake);
  ok(res.ok);
  eq(res.rows.map((x) => x.coin.symbol), ['BBB', 'EEE', 'FFF']);
  eq([res.good, res.failed], [3, 1]);
});

test('load: a failed stock read drops every coin on that stock', async () => {
  const fake = fakeIo({ prices: table(MOVES), fail: new Set([hex('d', 40) + '@' + END]) });
  const res = await run(fake);
  ok(res.ok);
  eq(res.rows.map((x) => x.coin.symbol), ['BBB', 'EEE', 'AAA']);
  eq(res.failed, 1);
});

test('load: more than half failing shows no numbers at all', async () => {
  const fake = fakeIo({ prices: table(MOVES), fail: new Set([hex('c', 64) + '@' + START]) });   // NVDA: 3 of 4 coins
  const res = await run(fake);
  eq(res.ok, false);
  eq(res.why, 'failed');
  eq(res.rows, undefined, 'no rows handed out');
});

test('load: a coin younger than the window is left out (not guessed, not a failure)', async () => {
  const fake = fakeIo({ prices: table(MOVES), zeroStart: new Set([hex('b', 64)]), init: { [hex('b', 64)]: START + 50 } });
  const res = await run(fake);
  ok(res.ok);
  eq(res.rows.map((x) => x.coin.symbol), ['EEE', 'AAA', 'FFF']);
  eq([res.failed, res.young], [0, 1]);
});

test('load: archive says "no price" for an old pool -> the trade records answer', async () => {
  const fake = fakeIo({ prices: table(MOVES), zeroStart: new Set([hex('b', 64)]), init: { [hex('b', 64)]: 10 }, logs: { [hex('b', 64)]: 0.002 } });
  const res = await run(fake);
  ok(res.ok);
  const bbb = res.rows.find((x) => x.coin.symbol === 'BBB');
  near(bbb.r, 0.25, 1e-9);
  const fake2 = fakeIo({ prices: table(MOVES), zeroStart: new Set([hex('b', 64)]), init: { [hex('b', 64)]: 10 } });
  const res2 = await run(fake2);
  eq(res2.rows.some((x) => x.coin.symbol === 'BBB'), false, 'no logs either: dropped');
  eq(res2.failed, 1);
});

test('load: unreadable decimals drop those coins; no decimals at all -> no board', async () => {
  const fake = fakeIo({ prices: table(MOVES), decNull: hex('f', 40) });
  const res = await run(fake);
  ok(res.ok);
  eq(res.rows.map((x) => x.coin.symbol), ['BBB', 'EEE', 'AAA']);
  eq(res.failed, 1);
  ok(fake.seen.decimals.every((n) => n <= 6), 'decimals asked in groups of at most 6');
  const none = await run(fakeIo({ prices: table(MOVES), decThrow: true }));
  eq([none.ok, none.why], [false, 'failed']);
});

test('load: stale chain data or a dead RPC -> no board', async () => {
  const stale = await run(fakeIo({ prices: table(MOVES), stale: true }));
  eq([stale.ok, stale.why], [false, 'stale']);
  const dead = fakeIo({ prices: table(MOVES) });
  dead.io.headBlock = async () => { throw new Error('network'); };
  const res = await run(dead);
  eq([res.ok, res.why], [false, 'rpc']);
});

test('load: a pinned end block reads both ends from the archive and skips the head', async () => {
  const fake = fakeIo({ prices: table(MOVES) });
  const res = await run(fake, { endBlock: END, now: NOW + 99999 });
  ok(res.ok);
  eq(fake.seen.head, 0);
  ok(fake.seen.archive.every(Boolean), 'archive for every read');
});

test('load: the hide list keeps coins off the board', async () => {
  const fake = fakeIo({ prices: table(MOVES) });
  const res = await run(fake, { coins: visibleCoins(COINS, ['bbb']) });
  eq(res.rows.map((x) => x.coin.symbol), ['EEE', 'AAA', 'FFF']);
  eq(res.total, 3);
});

test('load: maxRows caps the rows shown', async () => {
  const cfg = boardSettings({ ...SETTINGS, board: { ...SETTINGS.board, maxRows: 2 } });
  const res = await run(fakeIo({ prices: table(MOVES) }), { cfg });
  eq(res.rows.map((x) => x.rank), [1, 2]);
  eq(res.good, 4);
});

// ---- start-block reads: archive first, swap records when it isn't answering ---------------------------
// A fake network: archive(item) -> BigInt | undefined (no answer); logs(item) -> BigInt (throws for 'boom').
function fakeNet({ archiveUp = true, archiveMiss = new Set(), logs = {}, boom = new Set() } = {}) {
  const seen = { probe: [], read: [], fromLogs: [], busy: 0, maxBusy: 0 };
  const priceOf = (it) => BigInt(it.pool.n) * 1000n;
  return {
    seen,
    net: {
      probe: async (items) => {
        seen.probe.push(items.map((it) => it.pool.n));
        return items.map((it) => (archiveUp && !archiveMiss.has(it.pool.n) ? priceOf(it) : undefined));
      },
      read: async (items) => {
        seen.read.push(items.map((it) => it.pool.n));
        return items.map((it) => (archiveMiss.has(it.pool.n) ? (logs[it.pool.n] != null ? logs[it.pool.n] : null) : priceOf(it)));
      },
      fromLogs: async (it) => {
        seen.busy++; seen.maxBusy = Math.max(seen.maxBusy, seen.busy);
        seen.fromLogs.push(it.pool.n);
        await new Promise((r) => (typeof setTimeout === 'function' ? setTimeout(r, 0) : r()));
        seen.busy--;
        if (boom.has(it.pool.n)) throw new Error('logs failed');
        return logs[it.pool.n] != null ? logs[it.pool.n] : priceOf(it);
      },
    },
  };
}
const startItems = (n) => Array.from({ length: n }, (_, i) => ({ pool: { n: i + 1, id: 'p' + (i + 1) }, block: START }));

test('start reads: the archive answers -> one probe of 3, the rest read as usual, no log searches', async () => {
  const f = fakeNet();
  const out = await readStartPrices(startItems(8), f.net);
  eq(out, [1000n, 2000n, 3000n, 4000n, 5000n, 6000n, 7000n, 8000n]);
  eq(f.seen.probe, [[1, 2, 3]]);
  eq(f.seen.read, [[4, 5, 6, 7, 8]]);
  eq(f.seen.fromLogs, []);
});

test('start reads: a probe pool the archive missed is asked again with the rest, in order', async () => {
  const f = fakeNet({ archiveMiss: new Set([2, 5]), logs: { 2: 222n } });
  const out = await readStartPrices(startItems(6), f.net);
  eq(f.seen.read, [[2, 4, 5, 6]]);
  eq(out, [1000n, 222n, 3000n, 4000n, null, 6000n], 'no answer at all -> null (the row is dropped)');
});

test('start reads: the archive not answering -> never asked again; every pool from its swap records', async () => {
  const f = fakeNet({ archiveUp: false, logs: { 4: 0n }, boom: new Set([6]) });
  const out = await readStartPrices(startItems(7), f.net);
  eq(f.seen.probe.length, 1, 'one probe only');
  eq(f.seen.read, [], 'no archive reads after a failed probe');
  eq([...f.seen.fromLogs].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7], 'each pool searched once');
  ok(f.seen.maxBusy <= LOG_LANES, 'at most ' + LOG_LANES + ' searches at a time');
  eq(out, [1000n, 2000n, 3000n, 0n, 5000n, null, 7000n], '0n (pool born later) kept; a failed search -> null');
});

test('start reads: fewer pools than one probe, and none at all', async () => {
  const f = fakeNet();
  eq(await readStartPrices(startItems(2), f.net), [1000n, 2000n]);
  eq(f.seen.read, [], 'nothing left to read');
  const g = fakeNet();
  eq(await readStartPrices([], g.net), []);
  eq(g.seen.probe, [], 'no request for an empty list');
});

test('load: start prices come from io.readStart when given (end prices still from readSqrtMany)', async () => {
  const fake = fakeIo({ prices: table(MOVES) });
  const startCalls = [];
  fake.io.readStart = async (items) => {
    startCalls.push(items.length);
    ok(items.every((it) => it.block === START), 'every start read at the shared start block');
    return Promise.all(items.map((it) => (it.pool.id === hex('a', 64) ? null : fake.io.readSqrtMany([it], { archive: true }).then((r) => r[0]))));
  };
  const res = await run(fake);
  ok(res.ok);
  eq(startCalls, [6], 'one call for all 6 pools');
  eq(fake.seen.items.filter((k) => k.endsWith('@' + END)).length, 6, 'end prices from readSqrtMany');
  eq(res.rows.map((x) => x.coin.symbol), ['BBB', 'EEE', 'FFF'], 'no start price -> row dropped');
  eq(res.failed, 1);
});

// ---- formatting -------------------------------------------------------------------------------
test('formatting: one row (reference AI/NVDA numbers)', () => {
  const row = { rank: 3, coin: { symbol: 'AI', stock: 'NVDA', address: hex('a', 40), tag: '' },
    c: -0.13574, q: 0.02094, r: -0.15347, bar: { pair: 0, coin: 1 } };
  const v = rowView(row);
  eq([v.rank, v.symbol, v.vs, v.own, v.ownArrow], ['3', 'AI', 'vs NVDA', '−15%', '↓']);
  eq([v.coinLabel, v.coinText, v.stockLabel, v.stockText], ['AI in $', '−14%', 'NVDA', '+2.1%']);
  eq(v.bar, { pair: 0, coin: 100 });
  eq(v.aria, '3. AI against NVDA: own move −15%. AI in dollars −14%, NVDA +2.1%. Opens the full split.');
});

test('formatting: small moves, flat bar, same-name tag', () => {
  const v = rowView({ rank: 1, coin: { symbol: 'GME', stock: 'GME', address: hex('a', 40), tag: '0xaaaa…aaaa' },
    c: 0.0004, q: 0.046, r: 0.0754, bar: null });
  eq([v.own, v.coinText, v.stockText, v.ownArrow], ['+7.5%', '0.0%', '+4.6%', '↑']);
  eq(v.bar, null);
  eq(v.tag, '0xaaaa…aaaa');
  const split = rowView({ rank: 2, coin: { symbol: 'X', stock: 'SPY', address: hex('b', 40) }, c: -0.12, q: -0.05, r: -0.0737,
    bar: { pair: 0.4033, coin: 0.5967 } });
  eq(split.bar, { pair: 40, coin: 60 });
  eq(rowView({ rank: 1, coin: { symbol: '', stock: 'SPY', address: hex('b', 40) }, c: 0, q: 0, r: 0, bar: null }).symbol, '0xbbbb…bbbb');
});

test('formatting: the list date', () => {
  eq(scannedDate('2026-11-13T05:19:00Z'), 'Nov 13');
  eq(scannedDate('nonsense'), '');
  ok(/^[A-Z][a-z]{2} \d{1,2}$/.test(scannedDate()), 'list date reads like "Nov 13"');
});

test('wording: loading line, and left-out notes for one coin and for several', () => {
  const W = boardSettings(SETTINGS).words;
  eq(fill(W.loading, { count: 40 }), 'Reading 40 coins from Robinhood Chain…');
  eq(fill(W.leftOutFailed, { count: 3 }), "3 more couldn't be read just now, so they're left out.");
  eq(fill(W.leftOutFailedOne, {}), "1 more couldn't be read just now, so it's left out.");
  eq(fill(W.leftOutYoung, { count: 2, window: '24h' }), "2 started trading less than 24h ago, so they're left out.");
  eq(fill(W.leftOutYoungOne, { window: '7d' }), "1 started trading less than 7d ago, so it's left out.");
  eq(fill(W.listNote, { date: scannedDate('2026-11-13T05:19:00Z') }),
    'List of coins checked on Nov 13. Coins whose main pool is paired with a Robinhood stock token.');
  for (const [k, v] of Object.entries(W)) ok(typeof v === 'string' && v.trim(), 'wording ' + k);
});
