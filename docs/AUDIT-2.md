# Cipher audit, pass 2: the whole app except payments and push

Audited at **`64d5e4bf686616ef4448ce9aeb2493a2268e2226`**, which is `main` after PR #32 was merged. Every read is `git show 64d5e4b:<path>`. Line numbers refer to that SHA.

Out of scope, because pass 1 covered it: the payment watcher and amount guard, payment state, receipts, proof-of-trade, public views, ranking, the push gateway, native send, the service worker push handler, t= tags, and the two sweeps.

Tags: **CONFIRMED** means I read the live path, and where noted I ran it. **SUSPECTED** means I read the code, but the conclusion depends on runtime behavior I did not exercise.

Findings are written per area as the audit goes. The verdict table, ranking, calibration and scores come at the end.

---

## Area 1: identity and vault

Read in full: `src/main.jsx`, `src/App.jsx`, `src/AuthenticatedApp.jsx`, `src/useIdentity.js` (811 lines), `src/lib/vaultLockout.js`, `src/hooks/usePanicWipe.js`, `src/LockScreen.jsx` (1-200), `src/Wallet.jsx` (556), `src/components/chat/AccountSwitcher.jsx`, `src/components/chat/IdentityBackup.jsx`, `src/lib/storage.js`, `src/store/chatStore.js` (411).

### I1. CONFIRMED, High: two unlock paths skip the PIN lockout
`unlock()` counts failures (`useIdentity.js:426`). Two other paths that decrypt the same vault with a PIN do not:
- `switchAccount()` (`useIdentity.js:743-769`): a wrong PIN returns `{ success: false }` and never calls `recordPinFailure`. Reachable from Profile → Accounts (`AccountSwitcher.jsx:18`).
- `restoreFromRelays()` (`useIdentity.js:517-574`): despite the name, this is a local handle + PIN unlock. It never calls `recordPinFailure`. Reachable from the lock screen's restore mode (`LockScreen.jsx:120-122`).

Either path allows unlimited online PIN guesses against any saved account, so the 5-try lockout is decorative. A 6-digit PIN (`vaultLockout.js:2`) is 10^6 guesses.

**Fix:** route both through the same failure counter, keyed by the target pubkey, and run the same lockout wipe on the fifth failure. **Done when:** five wrong PINs on Accounts → Switch, or on lock-screen restore, lock out that account. A test drives both paths.

### I2. CONFIRMED, High: lockout and "remove account" delete the vault entry and leave the account's data
A lockout (`useIdentity.js:427-447`) deletes `cipher_vaults[pk]`, the legacy vault, `cipher_active_pubkey`, and the failure counter. It does **not** delete:
- that account's IndexedDB `CipherDB_v7_<pk16>`, which holds every message in plaintext, group keys, the outbox, and grants;
- its scoped localStorage `cipher_<pk8>_*`: receipts, bookmarks, blocked list, drafts, encrypted vendor keys, public views;
- its passkey identity `cipher_passkey_<pk>`.

So after "the next lockout deletes this account from this device" (`vaultLockout.js:28`), the whole message history is still on disk. And if a passkey was set up, `unlockWithBiometric` (`useIdentity.js:453-487`) recreates the vault with a new PIN, which is a full lockout bypass. `removeAccount` (`useIdentity.js:794-804`) has the same gap.

**Fix:** a per-account wipe helper that deletes that account's database, its scoped keys, and its passkey storage. Use it from lockout and from `removeAccount`. **Done when:** after a lockout, `indexedDB.databases()` has no `CipherDB_v7_<pk16>`, no `cipher_<pk8>_` key remains, and passkey unlock for that account fails. Other accounts are untouched.

### I3. CONFIRMED, High (design): message history and group keys are not encrypted at rest
The PIN encrypts only the secret key (`useIdentity.js:53-67`). Dexie stores DM and group plaintext (`rawContent`, `data`) and raw group key bytes (`db.js` tables `messages` and `groupKeys`) unencrypted. Anyone with the browser profile reads every conversation without the PIN. The lock screen gates the UI, not the data.

**Fix (design):** encrypt message rows and group keys under a key derived from the vault secret, or say plainly in the app that history is stored unencrypted. Not in this pass's fix budget.

### I4. CONFIRMED, Medium: the raw secret key sits in sessionStorage
`cipher_session_sk` holds the secret key as a plain JSON byte array (`useIdentity.js:379, 421, 480, 564, 604, 757`). It is read back on load (`:248-258`). It survives reloads for the life of the tab, and in an installed PWA that can be days. Any script injection reads it.

**Fix (design):** hold the key in memory only, and re-prompt for the PIN or passkey on reload, or wrap it under a non-extractable WebCrypto key kept in IndexedDB. Not in this pass's fix budget.

### I5. CONFIRMED, Medium (interop): the phrase is BIP39, but the key is not NIP-06
`deriveSkFromMnemonic` takes the first 32 bytes of the BIP39 seed (`useIdentity.js:6-10`). NIP-06 derives `m/44'/1237'/0'/0/0`. A Cipher phrase entered in any other Nostr client gives a different key. "Identity is a BIP39 seed" is literally true, but the phrase is not portable.

**Fix (design):** the derivation cannot change without migrating every account. Document it, or offer NIP-06 for new accounts and keep the old path for restores.

### I6. CONFIRMED, Medium: the shake-to-wipe trigger cannot be turned on
`usePanicWipe` runs only when `panicWipeEnabled` is true (`App.jsx:35-36`, `usePanicWipe.js:10`). The setter `setPanicWipeEnabled` (`chatStore.js:377`) is pulled into `Wallet.jsx:39` and never called, and no other file calls it. The shake path is unreachable.

