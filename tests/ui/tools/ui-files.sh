#!/usr/bin/env bash
# Runs the UI suite over an explicit slice, so a batch can be sized to fit the
# 10-minute tool budget instead of a whole shard's fixed share.
#
#   ui-files.sh <label> [playwright args...]
#
# Examples:
#   ui-files.sh selffix -- tests/ui/order-card.spec.js
#   ui-files.sh contract-a --shard=1/2 -- tests/ui/ui-contract.spec.js
#
# WORKERS=2 by default: two cores, and the vault derivation is the load.
set -u
LABEL=$1; shift
cd /home/aegis/cipher
OUT=${JCODE_SCRATCH_DIR:-/tmp}/ui-sweep
mkdir -p "$OUT"
npm run preview:stop >/dev/null 2>&1
echo "JCODE_PROGRESS {\"message\":\"$LABEL\"}"
CIPHER_DESKTOP_BUILD=1 npx playwright test --workers=${WORKERS:-2} --reporter=line "$@" > "$OUT/$LABEL.log" 2>&1
STATUS=$?
echo "JCODE_CHECKPOINT {\"message\":\"$LABEL exit=$STATUS\"}"
grep -E "✘|passed|failed" "$OUT/$LABEL.log" | tail -15
exit $STATUS
