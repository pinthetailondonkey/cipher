# R5 send-time and revocation decision record

Status: **owner-selected test-profile defaults recorded; protocol decision remains open**. These defaults do not define production acceptance behavior or select a trusted-time mechanism.

## Problem

The current R5 prototype embeds short-lived authority proofs in an immutable
delivery event and validates expiry at both send and receive. That fails for
offline relay delivery after the embedded proof expires. Refreshing only local
outbox metadata cannot change the immutable signed event.

The review candidate separates the immutable ratchet operation from a signed
delivery envelope. A refreshed envelope might preserve the same operation and
ratchet state, but receiver acceptance still depends on when the sender was
authorized and whether revocation has taken effect.

`created_at` on a sender-signed Nostr event is not a trustworthy send-time
attestation: the signer can choose an earlier timestamp. A relay's local
arrival time is not a portable signed receipt and different relays can report
different observations. Therefore an old event timestamp cannot establish
that a device sent a message before a revocation cutoff. A device certificate
that names an exact registry head establishes which head was authorized when
the certificate was issued; by itself it does not prove when a later message
was created or accepted for delivery.

## Owner-selected test-profile defaults

The product owner selected the plan defaults below for test-profile evaluation:

| Decision | Test-profile default | Scope and limit |
|---|---|---|
| D1 revocation grace | Five minutes after the authenticated revocation cutoff | Candidate maximum grace for an operation-specific, authority-signed authorization issued before the cutoff. It is not permission to trust sender-controlled `created_at`, nor approval of a reusable five-minute session lease. Trusted issuance/cutoff evidence and offline receipt semantics remain under independent review. |
| D3 registry age | At most 24 hours old at send time | Candidate maximum age of the sender's pinned, authenticated registry checkpoint when authorizing a send. Measure against authenticated checkpoint metadata and a defined clock source; local monotonic pinning still rejects rollback/forks but cannot prove a relay has not withheld a newer head. Receiver-side freshness at delayed receipt remains a separate open decision. |

These are test-profile parameters, not production policy or application
behavior. The protocol specification and independent review must define exact
signed fields, time source, clock rollback handling, cutoff ordering, offline
acceptance, and whether the defaults are safe and achievable. Until then, a
missing or unverifiable proof/checkpoint remains held or rejected.

## Questions that remain open

1. **Trusted send-time evidence:** what authority-signed evidence binds an
   exact operation to authorization before the D1 cutoff, and how does a
   receiver verify it without relying on sender-controlled `created_at`?
2. **D1 cutoff ordering:** define which signed revocation/checkpoint time is the
   cutoff and how an authorization racing with revocation is ordered.
3. **D3 clock source:** define a rollback-resistant time source for measuring
   the 24-hour sender checkpoint age, including after sleep, restore, or clock
   adjustment.
4. **Offline receipt:** what evidence lets an offline recipient distinguish a
   message authorized before revocation from a compromised device's message
   backdated to before revocation? Does D1 grace apply to relay acceptance,
   receiver receipt, or both?
5. **Receiver registry freshness and authority availability:** how fresh must
   the receiver's authenticated registry checkpoint be at receipt, and should
   an unavailable or too-old checkpoint hold delivery until authority is
   reachable?

## Candidate mechanisms for independent review

These are alternatives to analyze, not selected protocol behavior:

- Require current authenticated authority at receipt. This can reject a
  revoked device promptly, but offline recipients cannot accept messages
  until authority is reachable.
- Use a short-lived, authority-signed authorization token whose signed issue
  time and expiry bind the exact device, operation digest, and registry head.
  Review must define how revocation interacts with already issued tokens,
  token replay, offline age, and authority outage.
- Use a trusted relay or timestamp authority receipt. This adds a trust and
  availability dependency and must define what happens when delivery is
  relayed through multiple operators.

No option can be treated as satisfying a cutoff merely because it checks
sender-controlled `created_at`. The selected design must state its compromise
window and offline-delivery cost against the provisional five-minute D1 and
24-hour D3 test defaults.

## Required review cases

Before test-account DM integration, the wire specification and independent
review must define outcomes for: device revoked before send; revocation between
authorization and relay acceptance; message queued before revocation and
received after it; compromised device backdating `created_at`; stale or forked
recipient registry; authority outage; expired authorization; uncertain relay
acknowledgement; exact-event retry; and any refreshed envelope for an
unchanged operation. Tests must prove that a rejected or held attempt does not
advance ratchet state and that retries cannot alter the committed operation.

## Current implementation boundary

The local relay fault harness tests NIP-42 challenge handling, delay,
reordering, lost acknowledgement, and exact signed-event retry. It does not
provide trusted time, device revocation, an authority service, or ratchet
integration. The protocol-test artifact still compiles both DM and MLS modes
off and sends no relay traffic. Production DMs remain NIP-44/NIP-59.
