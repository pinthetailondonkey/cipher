# Cipher — Vision and Agent Brief

## 0. How to use this file
- Part 1 is the pitch. Read it for intent, not requirements.
- Part 2 is what Cipher is, plainly.
- Part 3 is hard invariants. Never break these. If a task seems to require breaking one, stop and say so.
- Part 4 is what exists today vs what does not. Treat "not built" as new work, never as a bug.
- Part 5 is out of scope for now. Do not build it unless the task says so.

## 1. The pitch (intent, not spec)
Cipher is an encrypted messenger and direct-deal shop for people who cannot afford to be shut down. No phone number, no central account, no platform fees. It replaces a centralised chat app plus a marketplace with one app on an open protocol.

## 2. What Cipher is, plainly
- A messenger. Encrypted end to end. Identity is a handle and a PIN; the user never handles a key.
- A shop. Buyers pay vendors directly in BTC or Monero. Cipher never touches the money.
- Groups are storefronts. A group has a chat and a catalogue.
- Trust is social, not escrowed. Group owners vouch for vendors; reputation travels with the vendor.

## 3. Hard invariants (must always hold)
1. No phone number and no email required.
2. DMs are always NIP-44 encrypted.
3. Group messages use rotating AES-GCM keys. Removing a member rotates the key so they cannot read later messages.
4. Every order generates a fresh payment address. No address reuse.
5. Photos have EXIF/GPS stripped before sending.
6. Cipher never holds funds. Zero custody.
7. No central server required: the app works against more than one relay.
8. The UI never shows the words "Nostr", "relay", or "private key".

## 4. Reality check (verify and correct this section against the repo)
Verified against the code at a41ef22. "Not built" here is new work, never a bug.
- Built:
  - Identity and device: handle + PIN account creation with relay precheck; PIN
    unlock with five-wipe vault lockout; passkey / biometric unlock; restore by
    handle+PIN and by 12-word phrase; multiple accounts (add/switch/remove);
    backup screen (secret key + phrase); panic wipe and shake-to-wipe; history
    encrypted at rest.
  - Messenger: NIP-44 DMs with outbox write-ahead, retry and flush; NIP-65 dm
    relays; typing indicators; read receipts; reactions (withdrawal via a
    kind-5 delete); message editing and forwarding; bookmarks with
    jump-to-message; mute with durations, archive; disappearing messages per
    chat incl. groups; safety numbers; block list and privacy screen;
    people/group search; message requests; in-app buzz on DM/order/group
    mention; QR camera that opens a scanned profile; command palette; optional
    link previews; photos re-encoded on send (EXIF stripped) and voice notes;
    media encrypted before the media host.
  - Groups: create/join/chat; rotating AES-GCM group keys (kick/leave rotates
    the epoch); join-approval gate (9021) with Approve/Deny; key distribution
    of every missing epoch; group pin; member reviews and vouches.
  - Shop: buyer pays vendor directly in BTC or Monero with a fresh address per
    order; order lifecycle created → address_issued → seen → confirmed; order
    ledger; countersigned receipts; vendor mode with a real menu of products,
    prices and a share link + QR; proof-of-trade receipts; the vault.
  - Dead-drop burn notes: fragment-carried key, "really gone" one-read host
    (one-read carrier, `scripts/note-carrier.mjs`) when the burn-note host
    answers; relay one-open fallback when it does not.
  - Shell: one app, dark + paper themes; phone-side drawer and desktop rail;
    chat rows with avatar/name/time/unread + mute/archive; DESIGN.md as the
    visual system of record (tokens, type scale, geometry).
- Not built (against docs/BACKLOG, not a bug):
  - Escrow 2-of-2 (5% total at successful release) and the escrow
    FSM/script/PSBT/membrane wiring.
  - Proof-of-trade v2; dispute-free / "math refunds you" board.
  - Free Telegram-premium personalization: sticker packs, custom emoji
    reactions, per-chat themes/wallpapers, emoji status, chat folders, search
    inside a chat, forwarded drafts.
  - Remaining speed-and-feel work: no-JS loading shell, service-worker dedupe
    of the cache-buster, notification ticker, twirling refresh.
  - The remaining "every wired engine gets a door" audit items (receipt
    inspection door, product share-link open, QR acting on group/chat/naddr,
    message edit history, mute-duration submenu, watcher/gateway paste doors)
    beyond what the audit already discharged.
  - Buyer and vendor seeing the same beats on the order card; vendor key-change
    verification before first payment; the Monero 1-piconero unit guard.
  - On-hardware walkthrough for the merged tor/tails drills.
Do not assume. If unsure, check the code, then update this section in the same commit.

## 5. Out of scope for now
- Pin-slot auctions and paid "verified" badges
- Global web-of-trust scoring
- Native mobile apps (this is a web app)

## 6. Words used
- "custies" = buyers
- "trap house" = a group's storefront
- "WoT" = web of trust, a reputation system
- "relay" = an open server that stores and forwards messages
