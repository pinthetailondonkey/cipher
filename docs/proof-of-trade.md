# Proof of trade

Version: 1

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
| `at` | number | Unix seconds, integer, zero or greater. Missing becomes `0`. |
| `outcome` | string | One of `confirmed`, `disputed`, `rugged`, `refunded`. Anything else becomes `""`. |

`at` and `outcome` are part of version 1. Adding a field later is a new version, not a quiet extension of an old signature.

The bytes that are hashed and signed are `JSON.stringify` of that object.

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
- The two public keys differ.

One valid signature and one invalid signature is not a receipt. One signature alone is not a receipt. The vendor signs when the watcher confirms. The buyer signs the same body when they have it. Until both are present, `verifyReceipt` is false.

## Public view

What is published by default:

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

The vendor signs that object with the same BIP-340 key. The signature is a sibling field, `sig`, and is not part of the signed bytes. `verifyPublicView` checks `sig` against `vendor` and does not need the receipt body. A changed amount, currency, or key fails. An object that still carries `address`, `txid`, or `body` is not a public view.

## Reveal

A dispute sends the signed object, body included. Anyone can recompute the hash and check both signatures. The reveal does not by itself change `outcome`. A later statement about the dispute is a separate record, not an edit of these bytes.
