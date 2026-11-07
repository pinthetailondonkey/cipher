# Protocol security roadmap

Status: Phase 0 implementation and verification are complete. Phase 1 has a
browser-WASM ratchet adapter and crash-safe storage prototype under test; it is
not yet integrated into DM send/receive paths, multi-device fanout, or
recovery. Phase 2 is authorized for protocol evaluation and design; MLS is not
yet integrated. This is a staged engineering plan, not a security
certification. Findings below are pinned to the source
currently checked out on `security-ui-remediation`; external protocol
comparisons link to the standards, protocol descriptions, and published audit
reports used. Cipher has not received a professional external security review.

R4 identity-compartment audit evidence is recorded in
`docs/IDENTITY-COMPARTMENTS.md`. The audit confirms group-local actor
signatures and sender-hidden outgoing DM wraps, and also confirms that DM
recipient routing and public merchant identity still use the account key.
Device credentials are not yet distributed to peers. Therefore R4's audit and
stop conditions are defined, but identity separation is not complete and no
claim of full cross-surface unlinkability is made.

## Scope and evidence labels

- **[V] Verified:** directly supported by the implementation, protocol text, or
  cited assessment.
- **[I] Inference:** consequence of verified behavior under the stated threat
  model.
- **[P] Proposal:** the next design or implementation to evaluate.
- **[U] Unknown:** requires a measurement, version pin, or live integration
  test.

The goal is to improve the existing Nostr application incrementally. Nostr
events remain the transport where their identity and metadata model is
compatible with a promised privacy property. No relay response, status code, or
internal test alone proves production behavior.

## Current Cipher protocol map

| Surface | Current implementation [V] | Consequence [I] |
| --- | --- | --- |
| Account identity | A Nostr account is a long-term secp256k1 key held in the unlocked account vault and recovered by the account recovery phrase. | A compromise of that account key permits identity impersonation until the account migrates; the account key is also the root for existing group actor derivation. |
| Direct messages | `src/hooks/useNIP44DM.js` derives the NIP-44 conversation key from the account secret and peer account pubkey (`src/lib/dmKeys.js`), seals a rumor, then wraps it with NIP-59. The pairwise encryption key is deterministic and has no conversational ratchet state. | Recorded NIP-44 ciphertext can be decrypted after later compromise of either long-term account key. Per-message nonces do not provide forward secrecy or post-compromise recovery. Existing messages remain decryptable by the long-term key. |
| DM delivery | NIP-59 gift wraps are published through configured Nostr relays and the durable outbox. Relays hold ciphertext and observe delivery timing, target routing metadata and the sender's network connection. | E2E content protection is present; transport metadata protection is limited by ordinary relay connections. Offline delivery depends on relay retention and recipient polling. |
| Group messages | `src/lib/crypto/groupCipher.js` uses AES-GCM with one shared key per group epoch. `groupKeyRotation.js` advances epochs on membership removal; the keys are distributed in NIP-44 direct messages. | A current epoch key reveals all retained ciphertexts in that epoch and future messages until rotation. Old keys still held in local storage/backups decrypt their epochs. There is no per-message ratchet or PCS. |
| Group authorization | The signed governance document in `src/lib/crypto/groupDoc.js` and `groupDocWire.js` is the normative app-side member set for key grants; SEC-1..3 fail closed on absent or invalid documents. NIP-29 relay state still gates event acceptance and delivery. | A relay can deny service, delay or fork delivery. Client authorization must continue to reject relay-only additions. Relay state is not itself proof of app-level key entitlement. |
| Group actor identity | `src/lib/crypto/groupAuthority.js` derives a per-group actor key from the account secret and group id. Group messages, NIP-42 proofs and control-event signatures use that actor. The actor is pseudonymous across different group ids. | This reduces cross-group linking by signature alone. It does not hide account keys placed in explicit `p` tags, control-event targets, relay rosters, or queries. |
| Group creation | `src/lib/groupCreate.js` currently builds `kind:9007` with `['p', accountPubkey, 'admin']`; `createGroup()` signs it with the per-group actor. | **Confirmed exposure:** the group relay can link the creator's account key to the group despite the actor signature. The configured relay's NIP-11 currently reports `software: groups_relay`, `version: 0.1.0`; upstream `verse-pbc/groups_relay` creates its admin from the signed event author, not the extra p-tag. The deployed source revision is [U]. |
| First-time group join | `publishGroupJoin()` signs a `kind:9021` using the joiner's per-group actor, but its body is currently empty. The owner has no verified actor-to-account binding for a first-time actor. NIP-29 accepts a join request as a relay action and may queue it for a closed group. | The owner cannot privately authenticate which account controls the actor. Existing code paths can fall back to the visible actor id or use account identifiers in later `9000`/`9001` p-tags. Approval, key delivery and actor roster state need one private binding protocol. |
| Asynchronous group access | Group key requests travel as actor-signed group acts; direct key bundles use NIP-44. New membership docs require the held random doc key. | Availability and delivery retries are implemented, but current shared epoch keys are not ratcheting keys. Key backfill policy must distinguish new people from a returning authorized device. |
| Device continuity | Account vault, device unlock, recovery phrase, encrypted at-rest group keys and local state exist. | The account recovery phrase restores the account key, not necessarily erased DM ratchet state, revoked device credentials, or all local history. Recovery must state what data can and cannot be restored. |

