# DM ratchet design and integration gates

Status: implementation design under evaluation. No production DM wire change
is made by this document. The plan preserves Nostr relays, NIP-59 transport,
the existing account key and historical NIP-44 reads.

The adapter experiment is built with Rust and a pinned `wasm-bindgen-cli`:
install the `wasm32-unknown-unknown` target, install
`wasm-bindgen-cli 0.2.128` with `--locked`, then run `npm run build:ratchet`
and `npm run test:ratchet-browser`. The generated binding and WASM files under
`src/lib/ratchet/wasm/` are build outputs and are ignored by Git. These
prototype tools remain behind explicit `build:ratchet`, `lint:ratchet`, and
`test:ratchet` scripts; the application build, lint, and test commands do not
depend on this not-yet-integrated WASM experiment.

## Threat model and target

The ratchet is intended to protect message content against a later compromise
of an endpoint's *current ratchet state*, after old message keys and superseded
DH private keys have actually been erased. A Double Ratchet can recover future
confidentiality after fresh authenticated DH input has been mixed into the
session; it cannot help while an attacker controls an endpoint or its identity
signing key. Relays remain able to observe the NIP-59 recipient tag, event
timing, approximate size, relay/IP metadata, and traffic volume. This work does
not add anonymity routing.

This design covers the ordinary conversation path in `useNIP44DM.js`; it does
not cover the separate direct NIP-44 key-grant path in
`src/lib/crypto/groupKeyDistribution.js`. That path carries group epoch keys
and remains a security-critical legacy control channel until a separately
verified MLS Welcome/key-package transport replaces it. The ordinary DM
ratchet must not be described as protecting group-key grants, and failure of a
future MLS Welcome must not fall back to a direct legacy grant for a group
already migrated to MLS. Existing non-MLS groups still require their present
compatible key-grant path during staged migration.

The protocol must cover ordinary text, commerce/order messages, read receipts,
typing, call signaling and app control messages sent through `sendDM()`. There
must be no new-message fallback to NIP-44 when session establishment or ratchet
storage fails. NIP-44 remains decode-only for historical messages and is used
only for explicit, versioned key-establishment control during a documented
transition if the final handshake requires it.

## Verified current execution path

`src/hooks/useNIP44DM.js` encrypts `sendDM()` payloads and typing indicators
with `conversationKey(accountSecret, peerAccountPubkey)`, then creates a NIP-59
signed seal and random-key gift wrap. Incoming live events and history unwrap
the gift wrap and seal, then use the same deterministic conversation key to
open the kind-4 rumor. `src/lib/giftWrap.js` and `giftUnwrap.js` provide
transport wrapping, not a message ratchet. The account secret remains the
long-lived decryption root for every recorded message.

The message table is encrypted at rest using the current unlocked vault key,
but the durable outbox stores signed events separately. A ratchet transition
must therefore atomically commit session state and ciphertext to the outbox
before the network publish. Incoming handling must atomically persist the
advanced session and a sealed, idempotent inbox journal before running
business side effects; otherwise a crash after decryption could advance the
ratchet and permanently lose the plaintext or skip an order/key-control action.

## Candidate and alternatives

### Conditional candidate: vodozemac Olm v2

The official Matrix `vodozemac` Rust crate implements Olm and Megolm and
contains an asynchronous 3DH session setup and Double Ratchet. Its published
crate is Apache-2.0 and its current source can be built for WebAssembly. The
default compatibility session uses an 8-byte truncated MAC. The crate has a
feature-gated experimental session v2 that uses the full MAC. Cipher would
need a thin, narrow Rust/WASM adapter around the library; it must not implement
or alter the ratchet itself.

The 2022 Least Authority report audited an older vodozemac revision. It did not
cover language bindings and listed findings, including the short MAC. That is
not a current independent review of the library release, the proposed adapter,
or Cipher. The experimental v2 mode is an explicit release gate: pin the crate,
verify both peers negotiate only that mode, inspect the wire/MAC behavior with
tests, and do not silently accept compatibility-mode sessions. The current
native and browser witnesses exercise this mode, including compromise recovery
after an authenticated fresh peer DH contribution. This is behavioral evidence
for the pinned library configuration, not evidence that the experimental mode
has been independently audited or is suitable for production. If the v2 API or
cross-platform build cannot be maintained safely, stop and reassess instead of
shipping the 8-byte compatibility mode.

### Current ratchet experiment results

`npm run test:ratchet` has seven native tests, including an excessive-gap refusal
that verifies the receive state remains usable afterward. The
compromise-recovery test copies
the recipient's encrypted current session state, confirms that the copy can
reject an already-consumed historical message key, then decrypt a message
while that state remains current. The live peer sends a fresh DH contribution;
the live pair continues, while the stale copied state cannot decrypt the next
message. `npm run test:ratchet-browser` repeats that scenario through the
generated WASM adapter in Chromium, alongside initial-session authentication,
duplicate rejection, skipped-message delivery and encrypted state restore.
This demonstrates historical-key rejection and recovery for this Olm v2 path
after the peer's fresh ratchet key arrives. It does not demonstrate recovery
while an attacker retains endpoint control, after account identity-key theft,
or through Cipher's NIP-59 transport, because the app send/receive path is not
integrated.

