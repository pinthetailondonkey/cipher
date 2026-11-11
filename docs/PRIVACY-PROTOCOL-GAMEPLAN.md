# Cipher privacy protocol game plan

Status: research and engineering plan, based on `security-ui-remediation` at
`2172f726f83923801b87ea93de897d4b271add9a` plus the staged worktree as of
2026-11-09. Nothing here enables a production protocol migration or deploy.
This is an evidence-based plan for Cipher's own protocol, not a proposal to
copy Session or SimpleX wire formats.

## Goal in plain terms

Make Cipher conversations harder to read after a later key compromise and
safer across multiple devices, without losing offline delivery or breaking old
history. Preserve the shared account identity and its intentional link to
public vendor reputation, while making private-routing, sender-IP protection,
metadata resistance, device rotation and independent evidence release gates.
The public identity may appear on public commerce and reputation surfaces;
ordinary private delivery should not expose it as a route when a scoped random
capability safely works. Destination relays must not receive the sender's
origin IP through the private delivery path. Reduce address-book, timing and
size leakage through measured route scoping, padding and batching. Minimize
what one operator can correlate and document what cooperating operators can
still infer. These are capability goals for Cipher's own design, not a claim of
Session/SimpleX parity. Until the transport and wire captures meet their gates,
current NIP-44/NIP-59 relays still see direct connection IP, account routing,
timing and size metadata.

Do not report a single numerical “privacy score.” There is no agreed scoring
model, and a number would hide tradeoffs among content security, metadata,
recovery, group membership and usability. Track the properties and evidence
below instead.

## What the reference designs teach us

Borrow properties and lessons, not their protocols:

* **Session:** separate knowledge of the sender's network origin from the
  recipient route with multi-hop onion requests, and be explicit about what
  each hop sees. Session's current protocol documentation says Protocol V2 is
  in development and lists forward secrecy as planned; treat this as a roadmap
  property, not a current guarantee. Its documented routing still carries
  recipient/account routing data within the routed request. [Session protocol
  status](https://github.com/session-foundation/session-docs/blob/main/session-network/session-protocol/README.md),
  [onion request routing](https://github.com/session-foundation/session-docs/blob/main/session-network/session-protocol/onion-requests-and-message-routing.md).
* **SimpleX:** avoid a network-wide user address; use per-connection,
  unidirectional queues and distinct identifiers to reduce easy relationship
  joins. Its own threat model still calls out server visibility of queue
  activity, timing and traffic, IP exposure without Tor, global traffic
  correlation, and local database compromise. These are documented design
  assumptions, not an independent audit. [SMP protocol
  v20](https://github.com/simplex-chat/simplexmq/blob/stable/protocol/simplex-messaging.md),
  [security and threat model](https://github.com/simplex-chat/simplexmq/blob/stable/protocol/security.md).
* **Established cryptographic building blocks:** evaluate the Double Ratchet
  for per-message forward secrecy and post-compromise recovery after fresh DH
  input, and MLS for asynchronous group epochs. Both properties depend on
  correct state handling, deletion, authenticated membership, and recovery;
  naming an algorithm does not establish the property. [Signal Double Ratchet
  specification](https://signal.org/docs/specifications/doubleratchet/),
  [RFC 9420 MLS](https://www.rfc-editor.org/rfc/rfc9420.html).

Cipher should preserve its own Nostr compatibility and governance rules, and
define versioned message, authority, storage, recovery and migration semantics
around reviewed primitives. It should not invent a new cipher or ratchet.

## Single gate status (2026-11-10)

This is the canonical current/open/blocked ledger. Detailed acceptance criteria
remain below; the lifecycle inventory records exact owner and callsite facts.

| Workstream/gate | Status | Evidence now | Exit blocker / next action |
|---|---|---|---|
| Commerce release candidate | **In progress; signed watcher and independent-account local-relay app path pass** | Watcher v2 trust, wallet allocation fencing, and payment/order durability changes are staged. The full UI suite passes 184/184 on the isolated snapshot (`commerce-security-ui-20261110.json`). Operator smoke covers key generation through signed synthetic XMR verification. Targeted Playwright passes 3/3 against the actual local watcher. A separate two-account browser harness exchanges an order request, address, synthetic confirmed payment state, and buyer update over a local NIP-01 relay using the existing NIP-44/NIP-59 app path. `paymentWatch.test.js` passes 30/30. | Two-account harness uses synthetic accounts/RPC/transfer and calls the DM API rather than exercising the full commerce UI or receipt ledger. The operator setup has not been deployed. Test wallet/chain, full buyer/vendor UI and receipt-ledger exercise, and deployment exercise remain open before a commerce release decision. |
| Phase 0 group identity/admission | **Historical gate complete; current-tree evidence open** | Actor-only relay identity and governance path; historical capture at `97491bb`. | Repeat captured-frame flow against exact pinned tree and compatible relay. Do not infer current deployment from historical capture. |
| Shared lifecycle foundation | **Partial, application-integrated** | Account-incarnation fences in account DB and app callbacks; shared durable coordination gate serializes standalone primary-authority, pin, and peer-checkpoint prototype writes against retirement. `saveMessage` now holds writes made across close/lock in the at-rest queue with the captured owner/fence, and same-account reopen retains that fence when older callers omit it; stale fences still fail before flush. The full UI browser suite passes 184/184, including both queued-message race cases. Chromium also covered delayed authority write across lock, competing pin and registry successors across tabs, injected allocator DB-open failure, marker retention and successful retry; sibling/unrelated owner remained usable. | Pin and peer stores still have no application callers. Missed-broadcast/storage-refusal cases, recovery/WebAuthn/provider branches, an actual blocked-delete case, and full resource cleanup remain open. Continue exact-callsite audit. |
| R5-A authority bridge | **Prototype only; no app caller** | Independent R/A/Dᵢ policy, registry, proof, checkpoint and ratchet helpers exist. Outbound idempotency binds operation id to next state, ratchet ciphertext, session, target and exact proof event ids; a plaintext side field was removed from the rumor. Standalone authority, pin, and peer stores use the shared durable retirement gate and recheck live incarnation capability at write callbacks. A two-client browser fixture committed and opened a proof-bound event against independent synthetic authorities. | Request/response transport, prekey publication, recovery UX, real ratchet library/session, and application integration are absent. Fixture ciphertext is explicitly not ratchet evidence. |
| R5-C/D contact and recovery UX | **Design candidate documented; implementation open** | Independent 24-word R custody, QR/out-of-band contact pin, exact successor, strict hold, and replacement flow are specified in `DEVICE-AUTHORITY-DESIGN.md`. | No app screens, user validation, contact rotation, backup/restore exercise, or anti-rollback recovery proof. User choice remains for recovery copy options and availability during recovery. |
| R5-B authorization and delivery | **Engineering semantics documented; product/review decisions open** | `R5-DELIVERY-SEMANTICS-DECISION.md` records the immutable-proof expiry contradiction. Local browser run exercised the isolated proof-aware publisher against the disposable NIP-01 relay: it stored an event but dropped its first ACK; retry handed off byte-identical signed event bytes and received ACK. | Strict receipt-time expiry conflicts with offline relay retention. Product must choose tolerated stale window vs availability. Define refreshed-envelope ordering, dedupe retention/rollback, and receiver policy. The R5 relay case uses fixture state/ciphertext and synthetic proof creation, not an app path or authority request/response. Independent review remains open. |
| Cipher DM v1 / R5-E | **Versioned review candidate assembled; app integration not started** | `DM-RATCHET-DESIGN.md`, `CIPHER-DM-V1-REVIEW-HANDOFF.md`, semantic vector manifest, and `R5-SEND-TIME-REVOCATION-DECISION.md` record candidate semantics and open gates. Sanitized two-client loopback capture records current app wire fields and the separate R5 fixture retry. | Canonical wire/signature profile and cryptographic known-answer vectors are open. The product owner selected five-minute D1 revocation grace and 24-hour D3 sender-registry-age test defaults; they are recorded in `R5-SEND-TIME-REVOCATION-DECISION.md` and do not authorize application or production behavior. Sender-controlled `created_at` cannot prove pre-revocation send time; trusted time evidence, receiver freshness, offline acceptance, and independent protocol/implementation review remain open. Local relay is not a public-relay capture. Live `useNIP44DM.js` remains NIP-44/NIP-59. |
| Private routes and IP protection | **Measurable design candidate; not implemented** | DM packet defines zero N/R/A/stable-D tags or queries, no public N→route map, per-contact/device route uniqueness and rotation checks, held-out AUC/delay/size targets, and regression that preserves public account/vendor reputation identity. Current local capture confirms the baseline account-key route exposure. | Routes and forwarding remain absent. Product/reviewer must ratify classifier and latency/bandwidth thresholds, first-contact availability, and supported-platform IP policy. No anonymity or SimpleX-parity claim; independent routing review and two-device relay evidence are open. |
| Timing/size resistance | **Requirements drafted + first measurement recorded; thresholds unratified** | Existing helper pads to 640 JS string code units; gameplan contains proposed AUC, delay and bandwidth thresholds. NEW this session: `src/lib/privacyMetrics/padBytes.js` implements UTF-8-byte power-of-two ladder padding from 512B before encryption; `scripts/padding-timing-eval.mjs` measures a 300-message synthetic corpus (5 classes × 60) under legacy vs ladder: route-activity classifier AUC **0.9017 → 0.7408** after ladder (held-out even/odd stratified split, Gaussian NB one-vs-rest by Mann-Whitney U — a 17.85% relative improvement, BELOW the draft ≥25% gate, so the draft target is not met yet); corpus-average wire bytes ratio 1.051× (within ≤2× draft); p95 modelled fill delay 7.98ms at 1Mbps (batching NOT modelled). `scripts/forwarder-perhop-test.mjs` passes: two-hop loopback prototype where the mailbox relay sees only the forwarder's source address/origin port hidden; labeled exactly "partial, web-forwarder evidence pending two-operator tests". Findings in `docs/PADDING-TIMING-EVAL-V1.md` marked DRAFT PENDING REVIEWER RATIFICATION. | Current wire classes and classifiers measured on SYNTHETIC corpus only, not real captures; measured AUC misses draft improvement bar; no real-relay capture feeding this yet; product/review must ratify or replace thresholds before prototype implementation. |
| IP exposure / forwarding (plan item 10, Gate B partial) | **Prototype evidence recorded; desktop/web claims unchanged** | Forwarder entry-hop→mailbox-capture topology asserts single mailbox connection, mailbox sees loopback only, origin source port hidden, ACK returns through both hops. No Tor SOCKS capture on any platform yet; no two-operator collusion test; no production egress change. Web/desktop remain labeled IP-visible per D5 until those tests pass. |
| Phase 2 / MLS groups | **Evaluation only; separate gate** | OpenMLS 0.9.2 and storage/concurrency prototypes. | No production group integration, governance binding, recovery/offline policy, migration, or independent review. Do not conflate with DM. |
| Phase 4 / MLS relay envelope flow (`src/lib/mlsTest/relayEnvelope.js`, `scripts/mls-three-member-relay-test.mjs`) | **LOCAL-TEST tier slice implemented; staged, not committed (2026-11-10)** | NEW test-only canonical kind-10606 Nostr envelope ({mlsGroupId, epoch, wireFormat mLSMessage/welcome/commit, mlsBytesHex, governanceRef {revision, hash}, attestations}) with deterministic signer and fail-closed verifier returning stable reasons `envelope-kind`/`envelope-signature`/`governance-mismatch`/`attestation-invalid`/`epoch-regression`. Unit: 28/28 pass incl tamper matrix + re-signed-but-unauthorized-signer rejection. THREE independent profiles over TWO genuine local NIP-01 relay instances on separate loopback ports ran create/add-B/add-C/group-message/remove-B/re-add-B with EVERY envelope verified before acceptance and per-epoch attestations of all three members compared across both relay instances at epochs 0-5; tampered unsigned envelope rejected by the relay itself, well-signed unknown-governance-revision envelope rejected fail-closed by receivers; removed member B observed its own removal commit and stopped advancing past epoch 3 per Section 5/D1 policy; rejoin used a fresh owner-authorized Welcome without history replay. Evidence: `test-evidence/mls-three-member-relay-capture.json` (12 events per relay, 78 captured frames). | Local compatible relays only, not public-relay interop; MLS wire bytes are opaque sha256 fixtures (no live OpenMLS group state in this capture); equivocation fault injection not exercised (cross-relay sets compared by agreement only); no production path changed; cross-implementation interop still open. |
| Opt-in in-app protocol test modes | **Boundary scaffold implemented; DM/MLS integration open** | Dedicated `build:protocol-test` emits only `protocol-test.html`; the page creates an in-memory disposable identity/device, a separate `CipherProtocolTest_v1_*` DB, and a stop/hold plus explicit cleanup flow. Build guard requires paired test flags and an explicit loopback relay allowlist. Browser harness verified no account DB, external request, or WebSocket. | No DM or MLS protocol traffic is implemented. DM waits for the exact wire/library choices, known-answer vectors, independent review, lifecycle/authority gates, and test-account acceptance. MLS waits for stable governance and separate MLS review. Production paths remain unchanged. |
| Phase 5 evidence/review | **Open; local relay baseline captured** | Disposable loopback NIP-01 relay + two independent Chromium contexts verified current-tree ordinary `useNIP44DM.sendDM` through actual browser WebSocket EVENT handoff, relay ACK, receiver subscription, decrypt, and save. Relay-visible wrapper was kind 1059 with recipient account `p` tag and no sender account key or plaintext. A separate R5 fixture on the same relay tested proof validation and exact-event retry after lost ACK. | This is a local compatible relay, not an ordinary public relay. Keep captures and test environment synthetic. No independent protocol/implementation review, chaos/fuzz campaign, two-device live-relay capture, or ratchet app integration exists. |
| R0, R6–R9 | **Undefined in authoritative project records** | No authoritative product-phase definitions found. | Do not invent phase meanings; locate a source record before assigning work/status. |

`MEMBERSHIP-DESIGN.md` uses R1–R10 to name review rounds; those are not the
product's R phases. This ledger keeps Phase 0–5, R5 milestones, and membership
review rounds separate.

`MEMBERSHIP-DESIGN.md` uses R1–R10 to name review rounds; those are not the
product's R phases. The phase ledger above deliberately keeps Phase 0–5 and R
labels separate.

### Current implementation boundaries

* Live 1:1 DMs remain NIP-44/NIP-59. Their pairwise key is derived from
  long-term account keys, so recorded ciphertext does not gain forward secrecy
  from the ratchet prototype.
* Live groups remain on the current shared AES-GCM epoch key and governance
  path. The MLS browser result is an evaluation, not a production group.
* Sender-hidden gift wraps do not hide the recipient account route, relay IP,
  timing or traffic volume. Merchant events still use the public account key.
* Device authority, recovery, ratchet and lifecycle changes in the current
  worktree are groundwork. Their passing tests must not be described as a
  production protocol switch.
* Recent commerce watcher/address allocation hardening improves payment
  integrity and address non-reuse. It does not improve messenger anonymity or
  DM forward secrecy.

## Historical checks at 2026-11-08 checkpoint

These results describe an earlier worktree state and are retained for
provenance. Use the later current-session ledger for present gate status.

| Check | Result | Scope and limit |
| --- | --- | --- |
| `npm test` | 1,264 passed, 4 skipped, 0 failed | Registered unit suite; the skip count is retained. |
| `npm run lint` | Exit 0 | Existing warnings remain; no lint errors. |
| Production Vite build | Pass in a source-only temporary tree | Direct root build intentionally refuses because local `.grok/app-env.json` is present. The workaround left `.grok` untouched. |
| `npm run test:watcher-browser` | Pass | Synthetic local watcher/RPC only. |
| `node browser-privacy-helpers.mjs` | Pass | Two tabs, account scoping and invalidation in browser storage. |
| `npm run test:security-context-lifecycle-browser` | Pass | Two real hook instances; tab-local lock and account-wide invalidation. |
| `npm run test:device-authority-browser` | Pass | Browser IndexedDB, recovery replacement and device authority prototype cases. |
| `npm run test:ratchet-authority-browser` | Pass | Two accounts, concurrency, sealed frame, retry/reload and lifecycle fencing. |
| `npm run lint:ratchet`; `npm run test:ratchet` | Pass; 7/7 Rust tests | Prototype only. |
| `npm run test:ratchet-browser` | Pass | WASM browser harness; not production DM integration. |
| `npm run test:mls-browser` | Pass | OpenMLS evaluation harness; not production group integration. |
| `git diff --check` | Pass | No whitespace errors. |
| Full `npm run test:ui -- --workers=1` | 178 passed, 6 failed; 184 total, 45.7 minutes | Ran in a temporary snapshot of the current dirty source. The default sandbox blocked the local preview bind (`EPERM` at `127.0.0.1:8081`); scoped local-only permission was approved for this rerun. All 6 failures are payment UI fixtures expecting the legacy unsigned/`v1` watcher path. The implementation refuses before network access until an Ed25519 v2 signing key is manually pinned, so pending/confirmed/malformed-report positive paths do not reach their expected results. Update fixtures to install a pin and return signed v2 reports, then rerun. All other 178 cases passed. |
| Phase 0 relay/app-flow and ordinary-relay chaos | Not run | No listener on `127.0.0.1:18888`/`:18889`, no `groups_relay` binary or chaos settings. These publish to a relay and require a local fixture; no external relay was used. |

The full unit suite and browser prototypes are strong local regression evidence.
They do not prove wire privacy, compatibility with ordinary relays, safety
under hostile relays, production delivery, or an independently reviewed
protocol.

## Current-session follow-up (2026-11-10)

| Check | Result | Scope and limit |
| --- | --- | --- |
| Focused lifecycle/chat/reconciler/key-distribution/outbox tests | Latest combined command across 9 files: 44 passed, 0 failed | Covers source contracts, fake-IndexedDB stale-incarnation rejection, immutable effect reservation, group rotation, key distribution, and security-context storage. Node tests do not prove browser IndexedDB races. |
| Focused commerce/outbox/vendor-card tests | Latest combined command across 6 files: 76 passed, 0 failed | Covers watcher trust/payment behavior, address allocation, outbox retry and retired-caller behavior, vendor card constraints, and Wallet navigation. The Wallet publication fence is source-linted; no dedicated browser race test exercises that UI action. |
| Full `npm test` aggregate (earlier checkpoint) | 1,316 passed, 4 skipped, 0 failed (1,320 tests) | Superseded by subsequent clean-index verification. |
| Focused store lifecycle checks | Group and document store slice passed; `deviceRegistryStore.test.js` 7/7; `dmRatchetTransactions.test.js` 6/6 | Fake IndexedDB and Node tests. They do not prove application integration for R/A/D or cross-browser authority lifecycle. |
| `npm run lint` | Exit 0 | Existing warnings remain. |
| `npm run test:security-context-lifecycle-browser` | Pass | Also holds a payment-watcher result across a local tab lock: no receipt, consumed-transfer ledger entry, order send, or stale UI effect is recorded, while the still-current sibling completes the fixture. Watcher/send are test doubles; no signed watcher or relay behavior is proved. It still does not exercise the standalone R/A/pin stores. |
| `npm run build` | Held by intentional safety guard | `.grok/app-env.json` is present; the guard refuses to merge it into a shippable build. The file was left untouched. |
| `git diff --cached --check` | Pass at earlier checkpoint | 103 paths were staged at that checkpoint; this is historical only. |
| Focused DM authority/transaction/outbox tests (2026-11-09) | 23 passed, 0 failed | Confirms proof checks, atomic helper transactions, lifecycle fence behavior, changed-ciphertext/state same-operation rejection, plaintext-only-after-ratchet callback contract, and expiry recheck after awaited outbox status writes. Node/fake-IndexedDB only; still prototype evidence. |
| Focused lifecycle/authority/outbox continuation (2026-11-09) | 47 passed, 0 failed | Command: `node --import ./scripts/resolve-extensionless.mjs --test src/hooks/securityRecordLifecycle.test.js src/lib/securityContextFence.test.js src/lib/securityContextCoordination.test.js src/lib/indexedDbContextGate.test.js src/lib/accountDatabaseCleanup.test.js src/lib/dmRatchetTransactions.test.js src/lib/ratchetProofAwareTransport.test.js src/lib/outboxWriteAhead.test.js`. Unit/fake-IndexedDB coverage; not browser race evidence. |
| `npm run lint:core` (2026-11-09) | Exit 0 | Existing unused-variable and hook dependency warnings remain; no lint error. |
| Expanded lifecycle browser harness (2026-11-09) | Pass after serializing navigation | Supersedes the earlier timeout row below. Expanded Chromium coverage and its mock boundaries are recorded in the later pass row. |
| Full `npm test` continuation (2026-11-09) | **Incomplete; no result** | An earlier aggregate stopped producing output after subtest 531 and its child process was no longer visible. Superseded by subsequent clean-index verification. |
| `oxlint src/lib/dmRatchetTransactions.js src/lib/dmRatchetAuthority.js src/lib/outbox.js src/lib/dmRatchetAuthority.test.js src/lib/outboxWriteAhead.test.js` | Exit 0 | Focused lint for the modified prototype, queue, and regression tests. |
| `git diff --check` | Pass | No whitespace errors in current unstaged documentation/code delta. |
| `npm run test:security-context-lifecycle-browser` | Pass after local-only bind permission | Verifies stale callback/database/outbox behavior in Chromium; relay, watcher, and media endpoints are mocks. Initial sandbox attempt failed with `EPERM` binding `127.0.0.1:8098`; the approved retry passed. |
| `npm run test:security-context-lifecycle-browser` (serial navigation, 2026-11-09) | Pass | Expanded Chromium run covered lock-raced authority write, concurrent pin/peer successor forks, resume after missed invalidation, storage refusal, actual blocked account DB deletion and successful retry, allocator failure marker retention, sibling continuity, stale UI/effect fences, and wipe. Prebundling `lucide-react` removed a cold-start storm of hundreds of icon requests that delayed the probe. Prototype-only stores have no app callers; relay/watcher/media services remain test doubles. |
| `npm run test:protocol-mode` (2026-11-09) | 2 test files pass; 7 assertions groups | Checks paired build flags, required local allowlist, URL restrictions, disposable identity/device creation, isolated DB namespace, stop/hold semantics, cleanup namespace restrictions, and missing-config fail-closed behavior. |
| `node --import ./scripts/resolve-extensionless.mjs --test src/lib/testRelayOverride.test.js` (2026-11-09) | 3/3 pass | Real Vite SSR bundle probes show shipping builds omit the test relay wall, the UI-test build routes to loopback, and protocol-test mode ignores saved overrides and has no ordinary egress URLs. |
| `VITE_PROTOCOL_TEST_RELAYS=ws://127.0.0.1:18888 npm run build:protocol-test` in `/tmp/cipher-protocol-test-build-check` | Pass | Built the current source copy without `.grok`, dependency caches, or desktop output because this workspace's intentional `.grok/app-env.json` guard refuses non-desktop builds. Output includes `protocol-test.html` and no `index.html`; bundle scan found no production DM relay, account DB name, or ordinary app entry. This is a local test artifact, not a release build. |
| `node scripts/protocol-test-mode-browser-test.mjs` in the isolated build copy | Pass | Chromium verified label, relay allowlist display, disposable public identity/device, separate DB, no production account DB/local owner marker, no non-local request or WebSocket, kill switch hold, and explicit DB deletion. No message publication is implemented. |
| Full `npm test` aggregate on dirty root (2026-11-09) | **1,352 passed, 4 failed, 5 skipped (1,361 tests)** | All four failures were stale assertions in `src/lib/panicWipe.test.js`: wipe now deletes `CipherSecurityContextCoordinationV1`, while four expectations still asserted a 9-database count/list. Updated the test fixture/counts; focused rerun passed 9/9. Superseded by clean-index verification on 2026-11-10. |
| `node --import ./scripts/resolve-extensionless.mjs --test src/lib/panicWipe.test.js` (2026-11-09) | 9 passed, 0 failed | Confirms expected wipe inventory includes the security-context coordination database and existing failure/cleanup behavior. |
| `npm run test:ratchet` (2026-11-09) | 7 passed, 0 failed | Actual pinned vodozemac 0.11.2 Olm v2 behavior tests. They use runtime-generated keys and are not static Cipher protocol KATs or Nostr/app integration evidence. |
| `npm run test:ratchet-browser` (2026-11-09) | Pass | After the sandbox blocked spawning `wasm-bindgen`, the exact command passed with local toolchain and loopback browser-test access. Exercises the Rust/WASM adapter in Chromium, not the separate protocol-test artifact. |
| Clean-index verification (`scripts/clean-verify.sh`, 2026-11-10) | **Pass** | Exported staged index tree `420095c456ad7deab242e5932249a387096132cb` from HEAD `2172f726f83923801b87ea93de897d4b271add9a`. `npm ci`, `npm run lint`, `npm run build`, `npm test` (**1,361 passed, 0 failed, 0 skipped**), protocol-mode tests, dedicated protocol-test build, and protocol-test browser boundary all exited 0. Manifest: `docs/evidence/clean-verify-20261110T023008Z.json`; retained log SHA-256 `2f5a5da099cd6aeb26339bf37f2c4f60170ab96a850578c93e8d0a408dabfe44` after trailing-horizontal-whitespace normalization (ANSI sequences retained; final extra blank line removed). This exact snapshot predates the relay-fault extension below. |
| Clean-index verification (staged snapshot, 2026-11-10) | **Pass** | Against tree `d07e297b04de34dc81b1651c2be57db9c5e0a677` at unchanged HEAD `2172f726f83923801b87ea93de897d4b271add9a`, `npm ci`, lint, production build, `npm test` (**1,362 passed, 0 failed, 0 skipped**), protocol-mode tests (8/8), dedicated protocol-test build, and Chromium protocol-test boundary all exited 0. Evidence: `docs/evidence/clean-index-verification-20261110T051445Z.json` and `.log` (SHA-256 `e94086fe3bd5f985e95f6f155793cc286ef6a3f9efa1fbbe11991472fa02b902`). The earlier sandboxed run `clean-verify-20261110T043433Z` was incomplete because subprocess and loopback tests were denied with `EPERM`; the unrestricted exact-index rerun supersedes that result. These checks do not prove live DM security or satisfy the commerce operator/two-party gate. |
| Local relay fault harness (`node scripts/local-nip01-relay-fault-test.mjs`, 2026-11-10) | Pass | Disposable Chromium clients cover per-connection NIP-42 AUTH, invalid challenge refusal, delayed and reverse-ordered delivery, dropped ACK with exact-event retry, and per-frame endpoint capture. No ratchet message format is exercised. |
| Signal-file guard I12 (`node scripts/signal-file-guard.mjs`, 2026-11-10) | **Pass (new artifact)** | `scripts/signal-file-guard.mjs` audits the staged index for changes to AGENTS.md signal files without a recorded reason. All currently staged signal-file diffs carry ledger reasons (useNIP44DM.js +69/-11 fence assertions; outbox.js +59/-6 ratchet-row context gate; paymentWatch.js +95/-65 v2 signed-report trust; egress.js +4/-0 protocol-test build guard; groupKeyStore/groupKeyDistribution/groupKeyRotation/groupDocWire/groupMessageCodec/gmIdentity captured-fence writes). Red-when-reverted confirmed: appending an unreasoned edit to src/lib/privacy.js turned the guard red (`--worktree`, exit 1), then the file was restored byte-identical and the guard returned to pass. Limitation: the reason ledger is maintainer-curated text; it proves a reason is recorded, not that the reason is correct. |
| Fault proxy I3 (`node scripts/fault-proxy.test.mjs`, 2026-11-10) | **Pass (new artifact)** | `scripts/fault-proxy.mjs` sits in front of the disposable local relay with bidirectional latency injection, drop-once and mutate-once frame faults, and a per-connection record (direction, text, timestamps, both endpoints). The focused test drives a raw-socket WebSocket client (Node 20 has no global WebSocket; no new dependency) through three cases against the real local relay: pass-through with both directions recorded, ≥250ms latency observed at the relay side, one drop-once EOSE recorded as exactly-one dropped frame while a second subscription's EOSE passes. Exit 0. Loopback-only; it records injected faults so evidence shows what happened on the wire. Two implementation gaps found and fixed during verification: the upstream socket originally never performed its HTTP WebSocket upgrade (relay then never parsed frames), and close() left sockets open (hang); both covered by the passing test now. Uses by Phase 3 expiry/AUTH tests are next; not yet consumed there. |
| Baseline re-run on current tree (2026-11-10) | **Pass** | Index tree at this checkpoint: `f6a76d37852d693b0a556159c175f6ea3c094c85` (175 staged paths before this session's additions; drift from the last recorded `d07e297b...` run is exactly the previously reported new slice: commerce two-account harness, operator test, watcher-real-handler spec, and their evidence files — nothing else changed). Re-ran on this exact tree: `npm run test:commerce-local-relay` pass (three kind-1059 events, watcher accepted signed v2 report); `npm run test:dm-local-relay` pass; `node scripts/local-nip01-relay-fault-test.mjs` pass; `npm run test:watcher-operator` pass. `npx playwright test tests/ui/watcher-real-handler.spec.js` could not start in the workspace because the full-suite webServer runs `npm run build:ui-test`, which routes through the root vite build refused by `.grok/app-env.json`; that spec was verified inside the isolated UI suite snapshot earlier (184/184 evidence), not re-proven in-workspace here. |
| Existing two-account relay baseline (`npm run test:dm-local-relay`, 2026-11-10) | Pass | Confirms existing NIP-44/NIP-59 app send/receive and synthetic R5 fixture against loopback. Ratchet ciphertext/state remain fixtures; this is not protocol-test app integration. |
| DM test profile freeze (plan §3 items 3–6, Phase 2 DM side) | **Code complete + locally verified (new artifacts, this session)** | `docs/DM-TEST-PROFILE-V1.md` freezes the kind-14 test wire profile (route key in `p`, device-certificate send-time freshness gate, D1 five-minute revocation grace and D3 24-hour registry-head age marked TEST-PROFILE DEFAULTS ONLY, receive-side verification order, Olm v2-only inbound, dedupe on (sender device, operation id) with digest compare). Wire module `src/lib/protocolTestDm/` (+ canonical operation encoding, reviewer-open points marked in the spec). KATs from fixed seeds in `test-vectors/dm-v1/` (now **7 files**, see freshness row below); generator reruns byte-identical; independent verifier `scripts/verify-dm-kat.mjs` re-derives expectations from vector data alone (imports nostr-tools nip44, NOT the wire module) — now **95 checks** after the freshness extension. Focused lane `npm run test:protocol-dm-lane`: **78 pass / 0 fail**. oxlint clean. Limits: spec-level, no app path wired; D1/D3 are test-profile defaults pending specification review; production paths untouched. |
| Freshness envelope for retry-after-expiry (profile sections 8–9; R5-B two-envelope question) | **Code complete + locally verified (new artifacts, this session); REVIEWER-OPEN items stated** | Profile gained section 8 (the ONE canonical `freshnessEnvelope` shape, frozen exactly one form: JSON object inside the Olm-encrypted payload under key `freshnessEnvelope`, authenticated by the Olm MAC BY CONSTRUCTION, bound by triple digest equality over JCS bytes — NOT a separate signed event, that alternative was considered and rejected as out of scope) and section 9 (receive-time offline semantics: D3/certificate gating applies only when certificates are held; duplicate redelivery decided by digest-matched journal entry may skip certificate re-checks, conflicting digests always reject, first-time messages NEVER bypass steps 5–6). Implementation: `src/lib/protocolTestDm/freshnessEnvelope.js` (build/verify, fail-closed stable reasons envelope-shape / digest-mismatch / target-mismatch / envelope-expired, boundary notAfter==now verifies) wired into `receiver.js` step 9 redelivery (`redelivery-freshness-rejected`) with zero change to first-time behavior. KAT vector file #7 `test-vectors/dm-v1/freshness-envelope.json` from fixed seeds (accept/expired/target-mismatch/digest-mismatch/boundary cases), generator rerun twice = byte-identical (coordinator verified sha256 match); independent verifier extended WITHOUT importing the module (+11 checks, now 95). Coordinator-verified: freshness tests 20/20, full protocol-DM lane 78/78, oxlint clean on all three new files. REVIEWER-OPEN: dedupe-record lifetime == inbound-journal lifetime == local history retention (single value to avoid two-valid-envelope windows) needs independent confirmation before v1 final. Limits: LOCAL-TEST tier only; no app caller; no interop claim. |
| Two-device reload dedup capture (Phase 3 open item from the rumor-id ledger row) | **Pass — new artifact** | New `scripts/two-device-reload-dedup-capture.mjs` (npm runner `test:reload-dedup`, registered near test:dm-local-relay): disposable loopback NIP-01 relay, two independent browser profiles, device A sends 3 distinct DMs via the real `useNIP44DM.sendDM` path, then BOTH devices perform TWO full reload cycles each, the second after a relay REPLAY of every event again from history (at-least-once). **13/13 assertions loud-pass**: B holds exactly the live rows with zero rumor-id duplicates; A's own rows appear once under rumor ids and never under wrap ids permanently; reply tags resolve to parent post-reload; cipher-order request and acceptance updates stay singletons keyed by rumor id across reloads; vendor ledger resolves to a unique order card. Legacy case deliberately captured as EXPECTED-FALLBACK: a synthetic pre-fix wrap-keyed own-sent row injected before reload survives fallback resolution exactly once and is NOT promoted permanently into a rumor key. Evidence JSON saved to `test-evidence/two-device-reload-dedup-capture.json`. Limits: loopback relay only, not public-relay evidence, no route privacy claim; exercised production read paths without modifying them. |
| Recovery ceremony spec v1 (Gate 1 item 3, plan §3 lifecycle) | **Spec candidate written; implementation open** | `docs/RECOVERY-CEREMONY-SPEC-V1.md` (marked design candidate for independent review; test profile only): eight-phase versioned state machine (initiate from healthy device, out-of-band contact fingerprint verification, recovery-material issuance defining exactly what R custody authorizes, hold/suspend window not a revocation freeze, successor claim by new device, user-mediated competing-successor resolution with no automatic timestamp/registry-size tie breaker, authority transfer commit, old-device fencing post-transfer), durable per-phase records (CeremonyIntent, ContactAck, HoldExtension, SuccessorClaim, CompetingObservation, TransferCommit, FencedState) with defined resumable-or-safely-aborted interruption states at each boundary reusing the existing exact-event idempotent retry/CAS contract, restore-from-older-backup semantics (cannot resurrect revoked ratchet state or forge newer registry heads; monotonic head/lag detection with no automatic merge), and a plain statement that a recovery root can replace account authority if stolen and has no protection against its own theft without another trust anchor. Limits: spec-level only; no ceremony record builders, no app path, no UX; prototype evidence limited to existing isolated device-authority modules and their browser tests; REVIEWER-OPEN tags F-O1 backup availability choice during recovery window, F-O2 contact rotation during pending ceremony, F-O3 D-window/hold parameters, F-O4 UX copy pending owner-selected test-profile defaults. Nothing is marked verified; production paths untouched. |
| MLS test profile groundwork (plan §3 items 12–18 partial, Phase 2 M side) | **Code complete + locally verified (new artifacts; several gates explicitly open)** | `docs/MLS-TEST-PROFILE-V1.md` (marked TEST PROFILE ONLY): governance binding (authenticated GroupContext extension carrying previous governance revision+hash, admin-at-revision committer rule, receiver buffering until both events verify), admission handshake shape, copy-on-write transactional storage semantics, per-member epoch attestations compared across relays, past-epoch retention configuration, rejoin rules. Modules under `src/lib/mlsTest/` with colocated tests: governance binding, epoch attestation, admission handshake, copy-on-write snapshot store, commit validators (forged commit / roster-only add / wrong previous revision / mismatched cross-hash / replay / fork rejection), receiver buffer state machine, past-epoch retention wrapper. Focused suite: **40 pass / 0 fail**. Vector generator writes 8 deterministic vectors to `test-vectors/mls-v1/`. oxlint clean. Item 18 (pinned OpenMLS 0.9.2/IETF vector run) completed 2026-11-10 at LOCAL-TEST evidence tier: crate promoted to `crypto/mls-wasm` (git-mv, history preserved), vectors vendored from the v0.9.2 tag filtered to cipher suite 1 under `test-vectors/ietf-mls-0.9.2-cs1/` with sha256 manifest, runners in `crypto/mls-wasm/src/pinned_vectors.rs` + `scripts/run-mls-vectors.mjs` (`npm run test:mls-vectors`). Families green: key-schedule 1/1, transcript-hashes 100/100 (independent RFC 9420 reimplementation incl confirmation-tag MAC and confirmed/interim chaining), messages 100/100 (byte-exact round trips plus GroupSecrets/Commit structural walks mirroring the upstream KAT's scope), psk_secret 10/10, welcome 1/1, passive-client-welcome 8/8 (public join path, epoch authenticators compared; expired vector lifetimes handled via the public `skip_lifetime_validation` knob exactly as upstream does). Loud skips only where OpenMLS 0.9.2 keeps needed symbols crate-private: secret-tree 3, treekem 11, both counted and reasoned in every summary (`FamilyResult`); upstream itself serializes but never decodes the reinit/external-init/group-context-extensions message fields and our runner mirrors that scope instead of silently claiming decode coverage. Evidence tier: LOCAL-TEST ONLY — NOT interoperability until a separate IETF interop client run happens. Still open (Phase 4): groups_relay envelope flow, three-member flow, attestation capture over an actual relay. |
| `npx oxlint scripts/local-nip01-relay.mjs scripts/local-nip01-relay-fault-test.mjs` (2026-11-10) | Exit 0 | Focused lint for the Phase 1 local relay fault modes. |
| Protocol-test flags and screen (2026-11-10) | Focused unit tests and oxlint pass; isolated build and Chromium boundary harness pass | Exported the staged index to `/tmp/cipher-protocol-mode.g18UGt`, overlaid the six current unstaged test-mode files, and used the installed dependency tree by symlink. `VITE_PROTOCOL_TEST_RELAYS=ws://127.0.0.1:18888 npm run build:protocol-test` passed. The browser harness passed after local loopback permission; it verified the disposable identity/device, test namespace, stop/hold and cleanup, and explicitly observed no relay messages. Direct root build remains refused because `.grok/app-env.json` exists. |
| R5 send-time/revocation review record (2026-11-10) | Owner defaults recorded; review open | Product owner selected a five-minute D1 post-revocation grace and a 24-hour maximum age for the sender's pinned authenticated registry head at send time, for test-profile evaluation only. `R5-SEND-TIME-REVOCATION-DECISION.md` records the exact limits and remaining trusted-time/offline questions. No application acceptance rule was implemented. |
| Full commerce/security UI regression (2026-11-10) | **184 passed, 0 failed, 0 skipped** | `npx playwright test --workers=1 --reporter=line` ran in a disposable snapshot at temporary commit `3ce47251f105c54837e9288cb1191c2c7163eca2`, tree `15d279ee3fb2bbd681b50562e286c52cca6912c5`; repository HEAD remained `2172f726f83923801b87ea93de897d4b271add9a`. Includes signed watcher v2 fixtures and the two close/reopen at-rest queue cases. All relay/watcher/network effects remain synthetic or loopback. Evidence: `docs/evidence/commerce-security-ui-20261110.json`. |
| Current source-snapshot checks (2026-11-10) | **Build and unit suite pass** | `npm run build` passed in the same disposable snapshot with ignored `.grok` config excluded; `npm test` passed **1,362/1,362**, 0 skipped, in 8m21s; `npm run lint` exited 0 with existing warnings. Focused at-rest/write-queue/context tests passed 29/29. These checks include the message queue fix and signed-v2 fixture updates. |
| Full commerce receipt loop end-to-end (`npm run test:commerce-local-relay`, 2026-11-10) | **Pass, 3 consecutive runs (new milestone)** | The staged two-account harness now exercises the REAL production commerce path per role: buyer request via `__dm.sendDM`; vendor acceptance through `getOrderPaymentMethods` per-order allocator with a synthetic valid Monero mainnet pair; BOTH sides' watcher checks through production `checkPayment` against pinned signed-v2 reports from a local watcher backed by synthetic wallet RPC (buyer's N1 device mark persisted via the same `patchMessage` seam as `updateLocalOrder`); vendor's real receipt path (ledger lock, consumed-txid gate, `signReceipt`, `receipt_<id>` scoped persist, ledger append); buyer countersign via live ingest `receiptMayBind`+`acceptPayment`+`sendCountersignOnce`; two-signature `verifyReceipt` pass on both devices; consumed-ledger binds txid AND address to this order only (txid/address replay-refusal contract asserted). Limits: synthetic identities/RPC/transfer/txid; in-page lib modules rather than shipped Chat shell buttons; local relay/watcher; no deployed operator setup; no anonymity claim. |
| Rumor-id identity fix for own sent DM rows (2026-11-10) | **Fixed + verified (production bug found by this slice's e2e)** | After the NIP-59 transition, a sender's OWN message row was persisted under the kind-1059 WRAP id, but every peer-side cross-reference names the RUMOR id (the recipient's unwrap, reply tags, acceptance `orderId`, receipt binding): buyer order cards were unreachable by acceptance updates (binding refused: "does not track as accepted"), vendor F4 self-write gate could never see its own acceptance update row, and replies to own DMs resolved to no parent. Fix: `useNIP44DM.sendDM` returns `rumorId` on all success paths (plain and idempotency-reserved); `sendCheckoutOrder` and composer DM send key their confirmed row on `result.rumorId || result.event.id` (legacy fallback intact); `deliverOrderUpdate` persists the device's own sent order-update row keyed rumor-id so the F4 gate sees it (own gift wraps never echo back — no subscription filter matches a wrap author). Verified by the 3× full commerce loop above plus focused suites: useCommerce/useComposer/orderActions/orderLedger/proofOfTrade **86/86**, fence-ordering source assertion updated for the new persistence seam, full `npm test` **1,355 pass / 2 pre-existing guard failures fixed** (test-runner ownership extended to dedicated lane runners; uiWords waiver for TEST-ONLY `lib/protocolTestDm/testPublisher.js` whose relay/challenge strings are NIP-42 wire tags), oxlint clean (lint exit 0; one pre-existing warning class unchanged). New npm runners registered: `test:protocol-dm-lane` (**58 pass / 0 fail**), `test:mls-lane` (**40 pass / 0 fail**), `test:fault-proxy` (pass). Signal-file guard passes; reason entries unchanged (this fix touches already-ledgered files and others that are not signal files). Remaining open: history-fetch dedup interaction with rumor-keyed own rows across reloads is exercised by existing suites but deserves an explicit two-device reload capture in Phase 3; legacy wrap-keyed rows (pre-fix restores) still resolve via fallback ordering — noted for review. |
| Scoped route keys + @ name discovery spec (Gate B design slice; OWNER DECISIONS #5 vs Gate B conflict) | **Spec candidate written + primitive KATs locally verified (new artifacts, this session); REVIEWER-OPEN items stated** | `docs/SCOPED-ROUTE-DISCOVERY-SPEC-V1.md` (marked design candidate for independent review; test profile only): scoped route keys — per-contact/per-device/per-direction HKDF-SHA256 derivation emitting a 256-bit route secret and blind tag (exceeds the >=128-bit Gate B floor), domain-separated deterministic rotation chain `SHA-256("cipher-route-rotate-v1" || prev || LE64(counter))`, revocation propagation via authority-signed registry-head updates so relays see only blind tags and can never map revocation to an account, plus a field-by-field walk proving no account key appears in any ordinary route tag. @ name discovery evaluates three candidates (capability-token discovery blob addressed by keyed handle blind tag; relay-side private namespace service with honest operator-trust statement; social-graph transitive introduction with availability cost) and RECOMMENDS the capability-token blob (kind 30090, per-handle discovery key, salt-carrying (handle, salt) capability pair, seq monotonicity, MAX_BLOB_AGE and per-key rate-limit TEST-DEFAULTS) with explicit enumeration numbers: with the salt out of band, blind tags give ~2^-256 guessing success and no testable dictionary surface; a leaked salt space makes dictionary enumeration computable at ~10^5-10^6 guesses/second for short handles, motivating >=12-char handles. Sender-IP boundary statement references the forwarder prototype: entry hop sees source IP and not the destination capability, mailbox hop sees the destination capability and only the forwarder's address, entry/mailbox collusion and timing correlation UNMEASURED (Gate C subjects). Primitives: `src/lib/protocolTestGateB/routeKeys.js` (+ `routeKeys.test.js`) — `deriveRouteSecret`, `rotateRouteSecret`, `verifyBlindTag` as pure node:crypto functions with colocated fixed-seed KAT vectors; `node --test` **8 pass / 0 fail**, oxlint clean. Frozen vs REVIEWER-OPEN: hash/HKDF derivations and domain separation frozen; rotation cadence (owner decision pending), revocation propagation window, discovery-blob byte canonicalization, MAX_BLOB_AGE/rate-limit values, and contact-secret device pooling all left REVIEWER-OPEN. Limits: primitive-level KATs and design-candidate spec only; no anonymity claim, no app path wired, production paths untouched. |

## Detailed acceptance criteria (status is in the single gate ledger above)

These gates are roadmap work and do not authorize a production migration. The
shared Nostr account remains Cipher's signed identity and remains linked to its
public vendor reputation. That linkage is intentionally visible on public
commerce/reputation surfaces. Private delivery routing, sender-IP protection,
metadata resistance and independent evidence are core completion gates, not
optional enhancements. Do not add merchant identity migration or per-group
identity-compartment migration. A random private delivery address is a scoped
routing capability, not a new public account identity; protocol authentication
must bind it to the shared account and authorized device without publishing the
account key as ordinary route metadata. The shared account key can still
correlate public profile/reputation surfaces and any legacy NIP-44 history;
captures must state each such residual. The current group actor wire shape is
a compatibility boundary and remains outside this migration.

| Gate | Threat and owner | Dependency order | Testable acceptance | Evidence now |
| --- | --- | --- | --- | --- |
| A. Relay-visible baseline | Relay operators and colluding operators may join identifiers, query filters, IP, timing, size, and delivery activity. Owner: protocol/security lead with client QA and two test accounts. | Specify during lifecycle work; capture after the current lifecycle slice; feed the routing and traffic decisions. | Consented test-account captures on desktop and web cover DM, group, search, media, push, and public trade flows. For each operator and plausible collusion set, record observed source IP, author/recipient tags, persistent IDs, queries, event arrival time, created_at, sizes, and delivery activity. Redact secrets and pin tested build/revision. | Source audit: live NIP-59 wraps use a public `p` tag containing the recipient account key, a 30-day expiration, a random outer author, and a `created_at` backdate of up to two days. Subscriptions/history query `#p` with the account key; peer relay-list lookup queries `authors` with the peer account key. `SimplePool` uses ordinary direct relay connections; no Tor/onion forwarding path is present. Rumor padding targets 640 JavaScript string code units before sealing, so longer content still creates size classes and the target is not a byte guarantee. This is a code audit, not a packet capture; arrival timing, actual wire sizes, and per-hop IP observations still need two-device captures. |
| B. Private delivery routing and IP protection | A delivery relay may learn a recipient account/address-book query, link a reused route, or observe sender IP. A single or cooperating operator may correlate endpoints. Owner: protocol/security lead and client transport owner; independent routing reviewer. | After R/A/D authority, authenticated device add/revoke, route rotation, recovery limits, and Gate A baseline; reviewed routing/transport spec must precede any test-account DM integration. This gate is on the release critical path. | Use cryptographically random routes with at least 128 bits of entropy, scoped per contact and device, with independently random directions where supported; never publish an account-to-route directory. Capture shows zero N/R/A or globally stable D identifiers in ordinary route tags/queries; stale/revoked routes are refused; route rotation works across two accounts and two devices. The destination/mailbox relay's observed peer IP must not be the sender's origin IP. State which forwarding hop sees source IP and which sees destination capability; one operator alone must not learn both. Test entry/mailbox collusion and timing correlation, address-book queries, invitations, offline expiry, fanout, spam, downgrade and NIP-44 history. Any stable identity join or platform without IP protection blocks that platform's release. | Live DMs still route by account-key NIP-59 tags over ordinary relay connections. No scoped route, privacy-forwarding/Tor route, or current-tree two-device capture exists. |
| C. Address-book, timing and size resistance | Reused route identifiers, exact timestamps, event counts and size classes can reveal contact edges or conversation activity. Owner: privacy measurement lead and client performance owner; independent traffic-analysis reviewer. | Measure alongside Gate A; specify and review defenses after authority/device rotation and routing design, before test-account DM integration and before release. Group migration stays a separate gate. | Capture baseline and candidate wire traces for text, control, orders, receipts, attachments, quiet periods and bursts. Report route-to-account/contact linkability and held-out content/activity classifier AUC, p50/p95 delivery delay, bytes per logical message, batching wait, and battery cost. Proposed starting limits for independent review: route-to-account/contact inference AUC ≤0.55 for one relay and ≤0.65 for two specified colluding hops; timing/size classifier AUC must improve at least 25% relative to baseline; p95 online delivery delay ≤3 seconds and corpus-average wire bytes ≤2× baseline. Ratify or replace these numeric limits before prototype implementation, with reasons and the same measurable bounds; release stays blocked until they pass. Test padding buckets and randomized batching separately; cover traffic is not a pass without demonstrated benefit. | Existing NIP-59 padding targets 640 JavaScript string code units before sealing, but no current wire-size, address-book, or classifier measurements exist; quantitative limits await independent review. |
| D. Group governance then MLS evaluation | A relay or stale device state could substitute membership, grant a key to an unverified member, or roll back an epoch. Owner: group protocol lead; independent group-protocol reviewer. | First finish the pinned owner-authorized membership-document path and bind each grant/Welcome to its verified document and epoch. Then evaluate OpenMLS separately from DM routing. | Verify authenticated key packages, commit/Welcome against the pinned governance authority, removal and re-add behavior, offline members, storage/rollback, history/recovery policy, and compatibility. Two-client malicious-relay/stale-state tests and independent review pass; no grant occurs without verified membership. Document that relay withholding can block availability and removed members retain plaintext/key material already decrypted. | Signed member-document and rotating-key tests exist; live groups still use shared AES-GCM epoch keys. OpenMLS remains an evaluation, not production integration. |
| E. Independent release evidence | Prototype success may be mistaken for production security or anonymity; a compromised build/dependency may invalidate protocol claims. Owner: release/security lead plus independent protocol and implementation reviewers. | Cross-cutting; before any production privacy claim or protocol rollout, after DM/routing specs, test-account integration, and group decision gates. | Independent review covers DM, routing, and group protocol; produce reproducible signed builds and dependency inventory; capture two-device live-relay behavior; test fork, downgrade, replay, stale authority, crash recovery, revocation, and operator correlation. Each claim names tested build, adversary, evidence, and remaining leakage. | Unit and prototype/browser evidence only; no full independent review or complete current-tree relay capture. |
| Supporting: copied-vault resistance | An attacker with a copied vault can guess offline; a local retry counter or wipe flag does not constrain copies. Owner: vault/security lead. | Measure the current vault before changing derivation or recovery; coordinate with recovery and backup semantics. | Benchmark offline guesses against copied-vault fixtures; evaluate memory-hard KDF parameters, stronger recovery secret, and hardware-bound key options. Specify rollback-safe backup behavior and recovery availability before selecting a change. Do not count a local retry/wipe counter as copied-file protection. | No copied-vault guessing benchmark or accepted KDF/recovery decision recorded. |
| Supporting: low-signal metadata controls | Read receipts, typing, mailbox tags, sizes, and timing can expose activity even when content is encrypted. Owner: product privacy owner and messaging protocol lead. | Gate A measures current exposure; defaults and protocol behavior are decided before test-account integration; Gate C provides the measured mitigation. | Confirm read receipts and typing default off or minimized; disabled settings emit no relay-visible event. Include these events and private mailbox tags in the address-book, size and timing measurements; report delivery impact and bandwidth. This is part of Gate C acceptance, not a substitute for it. | Current-tree defaults and mailbox-tag measurements remain open. |
| Supporting: public trade identity and transaction data | Cross-service linking is intentional for the existing public vendor reputation, while raw chain identifiers may expose trade details. Owner: commerce/security lead. | Preserve the account-key/vendor reputation link; complete the source/wire audit with the commerce release evidence. | Public reputation remains signed by the existing account identity. Raw transaction IDs are not emitted as a default public receipt/bulletin field; any future publication is a separate explicit opt-in with a documented chain-analysis warning. | Existing vendor bulletin design uses receipt hashes rather than raw transaction IDs; retain and verify this boundary. No public-identity split is planned. |

The active dependency sequence is: lifecycle and independent authority/device
rotation → relay-visible baseline → reviewed DM and delivery specifications →
isolated opt-in DM test mode using disposable identities and a local/test relay
→ test evidence and independent review → separate production rollout decision.
Scoped routes, sender-IP protection, and measured metadata resistance are
production release gates; they are not silently claimed or folded into the
disposable local test-mode gate. MLS has a separate branch: stable owner/admin
governance → reviewed governance-to-epoch binding → isolated opt-in MLS test
groups → independent evidence → separate production migration decision. The
shared test-only build boundary, lifecycle fences, disposable identities,
local relay evidence, and cleanup controls are common prerequisites. See
[`IN-APP-PROTOCOL-TEST-MODE-PLAN.md`](IN-APP-PROTOCOL-TEST-MODE-PLAN.md) for
the exact boundaries and acceptance cases. The authority store integration is
currently blocked by the missing independent R backup/restore and
contact-verification ceremony; see the lifecycle inventory for exact app
callsites and limits.

## Recommended order of work

### Gate 0 — establish the baseline and preserve the current work

1. Keep the current `security-ui-remediation` changes uncommitted until owners
   review the exact diff and the full UI suite result. No deployment, publish,
   or production DM change follows from this research task.
2. Snapshot inventory found **39 registered worktrees**: the current root has
   42 changed/untracked paths; 11 other trees are dirty (`bitch2-r3` 9,
   `bitch2-r4` 15, `catch-fix` 13, `cipher-data` 1, `cipher-desktop` 1,
   `cipher-drills` 27, `txid-fix` 6, `wt-journey` 2, `wt-ui` 7,
   `/tmp/cipher-commerce-remediation` 27, `/tmp/cipher-privacy-impl` 9).
   The other 27 are clean. Treat every dirty tree as valuable work: record its
   branch/HEAD and inspect its diff before closing or merging it. Several
   checkouts share ancestry but are not interchangeable snapshots.
3. Identify which uncommitted changes are the lifecycle/commerce handoff and
   which are older or unrelated. Do not merge or discard another tree by
   assumption.
4. Create one reproducible local NIP-29 relay fixture and pin its binary/source
   revision. Re-run the Phase 0 app flow and capture raw signed WebSocket frames
   from two independent browser accounts. Save exposure assertions with the
   revision and command output.

**Exit:** clean test baseline, clear ownership of each worktree, reproducible
local relay capture, and no unexpected account identifiers in group relay
events/filters/rosters.

### Gate 1 — finish lifecycle and authority prerequisites (R5-A through R5-D)

Finish and test the incomplete lifecycle integration before message migration:

1. Bind database write queues, relay subscriptions, pending decrypts, workers,
   media sessions, recovery operations and every async identity branch to an
   account plus incarnation fence. A lock/switch/remove/wipe must fence stale
   work before durable writes or follow-up effects.
2. Complete authority state storage and exact-successor acceptance, including
   concurrent tabs, stale relay responses, fork/equivocation, rollback,
   revocation propagation and outbox retry. Resolve the 30-second authorization
   proof versus offline queueing requirement in the protocol: define what is
   revalidated at send, enqueue and publish, and which immutable operation is
   safe to retry. A candidate is recorded in
   `docs/R5-DELIVERY-SEMANTICS-DECISION.md`; it is not an accepted protocol
   decision and needs independent review.
3. Complete contact fingerprint verification and recovery-root replacement
   ceremony. Exercise recovery after interruption and restore from an older
   backup. State plainly that a recovery root can replace account authority;
   do not imply it can securely recover from its own theft without another
   trust anchor.
4. Make wipe results report each resource that was or was not removed. Test
   stale task completion after wipe and two-account isolation. Never promise
   physical erasure of browser/OS storage or deletion of remote copies.

**Exit:** browser race tests cover lock, switch, removal and wipe during KDF,
WebAuthn/recovery, relay response, IndexedDB commit and publish; no stale
account effect commits; failures are visible; recovery trust and rollback
limits are documented.

### Gate 2 — write and review Cipher DM protocol v1 before integration

Write a versioned protocol specification with explicit wire schemas, state
transitions and rejection rules. At minimum define:

* identity hierarchy: account authority, device signing identity, per-contact
  or per-device inbox route, and per-session ratchet identity;
* authenticated asynchronous session start, prekey publication/use and
  replacement, replay protection, duplicate/out-of-order delivery, and safe
  behavior when authority or prekeys are missing;
* ratchet state persistence and immutable event/outbox coupling, idempotent
  message and commerce effects, retry after uncertain relay acknowledgement,
  and crash recovery;
* protocol version negotiation and a one-way migration policy: legacy NIP-44
  remains read-only compatible; no silent fallback from a failed new session;
* device add/revoke, device loss, account recovery, ratchet state backup policy,
  rollback detection, and what a newly restored device cannot decrypt;
* metadata table for sender, recipient, each relay, network observer and local
  device: visible identifiers, IP, timing, sizes, online state, retention and
  correlation. Include mitigations and accepted residuals;
* exact cryptographic library/version and test vectors, memory/state deletion
  assumptions, abuse limits and downgrade/fork handling.

Review this spec independently before wiring it into `useNIP44DM.js`.
Session/SimpleX comparisons are design inputs only. Preserve old history and
commerce semantics, but never reinterpret old ciphertext as a new protocol.

**Exit:** versioned spec, threat model, wire vectors, abuse cases, migration
and recovery decision record, implementation review, and independent protocol
review plan.

### Gate 3 — integrate DM for opt-in test accounts only

Entry requires Gates 1 and 2, the test-only artifact and relay/account
enforcement, and a protocol review with no unresolved critical finding. The
test path uses disposable accounts/devices and a local/test relay allowlist.
It is isolated from ordinary `useNIP44DM` conversations and must not use real
account traffic. Scoped routing, IP-forwarding and address-book/timing/size
acceptance remain mandatory production release gates and are measured in the
test path where useful; local test integration does not satisfy those release
gates.

Implement behind a hard protocol-version boundary with no production default
switch. Use two independent browser profiles and a local relay. Exercise first
contact, offline recipient, prekey depletion/replenishment, duplicate,
reordering, replay, corrupt envelope, stale/forked authority, simultaneous
tabs, lock/switch/wipe mid-operation, backup restore, revoked device, and
uncertain publish acknowledgement. Include attachments, orders, receipts and
payment updates as typed authenticated effects.

Capture relay frames and queries. Assert the test artifact accepts only
disposable test identities and allowlisted local/test relays; bind
account/device authority inside the authenticated protocol data; and fail
closed without fallback to NIP-44. Report every visible identifier, IP,
query, timing, size, acknowledgement, and route. Existing NIP-44 history stays
readable. The test-mode gate is not proof of sender-IP protection or production
route privacy; those claims require Gate 5's separate forwarding and
two-device evidence.

**Exit:** reviewed protocol and static vectors, test-only artifact enforcement,
two independent disposable browser profiles on a local/test relay, crash/race
and recovery suite, and wire evidence. Only then prepare a separate rollout
decision. No production migration is included.

### Gate 4 — add an opt-in MLS test-group path, then decide on migration

First stabilize owner/admin governance and review its binding to MLS
credentials, Commit/Welcome, transcript and resulting epoch. Then add the MLS
path only to the test artifact with disposable members and allowlisted local
relays. Test authorized add/remove, KeyPackage, Commit/Welcome delivery,
partial publish/retry, offline Welcome/rejoin, concurrent and stale commits,
replay/fork rejection, persistence/rollback, lock/switch/removal/recovery,
and captured relay metadata. A relay roster never authorizes an MLS commit.
An authenticated removal blocks future epochs for that member; already
decrypted history and copied keys cannot be recalled. Do not backfill old
history to new members by default. Current AES-GCM groups and their history
stay unchanged throughout this test path.

**Test-mode exit:** separate MLS review, two or more disposable member
profiles, local relay capture, tested governance/removal/rejoin/recovery
policy. Production MLS migration requires another decision and its own
compatibility, history, recovery and rollout gate. Do not combine it with DM
rollout.

### Gate 5 — protect private routing and obtain independent evidence (Phase 4/5)

Capture the relay-visible baseline for current DMs, groups, and commerce. Once
contact and device authority can authenticate and rotate routes, implement and
measure scoped random delivery capabilities and a forwarding path that keeps
the sender's origin IP from destination relays. Keep the existing Nostr account
as the signed identity for public commerce and reputation; do not publish a
global account-to-inbox directory or put the account key in ordinary private
route tags or queries where scoped routes work. Capture each hop's IP, route,
query, timing and size view, including a cooperating-operator test. If a
platform lacks a verified IP-protecting path, private messaging on that
platform has not met this gate. Record residual correlation through the shared
account identity wherever it remains visible.

Before prototyping padding or batching, capture route-linkability and
conversation-classifier baselines. Preregister the minimum privacy reduction
and maximum latency, bandwidth and battery costs; test text, control, commerce
payloads and attachments against those bounds. No padding, batching or cover
traffic is a pass by itself; the measured target must be met.

Keep MLS group migration behind its own governance, epoch, recovery, offline
member, and legacy-history gate. Retain the current group actor identity model
unless a separately approved compatibility decision changes it; this gate does
not authorize per-group identity compartments or merchant identity migration.

Run relay tampering/chaos, parser fuzzing, state-machine/property tests,
cross-account correlation captures and device lifecycle acceptance. Commission
independent reviews of the versioned DM protocol, MLS governance/epoch design,
and any production routing path; record reviewer scope and unresolved
findings. A review of a primitive or prototype is not a review of the full
app. In-app opt-in test modes remain separate from production migration and
must never enable production traffic by configuration alone.

**Exit:** each routing or cryptographic change has a stated privacy promise,
two-device wire captures, IP-path evidence, measured address-book/timing/size
results against preregistered targets, legacy/recovery policy, residual
metadata statement, and independent findings with remediation status. Public
vendor reputation remains linked to the existing account identity.

## Decisions to record before coding

1. Which private identifier scope is the first target: per-contact inbox, per
   device inbox, or both? More scopes reduce correlation but increase key
   lifecycle and recovery complexity.
2. Can a conversation use the new DM protocol only when both parties have
   verified device authority, or should there be an explicitly labeled
   legacy-only contact state?
3. Which recovery material, if any, may contain ratchet state? If none, what
   history is knowingly unavailable after device loss?
4. What offline delivery guarantee is required, and how can authorization
   freshness be enforced without expiring already accepted queued ciphertext?
5. Which relay-visible joins exist between the current account identity,
   public vendor reputation, groups, routes, and receipts? Record those joins
   as the baseline. Any future change to public identity linkage requires a
   separate explicit product decision and migration plan.

Do not answer these by coding around them. Record each as a decision with its
security and usability tradeoffs.

## References and scope notes

The local evidence sources are `docs/PROTOCOL-SECURITY-ROADMAP.md`,
`docs/R2-R3-DEVICE-STATE.md`, `docs/R5-INTEGRATION-PLAN.md`,
`docs/IDENTITY-COMPARTMENTS.md`, `docs/GROUP-MLS-DESIGN.md`, and
`docs/PRIVACY-LIFECYCLE-INTEGRATION.md`. Their prototype status is preserved;
this game plan does not upgrade those statuses.

External protocol documents describe the protocols' stated designs. They are
not proof that a deployed app or relay implements every property correctly.
Session's and SimpleX's threat-model documents are attributed to their authors;
Cipher has not independently validated those implementations.
