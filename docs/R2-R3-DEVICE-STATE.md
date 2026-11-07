# R2/R3 device authorization and protocol-state persistence

Status: isolated implementation and test infrastructure only. No device
enrollment UI, public registry publisher, DM send/receive integration, group
MLS migration, or production encryption switch is enabled. The helpers are not
an external security review or a claim of production readiness.

## R2 — device authorization

`src/lib/deviceEnrollment.js` defines a narrow signed state machine:

1. The account key signs a short-lived challenge naming a random device id and
   the proposed independent device Nostr signing key.
2. That device key signs a proof bound to the challenge event id, account,
   device id, and random nonce.
3. Only the account key can add the proof-verified device to the signed,
   monotonically increasing registry. Device ids and public keys cannot be
   reused, including after revocation; the last active device cannot be
   revoked.
4. Revocation produces a new account-signed generation and retains the
   revoked row as a tombstone. Duplicate, expired, wrong-account, wrong-key,
   malformed, or replayed proofs fail closed.

`src/lib/deviceRegistryStore.js` stores a verified registry event sealed under
the unlocked account key and keeps a local generation high-water mark. Lower
generations and same-generation equivocations are rejected transactionally.
`src/lib/dmRatchetWire.js` now creates v3 prekey bundles signed by the enrolled
device credential. Verification requires a separately supplied account-signed
registry and an active matching device row. Historical account-signed v2
bundles remain verifiable as legacy input; the builder refuses to create new
v2 bundles.

The account registry is deliberately not published to group relays or
automatically broadcast. No production transport currently delivers registry
updates to peers, so these helpers establish verifiable enrollment and
revocation records but do not yet operate a usable multi-device product flow.
Publishing a global device roster would link account and device identities;
the integration must deliver a scoped registry over an authenticated private
channel and preserve per-group actor keys.

Revocation freshness has a hard decentralization limit: a signature proves
who authorized a registry, not that it is the newest registry. A client that
has previously stored generation N rejects any lower generation. A first-time
peer or a relay that withholds N+1 cannot independently prove that its cached
N is current without an additional freshness mechanism. Do not treat an
account-signed old registry as proof that a device remains authorized. Before
production use, define and test a current-registry acquisition policy across
independent relays (or another explicit freshness design); if it cannot
establish freshness, defer the send.

The device credential is a Nostr secp256k1 signing key in this prototype.
Device secrets must be generated locally and stored only inside the existing
sealed device-state row. The helper interfaces do not create or persist that
secret themselves. Account recovery without the device secret does not restore
that device; a replacement must be enrolled as a new device.

## R3 — crash-safe protocol state

Database schema v14 already held sealed ratchet device/session/inbox records;
R3 adds `mlsGroups`, `mlsInbox`, and a sealed `deviceAuth` checkpoint in later
Dexie versions. `src/lib/mlsStateTransactions.js` provides the OpenMLS
prototype boundary:

- Outbound: compare-and-swap the group snapshot and put the immutable signed
  Nostr event into `outbox` inside one IndexedDB transaction. A network retry
  uses that exact event; it must not perform another MLS transition.
- Inbound/Welcome: compare-and-swap the snapshot and write a sealed,
  idempotent inbox journal atomically. A crash before commit leaves old state;
  a crash after commit resumes side effects from the journal.
- Conflict: concurrent tabs racing from the same epoch cannot both commit.
  The loser receives a typed conflict and must reload state before retrying.
- At rest: OpenMLS provider snapshots and journal payloads use the existing
  AES-GCM/HKDF sealed-state helper with account, collection and record-bound
  associated data. A locked vault or failed write refuses the transition.

The OpenMLS evaluation now exports/restores a serialized `MemoryStorage`
snapshot. This is only the evaluation provider; it is not a production storage
provider. The Chromium harness stores an actual OpenMLS provider snapshot in
the app's Dexie database, reloads the page, decrypts it, and asks OpenMLS to
load the group. It also races two real browser tabs against both MLS and
ratchet state, checks state/outbox atomicity, and resumes a pending inbox
journal after reload.

Ratchet state-plus-outbox and state-plus-inbox functions already existed from
the R1 prototype. Their optimistic IndexedDB version checks are now exercised
with two separate Chromium tabs. They are not yet called by `useNIP44DM.js`;
current live DMs remain NIP-44/NIP-59. Similarly, MLS transactions are not
called by `useNIP29Group.js`; existing group traffic and governance remain
unchanged.

## Verification evidence

The dedicated unit files are listed in `npm test` and cover challenge proof,
registry generation/revocation, same-generation equivocation, sealed storage,
ratchet/MLS atomic outbox and inbox writes, failed-write rollback, duplicate
inbound handling, and legacy v2 bundle reading. `npm run
test:crypto-state-browser` builds OpenMLS WASM and uses Chromium's native
IndexedDB implementation for cross-tab and reload tests.

These tests prove local transaction properties in Chromium and exercise the
pinned OpenMLS serialization APIs. They do not prove durability against
browser profile corruption, OS power-loss behavior on every browser, device
revocation propagation over Nostr, malicious-relay freshness, a completed
multi-device enrollment UX, production ratchet/MLS interoperability, or safe
backup rollback detection. Those are stop conditions before any production
protocol integration.
