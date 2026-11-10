# Cipher MLS v1 test profile (spec only)

Status: **TEST PROFILE ONLY. Never production.** This document specifies the
application-layer behavior around an MLS implementation for disposable test
groups. It binds the governance cross-binding designed in
`docs/GROUP-MLS-DESIGN.md` ("Cipher authorization binding", items 13-18 of the
security remediation plan, Phase 4 lane M). No production group path, key
store, or create flow is changed by this profile. Reference
implementations under `src/lib/mlsTest/` and the vector generator
`scripts/gen-mls-vectors.mjs` are test artifacts, not wire deployments.

Pinned implementation under evaluation: **OpenMLS 0.9.2** with the
`js` + `libcrux-provider` features and `openmls_libcrux_crypto` 0.4.0
(pinned in `crypto/mls-wasm/Cargo.toml`). The pinned native and browser
witnesses passed on 2026-11-07; see the design doc for their exact limits.

## 1. Governance binding (item 13)

MLS supplies an authenticated GroupContext; it does not decide who may add a
member. This profile binds each commit to the owner-signed governance
document chain, which remains the application authority.

**Authenticated GroupContext extension.** Every authorized membership commit
carries an authenticated extension containing, canonically serialized:

- `prevRev`: the integer governance revision **at which the committer's
  authority is evaluated** (the previous revision, not the new one).
- `prevHash`: the canonical document id (SHA-256 over the canonical body, as
  `groupDoc.js` computes it) of the governance document at `prevRev`.
- `actorPins`: the verified compressed actor pins of the committer's leaf
  credential identity, bound to the group id.
- `commitHashBinding`: the derived commit hash input (see below).

The extension is authenticated by MLS, so a relay cannot strip or rewrite it
without breaking the commit's own signature.

**Committer authorization.** The commit signer's group-actor credential must
hold role `admin` (or `owner`) in the governance document at `prevRev`. A
commit whose signer is not an admin at that revision is rejected before any
MLS state advances. A valid MLS signature alone never authorizes anything.

**Next governance document cross-reference.** The next signed governance
document (revision `prevRev + 1`) is derived from the same previous revision
plus the membership delta in the commit, and it must cite:

- `commitHash`: a hash of the exact MLS commit bytes.
- `transcriptHash`: the GroupContext transcript hash after the commit
  as the committer computed it.

This direction (governance cites MLS output, extension cites governance
input) avoids a circular hash dependency: the extension carries the
*previous* revision, the *next* document attests the *resulting* commit.

**Receiver verification.** A receiver processes a pair of events — the MLS
commit event and the next governance document — and must grant access only
when **both** verify together. Until then the receiver buffers: it holds the
events, decrypts nothing new, grants no key use, and waits. A receiver checks:
signatures, prior revision match, MLS transcript validity, signer role at
`prevRev`, membership delta consistency, and the governance document's
commit/transcript cross-hash match against the local computed values.

### Admission handshake shape

Admission is a private, encrypted exchange before any leaf credential is
installed (test-mode analogue of the NIP-29 request/approval flow):

1. Applicant derives a per-group actor/device credential and sends an
   encrypted admission request containing its MLS KeyPackage and an
   account-key signature over `(groupId, leafKeyHash, nonce)`.
2. The owner verifies the account-to-actor binding locally and returns an
   encrypted Welcome addressed to that one-time KeyPackage.
3. The Welcome is encrypted so only the joining device can install that
   leaf; other members and the relay can store but not read or use it.
4. The owner publishes the MLS commit adding the leaf; receivers accept it
   only under the Section 1 rules.

A relay-provided roster never creates a proposal or authorizes a commit.

## 2. Copy-on-write transactional storage (item 14)

All MLS state transitions run on a copy-on-write snapshot of the provider
store. The snapshot is tentative until one transaction commits it together
with the matching protocol event or journal row. Semantics:

- **Staging.** Each operation (Welcome processing, staged commit merge,
  governance revision advance) reads the current snapshot, clones it, and
  applies the operation to the clone only.
