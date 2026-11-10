# Cipher DM v1 semantic vector manifest

Revision: `cipher-dm-v1-review-candidate-r1`
Status: independent-review input, **not cryptographic known-answer vectors**.

The v1 wire candidate is not frozen to a canonical byte encoding or signature
profile. Producing fake signature/ciphertext bytes before that choice would be
misleading. The cases below freeze operation inputs, mutation, expected result,
and ratchet/journal effect. A reference implementation must add deterministic
cryptographic known-answer files after the reviewer accepts canonicalization,
Nostr event construction, and the supported vodozemac session mode.

## Shared valid-fixture contract

Every positive fixture must be built from two distinct accounts, independent
recovery roots, one active sender device and one active recipient device, exact
pinned policy events and registry heads, a fresh session id, an authenticated
prekey bundle, and a fresh operation id. The fixture records the canonical
operation bytes, operation digest, kind-14 rumor bytes, kind-13 seal, kind-1059
wrap, all Nostr ids/signatures, before/after ratchet state digests, and durable
outbox/inbox journal rows. No account secret substitutes for a device key.
The production account identity remains the signing identity on existing
profile, vendor, order, review, and reputation events.

## Required deterministic cases

| Vector ID | Exact mutation from shared fixture | Expected result | Durable state and effect expectation |
|---|---|---|---|
| `DMV1-001` | Unmodified valid initial-session operation, exact pinned heads, active device pair, valid signed-prekey bundle. | Accept and create one session. | One sender transition + immutable operation + attempt/outbox row in one transaction; one receiver transition + digest journal in one transaction; one application effect. |
| `DMV1-002` | Flip the final ciphertext byte; retain the original operation signature and digest. | Reject authentication. | No session, ratchet, outbox, inbox, or application effect change. |
| `DMV1-003` | Change `to.device` to a different active device but retain the original prekey and proofs. | Reject target binding. | No ratchet or journal change. |
| `DMV1-004` | Replace recipient registry head id with the immediate prior valid head. | Hold stale authority. | No ratchet transition or publish. Persist an explicit held reason only if that status write is outside the ratchet transaction and is fenced. |
| `DMV1-005` | Supply two valid signed registry successors from the same prior head. | Accept at most one local checkpoint successor; report exact fork/conflict. | Winning head is monotonic; losing branch cannot replace it; no send uses the losing head. |
| `DMV1-006` | Mark target device revoked in the exact current registry; leave its old prekey signature valid. | Reject the target. | No ratchet transition or publish. |
| `DMV1-007` | Change explicit protocol version from `1` to `0`, remove the version, or add an unknown mandatory version. | Reject downgrade/unknown version. | No fallback send through legacy NIP-44; prior history remains readable. |
| `DMV1-008` | Replay the exact accepted outer event and operation id with the same digest. | Treat as duplicate. | No second ratchet advance and no second message/order/payment effect. |
| `DMV1-009` | Reuse accepted operation id with a different digest or ciphertext. | Reject and record protocol conflict. | No state change; preserve the prior digest and effect journal. |
| `DMV1-010` | Deliver message counter `n+1` before `n`, within the selected library's documented skipped-key bound. | Accept both in order supported by the ratchet; reject duplicate consumption. | Each counter advances exactly once; skipped-key storage stays within the pinned limit. |
| `DMV1-011` | Set counter gap to one above the selected library's configured bound. | Reject excessive gap. | The unmodified prior session remains usable; no ratchet or journal change. |
| `DMV1-012` | Abort IndexedDB after ratchet preparation but before transaction commit. | Report storage failure/hold. | Either complete transition plus outbox/journal or no transition; no partial event publication. |
| `DMV1-013` | Commit event, drop relay `OK`, restart sender, retry before expiry. | Retry accepted. | Exact signed event bytes, id, operation id, digest, and ratchet state are unchanged; receiver effect remains once. |
| `DMV1-014` | Let proof expire before the actual WebSocket send boundary. | Hold before EVENT handoff. | No EVENT frame; committed operation remains pending and ratchet is not advanced again. |
| `DMV1-015` | Let embedded proof expire after relay acceptance and before receiver delivery. | Current immutable-proof prototype: receiver rejects. | No receiver ratchet/effect change. Candidate envelope behavior must be separately specified and reviewed. |
| `DMV1-016` | Refresh only local outbox expiry while retaining the old immutable event. | Reject/hold. | No event mutation, no proof extension, no publish. |
| `DMV1-017` | Present a refreshed attempt with the same operation digest but a different authenticated envelope, exact new heads, same target device, and no second ratchet call. | Candidate behavior pending review. | If approved, one receiver application effect across attempts; otherwise hold. This case cannot be made a pass vector before the expiry/revocation policy is selected. |
| `DMV1-018` | Restore an old ratchet backup without the corresponding latest operation digest journal. | Hold and require a fresh device-pair session. | Never reuse old operation id, message key, nonce, or dedupe state; no silent state reset. |
| `DMV1-019` | Replace the recovery root with an unconfirmed fingerprint. | Hold contact update. | Old locally pinned recovery head remains; no new recipient authority or route is trusted. |
| `DMV1-020` | Replace the root, compare the exact successor fingerprint independently, and authenticate the new genesis registry. | Accept candidate replacement only after ceremony. | Monotonic pin advances exactly once; old authority/device state is retired according to the reviewed recovery protocol. |

## Known-answer vector gate

Independent reviewers must select/approve the exact canonical encoding and
signature/profile first. Then add generated static vectors (not runtime
self-generated expectations) for:

1. `operation_bytes`, `operation_digest`, sender device signature, and exact
   kind-14 rumor id for `DMV1-001`;
2. first delivery-envelope bytes/signature, NIP-59 seal and wrap ids, exact
   outer tags and ciphertext byte length;
3. a second envelope over the same immutable operation digest, including the
   required changed bytes and stable bytes;
4. initial prekey/session handshake, ratchet ciphertext, state serialization
   digest, and restart restore;
5. each rejected mutation from `DMV1-002` through `DMV1-020`, with a state
   digest proving no partial transition.

The current staged prototype has helper tests for several of these semantic
properties, but they are not v1 candidate vectors. The local NIP-01 capture
artifact is transport evidence for the existing NIP-44 app path and an isolated
R5 fixture; it is not a cryptographic known-answer vector.
