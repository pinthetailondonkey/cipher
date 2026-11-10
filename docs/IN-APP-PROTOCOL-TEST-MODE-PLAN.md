# In-app protocol test modes: DM v1 and MLS

Status: boundary scaffold implemented; DM and MLS protocol integration remain
open. The current production DM path remains NIP-44/NIP-59 and existing groups
remain AES-GCM. Test modes are separate, explicitly enabled paths for
disposable accounts and groups. They do not migrate ordinary conversations or
groups.

The first slice now includes `npm run build:protocol-test`, a dedicated
`protocol-test.html` entry with no ordinary app entry, a visible test-build
screen, strict build-time loopback relay configuration, a disposable
in-memory identity/device, an isolated IndexedDB namespace, and stop/hold plus
explicit cleanup controls. Focused browser evidence covers this boundary only;
no protocol messages are sent, and no ratchet or MLS state is represented as
integrated.

## Boundary evidence (2026-11-09)

- `npm run test:protocol-mode`: build switches, required allowlist, endpoint
  validation, disposable key lifecycle, isolated database, stop/hold, and
  namespace-only cleanup tests pass.
- `node --import ./scripts/resolve-extensionless.mjs --test
  src/lib/testRelayOverride.test.js`: the shipping build has no test relay
  wall, the UI-test build uses its loopback wall, and protocol-test mode blocks
  ordinary relay URLs even when saved overrides are supplied.
- `npm run build:protocol-test` succeeded in a temporary source copy without
  `.grok/app-env.json`. The output contains `protocol-test.html` and no
  `index.html`, service worker, or manifest; a bundle scan found no production
  relay URL, account DB marker, or ordinary app entry. The in-workspace
  non-desktop build remains blocked by its existing `.grok/app-env.json`
  safety guard, which was left untouched.
- `npm run test:protocol-mode-browser` in that isolated build passed: it
  observed one disposable public identity and device, one protocol-test DB, no
  production account DB or owner marker, no external requests or WebSocket,
  stop-and-hold, and explicit deletion.
- `npm run test:security-context-lifecycle-browser` passed after serializing
  page navigation and prebundling `lucide-react`. It covered the expanded
  browser lifecycle cases recorded in the privacy game plan.

These results test the boundary scaffold. No ratchet event or MLS commit is
sent by the app test page, and no cryptographic test protocol has been approved
for integration. Separately, the pinned vodozemac adapter passed its native
and headless-browser behavior checks (`npm run test:ratchet` and
`npm run test:ratchet-browser`); those checks do not load the app test artifact,
use the local relay, or settle the Cipher wire profile. OpenMLS browser
evaluation evidence is recorded in `docs/GROUP-MLS-DESIGN.md`, but it likewise
does not exercise an app-owned MLS group path.

## Follow-up verification (2026-11-10)

The latest protocol-test switches and disabled-state labels were copied over
the staged source snapshot in an isolated `/tmp` tree with `.grok` excluded.
`VITE_PROTOCOL_TEST_RELAYS=ws://127.0.0.1:18888 npm run build:protocol-test`
passed, and `npm run test:protocol-mode-browser` passed with local loopback
permission. The browser run observed the disposable identity/device,
test-only database, stop/hold and explicit cleanup, and no relay messages.
The direct root build remains refused by the existing `.grok/app-env.json`
safety guard; that local file was not read, moved, or modified. This verifies
the boundary and disabled modes only, not DM or MLS protocol behavior.

`R5-SEND-TIME-REVOCATION-DECISION.md` records an unresolved acceptance
problem: sender-signed `created_at` can be backdated and does not prove whether
a device was authorized before revocation. The product owner selected a
five-minute D1 post-revocation grace and 24-hour D3 sender registry-age limit
as test-profile defaults. Exact signed-time evidence, receiver-side freshness,
offline acceptance, and clock rollback behavior remain open for specification
and independent review. These choices do not enable app behavior; no protocol
traffic was added to the app.

## Shortest safe dependency path

### 1. Complete the shared test boundary

Build a test-only app artifact with both protocol switches compiled off by
default. Enabling either mode must require the test artifact, an explicit
visible in-app opt-in, disposable test accounts, and a configured local/test
relay allowlist. A production artifact must reject a build with either test
switch enabled. The send and relay boundary must refuse a non-test account or
non-allowlisted relay even if a UI control or local-storage value is changed.

Keep test protocol state, subscriptions, history, and outbox rows in a
test-specific namespace so an accidental mode toggle cannot make them look
like legacy account conversations or production groups. The disabled state
holds pending test operations and makes no test-protocol publication; it does
not delete ratchet/MLS state or reinterpret it as NIP-44/AES-GCM. Ordinary
DMs and groups continue through their existing production paths.