Relevant source: `src/hooks/useNIP44DM.js`, `src/lib/dmKeys.js`,
`src/lib/giftWrap.js`, `src/lib/crypto/groupCipher.js`,
`src/lib/crypto/groupKeyRotation.js`, `src/lib/crypto/groupKeyDistribution.js`,
`src/lib/crypto/groupDoc.js`, `src/lib/crypto/groupDocWire.js`,
`src/lib/crypto/groupAuthority.js`, `src/lib/crypto/gmIdentityWire.js`,
`src/lib/groupCreate.js`, `src/lib/groupJoin.js`, and
`src/hooks/useNIP29Group.js`.

## Cipher / Session / SimpleX comparison

This compares documented protocol properties, not marketing summaries. It does
not imply the products have identical threat models or that any single one is
universally stronger.

| Property | Cipher today [V] | Session documented protocol [V] | SimpleX documented protocol [V] | Cipher target [P] |
| --- | --- | --- | --- | --- |
| Global identity | Stable Nostr account key is public and is used across contacts and public commerce. | Uses an account identifier; Session routes messages through its decentralized node network. The current Session Protocol V1 documentation describes stateless 1:1 E2EE; V2 plans include restoring PFS and improving multi-device management. | No network-wide user profile identifier is used; per-connection addresses/credentials are used. | Keep the existing Nostr account for interoperable/public product surfaces, but use independently scoped private, group, merchant and device identifiers. |
| DM E2EE | NIP-44 + NIP-59, with deterministic long-term shared conversation key; no ratchet. | Session Protocol V1 is designed around asynchronous decentralized delivery; official V2 material explicitly says PFS is planned, so do not treat PFS as a present V1 guarantee. | SimpleX agent layer documents a Double Ratchet with post-quantum KEM for E2EE; classic Double Ratchet properties include FS and break-in recovery after fresh DH input. | Add an established asynchronous key agreement and ratchet behind Nostr ciphertext transport; preserve NIP-44 for historical reads. |
| Group E2EE | Shared AES-GCM epoch keys with governance-document authorization. | Session describes a group protocol designed for decentralized storage-node constraints; protocol details/version need separate audit before borrowing. | App-level group messaging rides on the agent layer; group/channel features have different audience and privacy properties. | Evaluate MLS RFC 9420 or a mature implementation; keep Cipher governance as the authorization source unless a stronger, tested integration replaces it. |
| Relay metadata | Group relay sees group ids, actor authors, subscriptions, event timing, IP, and currently some account keys in tags/rosters. DM relays see Nostr transport metadata. | Session's Onion Requests route through multiple nodes so no individual node should see both origin and destination; this is a transport architecture Cipher does not have. | SMP uses per-connection unidirectional queues and server-independent identifiers; traffic still has routing/availability metadata and current privacy docs describe limits. | Keep accepted IP/timing residuals; eliminate avoidable account-key correlation and validate actual wire frames. Do not build a new anonymity network. |
| Asynchronous delivery | Nostr relay storage, NIP-59 wraps and outbox provide offline/retry behavior. | Decentralized Session nodes store messages for asynchronous retrieval. | SMP servers store asynchronous encrypted messages; transport layer is designed around independent sender/recipient queues. | Preserve Nostr and outbox; add ratchet state and encrypted prekey material only after storage/retry semantics are proven. |
| Multi-device/recovery | Shared account continuity and local vault recovery exist; ratchet state is not applicable yet. | Session V2 identifies improved multi-device account management as planned work. | SimpleX documents encrypted profile backups, but a copied live profile should not be concurrently used as a second device because it can disrupt ratchets. | Device-specific credentials, explicit add/verify/revoke, encrypted state backup, and clear limits on what account recovery can restore. |
| External evidence | No professional external review of Cipher's full protocol has occurred. | Quarkslab published a 2021 assessment of specific Session clients and code revisions; it was time-bounded and is not a present-day certification. | Trail of Bits published an implementation/network assessment (2022) and cryptographic protocol-design review (2024), as listed by SimpleX. Those reports apply only to their stated revisions and scope. | Reproducible tests first; then commission an independent assessment against a pinned release and a written threat model. |

