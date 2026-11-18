#!/bin/sh
# Local end-to-end run of the API Worker. Nothing leaves this machine except read-only chain/explorer calls
# the Worker makes itself. No Cloudflare login, no deploy.
#
#   sh dev/tools/local_e2e.sh [EXPORT_DIR] [--fresh] [--detach] [--test-scheduled]
#
#   EXPORT_DIR        folder with launches-*.sql + meta.sql from `backfill_launches.py export` (or set
#                     BTS_EXPORT_DIR). Without it the index starts empty and the cron fills it from ~1 minute back.
#   --fresh           delete the local D1 first (api/.wrangler/state) and build it again
#   --detach          leave wrangler dev running in the background and return (its PID and log file are printed)
#   --test-scheduled  also expose http://localhost:8787/__scheduled (runs the cron once per visit)
#   BTS_PORT=8797     use another port (default 8787)
#
# Steps: local D1 "bts" <- api/schema.sql + api/schema-reports.sql (+ the Worker's own tables) <- the export,
# then `wrangler dev --local --port 8787`, then GET /v1/health is printed.
# Needs: Node.js, and `npm install` done inside api/.

ROOT=$(cd "$(dirname "$0")/../.." && pwd) || exit 1
API="$ROOT/api"
PORT="${BTS_PORT:-8787}"
EXPORT_DIR="${BTS_EXPORT_DIR:-}"
FRESH=0
DETACH=0
SCHED=""
for a in "$@"; do
  case "$a" in
    --fresh) FRESH=1 ;;
    --detach) DETACH=1 ;;
    --test-scheduled) SCHED="--test-scheduled" ;;
    -*) echo "Unknown option: $a"; exit 2 ;;
    *) EXPORT_DIR="$a" ;;
  esac
done

case "$PORT" in ''|*[!0-9]*) echo "BTS_PORT must be a number"; exit 2 ;; esac

cd "$API" || exit 1
# Another server already on the port would answer the health check below and hide that ours didn't start.
if curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/"; then
  echo "Port $PORT is already in use (another wrangler dev?). Stop it, or pick another port: BTS_PORT=8797 sh dev/tools/local_e2e.sh"
  exit 1
fi
if [ ! -x node_modules/.bin/wrangler ]; then
  echo "wrangler isn't installed yet. Run: cd api && npm install"
  exit 1
fi
W="node_modules/.bin/wrangler"

if [ "$FRESH" -eq 1 ]; then
  echo "Removing the local D1 (api/.wrangler/state)…"
  rm -rf .wrangler/state
fi

d1() { "$W" d1 execute bts --local --yes "$@" >/dev/null 2>"${TMPDIR:-/tmp}/bts-d1-err.txt" || { echo "D1 step failed: $*"; cat "${TMPDIR:-/tmp}/bts-d1-err.txt"; exit 1; }; }

echo "1. Tables"
d1 --file=schema.sql
if [ -f schema-reports.sql ]; then
  d1 --file=schema-reports.sql
else
  echo "   (api/schema-reports.sql not there yet: launch-report tables skipped)"
fi
# The Worker's own cache and job tables (it also creates them itself on first use; same SQL as SQL_SCHEMA in worker.js).
d1 --command="CREATE TABLE IF NOT EXISTS api_cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, expires INTEGER NOT NULL); CREATE INDEX IF NOT EXISTS idx_api_cache_expires ON api_cache (expires); CREATE TABLE IF NOT EXISTS api_jobs (key TEXT PRIMARY KEY, kind TEXT NOT NULL, token TEXT NOT NULL, created INTEGER NOT NULL, touched INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, progress REAL); CREATE INDEX IF NOT EXISTS idx_api_jobs_touched ON api_jobs (touched); CREATE INDEX IF NOT EXISTS idx_api_jobs_created ON api_jobs (created)"

echo "2. Launch index"
if [ -n "$EXPORT_DIR" ] && [ -d "$EXPORT_DIR" ]; then
  n=0
  for f in "$EXPORT_DIR"/launches-*.sql; do
    [ -f "$f" ] || continue
    echo "   importing $(basename "$f")"
    d1 --file="$f"
    n=$((n + 1))
  done
  if [ -f "$EXPORT_DIR/meta.sql" ]; then d1 --file="$EXPORT_DIR/meta.sql"; fi
  echo "   $n file(s) imported"
else
  echo "   no export folder given: the index starts empty (the cron fills it from about a minute back)"
fi
"$W" d1 execute bts --local --yes --json --command="SELECT COUNT(*) AS launches, (SELECT value FROM meta WHERE key='last_block') AS last_block, (SELECT value FROM meta WHERE key='oldest_block') AS oldest_block FROM launches" 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s)[0].results[0];console.log("   "+r.launches+" launches, blocks "+r.oldest_block+" to "+r.last_block)}catch(e){console.log("   (count unavailable)")}})'

echo "3. wrangler dev on http://localhost:$PORT"
LOG="${TMPDIR:-/tmp}/bts-wrangler-dev.log"
"$W" dev --local --port "$PORT" --show-interactive-dev-session=false $SCHED >"$LOG" 2>&1 &
PID=$!
ok=0
i=0
while [ $i -lt 60 ]; do
  if ! kill -0 "$PID" 2>/dev/null; then break; fi
  if curl -s -o /dev/null "http://localhost:$PORT/v1/health"; then ok=1; break; fi
  sleep 1
  i=$((i + 1))
done
if [ "$ok" -ne 1 ]; then
  echo "wrangler dev didn't start. Last lines of $LOG:"
  tail -30 "$LOG"
  kill "$PID" 2>/dev/null
  exit 1
fi

echo "4. GET /v1/health"
curl -s "http://localhost:$PORT/v1/health" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.stringify(JSON.parse(s),null,2))}catch(e){console.log(s)}})'
echo
echo "Try:  curl -s 'http://localhost:$PORT/v1/copies?q=OBSYN'"
[ -n "$SCHED" ] && echo "Cron: curl -s 'http://localhost:$PORT/__scheduled'"

if [ "$DETACH" -eq 1 ]; then
  echo "wrangler dev is running in the background (PID $PID, log $LOG). Stop it with: kill $PID"
  exit 0
fi
echo "wrangler dev is running (log $LOG). Press Ctrl-C to stop."
trap 'kill "$PID" 2>/dev/null; exit 0' INT TERM
wait "$PID"
