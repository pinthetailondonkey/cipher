# Cipher DM v1 design-review handoff

**Candidate revision:** `cipher-dm-v1-review-candidate-r1`
**Protocol version proposed:** Cipher DM v1
**State:** assembled candidate packet; not frozen wire, not independently reviewed, not approved for app integration.
**Canonical spec:** `docs/DM-RATCHET-DESIGN.md`
**Semantic vector manifest:** `docs/CIPHER-DM-V1-SEMANTIC-VECTORS.md`
**Opt-in app test-mode boundary:** `docs/IN-APP-PROTOCOL-TEST-MODE-PLAN.md`

This revision freezes the threat model, candidate schemas/state machines,
proposed engineering defaults, known mismatches, semantic test expectations,
and local baseline evidence. It does **not** freeze canonical signed bytes,
the envelope refresh rule, product availability policy, or a source commit.
Those gaps are listed below. No outside reviewer has been contacted, no
production account was used, and the live DM hook remains on NIP-44/NIP-59.

## Source and dependency snapshot

- Repository HEAD when this packet was prepared: `2172f726f83923801b87ea93de897d4b271add9a`.
- The implementation tree contains staged changes and is not represented by
  that HEAD. This is a working review candidate, not a release source pin.
- Existing ratchet adapter dependency: `vodozemac = 0.11.2`, pinned in
  `crypto/ratchet-wasm/Cargo.toml` and `Cargo.lock`; the adapter calls
  `SessionConfig::version_2()` and rejects a restored session using version 1.
  It enables `experimental-session-config` and `wasm_js`. The v2 configuration
  is a candidate dependency choice, not an independently approved protocol
  choice.
- Adapter/tool versions: `wasm-bindgen = 0.2.128`,
  `serde-wasm-bindgen = 0.6.5`, `serde_json = 1.0.151` (Cargo exact pins);
  the repository build script requires `wasm-bindgen 0.2.128`.
- Nostr implementation currently installed in the app tree:
  `nostr-tools 2.25.2`. Candidate encapsulation references NIP-01, NIP-59,
  NIP-17 comparison, and NIP-65. The upstream NIP documents are moving sources;
  their exact git revisions and hashes must be recorded in the final review
  source lock before this packet is treated as a reproducible release spec.
- Proposed candidate only uses the library's Olm/Double Ratchet API; it does
  not claim Signal-protocol interoperability. The vodozemac API revision and
  WASM bindings require review as part of Cipher's adapter, not just a crate
  audit.

## Review packet checksums

These hashes identify the exact candidate text, semantic cases, capture, and
current implementation patch represented by this handoff. The implementation
patch hash is the diff from the recorded HEAD restricted to `src/`, `scripts/`,
and `package.json`; uncommitted source remains unpinned as a Git commit.

- `docs/DM-RATCHET-DESIGN.md` SHA-256: `aec1c36949bb7f8a8b29f98eb531b925164d8748a8c29e716cfcc1d749c94165`
- `docs/CIPHER-DM-V1-SEMANTIC-VECTORS.md` SHA-256: `217b583c065f8cd6fca5f04d8643529ca70d324ef4da684a66321df146d255bc`
- `docs/evidence/cipher-dm-local-nip01-relay-capture-2026-11-09.json` SHA-256: `26a2d2e8cb16a1767d669277a800808f0707c0b361d9cf6a2e112cef1d869b7d`
- Implementation patch (`git diff HEAD -- src scripts package.json`) SHA-256: `933ddc4edd0a8d3cfb55c7d893b662a319b0f1fbb8030e945b9228443aa7b4b4`

## Threat model and trust boundaries

