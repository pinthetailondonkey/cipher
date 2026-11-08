# R5 production integration plan

Status: planning and isolated prototypes only. This document does not authorize
switching live DMs or migrating account/device identities.

## Verified starting point

The current work establishes useful components, but not an integrated R5 DM
system:

* `src/lib/deviceAuthority.js` defines independent recovery (`R`), primary
  authority (`A`) and per-device credentials (`Dᵢ`), signed enrollment,
  revocation, replacement and device-scoped freshness records. Its current
  freshness response is challenge- and operation-bound, lasts at most 30
  seconds, and must match an exact policy and registry head.
* `src/lib/deviceAuthorityPinStore.js` and
  `src/lib/deviceAuthorityPeerStore.js` provide local monotonic policy and
  registry checkpoints. The witness experiment in
  `src/lib/deviceAuthorityCheckpoint.js` proves only that a configured quorum
  signed the head it observed; it cannot establish global freshness.
* `src/lib/deviceAuthorityTransport.js` seals updates for enrolled devices,
  but has no relay subscription, durable network outbox or application call
  site.
* `src/lib/dmRatchetTransactions.js` and `src/lib/dmRatchetWire.js` remain
  isolated ratchet prototypes. The transaction module currently imports
  `src/lib/deviceFreshness.js` and `src/lib/deviceRegistryStore.js`, which use
  the earlier account-signed device registry. They do **not** yet consume the
  independent `R/A/Dᵢ` authority protocol. Their tests prove properties of
  that older prototype only.
* `src/hooks/useNIP44DM.js` remains the production NIP-44 DM path. No live DM
  send, receive, profile, contact, group, order, review, or payment format was
  changed by this R5 preparation.

The first implementation milestone must bridge or replace the ratchet
prototype's legacy freshness dependency with the recovery-pinned v2 authority
protocol before its transaction tests can serve as R5 evidence.

## Authorization and queue behavior

The proposed integration should use the following explicit states.

| Situation | Required behavior | Ratchet state / relay effect |
| --- | --- | --- |
| Device enrollment, revocation, or authority replacement has no fresh approval | Reject the transition; retain the last verified local checkpoint and any exact signed transition already committed for retry | No registry advance or relay publication based on stale roster data |
| New session has no fresh proof for the exact sender and recipient devices | Hold the send locally; do not create a prekey session or use a legacy fallback | No ratchet mutation and no relay event |
| Existing-session send has no fresh proof, or its proof expired | Hold the message until proof is obtained; do not open a new session silently | No encryption-state advancement or relay publication |
| Fresh proof is valid and the ratchet/outbox transaction succeeds | Commit ciphertext, ratchet state, target device, authority epoch, registry head and proof expiry atomically | Relay publication may begin while the proof is valid |
| A relay or recipient is offline after a valid event was published | The relay may retain and deliver the ciphertext later; offline receipt does not require the recipient device to be online at publication time | Ciphertext remains immutable. Revocation cannot recall an event already accepted by a relay or plaintext/key already copied |
| Relay outage delays an unaccepted queued event past proof expiry | Keep the exact ciphertext in a held state. Ask for fresh authorization for the same target device and require a non-rolled-back head before retry | No forced flush after expiry, no re-encryption, no routing to a replacement device under the old session |
| Authority is offline, withholds a response, or presents a stale/conflicting head | Fail closed. Keep an existing queued event locally sealed and held; do not delete it or mark it delivered | Do not mutate the ratchet state during a refresh. If authorization never returns, delivery remains blocked |
| The target is revoked or its authority epoch changed | Do not authorize the old target. Keep the event held for explicit recovery or user resolution; a new device requires a new authenticated session | Do not transfer old ciphertext or reset/reuse the prior ratchet session |
| A recipient device reconnects with pending ciphertext but cannot establish its own current device status | Keep ciphertext sealed and do not expose plaintext to the app | Process only after its current enrollment and session state pass the accepted checkpoint policy |
| The recovery root itself is suspected compromised | Do not accept a root-signed successor as proof that the root is still controlled by its owner; preserve the prior pin and require independent contact re-verification or a previously approved guardian rule | Cryptography rooted only in the compromised R cannot distinguish owner replacement from attacker replacement |

For an offline recipient, asynchronous delivery remains possible when the
sender obtains a fresh short-lived authorization and a relay accepts the
ciphertext before that authorization expires. The recipient may fetch it later.
If the sender cannot reach a relay before expiry, the event stays held until
the exact device can be freshly authorized again. This is the fail-closed
availability cost. A relay may withhold a revocation from a sender; local
monotonic pins prevent rollback only after the sender learns the update.

