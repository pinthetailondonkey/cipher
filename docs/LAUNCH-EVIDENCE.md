# Launch evidence — release/launch-v1

One file. Every line is a command's output, not a memory. Detailed logs stay
outside the tree. Nothing here is pushed, deployed or released.

## Identity of the candidate

- Base: `origin/main` = `1b0fb053f5695cc729b390948c7635b320606fa1` (fetched 2026-10-28).
- Branch: `release/launch-v1`, cut from that SHA.
- Source candidate: `ec9b0c5c2dce4d18a287ec42d383cd1838cbcfe9`. The branch
  HEAD is this file's own round-2 updates (`f1a1227`, `1365a5d`, and this
  correction) — docs only, so `git diff --stat ec9b0c5..HEAD` names
  `docs/LAUNCH-EVIDENCE.md` alone. Fifteen local commits above base at
  `ec9b0c5` (`git rev-list --count 1b0fb05..ec9b0c5` → 15), none pushed
  (`git ls-remote origin 'refs/heads/release/*'` → empty), per the founder's
  release order that overrides "push each commit":
  `cbc2037` `5b12a30` `4dc0df0` `7042cb5` `298ef9b` `574a299` `54be472`
  `fb7d6cf` `61f35c0` `e1cdc54` `25ce9f7` `17dc8ab` `3176e18` `7d60e1a`
  `ec9b0c5`.
- Source history: `61f35c0` is the milestone-1 source candidate AUDITOR gated
  in round 1; `e1cdc54`, `25ce9f7` and `17dc8ab` are docs only
  (`git diff --stat 61f35c0..17dc8ab` touches `docs/LAUNCH-EVIDENCE.md` alone,
  99 lines, 87+/12−; AUDITOR re-measured it file by file). Round 2 adds three
  source commits — `3176e18`, `7d60e1a`, `ec9b0c5` — listed below.

## Milestone 1 — auth and recovery

| # | Finding | Verdict | Commit |
|---|---------|---------|--------|
| 1 | A local restore rebuilt the account entry and dropped `mnemonicEnc` (the encrypted 12 words) and any device envelope | confirmed, fixed, tested | `4dc0df0` |
| 2 | New-PIN rule was "eight or more" at the centre while the screens said exactly eight; unlock charged every error to the five-attempt counter | confirmed, fixed, tested | `cbc2037`, `5b12a30` |
| 3 | The save screen said the words and "your PIN" recover the account; a new device asks for a new PIN | confirmed, fixed | `7042cb5` |
| 4 | The Face ID door opened on a stored record alone, with no PRF capability check | confirmed, PARTIALLY fixed: the record-only door is closed, but the check is WebAuthn presence, not an authenticator answer | `298ef9b`, measured `fb7d6cf` |
| 5 | `feat/device-lock` integration risks | inspected, NOT merged | none |

Finding 1 is the trust-edge class CLAUDE.md names: state that lives only in
one place. The entry is the only holder of the encrypted words for an account
restored on this device, so rebuilding it erased the account's own backup.

Finding 2's second half matters more than its first: five wrong PINs delete an
account, so an error that was not a wrong PIN spending one is a deletion path
with no wrong PIN typed.

## Gates at the candidate

Run in the founder's checkout, production build (no test hooks). Two runs,
named by the SHA they were made at — the entry name differs because the
source changed between them:

- at `574a299`: `npm run build` exit 0, entry `dist/assets/index-Drp6qFzv.js`
- at `61f35c0`: `npm run build` exit 0, entry `dist/assets/index-CNxR3c1G.js`
- `npm run lint` — exit 0, 88 warnings, 0 errors
- `npm test` — 434 tests, 434 pass, 0 fail
- `__cipher` absent from every built asset at both SHAs (test-hook build not
  used for either; AUDITOR also measured the seam build separately and then
  rebuilt production to 0 hits)

At the round-2 candidate `ec9b0c5`, run in this checkout:

- `npm run build` — exit 0, entry `dist/assets/index-oiLnEhZQ.js`
- `npm run lint` — exit 0, 88 warnings, 0 errors (oxlint exits nonzero on an
  error; it exited 0, and the warning count matches the 61f35c0 baseline)
