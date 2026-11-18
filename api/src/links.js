// Wallet links: walletLinks({ token, env, settings, now, budget }) ->
//   { ok:true, status:'done'|'building'|'unavailable', funders, links, ignored, caveat } | ErrorResult
//
// Who first sent ETH to the dev and to each first buyer ("sniper"), and which of those wallets share a funder.
// Loaded separately from the launch report (GET /v1/report/{token}/links): it never holds the report back, and when
// the explorer is busy (429) or shows a challenge it answers status 'unavailable' instead of failing.
//
// How:
//  - The dev and the first buyers come from the report's job (report.js reportBasics; it reads them when needed).
//  - Funding: Blockscout /api/v2/addresses/{w}/transactions?filter=to (oldest first) and /internal-transactions?filter=to.
//    The funder is the sender of the earliest incoming ETH (trade proceeds from the Pons router, LaunchAndBuy, the
//    v4 PoolManager or the fee escrow are not funding). Cached per wallet ('funder:<wallet>'), since it never changes.
//  - Ignored as public services (never a link on their own): Across SpokePool and MulticallHandler, the Pons router,
//    MetaBridge, Relay's depository, Multicall3, LaunchAndBuy, any sender the explorer names (an exchange, a bridge),
//    and any funder that paid more than 25 wallets that day.
//  - A link: the same (not ignored) funder paid two or more of these wallets. A weak link: two wallets got ETH from
//    the same public service within 60 s of each other (a busy service can do that by chance; said so).
//  - Wallets funded through exchanges, bridges or privacy tools can't be linked; the answer always says so.
// Free plan: at most LINK_SUBREQUESTS fetches per call; unfinished work is kept (funder cache + a 'links:<token>' job
// for the cron) and the answer is 'building'. Nothing about the visitor is read or stored.
import { createBudget, BudgetExceeded } from './budget.js';
import { reportBasics, storeFor, memoryStore, settle, scopedBudget, KEEP_SECONDS, LEASE_SECONDS } from './report.js';
import { makeExplorer, ADDR } from '../../site/src/trust/facts.js';
import { POOL_MANAGER } from '../../site/src/data/constants.js';
import { txUrl, addressUrl } from '../../site/src/trust/rules.js';
import { isoOf } from '../../site/src/trust/report-rules.js';

export const LINKS_TTL = 86400;            // s: a finished links answer is served this long
export const LINK_SUBREQUESTS = 30;        // fetches per call (explorer + chain)
export const EXPLORER_PER_CALL = 16;       // Blockscout allows ~150 requests per 5 minutes per IP: stay well under
export const MAX_LINK_WALLETS = 25;        // the dev + the 24 biggest first buyers
export const FAN_OUT_MAX = 25;             // a funder that paid more wallets than this in a day is a public service
export const SAME_SOURCE_SECONDS = 60;
const INCOMPLETE_TTL = 86400;
const FANOUT_PAGES = 3;
const INTERNAL_PAGES = 3;
export const LINKS_CAVEAT = 'Wallets funded through exchanges, bridges or privacy tools can\'t be linked.';

// Public services: their payments link nobody.
export const IGNORED = {
  '0xd29c85f15df544ba632c9e25829fd29d767d7978': 'Across SpokePool',
  '0xa8ad2e87e2043711d8bec77e8bc3e2683c0ab6bd': 'Across MulticallHandler',
  '0x65050a9b7e5075a2ba5ced7b1b64ee66262c40dc': 'Pons router',
  '0x19ba492a2fa0734f4b44c139dff4fbaca48907d6': 'MetaBridge',
  '0x4cd00e387622c35bddb9b4c962c136462338bc31': 'Relay depository',
  '0xca11bde05977b3631167028862be2a173976ca11': 'Multicall3',
  '0xe33e9e479df8802cb0866d5d05258bec4cf62948': 'Pons LaunchAndBuy',
};
// Not funding at all (money back from trades or fees).
const NOT_FUNDING = new Set([ADDR.ROUTER, ADDR.LAUNCH_AND_BUY, POOL_MANAGER, ADDR.FEE_ESCROW]);

