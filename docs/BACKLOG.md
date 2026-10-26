# Backlog
One branch, one done-when per item. Take the top unfinished one.
Read docs/VISION.md before starting any item.
Owners' view after the founder's 2026-10-26 board (score today: 4/10; reachable when the board lands: 9/10 — "dispute-free, or math refunds you"): design-lane (6, 9, 10) plus the UI doors in 7 stay with this session; escrow spec, show-proof beats, PoT v2 and membrane wiring belong to the Breakthrough lane; tor/tailes drills stay with the tails lane (feat/tor-tails is MERGED, on-hardware walkthrough still owed).
Escrow is founder-locked (docs/ESCROW.md on feat/escrow-2of2 @ fa0e546): 5% total = 2.5% buyer + 2.5% vendor, charged once at successful release only; everything rides the order card, no new screens; whale-order fee cap stays a constant the founder flips, nothing hardcoded. Build order, all six the Breakthrough lane's: escrow-fsm → escrow-script → escrow-membrane → escrow-psbt → escrow-ui → re-attack round.

## 14. Two-sided UI: one app, dark + paper + drawer — DONE (c15951c, 714d5b9, de1ae20, 899024c, 057ae45, 9fbcec1, f429e59, eb46fb0, ba94bc6)
Done when:
- Theme tokens (DONE c15951c): every white/black literal rides ink/scrim, glass/hover/shadow tokens live per theme in src/index.css, Paper (light) joins vault/lobby/chromerooms, dark stays default.
- Phone (< md) shell is a side drawer (DONE 714d5b9): profile card up top, then Chats · Menus · Orders · Groups with badges, Connections and Lock now; the desktop left rail stands at md+; drawer < md, rail >= md; same tokens both sides.
- Chat list rows (DONE de1ae20): avatar, name, time, unread count, last message; the preview is privacy-blurred until the row is long-pressed (reveal just that row until you leave the list). Mute and archive buttons live on each row via the kebab; archived chats sit under their own heading.
- Orders ledger (DONE 899024c): one timeline, newest first, state read from the same derived facts the order card reads, ✓ marks a countersigned receipt this device verified; rows open the vendor's thread, which holds the detail view.
- The doors (DONE de1ae20, 057ae45, 9fbcec1): mute and archive on chat rows; the group header's disappearing-timer button (the send path already stamped group timers); Profile's Order settings screen holds the preferred-payment choice, the confirmation-count fields (BTC 3 / XMR 10 defaults kept) and the auto-vouch toggle; the bell shows its unread number; DM bubbles show avatars like groups do.
- The two honesty bugs die (DONE f429e59, eb46fb0): privacy.groups now denies join requests durably through the 9021 gate (the hint matches the engine); the call-relay hint names the Connections Advanced panel, where the control actually lives.
- Dead code removed in its own cleanup commit (DONE ba94bc6, corrected scope): unreachable publicViewChecks, dead client notificationFromPush (the worker carries the banner copy), and the unused chat-pin pair. Re-verified before cutting: the rest of the audit's "verify trio" is alive through rankVolumeByStanding, and nip65.partitionWriteRelay has an internal caller — both kept.

## 1. One-command install for both boxes — DONE (1752f6f)
Done when: from a clean clone, `npm run boxes` prints a watcher URL, and a wrong Node version fails naming it.

## 2. Encrypt message history at rest — DONE (7e2f1d4)
Done when:
- New message rows are stored encrypted using the EXISTING vault key. No new key material, no new dependency. AES-GCM, same family as group messages.
- Rows written before this change stay readable, and a reload shows old plaintext rows and new encrypted rows together in the same thread.
- A test asserts the stored bytes for a new row do not contain the plaintext.
- With the vault locked, history still renders without crashing.

Constraints:
- Do not touch DM crypto (NIP-44), group AAD, or the outbox.
- State in the commit: what happens to history if the vault key is lost.
- State in the commit: whether content search still works.

## 3. Extend the UI harness to every screen — DONE (147ec14)
Done when: the tap-target and clipping assertions run per tab, not just home.

## 4. README Vercel section — DONE (991cdd0)
Done when: the three stale claims are corrected.

## 5. Proof-of-trade v2 — STARTED
Done when: the implementation matches the spec (docs/proof-of-trade.md v2).
The spec is written; implementation is a separate item.

