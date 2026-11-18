// Copy check rules: per-coin facts in, flags + verdict + notes + caveats out. Pure (no network, no DOM).
// Contract: CopyCheckResult in the plan (api/src/copies.js builds it, the card shows it, MCP returns it).
//
// Wording rules: plain and friendly, never advice. Say "observed", "flag", "can't link". Never "scam" or "safe".
// We never say which coin is "the real one": first does not mean real.
import { skeleton, isHiddenChar, isLookalikeChar } from './skeleton.js';

export const EXPLORER = 'https://robinhoodchain.blockscout.com';
export const txUrl = (h) => EXPLORER + '/tx/' + h;
export const addressUrl = (a) => EXPLORER + '/address/' + a;
export const tokenUrl = (a) => EXPLORER + '/token/' + a;

// Defaults for SETTINGS.trust (site/settings.js). The settings file wins when it has a value.
export const TRUST_DEFAULTS = {
  launchedJustBeforeMinutes: 60,   // same name, launched this long (or less) before the coin it copies
  devDumpPct: 90,                  // dev sold at least this % of their launch buy...
  devDumpMinutes: 10,              // ...within this many minutes of launch
  feesAndLeftMinutes: 60,          // dev claimed fees AND bridged ETH out, both within this many minutes of launch
  deadCopyUsd: 500,                // never graduated and less than this many dollars left on its curve...
  deadCopyQuietMinutes: 60,        // ...and no trades in this many minutes (keeps brand-new launches out)
  sameSnipersMin: 3,               // this many of the same first buyers on two coins
  sniperWindowBlocks: 48,          // "first buyers" = launch block + 0..48 (about 5 seconds)
  maxFacts: 12,                    // matches checked in full; the rest are listed as "more matches not shown"
  official: [],                    // [{ symbol: 'BLAME', address: '0x…' }] - empty until launch day
};

// settings may be the whole SETTINGS object (uses .trust) or the trust block itself.
export function trustSettings(settings) {
  let t = {};
  if (settings && typeof settings === 'object') {
    if (settings.trust && typeof settings.trust === 'object') t = settings.trust;
    else if (Object.keys(TRUST_DEFAULTS).some((k) => k in settings)) t = settings;
  }
  const out = { ...TRUST_DEFAULTS };
  for (const k of Object.keys(TRUST_DEFAULTS)) {
    if (k === 'official') continue;
    const v = Number(t[k]);
    if (t[k] != null && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  out.official = officialList(t.official);
  return out;
}

// Official list -> [{ symbol, address (lowercase), skeleton }]; bad entries are dropped.
export function officialList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const o of list) {
    if (!o || typeof o !== 'object') continue;
    const address = String(o.address || '').trim().toLowerCase();
    const symbol = String(o.symbol || '').trim().replace(/^\$/, '');
    if (!/^0x[0-9a-f]{40}$/.test(address) || !skeleton(symbol)) continue;
    out.push({ symbol, address, skeleton: skeleton(symbol) });
  }
  return out;
}

// ---- display helpers -------------------------------------------------------------------------------------
// Hidden and format characters are shown as '·', look-alike letters are wrapped in ‹ › so they stand out:
//   nameShown('U⁠S⁠DG') === 'U·S·DG'      nameShown('ОBSYN' with a Cyrillic О) === '‹О›BSYN'
export const HIDDEN_MARK = '·';
export function markSegments(str) {
  const segs = [];
  const push = (kind, text) => {
    const last = segs[segs.length - 1];
    if (last && last.kind === kind && kind === 'plain') last.text += text; else segs.push({ kind, text });
  };
  for (const ch of String(str == null ? '' : str)) {
    if (isHiddenChar(ch)) push('hidden', HIDDEN_MARK);
    else if (isLookalikeChar(ch)) push('lookalike', ch);
    else push('plain', ch);
  }
  return segs;
}
export function shown(str) {
  return markSegments(str).map((s) => (s.kind === 'lookalike' ? '‹' + s.text + '›' : s.text)).join('');
}
export const nameShown = shown;
export const symbolShown = shown;
// How many hidden and look-alike characters a name and symbol use together.
export function oddChars(...strs) {
  const out = { hidden: 0, lookalike: 0 };
  for (const s of strs) for (const seg of markSegments(s)) {
    if (seg.kind === 'hidden') out.hidden++;
    if (seg.kind === 'lookalike') out.lookalike++;
  }
  return out;
}