The manual "Panic wipe" button is reachable (`Wallet.jsx:526-549`) and calls `identity.panicWipe` (`useIdentity.js:645-716`). That deletes every account's database, unregisters service workers, clears caches, and clears both storages.

**Fix:** wire a toggle on the Privacy screen, or delete `usePanicWipe.js` and the store flag. **Done when:** whichever was chosen; no third state.

### I7. CONFIRMED, Medium: payment addresses leak across accounts through global keys
`Wallet.jsx:60-61` and `useCommerce.js:62-63` fall back to global `cipher_btc_address`, `cipher_btc`, `cipher_xmr_address`, `cipher_xmr`. Every save writes those global keys too (`Wallet.jsx:103-106, 163-164, 225-226, 239-242`). Account B, with no address of its own, shows account A's address and **hands it to buyers** when accepting an order. The money goes to the wrong account's wallet, and the two identities are linked by a shared address. `migrateGlobalKeys` (`storage.js:88`), which would move global keys into scoped ones, is never called (pass-1 dead-export sweep, bucket A).

**Fix:** read and write scoped keys only, and remove the global fallbacks. Run `migrateGlobalKeys` once at unlock, or delete it. **Done when:** account B shows no address that account A saved, and a test proves the fallback is gone.

### I8. SUSPECTED, Medium: a new account's store starts with the previous account's settings
The store reads scoped keys once, at module load (`chatStore.js:103-372`). `scopeKey` falls back to `cipher_db_owner` when `cipher_active_pubkey` is unset (`storage.js:41-46`). `addNewAccount` removes `cipher_active_pubkey` and reloads (`useIdentity.js:789-791`), so the store loads under the previous owner's scope: their blocked list, muted chats, vendor flag and unread counts. `createVault` then sets the new active pubkey without a reload, and nothing calls `reload()` (`chatStore.js:389`).

**Fix:** after create, restore or switch, call `useChatStore.getState().reload()` or reload the page. **Done when:** a new account starts with an empty blocked list and buyer mode.

### I9. CONFIRMED, Low: usernames are not unique
The availability check is hard-coded off (`LockScreen.jsx:94`, `const available = true; // BYPASSED`). Two accounts can claim the same `@handle`, and the kind-10003 registry has no owner. Restore-by-handle takes the first local vault that matches (`useIdentity.js:523-529`).

**Fix:** fix or delete `checkUsernameAvailable` (`LockScreen.jsx:59-76`, unused per lint), and say in the UI that handles are not unique.

### I10. CONFIRMED, Low: two Wallet views are unreachable, and the dashboard reads a key nothing writes
- `view === 'edit_profile'` (`Wallet.jsx:326`) and `view === 'payments'` (`Wallet.jsx:416`) are rendered, but nothing calls `setView` with either.
- `VendorDashboard` gets its products from `localStorage['cipher_my_products']` (`Wallet.jsx:272`). Nothing writes that key. `publishProduct` writes `cipher_cached_products` (`Wallet.jsx:212-213`), which nothing reads. The store's scoped `my_products` (`chatStore.js:362`) is a third copy.
- So the dashboard always says "You haven't published any products yet".

**Fix:** delete the two dead views. Point the dashboard and `publishProduct` at the scoped `my_products`.

### I11. CONFIRMED, Low: Publish to Store reports success without an acknowledgement
`publishProduct` races the publish against a 3-second timer and then always says "Product Published!" (`Wallet.jsx:208-215`).

**Fix:** require at least one fulfilled publish, like `ProfileEditor` does.

### Area 1: what is true
- PBKDF2-SHA256 at 600k iterations with a per-vault salt, and legacy vaults upgraded on unlock (`useIdentity.js:36-78, 407-419`). Tested by `vaultCrypto.test.js`.
- Lockout counters are per account (`vaultLockout.js:4-6`), and the lockout deletes only the active account's vault entry, leaving other accounts' vaults. Tested by `vaultLockout.test.js`, but the tests cover the counter, not I1 or I2.
- Manual panic wipe deletes every `CipherDB_v7_*` database it can enumerate or derive from the vault list, unregisters service workers, clears caches and both storages, then reloads (`useIdentity.js:645-716`). Nothing in the repo tests it.
- The secret key and the phrase are shown only on demand; download needs an explicit checkbox (`IdentityBackup.jsx:60-101, 157-161`).

---

## Area 2: groups

Read: `src/features/chat/useGroupDirectory.js`, `src/Discover.jsx` (1-100), `src/components/chat/GroupInfoSidebar.jsx`, `src/lib/myGroups.js`, the join and group parts of `src/features/chat/useChatBootstrap.js`, `src/components/chat/GroupView.jsx` (grep), and `src/hooks/useNIP29Group.js`, which was read in full in pass 1 and is unchanged since.

### G1. CONFIRMED, High: invite links to app-made groups send a join request that nothing can approve
The invite link is `?g=<id>` (`GroupInfoSidebar.jsx:67`). On open, `useChatBootstrap.js:519-526` looks up the group's kind-9002 author. If the author is someone else, it calls `requestToJoinGroup` (`useGroupDirectory.js:50-60`), which DMs the creator a `{ type: 'join_request' }` and tells the user "You will be notified when approved."

No code handles `join_request` on the receiving side: the only match in `src/` is the sender. There is no approve button, and `removeJoinRequest` has no caller. Every group made in this app publishes a 9002 (`useNIP29Group.js:481-486`), so its invite link dead-ends. The groups are created `open` (`useNIP29Group.js:467`), so the request was never needed.

