# Group protocol migration: MLS evaluation

Status: architecture evaluation only. Phase 2 is authorized, but no production
group wire format or key store has been changed. This memo evaluates OpenMLS
0.9.2 against Cipher's actual NIP-29 and signed-governance model. It does not
claim that MLS integration is complete or externally reviewed.

## Threat model and current boundary

The group relay can read, delay, reorder, duplicate, omit, replay, and fork
events and the NIP-29 roster. It can deny service. It cannot forge a Nostr
signature or the group's governance-authority signature, and it must not gain
the ability to add a key recipient by changing its own roster. A removed
member may retain every old group key and ciphertext already delivered to
them. A malicious authorized member may send malformed or conflicting group
traffic. A device may be offline across many membership epochs or be restored
from old local state.

Today, `src/lib/crypto/groupCipher.js` encrypts each message with the shared
AES-GCM key for its epoch. `groupKeyRotation.js` provisions and rotates those
keys according to the signed governance document; `groupKeyDistribution.js`
sends keys by direct NIP-44 messages; `groupMessageCodec.js` authenticates
group events with the group actor and decrypts a locally held epoch key.
Phase 0 makes the governance document, not the relay roster, normative for
membership and grants. MLS must preserve that trust rule.

## What MLS supplies and what it does not

RFC 9420 defines a group key schedule, authenticated epochs, a ratchet tree,
per-sender generation state, and forward-secure application message keys.
Compromise recovery requires an honest member to contribute fresh entropy in a
Commit and the target member to process that Commit. A stale/offline member
does not magically recover by receiving an application message. MLS authenticates
its own membership changes, but does not define Cipher's owner/admin policy,
the NIP-29 request/approval flow, private account-to-actor bindings, offline
delivery, durable storage, backup, or relay consistency. Those remain app
responsibilities.

An MLS GroupContext binds the group identifier, epoch, tree hash, extensions,
and transcript state. It is a strong basis for detecting stale or forked
state, but a single relay can withhold one branch from a client. Cipher needs
cross-relay comparison or an authenticated state-transparency mechanism to
detect equivocation; MLS alone cannot make an adversarial relay deliver all
commits.

## Candidate implementation: OpenMLS

The current crates.io release inspected is `openmls` 0.9.2 (MIT, MSRV 1.91).
Its `js` feature enables browser randomness and time providers. Upstream
publishes WASM bindings/documentation, but states that WebAssembly support and
some tests have limitations; therefore a successful native `cargo check` is
not a browser readiness result. The current 0.9.2 release notes include fixes
for published advisories; the exact pinned package and transitive graph must be
reviewed before adoption.

SRLabs' OpenMLS audit was published by the project in 2026. The project's
summary says issues were fixed in OpenMLS 0.8.1 and 0.7.3, with one low-severity
issue still being worked on at the time of that summary. This is useful
implementation evidence, not a blanket audit of 0.9.2, a browser binding, or
Cipher's storage and policy integration. A release-specific audit-to-version
mapping is a go/no-go item.

OpenMLS is a viable candidate for a bounded browser prototype, not yet a
production dependency. Before selection, the prototype must demonstrate:

Initial compile evidence on 2026-11-06: a minimal `wasm32-unknown-unknown`
crate using OpenMLS 0.9.2 with its `js` and `libcrux-provider` features and
`openmls_libcrux_crypto` 0.4.0 passed `cargo check`. The default
`openmls_rust_crypto` provider failed the same target because its selected
dependency graph enabled `getrandom 0.2` without a WASM JS backend. The
Libcrux check proves compilation only: it did not initialize a provider in a
browser, create an MLS group, execute a commit, or exercise persistence. Use
the WASM-compatible provider and test exact release artifacts before any
selection.

