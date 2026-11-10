# R5-B delivery semantics decision record

Status: design candidate for independent review. This is not an accepted wire protocol and does not authorize test-account or production integration.

## Current prototype behavior

`src/lib/dmRatchetAuthority.js` serializes the operation id, ratchet ciphertext, application payload, and sender/recipient challenge-response proofs inside the NIP-59 rumor content. `commitRatchetOutboundV2` commits the session state, signed wrap, recipient metadata, expiry, and operation journal in one IndexedDB transaction. `openAuthorizedRatchetDm` verifies the embedded proof freshness at receive time. The event is immutable after commit, and `shouldFlushOutboxRow` holds it after `freshUntil`.

This creates a delivery gap: once the embedded proof expires, the sender holds the event and a receiver must reject that same event. Updating only the outbox expiry would not refresh the proof inside the signed and encrypted event. Changing the event would change its Nostr id and would need an explicit duplicate-delivery rule. The prototype's v1 refresh helper does not resolve this v2 behavior; it handles only the older v1 outbox metadata.

## Candidate semantics to take into protocol review

Keep the ratchet transition and one authenticated application operation immutable. Separate that operation from a short-lived authorization envelope:

1. The ratchet transaction commits the next ratchet state, one ciphertext, a random operation id, a digest binding the operation id to that ciphertext and application payload, the exact target device, the authority registry heads used, and an outbox journal. This is the only ratchet advancement for the operation.
2. A delivery envelope binds the immutable operation id and digest to sender and recipient account/device ids, the exact policy and registry checkpoints, and an expiry. The envelope is authenticated by the protocol's reviewed sender-device mechanism and carried in the encrypted transport object. No proof refresh may replace or re-encrypt the ratchet ciphertext.
3. While an envelope is valid, retry the byte-identical signed outer event whenever acknowledgement is uncertain. Do not generate another ratchet transition or event candidate.
4. After expiry, a new envelope may be created only for the already committed operation id and digest and only after fresh authority succeeds for the same target device. The new outer event may have a different event id; the receiver deduplicates by authenticated operation id and rejects any reuse with a different ciphertext or payload digest.
5. On receipt, verify the envelope expiry, authority proofs, exact registry heads, target device, and inner digest before ratchet advancement. A duplicate operation id with matching authenticated digest has no second message/order/payment effect; a conflicting digest is rejected and recorded as a protocol conflict.
6. A missing, stale, forked, or revoked authority result holds delivery. A local account-context failure holds delivery and prevents state or journal changes. Network failure does not authorize a new ratchet operation.

This candidate would preserve the ratchet step across authorization refresh while making the outer delivery object mutable. It does not yet settle how relays and receivers handle two valid envelopes arriving in either order, nor how long an operation-id deduplication record must be retained.

## Required review decisions before implementation

- Define canonical byte encodings, signatures, and domain separation for the immutable operation and each envelope.
- Decide whether a refreshed envelope is a new Nostr event, a replacement wrapper, or another transport object, and specify precisely which bytes are stable.
- Define duplicate retention, pruning, recovery backup, and behavior when the sender restores an older profile without the operation journal.
- Decide receive-time expiry semantics for offline recipients and clock skew, including whether an envelope valid at relay acceptance but expired at receipt is accepted.
- Define registry fork, revocation, and recovery replacement behavior between envelope creation and delivery.
- Prove concurrent sender tabs cannot attach different ciphertexts or digests to one operation id; test lost acknowledgement, out-of-order envelopes, restart, and crash boundaries.
- Measure relay-visible event ids, tags, routing keys, recipient device tags, size, and timing for both original and refreshed envelopes.
- Obtain independent protocol review before writing production wire code or connecting an application caller.

## Gate

Until these decisions are made and reviewed, keep `commitRatchetOutboundV2`, `commitRatchetInboundV2`, and the related authority code isolated. Do not connect them to `useNIP44DM.js`; existing NIP-44 history remains readable and live DM sending remains unchanged. Passing local prototype tests is not evidence of live DM security.

## Adversarial internal review (2026-11-09)

