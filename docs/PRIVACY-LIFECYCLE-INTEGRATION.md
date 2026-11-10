# Privacy lifecycle integration contract

This contract began as an integration checklist for independent wipe/retrieval helpers. The current working tree wires part of it into `src/useIdentity.js`, legacy DM/group callbacks, account database writes, and vendor payment operations. The audit below separates production app callsites from isolated ratchet, MLS, authority, and registry prototypes. The coordination marker now covers the main account DB, commerce allocator, and standalone primary-authority, pin, and peer-checkpoint databases; it does not complete every lifecycle callsite or R5 secret storage.

## Context API

`src/lib/securityContextFence.js` currently exports:

- `establishSecurityContext({ owner, storage, randomId })` after successful authenticated unlock; returns immutable `{ owner, incarnation }`.
- `createSecurityContextFence({ context, storage, channel, onInvalidate })`; returns `isCurrent()`, `assertCurrent()`, `invalidate()`, and `close()`.
- `invalidateSecurityContext({ owner, storage, channel })` removes the persisted account incarnation before broadcasting to tabs holding that exact incarnation and reports durable invalidation success or failure.

## Durable transaction linearization (main account DB, partial integration)

`src/lib/indexedDbContextGate.js` provides the transaction gate used by the
account database for ordering durable context retirement against account data writes. A writer includes the
`securityContexts` marker store in the same readwrite transaction as its data;
retirement deletes that exact `{owner, incarnation}` marker through a competing
readwrite transaction. Retirement transaction completion is the proposed
linearization point: an earlier writer may commit before it, and no later
writer for that incarnation may commit after it. A sibling tab with a different
incarnation remains authorized.

`src/db.js` now adds the `securityContexts` table (schema v20), activates the
current tab incarnation when an account DB is opened with a fence, and routes
readwrite transactions and table mutations through the marker gate. Queue
flushes wait for activation. Local lock retires its exact marker; account
removal and panic wipe retire all known markers for the affected owner before
database cleanup. Fake IndexedDB tests exercise the live `db` proxy transaction
and table-write paths, owner-wide retirement, sibling tabs, and transaction
abort behavior.

This is a partial gate, not application-wide atomicity. `openDBFor` still
accepts a missing fence for legacy/test callers, so every production caller
must continue to pass the authenticated fence. The chat bootstrap and both
legacy DM key-install paths now refuse an account DB open without that fence.
Message merge, patch, read-receipt and temporary-row settlement prepare
decrypted/sealed rows outside their short write transaction; merge and patch
recheck raw-row snapshots and retry on concurrent changes. Other code can
still pass arbitrary callbacks to `db.transaction`; current account-database
callers were inventoried by owner boundary below. Callbacks must remain short
and must not await network or cryptographic work. The Bitcoin commerce-wallet
allocator now has its own context marker: descriptor initialization,
reservation, and reservation finalization include the marker in their write
transaction when called with the active fence. Lock retires the exact allocator
incarnation; removal, lockout, and panic wipe retire all allocator markers for
the owner. A retired reservation is rejected without consuming an index, and
a replacement incarnation can continue from the durable head. This remains a
separate transaction domain from the main account DB. Authority and
peer-checkpoint stores remain outside the main DB transaction, but now use
`src/lib/securityContextCoordination.js` as a shared durable retirement gate.
Writers in each database acquire the same owner/incarnation Web Lock and check
the central coordination marker before entering their own transaction.
Retirement holds that Web Lock while retiring the main account and allocator
markers; account removal and panic wipe also retire every known incarnation for
the owner. The central marker is deleted only after each registered retirement
callback succeeds. If a database retirement fails, the marker remains, so
subsequent coordinated writes fail closed. Browser environments without Web
Locks fail closed for these standalone stores; the in-process test fallback is
not cross-tab evidence. This order serializes these coordinated writers and
retirement operations; it does not make multiple databases one IndexedDB
transaction. Activation itself requires the live account fence and rechecks it
after writing, so a retired tab cannot recreate its durable marker. The
group-key store and account DB-backed feature transactions use the main DB
proxy when using its handle. The two-tab browser harness now separately
verifies allocator marker retirement and sibling continuation, and holds a
standalone primary-authority write across lock to confirm retirement waits and
the stale write cannot commit. Pin and peer-checkpoint stores share the same
coordinator contract but do not yet have separate browser-level races in this
harness.

