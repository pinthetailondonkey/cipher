#!/usr/bin/env bash
# One sitting's sweep, in batches sized for a 10-minute tool cap, each batch
# stamped with the sha it built and whether the tree was dirty. Writes a TSV the
# receipts can quote instead of a remembered total.
set -u
cd /home/aegis/cipher
OUT=${JCODE_SCRATCH_DIR:-/tmp}/ui-sweep
mkdir -p "$OUT"
SUM=$OUT/sweep.tsv
: > "$SUM"

run() {
  local label=$1; shift
  local sha dirty
  sha=$(git rev-parse --short HEAD)
  dirty=$(git status --porcelain | wc -l | tr -d ' ')
  npm run preview:stop >/dev/null 2>&1
  WORKERS=${WORKERS:-2} CIPHER_DESKTOP_BUILD=1 npx playwright test --workers=${WORKERS:-2} --reporter=line "$@" > "$OUT/$label.log" 2>&1
  local status=$?
  # A parallel lane mid-edit can leave the tree unbuildable for a minute (an
  # apostrophe inside a single-quoted string did). That is a build failure, not
  # a red batch: wait once and retry rather than recording it as one.
  if [ "$status" -ne 0 ] && grep -q 'was not able to start' "$OUT/$label.log"; then
    echo "JCODE_PROGRESS {\"message\":\"$label build refused, retrying in 60s\"}"
    sleep 60
    sha=$(git rev-parse --short HEAD)
    dirty=$(git status --porcelain | wc -l | tr -d ' ')
    npm run preview:stop >/dev/null 2>&1
    WORKERS=${WORKERS:-2} CIPHER_DESKTOP_BUILD=1 npx playwright test --workers=${WORKERS:-2} --reporter=line "$@" > "$OUT/$label.log" 2>&1
    status=$?
  fi
  local line
  line=$(grep -E "^ +[0-9]+ (passed|failed)" "$OUT/$label.log" | tail -1 | sed 's/^ *//')
  printf '%s\t%s\tdirty=%s\texit=%s\t%s\n' "$label" "$sha" "$dirty" "$status" "$line" | tee -a "$SUM"
  echo "JCODE_PROGRESS {\"message\":\"$label $sha dirty=$dirty $line\"}"
  npm run preview:stop >/dev/null 2>&1
}

echo "JCODE_PROGRESS {\"message\":\"sweep start $(git rev-parse --short HEAD)\"}"

run sweep-shots     tests/ui/screenshots.spec.js
run sweep-contract  tests/ui/ui-contract.spec.js tests/ui/sheet-a11y.spec.js
run sweep-shells    tests/ui/check-catch.spec.js tests/ui/command-palette.spec.js tests/ui/how-to-screen.spec.js tests/ui/keypad.spec.js tests/ui/modal-typing.spec.js tests/ui/motion.spec.js tests/ui/txid-single.spec.js
run sweep-gate      tests/ui/pin-unlock.spec.js tests/ui/passkey-recovery-commit.spec.js
run sweep-restore   tests/ui/restore-commit.spec.js tests/ui/restore-handle-commit.spec.js tests/ui/restore-preflight.spec.js tests/ui/row6b-shared-address.spec.js tests/ui/relay-wall.spec.js
run sweep-boot      tests/ui/persistence.spec.js tests/ui/order-card.spec.js tests/ui/onboarding-tour.spec.js tests/ui/profile-open.spec.js tests/ui/account-switch.spec.js
run sweep-area      tests/ui/pwa-standalone-top.spec.js tests/ui/safe-area.spec.js
run sweep-install   tests/ui/pwa-standalone-bottom.spec.js tests/ui/session-boot.spec.js
run sweep-strip     tests/ui/pwa-standalone-strip.spec.js
run sweep-select    tests/ui/pwa-standalone-select.spec.js
run sweep-prf       --project=chromium tests/ui/devicePrf.spec.js tests/ui/account-switch.devicePrf.spec.js

echo "JCODE_PROGRESS {\"message\":\"sweep done\"}"
cat "$SUM"
