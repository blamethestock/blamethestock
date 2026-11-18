#!/bin/sh
# Copies the shared code the local MCP package runs into mcp/src/shared/, so `npx blamethestock-mcp` works on its
# own (the npm package can't reach files outside mcp/). Run it after changing any of the files below; the tests
# (dev/tests/mcp.test.js) fail while a copy differs from its source.
#
#   sh dev/tools/sync_mcp.sh
#
# The copies keep the project's folder layout (shared/site/..., shared/api/src/...), so their relative imports
# work unchanged. Never edit the copies by hand.
set -e
HERE=$(cd "$(dirname "$0")/../.." && pwd)
OUT="$HERE/mcp/src/shared"
rm -rf "$OUT"
mkdir -p "$OUT/site/src" "$OUT/api/src"
cp "$HERE/site/settings.js" "$OUT/site/settings.js"
for d in core data trust features; do
  mkdir -p "$OUT/site/src/$d"
  cp "$HERE/site/src/$d/"*.js "$OUT/site/src/$d/"
done
for f in mcp.js copies.js env.js budget.js report.js links.js; do
  cp "$HERE/api/src/$f" "$OUT/api/src/$f"
done
# the list the tests compare (one path per line, relative to the project folder)
( cd "$OUT" && find . -name '*.js' | sed 's|^\./||' | sort ) > "$HERE/mcp/src/shared-files.txt"
echo "mcp/src/shared: $(wc -l < "$HERE/mcp/src/shared-files.txt" | tr -d ' ') files copied"
