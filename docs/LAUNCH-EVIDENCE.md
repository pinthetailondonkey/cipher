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
