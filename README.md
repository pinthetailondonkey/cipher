# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some Oxlint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the Oxlint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and Oxlint's TypeScript related rules in your project.

## Commerce and native notifications

- Vendors can broadcast a product card to joined groups and group admins can feature one group product as the pinned listing.
- Optional account-level Bitcoin xpub and Monero private view key settings are encrypted locally using a key derived from the unlocked Cipher identity. Bitcoin receiving addresses use the BIP-84 external chain. Monero subaddresses are derived on the device with `@noble/curves` (ed25519) and keccak. The spend key and seed phrase are not requested. `monero-ts` and its WebAssembly wallet are not part of the app, so derivation does not need WASM and still runs when Tor Browser has WASM off. View-only: the private view key must match the primary address. Index 0 is that address. Any other index is a subaddress.
- Buyers can select Bitcoin, Monero, or both in Advanced Settings. Accepted orders derive only the selected currencies. Existing primary addresses remain the fallback when address derivation is not configured.
- While the app is open, local notifications fire for messages and orders. A locked phone is the push box's job. APNs is in: iOS has no other way to buzz. The gateway sends for `t=msg`, `t=order`, and `t=call` only when `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_TOPIC` are all set. They are not set in this repo, and no iPhone was buzzed, so the installed app does not notify.
- The Nostr outbox persists rejected events, displays delivery state, retries with capped exponential backoff, and flushes on network/relay reconnection. A service worker caches the app shell and same-origin build assets for offline reopening; relay delivery still requires a connection.
- Content-Security-Policy allows HTTPS images (`img-src` includes `https:`), so remote profile pictures and Blossom images can render. Remote audio and video stay blocked: `media-src` is `'self' blob:` only. `connect-src` still allows `https:` plus the listed Nostr relays.
- `Strict-Transport-Security` is `max-age=63072000; includeSubDomains; preload`. The production host already sends that policy; `vercel.json` now declares it as well.
- The installed shell loads the bundled files in `dist`. `capacitor.config.json` has no `server.url`. Putting that field back on `https://sonic-cobalt-4m6q5vj.vercel.app` makes every native open hit Vercel. The website is still that Vercel host until you serve the mirror yourself. `vercel.json` no longer matches the live response: `upgrade-insecure-requests` is gone, and `connect-src` now allows `http:`, `ws:`, `stun:`, `stuns:`, `turn:`, and `turns:` so a pasted relay or `.onion` is not blocked. `img-src` allows `https:` and `http://*.onion` only, so a clearnet `http` image does not load. The live host keeps the old policy until the next deploy. What the Vercel projects are, which one is canonical, and how a deploy is verified: see [Vercel](#vercel).

## Vercel

The team sits under the Vercel org id `team_Bv4z3VGkmdizi5WrM1btO2ih` and holds three projects. That comes from the dashboard, not from this repo: `.vercel/` is gitignored (the checkout carries `.vercel/repo.json`, not git), so the repo can name only one of the three.

- `cipher` is the project this repo links to. `.vercel/repo.json` in the checkout names it with `prj_mlaczix1ryrdsu5cuO0Bqy5n4JA1` under that org id. Its host is `https://sonic-cobalt-4m6q5vj.vercel.app`, listed in `src/lib/egress.js` as the App host.
- `https://cipher-beta-eight.vercel.app` is one of the other two. Older text called it a different project serving a different build (rechecked 2026-10-24: HTTP 200, `/assets/index-DuivEAWZ.js`, no `Content-Security-Policy`, no `X-Content-Type-Options`) and said to treat it as live until the hostname was attached to this project. That claim is stale. Rechecked 2026-10-25, the hostname is attached and this repo's `vercel.json` redirect now runs on it: it answers 308 with `location: https://sonic-cobalt-4m6q5vj.vercel.app/`. It is not reachable as an app anymore.
- The third project is not named anywhere in the repo. Its name and role is an open question below.

Canonical: `vercel.json` declares a permanent 308 from `cipher-beta-eight.vercel.app` to `https://sonic-cobalt-4m6q5vj.vercel.app/$1`, so sonic is the destination this repo points every other host at, and the redirect now takes effect on the one other host it governs. Whether any further host must redirect, and which of the three projects the other hostnames belong to, the repo does not establish. Nothing here makes sonic canonical beyond being that redirect destination.

Checks made on 2026-10-25, live:

- A deploy is verified by the page itself, never by a status code. Reading HTTP 200 as success is what left the stale beta-eight text standing: a redirect page, a gate, or another project's page can all answer 200. The page that proves the deploy is the one this repo ships: `<title>Cipher</title>` from `index.html`, and the asset bundle it loads matches a build of the checked-out commit.
- The live page at sonic answers with `<title>Cipher</title>`, and its bundle is `assets/index-Cu7vDotz.js`, last-modified 2026-10-24 19:25:57 UTC. No build of this repo's current `main` produces that bundle name, so the live deploy predates main as it stands now.
- The live host still sends the old policy: `upgrade-insecure-requests` present, `img-src` without `http://*.onion`, `connect-src` `https:` plus the relay list. `vercel.json` and the live response still disagree until a redeploy picks the current file up.
- What the live host does send, matching `vercel.json`: `Strict-Transport-Security` `max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and the `Permissions-Policy` line.

There is no custom domain. No domain other than the two hosts above appears anywhere in the repo or in `vercel.json`.

SSO protection (`ssoProtection`) is disabled on the projects. That is a dashboard fact; the repo cannot confirm it, and a project with it on would answer the page fetch with a Vercel sign-in screen instead of `<title>Cipher</title>` — which is exactly the check the bullets above run.

Open questions, nothing here settles them:

- What are the other two Vercel projects' names, and which, if any, still serves traffic of its own?
- What is the team's human name behind `team_Bv4z3VGkmdizi5WrM1btO2ih`?
- Which commit is the live sonic deploy cut from, and when does a redeploy carry the current `vercel.json` — the new CSP — onto the host?

## Tor

For IP privacy, use Tor Browser or a VPN. The app does not manage this.

The app used to have a Tor-only switch. That only policed hosts the app chose to call. A browser or system proxy covers images, previews, DNS, and calls, and a web page cannot set its own proxy. Decision: Tor-only is out. It gates no row. Not groups, not messages, not profiles, not search, not pictures, not calls. A pasted onion replaces only the row you paste it on. There is no clearnet banner and no onion probe.

Profile → Connections lists every host. That list is `src/lib/egress.js`. A test fails if a new `wss://`, `https://`, or `stun:` host appears anywhere else in `src`. Defaults are hardcoded and work with nothing pasted. Advanced, hidden until opened, is where a row can be pointed at an `.onion` or a box you run. Type `off` to drop that host. An onion relay needs Tor Browser or Orbot. From an HTTPS page, a plain `ws://` onion is blocked as mixed content. Restart after changing a relay.

Android: Orbot VPN mode. iOS: Onion Browser, or the HTTP onion mirror once you have one. Calls reveal your IP unless the whole device is routed. Calls use UDP, so Tor Browser alone will not cover them. Orbot’s VPN mode will.

Direct messages and group traffic do not share a relay. Groups stay on the group relay. Messages stay on the message relay, plus the other person’s published inbox (NIP-65, kind 10002) when they have one. With more than one message relay, each person is written to only one of yours, so no single relay holds every conversation. Someone with no published inbox still receives on your first message relay.

There is no chain explorer and no remote Monero node. Subaddresses are derived on the device. That math does not phone home and does not use WASM. Indexes are 32-bit little-endian integers, including past 127. The subaddress prefix is 42, and the checksum covers that prefix. High indexes were checked against knaccc/subaddress-js 1.0.3, which is not shipped in the app.

A payment moves created → address issued → seen → confirmed. Accepting an order issues the address. "I saw the payment" means the vendor saw it in their own wallet. That is not a chain confirmation, and the screen says so. "Check the chain" asks only the Payment watcher pasted in Connections. The address is sent to that host. A public block explorer is refused and is not contacted. The pasted URL must include `?token=`, and the phone sends that token. Seen and confirmed come only from a watcher report. The watcher row is empty. With no watcher, a payment cannot become confirmed. There is no other path to confirmed.

Bitcoin confirms at 3. Monero confirms at 10. A `confirmed: true` flag with fewer confirmations does not count. Change the phone with the `cipher_confirmations` setting, shaped `{ "btc": 3, "xmr": 10 }`. The watcher you run must be started with `WATCH_TOKEN`. It asks a Monero wallet RPC or a Bitcoin node only if you set `XMR_WALLET_RPC` or `BTC_RPC_URL`. Bitcoin uses `scantxoutset` on that node. It does not need a wallet or a transaction index, and it does not see a payment until the payment is in a block. It does not call a public explorer. On Bitcoin, seen means mined. There is no zero-confirmation path. One or two confirmations is the window where the vendor can see the money and must not ship. Confirmed is three blocks, and not before. With neither RPC set, it answers that it is not connected to a wallet. With no token, it refuses the check.

The watcher speaks `GET /payment?address=&currency=xmr|btc&token=` and answers `{ "txid", "confirmations", "amount" }` or `{ "pending": true }`. `npm run watch` is that box. It will not listen until `WATCH_TOKEN` is set and at least one of `XMR_WALLET_RPC` or `BTC_RPC_URL` is set. Copy `.env.example` to `.env`, fill the token, and run `npm run watch`. Paste the URL it prints into Connections.

`npm run boxes` is the one-command install for both boxes. From a fresh clone it installs the dependencies, writes `.env` from `.env.example` with a generated `WATCH_TOKEN` (kept, so the pasted URL survives a restart), starts the push box and the watcher together, and prints both addresses to paste into Connections. It needs Node 22 or newer, because the push box watches a relay and the global WebSocket arrived in Node 22. Ctrl-C stops both.

## Group keys

A group key arrives as a direct message with `t: 'gkey'`, not `type`. That message is installed into the member's key store and is never shown as a chat bubble. The install lives in `src/hooks/useGroupKeyMember.js`, called from the direct-message path, so a member who is not the owner still receives the key. A request for a missed key sends every epoch that member does not have, not only the newest one.

Who is in the group is also saved as an encrypted note to yourself (kind 30078, sealed with your own key). A reinstall reads that note back. If someone who was on it is gone, the owner rotates. If the note was never published, or the relay does not have it, the first list this install sees becomes the baseline and only a later removal rotates. The member list is not written into the chat.

A repeat of the same member list at the same key epoch does not run the rotation again. Returning to an earlier member list after the epoch has moved does.

## Updates

The installed app loads the files bundled in it. There is no update check. A check would contact a server and show an IP, which is the leak the shell was changed to avoid. Updating means a new build and a manual reinstall. That is accepted. There is no app store.

## Push

It buzzes only while the app is open, or the page is in the background with notification permission, until a push gateway is pasted in Connections. The row is empty. Nothing is contacted.

`node scripts/notify-gateway.mjs` is that box. It needs Node 22 or newer, which has a built-in WebSocket; on older Node it refuses to start. Paste its address on the Push gateway row. The phone fetches `/cipher-push.json`, subscribes with the browser's push API, and posts the subscription to `/subscribe`. The box watches the message relay for a kind-4 event that is tagged `t=msg`, `t=order`, or `t=call` and addressed to that key. A message sends `{ "kind": "message" }`. An order sends `{ "kind": "order" }`. A call sends `{ "kind": "call" }`. Typing indicators, read receipts, and key bundles are not tagged, so they do not buzz. The notice is "New message", "New order", or "Incoming call". The text is not in it. The box learns that something arrived, not what it said.

The tag is a known leak, and it is accepted for now. It sits on the public kind-4 event in plain text, so the message relay, and anyone who reads it, learns whether each message between two keys is a message, an order, or a call. The content stays encrypted. The gateway needs the tag because it cannot decrypt. The Connections screen says this on the Message relay and Push gateway rows. Revisit when a per-group relay lands.

Web Push covers a browser tab and an installed PWA only. It does not exist inside the Capacitor webview. Decision: APNs is in, and FCM is in. Both send only for `t=msg`, `t=order`, and `t=call`. Android sends only when `FCM_SERVICE_ACCOUNT` points at a Firebase service-account JSON. iOS sends only when `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, and `APNS_TOPIC` are set. Neither key is in this repo. No service account was created here, Google was not asked, and no locked phone was buzzed. The installed app does not notify.

Group messages are not watched. Orders travel as direct messages, so an order buzzes as a new message. The box was not left running here.

## Proof of trade

The versioned spec is [docs/proof-of-trade.md](docs/proof-of-trade.md). Version 1 is the body, both signatures, and the public view. The notes below are the short version.

A confirmed payment can carry a receipt. The body is the order id, the buyer and vendor public keys, the currency, the address, the amount, the txid, the unix time `at`, and the outcome (`confirmed`, `disputed`, `rugged`, or `refunded`). Both public keys sit in the body. Both parties sign that same canonical JSON with their Nostr keys (BIP-340). The hash is sha256 of those bytes. Verification requires both signatures. One valid signature and one invalid signature is not a receipt. The buyer and the vendor must be different keys. A self-trade does not verify, so a vendor cannot pad their own volume. `at` and `outcome` are part of version 1, so a later field cannot be slipped in under an old signature.

The order update publishes a selective view: the hash, the amount, the currency, and the two public keys. That is enough to rank volume, and it does not include the address or the txid. Those stay on the vendor's phone, under `receipt_<order id>`, until a dispute. A dispute is the reveal: the report then includes the body and both signatures. Anyone with the body can check that the hash matches and that both signatures belong to the buyer and the vendor named in the body. A wrong txid, a swapped hash, or one bad signature does not verify.

The vendor signs when the watcher confirms and sends that receipt in the private order update. The buyer's app co-signs it when the payment arrives, and sends the second signature back. A normal order then verifies. Signing during a dispute remains the fallback if that reply never happened. The vendor still does not call a block explorer. The txid is the one the watcher reported. The receipt is not a second confirmation. It is a record of the confirmation that already happened.

## Trust

Reputation reads `at` and `outcome` from version 1 receipts. A confirmed trade adds its amount. A rug subtracts it. A dispute or a refund adds nothing. The weight halves every 30 days. The rug registry is the set of vendors whose receipt outcome is `rugged`. Arbitration is a separate statement, `upheld` or `denied`, over the receipt hash. It names no address and moves no money. Credit between two keys is the decayed sum of confirmed trades between that buyer and that vendor, and nobody else.

## Left for later

Image proxying and a copy-paste onion-plus-TURN deploy recipe are not required now that Tor-only is gone. The push box and the payment watcher are scripts, and neither is running. A locked phone still does not buzz, and a payment still cannot be confirmed, until those addresses are pasted in Connections. Recovery and discovery are not built. Reputation, the rug list, arbitration, and credit are functions over receipts. They are not a market and they do not move money.

Media hosts are the three Blossom rows. Replace one, or type `off` to stop using it. Cipher does not fetch files on your behalf: a browser upload still comes from the device. Point the row at a Blossom server you run if that server should be the only one that sees the file.

One command serves the built app. Vercel is optional.

```
npm run self-host
```

That listens on port 8080 unless `PORT` is set. A hidden service should point at that process, over plain HTTP. Tor Browser treats an onion as a secure context, so a `ws` socket on the same origin is allowed. This was not opened here: there is no Tor daemon and no hidden-service hostname. Do not invent one.

```
HiddenServiceDir /var/lib/tor/cipher
HiddenServicePort 80 127.0.0.1:8080
```

The hostname Tor writes in that directory is the mirror. Paste it in Connections. From an HTTPS clearnet page, a plain onion socket is blocked as mixed content. Connections says so. A TLS certificate for an onion is possible through Let's Encrypt DNS-01. None was issued.

`connect-src` allows `https:`, `http:`, `wss:`, `ws:`, `stun:`, `stuns:`, `turn:`, and `turns:` so a pasted relay or onion is not blocked by the page policy. `upgrade-insecure-requests` was removed because it rewrites `http://*.onion` to HTTPS, and most onion services do not speak TLS. The trade: a clearnet page will no longer auto-upgrade an `http` subresource. `img-src` is `https:` plus `http://*.onion`, so a clearnet `http` image does not load and an onion picture can. The app host itself stays on HTTPS with HSTS.

What was checked without Tor Browser, and what was not:

- The join window is on the live key-request path. A member missing from the cached list is re-read from kind 39002. A failed re-read is remembered for 45 seconds and does not grant a list older than the key. A second request inside that window does not query again. This was run as a unit test, not against a live relay.
- A message that is still securing after three minutes shows "Still securing — retry" in white on the blue bubble, with a thumb-sized target. The word is not blue-on-blue. Checked in a phone-sized browser (390×844), not by a finger on a physical handset.
- A live onion socket was not opened. None is configured, and this environment has no Tor daemon.
- Monero derivation is pure JavaScript. It was checked against a known address vector, not inside Tor Browser. Safest mode can no longer block it by disabling WASM.
- Camera and QR need a user gesture and a secure context. An HTTP onion is a secure context in Tor Browser; that was not rechecked here. Tor Browser often blocks the camera until the shield allows it. Decoding falls back to a local library when the browser has no barcode detector.
- Clipboard write falls back to a hidden field when the async API is denied, including the scan screen.
- The service worker is same-origin (`/sw.js`). Registration failure is logged and the app still opens. Tor Browser may refuse service workers. It registers only in production. That was not rechecked on an onion.
- Voice calls use public STUN unless you paste a call relay. STUN shows your real IP. Calls use UDP, so Tor Browser alone does not cover them. Orbot’s VPN mode does. No TURN server was deployed. The call screen says this.

Android: install Orbot and turn on VPN mode before opening Cipher. The installed shell no longer loads the Vercel host, so Orbot covers the webview without a remote page at launch. iOS is weaker. Orbot cannot force every other app through Tor. Use Onion Browser or the HTTP onion mirror. Do not put the Vercel host back into `server.url`.

No VPN SDK and no Tor-in-webview library were added.

- Group membership for key hand-off is the relay's kind 39002, not a member-signed list. That makes the group relay a confidentiality trust anchor: a relay admin who can add a pubkey to the member snapshot will be handed the group key by any member who answers a key request. That is inherent to NIP-29. The relay pubkey is read from the relay's NIP-11 document (`https://groups.aegispayhq.com`); the key baked into the client is only the fallback if that document is unreachable. A failed NIP-11 lookup is remembered for 45 seconds so an outage does not turn into a query per request. It is not a permanent fallback.
- A fresh member snapshot that omits the requester is not a final refusal. The responder re-reads 39002 once, because a join often lands after the cached list was written. Repeated key requests from the same peer reuse that re-read, or a failed re-read, for 45 seconds instead of querying the relay every time. A failed re-read is stored as a miss, not as the old member list, so it cannot grant a key from a pre-rotation snapshot. The joiner republishes the key request on a backoff that starts at 2s and doubles until a 5 minute cap, with ±30% jitter so members do not retry in lockstep. The request keeps going while the group is still securing, and it resumes after the app reopens. A send that cannot encrypt yet stays on screen as "Securing…" and goes out once the key arrives. If the re-read fails, a stale list that still names them is trusted only when it is at least as new as the key being handed out. A snapshot older than that key predates a rotation — a kick or a leave — and is a refusal. Falling back to it would undo the kick for as long as the relay is unreachable, and the grant is kept. A relay blip can still delay a legitimate member of a rotated epoch until 39002 can be read again; it cannot quietly restore someone the rotation removed.
- A kick is eventual, not instant. It takes full effect only once the new epoch has propagated to every member who is still in the group. Until that happens, and through a relay blip where the group falls back to the old epoch, the removed member may still decrypt. History from epochs they already held still decrypts for everyone who has those keys.
- Five wrong PINs delete that account's on-device vault, including the encrypted recovery phrase stored on the device. Other accounts are not counted or deleted. The counter is stored per account and resets after a successful PIN unlock, biometric unlock, restore-by-handle, or restore-by-mnemonic. The lock screen says this before it happens, and the PIN error repeats it when two or fewer attempts remain. Only the 12 words that were written down can restore a wiped account. The minimum PIN is 6 digits.
- `android/` is gitignored, so the native Android project is not in version control. `capacitor.config.json` is what records the packaged web host.
- `.idea/`, `.vercel/`, and `.env.local` are not in the repo. `.env.local` had carried a `VERCEL_OIDC_TOKEN`. That token does not belong in git.