## Comparison and implementation decisions

| Improvement | Desired property / proposed change | Required code areas | Migration and compatibility | Test strategy | Priority |
| --- | --- | --- | --- | --- | --- |
| P0: private group admission and actor-only relay identity | The group relay sees only a per-group actor in creator/admin/member slots. A closed-group request carries an account-signed proof encrypted to the out-of-band group actor pin; owner approval binds account↔actor↔gid before key distribution. | `groupCreate.js`, `useNIP29Group.js`, `groupJoin.js`, `groupJoinQueue.js`, actor/authority helpers, group member UI mapping, group key grant mapping. No change to NIP-44 DM or group ciphers. | Existing account-key roster entries remain recognizable as legacy. New clients should display them locally but never copy those account keys back into fresh relay events. Actor pin must come from a signed invite (`a=`) or an already verified local binding; do not trust a relay-provided pin for encrypting identity. | Real NIP-29 relay implementation locally, two unrelated generated account keys, captured frames; assert account ids absent from 9007/9000/9001/39001/39002 and subscription filters. Test invalid signature, wrong gid/actor, replay, denied, duplicate, no-pin, owner offline, and retry. | Essential; immediate. |
| P1: ratcheted DMs | Add asynchronous authenticated key establishment and Double Ratchet with message-key deletion and durable transactional state. The current prototype evaluates Vodozemac's v2 Olm mode, not Signal libsignal interoperability. | New DM session/prekey module, per-device identity/prekeys, `useNIP44DM.js`, gift-wrap transport, DB schema/transactions, safety-number/key-change UX, outbox. | Keep old NIP-44 decrypt/read path for old messages. New sessions begin only after authenticated device/identity transition. Ratchet messages need a versioned payload and explicit retries. A recovered account without ratchet backup can establish a new session but cannot recover erased message keys or plaintexts. | Known-answer vectors from the chosen library; offline prekey delivery; out-of-order, duplicate, replay, corrupted state, atomic crash/retry, stolen old key and compromised-current-state tests; browser and two-device end-to-end run. | Essential. Depends on P0 identity mapping and storage design. |
| P2: group cryptography | Evaluate RFC 9420 MLS: epochs, authenticated commits, forward secrecy and PCS after members process updates; the relay is an untrusted delivery service, not an authorization authority. Preserve the verified governance doc as the application admission/role policy, with explicit binding into MLS credentials/commits. | Group codec, key store, membership docs, `groupKeyRotation`, distribution and baseline state, event transport, device sync, recovery. OpenMLS 0.9.2 is the current candidate for a browser-WASM spike; no production selection yet. | New groups first, or explicit opt-in rekey with all members online/available. Preserve legacy AES-GCM history reads. New admission defaults to current epoch only; historical access requires an explicit owner policy. Returning-device recovery uses verified encrypted backup or a current-epoch rejoin, not automatic old-epoch backfill. | Standard MLS vectors plus malicious relay reorder/drop/fork, concurrent commits, removed-member ciphertext, stale/offline devices, commit crash recovery, equivocation detection, and legacy compatibility. | Essential for FS/PCS in groups, but defer transport and state migration until P0/P1 architecture review. |
| P3: device security/recovery | Device-scoped signing/encryption credentials; explicit verified device adds and revokes; encrypted state backups with rollback detection. | Identity vault, device lock/passkey, backup/restore flows, DM ratchet storage, group state sync, revocation events. | Account phrase restores account continuity, not deleted ratchet secrets. Restore from an earlier encrypted backup is bounded by that backup's state and must rotate/rejoin after revocation. No public-relay ratchet or private-key backups. | New device enrollment, stolen/lost device revoke, old device key denial, backup restore, backup rollback, interrupted transfer, no-backup honest refusal. | Essential for safe multi-device and loss claims. |
| P4: privacy compartments | Distinct account, DM-device, per-group actor, storefront and device identities; minimize joins across public surfaces. | `identity`, group actor derivation/bindings, profile/vendor publication, subscriptions, NIP-65, receipt/public order surfaces. | No global identifier migration that silently breaks Nostr interoperability. Public profile/merchant data stays linkable by choice; old events remain public. | Cross-account/linkability harness over signed events, relay frames, profile and receipt publication; negative controls prove intentional public identity. | Essential for claims; increment after P0. |
| P5: security evidence | Reproducible adversarial harness with captured actual WebSocket frames and pinned protocol/library versions. | Tests, relay fixture, UI integration, release process and security documentation. | Compatibility fixtures retained for all wire versions; CI fails on unregistered tests. | Relay tampering, forged membership, key-request abuse, removal, rollback, compromise, offline, device loss/restore, cross-account linkage, browser execution. | Essential ongoing; start with P0. |

