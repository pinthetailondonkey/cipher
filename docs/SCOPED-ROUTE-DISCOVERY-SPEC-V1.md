# Scoped route keys and @ name discovery — SPEC-V1 (design candidate for independent review; test profile only)

Status: DESIGN CANDIDATE. Frozen for independent review only. Nothing here is
implemented in any production path; the primitives land under
`src/lib/protocolTestGateB/` as TEST-ONLY pure functions with KAT vectors. This
document makes no anonymity claim; it states mechanisms, their honest limits,
and what remains REVIEWER-OPEN.

Resolved tension cited: OWNER DECISIONS 2026-11-10 #5 (first contact must
support BOTH verified QR AND @ name lookup) against the Gate B hard constraint
("never publish an account-to-route directory"), recorded honestly in that
document's Gate B interaction warning.

---

## 1. Scoped route keys

### 1.1 Shape

Every contact-pair/device/direction gets an independently random-looking
256-bit route secret. The value placed in the NIP-59 wrap `p` tag is a BLIND
TAG derived from that secret, never the secret itself and never the account key.

Freezes (primitive layer, see `routeKeys.js`):

- `deriveRouteSecret({ contactSecret, deviceIdBytes, directionByte })`:
  HKDF-SHA256 with salt = `deviceIdBytes`, info =
  `"cipher-route-v1|dir=" || directionByte`, over input key material
  `contactSecret` (>=128 bits). Output: `routeSecretHex` (32 bytes = 256 bits,
  exceeds the >=128-bit Gate B floor with margin for reviewer reduction) and
  `blindTagHex` = SHA-256 over `"cipher-route-blind-v1" || routeSecret` (the
  actual `p`-tag value, 32 bytes).
- Direction bytes frozen here: `0x01` sender-to-recipient, `0x02`
  recipient-to-sender. Directions are independently derived, so observing one
  direction's tag reveals nothing derivable about the other.
- Per-contact `contactSecret` distribution: carried inside the verified-pin
  bundle (out of band, QR or code), never relay-visible. REVIEWER-OPEN: whether
  the contact secret is single-use per device pair or pooled across a contact's
  devices; the frozen primitive is per (contact, device, direction).

### 1.2 Rotation

`rotateRouteSecret(prevSecretHex, rotationCounter)` = SHA-256 domain-separated
chain: `next = SHA-256("cipher-route-rotate-v1" || prevSecret || LE64(counter))`,
then re-derive the blind tag as in 1.1. Rotation is deterministic and
countered, so both sides converge offline. Rotation cadence and revocation
propagation window are REVIEWER-OPEN (owner decision pending on cadence).

Revocation propagation: a revoked device's route tags stop being honored when
the receiver's pinned registry head (DM-TEST-PROFILE-V1 section 2) shows the
device revoked; the receiver stops acknowledging on the old route and the
sender learns rotation only through an authority-signed registry update pulled
from the registry head chain. Relays see only blind tags and can never map a
revocation to an account: the revocation event names the DEVICE key inside the
authority chain, not the route tag. REVIEWER-OPEN: how long a sender may keep
publishing to a stale route before the connection-level freshness gate forces
recovery.

### 1.3 Relay-visible field walk (hard-constraint proof)

For an ordinary DM wrap routed by this spec, every relay-visible field:

1. Wrap `pubkey` (author): fresh random ephemeral wrap key, never reused,
   never stored beyond the send attempt (inherited from DM-TEST-PROFILE-V1
   section 1). Not account, not device, not stable.
2. Wrap `p` tag: blind tag of the scoped route secret. Entropy 256 bits;
   uncorrelated across contacts, devices, and directions; unrelated to the
   account key or the discovery handle.
3. Wrap `created_at`: backdated per existing NIP-59 practice; no new field.
4. Wrap `id`/`sig`: over the random wrap key; no account linkage.
5. Event content: NIP-44 to the route key; relay sees ciphertext only.
6. No `account-to-route` artifact exists anywhere: the only public discovery
   surface is the handle-blind-tag event of section 2, which binds handle
   blind tag to a ROUTE capability, not to the account key. The account key
   appears only inside the already-sealed verified-pin bundle delivered
   out of band.

