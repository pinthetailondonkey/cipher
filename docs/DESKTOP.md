# Cipher Desktop

The desktop shell design. Built so far (see desktop/README.md): the Linux and
Windows portable bundles, the always-on bundled Tor, the loopback UI server and
the window locks. Not built yet: macOS, the Privacy switch and its banner, an
icon, the system-Tor path being tested on a real Tails. Decisions below were made by the founder on 2026-10-26; they are locked
unless the founder changes them.

## What it is

One program: the same Cipher the browser serves, wrapped in a shell that
always speaks Tor. The messenger, group and commerce code is the web app's
own code — the shell does not rewrap NIP-44, group AAD or the outbox, and
does not add a second messaging path. The web stays; the desktop is a
front door, not a fork.

## Locked decisions

- Reach: Tails and normal desktops. Windows gets the first installer;
  macOS follows.
- Tor: always on and bundled. The shell starts its own Tor, sends every
  connection through it, and stops it on quit. No settings to get right.
  On Tails the shell uses the system Tor instead — a second client there
  would route inside a route and slow everything down.
- Voice calls: on when Tor is off, off when Tor is on. Public mode is an
  explicit choice; in Tor mode the shell hard-disables WebRTC at the
  engine level, so a call refuses to start rather than failing halfway.
- The app is named Cipher — in the dock, the menu bar, the window title.
- Keys, chats and settings live in a folder beside the app. On Tails,
  dragging that folder into Persistent Storage is the persistence switch;
  on a normal desktop, the same folder is what a backup copies.
- In version 1 the vendor runs the payment watcher and the push gateway
  as the command-line boxes they are today, unchanged
  (scripts/payment-watcher.mjs with WATCH_HOST, scripts/notify-gateway.mjs
  with PUSH_HOST — default 127.0.0.1, on feat/tor-tails).

## The engine

Electron, because it is the one shell whose networking the app controls
at launch: the SOCKS route is set before any page loads, so every backend
connection — WebSocket relays, HTTPS media, the watcher — rides Tor from
the first byte. Web engines the OS provides (Tauri's Linux cadre included)
do not offer that control, and uncontrolled was the exact gap the Tails
investigation flagged. This is one new dependency with a stated reason.

## The Privacy switch

One switch, plainly named, default on. First run asks once:

Private mode sends everything through Tor. Voice calls are unavailable
while it is on. Turn it off only if this network is clean.

With Tor on, Connections marks rows that would leave the route, the same
badge list it already draws (`src/lib/egress.js` is the master list; the
shell adds no hosts of its own). With Tor off, one honest banner:

You are not private right now.

Notifications while the app is open use the shell's native notification
path; tags t=msg, t=order, t=call keep their meaning and the browser
throttle (`notificationThrottle`) still draws the line. The locked-phone
buzz stays the gateway's job, unchanged.

## Out of version 1, on purpose

- Phone packaging. Parked until ciphermessenger.org serves the desktop build.
- Auto-update. Fetching new builds over the network is a supply-chain
  surface; version 1 updates the manual way, and every update stays a
  reviewable artifact.
- The watcher inside the app. One program that carries a wallet stack is
  a bigger blast radius than a first ship deserves.

## Build order, smallest first

1. Throwaway spike outside the repo: a shell that loads `dist/`, pins the
   SOCKS switch, starts a Tor client, proves a DM round-trips. Earns its
   place in the repo or dies.
2. Packaging: icon, installer, Windows first. `Cipher` in every label.
3. The seam: the Privacy switch, WebRTC hard-off, the off banner.
4. The Tails profile: system Tor mode, data beside the app, the boot
   ritual documented as words in the app, not as a wiki page.
5. Polish, then the promised desktop asks from the founder vision.

## The download page — copy for the site (the founder's own hands paste it)

The static download page lives on the app-host site, outside this repo. Copy:

> Cipher is a messenger and a shop. Your messages, payments and pictures travel encrypted, and nothing here reports back to us.
> The desktop app routes everything through Tor, built in — your address never rides the envelope in the clear.
> Prefer the browser version? Run a VPN alongside it — it keeps your IP address harder to see.

## Honest costs

- One heavier download: the bundled Tor.
- One new trust surface: a program that ships a network engine. Updates
  are review artifacts for now, not background installs.
- In Tor mode, voice calls are structurally absent. That is the design
  working. No private messenger has ever crossed that wall, and this one
  does not pretend to.

## Relationship to Tor-on-Tails

The Tails web path (feat/tor-tails: the mirror, watcher and gateway bound
to 127.0.0.1, served as a local hidden service) is the desk-shape this app
walks into: the shell replaces the boot ritual with a window, and later
the hidden-service mirror retires into the shell's own loader. Both plans
share one law: no public block explorer, ever, and no host outside
`src/lib/egress.js`.
