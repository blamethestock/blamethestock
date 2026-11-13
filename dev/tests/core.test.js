// Tests for site/src/core (math.js, format.js, verdict.js).
import { suite, test, eq, near, ok } from './harness.js';
import { SETTINGS } from '../../site/settings.js';
import {
  changes, shareFromPair, classify, bar, validateAddress, parseWindow, WINDOW_SECONDS,
} from '../../site/src/core/math.js';
import { pct, pctAbs, arrow, moveWords, usd, age, asOfTime, fill, MINUS } from '../../site/src/core/format.js';
import { buildResult, buildError } from '../../site/src/core/verdict.js';

suite('core');

const M = MINUS; // "−"
const T_END = 1794548248; // 2026-11-13T05:37:28Z = 12:37 AM in New York (EST)
const NY = { timeZone: 'America/New_York' };
const ADDR = {
  ZOLVA: '0x8e04549484d0612be8373a0263b11928a5f7681f', AI: '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18',
  SHRP: '0xb961886115fb9e4f732e20e89efd6d0406c3527f', ORBIO: '0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3',
  NOVUS: '0x5e948189807ad655dd0d180f2e3df3fa1d03cf05', STRATEGY: '0x168661c52e5922288dfb2b3f323b6cf90eb21e18',
  NVDA: '0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', MSTR: '0xec262a75e413fafd0df80480274532c79d42da09',
  ETH: '0x0000000000000000000000000000000000000000', USDG: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
};
const PAIRS = { // pair kind -> how the sentences name it
  stock: { sym: 'NVDA', name: 'the stock (NVDA)', Name: 'The stock (NVDA)', short: 'NVDA' },
  eth: { sym: 'ETH', name: 'Ethereum', Name: 'Ethereum', short: 'ETH' },
  coin: { sym: 'ORBIO', name: 'ORBIO', Name: 'ORBIO', short: 'ORBIO' },
  stable: { sym: 'USDG', name: 'the dollar', Name: 'The dollar', short: 'USDG' },
};

// A PriceInput whose prices give exactly the changes r (coin vs pair) and q (pair in $).
function input({ coin = 'ZOLVA', kind = 'eth', pairSym, r, q = 0, c, window = '24h', sinceLaunch = false,
  createdAt = null, traded = true, liq = 50000, label, coinStart = 3.7e-8, pairStart = 2811.42 } = {}) {
  if (c !== undefined) r = (1 + c) / (1 + q) - 1;
  const ps = pairSym || PAIRS[kind].sym;
  const start = sinceLaunch ? { block: 113000000, time: createdAt } : { block: 112293925, time: T_END - WINDOW_SECONDS[window] };
  return {
    ok: true,
    coin: { address: ADDR[coin] || ADDR.ZOLVA, symbol: coin, name: coin },
    pair: { address: ADDR[ps] || ADDR.ORBIO, symbol: ps, kind },
    pool: { id: '0x417e', dex: 'uniswap', label: label || coin + '/' + ps, pairSideUsd: liq, createdAt, source: 'dexscreener' },
    window, windowSeconds: WINDOW_SECONDS[window],
    start, end: { block: 113120530, time: T_END },
    sinceLaunch,
    coinInPair: { start: coinStart, end: coinStart * (1 + r) },
    pairUsd: kind === 'stable' ? null : { start: pairStart, end: pairStart * (1 + q) },
    pairVia: null,
    tradedInWindow: traded,
  };
}
const build = (o) => buildResult(input(o), SETTINGS, NY);

// ---------------------------------------------------------------- the owner's case
test("owner's case: c −12%, q −5% -> r −7.4%, share 40%", () => {
  const res = build({ coin: 'AI', kind: 'stock', c: -0.12, q: -0.05 });
  ok(res.ok, 'result is ok');
  near(res.c, -0.12, 1e-12, 'c'); near(res.q, -0.05, 1e-12, 'q'); near(res.r, -0.0736842105263158, 1e-12, 'r');
  near(res.share, 0.4012512052346536, 1e-12, 'share');
  eq(res.sharePct, 40);
  eq(res.caseName, 'normal');
  eq(res.numbers[2].text, M + '7.4%');
  eq(res.lead, "You're down 12%.");
  eq(res.blame, 'About 40% of that is the stock (NVDA).');
  eq(res.verdict, "You're down 12%. About 40% of that is the stock (NVDA).");
  eq(res.subline, '');
  eq(res.headline, { value: res.c, text: M + '12%' });
  near(res.bar.pair, 0.4012512052346536, 1e-12); near(res.bar.pair + res.bar.coin, 1, 1e-12);
});

test('SPEC share text example (ETH pair)', () => {
  const res = build({ coin: 'ZOLVA', kind: 'eth', c: -0.12, q: -0.05 });
  eq(res.shareText, 'My $ZOLVA is down 12% (24h). About 40% of that is Ethereum.');
  eq(res.link, 'https://blamethestock.xyz/?ca=' + ADDR.ZOLVA + '&w=24h');
});

// ---------------------------------------------------------------- every case, every pair kind
for (const kind of ['stock', 'eth', 'coin']) {
  const P = PAIRS[kind];
  const cases = [
    { name: 'normal', c: -0.12, q: -0.05, verdict: `You're down 12%. About 40% of that is ${P.name}.`, sub: '', bar: 0.4012512052346536 },
    { name: 'mostly-pair', c: -0.10, q: -0.10, verdict: `You're down 10%. Almost all of that is ${P.name}.`, sub: '', bar: 1 },
    { name: 'pair-bigger', c: -0.02, q: -0.06,
      verdict: `You're down 2.0%. ${P.Name} fell 6.0%, so your coin actually held up better.`,
      sub: `On its own, ZOLVA was up 4.3% against ${P.short}.`, bar: 1 },
    { name: 'pair-bigger', c: 0.02, q: 0.06,
      verdict: `You're up 2.0%. ${P.Name} rose 6.0%, so your coin actually lagged behind.`,
      sub: `On its own, ZOLVA was down 3.8% against ${P.short}.`, bar: 1 },
    { name: 'none', c: -0.12, q: -0.0003, verdict: `You're down 12%. None of that is ${P.name}. It's all the coin.`, sub: '', bar: 0 },
    { name: 'opposite', c: -0.12, q: 0.021,
      verdict: `You're down 12%. ${P.Name} went the other way (+2.1%), so none of it is ${P.name}. It's all the coin.`,
      sub: `On its own, ZOLVA was down 14% against ${P.short}.`, bar: 0 },
    { name: 'flat', c: 0.003, q: -0.064,
      verdict: `Your coin barely moved (+0.3%). ${P.Name} moved ${M}6.4% in the same time.`,
      sub: `On its own, ZOLVA was up 7.2% against ${P.short}.`, bar: null },
    { name: 'flat', c: -0.002, q: 0.001, verdict: `Your coin barely moved (${M}0.2%). Neither did ${P.name}.`, sub: '', bar: null },
  ];
  for (const k of cases) {
    test(`${kind} pair, ${k.name}: ${k.verdict}`, () => {
      const res = build({ kind, c: k.c, q: k.q });
      eq(res.caseName, k.name);
      eq(res.verdict, k.verdict);
      eq(res.subline, k.sub);
      eq(res.pair.name, P.name);
      eq(res.pair.short, P.short);
      eq(res.pair.kind, kind);
      if (k.bar === null) eq(res.bar, null);
      else { near(res.bar.pair, k.bar, 1e-12, 'bar.pair'); near(res.bar.pair + res.bar.coin, 1, 1e-12); }
    });
  }
}

test('stable pair: nothing to blame', () => {
  const res = build({ coin: 'ORBIO', kind: 'stable', c: -0.22031405499806156 });
  eq(res.caseName, 'stable');
  eq(res.verdict, "You're down 22%. It's paired with a dollar coin, so there's nothing to blame. It's all the coin.");
  eq(res.subline, '');
  eq(res.q, 0); eq(res.sharePct, 0);
  eq(res.bar, { pair: 0, coin: 1 });
  eq(res.pair.name, 'the dollar');
  eq(res.numbers[1], { key: 'pair', label: 'USDG', value: 0, text: '0.0%', arrow: '→' });
});

test('stable pair, coin barely moved', () => {
  const res = build({ coin: 'ORBIO', kind: 'stable', c: 0.003 });
  eq(res.caseName, 'stable');
  eq(res.verdict, "Your coin barely moved (+0.3%). It's paired with a dollar coin, so there's nothing to blame. It's all the coin.");
  eq(res.shareText, "My $ORBIO is flat (24h). It's paired with a dollar coin, so there's nothing to blame. It's all the coin.");
});

test('stable pair ignores any pairUsd it is given (USDG is exactly $1)', () => {
  const pi = input({ coin: 'ORBIO', kind: 'stable', c: -0.1 });
  pi.pairUsd = { start: 1, end: 1.5 };
  const res = buildResult(pi, SETTINGS, NY);
  eq(res.q, 0); near(res.c, -0.1, 1e-12);
});

test('flat coin: share text says "flat"', () => {
  eq(build({ c: 0.003, q: -0.064 }).shareText, `My $ZOLVA is flat (24h). Ethereum moved ${M}6.4% in the same time.`);
  eq(build({ c: -0.002, q: 0.001 }).shareText, 'My $ZOLVA is flat (24h). Neither did Ethereum.');
});

