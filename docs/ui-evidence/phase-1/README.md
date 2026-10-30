# Phase 1 — tokens, type, layout, shared components

Final cut base: `76855332b35fe133e09533bcdab070292fa48fef`.
This branch: `9f9644abb9c519ac710e21e104c4c2f3fd24b567`, tree
`38cd58e74f0099ff234cca88428c16f599707013` (three commits on the cut:
`cca608c` DESIGN.md, `8376119` Phase 1, `9f9644a` the hidden-preview pill).
Visual system of record: `docs/DESIGN.md`.

## The set is replaced, not amended

Every picture below was shot once at the sha/tree above, scrolled one
viewport at a time. The previous set (`preview-*.png`, `chats-header-*.png`)
was deleted, not kept beside these: a reader must never have to guess which
tree a picture came from.

**These files are uncommitted working-tree state.** `HEAD` at `9f9644a` still
carries the OLD picture set, so a fresh checkout of that sha yields the old
images, not these; the run-context line says `dirty=true` for the same reason.
Until this directory is committed on some sha, these pictures are evidence for
the working tree built from `9f9644a`, and no claim about them should omit
that word.

## Screenshots

Every PNG carries its own provenance printed in the corner — surface, viewport,
scroll offset, sha and tree — so no picture can be read as evidence for a
different tree. The same block is machine-readable in `capture-index.json`.

`surface` is one of two words, and no other meaning is attached to it:

- `gallery` — the throwaway page `preview.html` mounting the **real** modules
  from `src/components/ui/*` (ScreenHeader, Avatar, ListRow, Badge, Button,
  Bubble, SystemCard, Composer) statelessly. It is not the shipped app.
- `live` — the running app at `127.0.0.1:8123`, session key seeded exactly as
  `tests/ui/fixtures.js` does.

| File | surface | Shows |
| --- | --- | --- |
| `gallery-00-390x844.png` | gallery | screen header, 7 avatar gradients at 52px and 28px, chat rows |
| `gallery-01-390x844.png` | gallery | badges, buttons, bubbles (78% / r18 / ticks) |
| `gallery-02-390x844.png` | gallery | the five-beat system-card rail, the floating composer |
| `gallery-00-1280x800.png` | gallery | same, desktop width |
| `gallery-01-1280x800.png` | gallery | same, desktop width |
| `gallery-02-1280x800.png` | gallery | same, desktop width |
| `chats-390x844.png` | live | Chats: header, logo, filter, All/Menus/Vendors, row with blurred preview + eye icon, tab bar |
| `chats-1280x800.png` | live | Chats, desktop width (drawer shell) |
| `dialog-390x844.png` | live | Burn-note dialog, centred, measured at rest |
| `dialog-1280x800.png` | live | same, desktop width |

Scroll offsets per shot are in `capture-index.json`; no two shots of one page
overlap by more than the caption chip.

The scratch page and capture script (`preview.html`, `src/preview-main.jsx`,
`scripts/evidence-capture.mjs`) were deleted before the recorded gate. The
screenshots are the record.

I looked at every picture in this set on this machine. What the set shows is
also asserted numerically in `tests/ui/ui-contract.spec.js`; the pictures are
the eyeball pass, not a substitute for the spec.

## Build-entry proof (BOSS condition 3)

Re-measured on the tree the pictures were taken from, after the scratch was
deleted:

- `vite.config.js` — no `rollupOptions` and no `input:` line
  (`sha256 d5f7541315418c03f409195bf399225dc22459b219dfcda0831795690ee176b1`,
  the same hash recorded in `capture-index.json`).
- `index.html` — no reference to `preview.html` or `preview-main`.

Verdict: single-entry `index.html`; the scratch page was in no build entry.

## Gate

Run once on the scratch-free tree at `9f9644a` / tree `38cd58e`, each step
redirected straight to a file, no pipes, no `tail`, no `head`. The working
tree differed from `HEAD` only by this directory's evidence files (old PNGs
deleted, new PNGs added, this README, `browser-reds.md`); no gate step reads
them.

| Step | Log | Result |
| --- | --- | --- |
| `npm run build` | `logs/gate-build-9f9644a-38cd58e.log` | exit 0, `✓ built in 8.91s`, 68 files in `dist/asset-manifest.json` |
| `npm run lint` | `logs/gate-lint-9f9644a-38cd58e.log` | exit 0, baseline warnings only |
| `npm test` | `logs/gate-test-9f9644a-38cd58e.log` | exit 0, `1..865`, 865 tests, 865 pass, 0 fail, 0 cancelled, 0 skipped |
| `playwright test tests/ui/ui-contract.spec.js --project=iphone` (`AUD_HARNESS_PORT=8081`) | `logs/ui-contract-9f9644a-38cd58e.log` | exit 0, 27 passed (53.7s), including the hidden-preview guard at `:91` |

The count line closes: 865 = 865 pass + 0 fail.

Runner-line check: 108 files are named in `scripts.test`; 109 test-named files
exist under `src/`, `scripts/`, `tests/`. The one not named is
`src/components/ui/smoke.test.jsx` (`package.json:19` omits it), which declares
no tests — it is a JSX helper exporting `sheetHtml` / `dialogHtml` / `smoke`,
compiled by `src/components/ui/ui.test.js:74`, and that consumer is in the
runner line. Nothing test-bearing is missing.

