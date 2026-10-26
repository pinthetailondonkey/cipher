# Cipher Desktop

The desktop shell. Design and locked decisions: `docs/DESKTOP.md`
(feat/desktop-shell). One quote that shapes everything here:

> Tor: always on and bundled. The shell starts its own Tor, sends every
> connection through it, and stops it on quit. No settings to get right.

The messenger, group and commerce code is the web app's own code - the
shell loads its built `dist/` unmodified and adds no second messaging path.

## Layout

- `src/main.js` - thin electron wiring: the proxy pinned before any page
  loads, tor lifecycle, the window. All logic lives beside it so it runs in
  tests without electron.
- `src/tor.js` - tor arguments, Tails detection from `/etc/os-release`.
- `src/paths.js` - data beside the app. `docs/DESKTOP.md`: "Keys, chats and
  settings live in a folder beside the app. On Tails, dragging that folder
  into Persistent Storage is the persistence switch; on a normal desktop,
  the same folder is what a backup copies."
- `src/uiServer.js` - loopback-only server on `127.0.0.1:9151` that serves
  `dist/`. The proxy bypass list covers ONLY this server (port 9151);
  everything else - relays, media, watcher, even DNS - rides Tor.
- `test/` - `node:test` unit tests, plain node, no electron.
- `scripts/fetch-tor.sh` - downloads the Tor Expert Bundle, checks its
  sha256 against the pinned checksum in the script, stages it under
  `vendor/tor/` (git-ignored, never committed).
- `electron-builder.yml` - the portable tar.gz bundle. That is the only v1
  target on purpose: it runs on Tails with no FUSE/AppImage machinery, and
  deb is deferred (docs/DESKTOP.md).

## Run it (dev)

```
npm install                 # or reuse the spike's install via a node_modules symlink
npm run build               # in the cipher repo root: builds dist/ the shell loads
CIPHER_DIST=/path/to/dist npm start
```

On a normal desktop, `npm start` without CIPHER_DIST loads the repo's own
`../dist`. On first run the data folder is created at `desktop/data/`.

## Portable bundle

```
desktop/scripts/fetch-tor.sh    # one-time: stages the bundled tor (checksum-checked)
cp -r ../dist dist              # stage the built web app
npm run dist                    # tar.gz under dist/ (electron-builder output)
```

Never commit `vendor/` or the staged `dist/` copy; both are git-ignored,
and the tor binary is a downloaded artifact, not source.

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

- `CIPHER_DIST` - path to a built `dist/` (default: `../dist` in dev,
  `dist/` in the bundle).
- `TOR_BIN` - tor executable (default: the bundled `vendor/tor/tor/tor`,
  else `tor` on PATH).
- `TOR_SOCKS` - socks port, default 9050.
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