// ---------------------------------------------------------------- SPEC §5 reference rows
const REF = [
  { coin: 'ZOLVA', pairSym: 'ETH', kind: 'eth', c: -0.15796568698876012, q: -0.06392152800237827, r: -0.100466105993965,
    texts: [M + '16%', M + '6.4%', M + '10%'], caseName: 'normal', sharePct: 38,
    verdict: "You're down 16%. About 38% of that is Ethereum.", sub: '' },
  { coin: 'SHRP', pairSym: 'ORBIO', kind: 'coin', c: -0.2202552873338579, q: -0.22031405499806156, r: 7.53735072183126e-05,
    texts: [M + '22%', M + '22%', '0.0%'], caseName: 'mostly-pair', sharePct: 100,
    verdict: "You're down 22%. Almost all of that is ORBIO.", sub: '' },
  { coin: 'ORBIO', pairSym: 'USDG', kind: 'stable', c: -0.22031405499806156, q: 0, r: -0.22031405499806156,
    texts: [M + '22%', '0.0%', M + '22%'], caseName: 'stable', sharePct: 0,
    verdict: "You're down 22%. It's paired with a dollar coin, so there's nothing to blame. It's all the coin.", sub: '' },
  { coin: 'NOVUS', pairSym: 'ETH', kind: 'eth', c: -0.06864162194557988, q: -0.06392152800237827, r: -0.005042412665605567,
    texts: [M + '6.9%', M + '6.4%', M + '0.5%'], caseName: 'normal', sharePct: 93,
    verdict: "You're down 6.9%. About 93% of that is Ethereum.", sub: '' },
  { coin: 'AI', pairSym: 'NVDA', kind: 'stock', c: -0.1357385800120855, q: 0.020944406699038076, r: -0.1534686763383306,
    texts: [M + '14%', '+2.1%', M + '15%'], caseName: 'opposite', sharePct: 0,
    verdict: "You're down 14%. The stock (NVDA) went the other way (+2.1%), so none of it is the stock (NVDA). It's all the coin.",
    sub: 'On its own, AI was down 15% against NVDA.' },
  { coin: 'STRATEGY', pairSym: 'MSTR', kind: 'stock', c: -0.017639167618211382, q: -0.06066797580019678, r: 0.04580787950739862,
    texts: [M + '1.8%', M + '6.1%', '+4.6%'], caseName: 'pair-bigger', sharePct: 352,
    verdict: "You're down 1.8%. The stock (MSTR) fell 6.1%, so your coin actually held up better.",
    sub: 'On its own, STRATEGY was up 4.6% against MSTR.' },
];
for (const row of REF) {
  test(`reference row ${row.coin}/${row.pairSym}`, () => {
    const res = buildResult(input({ coin: row.coin, pairSym: row.pairSym, kind: row.kind, r: row.r, q: row.q,
      coinStart: 1.234567e-5, pairStart: row.kind === 'stock' ? 181.37 : row.kind === 'coin' ? 0.03234 : 3412.5 }), SETTINGS, NY);
    near(res.c, row.c, 1e-12, 'c'); near(res.q, row.q, 1e-12, 'q'); near(res.r, row.r, 1e-12, 'r');
    eq(res.numbers.map((n) => n.text), row.texts);
    eq(res.numbers.map((n) => n.label), [row.coin + ' in $', row.kind === 'eth' ? 'ETH' : row.pairSym,
      row.coin + ' vs ' + (row.kind === 'eth' ? 'ETH' : row.pairSym)]);
    eq(res.caseName, row.caseName);
    eq(res.sharePct, row.sharePct);
    eq(res.verdict, row.verdict);
    eq(res.subline, row.sub);
    eq(res.notes, ['Measured in the ' + row.coin + '/' + row.pairSym + ' pool.']);
    eq(res.asOfText, 'Prices as of 12:37 AM EST');
  });
}

// ---------------------------------------------------------------- notes, warnings, links, share text
test('since launch: note, window label, share text and link', () => {
  const res = build({ c: -0.12, q: -0.05, window: '24h', sinceLaunch: true, createdAt: T_END - 3 * 3600 - 120 });
  eq(res.window, '24h'); eq(res.windowLabel, 'since launch');
  eq(res.notes[0], "This coin's pool is only 3 hours old, so this covers its whole life, not the full 24h.");
  eq(res.shareText, 'My $ZOLVA is down 12% (since launch). About 40% of that is Ethereum.');
  eq(res.link, 'https://blamethestock.xyz/?ca=' + ADDR.ZOLVA + '&w=24h');
  const week = build({ c: 0.5, q: 0.1, window: '7d', sinceLaunch: true, createdAt: T_END - 2 * 86400 - 5 });
  eq(week.notes[0], "This coin's pool is only 2 days old, so this covers its whole life, not the full 7d.");
  eq(week.link, 'https://blamethestock.xyz/?ca=' + ADDR.ZOLVA + '&w=7d');
});

test('since launch with no createdAt uses the start block time', () => {
  const pi = input({ c: -0.1, q: -0.05, sinceLaunch: true, createdAt: T_END - 40 * 60 });
  pi.pool.createdAt = null;
  eq(buildResult(pi, SETTINGS, NY).notes[0], "This coin's pool is only 40 minutes old, so this covers its whole life, not the full 24h.");
});

test('no trades note (every pair kind, dollar pairs too), pool note always last', () => {
  const res = build({ c: -0.0639, q: -0.0639, traded: false });
  eq(res.notes, ['Nobody traded ZOLVA in this window, so its price against ETH stood still.', 'Measured in the ZOLVA/ETH pool.']);
  eq(build({ coin: 'ORBIO', kind: 'stable', c: 0, traded: false }).notes,
    ['Nobody traded ORBIO in this window, so its price against USDG stood still.', 'Measured in the ORBIO/USDG pool.']);
  eq(build({ coin: 'ORBIO', kind: 'stable', c: 0 }).notes, ['Measured in the ORBIO/USDG pool.']);
  const all = build({ c: -0.1, q: -0.1, traded: false, sinceLaunch: true, createdAt: T_END - 7200 });
  eq(all.notes.length, 3);
  eq(all.notes[2], 'Measured in the ZOLVA/ETH pool.');
});

test('low liquidity warning', () => {
  eq(build({ c: -0.1, q: -0.05, liq: 26000 }).warnings, []);
  eq(build({ c: -0.1, q: -0.05, liq: 5000 }).warnings, []);
  eq(build({ c: -0.1, q: -0.05, liq: 1400 }).warnings, ['Only $1.4k on the ETH side of its main pool, so these numbers are shaky.']);
  eq(build({ kind: 'stock', c: -0.1, q: -0.05, liq: 4999.4 }).warnings, ['Only $5k on the NVDA side of its main pool, so these numbers are shaky.']);
  eq(build({ c: -0.1, q: -0.05, liq: null }).warnings, ['Only an unknown amount on the ETH side of its main pool, so these numbers are shaky.']);
  eq(build({ c: -0.1, q: -0.05, liq: null }).pool, { label: 'ZOLVA/ETH', pairSideUsd: null });
  eq(build({ c: -0.1, q: -0.05, liq: NaN }).pool.pairSideUsd, null);
});

test('Prices as of, as-of time and blocks', () => {
  const res = build({ c: -0.1, q: -0.05 });
  eq(res.asOf, T_END);
  eq(res.asOfText, 'Prices as of 12:37 AM EST');
  eq(res.blocks, { start: { block: 112293925, time: T_END - 86400 }, end: { block: 113120530, time: T_END } });
  ok(/^Prices as of \d{1,2}:\d{2} [AP]M \S+$/.test(buildResult(input({ c: -0.1, q: -0.05 })).asOfText), 'local time zone works');
});

test('result shape matches SPEC 3.2', () => {
  const res = build({ coin: 'AI', kind: 'stock', c: -0.12, q: -0.05 });
  const keys = ['ok', 'coin', 'pair', 'window', 'windowLabel', 'c', 'q', 'r', 'share', 'sharePct', 'caseName', 'bar', 'lead',
    'blame', 'verdict', 'subline', 'headline', 'numbers', 'notes', 'warnings', 'asOf', 'asOfText', 'shareText', 'link', 'pool'];
  for (const k of keys) ok(k in res, 'has ' + k);
  eq(res.coin, { address: ADDR.AI, symbol: 'AI' });
  eq(res.pair, { address: ADDR.NVDA, symbol: 'NVDA', kind: 'stock', name: 'the stock (NVDA)', short: 'NVDA' });
  eq(res.numbers[0], { key: 'coin', label: 'AI in $', value: res.c, text: M + '12%', arrow: '↓' });
  eq(res.numbers[1], { key: 'pair', label: 'NVDA', value: res.q, text: M + '5.0%', arrow: '↓' });
  eq(res.numbers[2].label, 'AI vs NVDA');
});

