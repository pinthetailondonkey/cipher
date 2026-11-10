# DM test profile v1 (protocol-test DM wire, frozen for review)

Status: TEST-PROFILE SPECIFICATION. This freezes the byte-level shape of the
protocol-test DM mode so vectors and a second verifier can be built against one
document. It is **not** an approved production policy, not a claim of anonymity,
and not a parity claim against SimpleX, Session, or any other messenger. Every
choice a reviewer still has to confirm is marked "canonical encoding:
reviewer-open" or tagged REVIEWER-OPEN inline. Production DMs stay on
`useNIP44DM.js` and NIP-44/NIP-59 as shipped; this profile governs only the
test artifact path built under `src/lib/protocolTestDm/`.

Decisions cited: §2 items 1, 2, 3, 5 of the protocol build plan v2, broken items
3, 4, 5, 6, infrastructure I7, decision D1 and D3 defaults, D4 first-contact
default.

## 1. Layer stack

| Layer | Kind | Signed by | Visible to relay |
| --- | --- | --- | --- |
| Operation plaintext | not an event | - | nothing |
| Kind 14 rumor | 14 | unsigned (rumor) | nothing |
| Seal | 13 | sender device key Di | kind, id, pubkey = Di |
| Wrap | 1059 | random ephemeral wrap key | kind, p tag, ciphertext |

- The outer event the relay accepts is a NIP-59 gift wrap of kind `1059`,
  signed by a fresh random key that is never reused and never stored beyond the
  send attempt.
- Inside it, encrypted with NIP-44 v2 to the recipient's route key, sits a kind
  `13` seal signed by the sender device key Dᵢ. The seal signature IS the
  device signature (plan §2 item 2): there is no separate `device_sig` field
  and no custom signing-bytes rule over delivery objects.
- Inside the seal is an unsigned kind `14` rumor whose content is the
  route-key-encrypted Olm session payload. Routing metadata (operation id,
  session id, from-device, to-device, operation digest) travels INSIDE the
  Olm-encrypted payload so the Olm MAC authenticates it (plan §2 item 3), not
  in any relay-visible field.
- The p tag of the wrap carries the per-contact, per-device ROUTE PUBKEY only.
  No account key N and no stable device key ever appears in a relay-visible tag
  (plan §2 item 5). REVIEWER-OPEN: route length pins at >=128 bits of entropy;
  the exact derivation of route keys from contact secrets is lane R work and is
  out of scope here; this profile fixes only that the p tag names a route.

## 2. Device certificate and pinned registry head

Send-time freshness gate (plan §2 item 1, broken item 3): the send attempt may
proceed only when ALL of these hold at send time:

1. The sender holds a locally authenticated authority checkpoint (policy event +
   registry head chain, never a bare relay snapshot).
2. The pinned registry head age is within REGISTRY_MAX_AGE_SECONDS (D3).
3. The target device is listed `active` in that head.
4. The freshly connected relay socket has passed NIP-42 AUTH for the sending
   route identity immediately before send.
5. The event carries, inside the sealed layers, a DEVICE CERTIFICATE signed by
   primary authority A referencing the pinned registry head at send time.

Device certificate format: a Nostr event of kind `30085` (`device-certificate`)
signed by A with tags `[d, device-certificate-v1]`, `[head, <registry-head-id>]`,
`[p, <sender-device-pubkey>]`, and content JSON
`{"v":1,"device":<Di>,"registryHead":<head-id>,"sentAt":<unix seconds>}`. The
receiver verifies the certificate signature, matches the cited head to its own
pinned successor chain, checks `sentAt`, and applies the revocation cutoff.

TEST-PROFILE DEFAULTS ONLY, NOT APPROVED PRODUCTION POLICY:

- D1 revocation grace: REVOKE_GRACE_SECONDS = 300 (five minutes). Messages whose
  authority-signed send time is after the target device's revocation effective
  time plus this skew are rejected at receive; earlier sends are delivered.
  This is a product choice recorded here as a test default only.
