// Launch report rules: facts read from the chain in, the report's plain-language parts out.
// Pure (no network, no DOM). api/src/report.js gathers the facts in small steps and calls these to build the
// ReportResult; a site card or the MCP tool can call buildVerdict again when wallet links arrive later.
//
// Wording rules (same as the copy check): plain and friendly, never advice. Say "observed", "flag", "can't link".
// Never "scam" or "safe". Every number in the report carries a transaction or address that proves it.
//
// Amounts come in as raw integers (decimal strings or BigInt, 18-decimal tokens) and go out as plain numbers.
import { txUrl, addressUrl, tokenUrl, duration, ethAmount } from './rules.js';

// Addresses the rules need (same values as ADDR in facts.js and POOL_MANAGER in data/constants.js; a test keeps
// them equal). Kept here so this file loads without the network modules.
export const R_ADDR = {
  ZERO: '0x0000000000000000000000000000000000000000',
  DEAD: '0x000000000000000000000000000000000000dead',
  ROUTER: '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc',
  LAUNCH_AND_BUY: '0xe33e9e479df8802cb0866d5d05258bec4cf62948',
  POOL_MANAGER: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
};

export const REPORT_DEFAULTS = {
  heavySniperPct: 10,          // first buyers together took at least this % of supply -> "heavily sniped"
  sniperPct: 3,                // ...at least this % -> "sniped"; above 0 -> "lightly sniped"
  justAfterSeconds: 60,        // a sniper's last sell this soon after graduation reads "just after"
  clusterMin: 3,               // this many first buyers in one block = a same-block group
  dustShare: 0.001,            // a wallet that kept less than 0.1% of what it got counts as "sold all"
  activityHours: 24,           // hourly activity covers the first 24 hours (curve buys, until graduation)
  maxMoves: 100,               // dev moves listed in full
};

// ---- small helpers ----------------------------------------------------------------------------------------
const big = (v) => { try { return BigInt(v == null ? 0 : v); } catch (e) { return 0n; } };
const tokensOf = (raw, dec = 18) => Number(big(raw)) / 10 ** dec;
// part / whole x 100 with 10 significant digits kept exact for huge raw numbers
export function pctOfRaw(part, whole) {
  const w = big(whole);
  if (w <= 0n) return null;
  return Number((big(part) * 10n ** 12n) / w) / 1e10;
}
const round6 = (x) => (x == null ? null : Math.round(x * 1e6) / 1e6);
export const isoOf = (unix) => (unix == null || !Number.isFinite(Number(unix)) ? null : new Date(Number(unix) * 1000).toISOString().replace('.000Z', 'Z'));
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const timeOf = (times, block) => (times && times[block] != null ? Number(times[block]) : null);
const lower = (a) => (a == null ? null : String(a).toLowerCase());

// 20.5132 -> '20.5%', 0.04 -> '0.04%', 100 -> '100%'
export function pct1(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return '?';
  if (v > 0 && v < 0.1) return (Math.round(v * 100) / 100).toString() + '%';
  return (Math.round(v * 10) / 10).toFixed(1).replace(/\.0$/, '') + '%';
}

