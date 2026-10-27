# The mockup

The one look the whole app wears. The founder drops the anchor image at
`docs/mockup/anchor.png`; this file holds its palette verbatim, and
`src/index.css` bakes the same values into `:root`.

- ground **#000000**
- ground-soft **#0A0A0A**
- panel **#111111**
- panel-strong **#171717**
- panel-alt **#1D1D1D**
- border **rgba(255,255,255,0.08)**
- border-strong **rgba(255,255,255,0.12)**
- ink **#F5F5F5**
- ink-muted **#9CA3AF**
- ink-subtle **#8B93A0**
- accent **#2563EB**
- accent-soft **rgba(37,99,235,0.14)**
- accent-text **#60A5FA** — blue for TEXT and ICONS on dark only; accent #2563EB is for FILLS only, never small text
- accent-ink **#FFFFFF**
- success **#10B981**
- danger **#EF4444**

## Anchor list (docs/mockup/anchor-list.png)

Layout source of truth for every LIST screen. Founder's drop, 2026-10-26:
https://cdn.dribbble.com/userupload/45559651/file/bc4953358afc5d96fe1c46a14ace45dc.png?resize=1024x768&vertical=center
It is a chat list, not a palette — the palette above wins; this section is structure.

- Screen title at the left, a circular search affordance at the right of the same row. The Cipher mark (the Logo component) sits beside every screen title throughout the app — founder's rule: "keep cipher logo present throughout the app by 'chats' and shit like that". The mark is never restyled.
- A full-radius segmented filter directly under the header, three segments, the active one accent-filled.
- List rows, 64px: circular avatar at the left (groups show initials), name and right-aligned time on the top line, one-line preview below, unread badge at the right.
- Live row states, all three: a preview that says a voice note was sent, a typing state in accent-text in place of the preview, and a preview that wraps to two lines. Rows are variable height.
- Times descend. Rows keep 44px minimum taps and must pass tests/ui/safe-area.spec.js.

Cipher mapping: the reference's three segments become All / Groups / Vendors on the chat list.
The sliding drawer stays exactly as it is — the segments are a filter inside a list, not a second navigation.

## Two modes

Exactly TWO modes — one token set, two value sets, one switch (profile or wallet screen). Not a picker.
Dark (above) is default. Light recovers Paper's values from git history (git show 1fea1053^:src/index.css):
ground #F7F5F0 · panel #FFFFFF · panel-alt #F2EFE8 · border rgba(28,27,24,0.10) · ink #1C1B18 · ink-muted #56544E · accent #2563EB.

Directional tokens invert for light or they die there:
- accent-text: #60A5FA dark → #1D4ED8 light (#60A5FA on white is 2.3:1).
- ink-subtle: #8B93A0 dark → #5F6875 light (3.1:1 on white).
- accent, success, danger do not change. White on accent stays 5.2:1 in both.

Guard rule: exactly one light selector in src/index.css and no more — src/lib/palette.test.js enforces it.
No yellow, no brass, no emoji. Copy and words unchanged.
