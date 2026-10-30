# DESIGN.md — Cipher visual system of record

Every coding agent reads this before touching UI. For visuals this
file wins. For repo rules AGENTS.md and CLAUDE.md win.

## Tokens (src/index.css :root)

The palette below is the telegram pass (2026-10-30) and replaces the earlier
block wholesale: the old values had drifted from the stylesheet and no longer
described what ships. Every value here is a copy of `src/index.css`; where the
two disagree, the stylesheet wins and this block is the bug.

```
--bg             #000000
--bg-soft        #05070a
--panel          #0d1116
--panel-strong   #12161d
--panel-alt      #1b2028
--header         #000000
--border         rgba(255,255,255,0.08)
--border-strong  rgba(255,255,255,0.14)
--text           #f2f4f7
--text-rgb       242 244 247
--text-muted     #98a1ac
--text-subtle    #767f8c
--accent         #005dfd
--accent-text    #7fb0ff
--accent-soft    rgba(0,93,253,0.16)
--accent-ink     #ffffff
--bubble-out-a   #1358e8
--bubble-out-b   #003a9e
--online         #10b981
--row-active     rgba(0,93,253,0.14)
--col            30rem
--gutter         1rem
```

Still defined and unchanged: `--bubble-in`, `--bubble-out`, `--success`,
`--danger`, `--scrim-rgb`, `--hover-wash`, `--glow-a`, `--glow-b`, and the
safe-area and layer tokens. `--glow-a` and `--glow-b` are `transparent` on
purpose: screens outside this pass still draw inline gradients from them, and
transparent makes those blobs vanish without editing those files.

## Type

11 timestamps, 12 meta, 13 secondary, 14 inline glyph, 15 body and
empty-state copy, 16 message text and every input, 17 row name, 20 title,
28 screen title. `text-[10px]` is retired (2026-10-30); `text-[11px]`
survives for timestamps only.

## Layout

One column, never two. `--col` is 30rem and `--gutter` is 1rem: a 420px
dialog plus two gutters still fits inside the column with slack.

- The column is `div.col-w.mx-auto` inside `main`. No pane wrapper sets a
  max-width (2026-10-30: the nested `max-w-md mx-auto` wrappers are deleted).
  Bubbles, images, avatars and dialogs still may.
- `main` is a grid: `auto minmax(0,1fr) auto` with the bar, and
  `auto minmax(0,1fr)` when the bar is hidden. Header row, scroll row, bar
  row. The bar is a row, never an overlay.
- Scroll roots carry `scroll-padding-bottom: calc(var(--bar-h) + var(--sab))`;
  their parents no longer pad for the bar.
- Chat rows 72px, avatar 52px, divider inset 76px. The active row takes
  `--row-active` and a 2px `--accent` left bar.
- Buttons: one solid primary per view; the rest soft or ghost.
- One breakpoint: **md = 768px** (superseded 2026-10-30: this file said
  "lg = 1024px", which contradicts the code, which uses `md:` throughout).
  The Rail and the bottom bar swap at that width.

## Header

56px, `--header`, 1px hairline bottom, `grid-cols-[44px_1fr_44px]`. Slot 1 is
back or menu, slot 3 is the action or empty, and both slots are always
reserved; the title is centred within the column. The thread is the one
exception: back, 36px avatar, name and last-seen, left-aligned. The logo
appears in the Chats header only.

## Bubbles

Max 78% wide, radius 18, tail corner 6, gaps 2 inside a group and 8 between,
centred day pill. Outgoing bubbles run `--bubble-out-a → --bubble-out-b`, the
one permitted gradient; incoming bubbles are `--panel-alt`. Ticks on outgoing
only, meta inside bottom-right.

## Components

- **ChatRow** (2026-10-30) — the only list row. 72px, `px-[var(--gutter)]`,
  avatar 52, name 17/600, vetted check 14 `--accent-text`, preview 15
  `--text-muted`, `You:` at `--text-subtle`, time 12, unread pill 20
  `--accent`, divider `pl-[76px]`. Active: `--row-active` plus a 2px
  `--accent` left bar.
- **FolderRail** (2026-10-30) — 32px pills, radius 8, active `--accent-soft`
  ground with `--accent-text`. All chats, Direct, Groups, Orders. Filters
  locally; nothing is persisted.
- **EmptyState** (2026-10-30) — icon 28 at `--text-subtle`, title 15/600,
  body 13 `--text-muted`, at most one optional primary action, no card.
  Screens do not hand-roll an empty state.
