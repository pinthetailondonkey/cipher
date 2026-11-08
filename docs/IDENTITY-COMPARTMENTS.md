# Identity compartments — R4 findings and migration boundary

Status: R4 audit plus replay-ingestion hardening and an isolated private-device
registry prototype. This records current behavior and intentional public
identity joins. It does not claim that DM or merchant identities are fully
separated, and the private registry transport is not wired into application
publication or device enrollment. Evidence is pinned to the source in this
commit.

## Identity map

| Compartment | Current identifier and owner | What a relay can link | Rotation and compatibility |
| --- | --- | --- | --- |
| Main Nostr account | Account secp256k1 key in the account vault | Public profile, NIP-65 relay list, ordinary Nostr activity, and recipient address on inbound DM fetches | Existing account recovery restores this key. Changing it is a public identity migration and cannot erase old events. |
| DM routing | The account pubkey is the NIP-44 recipient and the kind-1059 `p` address; outgoing wrap author is a random one-use key | The DM relay can associate the recipient account with the device's IP and traffic. It does not learn the sender account from the outgoing wrap itself. The incoming subscription filter also names the account key. | Legacy kind-4 history still depends on account-key filters. A separate address needs authenticated contact discovery, key rotation, legacy reads, and recovery before replacing this route. |
| Group actor | `HKDF(account secret, cipher-gid:<gid>, cipher-group-authority-key-v1)` | The group relay sees the group-local actor, not the account key. Different group ids produce different actor keys. It can still correlate the actor's actions within that group. | Actor is deterministic from the account key and gid. Losing or rotating the account key changes the derived actor unless the old key remains available. Existing invites, authority pins, governance rows, and relay history bind to this actor. |
| Merchant/storefront | Main account key signs the public card and marketplace events | The group relay that hosts the public vendor card can directly join the merchant account key with group traffic on that relay. Other public trade and review records also use Nostr account identity. | This linkage is a product-visible public identity today. Changing it requires migrating listings, orders, reviews, receipts, buyer trust, and existing links; no silent key substitution is safe. |
| Device | R2 creates an independent device signing key and a random device id | The local signed registry maps the account key to device key and id. The application does not publish it. `deviceRegistryWire.js` can wrap it as a sender-hidden kind-1059 DM to one contact; only the recipient route remains visible. | The private wrapper and sealed peer checkpoint are experimental helpers, not integrated into live DM send/receive. A lost device key is not recoverable from the account phrase. Device credentials are not used by live DM or group transport. |

## Wire evidence and tested guarantees

`src/lib/identityCompartments.test.js` executes the real Nostr signing, group
actor derivation, NIP-59 sealing/wrapping, vendor-card builder, and R2 device
registry builder. `deviceRegistryWire.test.js` executes the private wrapper,
and `crypto-state-browser-test.mjs` executes it in Chromium with two
independent browser account stores. These tests establish:

1. Two group ids produce different signed event authors, and the account key
   does not appear in those group events.
2. An outgoing kind-1059 relay event has a throwaway author and the recipient
   `p` address; the sender account key is absent from the outer event.
3. The current public merchant card is account-signed, intentionally making
   the merchant account identifiable.
4. The device registry is account-signed and contains device identity in
   plaintext. It is not safe to publish as a public identity directory. The
   prototype wrapper hides the sender account, device rows, and registry id
   from its outer relay event; it still exposes the recipient account route.
5. The recipient accepts the peer registry only after opening the NIP-59
   envelope, verifies the account signature, seals it at rest, and rejects
   lower generations and same-generation equivocation. This acceptance path
   is not yet connected to contact discovery or live device authorization.