Therefore the account key never appears in an ordinary DM route tag. What a
relay CAN still learn (stated honestly): per-blind-tag delivery frequency,
timing, and sizes (Gate C measurement work), and that two tags sharing a
wrap-connection operator view belong to the same client (Gate B collusion
test).

---

## 2. @ name discovery WITHOUT an account-to-route directory

### 2.1 Candidate evaluation

Three candidates evaluated. Tradeoff tables state the honest costs.

**Candidate A — capability-token discovery blob (handle-blind-tag addressed,
encrypted discovery blob).**

| Property | Assessment |
|---|---|
| Account-to-route directory | None published. Public event binds blindTag -> encrypted blob containing a ROUTE capability, never the account key. |
| Enumeration resistance | Attackers never learn the handle salt from the wire; a guessed handle cannot even be tested against a published tag without the salt. Enumeration cost = acquiring the salt out of band (QR), same trust step as first contact already requires. |
| Availability | Fully relay-based once the blob is published; works offline like any Nostr event. |
| Spam resistance | Publisher-side rate limits via per-discovery-key signing; see 2.3. |
| Trust assumptions | Relay sees blind tags only; operator cannot invert SHA-256(handle,salt). |
| Main cost | Handle salt must travel out of band (inside the verified-pin bundle) — @ lookup then complements, not replaces, QR first contact. |

**Candidate B — relay-side private namespace service (dedicated kind +
NIP-style query).**

| Property | Assessment |
|---|---|
| Directory | The operator's namespace index IS a handle-to-route-pointer directory, just operator-held instead of publicly published. Gate B is satisfied in letter (nothing published) but concentrates trust in an operator who can enumerate, correlate, and de-platform handles. |
| Enumeration resistance | Depends entirely on operator honesty; unprovable in the Gate E evidence model. |
| Availability | Single-service failure/outage modes; requires new operator-side service with no existing protocol support. |
| Honest statement | Requires trusting one operator with a global handle->route map; collision and takeover policy become operator policy. |

**Candidate C — social-graph transitive introduction (contacts attest
introductions signed by device keys).**

| Property | Assessment |
|---|---|
| Directory | No directory at all; introduction events travel contact-to-contact. |
| Availability cost | First contact cannot bootstrap (no contacts yet); discovery latency grows with graph distance; a contact who refuses to attest blocks reachability. Reachability becomes a function of social graph position — an availability failure mode, and a new correlation surface (introduction events carry contact-visible handles). |
| Enumeration resistance | Strong against relays, but each hop's contact learns the introducee's handle. |

**Recommended: Candidate A.** It is the only candidate that is both
relay-available without a trusted operator (vs B) and bootstrappable without
pre-existing contacts (vs C), while keeping zero account-key linkage in any
published field. B is recorded as the fallback if review rejects the
out-of-band salt requirement; C is recorded as a complement for recovery
introductions, not as the discovery path.

### 2.2 Frozen event shape (Candidate A)

Discovery blob event, kind `30090` (`cipher-discovery-blob-v1`):

- Signed by a dedicated per-handle DISCOVERY KEYPAIR (curve/seal identical to
  the wrap key family). The discovery public key is distributed inside the
  verified-pin bundle. It is NOT the account key and NOT the device key;
  the account key never appears in the event.
- Tags: `["d", <blindTagHex>]` where
  `blindTagHex = SHA-256("cipher-discovery-blind-v1" || handleLowercaseUTF8 || saltHex)`,
  `saltHex` being a random 128-bit per-handle salt generated with the handle.
  Optional `["expiration", <unix>]` to bound stale blobs.
- Content: NIP-44 encrypted to the CURRENT route public key, containing
  exactly the verified-pin bundle payload of DM-TEST-PROFILE-V1 section 7
  (route pubkey, device certificate, one OTK public) plus
  `{"v":1,"kind":"cipher-discovery-blob-v1","seq":<n>}`.
- `seq`: monotonically increasing per blind tag; receivers accept only the
  highest seq, so a replayed older blob cannot roll a handle back.
- Canonical bytes: REVIEWER-OPEN (JCS-style canonicalization reused from
  DM-TEST-PROFILE-V1 section 3 is the intended basis; the exact byte
  serialization of kind 30090 awaits the same review pass).

