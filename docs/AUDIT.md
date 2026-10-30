# Cipher audit: payment confirmation and push

Auditor pass. No code changes. Not committed.

## 0. Phase 0 record

- First look at this session: HEAD `f392dca`. By Phase 0, HEAD was `07fe1da` ("wip: before pull", local, not on origin), on top of `086eccf` (origin/main). `07fe1da` held CLAUDE.md, `.vite/deps/*` (2 files), and `cipher` recorded as a gitlink (`160000 1cbb024...`).
- `git rm --cached cipher`, `git rm -r --cached .vite`, `.gitignore` += `.vite/`. **Beyond the brief:** I also added `/cipher/` and `/cipher-old/`, because the commit message says "ignore ... nested clones" and without those lines it would be false.
- I checked both nested clones before `rm -rf`. `cipher/` was clean at origin/main `086eccf`, and `cipher-old/` was clean at `1cbb024`, 20 behind. Neither had unpushed commits or stashes. The only file not on origin was `cipher-old/.env.local`, holding one key, `VERCEL_OIDC_TOKEN`, a short-lived token that `vercel env pull` regenerates. Deleted.
- Amended commit: **`c67f0c180ef4a1eaa71470b424bcc906760a5fb4`** "chore: add CLAUDE.md, ignore .vite and nested clones" (files: `.gitignore` +3, `CLAUDE.md` +24). `git status --short` is empty. `npm install`: up to date, 312 packages, 3 moderate advisories.
- **Not pushed.** It sits on `main` directly. The repo history merges through PRs.

## 1. What I read, pinned to `c67f0c1`

All reads were `git show c67f0c1:<path>`.

Read in full: `src/features/chat/useCommerce.js` (449 lines), `src/lib/paymentState.js` (82), `src/lib/paymentWatch.js` (131), `src/lib/vendorPayments.js` (173), `src/lib/proofOfTrade.js` (292), `scripts/payment-watcher.mjs` (148), `scripts/notify-gateway.mjs` (179), `src/lib/egress.js` (243), `src/hooks/useNIP44DM.js` (321), `src/hooks/useNIP29Group.js` (1130), `src/components/chat/VendorDashboard.jsx` (66), `.env.example` (29).

Also read in full to check the live path: `src/lib/pushGateway.js`, `src/lib/nativePushSend.js`, `src/hooks/useVendorStats.js`, `src/lib/notifications.js`, `src/lib/paymentUri.js`, `src/lib/dmRelays.js`, `src/lib/paymentState.test.js`, `src/lib/paymentWatch.test.js`, `src/lib/proofOfTrade.test.js`, `src/lib/pushGateway.test.js`.

Read in part: `src/components/MessageBubble.jsx` 1-262, `src/features/chat/useChatBootstrap.js` 120-160 and 266-372, `src/db.js` 95-135, `public/sw.js` 50-82, `src/lib/voiceCall.js` 25-45 plus the signal call sites, `src/lib/nip65.js` 40-59, `docs/proof-of-trade.md` (first 80 lines), `README.md` (grep hits).

Not read: `vendorPayments.test.js`, `nativePushSend.test.js`, and the rest of the repo.

## 2. Phase 1 evidence

| Command | Exit | Result |
|---|---|---|
| `npm run build` | 0 | Built in 12.70s, 2519 modules. 1 warning: `INEFFECTIVE_DYNAMIC_IMPORT` (chatStore.js) |
| `npm run lint` | 0 | 0 errors, **93 warnings**. 31 are unused catch params, many of them on send paths |
| `npm test` | 0 | **73 tests, 73 pass, 0 fail, 0 skipped, 0 cancelled**, 12.1s |

`npm test` runs 23 files. **14 test files in the repo are not run:** 9 `scripts/*.test.mjs` and 5 `src/lib/**/*.test.ts`. Their status is unknown.

A green run does not prove a feature works. The XMR amount tests below pass, and the XMR guard is still broken.

Raw output is appended at the end of this file.

## 3. Verdict table

| # | Claim | Verdict |
|---|---|---|
| 1 | The amount guard is wired, fed and tested on both the BTC and XMR paths | **False for XMR.** It is wired and fed on both (`useCommerce.js:168-179` to `paymentWatch.js:116-124`). It is tested on BTC only. On XMR the watcher passes piconero as XMR: a 1-piconero payment confirmed a 0.5 XMR order in a probe |
| 2 | A payment split across two outputs does not read as short | **False.** The report names the largest single unspent (`paymentWatch.js:61-71`). A 0.006 + 0.004 split for a 0.01 BTC order returned `short: true` in a probe. A test codifies largest-only (`paymentWatch.test.js:110-114`) |
| 3 | t=order reaches the gateway as an order | **Proven in code, not run on a relay.** `withBuzzTag` (`pushGateway.js:14,23-30`) to the gateway filter `'#t': ['msg','order','call']` (`notify-gateway.mjs:164`) to `eventShouldOrder` to `{kind:'order'}` to `sw.js:62,65` "New order". The gateway script has no test. README:23,65 still says msg and call only |
| 4 | A short payment is info, and a watcher with no amount is not a red error | **Over-claimed.** Short is `type: 'info'` (`useCommerce.js:182-185`). No amount throws (`paymentState.js:66-67`), is not caught in `checkPayment` (`paymentWatch.js:126-129`), and lands in `setToast({ type: 'error' })` (`useCommerce.js:245-247`) |
| 5 | The buyer can read the coin amount and address off the order card | **False.** The address is shown (`MessageBubble.jsx:228-235`). `coinAmount` is never rendered: its only references are in `useCommerce.js`. The QR amount comes from `product.price` and `product.currency` (`MessageBubble.jsx:232`), so a USD-priced order shows "$40" and a bare address |
| 6 | VendorDashboard refreshes on a new countersign, and has no duplicate volume row | **Over-claimed.** Refresh is false: storage is read once on mount (`VendorDashboard.jsx:25-28`), with no subscription. Storage dedupe by hash is true (`proofOfTrade.js:273`). But views are not filtered to `vendor === me`, so purchases show as your volume in unlabeled rows. Separately, the vendor's chat gets a duplicate "Order / Marked paid" card on every buyer reload (H2) |
| 7 | The three-account group gate has actually been run | **Unverified.** No script, log or doc in the repo records it. Proof: a committed transcript of three identities doing create, join, post, kick, rotate and a decrypt check, with output |
| 8 | Push: does anything buzz a locked phone, on FCM or APNs? | **Unverified on both, with no evidence.** `/native` always answers `buzzing: false` (`notify-gateway.mjs:142`). `.env.example:25` says "No device has been buzzed". `android/` is gitignored, so there is no `google-services.json` and no iOS project in the repo. Web Push to a PWA is wired end to end in code (`pushGateway.js:154-168`, `notify-gateway.mjs:75-85`, `sw.js:58-70`) and has never been shown to buzz |

## 4. Findings, worst first

### C1. Critical: the XMR amount guard is defeated by a unit mismatch
`scripts/payment-watcher.mjs:57-65` passes monero-wallet-rpc `get_transfers` rows straight to `reportFromTransfers`. `amount` there is in atomic units (piconero, an integer). `paymentState.js:39-46` (`decimalUnits`) reads it as decimal XMR.

Probe at HEAD:
- `{amount: 1}` (1 piconero, 10 confirmations) against an order of `0.5` XMR gives `{"moved":true,"state":"confirmed"}`.
- A correct 0.5 XMR payment would be signed into the receipt as `500000000000 XMR` (`useCommerce.js:197-199`).

Any payment of N piconero covers any order up to N XMR. The XMR tests never send an amount (`paymentWatch.test.js:28-52`) and the transfer fixtures have no `amount` field (`:101-106`). Bug classes: a test that passes old arguments, hiding a new gap; field mismatch between producer and consumer.

**Fix:** convert in the watcher. Turn the atomic integer into a 12-place decimal string with BigInt, and send amounts as strings end to end. Add an XMR test with a real `get_transfers` row (`amount: 500000000000`) that must cover 0.5 and must not cover 0.6.

### C2. Critical: the vendor's order state lives only in memory
`useCommerce.js:21-27` (`updateLocalOrder`) patches zustand only. `fetchChats` rebuilds `dms` from Dexie (`useChatBootstrap.js:318-345`). `fetchDMs` re-saves the buyer's original `order_request` data (`useNIP44DM.js:300-307`), which overwrites even a persisted patch.

