// Request budget for one Worker invocation (one HTTP request or one cron run).
//
// Cloudflare Workers FREE plan, per invocation: 50 subrequests (each fetch() is one; a JSON-RPC batch POST is
// ONE), 50 D1 queries, 10 ms of CPU. A budget counts what a step spends so heavy work can stop early, save
// what it has, and answer "building" instead of being cut off by the platform.
//
//   const budget = createBudget({ limit: 45 });
//   budget.fetch(url, init)   counted fetch. Over the limit it does NOT throw (rpc.js would treat a throw as a
//                             network failure, retry and cool the endpoint): it answers at once with a refusal
//                             (JSON-RPC POST: every call gets error -32099 "budget: …", not retried; anything
//                             else: HTTP 503 with header x-budget: exhausted). Each refusal adds 1 to `refused`.
//   budget.remaining()        fetches still allowed (limit - used - reserved). Also: budget.left (getter).
//   budget.has(n) / canSpend(n)   remaining() >= n
//   budget.take(n) / spend(n)     count n subrequests made some other way (Cache API calls); false if over
//   budget.reserve(n)         admission for one piece of work: holds n of the room so other work doesn't start
//                             when only one fits; returns release() or null when there is no room. Fetches
//                             themselves are only capped by the limit.
//   budget.exhausted          true once anything was refused or the limit is reached
//   budget.wrapDb(db)         the same D1 binding, counting round trips (prepare().first/all/run/raw = 1,
//                             batch = 1, exec = 1) against d1Limit; over it throws BudgetExceeded
//   budget.child(n)           a smaller budget that also spends from this one (for one job inside a cron run)
//   budget.snapshot()         { limit, used, reserved, refused, d1Used, d1Limit }
//
// Plain ES module, no platform APIs needed (tests run it in jsc).

export const FREE_PLAN = { subrequests: 50, d1Queries: 50, cpuMs: 10 };
export const DEFAULT_LIMIT = 45;     // leave a few subrequests of the 50 for the Worker's own cache calls
export const DEFAULT_D1_LIMIT = 45;

export class BudgetExceeded extends Error {
  constructor(what = 'subrequests') {
    super('budget: ' + what + ' limit for this step reached');
    this.name = 'BudgetExceeded';
    this.code = 'budget';
  }
}

const REFUSAL_MESSAGE = 'budget: subrequest limit for this step reached';

function plainResponse(status, body, headers) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const h = {};
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v;
  if (typeof Response === 'function') {
    try { return new Response(text, { status, headers: h }); } catch (e) { /* fall through */ }
  }
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (Object.prototype.hasOwnProperty.call(h, String(k).toLowerCase()) ? h[String(k).toLowerCase()] : null) },
    json: async () => JSON.parse(text),
    text: async () => text,
    clone() { return plainResponse(status, text, headers); },
  };
}

// The answer a refused fetch gets. JSON-RPC POSTs get a per-call error with a message rpc.js classifies as
// "not retryable" (no retry, no cooling of the endpoint).
export function refusal(init) {
  const headers = { 'content-type': 'application/json', 'x-budget': 'exhausted' };
  const body = init && typeof init.body === 'string' ? init.body : null;
  if (body) {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch (e) { parsed = null; }
    const list = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
    if (list.length && list.every((c) => c && c.jsonrpc)) {
      const out = list.map((c) => ({ jsonrpc: '2.0', id: c.id, error: { code: -32099, message: REFUSAL_MESSAGE } }));
      return plainResponse(200, Array.isArray(parsed) ? out : out[0], headers);
    }
  }
  return plainResponse(503, { message: REFUSAL_MESSAGE }, headers);
}

export function isRefusal(res) {
  try { return !!(res && res.headers && res.headers.get('x-budget') === 'exhausted'); } catch (e) { return false; }
}

export function createBudget({ limit = DEFAULT_LIMIT, d1Limit = DEFAULT_D1_LIMIT, fetch: baseFetch = null, parent = null } = {}) {
  const base = baseFetch || ((...a) => fetch(...a));
  const st = { used: 0, reserved: 0, refused: 0, d1Used: 0 };

  // Hard cap: fetches stop at `limit` (and at the parent's limit). Reservations only steer admission:
  // reserve()/has()/remaining() see the room left after everything reserved, so two pieces of work never
  // both start when only one fits. (Conservative: a holder's own spending also counts while it holds.)
  const hardRoom = () => {
    const own = limit - st.used;
    return parent ? Math.min(own, parent.hardRoom()) : own;
  };
  const room = () => hardRoom() - st.reserved;

  function take(n) {
    if (hardRoom() < n) return false;
    if (parent && !parent.take(n)) return false;
    st.used += n;
    return true;
  }

  function counted(input, init) {
    if (take(1)) return base(input, init);
    st.refused++;
    return Promise.resolve(refusal(init));
  }

  const budget = {
    limit,
    d1Limit,
    fetch: counted,
    get used() { return st.used; },
    get refused() { return st.refused; },
    get reserved() { return st.reserved; },
    get d1Used() { return st.d1Used; },
    get left() { return Math.max(0, room()); },
    get exhausted() { return st.refused > 0 || hardRoom() <= 0; },
    hardRoom,
    remaining() { return Math.max(0, room()); },
    has(n = 1) { return room() >= n; },
    canSpend(n = 1) { return room() >= n; },
    take,
    spend(n = 1) { return take(n); },
    reserve(n) {
      n = Math.max(0, Math.floor(n));
      if (room() < n) return null;
      st.reserved += n;
      let done = false;
      return () => { if (!done) { done = true; st.reserved -= n; } };
    },
    countD1(n = 1) {
      if (st.d1Used + n > d1Limit) throw new BudgetExceeded('D1 query');
      if (parent) parent.countD1(n);
      st.d1Used += n;
    },
    wrapDb(db) { return wrapDb(db, budget); },
    child(n) {
      return createBudget({ limit: Math.max(0, Math.min(n, room())), d1Limit: Math.max(0, d1Limit - st.d1Used), fetch: base, parent: budget });
    },
    snapshot() { return { limit, used: st.used, reserved: st.reserved, refused: st.refused, d1Used: st.d1Used, d1Limit }; },
  };
  return budget;
}

// D1 binding wrapper: same interface, every round trip counted.
export function wrapDb(db, budget) {
  if (!db || typeof db.prepare !== 'function') return db;
  if (db.__budgeted) return db;
  const stmt = (s) => ({
    __raw: s,
    bind(...args) { return stmt(s.bind(...args)); },
    first(col) { budget.countD1(1); return col === undefined ? s.first() : s.first(col); },
    all() { budget.countD1(1); return s.all(); },
    run() { budget.countD1(1); return s.run(); },
    raw(opts) { budget.countD1(1); return opts === undefined ? s.raw() : s.raw(opts); },
  });
  return {
    __budgeted: true,
    __raw: db,
    prepare(sql) { return stmt(db.prepare(sql)); },
    batch(list) { budget.countD1(1); return db.batch(list.map((x) => (x && x.__raw) || x)); },
    exec(sql) { budget.countD1(1); return db.exec(sql); },
  };
}
