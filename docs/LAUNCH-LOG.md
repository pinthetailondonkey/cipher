# Launch log

Findings as they happen, pinned to the SHA they were read at. Newest phase last.
A finding without a file:line is not a finding.

## Phase 0 — truth, at `e1e70da`

### Gates

`npm run build` **pass**, `npm run lint` **pass — 0 errors, 94 warning lines**, `npm test` **pass — 400/400, 0 fail, 52.5s**.
Run in the founder's working tree, so the uncommitted `src/lib/egress.js` edits are inside the result.

### Test files no command runs

22 test files are absent from `npm test`. 7 are the browser suite (`npm run test:ui`), 5 are the desktop suite (`desktop/` → `node --test test/`). **10 have no runner anywhere in the repo:**

- `src/lib/escrowActions.test.js`
- `src/lib/escrowFsm.test.js`
- `src/lib/escrowMembrane.test.js`
- `src/lib/escrowPsbt.test.js`
- `src/lib/escrowScript.test.js`
- `src/lib/orderMembrane.test.js`
- `src/lib/npub.test.js`
- `src/components/ui/smoke.test.jsx`
- `scripts/preview.test.mjs`
- `scripts/with-app-env.test.mjs`

The five escrow files are the whole escrow suite — the FSM, the script, the PSBT, the membrane. No CI workflow exists (`.github/workflows` absent), so nothing else picks them up. The "gates green" law does not reach the money machine.

### Live host

Fetched `https://sonic-cobalt-4m6q5vj.vercel.app/`: 200, `<title>Cipher</title>` present.

- Live bundle `/assets/index-Cu7vDotz.js`, last-modified 2026-10-24 19:29:29 GMT.
- Build of `e1e70da` produces `/assets/index-2aTOTYUz.js`. Different bundle, so the live page is not built from HEAD.
- Newest commit at or before the live build time: `e3936ce` (2026-10-24 15:22 EDT).
- `git rev-list --count e3936ce..e1e70da` = **887 commits**, 346 files, +43,189 / −8,001. The public site predates the rebuild, group security, state survival and money-edges.

### VISION §4 — built / not built / built-but-unreachable

Read at `e1e70da`, from code only. `src/lib/egress.js` was read pinned (`git show e1e70da:`) because the working tree carries uncommitted edits to it; every other file on disk matches the SHA. The docs were used as a map and checked against code; docs/UI-INVENTORY.md is stale (it still lists `src/Shop.jsx` and `VendorStorefront.jsx`, both gone).

**BUILT — 58 items.** The feature exists and a user can reach it.

Identity and device:
- Handle + PIN account creation, handle precheck over the relay — `src/components/onboarding/Create.jsx:12`, `src/useIdentity.js:313`
- PIN unlock; five wrong PINs wipe that account's vault only — `src/LockScreen.jsx:27`, `src/lib/vaultLockout.js:113`
- Passkey unlock / biometric opt-in — `src/LockScreen.jsx:63`, `src/useIdentity.js:313`
- Restore by handle + PIN over the relay — `src/components/onboarding/Restore.jsx:7`
- Restore by 12-word recovery phrase — `src/components/onboarding/RestoreMnemonic.jsx`, mounted at `src/LockScreen.jsx:149`
- Multiple accounts, add / switch / remove — `src/Wallet.jsx:344`, `src/components/chat/AccountSwitcher.jsx`
- Backup screen (secret key and phrase) — `src/Wallet.jsx:480`, `src/components/chat/IdentityBackup.jsx`
- Panic wipe (button with confirm dialog) — `src/Wallet.jsx:528`
- Shake-to-wipe toggle — `src/components/chat/PrivacySettings.jsx:90`, `src/hooks/usePanicWipe.js`
- Message history encrypted at rest, old plaintext rows still readable — `src/db.js:210`, `src/lib/messageAtRest.js`