After an app start or the refresh button, the vendor's order loses `status`, `paymentState`, `paymentMethods`, `coinAmount` and `coinCurrency`. "Check the chain" disappears (`MessageBubble.jsx:208`), "Accept order" comes back (`:202`), and `check_chain` would answer "no coin amount" (`useCommerce.js:169-172`). The vendor has to keep the app open from accept until 3 BTC or 10 XMR confirmations. Re-accepting reuses the cached address but asks for the amount again.

**Design mistake:** order state is a mutation of a received message. It should be a reduction over the persisted `order_update` events for that `orderId`.

**Fix:** derive order state by folding `order_update` messages by `orderId` at render, from Dexie. Stop patching the request.

### H1. High: the buyer never sees the coin amount the guard enforces
See verdict 5 (`MessageBubble.jsx:43-67, 232`). The vendor types a coin amount (`useCommerce.js:115-128`). The buyer sees a USD price and an address. The watcher then calls a payment short against a number the buyer was never shown.

**Fix:** render `coinAmount` and `coinCurrency` on the accepted card, and pass them to `paymentUri` instead of `product.price`.

### H2. High: the countersign echo is re-sent on every history fetch and every subscription replay
In `useNIP44DM.js:274-288` (fetchDMs) and `:171-185` (live), `acceptPayment` returns `added: true` for any vendor-only receipt. The vendor's original event on the relay is vendor-only forever. So every `fetchChats` (app start at `useChatBootstrap.js:361`, plus the refresh button) and every resubscribe with `since` = 7 days co-signs again and sends a new `order_update`. Each one is tagged t=order (H6), buzzes the vendor, and lands as a new "Order / Marked paid" card.

**Fix:** before co-signing, read `receipt_${orderId}`. If it already verifies with both signatures, do not send. Echo only from the live path.

### H3. High: the buyer's countersign send fails silently
`useNIP44DM.js:178-184`: `sendDM` never rejects. It returns `{ success: false }`, so the `.catch` is dead code and the result is dropped. Commit b50397a ("say so when a co-signature fails") does not cover this path. Bug class: silent catch on a payment path.

**Fix:** await the result. On failure, toast and keep a "countersign pending" flag that is retried.

### H4. High: split payments read as short
`paymentWatch.js:61-71`, verdict 2. Even two outputs in one transaction (one txid) read as short, so the "a receipt names one transaction" rule does not require this behavior.

**Fix:** group rows by txid and sum each group with BigInt over decimal strings. Report the txid whose sum covers the order. Report multi-transaction payments as info: "paid in N transactions", with no auto-confirm.

### H5. High (design/security): the push gateway accepts anyone's registration for any pubkey
`notify-gateway.mjs:110-149`: `/subscribe` and `/native` take `{pubkey, ...}` with no proof of key ownership and no token. Anyone can register a victim's pubkey and get a push each time that key receives a DM, an order or a call. That is a metadata oracle, and an open spam target.

**Fix:** require a NIP-98-style signed event (kind 27235) from that pubkey over the method, URL and body hash. Add an operator token like the watcher has.

### H6. High (design/privacy): order and call tags are cleartext on public events
`useNIP44DM.js:51-55` adds `['t','order'|'call'|'msg']` to kind-4 events published to public relays. Every relay and observer learns which DMs are orders or calls, and between whom. NIP-44 hides the content and this hands the commerce metadata back.

**Design mistake.** **Fix:** move typing and read receipts to ephemeral kinds, have the gateway buzz on any kind-4 addressed to a subscriber, and drop the t tags. The alternative is a separate wake event encrypted to the gateway's key. The tag was added in 1fa1784 and extended to order and call after.

### M1. Medium: a watcher with no amount is a red error
Verdict 4. **Fix:** in `checkPayment`, map "did not report an amount" to `{ moved: false, noAmount: true }`. In `useCommerce`, show an info toast naming the watcher as out of date.

### M2. Medium: an amount finer than the coin is short forever
`useCommerce.js:122` and `paymentState.js:24` accept any number of decimals. `paymentState.js:45` returns null when there are more than 8 (BTC) or 12 (XMR) places, so `amountCovers` is false and the order reads short no matter what was paid (probe: order 0.123456789 BTC, paid 1 BTC, `short: true`). `paymentUri.js:8` silently drops the amount from the QR in the same case. Correct half-up rounding exists only in `proofOfTrade.js:198-215`, used for ranking.

Bug class: a guard that exists and is tested in isolation (rounding) but never fed.

**Fix:** one shared `roundToScale` (half up, BigInt), applied when the amount is entered. Store and show the rounded string.

### M3. Medium (design): the vendor's wallet tap sets `paymentState: 'seen'`
`useCommerce.js:137-162`. On Bitcoin, "seen" is supposed to mean mined, but a tap produces it with nothing mined. A real watcher report at 1-2 confirmations then "did not move" and the vendor reads "Your watcher has not seen this payment yet" (`:187-190`), which is false. The tap also sets `status: 'paid'`, which the watcher's seen path does not (`:234`).

**Fix:** the tap sets `vendorMarked: true` only. `paymentState` moves only through `applyWatcherReport`.

### M4. Medium (design): the countersignature is automatic, so it attests little
`proofOfTrade.js:81-102` co-signs any well-formed receipt that arrives with status paid or disputed. It never compares amount, currency, address or txid against the buyer's own order. `docs/proof-of-trade.md` says the self-trade check means "a vendor cannot add their own volume". That is over-claimed: it blocks only the same key, and a second key passes.

**Fix:** before co-signing, the buyer checks the body against the local order (orderId, coinAmount, currency, issued address). Correct the doc.

### M5. Medium: the "public view" is never published
It is written only to localStorage (`proofOfTrade.js:270-281`) and carried inside DMs. Nothing in `src/` publishes it to a relay. `docs/proof-of-trade.md` says "What is published by default".

**Fix:** publish it as a replaceable event, or relabel it as a local record in the doc and the UI.

### M6. Medium: VendorDashboard is stale and shows other vendors' volume
`VendorDashboard.jsx:25-28` reads once. `readPublicViews()` is not filtered by vendor. `VolumeList` (`:8-19`) shows no vendor name. `stats.xmr.toFixed(6)` (`:47`) drops 6 of Monero's 12 decimals, and `useVendorStats.js:36-39` sums floats.

**Fix:** filter by `vendor === identity.pk`. Have `rememberPublicView` dispatch an event the dashboard listens for. Use `rankVolume` strings and 12 places for XMR.

### M7. Medium: a failed group key grant is swallowed
`useNIP29Group.js:887-917`: one `catch (e) {}` covers both `JSON.parse` (expected to fail on ciphertext) and `grantKeyRequest`/`distributeGroupKey`. Test 6, "a rejected key delivery fails instead of pretending the grant was sent", proves `distributeGroupKey` throws. The live caller discards the throw. Bug classes: guard tested in isolation and never fed; silent catch on a send path.

**Fix:** a separate `try` for the parse. Log, toast and retry with backoff on a distribute failure.

### M8. Medium: group admin sends ignore relay results
`useNIP29Group.js:486, 492, 558, 663, 675, 686, 713` await `Promise.allSettled` and never read it. `updateGroupSettings` returns `{ success: true }` regardless. A kick rotates the key and removes the member in the UI even if the relay rejected the 9001.

**Fix:** use the `pinMessage` pattern (`:1071-1074`): require at least one fulfilled result, otherwise throw and toast.

### M9. Medium: every call signal rings
`voiceCall.js:36-43`: every signal (ice, answer, reject, busy, hangup) is `type: 'call'`, so it gets t=call (`pushGateway.js:13`). A hangup or reject more than 15s after the last push (`notify-gateway.mjs:62`) shows "Incoming call" on a locked phone. `signal()` also treats a `{ success: false }` from sendDM as success.

**Fix:** tag only `action: 'offer'`, and check the send result.

### M10. Medium (design): group messages never buzz a locked phone
The gateway watches only kind 4 on `CIPHER_RELAYS` (`notify-gateway.mjs:164`). Group messages are kind 9 on the group relay. DMs go to the peer's NIP-65 read relays (`dmRelays.js:9-29`, `nip65.js:53-58`), so a peer whose inbox is not on `CIPHER_RELAYS` never buzzes either.

**Fix:** make the gateway follow each subscriber's own read relays, and decide and document group wake.