- `npm test` — exit 0, 436 tests, 436 pass, 0 fail (434 + the 2 landed below)
- production build, hooks disabled: `grep -rl __cipher dist/ | wc -l` → 0
- `npx playwright test tests/ui/pin-unlock.spec.js tests/ui/persistence.spec.js
  tests/ui/keypad.spec.js` — exit 0, 17 passed (2.1m). Server was fresh:
  `ss -ltnp` found nothing on 8081 before the run, so `reuseExistingServer`
  had nothing to reuse. It served the seam build; production was rebuilt after.

## Milestone 1 close-out — UI-level unlock evidence

`tests/ui/pin-unlock.spec.js`, run in Chromium against the candidate's own
bundle (`npm run build:ui-test` + `npx playwright test`, 1 worker):

```
10 passed (1.5m)
```

Each test seeds a finished account and drives the real lock screen. What they
prove, and what they do not:

- 6-digit PIN opens a vault in today's salted format, and a 6-digit PIN in a
  vault from before per-vault salts opens and is upgraded to
  `salt` 16 bytes / `iter` 600000. EXECUTED.
- 8-digit PIN opens. EXECUTED.
- A ninth digit is refused (8 dots stay filled). Every PIN field and the pad
  have capped at 8 since the initial commit `6d83b48`, so no build in this
  history can create a longer PIN; a 9-digit vault, were one to exist, could
  not be opened here and each try would spend an attempt. EXECUTED.
- A wrong PIN spends an attempt ("4 attempts left", `cipher_fails_<pk>` = 1);
  a reload after it does not spend another. EXECUTED.
- A damaged vault answers "damaged copy" five times and spends none; the
  entry is still there afterwards. EXECUTED.
- A missing vault answers "No local vault found" and spends none. EXECUTED.
- A local restore (handle + PIN) keeps `mnemonicEnc`, `deviceEnvelope`,
  `displayName`, `createdAt` and `confirmed`. EXECUTED. Precision, from
  AUDITOR and re-measured here: `mnemonicEnc` is written only into an entry
  (`useIdentity.js:343`, `:676`), so the legacy single-vault fallback has no
  words to lose; and `deviceEnvelope` appears in no production source on this
  branch — only in these two tests, planted to prove the merge is
  field-preserving. The merge is the right shape for the device-lock work;
  today it protects one field that exists (`mnemonicEnc`).
- A vault with whole `iv`/`data` but a damaged `salt` still reads as a wrong
  PIN and spends an attempt: GCM cannot tell that from a bad PIN. Recorded
  as measured, not as a promise. EXECUTED.

What causes the five-attempt wipe, stated exactly: each press of Unlock (or a
restore/switch submit) that hands a PIN to decryption and fails. A reload
alone neither counts nor wipes — proven above. An earlier report of mine said
"five reloads"; that was wrong.

Passkey residual finding: the restore screen's capability check is
nostr-passkey's `isPRFSupported()` (`dist/chunk-ZKAH7U4Z.js:129`), which asks
only whether the browser has WebAuthn. In headless Chromium it returns true
while `isUserVerifyingPlatformAuthenticatorAvailable()` returns false, and the
Face ID door is offered anyway. The record-only door is closed; the
no-authenticator door is not. A cancelled or failing authenticator then ends
in the screen's error line. Not changed here — it is a founder decision, since
requiring a platform authenticator would hide the door for roaming keys.

## Round 2 — usability defects and the removal regression

Production stayed on HOLD. No feature was added; three defects and one missing
regression.

| # | Defect | Verdict | Commit |
|---|--------|---------|--------|
| 6 | A media, voice or file send that the relays refused still fired its own "sent" toast, one line after the failure toast | confirmed, fixed | `3176e18` |
| 7 | A failed text send had already cleared the field, so the user's words were gone | confirmed, fixed | `3176e18` |
| 8 | Buy has no disabled state; a second tap posted a second order request and a second success toast | confirmed, fixed | `7d60e1a` |
| 9 | No test executed a removal followed by a post-removal message | gap, closed | `ec9b0c5` |

Defects 6–8 are CODE-WALK, and are labelled so. They were found by reading
`sendMessage`'s callers and the Buy button, not by reproducing a refused send:
reproducing one offline needs a relay that refuses, and every call site already
read the same unconditionally-toasted shape. What changed is mechanical and
small: `sendMessage` now returns `'sent' | 'securing' | 'failed'`, all four
callers toast success only on `'sent'`, `submit` puts the text back on
`'failed'`, and `startOrderWithVendor` drops a second press while one is in
flight and clears the flag in a `finally`. No draft system was added; the
existing per-chat draft keys are untouched.