| Principal / state | Trusted for | Not trusted for / visible data |
|---|---|---|
| Existing Nostr account key `N` | Public profile, vendor, order, review, and reputation identity; compatibility/history association. | Does not substitute for the independent recovery root or enrolled device keys; restoring `N` alone does not restore ratchets. |
| Recovery root `R` | Authorizes authority policy succession and device-authority replacement under the recovery ceremony. Contact pins require independent fingerprint confirmation. | A stolen current `R` can authorize a valid-looking successor; signatures alone do not detect root compromise. Recovery replacement cannot silently override a contact's prior pin. |
| Primary authority `A` | Signs policy-bound device registry changes and freshness responses for exact heads. | A compromised `A` cannot replace `R` or move the independently pinned recovery fingerprint. It can authorize malicious registry changes until revoked/replaced. |
| Enrolled device keys `Dᵢ` | Authenticate device identity, per-device prekeys, and device-pair ratchet operations. Each active target device has its own session. | Device compromise exposes current local state and plaintext; revocation cannot recall previously published ciphertext or copied plaintext. |
| Recipient authority/checkpoint | Confirms exact currently pinned policy/registry head and target device. | Public relay snapshots are not freshness proof; request/response transport and offline-authority behavior remain unimplemented. |
| Browser IndexedDB and lifecycle coordinator | Durable state while the current account incarnation is valid; transactions and local marker order. | Browser profile rollback can restore old state; multi-database retirement uses Web Locks plus a central marker, not one atomic IndexedDB transaction. Storage refusal or marker loss must fail closed. |
| Ordinary Nostr relay/operator | Stores, routes, and returns signed NIP-01 events; can acknowledge or refuse. | Can delay, replay, withhold, fork queries, observe event ids/tags/size/timing and direct connection IP. Relay acceptance is not proof that a recipient received or processed an event. |
| Network observer / ISP | Sees endpoint, connection timing and traffic volume according to the selected transport path. | NIP-59 encryption does not hide source IP or traffic patterns. This candidate contains no anonymity transport. |
| Contact/user | Authenticated identity and messages after decrypt; may compare recovery fingerprints. | This protocol does not give deniability against a participating endpoint or stop screenshots/copying. |

Primary goals: device-pair forward secrecy and post-compromise recovery after
fresh authenticated DH input; exact R/A/Dᵢ authority binding; replay/downgrade
rejection; durable at-most-once application effects; legacy history readability;
and no silent weaker send fallback. Out of scope: endpoint compromise, account
key theft, traffic anonymity, relay availability, non-repudiation policy, and
recovery of erased history without a separately reviewed backup.

## Candidate packet contents and current implementation boundary

- `docs/DM-RATCHET-DESIGN.md`: operation and delivery schemas, NIP-59 kind
  mapping, state machines, authority and prekey rules, multi-device fanout,
  recovery limits, metadata observers, route lifecycle, IP path alternatives,
  and release acceptance criteria.
- `docs/R5-DELIVERY-SEMANTICS-DECISION.md`: immutable proof expiry conflict,
  retry rule, current fail-closed behavior, and engineering/product choice
  matrix.
- `docs/PRIVACY-LIFECYCLE-INTEGRATION.md`: account-incarnation and durable
  retirement boundaries, actual lifecycle callers, and prototype-only stores.
- `docs/CIPHER-DM-V1-SEMANTIC-VECTORS.md`: 20 deterministic semantic cases,
  state/effect expectations, and the missing known-answer vector gate.
- `docs/CIPHER-DM-V1-SOURCE-LOCK.md`: exact local dependency evidence,
  unresolved moving NIP source refs, relay-visible fields, and a provisional
  privacy-first recommendation with its availability cost.
- No application caller for R5 send/receive exists. Do not connect
  `useNIP44DM.js` until independent protocol review has no unresolved critical
  finding and the separate R5-E test-account gate is approved.
- The target after review is a separately labeled test-only app artifact using
  disposable accounts/devices and an allowlisted local/test relay. This does
  not authorize real-account traffic or a production default change. MLS has
  its own governance/review and disposable test-group path; current AES-GCM
  groups and history remain unchanged.
- A boundary-only scaffold now exists: `build:protocol-test` builds a separate
  `protocol-test.html` entry, refuses missing or non-loopback relay config,
  stores run metadata under `CipherProtocolTest_v1_*`, keeps generated test
  keys in memory, and offers stop/hold plus explicit cleanup. A local Chromium
  check passed against that isolated artifact. It sends no relay event and is
  not ratchet/MLS integration evidence.

## Additional review blocker found

The candidate borrows NIP-59 event kinds and routing, but does not specify the
NIP-44 encryption layers required for serialized rumor and seal events or the
device-to-account author mapping. The exact upstream text was checked, but its
moving branch reference could not be resolved to a commit in this environment.
The source lock records this gap and the two structural design choices. The
packet is therefore not ready to hand to an independent wire reviewer as a
selected protocol. The lifecycle browser
changes from this continuation also remain unverified: Playwright timed out
before the probe mounted, so no new assertion ran.

The follow-up browser harness additionally covers missed invalidation on
resume, storage refusal, and an actually blocked IndexedDB deletion. These
cases remain unverified until the harness reaches its probe and reports the
assertions; do not cite them as passed.