test('wording comes from the settings passed in', () => {
  const custom = JSON.parse(JSON.stringify(SETTINGS));
  custom.wording.lead = 'Coin {move} over {window}.';
  custom.wording.pairNames.eth = 'ether';
  custom.wording.normal = '{share} was {pair} ({Pair}).';
  custom.site.url = 'https://example.test/';
  const res = buildResult(input({ c: -0.12, q: -0.05 }), custom, NY);
  eq(res.verdict, 'Coin down 12% over 24h. 40% was ether (Ether).');
  eq(res.link, 'https://example.test/?ca=' + ADDR.ZOLVA + '&w=24h');
});

test('symbols are inserted literally (no $& tricks, no second fill)', () => {
  const res = build({ coin: '$&{move}', c: -0.12, q: -0.05 });
  ok(res.shareText.startsWith('My $&{move} is down 12%'), res.shareText);
  eq(build({ coin: 'BLAME', c: -0.12, q: -0.05 }).shareText.slice(0, 10), 'My $BLAME ');
  const pi = input({ c: -0.12, q: -0.05 }); pi.coin.symbol = '  ';   // no symbol: short address instead
  eq(buildResult(pi, SETTINGS, NY).coin.symbol, '0x8e04…681f');
});

// ---------------------------------------------------------------- bad input never becomes numbers
test('impossible prices -> error, not numbers', () => {
  const bads = [
    (p) => { p.coinInPair.start = 0; }, (p) => { p.coinInPair.start = -1; }, (p) => { p.coinInPair.end = NaN; },
    (p) => { p.coinInPair.end = -0.5; }, (p) => { p.pairUsd = null; }, (p) => { p.pairUsd.start = 0; },
    (p) => { p.pairUsd.end = Infinity; }, (p) => { p.end = null; }, (p) => { delete p.coinInPair; },
    (p) => { p.coinInPair = { start: 1e-300, end: 1e300 }; },
    (p) => { p.sinceLaunch = true; p.pool.createdAt = null; p.start = null; },
  ];
  for (const f of bads) {
    const pi = input({ c: -0.1, q: -0.05 }); f(pi);
    const res = buildResult(pi, SETTINGS, NY);
    eq(res.ok, false); eq(res.code, 'rpc-failed');
    eq(res.message, SETTINGS.wording.errors['rpc-failed']);
  }
  eq(buildResult(null).code, 'rpc-failed');
  eq(buildResult({ ok: false, code: 'no-pool' }).message, SETTINGS.wording.errors['no-pool']);
});

test('buildError: every code has its message', () => {
  for (const code of Object.keys(SETTINGS.wording.errors)) {
    const e = buildError({ ok: false, code, symbol: 'NVDA' });
    eq(e.ok, false); eq(e.code, code);
    eq(e.message, SETTINGS.wording.errors[code].replace('{symbol}', 'NVDA'));
  }
  eq(buildError({ ok: false, code: 'is-pair-asset', symbol: 'USDG' }).message, "That's USDG itself. Paste a coin that trades against it.");
  eq(buildError({ ok: false, code: 'is-pair-asset' }).message, "That's that coin itself. Paste a coin that trades against it.");
  eq(buildError({ ok: false, code: 'made-up' }).message, SETTINGS.wording.errors['rpc-failed']);
  eq(buildError(undefined), { ok: false, code: 'rpc-failed', message: SETTINGS.wording.errors['rpc-failed'] });
});

// ---------------------------------------------------------------- edge cases
test('coin went to zero (c = −100%)', () => {
  const down = build({ r: -1, q: -0.05 });
  eq(down.c, -1); eq(down.caseName, 'none');
  eq(down.verdict, "You're down 100%. None of that is Ethereum. It's all the coin.");
  eq(down.bar, { pair: 0, coin: 1 });
  eq(build({ r: -1, q: 0.05 }).caseName, 'opposite');
  const both = build({ r: -1, q: -1 });
  eq(both.caseName, 'mostly-pair'); eq(both.bar, { pair: 1, coin: 0 }); eq(both.sharePct, 100);
  eq(both.verdict, "You're down 100%. Almost all of that is Ethereum.");
  eq(classify({ c: -1.5, q: 0.1, kind: 'eth' }, SETTINGS.limits), 'opposite');
  eq(classify({ c: -1.5, q: -0.1, kind: 'eth' }, SETTINGS.limits), 'none');
  eq(shareFromPair(-1.5, 0.1), null);
  eq(shareFromPair(-1, -0.05), 0);
});

test('c tiny, c exactly 0, q exactly 0', () => {
  const tiny = build({ c: 1e-12, q: 0.02 });
  eq(tiny.caseName, 'flat'); eq(tiny.lead, 'Your coin barely moved (0.0%).'); eq(tiny.bar, null); eq(tiny.sharePct, null);
  const zero = buildResult(input({ r: 0, q: 0 }), SETTINGS, NY);
  ok(Object.is(zero.c, 0) && Object.is(zero.q, 0) && Object.is(zero.r, 0), 'plain zeros');
  eq(zero.share, null);
  eq(zero.verdict, 'Your coin barely moved (0.0%). Neither did Ethereum.');
  const qZero = build({ c: -0.1, q: 0 });
  eq(qZero.caseName, 'none'); eq(qZero.verdict, "You're down 10%. None of that is Ethereum. It's all the coin.");
});

test('huge moves (+5000%)', () => {
  const big = build({ c: 50, q: 0.05 });
  eq(big.lead, "You're up 5,000%."); eq(big.caseName, 'normal'); eq(big.sharePct, 1);
  eq(big.blame, 'About 1% of that is Ethereum.');
  eq(big.numbers[2].text, '+4,757%');
  const both = build({ c: 50, q: 2 });
  eq(both.blame, 'About 28% of that is Ethereum.');
  eq(build({ c: -0.9999, q: -0.5 }).lead, "You're down 100%.");
  eq(pct(1e21), '+100,000,000,000,000,000,000,000%');
});

test('negative zero never shows as "−0"', () => {
  eq(pct(-0), '0.0%'); eq(pctAbs(-0), '0.0%'); eq(arrow(-0), '→'); eq(moveWords(-0), 'flat');
  eq(pct(-0.0004), '0.0%'); eq(moveWords(-0.0004), 'flat');
  eq(classify({ c: -0, q: -0, kind: 'eth' }, SETTINGS.limits), 'flat');
  ok(Object.is(shareFromPair(-0.1, -0), 0), 'share is +0');
  ok(Object.is(bar('none', -0).pair, 0), 'bar pair is +0');
  const ch = changes({ coinInPair: { start: 2, end: 2 }, pairUsd: { start: 3, end: 3 } });
  ok(Object.is(ch.c, 0) && Object.is(ch.q, 0) && Object.is(ch.r, 0), 'changes are +0');
});

test('share exactly at the thresholds', () => {
  const L = SETTINGS.limits;
  const at = (share) => classify({ c: 0.1, q: 0.05, kind: 'coin', share }, L);
  eq(at(0.95), 'mostly-pair'); eq(at(0.9499999), 'normal');
  eq(at(1.05), 'mostly-pair'); eq(at(1.0500001), 'pair-bigger');
  eq(at(0.005), 'normal'); eq(at(0.00499), 'none'); eq(at(0), 'none'); eq(at(-0.2), 'none'); eq(at(null), 'none');
  eq(bar('mostly-pair', 1.05), { pair: 1, coin: 0 });
  near(bar('mostly-pair', 0.95).pair, 0.95, 1e-15);
});

test('flat and opposite thresholds', () => {
  const L = SETTINGS.limits;
  eq(classify({ c: 0.005, q: 0, kind: 'eth' }, L), 'none');
  eq(classify({ c: -0.005, q: 0, kind: 'eth' }, L), 'none');
  eq(classify({ c: 0.00499, q: 0, kind: 'eth' }, L), 'flat');
  eq(classify({ c: -0.00499, q: 0.2, kind: 'eth' }, L), 'flat');
  eq(classify({ c: 0.009, q: 0, kind: 'eth' }, { flatPercent: 1 }), 'flat');
  eq(classify({ c: -0.1, q: 0.001, kind: 'eth' }, L), 'opposite');
  eq(classify({ c: -0.1, q: 0.000999, kind: 'eth' }, L), 'none');
  eq(classify({ c: 0.1, q: -0.001, kind: 'stock' }, L), 'opposite');
  eq(classify({ c: 0.001, q: 0.5, kind: 'stable' }, L), 'stable');
});

// ---------------------------------------------------------------- math pieces
test('changes() and shareFromPair()', () => {
  const ch = changes({ coinInPair: { start: 2, end: 1.76 / 0.95 }, pairUsd: { start: 10, end: 9.5 } });
  near(ch.c, -0.12, 1e-12); near(ch.q, -0.05, 1e-12); near(ch.r, -0.0736842105263158, 1e-12);
  const st = changes({ coinInPair: { start: 4, end: 3 }, pairUsd: null });
  eq(st.q, 0); near(st.c, -0.25, 1e-15); near(st.r, -0.25, 1e-15);
  near(shareFromPair(-0.12, -0.05), 0.4012512052346536, 1e-12);
  eq(shareFromPair(0, 0.05), null);
  eq(shareFromPair(0.1, -1), null);
});

