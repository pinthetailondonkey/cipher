# DESIGN.md — Cipher visual system of record

Every coding agent reads this before touching UI. For visuals this
file wins. For repo rules AGENTS.md and CLAUDE.md win.

## Tokens (src/index.css :root)

```
--bg          #000000
--bg-soft     #0b0b0c
--panel       #141416
--panel-strong #1c1c1f
--panel-alt   #26262a
--header      #121214
--bubble-in   #1f1f23
--bubble-out  #005dfd
--border      rgba(255,255,255,0.08)
--border-strong rgba(255,255,255,0.14)
--text        #f5f5f5
--text-muted  #9a9aa3
--text-subtle #8b8b94
--accent      #005dfd
--accent-text #3987ff
--accent-soft rgba(0,93,253,0.16)
```

## Type

System font stack. 11 timestamps only; 12, 13, 15 body; 16 message
text and every input; 20, 28 titles. No other sizes.

## Layout

- Chat rows 72px, avatar 52px, 1px divider inset about 76px.
- Header 56px, solid `--header`, 1px hairline.
- Bubbles: max 78% wide, radius 18, tail corner 6, gaps 2 inside a
  group and 8 between, timestamp inside bottom-right, ticks on
  outgoing, centred day pill.
- Buttons: one solid primary per view; the rest soft or ghost.
- One breakpoint: `lg` = 1024px.

## Components

- **Avatar** — deterministic two-tone gradient, 7 pairs, index =
  `pubkey.charCodeAt(0) % 7`.
- **Hidden preview** — blurred line + one small eye icon; never a
  labelled "Tap to show" pill.
- **Order card** — `SystemCard`, never a bubble.
- **Pinned order bar** — under the thread header.
- **Composer** — floating pill; plus left, mic↔send right.
- **Tab bar** — labels >= 12px, filled active icon, unread badge.

## FOUNDER RULING — centred dialogs (2026-10-29)

Dialogs are **centred everywhere** — not bottom-sheets, no grabber, no
bottom-rise. Do-not-revert without founder sign-off. Rationale: the
founder shipped centred-only modals live (4c2b616) and re-confirmed the
same day that this behaviour stands over the earlier bottom-sheet clause.

Specifics:

- max-width: 420px.
- corner radius: 20.
- scrim colour: `#000000`, opacity 0.6.
- focus trap: on, focus returns to opener on close.
- Esc closes, back (gesture/Android) closes.

## Blue Ridge (reference thread copy)

- "Order #1042 · 40 USD"
- "Payment seen, waiting on confirmations"

These are verbatim reference strings for the single reference thread; the
primary list title remains "Chats".

## Always

Flat layered greys, hairlines, skeletons, press states, 44px targets,
4.5:1 contrast, focus-visible, reduced-motion, inputs at 16px.

## Never

backdrop-blur, glow blobs, neon-*, glass-*, hybrid-*, gradient
backgrounds behind content, cards inside lists, "Tap to show" pills,
more than one solid accent button in view, new hardcoded colours,
radii, z-index values or font sizes, the logo anywhere except the
Chats header.

## Checks

Every phase must satisfy both, or it FAILS closed:

- `tests/ui-contract.spec.js` green.
- Screenshots at 390x844 and 1280x800 into `docs/ui-evidence/<phase>/`.

## Mockup reference

`docs/mockup/approved.png` — the approved render to compare against.