Defect 9 is EXECUTED. `src/lib/crypto/groupRemoval.test.js` (AUDITOR's probe,
landed unchanged except import paths, and added to `npm test`): real secp256k1
identities, real `rotateGroupEpoch`, real NIP-44 bundle, real sealed key store,
real codec. A removed member cannot open the post-removal message; a remaining
member can; the ciphertext is bound to the real key (a foreign epoch-1 key gives
`decrypt-failed`); and it records in-file that removal does not take back
history. AUDITOR's negative control — putting the removed member back in
`remainingPubkeys` — makes the test fail. It is not the live two-account drill:
no relay, no socket, and the membership snapshot, `installReceivedGroupKey`
guards and network delivery are outside it.

## Lane reports (independent, read-only)

- AUDITOR, verdict at `61f35c0` on a clean clone: build 0 (`index-CNxR3c1G.js`),
  lint 0 errors / 88 warnings, `npm test` 434/434, UI pin-unlock + persistence
  14/14 on its own port. `__cipher` 0 hits in the production build, 1 file in
  the seam build, 0 again after rebuilding production. `git ls-remote`: no
  `release/*` on origin. Packet: `/tmp/audit-cand/REVIEW.md`. It caught three
  evidence-file errors, all corrected above: the stale gates entry name, "five"
  where there are nine commits, and row 4 called fixed when it is partial.
- AUDITOR, delta check: `e1cdc54^ = 61f35c0`, docs only, 45+/7−; its 61f35c0
  gates carry to this candidate. It asked to carry two additions, both
  re-measured here: `vaultEntry` merge and the restore test are "not defects,
  checked, stands"; `deviceEnvelope` is test-only on this branch.
- BITCH2, passkey instrumented tap (`/tmp/bitch2-authcheck`, `doorcheck5.mjs`,
  build at `574a299`; `Restore.jsx` is byte-identical through `25ce9f7`).
  EXECUTED: the tap calls `navigator.credentials.get` (rpId, allowCredentials,
  PRF eval), a rejection shows immediately in the error line, the button never
  sticks disabled, nothing hangs. It first watched `credentials.create` — the
  wrong function — and retracted its "no error after 15s" note as an
  instrument bug. The error text is the browser's raw exception message,
  because `Restore.jsx:37` passes `err?.message` through verbatim; the plain
  fallback only appears when the exception carries no message. Lane verdict:
  not a blocker, matches the finding above.
- OPSEC, transport: onion 80 open / 443 dead, clearnet 443 refused / 8080
  open; preference, overrides and "off" unchanged; no automatic clearnet
  fallback, no TLS bypass. Socket OPEN is not group messaging — no lane has
  proven a two-account group exchange on any transport.
- OPSEC, device-lock: measured on `origin/feat/device-lock` `6356411`, merge
  base `1f32ba6`. Withdrew an earlier "pre-rewrite history" claim: the branch
  and all 14 commits are noreply. Separate hazard found while checking it —
  see below.
- AUDITOR, round 2 at `17dc8ab`, own clone, `npm ci` instead of a symlinked
  `node_modules` (lock sha256 `6ee082e2…` unchanged by the install;
  nostr-tools 2.25.2, dexie 4.4.6): build 0 (`index-CNxR3c1G.js`), lint 0/88,
  434/434, 14/14 UI on its own fresh port 8103, `__cipher` 0 in production
  after rebuilding. It verified the docs-only chain parent by parent and added
  the removal probe. Its open items: D1 (Face ID door), D2 (group transport
  443/80), D3 (no two-account exchange).
- OPSEC, round 2 — runbook corrected, and it withdrew a claim it had made
  itself: onion TLS would not fix group transport for ordinary browsers,
  because a browser cannot resolve an onion name at all; it fixes the measured
  endpoint for Tor-routing clients only. It could not establish a certificate
  path for `.onion` and marks TLS-on-443 NOT actionable until one is verified.
  The only actionable owner action it found is flipping two pinned literals
  from `wss` to `ws` in `src/lib/egress.js:43` and the same string in
  `egress.test.js` — no certificate, no server change. That is a founder
  decision and is not taken here. AUDITOR added the caution that decides
  where it could even apply: on an `https` page a `ws://` socket is blocked
  as mixed content, so the flip helps only an `http://<onion>` origin, not
  the https clearnet PWA. OPSEC's attached drill — create, join, message each
  way, reconnect through a restart — is the two-account exchange itself; only
  a green drill would earn the words "groups work".