test('bar() for every case', () => {
  near(bar('normal', 0.4).pair, 0.4, 1e-15); near(bar('normal', 0.4).coin, 0.6, 1e-15);
  eq(bar('mostly-pair', 1.02), { pair: 1, coin: 0 });
  eq(bar('pair-bigger', 3.5), { pair: 1, coin: 0 });
  eq(bar('none', 0.001), { pair: 0, coin: 1 });
  eq(bar('opposite', -0.14), { pair: 0, coin: 1 });
  eq(bar('stable', 0), { pair: 0, coin: 1 });
  eq(bar('flat', 3), null);
  eq(bar('nonsense', 0.5), null);
});

test('validateAddress()', () => {
  const a = '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18';
  eq(validateAddress(a), a);
  eq(validateAddress('  ' + a + '\n'), a);
  eq(validateAddress('0x2E8C31162B855A2FFA90F6F8634643AD6F111E18'), a);
  eq(validateAddress('0X2e8c31162b855a2ffa90f6f8634643ad6f111e18'), a);
  eq(validateAddress('0x2e8c3116 2b855a2f'.replace(' ', '\u00A0') + 'fa90f6f8634643ad6f111e18'), a);
  eq(validateAddress('\u200B' + a), a);
  eq(validateAddress(a.slice(0, 41)), null);       // 39 hex
  eq(validateAddress(a + 'f'), null);              // 41 hex
  eq(validateAddress(a.slice(0, 41) + 'g'), null); // non-hex
  eq(validateAddress(a.slice(2)), null);           // no 0x
  eq(validateAddress('0x'), null);
  eq(validateAddress(''), null);
  eq(validateAddress(null), null);
  eq(validateAddress(undefined), null);
  eq(validateAddress(12345), null);
  eq(validateAddress('0x2e8c31162b855a2ffa90f6f8634643ad6f111e1z'), null);
  eq(validateAddress('1x2e8c31162b855a2ffa90f6f8634643ad6f111e18'), null);
});

test('parseWindow() and WINDOW_SECONDS', () => {
  eq(WINDOW_SECONDS, { '1h': 3600, '6h': 21600, '24h': 86400, '7d': 604800 });
  eq(parseWindow('1h'), '1h'); eq(parseWindow('6H'), '6h'); eq(parseWindow(' 7d '), '7d'); eq(parseWindow('24h'), '24h');
  eq(parseWindow('2h'), '24h'); eq(parseWindow(''), '24h'); eq(parseWindow(undefined), '24h'); eq(parseWindow(null), '24h');
  eq(parseWindow(7), '24h'); eq(parseWindow('constructor'), '24h');
  eq(parseWindow('1h', { windows: ['24h', '7d'], defaultWindow: '7d' }), '7d');
  eq(parseWindow('zz', { windows: ['24h'], defaultWindow: 'nope' }), '24h');
  eq(SETTINGS.defaultWindow, '24h');
});

// ---------------------------------------------------------------- format.js
test('pct()', () => {
  eq(pct(-0.12), M + '12%'); eq(pct(0.046), '+4.6%'); eq(pct(-0.0736842), M + '7.4%'); eq(pct(0), '0.0%');
  eq(pct(0.0004), '0.0%'); eq(pct(0.0005), '+0.1%'); eq(pct(-0.0005), M + '0.1%');
  eq(pct(0.0994), '+9.9%'); eq(pct(0.0996), '+10%'); eq(pct(-0.0995), M + '10%'); eq(pct(0.1), '+10%');
  eq(pct(0.155), '+16%'); eq(pct(-1), M + '100%'); eq(pct(50), '+5,000%'); eq(pct(12.3456), '+1,235%');
  eq(pct(0.046, { sign: false }), '4.6%'); eq(pct(-0.12, { sign: false }), M + '12%'); eq(pct(0, { sign: false }), '0.0%');
  eq(pct(NaN), '—'); eq(pct(Infinity), '—'); eq(pct(undefined), '—'); eq(pct(null), '—');
});

test('pctAbs(), arrow(), moveWords()', () => {
  eq(pctAbs(-0.12), '12%'); eq(pctAbs(0.046), '4.6%'); eq(pctAbs(0.0001), '0.0%'); eq(pctAbs(NaN), '—');
  eq(arrow(0.01), '↑'); eq(arrow(-0.01), '↓'); eq(arrow(0.0004), '→'); eq(arrow(0), '→'); eq(arrow(NaN), '→');
  eq(moveWords(-0.12), 'down 12%'); eq(moveWords(0.046), 'up 4.6%'); eq(moveWords(0.0001), 'flat'); eq(moveWords(Infinity), 'flat');
});

test('usd()', () => {
  eq(usd(26000), '$26k'); eq(usd(1.4e6), '$1.4M'); eq(usd(950), '$950'); eq(usd(1400), '$1.4k');
  eq(usd(999.4), '$999'); eq(usd(999.6), '$1k'); eq(usd(9960), '$10k'); eq(usd(999999), '$1M'); eq(usd(1000), '$1k');
  eq(usd(2.5e9), '$2.5B'); eq(usd(123456789), '$123M'); eq(usd(0), '$0'); eq(usd(0.42), '$0.42'); eq(usd(4e15), '$4,000T');
  eq(usd(-1500), M + '$1.5k'); eq(usd(NaN), '—'); eq(usd(null), '—');
});

test('age()', () => {
  eq(age(3 * 3600), '3 hours'); eq(age(40 * 60), '40 minutes'); eq(age(2 * 86400), '2 days');
  eq(age(30), '1 minute'); eq(age(0), '1 minute'); eq(age(-5), '1 minute'); eq(age(NaN), '1 minute');
  eq(age(119), '1 minute'); eq(age(3599), '59 minutes'); eq(age(3600), '1 hour'); eq(age(7199), '1 hour');
  eq(age(47.9 * 3600), '47 hours'); eq(age(36 * 3600), '36 hours'); eq(age(86400), '24 hours'); eq(age(6.99 * 86400), '6 days');
});

test('asOfTime()', () => {
  eq(asOfTime(T_END, 'en-US', 'America/New_York'), '12:37 AM EST');
  eq(asOfTime(T_END, undefined, 'America/New_York'), '12:37 AM EST');
  eq(asOfTime(T_END, 'en-US', 'UTC'), '5:37 AM UTC');
  eq(asOfTime(T_END + 12 * 3600, 'en-US', 'America/Los_Angeles'), '9:37 AM PST');
  ok(/^\d{1,2}:\d{2} [AP]M \S+$/.test(asOfTime(T_END)), 'local zone: ' + asOfTime(T_END));
  ok(asOfTime(T_END, 'en-US', 'Not/AZone').length > 0, 'bad zone falls back');
  eq(asOfTime(NaN), '');
});

test('fill()', () => {
  eq(fill('You\'re {move}.', { move: 'down 12%' }), "You're down 12%.");
  eq(fill('A {x} B', { x: '$&{y}', y: 'no' }), 'A $&{y} B');
  eq(fill('Keep {unknown}', {}), 'Keep {unknown}');
  eq(fill('Null {x}', { x: null }), 'Null {x}');
  eq(fill(undefined, {}), '');
});

