#!/usr/bin/env bash
# The naming step for the receipts. `tests/ui/screenshots.spec.js` writes twelve
# captures into test-results/ under generic names (home, explore, conversation)
# and leaves them there, because test-results/ is gitignored and the folder that
# travels is docs/ui-evidence/direction-a/. This copies them across under their
# published names and refuses to report success unless all twelve landed.
#
# Run it right after the screenshots spec, on the same tree: the capture and the
# copy are one receipt, and a later playwright run wipes test-results/.
set -eu
cd "$(dirname "$0")/../../.."
SRC=test-results
DST=docs/ui-evidence/direction-a

# raw capture name : published screen name. The raw names are the spec's own
# paths, so a rename there breaks here loudly instead of silently skipping.
PAIRS="home:home explore:menus profile:you conversation:thread settings:settings onboarding:onboarding"

for pair in $PAIRS; do
  raw=${pair%%:*}
  out=${pair##*:}
  for width in 390x844 1280x800; do
    suffix=""
    [ "$width" = "1280x800" ] && suffix="-1280x800"
    src="$SRC/$raw$suffix.png"
    dst="$DST/seeded-$out-$width.png"
    [ -f "$src" ] || { echo "missing $src" >&2; exit 1; }
    cp "$src" "$dst"
  done
done

n=$(ls "$DST"/seeded-*.png | wc -l | tr -d ' ')
[ "$n" -eq 12 ] || { echo "expected 12 receipts, found $n" >&2; exit 1; }
echo "copied 12 receipts into $DST"