**Fix:** invite links join directly through `joinGroupById`, and `requestToJoinGroup` is deleted. **Done when:** opening `?g=<id>` for an open group publishes kind 9021 and opens the chat, and no code sends `join_request`.

### G2. CONFIRMED, High: joining from Discover never publishes a NIP-29 join
`Discover.join` (`Discover.jsx:69-89`) writes the group to the local list and opens it. It never calls `publishGroupJoin`, which `joinGroupById` does (`useGroupDirectory.js:78`). The relay never sees a kind 9021. Key grants check membership (`useNIP29Group.js:893-904`), so the new member stays at "Securing…" and cannot read or post.

**Fix:** Discover joins through the same `joinGroupById`. **Done when:** a Discover join publishes kind 9021.

### G3. CONFIRMED, Medium: Discover lists only your own groups once you have one
`Discover.jsx:56-58`: if the store holds any groups, those are listed, and those are the groups you are already in. The relay query runs only when you have none. After your first join, Discover can no longer discover anything.

**Fix:** always query the relay, and mark the groups you are in. Left as a note.

### G4. CONFIRMED, Low: group admin sends ignore relay results
Pass-1 M8 still applies: kick, promote, add, settings, leave and create ignore `allSettled` (`useNIP29Group.js:486, 492, 558, 663, 675, 686, 713`). Note only.

### Area 2: what is true
- Per-epoch group keys, with rotation on kick and leave (`useNIP29Group.js:536-568, 640-666`) and AES-GCM with AAD (`groupCipher.js`). Covered by `groupCipher.test.js` and `groupKeyMember.test.js`; none of those tests run a relay.
- Membership snapshots (39002) are accepted only from the relay key (`useNIP29Group.js:788-797`).
- The outbox watcher is ref-counted and flushes are deduplicated per pubkey (`outbox.js:80-81, 131-173`). A second `useNIP29Group` instance in `GroupView.jsx:130` does not double-send.

---

## Area 3: DMs

Read: `src/Chat.jsx`, `src/features/chat/ChatHome.jsx`, `src/components/chat/ChatList.jsx`, `src/components/chat/ChatHeader.jsx`, `src/components/chat/DmView.jsx`, `src/features/chat/useMessageCommands.js`, `src/features/chat/ChatOverlays.jsx`, `src/components/chat/FloatingMenu.jsx`, `src/components/MessageInput.jsx`, `src/features/chat/useChatBootstrap.js` (all), and `src/hooks/useNIP44DM.js` from pass 1.

### D1. CONFIRMED, Critical: switching accounts erases the target account's messages
`useChatBootstrap.js:487-499`: when the signed-in pubkey differs from `localStorage.cipher_last_user`, it runs `db.messages.clear()` and `db.chatReads.clear()`, and resets unread counts. Each account has its own database (`db.js:37`). This hook opened the new account's database at line 121, in an effect declared earlier, so React runs it first. The clear therefore hits **the account being switched to**.

Every switch back to an account deletes its local history. Relays refill what they still hold. Local-only data is gone: the vendor order patches from PR #32 (`localPatch`), delivery states, and anything a relay dropped.

**Fix:** delete the effect. Per-account databases make it obsolete. **Done when:** switching A → B → A leaves A's message rows in place.

### D2. CONFIRMED, High: blocking has no way in
`toggleBlockUser` is called only by the Unblock button (`PrivacySettings.jsx:83`). The ingest filters honor the list (`useNIP44DM.js:150-151, 265-266`, `useNIP29Group.js:884-885`), but no screen can add anyone to it.

**Fix:** add Block to the profile sheet. **Done when:** blocking from a profile hides that person's new DMs, and they appear in Privacy → Blocked.

### D3. CONFIRMED, High: Forward does nothing
The bubble menu offers Forward (`MessageBubble.jsx:161`). It stores `forwardingMsg` (`useMessageCommands.js:104-108`), and nothing reads it: no picker exists, and `handleForwardSubmit` is passed into `threadProps` (`Chat.jsx:126`) and used by neither view. `handleBulkForward` and `handleBulkDelete` are returned and never used. The Forwarding privacy toggle (`PrivacySettings.jsx:72`) only sets `noforward` on outgoing messages (`useComposer.js:63`), and the only reader of that flag is the dead forward path.

**Fix:** delete Forward, its handlers, and the toggle. **Done when:** the menu has no Forward, and `forwardingMsg` is gone from the store.

### D4. CONFIRMED, Medium: edit is local only, and deleted messages come back
- Edit (`useMessageCommands.js:126-144`) rewrites the local row and sends nothing. The other side never sees the edit.
- Delete removes the row and, for your own message, publishes a kind 5. On the next `fetchChats`, the deleted set is rebuilt from `{ kinds:[5], limit:100 }` with no author filter (`useChatBootstrap.js:273`), which is the last 100 deletions by anyone on the relay. Your older deletions fall out of that window, and `fetchDMs` re-saves the message.
- A deleted received message is not tracked at all, so it returns on the next fetch.

**Fix:** filter kind 5 by `authors:[me]`, and keep a local tombstone list. Note only.

### D5. CONFIRMED, Medium: archive, pin chat, mute and disappearing timers have no way in
The store defines them. Readers exist for mute (`useNIP44DM.js:31-37`, `useNIP29Group.js:354-360`) and timers (`useComposer.js:52-63`, `useChatBootstrap.js:445-485`). No screen calls `toggleArchiveChat`, `togglePinChat`, `setMuteDuration`, `toggleMuteChat` or `setDisappearingTimer`. 19 of the store's 80 actions have no caller outside the store.