This is a source-and-test review by the project implementation agent, not an
independent protocol review. It found that the prototype and the v1 candidate
are materially different:

- `commitRatchetOutboundV2` embeds both authority proofs in the NIP-59 rumor
  and commits one immutable kind-4 wrapper. `shouldFlushOutboxRow` refuses
  both v1 and v2 rows after `freshUntil`, even with `force=true`.
- `refreshRatchetOutboundAuthorization` handles only
  `cipher-ratchet-device-delivery-v1`, which uses the older
  account-signed freshness mechanism. It cannot refresh the v2 proof.
- The generic `publishWriteAhead` path checks the captured lifecycle fence but
  has no ratchet-proof expiry parameter. `flushNostrOutbox` now rechecks v2
  expiry after awaited database status writes and immediately before calling
  the pool; a focused regression test covers expiry during those awaits. V2
  still has no app caller. Future integration must use a proof-aware
  per-attempt publisher and must recheck expiry at the actual socket handoff;
  calling generic publish with the returned event bypasses even the queue
  expiry gate.
- A final preflight alone is not enough with the current `nostr-tools`
  `SimplePool.publish`: it awaits relay connection setup before calling
  `Relay.publish`, and `Relay.send` schedules the WebSocket send from the
  connection promise. The short proof can expire during that wait. A v2
  publisher needs an already-connected relay socket or a transport hook that
  checks authority expiry at the actual send handoff, including after any
  NIP-42 AUTH challenge. Until that exists, hold instead of opening a new
  connection with a near-expiry proof.
- A disabled-by-default transport seam now demonstrates this handoff rule in
  `ratchetProofAwareTransport.js`: it uses one bounded socket attempt, checks
  the account fence and proof immediately before each synchronous send, and
  rechecks after asynchronous AUTH signing and acknowledgement. Its local
  tests use a deterministic socket double; they cover delayed connect, AUTH
  signing/acknowledgement, expiry before the post-AUTH resend, successful ACK,
  lost-ACK exact-event retry, and stale account context. They do not exercise a
  real WebSocket implementation, relay, browser race, or app caller. The seam
  is not connected to `SimplePool`, the generic outbox, or production DMs.
- `openAuthorizedRatchetDm` validates both proofs at receive time. Thus the
  v2 proof can expire while a kind-1059 relay retains the event; there is no
  accepted-at-relay proof or delivery receipt.
- The current v2 freshness response is signed by the primary authority `A`
  (`buildDeviceFreshnessResponseV2` requires its secret), not by the target
  recipient device. A target device may be offline if its authority can still
  answer and its active registry head is current; if that authority is offline,
  the sender cannot obtain a fresh recipient proof. The app has no request /
  response transport for this exchange.
- `buildAuthorizedRatchetDm` previously serialized `applicationPayload` next
  to `ratchetCiphertext` inside the NIP-59 rumor. NIP-44 protected that wrapper
  in transit, but the ratchet did not protect application content, so the
  prototype could not support a forward-secrecy claim for that payload. The
  field has been removed; inbound processors receive ciphertext only and
  return application plaintext only after the ratchet-processing step. The
  test uses a fake processor and does not prove the vodozemac adapter decrypts
  application content.
- The current helper uses a stable target-device public key in its NIP-59
  recipient tag and a kind-4 rumor. The v1 packet proposes kind 14 and a
  contact/device-scoped route key. Prototype tests do not establish that
  candidate wire format.
- Inbound deduplication keys the journal by operation id but also requires
  the same `rumorId`. That is fail-closed for alternate wrappers and does not
  support refreshed envelopes. It must instead authenticate and compare a
  stable operation digest before multiple delivery attempts can be accepted.
- The outbound idempotency check previously bound an operation id only to
  session and application-payload digest. A repeated id with a different
  ratchet ciphertext or next state could
  return the earlier event as an idempotent retry. It now hashes ciphertext,
  next state, session, target, and current proof event ids; changed state or
  ciphertext is rejected. The focused regression test covers
  this isolated prototype boundary. This is not v2 authority integration or
  live DM evidence.

### Decision matrix