## The 14 browser reds

`browser-reds.md` in this directory names and classifies all fourteen reds
from the full UI runs. Thirteen are stale specs (a boot landmark the shipping
shell removed on purpose). The fourteenth — the `txid-single.spec.js:135`
receipt control, the only one on the money path — has now been measured alone
at this tree: 4 passed in 1.1m, `logs/txid-single-9f9644a-38cd58e.log` and the
traced rerun `logs/txid-single-9f9644a-38cd58e-run2.log`, whose trace zips are
copied to `logs/traces-9f9644a-38cd58e/` (a later Playwright run deletes
`test-results/`, so the durable copy is the evidence). The ordered trace grep,
with file and line per test, is recorded there. Verdict: environment
(contention), with the limits of that verdict stated in the file.

## Deviations and calls

1. **Sheet geometry.** DESIGN.md governs: `max-w-[420px]`, `rounded-[20px]`,
   centred on every width. The live app at the base measured 448px / 28px
   radius; that is now 420 / 20. The founder ruling (centred, never
   bottom-rising) is carried by DESIGN.md, so nothing was overridden. A tall
   dialog's max-height in `index.css` also moves from `100dvh - 0.5rem` to
   `100dvh - 3rem`: measured before the change, a long sheet sat at y=0 with
   8px below it (edge-to-top, not centred); after, it centres with 0.5rem of
   air each side.
2. **Avatar colours.** The 7 gradient pairs are token pairs, not literals, so
   a swap is one line in `src/components/ui/Avatar.jsx`:
   `accent→accent-text`, `panel-alt→accent`, `accent-text→accent`,
   `panel-alt→accent-text`, `accent→panel-strong`, `panel→panel-alt`,
   `panel-strong→accent`. White initial on every pair.
3. **Back-gesture close — deferred, not done.** A dialog closes on Esc, on a
   backdrop tap and on the scrim. Closing on the phone's back gesture needs
   `popstate`, which is a routing question (the `/note` deep link), owned by
   another lane. Flagged to the CEO/BOSS; not wired in this phase.
4. **Type floor.** The unread badge and the tab-bar count badge were 10px,
   below DESIGN.md's 11px floor; both are now 11px (unread count label 12px).
5. **Glow / glass sweep.** Inside `src/index.css` only: `.linear-glow`,
   `.hybrid-*`, `.neon-*`, the `--glass-*` tokens and every `backdrop-filter`
   are gone; `.glass-panel` / `.glass-header` survive as flat panel/header
   aliases so untouched screens keep rendering. The `--glow-a/b` tokens are
   neutralised to `transparent` because seven screens outside this phase's
   lock draw them inline — those screens will look flatter and were not
   edited.
6. **Logo blue, sampled from `public/logo_raw.png`** (237×256, histogram of
   opaque pixels): the dominant blue is `#005DFE` (7,015 px), with `#005EFE`
   3,924 px beside it; the token `#005DFD` appears 905 px — one 8-bit step
   inside the same cluster. The token is therefore the logo's blue, not an
   approximation of it.
7. **UI suite port mismatch, pre-existing.** `tests/ui/runContext.setup.js:11`
   defaults to port 8285 while `playwright.config.js:8` serves 8081, so a
   plain `npm run test:ui` on a fresh checkout refuses at the run-context
   gate before any spec runs. Measured identical at base `4c2b616`; not
   introduced here and not fixed here. Suite runs use
   `AUD_HARNESS_PORT=8081`.
8. **Logo size, one file outside the brief's list.** DESIGN.md names a 28px
   mark; the live header measured 28 wide × 30 tall, because Tailwind's
   preflight sets `img { height: auto }` and the raw mark is 237×256. Fixed
   in `src/components/Logo.jsx` by pinning both axes inline (`style={{ width:
   size, height: size }}`), a one-line change that also corrects every other
   Logo use from intrinsic ratio to the size asked for.
9. **Old shells still outside the ruling — recorded, not edited.** On the
   Chats screen, Saved messages and Notifications are full-screen panes on the
   old shell (`BookmarksViewer`, `NotificationCenter`), not Sheet dialogs, and
   `CreateGroupModal` is still shaped like a bottom sheet (`rounded-t-3xl`,
   `max-w-md`). All three are screens, outside this phase's lock; the next
   phase owns them. The ruling itself is proven live on the Burn-note dialog,
   which is the `dialog-*.png` shot in this set.
10. **`docs/UI-INVENTORY.md`** was read and its header says it was written at
    `9755061`; it is stale against the live tree. Not edited in this phase.
11. **The hidden-preview pill, this branch's last commit.** DESIGN.md bans the
    labelled reveal pill; a hidden preview is the blurred line plus one small
    eye icon. `src/components/chat/ChatList.jsx` now draws exactly that, and
    `tests/ui/ui-contract.spec.js` pins it (no `Tap to show` in the row
    source, `<Eye size={14}` present). Seen live in `chats-390x844.png`.