Messenger:
- NIP-44 DMs with outbox write-ahead, retry and flush — `src/hooks/useNIP44DM.js:10`, `:130`
- Peer inbox read + own inbox relay list published (NIP-65) — `src/lib/dmRelays.js:19`, `:31`, called at `src/hooks/useNIP44DM.js:12`
- Typing indicators (sent while composing, group + DM) — `src/features/chat/useChatBootstrap.js:418`, `src/hooks/useNIP44DM.js:157`
- Read receipts, both sides — `src/hooks/useNIP44DM.js:244`, `src/features/chat/useChatBootstrap.js:437`
- Reactions, incl. taking one back via a kind-5 delete — `src/hooks/useReactions.js` wired at `src/Chat.jsx:34`, `src/lib/reactions.js`
- Message editing (re-send; the stored history is list 3) — `src/features/chat/useMessageCommands.js:114`
- Forwarding, DM and group — `src/components/chat/DmView.jsx:94`, `src/components/chat/GroupView.jsx`
- Bookmarks with jump-to-message — door `src/components/chat/ChatList.jsx:558`, viewer `src/components/chat/BookmarksViewer.jsx`
- Mute with durations (8h / forever / timed) — `src/components/chat/ChatList.jsx:349`
- Archive / unarchive — `src/components/chat/ChatList.jsx:250`
- Disappearing messages, per-chat timer picker incl. groups — `src/components/chat/ChatHeader.jsx:21`, engine `src/lib/disappearing.js`
- Safety numbers, per account, verify row in the DM header — `src/components/chat/ChatHeader.jsx:93`, `src/lib/safetyNumber.js`
- Block list + privacy screen — `src/components/chat/PrivacySettings.jsx:55`, `:95`
- Search (people and groups) — `src/Chat.jsx:131`, `src/features/chat/usePeopleSearch.js`
- Message requests screen — `src/Wallet.jsx:352`, `src/components/chat/MessageRequests.jsx`
- In-app notifications: DM message/order buzz `src/hooks/useNIP44DM.js:335`; group mention/reply buzz `src/hooks/useNIP29Group.js:1219`; engine `src/lib/notifications.js:54`
- QR camera scanner; a scanned key opens that profile — `src/components/chat/QRScanner.jsx:122`
- Command palette, ⌘K at md+ — `src/AuthenticatedApp.jsx:48`
- Link previews, opt-in toggle — `src/components/chat/PrivacySettings.jsx:92`, `src/components/chat/LinkPreview.jsx`
- Photos: compressed and re-encoded on send (canvas redraw strips EXIF/GPS), then Blossom — `src/features/chat/useComposer.js:174`, `src/lib/imageCompression.js:24`
- Voice notes — `src/features/chat/useComposer.js:195`, `src/components/chat/VoiceNote.jsx`
- Chat media encrypted before the media host — `src/lib/mediaCrypto.js`, used at `src/features/chat/useComposer.js` and `src/components/ui/PrivateMedia.jsx`
- Burn-once dead-drop notes: compose `src/components/chat/DeadDropModal.jsx:36` (door `src/components/chat/FloatingMenu.jsx:57`), open from a `#/note` link on boot `src/features/chat/useChatBootstrap.js:548`
- Boot link shapes all resolve: group join (`/<id>`, `?g=`), product card (`?product=&vendor=`), chat (`?chat=`), note (`/note#`) — `src/features/chat/useChatBootstrap.js:528`, `:632`

Groups:
- Group create, join (directory, link), chat — `src/features/chat/useGroupDirectory.js`, `src/Discover.jsx:131`
- Rotating AES-GCM group keys; kick or leave rotates the epoch — `src/hooks/useNIP29Group.js:614`, `:728`, `src/lib/crypto/groupKeyRotation.js`
- Join-approval gate (9021) with owner Approve / Deny — `src/hooks/useNIP29Group.js:911`, `src/components/chat/GroupInfoSidebar.jsx:309`, `:392`
- Key distribution: a member who asks for a key gets every epoch they lack — `src/hooks/useGroupKeyMember.js`, `src/lib/crypto/groupKeyRequest.js`
- Pin a group message (also how a vendor features a product) — `src/components/chat/GroupInfoSidebar.jsx:208`, `src/hooks/useNIP29Group.js:31`

