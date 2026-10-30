# Phase 1 — tokens, type, layout, shared components

Base: `4c2b616` · visual system of record: `docs/DESIGN.md` (`078e75f`).

## Screenshots

| File | What it shows |
| --- | --- |
| `chats-header-390x844.png` | Live app, Chats screen, phone width |
| `chats-header-1280x800.png` | Live app, Chats screen, desktop width |
| `preview-390x844.png` | Throwaway preview page, every component in every state, phone width |
| `preview-1280x800.png` | Same page, desktop width |
| `dialog-390x844.png` | The centred dialog over the preview page, phone width |
| `dialog-1280x800.png` | Same, desktop width |

The preview page (`preview.html` + `src/preview-main.jsx`) and the capture
script (`scripts/phase1-evidence.mjs`) are throwaway: deleted before the
commit. The screenshots are the record.

The screenshots were captured by the script, and the positions and sizes in
them are also asserted numerically in `tests/ui/ui-contract.spec.js`. The
images themselves were not viewed on this machine (no image reading on this
model), so the evidence is measurement, not an eyeball pass — the founder's
review of the pictures is still owed.

## Gate

Run on the final tree (throwaway preview files deleted first):

- `npm run build` — exit 0, `✓ built in 21.78s`.
- `npm run lint` — exit 0 (baseline warnings only, none from the rebuilt files).
- `npm test` — `# tests 767 / # pass 767 / # fail 0`, exit 0.
- `AUD_HARNESS_PORT=8081 playwright test tests/ui/ui-contract.spec.js` —
  `26 passed (4.6m)`, exit 0. The spec is new in this phase; it carries 22
  source checks (tokens, type scale, no literal colours, no glass, the
  component geometry) and 4 live checks (the Chats header, the tab bar, and
  the founder's centred-dialog ruling measured at 390×844 and 1280×800).

## Screens looked at

- Chats (header band, logo, title, list rows, tab bar).
- The preview page's components — not the app's other screens.

Every other screen still wears the old spacing and shadows and will look
wrong until its own phase. That is expected and is not claimed otherwise.

## Deviations and calls

1. **Sheet geometry.** DESIGN.md governs: `max-w-[420px]`, `rounded-[20px]`,
   centred on every width. The live app at `4c2b616` measured 448px / 28px
   radius; that is now 420 / 20. Founder ruling (centred, never bottom-rising)
   is already carried by DESIGN.md, so nothing was overridden. A tall
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
   another lane. Flagged to the CEO/BOSS; do not wire it in this phase.
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
   introduced here and not fixed here. The suite was run with
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
   phase owns them. The ruling itself is proven live on the Burn-note Sheet
   (a real `Sheet`) and on the preview page.
10. **`docs/UI-INVENTORY.md`** was read and its header says it was written at
   `9755061`; it is stale against the live tree. Not edited in this phase.
