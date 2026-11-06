# Direction A receipts — tree at `52e96db` (2026-11-05)

The six screenshots `docs/DESIGN.md` asks a phase to leave behind, at both
widths: 390x844 (phone ring) and 1280x800 (desktop ring). Taken from a local
UI-test build of a working tree at `52e96db` that recorded `dirty=false`, so
these are pixels of a commit and nothing else. No relay reached, no real key
anywhere.

The eleven batches of the sweep that stood behind them all ran at that one sha
with a clean tree, and each stamped both facts before it built; the table is
below. Two commits sit above `52e96db`: the thread pair's reshoot and this file,
both written after that run and neither changing what it built. Two earlier
sweeps in the same sitting were caught by a parallel lane landing group work,
which is why the receipts now name the sha per batch instead of once in a
sentence. The screenshots are the last batch the sweep runs, so nothing the
sweep itself writes can dirty a tree another batch is stamping.

Six screens, each at both widths:

- `seeded-home-*` — Threads. The header, the Chats / Groups / Menus segment
  row, the filter field, the empty state, and the shell itself: the bottom bar
  at phone width, the 72px rail at desktop width, where the list column keeps
  its own third pane.
- `seeded-menus-*` — Menus, the vendor browse pane, reached as a Threads
  segment (one tap in the header's own row) rather than a destination.
- `seeded-thread-*` — a thread with two synthetic messages, one each way. No
  order card in this pair; the card has its own spec.
- `seeded-you-*` — the You tab, which carries Orders through Wallet's own My
  Orders row. The ledger view itself sits behind that row and is not in this
  pair; a live contract case walks it and measures the row instead.
- `seeded-settings-*` — You > Privacy.
- `seeded-onboarding-*` — the first screen a new device shows, with no vault
  and no session.

## What moved since the set committed in `645a878`

Seven of these twelve files are byte-identical to that set. Five moved, and
every pixel of the move is accounted for:

- `seeded-home-1280x800` — the empty thread pane. It wore a hand-rolled
  `max-w-sm` card whose right border the 140px md+ pane cut, wrapping the line
  mid-sentence ("Pick a chat from | the list."). It now wears the shared
  `EmptyState`: no card, the icon above the title, both centred in the pane.
  Measured 124x132 at (792,334). `e95953c` and `2451e67`, with two live cases
  measuring it at both widths.
- `seeded-thread-*` and `seeded-you-*` — every avatar on both screens, from
  the media commit `917793e` and one repair. That commit moved the avatar off a
  flat `--panel-alt` circle onto the DESIGN.md two-tone gradient keyed by the
  pubkey, which is what the ruling asks for, and gave the Wallet avatar its
  `--line` ring and its 24px glyph. It also left the caller's `h-7 w-7` beside
  `SIZES.sm`, so the run avatar drew 32px where its own spacer drew 28 and every
  lead pushed its bubble right; `3ea07bd` made the call site win. Measured:
  1011x556 at (36,36) at phone width and 91x318 at (788,12) on the desktop
  thread, 240x240 at (465,36) and 80x80 at (636,32) on the You pair.
- Nothing else on those two screens moved. The messages, the clock, the rail
  and the list are byte-identical.

One thing in the thread pair is a change of subject, not of style: the header
avatar drew the lowercase `n` of the truncated npub before `917793e`, and draws
`?` now, because the peer has no profile and the new call passes an empty name.
Named here so a reader does not spend an hour deriving it from the pixels.

## How they were made, and what the pixels are

    CIPHER_DESKTOP_BUILD=1 npx playwright test tests/ui/screenshots.spec.js
    bash tests/ui/tools/ui-shots-out.sh

The spec writes twelve captures into the gitignored `test-results/` under
generic names; the tool is the naming step, and it refuses unless all twelve
land. Copy them first and run anything else afterwards: a later playwright run
wipes `test-results/`. The phone ring is the `iphone` project: 390x844 CSS,
deviceScaleFactor 3 (so the files are 1170x2532), iPhone user agent, touch. The
desktop ring overrides the viewport to 1280x800 and drops the phone flags, so it
is a real desktop context at 1x. Both rings open the harness's own vault first —
a literal pre-generated envelope whose secret is 32 bytes of 0xAA under PIN
13572468, so the pictures show an account with no key material behind it.

Not in these receipts: an order card in the thread (covered by
`tests/ui/order-card.spec.js`), the Groups list, the QR scanner, and the
installed-PWA geometry (covered by the `pwa-standalone-*` specs, which assert
the safe-area maths rather than photograph it). The raw per-run captures stay in
`test-results/`, which is gitignored; this folder is the copy that travels.

## The checks that stood behind them

The browser suite is 181 tests in 31 files (`--list` counts a 31st file, the
run-context setup, which holds one setup test, not a spec). All 30 of the spec
files were run green in the sitting that produced these shots, in batches sized
to fit a ten-minute tool budget (`tests/ui/tools/ui-sweep.sh`), because every
spec seeds the fixture vault and pays a real PBKDF2 derivation at its gate. The
batches write one TSV line each — label, sha, dirty count, exit, the reporter's
own tally — into `$JCODE_SCRATCH_DIR/ui-sweep/sweep.tsv`, which is what the
numbers below are read from instead of a remembered total.

- `npm run lint` — 0 errors, 105 warnings. The count moves with the lane; it
  stood at 101 at the previous take. Three of the 105 are in
  `MessageBubble.jsx` at lines 291, 347 and 456; the avatar line this folder's
  work touched is 534, so no warning here came from these commits.
- `npm test` — 1064 tests, 1060 pass, 0 fail, 4 skipped (this run is at
  `3ea07bd`; the lane keeps adding unit tests, so the count moves).
- The 47-test batch: `tests/ui/ui-contract.spec.js` (36, one of them new) and
  `tests/ui/sheet-a11y.spec.js` (10), plus the run-context setup every batch
  carries.
- The `devicePrf` pair (`devicePrf.spec.js`, `account-switch.devicePrf.spec.js`)
  runs under `--project=chromium`: it is the only project whose `testMatch`
  takes those two. Two tripwires, both real and neither where a reader would
  guess. Without `CIPHER_DESKTOP_BUILD=1` the webServer build refuses and zero
  tests run. With `--project=iphone` over the pair, playwright prints `No tests
  found`. A bare slice with the flag runs the whole pair, run-context included.

The whole sweep, in one line per batch: 191 executions over 11 batches, which is
the 180 spec tests plus the run-context setup each batch fires first. Every line
is green at the same sha on a clean tree:

| batch | sha | tree | exit | the reporter's own line |
|-------|-----|------|------|-------------------------|
| `sweep-contract` | `52e96db` | dirty=0 | exit=0 | 47 passed (5.6m) |
| `sweep-shells` | `52e96db` | dirty=0 | exit=0 | 24 passed (5.5m) |
| `sweep-gate` | `52e96db` | dirty=0 | exit=0 | 17 passed (3.9m) |
| `sweep-restore` | `52e96db` | dirty=0 | exit=0 | 16 passed (3.8m) |
| `sweep-boot` | `52e96db` | dirty=0 | exit=0 | 18 passed (5.3m) |
| `sweep-area` | `52e96db` | dirty=0 | exit=0 | 15 passed (3.7m) |
| `sweep-install` | `52e96db` | dirty=0 | exit=0 | 12 passed (3.0m) |
| `sweep-strip` | `52e96db` | dirty=0 | exit=0 | 13 passed (3.0m) |
| `sweep-select` | `52e96db` | dirty=0 | exit=0 | 10 passed (2.7m) |
| `sweep-prf` | `52e96db` | dirty=0 | exit=0 | 6 passed (1.8m) |
| `sweep-shots` | `52e96db` | dirty=0 | exit=0 | 13 passed (3.8m) |

The runner has no batch that reports the spec file list, so a batch name is the
sweep's own label, and the label's file list lives in
`tests/ui/tools/ui-sweep.sh`. Two of the eleven overlap by design: the contract
and sheet-a11y pair, and the shots batch that produced this folder.

## The adjudication

`docs/ADJUDICATION.md` is a falsification pass by a session that did none of
this work, landed at `c29e784`. It re-derived every claim in this folder from
source or by running the thing, marked what it could not check `[U]` and did not
count those as verified, and left the report in the house voice. It found one
real product bug the receipts had photographed and nobody had read, and four
sentences in the docs that were false.

Fixed, worst first, one commit each:

- `e95953c` then `2451e67` — the clipped empty card above. Two live contract
  cases now measure the pane at both widths.
- `ace7030` — `MyOrders` dropped its own `role="tablist"` for the shared
  `Segmented`. The row had missed the component's 44px target, and DESIGN.md's
  "two consumers" was false until it landed. A live case walks You > My Orders.
- `d233d60` — three DESIGN.md lines reconciled with the tree: the segment row
  sits above the filter field, the `Segmented` entry names its two real
  consumers, and the evidence pointer names `docs/ui-evidence/phase-1/`, the
  folder that exists, not the phantom `telegram-pass/`.
- `3ea07bd` — the run avatar above (found by re-deriving the pixel move, not by
  the adjudicator).
- The `205 executions over 14 batches` line is gone: the stamped TSV replaces
  it. The `devicePrf` sentence above replaces the one that described the wrong
  tripwire.

What the adjudicator marked `[U]`, and what still stands unproven here:

- No packet capture was taken, so "no relay reached" rests on the suite's
  localhost-only setup and `relay-wall`'s interception, not on a measurement.
- `run-context.setup.js` records the sha it built and refuses a bundle without
  the seam, but cannot bind the served bytes to that sha. The claim above rests
  on the runner rebuilding per run.
- `DESIGN.md:230` asks for screenshots in `docs/ui-evidence/<phase>/` and is
  silent on freshness. Nothing in the file sets a shelf life, so this folder is
  as current as the sha in its title and no more.