// ---- dev moves ----------------------------------------------------------------------------------------------
// transfers: the coin's Transfer logs that touch the dev wallet, each
//   { dir: 'out'|'in', other, raw, tx, block, li }   (other = the counterparty)
// txInfo: per tx hash, what the receipt showed (see report.js receiptInfo):
//   { curveSell: raw quote out | null, curveBuy: raw quote in for the dev | null, v4Quote: raw quote | null, swap: bool }
// Out to 0x0/0x…dEaD = burn; out to the curve, the Pons router or the v4 PoolManager (or in a tx with a curve sell or
// a v4 swap) = sell; other outs = send. In from the curve, router, LaunchAndBuy or PoolManager (or in a tx with a buy)
// = buy; tokens received from other wallets are not moves (counted in `received`). The launch tx is the launch buy.
export function devMoves({ transfers = [], txInfo = {}, times = {}, curve, launchTx, grad = null, supplyRaw, quoteDecimals = 18, isEth = true, maxMoves = REPORT_DEFAULTS.maxMoves } = {}) {
  const c = lower(curve);
  const sellTo = new Set([c, R_ADDR.ROUTER, R_ADDR.POOL_MANAGER]);
  const buyFrom = new Set([c, R_ADDR.ROUTER, R_ADDR.LAUNCH_AND_BUY, R_ADDR.POOL_MANAGER]);
  const groups = new Map();      // tx|type|to -> move (several Transfer logs of one tx become one move)
  let soldRaw = 0n, receivedRaw = 0n, receivedFrom = new Set();
  const sorted = transfers.slice().sort((a, b) => a.block - b.block || (a.li || 0) - (b.li || 0));
  for (const t of sorted) {
    if (t.tx === lower(launchTx) && t.dir === 'in') continue;           // the launch buy itself
    const info = txInfo[t.tx] || null;
    const other = lower(t.other);
    let type, to;
    if (t.dir === 'out') {
      if (other === R_ADDR.ZERO || other === R_ADDR.DEAD) type = 'burn';
      else if (sellTo.has(other) || (info && (info.curveSell != null || info.swap))) type = 'sell';
      else { type = 'send'; to = other; }
    } else if (buyFrom.has(other) || (info && (info.curveBuy != null || info.swap))) type = 'buy';
    else { receivedRaw += big(t.raw); receivedFrom.add(other); continue; }
    const key = t.tx + '|' + type + '|' + (to || '');
    const g = groups.get(key) || { type, raw: 0n, to, tx: t.tx, block: t.block, li: t.li || 0 };
    g.raw += big(t.raw);
    groups.set(key, g);
    if (type === 'sell') soldRaw += big(t.raw);
  }
  const quoteOf = (g) => {
    const info = txInfo[g.tx];
    if (!info) return null;
    const raw = g.type === 'sell' ? (info.curveSell != null ? info.curveSell : info.v4Quote)
      : g.type === 'buy' ? (info.curveBuy != null ? info.curveBuy : info.v4Quote) : null;
    return raw == null ? null : tokensOf(raw, quoteDecimals);
  };
  const all = [...groups.values()].sort((a, b) => a.block - b.block || a.li - b.li);
  const moves = all.slice(0, maxMoves).map((g) => {
    const m = { type: g.type, tokens: tokensOf(g.raw), pct: round6(pctOfRaw(g.raw, supplyRaw)) };
    if (g.to) m.to = g.to;
    if (g.type === 'sell' || g.type === 'buy') {
      const q = quoteOf(g);
      if (isEth) m.eth = q; else { m.eth = null; m.quote = q; }
    }
    m.time = isoOf(timeOf(times, g.block));
    m.tx = g.tx;
    m.block = g.block;
    m.afterGraduation = !!(grad && g.block > grad.block);
    return m;
  });
  return {
    moves,
    more: Math.max(0, all.length - moves.length),
    soldRaw: soldRaw.toString(),
    soldPct: round6(pctOfRaw(soldRaw, supplyRaw)) || 0,
    received: { tokens: tokensOf(receivedRaw), wallets: [...receivedFrom] },
  };
}

