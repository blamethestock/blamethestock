#!/bin/sh
# Runs every test file listed in dev/tests/run.js with Safari's JavaScript engine (jsc).
# Usage: sh dev/run-tests.sh      Exit code 0 = everything passed, 1 = something failed.
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc
HERE=$(cd "$(dirname "$0")" && pwd) || exit 1
OUT=$("$JSC" -m "$HERE/tests/run.js" 2>&1)
CODE=$?
printf '%s\n' "$OUT"
if [ "$CODE" -ne 0 ]; then
  echo "jsc stopped with exit code $CODE"
  exit 1
fi
# Pass only when the runner itself says so (a crash or a broken import never prints this line).
printf '%s\n' "$OUT" | grep -q '^RESULT: PASS' || exit 1
exit 0
