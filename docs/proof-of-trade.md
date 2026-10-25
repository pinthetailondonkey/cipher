# Proof of trade

Version: 2

A receipt binds one order to one payment. It is not a second confirmation and it does not move money. The chain check is the watcher. The receipt is the record of that check.

## Canonical body

Version 1 is one JSON object, UTF-8, with these keys in this order and no extra whitespace:

| Key | Type | Rule |
|---|---|---|
| `v` | number | Always `1`. |
| `orderId` | string | The order id. |
| `buyer` | string | Buyer Nostr pubkey, 64 lowercase hex characters, x-only. |
| `vendor` | string | Vendor Nostr pubkey, same form. Must differ from `buyer`. |
| `currency` | string | Lowercase. `btc` or `xmr` in this app. |
| `address` | string | The payment address. Not in the public view. |
| `amount` | string | Canonical decimal. `$` and commas are stripped. Leading zeros and trailing fractional zeros are stripped. `2.00` is `2`. `2.50` and `$2.50` are `2.5`. |
| `txid` | string | The transaction the watcher reported. Not in the public view. |
| `at` | number | Unix seconds, a positive integer. Missing, zero, and fractions are rejected. |
| `outcome` | string | The vendor's assertion at the moment of signing: `confirmed`, `rugged`, or `refunded`. Anything else, including `disputed`, becomes `""`. |

`at` and `outcome` are part of version 1. Adding a field later is a new version, not a quiet extension of an old signature.

`outcome` is not a dispute status. It is what the vendor asserts when they sign. A confirmed sale is `confirmed`. A rug or a refund is a new receipt the vendor signs with `rugged` or `refunded`, not an edit of the old bytes. A dispute is a separate order update and, if someone judges it, a separate arbitration statement over the receipt hash. Neither one rewrites `outcome`.

The bytes that are hashed and signed are `JSON.stringify` of that object.

### Version 2 body field: `prior`

Version 2 adds one body field, `prior`: the `hash` of the receipt immediately before this one in the vendor's chain, the empty string for the vendor's first receipt. Each receipt thus chains the hash of its predecessor, and a run of receipts from one vendor forms a hash chain. A break at any link invalidates everything after it.

This field is specified here, not implemented. `src/lib/proofOfTrade.js` still builds only version 1 bodies. The current code does not read, write, or verify `prior`, and version 1 verifier rules still apply byte for byte. When it ships, it changes the canonical body, so it is a body field of version 2 by the rule above: `at` and `outcome` belong to version 1, `prior` belongs to version 2, and no version 1 signature is ever extended to cover it.

## Hash

`hash` is SHA-256 of those bytes, lowercase hex. This is not the BIP-340 tagged hash. It is the id of the receipt.

## Signatures

