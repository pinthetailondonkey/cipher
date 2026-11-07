# DM ratchet design and integration gates

Status: implementation design under evaluation. No production DM wire change
is made by this document. The plan preserves Nostr relays, NIP-59 transport,
the existing account key and historical NIP-44 reads.

The adapter experiment is built with Rust and a pinned `wasm-bindgen-cli`:
install the `wasm32-unknown-unknown` target, install
`wasm-bindgen-cli 0.2.128` with `--locked`, then run `npm run build:ratchet`
and `npm run test:ratchet-browser`. The generated binding and WASM files under
`src/lib/ratchet/wasm/` are build outputs and are ignored by Git. These
prototype tools remain behind explicit `build:ratchet`, `lint:ratchet`, and
`test:ratchet` scripts; the application build, lint, and test commands do not
depend on this not-yet-integrated WASM experiment.

## Threat model and target

The ratchet is intended to protect message content against a later compromise
of an endpoint's *current ratchet state*, after old message keys and superseded
DH private keys have actually been erased. A Double Ratchet can recover future
confidentiality after fresh authenticated DH input has been mixed into the
session; it cannot help while an attacker controls an endpoint or its identity
signing key. Relays remain able to observe the NIP-59 recipient tag, event
timing, approximate size, relay/IP metadata, and traffic volume. This work does
not add anonymity routing.

This design covers the ordinary conversation path in `useNIP44DM.js`; it does
not cover the separate direct NIP-44 key-grant path in
`src/lib/crypto/groupKeyDistribution.js`. That path carries group epoch keys
and remains a security-critical legacy control channel until a separately
verified MLS Welcome/key-package transport replaces it. The ordinary DM
ratchet must not be described as protecting group-key grants, and failure of a
future MLS Welcome must not fall back to a direct legacy grant for a group
already migrated to MLS. Existing non-MLS groups still require their present
compatible key-grant path during staged migration.

The protocol must cover ordinary text, commerce/order messages, read receipts,
typing, call signaling and app control messages sent through `sendDM()`. There
must be no new-message fallback to NIP-44 when session establishment or ratchet
storage fails. NIP-44 remains decode-only for historical messages and is used
only for explicit, versioned key-establishment control during a documented
transition if the final handshake requires it.

## Verified current execution path

`src/hooks/useNIP44DM.js` encrypts `sendDM()` payloads and typing indicators
with `conversationKey(accountSecret, peerAccountPubkey)`, then creates a NIP-59
signed seal and random-key gift wrap. Incoming live events and history unwrap
the gift wrap and seal, then use the same deterministic conversation key to
open the kind-4 rumor. `src/lib/giftWrap.js` and `giftUnwrap.js` provide
transport wrapping, not a message ratchet. The account secret remains the
long-lived decryption root for every recorded message.

The message table is encrypted at rest using the current unlocked vault key,
but the durable outbox stores signed events separately. A ratchet transition
must therefore atomically commit session state and ciphertext to the outbox
before the network publish. Incoming handling must atomically persist the
advanced session and a sealed, idempotent inbox journal before running
business side effects; otherwise a crash after decryption could advance the
ratchet and permanently lose the plaintext or skip an order/key-control action.

## Candidate and alternatives

### Conditional candidate: vodozemac Olm v2

The official Matrix `vodozemac` Rust crate implements Olm and Megolm and
contains an asynchronous 3DH session setup and Double Ratchet. Its published
crate is Apache-2.0 and its current source can be built for WebAssembly. The
default compatibility session uses an 8-byte truncated MAC. The crate has a
feature-gated experimental session v2 that uses the full MAC. Cipher would
need a thin, narrow Rust/WASM adapter around the library; it must not implement
or alter the ratchet itself.

The 2022 Least Authority report audited an older vodozemac revision. It did not
cover language bindings and listed findings, including the short MAC. That is
not a current independent review of the library release, the proposed adapter,
or Cipher. The experimental v2 mode is an explicit release gate: pin the crate,
verify both peers negotiate only that mode, inspect the wire/MAC behavior with
tests, and do not silently accept compatibility-mode sessions. If the v2 API
or cross-platform build cannot be maintained safely, stop and reassess instead
of shipping the 8-byte compatibility mode.