Messages already published, delivered, decrypted, or copied cannot be recalled
by revocation. A device with a copied old session key may read ciphertext
already addressed to that session. R5 can stop future sends only after the
sender's accepted authority/checkpoint state excludes that device. It cannot
erase an adversary's prior copies.

### Existing-session authorization window

The currently tested v2 response is a single-operation proof with a maximum
30-second lifetime. The verifier rejects reuse for another operation and
rejects an extended five-minute expiry. The current ratchet prototype also
uses a proof per outbound operation, but through the legacy v1 authority.

| Candidate | Benefit | Cost / exposure |
| --- | --- | --- |
| 30 seconds, current v2 cap | Small replay/use window for one proof; an unpublished event delayed by relay outage is held quickly | Requires another authority response for a later message; a longer outage holds delivery |
| 5-minute existing-session lease | Fewer authority round trips and better tolerance of short relay/authority outages | A single valid lease can remain usable up to five minutes after revocation; needs a new proof schema scoped to a session/device, not a per-operation response |
| 1-hour existing-session lease | Better tolerance of longer outages | Much larger stale-authorization period; high value if an endpoint or lease is compromised; also requires a new schema and replay controls |

Longer lifetimes do not bound a compromised old authority that can issue new
leases to peers still pinned to the old policy. Any lease duration bounds only
one issued authorization, and a partitioned peer cannot know a replacement
exists. The safe initial integration candidate is the current 30-second,
per-operation proof. Do not implement a reusable 5-minute or 1-hour session
lease without separate approval after testing its offline-availability value
and compromise window. A future reusable lease must bind the account,
recovery-policy epoch, exact registry head, sender and target device, session
id, purpose, expiry and unique lease id; each outbound event must still be
deduplicated and ratchet-committed atomically.

## Implementation milestones

### R5-A: Bridge independent device authority into the ratchet prototype

Files: `src/lib/deviceAuthority.js`,
`src/lib/deviceAuthorityPeerStore.js`, `src/lib/dmRatchetWire.js`,
`src/lib/dmRatchetTransactions.js`, `src/lib/outbox.js`, and their tests.

Replace the ratchet prototype's account-signed `deviceFreshness.js` check with
the v2 policy-pinned response. A challenge must identify the authenticated
requester device, target device, purpose, operation id, exact policy epoch and
exact registry head. New session establishment and first-prekey publication
must require this proof; no v1 freshness fallback may authorize a v2 session.
Bind the accepted authority and target device to the immutable session and
outbox record. Keep NIP-44 compatibility readers outside this path.

Tests: account-key-signed forgery, old-authority response, stale registry,
wrong recovery pin, wrong requester/target, wrong purpose/operation, replay,
expired proof, registry fork, revoked target, authority replacement and
recovery retry. A failed proof must leave database versions, prekeys, session
state and outbox unchanged.

Gate: No use of `src/hooks/useNIP44DM.js`; pass the focused adversarial tests
with multiple independently generated accounts/devices and browser IndexedDB.

### R5-B: Durable authorization and asynchronous outbox behavior

Files: `src/lib/dmRatchetTransactions.js`, `src/lib/outbox.js`, `src/db.js`,
`src/lib/outboxWriteAhead.js`, `src/lib/dmRatchetTransactions.test.js`, and
browser harnesses.

Represent authorization expiry and exact recipient device/policy head in the
durable outbox row. Commit encrypted event, ratchet state and authorization
metadata in one transaction. Before each actual relay publication, re-check
expiry. A relay rejection, browser restart, offline relay or expired proof
must preserve the same immutable event and not advance ratchet state during
refresh. A refresh may only authorize the same device at the same or newer
verified head. Revocation, conflicting updates or inability to refresh leave
the row held for explicit resolution; never silently route it to a new device.

Tests: lost acknowledgement and duplicate publish, two tabs refreshing the
same row, crash before/after database commit, relay outage past expiry, offline
recipient, withheld update, exact-event retry, stale generation, revoked
target and recovery replacement. Assert both wire events and IndexedDB state.

Gate: Browser tests prove at-most-once local application effects and no
unapproved relay publication after proof expiry. The relay remains
at-least-once; receivers must deduplicate by immutable event/session message
identity.

### R5-C: Contact recovery-key pin and replacement flow

Files: `src/lib/deviceAuthorityPinStore.js`,
`src/lib/deviceAuthorityTransport.js`, `src/lib/deviceAuthorityCheckpoint.js`,
contact/account UI modules only after reading `docs/VOICE.md` and
`docs/DESIGN.md`, plus browser/relay capture harnesses.