### Two branches under one name

`origin/feat/device-lock` (`6356411`) is current history. The LOCAL
`feat/device-lock` in `/home/aegis/wt-lock` (`262cdd2`) has no merge base with
this branch and 941 commits outside current history carrying pre-purge
identities (counts only: 35 personal Gmail, 906 GitHub noreply handles).
Never push, move, rebase or delete that worktree; any device-lock testing
works from the origin branch in a fresh worktree. Merging either into the
release is refused: `merge-tree` exits 1 with conflicts in `package.json`,
`src/LockScreen.jsx`, `src/lib/vaultLockout.test.js`, `src/useIdentity.js`,
and the branch has no v3 rollback.

## Lane ownership (one row per worker; no overlap)

| Lane | Scope | Where | Blocker |
|------|-------|-------|---------|
| BOSS | integration, candidate, this evidence file | `/home/aegis/cipher`, `release/launch-v1` | none |
| BITCH2 | read-only auth verification | `/tmp/bitch2-verify` @ `ca1c6a0`, detached, dirty: M package.json, LockScreen.jsx, Create.jsx, Restore.jsx, RestoreMnemonic.jsx, SaveKey.jsx; ?? src/lib/passkeyRecord.js and its test; own clone `/tmp/bitch2-authcheck` | none |
| AUDITOR | independent candidate check | `/tmp/audit-ui/tree` @ `cc6accc`, `/tmp/audit-ui/wt` @ `d83d452` | none |
| OPSEC | transport matrix, device-lock risks | read-only; own worktree if needed | none |

## Independent review of the counter change

BITCH2, whose surfaces these touch, read `5b12a30` against the real vault
shapes and returned HOLDS: `encryptKey` emits `{iv, data, salt, iter}`, a
legacy vault is the same minus `salt`, and `decryptKey` reads `iv`/`data`
the same way in both, so the damaged-vault guard rejects only envelopes that
would have thrown before the PIN mattered. Two narrow edges remain, both
pre-existing and not introduced here: a vault with intact `iv`/`data` but a
damaged `salt` still counts as a wrong PIN, and so would a ciphertext that
passed GCM authentication after corruption.

## Not done, and not claimed

- Not pushed. Not deployed. Not released. No deployment of this branch
  exists: the served entry is `index-C8I3GXXT.js` (measured by AUDITOR in
  round 1), the candidate builds `index-oiLnEhZQ.js`.
- `feat/device-lock` not merged, and refused for launch on the risk read below.
- Redesign, `/download`, `/privacy`, desktop builds, Tor bundles, orphaned
  test runners: untouched, per the order to complete only milestone 1.

## Promises not proven by any execution here

Stated so nobody reads this file as more than it is:

- A removed member cannot read a post-removal message: the local rule is now
  EXECUTED end to end (`src/lib/crypto/groupRemoval.test.js`, landed at
  `ec9b0c5`) — rotation, bundle, store and codec, with the removed member
  unable to open and a remaining member able. The live path is still not
  proven: no relay, no socket, membership enforcement and network delivery
  untested. It needs a two-account drill.
- Two accounts exchanging a group message on any transport: not done. Every
  transport statement in this file stops at socket behaviour.
- A keyring-less device under `feat/device-lock`: CODE-WALK, twice
  independently, never executed on such a device.
- Passkey cancellation against a real authenticator: the tap was driven with
  an instrumented rejection, not a human pressing cancel.

## Device-lock risk read (read-only; no merge)

Branch `origin/feat/device-lock`, merge-base `1f32ba6`, 14 commits, 27 files.

- A re-enrol overwrites the device key silently: the first vault then fails to
  open (`DeviceKeyMissing wrong-key`). Reachable from restore and biometric
  unlock before the new vault is saved.
- A keyring-less device (Tails, `basic_text`) locks existing PIN accounts out
  entirely, with no pre-check on the create screen.
- `mnemonicEnc` survives the lazy migration; no path deletes an account.
- Synced passkeys do not open a second device; the PRF record is per origin.
- Verdict: not safe to merge for launch without fixing the overwrite and the
  lockout, or an explicit founder decision.
