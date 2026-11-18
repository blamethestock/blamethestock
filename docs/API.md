# Blame the Stock API

`https://api.blamethestock.com` — a small Cloudflare Worker (`api/`) next to the static site. It is
**read-only**: it never asks for a wallet, a signature or a login. Everything it says is an observed fact, a flag
or "can't link". It is not financial advice.

**Where the chain is read.** Robinhood Chain's official RPC answers HTTP 429 to every call from Cloudflare's
network (publicnode serves only the newest blocks, dRPC caps `eth_getLogs` at 100 blocks), so the Worker serves
its **launch index** (D1) and reads nothing else from the chain on a request. The website reads the chain facts,
the launch report and the wallet links **in the visitor's browser** (`site/src/trust/copycheck.js`,
`site/src/trust/local.js`), and the local MCP package (`npx blamethestock-mcp`) does the same on the user's
machine. Only the minute cron reads the chain here (dRPC, in 100-block pieces).

| Method | Path | What it answers |
|---|---|---|
| GET | `/v1/health` | the launch index: newest and oldest indexed block, indexed since, complete or not |
| GET | `/v1/copies?q=TICKER\|0xADDRESS` | every Pons launch with the same or a look-alike name, from the index (`facts: "client"`) |
| GET | `/v1/report/{token}` | the coin's launch row from the index (`status: "basics"`); the report is built by the browser |
| GET | `/v1/report/{token}/links` | a note: wallet links are checked by the browser |
| POST, GET, DELETE | `/mcp` | the same three tools for AI agents (MCP, Streamable HTTP, no login): index answers plus a note |

## Common rules

**Errors** always look like `{ "ok": false, "code": "…", "message": "a plain sentence" }`.

| HTTP | code | when |
|---|---|---|
| 400 | `bad-input`, `bad-address` | empty or too long query; not `0x` + 40 hex |
| 404 | `not-found`, `not-a-token`, `not-pons` | no coin there; not a Pons launch (report) |
| 405 | `method` | anything but GET (except `/mcp`) |
| 429 | `rate-limited` | over 60 requests a minute; header `Retry-After` (seconds) |
| 502 | `rpc-failed` | Robinhood Chain didn't answer |
| 503 | `index-behind`, `unavailable` | the launch index is still being built; a part isn't available right now |

**Caching.** Answers are kept for everyone for a minute, keyed only by the query or the token (Cache API and
the D1 table `api_cache`); browsers may keep them 60 seconds (`Cache-Control: public, max-age=60`). Errors are never
cached (`no-store`). `/v1/health` is `max-age=15`.

**CORS.** `Access-Control-Allow-Origin` is sent only for `https://blamethestock.com`,
`https://www.blamethestock.com` and `http://localhost:8765` (the `SITE_ORIGINS` var). Other callers still get
the JSON, just without that header. Preflight (`OPTIONS`) answers 204.

**Rate limit.** 60 requests a minute per visitor on `/v1/copies`, `/v1/report…` and `/mcp` (`/v1/health` is
free). It is counted in the Worker's memory only, under a hash of the IP address, and forgotten every minute.

**Privacy.** The API never logs or stores IP addresses or user agents. Workers request logs are off
(`invocation_logs = false`); the Worker's own log lines are about the indexer and errors only.

**Debug header.** `x-bts-budget: sub=12/45; d1=4/45; refused=0` shows what one request spent
(subrequests, D1 queries, refused fetches).

## GET /v1/health

```jsonc
{
  "ok": true, "service": "bts-api", "version": "0.1.0", "time": "2026-11-18T13:54:37Z",
  "index": {
    "ready": true,
    "lastBlock": 117349084,          // newest block whose launches are all indexed
    "oldestBlock": 115578971,        // oldest block of the unbroken indexed range
    "indexedFrom": "2026-11-16T07:06:13Z",
    "indexComplete": false,          // true once oldestBlock <= floorBlock (no Pons launch is older)
    "floorBlock": 20000000,
    "lastRun": "2026-11-18T13:54:33Z",
    "lastRunAgoSeconds": 4,
    "behind": false                  // true when the minute indexer hasn't run for 10 minutes
  },
  "rateLimitPerMinute": 60
}
```

## GET /v1/copies?q=

`q` is a ticker (`OBSYN`, `$obsyn`, look-alike letters and hidden characters are normalised) or a coin address.
For an address the index doesn't have yet, the browser reads its name and symbol from the chain and asks again with
`&name=…&symbol=…` (search words only). The answer:

```
{ ok: true, status: 'done', facts: 'client', factsNote, query: { input, kind, skeleton, address?, inIndex?, isPons? },
  asOf: null, indexAsOf, index: { lastBlock, lastRun }, indexedFrom, indexComplete, official,
  matches: [{ address, name, symbol, nameShown, symbolShown, oddChars, match: 'exact'|'near', isQuery, isOfficial, isPons,
              factory, curve, pairToken, launch: { tx, block, time }, launchCreator, txFrom, creator: null,
              devBuy: null, …, missing: [every fact], pending: true, flags: [], proof: { token, launchTx, curve } }],
  totals: { exact, near, total, listed }, capped, verdict, notes: [], caveats: [] }
```

The matches are the pasted and the official coin, then up to 60 others (exact before near, newest first). The
browser reads the most relevant ones in full (up to 12, two at a time, graduated and best-funded first), applies
the flags (`site/src/trust/rules.js`) and builds the same CopyCheckResult the card always showed.

## GET /v1/report/{token}

```
{ ok: true, status: 'basics', clientSide: true, inIndex: true|false,
  token: { address, name, symbol, isOfficial, pons: { factory, curve, launchTx, launchBlock, launchTime, pairToken } },
  launch: { token, factory, curve, creator, tx_from, pair_token, block, log_index, time, tx, name, symbol } | null,
  proof: { token, launchTx, curve }, note }
```

The browser builds the launch report from it with the step code in `site/src/trust/report-build.js` (an in-memory
store, the page's fetch); without the row it reads the launch from the chain too.

## GET /v1/report/{token}/links

`{ ok: true, status: 'client', clientSide: true, funders: [], links: [], ignored: [], caveat, note }`. The browser
checks the wallet links itself (`site/src/trust/wallet-links.js`) after the report is on screen; they never hold it up.

## /mcp

Streamable HTTP MCP server (`api/src/mcp.js`), stateless, no login. Tools (all read-only):
`blame_split({ token, window })`, `check_copycats({ query })`, `launch_report({ token })`. Hosted, they can't read
the chain: `check_copycats` returns the index list with launch info, `launch_report` the launch basics, both with
a note that the full facts are read by the website or the local package; `blame_split` returns that note with the
card's link. The local package (`npx -y blamethestock-mcp`, `mcp/`) runs the same tools with full facts read on the
user's machine.

```
claude mcp add --transport http blamethestock https://api.blamethestock.com/mcp
```

## Free plan: how the Worker stays inside it

Cloudflare Workers free plan, per request: 10 ms CPU, 50 subrequests (each `fetch`, each Cache API call; a
JSON-RPC batch is one), 50 D1 queries; 100,000 requests a day; D1 5M rows read and 100k written a day.

- **Budget** (`api/src/budget.js`): every request and every cron run gets `createBudget({ limit: 45, d1Limit: 45 })`.
  Fetches over the limit are refused at once (JSON-RPC calls get error `-32099`, which the RPC code doesn't retry).
- **Requests** read D1 and the cache only (a copy check is one or two D1 queries plus the cache).
- **Cron, every minute:** the launch indexer gets 40 subrequests. It reads `TokenLaunched` logs on dRPC in
  100-block pieces, 3 per batch request, at most 22 requests (6,600 blocks) and 15 launches a run, then the
  Multicall3 senders, names (dRPC archive `aggregate3`) and block times on dRPC. The official node is asked only
  when nothing else answered. A normal minute is ~575 blocks (2 requests); after an outage it catches up about
  6,000 blocks a minute. Expired cache rows are deleted.
- **D1 reads** are by primary key or index (`api_cache.key`, `launches.sym_skel`/`name_skel`/`token`/`block`).

### The Worker's own D1 tables

Created on first use (and by `dev/tools/local_e2e.sh`):

```sql
CREATE TABLE IF NOT EXISTS api_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache (expires);
CREATE TABLE IF NOT EXISTS api_jobs (key TEXT PRIMARY KEY, kind TEXT NOT NULL, token TEXT NOT NULL,
  created INTEGER NOT NULL, touched INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress REAL);
CREATE INDEX IF NOT EXISTS idx_api_jobs_touched ON api_jobs (touched);
```

`api_jobs` and `api/schema-reports.sql` (report jobs) are left from when the Worker built reports; nothing writes
to them now and the cron purges old `api_jobs` rows. The launch index is `api/schema.sql`.

## Running it locally

Needs Node.js. No Cloudflare account.

```sh
cd api && npm install
sh dev/tools/local_e2e.sh path/to/export --fresh     # local D1 + the backfill export, wrangler dev on :8787
curl -s 'http://localhost:8787/v1/copies?q=OBSYN'
cd api && npm run test-scheduled                      # then: curl -s http://localhost:8787/__scheduled
```

The export folder comes from `python3 -I dev/tools/backfill_launches.py export OUT_DIR`. Deploy steps are at the
top of `api/wrangler.toml`.
