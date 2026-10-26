# Stage 2 verification protocol

One locked phone, one real chain, no simulators, no mocks. Nothing on this page
has ever been verified by anyone. Every Result line stays empty until a human
fills it in.

## Rules for every test

- Start each test from a fresh device state: clear the site data, or use a
  device that has never opened the app.
- Before starting, save each account's 12 words somewhere safe. A wrong PIN
  five times deletes the account from that device, and only the 12 words
  bring it back.
- Two things get pasted into Connections before any test can run: a push
  gateway you run (Test 1) and a payment watcher you run (Test 2). The watcher
  URL is printed by `npm run boxes`. Nothing else is optional.
- A test is passed only by the observable result written in it. Not the logs,
  not a status code, not what the app says about itself.
- Record in the Result line: date, device, and what you saw.

## Test 1 — a locked phone buzzes

Proves: the push gateway you run reaches a phone with the screen off, and the
app can register a real subscription without holding the message text.

Setup: phone A installs the app as a PWA and pastes the gateway URL in
Connections. The entry point is `src/lib/pushGateway.js` (`registerWithGateway`);
the toggle lives in Connections.

Steps:
1. Lock phone A and put it screen-down.
2. From account B on another device, send account A a direct message.
3. Watch phone A without touching it for one minute.

Passes when: phone A buzzes on the lock screen with the notice "New message".

Disqualified when: the buzz happens only while unlocked, or the app was opened
by hand before the buzz, or no gateway URL was pasted first.

Result:

## Test 2 — one real-chain order, BTC and then XMR

Proves: the full payment path, watched on the real chain, with nothing skipped.

Setup: vendor account A publishes a menu with one priced item. Buyer account B
has a funded wallet of the chain under test. Paste the watcher URL in
Connections on B's device — it is printed by `npm run boxes`. The entry point
is `src/lib/paymentWatch.js` (`paymentWatchUrl`); the app refuses a public
block explorer as the watcher host.

Steps, run twice — once in BTC, once in XMR:
1. B opens A's direct chat, opens the menu, taps Buy.
2. B pays the shown address from their real wallet.
3. Watch the order page without touching anything else.

Passes when: the order moves created → address_issued → seen → confirmed, in
that order and no other, and the confirmation times are 3 blocks (BTC) or 10
blocks (XMR).

Disqualified when: any state is skipped, the vendor's own wallet is treated as
a confirmation, a public block explorer was contacted, or the amounts do not
match (BTC 8 decimals, XMR 12, rounding half up — no dropped digits).

Result (BTC):

Result (XMR):

## Test 3 — a three-account group gate

Proves: joining is by owner approval, a non-member cannot read group messages,
and a removed member cannot read what comes after removal.

Setup: three accounts on three devices or browser profiles. Account A creates a
group and an invite link. B and C request to join through it. The entry points
are `src/lib/groupJoin.js` (join publishes NIP-29 kind 9021) and the owner's
approval screen in Message Requests; the group key is granted only after
approval (`src/lib/crypto/groupKeyRequest.js`).

Steps:
1. A creates the group and posts one message to it.
2. B and C both request to join from their devices.
3. A approves B and leaves C pending.
4. A posts a second message.
5. A removes B, then posts a third message.

Passes when: B reads the second message only after approval and never the
first; C reads nothing at any point; B cannot read the third message after
removal.

Disqualified when: C sees any group content before approval, or B can still
read after being removed.

Result:

## Test 4 — one photo upload to its real host

Proves: photos travel through the real media host as encrypted files, arrive
readable, and arrive without their metadata.

Setup: accounts A and B in a direct chat. Take a photo with GPS and camera
metadata on phone A (a phone camera shot, not a screenshot). The entry point is
`src/features/chat/useComposer.js` line 212 (`uploadPrivateMedia`); the hosts
it uses are Blossom (blossom.primal.net, nostr.build, blossom.band).

Steps:
1. A sends the photo to B in the chat.
2. B taps it and views it on their device.
3. B saves the received file and opens its properties on a computer.

Passes when: the photo arrives encrypted in transit (the host stores an
encrypted file, not the image), B views the actual image, and the file's
properties show no GPS coordinates and no camera model.

Disqualified when: the host received the image in plain text, B sees only a
broken thumbnail, or any GPS or camera metadata survives in the saved file.

Result:

## What each test has behind it today

| Test | Screen | Code |
|---|---|---|
| 1 | Connections (paste gateway), lock the phone | `src/lib/pushGateway.js`, `src/lib/nativePushSend.js` |
| 2 | Shop → Buy, order page, Connections (paste watcher) | `src/lib/paymentWatch.js`, `src/lib/vendorPayments.js` |
| 3 | Group invite link, Message Requests (approve), group info (remove) | `src/lib/groupJoin.js`, `src/lib/crypto/groupKeyRequest.js`, `src/components/chat/MessageRequests.jsx` |
| 4 | Chat composer (photo), tap to view | `src/features/chat/useComposer.js`, `src/lib/mediaCrypto.js`, `src/lib/imageCompression.js` |

All four entry points exist in the app today. Nothing on this page is a
product gap; every gap that shows up will be a broken run, not a missing
screen.