## Dependency map

```text
wire/identity audit + NIP-29 relay fixture
                    │
                    ▼
P0 actor-only creation + encrypted admission + stable account↔actor binding
          ┌─────────┴──────────┐
          ▼                    ▼
P1 device identity +     P4 privacy compartments
DM ratchet state         (per-surface identifiers)
          │                    │
          └──────────┬─────────┘
                     ▼
P3 device add/revoke, encrypted backup and recovery
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
P2 MLS group migration    P5 adversarial harness and
and epoch recovery        independent review evidence
```

P2 depends on P0 because MLS credentials and commit senders must not reintroduce
account-key leakage or let relay state replace application authorization. P3
depends on P1/P2 state formats; implementing backup first risks ossifying unsafe
ratchet snapshots. P5 starts now and becomes a release gate for every later
phase.

## Phase 0: detailed security plan

### A. Hide the creator's account identity

**Verified exposure:** `groupCreateTags()` puts `identity.pk` in a plaintext
`p` tag on `kind:9007`; the event itself is signed with the per-group actor.
`kind:9000`/`9001` target tags also currently receive account pubkeys from the
application model. NIP-29 relay state records pubkeys as members/admins.

**Relay behavior evidence:** the live `groups.ciphertele.com` NIP-11 response
reports `software=groups_relay`, `version=0.1.0`. NIP-29 permits a group creator
to establish relay state through `kind:9007`; its user-signed event author is
the NIP event identity. The upstream `verse-pbc/groups_relay` source currently
sets the creator admin from `event.pubkey` and generates 39001/39002 from its
internal member set. Therefore the app must sign with the actor, place only
actor pubkeys in relay-facing moderation tags, and maintain account↔actor
mapping only in encrypted/signed app state. Removing the existing p-tag is not
assumed sufficient: the integration fixture must exercise relay creation and
its generated state events. The deployed binary's precise upstream commit is
unknown until the operator supplies it or the relay publishes it.

**Proposed check:** create, admit, promote, demote, kick and leave with actor
keys; inspect the raw signed events and relay-generated state. Account identifiers
may remain in encrypted governance docs, account-local state and recipient
key-DM ciphertext, but not in group-relay event tags, author fields, generated
rosters, or `REQ` filters.

### B. Encrypted first-time admission

**Trust anchor:** the applicant gets the owner's compressed per-group actor pin
from the signed/out-of-band invite (`a=`). An unpinned result remains
discoverable, but admission fails closed until a trusted pin is provided.
Never fetch a replacement authority pin from the group relay.