**Fix:** wire or delete. Note only; this is beyond the commit budget.

### D6. CONFIRMED, Low: "Report" in message actions shows a success toast and does nothing
`useMessageCommands.js:191-194`. No UI emits it today, which makes it dead too. Deleted with D3.

### Area 3: what is true
- Every DM payload, including typing and read receipts, goes through `nip44.v2.encrypt` (`useNIP44DM.js:65-66, 109-110`).
- Read receipts and typing honor the Privacy toggles (`useChatBootstrap.js:388, 409`, `privacy.js:48-51`).
- Dedupe by event id (`useNIP44DM.js:232`) and by `clientId` against the optimistic row (`:211-215`).

---

## Area 4: media

Read: `src/lib/imageCompression.js`, `src/lib/media.js`, `src/features/chat/media.js`, `src/components/ui/Picture.jsx`, `src/features/chat/useComposer.js` (upload and recording), and every `uploadToBlossom` and `compressImage` call site.

### M1. CONFIRMED, High (design): DM and group photos and voice notes are public files tied to the sender's key
`useComposer.js:188-192` and `:221` upload the file **unencrypted** to public Blossom hosts. Only the URL travels inside the encrypted DM or group message. The Blossom upload is authorized by an event signed with the sender's key, so the host holds the plaintext image or recording linked to that pubkey. Anyone who learns the URL, which is the content hash, can fetch it.

"Your messages stay private" (`DmView.jsx:30`) is false for every attachment.

**Fix:** encrypt with AES-GCM under a fresh random key before upload, send `{ url, key, iv, mime }` inside the encrypted message, and decrypt on display. No new dependency (WebCrypto). **Done when:** the uploaded blob does not decode as an image, and a peer still sees it.

### Area 4: what is true
- **EXIF stripping is True.** All three image upload paths re-encode through a canvas to JPEG, which carries no EXIF: avatar at onboarding (`LockScreen.jsx:142`), avatar and product (`Wallet.jsx:124`), chat (`useComposer.js:189`, `imageCompression.js:9-37`). Orientation is applied before drawing (`imageOrientation: 'from-image'`). Not run in a browser.
- Voice notes are not processed. A MediaRecorder webm carries little metadata.
- `stripImageMetadata` (`media.js:4`) is a dead duplicate (pass-1 sweep, bucket A).

---

## Area 5: calls

Read: `src/lib/voiceCall.js` (277), `src/components/chat/CallOverlay.jsx` (1-40), and the call path in `useNIP44DM.js`.

### C1. CONFIRMED, High: old call offers ring again on every launch
The live DM subscription asks for seven days of history (`useChatBootstrap.js:360-362`). The live handler passes every `type: 'call'` event to `handleCallSignal` (`useNIP44DM.js:159-163`) with no age check. `seenEvents` is in memory only (`voiceCall.js:9, 225-229`).

On each launch, the newest replayed offer rings (`voiceCall.js:239-257`), and each further old offer gets an automatic `busy` signal sent back to its caller (`:245-247`), which buzzes the caller via t=call. Whether a replayed hangup cancels the ring depends on the order the relay returns events.

**Fix:** drop call signals whose event `created_at` is more than 60 seconds old. **Done when:** a test feeds an old offer and it does not ring.

### C2. CONFIRMED, Low: no ring timeout
An unanswered outgoing call stays at "Calling…" until hangup. Note only.

### Area 5: what is true
- The Calls privacy toggle is honored: "Nobody" auto-rejects with `reason: 'privacy'` (`voiceCall.js:241-243`).
- ICE comes from the egress list, and with no route the call refuses to start instead of leaking (`voiceCall.js:53-56`).
- Early ICE candidates are held until the remote description is set (`voiceCall.js:101-123`).

---

## Area 6: privacy

Read: `src/lib/privacy.js`, `src/components/chat/PrivacySettings.jsx`, `src/components/chat/Connections.jsx`, `src/lib/relays.js`, `src/lib/pool.js`, `src/components/chat/LinkPreview.jsx` (1-45), and `src/lib/egress.js` from pass 1.

### What each Privacy control actually changes
| Control | Effect in code | Verdict |
|---|---|---|
| Calls: Everyone/Nobody | Nobody auto-rejects incoming offers (`voiceCall.js:241`) | Works |
| Last seen | The app publishes no last-seen data. Its only effect is that Nobody turns typing off (`privacy.js:50`) | Misleading |
| Profile photo: Nobody | Honored by `ProfileEditor.jsx:45`. Ignored by the Profile-tab avatar upload, which auto-publishes (`Wallet.jsx:136-138, 168-176`), and by onboarding (`LockScreen.jsx:191-195`) | Partial |
| Groups: Nobody | Read nowhere in `src/` | Does nothing |
| Read receipts | Gates the read event (`useChatBootstrap.js:409`) | Works |
| Typing | Gates typing events (`useChatBootstrap.js:388, 399`) | Works |
| Forwarding | Sets `noforward`, read only by the dead forward path (D3) | Does nothing |
| Blocked list | Unblock works; Block has no way in (D2) | Half |

### P1. CONFIRMED, High: link previews send every URL in your chats to microlink.io by default
Any message with a URL renders a `LinkPreview` (`MessageBubble.jsx:243`), which fetches `api.microlink.io/?url=<link>` (`LinkPreview.jsx:28-34`, `egress.js:17`). That includes links others send you. It is on unless the user finds Connections → Advanced and types `off`.

**Fix:** a Link previews toggle on the Privacy screen, off by default. **Done when:** with defaults, opening a chat with a link makes no request to microlink.