## 6. Custom theme: modern / serious / iOS / trap-street hustle
Done when: one token file (radius, shadow, surface levels) in src/index.css defines the whole geometry; every heavy card surface uses it; the `shadow-2xl backdrop-blur-2xl` stamp appears only where a sheet truly floats; message bubbles use the bubble radius, not a card radius; the tab bar badge is icon-anchored; empty states are py-8/py-10, never py-16. Glass (backdrop-blur) stays everywhere. Same colors. Founder's four words: modern, serious, iOS, trap-street hustle. (Token colors landed c15951c; geometry pass still owed.)
Known bulk spots (audit, 2026-10-26): Wallet.jsx 13 heavy cards, LockScreen.jsx 9, dead Connections.jsx 6 (STILL says unreachable — stale: Connections mounts from Wallet.jsx and is reachable), VendorStorefront/VendorDashboard/GroupView/GroupInfoSidebar 5 each; FloatingMenu has `shadow-2xl` twice on one element (3 lines); nested card-in-card: OrderReceipt in MessageBubble, Avatar fallback inside cards.
Also in this pass: when previews are ON, a message that is ONLY a URL should not also render the raw link text (double render); links should not trigger the bubble's long-press menu; chat list rows px-3 py-2.5 with h-10 avatars.

## 7. Close the garage: built features with no way in
Done when every built-but-unreachable feature has a door in the UI:
- Mute, pin-chat, archive, disappearing timer toggles in the chat header (src/store/chatStore.js has them all; no screen calls them). Persist through scoped storage so a history fetch cannot resurrect them.
- Product share link (?product=&vendor=) opens that product card. Today the app ignores the params.
- QR scanner acts on what it scans (open group, open chat). Today the result only copies to clipboard.
- Vendor dashboard shows the vendor's actual products. Today it reads a key nothing writes and always says "you haven't published any products".
- In-app buzz (haptics) already test-covered; ship it for t=msg, t=order, t=call per CLAUDE.md.

## 8. Vendor shop meshed into the menu page
Done when: a channel-type space (a menu) owned by a vendor shows their shop: items, prices, sold-out state, banner, about — inside the menu page; "add to menu" from the vendor's chat; one share link and one QR for the whole shop; Discover's Menus section opens it. VendorStorefront.jsx and VendorDashboard.jsx both point at the same real product key. Founder's line: "menus are vendor shops" — a menu IS the shop, not a link to one.

## 9. Free Telegram-premium: personalization
Done when, all free, no tiers:
- Sticker packs: send in DM and groups, custom emoji reactions, pack picker from any installed pack.
- Per-chat themes and wallpapers, persisting in scoped storage across reload and account switch.
- Emoji status as a public profile field.
- Chat folders, search inside a chat, forwarded messages, drafts.
Trap flavor per docs/VOICE.md: slang in copy only (plug, custy, trap, packs); never on buttons or labels; no emoji in UI copy.

## 10. Speed and feel
Done when:
- index.html carries an inline no-JS loading shell (logo + "Loading Cipher…") so slow links see progress instead of a black void; modulepreload hints for the dependency chunks; service worker dedupes the ?_ship cache-buster (public/sw.js strips the query before caches.match). Perf agent measured 45s on EDGE links caused by a serial chunk waterfall + no feedback.
- Group/menu creation completes visibly fast; the join-approval gate is not the bottleneck (measure before and after).
- Notification bell gets an unread ticker; saved-messages modal becomes a dropdown; refresh button twirls and actually reloads.

## 11. Money trust before scale
Done when:
- The Monero piconero unit guard lands: a float is never a coin amount; round half up, 12 decimals; test crossing watcher→app with a 1-piconero value.
- The buyer's order card shows the same beats the vendor sees: created, address_issued, seen, confirmed — nothing skips.
- Vendor key verification before first payment: a changed vendor key warns on the order card, never silently passes.
- Refund flow per docs/proof-of-trade.md v2: a refunded receipt is a NEW signed receipt, never an edit.

## 12. Account screens polish
Done when:
- Restore screen: PIN field renders (DONE 0c71d11), plus optional confirm-PIN field on restore.
- Accounts screen: add/remove accounts (DONE a719ff5).
- Lock row wording: Face ID / fingerprint (DONE c41dab3).
- Save_key mode's vestigial PIN field removed or wired (audit NIT-3).

## 13. Docs catch-up
Done when: README names the canonical host (shipstatic) not stale Vercel; the watcher instructions do not reference the removed Connections row; STAGE2's "Test 3 approval screen does not exist" line is corrected (the gate merged at 3a2e57b); docs/VISION.md section 4's built/not-built lists get filled.
