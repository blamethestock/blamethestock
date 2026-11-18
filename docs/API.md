# Blame the Stock API

`https://api.blamethestock.com` — a small Cloudflare Worker (`api/`) next to the static site. It is
**read-only**: it reads Robinhood Chain (chain id 4663) and its Blockscout explorer, and never asks for a wallet,
a signature or a login. Everything it says is an observed fact, a flag or "can't link". It is not financial advice.

Every answer is JSON. Every number in an answer comes with a Blockscout proof link
(`https://robinhoodchain.blockscout.com/tx/…`, `/address/…`, `/token/…`).

| Method | Path | What it answers |
|---|---|---|
| GET | `/v1/health` | the launch index: newest and oldest indexed block, indexed since, complete or not |
| GET | `/v1/copies?q=TICKER\|0xADDRESS` | "Is this the real one?": every Pons coin with the same or a look-alike name, with facts and flags |
| GET | `/v1/report/{token}` | launch report: the dev's buy and every later move, the first buyers ("snipers"), graduation, hourly activity, verdict |
| GET | `/v1/report/{token}/links` | wallet links (who funded the dev and the snipers); loaded after the report, never blocks it |
| POST, GET, DELETE | `/mcp` | the same three tools for AI agents (MCP, Streamable HTTP, no login) |

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

**Building.** Heavy answers are built in small steps (see "Free plan" below). While one is being built the API
answers HTTP **202** with

```json
{ "ok": true, "status": "building", "progress": 0.5, "retryAfterSeconds": 2 }
```

Ask the same URL again after `retryAfterSeconds`. Each request moves the work on, and the cron moves queued
reports on every minute too. Finished answers carry `"status": "done"`.

**Caching.** Finished answers are kept for everyone, keyed only by the token or the query:
copy check 5 minutes, launch report 2 minutes (report.js also keeps and refreshes its own 5-minute copy),
wallet links 6 hours. Browsers may keep an answer for 60 seconds
(`Cache-Control: public, max-age=60`). "building", errors and "unavailable" are never cached (`no-store`).
`/v1/health` is `max-age=15`.

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
The answer (`status: "done"`) is the copy-check result from `api/src/copies.js`:
`{ ok, status, query, asOf, indexedFrom, indexComplete, official, matches[], verdict, notes[], caveats[] }`.
Each match has the coin's launch, dev buy and sells, fees, bridges, holders, liquidity, graduation, first buyers,
`flags[]` (each with proof links), `missing[]` (facts that couldn't be read; no flag is ever raised on a blank)
and `proof`. The API never says which coin is "real"; only an address on the official list gets `isOfficial`.

A common name can take a few requests: each request reads about two coins in full (around 18 chain calls each),
keeps them for 5 minutes, and answers 202 until all are read. OBSYN (4 coins) takes 2 requests.

## GET /v1/report/{token}

The launch report for a Pons coin (`api/src/report.js`). When done:

```
{ ok, status: 'done', token: { address, name, symbol, isOfficial, pons: { factory, curve, launchTx, launchBlock, launchTime } }, asOf,
  dev: { address, viaMulticall, buy: { eth, tokens, pct, tx }, moves: [{ type: 'send'|'burn'|'sell'|'buy', tokens, pct, to?, eth?, time, tx, afterGraduation }],
         fees: { claimedEth, unclaimedEth, claims: [{ tx, time, eth }] }, bridges: [{ via, eth, time, tx, destChainId?, destChainConfirmed }], soldPct },
  snipers: { windowBlocks, windowSeconds, totalPct, wallets: [{ address, tokens, pct, block, secondsAfterLaunch,
             status: 'sold-on-curve'|'sold-after-graduation'|'partly-sold'|'holding', soldPct, sellTx? }], clusters: [{ block, wallets }] },
  graduation: { time, tx } | null, activity: { hours: [{ hourStart, buys, newWallets }] },
  verdict, notes: [], caveats: [], missing: [], proof: { token, creator, launchTx } }
```

## GET /v1/report/{token}/links

Wallet links (`api/src/links.js`), fetched by the card **after** the report has rendered:

```
{ ok: true, status: 'done'|'building'|'unavailable',
  funders: [{ wallet, role: 'dev'|'sniper', funder, kind: 'wallet'|'public-service'|'unknown', eth, time, tx }],
  links: [{ wallets: [], reason, proof: [] }], ignored: [{ address, why }], caveat }
```

`unavailable` (HTTP 200, not cached) means the explorer was busy or challenged us; the card shows
"Wallet links unavailable right now" with a retry button. Wallets funded through exchanges, bridges or privacy
tools can't be linked; the `caveat` always says so.

## /mcp

Streamable HTTP MCP server (`api/src/mcp.js`), stateless, no login. Tools (all read-only):
`blame_split({ token, window })`, `check_copycats({ query })`, `launch_report({ token })` (wallet links in a
separate field with `links_status`). Each returns a plain-text summary, the JSON, and proof links. The tools use
the same routes as above, so they share the cache and the building steps.

```
claude mcp add --transport http blamethestock https://api.blamethestock.com/mcp
```

## Free plan: how the Worker stays inside it

Cloudflare Workers free plan, per request: 10 ms CPU, 50 subrequests (each `fetch`, each Cache API call; a
JSON-RPC batch is one), 50 D1 queries; 100,000 requests a day; D1 5M rows read and 100k written a day.

- **Budget** (`api/src/budget.js`): every request and every cron run gets `createBudget({ limit: 45, d1Limit: 45 })`.
  Fetches over the limit are refused at once (JSON-RPC calls get error `-32099`, which the RPC code doesn't retry),
  so a step ends early and saves what it has instead of being cut off. `reserve(n)` keeps two coins from
  starting when only one fits. The RPC module is pointed at a dispatcher that counts each call on the budget of
  the request it belongs to (AsyncLocalStorage).
- **Small persisted steps:** copy-check facts per coin and finished answers go to D1 (`api_cache`). The launch
  report and wallet links keep their own step-by-step jobs (`report_jobs`, `report_cache` in
  `api/schema-reports.sql`); the cron calls their `advanceReportJobs` / `advanceLinkJobs` (the report gets about 60%
  of the cron's remaining budget, links the rest). A module without its own queue would use the Worker's `api_jobs`.
- **RPC batching:** the official node takes up to 6 calls per batch here (10 allowed, but larger batches draw
  429s), dRPC 3; 429s back off and fall over to the next node.
- **Cron, every minute:** the launch indexer gets 25 subrequests and reads at most 50,000 blocks / 30 launches per
  run (about 8-12 subrequests when catching up, fewer in a normal minute); queued jobs get what is left;
  expired cache rows are deleted.
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

The launch index is `api/schema.sql`; the launch report's own tables are `api/schema-reports.sql`.

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