### P2. CONFIRMED, Medium: search sends your query, signed by your key, to the group relay, and two listed search relays are never used
- Free-text people search publishes a signed kind-5315 DVM request containing the query to `groupOnlyRelays` (`usePeopleSearch.js:244-253`). It then ignores the answer (`if (false && …)`, `:260`).
- NIP-50 search also goes to the group relay (`:281-285`).
- The Connections rows "Search relay … sees your IP and the text you search" (`egress.js:11-12`) are never contacted: `searchRelays` (`relays.js:10`) has no reader (pass-1 sweep, bucket C).

**Fix:** delete the DVM block, and point NIP-50 at `searchRelays`. **Done when:** a search publishes no event, and queries go only to the search rows.

### Area 6: what is true
- **Onion per row is True.** No product file hard-codes a host outside `egress.js` (grep at 64d5e4b found none). Every relay set, the media hosts, link preview, STUN and TURN, the watcher and push are read through `activeUrl` and `urlsFor`. A pasted onion replaces only its row (`egress.js:143-148, 178-189`), and Connections warns when an HTTPS page will block a plain onion socket (`Connections.jsx:15-20, 49-51`).
- Exceptions the app cannot route: NIP-05 lookups go to whatever domain follows the @ (`usePeopleSearch.js:200`), and pictures load from their own hosts. Both are disclosed as rows.

---

## Area 7: discovery

Read: `src/features/chat/usePeopleSearch.js` (331), `src/components/ProfileModal.jsx`, `src/Discover.jsx` (1-100).

### S1. CONFIRMED, Low: message search is unreachable
`handleGlobalSearch` (`usePeopleSearch.js:11-37`) is returned and never called (`Chat.jsx:71` takes only `handleSearch`). `MessageSearchResults` is a 9-line stub.

### S2. CONFIRMED, Low: a 12-20 character word is treated as a group id
`usePeopleSearch.js:165-169`, and 10-63 hex characters at `:176-180`: typing "photographer" returns "Group photographer".

### S3. CONFIRMED, Low: the QR scanner decodes and only offers Copy
It never opens the chat or group it found (`QRScanner.jsx:58-63, 102-110`).

### S4. CONFIRMED, Low: product share links go nowhere
`?product=…&vendor=…` (`Shop.jsx:70`) is read by nothing; the bootstrap reads only `g`, `group`, `join` and `naddr`.

What is true: `@username` lookup checks local vaults, then the kind-10003 registry, then NIP-50, and confirms with an exact author query (`usePeopleSearch.js:60-147`). Usernames are squattable (I9).

---

## Area 8: shop and orders

Read: `src/Shop.jsx` (1-140), `src/components/chat/MyOrders.jsx`, the order part of `src/components/MessageBubble.jsx`, and `src/features/chat/useCommerce.js` from pass 1.

### O1. CONFIRMED, High: the order lifecycle stops at payment
Of the eight order actions `useCommerce` handles, only three are emitted by any UI: `accept_order`, `confirm_payment` and `check_chain` (`MessageBubble.jsx:199-205`). `decline_order`, `cancel_order`, `mark_shipped`, `confirm_delivery` and `report_issue` are emitted by nothing.

So no order can be shipped, delivered, declined, cancelled or disputed. The automatic vouch on delivery never fires, and the vendor's "Orders" count (`useVendorStats.js:17-32`, completed only) is always 0.

**Fix:** put the buttons on the order card. Vendor: Decline while pending, Mark shipped once paid. Buyer: Cancel while pending, Confirm delivery once shipped, Report an issue after acceptance. **Done when:** each of the five actions is reachable from a card, and a test covers which button shows in which state.

### O2. CONFIRMED, Medium: a BTC- or XMR-priced listing is ordered and shown as dollars
`Shop.jsx:46` renders `$<price>` regardless of the price tag's currency. `confirmOrder` hard-codes `currency: 'USD'` (`Shop.jsx:89`). A 0.001 BTC listing becomes an order for "$0.001". Note only.

### O3. CONFIRMED, Low: drops, edit-product and sold-out are dead
`handlePostListing`, the only writer of `dropUntil` and `stock` (`useCommerce.js:414-426`), needs `postListingGroup`, which nothing sets. `edit_product` and `mark_sold_out` are emitted by no UI, so `ProductEditModal` never opens. Note only.

Promise check, "Zero custody. A fresh derived address per order. Nothing is reused":
- Zero custody is **True**: only an xpub and a view key are ever stored (`vendorPayments.js:64-86`).
- A fresh address per order is **False by default**. With no xpub or view key, which is the default, every order gets the vendor's main address (`vendorPayments.js:146-147`).
- Every marketplace listing also publishes the static main addresses (`Wallet.jsx:202-203`), and checkout shows them (`OneTapCheckout.jsx:76-79`).

---

## Area 9: notifications

Read: `src/lib/notifications.js`, `src/components/chat/NotificationCenter.jsx`, and the notify paths in `useNIP44DM.js` and `useNIP29Group.js`.

- **N1. CONFIRMED, Medium:** live group messages never increment unread. `useNIP29Group.js` never calls `setUnreadCounts`. The badge catches up only on the next full `fetchChats`.
- **N2. CONFIRMED, Low:** no OS app badge. `setAppBadge` is never used.
- **N3. CONFIRMED, Low:** mute and archive suppression (`useNIP44DM.js:31-37`) cannot be triggered (D5). The "hide notification content" setting (`chatStore.js:103-104`) is read by nothing.
- **N4. CONFIRMED, Low:** notification permission is requested on mount with no user gesture (`AuthenticatedApp.jsx:29-31`). Safari ignores that.
- **True:** in-app and local notifications never carry message text (`notifications.js:23-26`). The group call site passes a title and body that the function ignores (pass-1 L5), so the result is still generic.

