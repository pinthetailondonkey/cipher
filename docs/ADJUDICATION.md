# Adjudication — an independent read of the direction A pass

What this is: a falsification pass over the Direction A rebrand, its receipts and
its harness work, done by a session that did none of it. Every claim below was
re-derived from source or by running the thing. The evidence labels:

- `[V]` verified — reproduced here, with the command.
- `[R]` refuted — the claim does not survive the check.
- `[U]` unverifiable — could not be checked; not counted as verified.

Adjudicated at `3fa6ec41d8f5007d2d18aa8a5df4224dc975134a`, 2026-11-05 evening
sitting. When the sitting began, HEAD was `66caa07` with ten modified `src/`
files that belonged to a parallel media lane; that lane landed as `917793e`
mid-sitting, then `4595982`, then `3fa6ec4`. Nothing in the receipts' folder was
written by the adjudicator; no product code or spec was changed to write this.
The tree was clean (`git status --porcelain` empty) at the final checks except
where noted.

## What was checked, and how

| Claim | How checked | Outcome | Evidence |
| --- | --- | --- | --- |
| Shots taken from a `cf275e7` run recording `dirty=false` | `grep dirty= $JCODE_SCRATCH_DIR/ui-sweep/finO.log` (the 13-test screenshots batch, mtime 16:51, 4 min after `cf275e7` landed at 16:47) | `[V]` | `finO.log` prints `sha=cf275e7… dirty=false`, `13 passed (4.1m)` |
| Eleven of twelve files byte-identical to `645a878`'s set | `git show 645a878:<path> \| cmp - <worktree path>` over all twelve | `[V]` | exactly the `seeded-thread-*` pair differs |
| Moved pair differs only in the clock: 243x232 at phone, 243 px at desktop | decode both to rgba (`magick <f> -depth 8 rgba:-`), byte-compare in python, print true bbox of differing pixels | `[V]` | phone: 1087 px in `243x232+756+360`; desktop: 243 px in `25x124+854+195`; cropping those regions shows only timestamps (`01:55`→`04:45` PM and `02:00`→`04:46` PM) |
| Browser suite is 175 tests in 30 spec files (31st file is run-context) | `npx playwright test --list` | `[V]` | `Total: 175 tests in 31 files`; 30 unique `.spec.js` names plus `runContext.setup.js` which holds one setup test, not a spec |
| `npm test` 1010 / 1006 / 0 fail / 4 skipped | `npm test` (941s) | `[V]` for shape, stale by one | this run: `# tests 1011`, `# pass 1007`, `# fail 0`, `# skipped 4`, exit 0. `917793e` added exactly one test (`mediaCrypto.test.js` N1), so the receipts' 1010 was true at `66caa07` and is stale now |
| `npm run lint` 0 errors | `npm run lint` twice | `[V]` for errors, warnings moved | `0 errors`; 104 warnings against the dirty `66caa07` tree, 105 at `4595982+` (the receipts said 101 and said the count moves with the lane's edits, which it demonstrably does) |
| `tests/ui/ui-contract.spec.js` green | `WORKERS=2 bash tests/ui/tools/ui-files.sh adj-ui-contract tests/ui/ui-contract.spec.js` | `[V]` | 31 passed (3.5m) at `66caa07` dirty |
| `tests/ui/session-boot.spec.js` green | same runner | `[V]` | 4 passed (2.2m) |
| `tests/ui/screenshots.spec.js` green and regenerates the receipts | same runner, twice | `[V]` | 13 passed at `66caa07` dirty, 13 passed again at `4595982` |
| `tests/ui/sheet-a11y.spec.js` green | same runner | `[V]` | 11 passed (3.2m) at `3fa6ec4` `dirty=false` |
| The `devicePrf` pair runs only under `--project=chromium` | `npx playwright test --list --project=chromium`; run of the pair with and without the env flag; `--project=iphone` slice | `[V]` for the project shape, `[R]` for the README's sentence (below) | bare slice executes 6 tests (run-context + the pair); `--project=iphone tests/ui/devicePrf.spec.js` prints `Error: No tests found` |
| `npm run test:ui` picks the pair up | read `playwright.config.js:33-58` and `package.json:16` | `[V]` | the default run selects all three projects; the chromium project's `testMatch` takes the pair, the iphone project's `testIgnore` drops it. No CI config exists anywhere in the repo, so there is no separate CI path |
| All 30 spec files ran green after the shots: 205 executions over 14 batches | tallied every surviving batch log in `$JCODE_SCRATCH_DIR/ui-sweep/` | `[U]` and contradicted by the record | logs show 144 executions over 10 batches after the shots run (finP..finX, 17:08..18:04) plus the 41-test contract batch (finN) that ran at 16:45, six minutes *before* the shots. No subset of the surviving logs sums to 205 over 14. The two contract files' last recorded pre-my-runs green is that pre-shots batch |
| No "Track anything" destination | `grep -rn "Track\b" src/` (product surfaces) | `[V]` | zero hits in components or actions; `orderActions.js` carries the Pay / Mark shipped / Confirm delivery / review vocabulary only |
| One primary action per card, never a row of buttons | read `src/lib/orderActions.js:422-498` and `src/components/MessageBubble.jsx:261-266` | `[V]` | actions render as a vertical stack of text links (`block mb-1`), at most one solid accent surface per card; the shipped status pill (`bg-accent`) is a badge-class word, which DESIGN.md excepts |
| No emoji in UI strings | `npm test` (the `uiWords.test.js` guard is in it) plus a manual grep | `[V]` | the only emoji in components are `REACTION_CHOICES` (content, explicitly waived by the guard at `uiWords.test.js:106`) and one comment |
| Two tabs only; Menus reachable as a Threads segment | read `src/lib/tabs.js:13-28`, `AuthenticatedApp.jsx:22,180-203`, `BottomBar.jsx`, `ChatList.jsx:354-358` | `[V]` | `TABS` is frozen at `['chat','profile']` labelled Threads and You; segment state owned by the shell (`AuthenticatedApp.jsx:22`), so a drill-down returns to it; pinned by `src/lib/tabs.test.js:14-22` (part of `npm test`) |
| You carries Orders through Wallet's own My Orders row | `src/Wallet.jsx:378,515` | `[V]` | the row sets `view('orders')`, `needsAction` badge rides the You tab in both navs |
| 390x844 is the iphone ring, 1280x800 a real desktop context | `magick identify` (1170x2532 = 3x DPR) and `playwright.config.js:48-58` | `[V]` | as the README describes |
| Harness repairs priced, not blanket | read `0f959e7`, `e29492c`, `6696a23`, `800b123` diffs; grep every UI commit `cab7cb0..HEAD` for skips and waits | `[V]` (verdict below) | zero `.skip(`/`.fixme(` added; no assertion deleted; `test.slow()` added four times with per-test reasoning; the wait changes are small settles or a 3000→2000 replacement |
| No relay reached during the shots | no packet capture available | `[U]` | the claim is plausible (the suite runs headless against localhost; `relay-wall.spec.js` intercepts all sockets) but was not measured by the adjudicator |
| "Pixels of a commit and nothing else" | read `tests/ui/runContext.setup.js` | `[U]` | run-context records the sha and the port and refuses a bundle without the seam, but cannot prove the served bundle was built from that sha; the webServer does build fresh per run, so the claim rests on the runner's discipline, not on a check |

## What is actually broken

**1. A real product bug, not a harness one: at 1280x800 the "No chat open"
empty-state card is clipped in half.** `seeded-home-1280x800.png` in the
shipped receipts shows it: the card starts at x=775 and is cut at x=915,
mid-text ("Pick a chat from | the list."). Cause: at md+ the list pane takes a
fixed 340px (`Chat.jsx:147`), the thread pane gets the 140px remainder of the
480px column, and the empty-state card is `max-w-sm` (384px) plus gutters
(`Chat.jsx:169-172`) inside an `overflow-hidden` pane (`Chat.jsx:158`). The
card can never fit. This has shipped since the shell landed (`cab7cb0`), it is
in the evidence folder unremarked, and no spec pins the empty thread pane at
md+. Reproduction: boot the app at 1280x800 with no chat open. The receipts do
not claim the card renders fully, so this is not a receipt lie; it is a defect
the receipts photographed and nobody read.

**2. `[R]` `docs/ui-evidence/direction-a/README.md:68` — "A file slice that
names the pair without the project runs nothing at all."** False as stated. A
bare slice with the desktop build flag executes six tests: run-context plus the
whole pair (`npx playwright test tests/ui/devicePrf.spec.js
tests/ui/account-switch.devicePrf.spec.js` → `6 passed (1.9m)`). The
nothing-at-all outcomes are real but have other mechanisms: without
`CIPHER_DESKTOP_BUILD=1` the webServer build refuses (vite's carrier guard) and
zero tests run; with `--project=iphone` the slice prints `Error: No tests
found`. The sentence replaced an earlier, accurate one (`645a878`'s version:
"they default to the iphone project, whose testIgnore drops both" — which was
itself wrong about the default) with a stronger, wronger one. The trap the
receipts want a reader to avoid is real; the sentence built to warn about it
describes the wrong tripwire.

**3. `[R]` `docs/DESIGN.md:171-172` — the ruling's own layout sentence.** It
says the Chats / Groups / Menus segments sit "in one `Segmented` row under the
filter field". Both the pixels and the code put the segments above the filter
field (`ChatList.jsx:354-378`, visible in `seeded-home-390x844.png` and the
desktop home shot). The receipts README describes the pixels correctly; the
system-of-record does not describe the system. DESIGN.md:11 makes the file win
over the code, so this is a live contradiction, not a typo.

**4. `[R]` `docs/DESIGN.md:105-107` — "Two consumers now: the Threads filter
and the payment-method row."** `Segmented` has exactly one consumer in the tree
(`ChatList.jsx`). No payment-method Segmented exists anywhere in `src/`. Worse,
`MyOrders.jsx:82-94` hand-rolls `role="tablist"` with its own two-segment
row, the exact pattern the same paragraph bans ("No screen hand-rolls a
tablist", line 106). The ledger row predates the ruling (since `157a598`,
10-28), but the ruling's rewrite of this paragraph on 11-05 (`9e6e359`) asserts
a second consumer that was never built.

**5. `[R]` `docs/ui-evidence/direction-a/README.md:54-55` — "205 test
executions over 14 batches."** Not reconstructable from the surviving record.
The batch logs total 144 executions over 10 batches after the shots run
(finP..finX), 388 over 23 batches since the first receipts, 198 over 13 before
the shots in the same sitting. No combination yields 205/14. The directory's
own mtime shows a file was removed at 19:08, after the last receipts commit, so
either a batch log was deleted or the number was miscounted. The
direction of the claim ("all 30 files green after these shots") is separately
contradicted: `ui-contract.spec.js` and `sheet-a11y.spec.js` last ran green six
minutes before the shots, not after. Both were re-run green by this
adjudication, so the suite is not the problem; the receipt's accounting is.

**6. `[R]` `docs/DESIGN.md:238` — "`docs/ui-evidence/telegram-pass/` holds
this pass's screenshots."** The path does not exist and never has on any
commit (`git log --all -- 'docs/ui-evidence/telegram-pass*'` is empty). The
screenshots it promises live in `docs/ui-evidence/phase-1/`. Pre-existing
line (from `1947b64`, 10-30), not this pass's work, but DESIGN.md is the file
every agent is ordered to read first, and it names a phantom.

**7. A cosmetic regression the receipts photographed before it existed: the
nameless-peer header avatar.** `917793e` (the parallel lane) replaced the
thread header's `Picture`+inline fallback with `Avatar`
(`ChatHeader.jsx:215-219`). The old fallback drew `shortNpub`'s first letter
("n" for `npub1…`); the new call passes `name={profile?.displayName}`, which is
empty for a no-profile peer, so `Avatar.jsx:52` draws "?". The receipts' thread
shots show "n"; the same shots regenerated at the current tree show "?" and a
31136-pixel difference at phone width. To the lane's credit, the same change
replaced flat `bg-panelAlt` circles with the deterministic two-tone gradient,
which is what DESIGN.md:113-114 actually requires. Not this pass's bug; named
because the receipts are now evidence of a UI that no longer ships.

**8. Harness audit verdict: the timeouts are priced, not lazy.** `0f959e7`'s
60s/15s exist because every spec now pays a real 600k-iteration PBKDF2 and a
WebAuthn round trip at the gate, twice on reload; the commit names the exact
red specs (order-card escrow, pin-unlock 9-digit, standalone-select), and the
morning shard logs corroborate (`shard-2.log`: five `toBeVisible` failures
including order-card, before the timeouts landed). Nothing is waited on a bare
clock that could hide a product bug: the added `waitForTimeout`s are 500-1000ms
capture settles and one 2000ms relay-settle that replaced a 3000ms one
(`4136668`). Zero skips, zero `.only`, zero deleted assertions. The two places
a skeptic should keep watching: `e29492c`'s `unlock()` after reload makes specs
stronger (they walk the real gate twice), but `fixtures.js:26` keeps the
"tolerant of a build that restores a session" path, so a boot change back to
session restore would pass silently until `session-boot.spec.js` catches it;
and `6696a23`'s `acrossReload` poll still enforces its 60s budget, so it is not
an escape hatch. `check-catch`'s button count 1→2 was re-derived from the
render (two cards now draw the offer), not loosened. No spec got quieter.

## What could not be checked

- The 205-over-14 accounting could be true if a batch log was deleted at
  19:08; the surviving record contradicts it either way (item 5).
- "No relay reached": no packet capture was taken; the claim rests on the
  suite's localhost-only setup and `relay-wall`'s interception, not on
  evidence.
- "Pixels of a commit": `run-context` records the sha but cannot bind the
  served bundle to it. The webServer rebuilds each run, so the risk is a tree
  moving between build and shot, which is exactly what the receipts admit
  happened elsewhere in the sitting.
- The receipts' exact warning count (101) and npm-test duration (14m) at their
  tree: reproduced as 104-105 and 15.7m at neighbouring trees; the numbers move
  as the receipts themselves say.
- Whether the receipt folder satisfies `DESIGN.md:230` "current": the file
  requires screenshots in `docs/ui-evidence/<phase>/` but is silent on
  freshness. Judged below, not checked, because the file sets no bar.

## Stale-but-true, and true-but-seductive

Stale-but-true, all overtaken by the lane's `917793e` while this was being
written: the receipts' 1010-test count (now 1011), the 101-warning line (now
105), and the folder's pixels themselves, which no longer match the shipping
tree on two screens (thread: clock plus the avatar change, item 7; you: the
Wallet avatar glyph grew from 15px antialiased grey to a 24px white letter,
`Wallet.jsx:495` now passes `size="lg"` with `!text-2xl`). A re-take at
whatever sha ships next is required before this folder can be called the
evidence of record again.

True-but-seductive: "the shots above are the one run that recorded
`dirty=false`" is literally honest and leaves the reader to assume the sweep
ran clean too; seven of the ten post-shots batches recorded `dirty=true` at
their own shas as the lane edited files underneath. The README also says
"every spec seeds the fixture vault and pays a real PBKDF2 derivation at its
gate" (line 56-57); `relay-wall.spec.js` seeds nothing and dials nothing on
purpose, `keypad.spec.js` carries no seed, and the onboarding screenshot clears
storage by design. Three exceptions to a "every" sentence. And the receipts'
not-photographed list is honest, but the one thing the desktop home shot
actually needed to be read for — the clipped empty-state card (item 1) — went
unremarked in both the README and the folder that photographs it.

## Verdict

The work ships. The rebrand itself is real and verified: two tabs, three
segments, Menus as a browse segment, the badge moved to You, no Track
destination, no emoji, the receipts' PNG evidence internally honest at the tree
it names, the counts real, the harness repairs justified by measured work and
audited clean of skips and deleted assertions. Nothing the receipts claim about
the product is false. Three things must not survive contact with the next
sitting unchanged: the clipped "No chat open" card at 1280x800 (a real,
user-visible defect, item 1); the receipts' devicePrf sentence, which
misdescribes the trap it warns about and will send the next debugger looking in
the wrong place (item 2); and the DESIGN.md ruling sentences that contradict
the code they rule on (items 3 and 4), because a system of record that is wrong
about its own ruling is how the next pass ships a second contradiction with
confidence. The evidence folder is now stale against the tree that ships and
needs one re-take at the new sha; that is bookkeeping, not a blocker.

## Recommended next

1. Fix the md+ empty thread pane: give the thread pane a min-width or let the
   `max-w-sm` card shrink; pin it with a spec that measures the card at
   1280x800. `Chat.jsx:147-172`.
2. Re-take the six receipts at the next stable sha and re-derive the two moved
   regions the same way (decode, not `magick -format %@`, which antialiasing
   fools); rewrite the stale counts (1010→current, 101→current, the 205/14
   line to a number the logs actually show).
3. Correct `README.md:68` to the two real tripwires: without the desktop build
   flag the run dies at the carrier guard, and `--project=iphone` over the pair
   lists nothing. The bare slice runs the pair.
4. Reconcile `DESIGN.md:171-172` (segments under the filter) with the shipped
   order (segments above), and fix `DESIGN.md:105-107` (one Segmented
   consumer; `MyOrders.jsx:82` hand-rolls a tablist) or move that row onto
   `Segmented`.
5. Fix `DESIGN.md:238` to name `docs/ui-evidence/phase-1/`, the folder that
   exists.