Shop:
- Menus browse: network kind-30402 listings grouped per vendor, search, copy link — `src/Menus.jsx:93`, `:116`
- Vendor menu home: items, standing banner, reviews, "Message vendor" — `src/features/chat/ChatOverlays.jsx:76`, `src/components/chat/VendorMenuHome.jsx`
- Vendor profile page with receipt-bound reviews — `src/components/chat/VendorProfilePage.jsx`, rows `src/components/chat/ReviewRow.jsx`
- Discover directory of menus + groups — `src/Discover.jsx:68`, join `:142`
- One-tap checkout / Buy — `src/Menus.jsx:273`, `src/components/OneTapCheckout.jsx`
- Delivery address: buyer seals it into a burn-once note at checkout `src/components/OneTapCheckout.jsx:23`, vendor opens + validates + saves + burns `src/features/chat/useCommerce.js:78`
- Order lifecycle: created → address issued → seen → confirmed → shipped → delivered — accept `src/features/chat/useCommerce.js:124`, vendor "seen" `:301`, chain check `:333`, shipped `:549`, delivery `:555`
- Per-order payment addresses: BTC from xpub (BIP-84 external chain) `src/lib/vendorPayments.js:122`; XMR subaddresses on device `src/lib/vendorPayments.js:136`, `src/lib/moneroAddress.js`
- Chain check from both sides, watcher-evidence only, one-txid-one-order ledger — `src/features/chat/useCommerce.js:333-548`
- Receipts: signed at watcher confirm, buyer co-signs, public view published, refund = new receipt — `src/features/chat/useCommerce.js:488-519`, `src/lib/proofOfTrade.js`
- Receipt inspection door, both the bubble and My Orders — `src/components/MessageBubble.jsx:152`, `src/components/chat/MyOrders.jsx:78`
- Orders ledger (My Orders, hybrid timeline, ✓ = countersigned) — `src/Wallet.jsx:348`, `src/components/chat/MyOrders.jsx`
- Disputes: report issue, receipt reveal on dispute (kind 10006 on the data layer) — `src/features/chat/useCommerce.js:608`, `src/lib/disputes.js`
- Refund and reopen — `src/features/chat/useCommerce.js:576`
- Vouches: auto-vouch on delivery + manual vouch on a profile — `src/features/chat/useCommerce.js:558`, `src/components/ProfileModal.jsx:49`
- Vendor reviews, receipt-bound, compose after delivery — prompt `src/components/MessageBubble.jsx:491`, `src/components/chat/ReviewCompose.jsx`, `src/lib/vendorReviews.js`
- Vendor dashboard reading this account's real products + stats + publish bulletin (kind 10007) — `src/Wallet.jsx:363`, `src/components/chat/VendorDashboard.jsx:14`, `:61`
- Vendor mode on/off, payment settings (xpub / view key, encrypted at rest) — `src/Wallet.jsx:287`, `:384`, `src/lib/vendorPayments.js`
- Product publish (kind 30402), honest "Published." only on a relay's word — `src/Wallet.jsx:229`
- Buyer order settings: preferred coin, confirmation counts (BTC 3 / XMR 10), auto-vouch — `src/Wallet.jsx:299`
- Reputation volume rank on the vendor dashboard — `src/lib/proofOfTrade.js` (`rankVolumeByStanding`), caller `src/components/chat/VendorDashboard.jsx`