**Handshake implemented for pinned invites:** the applicant creates their
per-group actor key, signs a short-lived, domain-separated proof binding
account, actor, group and nonce, then places it inside NIP-44 ciphertext to the
owner's authority actor pin in the ordinary NIP-29 `9021` content. The owner
verifies the outer Nostr event, decrypts with its actor secret, verifies the
inner account signature and freshness, then queues the account/actor pair for
explicit approval. Approval publishes the signed governance binding before
sending `9000` to the actor pubkey; key requests resolve back to the account
and key bundles still target its account DM key. Receipt of `9021` alone adds
neither relay membership nor governance standing.

The binding's provenance is now explicit in governance-document version 3.
Version 1/2 documents still verify and decrypt, but any actor field they carry
is treated as an unverified migration hint. The sealed group-message `by`
field is not an account signature because every current member knows the group
key; it is never used to create an authorization binding. When an existing
governance signer publishes its next v3 update, it can bind its own account row
to the actor derived from that unlocked account secret; this does not trust the
legacy pin or relay. Other existing members whose pins came only from v1/v2
documents need a fresh account-signed admission before actor-based control
attribution is enabled. Wire control
authorization reads only held, verified governance standing; stale local/UI
rosters and relay-only snapshots cannot fill a missing document.

**Trust/availability limit:** public directory browsing remains available,
but joining an unpinned discovery result is refused until an admin-issued
invite is supplied. Trusting a pin learned only from the group relay would let
a malicious relay decrypt the proof and learn the applicant's account. This
preserves identity confidentiality at the cost of first-time join from
unpinned discovery. A verifiable authority-pin mechanism is needed before
claiming every discovered group remains directly joinable.

**Failure behavior:** malformed, expired, replayed, wrongly addressed or
unverifiable requests are ignored/refused; they do not create a member row or
receive keys. Relay publish loss is retryable with the same ticket nonce and
idempotent owner queue. The owner publishes the signed governance binding
before the relay add; if the add is rejected, app authorization includes the
owner-approved account but relay membership does not, no key bundle is sent,
and the pending request remains for retry. Lost pending-queue storage means
the applicant can resubmit a fresh ticket; it must not silently approve.
Existing account-key members remain legacy-readable; moderation against a
legacy member without a verified actor binding refuses instead of emitting an
account-key target, until an authorized document update binds that actor. The
current authority signer binds its own account by local key derivation during
such an update; other members need a fresh invite handshake.

**Relay compatibility:** NIP-29's join request includes optional free-form
content and the requester's event pubkey. The inspected upstream relay queues
closed-group requests by `event.pubkey`, so actor-signed requests can be queued
and the owner can approve that actor. The running production service is not
modified or used for a test write. A local relay test and later operator-approved
two-account live test are required before making a deployment claim.

## Migration and history policy

1. Continue reading existing NIP-44 DM wraps, AES-GCM group epochs, v1/v2
   governance documents and legacy account-key relay roster rows.
2. P0 new group traffic writes actor identifiers only. Existing relay roster
   account rows are not deleted automatically; destructive roster migrations
   require a separate, idempotent and recoverable procedure.
3. P1 legacy DMs remain readable through NIP-44. New ratchet sessions do not
   reinterpret or rewrite old ciphertext. Key changes are shown to the user.
4. Governance documents v1/v2 remain readable. Their actor pins are displayed
   as legacy data but cannot authorize actor-signed controls; a v3 signed
   update marks only proof-backed bindings verified. Older clients that do not
   understand v3 fail closed on that head, so upgrade all active group devices
   before onboarding a new actor member.
5. P2 preserves old group ciphertext under old epoch keys for members that
   already hold them. A newly admitted human receives current epoch access by
   default, never all previous epochs. A returning authorized device receives
   only state from a verified encrypted backup or an explicit owner-approved
   history grant.
6. A relay outage can block delivery but cannot authorize a member. Concurrent
   history forks are surfaced; clients do not pick the newest relay copy as
   authority without checking signatures, epochs and held state.
7. Losing all copies of a ratchet/MLS state without backup can make old history
   permanently unreadable. The app will say that plainly; it will not mint a
   replacement secret and claim continuity.

## Definition of done

### Phase 0 — group identity and admission

- [x] Regression coverage captures the actor-only creation tag and proves the
  prior caller's account p-tag leak; first-contact account/actor binding uses
  independent generated keys and real actor derivation, NIP-44 and Nostr
  signature verification.
