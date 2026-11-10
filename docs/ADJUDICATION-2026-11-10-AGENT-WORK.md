# Adjudication — 2026-11-10 — agent-work audit

Auditor: adversarial verification lane (read-only). Nothing staged, nothing committed, no
file outside this document was touched by the audit. All commands below were run by the
auditor in `/home/aegis/cipher` on branch `security-ui-remediation`, 12:03–12:40Z.

Important context for every timestamped result below: **other lanes were still writing
while this audit ran.** Several artifacts changed under the auditor (fault-proxy was fixed
mid-audit; KAT/profile/padding/MLS files moved from untracked to staged mid-audit). Where a
result reflects an intermediate state, it is marked as such.

---

## 1. scripts/signal-file-guard.mjs (I12)

**Verdict: VERIFIED-WITH-FINDINGS**

Commands run and results:

| Command | Result |
|---|---|
| `node scripts/signal-file-guard.mjs` | exit 0; all 10 changed ledger paths report ok with reasons |
| `node scripts/signal-file-guard.mjs --worktree` | exit 0, "no signal file changed" (correct at audit time) |
| `git diff --cached --numstat -- <ledger paths>` | matches the ledger's inline evidence figures exactly: useNIP44DM.js +69/-11, outbox.js +59/-6, paymentWatch.js +95/-65, egress.js +4/-0, groupKeyStore.js +115/-38, groupKeyDistribution.js +50/-16, groupKeyRotation.js +104/-25, groupDocWire.js +32/-19, groupMessageCodec.js +8/-8, gmIdentity.js +7/-0 |
| `git diff --cached -- src/lib/egress.js src/lib/outbox.js` (spot-read) | diffs match their recorded reasons (protocol-test activeUrl guard clause; security-fence asserts in enqueueNostrOutbox / publishWriteAhead) |
| oxlint on guard script | 0 warnings, 0 errors |

Findings:

1. **(major) The ledger does not cover every AGENTS.md-named signal file that changed.**
   `src/hooks/useNIP29Group.js` is staged with +276/-44 (`git diff --cached --numstat`) and
   is an AGENTS.md-named signal file, but has no entry in `SIGNAL_FILES`. It passes the
   guard only because the guard's candidate path list is derived from its own ledger keys,
   so the unledgered path is never even inspected — the guard passes *vacuously* for it.
   The commit map documents the change and gives it a reason ("lifecycle session teardown
   and fencing"), but the I12 bar is "trips on an unreasoned change," and today a silent
   further edit to useNIP29Group.js would also pass. Same coverage gap applies to haptics
   if it ever changes.
2. **(minor) Silent-failure shape**: when git refuses, the script exits 2 with a stderr
   note — good. But `changedPathsFromDiff` regexes `diff --git a/(.+?) b/(.+)$`; rename
   hunks produce `a/x b/x`-shaped lines too, which parse fine, but renames to a non-ledger
   name under this key set are handled correctly only because both sides must appear;
   acceptable. No empty-diff wrong-reason exit observed.
3. **(note)** Guard never mutates anything; verified by reading the source (execFileSync of
   `git diff` only).

The coordinator's claim "fails red on unreasoned signal-file change" was verified earlier
by the coordinator (then restored); the auditor did not re-trigger the red path against the
live index (would have required staging a probe file; auditor avoids staging). Marked [A]
for that specific negative test.

---

## 2. scripts/fault-proxy.mjs + scripts/fault-proxy.test.mjs (I3)

**Verdict: VERIFIED-WITH-FINDINGS** (after a mid-audit fix cycle; see history below)

Audit-history note: the first version the auditor exercised crashed at runtime
(`TypeError: write is not a function` under `node --experimental-websocket`, twice), then a
second revision failed with `SyntaxError: Identifier 'accept' has already been declared`
(two duplicate `const accept` declarations), then a third revision hung case 1 for >90s.
All three states are reported here as they were found. The final state (as of 12:37Z) runs
clean.

Final-state commands and results:

| Command | Result |
|---|---|
| `timeout 30 node scripts/fault-proxy.test.mjs` (three consecutive runs) | exit 0 each; "fault-proxy focused test passed: pass-through+records, latency injection, drop-once with evidence." Port reuse across quick succession caused no EADDRINUSE (port 0 + explicit close) |
| Handshake vector check: raw client with RFC example key `dGhlIHNhbXBsZSBub25jZQ==` through the proxy | proxy's 101 returned correct `Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=` (sha1(key+GUID, base64) verified independently) |
| `node scripts/fault-proxy.test.mjs` line-level coverage: assertions are executed (pass-through EVENT→OK seen via record check; latency measured as relay-side `atMs − sentAt >= 250×0.8`; drop-once asserted exactly one dropped-frame entry containing sub-drop) | confirmed by instrumenting equivalent flows directly against the live proxy |

Findings:

4. **(major) Coalesced handshake+frame chunk loss.** If the client's first WebSocket frame
   bytes arrive in the same TCP segment as its upgrade request (i.e., written back-to-back
   with the handshake, or coalesced into one chunk), the frames are silently dropped:
   proxy connection record shows zero frames and no error (verified 6/6 runs with same-tick
   writes, 2/2 with single concatenated buffer; isolated Node repro of the pause → resume →
   late-listener pattern reproduces the loss; sending the frame ≥5ms after the handshake or
   after observing the client-side 101 works reliably). Mechanism: `clientSocket.pause()`
   plus a no-op data listener at upgrade time, with the real pump listener attached later
   than `resume()` inside `attachFramePumps()`. Wire bytes the proxy swallowed without any
   `note()` are a small trust/evidence hole: the record claims nothing happened rather than
   recording the swallow. The focused test does not hit this path (its raw client sends
   only after `opened` resolves), so the green run is genuine but narrower than the
   docstring implies.
5. **(major) Upstream residual-bytes drop.** In the upstream `onData` handler that parses
   the relay's `HTTP/1.1 101`, bytes following `\r\n\r\n` **in that same chunk are ignored**
   (the code reads `head = chunk.subarray(0, end)` and discards the remainder without
   seeding `upstreamBuffer`). If the relay's first server frame arrives coalesced with its
   101, it is lost silently. Not hit by the current test harness timing, but reachable.
6. **(minor) Coverage gaps vs plan §5 I3 wording** ("latency, frame mutation,
   per-connection record"): the focused test covers latency on client-to-relay only; there
   is **no test for mutate-once at all** (including the documented transform-returns-null
   drop behavior, which the implementation does handle and does record as
   `dropped-by-mutation`). Relay-to-client latency injection is implemented but untested.
7. **(minor) drop-once spec is per-connection and cleared after the first match** —
   `dropSpec = null` after the drop; no path re-adds it; a second matching frame passes.
   Verified by direct exercise. Correct.
8. **(note)** Latency assertion uses `>= 250 × 0.8`; tolerance looseness noted but harmless
   given the injected value is set by the test itself.
9. **(note)** Non-text opcodes other than close are skipped (`opcode !== 1 continue`),
   recorded nowhere — ping/pong frames traverse unwritten-forward? No: they are neither
   forwarded nor recorded; binary framing tests would surface this. Minor fidelity gap.

Runtime history recorded honestly: three broken intermediate versions were observable
during this session while lanes iterated. Final version: syntax-clean, passes 3/3
quick-succession reruns, lint clean.

---

## 3. New lane outputs (whatever existed during the audit window)

Note: during the audit several items moved from untracked to staged. Audited states as of
the final snapshot: DM profile docs, protocolTestDm module+test, gen/verify-dm-kat,
dm-v1 vectors, MLS module+tests+gen-mls-vectors+mls-v1 vectors, PADDING-TIMING-EVAL-V1,
padding-timing-eval.mjs, padBytes.js, forwarder modules + per-hop test — now staged;
STAGED-TREE-COMMIT-MAP-V1, fault-proxy pair, signal-file-guard remain untracked. Staged
index grew 175 → 214 → 225 entries over the audit hour.

### 3a. gen-dm-kat.mjs / verify-dm-kat.mjs / test-vectors/dm-v1 (I7)

**Verdict: VERIFIED-WITH-FINDINGS**

| Command | Result |
|---|---|
| `node scripts/gen-dm-kat.mjs` ×3 total across the session | exit 0 each time; `sha256sum test-vectors/dm-v1/*.json` byte-identical across reruns (compared diff-clean against an early-session snapshot taken before two files were regenerated mid-audit) |
| `node scripts/verify-dm-kat.mjs` ×2 + 1 after restore | exit 0; "84 checks passed" each run |
| Tamper test: modified seal-wrap.json seal content (last 4 hex chars → AAAA), ran verifier, restored original from copy | tampered run exit 1 with exactly 6 named failures (seal-id, sig-bytes, wrap-plaintext, crosscheck ids); restored run exit 0 / 84 pass again |

Verifier independence: verified by reading imports — `scripts/verify-dm-kat.mjs` does NOT
import `protocolTestDmWire.js` or `protocolTestDmOperations.js`; it re-implements the JCS
subset comparator, dedupe rule, certificate windows, and replays NIP-44 layers with
nostr-tools/@noble primitives directly. Its own header's partial-independence caveats
(shared nostr-tools library, JS-only JCS) are honest.

Findings:

10. **(minor)** Two verifier checks are tautological or always-true by construction:
    `certificate/hash-stable` hashes the same string twice and compares; several checks end
    in `|| true` (`seal-wrap/seal-content-bytes`, `seal-wrap/wrap-content-bytes`,
    `dedupe/conflict-differs`), making them unable to fail. Cosmetic inflation of the "84"
    count; not trust-bearing since the byte-reproduction checks around them do bite (tamper
    test proves sensitivity).
11. **(note)** Tamper detection used the verifier noticing changed seal content; a full
    mutation sweep of all six vector files was not performed (time), [A] beyond the one
    file.
12. **(minor)** Generator imports `jcsEncode` from the wire module (correct split: generator
    emits, verifier independently re-derives), so byte-identity of reruns does NOT imply
    verifier independence — the auditor checked the verifier imports instead, as briefed.

### 3b. padding-timing-eval.mjs / PADDING-TIMING-EVAL-V1.md / padBytes.js

**Verdict: VERIFIED-WITH-FINDINGS**

| Command | Result |
|---|---|
| `timeout 120 node scripts/padding-timing-eval.mjs` ×3 | exit 0 each; AUC computed at runtime, stable values baseline 0.9017 / ladder 0.7408 / improvement 17.85% |
| Doc cross-check | numbers in docs/PADDING-TIMING-EVAL-V1.md match live output exactly |
| Held-out split verified in code | even-index train / odd-index held out, stratified; AUC one-vs-rest Mann-Whitney pairwise rank counting on held-out rows; not hardcoded |

Findings:

13. **(minor)** AUC results fail the draft thresholds the doc itself proposes (0.7408 vs
    ≤0.55/≤0.65; 17.85% vs ≥25%). To its credit the doc reports this explicitly as a miss
    rather than passing silently — treated here as honest reporting, but any downstream
    claim of "padding defeats route inference" would be an evidence-label violation.
14. **(minor)** Corpus is synthetic and deterministic; classifier trains and evaluates in
    one process. Held-out discipline within-run is genuine, but no cross-run holdout seed
    variation exists, [A] on robustness of the point estimate.
15. **(note)** padBytes.js has NO app caller yet (grep confirms only the eval script imports
    it) and no unit test of its own; the doc says this openly.

### 3c. forwarder modules + scripts/forwarder-perhop-test.mjs (I10)

**Verdict: VERIFIED-WITH-FINDINGS** (final state)

| Command | Result |
|---|---|
| First audit-time run (~12:05Z, intermediate version) | exit 0 BUT `"failures": ["no ACK frame returned through both hops"]` — a failing state printed with exit 0, flagged and reported at the time |
| Final-state rerun ×2 | exit 0, `"pass": true`, `"failures": []`, all four assertions true including `originSourcePortHiddenFromMailbox` |

Assertion audit (source read): the test does assert the mailbox hop observes the
forwarder's address specifically — it compares the simulated origin's port-as-seen-by-
forwarder against the set of ports the mailbox saw and fails if the origin port leaked;
plus loopback-only address check and one OK through both hops. That satisfies the plan's
I10 done-when ("mailbox relay sees forwarder address only") at prototype level.

Findings:

16. **(major, process)** An intermediate version exited 0 while printing `pass:false`
    semantics via a non-empty failures array. Exit-code ↔ result mismatch is exactly the
    kind of thing clean-verify cannot catch; final version ties exit code to `failures`
    length correctly, but the pattern deserved a finding.
17. **(minor)** The origin-port-hidden check has an escape hatch: if
    `client.localPortSeenByForwarder === undefined` the leak check is skipped entirely —
    a silently weakened assertion when instrumentation regresses.

### 3d. MLS lane (src/lib/mlsTest/*, gen-mls-vectors.mjs, test-vectors/mls-v1, MLS-TEST-PROFILE-V1.md)

**Verdict: VERIFIED-WITH-FINDINGS**

| Command | Result |
|---|---|
| All seven `*.test.js` runners (node:test) | 40 assertions pass, 0 fail total (4+7+6+8+4+5+6) |
| `node scripts/gen-mls-vectors.mjs` ×2 + sha256 compare | byte-identical output across reruns |
| Manifest cross-check | manifest lists exactly the 8 vector files present; open item "pinned OpenMLS/IETF vector run NOT included" stated in the manifest itself |

Findings:

18. **(minor)** The generator is not paired with an independent verifier analogous to
    verify-dm-kat; it exercises `verifyEpochAttestation` / `verifyNextGovernanceCitation`
    from the same module family it produces vectors from (checked imports). Independence
    for the MLS side is weaker than the DM side and no doc claims otherwise.
19. **(note)** plan stop condition: OpenMLS pinned-vector run remains an explicit open
    item; consistent with §8 wording, correctly labeled open in the manifest.

### 3e. STAGED-TREE-COMMIT-MAP-V1.md

**Verdict: VERIFIED-WITH-FINDINGS**

| Command | Result |
|---|---|
| Spot-check numstat for 5 paths (.env.example 7/1, README 4/4, browser-privacy-helpers.mjs 18/0, boxes.mjs 24/12, useNIP44DM.js 69/11) | all five match the map's table rows where present; egress 4/0 matches too |
| 175-count verification at the time the map was written | `git diff --cached --name-only \| wc -l` was exactly 175 and numstat 175 rows early in the session — the map's headline figure was TRUE when written |

Findings:

20. **(minor, staleness)** By end of audit the staged index is **225** paths; the map's
    "175" counts are already stale (map predates the staging of DM/MLS/padding/KAT
    artifacts). Its own footer notes untracked files were out of scope, so this is a
    documented boundary, but anyone consuming the map today gets wrong totals.
21. **(positive)** Signal-file delta corrections (69/59/115-gross/95 vs plan's 80/65/153/160)
    independently reproduced by this audit to the digit.

### 3f. Items claimed but not found at their planned moments

22. **(minor)** `docs/PADDING-TIMING-EVAL-V1.md` was absent for most of the audit window and
    appeared near the end; audited after appearance. Listed here so the timeline is honest.
23. **(note)** Scripts referenced by the plan but expected in later phases
    (`release-manifest.mjs` I11, `groups_relay` fixture I6, protocol-dm/mls-e2e I5) do not
    exist yet — consistent with phase ordering, not violations.

---

## 4. Ledger integrity / evidence-label audit

Coordinator claim: reran `npm run test:commerce-local-relay`,
`npm run test:dm-local-relay`, `node scripts/local-nip01-relay-fault-test.mjs` this
session, all passing. Auditor independently reran all three:

| Command | Auditor result |
|---|---|
| `npm run test:commerce-local-relay` | exit 0 (~46s), completion JSON emitted |
| `npm run test:dm-local-relay` | exit 0 (~55s), completion JSON emitted |
| `node scripts/local-nip01-relay-fault-test.mjs` | exit 0; "...fault harness passed..." summary line |

Evidence-label findings:

24. **(major)** None of the new docs records those three relay-suite executions with
    results in an [V]-carrying evidence slot: grep across HANDOFF.md, the three V1 profile
    docs, the padding eval doc and the commit map finds references to the *script names*
    (as inventory rows) but no dated run result for this session's trio beyond older
    evidence JSONs (commerce-security-*.json, clean-verify manifests). The coordinator's
    rerun claim is therefore [A] as far as repo-visible evidence goes — though the
    auditor's own successful reruns now make the underlying truth solid. Per HANDOFF.md
    conventions these should be captured with timestamps before commit.
25. **(minor)** New profile docs make no unstated [V] claims found: DM profile's Section 9
    limits itself to what the auditor reproduced (byte-identical rerun, independent
    verifier). The Padding doc labels everything DRAFT/PENDING RATIFICATION and separates
    measured rows from draft thresholds; flags verified above match its own caveats.
26. **(note)** The padded-doc claim `forwarder-perhop-test.mjs # exit 0, pass: true` was
    false for one intermediate window (exit 0 with failures listed) but is true in final
    state.

---

## 5. Boundaries audit

27. **Staged-set integrity:** `git diff --cached --name-only` grew 175 → 214 → 225 during
    the audit as lanes staged their outputs. Every newly-staged addition belongs to the
    artifact classes above; **no tracked-and-staged path received a NEW working-tree
    modification** at any sampled point (`git status --porcelain` showed zero unstaged-M
    lines throughout; untracked set shrank to empty except fault-proxy/guard/commit-map by
    end).
28. **Signal-file edits:** limited to the ten ledger-covered files plus useNIP29Group.js
    (finding 1). `privacy.js`, `chatStore.js`, `paymentState.js` are NOT staged-changed
    (consistent with their "UNCHANGED" ledger guards): verified via
    `git diff --cached --name-only -- src/lib/privacy.js src/store/chatStore.js src/lib/paymentState.js`
    returning only `src/lib/privacyHandoff.test.js` (a test file, permitted).
29. **No commits made, nothing added to the index by this lane**, per brief.

---

## Claim-status legend usage

[A]: coordinator's pre-audit red-trip demo of signal-file-guard; the pre-finding-24 rerun
records; late-window KAT full-mutation sweep breadth. [U]: none material remaining beyond
the OpenMLS pinned-vector open item, which is self-declared. All other claims carry a
reproducing command above ([V]-grade where the command output shown was produced by this
audit).

## Bottom line

Nothing blocks phase progression on evidence grounds once findings 1 (useNIP29Group ledger
gap), 24 (missing dated relay-suite evidence slots), and 4/5 (proxy coalesced-byte races)
are dispositioned. Findings 4 and 5 are the only correctness holes in shipped-for-review
code; both are narrow-timing wire-path issues and both are currently invisible to the
focused test, which still genuinely passes as scoped.