The expanded Chromium lifecycle harness exercises the standalone pin and peer
checkpoint APIs with the real active account fences and synthetic signed
policy/registry events. Two independent successor branches race from the same
head; one wins and both tabs read the same winner. The harness also holds a
cross-tab owner lock, injects one allocator database-open failure while the account-database
retirement call succeeds for a synthetic owner without marker rows, verifies
the shared marker remains, then
retries after recovery and checks an unrelated owner survives. This is a
targeted injected resource failure, not evidence for every blocked IndexedDB
delete/storage refusal. The pin and peer stores still have no live application
callers.

## Local evidence artifact

`docs/evidence/cipher-dm-local-nip01-relay-capture-2026-11-09.json` contains
sanitized observations from two synthetic Chromium clients and a disposable
loopback NIP-01-compatible relay. It records actual app-path NIP-44/NIP-59
`REQ`, kind-1059 `EVENT`, recipient-account `p` tag, `expiration`, outer pubkey,
creation time, encrypted content byte length, local relay arrival and OK
acknowledgement times, and loopback socket endpoints. The recipient hook
received, decrypted, and saved the message. It also records the isolated R5
fixture's embedded proofs, relay-stored event with a deliberately dropped first
OK, and byte-identical exact-event retry.

This capture shows the current account-key routing exposure. The ordinary
app wrapper did not expose sender account `N` as its outer pubkey and did not
contain application plaintext; it did expose the recipient account `N` in the
public `p` tag and account-key `REQ`. The same local relay showed the fixture
R5 wrapper uses a stable device route. The capture does not represent an
ordinary public relay, production user, live ratchet ciphertext, actual
recipient-authority request/response, scoped route, or IP-anonymizing path.
The test browser also attempts a deliberate `ws://127.0.0.1:9` wall address;
Chromium rejects it as an unsafe port. The successful app event handoff is to
the dynamic loopback relay only.

## Follow-up diagnostics (2026-11-09)

The completed `npm test` run had 4 failures, all from the expected database
inventory in `src/lib/panicWipe.test.js`: the wipe implementation had added
`CipherSecurityContextCoordinationV1`, while four test assertions still
expected the previous 9-database set/count. The test now includes that fixed
security database and expects 10 deletions. The focused command
`node --import ./scripts/resolve-extensionless.mjs --test
src/lib/panicWipe.test.js` passes 9/9. The full aggregate was not repeated, so
its post-fix status is unverified.

The pinned adapter's `npm run test:ratchet` passed 7 Rust tests, and
`npm run test:ratchet-browser` passed in Chromium with the pinned
`wasm-bindgen 0.2.128`. These are actual-library behavior checks, but they
generate keys at runtime and do not provide static KATs or exercise the
isolated app test page. The source revision and hashes are recorded in
`docs/CIPHER-DM-V1-SOURCE-LOCK.md`.

No independent DM or MLS reviewer has been engaged. The in-app protocol test
page still sends no events. A real isolated DM wire path remains held until a
reviewer can resolve: (1) conformant NIP-59 plus exact NIP-44 layers versus a
Cipher-specific NIP-01 transport; (2) account/device author mapping, canonical
bytes, signatures and domain separation; (3) expiry, uncertain-ack and
refreshed-envelope acceptance; (4) whether experimental vodozemac Olm v2 is an
acceptable Cipher profile; and (5) interoperability vectors and source-pinned
NIP revisions. Product approval is also needed for offline age, clock skew,
dedupe/backup retention, first-contact policy, and retry UX. MLS separately
needs review of the governance-to-credential/Commit/Welcome/transcript binding
and the pinned OpenMLS provider/release implications. The source and test
evidence are prepared for that review; they do not replace it.

## Engineering semantics proposed for review

- Immutable ratchet operation: one id/digest/ciphertext/session/target and one
  ratchet advancement. Commit the state and operation journal atomically with
  its first immutable delivery object.
- Before proof expiry, any retry after uncertain ACK uses the byte-identical
  committed NIP-59 event. The local relay test observed two identical browser
  EVENT JSON frames after storing the first event and dropping its ACK.
- Current R5 prototype embeds the authority proofs in the immutable NIP-59
  rumor. Both sender and receiver check expiry. After expiry the event is held
  and receiver rejects it; changing outbox metadata cannot repair the embedded
  proof. The R5 v2 prototype itself still holds rather than refreshes.
- Candidate v1 separates the operation from a signed delivery envelope. A
  refreshed envelope could carry the same digest without ratchet advancement,
  but byte immutability, signatures, event replacement, uncertain ACK, and
  receiver acceptance order are unresolved review items.
