# PIN length evidence

Question: can a vault exist whose PIN is longer than eight digits? The
unlock keypad has eight slots, so if one could, that account would be
unopenable on this device — every attempt at its 8-digit prefix would
spend one of the five attempts that delete the account.

## Answer

No. No screen in this repository's history — including the pre-rewrite
dangling history — ever accepted a ninth digit, so no vault written by
the app can carry one. Every claim below is a `git show <sha>` read of
the named file, not a recollection.

- `6d83b48` (rewritten history's initial commit) — LockScreen's PIN
  input: `e.target.value.replace(/\D/g, '').slice(0, 8)` with
  `maxLength={8}`.
- `13f20cf`, `c821e2b`, `9d81a04`, `2a3382d` (dangling pre-rewrite
  history, the "PIN (4+ digits)" era) — same `slice(0, 8)` +
  `maxLength={8}` on every PIN input they touched.
- `a911eee` — the keypad is born with `maxLength = 8` and a press guard
  (`value.length < maxLength`); Create, Restore and RestoreMnemonic are
  born with `slice(0, 8)` + `maxLength={8}` on their PIN fields.
- `1c7aba4` — the minimum for a NEW PIN rises 6 → 8; its own message
  records "Keypad already had 8 slots."
- `cbc2037` — `isAcceptableNewPin` requires exactly eight at the centre.

One path could mint a longer-PIN vault, and it was never a screen:
between `1c7aba4` and `cbc2037` the centre checked `>= 8`, so a direct
call to `createVault` with ten digits would have passed. No UI could
type those digits, so no vault from the app carries them. Not a bug;
recorded so nobody has to re-dig.

## Every vault writer, and where its PIN came from

A vault's PIN length is set by the field it was typed into, so the
question is whether any field that ever fed `encryptKey` accepted a
ninth digit. Each writer, with the read that bounds it:

- **Create** — `createVault(handle, pin)`; the PIN field is born at
  `a911eee` with `slice(0, 8)` + `maxLength={8}`.
- **Restore from words** — the new-PIN field in RestoreMnemonic, born
  at `a911eee` with the same cap.
- **Restore by handle** — decrypts a vault that was already written; the
  PIN field in Restore, born at `a911eee` with the same cap, and the
  stored vault keeps whatever length its own writer gave it.
- **Unlock's transparent legacy upgrade** — re-encrypts with the PIN
  just typed on the keypad, born at `a911eee` with eight slots.
- **Passkey recovery on a fresh device** — the new PIN comes from the
  Restore/lock-screen fields above, and `isAcceptableNewPin` bounds it
  at the centre (`>=` from `1c7aba4`, exactly 8 from `cbc2037`).

The `>=` window at the centre could not be reached with a longer PIN by
any caller: every field that feeds it has capped at eight since before
the window opened. `git log --all -S 'setPin(e.target.value'` lists
every commit that ever touched a PIN setter; each one carries the same
`slice(0, 8)` + `maxLength={8}` pair.

## The executed half

`tests/ui/pin-unlock.spec.js` runs the proof the other way: it seeds a
real 9-digit vault, drives five actual UI unlock attempts with the only
typeable prefix, and watches the account wipe — the 12 words left as
the only way back. Seeding is the test's own construction; the wipe is
the app's own behavior.

## Consequences

- The eight-slot unlock keypad locks nobody out: every vault the app
  ever wrote has a PIN of eight digits or fewer.
- Six-digit legacy PINs still open (spec: `tests/ui/pin-unlock.spec.js`,
  "a 6-digit PIN from before the eight-digit rule still opens the
  account").
- The cap is load-bearing: a ninth digit must stay untypeable, and the
  spec asserts it ("a ninth digit is refused").
