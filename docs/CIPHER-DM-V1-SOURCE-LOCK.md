# Cipher DM v1 source lock

Status: incomplete review evidence. This file distinguishes exact local
dependency locks from upstream protocol documents that are still moving
references. It does not select the v1 wire profile.

## Local dependency versions

| Component | Locked value in the current tree | Evidence and limitation |
|---|---|---|
| `vodozemac` | `0.11.2` | Exact `=0.11.2` in `crypto/ratchet-wasm/Cargo.toml`; `Cargo.lock` registry checksum `cafdb6875115a436251b280d741286a9cec7fc4daab0588ea26481dd8e2bab2f`. The published crate's `.cargo_vcs_info.json` identifies source revision `fb4a9980a1038c646824ea7e64567eec28bf582e`. Its Olm v2 config is behind the crate's `experimental-session-config` feature; this remains a candidate, not an approved profile. |
| `wasm-bindgen` | `0.2.128` | Exact Cargo dependency pin; also the required CLI version in the build script. |
| `serde-wasm-bindgen` | `0.6.5` | Exact Cargo dependency pin. |
| `serde_json` | `1.0.151` | Exact Cargo dependency pin. |
| `nostr-tools` | `2.25.2` | Exact manifest and lockfile pin; `package-lock.json` resolves this tarball with integrity `sha512-7JAx+brEPmqGz1yzaK9MOxvis/Nl1B38j9hVsBSRDMRmxk5XSc0+5LlPEYbzeiUyk41RURBDcfuMzmaT754HAg==`. This is the existing app library, not a selected Cipher DM wire profile. |

## Upstream protocol documents

The candidate currently cites NIP-01, NIP-17, NIP-44, NIP-59, and NIP-65 at
`nostr-protocol/nips` branch URLs. These are not immutable source pins. The
review on 2026-11-09 checked the upstream NIP-44 and NIP-59 text and found an
encapsulation gap recorded in `docs/DM-RATCHET-DESIGN.md`: NIP-59 requires
NIP-44 encryption of serialized JSON events, while the candidate does not
specify the encryption algorithm or exact NIP-44 input/output layers. Its
device-signed seal may be compatible as an authorized Nostr device author, but
the account mapping must be explicit and reviewed.

I attempted `git ls-remote` for the NIPs and vodozemac repositories to record
exact commit ids, but this environment could not resolve `github.com`. The web
read used to inspect the primary NIP text exposed branch pages, not immutable
commit ids or raw-file hashes. Therefore the NIP source revisions and hashes
are **not pinned**. Do not treat the 2026-11-09 inspection date as a version.
Before external review, resolve the exact NIPs repository commit, record its
full commit id and the SHA-256 of every cited file, and archive those files in
the review packet. The local `vodozemac` crate is exact-version and checksum
pinned by Cargo, but the WASM build still needs reproducibility evidence.

## Signature and wire-profile status

The authority prototype's device credentials are secp256k1 Nostr keys, and
existing device enrollment signs Nostr events with those keys. That does not
by itself define a signature over an arbitrary operation or delivery object.
The candidate's `device_sig` field, canonical object encoding, domain
separation, event-signing relationship, and envelope refresh signature remain
unselected. NIP-01's event signature is not a generic signature primitive for
an unspecified byte string. The NIP-59 mismatch must be resolved before the
operation and delivery signatures can be frozen.

No static Cipher DM cryptographic known-answer vectors were generated. Doing
so before the wire transport, canonical encoding, signature profile, and
ratchet mode are selected would create vectors for a guessed protocol. The
existing semantic manifest remains useful for state-machine review but is not
an interoperability vector set.

### Local implementation evidence (2026-11-09)

The pinned adapter's Rust tests passed `npm run test:ratchet` (7 tests). The
existing headless Chromium test passed `npm run test:ratchet-browser` after
building with the pinned `wasm-bindgen 0.2.128`. These tests exercise actual
vodozemac Olm v2 account/session behavior: prekey setup, bidirectional
ratcheting, bounded out-of-order receive, duplicate rejection, excessive-gap
rejection, encrypted pickle restore, and post-compromise recovery. They are
behavior tests with runtime-generated keys, not static cryptographic
known-answer vectors and not a test of Cipher's Nostr wrapper or app/IndexedDB
integration.

The local adapter source snapshot used for those checks is identified by:

| File | SHA-256 |
|---|---|
| `crypto/ratchet-wasm/src/lib.rs` | `166d0e22ab70b41f9bc2c2868b73c08bcc255c48bd36ef68441b141bfaadecb6` |
| `crypto/ratchet-wasm/Cargo.toml` | `e1351281a6a80390db065de443a8c7446f993878987c4871859650c00f54b3d5` |
| `crypto/ratchet-wasm/Cargo.lock` | `88fd7ddbfe3a202bf542857df5452fb277914387369c94fc401f73abd5bf1cc1` |
| `scripts/build-ratchet-wasm.mjs` | `353d18a0d2764ca4c619618238734c27a94dcaf65f9c1aeacb738a2ec69ea1e9` |
| `scripts/ratchet-browser-test.mjs` | `ef84687b5bfc73dd1507d66b391dc0bf3f189548daf5c6fd2a8e8fd96a5da739` |

The existing adapter is not called by `protocol-test.html`; no test-mode event
is sent. Cipher KAT generation remains blocked pending independent selection of
the transport/wrapping profile, signature and canonical-byte rules, expiry and
retry envelope semantics, and approval of the experimental Olm v2 mode. Do
not substitute the library's randomized round-trip tests for those vectors.

## Relay-visible surface to include in the final vector/capture packet

At minimum, record the NIP-01 event fields visible to the accepting relay:
`id`, `pubkey`, `created_at`, `kind`, `tags`, `content` ciphertext and length,
and `sig`. Also record the full `REQ` filter fields (`kinds`, `authors`, `#p`,
`since`, `until`, `limit`, and any custom filters), relay URL, connection IP,
socket timing, event size, ACK/refusal, reconnects, and any NIP-42 AUTH exchange.
For a custom transport, identify which of those fields carry `N`, `D_i`, or a
scoped route, and whether the query or AUTH event separately links the relay
connection to the stable account. `docs/evidence/cipher-dm-local-nip01-relay-capture-2026-11-09.json`
is only a legacy NIP-44/NIP-59 app-path baseline plus an isolated synthetic R5
retry fixture; it is not a ratchet capture.

## Provisional privacy-first recommendation (not product-approved)

The engineering default to take into review is: no account-key fallback;
require exact pinned authority and an active target device; hold when proof is
expired or the recipient authority cannot answer; require a separately
verified first-contact route; use one target-device route per delivery; and
after an uncertain acknowledgement retry only identical committed event bytes
while that attempt is valid. Expired attempts remain held until a reviewed
refresh envelope can reuse the same authenticated operation digest without
ratchet advancement.

This choice reduces stale-revocation, first-contact discovery, account-route,
and duplicate-effect exposure. Its cost is substantial unavailability: offline
recipients, offline authorities, and delayed relay delivery can remain pending;
users may need to complete a separate verified contact step; and an event
stored past proof expiry cannot be accepted without a new, reviewed envelope.
Maximum offline age, tolerated clock skew, dedupe/backup retention, first
contact availability, and retry UX remain user/product choices. This
recommendation is not approval to impose those costs on users.