// ---- first buyers ("snipers") ---------------------------------------------------------------------------------
// One wallet's tokens after its first buy, from the coin's Transfer logs touching it:
//   flow = { receivedRaw, movedRaw, sells: [{ raw, block, li, tx }] }   (sells = out to the curve, router or PoolManager)
// status: sold all (kept < dustShare of what it got) -> 'sold-on-curve' when the last sell was before graduation (or
// the coin never graduated), else 'sold-after-graduation'; sold some -> 'partly-sold'; sold none -> 'holding'.
// Tokens sent to other wallets are not counted as sold (movedPct says how much left that way).
export function sniperStatus(flow, { grad = null, times = {}, dustShare = REPORT_DEFAULTS.dustShare } = {}) {
  const received = big(flow && flow.receivedRaw);
  const moved = big(flow && flow.movedRaw);
  const sells = ((flow && flow.sells) || []).slice().sort((a, b) => a.block - b.block || (a.li || 0) - (b.li || 0));
  const sold = sells.reduce((s, x) => s + big(x.raw), 0n);
  const out = { status: 'holding', soldPct: 0, movedPct: 0 };
  if (received <= 0n) return out;
  out.soldPct = round6(Math.min(100, pctOfRaw(sold, received)));
  out.movedPct = round6(Math.min(100, pctOfRaw(moved, received)));
  if (!sells.length) return out;
  const left = received - sold - moved;
  const last = sells[sells.length - 1];
  const dust = (received * BigInt(Math.round(dustShare * 1e6))) / 1000000n;
  if (left <= dust && sold > 0n && (sold * 2n >= received || moved === 0n)) {
    out.status = grad && last.block > grad.block ? 'sold-after-graduation' : 'sold-on-curve';
  } else out.status = 'partly-sold';
  out.sellTx = last.tx;
  out.sellBlock = last.block;
  const lt = timeOf(times, last.block);
  out.sellTime = isoOf(lt);
  if (grad) {
    const after = sells.filter((x) => x.block > grad.block);
    out.soldAfterGraduationPct = round6(pctOfRaw(after.reduce((s, x) => s + big(x.raw), 0n), received));
    if (after.length && grad.time != null) {
      const ft = timeOf(times, after[0].block);
      out.firstSellAfterGraduationSeconds = ft == null ? null : ft - grad.time;
      out.secondsAfterGraduation = lt == null || last.block <= grad.block ? null : lt - grad.time;
    }
  }
  return out;
}

// Groups of `min` or more first buyers in one block.
export function sameBlockClusters(wallets, min = REPORT_DEFAULTS.clusterMin) {
  const by = new Map();
  for (const w of wallets) {
    if (!by.has(w.block)) by.set(w.block, []);
    by.get(w.block).push(w.address);
  }
  return [...by.entries()].filter(([, ws]) => ws.length >= min).sort((a, b) => a[0] - b[0]).map(([block, ws]) => ({ block, wallets: ws }));
}

// buys: [{ wallet, raw, block, tx, byDev? }] (one per wallet, the window total); flows: wallet -> flow (see sniperStatus).
// byDev = the wallet got its coins in a transaction the dev sent (the launch transaction itself, or a buy the dev paid
// for another wallet): a bundled launch, not a bot. Such wallets get boughtByDev: true and are summed in `boughtByDev`.
export function sniperReport({ buys = [], flows = {}, times = {}, launch, grad = null, supplyRaw, windowBlocks, settings = {} } = {}) {
  const o = { ...REPORT_DEFAULTS, ...settings };
  const launchTime = launch && launch.time != null ? Number(launch.time) : null;
  const wallets = buys.map((b) => {
    const t = timeOf(times, b.block);
    const st = sniperStatus(flows[b.wallet], { grad, times, dustShare: o.dustShare });
    const w = {
      address: b.wallet,
      tokens: tokensOf(b.raw),
      pct: round6(pctOfRaw(b.raw, supplyRaw)),
      block: b.block,
      blocksAfterLaunch: launch ? b.block - launch.block : null,
      secondsAfterLaunch: t == null || launchTime == null ? null : t - launchTime,
      buyTx: b.tx,
      status: st.status,
      soldPct: st.soldPct,
    };
    if (b.byDev) w.boughtByDev = true;
    if (!flows[b.wallet]) w.status = null;                             // not read yet / couldn't be read
    for (const k of ['movedPct', 'sellTx', 'sellTime', 'secondsAfterGraduation', 'firstSellAfterGraduationSeconds', 'soldAfterGraduationPct']) {
      if (st[k] != null && ((k !== 'movedPct' && k !== 'soldAfterGraduationPct') || st[k] > 0)) w[k] = st[k];
    }
    return w;
  }).sort((a, b) => a.block - b.block || (a.address < b.address ? -1 : 1));
  const total = buys.reduce((s, b) => s + big(b.raw), 0n);
  const lastT = timeOf(times, launch ? launch.block + windowBlocks : null);
  const spans = wallets.map((w) => w.secondsAfterLaunch).filter((x) => x != null);
  const out = {
    windowBlocks,
    windowSeconds: lastT == null || launchTime == null ? null : lastT - launchTime,
    totalPct: round6(pctOfRaw(total, supplyRaw)) || 0,
    spanSeconds: spans.length ? Math.max(...spans) : null,
    wallets,
    clusters: sameBlockClusters(wallets, o.clusterMin),
  };
  const dev = buys.filter((b) => b.byDev);
  if (dev.length) {
    out.boughtByDev = {
      wallets: dev.length,
      pct: round6(pctOfRaw(dev.reduce((s, b) => s + big(b.raw), 0n), supplyRaw)) || 0,
      txs: [...new Set(dev.map((b) => b.tx))],
    };
  }
  return out;
}

