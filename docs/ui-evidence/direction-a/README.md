# Direction A receipts — tree at 1874260 (2026-11-05)

The screenshots `docs/DESIGN.md` asks a phase to leave behind, at both widths:
390x844 (phone ring) and 1280x800 (desktop ring). Taken from a local UI-test
build of `1874260`, no relay reached, no real key anywhere. The commits after
that one are documentation only, so far, so the app source these pictures show
current one.

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
  Orders row.
- `seeded-settings-*` — You > Privacy.
- `seeded-onboarding-*` — the first screen a new device shows, with no vault
  and no session.

How they were made, and what the pixels are:

    CIPHER_DESKTOP_BUILD=1 npx playwright test tests/ui/screenshots.spec.js

The phone ring is the `iphone` project: 390x844 CSS, deviceScaleFactor 3 (so
the files are 1170x2532), iPhone user agent, touch. The desktop ring overrides
the viewport to 1280x800 and drops the phone flags, so it is a real desktop
context at 1x. Both rings open the harness's own vault first — a literal
pre-generated envelope whose secret is 32 bytes of 0xAA under PIN 13572468, so
the pictures show an account with no key material behind it.

Not in these receipts: an order card in the thread (covered by
`tests/ui/order-card.spec.js`), the Groups list, the QR scanner, and the
installed-PWA geometry (covered by the `pwa-standalone-*` specs, which assert
the safe-area maths rather than photograph it). The raw per-run captures stay
in `test-results/`, which is gitignored; this folder is the copy that travels.
