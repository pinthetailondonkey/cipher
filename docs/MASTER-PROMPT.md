# CIPHER UI — TELEGRAM-GRADE REBUILD, SATOSHI-CHROME COLORS, DARK ONLY

You are rebuilding Cipher's UI layer to Telegram/Signal quality. Layouts clone
Telegram's proven patterns; every color, radius and shadow comes from Cipher's
existing token sheet in src/index.css. No theme picker, no light mode: dark
ground #000 with the blue #2563EB accent is the only look (BACKLOG item 15:
the light "Paper" skin is retired; palette.test.js must keep exactly one light
selector — strip it everywhere else).

The product underneath never changes: encrypted DMs (NIP-44 in kind 4), NIP-29
groups with rotating keys, per-order payment addresses, the watcher chain
check, proof-of-trade receipts, escrow (commit 52cbdab), panic wipe.

## 0 · READ-ONLY CONTRACTS — never edit these files' behavior

Logic is frozen. Touch presentation only; when a screen needs a value, add a
pure presentation helper next to the existing lib, never rewire payloads.

- src/hooks/useNIP44DM.js — sendDM, receive, receiptMayBind, gkey install
- src/hooks/useNIP29Group.js + src/lib/crypto/* — keys, membership, epochs
- src/lib/escrowFsm.js, escrowScript.js, escrowPsbt.js, escrowActions.js —
  quote math, script shape, refund-key gate; ESCROW_ORDER_ACTIONS table
- src/features/chat/useCommerce.js — the 11 order actions:
  accept_order, accept_with_escrow, decline_order, cancel_order,
  confirm_payment, check_chain, mark_shipped, confirm_delivery,
  report_issue, mark_refunded, resume_order
- src/lib/orderMembrane.js — decode/dedup/revision/authority/journal
- src/lib/paymentState.js, vendorPayments.js, paymentWatch.js — beats:
  created → address_issued → seen → confirmed; BTC 3 / XMR 10 confirms
- src/lib/proofOfTrade.js — dual-signed receipts; receipt_<orderId>;
  bound_receipt_<orderId> marks what THIS device countersigned
- src/lib/egress.js + egress.test.js — do not add hosts, words, or rows
- src/lib/privacy.js — allowsTyping / allowsLinkPreviews must keep gating
- src/store/chatStore.js — selectors keep their names; you may ADD
  presentation-only selectors, never rename existing ones
- src/lib/haptics.js — keep levels: light taps, medium long-press,
  heavy big-money
- Security copy that must survive verbatim: "Not checked on-chain.",
  "If nothing proves the deal, the whole deposit comes back.",
  "(2.5% + 2.5%)", "Still securing — retry", the S5/S7/F7/N2 refusal toasts

Hard word bans in UI: "Nostr", "relay", "private key", "seed", emoji in labels.
Slang (custy, plug, trap) may flavor EMPTY-STATE and marketing copy only,
never buttons or system text.

## 1 · DESIGN SYSTEM — build these ONCE in src/components/ui/, delete every hand-rolled duplicate

Telegram look: dense rows, one accent color, glassy sheets, springy motion.
Cipher look: near-black ground, charcoal #111/#171717 panels, 1px
rgba(255,255,255,.08) curves, blue only where money or focus lives.

Tokens: use existing CSS variables only (--bg, --panel, --panel-strong,
--panel-alt, --border, --border-strong, --text 245 245 245, --text-muted,
--text-subtle, --accent #2563EB fills, --accent-text #60A5FA text/icons,
--accent-ink #fff, --accent-soft, --success #10B981, --danger #EF4444,
--glow-a/b, glass-panel, glass-header, hover-wash). FORBIDDEN: new hex in JSX
(rip out bg-[#161616] and friends), inline z-[...] literals — replace with
tokens you add: --z-fab 40, --z-sheet 60, --z-call 80, --z-toast 100.

Components (all keyboard-reachable, focus-trapped where modal):
- Button: variants primary(accent fill)/secondary(panel-strong + border)/
  ghost/danger; sizes sm 36/md 44/lg 52; props loading, leadingIcon,
  trailingIcon, fullWidth. Reuse pressable.
- IconButton: 44px min, mandatory aria-label.
- Sheet: THE bottom sheet. rounded-t-[28px], pb-sheet (1.5rem + safe-area),
  drag handle 36×4, backdrop scrim/60, slide-up spring (stiffness 380,
  damping 34), drag-to-dismiss at 120px; on md+ centered max-w-md panel.
  Replaces: action sheet, checkout, storefront, reactors, profile, QR sheet.
- Dialog: centered confirm for destructive + money moments; danger variant.
- Segmented: the three-pill filter (All/Menus/Vendors, Shop/Groups).
- ListRow: 64px min, avatar slot 40, title 15px semibold, subtitle 13px
  inkMuted, meta right (time 11px inkSubtle), trailing badge/kebab slot.
- Badge, Chip (outline variant like the escrow fee chips).
- Skeleton: shimmer (hover-wash → ink/10), Row/List/Grid/OrderCard presets.
- EmptyState: icon in accent-soft circle, title, one line, optional action.
- Toast: top banner queue, role=status, 4s, tap to dismiss; replaces
  ToastBanner + Wallet status pills + setToast duplicate renders.
- Switch: one 44×26 track, accent when on.
- Keypad: 3×4 numeric, 64px keys, haptic light per press, shake row on
  error, biometric checkmark button bottom-left, erase bottom-right.
- Inputs: Input/Textarea/PinField with 12px labels, focus border-accent.
- EscrowTimeline: 5 beats with connector line — states done (success fill),
  current (accent, pulsing dot), future (line); plus EscrowFactBox that
  renders ONLY the "In escrow" panel copy defined in §4.
- Avatar: 40 default; no story-style presence rings — cipher is lean.

Motion library: existing framer-motion. Entrance spring stiffness 420
damping 28; sheets 380/34; haptic('light') on all primary taps.

Type scale (on 15px base): page titles 22/26 bold tracking-tight, row titles
15 semibold, body 14.5, meta 13, micro 11 uppercase tracking-wider.

## 2 · NAVIGATION SHELL

4 tabs (UI-SPEC 2026-10-28, fixed order): Chats | Menus | Orders | Profile —
one set, src/lib/tabs.js, mapped by both navs; md+ rail labels ⌘1–⌘4.
- Mobile (<md): a persistent bottom bar carries the four (badges on Chats
  and Orders only, hidden inside a conversation); the side Drawer is
  overflow navigation (Groups, Connections, Lock now) — anatomy:
  320px panel, glass-header over scroll, profile card top (avatar 56, name,
  @handle, verified icon = reset trust row), sections with lucide icons,
  active pill bg-accent-soft. Keep onNavigate(tab, mode, startView) +
  profileNavNonce.
- Desktop (md+): keep 72px icon rail left, add tooltips + ⌘1/⌘2/⌘3.
- Command palette md+: ⌘K → fuzzy jump to chat/group/screen. Data sources
  EXISTING store lists only (dms keys, groups array, three tab names).
- Deep links keep working: ?g=<groupId>, ?product=&vendor=, ?chat=<pubkey>.
  Boot: resolve handle → openChat('dm', pk) | openChat('group', id) |
  OneTapCheckout(product) after history fetch, exactly current behavior.

## 3 · CHAT LIST (Telegram anatomy, cipher skin)

Header row: logo chip (Cipher logo 20, never restyled) + title "Chats" left;
right: search icon → expands in-place filter field; kebab → New chat / New
group / Burn note (this kebab replaces the FloatingMenu long-press model;
keep FloatingMenu's handlers wired to the same actions in the kebab menu).

Then Segmented: All · Menus · Vendors. Then rows:
- Section PINNED (rows with pinned flag): 48px tall, pin icon 12 inkSubtle
  right of time. Pin toggle lives in the row kebab (chatStore already tracks
  chat-pin pairs; if the pair was removed in cleanup, RE-ADD as pinnedChats
  in scoped storage keyed by chat id; no new relay events).
- Row 64px: avatar 40 (groups initials), name 15 semibold; right: time 11
  inkSubtle (relative: now/Xm/Xh/Mon/Jan 5), below that unread pill badge or
  BellOff 12 if muted. Line 2: preview 13 inkMuted truncated — typing
  indicator replaces preview for 6s ("typing" in accent-text then dots
  animation, Telegram's 3 bouncing dots); vendor chat gets the Shop wordmark
  12 accentText right of preview; group previews carry sender: "Alex: msg".
  Privacy blur stays (blur 5px until long-press reveal).
- Swipe right = pin, swipe left = mute menu (8h / 1d / 1w / forever) — map
  to existing mutedUntil durations (8h/forever/timed set exists in store
  BACKLOG 16.9; wire the durations submenu here and in the kebab).
- Kebab popover (absolute right, 44px items): Mute/Unmute, Pin/Unpin,
  Archive/Unarchive, Vendor: View shop (opens VendorStorefront sheet —
  BACKLOG 16.10 door), Block peer.
- Archived section at bottom collapsible like today.
- Empty: EmptyState "No chats yet — your first message starts the cipher"
  + New chat button.

## 4 · ORDER CARD + ESCROW (the money surface)

Order bubble anatomy (Telegram-attached-card style, 100% bubble width up to
280px inside bubble):
- Image 28:9 crop, title 15 semibold, price line 15 bold accentText with
  currency; badge pill by derived state (derived via orderState()):
  Awaiting payment → Address sent → Marked paid → Shipped → Delivered /
  Cancelled / Refunded / Disputed; felt colors: awaiting amber-soft, address
  accent-soft outline, paid/shipped accent fill, delivered success,
  cancelled ink/15, disputed danger-soft.
- Fee + cash rows when escrow attached: the existing "In escrow" panel text
  exactly: "Price X BTC · deposit Y BTC · fee Z BTC (2.5% + 2.5%)"
  + "{N}-day timer. If nothing proves the deal, the whole deposit comes
  back."
- EscrowTimeline beats (labels + colors): Requested, Accepted (escrow),
  Deposit shown, Watcher confirmed, Released (or Refunded). States come from
  derived order facts only (F7) — never badges written by the peer.
  UNTIL the membrane-reroute commit lands, beats 4/5 render DOT + skeleton
  shimmer, not a fake state word.
- Payment block (existing paidRows merge: direct + escrow): black inset
  panel, "Pay {amount} {currency}" 15 mono bold, QR 120, address 10 mono
  selectable, then an overflow row: Copy address (existing copyText util),
  Share link, Open in wallet: `bitcoin:<uri>` deep link.
- ACTION BUTTONS appended only per role/phase: buyer from paidRows path;
  vendor: Accept (direct) FIRST, then Accept with escrow SECOND — keep
  both, blue-300 tone on the escrow one per current code; then vendor
  actions Confirm payment / Check chain / Mark shipped / Confirm delivery /
  Report issue / Mark refunded / Resume by orderState as today.
- Approve release / Request refund / Admit refund: RENDER DORMANT when the
  phase reaches funded-but-unconfirmed, caption "available once your watcher
  confirms funding", no click — these light up when the membrane reroute
  wires escrow_release/escrow_refund admission; not a moment before.
- "View receipt" → Sheet: body both parties signed, IDs, amount, txid,
  timestamp, outcome, both sigs; verifyReceipt() result banner green/red
  (BACKLOG 16.2; requires NO new hosts).

## 5 · THREAD (DM + GROUP SHARED SHELL)

- Date chips: sticky gooey pill center ("Today", "Yesterday", "Mar 14")
  panel-strong fill, inkMuted text.
- Group sender names: 11px semibold, color = stable hash of pubkey into
  [#60A5FA, sky-300, cyan-300, teal-300 — NO AMBER/YELLOW]. On dark ground
  all options ≥ 4.5:1.
- Bubbles: sent = bg-accent text-accentInk (Telegram blue bubble); received
  = panel + border-line; both 18px radius, tail corner 6px on run end; meta
  pill (time + edited + delivery ticks) inside bottom right 10px — sent
  white/70, read state ✓✓ swaps to the lucide CheckCheck icon.
  "Still securing — retry" retry row under the carrier bubble when stuck
  (existing).
- Reply preview: 2px accent bar + 12px quote + 13px fallback inkMuted strip
  in parents; tapping jumps to the `msg-<id>` anchor with a glow-ring pulse
  2s.
- Context menu (long-press 420ms or right click): Sheet with reaction row
  (7 emojis, existing choices), then icon grid: Reply, Copy, Forward,
  Pin (groups canPin), Edit (own text), Delete (existing), Select (multi).
  Forward opens the peer-picker sheet, then sendDM with the same payload
  shape and a fresh clientId; gkey/order payloads stay unforwardable
  (dmControlAction already filters — respect it).
- Select mode: top bar emerges "N selected — Forward ⋅ Delete ⋅ Cancel";
  bubbles show accent checkmark circle left.
- Scroll-to-bottom FAB 40px above composer with unread count when scrolled
  up >400px. Auto-scroll on own send and when at bottom otherwise.
- Voice notes: rounded pill reply, play/pause circle, scrub bar, waveform
  from sampled amplitude (32 bars, ink/40, accent when played); keep
  MediaAudio under the hood.
- Composer: pill (panel-strong, border-line, 44px) with plus button inside
  left, textarea autogrow to 5 lines; mic sits inside right while the field
  is empty, and swaps mic → paper-plane accent circle 40 when text is
  present. Tap plus → Sheet menu: Photo gallery (existing handleImageUpload),
  Camera (existing QRScanner permission gate), Document (existing audio
  sender), Payment request (order flow start with vendor). Recording state:
  red accent dot pulsing + timer "0:07" + slide-right-to-lock (locks into
  continue-recording, stop button stays) — same logic, re-skinned.
- Draft restore per chat (existing scoped storage draft-group-*).

## 6 · DISCOVER (Shop | Groups segmented stays)

- Segmented pills; hero is a half-screen scroll area → grid of 172px cards.
- Menu card: image 4:5, vendor avatar overlay 24 bottom-left with
  displayName, name 14 semibold 2-line, price mono 13 accentText, Buy
  button ghost pill bottom-right. Card tap → OneTapCheckout Sheet
  (details §4).
- Group card: initials-avatar 40 + name + about 2 lines + member count
  badge; Join button accent sm; joined state switches to ghost "Open".
- Skeleton grid on first load; error state with Retry.
- Empty: "You're early. Be the first menu on Cipher."

## 7 · VENDOR SURFACES

- VendorStorefront: Sheet (not full-screen). Header glass: avatar 44, name,
  vouch count with ShieldCheck; grid 2-col product cards; sticky bottom
  "Message vendor" accent lg full-width.
- VendorDashboard: StatCards Orders / Revenue / Volume by coin; Product
  table reads cipher_cached_products (own pubkey filter — the one-line fix
  BACKLOG 16.5, already pre-approved).
- Vendor mode toggle lives in Profile via existing setIsVendor +
  vendor_setup addresses form (copy intact).

## 8 · GROUP INFO (Telegram's GroupInfo as a Sheet on phone, docked pane at md+)

- Open via chat-header kebab "Group information" (existing) or long avatar
  tap.
- Sheet/dock anatomy: banner none; name 22 bold + member chip; action row
  (Invite link with copy — existing; Add member; Leave). Pending joins
  panel with Approve/Deny (existing pendingJoinsFor + approve/deny logic).
  Members grid 5-up avatars with role chips Admin/Owner; admin taps open
  the member Sheet: Remove, Boss action (existing kick), Vouch row.
- Shared media strip (existing products + attachments), Pinned listing row.

## 9 · PROFILE (the Wallet router gets a skin, not a rewrite)

Keep every setView path; only restyle + group. Three grouped cards, iOS
style: Account (Edit profile → Sheet not page; Accounts switcher; Backup),
Trading (My Orders → list with status chips; Message requests; Start
selling / Vendor; Order settings), Security & Privacy (How to use, Privacy,
Connections — Tor toggle + Proxy + the two paste rows for watcher and push
gateway, waiting on BACKLOG 16.7; Light look REMOVED per BACKLOG 15). Put a
"Danger zone" card with Lock now + Panic wipe behind Dialog with the
existing wipe copy. Avatar tap → upload sheet (existing Blossom signer
path is frozen).

## 10 · LOCK SCREEN

- Unlock: logo 72 top; Keypad component; PIN dots 8; wrong attempt shake +
  "N attempts left before this account is erased" danger microcopy (keep
  the current copy word-for-word); Face ID circle button under keypad
  (existing identity.unlockWithBiometric).
- Modes split to components/onboarding/: Create (handle field), SaveKey
  (12-word grid, tap-to-reveal each word, copy all, share, checkbox gate),
  VerifyKey (the 3 random word indices already generated), SetupProfile,
  Restore, RestoreMnemonic. Reuse identity.* API untouched.
- BYPASSED precheck for username: keep bypassed; toast says handle check
  happens at finalize.

## 11 · TELEMETRY OF FEEL (states)

Every list: Skeleton idle → content | error + Retry | EmptyState. Buttons
inside action rows morph to spinner. Optimistic send: the bubble appears
immediately with sending → queued → sent → read tick states (existing
deliveryStatus). Never block UI on a fetch over 300ms — show a skeleton.

## 12 · ACCESSIBILITY + MOTION FLOOR

44px targets; focus-visible ring accent 2px offset 2 (existing rule);
aria-label on every icon button; role=dialog + aria-modal + Escape + focus
restore on Sheets/Dialogs; prefers-reduced-motion: no springs above 200ms,
no pulse animations; minimum 3:1 contrast for text-muted (current #9ca3af
on #000 = 5.1, keep; grays falling below that get dropped).

## 13 · PERFORMANCE

Keep lazy() route splits. Add content-visibility:auto on bubble rows > 50
in a chat (CSS only, no new deps). No new runtime deps except
@tanstack/react-virtual IF a thread exceeds 500 messages in your own
profiling; skip otherwise and rely on content-visibility.

## 14 · DELIVERY ORDER (one PR each, tests green, push)

1. tokens + z-literal cleanup + palette.test.js dark-only assert
2. ui primitives + Toast unification + delete hand-rolled duplicates
3. shell + command palette + deep-link boot (signature tests persist)
4. ChatList rewrite (§3)
5. Thread shell + bubbles + composer (§5) — DO NOT touch escrow paths here,
   only reskin paidRows rendering
6. Sheet infrastructure + convert all modals (checkout, storefront,
   profile, reactors, QR result, reactions) onto Sheet
7. Shop + Discover grid (§6)
8. Vendor surfaces (§7)
9. GroupInfo (§8)
10. Profile skin + lock keypad (§9–10)
11. Escrow card timeline + dormant buttons (§4) — only when the membrane
    reroute commit exists does anything become clickable
12. Command palette polish + desktop docked group info + final cuts
13. Screenshots.spec: update baselines; add sheet a11y spec; add keypad spec

## 15 · DEFINITION OF DONE

- 0 hex colors in JSX outside index.css; 0 z-[...] literals; 0 duplicate
  toast systems; 0 unwired buttons (grep your diff: every onClick reaches an
  existing store setter, actor hook, or menu action)
- npm run lint · npm test (node --test all suites) · npx playwright test —
  all green; egress.test passes (no host additions)
- All security copy snippets from §0 verbatim; word bans enforced via a NEW
  palette.test.js-style guard test (UI_WORDS_BAN list)
- Every screen passes at 390×844 AND at 1440×900 docked layout

If any contract seam binds — stop, document the conflict in
docs/UI-NOTES.md; do not invent protocol.