const fail = (code, message) => ({ ok: false, code, message });
const nowSec = (now) => Math.floor(Number(now == null ? Date.now() : now) / 1000);
const short = (a) => (a && a.length > 12 ? a.slice(0, 6) + '…' + a.slice(-4) : String(a || ''));
const dayOf = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);
const lower = (a) => (a == null ? null : String(a).toLowerCase());

class Unavailable extends Error {}

// The explorer's label for an address object ({ hash, is_contract, name, public_tags, metadata }), or null.
export function labelOf(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.name) return String(a.name);
  const pub = Array.isArray(a.public_tags) ? a.public_tags.find((t) => t && (t.display_name || t.label)) : null;
  if (pub) return String(pub.display_name || pub.label);
  const tags = a.metadata && Array.isArray(a.metadata.tags) ? a.metadata.tags.find((t) => t && t.name) : null;
  return tags ? String(tags.name) : null;
}

// One incoming payment from an explorer item (a transaction or an internal transaction), or null.
function payment(it, wallet, kind) {
  if (!it || !it.from || !it.from.hash) return null;
  const from = lower(it.from.hash);
  const value = BigInt(it.value || '0');
  if (value <= 0n || from === wallet) return null;
  if (kind === 'tx' && it.status && it.status !== 'ok') return null;
  if (kind === 'internal' && (it.success === false || it.error)) return null;
  if (it.to && it.to.hash && lower(it.to.hash) !== wallet) return null;
  const t = Date.parse(it.timestamp) / 1000;
  if (!Number.isFinite(t)) return null;
  const label = labelOf(it.from);
  if (NOT_FUNDING.has(from) || (label && /curve|launchandbuy|feeescrow/i.test(label))) return null;
  return {
    from, label, isContract: !!it.from.is_contract, eth: Number(value) / 1e18, time: t,
    block: Number(it.block_number), pos: Number(kind === 'tx' ? it.position : it.index) || 0,
    tx: lower(kind === 'tx' ? it.hash : it.transaction_hash),
  };
}

// Who first sent `wallet` ETH. -> { funder, label, isContract, eth, time, tx, block, complete } | { funder: null, ... }
// Throws Unavailable when the explorer is busy or challenges us; BudgetExceeded when this call's budget is spent.
export async function findFunder(wallet, ex, budget) {
  const get = async (path) => {
    if (!budget.has(2) || budget.explorerLeft <= 0) throw new BudgetExceeded();
    budget.explorerLeft--;
    const r = await ex.get(path);
    if (!r.ok && r.reason !== 'not-found') {
      if (budget.refused) throw new BudgetExceeded();
      throw new Unavailable('explorer');
    }
    return r.ok ? r.json || {} : { items: [] };
  };
  const a = await get('/api/v2/addresses/' + wallet + '/transactions?filter=to&sort=block_number&order=asc');
  const cands = [];
  for (const it of a.items || []) { const p = payment(it, wallet, 'tx'); if (p) cands.push(p); }
  // internal payments come newest first: read on until the oldest page (a few pages at most)
  let q = '', complete = false;
  for (let page = 0; page < INTERNAL_PAGES; page++) {
    const b = await get('/api/v2/addresses/' + wallet + '/internal-transactions?filter=to' + q);
    for (const it of b.items || []) { const p = payment(it, wallet, 'internal'); if (p) cands.push(p); }
    const next = b.next_page_params;
    if (!next || !(b.items || []).length) { complete = true; break; }
    q = '&' + Object.keys(next).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(next[k] == null ? '' : String(next[k]))).join('&');
  }
  cands.sort((x, y) => x.block - y.block || x.pos - y.pos);
  const first = cands[0];
  if (!first) return { funder: null, complete };
  return { funder: first.from, label: IGNORED[first.from] || first.label, isContract: first.isContract, eth: first.eth, time: first.time, tx: first.tx, block: first.block, complete };
}