The pinned `crypto/mls-eval` crate now checks the dependency actually needed
for MLS credentials as well: `openmls_basic_credential` 0.6.0 pulls
`getrandom` 0.2, so this isolated evaluation pins 0.2.17 with its `js` feature
in addition to OpenMLS 0.9.2's `js` feature and the Libcrux provider. The
repository command
`cargo check --manifest-path crypto/mls-eval/Cargo.toml --locked --target
wasm32-unknown-unknown` passed on 2026-11-07. On 2026-11-07, the exact
OpenMLS add/Welcome/commit/removal witness was also built with the pinned
`wasm-bindgen` CLI and executed in headless Chromium via `npm run
test:mls-browser`. It passed provider initialization, Alice adding Bob and
Carol, both members processing the current epoch, delivery of an application
message to the remaining members, and rejection of a post-removal application
message by Bob. Carol also rejects a duplicate delivery of the already merged
removal Commit. The native and browser checks invoke the same Rust flow in
`crypto/mls-eval/src/group_flow.rs`. This is evidence for OpenMLS 0.9.2 plus
the pinned Libcrux provider in this narrow browser scenario, not a production
adapter, storage, relay, or interoperability result.

**Welcome failure/retry is reproduced and contained in the evaluation shim.**
The shared flow first calls OpenMLS 0.9.2 `StagedWelcome::new_from_welcome`
directly on a one-time KeyPackage with a Welcome whose group omits the ratchet
tree. OpenMLS returns `MissingRatchetTree` after deleting the KeyPackage;
retrying a later valid Welcome returns `NoMatchingKeyPackage`. The same flow
then repeats with a copy-on-write provider: it snapshots the in-memory store,
stages and stores the group against the candidate snapshot, and replaces the
active store only on success. The failed attempt leaves the original key
available, and the later valid Welcome succeeds. This reproduces the upstream
[0.9.2 Welcome-consumption issue](https://github.com/openmls/openmls/issues/2316)
and tests a safe retry pattern in the evaluation only. Cipher still needs an
application-owned IndexedDB transaction that atomically commits the consumed
KeyPackage, MLS group state, governance revision, and immutable outbox before
using OpenMLS for production admission.

The shared flow also makes two commits from independent copies of the same
accepted epoch: one removes Bob and the other adds Eve. Carol accepts the add
branch, then rejects the competing removal commit from the stale epoch. This
is a narrow fork-replay witness, not equivocation detection: a relay that
withholds the other branch from a device remains undetectable without an
independent authenticated view or cross-relay comparison.

The repository includes a pinned, isolated native behavior witness at
`crypto/mls-eval`, run with
`cargo test --manifest-path crypto/mls-eval/Cargo.toml --locked`. It creates Alice's group,
adds Bob and Carol with Welcome messages, advances Bob using the received
staged Commit, confirms both remaining members decrypt an application message,
removes Bob, then confirms Carol decrypts a later message while Bob rejects it.
The exercise uses group-actor-shaped MLS credentials but does not test Cipher's
governance policy, NIP-29 transport, relay privacy, crash recovery, or browser
storage. It is evidence for the library's basic epoch/key behavior only. The
test also exposed that incoming staged Commit messages must be applied with
`merge_staged_commit`; `merge_pending_commit` does not advance an incoming
member's state. The pinned native witness passed on 2026-11-07 (1 test, 0
failed); the same flow passed in headless Chromium using the actual WASM build.
These are explicit evaluation commands and are not folded into `npm test`.

The candidate source review also found current release-specific limitations
that must shape any prototype. OpenMLS issue #2308 reports an unbounded allocation path
in `ExternalCommitBuilder` when a Remove is staged after `build_group`; Cipher
would not use external commits for its owner-approved admission flow, and must
keep that API out of the adapter until the fix is in the pinned release. Issue
#2316 reports that `StagedWelcome::new_from_welcome` can consume/delete a
one-time KeyPackage before Welcome validation succeeds in 0.9.2. Inbound
Welcome processing therefore needs copy-on-write provider state: process on a
throwaway snapshot and persist the consumed key plus new group state only on
success. If validation fails, discard the staged snapshot and retain the
prekey for a fresh Welcome retry. These are implementation/reliability gates,
not a claim that the library is broadly unsafe.

1. A browser/WASM build and real-browser two-device create, add, commit,
   application message, remove, and decrypt flow using the exact production
   feature flags and crypto provider.