Infra:
- Connections: Tor switch + proxy field (relay rows are gone by design) — `src/components/chat/Connections.jsx:36`
- Service worker app shell, production only — `public/sw.js:1`, `src/main.jsx:6`
- PWA manifest — `public/manifest.json`
- Egress host list with the no-clearnet-founder gate — `src/lib/egress.js:1` (pinned read)
- Self-host server — `scripts/self-host.mjs` (`npm run self-host`)
- One-command boxes installer (watcher + push box) — `scripts/boxes.mjs`
- Payment watcher box: BTC `scantxoutset` / XMR wallet RPC, token-gated, no explorer — `scripts/payment-watcher.mjs` (`npm run watch`)
- Push gateway box incl. FCM + APNs paths — `scripts/notify-gateway.mjs:16`, `src/lib/nativePushSend.js`
- Desktop Electron shell, bundled Tor by design — `desktop/package.json:6` (main `src/main.js`), `desktop/electron-builder.yml`

**NOT BUILT — 9 items.**

- Voice calls — off by founder decision in every build; `startCall` returns a canned refusal. The phone icon remains on the header as the refusal door: `src/lib/voiceCall.js:15`, `:37`, button at `src/components/chat/ChatHeader.jsx:98`, `:154`
- Escrow (2-of-2 BTC + refund timelock) — engine, PSBT, FSM and membrane are written and tested, but the accept door is flag-gated off and no order request ever carries the escrow slot key: `src/components/MessageBubble.jsx:27` (`ESCROW_WIRING_LANDED = false`), `:482`; no producer of `escrowPubKey` anywhere in `src` (grep, zero hits). The card shows dormant escrow rows only: `src/components/chat/EscrowDormantRow.jsx`, rendered at `src/components/MessageBubble.jsx:493`
- A door to paste the payment watcher, push gateway, or an onion relay — `setRelayOverride` has zero callers in the app (`src/lib/egress.js:129`, pinned read); Connections carries no rows and says so: `src/components/chat/Connections.jsx:88`. Consequence below, list 3
- Search inside a chat (message content) — SearchView matches people and groups only: `src/components/chat/SearchView.jsx` (no content query; `src/features/chat/usePeopleSearch.js` is the only search engine wired at `src/Chat.jsx:67`)
- Message edit history — the edit write is reachable (`src/features/chat/useMessageCommands.js:114`) but no screen ever reads `msg_edits`; only the store itself touches the key: `src/store/chatStore.js:255-261`
- QR scanner acts on group ids / naddr / Cipher links — only a scanned key opens a profile; everything else copy-only: `src/components/chat/QRScanner.jsx:120`
- Chat drafts, sticker packs, custom emoji reactions, per-chat themes/wallpapers, emoji status, chat folders — no code anywhere in `src` (grep: "draft" exists only as the pre-account vault flag in `src/useIdentity.js:332`; no "sticker", no per-chat theme store)
- Arbitration statements and the rug registry — engines exist over receipts in `src/lib/reputation.js` / `src/lib/proofOfTrade.js`, but no screen writes or reads an `upheld`/`denied`/`rugged` decision (grep in `src/components`: zero hits)
- Locked-phone push in practice — the box side is built (`scripts/notify-gateway.mjs`), but no FCM service account or APNs key exists anywhere (README.md:23, :98), so the installed app does not notify until the founder sets them

**BUILT BUT UNREACHABLE — 6 items.** Each is a door the launch rides on.

- Payment confirmation. `checkPayment` is called from the order card but reads the `explorer` row, which is empty in every install and cannot be set from any screen: `src/features/chat/useCommerce.js:413`, row `src/lib/egress.js:29` (pinned), writer `setRelayOverride` with zero callers `src/lib/egress.js:129`. A payment can never become confirmed in the shipped app
- Web-push registration. `registerWithGateway` runs only if the `push` row is set; it never is, same missing door: `src/features/chat/useChatBootstrap.js:134`, row `src/lib/egress.js:30`
- Relay override writer itself. `setRelayOverride` / `setRelayList` are exported, tested, and called by nothing: `src/lib/egress.js:123`, `:129` (pinned read)
- Escrow accept action. `escrowActionsFor` is computed on every pending order card and rendered behind a `false` constant: `src/components/MessageBubble.jsx:482`, engine `src/lib/escrowActions.js:184`
- STM order membrane. Only its unit helpers (`satsFromString`/`satsToCoins`) are imported; the FSM reroute never runs: `src/lib/escrowActions.js:27`, the pending-phase comment at `:181`
- Message edit history. Written on every edit (`src/features/chat/useMessageCommands.js:114` → `src/store/chatStore.js:256`), read by no one