`giftUnwrap.js` is the shared DM transport verification gate for live and
history receive: it validates outer kind-1059 hashes/signatures/routing tags,
then returns the authenticated inner rumor id; legacy kind-4 remains accepted
only with its original valid signature and exactly one recipient tag. The DM
hook uses that same inner id in both paths. `saveMessageOnce()` arbitrates
duplicate incoming IDs in a cross-tab IndexedDB transaction before unread and
notification effects. Order receipt countersigns reserve one immutable signed
kind-1059 event and its outbox row atomically under a hashed idempotency key;
the outbox settles both records together, and retries reuse the same event ID.
Group kind-9 ingestion still requires one matching group id and rejects
ambiguous epoch tags. These changes close duplicate message insertion and
cross-tab receipt-send races, but cannot make external relay delivery or OS
notifications literally exactly-once: an uncertain relay acknowledgement can
cause retry of the same signed event id, and notifications/haptics remain
best-effort rather than durably journaled.

The browser registry exercise is a real Chromium + IndexedDB crypto path, but
does not publish the registry over a WebSocket. In this R4 run, two independent
browser accounts completed the real app flow against isolated local group and
DM relay processes configured with fresh temporary keys and databases. The
group relay capture contained 180 WebSocket frames, including four AUTH frames;
creation, encrypted admission, approval, messaging, role changes, removal,
rejoin, and encrypted key delivery passed. The harness asserted that both
account keys were absent from captured group-relay frames and REQ filters.
Those relay processes and temporary databases were stopped and removed after
the run. A background profile request to the default public relay returned
503, but it did not participate in the isolated group flow. A future DM
identity migration must inspect subscription filters and delivery across
ordinary relays.

The same Chromium harness now uses two tabs on one account to race distinct
signed kind-1059 candidates for one receipt-effect key, completes the reserved
event from the second tab, then confirms the first tab recovers the completed
state without creating another event. Separate independent account contexts
remain in the registry test. The UI payment test checks that a valid signed
watcher result stores a receipt and its signed event in the durable outbox;
unit and Chromium database tests exercise retry/recovery. These are isolated
test paths; they do not migrate identity formats or publish a new identity
capability.

The payment watcher itself is read-only. Its confirmed report now enters the
account's Web-Locks-protected consumed-transfer check, persists a receipt and
the consumed ledger before publication, and uses the message-effect journal
for the outgoing order update. A crash after those local writes can repeat the watcher
check for the same order/transfer, revalidate and reuse the exact device-signed
receipt, then recover the same outbox event. A different order using that
transfer remains refused. The watcher does not broadcast a payment, custody
funds, or prove more than its signed report; external relay acceptance remains
at-least-once with a stable event id.

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
  at rest, but live DM bundles and group actions do not yet use them. The
  registry remains local today; the private wrapper prototype avoids a public
  account↔device record, but live registry publication, key-change freshness,
  and multi-device revocation enforcement remain unimplemented.
- **Root compromise:** current group actors can be derived from the account
  secret. An account-key compromise can therefore link and impersonate that
  account's known group actors. Group pseudonymity protects the public wire
  from direct account-key matching; it does not protect against root-key
  compromise or a party that already knows the binding.

## Migration designs requiring approval

### DM recipient privacy

**Threat model.** A relay reads Nostr event tags and REQ filters. It sees the
recipient account key on current kind-1059 DMs and can join that route to the
account's public profile and traffic timing. The gift wrap hides the sender
and the inner NIP-44 body; it does not hide the recipient route, IP, or timing.

**Design.** Give each account device random inbox signing keys, scoped per
contact/device where practical. The account key signs a private, expiring
contact capability binding the contact, inbox public key, device credential,
protocol version, and rotation counter. Exchange it inside the existing
authenticated DM. Send new NIP-59 wraps to that scoped inbox route while
keeping sender identity inside the sealed conversation. Verify the capability
signature, contact binding, expiry, and monotonic counter before sending.
Keep account-key routes for receive-only legacy history; never silently send
there after a new capability is expired or revoked, and never publish an
account-to-inbox directory.

Existing event IDs, message history, contacts, and NIP-44 decryption stay
unchanged. Migrate through an in-band signed capability exchange with an
authenticated acknowledgement. New devices obtain inbox secrets only via
verified device pairing or an encrypted recovery package. Without either, a
lost inbox secret cannot be reconstructed from the account key. Capture
filters and frames across independent ordinary relays before enabling this.