`useIdentity` now establishes and retires contexts across its principal unlock, lock, switch, removal, and wipe paths. Ratchet transaction/outbox operations and vendor payment operations capture and recheck the fence across asynchronous work. The previously passing lifecycle harness covered independent hook incarnations, tab-scoped lock, stale allocator/UI callbacks, sibling continuation, account removal, panic wipe, delayed authority WebCrypto, and two-tab pin/peer successor races. Those pin/peer stores remain prototypes with no application callers. The harness also covered owner retirement behind a cross-tab Web Lock and one injected allocator database-open failure; that was not an actual blocked account-database deletion.

The current continuation adds resume-time checks in `useIdentity` for `focus`, `pageshow`, and visible `visibilitychange`, plus browser cases for a missed invalidation, storage refusal through `removeAccount`, and a held IndexedDB connection that blocks the real account-database delete. These new cases have **not passed yet**: the current environment's Playwright run timed out at navigation before the probe mounted (`identity: false`, empty page body), on three attempts. No lifecycle assertion ran in those attempts. The existing unit test does verify that `deleteAccountDatabase` reports a blocked database while deleting unblocked siblings, but it is not a substitute for the new app-level browser case. Keep the integration gate open until the browser runner loads and all added cases pass. Relay, watcher, and media endpoints remain test doubles. This is local lifecycle evidence, not proof for every callback. `localStorage` plus BroadcastChannel is a cooperative invalidation signal, and bytes already handed to a socket cannot be recalled. Keep every new side effect behind the captured context and check after each asynchronous boundary.

## Required call sites

1. `src/useIdentity.js`: the main lock/unlock/switch/remove/wipe paths are fenced. Initial/profile relay publication now requires a live fence matching the event pubkey and rechecks before socket creation, EVENT send, and AUTH send. The shake handler in `src/hooks/usePanicWipe.js` now delegates to the same wipe coordinator after identity-wipe failure. Audit every `setSessionKey` and asynchronous restore/biometric branch for complete coverage.
2. `src/db.js`: partially wired. `openDBFor(pubkey, securityFence)` binds the active DB handle to the matching context; readwrite transactions and table mutations contend with exact-incarnation retirement on the `securityContexts` store; pre-open write-queue rows wait for activation and retain owner/fence checks; pending at-rest rows are tagged to the receiving incarnation and discarded after it expires. Lock, account removal, lockout cleanup and panic wipe retire local or account-wide IndexedDB markers before cleanup. Production account DB open call sites require the authenticated fence. Message merge, patch, read-receipt and temp-row helpers prepare crypto outside transactions and use short commits. HMR no longer restores a handle from the persisted owner string; the authenticated path must reopen it. `deleteAccountDatabase` reports each result and includes the main account DB, primary-authority DB, and policy-pin DB; the peer-checkpoint DB still lacks local-owner provenance and is not guessed to belong to a removed account. The commerce allocator's separate database now has cross-tab browser evidence for marker retirement, sibling continuation, and anti-reuse-head retention. Remaining: audit arbitrary transaction callbacks and standalone ratchet/MLS/authority stores. Group-key app mutations carry the fence; device-registry mutations require a fence but still have no app caller. Primary-authority, policy-pin, and peer-checkpoint APIs require a live account-incarnation capability and recheck it inside write callbacks; these stores now serialize writes and retirement through the shared central coordination marker. They still have no application callers. Browser race coverage currently exercises primary-authority storage only; pin and peer-checkpoint browser races remain open.
   The legacy `useNIP44DM` send, typing, history fetch, and live-ingestion paths now retain the identity fence and recheck it after awaits and before DB/outbox/publish effects. `publishWriteAhead` accepts the caller fence and checks before/after durable queueing, before publish, after relay settlement, and before queue removal; if the caller expires before the publish gate, the immutable event remains queued without a new send, and expiry before acknowledgement processing leaves the row queued. `publishOwnRelayList`, relay-list cache fill, and first-seen safety-number writes also check the context. This narrows stale callbacks for these paths; it does not make IndexedDB invalidation atomic with an already-started transaction, nor can it recall a socket write already handed to the relay library. Focused hook-level browser race coverage is still open.