For initial contact verification, show a recovery fingerprint and QR or
safety-number representation on both sides. Contacts compare it through an
independent authenticated channel (in person or a previously verified channel
whose trust does not depend on the possibly compromised account secret). A
first pin signed only by the old Nostr account key is rejected. Later
replacement requires an R-signed successor extending the exact previously
pinned policy id by one epoch; update the local pin atomically before using
the new authority. Existing profile, Nostr key, contacts, conversation ids,
group references, orders, reviews and payment records remain unchanged.

Tests: same Nostr identity with different R, forged N-signed successor,
wrong R, stale predecessor, replay, concurrent successors, offline contact,
out-of-order transport, recovery replacement and restored/rolled-back browser
profile. Capture EVENT/AUTH/REQ frames and prove no recovery or account secret
is present in new private transport payloads.

Gate: Existing contacts can verify and recover without account-key TOFU; the
first-pin ceremony is independently reviewed for usability and social
engineering risk. A contact who never authenticated R cannot be safely
upgraded from a possibly compromised N key alone.

### R5-D: Recovery ceremony and secure backup

Files: `src/lib/deviceAuthorityRecovery.js`,
`src/lib/deviceAuthorityRecoveryPackage.js`, browser recovery harness and
onboarding UI only after voice/design review.

Keep the 24-word phrase as the primary offline recovery route. The optional
Argon2id-encrypted package is a second copy, never stored automatically or
sent to relays. Add a clear recovery fingerprint confirmation and an actual
restore exercise before allowing the user to discard the in-memory root.
Recovery replaces A and the primary D, advances the pinned policy epoch, and
does not restore ratchet/session state or authorize old devices. A stolen R
can replace A; a compromised root requires a separate key-migration decision.

Tests: wrong words/password, corrupt file, changed account/root pin, KDF
parameter tampering, backup leakage in localStorage/IndexedDB/log/network,
lost primary, lost R, compromised R, interrupted replacement, duplicate
recovery and offline contacts. Verify all private buffers best-effort clear;
do not promise JavaScript memory erasure. An adversarial test demonstrates
that a person holding R can produce a correctly signed authority replacement
that a peer pinned to R accepts; this is the expected consequence of R being
the root of trust, not a signature-verification bug.

Gate: Usability test confirms people can create, verify, store, and restore a
backup; recovery does not make ordinary devices holders of R or A.
Suspected compromise of R requires a separately trusted recovery step. A
guardian quorum, previously pinned independent witnesses, or out-of-band
contact re-verification can supply that trust, but each requires a user or
contact trust decision. R alone cannot securely rotate itself after theft.

### R5-E: Controlled DM migration, only after separate authorization

Files: `src/hooks/useNIP44DM.js`, ratchet send/receive adapters,
`src/lib/dmRatchetMigration.js`, `src/lib/dmRatchetTransactions.js`, database
schema, message/attachment/commerce adapters, and browser integration tests.

Keep existing NIP-44/NIP-59 messages readable. Start new Double Ratchet
sessions only after both participants have independently authenticated device
authority and prekeys. Never fall back silently if a new-session proof,
prekey, registry head or ratchet state is missing. Preserve attachments,
orders, receipts and payment payload semantics inside the authenticated
message adapter. Recovery restores account history only from existing
protected backups; it cannot recreate erased ratchet state without a separate
backup design.

Gate: Two independent browser accounts, ordinary relays, all device/replay/
outage cases, migration compatibility and commerce flows pass. Rollout needs
explicit approval after this plan; no code in this milestone is authorized
now.

## Witness decision

The 2-of-3 witness prototype has no operators or trust list. A real model
requires users to choose/pin three independent witnesses, define how those
witnesses are replaced, prevent one operator from controlling multiple keys,
and recover if fewer than two are reachable. It improves detection only when
two honest witnesses have already received the replacement and can answer.
A partition containing two stale witnesses may certify an old checkpoint;
censorship can make the quorum unavailable. Witnesses therefore remain
optional and must not be silently made a requirement. Recommended first
implementation: local recovery-root pins plus fail-closed holds. Revisit a
user-selected witness quorum only if measured contact-recovery failures make
the added trust and availability cost worthwhile.

## Stop conditions and rollback

Stop if the app cannot establish an independent first recovery pin, the
authority freshness source is stale or ambiguous, concurrent tabs disagree on
the checkpoint, the recovery root is unavailable, or no target device can be
freshly authorized. Do not resolve these cases with N-key signatures,
relay-roster inference, legacy encryption fallback, secret regeneration or
session reset.