// ---------------------------------------------------------------- invariants on random inputs
function rng(seed) { // mulberry32: same numbers every run
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('invariant (1+c) = (1+q)(1+r) on 1000 random inputs', () => {
  const rand = rng(4663);
  for (let i = 0; i < 1000; i++) {
    const cs = Math.exp(-30 + 40 * rand()), ps = Math.exp(-10 + 20 * rand());
    const coinInPair = { start: cs, end: cs * Math.exp(-6 + 10 * rand()) };
    const pairUsd = rand() < 0.15 ? null : { start: ps, end: ps * Math.exp(-2 + 4 * rand()) };
    const { c, q, r } = changes({ coinInPair, pairUsd });
    const prod = (1 + q) * (1 + r);
    ok(Math.abs((1 + c) - prod) <= 1e-12 * Math.max(1, Math.abs(prod)), `input ${i}: c=${c} q=${q} r=${r}`);
    near(r, coinInPair.end / coinInPair.start - 1, 1e-12 * Math.max(1, Math.abs(r)), 'r is the coin-in-pair change');
  }
});

test('bar fractions sum to 1 and stay in 0..1 (1000 random results)', () => {
  const rand = rng(7);
  const names = ['flat', 'stable', 'opposite', 'none', 'normal', 'mostly-pair', 'pair-bigger'];
  for (let i = 0; i < 1000; i++) {
    const c = Math.exp(-5 + 9 * rand()) - 1, q = Math.exp(-3 + 6 * rand()) - 1;
    const kind = ['stock', 'eth', 'stable', 'coin'][i % 4];
    const share = shareFromPair(c, q);
    const caseName = classify({ c, q, r: (1 + c) / (1 + q) - 1, kind, share }, SETTINGS.limits);
    ok(names.includes(caseName), 'known case ' + caseName);
    const b = bar(caseName, share);
    if (caseName === 'flat') { eq(b, null); continue; }
    ok(b.pair >= 0 && b.pair <= 1 && b.coin >= 0 && b.coin <= 1, `fractions in range (${b.pair}, ${b.coin})`);
    near(b.pair + b.coin, 1, 1e-12, 'sum');
  }
});

test('1000 random lookups: no NaN / Infinity / undefined in any text', () => {
  const rand = rng(2026);
  const kinds = ['stock', 'eth', 'stable', 'coin'];
  const strings = (res) => [res.lead, res.blame, res.verdict, res.subline, res.headline.text, res.asOfText, res.shareText,
    res.link, res.pair.name, res.windowLabel, ...res.notes, ...res.warnings,
    ...res.numbers.flatMap((n) => [n.text, n.label, n.arrow])];
  for (let i = 0; i < 1000; i++) {
    const kind = kinds[i % 4];
    const pick = rand();
    const coinRatio = pick < 0.05 ? 0 : pick < 0.1 ? 1 : pick < 0.15 ? 51 : Math.exp(-6 + 9 * rand());
    const pairRatio = rand() < 0.1 ? 1 : Math.exp(-1.5 + 3 * rand());
    const pi = input({ kind, r: coinRatio - 1, q: pairRatio - 1, liq: rand() < 0.2 ? null : 10 ** (1 + 6 * rand()),
      window: ['1h', '6h', '24h', '7d'][i % 4], traded: rand() < 0.8,
      sinceLaunch: rand() < 0.2, createdAt: T_END - Math.floor(rand() * 3600) });
    if (!pi.sinceLaunch) pi.pool.createdAt = null;
    const res = buildResult(pi, SETTINGS, NY);
    eq(res.ok, true, 'ok for input ' + i);
    for (const s of strings(res)) {
      ok(typeof s === 'string' && !/NaN|Infinity|undefined|null|\{\w+\}|—/.test(s), `input ${i}: bad text ${JSON.stringify(s)}`);
    }
    ok(res.lead.length > 0 && res.blame.length > 0, 'has a verdict');
    const prod = (1 + res.q) * (1 + res.r);
    ok(Math.abs((1 + res.c) - prod) <= 1e-12 * Math.max(1, prod), 'invariant on the result');
    if (res.bar) near(res.bar.pair + res.bar.coin, 1, 1e-12, 'bar sum');
    ok(res.sharePct === null || Number.isInteger(res.sharePct), 'sharePct integer or null');
  }
});

// ================================================================ CORE TESTER: adversarial checks
// Expected values below were worked out separately in Python (decimal rounding, c taken straight from the
// dollar prices as (coinInPair.end × pairUsd.end) / (coinInPair.start × pairUsd.start) − 1, the SPEC 3.2 case
// rules re-implemented from the text), not by running this JS. Each row starts from raw prices, not c and q.
//   [name, kind, coin, pair, coinInPair.start, coinInPair.end, pairUsd.start, pairUsd.end, traded,
//    c, q, r, caseName, sharePct, [coin, pair, own texts], verdict, subline, shareText, bar.pair, snapshot c (SPEC §5)]
const INDEPENDENT = [
  ["ref ZOLVA", "eth", "ZOLVA", "ETH", 1.234567e-05, 1.1105348609213487e-05, 181.37, 169.77655246620867, true, -0.15796568698876, -0.06392152800237816, -0.100466105993965, "normal", 38, ["\u221216%", "\u22126.4%", "\u221210%"], "You're down 16%. About 38% of that is Ethereum.", "", "My $ZOLVA is down 16% (24h). About 38% of that is Ethereum.", 0.3841926031253037, -0.15796568698876012],
  ["ref SHRP", "coin", "SHRP", "ORBIO", 1.234567e-05, 1.234660053644686e-05, 181.37, 141.4116398450016, true, -0.2202552873338579, -0.22031405499806156, 7.53735072183126e-05, "mostly-pair", 100, ["\u221222%", "\u221222%", "0.0%"], "You're down 22%. Almost all of that is ORBIO.", "", "My $SHRP is down 22% (24h). Almost all of that is ORBIO.", 1, -0.2202552873338579],
  ["ref ORBIO", "stable", "ORBIO", "USDG", 1.234567e-05, 9.625745380632081e-06, null, null, true, -0.22031405499806156, 0.0, -0.22031405499806156, "stable", 0, ["\u221222%", "0.0%", "\u221222%"], "You're down 22%. It's paired with a dollar coin, so there's nothing to blame. It's all the coin.", "", "My $ORBIO is down 22% (24h). It's paired with a dollar coin, so there's nothing to blame. It's all the coin.", 0, -0.22031405499806156],
  ["ref NOVUS", "eth", "NOVUS", "ETH", 1.234567e-05, 1.2283418037226614e-05, 181.37, 169.77655246620867, true, -0.06864162194557955, -0.06392152800237816, -0.005042412665605567, "normal", 93, ["\u22126.9%", "\u22126.4%", "\u22120.5%"], "You're down 6.9%. About 93% of that is Ethereum.", "", "My $NOVUS is down 6.9% (24h). About 93% of that is Ethereum.", 0.9289117184159471, -0.06864162194557988],
  ["ref AI", "stock", "AI", "NVDA", 1.234567e-05, 1.0450996366590162e-05, 181.37, 185.16868704300455, true, -0.1357385800120856, 0.020944406699038076, -0.1534686763383306, "opposite", 0, ["\u221214%", "+2.1%", "\u221215%"], "You're down 14%. The stock (NVDA) went the other way (+2.1%), so none of it is the stock (NVDA). It's all the coin.", "On its own, AI was down 15% against NVDA.", "My $AI is down 14% (24h). The stock (NVDA) went the other way (+2.1%), so none of it is the stock (NVDA). It's all the coin.", 0, -0.1357385800120855],
  ["ref STRATEGY", "stock", "STRATEGY", "MSTR", 1.234567e-05, 1.2911198963798107e-05, 181.37, 170.3666492291183, true, -0.017639167618211382, -0.06066797580019678, 0.04580787950739862, "pair-bigger", 352, ["\u22121.8%", "\u22126.1%", "+4.6%"], "You're down 1.8%. The stock (MSTR) fell 6.1%, so your coin actually held up better.", "On its own, STRATEGY was up 4.6% against MSTR.", "My $STRATEGY is down 1.8% (24h). The stock (MSTR) fell 6.1%, so your coin actually held up better.", 1, -0.017639167618211382],
  ["owner -12/-5 stock", "stock", "AI", "NVDA", 3.7e-08, 3.427368421052632e-08, 2811.42, 2670.849, true, -0.11999999999999988, -0.04999999999999993, -0.07368421052631569, "normal", 40, ["\u221212%", "\u22125.0%", "\u22127.4%"], "You're down 12%. About 40% of that is the stock (NVDA).", "", "My $AI is down 12% (24h). About 40% of that is the stock (NVDA).", 0.4012512052346533, null],
  ["owner -12/-5 eth", "eth", "ZOLVA", "ETH", 3.7e-08, 3.427368421052632e-08, 2811.42, 2670.849, true, -0.11999999999999988, -0.04999999999999993, -0.07368421052631569, "normal", 40, ["\u221212%", "\u22125.0%", "\u22127.4%"], "You're down 12%. About 40% of that is Ethereum.", "", "My $ZOLVA is down 12% (24h). About 40% of that is Ethereum.", 0.4012512052346533, null],
  ["opposite c-12 q+2.1", "coin", "ZOLVA", "ORBIO", 3.7e-08, 3.189030362389814e-08, 2811.42, 2870.45982, true, -0.11999999999999988, 0.020999999999999908, -0.138099902056807, "opposite", 0, ["\u221212%", "+2.1%", "\u221214%"], "You're down 12%. ORBIO went the other way (+2.1%), so none of it is ORBIO. It's all the coin.", "On its own, ZOLVA was down 14% against ORBIO.", "My $ZOLVA is down 12% (24h). ORBIO went the other way (+2.1%), so none of it is ORBIO. It's all the coin.", 0, null],
  ["opposite c+8 q-3", "stock", "ZOLVA", "NVDA", 3.7e-08, 4.1195876288659796e-08, 2811.42, 2727.0774, true, 0.08000000000000007, -0.030000000000000027, 0.11340206185567014, "opposite", 0, ["+8.0%", "\u22123.0%", "+11%"], "You're up 8.0%. The stock (NVDA) went the other way (\u22123.0%), so none of it is the stock (NVDA). It's all the coin.", "On its own, ZOLVA was up 11% against NVDA.", "My $ZOLVA is up 8.0% (24h). The stock (NVDA) went the other way (\u22123.0%), so none of it is the stock (NVDA). It's all the coin.", 0, null],
  ["pair bigger down", "eth", "ZOLVA", "ETH", 3.7e-08, 3.8574468085106385e-08, 2811.42, 2642.7347999999997, true, -0.020000000000000018, -0.060000000000000164, 0.042553191489361764, "pair-bigger", 306, ["\u22122.0%", "\u22126.0%", "+4.3%"], "You're down 2.0%. Ethereum fell 6.0%, so your coin actually held up better.", "On its own, ZOLVA was up 4.3% against ETH.", "My $ZOLVA is down 2.0% (24h). Ethereum fell 6.0%, so your coin actually held up better.", 1, null],
  ["pair bigger up", "stock", "ZOLVA", "NVDA", 3.7e-08, 3.560377358490566e-08, 2811.42, 2980.1052000000004, true, 0.02000000000000024, 0.06000000000000005, -0.037735849056603765, "pair-bigger", 294, ["+2.0%", "+6.0%", "\u22123.8%"], "You're up 2.0%. The stock (NVDA) rose 6.0%, so your coin actually lagged behind.", "On its own, ZOLVA was down 3.8% against NVDA.", "My $ZOLVA is up 2.0% (24h). The stock (NVDA) rose 6.0%, so your coin actually lagged behind.", 1, null],
  ["pair bigger tiny same display", "eth", "ZOLVA", "ETH", 3.7e-08, 3.701041499115329e-08, 2811.42, 2796.5757024000004, true, -0.004999999999999782, -0.00527999999999984, 0.0002814862473863311, "flat", null, ["\u22120.5%", "\u22120.5%", "0.0%"], "Your coin barely moved (\u22120.5%). Ethereum moved \u22120.5% in the same time.", "On its own, ZOLVA was flat against ETH.", "My $ZOLVA is flat (24h). Ethereum moved \u22120.5% in the same time.", null, null],
  ["flat 0.499 up", "eth", "ZOLVA", "ETH", 3.7e-08, 3.6101582524271844e-08, 2811.42, 2895.7626, true, 0.00499000000000005, 0.030000000000000027, -0.024281553398058264, "flat", null, ["+0.5%", "+3.0%", "\u22122.4%"], "Your coin barely moved (+0.5%). Ethereum moved +3.0% in the same time.", "On its own, ZOLVA was down 2.4% against ETH.", "My $ZOLVA is flat (24h). Ethereum moved +3.0% in the same time.", null, null],
  ["flat edge exactly 0.5", "eth", "ZOLVA", "ETH", 3.7e-08, 3.7185e-08, 2811.42, 2811.42, true, 0.004999999999999893, 0.0, 0.004999999999999893, "flat", null, ["+0.5%", "0.0%", "+0.5%"], "Your coin barely moved (+0.5%). Neither did Ethereum.", "", "My $ZOLVA is flat (24h). Neither did Ethereum.", null, null],
  ["flat -0.499 pair flat", "coin", "ZOLVA", "ORBIO", 3.7e-08, 3.666869521912351e-08, 2811.42, 2822.66568, true, -0.004989999999999939, 0.0040000000000000036, -0.008954183266932203, "flat", null, ["\u22120.5%", "+0.4%", "\u22120.9%"], "Your coin barely moved (\u22120.5%). Neither did ORBIO.", "", "My $ZOLVA is flat (24h). Neither did ORBIO.", null, null],
  ["just over flat -0.5001", "stock", "ZOLVA", "NVDA", 3.7e-08, 3.688874048096193e-08, 2811.42, 2805.79716, true, -0.005000999999999811, -0.0020000000000000018, -0.003007014028056032, "normal", 40, ["\u22120.5%", "\u22120.2%", "\u22120.3%"], "You're down 0.5%. About 40% of that is the stock (NVDA).", "", "My $ZOLVA is down 0.5% (24h). About 40% of that is the stock (NVDA).", 0.3993186322777883, null],
  ["flat 0.49999 pair 3", "stock", "ZOLVA", "NVDA", 3.7e-08, 3.610193815533981e-08, 2811.42, 2895.7626, true, 0.004999900000000057, 0.030000000000000027, -0.024271941747572745, "flat", null, ["+0.5%", "+3.0%", "\u22122.4%"], "Your coin barely moved (+0.5%). The stock (NVDA) moved +3.0% in the same time.", "On its own, ZOLVA was down 2.4% against NVDA.", "My $ZOLVA is flat (24h). The stock (NVDA) moved +3.0% in the same time.", null, null],
  ["just over flat mostly", "eth", "ZOLVA", "ETH", 3.7e-08, 3.7004050154244204e-08, 2811.42, 2825.195958, true, 0.005009999999999959, 0.004899999999999904, 0.00010946362822172873, "mostly-pair", 98, ["+0.5%", "+0.5%", "0.0%"], "You're up 0.5%. Almost all of that is Ethereum.", "", "My $ZOLVA is up 0.5% (24h). Almost all of that is Ethereum.", 0.9780974849261739, null],
  ["share 0.9499", "eth", "ZOLVA", "ETH", 3.7e-08, 3.680520777581978e-08, 2811.42, 2543.6695418278955, true, -0.09999999999999998, -0.09523673381142073, -0.005264654707573535, "normal", 95, ["\u221210%", "\u22129.5%", "\u22120.5%"], "You're down 10%. About 95% of that is Ethereum.", "", "My $ZOLVA is down 10% (24h). About 95% of that is Ethereum.", 0.9498999999999995, null],
  ["share 0.9501", "eth", "ZOLVA", "ETH", 3.7e-08, 3.680598334712524e-08, 2811.42, 2543.6159419257106, true, -0.10000000000000009, -0.09525579887540447, -0.005243693320939435, "mostly-pair", 95, ["\u221210%", "\u22129.5%", "\u22120.5%"], "You're down 10%. Almost all of that is Ethereum.", "", "My $ZOLVA is down 10% (24h). Almost all of that is Ethereum.", 0.9501000000000002, null],
  ["share 1.0499", "stock", "ZOLVA", "NVDA", 3.7e-08, 3.66649063362402e-08, 2811.42, 3404.5374848433444, true, 0.20000000000000018, 0.21096722824883662, -0.009056585507021708, "mostly-pair", 105, ["+20%", "+21%", "\u22120.9%"], "You're up 20%. Almost all of that is the stock (NVDA).", "", "My $ZOLVA is up 20% (24h). Almost all of that is the stock (NVDA).", 1, null],
  ["share 1.0501", "stock", "ZOLVA", "NVDA", 3.7e-08, 3.666356940005499e-08, 2811.42, 3404.6616312216665, true, 0.20000000000000018, 0.21101138613998138, -0.009092718917432685, "pair-bigger", 105, ["+20%", "+21%", "\u22120.9%"], "You're up 20%. The stock (NVDA) rose 21%, so your coin actually lagged behind.", "On its own, ZOLVA was down 0.9% against NVDA.", "My $ZOLVA is up 20% (24h). The stock (NVDA) rose 21%, so your coin actually lagged behind.", 1, null],
  ["share 0.0049 none", "eth", "ZOLVA", "ETH", 3.7e-08, 1.8562940617836452e-08, 2811.42, 2801.88743102611, true, -0.4999999999999999, -0.0033906598707735824, -0.49829890222063644, "none", 0, ["\u221250%", "\u22120.3%", "\u221250%"], "You're down 50%. None of that is Ethereum. It's all the coin.", "", "My $ZOLVA is down 50% (24h). None of that is Ethereum. It's all the coin.", 0, null],
  ["share 0.0051 normal", "eth", "ZOLVA", "ETH", 3.7e-08, 1.856551416620754e-08, 2811.42, 2801.4990338737584, true, -0.5, -0.003528809685583001, -0.4982293468592557, "normal", 1, ["\u221250%", "\u22120.4%", "\u221250%"], "You're down 50%. About 1% of that is Ethereum.", "", "My $ZOLVA is down 50% (24h). About 1% of that is Ethereum.", 0.00510000000000004, null],
  ["coin to zero, pair -5", "eth", "ZOLVA", "ETH", 3.7e-08, 0.0, 2811.42, 2670.849, true, -1.0, -0.04999999999999993, -1.0, "none", 0, ["\u2212100%", "\u22125.0%", "\u2212100%"], "You're down 100%. None of that is Ethereum. It's all the coin.", "", "My $ZOLVA is down 100% (24h). None of that is Ethereum. It's all the coin.", 0, null],
  ["coin to zero, pair +5", "stock", "ZOLVA", "NVDA", 3.7e-08, 0.0, 181.37, 190.4385, true, -1.0, 0.050000000000000044, -1.0, "opposite", 0, ["\u2212100%", "+5.0%", "\u2212100%"], "You're down 100%. The stock (NVDA) went the other way (+5.0%), so none of it is the stock (NVDA). It's all the coin.", "On its own, ZOLVA was down 100% against NVDA.", "My $ZOLVA is down 100% (24h). The stock (NVDA) went the other way (+5.0%), so none of it is the stock (NVDA). It's all the coin.", 0, null],
  ["pair to zero", "coin", "ZOLVA", "ORBIO", 3.7e-08, 4e-08, 0.03, 0.0, true, -1.0, -1.0, 0.08108108108108114, "mostly-pair", 100, ["\u2212100%", "\u2212100%", "+8.1%"], "You're down 100%. Almost all of that is ORBIO.", "", "My $ZOLVA is down 100% (24h). Almost all of that is ORBIO.", 1, null],
  ["both to zero", "coin", "ZOLVA", "ORBIO", 3.7e-08, 0.0, 0.03, 0.0, true, -1.0, -1.0, -1.0, "mostly-pair", 100, ["\u2212100%", "\u2212100%", "\u2212100%"], "You're down 100%. Almost all of that is ORBIO.", "", "My $ZOLVA is down 100% (24h). Almost all of that is ORBIO.", 1, null],
  ["q = 0 exactly", "eth", "ZOLVA", "ETH", 3.7e-08, 3.33e-08, 2811.42, 2811.42, true, -0.09999999999999998, 0.0, -0.09999999999999998, "none", 0, ["\u221210%", "0.0%", "\u221210%"], "You're down 10%. None of that is Ethereum. It's all the coin.", "", "My $ZOLVA is down 10% (24h). None of that is Ethereum. It's all the coin.", 0, null],
  ["huge +5000 q+5", "eth", "ZOLVA", "ETH", 3.7e-08, 1.7971428571428572e-06, 2811.42, 2951.991, true, 50.0, 0.050000000000000044, 47.57142857142858, "normal", 1, ["+5,000%", "+5.0%", "+4,757%"], "You're up 5,000%. About 1% of that is Ethereum.", "", "My $ZOLVA is up 5,000% (24h). About 1% of that is Ethereum.", 0.012409035579643901, null],
  ["huge +1e6 q+1", "coin", "ZOLVA", "ORBIO", 3.7e-08, 0.0185000185, 2811.42, 5622.84, true, 1000000.0000000001, 1.0, 499999.5, "normal", 5, ["+100,000,000%", "+100%", "+49,999,950%"], "You're up 100,000,000%. About 5% of that is ORBIO.", "", "My $ZOLVA is up 100,000,000% (24h). About 5% of that is ORBIO.", 0.05017166231245267, null],
  ["near wipe -99.99 q-50", "eth", "ZOLVA", "ETH", 3.7e-08, 7.399999999999186e-12, 2811.42, 1405.71, true, -0.9999, -0.5, -0.9998, "normal", 8, ["\u2212100%", "\u221250%", "\u2212100%"], "You're down 100%. About 8% of that is Ethereum.", "", "My $ZOLVA is down 100% (24h). About 8% of that is Ethereum.", 0.07525749891599438, null],
  ["stable -22", "stable", "ORBIO", "USDG", 3.7e-08, 2.8860000000000002e-08, null, null, true, -0.21999999999999997, 0.0, -0.21999999999999997, "stable", 0, ["\u221222%", "0.0%", "\u221222%"], "You're down 22%. It's paired with a dollar coin, so there's nothing to blame. It's all the coin.", "", "My $ORBIO is down 22% (24h). It's paired with a dollar coin, so there's nothing to blame. It's all the coin.", 0, null],
  ["stable flat", "stable", "ORBIO", "USDG", 3.7e-08, 3.7110999999999994e-08, null, null, true, 0.0029999999999998916, 0.0, 0.0029999999999998916, "stable", 0, ["+0.3%", "0.0%", "+0.3%"], "Your coin barely moved (+0.3%). It's paired with a dollar coin, so there's nothing to blame. It's all the coin.", "", "My $ORBIO is flat (24h). It's paired with a dollar coin, so there's nothing to blame. It's all the coin.", 0, null],
  ["opp tiny q+0.09 none", "eth", "ZOLVA", "ETH", 3.7e-08, 3.253072234988511e-08, 2811.42, 2813.950278, true, -0.11999999999999988, 0.0008999999999999009, -0.12079128784094295, "none", 0, ["\u221212%", "+0.1%", "\u221212%"], "You're down 12%. None of that is Ethereum. It's all the coin.", "", "My $ZOLVA is down 12% (24h). None of that is Ethereum. It's all the coin.", 0, null],
  ["opp q exactly 0.1%", "eth", "ZOLVA", "ETH", 3.7e-08, 3.252747252747253e-08, 2811.42, 2814.2314199999996, true, -0.12, 0.0009999999999998899, -0.12087912087912078, "none", 0, ["\u221212%", "+0.1%", "\u221212%"], "You're down 12%. None of that is Ethereum. It's all the coin.", "", "My $ZOLVA is down 12% (24h). None of that is Ethereum. It's all the coin.", 0, null],
  ["none big up tiny pair", "stock", "ZOLVA", "NVDA", 3.7e-08, 1.8683168316831684e-06, 2811.42, 2839.5342, true, 50.00000000000001, 0.010000000000000009, 49.4950495049505, "none", 0, ["+5,000%", "+1.0%", "+4,950%"], "You're up 5,000%. None of that is the stock (NVDA). It's all the coin.", "", "My $ZOLVA is up 5,000% (24h). None of that is the stock (NVDA). It's all the coin.", 0, null],
  ["no trades r=0", "eth", "ZOLVA", "ETH", 3.7e-08, 3.7e-08, 2811.42, 2631.770262, false, -0.06389999999999996, -0.06390000000000007, 0.0, "mostly-pair", 100, ["\u22126.4%", "\u22126.4%", "0.0%"], "You're down 6.4%. Almost all of that is Ethereum.", "", "My $ZOLVA is down 6.4% (24h). Almost all of that is Ethereum.", 1, null],
  ["up 30 r=0", "coin", "ZOLVA", "ORBIO", 3.7e-08, 3.7e-08, 2811.42, 3654.846, true, 0.2999999999999998, 0.30000000000000004, 0.0, "mostly-pair", 100, ["+30%", "+30%", "0.0%"], "You're up 30%. Almost all of that is ORBIO.", "", "My $ZOLVA is up 30% (24h). Almost all of that is ORBIO.", 1, null],
  ["normal up", "coin", "ZOLVA", "ORBIO", 3.7e-08, 4.2045454545454545e-08, 2811.42, 3092.5620000000004, true, 0.25, 0.10000000000000009, 0.13636363636363624, "normal", 43, ["+25%", "+10%", "+14%"], "You're up 25%. About 43% of that is ORBIO.", "", "My $ZOLVA is up 25% (24h). About 43% of that is ORBIO.", 0.42712495719904586, null],
  ["pct tie 0.05", "eth", "ZOLVA", "ETH", 3.7e-08, 3.7018316831683164e-08, 2811.42, 2839.5342, true, 0.010499999999999954, 0.010000000000000009, 0.0004950495049502734, "mostly-pair", 95, ["+1.0%", "+1.0%", "0.0%"], "You're up 1.0%. Almost all of that is Ethereum.", "", "My $ZOLVA is up 1.0% (24h). Almost all of that is Ethereum.", 0.952617061739287, null],
  ["lowercase coin pair", "coin", "ZOLVA", "cbBTC", 3.7e-08, 3.189030362389814e-08, 2811.42, 2870.45982, true, -0.11999999999999988, 0.020999999999999908, -0.138099902056807, "opposite", 0, ["\u221212%", "+2.1%", "\u221214%"], "You're down 12%. cbBTC went the other way (+2.1%), so none of it is cbBTC. It's all the coin.", "On its own, ZOLVA was down 14% against cbBTC.", "My $ZOLVA is down 12% (24h). cbBTC went the other way (+2.1%), so none of it is cbBTC. It's all the coin.", 0, null],
  ["lowercase coin pair bigger", "coin", "ZOLVA", "wif", 3.7e-08, 3.8574468085106385e-08, 2811.42, 2642.7347999999997, true, -0.020000000000000018, -0.060000000000000164, 0.042553191489361764, "pair-bigger", 306, ["\u22122.0%", "\u22126.0%", "+4.3%"], "You're down 2.0%. wif fell 6.0%, so your coin actually held up better.", "On its own, ZOLVA was up 4.3% against wif.", "My $ZOLVA is down 2.0% (24h). wif fell 6.0%, so your coin actually held up better.", 1, null],
];

function rawInput(row) {
  const [, kind, sym, psym, cs, ce, ps, pe, traded] = row;
  return {
    ok: true,
    coin: { address: ADDR[sym] || ADDR.ZOLVA, symbol: sym, name: sym },
    pair: { address: ADDR[psym] || ADDR.ORBIO, symbol: psym, kind },
    pool: { id: '0x1', dex: 'uniswap', label: sym + '/' + psym, pairSideUsd: 50000, createdAt: null, source: 'dexscreener' },
    window: '24h', windowSeconds: 86400,
    start: { block: 112293925, time: T_END - 86400 }, end: { block: 113120530, time: T_END }, sinceLaunch: false,
    coinInPair: { start: cs, end: ce }, pairUsd: ps === null ? null : { start: ps, end: pe },
    pairVia: null, tradedInWindow: traded,
  };
}
const rel = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));

