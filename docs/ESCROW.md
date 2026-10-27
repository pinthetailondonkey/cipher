# Escrow — the 2-of-2 design (draft, feat/escrow-2of2)

One optional layer for direct deals: money neither side can walk away
with alone, and no human in the middle. Direct deals keep working exactly
as they do today — escrow is chosen per order, never defaulted on.

## In plain words (founder-first)

Two locks on one box. You each hold one key. The money only moves when
both of you turn your keys at once — or when a timer runs out, and the
buyer's own key gets it back alone. Cipher never holds a key. If the
deal settles, **the buyer pays 2.5% and the vendor pays 2.5%** (the 5%
escrow fee, split). If the deal dies on the timer, **nobody pays
anything** — every satoshi goes home.

## Locked decisions (founder, 2026-10-26)

- Escrow is **optional**. Direct deal is the default and stays free forever.
- **BTC-only, 2-of-2, refund timelock. Never 2-of-3.** Monero cannot do
  this soundly; multisig judgment is parked permanently.
- Fee: **5% total, split 2.5% buyer / 2.5% vendor**, charged once at
  successful release. Timeout or refunded deal: **no fee at all.**
- No centralized judgment. Disagreements resolve with the deal engine's
  adjudication, or not at all.
- Non-custodial, always: the user's vault derives per-order keys. The app
  never holds, never transmits, never touches someone else's coins.

## The one script (the whole product)

A single-address 2-of-2 purchase script per order, assembled from keys
derived fresh for that order (same philosophy as per-order addresses):

```
OP_IF                                  release branch (needs BOTH keys)
  <vendor_pub>  OP_CHECKSIGVERIFY
  <buyer_pub>   OP_CHECKSIG
OP_ELSE                                refund branch (needs TIME + buyer only)
  <delay>       OP_CSV  OP_DROP
  <buyer_pub>   OP_CHECKSIG
OP_ENDIF
```

- **Release**: buyer and vendor each sign once. One transaction sends
  the money where it belongs. Cipher's fee rides the same transaction —
  no invoice, no collection step.
- **Refund**: after `delay`, the buyer signs alone. The vendor cannot
  block it, cannot slow it, does not have to be online. Default
  `delay`: **20 days** (about 2880 blocks); tunable per order before
  funding, shown on the card, never tunable after.

Nothing else. No arbiter key, no recovery key, no "support" backdoor.
The absence is the product.

## The money math (all satoshis, integer math only)

Order price `P`, fee 5% of `P`. Buyer fee share `bf = P·0.025`, vendor
fee share `vf = P·0.025`.