- UPDATE 2026-11-10: the DM test-profile lane (separate from the R5 v2
  prototype) has since FROZEN a canonical redelivery envelope shape —
  `docs/DM-TEST-PROFILE-V1.md` sections 8–9: a `freshnessEnvelope` JSON object
  inside the Olm-encrypted payload, authenticated by the Olm MAC by
  construction and bound by triple digest equality over JCS bytes — with a
  fail-closed receiver implementation, colocated tests, a known-answer vector
  file, and an extended independent verifier. It remains a REVIEW CANDIDATE,
  not an approved wire format: the freeze exists so the reviewer evaluates ONE
  canonical shape instead of choosing among alternatives. The R5 v2
  prototype's hold-on-expiry behavior is unchanged. Reviewer must still decide
  whether the frozen envelope shape is acceptable before any wire use.
- Use the fail-closed defaults in the options matrix in the canonical spec:
  reject expired authority; keep dedupe journals for the complete supported
  backup/retry window or force a fresh session after uncertain restore; require
  verified-channel first-contact enrollment. These defaults have explicit
  availability costs. They do not silently decide product maximum offline age,
  clock skew, backup duration, or first-contact channel.
- Existing `N` remains public on public profile/vendor/order/review/reputation
  surfaces. DM routing is compartmentalized separately. Do not claim this
  protocol changes or unlinks public vendor history.

## Evidence inventory as of 2026-11-10

New artifacts added since the original assembly of this packet, each stated
with its honest limit. None of these change the state line above: still a
candidate packet for independent review, not approved production policy.

- `docs/DM-TEST-PROFILE-V1.md` sections 8–9: frozen canonical
  `freshnessEnvelope` shape (one form: JSON object inside the Olm-encrypted
  payload under key `freshnessEnvelope`, authenticated by the Olm MAC by
  construction, bound by triple digest equality over JCS bytes) and
  receive-time offline semantics (certificate gating only when certificates are
  held; duplicate redelivery decided by a digest-matched journal entry may skip
  certificate re-checks; conflicting digests always reject; first-time messages
  never bypass receive-order steps 5–6). Limit: spec text plus LOCAL-TEST tier
  implementation only.
- `src/lib/protocolTestDm/freshnessEnvelope.js`: build/verify with fail-closed
  stable reasons (`envelope-shape`, `digest-mismatch`, `target-mismatch`,
  `envelope-expired`; boundary `notAfter == now` verifies), wired into
  `receiver.js` step 9 redelivery. Limit: no application caller; LOCAL-TEST
  tier only.
- Colocated tests: `freshnessEnvelope.test.js` (10 tests) and
  `freshnessRedelivery.test.js` (10 tests); full protocol-DM lane now runs
  **78 pass / 0 fail** via `npm run test:protocol-dm-lane`. Limit: unit-level;
  no app path exercised.
- `test-vectors/dm-v1/freshness-envelope.json`: known-answer vector file #7 of
  7 for the DM test profile (accept/expired/target-mismatch/digest-mismatch/
  boundary cases, fixed seeds, byte-identical regeneration). The independent
  verifier `scripts/verify-dm-kat.mjs` re-derives expectations from vector data
  alone and now performs **95 checks** (+11 for freshness); it imports
  nostr-tools NIP-44, not the wire module. Limits: KATs over fixed vectors,
  not interoperability evidence against an independent implementation.
- `docs/RECOVERY-CEREMONY-SPEC-V1.md`: eight-phase versioned recovery ceremony
  state machine (initiate, out-of-band contact fingerprint verification,
  recovery-material issuance, hold/suspend window that is not a revocation
  freeze, successor claim, user-mediated competing-successor resolution with no
  automatic tie breaker, authority transfer commit, old-device fencing),
  durable per-phase records, resumable-or-safely-aborted interruption states,
  restore-from-older-backup semantics, and an explicit statement that a stolen
  recovery root has no protection against its own theft without another trust
  anchor. Limits: design candidate for review; spec-level only, no ceremony
  record builders, no app path, no UX.
- `scripts/two-device-reload-dedup-capture.mjs` (`npm run test:reload-dedup`):
  loopback two-device reload/replay dedup capture, **13/13 assertions** loud-
  pass, evidence JSON saved to
  `test-evidence/two-device-reload-dedup-capture.json`. Limits: disposable
  loopback relay only, not public-relay
  evidence, no route privacy claim.
- MLS item-18 pinned-vector completion: crate promoted to `crypto/mls-wasm`
  (history preserved via git-mv), OpenMLS 0.9.2 cipher-suite-1 vectors vendored
  under `test-vectors/ietf-mls-0.9.2-cs1/` with sha256 manifest, runners in
  `crypto/mls-wasm/src/pinned_vectors.rs` + `scripts/run-mls-vectors.mjs`
  (`npm run test:mls-vectors`). Families green where OpenMLS 0.9.2 exposes the
  needed symbols, with counted loud skips where it keeps them crate-private.
  Limits: LOCAL-TEST tier ONLY, explicitly NOT interoperability until a
  separate IETF interop client run happens; groups_relay envelope flow,
  three-member flow, and relay attestation capture remain open (Phase 4).

