# UI-NOTES

Where the rebuild contracts bind, bind, and how each seam was resolved. Written
by PR13 (the enforcement layer); each entry names the lane that owns the fix.

## Contract seams

### 1. "Exactly one light selector" vs dark-only (PR1 owns the resolution)
BACKLOG item 15 says the light "Paper" skin is retired — no theme picker, no
light mode — yet the standing palette.test.js assert reads "the stylesheet
carries exactly one light selector" (one `[data-theme='light']` block is
REQUIRED today, with `:root` dark as the default). These two rules contradict
once dark-only lands: a dark-only stylesheet has zero per-theme selectors.
Resolution the rebuild settled on: PR1 removes the light value block from
src/index.css entirely AND restores the sharp assert — zero `[data-theme]`
selectors, one default dark look. This file is the paper trail so nobody
"fixes" the assert back to a selector count of one.

### 2. Flat four-layer world (PR1 token work §1, PR13 enforces)
The z tokens are the ONLY layers: `--z-fab 40`, `--z-sheet 60`, `--z-call 80`,
`--z-toast 100` (src/index.css), exposed as Tailwind classes `z-fab`,
`z-sheet`, `z-call`, `z-toast` (tailwind.config.cjs). All literal z values
were collapsed: 999/1000/950/900/980 → z-sheet, camera/call/square-peg tiers →
z-call, chrome+fab+pill tiers → z-fab, toast → z-toast. Consequences, accepted:
- Within a tier (two sheets at once, say), order is decided by DOM/mount
  order, not old literals. Render-order pointers applied for the app shell:
  GlobalDialog renders AFTER CallOverlay so the app-wide confirm still tops
  the call surface (old literals had 1000 > 80).
- Toast (z-toast 100) now sits ABOVE dialogs (z-sheet 60) — the old literal
  ladder had toast at 200 under modals at 999/1000. Toast wins now; that is
  the Telegram behavior the spec asks for.
- Drawer (z-sheet) equals Sheets. Open-drawer-then-open-sheet resolves by DOM
  order; nothing in the boot flow opens both today.
- Inner `relative z-10` stackers inside full-screen-glow overlays were dropped
  (they sat above only the glow div, same same in DOM order); sticky chrome
  inside sheets took z-fab, which only competes within its own context.

### 3. Word-ban scan is start-of-string anchored — known open strings
The guard (`src/lib/uiWords.test.js`) bans `"Nostr"`, `"nostr:"`, `"relay"`,
`"private key"`, `"seed"` where they OPEN a string or a JSX text node. That
leaves mid-string words out of scope by design (a noisy guard fails the build
on live wire data and gets deleted). Strings that still carry a banned word
mid-sentence, deliberately NOT touched here, for the owner to rule on:
- src/Wallet.jsx (~line 384): "Never enter a seed phrase or spending key."
- src/Wallet.jsx (~line 410): "Never enter a seed or a spend key."
- src/components/chat/Connections.jsx (~line 89): "The relay rows that used
  to live here are gone. The app talks to its own hosts, and the defaults
  hold."
- src/Wallet.jsx (~line 244): "No relay accepted the profile" (error copy).
- src/components/chat/ProfileEditor.jsx (~line 50): same shape.
PR13 fixed all matches the scan finds live: `'Relay timeout'` Throw strings in
src/Shop.jsx and src/Discover.jsx are now `'Network timeout'` (they match the
scan's quote anchor; they surface in console diagnostics only).

### 4. Wire-format exemptions in the word scan
Pinned by explicit, commented exemptions in the guard, not by edits to code:
- src/lib/egress.js and the §0 read-only contracts: hosts registry, relay tag
  arrays, kind names — internal protocol words, never pressed by a person.
- src/hooks/useIdentity.js (outside the §0 list, but the identity/restore
  contract; §10 "identity.* API untouched"): event tags and passkey wire
  strings only.
- src/lib/mediaCrypto.js (the Blossom upload `Authorization: Nostr …` header)
  carries a one-line `not UI copy` marker comment the guard honors.
- Module specifiers (`nostr-tools`, `nostr-passkey`, `@nostr-wot/blossom`)
  are filtered out as imports.

### 5. Emoji floor (PR13)
The scan (src/components/** + src/*.jsx strings) found three emoji hits on
arrival: the ✓/✓✓ delivery ticks in src/components/MessageBubble.jsx (now the
lucide Check / CheckCheck icons, per §5 of the spec), the reaction choice list
in the same file (exempt: the 7 reactions are content, not labels — excluded
on the REACTION choices line), and a ✓ in a source comment (exempt: comments
speak to devs, not users).

### 6. Keypad on the lock screen (PR10 re-dresses §10)
One §10 feature was already reachable at boot with no data — the keypad —
so PR13 ships it as a floor: src/components/ui/Keypad.jsx (3×4, 64px keys,
haptic light per press, eraser, optional biometric checkmark, 8 PIN dots)
wired into src/LockScreen.jsx feeding the same `pin` state as the typed
field. The password field stays for keyboard access. PR10's lock rebuild may
take over styling and the shake-row; the component contract here is: what
counts is 8 dots and digit/erase behavior.

### 7. Dialog a11y floor (PR6-7's later Sheet supersedes)
src/components/ui/dialogA11y.js mounts Escape-close + focus-return on the
dialog surfaces reachable from the boot flow (Tutorial, QR scanner,
Notifications, Saved, New group, My profile, peer Profile, GlobalDialog).
Surfaces only reachable with data (OneTapCheckout, VendorStorefront,
Broadcast, Product edit, Dead drop, Group info, per-bubble menus) still carry
role=dialog/aria-modal where they have it; they land on PR6-7's Sheet
component and its assertions.

### 8. tests/ui/screenshots.spec.js is parked pending the one-and-done merge
The parallel rebuild re-skins every screen, so pixel baselines taken today
would misfire at the merge. describe.skip with a TODO referencing that merge;
re-enable when the shell lands.