2. Persistent storage of OpenMLS's full serialized state encrypted under the
   unlocked account vault, with one IndexedDB transaction containing state,
   governance version, and immutable relay outbox event. No MLS state is
   published as a plaintext snapshot.
3. Crash recovery at every step around a commit: before durable write, after
   durable write but before relay publish, after partial relay acceptance, and
   on duplicate commit delivery. A locally durable commit is retried as the
   same event; a failed local transaction does not advance local state.
4. Concurrent membership changes serialized against one governance revision.
   A second commit based on an obsolete revision is rejected and retried only
   after verified state synchronization.
5. Deletion/retention policy tests for prior epoch secrets and the API for
   limiting how far backward a member can decrypt. Cipher must not retain
   secrets indefinitely just because the library supports historical epochs.
6. Standard MLS test vectors and interop with at least one independent MLS
   implementation for the selected ciphersuite and wire format.

## Cipher authorization binding

The signed governance document remains the application authority. Each MLS
leaf credential must identify a per-group actor/device credential and bind it
to the group ID plus a governance-document revision. It must not include the
account pubkey in relay-visible group events. A private admission handshake
validates the account-to-actor binding before the owner authorizes the leaf.

Only an owner/admin authorized by the current signed document may construct
the application-level membership change. The intended safe sequence is:

1. Load and verify the latest governance document and MLS transcript against
   the stored accepted revision.
2. Build the MLS proposal/commit for exactly the authorized add/remove and
   include an authenticated extension containing the *previous* governance
   revision/hash and the authorized actor credential identifiers. The MLS
   commit signer must be an owner/admin authorized by that previous document.
3. Derive the next signed governance document from that same previous
   revision and membership delta; the document references the MLS commit hash
   and resulting transcript hash. This direction avoids a circular dependency
   between the MLS commit and governance document hashes.
4. In one local transaction, persist the new MLS state, governance document,
   and exact immutable outbox events. If the transaction fails, neither
   protocol state advances.
5. Publish the committed artifacts. If one relay accepts only one artifact,
   retry the exact event IDs; receivers buffer the incomplete pair and do not
   grant access until signatures, prior revision, MLS transcript, signer role,
   delta, and the governance document's commit reference all match.

This is still a proposal. RFC 9420's authenticated extensions and the selected
OpenMLS APIs must be tested to ensure a governance revision can be bound
without creating a custom, unauthenticated metadata side channel. The wire
design must specify how the next signed document attests to the MLS output and
how a relay replay or same-revision conflict is rejected. A relay-provided
roster never creates a proposal or authorizes a commit.

An MLS library may permit any member to generate a commit. Cipher must enforce
owner/admin policy before the commit is accepted by the app state machine, and
must validate the resulting credential set against the signed governance
document before applying it. A valid MLS signature alone does not override
Cipher authorization.

## NIP-29 transport and identity constraints

The NIP-29 relay may reject unknown event kinds, require a relay-specific
`h`-tag, or only deliver kind-9 messages for its current roster. The actual
configured relay's supported event kinds and limits must be measured before
choosing an MLS envelope. Candidate transports are:

- Encode authenticated MLS application messages as kind-9 content signed by
  the existing per-group actor. This best preserves current relay semantics,
  but public group content remains relay-visible ciphertext and MLS actor
  message metadata may allow within-group correlation.
- Encode commits and application messages in a dedicated Nostr kind if the
  relay accepts it. This needs a real compatible-relay test and does not
  remove the need for kind-9 authorization or delivery.
- Carry MLS ciphertext in existing kind-9 content, with a strict protocol
  marker inside the encrypted/authenticated application envelope. This likely
  provides the least relay compatibility risk, but must be checked for size
  limits and legacy-client behavior.