### M11. Medium (design): the BTC watcher is a full UTXO-set scan per tap
`payment-watcher.mjs:76-84`: Core runs one `scantxoutset` at a time, so concurrent taps get a 502. A spent output disappears from the scan: if the vendor sweeps the address before checking, the order never confirms.

**Fix:** a watch-only descriptor wallet (`importdescriptors`, then `listreceivedbyaddress` or `listtransactions`). Until then, document "do not spend before confirmed".

### M12. Medium: the amount guard is optional by signature
`paymentState.js:65`: `amount == null` skips the guard. Tests rely on that (`paymentState.test.js:20-37, 39-69`; `paymentWatch.test.js:25-52`).

**Fix:** require an amount for seen and confirmed, and update the tests to pass it.

### L1. Low: the watcher token travels in cleartext
The token is in the URL query, the client sends it in both query and header (`paymentWatch.js:41-45, 95`), the watcher listens on `0.0.0.0` over plain HTTP, and it prints the token at startup (`payment-watcher.mjs:139-140`).

**Fix:** header only, TLS or onion guidance, never log the token.

### L2. Low: the XMR report counts transfers it should not
It includes `pending` transfers, which are outgoing (`payment-watcher.mjs:62-64`), and ignores `unlock_time`.

**Fix:** use `in` and `pool` only, and treat locked transfers as not seen.

### L3. Low: the confirmations override is read but never written
It is read at `paymentWatch.js:123` and nothing writes it. The watcher log names the wrong key, `cipher_confirmations`; the real key is `cipher_<pk8>_confirmations` (`storage.js:49-52`). Bug class: wired on one side only.

**Fix:** add a settings field, or fix the log line.

### L4. Low: dead code that passes tests
- `useNIP29Group.js:864-870`: a second `kind === 39002` branch is unreachable, because `:788` returns first. If it were ever reached, it would trust an unsigned snapshot.
- `useCommerce.js:196` is unreachable, because `applyWatcherReport` already throws.

**Fix:** delete both.

### L5. Low: group notifications pass the wrong arguments
`useNIP29Group.js:998-1000` calls `showNotification(title, body)`. The function takes `(type)` (`notifications.js:23`). The reply and mention branches are dead, and everything shows "New Message". The privacy result is fine; the code is wrong.

**Fix:** pass a kind, and remove the dead branches.

### L6. Low: stale docs
README:23 and :65 omit t=order. `AGENTS.md` describes a different product ("Grok Dashboard", nitro).

**Fix:** update README, and replace or delete AGENTS.md.

### L7. Low: 14 test files are not run
See Phase 1. **Fix:** add them to `npm test` or delete them.

### Invariants: what touched the DM path, group AAD, or the outbox since `f392dca` (71 commits)

- `src/hooks/useNIP44DM.js` (the DM path, not the NIP-44 calls themselves):
  - 1fa1784 adds t tags to the public DM event, which changes the shape of every outgoing DM.
  - 8cf4184, 10bacf5 and c4a9449 add receipt handling to DM ingest.
  - a88ba75 makes further changes.
- `src/lib/outbox.js`: a88ba75 (+9/-5) and b98d8ea (+44/-26).
- `groupCipher.js` and `groupMessageCodec.js`: no commits in range. Group AAD is untouched.