---

## Area 10: storage and the database

Read: `src/db.js`, `src/lib/storage.js`, `src/lib/myGroups.js`, and a grep of every unscoped localStorage key.

- **ST1. CONFIRMED, Medium:** `flushQueue` is never called (`db.js:64`). Writes made before the database opens go into `pendingQueue` through the stub (`db.js:76-77`) and are lost. That window covers the first-ever login, before `openDBFor` runs.
- **ST2. CONFIRMED, Medium:** product state lives in global keys (`cipher_cached_products`, `cipher_my_products`) and in a scoped key, all at once (I10). The payment-address keys are global (I7).
- **ST3:** versioning is Dexie v8 → v9 (adds `outbox`), with one database per account named by the first 16 hex characters of the pubkey (`db.js:10-28, 37`). Fine.
- **Wipe:** see I2 for lockout and remove-account, and D1 for account switch. Panic wipe deletes every database it can name.

---

## Area 11: onboarding and install

Read: `src/LockScreen.jsx` (1-200), `src/components/chat/IdentityBackup.jsx`, `src/components/chat/QRScanner.jsx` (56-110), `public/manifest.json`, `index.html`, the `TutorialModal` text.

- **True:** creating an account generates a 128-bit BIP39 phrase, makes you confirm three random words before continuing (`LockScreen.jsx:105-116, 169-181`), and asks for no phone or email.
- Restore by phrase validates the phrase against the BIP39 wordlist (`useIdentity.js:581-587`).
- See I1 for restore-by-handle and I9 for the bypassed username check.

---

## Area 12: PWA

Read: `public/sw.js`, `public/manifest.json`, `index.html`, `vite.config.js`, `vercel.json`.

- **W1. CONFIRMED, Medium:** offline works only for screens already opened. Navigation is network-first with a cached shell (`sw.js:26-40`). Assets are cached only when fetched (`sw.js:43-54`), so a lazy chunk never opened online fails offline, and the error boundary shows "App Crashed" (`App.jsx:19-27`).
- **W2. CONFIRMED, Low:** there is no install prompt (no `beforeinstallprompt`). The manifest's `"purpose": "any maskable"` on both icons is discouraged. Old `/assets/` entries are never purged from `cipher-shell-v1`.
- **True:** update works. `skipWaiting` plus `clients.claim` (`sw.js:7, 17`), and a network-first shell, pick up a new deploy on the next load.
- **True:** the CSP has `script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'` and `Referrer-Policy: no-referrer` (`vercel.json:22-37`).

---

## Area 13: the unused layer

- **Template leftover, 68 files, never imported by product code:** `src/lib/auth/*`, `src/lib/app-data/*`, `src/lib/multiplayer/*`, `src/lib/db.ts`, `src/lib/env.server.ts`, `src/lib/error-component.tsx`, `src/lib/preview-*.ts`, `src/components/preview-host-bridge.tsx`, `server/*`, `vite.config.ts`, `tsconfig.json`, `eslint.config.mjs`, and `scripts/grok-*`, `brand-check*`, `browser-*`, `check-auth-invariant*`, `migrat*`, `preview*`, `sign-out-plan*`, `write-atomic*`, `app-env-plugin.mjs`, `install-page.html`.
  - Grep for imports of these from `src/` returned nothing.
  - The packages they need (auth, pglite, the router) are not in `package.json`, so they cannot even build. `AGENTS.md` describes this layer.
- **Product infrastructure that came with the template:** `scripts/with-app-env.mjs` wraps `dev`, `build` and `preview` (`package.json:7-10`). Keep it, or replace it in the same commit that removes the layer.
- **Unused dependencies:** `@nostr-dev-kit/ndk`, `@lglab/react-qr-code`, `emoji-picker-react` and `react-easy-crop` have zero importing files.
- **Dead product components** (pass-1 sweep, bucket A): `ShopView`, `ChatPinnedBar`, `ChatReplyPreview`, `FullEmojiPicker`, `OrderManagerModal`, `ReviewModal`, `VendorAnalytics`, `VendorOnboardingWizard`, `ui/Card`.
- **Decision:** delete the template layer and the four dependencies in one commit. That is beyond this pass's twelve; left as the first note.

---

## Verdict table: the app's own promises