// ---- small formatters (plain text, no locale surprises) ---------------------------------------------------
export function duration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s < 60) return s + ' s';
  if (s < 3600) {
    const m = Math.floor(s / 60), r = s % 60;
    return r ? m + ' min ' + r + ' s' : m + ' min';
  }
  if (s < 86400) {
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return m ? h + ' h ' + m + ' min' : h + ' h';
  }
  const d = Math.floor(s / 86400);
  return d === 1 ? '1 day' : d + ' days';
}

export function ethAmount(x, unit = 'ETH') {
  const v = Number(x);
  if (!Number.isFinite(v)) return '?';
  if (v === 0) return '0 ' + unit;
  if (Math.abs(v) < 0.0001) return '<0.0001 ' + unit;
  const s = Math.abs(v) < 1 ? v.toFixed(4) : v < 100 ? v.toFixed(2) : v.toFixed(0);
  return s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') + ' ' + unit;
}

export function usdAmount(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return '?';
  if (v < 1000) return '$' + Math.round(v);
  if (v < 1e6) return '$' + (v / 1e3).toFixed(v < 1e4 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return '$' + (v / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
}

export function pctText(x) {
  const v = Number(x);
  if (!Number.isFinite(v)) return '?';
  if (v >= 99.95) return '100%';
  return (v < 10 ? v.toFixed(1) : v.toFixed(0)).replace(/\.0$/, '') + '%';
}

const secsOf = (iso) => {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  return Number.isFinite(t) ? (typeof iso === 'number' ? iso : t / 1000) : null;
};
const short = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : String(a || ''));

// ---- the flags -------------------------------------------------------------------------------------------
// Each rule reads one match (and, for the cross-coin rules, all matches). A rule only fires on facts that were
// actually read: an unknown fact (null) never raises a flag.

// The coin a "launched just before" copy would be copying: the official coin, else the earliest graduated
// exact match, else the exact match with the most holders. null when nothing stands out.
export function referenceCoin(matches) {
  const exact = matches.filter((m) => m.match === 'exact' && m.launch && secsOf(m.launch.time) != null);
  const off = exact.find((m) => m.isOfficial);
  if (off) return off;
  const grad = exact.filter((m) => m.graduated).sort((a, b) => secsOf(a.graduated.time) - secsOf(b.graduated.time));
  if (grad.length) return grad[0];
  const held = exact.filter((m) => m.holders && m.holders.count > 0).sort((a, b) => b.holders.count - a.holders.count);
  if (held.length && (held.length === 1 || held[0].holders.count > held[1].holders.count)) return held[0];
  return null;
}

export function flagLaunchedJustBefore(m, ref, t) {
  if (!ref || ref === m || m.match !== 'exact' || !m.launch || !ref.launch) return null;
  const a = secsOf(m.launch.time), b = secsOf(ref.launch.time);
  if (a == null || b == null) return null;
  const gap = b - a;
  if (!(gap > 0 && gap <= t.launchedJustBeforeMinutes * 60)) return null;
  const what = ref.isOfficial ? 'the official coin' : ref.graduated ? 'a coin with the same name that later graduated'
    : 'the most-held coin with the same name';
  return {
    code: 'launched-just-before', severity: 'warn',
    text: 'Launched ' + duration(gap) + ' before ' + what + ' (' + short(ref.address) + ').',
    proof: [txUrl(m.launch.tx), txUrl(ref.launch.tx)],
  };
}

export function flagDevDumpedFast(m, t) {
  const buy = m.devBuy, sold = m.devSold;
  if (!buy || !(buy.tokens > 0) || !sold || !Array.isArray(sold.sells) || !m.launch) return null;
  const start = secsOf(m.launch.time);
  if (start == null) return null;
  let total = 0, last = null;
  const within = [];
  for (const s of sold.sells.slice().sort((a, b) => secsOf(a.time) - secsOf(b.time))) {
    const dt = secsOf(s.time) - start;
    if (!(dt <= t.devDumpMinutes * 60)) break;
    total += s.tokens;
    within.push(s);
    last = dt;
    if ((total / buy.tokens) * 100 >= t.devDumpPct) break;
  }
  const pct = (total / buy.tokens) * 100;
  if (!(pct >= t.devDumpPct)) return null;
  return {
    code: 'dev-dumped-fast', severity: 'warn',
    text: 'Dev sold ' + pctText(pct) + ' of their launch buy ' + duration(last) + ' after launch.',
    proof: within.map((s) => txUrl(s.tx)).concat([txUrl(m.launch.tx)]),
  };
}

export function flagFeesAndLeft(m, t) {
  if (!m.fees || !m.launch || !Array.isArray(m.bridges)) return null;
  const start = secsOf(m.launch.time), lim = t.feesAndLeftMinutes * 60;
  if (start == null) return null;
  const inWin = (x) => { const dt = secsOf(x.time) - start; return dt >= 0 && dt <= lim; };
  const claims = (m.fees.claims || []).filter(inWin);
  const bridges = m.bridges.filter(inWin);
  if (!claims.length || !bridges.length) return null;
  const claimed = claims.reduce((s, c) => s + (Number(c.eth) || 0), 0);
  const out = bridges.reduce((s, b) => s + (Number(b.eth) || 0), 0);
  const lastT = Math.max(...claims.concat(bridges).map((x) => secsOf(x.time))) - start;
  return {
    code: 'fees-and-left', severity: 'warn',
    text: 'Dev claimed ' + ethAmount(claimed) + ' in fees and bridged ' + ethAmount(out) + ' out, all within '
      + duration(lastT) + ' of launch.',
    proof: claims.map((c) => txUrl(c.tx)).concat(bridges.map((b) => txUrl(b.tx))),
  };
}

export function flagDeadCopy(m, t) {
  if (m.graduated !== null || (m.missing || []).includes('graduated')) return null;   // graduated, or unknown
  if (!m.liquidity || !Number.isFinite(m.liquidity.usd)) return null;
  if (m.tradesRecent == null || m.tradesRecent > 0) return null;
  if (!(m.liquidity.usd < t.deadCopyUsd)) return null;
  return {
    code: 'dead-copy', severity: 'info',
    text: 'Looks abandoned: never graduated, ' + (m.liquidity.usd < 1 ? 'less than $1' : 'about ' + usdAmount(m.liquidity.usd))
      + ' left on its curve and no trades in the last '
      + duration(t.deadCopyQuietMinutes * 60) + '.',
    proof: [tokenUrl(m.address), addressUrl(m.curve)],
  };
}

// Pairs of matches whose first buyers (launch block + 0..sniperWindowBlocks, dev excluded) overlap.
export function flagsSameSnipers(matches, t) {
  const out = new Map();
  const sets = matches.map((m) => new Set((m.snipers || []).map((s) => s.wallet)));
  for (let i = 0; i < matches.length; i++) {
    for (let j = i + 1; j < matches.length; j++) {
      const shared = [...sets[i]].filter((w) => sets[j].has(w));
      if (shared.length < t.sameSnipersMin) continue;
      for (const [a, b] of [[i, j], [j, i]]) {
        const m = matches[a], other = matches[b];
        if (!out.has(m)) out.set(m, []);
        out.get(m).push({
          code: 'same-snipers', severity: 'info',
          text: shared.length + ' of the same wallets bought both this coin and ' + short(other.address)
            + ' in their first seconds. That points to one bot operator; it doesn\'t link either dev.',
          proof: [tokenUrl(other.address)].concat(shared.slice(0, 5).map(addressUrl)),
          wallets: shared,
        });
      }
    }
  }
  return out;
}

// Only rows whose own symbol or name has the official coin's skeleton (an address query also matches rows by
// the pasted coin's name, which may differ from its symbol).
export function flagNameOfOfficial(m, official) {
  if (!official || m.isOfficial || m.match !== 'exact') return null;
  const sk = official.skeleton || skeleton(official.symbol);
  if (skeleton(m.symbol) !== sk && skeleton(m.name) !== sk) return null;
  return {
    code: 'name-of-official', severity: 'warn',
    text: 'Uses the name of an official coin, not the official address. The official $' + official.symbol + ' is '
      + official.address + '.',
    proof: [tokenUrl(official.address), tokenUrl(m.address)],
  };
}

// Adds .flags to every match (in place) and returns the matches.
export function applyFlags(matches, { official = null, settings } = {}) {
  const t = trustSettings(settings);
  const ref = referenceCoin(matches);
  const same = flagsSameSnipers(matches, t);
  for (const m of matches) {
    const flags = [
      flagNameOfOfficial(m, official),
      flagLaunchedJustBefore(m, ref, t),
      flagDevDumpedFast(m, t),
      flagFeesAndLeft(m, t),
      flagDeadCopy(m, t),
      ...(same.get(m) || []),
    ].filter(Boolean);
    m.flags = flags;
  }
  return matches;
}

// ---- verdict, notes, caveats -----------------------------------------------------------------------------
// "Quick copy" is only said about a coin that copies another one by its timing or its name: launched just before
// a same-name coin, or uses the official coin's name. A coin whose dev sold fast (or took fees and bridged out)
// is described as that, separately, so the earliest coin of a name is never called a copy.
const QUICK_COPY = new Set(['launched-just-before', 'name-of-official']);
const DEV_FAST = 'dev-dumped-fast';
const FEES_LEFT = 'fees-and-left';
const PASTED_WARN = new Set(['launched-just-before', 'dev-dumped-fast', 'fees-and-left']);
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);
const hasFlag = (m, codes) => (m.flags || []).some((f) => (typeof codes === 'string' ? f.code === codes : codes.has(f.code)));