Spam resistance and rate limits (TEST-DEFAULTS, all REVIEWER-OPEN in value):
one blob per blind tag per seq bump; receivers ignore unsolicited blob events
outside an active lookup by more than MAX_BLOB_AGE (default 7 days); lookup
clients batch queries to at most one relay per rotation epoch. Relays may rate
limit kind-30090 publishes per discovery key (default burst 10/hour); because
the discovery key is per-handle, mass-publishing requires one key per handle,
bounding cheap spam.

Handle uniqueness/conflict: handles are NOT globally reserved. Uniqueness is
only (handle, salt) pair — two users may pick the same handle with different
salts, both published without collision. This deliberately trades global
uniqueness (a directory property) for the absence of a directory. Conflict
resolution between identical (handle, salt): seq comparison on the same blind
tag; last-published-highest-seq wins and takeover requires knowing the salt.

Takeover/recovery when a handle is lost: the salt is the capability. Losing
the handle is not losing the identity — routes and the account are untouched;
recovery = publish a NEW (handle, salt) pair under a NEW discovery key and
redistribute it via the verified-pin path. An attacker who captures the old
(handle, salt) can keep publishing blobs for the OLD blind tag, but receivers
holding the pinned discovery key reject unknown keys, and stale blobs expire by
MAX_BLOB_AGE. A hostile (handle, salt) pair publish cannot hijack a route the
attacker does not already hold.

Enumeration analysis (honest numbers): with the salt out of band, an attacker
observing a blindTagHex gets a 256-bit tag with zero testable structure;
offline dictionary guessing over the handle space succeeds only given the salt,
which requires either a compromised contact share (the same compromise that
already leaks the QR bundle) or ~2^(handle bits) attempts against nothing
testable. If an operator EVER publishes a (handle, salt) directory — including
leaking salts through query timing — dictionary enumeration becomes computable
at ~10^5–10^6 guesses/second for short handles, so handle length >=12
characters with mixed classes is the minimum the protocol should encourage.
This risk is the honest tension with decision #5's "searchable" framing:
searchability is client-side over distributed salts, not relay-side over a
public namespace.

### 2.3 Sender IP protection boundary statement

Per the forwarder prototype (`scripts/forwarder-perhop-test.mjs`, evidence
label "partial, web-forwarder evidence pending two-operator tests"): the ENTRY
hop sees the origin's source IP and the destination capability must be hidden
from it; the mailbox hop sees the destination capability and only the
forwarder's listening-socket identity, never the origin IP. Concretely frozen
for review:

- ENTRY hop: sees source IP of the sender; sees frame sizes and timing; must
  NOT be handed the destination blind tag (the wrap's `p` tag travels
  encrypted to the forwarder's egress path — REVIEWER-OPEN how a
  non-websocket entry transport, e.g. Tor onion, satisfies this without the
  loopback assumption the current prototype tests).
- MAILBOX hop: sees the destination blind tag and the sender's
  forwarder-assigned address; must NOT see the origin IP (demonstrated at
  loopback by the per-hop capture asserting `mailbox sees loopback only` and
  no origin source-port leak).
- One operator alone (entry XOR mailbox) must not learn both endpoints; entry/
  mailbox collusion and timing correlation remain UNMEASURED and are Gate C
  test subjects, not solved here.
- Unmeasured/remaining: real two-operator public-relay captures, multi-network
  correlation, per-hop latency correlation, and whether a non-colluding entry
  forwarder at Internet scale can be found or must be self-hosted.

---

## 3. Primitive layer and REVIEWER-OPEN register

`src/lib/protocolTestGateB/routeKeys.js` implements sections 1.1-1.2 as pure
functions with colocated fixed-seed KATs. REVIEWER-OPEN items left unfrozen by
intent: rotation cadence, revocation propagation window, discovery-blob byte
canonicalization, MAX_BLOB_AGE and rate-limit values, contact-secret device
pooling. None of these blocks the primitive KATs, which freeze only the hash/
HKDF derivations above.

Limits: primitive-level KATs only. No anonymity claim is made or achieved by
this document; Gate C measurement and independent review are prerequisites for
any such claim.