- [x] A locally run compatible NIP-29 relay accepts creation, queues closed
  `9021`, and accepts owner approval targeting the actor; it generates actor-
  only admin/member state.
- [x] Captured group-relay frames/events/filters contain neither account key.
- [x] No joiner obtains roster access or any group key before explicit approval.
- [x] Bad signature, wrong gid, wrong actor, wrong pin, stale/replayed ticket,
  duplicate, denial, relay refusal and retry cases are tested.
- [x] Existing groups and unpinned links follow explicit legacy/refusal behavior;
  no relay-derived pin is treated as trusted.
- [x] `npm run lint`, `npm test`, `npm run build`, targeted crypto/membership
  tests and browser checks are run; exact counts and skips are reported below.
- [x] A two-account run against a locally run compatible NIP-29 relay verifies
  the real admission path and captured traffic.
- [x] Verified changes are committed locally on `security-ui-remediation`; no
  push or deploy.

Phase 0 verification snapshot (2026-11-06): `npm test` — 1,119 passed, 0
failed, 4 skipped (1,123 tests total); `npm run lint` — exit 0 with 103
existing warnings and no errors; `npm run build` — exit 0; `npm run test:ui
-- --workers=2` — 184 passed. The local compatible NIP-29 integration test
passed with two independent accounts and captured 26 outgoing and 38 incoming
frames (17 EVENT, 2 AUTH, 7 REQ). No account key appeared in captured relay
frames. `git diff --check` passed. These results do not establish behavior on
every deployed NIP-29 relay. Commit: `97491bb` (`SEC: close Phase 0 group
membership trust gaps`), local only; branch is one commit ahead of origin.

### Phase 1 — DM forward secrecy

- [ ] The selected ratchet/key-establishment implementation passes the browser,
  native/desktop, license, update, storage and API assessment documented in
  `docs/DM-RATCHET-DESIGN.md`; no custom ratchet primitives.
- [ ] Protocol design records identity authentication, device identity, async
  prekeys, ratchet advancement, replay/out-of-order behavior and deletion rules.
- [ ] Ciphertext fixtures prove legacy read and versioned new-session behavior.
- [ ] Crash-safe message-key/session-state transactions and concurrent-send
  locking are tested.
- [ ] Historical key theft cannot decrypt messages whose message keys were
  securely erased; current-state compromise demonstrates recovery after fresh
  authenticated DH input. The limits of compromised identity keys are stated.
- [ ] Two independent devices and offline delivery pass browser integration.

#### Phase 1 source audit (2026-11-06)

**Verified call paths.** `useNIP44DM.sendDM()` encrypts every ordinary DM
payload, including commerce and control payloads passed through `sendDM()`,
under `conversationKey(accountSecret, peerAccountPubkey)`. Typing has a
separate sender that uses the same key. Live and history ingestion unwrap
NIP-59 and decrypt the rumor using that same deterministic key. NIP-59's
kind-13 seal and kind-1059 gift wrap add signatures/routing privacy but do not
ratchet the inner message key. There is no persistent conversation ratchet
state. `dmKeys.js` caches only the deterministic key in memory.

**Verified storage and retry behavior.** The account database is Dexie-backed,
message payload rows are sealed at rest with the active vault session key, and
outgoing signed events use a durable write-ahead outbox. The current send path
does not atomically commit a ratchet state transition with the message/outbox;
that must change before ratcheted messages can safely use the existing retry
semantics. Incoming decrypt currently precedes message persistence and business
side effects, so inbound state, decrypted message storage, and idempotent
side-effect recovery need one explicit transaction/journal design.

**Candidate assessment and prototype.** Signal publishes its Double Ratchet,
X3DH and Sesame specifications, but its official `@signalapp/libsignal-client`
package targets native Node libraries and maintainers say outside-Signal use is
unsupported. A third-party browser port exists, but it is not an audited
official implementation and is not selected. Matrix `vodozemac` implements
Olm's asynchronous 3DH setup and Double Ratchet and builds for
`wasm32-unknown-unknown`. A Rust/WASM adapter prototype pins vodozemac 0.11.2
and uses its experimental Olm v2 full-MAC mode. This mode is intentionally
not treated as audited just because the library's older core was audited; the
2022 Least Authority assessment examined an older revision, excluded language
bindings, and left the 8-byte v1 MAC concern unresolved. The mode requires a
separate protocol and implementation review before production selection.