References: [vodozemac](https://github.com/matrix-org/vodozemac),
[vodozemac audit (2022)](https://matrix.org/media/Least%20Authority%20-%20Matrix%20vodozemac%20Final%20Audit%20Report.pdf),
[Double Ratchet specification](https://signal.org/docs/specifications/doubleratchet/),
[X3DH specification](https://signal.org/docs/specifications/x3dh/), and
[Sesame session-management specification](https://signal.org/docs/specifications/sesame/).

### Rejected for this integration without a separate design

- The official Signal `@signalapp/libsignal-client` distribution is native
  Node-oriented; Signal says using it outside Signal is unsupported. It is not
  an app-supported browser/WASM package.
- Matrix's high-level `matrix-sdk-crypto-wasm` owns its crypto store and
  Matrix device/request model. The current Cipher app needs a recoverable,
  atomic transaction across ratchet state, its message store and its Nostr
  outbox. The high-level store API has not demonstrated that transaction
  boundary.
- A handwritten JavaScript ratchet, a wrapper around an unreviewed fork, or a
  fresh crypto primitive is out of scope.

## Identity and first-message delivery

Ratchet credentials must be device-specific and account-authenticated. The
account signing key binds a device's identity key, signed prekey and prekey
generation to the user's existing Nostr account. Peer fingerprints must cover
the authenticated account/device binding and be compared through the existing
safety-number or another reviewed verification flow. A changed identity or
device set must not silently establish a trusted replacement session.

Prekey distribution must support an offline recipient without trusting a relay
to authenticate the bundle. A bundle is accepted only after verifying its
account signature, key id, protocol version, expiry, and binding to the
recipient. Since Nostr relays cannot atomically consume a one-time key, the
design must not claim exactly-once one-time-prekey semantics: a malicious or
replicating relay may hand the same signed bundle to multiple senders. The
receiver must safely handle duplicate initial messages and retain the matching
private prekey until a documented delivery/expiry condition. Replay, stale
bundle and account-key-change behavior must be tested. If a recipient has no
valid bundle, a sensitive message remains locally pending and the UI reports
that session setup is required; it is never sent by NIP-44 as a fallback.

Publicly account-signed key-bundle events make the account-to-device binding
visible to the publishing relay. An encrypted mailbox request/response avoids
that public listing but cannot support first contact to a recipient who stays
offline. This is a real availability/privacy trade-off. The initial design may
use signed public bundles only if captured-frame tests and the privacy review
accept this exposure; otherwise first-contact sending must wait for a private
response. No globally reusable device identifier is required: use a random,
account-scoped device id and rotate it only through an authenticated device
transition.

## State, retries and crash recovery

1. Each device owns independent ratchet accounts and sessions. Ratchet private
   state is serialized only inside the local account database and sealed under
   a key derived from the unlocked vault secret with domain separation and
   authenticated database/account/session identifiers.
2. Outbound: serialize access to a conversation/device session; operate on a
   clone of the stored ratchet state; encrypt once; then atomically write the
   new state and immutable NIP-59 event into the durable outbox. Only after that
   transaction commits may relay publishing start. Retries resend the exact
   stored event and never ratchet again.
3. Inbound: verify NIP-59 seal/hash first; deduplicate by immutable wrap and
   inner message ids; decrypt using a cloned ratchet state; then atomically
   write the new state and a sealed inbox-journal row. Application processing
   is idempotently resumed from the journal, and the journal is deleted only
   after message storage and required local side effects are durable.
4. Out-of-order messages use the library's bounded skipped-key support.
   Duplicate, too-old, excessive-gap and malformed messages are rejected
   without committing partially advanced state. Limits and retention for
   skipped keys are explicit and covered by tests.
5. Concurrent tabs/devices cannot mutate the same session copy. Web Locks or
   an IndexedDB compare-and-swap lease must guard each local session, with
   transaction version checks. Separate devices use separate ratchet sessions.
6. Lock clears plaintext state and in-memory library objects. A vault lock
   during a transition leaves either the pre-transaction state or the complete
   committed state. At-rest corruption is an explicit recovery error; no
   replacement secret is generated.

## Migration and recovery

- Existing bare kind-4 messages and NIP-59-wrapped NIP-44 payloads remain
  readable through the existing decoder, explicitly labeled legacy. No old
  event is rewritten or re-encrypted.
- New payloads carry a versioned ratchet envelope inside the existing sealed
  rumor. A client may send a new ratchet message only to an authenticated,
  supported peer device. Mixed-version peers require explicit upgrade; there
  is no silent weaker-content fallback.
- Existing same-account installs do not possess a shared ratchet state merely
  because they restore the same Nostr account key. Each install must enroll as
  a new device. Adding devices, revoking devices and authenticated state
  transfer require the Phase 3 design. Until that is implemented, the Phase 1
  rollout must not claim safe multi-device continuity.
- Reinstall without an encrypted state backup creates a new device and fresh
  sessions. Old ratchet messages that were never locally stored may be
  unrecoverable; Nostr account recovery alone cannot reconstruct erased
  message keys. There is no silent reset of an existing session.
- A backup can only restore the state at its creation time; it may replay old
  ratchet state. Backup restore must be rollback-detectable or must force a
  fresh authenticated session before sending. The safe, device-sync design is
  part of Phase 3, not inferred from account-key recovery.

## Definition of done

- [ ] Library and adapter versions are pinned; browser and supported native
  targets build from reproducible sources, with license notices preserved.
- [ ] Independent endpoints establish an account-authenticated device session
  using the chosen prekey protocol; invalid signatures, stale/replayed bundles,
  wrong peers and changed keys fail closed.
- [ ] Ratchet tests prove out-of-order, duplicate, replay, excessive gap,
  corrupted state, old-key theft and future recovery after fresh authenticated
  DH input, using the actual library implementation.
- [ ] IndexedDB tests prove atomic state+outbox and state+inbox-journal commits,
  crash/retry behavior, concurrent-tab exclusion and lock/unlock handling.
- [ ] Browser tests exercise two independent devices over the existing Nostr
  transport, including offline prekey delivery and relay refusal.
- [ ] Historic NIP-44 content remains readable; sending without a valid ratchet
  session never publishes NIP-44 content.
- [ ] Multi-device limitations and restore behavior are accurately represented
  in product copy before the rollout is enabled.