// ---- activity -----------------------------------------------------------------------------------------------
export const hourStart = (unix) => Math.floor(Number(unix) / 3600) * 3600;

// counts: { [hourStart unix]: { buys, newWallets } } -> every hour from the launch hour to the last hour, in order.
export function activityHours(counts, fromUnix, toUnix) {
  if (fromUnix == null || toUnix == null) return [];
  const out = [];
  for (let h = hourStart(fromUnix); h <= hourStart(toUnix) && out.length < 24 * 31; h += 3600) {
    const c = (counts && counts[h]) || { buys: 0, newWallets: 0 };
    out.push({ hourStart: isoOf(h), buys: c.buys || 0, newWallets: c.newWallets || 0 });
  }
  return out;
}

// Time of a block between two blocks whose times are known (logs carry no usable timestamp on this chain).
export function interpolateTime(block, a, b) {
  if (!a || !b || b.block === a.block) return a ? a.time : b ? b.time : null;
  return a.time + ((block - a.block) * (b.time - a.time)) / (b.block - a.block);
}

// ---- verdict ------------------------------------------------------------------------------------------------
// The sniper part: "Heavily sniped by bots (20.5% in 3 s; 8 of 9 sold before graduation, 1 just after)."
// "8 of 9 sold before graduation, 1 just after" for a list of first-buyer wallets.
function statusParts(ws, graduation, o) {
  const n = ws.length;
  const count = (s) => ws.filter((w) => w.status === s).length;
  const curve = count('sold-on-curve'), after = count('sold-after-graduation'), part = count('partly-sold'), hold = count('holding');
  const justAfter = after > 0 && ws.filter((w) => w.status === 'sold-after-graduation')
    .every((w) => w.secondsAfterGraduation != null && w.secondsAfterGraduation <= o.justAfterSeconds);
  const lead = (k) => (k === n && n > 1 ? 'all ' + n : k + ' of ' + n);
  const parts = [];
  if (curve) parts.push(lead(curve) + ' sold ' + (graduation ? 'before graduation' : 'on the curve'));
  if (after) parts.push((parts.length ? after : lead(after) + ' sold') + (justAfter ? ' just after' : ' after graduation'));
  if (part) parts.push((parts.length ? part : lead(part)) + ' partly sold');
  if (hold) parts.push((parts.length ? hold : lead(hold)) + ' still holding');
  return parts;
}

