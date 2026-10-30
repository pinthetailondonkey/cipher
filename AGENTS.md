# Cipher — agent brief

[CLAUDE.md](CLAUDE.md) holds the rules for changing this repo. This file only
says where the rest of the truth is, so an agent does not have to guess.

## Read in this order

1. [CLAUDE.md](CLAUDE.md) — the rules every change obeys: one change per commit,
   green build/lint/test before a commit, the unit and trust-edge checks, what
   not to touch without a reason.
2. [README.md](README.md) — what the app is, how to run it, and how a deploy is
   proven. Status codes prove nothing; the page does.
3. [docs/VISION.md](docs/VISION.md) — what this is for.
4. [docs/VOICE.md](docs/VOICE.md) — the words. Read before changing any text a
   person sees. Words only, never a restyle.
5. [docs/LAUNCH-LOG.md](docs/LAUNCH-LOG.md) — what has been checked, what is
   open, and what is waiting on a decision.
6. [docs/UI-SPEC.md](docs/UI-SPEC.md) — the shell the screens are being built
   toward.
7. [docs/DESIGN.md](docs/DESIGN.md) — the visual system of record. Before any
   UI change, read DESIGN.md. On conflict, follow DESIGN.md and flag the
   conflict in your report.

## Hard lines

- No secret, key, token or credential file enters a commit, the working tree or
  history. `.env.local`, `dist/`, `.vercel/` and `android/` stay untracked.
- Commit as the project's noreply identity, never a personal address.
- Signals are read-only without a stated reason: `useNIP44DM.js`,
  `useNIP29Group.js`, `src/lib/crypto/*`, `src/lib/egress.js`, `privacy.js`,
  `chatStore.js` selectors, `paymentState.js`, `paymentWatch.js`, haptics.
- No public block explorer is ever called. A payment's confirmed state comes
  from a watcher the user runs and pastes in Connections, and a vendor's own
  wallet is not a chain confirmation.
- Money is a decimal string of the coin's own scale (Bitcoin 8, Monero 12),
  rounded half up and never dropped. Never a float, never a unit the rest of the
  code does not expect.