Ambiguity, one item, not guessed: "Recovery and discovery are not built" (README.md:118) vs. restore-by-handle landing later — I read restore-by-handle as built (`src/components/onboarding/Restore.jsx:7`), so I read the README line as stale. If the founder means something else by "recovery" (e.g. delegated recovery), that is a call to make, not a code fact.

Counts: BUILT 58, NOT BUILT 9, BUILT BUT UNREACHABLE 6.


## Phase 9 — the Signal/Telegram shell (founder-authored spec, now in the repo)

The interface the product ships behind. The spec was written by the founder on 2026-10-28 and lived only in `/home/aegis/aegis-backups/ui-spec/CIPHER-UI-SPEC.md`; it is copied here as [docs/UI-SPEC.md](UI-SPEC.md) so the phase and its rules are in version control with the code they govern.

- **Spec:** [docs/UI-SPEC.md](UI-SPEC.md) — four destinations in fixed order (Chats | Menus | Orders | Profile), eight reference screens, tokens (bg #050505, Cipher blue #2463F5, bright blue #3987FF), one reusable transaction card, shared-component list, micro-interactions, quality bar (touch targets >=44px; test at 320/360/375/390/412).
- **Layout references:** `/home/aegis/aegis-backups/ui-mockups-2026-10-28/` (eight screens, HTML + PNG). Layout only — where a mock-up and the spec differ, the spec wins.
- **Logo:** the existing asset is authoritative; never redraw it.
- **State:** `feat/ui-redesign` in `/home/aegis/wt-ui` holds stages 1-3 (audit, tokens, shared components, transaction card). Screens are NOT rebuilt. The branch is parked, not merged.
- **Order of work:** shared components first (they are the reuse contract), then the four destinations in spec order, then the eight reference screens, then the quality pass at real phone widths.
- **Hard gates for this phase, from the brief:** 0 hex colours in JSX outside `index.css`, 0 `z-[...]` literals, 0 duplicate toast systems, 0 unwired buttons, and the guard test bans the banned words.
- **Never in this phase:** invented data, invented order states, a cart, a public marketplace, calls, escrow the code does not have, a replaced nav, or a redrawn logo.


## Phase 8 — docs, and the doors found along the way

Landed and pushed, one change per commit, every gate green at each one:

- `2550bdf` — `roundToScale` in `src/lib/paymentState.js`; acceptance rounds half up to the coin's own scale instead of refusing, and refuses only what rounds away to nothing. This is the M2 gap from Phase 1 and the only real money defect found by execution.
- `fdc6f0a` — Connections carries the Payment watcher and Push gateway rows again, writing through the pinned `setRelayOverride` from `src/lib/egress.js` with no change to it. Closes "a payment can never become confirmed": the missing piece was a screen, not a mechanism.
- `d5560ff` — a scanned group, menu item, chat or burn note opens, through the same boot path a tapped link uses (`src/lib/scannedTarget.js`, 7 tests). Closes the scanner item.
- `b825493` — Phase 9 above, spec into the repo.
- `8f3b2ce` — Share link on a payment block called `sharePayment`, which was defined nowhere: a tap threw a ReferenceError. Fixed.
- `08d6d85` — edit history is a row in the message menu, so the record the app already wrote can be read. Closes that item.
- `d277e77` — README: a real front page, run commands, and the deploy-verification law. The hosting section no longer claims three Vercel projects and no canonical domain; the canonical address is `https://ciphermessenger.org`. `t=order` was already in the push docs.
- `b0e7f39` — `AGENTS.md` was a different product's sandbox contract (App Builder workspace: scaffold TanStack Start, keep a third-party branding pill, deploy to Vercel). Replaced with a Cipher brief pointing at CLAUDE.md. The old text is recoverable at blob `bec0e5b`.

Still open, and each one needs a decision rather than code:

- **Safety numbers never change.** `markSafetyChange` has no caller. There is no handle-to-key map in the app to hang a trigger on, so wiring one would mean inventing the trigger. Question: should a changed safety number be raised on opening a chat with a known key, and is a toast enough?
- **Escrow stays off.** `ESCROW_WIRING_LANDED = false` in `src/components/MessageBubble.jsx`. Nothing was wired.
- **Live host is 887 commits behind** the current `main` as of 2026-10-28; the check and its evidence are in README.md. Resolved in Phase 10: the cause was a redirect to a second Vercel project that had stopped deploying, and the live page is now this build.
- **`cipher-70` never filed a report** for the work it took.


## Phase 4 — privacy defaults, `feat/privacy-overnight`

Rebased onto `e409f97` after the boss tab's MessageBubble work; one line of history, 415/415 green on the merged tree. One change per commit:

- `80e482d` — **P1, link previews off by default, enforced at the fetch itself.** New `src/lib/linkPreview.js` (`fetchLinkPreview` returns null unless `allowsLinkPreviews()`); `src/components/chat/LinkPreview.jsx` renders nothing with defaults; a test on a fresh profile throws the moment any preview request leaves the device (`src/lib/linkPreview.test.js`).
- **M1, media encrypted before upload — already built, no change.** Per-file random AES-GCM in `src/lib/mediaCrypto.js`, wired at `src/features/chat/useComposer.js:7`; `src/lib/mediaCrypto.test.js:11,34` already prove the stored blob does not decode as an image.
- **D2, Block from the profile sheet — already built, no change.** Button `src/components/ProfileModal.jsx:104`, persisted list `src/store/chatStore.js:232`, Blocked screen `src/components/chat/PrivacySettings.jsx:93`.
- `416584b` — **C1, stale call signals dropped.** An offer whose `created_at` is over 60 seconds old, or unreadable, gets silence instead of a reject (`src/lib/voiceCall.js:58`); proven in `src/lib/voiceCall.test.js:46`. Receive side only; the call button and `startCall` untouched.
- **P2, DVM search — closed, no code.** The block `docs/AUDIT-2.md:228` flagged (signed kind-5315 to the group relays) was already deleted in `0d00d42`, and `src/lib/egress.test.js:134` asserts the search path never publishes. NIP-50 already targets the Connections search rows (`src/features/chat/usePeopleSearch.js:92`, set at `src/lib/egress.js:41`). Accepted as closed by the founder, 2026-10-28.

## Phase 10 — the front door, at `6ca5f27` (2026-10-28)

### The cause of the staleness

Not failing builds, not a disconnected integration, not a wrong branch. There were **two Vercel projects built from this same repo**:

- `cipher` — the one `.vercel/repo.json` links to. It built `main` on every push, green. Latest production before this work: `594cac4`, 2026-10-28 05:00Z.
- `sonic-cobalt-4m6q5vj` — a second project on the same repo. **Its last deployment was 2026-10-24 19:25Z at `f392dca`.** It stopped deploying and kept answering.
- `cipher-shop` — a third copy, deployed 2 days earlier.

`vercel.json` sent `cipher`'s production name, `cipher-beta-eight.vercel.app`, to `sonic`. So every push built correctly into `cipher`, and every visitor was then handed to the project that had frozen on 24 October. `main` was 909 commits past the served build.

Proof the pipeline itself was sound, without a deploy: the live deployment of `594cac4` served `assets/index-C-deVjni.js`, and a clean local build of that same commit produced `index-C-deVjni.js`. Identical.

### The bind

`ciphermessenger.org` was registered 2026-10-27 at Tucows, zone on Cloudflare (`cesar`/`vera.ns.cloudflare.com`), and bound to the `cipher` project on 2026-10-28.

**The canonical address is `https://www.ciphermessenger.org`.** The bare name answers `308` and forwards to it. This is the inverse of the usual arrangement and it is deliberate for now: Vercel issued the redirect that way when both names were added, and the founder ruled on 2026-10-28 that `www` stays primary and the order follows it. **Do not "fix" it back.** If the direction is ever reversed, it is a dashboard change on the domain entry, and the README, `src/lib/egress.js` and `scripts/verify-live.mjs`'s default all follow it.

### Three checks, verbatim

Deployed `dpl_FyRxwahNWfouREB7TuQooxniHJbr` — **https://cipher-leck6tmem-cipher.vercel.app**, aliased to `https://www.ciphermessenger.org`. This is the rollback: `vercel alias set cipher-leck6tmem-cipher.vercel.app www.ciphermessenger.org`.

```
verify:live — https://www.ciphermessenger.org
  final       https://www.ciphermessenger.org/
  status      200
  title       Cipher
  built here  index-B_8vez9N.js
  served      index-B_8vez9N.js
verify:live — the live page is this build.            exit 0

verify:live — https://ciphermessenger.org
  redirect    308 https://ciphermessenger.org/ -> https://www.ciphermessenger.org/
  final       https://www.ciphermessenger.org/
  status      200
  title       Cipher
  built here  index-B_8vez9N.js
  served      index-B_8vez9N.js
verify:live — the live page is this build.            exit 0

verify:live — https://cipher-beta-eight.vercel.app
  redirect    308 https://cipher-beta-eight.vercel.app/ -> https://ciphermessenger.org/
  redirect    308 https://ciphermessenger.org/ -> https://www.ciphermessenger.org/
  final       https://www.ciphermessenger.org/
  status      200
  title       Cipher
  built here  index-B_8vez9N.js
  served      index-B_8vez9N.js
verify:live — the live page is this build.            exit 0
```

### Deletions

`sonic-cobalt-4m6q5vj` and `cipher-shop` were deleted after the three passes. `sonic-cobalt-4m6q5vj.vercel.app` now answers `404`. `cipher` is the only project left, and its production URL is `https://www.ciphermessenger.org`.

### A deploy run by hand uploaded the machine, not the repo

The first `npx vercel deploy --prod` read 3.3 GB from disk and had not finished after ten minutes: the Git integration ships the tracked tree, but a CLI deploy uploads the working directory, and this one carried `desktop/dist` (3.0 GB of installers) and eighteen agent worktrees (2.7 GB). `.vercelignore` now excludes both, so a by-hand deploy takes under two minutes and sends the same set the pipeline does.

### Known gaps

- **No install files.** `/download` was claimed to be a page pointing at them. It is not: `public/` holds icons, `manifest.json` and `sw.js` only, and the catch-all rewrite answers `/download` — and every other path — with the app. The README now says it is not built.
- **No staging environment.** Every deploy is production. There is nowhere to see a change running before people do.
- **Deploys are by hand, and nothing stops a merge from landing undeployed.** The Git integration does deploy `main`, but nothing asserts it: the four-day freeze was found by hand, not by a check. `npm run verify:live` closes part of this — it catches a live page that is not this build — but it has to be run.

### The deploy quota stopped the next one (found at `c1ae37e`)

Two commits after the passing deploy — `fc0458e` (the app host row names www) and the docs above — the Git integration did not create a deployment, and a by-hand `npx vercel deploy --prod` was refused:

```
"message": "Resource is limited - try again in 24 hours (more than 100, code: \"api-deployments-free-per-day\")."
```

The Hobby plan allows 100 deployments a day, and this repo spends them on previews: every branch push deploys one, and there are more than twenty branch worktrees on this machine. So the live page still serves `index-B_8vez9N.js` (the `6ca5f27` build) while `main` is `c1ae37e` and builds `index-DX5sbwlP.js`. `npm run verify:live` exits 1 and says exactly that, which is the check doing its job.

Nothing is wrong with the site; it is two small commits behind. What needs a decision is the budget: turn off preview deployments for branches that are not `main`, or move the project to a plan whose limit is not 100 a day. Until one of those happens, a merge cannot be followed by a deploy on the same day.