References: [vodozemac](https://github.com/matrix-org/vodozemac),
[vodozemac audit (2022)](https://matrix.org/media/Least%20Authority%20-%20Matrix%20vodozemac%20Final%20Audit%20Report.pdf),
[Double Ratchet specification](https://signal.org/docs/specifications/doubleratchet/),
[X3DH specification](https://signal.org/docs/specifications/x3dh/), and
[Sesame session-management specification](https://signal.org/docs/specifications/sesame/).

### Rejected for this integration without a separate design

- The official Signal `@signalapp/libsignal-client` distribution is native
  Node-oriented; Signal says using it outside Signal is unsupported. It is not
  an app-supported browser/WASM package.
- Matrix's high-level `matrix-sdk-crypto-wasm` owns its crypto store and
  Matrix device/request model. The current Cipher app needs a recoverable,
  atomic transaction across ratchet state, its message store and its Nostr
  outbox. The high-level store API has not demonstrated that transaction
  boundary.
- A handwritten JavaScript ratchet, a wrapper around an unreviewed fork, or a
  fresh crypto primitive is out of scope.

## Identity and first-message delivery

Ratchet credentials must be device-specific and account-authenticated. The
account signing key binds a device's identity key, signed prekey and prekey
generation to the user's existing Nostr account. Peer fingerprints must cover
the authenticated account/device binding and be compared through the existing
safety-number or another reviewed verification flow. A changed identity or
device set must not silently establish a trusted replacement session.

Prekey distribution must support an offline recipient without trusting a relay
to authenticate the bundle. A bundle is accepted only after verifying its
account signature, key id, protocol version, expiry, and binding to the
recipient. Since Nostr relays cannot atomically consume a one-time key, the
design must not claim exactly-once one-time-prekey semantics: a malicious or
replicating relay may hand the same signed bundle to multiple senders. The
receiver must safely handle duplicate initial messages and retain the matching
private prekey until a documented delivery/expiry condition. Replay, stale
bundle and account-key-change behavior must be tested. If a recipient has no
valid bundle, a sensitive message remains locally pending and the UI reports
that session setup is required; it is never sent by NIP-44 as a fallback.

Publicly account-signed key-bundle events make the account-to-device binding
visible to the publishing relay. An encrypted mailbox request/response avoids
that public listing but cannot support first contact to a recipient who stays
offline. This is a real availability/privacy trade-off. The initial design may
use signed public bundles only if captured-frame tests and the privacy review
accept this exposure; otherwise first-contact sending must wait for a private
response. No globally reusable device identifier is required: use a random,
account-scoped device id and rotate it only through an authenticated device
transition.

## State, retries and crash recovery

1. Each device owns independent ratchet accounts and sessions. Ratchet private
   state is serialized only inside the local account database and sealed under
   a key derived from the unlocked vault secret with domain separation and
   authenticated database/account/session identifiers.
2. Outbound: serialize access to a conversation/device session; operate on a
   clone of the stored ratchet state; encrypt once; then atomically write the
   new state and immutable NIP-59 event into the durable outbox. Only after that
   transaction commits may relay publishing start. Retries resend the exact
   stored event and never ratchet again.
3. Inbound: verify NIP-59 seal/hash first; deduplicate by immutable wrap and
   inner message ids; decrypt using a cloned ratchet state; then atomically
   write the new state and a sealed inbox-journal row. Application processing
   is idempotently resumed from the journal, and the journal is deleted only
   after message storage and required local side effects are durable.
4. Out-of-order messages use the library's bounded skipped-key support.
   Duplicate, too-old, excessive-gap and malformed messages are rejected
   without committing partially advanced state. Limits and retention for
   skipped keys are explicit and covered by tests.
5. Concurrent tabs/devices cannot mutate the same session copy. Web Locks or
   an IndexedDB compare-and-swap lease must guard each local session, with
   transaction version checks. Separate devices use separate ratchet sessions.
6. Lock clears plaintext state and in-memory library objects. A vault lock
   during a transition leaves either the pre-transaction state or the complete
   committed state. At-rest corruption is an explicit recovery error; no
   replacement secret is generated.

## Migration and recovery

- Existing bare kind-4 messages and NIP-59-wrapped NIP-44 payloads remain
  readable through the existing decoder, explicitly labeled legacy. No old
  event is rewritten or re-encrypted.
- New payloads carry a versioned ratchet envelope inside the existing sealed
  rumor. A client may send a new ratchet message only to an authenticated,
  supported peer device. Mixed-version peers require explicit upgrade; there
  is no silent weaker-content fallback.
- Existing same-account installs do not possess a shared ratchet state merely
  because they restore the same Nostr account key. Each install must enroll as
  a new device. Adding devices, revoking devices and authenticated state
  transfer require the Phase 3 design. Until that is implemented, the Phase 1
  rollout must not claim safe multi-device continuity.
- Reinstall without an encrypted state backup creates a new device and fresh
  sessions. Old ratchet messages that were never locally stored may be
  unrecoverable; Nostr account recovery alone cannot reconstruct erased
  message keys. There is no silent reset of an existing session.
- A backup can only restore the state at its creation time; it may replay old
  ratchet state. Backup restore must be rollback-detectable or must force a
  fresh authenticated session before sending. The safe, device-sync design is
  part of Phase 3, not inferred from account-key recovery.

## Definition of done

- [ ] Library and adapter versions are pinned; browser and supported native
  targets build from reproducible sources, with license notices preserved.
- [ ] Independent endpoints establish an account-authenticated device session
  using the chosen prekey protocol; invalid signatures, stale/replayed bundles,
  wrong peers and changed keys fail closed.
- [ ] Ratchet tests prove out-of-order, duplicate, replay, excessive gap,
  corrupted state, old-key theft and future recovery after fresh authenticated
  DH input, using the actual library implementation.
- [ ] IndexedDB tests prove atomic state+outbox and state+inbox-journal commits,
  crash/retry behavior, concurrent-tab exclusion and lock/unlock handling.
- [ ] Browser tests exercise two independent devices over the existing Nostr
  transport, including offline prekey delivery and relay refusal.
- [ ] Historic NIP-44 content remains readable; sending without a valid ratchet
  session never publishes NIP-44 content.
- [ ] Multi-device limitations and restore behavior are accurately represented
  in product copy before the rollout is enabled.

## Cipher DM protocol v1.0.0-review-1 candidate packet (2026-11-09)

Status: design packet for independent review; **not approved, implemented, or a
production migration authorization**. The current live path remains
NIP-44/NIP-59. This section converts the existing ratchet notes into a
versioned candidate and makes its unresolved decisions visible. It does not
claim compatibility with Signal, SimpleX, or Matrix wire formats.

This frozen document revision is identified as
`cipher-dm-v1-review-candidate-r1`. Its SHA-256 is recorded in
`docs/CIPHER-DM-V1-REVIEW-HANDOFF.md` after the packet contents are finalized.
It freezes candidate prose and semantic test cases only. It does not freeze a
production encoding: canonical bytes, signature profile, and even the final
ratchet-library mode remain independent-review blockers. The staged
application tree is not a protocol source commit; a reviewer must receive an
exact source snapshot after the implementation checkpoint is approved and
frozen.

### NIP-59 encapsulation blocker discovered during source review

The current wire sketch cannot yet be described as NIP-59-conformant. The
upstream NIP-59 text requires NIP-44 encryption of the serialized rumor and
seal event. This candidate says the seal and wrap are encrypted to a route key,
but does not name NIP-44, specify the serialized inputs, or show the two
encryption layers around the ratchet ciphertext. It also assigns the seal
signature to device key `Dᵢ`; that is a Nostr key in the current authority
prototype, but the wire spec must state that this device key is the seal's
authenticated author and how the receiver maps it to account `N`.

Until those fields are explicit and interoperability-tested, the candidate
only borrows NIP-59 event kinds and routing. It is not proven compatible.

Two designs remain open for protocol review: (1) specify standard NIP-44
encryption of the serialized kind-14 rumor to the recipient route key and of
the kind-13 seal to that route key, with the ratchet ciphertext remaining the
only application payload; or (2) define a Cipher-specific NIP-01 event
transport and stop calling it NIP-59. Option 1 adds NIP-44 envelope work and
requires exact sender-key, recipient-key, and account-mapping rules. No choice
is made here. Either design must state which key signs each event, what exact
bytes that signature covers, how the recipient device route is authenticated,
and whether the wrapper adds any extra recipient or sender correlation. The
current proposed `device_sig` fields and their domain-separated canonical
bytes are placeholders, not established by NIP-01 or vodozemac. Do not
generate protocol KATs from them.

### Security goals and exclusions

Protect message content and forward secrecy between enrolled device pairs;
authenticate each account/device binding through pinned `R/A/Dᵢ` authority;
reject replay, stale authority, revoked devices, downgrade, and ambiguous
state; commit ratchet state and durable delivery records atomically. Keep
existing Nostr profile, vendor, order, review, and payment identity intact.
Preserve legacy history reads.

The protocol does not protect a compromised live endpoint, an attacker holding
the account signing key or current device secrets, relays from traffic
analysis, or already copied messages. Relays can observe connection IP,
timing, approximate sizes, relay choice, volume, subscription/query behavior,
and current NIP-59 routing tags. NIP-59 hides the inner sender from a relay; it
does not hide the recipient route or network source IP. Scoped routes can
reduce account-key correlation only after authority-authenticated enrollment
and rotation. They do not provide IP anonymity.

### Candidate operation and delivery-attempt schemas

The candidate keeps Nostr gift-wrap transport but versions the encrypted
rumor. It separates one immutable ratchet operation from one or more
individually authorized delivery attempts. This split is required for
authorization refresh; the current prototype does not implement it. Exact
field names and types below are a review target. Byte-level key, signature,
and ratchet encoding remains contingent on the crypto-profile decision below.
JSON objects are UTF-8, duplicate keys are invalid, integers are unsigned
decimal integers, and opaque bytes use unpadded base64url.

```json
{
  "v": 1,
  "type": "cipher.dm",
  "op": "<128-bit random operation id>",
  "sid": "<256-bit random device-pair session id>",
  "from": { "account": "<N pubkey>", "device": "<D id>" },
  "to": { "account": "<N pubkey>", "device": "<D id>" },
  "ratchet": { "dh": "<opaque library public key>", "n": 0, "pn": 0 },
  "ciphertext": "<opaque library ciphertext bytes, base64url>",
  "device_sig": "<Dᵢ signature over domain-separated canonical operation bytes>"
}
```

`op` is unique per logical device-pair operation and authenticated inside the
ciphertext; `sid` is never reused after session reset. `from` and `to` are
authenticated device identities, not relay destinations. Every recipient
device gets a distinct session and ciphertext; there is no shared account
session or account-wide group key. Unknown fields, duplicate fields, invalid
base64url, out-of-range counters, a mismatched account/device binding, or
unsupported `v` fail closed. A v1 reader never interprets a legacy payload as
v1 based on content heuristics. The operation digest is SHA-256 over the
protocol domain string plus the exact canonical immutable operation bytes;
the final canonicalization and signature suite remain review blockers. The
application payload must be the plaintext input to the ratchet and appear only
after authenticated ratchet decryption. It must never be duplicated in a
parallel clear field inside the NIP-59 rumor.

Each delivery attempt embeds the same immutable operation bytes and this
separate envelope inside the NIP-59 seal:

```json
{
  "v": 1,
  "type": "cipher.dm.delivery",
  "delivery_id": "<128-bit random attempt id>",
  "op": "<operation id>",
  "operation_digest": "<SHA-256 of immutable operation bytes>",
  "from": { "account": "<N pubkey>", "device": "<D id>" },
  "to": { "account": "<N pubkey>", "device": "<D id>" },
  "authority": {
    "sender_policy_id": "<exact locally pinned policy event id>",
    "sender_registry_id": "<exact locally pinned registry head id>",
    "recipient_policy_id": "<exact contact-pinned policy event id>",
    "recipient_registry_id": "<exact contact-pinned registry head id>"
  },
  "expires_at": 0,
  "sender_proof": "<single-operation sender authority proof>",
  "recipient_proof": "<single-operation target-device proof>",
  "device_sig": "<Dᵢ signature over this attempt and operation digest>"
}
```

The unsigned inner Nostr rumor is kind 14, with content carrying the operation
and one delivery envelope. It is sealed as kind 13 (empty tags) and wrapped as
kind 1059, with a public `p` tag naming the recipient's current route public
key. The kind-13 seal is signed by the authenticated sender device `Dᵢ` and
has no tags; the outer kind-1059 wrap is signed by a fresh one-time key. The
seal and wrap are encrypted to that route key. This uses NIP-59's
routing mechanism but defines Cipher's own encrypted operation and delivery
schema; it does not reuse NIP-17's message format. One outer wrap targets one
recipient device route. A route key is contact-scoped and distinct from `N`,
`A`, and the globally stable device signing key `Dᵢ`; the authenticated local
contact record binds the route to the target device. The decrypted `to.device`
must match that verified binding. The route binding is not publicly listed.
The proposed confidential route-binding record contains `{v, owner_account,
owner_device, peer_account, route_pubkey, route_generation, previous_route_id,
created_at, expires_at, policy_id, registry_id}` and a signature by the
currently authorized owner device. It is delivered only inside a previously
authenticated contact channel or verified out-of-band. The recipient checks
that `owner_device` is active at the pinned head, `peer_account` is its own
account, generation extends the exact saved predecessor, and the route key is
not already assigned to another local contact/device pair. This schema is
design-only; routes are not in the existing public R/A/D registry.
NIP-59 defines encapsulation, not the DM protocol; NIP-17 is a separate
convention with kind-14 messages and sender/receiver fanout. Cipher should
review its own sender-copy and multi-device history behavior instead of
assuming NIP-17 semantics.

**Current prototype mismatch:** `dmRatchetAuthority.js` builds kind-4 rumors,
uses the stable recipient-device public key for the NIP-59 `p` tag, and embeds
the authority proofs in the immutable rumor. The v1 candidate instead requires
kind 14, a contact/device-scoped route key, and a separate delivery envelope.
The prototype provides adversarial helper evidence only; it does not match
this wire candidate and must not be called v1 evidence. Live application DMs
remain the existing NIP-44/NIP-59 kind-4 path.

**Local capture baseline (2026-11-09):** `docs/evidence/cipher-dm-local-nip01-relay-capture-2026-11-09.json`
records two synthetic Chromium clients on a disposable loopback NIP-01 relay.
The ordinary app path sent kind 1059 with a one-time outer pubkey, an account
`p` tag for the recipient, and an `expiration` tag; its relay-visible `REQ`
included account-key DM filters and `since`. The captured event's encrypted
content did not contain the plaintext, and the wrapper pubkey differed from
the sender account key. A real browser socket handoff reached the local relay,
which returned `OK`; the other client received the subscription event,
decrypted it, and saved the message. The same local relay stored an isolated
R5 fixture, suppressed the first acknowledgement, then accepted a retry whose
signed EVENT JSON was byte-identical. The capture reports local relay arrival
and ACK times and loopback socket endpoints. It does not show a public relay,
anonymity, or live ratchet execution. The R5 fixture embeds short proofs in the
immutable NIP-59 event; expiry therefore makes that event unusable at receipt
and cannot be fixed by changing only local outbox metadata. A refreshed
envelope is a candidate design in this packet, not an implemented wire format.

Recorded baseline details: the ordinary test message was event
`b1021e6cbd5e47d1f83612fb8b01768a7ec2fb304e50dc59fb6484928378bda0`, kind
1059, `created_at=1794098126`, outer pubkey
`899dd9ed64d5c8424da140d9768ba4dab4b76151241a15ff8103b31f633071f2`, `p`
tag `857ccdf8a26aa0ea206ec6b37c31b29e99a9f03cf8de2367a74fd085578b4146`,
expiration `1796690126`, and 3,504 UTF-8 content bytes. The two DM queries
included `{kinds:[4,1059],"#p":[recipient N],since:1794005311}` and
`{kinds:[4],authors:[recipient N],since:1794005311}`. The R5 fixture event
`6b37ba42ec7d69a4b923042a5ffd80f1b4e133c4769c097c69c51197d213b53a` was
sent at relay-capture time `1794264513559`; the relay stored it but recorded
`TEST_DROP_ACK` at `1794264513572`. The retry used the same id and full event
object at `1794264513934`; the relay acknowledged it at `1794264513954`.
`exactRetryFramesEqual` was `true`. The artifact contains the full captured
NIP-01 JSON event objects (including encrypted content and signatures), query
filters, and local socket endpoints; it contains no plaintext.

Protocol references for the event and encryption layers and compared convention are
[NIP-01 Basic Protocol](https://github.com/nostr-protocol/nips/blob/master/01.md),
[NIP-44 Encrypted Payloads](https://github.com/nostr-protocol/nips/blob/master/44.md),
[NIP-59 Gift Wrap](https://github.com/nostr-protocol/nips/blob/master/59.md),
[NIP-17 Private Direct Messages](https://github.com/nostr-protocol/nips/blob/master/17.md),
and [NIP-65 Relay List Metadata](https://github.com/nostr-protocol/nips/blob/master/65.md).
These are moving upstream documents; a review release must pin exact source
revisions rather than treating these links as a protocol version.

Each attempt also has a **local durable outbox row**, not relay-visible wire
content:

```json
{
  "v": 1,
  "purpose": "dm.publish",
  "op": "<same operation id>",
  "delivery_id": "<same attempt id>",
  "event_id": "<exact immutable NIP-59 event id for this attempt>",
  "from_device": "<D id>",
  "to_device": "<D id>",
  "policy_id": "<exact pinned policy event id>",
  "registry_id": "<exact pinned registry head id>",
  "expires_at": 0,
  "proof": "<authority proof bytes>"
}
```

This row binds one publish attempt to the immutable operation, target, exact
event, and authority head. It is sealed locally. The durable operation row
keeps the ratchet transition and ciphertext stable; a refresh creates a new
delivery envelope and new NIP-59 wrapper but does not call the ratchet again.
The receiver verifies each proof at receipt and deduplicates by authenticated
`op` plus `operation_digest`; mismatched digests are protocol conflicts. An
attempt's `device_sig` and operation `device_sig` are verified against the
currently accepted device keys. Signature algorithm, canonical byte
encoding, and authority proof response schema remain crypto-profile review
blockers. Retry uses byte-identical event bytes while the attempt is
unexpired or acknowledgement is uncertain. What authorizes a replacement
attempt and how an offline receiver treats an expired old attempt remain
explicit R5-B decisions. No attempt refresh is implemented by the current
prototype.

### State machine and durable invariants

Outbound state transitions:

```text
idle
  -> authority_pending
  -> prekey_verified (new session only)
  -> prepared (clone ratchet; no durable state change)
  -> committed (atomic ratchet state + immutable operation + first envelope/event + op journal)
  -> publishing
  -> acknowledged | held | retryable
  -> authorization_refresh (same operation, no ratchet advance)
  -> committed_new_attempt (new proof/envelope/wrap, same operation digest)
```

Missing, expired, stale, forked, or revoked authority; invalid prekey; stale
account incarnation; storage failure; or transaction abort returns to a held
state with no ratchet advancement and no publish. After commit, retry of an
attempt uses its exact stored event bytes and id. A lost acknowledgement
remains uncertain and retries that same event while its envelope is valid. A
later attempt may have a different outer event id but must carry the exact
same immutable operation and digest; the receiver applies the operation at
most once. Whether to create a new attempt during unresolved acknowledgement
and how long the receiver accepts a delayed attempt require explicit
security/product acceptance before coding.

Inbound transitions:

```text
received -> outer_verified -> route_verified -> authority_verified
         -> decrypted_prepared -> committed_inbox_journal
         -> effects_applied -> journal_completed
```

Any failure before `committed_inbox_journal` leaves the prior ratchet state
unchanged. The inbound transaction atomically stores advanced ratchet state,
the authenticated operation digest, seen attempt/event ids, `op`, and sealed
application journal. A duplicate `op` with the same digest does not advance
state or repeat effects; the same `op` with a different digest is a conflict.
Operation dedupe must survive supported backup/restore or restored ratchet
state must be forced into a fresh session. Out-of-order delivery uses only the
selected library's bounded skipped-key mechanism. One device pair cannot share
state with another device pair.

All local operations bind the captured account incarnation. The transaction
must contend with the same lifecycle marker as account retirement. Before
publish, the sender rechecks the incarnation and proof expiry. A concurrent
tab uses a session lease or compare-and-swap version; conflict aborts and
re-prepares from the winning state without reusing the operation id or nonce.
Database failure is visible as held/error, never as a send success.

### Device authentication, prekeys, and downgrade rules

The authenticated registry binds random account-scoped device id, signing and
agreement public keys, credential generation, lifecycle state, and prekey
bundle generation to the exact account policy. A prekey bundle must carry a
version, account and device ids, policy epoch/id, registry head id, key ids,
signed-prekey expiry, and signature from the enrolled device key; it is
accepted only under the independently pinned `R` policy and exact registry
head. Initial session creation and prekey publication both require current
R5 authorization for requester, recipient, operation, and purpose. The old
account-signed `deviceFreshness` mechanism cannot authorize this protocol.

One-time prekeys are best-effort under ordinary relays: relays can replay or
fan out a signed bundle, so no exactly-once consumption claim is valid. The
receiver retains matching private prekey state until delivery/expiry rules
permit retirement. Duplicate initial messages are idempotent; stale bundles,
wrong recipients, replayed generations, account-key changes, and revoked
devices hold or reject. Missing prekeys hold the outgoing message locally.

Candidate fanout is one independent ratchet session, operation id, ciphertext,
and delivery envelope per active recipient device in the exact pinned
registry. No session or ciphertext is shared across devices; revoked devices
are excluded, and newly enrolled devices do not receive old messages by
re-encryption. The sending device stores its own copy locally. Sending
additional copies to the sender's other devices requires separate
device-to-device sessions and a defined “sent history sync” effect; this
candidate does not silently add those copies. Product must choose whether
cross-device sent-history sync is part of the first test-account release.

Readers accept the explicit v1 marker only. Unknown mandatory versions,
ambiguous version tags, downgrade attempts after a contact/device negotiated
v1, and silent NIP-44 send fallback are rejected. A legacy peer remains on
legacy sending only until a user-visible enrollment/upgrade boundary is
approved; v1 is not inferred from a peer's Nostr identity. Legacy NIP-44
history remains readable and is never rewritten.

### Recovery, migration, and metadata policy

Restoring the same Nostr `N` does not restore a device identity or ratchet
state. The restored install enrolls a new `Dᵢ`, authenticates a fresh session,
and cannot decrypt messages absent from its local history or an independently
reviewed encrypted backup. Restoring an older ratchet backup is rollback and
must be detected by an authenticated checkpoint or force fresh sessions
before sending. Revocation cannot recall published ciphertext or erase
already copied plaintext. Contacts that have not accepted a recovery-root
successor remain pinned to the old head and are held for sensitive operations.

Private routing is a required design and release gate after authority and
device rotation. The shared Nostr account key remains the public profile,
vendor, order, and reputation identity. A private delivery route is a scoped
capability; it must not replace or silently unlink public vendor history.

### Open delivery and recovery policy choices

The recommended defaults below are engineering-safe proposals, not product
decisions. Product must select supported behavior and user-facing language
before implementation. Current code implements none of the envelope-refresh
candidate.

| Question | Recommended fail-closed default | Alternative | Explicit UX cost and decision still needed |
|---|---|---|---|
| Offline delivery vs short proof expiry | Require fresh sender and recipient authority at publication and receipt; hold an expired attempt. If acknowledgement is uncertain after expiry, do not create another operation. A reviewed future envelope may retry the same committed operation digest only after fresh proof. | Accept a bounded authority lease, or use a relay receipt as evidence that the event arrived before expiry. | Strict expiry may delay or lose offline delivery and require the recipient authority to be reachable; leases widen the revocation window and relay receipts add trust. Product must choose maximum offline age, clock-skew policy, and whether relay-held late events are rejected. |
| Dedupe and backup retention | Retain the authenticated operation digest and effect journal for every supported retry and backup-restore window. If restore cannot prove the journal is current, hold and require a fresh device-pair session. | Prune journals sooner to reduce local storage, accepting a bounded replay risk after rollback or backup restore. | Safer retention uses disk and backup space; a forced fresh session can interrupt use and may make old unsaved history unavailable. Product must define backup retention and history-recovery promises. |
| First-contact availability | Require QR or another independently verified channel to exchange the recovery fingerprint, enrolled device identity, route, and prekey. Do not send until that trust ceremony completes. | Publish an account-signed route/prekey directory, or send a private request to a known account route. | The verified-channel default blocks asynchronous first contact until both people coordinate. A public directory is more available but exposes an account-to-route/device association; a private request still exposes first-contact linkage. Product must choose allowed discovery channels and label their metadata. |
| Uncertain acknowledgement after proof expiry | Keep the operation held and show “delivery status unknown”; never advance the ratchet or silently send a new operation. Only after reviewed dedupe/envelope semantics may a refreshed attempt reuse the same digest. | Send a new attempt despite unresolved acceptance, relying on receiver dedupe. | Holding can leave the user waiting; sending can produce delayed duplicates if receiver state was rolled back. Product must choose whether an explicit “retry safely” action is exposed after the protocol gate. |

These defaults preserve the shared account/vendor identity model: public vendor,
order, review, and reputation events remain signed under the existing account
key. They do not silently replace that identity with a pseudonym. The private
route applies only to DM delivery; route compartmentalization and sender-IP
privacy are separate properties.

#### Relay/operator visibility map

| Observer | Visible in current NIP-44/NIP-59 path | Candidate v1 if it uses NIP-59 | Residual correlation |
|---|---|---|---|
| Message relay receiving `EVENT` | `kind=1059`; one-time random outer `pubkey`; signed `created_at`; public `p=<account N>` and `expiration` tags; event id/signature; encrypted `content` length/bytes; publish time, connection IP, and relay result. Current helper backdates `created_at` by up to two days and sets `expiration=created_at+30 days`. | Same outer fields, but `p=<contact/device route key>`; content remains an encrypted NIP-59 seal and reveals no inner kind/identity. Repeated route values still link deliveries to that route. | Direct WebSocket exposes sender source IP to the relay. Relay sees activity and route-level frequency. A relay may also correlate identical event ids published to multiple targets. Outer time randomization does not hide socket arrival time. |
| Relay handling client `REQ` | DM filter includes `{kinds:[4,1059], '#p':[account N], since}` and a legacy `{kinds:[4], authors:[account N], since}` filter. The relay sees account-key lookup and requested time range. | Client must subscribe to `#p` route(s). A batched list of routes reveals they belong to one client/query; separate subscriptions on the same IP/socket still permit correlation. | Churn, reconnects, `CLOSE`, relay selection, query timing, and route-set size remain visible. |
| Sender ISP/local network | Direct relay endpoint, DNS/network destination, source IP, connection duration, and traffic volume; encryption hides payload. | A local privacy path can change the destination/source visible to each hop but introduces an additional observer and traffic pattern. | A VPN shifts trust to its operator; it does not make traffic anonymous from the VPN or relay if the route is direct from VPN exit. |
| Recipient/contact | After opening the seal: sender N/device, target D, operation id, delivery attempt, plaintext, and the authenticated route mapping. | Same, plus proof/head details and route lifecycle. | The contact intentionally knows identity and message history; this protocol does not provide sender deniability against the contact. |

This map is a design/source audit, not a packet capture. Current source
behavior is documented in `src/lib/giftWrap.js`, `src/lib/dmSubscription.js`,
`src/lib/dmRelays.js`, and `src/hooks/useNIP44DM.js`. Current rumor padding
targets 640 JavaScript string code units before NIP-59 wrapping; Unicode,
JSON, envelope overhead, and long messages mean this is neither a fixed byte
size nor a constant-size wire event.

#### Scoped-route lifecycle and hard cases

Candidate route identifiers are independent random Nostr-compatible route
keypairs, at least 128 bits of entropy, generated separately for each contact,
direction, and target device. The route private key is sealed on that target
device and bound locally to its authenticated `Dᵢ`; route public keys and
contact mappings are not posted in a public directory. Sender and receiver
hold distinct directional routes. Each contact/device route has a generation,
creation time, status, associated account/device authority checkpoint, and
retirement time in local encrypted state.

1. **First contact:** privacy-preserving asynchronous delivery requires the
   sender to already know an authenticated route and usable prekey. Safest
   default is an independent QR/verified-channel exchange of recovery
   fingerprint, device identity, route, and prekey bundle. A public account-
   signed directory supports offline discovery but reveals the N-to-device/
   route binding. A private request to a known account route still exposes
   first-contact linkage. If neither route nor recipient is online, private
   first-contact discovery is unavailable. Product must choose which
   availability path to expose and label its metadata cost.
2. **Offline recipient:** an already-known route can receive a regular
   persistent gift wrap while the device is offline. This is not enough for
   the current R5 proof rule: strict receipt-time expiry can reject the event
   after a relay stored it. Also, current v2 freshness proof generation needs
   the recipient's primary authority `A` to answer a challenge even when the
   target device itself is offline. The app has no request/response transport
   for that exchange. These are distinct availability limits in the R5-B
   matrix. No message may bypass them with legacy NIP-44.
3. **Add, revoke, and rotate:** authenticate route creation and replacement
   to exact `R/A/Dᵢ` heads; deliver successor only over a previously verified
   route or independent contact ceremony. Revoke the route and Dᵢ locally,
   stop sending to it after the successor is accepted, and generate a fresh
   scoped route. Offline contacts remain at old pins and are held for
   sensitive sends; no account-key fallback. Preserve old route secrets only
   for an explicit bounded history/retry window. Previously accepted wraps,
   copied route secrets, and relay-held ciphertext cannot be recalled.
4. **Abuse and enumeration:** random routes must not be enumerable. Inbound
   controls need per-route quotas/rate limits, bounded decrypt work, duplicate
   suppression, and a report/block path. Proof-of-work may shift cost to mobile
   senders and is not selected without measurement. A relay may still rate
   limit by source IP, and anonymous routes can be used for harassment.
5. **Query leakage:** querying many route `p` tags together reveals a
   contact/device route set to that relay. One filter per route reduces that
   direct grouping but same-IP connection logs and synchronized polling still
   correlate the set. Route-specific relay selection can split observers but
   does not hide the publisher IP from each directly contacted relay.

#### IP path and traffic-shaping options

| Option | What the destination sees | Tradeoff / status |
|---|---|---|
| Direct relay connection | Sender IP, destination, route tag, event bytes, timing. | Implemented today; fails sender-IP protection. No anonymity claim. |
| VPN or single forward proxy | Relay sees VPN/proxy egress IP; provider sees source IP and usually destination relay. | Moves trust to one operator, who can join source and destination. Not an anonymity guarantee. |
| Tor/onion path | Relay sees an exit/onion-side connection; entry observes source connection; paths may be correlated by timing/volume. | Design-only; browser WebSocket support, exit availability, relay blocking, and UX are unproven. |
| Independent ingress/egress relay | Ingress can see source IP and ciphertext/size/time; egress sees destination route and forwarded event. | Design-only; operator separation, encrypted forwarding, batching, replay, abuse, and ingress/egress collusion need review. Low-latency forwarding alone still permits timing joins. |

No option is implemented in this DM candidate. IP protection is a distinct
transport gate from route compartmentalization. The project must specify which
platforms (web/desktop/mobile) require it and what operator collusion is in
scope before release. For traffic analysis, compare no mitigation, padding
buckets applied after all envelope overhead, randomized batching, and optional
cover traffic. Measure AUC for route/contact and timing/size classifiers,
p50/p95 delivery delay, bytes per logical message, CPU, battery, and relay
cost. The existing gameplan's draft targets (AUC ≤0.55 one hop, ≤0.65 two
specified colluding hops, ≥25% classifier improvement, p95 online delay ≤3s,
and average bytes ≤2× baseline) are proposed acceptance limits, not approved
product requirements; reviewers and product must ratify or replace them.

#### Required wire-capture acceptance

Capture the exact staged test build from two independent accounts and at least
two devices each on ordinary relays. Preserve decrypted test-event metadata
locally for analysis and export sanitized wire frames only. Record for every
relay/operator: full `REQ`/`CLOSE`, `EVENT`, `OK`, `EOSE`, and `CLOSED` JSON;
outer `kind`, `pubkey`, tags, `created_at`, content byte length, event id,
expiry, publish/arrival/ack timestamps, relay URL/operator, socket source and
destination IP, reconnects, and subscription duration. Include sender and
recipient route queries, profile/kind-10002 queries, prekey lookup, failed
relay, late delivery, duplicate attempt, route rotation/revocation, and the
same users' public vendor/profile events. Desktop and web must be measured
separately. The capture must show which operator sees N, each opaque route,
device id, sender IP, and event timing, plus which operator pairs could join
them. Do not label mocked relay frames as live evidence.

Acceptance is zero `N/R/A` or stable `Dᵢ` values in ordinary route tags and
queries, no public `N→route` mapping, correct refusal of revoked routes, and a
documented per-hop IP view for each supported platform. Quantify route-to-
account/contact inference and timing/size classifier performance against
baseline. The public account remains visible on vendor/reputation surfaces by
design; local user IP/time correlation can still link those surfaces with DM
traffic absent an IP-protecting path. No anonymity/parity claim follows from
passing route-tag checks alone.

Make those checks reproducible with these candidate thresholds and fixtures:

- In two accounts × two devices × at least ten contacts, generated route keys
  contain at least 128 bits of CSPRNG entropy, are unique per contact,
  direction, and device, and no route value repeats across contacts. A static
  schema scan and captured `REQ`/`EVENT` corpus must find zero account `N`,
  recovery key `R`, authority key `A`, or stable device id `Dᵢ` in ordinary
  DM route tags/filters. This intentionally differs from public profile,
  vendor, order, review, and reputation events, where the existing account `N`
  remains the signing identity.
- No relay-observable or public event creates a `N→route` mapping. Route
  rotation after device revocation must make the old route produce zero new
  accepted sends after the exact authority successor is pinned; held/offline
  contacts remain visibly pending until they accept it. Count attempts and
  accepted deliveries for the old and new route in browser traces.
- Regression fixtures must retain the same account signature and vendor
  reputation/history association before and after private-route enrollment and
  rotation. All legacy NIP-44 history remains readable; no receipt or review is
  rewritten under a new identity. Pass rate: 100% on the fixed commerce and
  history corpus.
- For a seeded corpus with separate accounts, contacts, message classes, and
  online/offline schedules, train on 70% and report held-out route-to-account
  and activity/timing/size classifier AUC with participant-separated folds.
  Proposed review targets are ≤0.55 for one relay and ≤0.65 for the named
  two-hop collusion model, at least 25% lower timing/size AUC than current
  baseline, p95 online delivery ≤3 seconds, and average wire bytes ≤2× the
  current same-payload baseline. Product and the independent reviewer must
  ratify or replace these targets before privacy claims or rollout.
- For each supported platform, record source IP at every relay/operator hop.
  Direct WebSocket transport is an explicit fail for sender-IP protection; it
  may pass the route compartment gate while remaining blocked on the IP gate.
  A product claiming IP protection must show that no single in-scope operator
  observes both client origin IP and DM route, and test specified collusion,
  timing, outages, and browser capability. Without that evidence, copy must
  say the relay can observe the connection IP.

### Review handoff and evidence checklist

Before opt-in test-account integration, reviewers receive a commit-pinned
packet containing this spec, authority and lifecycle decisions, source and
dependency revisions, matching unit/browser tests, reproducible build notes,
and an evidence index. Do not treat the current dirty staged tree as a pinned
protocol revision. The reviewer checklist is:

- [ ] Pin the reviewed source commit, crate/WASM toolchain versions, schemas,
  protocol text, and test-vector revision.
- [ ] Provide vectors for initial authenticated session, normal send/receive,
  skipped and duplicate message, replay, excessive gap, malformed schema,
  downgrade, wrong account/device, stale/forked registry, revoked target,
  expired proof, and recovery replacement.
- [ ] Match every security claim to a named test at both helper and browser
  integration level; label fakes, virtual authenticators, and mocked relays.
- [ ] Capture actual two-account ordinary-relay EVENT/REQ/AUTH frames and
  measure recipient route, sender exposure, event size, timing, fanout,
  connection IP, and subscription queries. Mocks are not relay evidence.
- [ ] Exercise two tabs, lock/wipe during async work, blocked/aborted IndexedDB,
  lost acknowledgement, exact-event retry, offline devices, device revocation,
  backup rollback, and replacement recovery.
- [ ] Record residual content, identity, routing, and network metadata visible
  to account peers, relays, relay operators, and network observers.
- [ ] Obtain independent protocol and implementation review with no unresolved
  critical finding; separately approve opt-in test-account rollout.

Still open before implementation: independent acceptance or replacement of
the pinned vodozemac 0.11.2 `SessionConfig::version_2()` adapter; canonical
operation/envelope bytes, signature and domain-separation profile; static
cryptographic known-answer vectors; product-approved proof/offline/clock-skew,
backup-retention, first-contact and uncertain-retry policy; private prekey
availability; recovery anti-rollback; authenticated scoped-route creation and
rotation; attachment and cross-device sent-history rules; pinned NIP source
revisions; and independent review. These are explicit blockers, not implied
decisions. R5-E and production DM migration remain separate gates.

## KAT status (2026-11-10, LOCAL-TEST tier only)

The ratchet crate now carries a behavioral-capture vector harness:
`kat_behavioral_capture_six_round_trip_chain_with_skipped_key_case` in
`crypto/ratchet-wasm/src/lib.rs`. Scope and limits, stated honestly:

- NOT true known-answer vectors. Vodozemac 0.11.2 exposes no public
  key-injection constructor for Olm `Account`, so identities and one-time
  keys regenerate per run. The vectors pin INVARIANTS, not ciphertext bytes:
  the fixed six-round plaintext sequence, strict alice/bob alternation,
  per-round wire-frame kinds (round 0 is PreKey-framed — it precedes any
  peer contribution — every later frame Normal), round-trip plaintext
  equality per round, stable session identity across all rounds, and the
  exercised skipped-message-key case (message two decrypted while message
  one's key was skipped; both recovered).
- Running `cargo test --locked` in `crypto/ratchet-wasm` executes the capture
  as a normal test (8 pass including this one). Setting
  `CIPHER_WRITE_RATCHET_KAT=<path>` also writes the capture as JSON to that
  path; the committed (staged) vector lives at
  `test-vectors/ratchet-v1/behavioral-capture.json`.
- The independent Node-side verifier `scripts/verify-ratchet-kat.mjs`
  (`npm run test:ratchet-kat`) re-derives every checkable expectation from
  the vector data alone — it imports nothing from the crate or the wasm
  adapter — and passes 51 checks. It fails loudly on schema drift, schedule
  desync, unknown frame kinds, missing skipped-key evidence, or round-count
  mismatch.
- REGISTRATION: regenerating vectors requires a cargo test run with the env
  var (documented here and in the test header); CI-equivalent verification is
  the npm runner against the committed vector file.
- Limits: LOCAL-TEST evidence only. This is not a Signal X3DH interop claim,
  not a SimpleX/Session parity claim, and not production DM integration. The
  crate still has no app caller; the wasm adapter remains opt-in; and true
  byte-level KATs still require either a vodozemac key-injection API or a
  local patch — recorded here as the explicit blocker it is.