### Remaining callsites confirmed in the current tree

- `src/features/chat/useChatBootstrap.js`: `syncIdentity` carries `{ pk, sk, securityFence }`; `syncGroupMessages` rechecks that captured context after relay fetch, member snapshot load, each decode, each DB save, and before store update. The outbox-status listener, username restore effect, push gateway callback, and `cipher:group-key-updated` listener also hold/recheck their captured fence before DB/UI effects or queued-send retry. The member-baseline publisher rechecks after pool creation, baseline sealing, and relay settlement. `fetchChats`, `drawHeldChats`, `splitRows`, and profile hydration now retain/check the account fence across relay and IndexedDB awaits, bulk-expiry deletion, and state changes. Browser race coverage remains open; source-contract tests verify guard placement, not IndexedDB races.
- `src/features/chat/useGroupDirectory.js`: account group-list writes retain the fence inside the store updater; read-marker writes recheck before updating unread state; join and create callbacks recheck before post-await UI effects; directory fetch checks after pool and relay reads before merging local rows. Its source-contract tests are local checks, not browser race evidence.
- `src/hooks/useNIP29Group.js`: raw group relay AUTH/EVENT sends check the captured account fence after async actor proof/AUTH waits and immediately before send; post-ack processing also rechecks. Auth-triggered subscription flush returns without sending REQ after invalidation. `publishKeyDm` checks before peer-route resolution, after peer-route and pool awaits, and after relay settlement. `flushSecuringGroupSends` rechecks before and after authorization, encoding, publish, and key lookup; it drops a saved retry only after publish returns under the same context. Group creation/join/leave, group sends and key requests, moderation/member changes, settings, pin operations, and sealed-name key delivery now recheck before their local and relay effects. `sendGroupMessage` passes the fence through atomic message-effect reservation/completion; the epoch rotation helper passes it into membership and key distribution helpers. Group relay frames and history refresh recheck after decode and database writes before store or notification effects. Stale sessions do not open, dispatch on open, or reconnect after close. Remaining: browser race coverage, auditing non-hook callers of optional-fence helpers, and ensuring lock/wipe can coordinate with already-started transactions and socket writes. Source-contract tests are not IndexedDB race proof. Do not count group MLS migration as part of this.
- `src/features/chat/useMessageCommands.js`: delete, delayed edit, reaction, retry, pin, bookmark, copy completion, delegated order handling, and checkout callbacks now capture and recheck the account fence before follow-up effects. Source-contract tests cover guard placement, not browser races.
- `src/hooks/useReactions.js`: reaction send/revoke and DM/group subscription callbacks now recheck the captured fence after asynchronous work and before durable or store effects. A relay frame already handed to the library cannot be recalled; this is local stale-callback fencing, not browser race proof.
- `src/hooks/useGroupKeyReconciler.js`: the update listener and reconciliation run retain the captured identity incarnation across relay, key-store, member-snapshot, and baseline awaits. Its member-document publisher, membership snapshot writes, durable rotation marker, and per-recipient key distribution pass and recheck that fence. All inventoried app calls to production group-key/document mutators pass the captured fence, and production mutation APIs reject missing fences. Focused Node/fake-IndexedDB tests reject a retired incarnation; cross-tab group-key browser coverage remains open. `deviceRegistryStore.js` mutation/read APIs also require the fence through verification, sealing, and commit, but have no app callers and are not an enrollment integration.
- `src/hooks/useReputation.js` / `src/hooks/useVendorStats.js`: reputation reads and signed vouch, review, dispute-rider, and bulletin operations now check the captured fence after awaits and before local/relay effects. `enqueueNostrEvent` accepts that fence for these queue writes. Tests check source guard placement, not browser races.
- `src/Wallet.jsx`: product listing publication captures the active account fence, checks before signing and relay publication, passes it to outbox enqueue, and checks before cache/UI effects after relay and database awaits. Vendor receiving-address saves, advanced settings, buyer-mode cleanup, profile save, copy completion, vendor settings hydration, private media upload completion, preferred-payment, confirmation-count, and auto-vouch settings all use the captured incarnation. Vendor-card publication checks the fence before relay send and after acknowledgement. The browser lifecycle harness holds Wallet media and stale settings callbacks across lock; relays and media hosts are mocks. A network request or media upload accepted before invalidation cannot be recalled.
- Remaining writers in this inventory are the standalone ratchet, MLS, and authority stores plus unenumerated transaction callbacks. `NotificationCenter` carries identity into its durable read-marker transaction; `GroupView`'s direct group-text and listing sends, pending retry, profile hydration, and storefront photo callback retain the account fence; `useComposer` checks it across message saves, DM/group sends, image uploads, and voice recording/upload callbacks; and `useMessageCommands` checks it around deletion, delayed edit, reaction, retry, pin, bookmark, copy completion, and delegated order callbacks. The browser harness exercises these UI surfaces against controlled pauses. The `useCommerce` `check_chain` path captures the identity fence, checks it after order-history and watcher awaits, before receipt/consumed-transfer writes, and through the resulting order update's send and local persistence; its ledger Web Lock remains in place. It uses the captured per-tab incarnation rather than the shared active-key string, so locking one tab does not revoke a still-valid sibling tab. All `deliverOrderUpdate` paths require that captured identity fence before send, after relay settlement, and around local persistence. Order acceptance, delivery-note open/save/burn, checkout note creation and order send, product edit/broadcast, and delivery-vouch follow-up now check the same fence at their asynchronous boundaries. The report-issue confirmation callback also rejects a retired action context. The `writeDeviceMark` effect receives the fence on the chain-check path and suppresses stale rollback/UI effects. The commerce harness holds a watcher result, locks the originating tab, and verifies no receipt, consumed-transfer ledger entry, order publication, or stale UI effect; the sibling control passes. Watcher response and send are test doubles, so this is lifecycle-race evidence, not signed-watcher or relay evidence. Commerce response testing against real operator services remains open.
3. Authority app integration is open. Current app setup is `LockScreen` → `Create` → `createVault` → 12-word N confirmation → `confirmVault` → `SetupProfile` → `finalizeLogin`; local restore is `RestoreMnemonic` → `restoreFromMnemonic` and also accepts only the 12-word N phrase. There are no application callsites for `deviceAuthorityStorage.js`, `deviceAuthorityPinStore.js`, `deviceAuthorityPeerStore.js`, or the v2 device enrollment flow. The authority store has no captured lifecycle fence; the peer store has no local-account provenance. R is an independent 24-word root in the prototype, and `restoreOfflineRecoverySecret` requires a separately authenticated R fingerprint. Do not derive R from N or silently create a non-recoverable R during unlock. Before wiring A/R/D or pins, define and test initial R backup/confirmation, legacy-account behavior, restore/replacement, contact re-verification, and lock/removal cleanup.
4. Provider/cache boundaries: group actor cache now clears with group-session shutdown, and a pending HKDF derivation clears its private result if the session key changed before completion. Still open: invalidate `devicePrf` cached secrets and authority unwrap state; on removal destroy owner-scoped provider material and report inability to confirm. Panic cleanup can delete encrypted stores without unlocking.
5. `src/lib/dmRatchetTransactions.js` and `src/lib/outbox.js`: prototype operations now capture context and assert it after awaits and at transaction/publication gates. This does not wire the prototype into production DMs. Ratchet state, immutable event, authorization metadata and outbox journal must stay atomic. A 30-second remote proof does not supersede a local lock/switch/wipe.
6. Workers, relay subscriptions, media/object URLs, group sessions and chat state: register stoppable cleanup with the same wipe coordinator. Context loss suppresses callbacks and effects even when unsubscribe/termination is delayed.