| Path | Who pays | Who gets what |
|---|---|---|
| **Fund** | Buyer deposits `P + bf` into the 2-of-2 | (sits there, nobody's) |
| **Release** (both keys, co-signed tx) | — | vendor gets `P − vf`; Cipher gets `bf + vf` (= 5% total). Buyer's leftover change returns to buyer's wallet in the same tx |
| **Timeout refund** (buyer key alone, after delay) | nobody | buyer gets back `P + bf` — everything |
| **Admitted refund** (both keys, co-signed refund tx) | nobody | buyer gets back `P + bf`; vendor admits early rather than waiting out the clock |

Why the split works without trust: the buyer's half is deposited
upfront and goes home on failure; the vendor's half is paid out of their
own settlement at the end. Nobody fronts the other's fee, nobody can
short it — the rulebook is the script, and both sides can decode the
funding transaction before signing it.

- Rounding: **round half up, never drop** — the fee split uses exact
  integer sats; if `P·0.025` has a remainder, the odd sat goes to the
  fee output, never vanishes and never goes to a party silently.
- Dust: BTC refuses outputs below dust. Escrow fees under the dust
  floor can't ride the transaction, so escrow orders carry a minimum
  price (fee share ≥ 1000 sats ⇒ order ≥ 40,000 sats ≈ $40-ish at this
  writing). The card shows the rule before escrow is offered, never
  after money moves.
- Whale deals: 5% of a huge order gets big. Open founder decision —
  cap the fee (e.g. max fee $250) or keep pure 5%. Not settled here;
  the script doesn't care either way.
- Time-to-live in blocks: `delay` counts blocks, so an attacker's clock
  fraud changes nothing.

## How it walks through Cipher's own door

Escrow facts are order facts, and every order fact already walks one
admission door (feat/stm-order-membrane, verified: 11/11 attack tests).
Four new ops, same table of who-may-say-what:

| Op | Principal | Allowed only when |
|---|---|---|
| `escrow_open` | vendor | status `pending`; fixes P, the 2-of-2 address, both per-order pubkeys, the delay, the fee quote |
| `escrow_fund` | watcher | reports the *funding* txid seen/confirmed on chain — the payment beats continue (created → address_issued → **escrow_funded** → seen → confirmed) |
| `escrow_release` | watcher | reports the *release* txid: vendor paid, fee paid. Mirrors the order `paid → completed` beats |
| `escrow_refund` | watcher | reports either the admitted refund (both keys co-signed) or the timeout refund (timelock elapsed) → order to `refunded` |

The beats stay a straight walk, nothing skips, and the membrane's
existing guarantees hold unchanged: replayed watcher reports are
idempotent, forged facts are refused by authority, a tampered journal
tail is dropped, and every statement survives reload because the
journal is durable. The watcher's existing signed-and-fresh rule covers
every escrow report exactly as it covers payment reports today.

PSBTs (the unsigned transaction drafts both sides pass through the chat)
are themselves journaled facts — an escrow PSBT is an artifact the
membrane stores with a digest, so a forged or replayed PSBT is a
surfaced conflict, not a silent swap.

## Where it fits in the app (no new screens)

Everything lives in the order card in the chat — the chat is the deal:

1. **Vendor's accept flow gains one honest option**: "Accept with
   escrow" — it builds the 2-of-2 address, quotes the fee split, sends
   the card. Direct-deal "Accept" stays the first and default button.
2. **Buyer's card shows it before any money moves**: item, price,
   `(2.5%)`, `(2.5%)`, "your keys, their keys, 20-day timer" — and the
   plain sentence **"Math refunds you if nothing proves the deal."**
3. **Pay with escrow** opens the buyer's wallet, funds the 2-of-2 in
   one tap. From here the payment beats read like any order: seen,
   confirmed.
4. **Ship / deliver** as today. **Approve release** is buyer's one tap;
   the vendor's half-signature is already waiting. Coins move, fee
   moves, receipt signs, both cards flip to completed.
5. **Not delivered?** Buyer taps **Request refund**: vendor can admit
   (one tap, both sign, everyone whole), or the timer does it alone on
   day 20 — vendor offline, keys lost, app uninstalled, whatever: the
   chain refunds.
6. **Show proof gets richer for free**: every escrow state shows the
   txid, both signatures, and the script's branch — the evidence chain
   the founder already approved, one layer deeper.

Persistence and durability ride existing rails: escrow state in the
membrane journal, PSBTs and raw transactions in scoped storage next to
receipts, keys derived from the vault the app already guards.

## What is deliberately NOT here

- **XMR escrow** — cannot be done soundly as 2-of-2; parked by decision.
- **Witnesses** — future attestation layer, parked; peer-run only,
  decentralized, engine-adjudicated.
- **Cipher holding keys, ever, for any duration, for any reason.**
- **Any fee on timeout, refund, dispute, or direct deal.**

## Foil-hat corner (the honest limits)

- The **app assembling both signatures is a convenience, not a
  requirement** — raw PSBTs work in any wallet; that's the user's
  escape hatch and our proof of non-custody.
- Timestamps on escrow facts are self-claimed by the watchers, bounded
  by the same limits the deal engine already documents — the refund
  clock is the chain's, not the app's, so nothing there is forgeable.
- **Before strangers' money moves, one legal consult** on crypto fee
  handling — one hour, protects the whole lane. The design (user-held
  keys, fee as a service charge riding a user-authorized transaction)
  is written to be the safe kind; the hour makes it documented.
- New dependency warning: building PSBTs genuinely needs raw
  transaction capability — if bitcoinjs-lib (or similar) becomes the
  justified dependency, the commit says exactly that and why.

## Build order (one change per commit, gates green, pushed)

1. `escrow-fsm`: pure state machine + fee/rounding math + tests
   (`src/lib/escrow.js` + `escrow.test.js`) — every path in the money
   table above, unit-crossing edge cases included.
2. `escrow-script`: 2-of-2 script assembly/decode + per-order key
   derivation + tests (the dependency decision lives here).
3. `escrow-membrane`: the four ops behind the existing door + tests.
4. `escrow-psbt`: fund/draft-refund/release PSBT plumbing + tests.
5. `escrow-ui`: accept-with-escrow card, buyer pay, approve release,
   request refund — the chat IS the escrow.
6. Re-attack round before merge (standing ritual): a skeptical agent
   gets the keys to steps 1–5 and tries to steal money; every confirmed
   hole gets a pinning test.

Nothing on main until the founder reviews. Deal engine wiring
(resolutions → release/refund/overturn) comes after the FSM stands
alone, at the PoT v2 merge point.