The test screen must say that the protocol is experimental, works only with
compatible test builds, may have different history and recovery behavior, and
does not change production messaging. Do not claim production security or
anonymity. Preserve ordinary NIP-44 history and existing AES-GCM group history.

### 2. Close shared lifecycle and authority prerequisites

Before either test protocol gets an app caller, make the active account
incarnation fence cover its actual database, queues, relay callbacks, lock,
switch, removal, wipe, and recovery path. The browser tests must include
missed invalidation on resume, actual blocked IndexedDB deletion, storage
refusal, two tabs, and stale callbacks. R/A/D setup and exact pinned registry
heads must be usable with disposable identities; authority storage, contact
pinning, device enrollment/revocation, and recovery replacement must fail
closed and survive restart. Standalone pin/peer prototypes are not evidence
of these app flows.

### 3. Freeze and review DM v1 before integrating it

Resolve the current NIP-59/NIP-44 encapsulation gap and choose either
conformant NIP-59 wrapping of an inner ratchet ciphertext or a Cipher-specific
NIP-01 transport. Pin the NIP source commit and file hashes. Select the exact
ratchet library/mode, account/device key mapping, canonical operation and
delivery-envelope bytes, signature/domain separation, expiry/refresh rule,
and relay transport. Add static known-answer and cross-implementation vectors
for those exact choices. Keep product decisions about offline age, clock skew,
retention, first contact, and retry UX visible and unapproved until the
product owner accepts their costs.

Prepare the source lock, wire capture, schemas, state machines, semantic and
cryptographic vectors, recovery limits, metadata inventory, and failure cases
for independent protocol/implementation review. Do not contact an outside
reviewer without authorization. The current packet is not ready to call a
selected v1 protocol.

### 4. Add the isolated DM test path

Integrate a clearly labeled test conversation path for two disposable
accounts/devices, using the reviewed ratchet adapter and the real browser
IndexedDB, app event handling, and local NIP-01 relay WebSocket. Keep it out of
`useNIP44DM`'s ordinary conversation path; test mode must not become an
implicit default or a fallback for real accounts. Existing NIP-44 history
remains readable.

The acceptance run uses two browser profiles and covers:

- Send/receive and relay refusal with a fresh authenticated session.
- Recipient offline at send, later retrieval, restart, and rejoin.
- Replay, duplicate, out-of-order delivery, and conflicting operation digest.
- Expired authority before socket send, lost acknowledgement, exact-event
  retry, and the reviewed new-envelope-after-expiry behavior.
- Lock, account switch, removal, wipe, profile restore, and recovery
  replacement during asynchronous work.
- Captured `REQ`, `EVENT`, `AUTH`, ACK/refusal, IP endpoint, timestamps, event
  fields/tags, sizes, and identifiers visible to the local relay.

The kill switch stops new test-mode publications and keeps unresolved
operations held. Turning the test path off never changes ordinary DM routing
or retries a test payload through NIP-44. Removal of test state requires a
separate explicit disposable-profile cleanup.

### 5. Specify and review MLS separately, then add an isolated test-group path

First finish stable owner/admin governance and the binding from a governance
revision to the MLS transcript, credential, commit hash, and resulting
transcript hash. Review that design separately from DM v1. Confirm the exact
OpenMLS release/provider/ciphersuite and browser build, and account for the
0.9.2 Welcome KeyPackage-consumption retry issue with copy-on-write provider
state plus an atomic application-owned storage transaction. The current MLS
native/browser witnesses are evaluation evidence, not app integration.

Add a new, clearly labeled MLS test group only in the test artifact, using
disposable members and the local/test relay allowlist. Keep current AES-GCM
groups unchanged and readable. Test owner-authorized adds/removes, KeyPackage,
Commit and Welcome delivery, partial publish/retry, offline Welcome and
rejoin, concurrent and stale commits, replay and fork rejection, persistent
state restore and rollback, and lock/switch/removal/recovery. Capture actual
relay-visible group ids, actor/device identifiers, `REQ`/`EVENT` fields,
content sizes, timing, ACKs, and IP endpoints.

An authenticated removal must prevent the removed member from processing
future epochs. State plainly that a removed member can keep plaintext and keys
already received and can continue to read history already decrypted. Do not
backfill old history to a newly added member by default. Preserve the
governance rule: a relay roster never authorizes an MLS commit.

The DM and MLS test paths share the test-only build boundary, lifecycle
fences, disposable-account policy, local relay capture, and cleanup controls.
Their wire protocols, authority binding, recovery tests, independent reviews,
and disable switches remain separate gates; neither path waits for the other
to make progress on its own prerequisites.

## Release boundary

Passing these test-mode gates authorizes only an in-app test experience for
disposable identities/groups. It does not authorize DM migration, group
migration, production relay use, or a production rollout. Each migration needs
its own evidence and separate rollout decision.
