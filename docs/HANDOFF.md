# Handoff — the security and UI remediation, where the last agent stopped

Written 2026-11-06 on branch `security-ui-remediation`, on top of `92efeab`
(SEC-3). This page's own commit is the one after it. Read the
same way as `AGENTS.md` says: `CLAUDE.md` first (the rules), `README.md`, then
`docs/VISION.md`, `docs/VOICE.md`, `docs/DESIGN.md`, `docs/PRIVACY-REVIEW.md`,
`docs/NO-IP-LEAKS.md`. This page only says what was already done and what is
left, so the next agent does not have to guess or re-derive.

The mission text itself (SEC-1..SEC-5, UI-1..UI-5, verbatim) lives in a chat
session, not a file: recover it with `conversation_search` anchored on the
phrase **"Multi-group connection correlation"** (the mission author is turn
5653). Do not re-derive the findings from scratch; recover the wording first.

## Status at a glance

| Item | State | Where |
| --- | --- | --- |
| SEC-1 sealed governance doc under a held secret | committed | `f467b51` |
| SEC-2 key request resolves its requester through verified bindings | committed | `1263e46` |
| SEC-3 a held verified doc outvotes the relay roster on a key grant | committed | `92efeab` |
| SEC-4 arbitrary attachment URL tracking | code + tests done, **uncommitted** | lane A below |
| SEC-5 multi-group connection correlation | code + tests done, **doc missing**, uncommitted | lane B below |
| UI-1 .. UI-5 | not started | mission text |
| Final matrix report with commit hashes | not started | mission text |

Nothing is committed that was not verified, and nothing below claims a check
that was not actually run.

## Lane A — SEC-4, complete, not committed

**Finding.** An arbitrary attachment URL tracking: any member can write a URL
into a message body, a profile or a listing, and the recipient's browser dials
that host while rendering.

**What exists now.**

- `src/lib/mediaUrl.js` — the single gate for wire-supplied URLs:
  `mediaHref` (only http/https is dialled; `data:`/`blob:` stay local;
  `javascript:`/`ftp:`/`mailto:`/`file:`/empty refused; relative resolved
  against the origin), `mediaHostOf` (host for the tooltip),
  `MEDIA_FETCH_OPTIONS` (frozen `{referrerPolicy:'no-referrer',
  credentials:'omit'}`), `mediaFetch` (one GET, throws on a stray).
- `src/components/ui/Picture.jsx` runs `useVisibleSrc` through `mediaHref` and
  renders `<img referrerPolicy={MEDIA_REFERRER_POLICY} title={host}>`;
  `Avatar.jsx`, `PrivateMedia.jsx`, `chat/VoiceNote.jsx` and
  `lib/mediaCrypto.js` take the same door; `openPrivateMedia` uses
  `mediaFetch(href, fetchImpl)` and keys its cache on `mediaHref(entry.url)`.
- `index.html` carries `<meta name="referrer" content="no-referrer" />` as the
  document floor; `docs/NO-IP-LEAKS.md` item 3 records the rule (the tooltip now
  names the source host).
- Tests: `src/lib/mediaUrl.test.js` (gate shape, host naming, one
  no-referrer/credential-free GET, a source walk asserting every door imports
  the gate and every `<img>` carries `referrerPolicy`, document meta) plus SEC-4
  witnesses in `src/lib/mediaCrypto.test.js`. Both registered in `package.json`.

**Evidence.** Red-when-reverted confirmed by hand: reverting the gate in
`mediaCrypto`/`Picture` turned 3 tests red, restored from
`$JCODE_SCRATCH_DIR/{mc,pic}.bak`. Full gate green at that point: **1081 tests,
1077 pass, 0 fail, 4 skipped; oxlint 106 warnings, 0 errors**
(`$JCODE_SCRATCH_DIR/full-sec4.txt`). That run predates the SEC-5 edits, so
re-run `npm run lint && npm test` before committing.

## Lane B — SEC-5, code and tests done, the doc is missing

**Finding.** Multi-group connection correlation: one WebSocket carries every
group this device follows, so a group relay reads the whole group-id set off the
REQ frames, all on one connection and one address. The NIP-42 proof on that
socket was signed by whichever group happened to be open on screen, so a proof
followed UI state and rotated as the reader switched groups.

**What exists now.**