for (const row of INDEPENDENT) {
  const [name, , , , , , , , , c, q, r, caseName, sharePct, texts, verdict, subline, shareText, barPair, snapC] = row;
  test(`independent maths: ${name}`, () => {
    const res = buildResult(rawInput(row), SETTINGS, NY);
    eq(res.ok, true, 'ok');
    ok(rel(res.c, c), `c js=${res.c} python=${c}`);
    ok(rel(res.q, q), `q js=${res.q} python=${q}`);
    ok(rel(res.r, r), `r js=${res.r} python=${r}`);
    if (snapC !== null && snapC !== undefined) ok(rel(res.c, snapC), `c js=${res.c} SPEC snapshot=${snapC}`);
    ok(Math.abs((1 + res.c) - (1 + res.q) * (1 + res.r)) <= 1e-12, 'invariant');
    eq(res.caseName, caseName, 'caseName');
    eq(res.sharePct, sharePct, 'sharePct');
    eq(res.numbers.map((n) => n.text), texts, 'number texts');
    eq(res.numbers.map((n) => n.arrow), texts.map((t) => (t === '0.0%' ? '→' : t.charAt(0) === M ? '↓' : '↑')), 'arrows');
    eq(res.verdict, verdict, 'verdict');
    eq(res.subline, subline, 'subline');
    eq(res.shareText, shareText, 'share text');
    if (barPair === null) eq(res.bar, null, 'no bar');
    else { near(res.bar.pair, barPair, 1e-12, 'bar.pair'); near(res.bar.pair + res.bar.coin, 1, 1e-15, 'bar sum'); }
  });
}