### Merchant/account separation

**Threat model.** Public marketplace cards use the account key, and a group
relay hosting a card can directly join it to group activity. This is a
confirmed key-reuse link, not a theoretical derivation risk.

**Design.** Create an independent random merchant key and a versioned,
account-signed continuity statement. Do not globally publish that statement by
default, since that would preserve the public link. Deliver proof in a signed
listing, an established private conversation, or an explicit QR/export. New
listings use merchant identity; old listings remain immutable and verifiable.
Version orders, receipts, and reviews to name the merchant identity while
retaining original account party fields for legacy verification. A transition
ledger must preserve review provenance and old merchant-key continuity. Never
rewrite an order, signed receipt, reputation record, or chain address.

Keep one familiar visible profile and present the merchant identity as its
storefront compartment. Existing chats continue to account routes until a
separately approved inbox migration. Back up and transfer the merchant secret
only to verified devices. Losing it does not authorize signing as the account;
watcher evidence and noncustodial wallet/address behavior remain unchanged.

### Independent group actor keys

**Threat model.** Group actors are group-separated on the wire, but their
secrets are HKDF-derived from the account secret and group id. Root-key
compromise enables derivation of known group actors. Relay observers do not
learn the account key from group events; the risk is derivation after root
compromise or correlation by a party that already knows the binding.

**Design.** Generate an independent random actor secret per group, seal it at
rest, and deliver it only to governance-authorized devices. A governance-signed
transition binds group id, generation, old actor, new actor, authority
standing, and a fresh nonce. Members verify that transition against their
current signed governance document. Preserve old pins, invites, and relay
events as history; never authorize a transition from a relay roster. Offline
members receive transition plus current governance state through an
authenticated member channel. If authority is lost, require explicit group
recovery rather than deriving a replacement key.

This needs a versioned actor binding, device transfer, and a decision on
recovery after the last authority device is lost. Existing groups remain on
their old actors until every member can verify the transition. No automatic
downgrade or parallel authorization is safe.

### Device registry freshness and revocation

The prototype account-signs registry contents and seals the latest locally
accepted generation at rest. It rejects lower generations and same-generation
equivocation, but that is not global freshness: a relay can withhold a newer
revocation and replay an older valid registry to a device that has not seen
the update. Event timestamps and the 90-day age limit cannot prove latestness.

Before live DM prekeys or group key delivery depend on the registry, require
authenticated device-to-device checkpoint gossip, per-contact monotonic
generation acknowledgements, and explicit handling of conflicting valid
snapshots. A stale/unavailable checkpoint must block new device authorization;
it must not erase historical access or mint replacement secrets. Recovery
pairs from an active device or consumes an encrypted recovery package and
advances the registry. Account-key recovery alone cannot recreate a revoked
device secret. This remains experimental and is not wired into live transport.

## Safe migration order

1. Approve merchant continuity policy before changing public listing authors.
2. Approve scoped DM inbox routes and their contact capability handshake.
3. Define independent group actor ownership and recovery before replacing
   deterministic derivation.
4. Complete registry freshness/revocation before live key delivery depends on
   device credentials.
5. Capture ordinary-relay traffic and test cross-account correlation before
   enabling any new wire format.

## Stop conditions

- No globally published account↔device or account↔private-DM mapping.
- No removal of the account-key DM route until old-message compatibility and
  verified contact migration work on independent devices.
- No merchant-key split until order, payment, dispute, receipt, and reputation
  continuity are proven end to end.
- No per-group actor rotation until every member can verify the signed
  transition and offline/reinstall recovery is specified.
- Receipt sending and message insertion now use durable cross-tab idempotency.
  OS notifications/haptics remain best-effort; external relay delivery is
  at-least-once with the same event id after an uncertain acknowledgement.
- Do not claim R4 provides full identity unlinkability. IP and traffic timing
  remain accepted residuals, and the current merchant and DM routing joins are
  measurable.