| Promise | How tested | Verdict |
|---|---|---|
| No phone, no email, ever | Grep of product `src/` for email or tel inputs and wording: none. The template's email-password file is never imported | **True** |
| Identity is a BIP39 seed in a PIN vault | Read `useIdentity.js:6-10, 53-78, 285-311` | **True, with caveats.** The key is not NIP-06, so the phrase does not restore in other clients (I5). A 6-digit PIN behind PBKDF2 is offline-crackable. The unlocked key sits in sessionStorage (I4) |
| Zero custody | Read `vendorPayments.js`: only an xpub or a view key is stored | **True** |
| A fresh derived address per order; nothing is reused | Read `vendorPayments.js:146-147`, `Wallet.jsx:202-203`, `OneTapCheckout.jsx:76-79` | **False.** Without an xpub or view key (the default) every order gets the main address, and every listing publishes it |
| Zero platform fees | Grep for fee, commission and take rate across `src/` and `scripts/`: no fee logic | **True** |
| Panic wipe | Read `useIdentity.js:645-716`, `Wallet.jsx:526-549`, `usePanicWipe.js` | **True for the button**, by reading the code; not run. The shake trigger cannot be turned on (I6) |
| EXIF stripping | Read all three upload paths and `imageCompression.js` | **True.** Canvas re-encode on every image upload. Not run |
| DMs over NIP-44 | Read `useNIP44DM.js:65-66` | **True.** The payload is NIP-44 v2, carried in kind 4, which is NIP-04's kind, so it does not interoperate |
| Groups over NIP-29 with per-epoch keys | Read the group codec and rotation, and the tests | **True in code.** Discover joins skip the NIP-29 join (G2), and invite links dead-end (G1) |
| Private by default: what a relay learns, what a host learns | Read every egress use | **False.** See the table below |
| PWA is the primary install path, and it buzzes | Manifest and service worker read; push from pass 1 | **Unverified.** No locked phone has buzzed, and there is no install prompt |
| Onion is optional per row and used when pasted | Grep for hard-coded hosts: none; `activeUrl` on every row | **True.** NIP-05 and picture hosts cannot be routed; both are disclosed |
| Per-account PIN lockout wipes only that account | Read `useIdentity.js:384-451, 743-769, 517-574` | **False.** Two unlock paths skip the counter (I1), the wipe leaves the account's data (I2), and switching accounts erases a different account's messages (D1) |
| Every advertised screen is reachable and does what it says | Store-action caller sweep (19 of 80 have no caller), view reachability, menu action sources | **False.** Forward, Block, mute, archive, disappearing messages, ship/deliver/dispute, two Wallet views, Groups privacy and Last seen |

### What a relay or host learns with default settings

