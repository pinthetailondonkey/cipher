# Worktree slice inventory and review map

This file maps the preserved changes to review slices; it is not the current
status ledger. Current gate status and evidence are maintained in
`docs/PRIVACY-PROTOCOL-GAMEPLAN.md`. Nothing here authorizes a commit, protocol
migration, or release.

## Verified baseline snapshot

- Branch: `security-ui-remediation`; HEAD: `2172f726f83923801b87ea93de897d4b271add9a`.
- Clean-index verification exported staged tree `420095c456ad7deab242e5932249a387096132cb` and passed `npm ci`, lint, production build, all 1,361 unit tests with zero skips, focused protocol-mode tests, protocol-test build, and its Chromium boundary test.
- The exact manifest and combined-log hash are in `docs/evidence/clean-verify-20261110T023008Z.json` and its adjacent `.log` file. That snapshot predates the local relay fault-mode additions; their focused results are recorded in the gameplan ledger.
- Production DMs remain NIP-44/NIP-59 and production groups remain AES-GCM. The dedicated protocol-test page still sends no protocol events.
- Existing slice notes below describe file ownership and earlier review evidence. They do not override the current gameplan ledger.

## Commerce slice review update

Reviewed the watcher v2 and payment/order diff as slices A and B. Focused command:

```text
node --import ./scripts/resolve-extensionless.mjs --test scripts/boxes.test.mjs src/lib/paymentWatch.test.js src/lib/vendorPayments.test.js src/lib/escrowPsbt.test.js src/lib/reputation.test.js src/lib/paymentAddress.test.js src/lib/paymentState.test.js src/lib/paymentLedgerLock.test.js src/lib/outboxWriteAhead.test.js
```

Result: 107 passed, 0 failed. This covers credential persistence, signed watcher trust, payment parsing and transitions, allocator concurrency/recovery, dormant escrow serialization, reputation presentation, and write-ahead retry behavior. `git diff --check` also passes. The local browser watcher test remains blocked because its fixture needs loopback listeners; rerun in an environment that permits local binds. This is focused unit evidence, not the commerce exit gate: no buyer/vendor browser transaction or operator deployment has been completed.

Review boundary: watcher signing/key setup, browser pin/rotation UI, and report verification are slice A; wallet index allocation, transfer ledger, receipt/order idempotency, and reputation/escrow boundaries are slice B. `paymentWatch.js`, `paymentWatch.test.js`, `vendorPayments.js`, `vendorPayments.test.js`, `Connections.jsx`, and `package.json` contain cross-cutting hunks and must be split by hunk. The shared `relays.js`, `outbox.js`, `useIdentity.js`, and panic-wipe paths also contain lifecycle behavior and should stay with their owning lifecycle commit unless a commerce-only hunk is independently justified.

The watcher trust/operator slice is now staged as a review boundary across 11 files. Its client verifier also enforces the requested address and currency directly, in addition to nonce, pinned key id, and exact signed bytes; the payment flow retains its post-parse echo check as defense in depth. Focused serial run after this change: 107 passed, 0 failed. Targeted Oxlint and `git diff --cached --check` pass. The earlier parallel focused run produced a child-process failure in `paymentWatch.test.js`; serial execution passed, and the individual suite passed separately. The browser-origin harness still cannot be completed here because local listener binds are restricted. `package.json` remains unstaged because its single manifest hunk also registers lifecycle and privacy suites; test registration needs a dedicated split hunk before the slice is commit-ready.

## Proposed review slices

### A. Watcher v2 trust and operator setup

Purpose: separate access credentials from report-signing trust, sign exact v2 reports, pin and rotate the verification key, and document operator setup.

Files primarily owned by this slice:

- `.env.example`, `README.md`
- `scripts/boxes.mjs`, `scripts/boxes.test.mjs`, `scripts/payment-watcher.mjs`
- `scripts/payment-watcher-keygen.mjs`
- `src/lib/paymentWatcherTrust.js`
- `src/components/chat/Connections.jsx`
- relevant `src/lib/paymentWatch.js` and `src/lib/paymentWatch.test.js` hunks

Required evidence: unit trust tests and a browser watcher test using signed v2 responses, including pin/rotation, malformed and stale reports, nonce/payment mismatch, and outage behavior. Operator setup must be exercised end to end before commerce release.

### B. Wallet allocation and payment/order durability

Purpose: prevent address/index reuse, make watcher-backed order effects idempotent, preserve exact signed receipt retries, and keep monetary values in decimal strings at the trust boundary.

Files primarily owned by this slice:

- `src/lib/commerceWalletStore.js`
- relevant `src/lib/vendorPayments.js` and `src/lib/vendorPayments.test.js` hunks
- relevant `src/lib/paymentWatch.js` and `src/lib/paymentWatch.test.js` hunks
- `src/lib/escrowPsbt.js`, `src/lib/escrowPsbt.test.js` (dormant escrow safeguards only; escrow stays disabled)
- `src/lib/reputation.js`, `src/lib/reputation.test.js`, `src/components/ProfileModal.jsx`, `src/components/chat/VendorMenuHome.jsx`, `src/hooks/useVouchCount.js`
- relevant `scripts/payment-watcher-browser-test.mjs` cases
- `docs/COMMERCE-SECURITY.md`

Required evidence: IndexedDB concurrency/recovery tests and buyer/vendor browser flow with signed watcher v2. Existing address, payment, order, and shipping history remain intact. One allocation device per descriptor is the supported constraint; cross-device allocation and whole-profile rollback remain open risks.

### C. Account lifecycle and wipe fencing

Purpose: invalidate stale async work at lock, switch, removal, and wipe, then make cleanup outcomes explicit.

Files primarily owned by this slice:

- `src/lib/securityContextFence.js`, `src/lib/securityContextFence.test.js`
- `src/useIdentity.js`
- `src/lib/panicWipe.js`, `src/lib/panicWipe.test.js`
- `src/lib/pool.js`
- `scripts/security-context-lifecycle-browser-test.mjs`, `src/lib/securityContextLifecycleProbe.jsx`
- `src/lib/sessionKey.test.js`
- `docs/PRIVACY-LIFECYCLE-INTEGRATION.md`

Cross-slice dependency: the payment operation fence is in `src/lib/vendorPayments.js`; the ratchet/outbox fence is in slice D. `src/db.js` now binds the production bootstrap and DM hook's database handle to the active fence, checks fenced transactions around their callback, guards table writes, tags pre-open writes, and scopes pending at-rest message rows to their receiving incarnation. HMR no longer opens a handle using only the stored owner string; authenticated code must reopen it. Account cleanup now returns per-database results for the main account, primary-authority, and policy-pin databases; the peer checkpoint store remains unscoped by local owner and is deliberately not deleted by guess. Group AUTH derivation and identity profile publication now recheck the account fence after asynchronous work and before sending. Focused tests cover async invalidation, stale queue rejection, owner DB cleanup, and preventing a later incarnation from flushing an earlier one’s row. Atomic invalidation/commit serialization and complete caller-level writer coverage remain open.

Required evidence: browser races across two tabs for lock/switch/remove/wipe, suspended work, IndexedDB interruption, stale completion, and cleanup failures. The current unit suite covers helpers, not all application call sites.

### D. Isolated R5-A authority bridge and transaction prototype

Purpose: require independently pinned R/A/Dᵢ authority and exact registry checkpoints for experimental ratchet send/receive operations, while atomically committing state, immutable event, target metadata, proof expiry, and journal.

Files primarily owned by this slice:

- `src/lib/dmRatchetTransactions.js`, `src/lib/dmRatchetAuthority.test.js`
- `src/lib/outbox.js`
- `scripts/dm-ratchet-authority-browser-test.mjs`
- relevant lifecycle assertions in `src/useIdentity.js` and `src/lib/securityContextFence.js`
- `docs/R5-INTEGRATION-PLAN.md`

Required evidence: focused authority and transaction tests plus IndexedDB browser races, exact-event retry, expired-proof hold, stale/forked registry, recovery replacement, and lifecycle invalidation. This is prototype evidence only; the existing immutable envelope makes an expired proof non-refreshable, so R5-B delivery semantics remain unresolved. Do not connect this slice to `useNIP44DM.js`.

### E. Cross-cutting registration and evidence

`package.json` registers tests for slices A–D; split each script/test-list hunk with the owning slice. `docs/PRIVACY-PROTOCOL-GAMEPLAN.md` is the architecture/evidence record and should be updated only after the corresponding gates have actual results. `browser-privacy-helpers.mjs` contains shared browser setup and must be assigned with the first browser slice that consumes it or reviewed as test infrastructure on its own.

## Commit boundary and order

The current files overlap across slices, especially `paymentWatch.js`, `vendorPayments.js`, `outbox.js`, `useIdentity.js`, `relays.js`, `package.json`, and the browser harnesses. Do not stage those files wholesale into a single commit. Extract and review per-slice hunks, run that slice's focused tests, and then run `npm run lint` and `npm test` before each commit. Keep this inventory uncommitted until its owners confirm that the assignments match the intended scope.

Recommended order: A + B commerce candidate; C lifecycle foundation; resolve the R5-B immutable-envelope expiry decision; D authority bridge; protocol v1 review; only then test-account integration. MLS, routing compartments, and production DM rollout have separate gates.
