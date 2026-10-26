# Payment guards

Six WARN findings from the payment-path audit (read-only, 2026-10-25, main @ d1e7406).
No BLOCKER: nothing shipped confirms a wrong amount or emits the payment path out
of order. Each finding below is a trust edge that rests on a contract the code
does not itself enforce. One item each, with its file:line and the fix shape.

## 1. Peer-asserted paymentState is adopted with no transition validation

The receiving side takes any `paymentState` an order_update carries.
`orderState` takes the newest order_update carrying any paymentState and
`mergeStoredMessage` overlays it, so a crafted order_update can display
`confirmed` or `seen` on the wire — or regress the state — without watcher
evidence, and can hide the vendor's chain-check button. Display and state
trust edge only; it cannot sign a receipt.

Fix shape: validate the peer's paymentState on receive against the same
finite-state table the emitting side already uses. An update that jumps,
regresses, or names an unknown state is ignored, not overlaid.

- src/lib/orderActions.js:29-33
- src/lib/messageMerge.js:9-16
- display src/components/MessageBubble.jsx:37

## 2. Confirmed pill requires watcher evidence

The buyer's "Confirmed" pill keys off `paymentState === 'confirmed'` alone.
Unlike the `seen` pill and the "Not checked on-chain." note, it does not
require `paymentSeenBy === 'watcher'` or a signed receipt, so a
vendor-reported confirmation shows as confirmed without receipt evidence.

Fix shape: the confirmed pill gates on watcher evidence the same way the seen
pill does — `paymentSeenBy === 'watcher'` or a signed receipt, never a bare
vendor assertion.

- src/components/MessageBubble.jsx:37 (contrast :42, :63-64)

## 3. Seen requires mempool-blind watcher proof

The `'seen'` transition has no `confirmations >= 1` check in the app: any
watcher reply bearing a txid and not `pending` moves address_issued → seen.
For BTC, mined-ness rests entirely on the bundled watcher scanning
scantxoutset (structurally mempool-blind); a different watcher could mark BTC
seen from the mempool. XMR seen can fire from the mempool (`pool: true`),
which the 10-confirmation rule covers.

Fix shape: the app requires `confirmations >= 1` on the watcher report before
it moves a BTC order to seen, so mined-ness is checked in the app and not
left to whichever watcher is pointed at it.

- src/lib/paymentState.js:111
- src/lib/paymentWatch.js:159-164
- structurally safe source scripts/payment-watcher.mjs:82-90

## 4. Scale is asserted by contract, not checked on arrival

`amountCovers` treats any plain decimal string as whole coins with no
magnitude bound, so a custom watcher that reported atomic units
("500000000000") would read as 500-billion XMR and cover any order. The
bundled watcher is safe (it emits coin-amount strings), so no wrong amount is
confirmable as shipped.

Fix shape: check the scale at ingest — bound the magnitude against the
order's coin and the asset's decimal places (BTC 8, XMR 12) before the value
is trusted, so an atomic-unit string is rejected, not read as whole coins.

- src/lib/paymentState.js:66-67,89
- src/lib/paymentWatch.js:165

## 5. The app's fetch path never uses parseExactAmounts

`checkPayment` parses the watcher reply with `response.json()`; a numeric
amount above 2^53 is silently rounded (9007199254740993 → 9007199254740992).
The quoting guard `parseExactAmounts` exists but is used only inside the
watcher process and the tests — the app's fetch path never uses it. Same
contract dependence as the scale finding.

Fix shape: wire `parseExactAmounts` into the app's fetch path so the amount
is read as an exact decimal string, never through a float.

- src/lib/paymentWatch.js:152
- guard exists but unused app-side src/lib/paymentWatch.js:75-77

## 6. XMR dashboard revenue sums as float

Monero dashboard revenue renders a float sum built with `Number()` and shows
`toFixed(6)` — Monero is 12 dp and the project rule is never drop; float
accumulation can also mis-sum large totals. Display-only, not on the
confirmation path.

Fix shape: sum piconero as BigInt and shift to the coin string only at
render, so the total is exact and shows all 12 decimals.

- src/components/chat/VendorDashboard.jsx:47
- accumulation src/hooks/useVendorStats.js:32-35