- `src/lib/groupSocketProof.js` — `socketProofGroupId({held, readable, known})`.
  The pin a socket already proved under sticks; otherwise the LOWEST group id it
  reads, falling back to the lowest group the account holds, `''` when nothing
  is known (the challenge then goes unanswered, as before).
- `src/hooks/useNIP29Group.js` — `sessionActorGroupId` delegates to the rule
  (exported, along with `groupIdsOnSession`, so the seam is driven from the real
  tree); the active-group preference is gone.
- `src/lib/pool.js` — same rule per pool through a `heldProofGroup` WeakMap; the
  now-unused `useChatStore` import is dropped. `src/lib/relayDirectoryRead.js` —
  same rule, held for the life of a read.
- `src/lib/groupSocketProof.test.js` (registered in `package.json`): 11 tests,
  the pure rule (held sticks, lowest id, dedupe, empty) plus the source-pinned
  exposure contract (one socket per account, one sub per group, one AUTH per
  socket via `authSent`, the pin on the group host only, both pool paths holding
  their first pin).

**Evidence.** Touched suites green: 11 new, 66 neighbours
(pool/relayDirectoryRead/useNIP29Group/privacy/uiWords/groupCreate), 35
(groupJoin/groupJoinQueue), 0 fail; oxlint clean on the five touched
files. Red-when-reverted confirmed: reverting the hook and the pool to the
active-group preference turned tests 5, 6, 7 and 11 red; restored from
`$JCODE_SCRATCH_DIR/{hook,pool,rdr}.sec5.bak`.

**MISSING — `docs/SESSION-SEPARATION.md`,** the evaluation the finding asks for.
The outline is already fixed; write it with these parts:

1. The question, in plain words: what a group relay (or a passive observer on
   that host) can join about a reader.
2. The `[V]` facts with file:line — one socket per account
   (`useNIP29Group.js:95,596`, one `new WebSocket(` at `:534`); one sub per group
   on it (`:1313`); a per-group REQ on the shared socket (`:1315`); one AUTH
   gated by `authSent` (`:404-405`); the proof is kind 22242 under a per-group
   actor key (`gmIdentityWire.js:146`, `signActProof`); the pin reaches the
   group host only (`pool.js:154`, `relayDirectoryRead.js:85`).
3. The `[I]` joins: the group-id set is correlated to one connection and one IP;
   the subId carries the gid's first 12 characters but the gid is already in the
   `#h` tag, so nothing extra rides; the member doc publishes to group plus
   general relays, which is the cross-operator gid-to-authority-pin bridge.
4. The options weighed — per-group sockets and per-group AUTHs against one
   socket — with the at-most-once and delivery check for each.
5. The decision: one socket stays, the proof stops following the screen, and the
   reason (the relay already reads the set; the pin is the only identity fact and
   should be one stable pseudonym).
6. The residual leakage, worst first, and what would falsify each claim.
7. The tests that hold it up, named.

## What is left after that

1. Commit lane A alone, then lane B with its doc; re-run the full gate before
   each commit.
2. UI-1 .. UI-5 from the mission text (recover the wording first; `docs/VOICE.md`
   governs every visible word, `docs/DESIGN.md` the visual system).
3. The final matrix report: each finding, its evidence label, its commit hash.

## Conventions and environment quirks the next agent will hit

- Evidence labels `[V]` verified / `[A]` assumed / `[I]` inferred / `[U]`
  unknown. Never claim an unexecuted test passed. A red-when-reverted witness
  belongs before every commit.
- `npm run lint` is **oxlint** (there is no eslint config): the normal band is
  106 warnings, 0 errors. `npm test` is an explicit file list and
  `src/lib/testRunner.test.js` fails on any `*.test.js` that is not listed.
- Run suites directly: `node --import ./scripts/resolve-extensionless.mjs --test
  <files>`.
- Node suites that reach the group hook need `fake-indexeddb/auto` plus a
  `localStorage` stub installed before the import; member doc bodies validate hex
  pubkeys, so test ids look like `'ab'.repeat(32)`.
- One change per commit; no merge, no auto-deploy. Commits are authored
  `Cipher <noreply@ciphermessenger.org>` via `git commit -F <message file>`,
  bold subject line and a detailed body (see `f467b51`, `1263e46`, `92efeab`).
  `.env.local`, `dist/`, `.vercel/` and `android/` stay untracked.
- An orphaned banner replays for an old background task id (`355755rhaz`):
  ignore it.