// Wallets the dev's own transaction bought for (a bundled launch) are not bots: they are left out here and told
// apart by devBundleSentence.
export function sniperSentence(snipers, graduation, settings = {}) {
  const o = { ...REPORT_DEFAULTS, ...settings };
  if (!snipers) return '';
  const all = snipers.wallets || [];
  const ws = all.filter((w) => !w.boughtByDev);
  const others = ws.length < all.length;
  if (!ws.length) return 'No ' + (others ? 'other ' : '') + 'first buyers besides the dev in the first ' + (snipers.windowSeconds != null ? duration(snipers.windowSeconds) : 'seconds') + '.';
  const p = others ? ws.reduce((s, w) => s + (Number(w.pct) || 0), 0) : Number(snipers.totalPct) || 0;
  const head = p >= o.heavySniperPct ? 'Heavily sniped by bots' : p >= o.sniperPct ? 'Sniped by bots' : 'Lightly sniped by bots';
  const n = ws.length;
  const parts = statusParts(ws, graduation, o);
  const spans = ws.map((w) => w.secondsAfterLaunch).filter((x) => x != null);
  const spanS = others ? (spans.length ? Math.max(...spans) : null) : snipers.spanSeconds;
  const span = spanS != null ? Math.max(1, Math.round(spanS)) : null;
  const who = n === 1 ? '1 wallet' : n + ' wallets';
  const first = pct1(p) + (span != null ? ' in ' + duration(span) : '') + (n === 1 || !parts.length ? ' by ' + who : '');
  return head + ' (' + first + (parts.length ? '; ' + parts.join(', ') : '') + ').';
}

// "The dev's own transaction also bought 15.3% for 4 other wallets (all 4 still holding)."
export function devBundleSentence(snipers, graduation, settings = {}) {
  const o = { ...REPORT_DEFAULTS, ...settings };
  const ws = ((snipers && snipers.wallets) || []).filter((w) => w.boughtByDev);
  if (!ws.length) return '';
  const p = ws.reduce((s, w) => s + (Number(w.pct) || 0), 0);
  const txs = new Set(ws.map((w) => w.buyTx).filter(Boolean));
  const parts = statusParts(ws, graduation, o);
  return 'The dev\'s own transaction' + (txs.size > 1 ? 's' : '') + ' also bought ' + pct1(p) + ' for '
    + plural(ws.length, 'other wallet', 'other wallets') + (parts.length ? ' (' + parts.join(', ') + ')' : '') + '.';
}

// The dev part: "Dev claimed 2.07 ETH in fees, bridged 0.18 ETH out and sold nothing."
export function devSentence(dev) {
  if (!dev || !dev.address) return 'The dev\'s moves couldn\'t be read right now.';
  const acts = [];
  const claimed = dev.fees && Number(dev.fees.claimedEth) > 0 ? Number(dev.fees.claimedEth) : 0;
  if (claimed) acts.push('claimed ' + ethAmount(claimed) + ' in fees');
  const bridged = (dev.bridges || []).reduce((s, b) => s + (Number(b.eth) || 0), 0);
  if (bridged > 0) acts.push('bridged ' + ethAmount(bridged) + ' out');
  let sold;
  if (dev.moves == null) sold = null;
  else if (!(dev.soldPct > 0)) sold = 'sold nothing';
  else {
    const buy = dev.buy && dev.buy.pct > 0 ? dev.buy.pct : null;
    const share = buy ? (dev.soldPct / buy) * 100 : null;
    const firstSell = (dev.moves || []).find((m) => m.type === 'sell');
    const fast = firstSell && dev.launchTime && firstSell.time ? (Date.parse(firstSell.time) - Date.parse(dev.launchTime)) / 1000 : null;
    if (share != null && share >= 99.5) sold = 'sold their whole launch buy' + (fast != null && fast <= 600 ? ' ' + duration(fast) + ' after launch' : '');
    else if (share != null && share <= 100) sold = 'sold ' + pct1(share) + ' of their launch buy';
    else sold = 'sold ' + pct1(dev.soldPct) + ' of supply';
  }
  if (sold) {
    if (!acts.length) return 'Dev ' + sold + '.';
    return 'Dev ' + acts.join(', ') + ' and ' + sold + '.';
  }
  return acts.length ? 'Dev ' + acts.join(' and ') + '.' : '';
}