The prototype currently has: 7 native Rust tests for V2 setup, bidirectional
ratchet operation, refusal of V1 sessions, one-time-key consumption, encrypted
account-pickle restoration, one-use out-of-order message keys, rejection of a
consumed historical key from current state, and stale-state rejection after a
fresh peer DH contribution; JS tests cover encrypted local
state, authenticated prekey bundles and IndexedDB CAS/outbox behavior. The WASM
release module builds, and its Chromium exercise passes initial delivery,
wrong-recipient rejection, out-of-order delivery, replay rejection, encrypted
state restore and the same compromise-recovery sequence. These tests exercise
the library adapter only: no DM production send or receive path has changed,
and no forward-secrecy claim is enabled for users. `docs/DM-RATCHET-DESIGN.md`
records the storage and migration gates. **Production implementation choice
remains unresolved** pending review of the experimental V2 mode or a
better-supported browser-capable implementation.

#### Phase 2 implementation evaluation

RFC 9420 and OpenMLS 0.9.2 are evaluated in `docs/GROUP-MLS-DESIGN.md`. OpenMLS
is a possible browser/WASM prototype candidate, not yet selected for
production. Phase 0's signed governance document remains authoritative;
OpenMLS membership commits alone do not implement Cipher's owner/admin policy.
The relay's NIP-29 roster remains untrusted input. Local crash-atomic MLS state
and governance/outbox persistence, fork detection, NIP-29 event compatibility,
offline/stale member behavior, and independent interop are all open gates.

**Current-only history-grant policy implemented.** The AES-GCM key distribution
path now sends only the current epoch during reconciliation, rotation, and
explicit key-request responses. A returning device may ask an authorized admin
for a one-key current-state resync across missed epochs; this does not grant
old history. The receiver accepts that gap only for one key exactly at the
sender's current epoch and only from a governance-authorized admin. New tests
exercise the real NIP-44 envelope contents, current-only admission grant,
current-state resync authorization, and refusal of multi-key or non-admin gap
grants. The legacy receiver still reads historical keys from older senders for
compatibility, so old clients can continue to grant history during migration;
new clients no longer do so automatically. Historical access remains
unavailable through the new client until a distinct, explicit owner-authorized
grant policy exists.

Verification snapshot (2026-11-07): `npm test` — 1,133 tests, 1,129 passed,
0 failed, 4 skipped; `npm run test:ratchet` — 7 passed; `npm run lint` — exit
0 with 103 warnings and no errors; `npm run lint:ratchet` — exit 0;
`npm run test:ratchet-browser` — passed in a real browser; targeted
group-key/removal suite — 29 passed; `cargo test --manifest-path
crypto/mls-eval/Cargo.toml --locked` — 1 passed; `npm run build` — passed.
`npm run test:mls-browser` — passed in headless Chromium against the actual
OpenMLS 0.9.2 WASM module, using the same add/commit/remove and Welcome
failure/retry flow as the native test, including duplicate removal-commit
rejection. Direct OpenMLS Welcome processing reproduced KeyPackage loss on a
failed stage; the evaluation's copy-on-write retry preserved the key and
accepted a later valid Welcome. Two commits built from the same epoch also
demonstrated that a client rejects the competing stale branch it receives.
The MLS evaluation crate passed `cargo fmt --manifest-path
crypto/mls-eval/Cargo.toml --check` and `cargo check --manifest-path
crypto/mls-eval/Cargo.toml --locked --target wasm32-unknown-unknown`. The
NIP-29 relay integration could not
be repeated because no compatible test relay was listening on
`127.0.0.1:18888`; the earlier Phase 0 captured-frame result remains its only
live relay evidence. `npm run test:ui -- --workers=2` — 184 passed. The build
and UI run temporarily moved `.grok/app-env.json` out of the workspace as
required by the build guard; the original file was restored after the run.

### Phase 2 — group forward secrecy and post-compromise recovery

- [ ] MLS RFC 9420 or another mature implementation is selected with published
  implementation evidence; protocol-to-Cipher trust-model review is complete.