Keep every step behind a protocol-version boundary until R5-E receives
separate approval. Preserve NIP-44 decryption and old conversation data. If a
new ratchet session fails before its initial transaction commits, discard the
tentative ratchet object and retry only from the exact durable state. If
outbound state and ciphertext committed but relay delivery failed, retry the
same immutable event only after refreshing authorization. If recovery or
contact pinning is interrupted, retain the last accepted checkpoint and
retry the exact signed successor; never accept an alternate branch by
generation number alone.

## R5 authority bridge implementation status (isolated, not production)

The following experimental bridge is implemented behind explicit module APIs
with no call site in `useNIP44DM.js`:

* `src/lib/dmRatchetAuthority.js` validates one sender proof and one exact
  recipient-device proof against their recovery-pinned policy and full
  registry chains. It seals both proofs and the ratchet ciphertext inside a
  NIP-59 message. Relay-visible EVENT fields contain no account or recovery
  pubkey; the recipient device pubkey remains visible and can correlate
  messages to that device.
* `commitRatchetOutboundV2()` in `src/lib/dmRatchetTransactions.js` stores the
  ratchet state, immutable wrapped event, authorization fence and sealed
  operation journal atomically. Concurrent tabs converge on one operation id;
  reusing it for changed application content fails. The outbox refuses a
  forced publication after the 30-second proof expires.
* `commitRatchetInboundV2()` checks the sealed message and both proofs, claims
  the operation id in IndexedDB, and then atomically persists receive state
  and a durable operation journal. Concurrent tabs cannot both claim an
  operation. An expired processing claim can be recovered after a crash, so
  the ratchet processor must only prepare a tentative transition and journal;
  application effects must run from the committed journal through the
  existing idempotent effect/order handlers.
* `deviceAuthorityTransport.js` now has a peer-contact update envelope, not
  only the older sibling-device envelope. It can deliver a primary-signed
  registry successor or a recovery-root candidate privately to a device in a
  separately pinned contact checkpoint. The peer store accepts only an exact
  predecessor. A new recovery root is only a candidate until the contact
  compares and confirms its full fingerprint independently; an account-key
  signature cannot complete that step.
* `deviceAuthorityContactVerification.js` provides a full SHA-256 fingerprint
  over account and recovery pubkeys. Its API checks the entered value, but
  cannot prove a person compared it out of band. A product UI must explain
  that comparison and require an explicit confirmation before calling the
  checkpoint replacement API.

Focused node tests and the isolated Chromium harness exercise independent
accounts, NIP-59 sealing, relay-visible fields, update/revocation delivery,
operation replay, real IndexedDB cross-tab races, expiry holds and reload
recovery. These tests do not exercise the application DM hook, a live relay
WebSocket, or vodozemac message processing.

### Remaining R5 release gates

1. The authorized browser harness has no relay subscription/request-response
   implementation for obtaining the recipient authority proof. The remote
   primary must be reachable to answer each operation. Without that proof,
   the send is rejected before the ratchet transaction. Authenticated update
   helpers also need relay subscriptions, durable retries, and app lifecycle
   integration.
2. The same 30-second proof is embedded in the immutable NIP-59 rumor. After
   expiry, the outbox holds the exact event and the receiver rejects it. There
   is no safe proof refresh for that immutable envelope yet. Strict expiry
   therefore limits delayed/offline delivery; accepting the proof at message
   creation time would permit a compromised sender to backdate a previously
   authorized message. A protocol decision is required before claiming both
   strict 30-second freshness and long-offline delivery.
3. The contact fingerprint and recovery-root candidate functions have no
   ordinary-user screens, QR scanning/display, or usability validation. A
   typed fingerprint check alone is not evidence of an independent channel.
4. The relay sees a stable recipient device pubkey in the NIP-59 `p` tag.
   This avoids exposing the account pubkey, but it introduces device-level
   cross-conversation correlation. Per-contact or one-time mailbox routing
   needs a separate protocol design before network rollout.
5. The receive transaction reserves ratchet state and a sealed inbox journal;
   commerce effects must be dispatched after commit through the durable
   idempotency ledger. No order/payment application path is connected to this
   experimental receiver yet.
6. `src/hooks/useNIP44DM.js`, legacy conversation reads, attachment adapters,
   contact/profile data, orders, reviews and payments remain unchanged. The
   old experimental v1 freshness helpers remain available to old harnesses;
   the new R5 methods never call them, but the old experimental API should be
   removed or fenced before the ratchet prototype becomes selectable.

No production protocol switch is justified until these gates, the ratchet
engine’s independent security review, browser/relay integration, and
compatibility tests pass. A held expired event remains sealed and durable; it
is not automatically re-encrypted or routed to another device. User-facing
recovery must retain the last accepted checkpoint if the fingerprint ceremony
or storage commit is interrupted.
