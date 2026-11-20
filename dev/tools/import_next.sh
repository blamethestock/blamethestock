#!/bin/sh
# Loads the next launch-history files into the live D1 database, newest first, on the free plan's daily budget.
#
#   sh dev/tools/import_next.sh [N]        (default N = 2 files, about 70,000 of the free plan's 100,000 daily writes;
#                                           the minute indexer needs the rest)
#
# It asks D1 how far back the index already reaches (meta.oldest_block) and loads the next N files below that, from
# dev/out/index/export-full (made by: backfill_launches.py DB export dev/out/index/export-full). Each file moves the
# cursor itself, only when it joins on. Run inside the project folder, with `npx wrangler login` done.
set -e
N=${1:-2}
HERE=$(cd "$(dirname "$0")/../.." && pwd)
DIR="$HERE/dev/out/index/export-full"
cd "$HERE/api"

oldest() {
  npx wrangler d1 execute bts --remote --json --command "SELECT value FROM meta WHERE key = 'oldest_block'" 2>/dev/null \
    | grep -o '"value": *"[0-9]*"' | grep -o '[0-9][0-9]*'
}

done_n=0
for f in "$DIR"/launches-*.sql; do
  [ "$done_n" -ge "$N" ] && break
  cur=$(oldest)
  [ -n "$cur" ] || { echo "Couldn't read the cursor from D1; stopping."; exit 1; }
  start=$(grep -m1 '^-- Coverage:' "$f" | grep -o 'blocks [0-9]*' | grep -o '[0-9][0-9]*')
  [ -n "$start" ] || continue
  [ "$start" -lt "$cur" ] || continue                    # already covered
  echo "Loading $(basename "$f") (blocks from $start; index now reaches $cur)…"
  npx wrangler d1 execute bts --remote --yes --file="$f" >/dev/null
  done_n=$((done_n + 1))
done
echo "Loaded $done_n file(s). The index now reaches block $(oldest)."
[ "$done_n" -eq 0 ] && echo "Nothing left to load: the history is complete."
exit 0