// How many different wallets `funder` paid on `day` (UTC date). -> { count, busy, seen: 'all'|'partial' }
export async function fanOut(funder, day, ex, budget) {
  const recipients = new Set();
  let q = '';
  for (let page = 0; page < FANOUT_PAGES; page++) {
    if (!budget.has(2) || budget.explorerLeft <= 0) throw new BudgetExceeded();
    budget.explorerLeft--;
    const r = await ex.get('/api/v2/addresses/' + funder + '/transactions?filter=from' + q);
    if (!r.ok) {
      if (r.reason === 'not-found') return { count: 0, busy: false, seen: 'all' };
      if (budget.refused) throw new BudgetExceeded();
      throw new Unavailable('explorer');
    }
    const items = (r.json && r.json.items) || [];
    let older = false;
    for (const it of items) {
      const t = Date.parse(it.timestamp) / 1000;
      if (!Number.isFinite(t)) continue;
      const d = dayOf(t);
      if (d < day) { older = true; continue; }
      if (d === day && it.to && it.to.hash && BigInt(it.value || '0') > 0n) recipients.add(lower(it.to.hash));
    }
    if (recipients.size > FAN_OUT_MAX) return { count: recipients.size, busy: true, seen: 'partial' };
    const next = r.json && r.json.next_page_params;
    if (older || !next || !items.length) return { count: recipients.size, busy: false, seen: 'all' };
    q = '&' + Object.keys(next).map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(next[k] == null ? '' : String(next[k]))).join('&');
  }
  // more than FANOUT_PAGES pages of payments after that day: too busy to be one person's wallet
  return { count: recipients.size, busy: true, seen: 'partial' };
}

