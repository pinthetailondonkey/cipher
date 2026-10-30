# Cipher Desktop

The desktop shell. Design and locked decisions: `docs/DESKTOP.md`
(feat/desktop-shell). One quote that shapes everything here:

> Tor: always on and bundled. The shell starts its own Tor, sends every
> connection through it, and stops it on quit. No settings to get right.

The messenger, group and commerce code is the web app's own code - the
shell loads its built web app unmodified and adds no second messaging path.

## Layout

- `src/main.js` - thin electron wiring: the proxy pinned before any page
  loads, tor lifecycle, the window. All logic lives beside it so it runs in
  tests without electron.
- `src/windowPolicy.js` - what a window may do: no pop-ups, no navigation
  off the UI origin, no webviews, WebRTC locked. Applied to every window.
- `src/tor.js` - tor arguments, Tails detection from `/etc/os-release`.
- `src/paths.js` - data beside the app. `docs/DESKTOP.md`: "Keys, chats and
  settings live in a folder beside the app. On Tails, dragging that folder
  into Persistent Storage is the persistence switch; on a normal desktop,
  the same folder is what a backup copies."
- `src/uiServer.js` - loopback-only server on `127.0.0.1:9151` that serves
  the web build (`../dist` in dev, `web/` in the bundle). It sends a
  Content-Security-Policy, nosniff and no-referrer on every answer. The proxy bypass list covers ONLY this server (port 9151);
  everything else - relays, media, watcher, even DNS - rides Tor.
- `test/` - `node:test` unit tests, plain node, no electron.
- `scripts/fetch-tor.sh` - downloads the Tor Expert Bundle, checks its
  sha256 against the pinned checksum in the script, stages it under
  `vendor/tor/` (git-ignored, never committed).
- `scripts/fetch-tor-windows.sh` - the same for the Windows tor (`tor.exe`).
- `scripts/prepare-pack.mjs` - before packing: stages the web build into
  `web/` and checks `vendor/tor/` holds the tor for the platform being packed.
- `electron-builder.yml` - portable tar.gz bundles for Linux and Windows. No
  installer on purpose: the Linux one runs on Tails with no FUSE/AppImage
  machinery, and deb is deferred (docs/DESKTOP.md).

## Run it (dev)

```
npm install                 # or reuse the spike's install via a node_modules symlink
npm run build               # in the cipher repo root: builds dist/ the shell loads
CIPHER_DIST=/path/to/dist npm start
```

On a normal desktop, `npm start` without CIPHER_DIST loads the repo's own
`../dist`. On first run the data folder is created at `desktop/data/`.

## Portable bundle

Folders, all git-ignored: `vendor/` (the downloaded tor), `web/` (the staged
web build), `out/` (electron-builder's output). The web build is staged in
`web/` and the output goes to `out/` so neither can be packed into the other.
An earlier layout staged into `dist/`, which was also the output folder, and the
Windows `app.asar` came out 1.18 GB with the Linux tarball inside it.

`scripts/fetch-tor.sh` (Linux) and `scripts/fetch-tor-windows.sh` (Windows)
write into the SAME `vendor/tor/` and each replaces it whole. Fetch the one
for the bundle you are about to pack, then pack, then switch. `npm run dist`
and `npm run dist:win` refuse to pack if `vendor/tor/` holds the other
platform's tor.

Linux:

```
npm run build                   # in the cipher repo root: builds dist/
cd desktop
scripts/fetch-tor.sh            # stages the Linux tor in vendor/ (checksum-checked)
npm run dist                    # stages web/, packs a tar.gz under out/
```

Windows (a portable archive, no installer; packing on Linux may need wine):

```
npm run build                   # in the cipher repo root
cd desktop
scripts/fetch-tor-windows.sh    # replaces vendor/tor/ with the Windows tor
npm run dist:win                # stages web/, packs a tar.gz under out/
```

Never commit `vendor/`, `web/` or `out/`. The tor binary is a downloaded
artifact, not source.

## Tails

```
TAILS=1 npm start
```

On Tails the shell never spawns a tor: a second client would route inside a
route (docs/DESKTOP.md). It uses the system tor on `127.0.0.1:9050`, which
is why 9050 is the default `TOR_SOCKS` for every mode. Detection: env
`TAILS=1` wins, otherwise the `ID=tails` line of `/etc/os-release` decides.
The tor we spawn ourselves gets an ephemeral data folder that is deleted on
quit; the system tor on Tails is never ours to touch.

## Env

- `CIPHER_DIST` - path to a built web app (default: `../dist` in dev,
  `web/` in the bundle).
- `TOR_BIN` - tor executable (default: the bundled `vendor/tor/tor/tor`,
  else `tor` on PATH).
- `TOR_SOCKS` - socks port. Default: 9050 on Tails (or the system torrc's
  port); elsewhere 9050 if free, otherwise a random free port for our own tor.
- `TAILS=1` - force system-tor mode.
- `CIPHER_CALLS=1` - development escape hatch ONLY: re-enables WebRTC in
  private mode. Ships disabled.

## What the shell does and does not do

- The SOCKS route is pinned before any page loads, so every backend
  connection rides Tor from the first byte (docs/DESKTOP.md, "The engine").
- In private mode WebRTC is hard-disabled at the engine level
  (`disable_non_proxied_udp`) and mic/camera permission is refused, so a
  call refuses to start rather than failing halfway. The page-level refusal
  in `src/lib/voiceCall.js` stays as the second lock.
- If the bundled tor exits on its own, the shell says so and restarts it on
  the same port, at most three times in ten minutes; then it says it gave up.
  While tor is down every connection fails. If 9050 is already taken, the
  shell and its own tor use a random free port instead of pointing at
  whatever listens on 9050.
- If tor cannot start, the app fails loudly and every connection fails
  instead of leaking. There is no clearnet fallback, ever.
- Data resolution is deterministic and unit-tested; if the folder beside
  the app cannot be written (a deb-style install), the app says so in plain
  words and points at the portable build.
- No auto-update (docs/DESKTOP.md: updates stay reviewable artifacts).
  No notification changes.
- The vendor payment watcher and push gateway stay the command-line boxes
  they are (`scripts/payment-watcher.mjs`, `scripts/notify-gateway.mjs`);
  the shell does not carry a wallet stack.

## Known gap

No icon yet (docs/DESKTOP.md build order step 2); the bundle carries the
default placeholder. TODO noted in `electron-builder.yml`.