test('a ticker is never re-cased at the start of a sentence', () => {
  const opp = build({ kind: 'coin', pairSym: 'cbBTC', c: -0.12, q: 0.021 });
  eq(opp.blame, "cbBTC went the other way (+2.1%), so none of it is cbBTC. It's all the coin.");
  eq(build({ kind: 'coin', pairSym: 'wif', c: -0.02, q: -0.06 }).blame, 'wif fell 6.0%, so your coin actually held up better.');
  eq(build({ kind: 'coin', pairSym: 'wif', c: 0.003, q: 0.064 }).blame, 'wif moved +6.4% in the same time.');
  eq(build({ kind: 'stock', c: -0.02, q: -0.06 }).blame, 'The stock (NVDA) fell 6.0%, so your coin actually held up better.');
  const custom = JSON.parse(JSON.stringify(SETTINGS));
  custom.wording.pairNames.coin = 'the coin {symbol}';
  eq(buildResult(input({ kind: 'coin', pairSym: 'wif', c: -0.02, q: -0.06 }), custom, NY).blame,
    'The coin wif fell 6.0%, so your coin actually held up better.');
});

test('pool label with a missing symbol is rebuilt', () => {
  for (const label of ['/WETH', 'ZOLVA/', '', '  ', null]) {
    const pi = input({ c: -0.1, q: -0.05 }); pi.pool.label = label;
    const res = buildResult(pi, SETTINGS, NY);
    eq(res.pool.label, 'ZOLVA/ETH', 'label ' + JSON.stringify(label));
    eq(res.notes[res.notes.length - 1], 'Measured in the ZOLVA/ETH pool.');
  }
  const noSym = input({ c: -0.1, q: -0.05 }); noSym.coin.symbol = ''; noSym.pool.label = '/WETH';
  eq(buildResult(noSym, SETTINGS, NY).pool.label, '0x8e04…681f/ETH');
});

