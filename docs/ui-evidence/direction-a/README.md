# Direction A receipts — clean tree at cf275e7 (2026-11-05)

The screenshots `docs/DESIGN.md` asks a phase to leave behind, at both widths:
390x844 (phone ring) and 1280x800 (desktop ring). Taken from a local UI-test
build of a working tree at `cf275e7` that recorded `dirty=false`, so these are
pixels of a commit and nothing else. No relay reached, no real key anywhere.

An earlier set was built at `3f4a854` and committed in `645a878`. Eleven of
these twelve files are byte-identical to that set. The two that moved are the
thread pair, and only their clock did: the synthetic message's relative time,
a 243x232 patch at phone width and 243 pixels at desktop width. Between the
two trees landed a group-key grant, the membership memo, three commits on the
kind-0 record the boot reads, and the vendor-bulletin rework — none of which
draws these six screens, which is why the Menus pair did not shift under it.

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

then copied out of `test-results/` under these names. The phone ring is the
`iphone` project: 390x844 CSS, deviceScaleFactor 3 (so the files are
1170x2532), iPhone user agent, touch. The desktop ring overrides the viewport
to 1280x800 and drops the phone flags, so it is a real desktop context at 1x.
Both rings open the harness's own vault first — a literal pre-generated
envelope whose secret is 32 bytes of 0xAA under PIN 13572468, so the pictures
show an account with no key material behind it.

Not in these receipts: an order card in the thread (covered by
`tests/ui/order-card.spec.js`), the Groups list, the QR scanner, and the
installed-PWA geometry (covered by the `pwa-standalone-*` specs, which assert
the safe-area maths rather than photograph it). The raw per-run captures stay
in `test-results/`, which is gitignored; this folder is the copy that travels.

## The checks that stood behind them

Run on or after this tree, in this sitting. The browser suite is 175 tests in
31 files; every one of those 31 files has a green run here, taken in batches
sized to fit the ten-minute tool budget (`tests/ui/tools/ui-files.sh`), because
every spec seeds the fixture vault and pays a real PBKDF2 derivation at its
gate.

- `npm run lint` — 0 errors.
- `npm test` — 1010 tests, 1006 pass, 0 fail, 4 skipped (14m).
- `tests/ui/ui-contract.spec.js` — 31 passed, and `tests/ui/sheet-a11y.spec.js`
  — 10 passed, in one 41-test batch.
- The rest of the suite, batched by hand: the boot, profile and account-switch
  files re-run after the commits that touch the boot's kind-0 read, and the
  `devicePrf` pair (`devicePrf.spec.js`, `account-switch.devicePrf.spec.js`)
  run under `--project=chromium`, which the file slices do not select — they
  default to the `iphone` project, whose `testIgnore` drops both.

The one naming wrinkle worth knowing: `--` in `npx playwright test -- <files>`
swallows the file filter, so the batches pass the paths without a separator and
let the project's own `testMatch` sort them.
