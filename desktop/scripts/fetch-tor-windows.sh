#!/usr/bin/env bash
# Fetch the Tor Expert Bundle (client only) for windows x86_64, check its
# sha256 against this file's pinned value, and stage it under vendor/tor/
# so the portable bundle ships a bundled tor (docs/DESKTOP.md: "Tor: always
# on and bundled"). Windows layout note, verified in the download: the
# bundle stages tor/tor.exe (and pluggable_transports/*.exe beside it), so
# this script chmods the .exe names — the packer reads the same vendor/
# folder fetch-tor.sh uses for the Linux pack, one currency staged at a
# time: re-run fetch-tor.sh before building a Linux bundle again.
#
# The download is not committed: vendor/tor/ is git-ignored. Run this script
# before `npm run dist -- --win`.
#
# Version 15.0.26, pinned 2026-10-27:
#   https://dist.torproject.org/torbrowser/15.0.26/sha256sums-signed-build.txt
#   c1988c701de2f24f7d098d1d6d7f507b58f27740d097f29c246e0524d639b252
#     tor-expert-bundle-windows-x86_64-15.0.26.tar.gz
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
version="15.0.26"
expected="c1988c701de2f24f7d098d1d6d7f507b58f27740d097f29c246e0524d639b252"
url="https://dist.torproject.org/torbrowser/${version}/tor-expert-bundle-windows-x86_64-${version}.tar.gz"

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
# The bundle's own layout: tor/tor.exe with the pluggable transports beside
# it, data/ with the geoip files. Windows tor needs no shared libraries
# beside it (statically linked), so the exe is staged as-is.
cp -a "${work}/extract/." "${here}/vendor/tor.tmp/"
chmod +x "${here}/vendor/tor.tmp/tor/tor.exe" "${here}/vendor/tor.tmp/tor/pluggable_transports/"lyrebird.exe conjure-client.exe 2>/dev/null || true
rm -rf "${here}/vendor/tor"
mv "${here}/vendor/tor.tmp" "${here}/vendor/tor"

echo "Done. The bundled tor is at desktop/vendor/tor/tor/tor.exe"
echo "It is not committed (vendor/tor/ is git-ignored); it ships inside the tar.gz bundle."
