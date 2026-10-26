#!/usr/bin/env bash
# Fetch the Tor Expert Bundle (client only) for linux x86_64, check its
# sha256 against this file's pinned value, and stage it under vendor/tor/
# so the portable bundle ships a bundled tor (docs/DESKTOP.md: "Tor: always
# on and bundled").
#
# The download is not committed: vendor/tor/ is git-ignored. Run this script
# before `npm run dist`.
#
# Version 15.0.26, pinned 2026-10-26:
#   https://dist.torproject.org/torbrowser/15.0.26/sha256sums-signed-build.txt
#   19cf18726eecb362e0f21d27afa9ea9efe5da928bfdfbb1ceb5fe54519e87f4a
#     tor-expert-bundle-linux-x86_64-15.0.26.tar.gz
# (verified in the build sandbox by downloading and hashing the file itself)
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
version="15.0.26"
expected="19cf18726eecb362e0f21d27afa9ea9efe5da928bfdfbb1ceb5fe54519e87f4a"
url="https://dist.torproject.org/torbrowser/${version}/tor-expert-bundle-linux-x86_64-${version}.tar.gz"

if [ "$(uname -m)" != "x86_64" ]; then
  echo "This pin is for linux x86_64. This machine is $(uname -m): update the version and checksum in this script first." >&2
  exit 1
fi

command -v curl >/dev/null || { echo "curl is needed to download the tor bundle." >&2; exit 1; }
command -v sha256sum >/dev/null || { echo "sha256sum is needed to check the download." >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Downloading ${url}"
curl -fsSL --retry 3 -o "${work}/tor.tar.gz" "$url"

echo "Checking sha256"
actual="$(sha256sum "${work}/tor.tar.gz" | awk '{print $1}')"
if [ "$actual" != "$expected" ]; then
  echo "The download does not match the pinned checksum." >&2
  echo "  expected: $expected" >&2
  echo "  actual:   $actual" >&2
  echo "Do NOT stage it. If upstream replaced the file, update the version and checksum in this script after checking why." >&2
  exit 1
fi

echo "Staging the bundle content under desktop/vendor/tor/"
mkdir -p "${work}/extract" "${here}/vendor/tor.tmp"
tar -xzf "${work}/tor.tar.gz" -C "${work}/extract"
# The bundle's own layout: tor/tor with its libraries beside it, data/ with
# geoip files. Copied as-is so the binary finds its own libraries.
cp -a "${work}/extract/." "${here}/vendor/tor.tmp/"
chmod +x "${here}/vendor/tor.tmp/tor/tor" "${here}/vendor/tor.tmp/tor/pluggable_transports/"lyrebird conjure-client 2>/dev/null || true
rm -rf "${here}/vendor/tor"
mv "${here}/vendor/tor.tmp" "${here}/vendor/tor"

echo "Done. The bundled tor is at desktop/vendor/tor/tor/tor"
echo "It is not committed (vendor/tor/ is git-ignored); it ships inside the tar.gz bundle."