The current leading transport candidate is serialized MLS messages inside
kind-9 events signed by the per-group actor. An approved applicant's KeyPackage
would arrive inside the existing encrypted admission request. After the relay
accepts the owner's NIP-29 approval and the actor can publish as a member, the
owner sends an MLS Welcome as a group event. The Welcome is encrypted to the
joining device's one-time KeyPackage; other members and the relay can store it
but cannot install that leaf. This avoids putting group epoch secrets in a
long-lived NIP-44 key grant. It depends on the configured relay accepting the
same kind-9/group-id envelope, preserving the Welcome until an offline client
fetches it, and allowing an approved actor to retrieve it. These behaviors
need captured-frame integration tests. If the relay filters Welcome traffic
by the recipient's `p` tag, that tag must contain only the group actor/device
credential, not the account pubkey.

No plaintext account keys or account-to-actor maps may appear in group `EVENT`,
`AUTH`, or `REQ` frames, nor in relay-generated rosters. Stable MLS group IDs
and per-group actor identities are already group-correlatable; do not introduce
a new global device identifier into these frames. A group actor is not an MLS
credential by itself until the credential signature and governance binding
are validated.

## Migration, history, and recovery

- Preserve existing AES-GCM documents and ciphertext as read-only historical
  data. Never reinterpret an old epoch key as MLS state.
- Prefer new groups as the first MLS deployment. Existing groups opt in only
  through a verified, owner-authorized migration with all active members able
  to acknowledge the same migration transcript.
- If any member is unavailable, retain the legacy group or wait. Do not silently
  migrate only the owner's device or issue MLS Welcome state based on a relay
  roster. Migration may create a new, explicitly versioned group epoch while
  preserving legacy history.
- New members receive current MLS state only. Historical access requires an
  explicit owner action that re-encrypts selected history; the default is no
  backfill.
- The current AES-GCM implementation now follows the same default: admission,
  key requests, reconciliation, and rotation distribute only the current
  epoch. A returning authorized device may request an explicit resync envelope
  containing that one current key; only an authorized admin can move its held
  epoch forward across gaps. This does not transfer missed history. If an
  explicit historical grant is added later, it needs a separate owner action,
  recipient scope, confirmation, and audited tests.
- A returning device can rejoin from an authenticated current-state Welcome or
  a verified encrypted backup. A stale MLS snapshot cannot be merged by
  trusting the relay's latest roster; it must process a verified commit chain
  or perform an owner-authorized rejoin. If prior state was lost and no backup
  exists, old messages and erased epoch secrets are unrecoverable.
- Device revocation is an authorized removal commit. Restoring an old backup
  must not resurrect revoked credentials; the current governance revision and
  device revocation state are checked before state import.

## Definition of done for Phase 2

Phase 2 is complete only after all six conditions hold:

1. Threat model, credential format, governance/MLS cross-binding, transport,
   and migration are reviewed and versioned in this repository.
2. OpenMLS or a different mature implementation is pinned with exact feature
   flags, provider, audit evidence, license, WASM support, and upgrade policy.
3. Browser integration proves authorized add/remove, offline and concurrent
   commit recovery, and no key delivery to removed or relay-injected members.
4. Adversarial relay tests prove rejection of forged signatures, roster-only
   additions, replayed/rolled-back commits, forked transcript state, and
   mismatched governance cross-hashes.
5. Storage tests prove atomic commit/outbox durability, encrypted backups,
   current-only new-member policy, and explicit refusal when state is missing.
6. Legacy group history remains readable, existing groups have a documented
   owner-mediated migration, and independent implementation interop passes.

## Primary sources

- IETF, [RFC 9420: The Messaging Layer Security (MLS) Protocol](https://www.rfc-editor.org/rfc/rfc9420.html).
- OpenMLS, [WebAssembly support notes](https://github.com/openmls/openmls/wiki/WebAssembly) and [release history](https://github.com/openmls/openmls/releases).
- OpenMLS, [published protocol audit summary](https://blog.openmls.tech/posts/).
- OpenMLS, [0.9.2 crate metadata and feature list](https://docs.rs/crate/openmls/0.9.2).
- OpenMLS, [ExternalCommitBuilder allocation issue #2308](https://github.com/openmls/openmls/issues/2308) and [Welcome KeyPackage consumption issue #2316](https://github.com/openmls/openmls/issues/2316).