- [ ] MLS credentials bind to the verified group actor/account policy without
  publishing account keys. Relay roster changes alone cannot admit a member.
- [ ] Commit durability, simultaneous changes, stale/offline members, forks and
  restore from backup have explicit deterministic handling.
- [ ] Removed member lacks future epoch state; old members retain only the
  history they previously received. New-member history default is current-only.
- [ ] Legacy AES-GCM group history remains readable during a documented,
  reversible migration window.

### Phase 3 — devices and recovery

- [ ] Device add is authenticated by an already authorized device and verified
  out of band; each device has revocable credentials.
- [ ] Lost-device revocation rotates DM/group state and prevents stale sync.
- [ ] Backups are encrypted end-to-end, versioned, rollback-detectable and never
  published in plaintext. Recovery without backup refuses to claim old ratchet
  history.
- [ ] Restore, concurrent devices, partial transfer and interrupted revocation
  are covered by integration tests.

### Phase 4 — privacy compartments

Audit result: the measured wire behavior, public identity joins, ownership
rules, and safe migration gates are in `docs/IDENTITY-COMPARTMENTS.md`. The
remaining unchecked items are actual privacy migrations; do not mark Phase 4
complete until they are implemented and exercised through independent relay
captures.

- [ ] Main account, DM-device, group actor, merchant and device identities have
  explicit ownership/rotation rules and no unnecessary shared wire key.
- [ ] Public profile/storefront choices remain visibly public; private group and
  DM correlation is measured from actual events, filters and captured frames.
- [ ] No globally correlatable identifier is added as a shortcut.

### Phase 5 — security evidence and independent review

- [ ] Adversarial relay harness captures complete, timestamped WebSocket frames
  and can replay, reorder, omit, duplicate and forge unsigned/server events.
- [ ] Harness covers all mission cases, including cross-account identity
  correlation, removed members, key theft, interrupted rotations, offline and
  lost/restored devices.
- [ ] Tests are in the repository's explicit `npm test` registry and CI; browser
  integration covers actual app flows and independent devices.
- [ ] Wire compatibility fixtures, pinned dependencies, threat model and
  release-state claims are reviewed before professional external assessment.
- [ ] Public security wording states tested limits and does not claim equivalence
  to Session or SimpleX.

## Research references

- NIP-29, Relay-based Groups: [protocol text](https://github.com/nostr-protocol/nips/blob/master/29.md).
- Session, [Session Protocol documentation](https://docs.getsession.org/session-network/session-protocol): it describes V1's asynchronous design and says V2 plans to add PFS, PQ cryptography and improved multi-device management. Session also publishes [its 2021 Quarkslab assessment](https://blog.quarkslab.com/audit-of-session-secure-messaging-application.html); that assessment covers pinned historical client revisions and is not evidence of a current full-system audit.
- SimpleX, [protocol and privacy documentation](https://simplex.chat/docs/cli.html), [privacy/security architecture](https://simplex.chat/docs/guide/privacy-security.html), and [transparency/security assessments](https://github.com/simplex-chat/simplex-chat/blob/stable/docs/TRANSPARENCY.md). SimpleX documents per-connection identifiers and an agent-layer Double Ratchet; its current docs also describe post-quantum ratchet work. Trail of Bits assessments are listed as October 2022 (implementation/network) and July 2024 (protocol design).
- Signal, [Double Ratchet specification](https://signal.org/docs/specifications/doubleratchet/) and [X3DH specification](https://signal.org/docs/specifications/x3dh/). The Double Ratchet specification defines forward security and break-in recovery under new DH entropy; it also warns that compromised identity keys can still enable impersonation.
- IETF, [RFC 9420 MLS](https://www.rfc-editor.org/rfc/rfc9420.html) and [RFC 9750 MLS Architecture](https://www.rfc-editor.org/rfc/rfc9750.html). MLS specifies asynchronous group key establishment, FS and PCS, while requiring applications to handle authentication, delivery-service behavior and timely deletion of key material.
- SimpleX audit reports are linked by the project in its transparency report; the published implementation report is indexed by [Trail of Bits](https://github.com/trailofbits/publications/blob/master/README.md). This roadmap has not independently reproduced their audits.
