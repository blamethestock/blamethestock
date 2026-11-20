// Blame the Stock — turns a PriceInput into the words and numbers on the card (pure: no DOM, no network).
// All sentences come from SETTINGS.wording; this file only fills in the {blanks}.
import { SETTINGS } from '../../settings.js';
import { changes, shareFromPair, classify, bar, parseWindow, WINDOW_SECONDS } from './math.js';
import { pct, pctAbs, arrow, moveWords, usd, age, asOfTime, fill } from './format.js';

const KINDS = ['stock', 'eth', 'stable', 'coin'];
const isNum = Number.isFinite;
const above0 = (x) => isNum(x) && x > 0;
const atLeast0 = (x) => isNum(x) && x >= 0;
const text = (s) => (typeof s === 'string' ? s.trim() : '');
const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const shortAddress = (a) => (a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : a);

// ErrorResult -> { ok:false, code, message }. Unknown codes get the "couldn't reach" message.
export function buildError(err, settings = SETTINGS) {
  const errors = (settings && settings.wording && settings.wording.errors) || SETTINGS.wording.errors;
  const code = err && typeof err.code === 'string' ? err.code : 'rpc-failed';
  const template = errors[code] || errors['rpc-failed'];
  const out = { ok: false, code, message: fill(template, { symbol: text(err && err.symbol) || 'that coin' }) };
  if (err && err.symbol) out.symbol = err.symbol;
  if (err && err.detail) out.detail = err.detail;
  return out;
}

// PriceInput -> Result (see SPEC 3.2). opts.locale / opts.timeZone only change the "Prices as of" clock
// (default: English, the visitor's own time zone). Input with missing or impossible prices never becomes
// numbers: it returns buildError(...) with code 'rpc-failed' instead.
const ADDR = /^0x[0-9a-fA-F]{40}$/;

