# Launch evidence — release/launch-v1

One file. Every line is a command's output, not a memory. Detailed logs stay
outside the tree. Nothing here is pushed, deployed or released.

## Identity of the candidate

- Base: `origin/main` = `1b0fb053f5695cc729b390948c7635b320606fa1` (fetched 2026-10-28).
- Branch: `release/launch-v1`, cut from that SHA.
- Candidate HEAD: see `git log --oneline origin/main..HEAD`. Five local commits,
  none pushed, per the founder's release order that overrides "push each commit".

## Milestone 1 — auth and recovery

| # | Finding | Verdict | Commit |
|---|---------|---------|--------|
| 1 | A local restore rebuilt the account entry and dropped `mnemonicEnc` (the encrypted 12 words) and any device envelope | confirmed, fixed, tested | `4dc0df0` |
| 2 | New-PIN rule was "eight or more" at the centre while the screens said exactly eight; unlock charged every error to the five-attempt counter | confirmed, fixed, tested | `cbc2037`, `5b12a30` |
| 3 | The save screen said the words and "your PIN" recover the account; a new device asks for a new PIN | confirmed, fixed | `7042cb5` |
| 4 | The Face ID door opened on a stored record alone, with no PRF capability check | confirmed, fixed, tested | `298ef9b` |
| 5 | `feat/device-lock` integration risks | inspected, NOT merged | none |

Finding 1 is the trust-edge class CLAUDE.md names: state that lives only in
one place. The entry is the only holder of the encrypted words for an account
restored on this device, so rebuilding it erased the account's own backup.

Finding 2's second half matters more than its first: five wrong PINs delete an
account, so an error that was not a wrong PIN spending one is a deletion path
with no wrong PIN typed.

## Gates at the candidate

Run in the founder's checkout, production build (no test hooks):

- `npm run build` — exit 0, entry `dist/assets/index-Drp6qFzv.js`
- `npm run lint` — exit 0, warnings only
- `npm test` — 434 tests, 434 pass, 0 fail
- `__cipher` absent from every built asset (test-hook build not used)

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
  `displayName`, `createdAt` and `confirmed`. EXECUTED.
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

- Not pushed. Not deployed. Not released. Production still serves `1b0fb05`
  or older; no deployment of this branch exists.
- `feat/device-lock` not merged and not reviewed to a verdict beyond the risk
  read below.
- Redesign, `/download`, `/privacy`, desktop builds, Tor bundles, orphaned
  test runners: untouched, per the order to complete only milestone 1.

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