I did not diff each commit to prove the `nip44.v2` calls are unchanged. The calls at HEAD (`useNIP44DM.js:49-50, 136-138, 259-262`) are stock `nip44.v2`. Separately, kind 4 carrying a NIP-44 payload is non-standard (NIP-04's kind). That is noted only, since it is an invariant.

Selector check: I found no selector returning a fresh object in the audited files. `egress.js:78-108` keeps its snapshot stable on purpose.

Verify-throws check: none found. `verifyReceipt`, `verifyPublicView` and `verifyVendorView` all return false on garbage, and `proofOfTrade.test.js:104-114` covers it.

## 5. Calibration

| Finding | How verified | Confidence |
|---|---|---|
| C1 XMR units | Probe against the real `reportFromTransfers` and `checkPayment` at HEAD. Atomic units are per monero-wallet-rpc docs. Not run against a live wallet | High |
| C2 state lost on reload | Read `updateLocalOrder`, `fetchChats` (rebuild from Dexie), and `fetchDMs` with the `saveMessage` merge. Not run in a browser | High |
| H1 no coin amount on card | grep: `coinAmount` appears only in useCommerce. Read `OrderReceipt` and `paymentUri` | High |
| H2 echo re-sent | Read `acceptPayment` (`added: !already` over the relay copy) and both call sites | High |
| H3 silent countersign failure | Read `sendDM` (never throws) and the caller | High |
| H4 split reads short | Probe at HEAD, plus the existing test | High |
| H5 open gateway registration | Read the handlers: no auth | High |
| H6 cleartext tags | Read `withBuzzTag` use on the kind-4 event | High |
| M1, M2 | Probe at HEAD | High |
| M3 vendor tap sets seen | Read `useCommerce.js:137-162` and `:187-190` | High |
| M4, M5 | Read code and doc. grep for any publisher of the view | High |
| M6 dashboard | Read the component and the hook | High |
| M7, M8 | Read code and test 6 | High |
| M9 call rings | Read `voiceCall` signal sites and `buzzTagFor` | High |
| M10 group never buzzes | Read the gateway filter and the group transport | High |
| M11 scantxoutset | Code read, plus Bitcoin Core behavior from knowledge. Not run against a node | Medium |
| L1-L7 | Code read and grep | High |
| Verdict 7, gate run | Absence of evidence in the repo | Unverified |
| Verdict 8, locked-phone buzz | The gateway's own `buzzing: false` and `.env.example`. No device test | Unverified |

## 6. Scores

- **Payment confirmation: 3/10.** The state machine, BigInt compare, explorer refusal and token handling are solid. But the XMR guard is broken by units (C1), the vendor loses order state on reload (C2), the buyer cannot see the amount (H1), and splits read short (H4). It does not hold up end to end.
- **Push: 3/10.** Notices never carry text, and the Web Push path is complete in code. But registration is open to anyone (H5), order and call metadata is public on every DM (H6), group messages never buzz (M10), hangups ring (M9), and no locked phone has been shown to buzz on any transport.

## 7. Credit, specific

- `paymentState.js:1-32, 75-80`: a transition table that throws on any skip. The confirmation count, not the `confirmed` flag, decides confirmation, and the test proves it (`paymentState.test.js:43-69`).
- `paymentState.js:39-56`: amount comparison in BigInt units, with no float comparison.
- `paymentWatch.js:18-47`: explorers and token-less URLs are refused before any request, and the test asserts `called === false` (`paymentWatch.test.js:6-23`).
- `payment-watcher.mjs:30-35, 97-106, 129-138`: `timingSafeEqual`, refuses an open check, will not listen without a token. RPC credentials are moved from the URL into a Basic header (`:37-45`). No mempool path, and the comment says why (`:6-10`).
- `paymentWatch.js:49-59`: confirmations from `tip - height + 1` when Core omits them.
- `proofOfTrade.js:104-117, 169-194`: verifiers return false and do not throw. Self-trade is rejected. The public view is rejected if it carries an address, txid or body (`:171`). `amountUnits` (`:198-215`) rounds half up correctly, and the tests check dust and half-up (`proofOfTrade.test.js:78-83`).
- `useCommerce.js:29-47` (`deliverOrderUpdate`): handles both a throw and `{ success: false }`, and patches local state only on success.
- `egress.js:78-108`: a stable snapshot for `useSyncExternalStore`, with a test. One host inventory, which `nativePushSend.js:6-10` reads instead of inlining hosts.
- `sw.js:58-70` and `pushGateway.js:51-59`: the notice never carries text, tested against the service worker source.
- `notify-gateway.mjs:135-142`: honest. `/native` reports `buzzing: false` with a reason instead of pretending.
- `useNIP29Group.js:788-808`: 39002 is accepted only from the relay key, and membership control events go through `authorizeGroupControl`.

## 8. Build brief

```
Rules: do not touch DM crypto (NIP-44), group AAD, or the outbox. One change
per commit. npm run build, npm run lint and npm test green before every
commit. No new dependencies. Push each commit. Read files pinned to the SHA.

Ordered work

1. XMR watcher units (C1)
   payment-watcher.mjs converts monero-wallet-rpc atomic amounts to a 12-place
   decimal string with BigInt before reportFromTransfers. BTC amounts become
   8-place strings.
   Done when: a test with a real get_transfers row {amount: 500000000000}
   covers a 0.5 XMR order and does not cover 0.6; a row {amount: 1} does not
   cover 0.5; the signed receipt says 0.5.

2. Amount required (M12)
   applyWatcherReport refuses seen/confirmed with no order amount. Old tests
   updated to pass one, for both btc and xmr.
   Done when: every checkPayment/applyWatcherReport test passes an amount, and
   one test proves a missing order amount refuses.

3. Order state from persisted updates (C2)
   Order state is derived by folding order_update messages by orderId from
   Dexie. updateLocalOrder is removed.
   Done when: accept, reload, and Check the chain is still visible with the
   same address and coin amount; Accept does not reappear.

4. Buyer sees the coin amount (H1)
   The accepted card shows coinAmount and coinCurrency. paymentUri uses them.
   Done when: a USD-priced order accepted at 0.001 BTC renders "0.001 BTC"
   and the QR is bitcoin:<addr>?amount=0.001.

5. Round at entry (M2)
   One roundToScale (half up, BigInt; 8 BTC, 12 XMR), used by the accept
   dialog, orderCoinAmount, paymentState and rankVolume.
   Done when: 0.123456785 BTC becomes 0.12345679, 0.123456784 becomes
   0.12345678, and a covering payment confirms.

6. Split outputs (H4)
   Rows are grouped by txid and summed. Multi-tx coverage is reported as info,
   with no confirm.
   Done when: one tx with 0.006 + 0.004 confirms a 0.01 order and names that
   txid; two txs summing to 0.01 return {moved:false, split:true}.

7. No-amount watcher is info (M1)
   Done when: a watcher answer without amount shows an info toast, not an
   error toast.

8. Vendor tap does not set seen (M3)
   Done when: "I saw the payment" sets vendorMarked only; paymentState is
   unchanged; a watcher report at 1 confirmation moves address_issued to seen.

9. Countersign once, and say when it fails (H2, H3)
   Done when: reloading the buyer app twice sends zero new order_update DMs
   for an already countersigned receipt; a failed countersign send shows a
   toast and is retried.

10. Buyer checks before co-signing (M4)
    Done when: a receipt whose amount, currency or address differs from the
    buyer's order is not co-signed, and a test proves it. The doc no longer
    says a vendor cannot add their own volume.

11. Dashboard (M6)
    Done when: rows are filtered to vendor === me; a countersign arriving
    while the dashboard is open updates it without a remount; XMR shows 12
    places.

12. Gateway auth (H5)
    /subscribe and /native require a signed kind-27235 event from the pubkey
    over method, URL and body hash.
    Done when: an unsigned or wrong-key registration gets 401, and a test
    proves it.

13. Calls ring once (M9)
    Done when: only action 'offer' carries t=call; a test proves hangup,
    reject, busy and ice carry no t tag.

14. Silent sends (M7, M8)
    Done when: a failed key grant and a rejected kick/promote/settings/leave
    each log and toast; updateGroupSettings returns success:false on reject.

15. Dead code and docs (L3, L4, L5, L6, L7)
    Done when: the unreachable 39002 branch and useCommerce:196 are gone;
    showNotification gets a kind; README lists t=order; the 14 unrun tests
    are run or deleted.

Decide before building (design, needs an owner call)
- H6 cleartext t tags on public DMs: ephemeral kinds for typing and read plus
  untagged DMs, or an encrypted wake event to the gateway.
- M5 publish the public view to a relay, or call it a local record.
- M10 group wake and per-subscriber relays on the gateway.
- M11 replace scantxoutset with a watch-only descriptor wallet.

Already correct (leave alone)
- The state machine and its no-skip transitions; count beats flag.
- BigInt amount comparison.
- Explorer refusal before any request; the watcher token is required.
- Watcher timingSafeEqual; Basic auth header; no mempool path.
- Verifiers return false and do not throw; self-trade rejected; public view
  strips address and txid.
- Half-up rounding in proofOfTrade.amountUnits (reuse it, don't rewrite it).
- Push notices carry no text; sw.js ignores payload text.
- egress snapshot stability; one host inventory.
- 39002 only from the relay key; membership control authorization.

Fixed now
- Nothing. This pass made no code changes.
```

## 9. Raw Phase 1 output (re-run at c67f0c1)

### `npm run build`

```

> cipher@0.0.0 build
> node scripts/with-app-env.mjs vite --config vite.config.js build

vite v8.3.4 building client environment for production...
transforming...
✓ 2519 modules transformed.
rendering chunks...
computing gzip size...
dist/index.html                             1.46 kB │ gzip:  0.68 kB
dist/assets/index-D0hWCP7p.css             31.79 kB │ gzip:  7.15 kB
dist/assets/voiceCall-B7hjjXK-.js           0.06 kB │ gzip:  0.08 kB
dist/assets/esm-BXC3LNjd.js                 0.11 kB │ gzip:  0.10 kB
dist/assets/plus-0umi5HmJ.js                0.18 kB │ gzip:  0.16 kB
dist/assets/loader-circle-2qYXdbNz.js       0.19 kB │ gzip:  0.18 kB
dist/assets/search-BZJlrNuV.js              0.20 kB │ gzip:  0.18 kB
dist/assets/forward-SJBuGFsm.js             0.20 kB │ gzip:  0.18 kB
dist/assets/type-KlaVK1dA.js                0.24 kB │ gzip:  0.20 kB
dist/assets/message-circle-BFvMOKLl.js      0.27 kB │ gzip:  0.22 kB
dist/assets/users-DxuOpOoN.js               0.33 kB │ gzip:  0.24 kB
dist/assets/badge-check-BrGwjyKe.js         0.37 kB │ gzip:  0.25 kB
dist/assets/megaphone-DDHIwvnY.js           0.37 kB │ gzip:  0.26 kB
dist/assets/package-OHG7EqR7.js             0.40 kB │ gzip:  0.27 kB
dist/assets/store-DLAiPyoY.js               0.52 kB │ gzip:  0.30 kB
dist/assets/rolldown-runtime-XKyaHtl9.js    0.72 kB │ gzip:  0.42 kB
dist/assets/esm-DZhBGPFl.js                 0.72 kB │ gzip:  0.41 kB
dist/assets/pool-B73iTKNy.js                0.90 kB │ gzip:  0.54 kB
dist/assets/useVouchCount-DprngPqA.js       0.93 kB │ gzip:  0.59 kB
dist/assets/copyText-BN6mLcVE.js            1.36 kB │ gzip:  0.73 kB
dist/assets/hmac-CmYQHmgA.js                1.38 kB │ gzip:  0.61 kB
dist/assets/useProfiles-CdxE6aDp.js         1.81 kB │ gzip:  0.91 kB
dist/assets/DmView-DBmi48th.js              2.08 kB │ gzip:  1.01 kB
dist/assets/_md-DAyZ4w-S.js                 2.08 kB │ gzip:  1.07 kB
dist/assets/legacy-BoS4nOuE.js              3.82 kB │ gzip:  1.70 kB
dist/assets/ProfileModal-VL_h8hRt.js        4.04 kB │ gzip:  1.85 kB
dist/assets/web-DW35DcwH.js                 4.44 kB │ gzip:  1.28 kB
dist/assets/ProfileEditor-C4ljID6d.js       4.47 kB │ gzip:  1.77 kB
dist/assets/Discover-CEQMe97m.js            4.50 kB │ gzip:  1.90 kB
dist/assets/bip39-MpvNTWsG.js               4.99 kB │ gzip:  2.11 kB
dist/assets/VendorDashboard-Slwun8st.js     5.06 kB │ gzip:  1.88 kB
dist/assets/VendorStorefront-oP3dlmtG.js    5.37 kB │ gzip:  2.05 kB
dist/assets/proofOfTrade-BJEaJwXW.js        5.54 kB │ gzip:  2.22 kB
dist/assets/utils-CSny2JPi.js               5.72 kB │ gzip:  2.37 kB
dist/assets/sha2-CjybWU0o.js                6.83 kB │ gzip:  3.54 kB
dist/assets/react-DlmbjZJV.js               7.87 kB │ gzip:  3.00 kB
dist/assets/dist-BZzXv9Bm.js                8.34 kB │ gzip:  3.98 kB
dist/assets/dmRelays-CD7vk4uO.js            9.25 kB │ gzip:  3.78 kB
dist/assets/notifications-BSbBgzk9.js       9.82 kB │ gzip:  3.95 kB
dist/assets/Shop-DP8UwDpE.js                9.99 kB │ gzip:  3.57 kB
dist/assets/dist-BwDGAvLd.js               11.21 kB │ gzip:  3.83 kB
dist/assets/useNIP44DM-CD5NyMdh.js         12.01 kB │ gzip:  4.41 kB
dist/assets/english-oOihPoMM.js            13.17 kB │ gzip:  6.50 kB
dist/assets/esm-BUxC12gp.js                16.52 kB │ gzip:  6.19 kB
dist/assets/secp256k1-C4J1y55y.js          17.74 kB │ gzip:  7.14 kB
dist/assets/GroupView-CIMUFeWc.js          19.70 kB │ gzip:  6.15 kB
dist/assets/ChatHeader-B64B_pwF.js         20.04 kB │ gzip:  7.00 kB
dist/assets/curve-BnK-hn2J.js              20.84 kB │ gzip:  9.17 kB
dist/assets/hkdf-XWjvZBK1.js               23.08 kB │ gzip:  9.24 kB
dist/assets/vendorPayments-Dr0fmssN.js     26.56 kB │ gzip: 11.06 kB
dist/assets/AuthenticatedApp-ByAmg_lB.js   28.09 kB │ gzip:  9.77 kB
dist/assets/useNIP29Group-DXLf6LPG.js      33.99 kB │ gzip: 10.93 kB
dist/assets/bip32-BvsUlJHt.js              37.83 kB │ gzip: 13.76 kB
dist/assets/Wallet-CRQPYGt-.js             52.95 kB │ gzip: 11.90 kB
dist/assets/esm-DRwoFPt4.js                62.79 kB │ gzip: 21.52 kB
dist/assets/Chat-D0SOteo8.js               95.41 kB │ gzip: 27.33 kB
dist/assets/db-ZLIfZkkA.js                 97.73 kB │ gzip: 32.14 kB
dist/assets/jsQR-Ct1FLwmy.js              129.98 kB │ gzip: 47.50 kB
dist/assets/proxy-CVsPYz2F.js             132.45 kB │ gzip: 43.56 kB
dist/assets/index-CH42DFfj.js             280.10 kB │ gzip: 86.36 kB

[INEFFECTIVE_DYNAMIC_IMPORT] src/store/chatStore.js is dynamically imported by src/useIdentity.js but also statically imported by src/App.jsx, src/AuthenticatedApp.jsx, src/Chat.jsx, src/Discover.jsx, src/LockScreen.jsx, ..., dynamic import will not move module into another chunk.

✓ built in 4.16s
EXIT=0
```

### `npm run lint`

```

> cipher@0.0.0 lint
> oxlint

src/components/chat/ProductEditModal.jsx:13:5: warning react(set-state-in-effect): Calling setState synchronously within an effect can trigger cascading renders help: Effects should synchronize React with external systems. Calling setState synchronously inside an effect starts another render and is usually unnecessary. Derive the value during render, initialize state directly, or update it from the event that caused the change. Use an effect only when synchronizing with an external system.
src/components/chat/ChatPinnedBar.jsx:2:41: warning eslint(no-unused-vars): Parameter 'children' is declared but never used. Unused parameters should start with a '_'. help: Consider removing this parameter.
src/components/chat/ChatPinnedBar.jsx:2:54: warning eslint(no-unused-vars): Parameter 'props' is declared but never used. Unused parameters should start with a '_'. help: Consider removing this parameter.
src/components/chat/FullEmojiPicker.jsx:2:43: warning eslint(no-unused-vars): Parameter 'children' is declared but never used. Unused parameters should start with a '_'. help: Consider removing this parameter.
src/components/chat/FullEmojiPicker.jsx:2:56: warning eslint(no-unused-vars): Parameter 'props' is declared but never used. Unused parameters should start with a '_'. help: Consider removing this parameter.
src/components/chat/VendorDashboard.jsx:27:5: warning react(set-state-in-effect): Calling setState synchronously within an effect can trigger cascading renders help: Effects should synchronize React with external systems. Calling setState synchronously inside an effect starts another render and is usually unnecessary. Derive the value during render, initialize state directly, or update it from the event that caused the change. Use an effect only when synchronizing with an external system.
src/lib/app-data/use-connector-readiness.ts:65:7: warning react(set-state-in-effect): Calling setState synchronously within an effect can trigger cascading renders help: Effects should synchronize React with external systems. Calling setState synchronously inside an effect starts another render and is usually unnecessary. Derive the value during render, initialize state directly, or update it from the event that caused the change. Use an effect only when synchronizing with an external system.
src/components/chat/ChatReplyPreview.jsx:2:44: warning eslint(no-unused-vars): Parameter 'children' is declared but never used. Unused parameters should start with a '_'. help: Consider removing this parameter.
src/components/chat/ChatReplyPreview.jsx:2:57: warning eslint(no-unused-vars): Parameter 'props' is declared but never used. Unused parameters should start with a '_'. help: Consider removing this parameter.
src/components/chat/BroadcastModal.jsx:9:17: warning react(set-state-in-effect): Calling setState synchronously within an effect can trigger cascading renders help: Effects should synchronize React with external systems. Calling setState synchronously inside an effect starts another render and is usually unnecessary. Derive the value during render, initialize state directly, or update it from the event that caused the change. Use an effect only when synchronizing with an external system.
src/components/chat/LinkPreview.jsx:8:17: warning react(only-export-components): Fast refresh only works when a file only exports components. Use a new file to share constants or functions between components.
src/components/chat/LinkPreview.jsx:21:7: warning react(set-state-in-effect): Calling setState synchronously within an effect can trigger cascading renders help: Effects should synchronize React with external systems. Calling setState synchronously inside an effect starts another render and is usually unnecessary. Derive the value during render, initialize state directly, or update it from the event that caused the change. Use an effect only when synchronizing with an external system.
src/Discover.jsx:57:7: warning react(set-state-in-effect): Calling setState synchronously within an effect can trigger cascading renders help: Effects should synchronize React with external systems. Calling setState synchronously inside an effect starts another render and is usually unnecessary. Derive the value during render, initialize state directly, or update it from the event that caused the change. Use an effect only when synchronizing with an external system.
src/components/chat/GroupView.jsx:188:48: warning react-hooks(exhaustive-deps): React Hook useEffect has missing dependencies: 'activeGroup.name', and 'identity' help: Either include it or remove the dependency array.
src/components/chat/MessageSearchResults.jsx:3:48: warning eslint(no-unused-vars): Parameter 'children' is declared but never used. Unused parameters should start with a '_'. help: Consider removing this parameter.
src/components/chat/MessageSearchResults.jsx:3:61: warning eslint(no-unused-vars): Parameter 'props' is declared but never used. Unused parameters should start with a '_'. help: Consider removing this parameter.
src/hooks/useNIP44DM.js:139:22: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/hooks/useNIP44DM.js:141:55: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/hooks/useNIP44DM.js:239:53: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/hooks/useNIP44DM.js:262:16: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/hooks/useNIP44DM.js:264:49: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/hooks/useNIP44DM.js:29:28: warning react-hooks(exhaustive-deps): React Hook useEffect has a missing dependency: 'identity' help: Either include it or remove the dependency array.
src/components/GlobalDialog.jsx:15:5: warning react(set-state-in-effect): Calling setState synchronously within an effect can trigger cascading renders help: Effects should synchronize React with external systems. Calling setState synchronously inside an effect starts another render and is usually unnecessary. Derive the value during render, initialize state directly, or update it from the event that caused the change. Use an effect only when synchronizing with an external system.
src/db.js:36:52: warning eslint(no-unused-vars): Catch parameter '_' is caught but never used. help: Consider handling this error.
src/db.js:51:10: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/db.js:54:52: warning eslint(no-unused-vars): Catch parameter '_' is caught but never used. help: Consider handling this error.
src/db.js:67:68: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/hooks/useReputation.js:54:13: warning eslint(no-unused-vars): Variable 'cachedPubkeys' is declared but never used. Unused variables should start with a '_'. help: Consider removing this declaration.
src/hooks/useScamReports.js:15:49: warning react-hooks(exhaustive-deps): React Hook useEffect has a missing dependency: 'identity' help: Either include it or remove the dependency array.
src/hooks/useVouchCount.js:14:7: warning react(set-state-in-effect): Calling setState synchronously within an effect can trigger cascading renders help: Effects should synchronize React with external systems. Calling setState synchronously inside an effect starts another render and is usually unnecessary. Derive the value during render, initialize state directly, or update it from the event that caused the change. Use an effect only when synchronizing with an external system.
src/hooks/useVouchCount.js:21:49: warning react-hooks(exhaustive-deps): React Hook useEffect has a missing dependency: 'identity' help: Either include it or remove the dependency array.
src/hooks/usePanicWipe.js:7:14: warning react(refs): Cannot access refs during render help: React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected
src/Wallet.jsx:3:9: warning eslint(no-unused-vars): Identifier 'Plus' is imported but never used. help: Consider removing this import.
src/Wallet.jsx:5:33: warning eslint(no-unused-vars): Identifier 'ShieldAlert' is imported but never used. help: Consider removing this import.
src/Wallet.jsx:15:8: warning eslint(no-unused-vars): Identifier 'Logo' is imported but never used. help: Consider removing this import.
src/Wallet.jsx:38:9: warning eslint(no-unused-vars): Variable 'panicWipeEnabled' is declared but never used. Unused variables should start with a '_'. help: Consider removing this declaration.
src/Wallet.jsx:39:9: warning eslint(no-unused-vars): Variable 'setPanicWipeEnabled' is declared but never used. Unused variables should start with a '_'. help: Consider removing this declaration.
src/Wallet.jsx:72:25: warning react(set-state-in-effect): Calling setState synchronously within an effect can trigger cascading renders help: Effects should synchronize React with external systems. Calling setState synchronously inside an effect starts another render and is usually unnecessary. Derive the value during render, initialize state directly, or update it from the event that caused the change. Use an effect only when synchronizing with an external system.
src/Wallet.jsx:80:29: warning react-hooks(exhaustive-deps): React Hook useEffect has a missing dependency: 'identity' help: Either include it or remove the dependency array.
src/features/chat/useMessageCommands.js:211:16: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/hooks/useNIP29Group.js:637:14: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/hooks/useNIP29Group.js:917:16: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/hooks/useNIP29Group.js:997:20: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/hooks/useNIP29Group.js:1107:14: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/hooks/useNIP29Group.js:432:28: warning react-hooks(exhaustive-deps): React Hook useEffect has a missing dependency: 'identity' help: Either include it or remove the dependency array.
src/hooks/useNIP29Group.js:724:47: warning react-hooks(exhaustive-deps): React Hook useCallback has a missing dependency: 'identity' help: Either include it or remove the dependency array.
src/hooks/useNIP29Group.js:1064:45: warning react-hooks(exhaustive-deps): React Hook useCallback has a missing dependency: 'identity' help: Either include it or remove the dependency array.
src/hooks/useNIP29Group.js:1080:45: warning react-hooks(exhaustive-deps): React Hook useCallback has a missing dependency: 'identity' help: Either include it or remove the dependency array.
src/hooks/useNIP29Group.js:1097:47: warning react-hooks(exhaustive-deps): React Hook useCallback has a missing dependency: 'identity' help: Either include it or remove the dependency array.
src/features/chat/usePeopleSearch.js:31:18: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/features/chat/usePeopleSearch.js:58:14: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/features/chat/usePeopleSearch.js:85:20: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/features/chat/usePeopleSearch.js:133:20: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/features/chat/usePeopleSearch.js:207:18: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/features/chat/usePeopleSearch.js:236:20: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/features/chat/usePeopleSearch.js:298:20: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/features/chat/usePeopleSearch.js:303:20: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/features/chat/usePeopleSearch.js:260:13: warning eslint(no-constant-condition): Unexpected constant condition help: Update the condition to not be constant, or remove the condition entirely
src/features/chat/usePeopleSearch.js:260:13: warning eslint(no-constant-binary-expression): Unexpected constant truthiness on the left-hand side of a "&&" expression help: This expression always evaluates to the constant on the left-hand side
src/features/chat/useComposer.js:66:11: warning eslint(no-unused-vars): Variable 'chatId' is declared but never used. Unused variables should start with a '_'. help: Consider removing this declaration.
src/useIdentity.js:108:16: warning eslint(no-unused-vars): Catch parameter '_' is caught but never used. help: Consider handling this error.
src/useIdentity.js:258:18: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/useIdentity.js:296:11: warning eslint(no-unused-vars): Variable 'lookupId' is declared but never used. Unused variables should start with a '_'. help: Consider removing this declaration.
src/useIdentity.js:425:14: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/useIdentity.js:571:14: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/useIdentity.js:636:13: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/useIdentity.js:642:13: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/useIdentity.js:699:18: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/useIdentity.js:706:18: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/useIdentity.js:749:29: warning eslint(no-unused-vars): Variable 'nip19' is declared but never used. Unused variables should start with a '_'. help: Consider removing this declaration.
src/useIdentity.js:787:16: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/LockScreen.jsx:19:14: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/LockScreen.jsx:59:9: warning eslint(no-unused-vars): Variable 'checkUsernameAvailable' is declared but never used. Unused variables should start with a '_'. help: Consider removing this declaration.
src/components/ShopView.jsx:2:36: warning eslint(no-unused-vars): Parameter 'children' is declared but never used. Unused parameters should start with a '_'. help: Consider removing this parameter.
src/components/ShopView.jsx:2:49: warning eslint(no-unused-vars): Parameter 'props' is declared but never used. Unused parameters should start with a '_'. help: Consider removing this parameter.
src/features/chat/useChatBootstrap.js:438:6: warning react(preserve-manual-memoization): Existing memoization could not be preserved help: React Compiler has skipped optimizing this component because the existing manual memoization could not be preserved. The inferred dependencies did not match the manually specified dependencies, which could cause the value to change more or less frequently than expected. The inferred dependency was `activeGroup.id`, but the source dependencies were [activeGroup?.id, groupMessages]. Inferred different dependency than source
src/features/chat/useChatBootstrap.js:112:31: warning react-hooks(exhaustive-deps): React Hook useEffect has a missing dependency: 'identity' help: Either include it or remove the dependency array.
src/features/chat/useChatBootstrap.js:159:47: warning react-hooks(exhaustive-deps): React Hook useEffect has a missing dependency: 'identity' help: Either include it or remove the dependency array.
src/features/chat/useChatBootstrap.js:212:49: warning react-hooks(exhaustive-deps): React Hook useEffect has missing dependencies: 'identity', and 'lockedUsername' help: Either include it or remove the dependency array.
src/features/chat/useChatBootstrap.js:369:18: warning react-hooks(exhaustive-deps): React Hook useEffect has missing dependencies: 'subscribeToGroupReactions', 'subscribeToGroups', 'fetchChats', and 'subscribeToDMs' help: Either include it or remove the dependency array.
src/features/chat/useChatBootstrap.js:383:5: warning react-hooks(exhaustive-deps): React Hook useEffect has a missing dependency: 'fetchGroups' help: Either include it or remove the dependency array.
src/features/chat/useChatBootstrap.js:442:5: warning react-hooks(exhaustive-deps): React Hook useEffect has a missing dependency: 'fetchProfilesForPubkeys' help: Either include it or remove the dependency array.
src/features/chat/useChatBootstrap.js:526:14: warning react-hooks(exhaustive-deps): React Hook useEffect has missing dependencies: 'joinGroupById', 'identity', and 'requestToJoinGroup' help: Either include it or remove the dependency array.
src/components/MessageBubble.jsx:78:28: warning react(purity): Cannot call impure function during render help: `Date.now` is an impure function. Calling an impure function can produce unstable results that update unpredictably when the component re-renders
src/components/MessageBubble.jsx:136:95: warning react(refs): Cannot access refs during render help: React refs are values that are not needed for rendering. Refs should only be accessed outside of render, such as in event handlers or effects. Accessing a ref value (the `current` property) during render can cause your component not to update as expected
src/components/ui/Picture.jsx:1:17: warning react(only-export-components): Fast refresh only works when a file only exports components. Use a new file to share constants or functions between components.
src/useProfiles.js:85:20: warning eslint(no-unused-vars): Catch parameter 'e' is caught but never used. help: Consider handling this error.
src/useProfiles.js:27:7: warning react-hooks(exhaustive-deps): React Hook useEffect has a complex expression in the dependency array. help: Extract the expression to a separate variable so it can be statically checked.
src/useProfiles.js:26:9: warning react-hooks(exhaustive-deps): React Hook useEffect has missing dependencies: 'pubkeys.length', and 'pubkeys' help: Either include it or remove the dependency array.
src/useProfiles.js:43:7: warning react-hooks(exhaustive-deps): React Hook useEffect has a complex expression in the dependency array. help: Extract the expression to a separate variable so it can be statically checked.
src/useProfiles.js:33:26: warning react-hooks(exhaustive-deps): React Hook useEffect has a missing dependency: 'pubkeys' help: Either include it or remove the dependency array.
src/useProfiles.js:98:7: warning react-hooks(exhaustive-deps): React Hook useEffect has a complex expression in the dependency array. help: Extract the expression to a separate variable so it can be statically checked.
src/useProfiles.js:46:10: warning react-hooks(exhaustive-deps): React Hook useEffect has missing dependencies: 'pubkeys', and 'pubkeys.length' help: Either include it or remove the dependency array.
EXIT=0
```

### `npm test`

```

> cipher@0.0.0 test
> node --import ./scripts/resolve-extensionless.mjs --test src/lib/vaultLockout.test.js src/lib/outboxPolicy.test.js src/lib/moneroIndexes.test.js src/lib/moneroAddress.test.js src/lib/vendorPayments.test.js src/lib/paymentState.test.js src/lib/paymentWatch.test.js src/lib/pushGateway.test.js src/lib/nativePushSend.test.js src/lib/privacy.test.js src/lib/crypto/groupCipher.test.js src/lib/crypto/groupKeyGrant.test.js src/lib/crypto/groupKeyMember.test.js src/lib/crypto/memberBaseline.test.js src/lib/crypto/groupKeyRequest.test.js src/lib/crypto/groupMembership.test.js src/lib/vaultCrypto.test.js src/lib/reactions.test.js src/lib/egress.test.js src/lib/nip65.test.js src/lib/proofOfTrade.test.js src/lib/trust.test.js src/store/snapshot.test.js

TAP version 13
# Subtest: group messages round-trip and reject a tampered AAD, epoch, or key
ok 1 - group messages round-trip and reject a tampered AAD, epoch, or key
  ---
  duration_ms: 22.516856
  ...
# Subtest: a key request backfills every epoch the requester missed, not only the current one
ok 2 - a key request backfills every epoch the requester missed, not only the current one
  ---
  duration_ms: 2.783503
  ...
# Subtest: grant tracking asks only for epochs the recipient does not already have
ok 3 - grant tracking asks only for epochs the recipient does not already have
  ---
  duration_ms: 0.483873
  ...
# Subtest: a received key bundle is the epoch list, and a bad hex is dropped
ok 4 - a received key bundle is the epoch list, and a bad hex is dropped
  ---
  duration_ms: 0.617692
  ...
# Subtest: a member offline across two rotations still receives every epoch and can decrypt both
ok 5 - a member offline across two rotations still receives every epoch and can decrypt both
  ---
  duration_ms: 183.156774
  ...
# Subtest: a rejected key delivery fails instead of pretending the grant was sent
ok 6 - a rejected key delivery fails instead of pretending the grant was sent
  ---
  duration_ms: 27.725697
  ...
# Subtest: a key bundle is not a chat message, whether it uses t or type
ok 7 - a key bundle is not a chat message, whether it uses t or type
  ---
  duration_ms: 3.340411
  ...
# Subtest: install refuses a normal message, a bad key, and a bundle before the database is open
ok 8 - install refuses a normal message, a bad key, and a bundle before the database is open
  ---
  duration_ms: 1.211486
  ...
# Subtest: retry delays stay inside ±30% of a base that doubles up to the cap
ok 9 - retry delays stay inside ±30% of a base that doubles up to the cap
  ---
  duration_ms: 2.909449
  ...
# Subtest: two members do not share a retry schedule
ok 10 - two members do not share a retry schedule
  ---
  duration_ms: 1.63712
  ...
# Subtest: the ladder keeps scheduling after the old 62s dead end
ok 11 - the ladder keeps scheduling after the old 62s dead end
  ---
  duration_ms: 73.070224
  ...
# Subtest: a securing key request resumes after the in-memory ladder is dropped
ok 12 - a securing key request resumes after the in-memory ladder is dropped
  ---
  duration_ms: 27.175922
  ...
# Subtest: a send waiting on a key survives reload and stays on the account that queued it
ok 13 - a send waiting on a key survives reload and stays on the account that queued it
  ---
  duration_ms: 1.527995
  ...
# Subtest: the ladder stops at the attempt cap and a reload does not start it over
ok 14 - the ladder stops at the attempt cap and a reload does not start it over
  ---
  duration_ms: 25.762906
  ...
# Subtest: securing becomes stuck after the threshold and a retry resets the clock
ok 15 - securing becomes stuck after the threshold and a retry resets the clock
  ---
  duration_ms: 1.383378
  ...
# Subtest: forged membership events from a non-admin are rejected, including when membership is unknown
ok 16 - forged membership events from a non-admin are rejected, including when membership is unknown
  ---
  duration_ms: 7.138217
  ...
# Subtest: admins may kick or edit, and join or leave is only the signer acting as themselves
ok 17 - admins may kick or edit, and join or leave is only the signer acting as themselves
  ---
  duration_ms: 0.579596
  ...
# Subtest: another member joining or leaving is accepted; a join cannot name someone else
ok 18 - another member joining or leaving is accepted; a join cannot name someone else
  ---
  duration_ms: 0.484044
  ...
# Subtest: the group socket subscribes per group, so one restricted id cannot close the others
ok 19 - the group socket subscribes per group, so one restricted id cannot close the others
  ---
  duration_ms: 2.595233
  ...
# Subtest: 39002 is accepted only from the relay key, and only when the member list is well formed
ok 20 - 39002 is accepted only from the relay key, and only when the member list is well formed
  ---
  duration_ms: 0.895601
  ...
# Subtest: key grants refetch a fresh list that omits the requester before refusing
ok 21 - key grants refetch a fresh list that omits the requester before refusing
  ---
  duration_ms: 0.731595
  ...
# Subtest: a join omitted from a fresh snapshot is re-fetched exactly once
ok 22 - a join omitted from a fresh snapshot is re-fetched exactly once
  ---
  duration_ms: 0.711901
  ...
# Subtest: the relay pubkey is read from NIP-11 and a failed lookup is a short negative cache
ok 23 - the relay pubkey is read from NIP-11 and a failed lookup is a short negative cache
  ---
  duration_ms: 5.668048
  ...
# Subtest: a membership snapshot is taken only from the relay key
ok 24 - a membership snapshot is taken only from the relay key
  ---
  duration_ms: 1.337125
  ...
# Subtest: a requester without a key keeps a capped backoff instead of stopping at 32s
ok 25 - a requester without a key keeps a capped backoff instead of stopping at 32s
  ---
  duration_ms: 1.145924
  ...
# Subtest: a kick refuses a grant from a pre-rotation list
ok 26 - a kick refuses a grant from a pre-rotation list
  ---
  duration_ms: 0.397279
  ...
# Subtest: repeated key requests from one peer do not re-read the relay inside the omission TTL
ok 27 - repeated key requests from one peer do not re-read the relay inside the omission TTL
  ---
  duration_ms: 0.964101
  ...
# Subtest: a failed member re-read is cached briefly and still refuses a pre-rotation list
ok 28 - a failed member re-read is cached briefly and still refuses a pre-rotation list
  ---
  duration_ms: 0.656277
  ...
# Subtest: a joiner missing from the cached list is re-read, and a failed re-read stays quiet for 45s
ok 29 - a joiner missing from the cached list is re-read, and a failed re-read stays quiet for 45s
  ---
  duration_ms: 2.398108
  ...
# Subtest: grant decision table rows 3 and 4 stay different
ok 30 - grant decision table rows 3 and 4 stay different
  ---
  duration_ms: 1.311105
  ...
# Subtest: a failed re-read inside the freshness window still refuses a list older than the key
ok 31 - a failed re-read inside the freshness window still refuses a list older than the key
  ---
  duration_ms: 4.684497
  ...
# Subtest: a reinstall that recovers the baseline still sees who left
ok 32 - a reinstall that recovers the baseline still sees who left
  ---
  duration_ms: 4.63943
  ...
# Subtest: the published baseline round-trips and an older copy does not win
ok 33 - the published baseline round-trips and an older copy does not win
  ---
  duration_ms: 228.643842
  ...
# Subtest: every outbound host is listed, and nowhere else
ok 34 - every outbound host is listed, and nowhere else
  ---
  duration_ms: 30.441249
  ...
# Subtest: defaults work with no config, and an onion replaces only that row
ok 35 - defaults work with no config, and an onion replaces only that row
  ---
  duration_ms: 4.4293
  ...
# Subtest: a pasted call relay keeps its login, and pictures are not blocked
ok 36 - a pasted call relay keeps its login, and pictures are not blocked
  ---
  duration_ms: 1.03556
  ...
# Subtest: the network snapshot stays the same object until storage changes
ok 37 - the network snapshot stays the same object until storage changes
  ---
  duration_ms: 0.762225
  ...
# Subtest: a view-only wallet derives the same subaddresses as Monero
ok 38 - a view-only wallet derives the same subaddresses as Monero
  ---
  duration_ms: 180.589989
  ...
# Subtest: high indexes match an independent wallet implementation
ok 39 - high indexes match an independent wallet implementation
  ---
  duration_ms: 55.722595
  ...
# Subtest: a view key that does not match the address is refused
ok 40 - a view key that does not match the address is refused
  ---
  duration_ms: 2.629469
  ...
# Subtest: Monero subaddress creation only fills indexes the cached wallet does not have
ok 41 - Monero subaddress creation only fills indexes the cached wallet does not have
  ---
  duration_ms: 5.026358
  ...
# Subtest: a native notice is only a message or a call, and it is not sent without a key
ok 42 - a native notice is only a message or a call, and it is not sent without a key
  ---
  duration_ms: 713.324006
  ...
# Subtest: a relay list marks read and write without sending one conversation everywhere
ok 43 - a relay list marks read and write without sending one conversation everywhere
  ---
  duration_ms: 4.136623
  ...
# Subtest: enqueue identity is the event id, so a second put does not create another row
ok 44 - enqueue identity is the event id, so a second put does not create another row
  ---
  duration_ms: 2.103276
  ...
# Subtest: flush waits for nextRetryAt unless forced, and a reject backs off inside the existing cap
ok 45 - flush waits for nextRetryAt unless forced, and a reject backs off inside the existing cap
  ---
  duration_ms: 2.391377
  ...
# Subtest: a dollar price is not a coin amount
ok 46 - a dollar price is not a coin amount
  ---
  duration_ms: 2.363309
  ...
# Subtest: a payment moves created, address issued, seen, confirmed, and skips nothing
ok 47 - a payment moves created, address issued, seen, confirmed, and skips nothing
  ---
  duration_ms: 1.378385
  ...
# Subtest: the vendor device cannot confirm a payment, and an empty watcher refuses
ok 48 - the vendor device cannot confirm a payment, and an empty watcher refuses
  ---
  duration_ms: 2.400533
  ...
# Subtest: confirmation depth is per currency, and a flag alone cannot confirm
ok 49 - confirmation depth is per currency, and a flag alone cannot confirm
  ---
  duration_ms: 1.29442
  ...
# [payments] Watcher did not answer: Error: offline
#     at fetchImpl (file://<repo>/src/lib/paymentWatch.test.js:59:38)
#     at checkPayment (file://<repo>/src/lib/paymentWatch.js:95:22)
#     at file://<repo>/src/lib/paymentWatch.test.js:54:11
#     at waitForActual (node:assert:519:21)
#     at Function.rejects (node:assert:654:31)
#     at TestContext.<anonymous> (file://<repo>/src/lib/paymentWatch.test.js:53:16)
#     at async Test.run (node:internal/test_runner/test:797:9)
#     at async Test.processPendingSubtests (node:internal/test_runner/test:526:7)
# Subtest: an empty watcher and a public explorer are refused before any request
ok 50 - an empty watcher and a public explorer are refused before any request
  ---
  duration_ms: 4.278009
  ...
# Subtest: a watcher you run can mark seen, then confirmed, and silence is not a success
ok 51 - a watcher you run can mark seen, then confirmed, and silence is not a success
  ---
  duration_ms: 8.035955
  ...
# Subtest: a short payment does not move, and a covering payment does
ok 52 - a short payment does not move, and a covering payment does
  ---
  duration_ms: 3.883586
  ...
# Subtest: wallet transfers become a watcher report, and a miss stays pending
ok 53 - wallet transfers become a watcher report, and a miss stays pending
  ---
  duration_ms: 21.796128
  ...
# Subtest: a stock-node scan of one address becomes a bitcoin report
ok 54 - a stock-node scan of one address becomes a bitcoin report
  ---
  duration_ms: 0.932306
  ...
# Subtest: a privacy read returns the same object until the setting changes
ok 55 - a privacy read returns the same object until the setting changes
  ---
  duration_ms: 2.536278
  ...
# Subtest: an unchanged profile write keeps the same object
ok 56 - an unchanged profile write keeps the same object
  ---
  duration_ms: 64.83298
  ...
# Subtest: scoped storage does not allocate a new value on every read
ok 57 - scoped storage does not allocate a new value on every read
  ---
  duration_ms: 1.685915
  ...
# Subtest: both parties sign the same bytes, and one bad signature fails
ok 58 - both parties sign the same bytes, and one bad signature fails
  ---
  duration_ms: 436.266745
  ...
# Subtest: outcome is the vendor assertion at signing, not a dispute
ok 59 - outcome is the vendor assertion at signing, not a dispute
  ---
  duration_ms: 1.030958
  ...
# Subtest: a bad time or a missing amount does not throw
ok 60 - a bad time or a missing amount does not throw
  ---
  duration_ms: 0.446875
  ...
# Subtest: a self-trade does not verify
ok 61 - a self-trade does not verify
  ---
  duration_ms: 13.587566
  ...
# Subtest: a second ranking of the same views does not verify again
ok 62 - a second ranking of the same views does not verify again
  ---
  duration_ms: 33.249327
  ...
# Subtest: typing, read receipts, and key bundles are not tagged, so they do not buzz
ok 63 - typing, read receipts, and key bundles are not tagged, so they do not buzz
  ---
  duration_ms: 2.479964
  ...
# Subtest: a push notice never carries the message
ok 64 - a push notice never carries the message
  ---
  duration_ms: 2.186508
  ...
# Subtest: no gateway means no request, and a gateway that answers can register
ok 65 - no gateway means no request, and a gateway that answers can register
  ---
  duration_ms: 1.727487
  ...
# Subtest: kind 7 from a second subscription does not double-apply
ok 66 - kind 7 from a second subscription does not double-apply
  ---
  duration_ms: 3.578913
  ...
# Subtest: kind 7 for every joined group is its own filter, not the open chat
ok 67 - kind 7 for every joined group is its own filter, not the open chat
  ---
  duration_ms: 0.975398
  ...
# Subtest: reputation decays, a rug is listed, arbitration moves no money, and credit is between two keys
ok 68 - reputation decays, a rug is listed, arbitration moves no money, and credit is between two keys
  ---
  duration_ms: 5.404843
  ...
# Subtest: current and legacy vaults decrypt, and the wrong PIN does not
ok 69 - current and legacy vaults decrypt, and the wrong PIN does not
  ---
  duration_ms: 1487.597922
  ...
# Subtest: PIN failure counters are per account and do not share the global key
ok 70 - PIN failure counters are per account and do not share the global key
  ---
  duration_ms: 2.740792
  ...
# Subtest: the fifth failure locks that account only, and success clears it
ok 71 - the fifth failure locks that account only, and success clears it
  ---
  duration_ms: 0.718313
  ...
# Subtest: a Bitcoin address uses bc on mainnet and bcrt on regtest
ok 72 - a Bitcoin address uses bc on mainnet and bcrt on regtest
  ---
  duration_ms: 210.336504
  ...
# Subtest: a repeated store read does not build a new reaction key or unread total
ok 73 - a repeated store read does not build a new reaction key or unread total
  ---
  duration_ms: 7.896404
  ...
1..73
# tests 73
# suites 0
# pass 73
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 11154.100111
EXIT=0
```