// The wallet-links part (only when the links lookup has finished): links = walletLinks() result.
// bundled: the report already says the dev's own transaction bought for other wallets (then "No dev link found."
// would contradict it, so nothing is said when funding shows no further link). Links of kind 'same-tx' (bought in
// the dev's transaction) are that same fact, not funding.
export function linkSentence(links, { bundled = false } = {}) {
  if (!links || links.ok !== true || links.status !== 'done') return '';
  const devLinked = new Set();
  for (const l of links.links || []) {
    if (!l.involvesDev || l.strength === 'weak' || l.kind === 'same-tx') continue;   // a public service paying both within 60 s is not a link
    for (const w of l.wallets || []) if (w !== links.dev) devLinked.add(w);
  }
  if (devLinked.size) return 'Dev linked by funding to ' + plural(devLinked.size, 'first buyer', 'first buyers') + '.';
  return bundled ? '' : 'No dev link found.';
}

// report: a ReportResult (dev, snipers, graduation); links: optional finished walletLinks() result.
export function buildVerdict(report, links = null, settings = {}) {
  if (!report) return '';
  const dev = report.dev ? { ...report.dev, launchTime: report.token && report.token.pons ? report.token.pons.launchTime : null } : null;
  const bundle = devBundleSentence(report.snipers, report.graduation, settings);
  return [sniperSentence(report.snipers, report.graduation, settings), bundle, linkSentence(links, { bundled: !!bundle }), devSentence(dev)]
    .filter(Boolean).join(' ');
}

// ---- notes and caveats ------------------------------------------------------------------------------------
// "How we got this": one line per part, said once.
export function howWeGotThis({ windowBlocks = 48, viaMulticall = false, activityHours: hours = REPORT_DEFAULTS.activityHours } = {}) {
  return [
    'Launch: the coin\'s TokenLaunched event from the Pons factory, its launch transaction and the dev\'s CurveBuy in it.'
      + (viaMulticall ? ' This coin was launched through Multicall3, so the dev is the transaction sender.' : ''),
    'Dev moves: every Transfer of the coin to or from the dev wallet. To 0x0 or 0x…dEaD is a burn; to the curve, the Pons router or the Uniswap v4 PoolManager is a sell; from them is a buy; anything else is a send.',
    'Fees: Claimed events on the Pons fee escrow for the dev wallet, plus what the escrow still holds for it.',
    'Bridges: Arbitrum native-bridge withdrawals and Across deposits made by the dev, and the dev\'s MetaBridge/Relay calls (from the explorer), in the first 7 days.',
    'First buyers: CurveBuy events in the launch block and the next ' + windowBlocks + ' blocks, credited to the wallet that got the coins (never the Pons router), leaving out the dev. Wallets that got coins in a transaction the dev sent (the launch itself or a buy the dev paid for) are marked as bought by the dev. Sold or holding comes from each wallet\'s Transfers of the coin since then: to the curve, the Pons router or the v4 PoolManager is a sale, and so is a transfer to another app in a transaction that shows a sale on the curve or the coin\'s pool; anything else is "moved".',
    'Activity: CurveBuy events per hour for the first ' + hours + ' hours (until graduation), and how many of those buyers were buying for the first time. Hours are worked out from block times.',
  ];
}

export const REPORT_CAVEATS = [
  'Wallets funded through exchanges, bridges or privacy tools can\'t be linked.',
  'Fast first buyers are usually bots. We show what they did; we can\'t say who runs them.',
  'Fees are counted per dev wallet, so they can include fees from the dev\'s other coins.',
  'Bridges we can see: the Arbitrum native bridge, Across and MetaBridge/Relay. Exchanges and other bridges can\'t be seen.',
  'Facts from Robinhood Chain; not financial advice.',
];

// Proof links for the report's top level.
export function reportProof({ token, creator, launchTx, curve, graduationTx = null, escrow = null }) {
  return {
    token: tokenUrl(token),
    creator: creator ? addressUrl(creator) : null,
    launchTx: txUrl(launchTx),
    curve: curve ? addressUrl(curve) : null,
    graduationTx: graduationTx ? txUrl(graduationTx) : null,
    escrow: escrow ? addressUrl(escrow) : null,
  };
}