| Host | Learns |
|---|---|
| Message relay (`relay.primal.net`) | Your IP. Who you message and when (kind-4 authors and `p` tags). Whether each message is a message, an order or a call (t= tags, accepted in pass 2's documentation commit). When you open a chat (read events) and when you type (typing events), as separate kind-4 events. |
| Group relay (`groups.ciphertele.com`) | Your IP and key (AUTH). Every group you open and its member list. Message timing and size. **Your people-search text, signed by your key (P2).** |
| Media hosts (Blossom) | **The plaintext of every photo and voice note you send, linked to your key (M1).** |
| `api.microlink.io` | **Every URL in every chat you view (P1).** |
| Google and Twilio STUN | Your real IP during a call. Disclosed in the app. |
| Profile relays | Your profile, username registry entry and relay list. All public by design. |

---

## Findings, worst first

| # | Severity | Tag | Finding | Where |
|---|---|---|---|---|
| D1 | Critical | CONFIRMED | Switching accounts erases the target account's messages | `useChatBootstrap.js:487-499` |
| M1 | High | CONFIRMED | Photos and voice notes uploaded in plaintext, linked to the sender's key | `useComposer.js:188-192, 221` |
| I1 | High | CONFIRMED | PIN lockout skipped by account switch and by restore-by-handle | `useIdentity.js:517-574, 743-769` |
| I2 | High | CONFIRMED | Lockout and remove-account leave the account's database, keys and passkey | `useIdentity.js:427-447, 794-804` |
| I7 | High | CONFIRMED | Payment addresses shared across accounts through global keys; a buyer can be handed another account's address | `Wallet.jsx:60-61`, `useCommerce.js:62-63` |
| G1 | High | CONFIRMED | Invite links send a join request nothing can approve | `useChatBootstrap.js:519-526`, `useGroupDirectory.js:50-60` |
| G2 | High | CONFIRMED | Discover join never publishes kind 9021 | `Discover.jsx:69-89` |
| O1 | High | CONFIRMED | Ship, deliver, decline, cancel and dispute have no button | `MessageBubble.jsx:199-205` |
| C1 | High | CONFIRMED | Replayed call offers ring on launch and auto-send busy | `useNIP44DM.js:159-163`, `voiceCall.js:239-257` |
| P1 | High | CONFIRMED | Link previews leak every chat URL to microlink by default | `LinkPreview.jsx:28-34` |
| D2 | High | CONFIRMED | Block has no way in | `PrivacySettings.jsx:83` only |
| D3 | High | CONFIRMED | Forward does nothing; the Forwarding toggle governs nothing | `useMessageCommands.js:104-108`, `Chat.jsx:126` |
| I3 | High (design) | CONFIRMED | History and group keys unencrypted at rest | `db.js` tables |
| P2 | Medium | CONFIRMED | Search text signed and sent to the group relay; search rows unused | `usePeopleSearch.js:244-285` |
| I4 | Medium | CONFIRMED | Raw secret key in sessionStorage | `useIdentity.js:379, 421, 480, 564, 604, 757` |
| I5 | Medium | CONFIRMED | Phrase not NIP-06 | `useIdentity.js:6-10` |
| I6 | Medium | CONFIRMED | Shake panic wipe cannot be enabled | `chatStore.js:377`, `Wallet.jsx:39` |
| I8 | Medium | SUSPECTED | A new account's store starts with the previous account's settings | `chatStore.js:103-372`, `storage.js:41-46` |
| D4 | Medium | CONFIRMED | Edit is local only; deletions resurface | `useMessageCommands.js:126-185`, `useChatBootstrap.js:273` |
| D5 | Medium | CONFIRMED | Archive, pin, mute and timers have no way in | `chatStore.js` (19 actions) |
| G3 | Medium | CONFIRMED | Discover shows only joined groups | `Discover.jsx:56-58` |
| O2 | Medium | CONFIRMED | Coin-priced listings ordered as USD | `Shop.jsx:46, 89` |
| N1 | Medium | CONFIRMED | Group unread never increments live | `useNIP29Group.js` |
| ST1 | Medium | CONFIRMED | Pre-open write queue never flushed | `db.js:64, 76-77` |
| W1 | Medium | CONFIRMED | Offline fails for screens not yet opened | `sw.js:43-54` |
| Privacy | Medium | CONFIRMED | Groups toggle does nothing; Last seen is misleading; Profile photo partial | `PrivacySettings.jsx:64-72` |
| I9-I11, S1-S4, O3, N2-N4, C2, W2, G4, D6 | Low | CONFIRMED | See each area | — |

## Calibration

| Finding | How verified | Confidence |
|---|---|---|
| D1 | Read both effects in `useChatBootstrap.js`; React runs passive effects in declaration order; `db` is the proxy over `_current` set by `openDBFor`. Not run in a browser | High |
| M1 | Read every upload call; no encryption between `compressImage` and `uploadToBlossom` | High |
| I1, I2 | Read every vault-decrypt path and the lockout block | High |
| I7 | Read reads and writes of the global keys in `Wallet.jsx` and `useCommerce.js` | High |
| G1 | Grep for `join_request`: one sender, no handler | High |
| G2 | Read `Discover.join`: no `publishGroupJoin` | High |
| O1 | Grep for each action string across `src/` | High |
| C1 | Read the replay window, the live handler and `handleCallSignal`. The ghost ring is certain; whether a replayed hangup cancels it depends on relay order | High that it rings; Medium on how long |
| P1, P2 | Read the code paths; not observed on the network | High |
| D2, D3, D5 | Caller sweep of store actions, and grep | High |
| I8 | Depends on module-load timing of the store versus `cipher_active_pubkey` | Medium |
| ST1 | Read: the stub queues writes and nothing calls `flushQueue` | High that the queue is never flushed; Medium on how often writes land there |
| W1 | Read `sw.js`; not run offline | Medium |
| Promises marked True | Read the code; nothing run in a browser, no relay contacted | Medium-High |

## Scores

**App as a whole: 4/10.** The core crypto is sound: NIP-44 everywhere, per-epoch group keys with AAD, and a salted 600k PBKDF2 vault. But a set of reachable defects destroy data or leak content:
- account switching erases history;
- attachments are public;
- the lockout can be bypassed;
- invite links and Discover joins do not work;
- the order flow stops at payment;
- a fifth of the store's actions cannot be reached.

| Area | Score | Why |
|---|---|---|
| 1. Identity and vault | 4 | Good KDF and phrase confirmation; lockout bypass, incomplete wipe, plaintext session key |
| 2. Groups | 4 | Sound crypto and membership checks; two of three join paths broken |
| 3. DMs | 4 | Encryption and dedupe fine; switch wipe, no block, dead forward, edits not sent |
| 4. Media | 3 | EXIF stripped everywhere; content public |
| 5. Calls | 6 | Sound WebRTC flow and privacy toggle; replay rings |
| 6. Privacy | 4 | Honest Connections list and onion routing; leaky defaults; two toggles do nothing |
| 7. Discovery | 5 | Username lookup layered and confirmed; dead message search, odd heuristics |
| 8. Shop and orders | 3 | Listing and payment work; lifecycle stops at payment; address reuse by default |
| 9. Notifications | 5 | Generic, no content; group unread lags; no OS badge |
| 10. Storage | 4 | Per-account databases; global keys leak; pre-open queue dropped |
| 11. Onboarding | 7 | Phrase confirmation, no phone or email; username squatting |
| 12. PWA | 5 | Updates work, strict CSP; offline partial, no install prompt |
| 13. Unused layer | 2 | 68 template files and 4 unused dependencies shipped in the repo |

## Fix plan for this pass (capped at twelve commits)

Ordered by promise broken, then adoption blocked, then dead code:

1. I1: count PIN failures on account switch and on restore by handle.
2. I2: lockout and remove-account erase that account's database, scoped keys and passkey.
3. D1: stop erasing an account's messages on account switch.
4. I7: payment addresses per account only.
5. M1: encrypt photos and voice notes before upload.
6. P1: link previews off by default, with a Privacy toggle.
7. P2: stop sending search text to the group relay.
8. C1: ignore replayed call signals.
9. G1 + G2: one join path. Invite links and Discover join through `joinGroupById`, and the join-request path is deleted.
10. O1: order card buttons for decline, cancel, ship, deliver and report.
11. D2: Block from the profile sheet.
12. D3 + D6: delete Forward, its toggle, and message actions no UI can emit.

Left as notes, in priority order:
- delete the template layer and the four unused dependencies (Area 13);
- G3, Discover lists the relay's groups;
- D4, kind-5 author filter and tombstones;
- D5, wire or delete archive, pin, mute and timers;
- I6, shake toggle;
- the Groups and Last seen privacy toggles;
- N1, group unread;
- ST1, the pre-open write queue;
- O2, currency on coin listings;
- W1, offline precache;
- I3, I4 and I5, design work.

## Corrections to the pass-1 audit
- Pass 1 treated `report_issue`, `mark_shipped` and `confirm_delivery` as live order paths: the buyer co-signing on dispute, and the automatic vouch on delivery. **No UI emits any of them (O1).** The `acceptPayment` co-sign on an incoming paid receipt is live, and findings H2, H3 and M4 stand. The dispute and delivery branches are unreachable, and the vendor sales count built on `completed` is always 0.
- PR #32's C2 fix stores the vendor's order patch in Dexie, and it survives a reload as claimed. **Switching accounts erases it (D1).** Its "done when" held for reload only.
- Pass 1 credited `deliverOrderUpdate` (`useCommerce.js:35-54`) for handling both failure shapes. That still holds, but five of its eight callers are unreachable.