- D3 registry max age: REGISTRY_MAX_AGE_SECONDS = 86400 (24 hours) applied to
  the SEND-time pinned head. A vector encodes rejection when the cited head is
  staler than this. OWNER DECISION 2026-11-10: 24 hours confirmed as the
  chosen production default (docs/OWNER-DECISIONS-2026-11-10.md #3).

Both constants carry the owner's 2026-11-10 selections (D1 five minutes,
D3 24 hours) as production-policy defaults; independent review may still
challenge the values, but they are no longer owner-pending.

## 3. Operation plaintext canonical encoding

The operation plaintext is a JSON object canonicalized before hashing. The
profile implements RFC 8785 JCS restricted to the value classes below; anything
outside them makes encoding FAIL CLOSED rather than guess.

Canonically encodable value classes (exact list):

- object keys: strings sorted by UTF-16 code unit order (the JCS sort), escaped
  exactly as JSON.stringify escapes except no key may contain unpaired
  surrogates or control characters other than those stringify itself escapes.
- strings: any string JSON.stringify can emit; REVIEWER-OPEN whether lone
  surrogates should be refused outright even though stringify emits \uXXXX
  escapes for them.
- numbers: safe integers only (-9007199254740991..9007199254740991),
  rendered via JavaScript number-to-shortest-string (JSON.stringify semantics);
  plus decimal strings carried AS STRINGS (quoted), so money amounts ride as
  `"0.500000000000"` style values and never as floats. REVIEWER-OPEN: whether
  exponent-notation integers produced by stringify (e.g. 1e21 boundary, above
  the safe range anyway) need an explicit refusal clause; this profile refuses
  any number outside the safe integer range at encode time.
- booleans true/false, null.
- arrays of any canonically encodable value, in array order.
- bytes/binary fields are represented as lowercase hex strings by the caller;
  JCS itself does not encode raw bytes.

The digest of an operation is SHA-256 over the canonical UTF-8 bytes of the
operation plaintext object WITHOUT any envelope, timestamp, or padding fields.

**Canonical encoding: reviewer-open.** Reviewer must confirm the value-class
restriction, the sort rule, hex-for-binary convention, and digest domain
separation before this becomes v1 final.

## 4. Dedupe key

Dedupe key is `(sender device id/pubkey, operation id)`. It is COMPARED BY
DIGEST: the stored journal keeps the SHA-256 digest of the dedupe tuple bytes
(`<deviceId> || ':' || <operationId>` UTF-8) and receivers compare digests, never
event ids, rumor ids, or wrap ids. Rules:

- Same tuple + same digest = duplicate: apply the application effect once, do
  not advance the ratchet again.
- Same tuple + different digest = protocol conflict: reject and record conflict,
  preserve the prior journal entry (semantic case DMV1-009).

Event/wrap ids are irrelevant to dedupe because a retry re-sends identical
bytes with identical ids anyway; the point of digest comparison is to catch an
envelope that changed while claiming the same operation.

## 5. Receive-side verification order

Fixed, fail-closed order. Each step runs fully before the next; any failure
stops processing with no state change.

1. Outer wrap: parse event, verify event structure. Verify it is kind 1059 with
   exactly one p tag naming a locally held route key. Decrypt NIP-44 layer with
   the route secret. Failure = drop silently.
2. Seal: verify it is kind 13, verify the NIP-01 event signature of the seal
   against its own pubkey (= claimed sender device Dᵢ). Signature failure =
   reject. Then decrypt the seal layer to recover the rumor.
3. Rumor: verify kind 14 and non-empty content.
4. Inbound session init mode: ONLY Olm v2 init messages are accepted. Any
   inbound v1 pre-key/init message is rejected outright (broken item 6).
   REVIEWER-OPEN: vodozemac remains =0.11.2 with experimental-session-config;
   the v2 mode stays on the review list until the §7 stop condition clears.
5. Device certificate: verify certificate signature (primary authority A),
   verify the cited registry head resolves on the receiver's locally pinned
   chain, verify head age <= D3 window for LIVE acceptance gating of NEW sends
   and <= the same window on receive for new sessions, and verify the target
   device was active at that head.
