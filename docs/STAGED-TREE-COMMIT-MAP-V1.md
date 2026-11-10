# Staged-tree commit map v1

Lane: reviewability-map (documentation only). Baseline branch
`security-ui-remediation`, HEAD `2172f726f83923801b87ea93de897d4b271add9a`.

Verification run for this map (2026-11-10T11:49Z, this lane's only git runs):

- `git status --porcelain | wc -l` = **175** staged entries (68 `A`, 107 `M`). This matches the lane brief.
- `git diff --cached --numstat | wc -l` = **175**. Recorded as required.
- Untracked working-tree files exist (7, e.g. `docs/DM-TEST-PROFILE-V1.md`, `src/lib/mlsTest/`, `src/lib/protocolTestDm/`, `scripts/signal-file-guard.mjs`) but are NOT staged and are outside this map's scope.
- The working tree also holds a later working copy; all deltas below are measured on the **staged index** (`git diff --cached --numstat`).

## Plan item 1 correction vs earlier reports

The plan text claims signal-file deltas of `useNIP44DM.js +80, outbox.js +65, groupKeyStore.js +153, paymentWatch.js +160, egress.js +4`. Verified staged deltas (`git diff --cached --numstat`, add|del):

| Signal file | Plan claim (+) | Verified staged (+/−) | Verdict |
|---|---|---|---|
| `src/hooks/useNIP44DM.js` | +80 | +69 / −11 | Corrected: +69, not +80 |
| `src/lib/outbox.js` | +65 | +59 / −6 | Corrected: +59, not +65 |
| `src/lib/crypto/groupKeyStore.js` | +153 | +115 / −38 | Corrected: net +77 (gross +115), not +153 |
| `src/lib/paymentWatch.js` | +160 | +95 / −65 | Corrected: +95, not +160 |
| `src/lib/egress.js` | +4 | +4 / −0 | Correct: +4 |

The plan numbers most plausibly measured net growth of an earlier tree (groupKeyStore's +153 ≈ net before later hunks moved). Every correction is against the current staged index, which is what reviewers will commit.

## Disagreements with WORKTREE-SLICE-INVENTORY.md slices

Two explicit notes, both resolved in favor of the inventory where it speaks:

1. **Commit order.** The inventory's recommended order is "A + B commerce candidate; C lifecycle foundation; D authority bridge; protocol v1 review". The lane brief fixes this map's proposed order as lifecycle (C) first, then commerce (A, B). This is a deliberate ordering difference, not a file-ownership disagreement: every slice's ownership lists below follow the inventory exactly. Ordering is the coordinator's call; both orders are consistent with the inventory's file assignments.
2. **`package.json`.** The inventory says it "remains unstaged" and its manifest hunk "registers lifecycle and privacy suites". It is in fact staged now (`M`, +12/−3). The cross-cutting warning stands: the single `test`-script hunk touches slice A, B, C, D, and protocol-test registrations and must be split by hunk (group 7 below). `package-lock.json` is also now staged (+1/−1, pins `nostr-tools` to exactly 2.25.2) and rides with the commerce/trust commit that justifies the pin or its own chore commit; noted as a conflict-resolution item below.

## Signal-file reasons (AGENTS.md read-only rule)

Every changed AGENTS.md signal file with a stated reason:

- **`src/hooks/useNIP44DM.js`** (+69/−11): lifecycle fencing only — every send/receive/publish path rechecks the captured security-context fence via `assertIdentityCurrent` before touching state; no protocol change.
- **`src/lib/outbox.js`** (+59/−6): lifecycle fencing (fence-checked enqueue and flush) plus the R5-A prototype's `ratchetDelivery` flush gating — the pre-existing `shouldFlushOutboxRow` path, kept here because the prototype contract lives in the shared outbox; no encryption or policy change.
- **`src/lib/crypto/groupKeyStore.js`** (+115/−38): lifecycle fencing — captured-fence assertions around group-key reads/writes; key derivation and distribution math unchanged.
- **`src/lib/paymentWatch.js`** (+95/−65): commerce watcher v2 trust — parse, pin, nonce, and signed-report verification inside the existing watcher boundary; no new trust source.
- **`src/lib/egress.js`** (+4): protocol-test boundary — a test build short-circuits ordinary relay selection to empty, keeping the artifact relay-isolated.
- Other read-only-listed signal files (`useNIP29Group.js`, `privacy.js`, `chatStore.js`, `paymentState.js`) are also touched; reasons appear per-row below (useNIP29Group: lifecycle session teardown and fencing; paymentState/chatStore/privacy: not staged).

---

## Proposed commit order and full path map

Legend per row: status letter, concern category, one-line reason, flags.

### 1) Lifecycle foundation (slice C)

Focused verification (from inventory): browser races via `scripts/security-context-lifecycle-browser-test.mjs`; unit coverage via the lifecycle suites registered in package.json (`securityContextFence.test.js`, `securityContextCoordination.test.js`, `indexedDbContextGate.test.js`, `accountDatabaseCleanup.test.js`, `groupKeyStoreLifecycle.test.js`, `privacyHandoff.test.js`, `identityPublisher.test.js`).

| Path | St | Cat | Reason | Flags |
|---|---|---|---|---|
| `.env.example` | M | 1 | watcher operator env for slice A v2 signing key; rides the first commerce commit's docs, listed here only because the inventory names it under slice A | cross-cutting hunk — must be split by hunk before staging into its owning commit (A, not C) |
| `README.md` | M | 1 | watcher operator setup text; same slice-A ride-along | cross-cutting hunk — must be split by hunk before staging into its owning commit (A, not C) |
| `src/lib/securityContextFence.js` | A | 1 | new account security-context fence, the core lifecycle primitive | |
| `src/lib/securityContextFence.test.js` | A | 1 | fence unit tests | |
| `src/lib/securityContextCoordination.js` | A | 1 | cross-tab context coordination for lock/switch/remove | |
| `src/lib/securityContextCoordination.test.js` | A | 1 | coordination tests | |
| `src/lib/indexedDbContextGate.js` | A | 1 | gates database writes on the active fence incarnation | |
| `src/lib/indexedDbContextGate.test.js` | A | 1 | gate tests | |
| `src/lib/accountDatabaseInventory.js` | A | 1 | enumerates per-owner databases so cleanup and wipe cover each one | |
| `src/lib/accountDatabaseCleanup.test.js` | A | 1 | cleanup result tests | |
| `src/lib/securityContextLifecycleProbe.jsx` | A | 1 | browser probe for lifecycle races | |
| `scripts/security-context-lifecycle-browser-test.mjs` | A | 1 | the two-tab race harness the inventory requires | |
| `src/useIdentity.js` | M | 1 | establishes, retires and coordinates the fence across lock/switch/remove/unlock | cross-cutting hunk — must be split by hunk before staging into its owning commit (also named by the inventory's shared list) |
| `src/lib/panicWipe.js` | M | 1 | wipe now enumerates account-scoped and fixed security databases via the inventory | |
| `src/lib/panicWipe.test.js` | M | 1 | updated wipe assertions for the new database list | |
| `src/lib/pool.js` | M | 1 | adds `querySyncAfterAuthDetailed` used by history/security discovery with failure surfaced | |
| `src/lib/pool.test.js` | M | 1 | tests for the detailed query facade | |
| `src/db.js` | M | 1 | binds the database handle to the active fence, guards writes, scopes at-rest rows per the inventory | |
| `src/lib/writeQueue.js` | M | 1 | queued writes carry context and recheck fence around each flush | |
| `src/lib/writeQueue.test.js` | M | 1 | context-carrying queue tests | |
| `src/lib/idempotentMessageEffect.js` | M | 1 | effect reservation rechecks the fence around async work | |
| `src/lib/idempotentMessageEffect.test.js` | M | 1 | fence-invalidation tests for effects | |
| `src/lib/messageAtRest.js` | M | 1 | pending at-rest writes are scoped to their owning fence incarnation | |
| `src/lib/messageAtRest.test.js` | M | 1 | scoped at-rest tests | |
| `src/lib/safetyNumber.js` | M | 1 | first-seen write rechecks the fence around awaits | |
| `src/lib/safetyNumber.test.js` | M | 1 | fence tests for first-seen | |
| `src/lib/vendorCard.js` | M | 1 | card publish rechecks the fence and honors the test-hook seam | |
| `src/lib/vendorCard.test.js` | M | 1 | vendor card tests updated for the seam | |
| `src/lib/outboxWriteAhead.test.js` | M | 1 | write-ahead retries against fenced enqueue | |
| `src/lib/sessionKey.test.js` | M | 1 | session-key assertions under fenced contexts | |
| `src/lib/mediaCrypto.test.js` | M | 1 | media assertions now cover the test-hook upload seam and fence args | cross-cutting hunk — must be split by hunk before staging into its owning commit (part lifecycle, part UI test seam) |
| `src/lib/messageMerge.test.js` | M | 1 | tombstone application rechecks the captured account context | |
| `src/lib/orderLedger.test.js` | M | 1 | checkout queued branch now asserts the fence before flush | |
| `src/lib/releaseSurface.test.js` | M | 1 | wallet listing assertions updated for fenced publish | |
| `src/lib/testRelayOverride.test.js` | M | 1 | adds the protocol-test probe asserting the artifact reaches no ordinary relay | |
| `src/lib/shakeDetector.test.js` | M | 1 | minor assertion updates to wipe-trigger tests | |
| `src/lib/identityPublisher.test.js` | A | 1 | publish paths recheck the fence after async work (per inventory C) | |
| `src/lib/privacyHandoff.test.js` | A | 1 | exercises queryHistoryDetailed/querySecurityRecords discovery budgets | |
| `browser-privacy-helpers.mjs` | A | 1 | shared two-tab fence browser harness; assigned as test infrastructure on its own per slice E | |
| `src/hooks/usePanicWipe.js` | M | 1 | wipe runs through the coordinated retire path | |
| `src/hooks/useNIP29Group.js` | M | 1 | **signal file — needs recorded reason:** group sessions close and actor caches drop on context invalidation (lifecycle), plus fencing on group sends; no wire change |
| `src/hooks/useNIP29Group.test.js` | M | 1 | tests for session teardown/fencing | |
| `src/hooks/useReactions.js` | M | 1 | reaction send rechecks the fence around each await | |
| `src/hooks/useReactions.test.js` | A | 1 | reaction fencing tests | |
| `src/hooks/useReputation.js` | M | 1 | reputation fetch rechecks the fence around discovery awaits | |
| `src/hooks/useVendorStats.js` | M | 1 | vendor stats fetch rechecks the fence | |
| `src/hooks/useGroupKeyMember.js` | M | 1 | member key install threads the security fence through receipt | |
| `src/hooks/useGroupKeyReconciler.js` | M | 1 | reconciler runs recheck the fence before publishing member docs | |
| `src/hooks/useGroupKeyReconciler.test.js` | M | 1 | reconciler fencing tests | |
| `src/lib/dmRelays.js` | M | 1 | peer relay discovery rechecks the fence around the authenticated pool query | |
| `src/lib/deviceProvider.js` | M | 1 | cached device provider secrets can be forgotten on retire (lifecycle) | |
| `src/lib/escrowPsbt.js` | M | 1 | dormant escrow safeguards only per slice B boundary note | |
| `src/lib/escrowPsbt.test.js` | M | 1 | dormant escrow tests | |

### 2) Commerce watcher v2 trust (slice A)

Focused verification (exact command string from the inventory):

```text
node --import ./scripts/resolve-extensionless.mjs --test scripts/boxes.test.mjs src/lib/paymentWatch.test.js src/lib/vendorPayments.test.js src/lib/escrowPsbt.test.js src/lib/reputation.test.js src/lib/paymentAddress.test.js src/lib/paymentState.test.js src/lib/paymentLedgerLock.test.js src/lib/outboxWriteAhead.test.js
```

| Path | St | Cat | Reason | Flags |
|---|---|---|---|---|
| `scripts/payment-watcher-keygen.mjs` | A | 2 | generates the Ed25519 report-signing key for v2 reports | |
| `src/lib/paymentWatcherTrust.js` | A | 2 | client verifier: pinned key, nonce, exact signed bytes, echoed address/currency | |
| `scripts/payment-watcher.mjs` | M | 2 | watcher signs exact v2 reports with the separate Ed25519 key | |
| `scripts/boxes.mjs` | M | 2 | boxes setup provisions the signing seed beside the access token | |
| `scripts/boxes.test.mjs` | M | 2 | boxes tests cover signing-key provisioning | |
| `src/lib/paymentWatch.js` | M | 2 | **signal file — needs recorded reason:** v2 report parsing, pin/nonce verification, size caps in the payment path; no new trust source | cross-cutting hunk — must be split by hunk before staging into its owning commit |
| `src/lib/paymentWatch.test.js` | M | 2 | v2 verification tests | cross-cutting hunk — must be split by hunk before staging into its owning commit (also carries slice-B receipt tests) |
| `src/components/chat/Connections.jsx` | M | 2 | pin/rotate/remove the watcher signing key at the trust screen | cross-cutting hunk — must be split by hunk before staging into its owning commit (also touched by DM-prototype wiring) |
| `scripts/payment-watcher-browser-test.mjs` | A | 2 | browser watcher flow with signed v2 reports | browser harness — check whether its fixture cases split A vs B |
| `scripts/payment-watcher-operator-test.mjs` | A | 2 | end-to-end operator setup evidence | |
| `tests/ui/payment-watcher-fixture.js` | A | 2 | shared signed-report fixture for UI specs | |
| `tests/ui/watcher-real-handler.spec.js` | A | 2 | real-handler watcher UI flow | |
| `tests/ui/check-catch.spec.js` | M | 2 | refusal branches use the signed v2 fixture | |
| `tests/ui/row6b-shared-address.spec.js` | M | 2 | shared-address row uses the signed fixture | |
| `tests/ui/txid-single.spec.js` | M | 2 | one-transaction row uses the signed fixture | |

### 3) Wallet allocation / payment durability (slice B)

Focused verification: same focused command string as group 2 (it covers `vendorPayments`, `commerceWalletStore` consumers, escrow and reputation), per the inventory's slice A/B shared focused run.

| Path | St | Cat | Reason | Flags |
|---|---|---|---|---|
| `src/lib/commerceWalletStore.js` | A | 3 | Bitcoin allocation store; one allocation device per descriptor | |
| `src/lib/vendorPayments.js` | M | 3 | per-owner allocator context and fenced address issuance | cross-cutting hunk — must be split by hunk before staging into its owning commit |
| `src/lib/vendorPayments.test.js` | M | 3 | allocator concurrency/recovery tests | cross-cutting hunk — must be split by hunk before staging into its owning commit |
| `src/lib/reputation.js` | M | 3 | vouches demoted to unverified endorsements (`tradeEvidenceOf`), never trade proof | |
| `src/lib/reputation.test.js` | M | 3 | endorsement-projection tests | |
| `src/hooks/useVouchCount.js` | M | 3 | counter no longer requires receipt binding; endorsements only | |
| `src/components/chat/VendorMenuHome.jsx` | M | 3 | display drops the shield glyph for self-reported vouches | |
| `src/components/ProfileModal.jsx` | M | 3 | profile no longer reads the removed trade-vouch reader | |
| `docs/COMMERCE-SECURITY.md` | A | 3 | commerce security record for the slice | |
| `docs/evidence/commerce-security-*.json` (3 files) | A | 3 | operator, two-account and UI evidence runs for slice B gates | |
| `scripts/commerce-local-relay-integration.mjs` | A | 3 | commerce flow over the local NIP-01 relay harness | browser harness — local-bind environment needed |

### 4) Group identity / groupKeyStore

Focused verification: the group suites in the focused list registered under group-key names (`groupKeyStoreLifecycle.test.js`, `groupKeyGrant.test.js`, `groupKeyRotation.test.js`, `groupMessageCodec.test.js`, `memberDocPublish.test.js`) via the same resolve-extensionless runner; per-inventory rule, the exact single-command form is the focused list within the package `test` hunk registered in group 7.

| Path | St | Cat | Reason | Flags |
|---|---|---|---|---|
| `src/lib/crypto/groupKeyStore.js` | M | 4 | **signal file — needs recorded reason:** captured-fence assertions for group-key reads/writes; derivation and rotation math unchanged | |
| `src/lib/crypto/groupKeyStoreLifecycle.test.js` | A | 4 | fence lifecycle tests for the key store | |
| `src/lib/crypto/groupKeyDistribution.js` | M | 4 | distribution rechecks the fence before send; crypto unchanged | |
| `src/lib/crypto/groupKeyRotation.js` | M | 4 | rotation rechecks the fence; strict abort on failed strip preserved | |
| `src/lib/crypto/groupKeyGrant.test.js` | M | 4 | grant tests for the fenced paths | |
| `src/lib/crypto/gmIdentity.js` | M | 4 | actor derivation rechecks the session key after async HKDF so a fork cannot split the pinned identity | |
| `src/lib/crypto/gmIdentity.test.js` | M | 4 | fork tests for actor derivation | |
| `src/lib/crypto/groupDocWire.js` | M | 4 | member-doc writes go through the fenced account-db write path | |
| `src/lib/crypto/groupMessageCodec.js` | M | 4 | key wait threads the fence; codec unchanged | |
| `src/lib/crypto/groupMessageCodec.test.js` | M | 4 | codec tests for fenced waits | |
| `src/lib/crypto/memberDocPublish.test.js` | M | 4 | member doc publish assertions under the fence | |
| `src/lib/deviceAuthorityContext.js` | A | 4 | device authority context derived from the same fence | |
| `src/lib/deviceAuthorityPeerStore.js` / `.test.js` | M | 4 | peer checkpoint store gains owner provenance (plan §3.19) | |
| `src/lib/deviceAuthorityPinStore.js` / `.test.js` | M | 4 | pin store fencing; the inventory's two-tab race note | |
| `src/lib/deviceAuthorityStorage.js` / `.test.js` | M | 4 | authority storage fencing | |
| `src/lib/deviceAuthorityTransport.test.js` | M | 4 | transport fence tests | |
| `src/lib/devicePrf.test.js` | M | 4 | PRF tests under fenced contexts | |
| `src/lib/deviceRegistryStore.js` / `.test.js` | M | 4 | registry writes recheck the fence | |
| `src/hooks/useGroupKeyMember.js` / `useGroupKeyReconciler.js` (already in group 1 rows) | — | — | these two also serve group key flow; assigned to group 1 to keep one home per file | noted: inventory places the group-key member files with slice C's group membership boundary; no disagreement because each file appears once |
| `src/features/chat/useGroupDirectory.js` / `.test.js` | M/A | 4 | group directory hooks recheck the fence | |
| `src/hooks/useNIP29Group.js` / `.test.js` (also rowed in group 1) | — | — | one home in group 1; group-4 relevant hunks split from it | cross-cutting hunk — must be split by hunk before staging into its owning commit |
| `src/components/chat/GroupView.jsx` / `GroupView.test.js` | M/A | 4 | group storefront/photo listing threads the fence and test hook | cross-cutting hunk — must be split by hunk before staging into its owning commit (UI commerce listing vs group display) |
| `src/components/chat/menuPhoto.test.js` | M | 4 | menu photo assertions updated for the fence/test hook | |
| `docs/IDENTITY-COMPARTMENTS.md` | M | 4 | compartment doc updated for the actor-fork note | |
| `docs/DEVICE-AUTHORITY-DESIGN.md` | M | 4 | design updated for owner-provenant peer checkpoints (plan §3.19) | |

### 5) R5-A authority bridge / DM prototype (slice D)

Focused verification: focused authority and transaction tests per the inventory — `src/lib/dmRatchetAuthority.test.js`, `src/lib/dmRatchetTransactions.test.js`, `src/lib/ratchetProofAwareTransport.test.js`, plus `scripts/dm-ratchet-authority-browser-test.mjs`; the inventory's `test:ratchet-authority-browser` script in the package.json split hunks.

| Path | St | Cat | Reason | Flags |
|---|---|---|---|---|
| `src/lib/dmRatchetTransactions.js` | M | 5 | atomic commit of state, event, metadata, proof expiry and journal for the prototype | |
| `src/lib/dmRatchetTransactions.test.js` | M | 5 | transaction tests incl. fence contexts | |
| `src/lib/dmRatchetAuthority.js` | M | 5 | removes the `applicationPayload` passthrough; prototype wire keeps ratchet ciphertext only | |
| `src/lib/dmRatchetAuthority.test.js` | M | 5 | authority proof and build/open tests | |
| `src/lib/ratchetProofAwareTransport.js` | A | 5 | transport seam that holds delivery when the proof expires before the socket handoff (plan §3.4) | |
| `src/lib/ratchetProofAwareTransport.test.js` | A | 5 | held-delivery tests | |
| `src/lib/outbox.js` | M | 5 | **signal file — needs recorded reason:** ratchet rows gate flush on freshUntil and fenced context, rechecked after every await; production DM path untouched | cross-cutting hunk — must be split by hunk before staging into its owning commit (lifecycle hunks belong to group 1) |
| `scripts/dm-ratchet-authority-browser-test.mjs` | M | 5 | browser harness establishes a fence for the prototype tabs | |
| `src/lib/dmLocalRelayProbe.jsx` | A | 5 | local-relay probe page for prototype DM capture | browser harness — local-bind environment needed |
| `scripts/dm-local-relay-integration.mjs` | A | 5 | local relay integration for the prototype | browser harness — local-bind environment needed |
| `scripts/local-nip01-relay.mjs` | A | 5 | local NIP-01 relay used by prototype capture | |
| `scripts/local-nip01-relay-fault-test.mjs` | A | 5 | fault-mode tests for the local relay | |
| `docs/evidence/cipher-dm-local-nip01-relay-capture-2026-11-09.json` | A | 5 | recorded prototype capture evidence | |
| `docs/DM-RATCHET-DESIGN.md` | A | 5 | the frozen wire/spec design record for the prototype | |
| `docs/R5-INTEGRATION-PLAN.md` | M | 5 | integration plan updated for the send-time freshness decision | |
| `docs/R5-DELIVERY-SEMANTICS-DECISION.md` | A | 5 | R5-B decision record (expiry vs immutable events) | |
| `docs/R5-SEND-TIME-REVOCATION-DECISION.md` | A | 5 | revocation decision record per plan §2.6 | |
| `docs/CIPHER-DM-V1-REVIEW-HANDOFF.md` | A | 5 | review handoff for the DM v1 prototype | |
| `docs/CIPHER-DM-V1-SEMANTIC-VECTORS.md` | A | 5 | semantic vector record | |
| `docs/CIPHER-DM-V1-SOURCE-LOCK.md` | A | 5 | source lock record | |

### 6) Protocol-test boundary scaffold

Focused verification: focused protocol-mode tests per the inventory/plan — `src/lib/protocolTestMode.test.js`, `scripts/protocol-test-build-config.test.mjs`, `scripts/protocol-test-mode-browser-test.mjs`, and the protocol-test build via `npm run build:protocol-test` (the clean-verify boundary case).

| Path | St | Cat | Reason | Flags |
|---|---|---|---|---|
| `protocol-test.html` | A | 6 | the isolated test artifact page; sends no protocol events | |
| `src/ProtocolTestScreen.jsx` | A | 6 | test-only screen, disposable identities, fail-closed config | |
| `src/protocolTestMain.jsx` | A | 6 | artifact entry point | |
| `src/lib/protocolTestMode.js` | A | 6 | test-mode wiring separate from production hook/queue/publisher (plan §2.4) | |
| `src/lib/protocolTestMode.test.js` | A | 6 | production-path refusal tests (plan §3.4 static test) | |
| `scripts/build-protocol-test.mjs` | A | 6 | artifact build script | |
| `scripts/protocol-test-build-config.mjs` | A | 6 | shared build config validator | |
| `scripts/protocol-test-build-config.test.mjs` | A | 6 | validator tests | |
| `scripts/protocol-test-mode-browser-test.mjs` | A | 6 | the boundary Chromium test the full suite skipped | |
| `vite.config.js` | M | 6 | wires the protocol-test build flag and refuses misconfigured builds | |
| `scripts/vite-config-guard.test.mjs` | M | 6 | guard tests for the protocol build env keys | |
| `src/lib/egress.js` | M | 6 | **signal file — needs recorded reason:** test build returns no ordinary relay URL, keeping the artifact isolated; 4 added lines only | |
| `src/lib/testRelayOverride.test.js` (also rowed group 1) | — | — | single home in group 1; its protocol probe hunk splits here | cross-cutting hunk — must be split by hunk before staging into its owning commit |
| `src/Chat.jsx` | M | 6 | one-line test-hook seam (`setGroups` fence arg) consumed by the artifact's disposable flow; alternately assignable to group 1 | cross-cutting hunk — must be split by hunk before staging into its owning commit |
| `package.json` | M | 6 | **signal-file-adjacent — needs recorded reason:** registers `build:protocol-test` and protocol test hooks for the artifact; test-list hunk splits per group 7 | cross-cutting hunk — must be split by hunk before staging into its owning commit |

### 7) Test registration (package.json split hunks, slice E)

Focused verification: per the inventory, each split hunk is verified by the owning slice's focused run; the combined tree is proven by the recorded `docs/evidence/clean-verify-20261110T023008Z.json` run (1,361 tests, 0 fail, 5 skips).

| Path | St | Cat | Reason | Flags |
|---|---|---|---|---|
| `package.json` (test-list hunk: lifecycle/privacy/protocol registrations) | M | 7 | registers `useChatBootstrap.test.js`, `useComposer.test.js`, `useGroupDirectory.test.js`, `useMessageCommands.test.js`, `useReactions.test.js`, `securityRecordLifecycle.test.js`, `NotificationCenter.test.js`, `GroupView.test.js`, `Wallet.test.js`, `ratchetProofAwareTransport.test.js`, `securityContext*`, `indexedDbContextGate`, `privacyHandoff`, `identityPublisher`, `accountDatabaseCleanup`, `groupKeyStoreLifecycle`, `protocolTestMode` | cross-cutting hunk — must be split by hunk before staging into its owning commit |
| `package.json` (commerce hunks: `watch:keygen`, `test:dm-local-relay`, `test:security-context-lifecycle-browser`, `build:protocol-test`) | M | 7 | each script hunk goes with its owning commit (A / D / C / 6) | cross-cutting hunk — must be split by hunk before staging into its owning commit |
| `src/Wallet.test.js` | A | 7 | listing send assertions run under the fence; owner commit is commerce UI (B) or lifecycle (1) depending on the Wallet.jsx hunk split | cross-cutting hunk — must be split by hunk before staging into its owning commit |
| `src/hooks/securityRecordLifecycle.test.js` | A | 7 | lifecycle registration coverage per slice E | |
| `src/features/chat/useChatBootstrap.test.js`, `useComposer.test.js`, `useGroupDirectory.test.js`, `useMessageCommands.test.js` | A | 7 | new chat-hook suites registered here; implementation files live in groups 1/4 | |
| `src/components/chat/NotificationCenter.test.js` | A | 7 | notification read-marker persistence suite; implementation is group 1 | |
| `src/lib/dmPeerProfiles.test.js` (via `src/features/chat/dmPeerProfiles.test.js`) | M | 7 | fence recheck assertions updated | |
| `src/lib/testRelayOverride.test.js` (probe hunk) | M | 7 | protocol-boundary probe hunk | cross-cutting hunk — must be split by hunk before staging into its owning commit |
| `tests/ui/persistence.spec.js` | M | 7 | comment-level update to the at-rest queue description | |
| `package-lock.json` | M | 7 | pins `nostr-tools` to exactly 2.25.2 (audit pin for the Olm adapter per plan §1); owner is the commerce/trust commit or a chore commit, owner decision recorded below | cross-cutting hunk — must be split by hunk before staging into its owning commit |

### 8) Docs and evidence

Focused verification: no test run; these are records. Verify each cited run exists in `docs/evidence/` (all present and staged).

| Path | St | Cat | Reason | Flags |
|---|---|---|---|---|
| `docs/WORKTREE-SLICE-INVENTORY.md` | A | 8 | the slice inventory itself, committed last per its own instruction to keep it uncommitted until owners confirm | |
| `docs/PRIVACY-PROTOCOL-GAMEPLAN.md` | A | 8 | the one status ledger with per-row run citations (plan item 1 fix) | |
| `docs/PRIVACY-LIFECYCLE-INTEGRATION.md` | A | 8 | lifecycle integration record (slice C) | |
| `docs/IN-APP-PROTOCOL-TEST-MODE-PLAN.md` | A | 8 | protocol-test plan record | |
| `docs/evidence/clean-verify-20261110T023008Z.json` + `.log` | A | 8 | clean-index verification manifest (plan Phase 0) | |
| `docs/evidence/clean-verify-20261110T043433Z.json` + `.log` | A | 8 | later clean-verify run with local relay fault additions | |
| `docs/evidence/clean-index-verification-20261110T051445Z.json` + `.log` | A | 8 | exported-index verification record | |
| `docs/evidence/commerce-security-{operator,two-account,ui}-20261110.json` | A | 8 | commerce gate evidence (also rowed in group 3 for slice-B context) | noted: one home each in group 3; this group is their commit vehicle if the owner prefers a docs-only evidence commit |
| `docs/CIPHER-DM-V1-*.md` (3) | A | 8 | also rowed in group 5; commit with the prototype or as the docs vehicle — owner choice, one home | noted disagreement risk: pick exactly one group per file |

---

## Unresolved conflicts needing owner / hunk-level decisions

1. **`src/lib/paymentWatch.js`, `src/lib/paymentWatch.test.js`** — slice A (trust) and slice B (receipt/durability) hunks share each file. Per the inventory, split by hunk; the boundary note names `paymentWatch.js`/`vendorPayments.js`/`Connections.jsx`/`package.json` explicitly.
2. **`src/lib/outbox.js`** — lifecycle fence hunks (group 1) vs ratchet flush gating (group 5) in one staged file. The inventory says stay with the lifecycle commit unless a commerce/prototype-only hunk is independently justified; the `ratchetDelivery` flush hunk is that justified exception, but the split is the owner's.
3. **`src/lib/relays.js`** — inventory names it cross-cutting (lifecycle vs discovery). The staged diff is dominated by `queryHistoryDetailed`/`querySecurityRecords` (privacy handoff discovery, related to group 1's `pool.js`/`privacyHandoff.test.js` work). Assign whole-file to group 1 as the least-bad split, or split the detailed-query hunk from the fence hunk.
4. **`src/useIdentity.js`** — named by the inventory as shared between lifecycle and slice D. Staged diff is nearly all fence work; the ratchet-relevant lifecycle assertions ride with it. Assign to group 1; note that slice D's commit depends on it.
5. **`package.json`** — one manifest hunk covers every slice's script/test registration plus the `watch:keygen` script. Must be split by hunk (group 7 lists the pieces). The inventory's claim that it "remains unstaged" is stale; it is staged (+12/−3).
6. **`package-lock.json`** — staged pin of `nostr-tools` to exactly 2.25.2. Not named by the inventory at all. Needs an owner decision: rides the commerce-trust commit (plan §1 audit pin) or a standalone chore commit.
7. **Browser harnesses with local binds** — `scripts/payment-watcher-browser-test.mjs`, `scripts/commerce-local-relay-integration.mjs`, `scripts/dm-local-relay-integration.mjs`, `scripts/dm-ratchet-authority-browser-test.mjs`, `scripts/security-context-lifecycle-browser-test.mjs`, and `browser-privacy-helpers.mjs` all need loopback listener binds; the inventory records that this environment refused them and the watcher browser test reran elsewhere. Evidence for those runs is owner-confirmed before the commerce and R5-A commits.
8. **`src/Chat.jsx`, `src/components/chat/GroupView.jsx`, `src/lib/mediaCrypto.test.js`** — one file mixing lifecycle fencing with the UI test-upload seam (`VITE_TEST_HOOKS` media hook). Split or assign whole-file to group 1 with the seam hunks to the protocol/test-infrastructure commit.
9. **`src/Wallet.jsx`** (+160/−37) and `src/Wallet.test.js` are staged but appear in no inventory slice list. The diff is fence assertions plus the listing-publish flow. Assigned provisionally to group 1 (fence) with the commerce-listing hunks split to group 3; owner must confirm.

## Blocked status

Per plan rule (§0) and the Phase 0 instruction "Do not commit until approved": **all commits remain blocked pending explicit owner approval.** This map authorizes nothing; it is a reviewability aid only.
