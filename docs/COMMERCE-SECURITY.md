# Commerce security remediation notes

This note records the local safeguards and the boundaries that still require a
separately coordinated product or protocol decision.

## Wallet allocation

Bitcoin order addresses are reserved in the local IndexedDB database
`cipher-commerce-wallet-allocator-v1`. A read/write transaction advances the
descriptor head and writes a unique owner/order reservation before derivation.
An immutable descriptor registration remains after a head is lost, so changing
back to that descriptor cannot initialize it at index 1 again.
The browser Web Locks API serializes settings reads and writes across tabs; the
IndexedDB transaction remains the allocator of record. A retry for the same
account, descriptor and order recovers the same index. Failed derivation or
settings writes do not release an index. Panic wipe deletes this database.

The reservation head survives restoring only the encrypted localStorage
settings. If the settings contain prior allocation history and the head is
missing, new Bitcoin allocation holds with
`WALLET_ALLOCATION_RECOVERY_REQUIRED`. A pristine old settings backup or a
whole-profile/device rollback cannot be distinguished from first-time setup
without a surviving checkpoint. Keep one designated allocation device per
wallet descriptor; do not configure the same xpub for independent allocation
on another device. Cipher has no central allocator or cross-device authority.
Whole-profile rollback and undetected duplicate-device setup remain residual
risks.

The wallet settings encryption key derivation, xpub format, BIP-84 path and
existing order addresses are unchanged. The dormant escrow serializer and
signature checks are repaired, but escrow stays disabled and active funded
scripts are unchanged.

## Reputation evidence

Vouches and reviews remain social history. A receipt hash and party tags are
publisher claims; they do not authenticate a two-party receipt or settlement.
The profile no longer projects those endorsements into a “Trusted Vendor”
badge. No history is deleted or relabeled as a verified settlement. A future
verified-settlement indicator needs a viewer-trusted verifier, a canonical
two-party receipt, and independently verifiable settlement provenance.

## Payment watcher protocol

Watcher v2 uses the child bearer token only to open the request endpoint. A
separate Ed25519 key signs the exact report body, including its key id, request
nonce, payment echo, and signed timestamp. Each account must manually pin the
watcher public key in Connections. V1 and unpinned reports stay on hold; the
client never falls back to token-based report verification. The watcher key
can rotate only with a signature from the currently pinned key and explicit
confirmation. If that key is compromised, remove the pin, verify the
replacement independently from the watcher host, and pin it again; checks
remain on hold during that interval.

Generate an initial key with `npm run watch:keygen`. Keep the printed private
seed only in the watcher environment as `WATCH_SIGNING_PRIVATE_KEY`; never
paste it into Cipher. Pin the printed public key in Connections. Existing
watcher URLs retain their access token as local configuration, but requests
remove it from the URL and send the derived child credential in the
Authorization header. Watcher operators must deploy v2 before reports can
confirm payments; existing payment records remain unchanged.

`npm run boxes` generates and retains missing local access and signing
credentials in `.env`; it does not print the signing seed. `npm run watch:keygen`
prints a one-time private seed for manual setup. The watcher exposes CORS only
to configured exact origins and never enables credentialed CORS.

For a planned rotation, set `WATCH_SIGNING_PRIVATE_KEY` to the currently
pinned seed and run `node scripts/payment-watcher-keygen.mjs --sign-rotation
<replacement-public-key>`. Paste the replacement public key and printed
signature into Connections, then confirm rotation. The watcher allows browser
requests only from `https://www.ciphermessenger.org` by default. For a local
app or another approved deployment, set `WATCH_ALLOWED_ORIGINS` to a
comma-separated list of exact origins (scheme, host, and port); do not use a
wildcard. The watcher never enables credentialed CORS.

## Financial keys and shipping addresses

The retained N secret can reproduce the current per-order escrow financial key
from its public salt. Device revocation does not revoke a key or alter an
already funded script. This work does not migrate key custody, change key
formats, or claim that account rotation recovers unresolved escrow funds.

The order flow saves the shipping address before burning the delivery note.
Burning the note does not remove the saved address from local order state,
archives, or backups. Keep the existing retention behavior. Any future purge
must be opt-in and field-specific, preserve dispute and unfulfilled-order
exceptions, identify every local/export/backup copy, and retain redaction
provenance. No shipping address or payment history was deleted here.

## Verification boundary

The focused buyer/vendor UI fixtures pin a synthetic Ed25519 watcher key and
return v2 reports with the exact nonce, address, currency, and signed time.
The 184-case Playwright suite passed in an isolated snapshot. A separate
operator smoke invokes the documented key generator, writes the key and
synthetic access token to a mode-0600 temporary `.env`, starts the actual
watcher handler against a local synthetic Monero RPC response, pins its public
key, and runs the report through `checkPayment` until the synthetic payment is
confirmed. It also verifies the derived child token is sent in the
Authorization header and is absent from the request URL. The Chromium watcher
test separately exercises allowed and refused origins against a synthetic
local RPC.

A focused app-browser smoke also ran buyer-view and vendor-view payment checks
against the actual local watcher. Both views displayed confirmed; the vendor
view wrote a local receipt and pending signed outbox event. These are seeded
history scenarios with one fixture identity per browser run, not an exchange
between independently authenticated buyer/vendor accounts.

The two-account loopback harness now restores distinct buyer and vendor
accounts, exchanges an order request and address-issued update over the actual
NIP-44/NIP-59 browser path, runs the vendor's `checkPayment` against the signed
local watcher report, then delivers the confirmed update to the buyer. The
local relay accepts all three events and does not see the order title in their
outer events. This is transport and app-path evidence only: the harness sends
the order payload through the DM API rather than clicking the commerce UI or
creating its receipt-ledger entry.

The real-UI loop now closes that last gap: `scripts/commerce-local-relay-ui-loop.mjs`
drives the whole commerce lifecycle through the shipped interface — the buyer
places the order from the real Menus browse and OneTapCheckout sheet, the
vendor accepts from the real order card with a freshly derived per-order
subaddress, the buyer pins the watcher key through the real Connections screen
and checks the chain from the real button, the vendor confirms from its own
button into a vendor-signed receipt and the consumed-txids ledger, the buyer
countersigns, and both devices hold a two-signature receipt that
`proofOfTrade.verifyReceipt` verifies. The local relay's capture shows the
gift-wrapped DM wire exposing no order plaintext (the vendor's kind-30402
menu event carries its own title in the clear by design), and the ledger
spot-check refuses the txid and address for any other order. Evidence:
`test-evidence/commerce-ui-loop-2026-11-11.json`
(schema `cipher-commerce-ui-loop-capture-v1`). Still synthetic: identities,
wallet RPC, transfer and txid; no deployed operator setup, no real chain.

These checks do not use a real wallet daemon or chain transaction and do not
exercise a deployed watcher operator setup. The commerce release gate remains
open for real-chain evidence and operator deployment exercise; the complete
buyer/vendor commerce UI and receipt-ledger path is now exercised end to end
by the real-UI loop above. Retained focused evidence is in
`docs/evidence/commerce-security-operator-20261110.json`; full UI evidence is
in `docs/evidence/commerce-security-ui-20261110.json`; the independent-account
loopback run is recorded in
`docs/evidence/commerce-security-two-account-20261110.json`; the real-UI
closure run is recorded in `test-evidence/commerce-ui-loop-2026-11-11.json`.