## Account-owned resource inventory

Use an explicit registry for owner-scoped resources so cleanup works without `indexedDB.databases()`. Reviewed DB names are `CipherDB_v7_<N first 16 hex>`, `CipherPrimaryAuthorityV2_<N first 24 hex>`, and `CipherAuthorityPinsV2_<N first 24 hex>`. Peer checkpoints currently use `CipherAuthorityPeerV2_<peer N first 24 hex>` and therefore lack local-owner provenance; migrate to an owner-scoped opaque store before making per-account deletion decisions. Whole-origin wipe should enumerate and delete all origin DBs where possible, always attempt registered names, and report unknown/unverifiable stores when enumeration is unavailable.

Do not claim secure physical erasure, deletion of remote relay copies, or invalidation of hostile browser contexts. Report per-resource clear/fail/blocked/timeout/unverified outcomes. Preserve profiles, conversations, recovery records, and unrelated accounts. Do not fall back to N-key wrapping or TOFU if an authority pin is missing.

### Lifecycle ownership and callsite status

| Resource and current callers | Owner evidence | Lock and switch | Account removal | Panic wipe | Recovery | Gate |
|---|---|---|---|---|---|---|
| `CipherDB_v7_<owner-prefix>`: `groupKeyStore.js`, `deviceRegistryStore.js`, ratchet and account data; `openDBFor` callers are `useChatBootstrap.js` and two `useNIP44DM.js` key-install paths | Local account pubkey is in the database name and rows | Retire the exact tab incarnation; switch retires the old context while preserving account data | Retire all owner contexts, then delete this account DB | Retire known contexts, then delete all enumerated DBs | Same-account restore opens a new incarnation; ratchet/group rollback and backup restore are not proven | Partial: group-key, governance-key, grant-ledger, verified-doc and device-registry mutations require their captured fence; device-registry APIs remain prototype-only with no application caller |
| `CipherPrimaryAuthorityV2_<owner-prefix>`: `deviceAuthorityStorage.js` | Account pubkey is in the DB name and authority row; no application caller found | Preserve wrapped secret on local lock or switch | `deleteAccountDatabase` deletes it | Explicit owner name plus global enumeration | Replacement APIs exist in prototype code; no application recovery/restore caller or rollback proof | Open: standalone prototype store uses the shared durable coordinator; no app caller, restore UX, or pin-store browser race yet |
| `CipherAuthorityPinsV2_<owner-prefix>`: `deviceAuthorityPinStore.js` | Account pubkey is in the DB name and pin row; no application caller found | Preserve public monotonic pin on lock or switch | `deleteAccountDatabase` deletes it | Explicit owner name plus global enumeration | Exact policy successor and recovery-root replacement helpers exist, but no contact ceremony is wired | Open: standalone API uses the shared durable coordinator; no contact ceremony or browser race yet |
| `CipherAuthorityPeerV2_<peer-prefix>`: `deviceAuthorityPeerStore.js` | Database and row identify the remote peer only; no local-account provenance or application caller found | Preserve; it is not owned by the currently locked local account | Deliberately retain; deletion by local account would guess ownership | Delete only through global origin enumeration during whole-device wipe | Peer recovery-root replacement has a fingerprint-gated prototype; no local owner is recorded | Unverified for per-account ownership. Add local-owner provenance before adding per-account deletion; do not migrate an unused prototype preemptively |
| `cipher-commerce-wallet-allocator-v1`: `vendorPayments.js` and `commerceWalletStore.js` | Shared DB; rows carry account owner and descriptor hash | Retire exact incarnation; switch leaves durable head intact | Retire all owner markers, but retain owner head and reservation history to prevent reissuing previously allocated addresses after a later restore | Delete the shared DB as part of whole-device wipe | A panic wipe erases this anti-reuse history; recovery must hold for allocation evidence or use a fresh descriptor. Current UI flow is not proven to enforce that limit | Partial: two-tab browser lock/retirement evidence passes; deletion-versus-recovery policy needs an explicit user-visible hold before wallet reinitialization |