test('asOfTime in many time zones: right clock, real minus in GMT offsets', () => {
  eq(asOfTime(T_END, 'en-US', 'Asia/Tokyo'), '2:37 PM GMT+9');
  eq(asOfTime(T_END, 'en-US', 'Asia/Kolkata'), '11:07 AM GMT+5:30');
  eq(asOfTime(T_END, 'en-US', 'America/Sao_Paulo'), '2:37 AM GMT' + M + '3');
  const nf = asOfTime(T_END, 'en-US', 'America/St_Johns');   // some browsers know "NST", others say GMT−3:30
  ok(nf === '2:07 AM NST' || nf === '2:07 AM GMT' + M + '3:30', nf);
  eq(asOfTime(T_END, 'en-US', 'America/Chicago'), '11:37 PM CST');
  eq(asOfTime(1783000000, 'en-US', 'America/New_York'), '9:46 AM EDT');           // summer time
  ok(/^5:37 AM (GMT|GMT\+0|UTC)$/.test(asOfTime(T_END, 'en-US', 'Europe/London')), asOfTime(T_END, 'en-US', 'Europe/London'));
  eq(asOfTime(T_END, 'not a locale!!', 'UTC'), '5:37 AM UTC');                   // bad locale keeps the zone
  const zones = ['America/New_York', 'America/Los_Angeles', 'America/Sao_Paulo', 'America/Bogota', 'Europe/Berlin',
    'Asia/Tokyo', 'Asia/Kolkata', 'Australia/Adelaide', 'Pacific/Chatham', 'Pacific/Pago_Pago', 'UTC', undefined];
  for (const tz of zones) {
    const s = asOfTime(T_END, undefined, tz);
    ok(/^\d{1,2}:\d{2} [AP]M \S+$/.test(s), `${tz}: ${JSON.stringify(s)}`);
    ok(!/-/.test(s) && !/[\u00A0\u202F]/.test(s), `${tz}: no hyphen-minus, no odd spaces in ${JSON.stringify(s)}`);
    const res = buildResult(input({ c: -0.1, q: -0.05 }), SETTINGS, { timeZone: tz });
    eq(res.asOfText, 'Prices as of ' + s);
  }
});

test('validateAddress() ignores copy-paste junk (bidi marks, word joiner, BOM, NBSP)', () => {
  const a = '0x2e8c31162b855a2ffa90f6f8634643ad6f111e18';
  for (const junk of ['\u200B', '\u200C', '\u200D', '\u200E', '\u200F', '\u2060', '\uFEFF', '\u00A0', '\u202A', '\u202C', '\u2066', '\u2069', '\t', '\r\n']) {
    eq(validateAddress(junk + a + junk), a, 'junk U+' + junk.charCodeAt(0).toString(16));
    eq(validateAddress(a.slice(0, 20) + junk + a.slice(20)), a, 'inside, U+' + junk.charCodeAt(0).toString(16));
  }
  eq(validateAddress('0x\u200B'), null);
  eq(validateAddress('０x2e8c31162b855a2ffa90f6f8634643ad6f111e18'), null);   // full-width zero is not hex
  eq(validateAddress('https://blamethestock.xyz/?ca=' + a), null);
});

test('every sentence, every pair kind, a grid of moves: plain, consistent, no bad characters', () => {
  const grid = [-1, -0.9999, -0.5, -0.12, -0.1, -0.06, -0.02, -0.0051, -0.005, -0.00499, -0.002, -0.0004, 0, 0.0004, 0.003,
    0.00499, 0.005, 0.0051, 0.02, 0.1, 0.25, 1, 50, 1e6];
  const qs = [-0.9, -0.2, -0.06, -0.0054, -0.004, -0.001, -0.0009, 0, 0.0009, 0.001, 0.004, 0.021, 0.064, 0.5, 3];
  const BAD = /NaN|Infinity|undefined|null|\{|\}|—|\s\s|(^|[^\w])-\d|\d-|[−+]0(\.0)?%|\.\./;
  let n = 0;
  for (const kind of ['stock', 'eth', 'stable', 'coin']) {
    for (const c of grid) for (const q of (kind === 'stable' ? [0] : qs)) {
      if (c === -1 && q === -1) continue;
      const res = buildResult(input({ kind, c, q, traded: n % 3 !== 0, liq: n % 5 ? 50000 : n % 2 ? null : 1400,
        sinceLaunch: n % 7 === 0, createdAt: T_END - 5 * 3600 }), SETTINGS, { timeZone: 'America/Sao_Paulo' });
      n++;
      eq(res.ok, true, `ok for ${kind} c=${c} q=${q}`);
      const where = `${kind} c=${c} q=${q}`;
      const sentences = [res.lead, res.blame, res.subline, ...res.notes, ...res.warnings].filter(Boolean);
      for (const s of sentences.concat([res.shareText, res.asOfText, ...res.numbers.map((x) => x.text)])) {
        ok(!BAD.test(s), `${where}: ${JSON.stringify(s)}`);
      }
      for (const s of sentences) ok(/^[A-Z0-9a-z$]/.test(s) && /\.$/.test(s), `${where}: sentence shape ${JSON.stringify(s)}`);
      ok(!/\b(NVIDIA|Nvidia|Strategy Inc|Tesla|Robinhood Markets)\b/.test(res.verdict + res.shareText), 'tickers, not company names');
      // the words agree with the numbers
      const down = res.lead.includes('down'), up = res.lead.includes('up ');
      if (down) ok(res.c < 0, `${where}: "down" but c=${res.c}`);
      if (up) ok(res.c > 0, `${where}: "up" but c=${res.c}`);
      const flatLead = res.lead.startsWith('Your coin barely moved (');
      if (res.caseName === 'flat') ok(flatLead, where);
      if (flatLead) ok(Math.abs(res.c) < SETTINGS.limits.flatPercent / 100, `${where}: "barely moved" but c=${res.c}`);
      else ok(down || up, `${where}: lead says a direction (${res.lead})`);
      if (res.caseName === 'normal') ok(res.blame.includes('About ' + res.sharePct + '% '), where);
      if (res.caseName === 'pair-bigger') ok(res.blame.includes(res.q < 0 ? ' fell ' : ' rose ') && res.q * res.c > 0, where);
      if (res.caseName === 'opposite') ok(res.q * res.c < 0 && res.blame.includes('(' + pct(res.q) + ')'), where);
      if (res.caseName === 'none') ok(res.sharePct === 0 && res.bar.pair === 0, where);
      if (res.subline) ok(res.subline.includes(res.r === 0 || !pctAbs(res.r).match(/[1-9]/) ? 'was flat against' : moveWords(res.r)), where);
      eq(res.headline.text, res.numbers[0].text, 'headline matches the coin number');
    }
  }
  ok(n > 600, 'checked ' + n + ' results');
});