| Decision | Safe default | Alternatives and tradeoff | Evidence required | User product choice? |
|---|---|---|---|---|
| Where is application plaintext carried? | Only as ratchet-encrypted plaintext; the NIP-59 rumor carries ratchet ciphertext and authorization data, never a parallel clear application payload. | Relying only on NIP-44 gift-wrap encryption protects transport confidentiality but does not give the payload ratchet forward secrecy. | Inspect decoded rumor schema; prove application plaintext enters only after the actual ratchet library decrypts. Current test uses a fake processor and is helper evidence only. | No; this is a cryptographic invariant. |
| What is immutable across a retry? | One operation id binds the exact ratchet ciphertext, next state, sender/target device pair, and session. The app payload exists only after ratchet decryption. Retry the exact committed event while its authorization is valid. | Re-encrypting or ratcheting again on retry risks state divergence and duplicate business actions. | Two-tab CAS, crash boundaries, changed-ciphertext/state same-id rejection, exact event byte comparison after lost ACK. The prototype now covers helper-level idempotency/CAS cases only. | No; fail closed is the engineering default. |
| What can change after authorization expiry? | Current prototype: nothing; hold the exact event. Candidate design: a new signed delivery envelope and NIP-59 wrapper may refer to the same operation digest, without ratchet advancement. | Dropping the message sacrifices delivery. Re-encrypting creates a new operation. Rewrapping requires receiver dedupe across event/rumor ids and durable rollback-safe operation journals. | Competing/out-of-order envelopes, lost/partial ACK, crash, duplicate effects, conflict digest, profile restore, and message-journal rollback tests. Independent review of all signed bytes. | Yes, if the product permits a fresh attempt after uncertain ACK and defines the duplicate/hold UX. |
| When must a proof be fresh? | Verify at both sender publication and receiver receipt against exact locally pinned heads. Expired proof is held/rejected; relay `created_at` is not trusted as acceptance time. | A signed relay receipt adds relay trust. Accepting proof issuance time or a lease permits offline delivery but sets a stale-authorization window, especially after revocation. | Authority/relay threat analysis, clock-skew cases, relay receipt forgery/withholding tests, and measured delivery delay under offline relay retention. | Yes. Strict revocation and useful offline delivery conflict under a 30-second proof. |
| How does a sender obtain the recipient proof/prekey? | Require the recipient authority to answer a challenge; otherwise hold. Do not treat a public registry snapshot as fresh proof. | Publish signed public bundles for offline first contact (links account/device to the relay), or use a private request that requires a reachable/contact-known route (less discovery, lower availability). | First-contact online/offline, replay/fanout, stale prekey, relay censorship, authority outage, and capture of queries plus EVENT/AUTH frames. | Yes; choose availability versus first-contact metadata exposure. |
| Which endpoint must be online for a fresh recipient proof? | Require reachable `A` to answer each one-operation challenge; if it is unavailable, hold. | Cache a bounded signed lease or use a witness/checkpoint service to improve availability, at the cost of a stale-revocation interval or added trust/operator. | Partition/revocation tests with primary authority offline, target device offline, clock skew, and stale sender/recipient checkpoints. | Yes; choose acceptable outage behavior and maximum stale-authorization window. |
| How long is operation dedupe retained? | Keep the operation digest through the full retry/message-retention window and any supported restore window; reject a reused id with a changed digest. | Short TTL saves storage but permits replay after pruning or backup restore. A rollback-resistant checkpoint is stronger but adds a trust/service dependency. | Retention-boundary replay, browser profile rollback, backup restore, and application effect recovery tests. | Yes for user-visible history/backup retention; mechanism is an engineering decision after recovery design. |
| Which publisher may send a ratchet operation? | A dedicated proof-aware queue that checks caller incarnation and proof expiry immediately before transport handoff. Never send v2 through generic `publishWriteAhead` or raw `pool.publish`. | A shared queue helper is viable only if proof context is a mandatory typed capability and cannot be omitted. | Expiry during DB status write, relay connection wait, lock/wipe, and multi-relay partial publish; inspect the actual send boundary. | No; security boundary choice is engineering. |
| What if the relay socket is not already connected? | Hold the operation until a fresh proof and a connected authorized socket are both available; recheck after any AUTH challenge, immediately before `WebSocket.send`. | Let `SimplePool` connect after proof creation; this improves availability but can publish after the short proof expires. A larger lease is the separate product/security choice above. | Delayed handshake past `freshUntil`, AUTH challenge at expiry, multi-relay with mixed connection state, and actual socket-send timestamp instrumentation. | No; fail-closed send gate is engineering. |
| Which recipient identifier is on the relay? | Do not publish the globally stable `Dᵢ` or account `N` as the future private-route tag. Until the scoped route is established, do not claim the prototype hides either. | Account-key routing is compatible and available but exposes the account graph. Stable device routing hides `N` in the tag but allows cross-contact device correlation. | Exact route-tag/REQ capture, route rotation/revocation, and same-relay public-account correlation tests. | Yes for availability and fallback policy; route cryptographic binding is an engineering/review gate. |
| Which event version carries the ratchet? | Versioned kind-14 rumor under NIP-59 is the candidate; explicit downgrade rejection and legacy read-only path. | Reuse kind 4 for transitional compatibility, but existing decoders and filters may confuse legacy and ratchet content. | Exact schema/version tests, legacy-history regression, malformed/downgrade corpus, ordinary relay compatibility capture. | No for fail-closed versioning; rollout timing is a product choice. |
| What protects sender IP? | Direct relay connection is explicitly IP-visible; do not claim sender-IP protection on it. Hold release claims until a separate path is tested. | Tor/onion or independent ingress/egress forwarding reduce what a single hop sees but add availability, latency, operator-collusion, browser-platform, and traffic-correlation costs. | Per-hop IP capture on desktop and web, ingress/egress collusion timing analysis, outage and abuse tests. | Yes: supported platforms and acceptable latency/availability must be chosen. |