- **Segmented** (2026-10-30) — 32px segments, radius 8, track
  `--panel-strong`, active `--accent`. No screen hand-rolls a tablist.
- **Compose FAB** (2026-10-30) — 50px `--accent`,
  `calc(var(--bar-h) + 1.5rem)` from the bottom, `--gutter` from the right,
  hidden with the keyboard.
- **Avatar** — deterministic two-tone gradient, 7 pairs, index =
  `pubkey.charCodeAt(0) % 7`.
- **Hidden preview** — blurred line + one small eye icon; never a
  labelled "Tap to show" pill.
- **Order card** — `SystemCard`, never a bubble.
- **Pinned order bar** — under the thread header.
- **Composer** — floating pill, `--panel-strong` field, attach left, and the
  mic becomes an `--accent` send circle once there is input.
- **Tab bar** — labels >= 12px, unread badge. Active state is 2.4 stroke at
  `--accent-text` (2026-10-30: this replaces "filled active icon" — a fill
  collapses a thin glyph, so only MessageSquare and User may fill).

## FOUNDER RULING — centred dialogs (2026-10-29)

Dialogs are **centred everywhere** — not bottom-sheets, no grabber, no
bottom-rise. Do-not-revert without founder sign-off. Rationale: the
founder shipped centred-only modals live (4c2b616) and re-confirmed the
same day that this behaviour stands over the earlier bottom-sheet clause.

Specifics:

- max-width: `min(420px, calc(var(--col) - 2 * var(--gutter)))` (2026-10-30:
  the 420px cap still binds; on a narrow phone the column wins). This is the
  `panel-w` utility.
- corner radius: 20.
- scrim colour: `#000000`, opacity 0.6.
- focus trap: on, focus returns to opener on close.
- Esc closes, back (gesture/Android) closes.
- Still centred everywhere; the "only a panel that asks for it is capped"
  rule (`data-centred`) is a geometry scoping, not a change of behaviour.

## Unchanged by this pass (2026-10-30)

These are named so nobody re-opens them while the layout moves:

- The centred-dialog ruling above, including its trap and focus restore.
- Avatar's deterministic 7-pair gradient and its `% 7` index.
- The hidden-preview rule: blurred line plus one small eye icon.
- `SystemCard` for order cards, never a bubble.
- The pinned order bar under the thread header.
- The logo in the Chats header only.

## Blue Ridge (reference thread copy)

- "Order #1042 · 40 USD"
- "Payment seen, waiting on confirmations"

These are verbatim reference strings for the single reference thread; the
primary list title remains "Chats".

## Always

Flat layered greys, hairlines, skeletons, press states, 44px targets,
4.5:1 contrast, focus-visible, reduced-motion, inputs at 16px.

## Never

backdrop-blur, glow blobs, `neon-*`, `glass-*`, `hybrid-*`, gradient
backgrounds behind content, cards inside lists, "Tap to show" pills,
more than one solid accent button in view, new hardcoded colours,
radii, z-index values or font sizes, the logo anywhere except the
Chats header.

Four of those carry a stated exception (2026-10-30):

- blur, glass and glow stay banned this pass. What exists stays **defined and
  unused** — the `.glass-panel` and `.glass-header` rules, and the `--glow-a`
  and `--glow-b` tokens, both `transparent` — so a component that still
  references one degrades to nothing instead of reversing the ban.
  `.neon-*` and `.hybrid-*` do not exist in the tree and are not to be
  created (2026-10-30: checked, zero hits).
- "gradient backgrounds behind content" — except outgoing bubbles and
  avatars.
- "cards inside lists" — except a vendor's post cards on Menus.
- "more than one solid accent button in view" — except unread pills, which
  are badges rather than buttons.

## Checks

Every phase must satisfy all of these, or it FAILS closed:

- The contract spec under `tests/ui/` is green — `tests/ui/ui-contract.spec.js`
  (superseded 2026-10-30: this file named `tests/ui-contract.spec.js`, a path
  that does not exist).
- `npm run lint` and `npm test` are clean.
- Screenshots at 390x844 and 1280x800 into `docs/ui-evidence/<phase>/`.

## Mockup reference

`docs/mockup/anchor.png` — the anchor render this palette is sampled from.
`docs/mockup/anchor-list.png` — the founder's list-screen layout drop.
`docs/mockup/README.md` — the palette block in full and what each image governs.

`docs/ui-evidence/telegram-pass/` holds this pass's screenshots at 390x844 and
1280x800. The anchor PNGs above predate the pass: they are history, not a
target, and where they disagree with this file the file wins.