## Reviewer-open items consolidated

Open items carried across all DM-family documents, each with its source. These
are unresolved review inputs, not decisions.

| Item | Source (document and section) |
|---|---|
| D1 production values (post-revocation grace): five-minute value is a TEST-PROFILE DEFAULT ONLY, owner choice pending | `docs/DM-TEST-PROFILE-V1.md` §2 and §10; `docs/R5-SEND-TIME-REVOCATION-DECISION.md`; ledger row "DM test profile freeze" in `docs/PRIVACY-PROTOCOL-GAMEPLAN.md` (~line 170) |
| D3 production values (registry-head maximum age): 24-hour value is a TEST-PROFILE DEFAULT ONLY, owner choice pending | `docs/DM-TEST-PROFILE-V1.md` §2 and §10; same decision record and ledger row as above |
| Dedupe-record lifetime == inbound-journal lifetime == local history retention equivalence (a single value to avoid two-valid-envelope windows) needs independent confirmation before v1 final | `docs/DM-TEST-PROFILE-V1.md` §4 and §8 REVIEWER-OPEN note; ledger row "Freshness envelope" in `docs/PRIVACY-PROTOCOL-GAMEPLAN.md` (~line 171) |
| F-O1 backup availability choice during the recovery window | `docs/RECOVERY-CEREMONY-SPEC-V1.md` §6 (reviewer-open tags) |
| F-O2 contact rotation during a pending ceremony | `docs/RECOVERY-CEREMONY-SPEC-V1.md` §6 |
| F-O3 hold-window/D-window parameters (hold timeout default, contact ack grace, extension allowance) | `docs/RECOVERY-CEREMONY-SPEC-V1.md` §6 |
| F-O4 UX copy for custody warning, competing-root disclosure, fencing notice, stolen-phrase caveat | `docs/RECOVERY-CEREMONY-SPEC-V1.md` §5 UX note and §6 |
| JCS subset restriction (RFC 8785 restricted value classes, UTF-16 code-unit key sort) and lowercase-hex-for-binary caller convention need reviewer confirmation | `docs/DM-TEST-PROFILE-V1.md` §3 (canonical encoding rules, lines ~80–107) |
| Vodozemac experimental Olm session v2 stop condition: whether `experimental-session-config` v2 is an acceptable Cipher profile remains an unresolved review item | `docs/CIPHER-DM-V1-SOURCE-LOCK.md` dependency table (row `vodozemac`); follow-up diagnostics item (4) below |

All earlier unresolved review questions in this document remain open until an
independent reviewer resolves them, including: (1) conformant NIP-59 plus exact
NIP-44 layers versus a Cipher-specific NIP-01 transport; (2) account/device
author mapping, canonical bytes, signatures and domain separation; (3) expiry,
uncertain-ack and refreshed-envelope acceptance; (4) whether experimental
vodozemac Olm v2 is an acceptable Cipher profile; and (5) interoperability
vectors and source-pinned NIP revisions.

This remains assembled candidate material prepared for independent review. It
is not approved production policy, and none of today's artifacts claims wire
parity or interoperability beyond the scoped limits stated above.

## Review entry criteria

Before asking a reviewer to evaluate wire security, Cipher must provide:

1. A clean source tree hash containing the exact candidate spec, adapter,
   lockfiles, semantic tests, and capture artifact. The current tree is staged
   but uncommitted and has not been independently pinned.
2. Exact NIP source revisions/hashes and a reproducible build of the WASM
   adapter/toolchain.
3. Canonical byte rules, signature/domain-separation profile, full static known-
   answer vectors, and chosen error/replay behavior. The semantic manifest is
   not a substitute for cryptographic vectors.
4. Product decisions or explicit product-approved defaults for offline age,
   proof expiry/clock skew, dedupe/backup retention, first-contact discovery,
   sender-copy/history sync, and retry UX after uncertain acknowledgement.
5. A route/IP transport acceptance decision for web, desktop, and mobile. The
   current direct relay transport fails sender-IP protection.

After those inputs, the independent reviewer should examine threat model,
state machines, canonical wire objects, key erasure/backup, cross-device
fanout, metadata, implementation source, and adversarial vectors. No outside
reviewer is contacted by this handoff. No test-account app integration begins
until review is complete and the required R5-E gate is separately authorized.