### Transaction-owner audit (2026-11-09)

- **Main account DB (`CipherDB_v7_<owner-prefix>`):** production feature
  transactions in `db.js`, `idempotentMessageEffect.js`, group key/document
  stores, and commerce app code use the account DB proxy or
  `runAccountDbWriteForFence`. The group-key and verified-document writes
  explicitly require and check the captured fence. `decodeGroupEvent` and
  `encodeGroupPayload` previously reached the group-key store without passing
  their caller's fence; the production NIP-29 and bootstrap callsites now pass
  it through to each key read. Those callers also check after decode/encode.
- **Ratchet/outbox transaction prototype:** `dmRatchetTransactions.js` and
  `outbox.js` operate against the main DB handle, but no non-test app module
  imports these transaction APIs. Their transaction tests therefore establish
  prototype behavior, not live DM lifecycle protection. `useNIP44DM.js` remains
  the production NIP-44/NIP-59 path and keeps its own captured-fence checks.
- **MLS transaction prototype:** `mlsStateTransactions.js` has no non-test app
  importer. Live groups still use the existing group-key implementation; the
  MLS functions are not a production owner boundary and have no integration
  claim.
- **Separate primary authority and pin databases:**
  `deviceAuthorityStorage.js` and `deviceAuthorityPinStore.js` use their own
  IndexedDB transactions and have no application callsites or lifecycle-fence
  argument. Cleanup deletes the registered owner DBs, but no claim is made
  about an in-flight operation racing deletion. They must gain captured-owner
  lifecycle fencing before application integration.
