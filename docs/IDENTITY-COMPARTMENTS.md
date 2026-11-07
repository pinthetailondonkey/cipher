# Identity compartments — R4 findings and migration boundary

Status: R4 audit and wire-level evidence harness. This records current behavior
and intentional public identity joins. It does not claim that DM, merchant, or
device identities are fully separated, and it does not change production wire
formats. Evidence is pinned to the source in this commit.

## Identity map

| Compartment | Current identifier and owner | What a relay can link | Rotation and compatibility |
| --- | --- | --- | --- |
| Main Nostr account | Account secp256k1 key in the account vault | Public profile, NIP-65 relay list, ordinary Nostr activity, and recipient address on inbound DM fetches | Existing account recovery restores this key. Changing it is a public identity migration and cannot erase old events. |
| DM routing | The account pubkey is the NIP-44 recipient and the kind-1059 `p` address; outgoing wrap author is a random one-use key | The DM relay can associate the recipient account with the device's IP and traffic. It does not learn the sender account from the outgoing wrap itself. The incoming subscription filter also names the account key. | Legacy kind-4 history still depends on account-key filters. A separate address needs authenticated contact discovery, key rotation, legacy reads, and recovery before replacing this route. |
| Group actor | `HKDF(account secret, cipher-gid:<gid>, cipher-group-authority-key-v1)` | The group relay sees the group-local actor, not the account key. Different group ids produce different actor keys. It can still correlate the actor's actions within that group. | Actor is deterministic from the account key and gid. Losing or rotating the account key changes the derived actor unless the old key remains available. Existing invites, authority pins, governance rows, and relay history bind to this actor. |
| Merchant/storefront | Main account key signs the public card and marketplace events | The group relay that hosts the public vendor card can directly join the merchant account key with group traffic on that relay. Other public trade and review records also use Nostr account identity. | This linkage is a product-visible public identity today. Changing it requires migrating listings, orders, reviews, receipts, buyer trust, and existing links; no silent key substitution is safe. |
| Device | R2 creates an independent device signing key and a random device id | The local signed registry maps the account key to device key and id. It is not published by current code. Publishing it to an ordinary relay would expose the account↔device relationship. | A lost device key is not recoverable from the account phrase. Revocation freshness and private peer distribution are not yet solved. Device credentials are not yet used by live DM or group transport. |

## Wire evidence and tested guarantees

`src/lib/identityCompartments.test.js` executes the real Nostr signing, group
actor derivation, NIP-59 sealing/wrapping, vendor-card builder, and R2 device
registry builder. It establishes four facts:

1. Two group ids produce different signed event authors, and the account key
   does not appear in those group events.
2. An outgoing kind-1059 relay event has a throwaway author and the recipient
   `p` address; the sender account key is absent from the outer event.
3. The current public merchant card is account-signed, intentionally making
   the merchant account identifiable.
4. The device registry is account-signed and contains device identity in
   plaintext. It must remain local or move over an authenticated private
   channel; it is not safe to publish as a public identity directory.

These are cryptographic event-builder checks, not a complete network capture.
The captured R0/R1 WebSocket harness already verifies group relay frames and
REQ filters. A future DM identity migration must extend it to inspect the full
subscription and delivery path across ordinary relays.

## Linkability findings

- **Confirmed compartment:** group wire signatures are separated from the
  account key and from other group ids. The group actor remains linkable within
  its group by design.
- **Partial DM separation:** the outgoing sender is hidden in the outer gift
  wrap, but the recipient's account key is the routing address. Incoming
  filters name that account. The DM relay therefore learns an account-to-inbox
  association; this is not an anonymous DM identity.
- **Confirmed merchant join:** the same account key signs public merchant
  events, and the vendor card is served on the group relay. A group relay can
  directly join storefront and group activity. This is a stronger join than
  timing-only inference.
- **Device isolation not integrated:** R2 device credentials are independent
  at rest, but live DM bundles and group actions do not yet use them. A signed
  public registry would undo the compartment by naming the account and device
  together.
- **Root compromise:** current group actors can be derived from the account
  secret. An account-key compromise can therefore link and impersonate that
  account's known group actors. Group pseudonymity protects the public wire
  from direct account-key matching; it does not protect against root-key
  compromise or a party that already knows the binding.

## Safe migration order

Do not replace keys in place. Preserve current account-signed public profile,
commerce events, old group actor pins, and legacy DM reads while introducing
new identities only behind a versioned, authenticated transition:

1. Decide whether merchant identity separation is desired. If yes, define a
   stable merchant key and signed account-to-merchant continuity statement;
   migrate orders, dispute authority, reviews, receipts, listings, and buyer
   verification together. Until then, merchant/account linkage is an explicit
   public product choice.
2. Define a private DM address-discovery protocol bound to verified contacts
   and device credentials. Keep old account-addressed NIP-44/NIP-59 history
   readable. Reject unauthenticated address changes; never publish an
   account-to-DM-address directory.
3. Define per-group actor key ownership and encrypted device transfer before
   changing the deterministic derivation. The transition must bind old actor,
   new actor, account standing, group id, and governance generation, and must
   preserve existing authority pins and relay history.
4. Add a private, freshness-checked device-registry delivery path before live
   prekey bundles rely on R2 credentials. Missing or stale registry means no
   new device-authorized send.
5. Capture ordinary-relay frames and test cross-account correlation before
   enabling any new format. Keep public profile and commerce identifiers
   public where the user chose a public identity.

## Stop conditions

- No globally published account↔device or account↔private-DM mapping.
- No removal of the account-key DM route until old-message compatibility and
  verified contact migration work on independent devices.
- No merchant-key split until order, payment, dispute, receipt, and reputation
  continuity are proven end to end.
- No per-group actor rotation until every member can verify the signed
  transition and offline/reinstall recovery is specified.
- Do not claim R4 provides full identity unlinkability. IP and traffic timing
  remain accepted residuals, and the current merchant and DM routing joins are
  measurable.