// funders: [{ wallet, role, funder, kind, eth, time, tx, label? }]; fanouts: funder -> { busy, count }
// sameTx: [{ wallet, tx }] first buyers that got their coins in a transaction the dev sent (a bundled launch)
// -> { links, ignored } (pure)
export function buildLinks(funders, { dev = null, sameTx = [] } = {}) {
  const links = [], ignored = new Map();
  const bundled = sameTx.filter((s) => s && s.wallet && s.wallet !== dev);
  if (dev && bundled.length) {
    const txs = [...new Set(bundled.map((s) => s.tx).filter(Boolean))];
    links.push({
      wallets: [dev].concat(bundled.map((s) => s.wallet)), funder: null, strength: 'strong', kind: 'same-tx', involvesDev: true,
      reason: 'Got their coins in the dev\'s own transaction' + (txs.length > 1 ? 's' : '') + ': the dev paid for these ' + bundled.length + ' buys.',
      proof: [addressUrl(dev)].concat(txs.map((t) => txUrl(t))),
    });
  }
  const byFunder = new Map();
  for (const f of funders) {
    if (!f.funder) continue;
    if (!byFunder.has(f.funder)) byFunder.set(f.funder, []);
    byFunder.get(f.funder).push(f);
    if (f.kind === 'public-service' && !funders.some((x) => x.wallet === f.funder)) ignored.set(f.funder, f.why || ((f.label ? f.label + ': ' : '') + 'a public service, its payments link nobody'));
  }
  const checked = new Set(funders.map((f) => f.wallet));
  for (const [funder, list] of byFunder) {
    // The funder is itself one of the wallets checked (the dev, or a first buyer): a direct link, even for one wallet.
    // It is never a "public service", however busy it is.
    if (checked.has(funder)) {
      const wallets = [funder].concat(list.map((f) => f.wallet).filter((w) => w !== funder));
      if (wallets.length < 2) continue;
      const isDev = !!dev && funder === dev;
      links.push({
        wallets, funder, strength: 'strong', kind: 'direct-funding', involvesDev: !!dev && wallets.includes(dev),
        reason: (isDev ? 'The dev' : 'First buyer ' + short(funder)) + ' sent the first ETH to ' + (wallets.length - 1 === 1 ? 'this wallet' : 'these ' + (wallets.length - 1) + ' wallets') + '.',
        proof: [addressUrl(funder)].concat(list.map((f) => txUrl(f.tx))),
      });
      continue;
    }
    if (list.length < 2) continue;
    const wallets = list.map((f) => f.wallet);
    const proof = [addressUrl(funder)].concat(list.map((f) => txUrl(f.tx)));
    if (list[0].kind === 'wallet') {
      links.push({
        wallets, funder, strength: 'strong', kind: 'same-funder', involvesDev: !!dev && wallets.includes(dev),
        reason: 'Same funder: ' + short(funder) + ' sent the first ETH to each of these ' + wallets.length + ' wallets.',
        proof,
      });
      continue;
    }
    // public service: only payments within SAME_SOURCE_SECONDS of each other, as a weak link
    const secs = (t) => (typeof t === 'number' ? t : Date.parse(t) / 1000);
    const sorted = list.filter((f) => f.time != null && Number.isFinite(secs(f.time))).map((f) => ({ ...f, t: secs(f.time) })).sort((a, b) => a.t - b.t);
    let group = [];
    const flush = () => {
      if (group.length >= 2) {
        const ws = group.map((f) => f.wallet);
        const gap = Math.round(group[group.length - 1].t - group[0].t);
        links.push({
          wallets: ws, funder, strength: 'weak', kind: 'same-service', involvesDev: !!dev && ws.includes(dev),
          reason: 'Got their first ETH from the same public service (' + (list[0].label || short(funder)) + ') within ' + gap
            + ' s of each other. A busy service can do this by chance.',
          proof: [addressUrl(funder)].concat(group.map((f) => txUrl(f.tx))),
        });
      }
      group = [];
    };
    for (const f of sorted) {
      if (group.length && f.t - group[group.length - 1].t > SAME_SOURCE_SECONDS) flush();
      group.push(f);
    }
    flush();
  }
  links.sort((a, b) => (a.strength === b.strength ? 0 : a.strength === 'strong' ? -1 : 1) || (b.involvesDev - a.involvesDev) || b.wallets.length - a.wallets.length);
  return { links, ignored: [...ignored.entries()].map(([address, why]) => ({ address, why })) };
}

function kindOf(rec) {
  if (!rec || !rec.funder) return 'unknown';
  if (IGNORED[rec.funder]) return 'public-service';
  if (rec.label) return 'public-service';            // the explorer names it (exchange, bridge, protocol)
  return 'wallet';
}

const building = (progress, extra = {}) => ({ ok: true, status: 'building', progress: Math.round(Math.max(0, Math.min(0.99, progress)) * 100) / 100, funders: [], links: [], ignored: [], caveat: LINKS_CAVEAT, ...extra });
const unavailable = (extra = {}) => ({ ok: true, status: 'unavailable', funders: [], links: [], ignored: [], caveat: LINKS_CAVEAT, retryAfterSeconds: 60,
  message: 'Wallet links unavailable right now. Try again in a minute.', ...extra });