- **Atomic commit.** One transaction writes the sealed MLS state, the
  governance revision pointer, and the immutable outbox/journal row
  together. If any step throws, nothing is written and the pre-operation
  snapshot stays active.
- **Welcome failure containment.** This directly contains the OpenMLS 0.9.2
  `StagedWelcome::new_from_welcome` KeyPackage-consumption issue (#2316): a
  failed Welcome consumes the snapshot only, and the one-time KeyPackage
  survives for a retry with a valid Welcome.
- **Interface.** The reference store implements the
  fake-indexeddb-compatible API shape used by the repo's browser tests
  (async `get/put/delete/transaction`) so the same code path runs against
  real IndexedDB in the browser later.

## 3. Epoch attestation and equivocation detection (item 15)

A single relay can withhold one branch of a fork from one device. After each
epoch advance, **every member** publishes one attestation event:

- Signed by the member's group-actor device key (Ed25519 over the group
  binding in this profile's reference implementation).
- The signed message binds, canonically: `groupId`, `epoch`,
  `transcriptHash` (the member's own computed GroupContext transcript hash
  for that epoch), and the commit hash that produced the epoch.

Admins collect attestations through **at least two independent relays** and
compare. If two otherwise-valid attestations for the same
`(groupId, epoch)` carry different transcript hashes — or if an
admin-reachable branch of commits implies a second conflicting history — the
group is in **equivocation**:

- Sends are frozen (no new commits or messages accepted from the group
  state machine).
- A visible alert is raised for owner review.
- The freeze persists until an owner-authorized rejoin (Section 5) rebuilds
  a verified state.

Cost is one extra event per member per epoch; that is accepted for test
mode. Admins must not treat one relay's attestation set as complete.

## 4. Past-epoch retention (item 16)

The reference configuration pins the past-epoch retention window explicitly
and records the value in the release manifest. Defaults here:

- `PAST_EPOCH_RETENTION = 4` past epochs retained for decryption.
- After the window, old-epoch secrets are wiped and decryption of messages
  from epochs older than `current - RETENTION` **must fail** (key destroyed,
  not merely hidden).
- The exact OpenMLS 0.9.2 setting that trims past epochs must be verified by
  name when the wasm integration lands; this profile records the intended
  application-level window regardless of the library setting's final name.

Rejoin rules across gaps:

- A returning device rejoins from a verified commit chain from its own last
  epoch forward. Stale snapshots are never merged by trusting a relay
  roster.
- If its snapshot is older than the retention window (a gap), rejoin
  requires an **owner-authorized new Welcome**, not a chain replay: history
  inside the gap is unrecoverable from chain material alone.
- **Group history for NEW joiners (owner decision 2026-11-10 #8,
  docs/OWNER-DECISIONS-2026-11-10.md):** whether prior history is shared with
  a new member is the JOINING MEMBER'S choice (joiner opt-in). Mechanics stay
  REVIEWER-OPEN: which existing member supplies it under whose authorization,
  sender-side consent when another member's messages are involved, re-key/
  delivery cost of re-encrypted backfill, and relay-visible metadata of a bulk
  transfer. HONEST LIMIT carried over unchanged: this opt-in applies only to
  history still decryptable within `PAST_EPOCH_RETENTION` or already-exported
  plaintext/exports; nothing resurrects messages whose epoch secrets were
  wiped after the retention window, and removed members' copies cannot be
  recalled.

## 5. Rejoin and rejoin-validation

A rejoin is validated by:

1. Verifying the governance document chain from the device's stored
   revision through the current revision (each document cites its commit
   and transcript hash per Section 1).
2. Replaying or verifying the commit chain from the device's last known
   epoch to the current one, checking signature and role at each step.
3. Rejecting the rejoin if any intermediate commit fails role checks
   (Section 1) or if the chain length exceeds the retention window
   (Section 4) — in that case only a fresh owner-authorized Welcome is
   accepted.
4. Restoring a backup must not resurrect revoked credentials: revocation
   state at the current revision is checked before import.

## 6. Receiver buffering state machine

Receivers run a small state machine per group:

- `BUFFERING` — a commit and/or governance document arrived but the pair
  has not both verified. Events are held; no key use is granted. Messages
  from the affected epoch are not decrypted.
- `VERIFIED` — both events verified and cross-hashes match. State advances,
  keys are installed, normal operation resumes, epoch attestation is
  emitted (Section 3).
- `REJECTED` — any check fails: forged commit, roster-only add (membership
  change without a valid commit), wrong previous revision, mismatched
  cross-hash, stale epoch, replayed commit, forked transcript. The bad
  event is quarantined and the buffer is not advanced by it.
- `FROZEN` — equivocation detected (Section 3). Nothing is accepted until
  owner-authorized recovery.

Replay and stale-commit rules: a commit whose epoch is not exactly
`current + 1` for its branch is rejected (stale or forked); a commit whose
event id was already merged is rejected as replay; a second commit claiming
the same epoch with different transcript state is a fork and freezes the
group into equivocation handling once attestation comparison confirms it.

## 7. References to D1/D3

- **D1 (revocation cutoff):** removal commits follow the same default —
  messages whose signed send time is after the removal's effective time
  plus 5 minutes of skew are rejected for the removed member; earlier
  messages may still decrypt within the retention window.
- **D3 (registry max age):** the admission handshake (Section 1) honors the
  same 24-hour send-gate default; an admission request older than the
  window is refused and must be re-sent.

## 8. Vectors

`scripts/gen-mls-vectors.mjs` generates deterministic vectors from fixed
seeds into `test-vectors/mls-v1/`, covering:

1. forged commit rejection (wrong signature),
2. roster-only add rejection (governance change without a valid commit),
3. wrong previous revision rejection,
4. mismatched cross-hash rejection,
5. stale epoch rejection,
6. replayed commit rejection,
7. fork rejection,
8. a valid chain of three accepted epochs.

The generator signs everything with Ed25519 (from the existing
`@noble/curves` dependency) over the canonical attestation/binding
serialization defined above.

## 9. Explicitly open (reviewer-open points)

- **Pinned-revision IETF MLS vector run: DONE at LOCAL-TEST evidence tier
  (2026-11-10, plan item 18).** Vectors vendored from the OpenMLS v0.9.2 tag,
  filtered to cipher_suite 1 with sha256-pinned manifest under
  `test-vectors/ietf-mls-0.9.2-cs1/`; runner lives in
  `crypto/mls-wasm/src/pinned_vectors.rs` (native `cargo test`) orchestrated by
  `scripts/run-mls-vectors.mjs` (`npm run test:mls-vectors`). Families checked:
  key-schedule (1, upstream runner), transcript-hashes (100, independent RFC
  9420 reimplementation incl. confirmation-tag MAC + confirmed/interim
  chaining), messages (100, byte-exact round trips + GroupSecrets/Commit
  structural walks), psk_secret (10, independent formula), welcome (1) and
  passive-client-welcome (8) via public group APIs with epoch-authenticator
  comparisons. Skipped LOUDLY because OpenMLS 0.9.2 keeps every needed symbol
  crate-private: secret-tree (3) and treekem (11); their counts+reasons appear
  in every summary (`FamilyResult`). Vector-file lifetimes are expired relative
  to run time; the passive join uses the public `skip_lifetime_validation`
  knob for exactly this reason, matching upstream's own KAT handling.
  Evidence tier is LOCAL-TEST ONLY: passing here does NOT claim interop with
  other MLS implementations; that needs a separate IETF interop client run.
- The exact OpenMLS past-epoch retention setting name for item 16 is
  unverified (see Section 4).
- GroupContext extension encoding: whether the governance binding rides a
  standard MLS authenticated extension or a Cipher-defined extension type is
  untested against the real 0.9.2 API; this spec fixes the semantics, not
  the tag numbers.
- Two-relay attestation comparison assumes both relays are reachable and
  honest about delivery; a relay that withholds *all* attestation events
  degrades to no equivocation detection (same blind spot as the design doc).
- Cross-implementation interop (item 18, second MLS implementation) is
  entirely unaddressed here.
- Extension wire size against relay kind-9 size limits is unmeasured.