// totals (optional): { exact, near } = every index row found, including rows not read in full (the matches list
// is cut to maxFacts). Without it the matches themselves are counted. "Use this name" counts exact matches only;
// near matches (one character off) are counted separately as "a similar name".
export function buildVerdict({ query, matches, official, totals = null }) {
  const others = matches.filter((m) => !m.isQuery && !m.isOfficial);
  const kinds = (list) => ({ exact: list.filter((m) => m.match !== 'near').length, near: list.filter((m) => m.match === 'near').length });
  const all = totals && Number.isFinite(totals.exact) && Number.isFinite(totals.near) ? totals : kinds(matches);
  const self = kinds(matches.filter((m) => m.isQuery || m.isOfficial));
  const oth = { exact: Math.max(0, all.exact - self.exact), near: Math.max(0, all.near - self.near) };
  const quickRows = others.filter((m) => hasFlag(m, QUICK_COPY));
  const quick = quickRows.length;
  const rest = others.filter((m) => !quickRows.includes(m));
  const devFast = rest.filter((m) => hasFlag(m, DEV_FAST)).length;
  const feesLeft = rest.filter((m) => !hasFlag(m, DEV_FAST) && hasFlag(m, FEES_LEFT)).length;
  const queryRow = matches.find((m) => m.isQuery);
  const sym = official ? '$' + official.symbol : '';
  let lead;
  if (official && query.kind === 'address' && query.address === official.address) {
    lead = 'This is the official ' + sym + '.';
  } else if (official && query.kind === 'address') {
    lead = 'This is not the official ' + sym + '. The official one is ' + short(official.address) + '.';
  } else if (official) {
    lead = 'The official ' + sym + ' is ' + short(official.address) + '.';
  } else if (query.kind === 'address' && !query.isPons) {
    lead = 'This coin wasn\'t launched on Pons.';
  } else lead = '';

  const relative = !!official || (query.kind === 'address' && !!query.isPons);   // "other" = besides the pasted/official coin
  const n = relative ? oth : all;
  let count = relative
    ? (n.exact ? plural(n.exact, 'other coin uses', 'other coins use') + ' this name.' : 'No other Pons coin uses this name.')
    : (n.exact ? plural(n.exact, 'Pons coin uses', 'Pons coins use') + ' this name.' : 'No Pons coin uses this name.');
  if (n.near) count += ' ' + (n.exact ? n.near + ' more' : String(n.near)) + (n.near === 1 ? ' has' : ' have') + ' a similar name.';
  let tail = '';
  if (quick) tail = ' ' + (quick === 1 ? '1 looks like a quick copy.' : quick + ' look like quick copies.');
  if (devFast) tail += ' ' + (devFast === 1 ? '1 had its dev sell within minutes.' : devFast + ' had their devs sell within minutes.');
  if (feesLeft) tail += ' ' + (feesLeft === 1 ? '1 had its dev take fees and bridge out within the hour.'
    : feesLeft + ' had their devs take fees and bridge out within the hour.');
  if (queryRow && hasFlag(queryRow, PASTED_WARN) && !official) {
    tail += ' The coin you pasted has warning flags.';
  }
  return [lead, count + tail].filter(Boolean).join(' ');
}

export function buildNotes({ shownCount, totalCount, indexComplete, indexedFrom, problems = [] }) {
  const notes = [];
  if (totalCount > shownCount) {
    notes.push('Showing the top ' + shownCount + ' of ' + totalCount + ' matches, ranked by graduation, holders and liquidity. '
      + plural(totalCount - shownCount, 'more match', 'more matches') + ' not shown.');
  }
  if (!indexComplete && indexedFrom) {
    notes.push('Still indexing older launches: searching launches since ' + String(indexedFrom).slice(0, 10) + '.');
  }
  for (const p of problems) if (!notes.includes(p)) notes.push(p);
  return notes;
}

export const CAVEATS = [
  'Pons launches only. Copies made elsewhere aren\'t in this list.',
  'First doesn\'t mean real. We show what the chain shows and flag patterns; we don\'t pick a winner.',
  'Fees are counted per dev wallet, so they can include fees from the dev\'s other coins.',
  'Bridges we can see: the Arbitrum native bridge, Across and MetaBridge/Relay. Exchanges and other bridges can\'t be seen, and wallets funded through them can\'t be linked.',
  'Facts from Robinhood Chain; not financial advice.',
];