export async function walletLinks({ token, env = null, settings = null, now = Date.now(), budget = null, fetch: fetchFn = null, sleep = null, store = null, maxSubrequests = LINK_SUBREQUESTS } = {}) {
  const raw = String(token == null ? '' : token).trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return fail('bad-address', 'That isn\'t a coin address. Paste a Pons coin address: 0x followed by 40 letters or numbers.');
  const addr = raw.toLowerCase();
  const nowS = nowSec(now);
  const b = scopedBudget(budget, fetchFn, maxSubrequests);         // this call's share; rpc.js counts through it
  b.explorerLeft = EXPLORER_PER_CALL;
  const st = storeFor({ env, store, budget: b }) || memoryStore();
  const key = 'links:' + addr;
  try {
    const cached = (await st.getCaches([key])).get(key);
    if (cached && cached.value && nowS - cached.createdAt < LINKS_TTL) return cached.value;

    const basics = await reportBasics({ token: addr, env, settings, now, budget: b, sleep, store: st });
    if (!basics || basics.ok !== true) return basics && basics.code === 'unavailable' ? unavailable() : basics;
    if (basics.status !== 'done') { await queue(st, addr, nowS, 0); return building(0); }

    const wallets = [{ wallet: basics.dev, role: 'dev' }]
      .concat(basics.snipers.filter((s) => s.wallet !== basics.dev).slice(0, MAX_LINK_WALLETS - 1).map((s) => ({ wallet: s.wallet, role: 'sniper' })));
    const got = await st.getCaches(wallets.map((w) => 'funder:' + w.wallet));
    const recs = new Map();
    for (const w of wallets) { const c = got.get('funder:' + w.wallet); if (c && c.value) recs.set(w.wallet, c.value); }

    const ex = makeExplorer({ fetch: b.fetch, sleep: sleep || undefined });
    const fresh = [];
    let stopped = null;
    for (const w of wallets) {
      if (recs.has(w.wallet)) continue;
      try {
        const rec = await findFunder(w.wallet, ex, b);
        recs.set(w.wallet, rec);
        fresh.push({ key: 'funder:' + w.wallet, value: rec, createdAt: nowS, expiresAt: nowS + (rec.complete ? KEEP_SECONDS : INCOMPLETE_TTL) });
      } catch (e) {
        stopped = e instanceof Unavailable ? 'unavailable' : 'budget';
        break;
      }
    }
    if (fresh.length) await st.putCaches(fresh);
    if (stopped) {
      const progress = recs.size / (wallets.length + 1);
      if (stopped === 'unavailable') { await queue(st, addr, nowS, progress); return unavailable({ progress }); }
      await queue(st, addr, nowS, progress);
      return building(progress);
    }

    // funders, with the public-service check for funders shared by two or more wallets
    const funders = wallets.map((w) => {
      const r = recs.get(w.wallet) || { funder: null };
      const f = { wallet: w.wallet, role: w.role, funder: r.funder || null, kind: kindOf(r), eth: r.eth == null ? null : r.eth, time: isoOf(r.time), tx: r.tx || null };
      if (r.label) f.label = r.label;
      if (r.funder && !r.complete) f.firstSeen = 'earliest we could see';
      return f;
    });
    // A funder that is one of these wallets (the dev paying its own first buyers) links them directly: no busy check.
    const checked = new Set(wallets.map((w) => w.wallet));
    for (const f of funders) if (f.funder && checked.has(f.funder)) { f.kind = 'wallet'; delete f.label; }
    const count = new Map();
    for (const f of funders) if (f.kind === 'wallet') count.set(f.funder, (count.get(f.funder) || 0) + 1);
    const shared = [...count.entries()].filter(([f, n]) => n >= 2 && !checked.has(f)).map(([f]) => f);
    const timeOf = (f) => recs.get(funders.find((x) => x.funder === f).wallet).time;
    const fanKeys = shared.map((f) => 'fanout:' + f + ':' + dayOf(timeOf(f)));
    const fans = await st.getCaches(fanKeys);
    const newFans = [];
    for (let i = 0; i < shared.length; i++) {
      let v = fans.get(fanKeys[i]) ? fans.get(fanKeys[i]).value : null;
      if (!v) {
        try { v = await fanOut(shared[i], dayOf(timeOf(shared[i])), ex, b); }
        catch (e) {
          if (newFans.length) await st.putCaches(newFans);
          await queue(st, addr, nowS, 0.9);
          return e instanceof Unavailable ? unavailable({ progress: 0.9 }) : building(0.9);
        }
        newFans.push({ key: fanKeys[i], value: v, createdAt: nowS, expiresAt: nowS + KEEP_SECONDS });
      }
      if (v.busy) {
        for (const f of funders) if (f.funder === shared[i]) {
          f.kind = 'public-service';
          f.why = v.count > FAN_OUT_MAX
            ? 'paid more than ' + FAN_OUT_MAX + ' wallets on ' + dayOf(timeOf(shared[i])) + ' (an exchange, relayer or payout service)'
            : 'sent too many transactions since ' + dayOf(timeOf(shared[i])) + ' to check how many wallets it paid that day, so it is treated as a public service';
        }
      }
    }
    if (newFans.length) await st.putCaches(newFans);

    const { links, ignored } = buildLinks(funders, { dev: basics.dev, sameTx: basics.snipers.filter((s) => s.byDev).map((s) => ({ wallet: s.wallet, tx: s.tx })) });
    const result = {
      ok: true, status: 'done', token: addr, dev: basics.dev, asOf: isoOf(nowS),
      funders: funders.map(({ why, ...f }) => f),
      links, ignored, caveat: LINKS_CAVEAT,
      notes: [
        'The funder is whoever sent each wallet its first ETH (the explorer\'s transactions and internal transactions). Money back from trades and fee payouts doesn\'t count.',
        'Bridges, the Pons router, Multicall3 and any sender that paid more than ' + FAN_OUT_MAX + ' wallets that day are public services: they link nobody on their own.',
        'First buyers that got their coins in a transaction the dev sent (a bundled launch) are linked to the dev by that transaction, and wallets whose first ETH came from the dev (or from another wallet checked here) are linked to it directly.',
      ],
    };
    if (basics.snipers.length > MAX_LINK_WALLETS - 1) result.notes.push('Only the dev and ' + (MAX_LINK_WALLETS - 1) + ' first buyers are checked.');
    await st.putCaches([{ key, value: result, createdAt: nowS, expiresAt: nowS + KEEP_SECONDS }]);
    await finish(st, addr, nowS);
    return result;
  } catch (e) {
    if (e instanceof BudgetExceeded) return building(0);
    return unavailable();
  }
}

