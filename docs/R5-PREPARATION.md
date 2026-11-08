# R5 security preparation: device freshness and migration boundary

Status: isolated prerequisites only. The production DM path remains
NIP-44/NIP-59. This work does not enable ratchet sends or reads in
`useNIP44DM.js`, migrate stored messages, or claim vodozemac's experimental
session mode is production-ready.

The account-key-authorized v1 device registry and freshness design described
below are superseded as a proposed trust model by
[`DEVICE-AUTHORITY-DESIGN.md`](./DEVICE-AUTHORITY-DESIGN.md). They remain in
the codebase for existing prototype tests and are not safe as production
revocation authority while the shared account secret can exist on multiple
devices. The v2 independent R/A/D foundation is isolated and has no application
or relay call sites.

## Review of the six reported findings

The six cases were checked against the helper and storage paths used by the
R5 prototype. Regression tests were first run against the vulnerable local
implementation: the six new assertions failed (12 of 18 checks passed). The
repaired focused suite now passes.

| Finding | Reproduced behavior | Isolated correction |
| --- | --- | --- |
| Stale device registry | A signed but old account registry could accompany a device bundle; a relay could withhold the newer generation. | `verifyDmRatchetBundleEvent()` and `selectDmRatchetPrekey()` require a fresh, nonce-bound response signed by the account authority, matching the device and minimum locally held generation. |
| Expired prekeys | A bundle with a very old event time could use a distant expiry and remain acceptable. | Bundle event time and expiry are bounded to a seven-day window; new bundles with later expiry are rejected. |
| Legacy bundle bypass | An account-signed v2 record could be accepted as a new-session bundle, bypassing the independently enrolled device signer. | The new-session verifier accepts only v3 bundles signed by the enrolled device key and backed by a fresh authority response. Historical records are not rewritten or used to authorize a new ratchet session. |
| Credential overwrite | Ratchet account pickle publication replaced the enrolled device row, which also stored its signing credential. | Device publication and initial prekey consumption preserve the credential and place the ratchet account pickle in a separate field inside the same sealed row. |
| Accidental session reset | A repeated initial-prekey path could replace an already established session id. | Initial-session setup checks the session id inside the same IndexedDB transaction and uses compare-and-swap; a concurrent loser gets `RatchetStateConflict`. |
| Revoked-device pending access | Pending inbox plaintext could be opened without proving the local device was still active; pending outbound ratchet messages had no recipient-freshness expiry. | Inbox opening now requires a fresh authority proof made by the active local device credential. Ratchet outbox rows are held after the proof expires, including forced retries, until the same device is freshly authorized again. A refresh only changes the authorization fence, never the event or ratchet state. |

Evidence is in `deviceFreshness.test.js`, `dmRatchetWire.test.js`,
`dmRatchetTransactions.test.js`, `deviceRegistryStore.test.js`,
`dmRatchetMigration.test.js`, and `scripts/crypto-state-browser-test.mjs`.

## Decentralized freshness prototype and trust limits

The requester signs a short-lived challenge containing a random nonce, the
authority account key and the target device id. The account authority signs a
response binding that challenge to one active device and the authority's
current registry generation. The response is intended to travel inside the
existing authenticated private NIP-59 envelope; publishing it or a registry
in the clear would expose identity and device linkage. The freshness module
does not publish or fetch records itself.

The authority must derive `currentGeneration` from its locally sealed,
monotonic registry checkpoint. A relay cannot make an older generation look
current to a correctly functioning authority. A relay that withholds the
challenge or response causes a safe hold. The prototype accepts responses for
30 seconds, then pending ratchet delivery is held. This has two unavoidable
limits:

* The account authority is a trust root. A compromised or malicious account
  key can certify a revoked device. Removing that authority requires a
  separately approved identity-recovery protocol.
* Cipher's present account secret may be available on multiple devices. A
  revoked device that retained that secret can impersonate the account
  authority and certify its own stale registry copy. Therefore this prototype
  blocks the honest local app path and holds sends without a fresh response;
  it does not defeat a malicious revoked device that still controls the shared
  account key. Production revocation requires a device-separated authority
  signing key or another explicit authority model.
* Freshness is time-bounded, not instantaneous. A device can be revoked just
  after it receives a valid response, and an event already accepted by a relay
  cannot be recalled. The prototype does not prove that a revoked device
  erased plaintext, keys, or a ciphertext it already received. A stricter
  protocol would need per-send acknowledgements/leases or an online authority
  assumption, each with availability and privacy costs.

Therefore this mechanism is fail-closed when freshness is absent under the
assumption that only a currently authorized authority can answer. It is not a
proof of instantaneous global revocation, and must not yet gate a production
protocol switch.

## NIP-44/NIP-59 migration design

1. Keep the current decoder for historical bare kind-4 events and
   NIP-59-wrapped NIP-44 rumors. Treat them as legacy reads; do not re-encrypt,
   rewrite, delete, or relabel their stored history. `dmRatchetMigration.test.js`
   constructs real legacy ciphertext and proves the existing transport decoder
   still opens attachment metadata, order fields, receipt-shaped messages and
   canonical client ids unchanged.
2. A future ratchet envelope belongs inside the existing sealed NIP-59 rumor.
   The ratchet encrypts the whole application payload, including attachment
   references/keys and commerce fields. It must retain stable event and order
   identifiers so existing message-effect and order deduplication continues
   to apply. Ciphertext attachments remain in their existing blob flow; this
   proposal does not change upload or payment formats.
3. Never infer ratchet capability from an account key or a relay roster. A new
   session requires a verified device bundle plus fresh authority response.
   Until both peers have an authenticated supported device session, new
   sensitive sends must remain locally pending with an explicit setup error;
   they must not silently use NIP-44. Existing history remains readable.
4. Do not automatically convert old messages or transfer old conversation
   keys into ratchet state. A ratchet session starts with authenticated
   per-device key establishment. Each device receives its own session; sharing
   an account key does not clone ratchet state.
5. If a device is reinstalled without a verified state backup, keep local
   legacy history that survived storage intact and establish a newly enrolled
   device session. Do not regenerate a prior device credential, restore an
   older ratchet snapshot silently, or claim recovery of erased message keys.
   Ratchet-only history not stored elsewhere may be unrecoverable.

The present production routing still exposes the recipient account pubkey in
the NIP-59 `p` tag. This prototype adds no public registry or new routing
format, but it does not close that existing DM correlation surface. Changing
recipient routing needs a separate privacy and compatibility decision.

## Candidate status and advancement gate

`vodozemac` 0.11.2 remains pinned in the Rust/WASM experiment. The adapter
explicitly selects its feature-gated experimental Olm v2 full-MAC mode. Native
and Chromium witnesses exercise initial authentication, duplicate/replay
rejection, out-of-order delivery, state restore and post-compromise recovery
after fresh authenticated DH input. These are behavior tests of the pinned
configuration, not an independent audit of the library version, the
experimental mode, the adapter, or the full Cipher message path. No production
DM call site imports the adapter.

Do not advance to live integration until Cipher approves the account-authority
trust model, device enrollment/recovery UX, recipient-device routing and
revocation race policy, and the final ratchet/library mode. A full production
integration additionally needs two independent application accounts over
Nostr, multi-device/offline delivery, key-change UX, and adversarial relay
tests. This milestone does not complete those gates.