export function buildResult(pi, settings = SETTINGS, opts = {}) {
  const S = settings || SETTINGS;
  if (!pi || pi.ok !== true) return buildError(pi && pi.ok === false ? pi : { code: 'rpc-failed', detail: 'no price input' }, S);
  const w = S.wording || SETTINGS.wording;
  const notesW = w.notes || {};
  const limits = S.limits || SETTINGS.limits;
  const flatEdge = (isNum(limits.flatPercent) ? limits.flatPercent : SETTINGS.limits.flatPercent) / 100;
  const lowLiq = isNum(limits.lowLiquidityUsd) ? limits.lowLiquidityUsd : SETTINGS.limits.lowLiquidityUsd;

  const coin = pi.coin || {}, pairIn = pi.pair || {}, pool = pi.pool || {};
  const kind = KINDS.includes(pairIn.kind) ? pairIn.kind : 'coin';
  const cip = pi.coinInPair;
  const pu = kind === 'stable' ? null : pi.pairUsd;   // a dollar coin is exactly $1
  const end = pi.end || {}, start = pi.start || {};
  const born = isNum(pool.createdAt) ? pool.createdAt : start.time;
  const bad = !cip || !above0(cip.start) || !atLeast0(cip.end)
    || (kind !== 'stable' && (!pu || !above0(pu.start) || !atLeast0(pu.end)))
    || !isNum(end.time) || (pi.sinceLaunch && !isNum(born));
  if (bad) return buildError({ code: 'rpc-failed', detail: 'missing or impossible prices' }, S);

  const { c, q, r } = changes({ coinInPair: cip, pairUsd: pu });
  if (!isNum(c) || !isNum(q) || !isNum(r)) return buildError({ code: 'rpc-failed', detail: 'prices out of range' }, S);

  const window = Object.prototype.hasOwnProperty.call(WINDOW_SECONDS, pi.window) ? pi.window : parseWindow(pi.window, S);
  const windowLabel = pi.sinceLaunch ? 'since launch' : window;
  const coinAddress = text(coin.address).toLowerCase();
  const pairAddress = text(pairIn.address).toLowerCase();
  const coinSym = text(coin.symbol) || shortAddress(coinAddress);
  const pairSym = text(pairIn.symbol);
  const pairShort = kind === 'eth' ? 'ETH' : pairSym || shortAddress(pairAddress);
  const nameTemplate = (w.pairNames && w.pairNames[kind]) || '{symbol}';
  const pairName = fill(nameTemplate, { ticker: pairShort, symbol: pairShort });
  // Sentence-start form: capitalise the wording, never the ticker ("the stock (NVDA)" -> "The stock (NVDA)",
  // but a coin pair called "cbBTC" stays "cbBTC", not "CbBTC").
  const PairName = fill(capital(nameTemplate), { ticker: pairShort, symbol: pairShort });
  const label = text(pool.label);
  const poolLabel = label && !/^\/|\/$/.test(label) ? label : coinSym + '/' + pairShort;   // "/WETH" when a symbol is missing

  const share = shareFromPair(c, q);
  const caseName = classify({ c, q, r, kind, share }, limits);
  const sharePct = caseName === 'flat' ? null
    : caseName === 'none' || caseName === 'opposite' || caseName === 'stable' ? 0
    : isNum(share) ? Math.round(share * 100) || 0 : 100;
  const flatLead = Math.abs(c) < flatEdge || moveWords(c) === 'flat';
  const pairMovedWhileFlat = Math.abs(q) >= flatEdge;
  const liquidity = isNum(pool.pairSideUsd) ? pool.pairSideUsd : null;

  const vars = {
    move: flatLead ? moveWords(0) : moveWords(c),   // only the share text uses {move} when flat: "is flat"
    coinPct: pct(c),
    share: sharePct === null ? null : sharePct + '%',
    pair: pairName, Pair: PairName, pairShort,
    pairPct: pct(q), pairPctAbs: pctAbs(q),
    pairMoved: moveWords(q) === 'flat' ? 'barely moved' : (q < 0 ? 'fell ' : 'rose ') + pctAbs(q),
    ownMove: moveWords(r),
    coin: coinSym, coinTag: coinSym.charAt(0) === '$' ? coinSym : '$' + coinSym,
    window: windowLabel,
    age: pi.sinceLaunch ? age(end.time - born) : null,
    liquidity: liquidity === null ? null : usd(liquidity),
    poolLabel,
    time: asOfTime(end.time, opts.locale, opts.timeZone),
    ticker: pairShort, symbol: pairShort,
  };

  const lead = fill(flatLead ? w.leadFlat : w.lead, vars);
  const blameTemplate = {
    flat: pairMovedWhileFlat ? w.flatPairMoved : w.flatPairFlat,
    stable: w.stable,
    opposite: w.opposite,
    none: w.none,
    normal: w.normal,
    'mostly-pair': w.mostlyPair,
    'pair-bigger': q < 0 ? w.pairBiggerDown : w.pairBiggerUp,
  }[caseName];
  const blame = fill(blameTemplate, vars);
  // The X post speaks as the visitor ("mine held up better"), when settings has that wording.
  const shareBlameTemplate = caseName === 'pair-bigger' ? (q < 0 ? w.sharePairBiggerDown : w.sharePairBiggerUp) : null;
  vars.blame = shareBlameTemplate ? fill(shareBlameTemplate, vars) : blame;
  const showOwnMove = caseName === 'pair-bigger' || caseName === 'opposite' || (caseName === 'flat' && pairMovedWhileFlat);
  const subline = showOwnMove ? fill(w.ownMove, vars) : '';

  const onCurve = pool.source === 'pons-curve';      // a Pons coin still on its launch curve (no pool yet)
  // A graduated Pons coin whose window starts on its launch curve and ends in its pool. Its "measured in" note says
  // so. Since launch, its window starts at the curve's birth (data/index.js curveStart), so the age is the coin's,
  // not its younger pool's: the curve sentence. The low-money line is the pool one (measured in the pool).
  const curveThenPool = pool.source === 'pons-curve-then-pool';
  const notes = [];
  const sinceLaunchW = (onCurve || curveThenPool) && notesW.sinceLaunchCurve ? notesW.sinceLaunchCurve : notesW.sinceLaunch;
  if (pi.sinceLaunch) notes.push(fill(sinceLaunchW, { ...vars, window }));   // "not the full 24h"
  // No trades = the price is old, so say so for every pair kind (a dollar pair too: its 0.0% is a stale price).
  if (pi.tradedInWindow === false) notes.push(fill(notesW.noTrades, vars));
  // Brief, logic 7: a stock token's price is its on-chain price, not the share price.
  if (kind === 'stock' && notesW.stockToken) notes.push(fill(notesW.stockToken, vars));
  notes.push(fill(onCurve && notesW.curve ? notesW.curve
    : curveThenPool && notesW.curveThenPool ? notesW.curveThenPool : notesW.pool, vars));

  const warnings = [];
  // A plain coin that copies a stock/ETH/dollar ticker (e.g. a fake "NVDA") is flagged by the data layer.
  if (pairIn.lookalike && notesW.lookalike) warnings.push(fill(notesW.lookalike, vars));
  if (liquidity === null || liquidity < lowLiq) {
    // No dollar figure for the pool: settings may add notes.lowLiquidityUnknown; until then reuse lowLiquidity.
    const lowW = onCurve && notesW.lowLiquidityCurve ? notesW.lowLiquidityCurve : notesW.lowLiquidity;
    warnings.push(liquidity !== null ? fill(lowW, vars)
      : notesW.lowLiquidityUnknown ? fill(notesW.lowLiquidityUnknown, vars)
      : fill(notesW.lowLiquidity, { ...vars, liquidity: 'an unknown amount' }));
  }

  const number = (key, label, value) => ({ key, label, value, text: pct(value), arrow: arrow(value) });
  const siteUrl = text((S.site && S.site.url) || SETTINGS.site.url).replace(/\/+$/, '');
  const block = (b) => (b && isNum(b.block) ? { block: b.block, time: b.time } : null);

  return {
    ok: true,
    coin: { address: coinAddress, symbol: coinSym },
    pair: { address: pairAddress, symbol: pairSym || pairShort, kind, name: pairName, short: pairShort },
    window, windowLabel,
    c, q, r, share, sharePct, caseName,
    bar: bar(caseName, share),
    lead, blame, verdict: lead + ' ' + blame, subline,
    headline: { value: c, text: pct(c) },
    numbers: [
      number('coin', coinSym + ' in $', c),
      number('pair', pairShort, q),
      number('own', coinSym + ' vs ' + pairShort, r),
    ],
    notes, warnings,
    asOf: end.time, asOfText: fill(w.asOf, vars),
    shareText: fill(w.shareText, vars),
    link: siteUrl + '/?ca=' + coinAddress + '&w=' + window,
    pool: { label: vars.poolLabel, pairSideUsd: liquidity },
    blocks: { start: block(start), end: block(end) },   // extra: which chain blocks the numbers come from
    // What the card's proof links point at: the coin, its pair, the pool or launch curve (only when it has its own
    // address; a v4 pool is a 32-byte id inside the PoolManager), and the window's start and end blocks.
    proof: {
      coin: ADDR.test(coinAddress) ? coinAddress : null,
      pair: ADDR.test(pairAddress) && !/^0x0{40}$/.test(pairAddress) ? pairAddress : null,
      pool: ADDR.test(text(pool.id)) ? text(pool.id).toLowerCase() : null,
      onCurve: onCurve,
      startBlock: block(start) ? block(start).block : null,
      endBlock: block(end) ? block(end).block : null,
    },
  };
}