- **Peer authority checkpoint database:** `deviceAuthorityPeerStore.js` has
  its own transactions, no application caller, and no local-owner provenance.
  Do not delete it on account removal or claim per-account cleanup; migrate its
  ownership model before integration.
- **Device registry:** `deviceRegistryStore.js` writes to the main account DB
  through the fenced transaction helper and fails closed without a fence. It
  has no production app caller, so enrollment/revocation behavior remains
  unintegrated despite its helper-level fence tests.
- **Commerce allocator:** `commerceWalletStore.js` is the only separate
  production-owned transaction domain in this audit. Its context marker and
  owner-scoped anti-reuse head are tested in the lifecycle browser harness;
  the harness uses controlled local browser state, not an external wallet or
  relay service.

The authority and pin stores have no production callsites today; they remain
prototype APIs and must not be described as integrated R5 authority. Current
onboarding and local restore only create or recover the Nostr account key N
from a 12-word phrase. They neither create nor recover independent R, primary
authority A, or Dᵢ credentials. Adding authority storage to unlock without a
separate R backup and replacement ceremony would strand R after device loss;
deriving R from N would collapse the independent trust roots. Do not wire a
silent migration for existing accounts. Group
keys, governance keys, grant records, verified member documents, and device
registry rows are not separate databases: they live in the account DB. The
group-key and verified-document app call chains pass their captured fence, and
their production mutation APIs reject missing fences. `deviceRegistryStore.js`
now also requires the captured fence through verification, sealing, and its
atomic writes; a same-account relock test confirms stale registry work cannot
write into the replacement incarnation. It still has no application caller.
These helper tests do not prove cross-browser account lifecycle or live
group/DM security.

## Acceptance gates for Luna

- Lock/switch/wipe during WebAuthn, KDF, recovery, relay response, ratchet prepare, and queued publish: old incarnation cannot install plaintext, commit state, apply order/message effects, or initiate new publication afterward.
- Missing/corrupt context marker, localStorage denial, missed broadcast, duplicated tabs, reload/suspend/resume, blocked IndexedDB and worker failure fail closed and surface incomplete cleanup.
- D/A cannot be loaded from locked storage; unlocked correct owner can use them; removing one account destroys only its secrets and retains other accounts.
- Peer and pin plaintext contains no account-to-device/recovery relationship. Ciphertext tampering, owner substitution, rollback, interrupted migration and concurrent CAS are rejected without clearing a verified predecessor.
- History APIs preserve compatibility for old array callers while detailed consumers expose gaps/budgets and never claim a single relay proves global completeness.
- Security records render provisionally, continue collection until deadline, merge valid later signed records, reject invalid/unauthorized records, and ignore late old-context callbacks.

The helper and lifecycle tests do not satisfy all application integration gates. R/A/D setup and storage fencing, all async identity branches, security-record caller authentication, device-registry application integration, contact fingerprint verification, and R recovery/backup/replacement remain open. Do not enable R5 production DMs until authority setup, session lifecycle, recovery, and ratchet transaction tests pass in browser integration.