### Engineering disposition

Resolve in design without user input: keep the current v2 prototype fail-closed;
keep application plaintext out of the NIP-59 rumor outside ratchet ciphertext;
reject operation-id reuse with changed ciphertext or next state (now enforced); never let
`force` bypass proof expiry; retain NIP-44 only for history; and do not use the
v1 refresh helper as R5-A evidence. The generic write-ahead path must not
publish a ratchet event without a proof-aware transport handoff. The versioned candidate must separate
immutable ratchet operation from per-attempt delivery authorization and must
deduplicate by a cryptographically authenticated operation digest, not event
or rumor id alone.

User-dependent gates remain explicit: the tolerated offline-delivery window
after proof issuance/revocation, first-contact discovery availability versus
linkage, dedupe/backup retention, and platform coverage for IP protection.
No choice is inferred from the current prototypes. No refreshed envelope
implementation is authorized by this internal review.

## Local relay evidence (2026-11-09)

`npm run test:dm-local-relay` passed against a disposable NIP-01 WebSocket relay
bound to loopback and two independent Chromium contexts. The first scenario
exercised the existing `useNIP44DM.sendDM` path through its write-ahead outbox,
`nostr-tools` pool, actual browser `WebSocket.send`, relay OK acknowledgement,
the recipient's live subscription, decryption, and local message save. Its
captured kind-1059 wrapper had a recipient account `p` tag, did not contain the
application plaintext, and did not use the sender account key as the wrapper
pubkey. This is synthetic test-account traffic to a local fixture, not a public
relay capture or a production security claim.

The second scenario committed a proof-bound R5 event using independent
synthetic sender/recipient authority setups, sent placeholder ciphertext and
fixture ratchet state, and used the isolated proof-aware WebSocket publisher.
The relay stored the event but dropped the first OK; the receiver fetched the
same event and validated both authority proofs; the retry sent byte-identical
EVENT JSON and received OK. This verifies the harness's authority and transport
boundary with a local relay. It does not run the ratchet library, model a
recipient-authority request/response exchange, or connect the prototype to an
application caller. The fixture's generated recipient proof is not evidence
that a real contact can request or obtain that proof. The expired-event,
recovery, stale registry, revocation, and cross-profile rollback cases remain
separate focused-test requirements.