Each party signs the same canonical bytes with BIP-340 Schnorr (Nostr's signature, as implemented by `@noble/curves` secp256k1). The signature is 64 bytes, lowercase hex.

The signer's public key must equal `buyer` or `vendor` in the body. A third key is rejected. Both signatures are over those exact bytes. A co-signature over a different hash is rejected.

The signed object is:

```json
{
  "v": 1,
  "hash": "<sha256 hex>",
  "body": { },
  "sigs": { "buyer": "<hex>", "vendor": "<hex>" }
}
```

Verification requires all of the following. Any miss fails the receipt:

- `hash` equals SHA-256 of the canonical body.
- `sigs.buyer` verifies under `body.buyer`.
- `sigs.vendor` verifies under `body.vendor`.
- The two public keys differ. A self-trade is rejected. The buyer and the vendor are different keys, so a vendor cannot add their own volume.

One valid signature and one invalid signature is not a receipt. One signature alone is not a receipt. The vendor signs when the watcher confirms. The buyer signs the same body when they have it. Until both are present, `verifyReceipt` is false.

## Privacy

A receipt is private. It travels over the customer chat between the buyer and the vendor, and then it is stored locally only, by both parties. Receipts are never published to relays. No relay, no third party, and no other app user sees a receipt, its hash, its amount, its address, its txid, or either party's role in it.

Both copies are the full signed object. The buyer keeps what they countersigned; the vendor keeps what they signed. The two copies are identical bytes, so either party can prove the receipt later — but only to each other, or to whoever one of them chooses to reveal it to.

## Public trust artifact

The only event about sales that ever leaves the device is a vendor-signed commitment. It contains a count of receipts in the vendor's private hash chain and the hash of the chain head — the chain built by the version 2 `prior` field. It is published periodically, not per sale. A reader can watch the count grow and the head advance, and check that a claimed body of sales is consistent with the chain, without ever seeing a sale.

What a commitment does not contain: amounts, currencies, addresses, txids, buyer keys, receipt hashes in isolation. The receipt body stays on the device. The commitment is evidence that the chain exists and how long it is; the chain itself is the vendor's private record and comes out only on a dispute reveal.

The commitment is vendor-signed and carries no buyer signature — the buyer never signs it, because the buyer is one link the reader cannot single out from it. Verification is: one valid Schnorr signature under the vendor key, over the canonical commitment bytes. Its exact body, like `prior`, is specified from version 2 and not implemented.

## Dispute reveal only

Version 1 had a "public view": a stripped object with `hash`, `amount`, `currency`, `buyer`, and `vendor`, countersigned by both parties, published by default, and a vendor-only signed form before that. Under version 2 that object is private until a dispute needs it. It is never published to relays by default.

The form itself does not change and stays verifiable verbatim:

```json
{
  "v": 1,
  "hash": "<sha256 hex>",
  "amount": "<string>",
  "currency": "<string>",
  "buyer": "<hex>",
  "vendor": "<hex>"
}
```

The vendor signs that object first. The buyer signs the same bytes when the payment arrives. Both signatures sit in `sigs` and are not part of the signed bytes:

```json
{
  "v": 1,
  "hash": "<sha256 hex>",
  "amount": "<string>",
  "currency": "<string>",
  "buyer": "<hex>",
  "vendor": "<hex>",
  "sigs": { "buyer": "<hex>", "vendor": "<hex>" }
}
```

`verifyPublicView` requires both signatures and does not need the private body. A changed amount, currency, or key fails. One valid signature and one invalid signature is not a countersigned view. An object that still carries `address`, `txid`, or `body` is not a public view. A bad amount or a bad time makes verification return false. It does not throw.

A view with only the vendor's signature is legacy. It may carry `sig`, or `sigs.vendor` and no buyer signature. `verifyVendorView` accepts that and nothing else. It is not countersigned.

Volume is summed twice, by the same vendor and currency: once from countersigned views, once from vendor-only views. An unsigned object is in neither. Bitcoin uses 8 decimal places. Monero uses 12. A finer amount is rounded, half up, to that scale. It is not dropped. Under version 2 this summation runs over views the device holds — both copies held locally, and views explicitly revealed to it — never over events fetched from a relay, because relays never carry views.

## Reveal

A dispute sends the signed object, body included, to the party judging the dispute — not to a relay. Anyone presented with it can recompute the hash and check both signatures. The chain head in the public trust artifact lets that party place the receipt in the vendor's chain: hash it with its neighbors and the head matches. The reveal does not by itself change `outcome`. A later statement about the dispute is a separate record, not an edit of these bytes.

## Rules

Every event that leaves the device must pass the court-room rule: safe to read aloud in a court room. The question is not what a reader believes about it, but what the words alone say about the person who sent it.

- Menu events: what the shop sells. Yes.
- Heartbeat pings: presence only, nothing else in them. Yes.
- Vouches: a statement that a vendor is known, by who vouches. Yes.
- Receipts: never public. They name the buyer, the amount, the transaction.
- Amounts: never public, on any event, in any form.
- Buyer keys: never public as part of a payment record. A buyer key in a DM to the vendor it chats with is a DM fact, not a sales fact; it never leaves that DM.
- Payment addresses: never public.
- Txids: never public.

Anything that mixes a buyer with money — a receipt, an amount next to a key, an address, a txid — fails the rule. The public trust artifact is the one sales-shaped event that passes: a count and a hash, no buyer, no amount, no transaction.