// A 'links:<token>' job row tells the cron to carry on (the funders found so far are already cached).
async function queue(st, addr, nowS, progress) {
  try {
    const key = 'links:' + addr;
    if (!(await st.claimJob(key, 'links', addr, nowS, LEASE_SECONDS))) return;
    await st.saveJob({ key, status: 'building', step: 'funders', progress, state: {}, attempts: 0, updatedAt: nowS }, { release: true });
  } catch (e) { /* the next request tries again */ }
}
async function finish(st, addr, nowS) {
  try {
    const key = 'links:' + addr;
    const j = await st.getJob(key);
    if (j && j.status !== 'done') await st.saveJob({ ...j, status: 'done', progress: 1, updatedAt: nowS }, { release: true });
  } catch (e) { /* harmless */ }
}

// Cron: carry on with wallet links someone asked for. -> { advanced: [token], done: [token] }
export async function advanceLinkJobs({ env = null, settings = null, now = Date.now(), budget = null, store = null, max = 2, fetch: fetchFn = null, sleep = null } = {}) {
  const b = budget || createBudget({ fetch: fetchFn || null });
  const st = storeFor({ env, store, budget: b });
  const out = { advanced: [], done: [] };
  if (!st) return out;
  try {
    const list = await st.queued('links', nowSec(now), max);
    for (const j of list) {
      if (!b.has(8)) break;
      const r = await walletLinks({ token: j.token, store: st, settings, now, budget: b, maxSubrequests: Math.min(LINK_SUBREQUESTS, b.remaining()), sleep });
      out.advanced.push(j.token);
      if (r && r.ok && r.status === 'done') out.done.push(j.token);
      if (!r || r.ok !== true) await settle(st, j.key, 'failed', nowSec(now));     // e.g. not a Pons coin
    }
  } catch (e) { /* the next minute tries again */ }
  return out;
}