6. Revocation cutoff (D1): reject if the authority-signed send time exceeds the
   device's revocation effective time + REVOKE_GRACE_SECONDS.
7. Olm decrypt on a CLONE of the session state; commit state and inbound
   journal row together only after steps 8-10 pass.
8. Plaintext binding: recompute the operation digest from the recovered
   operation plaintext and compare with the digest bound inside the Olm
   payload. Mismatch = reject (DMV1-002 family).
9. Dedupe check per §4, compared by digest.
10. Application effect dispatch, exactly once.

## 6. Retry / resend semantics

While a committed send attempt is uncertain (relay OK not yet observed):

- Retry resends the IDENTICAL BYTES of the already-signed event: same id, same
  sig, same content, same created_at. Never re-encrypt, never re-sign, never
  refresh timestamps (DMV1-013).
- Expired attempts hold instead of mutate: no event mutation, no proof
  extension (DMV1-016); a new attempt requires a reviewed refresh envelope
  carrying the SAME operation digest (DMV1-017 behavior is reviewer-open).
- The ratchet advances exactly once per operation, before first publish.

REVIEWER-OPEN: maximum number of identical-byte retries before surfacing
"not confirmed" to UI wording (D6 wording approval pending).

## 7. First contact and verified-pin bundle

D4 default as amended by OWNER DECISION 2026-11-10 (#5): verified QR or
out-of-band code is the IMPLEMENTED path today; @ name-based discovery is an
approved REQUIREMENT TARGET to be added later without publishing an
account-to-route directory (Gate B constraint recorded in
OWNER-DECISIONS-2026-11-10.md). Until that discovery mechanism exists and is
reviewed, no public bundles are published to relays and first contact stays
verified-pin only. The verified-pin bundle constructed during first contact
carries exactly:

1. the contact's current route pubkey,
2. the device certificate signed by primary authority for the receiving device,
3. one one-time key (public half) for Olm session establishment.

Further one-time keys arrive later as route-addressed wraps; recipients keep
private one-time keys until session confirmation or a retention limit passes
(limit value REVIEWER-OPEN). Duplicate initial messages dedupe by operation id
per §4. Offline first-contact exchange happens through the local relay fixture
in Phase 3 tests.

## 8. Freshness envelope for retry after expiry

This section defines the ONLY canonical `freshnessEnvelope` shape (the format
section 6 referenced as "a reviewed refresh envelope carrying the SAME
operation digest" but left undefined; it is now frozen here).

Shape decision, frozen exactly ONE form:

- The envelope is a JSON object carried INSIDE the Olm-encrypted payload of the
  redelivered operation, under the payload key `freshnessEnvelope`, next to the
  existing payload fields (`olmVersion`, `opId`, `sessionId`,
  `operationDigestClaimed`, `operation`). It is NOT a separate kind 13-sealed
  event inside its own kind 1059 wrap and it is NOT an open rumor field.
  A separate signed-event envelope was considered and REJECTED as out of scope
  (it would double the anonymous-transport surface and require new wrap keys).
- Authentication is BY CONSTRUCTION: the envelope rides inside the Olm
  MAC-protected plaintext, so any mutation breaks Olm decryption first.
- Binding: the receiver recomputes SHA-256 over the JCS bytes (section 3) of
  the recovered operation plaintext and compares with BOTH the payload's
  `operationDigestClaimed` AND the envelope's `opDigestHex`. All three digests
  must be byte-equal (sha256 hex64, lowercase).

Canonical envelope object (presented in JCS key order per section 3):

```
{
  "v": 1,
  "opId": "<operation id>",
  "opDigestHex": "<sha256-hex64 of the operation plaintext, section 3 rules>",
  "issuedAt": <safe non-negative unix seconds>,
  "notAfter": <safe non-negative unix seconds, >= issuedAt>,
  "boundTarget": { "senderDeviceId": "<device pubkey>", "recipientRoutePubkey": "<route pubkey>" }
}
```

Rules (fail closed):

- Non-safe-integer or negative timestamps refuse with reason
  `envelope-shape`; a digest that is not lowercase hex64 refuses the same way.
- An envelope whose parsed key insertion order is not the JCS sort refuses
  with reason `envelope-shape` (it cannot reproduce its own canonical bytes).
- Receiver verification reasons are the STABLE STRINGS: `envelope-shape`,
  `digest-mismatch` (opId or opDigestHex disagrees), `target-mismatch`
  (boundTarget sender/route disagree), `envelope-expired` (notAfter < now).
- BOUNDARY: `notAfter == nowSeconds` at check time STILL VERIFIES; strictly
  earlier expires.

Redelivery acceptance rule that resolves R5-B ("two valid envelopes"):
When a received operation's tuple `(senderDeviceId, operationId)` matches an
existing journal entry AND the recomputed operation content digest equals the
stored entry's digest, the receiver may accept the redelivery as a duplicate
EVEN IF the original certificate or D3 checks would now fail at receive time,
PROVIDED (a) steps 1-4 still pass identically (wrap/seal/rumor/Olm-v2 mode
are verified on every delivery), and (b) whenever the payload carries a
`freshnessEnvelope` field, the envelope verifies per this section against
NOW (issuedAt/notAfter, target binding, digest equality); invalid present
envelopes reject at step 9 with reason `redelivery-freshness-rejected`.
Without a `freshnessEnvelope` field the pre-envelope duplicate-suppressed path
applies unchanged (only one valid envelope interpretation exists because the
payload itself binds everything else via the Olm MAC).

DEDUPE LIFETIME (owner-confirmed 2026-11-10, docs/OWNER-DECISIONS-2026-11-10.md #7): Profile freeze: the dedupe record
defined here lives exactly as long as the inbound journal row AND local
history retention, i.e. dedupe record lifetime == inbound journal lifetime ==
local history retention (forever, tied to history retention). This is
intentionally ONE lifetime value to avoid two-valid-envelope windows (R5-B);
when retention changes, dedupe coverage changes with it. Independent review
still confirms this equivalence before v1 final.

## 9. Receive-time offline semantics

Applies at RECEIVE time (receipt moment) regardless of connectivity state:

1. The D3 stale-head check applies ONLY when held device certificates are
   provided to the step-5 gate (new-session gating). When the receiver holds
   no certificate map for offline replay, steps 5-6 certificate/D3 gating is
   skipped because there is nothing locally pinned to check against.
2. For a DUPLICATE redelivery path (tuple matches an existing journal entry,
   per section 4 compared by digest): the certificate/D3 checks MAY BE
   SKIPPED because the operation was already accepted once under whatever
   freshness rules were live then; dedupe decides. A conflicting digest under
   the same tuple still REJECTS (DMV1-009 preserved; never overwritten by
   envelope-or-offline allowances).
3. Step-8-then-step-9 order is NEVER reordered by these allowances: the
   plaintext binding digest recompute must still succeed BEFORE dedupe.
4. OFFLINE caveats are NOT a bypass rule: FIRST-TIME messages (no matching
   journal tuple) MUST STILL pass every numbered step of section 5 including
   steps 5 and 6 exactly as written. These offline semantics only relax what
   happens AFTER an operation has already been accepted once and only when
   the stored evidence permits it. No first-time message reaches dedupe or
   duplicate suppression without full certificate + revocation evaluation
   whenever such checks would apply live.

## 10. What this document does NOT claim

- No anonymity claim of any kind; §6 captures exist nowhere yet.
- No IP-protection claim; web stays IP-visible to the mailbox relay (D5) until
  forwarder evidence exists.
- No SimpleX/Session parity claim.
- No production approval: every constant here is a TEST-PROFILE DEFAULT and
  changes owner-side decisions (D1, D3, D4 confirmation) remain open.
- No claim that vodozemac Olm v2 is approved; it is an experimental crate
  feature under review (stop condition §7 of the plan).

## 11. KAT relationship

Vectors live in `test-vectors/dm-v1/`, generated by `scripts/gen-dm-kat.mjs`
from fixed seed constants only, byte-identical on rerun. Independent
verification: `scripts/verify-dm-kat.mjs` re-derives everything from the vector
data alone. Independence caveats are stated honestly in that file's header.
