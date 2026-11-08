# R5 device authority foundation

Status: isolated experimental foundation. No identity, DM, group, commerce, or
relay path consumes this protocol. The v1 account-signed device registry and
freshness prototype remain for compatibility and are not upgraded by this
document.

## Security model

The R5 prototype separates four capabilities:

| Credential | Purpose | Availability |
| --- | --- | --- |
| `N` account key | Existing Nostr profile and compatibility identity | Existing installations; remains valid outside Cipher |
| `R` recovery root | Create the initial Cipher policy and replace a lost primary authority | Generated independently; caller must store it offline |
| `A` primary authority | Enroll/revoke devices, advance the registry and answer freshness challenges | One designated primary browser installation |
| `Dᵢ` device credential | Prove possession for one installation and sign scoped requests | Unique per installation; never derives `A` or `R` |

`createDeviceAuthoritySetup()` generates `R`, `A`, and the primary `D` using
independent secure random keys. The signed policy binds their public keys to
the existing account public identity. The verifier requires an independently
provided recovery-key pin; the account key cannot substitute for that pin.
Neither `A` nor `R` is derived from `N`.

`R` is not accepted by the local storage API and is never written by it. `A`
is wrapped under a non-extractable WebCrypto AES key stored in a separate
primary-installation IndexedDB database. The account's shared at-rest secret
does not unlock this database. Loading `A` requires the policy's exact primary
device credential and current recovery-pinned policy. Authority replacement
replaces the local row at the next recovery-signed epoch; the former primary
then fails to load it.

An isolated public-policy pin store provides the corresponding peer-side
checkpoint: the initial pin requires the independently authenticated recovery
fingerprint, and later updates must extend the exact stored policy id by one
recovery-signed epoch. IndexedDB transactions make simultaneous replacement
updates compare-and-swap; the winning exact signed event is safe to retry.
This is local browser state, not a remote witness or rollback-resistant
hardware counter. Restoring an older whole-browser profile can roll back the
checkpoint, so a production client still needs a recovery/contact checkpoint
strategy.

The records use Nostr event signatures as an encoding and authentication
primitive. The isolated `deviceAuthorityTransport.js` prototype carries
policy and registry transitions as individually addressed NIP-59 wraps. It
requires the exact predecessor, a valid sender device credential, a valid
recovery signature for replacement, and an active post-update recipient.
Tests cover withheld/stale heads, replay, conflicting successors, tampering,
wrong recipients and replacement. Relay-visible wraps contain an ephemeral
outer author and recipient device-key `p` tag; account, recovery and authority
keys and transition bodies remain sealed. The helper has no application call
site. `deviceAuthorityPeerStore.js` persists a bounded signed registry history
and exact policy/registry head in IndexedDB, revalidates it on load, commits
successors atomically across tabs, retries an exact event idempotently, and
fences delayed pre-replacement updates. Node adversarial tests and a Chromium
two-tab IndexedDB test exercise those behaviors. Relay subscriptions, a
durable delivery outbox, independent-relay synchronization, offline recipient
recovery, and real WebSocket privacy capture remain unverified. A relay still
learns the recipient device key and can withhold its copy; this is not
production discovery or anonymity.

Fresh authority approval is mandatory for enrollment, revocation, and
replacement. These operations are not authorized by a cached 30-second
messaging lease: enrollment and revocation require the current `A` to sign the
exact successor, and replacement requires `R` to sign the next policy epoch.
If the primary is offline, ordinary devices cannot perform these transitions.
The 30-second lease is currently a verifier prototype only; no production send
path consumes it. Tests establish expiry at the signed boundary, denial when
the authority withholds a response, and denial after the peer pins a newer
registry. With an honest authority and a relay withholding a revocation, a
peer must hold sensitive sends when its last lease expires (at most 30 seconds
after that response). This is a replay bound, not a global revocation bound:
the adversarial test demonstrates that a compromised old authority can answer
fresh challenges indefinitely for a peer still pinned to the old recovery
policy. The peer accepts each new short lease until it learns and pins the
recovery-signed replacement. Multiple relays and timestamps cannot prove that
a newer record was not withheld.

This is browser-profile isolation, not a hardware-backed device identity. A
compromised primary browser origin, OS, or copied browser profile may expose
the authority and device credentials. A non-extractable `CryptoKey` prevents
ordinary export through WebCrypto; it does not protect against malicious
same-origin code that can invoke decryption while the profile is open.
The storage helper does not yet bind key loading to Cipher's locked or
unlocked UI state. The application already has a WebAuthn PRF-backed device
secret provider for other local vault use, but it must not be reused for `A`
without a device-custody decision: WebAuthn supports both single-device and
backup-eligible multi-device credentials, and the PRF is associated with the
credential. The web API does not promise that a credential (or its PRF access)
is non-synchronizing. A synced credential could therefore undermine the
requirement that ordinary devices never obtain `A`. A future browser design
must require a user-presence unlock on the designated primary and reject
multi-device credentials for authority custody where the browser exposes a
reliable signal; otherwise it must say that browser-only custody is weaker.
Platform secure storage (native Keychain/Keystore) or a device-bound roaming
security key may improve custody, but each introduces platform-specific
availability and recovery behavior. The standards distinguish single-device
from backup-eligible multi-device credentials and define PRF output as
associated with a credential; they do not provide Cipher a universal
device-only custody guarantee ([W3C WebAuthn Level 3](https://www.w3.org/TR/webauthn-3/), [FIDO synced passkey deployment guidance](https://fidoalliance.org/wp-content/uploads/2024/05/Synced-Passkey-Deployment_-Emerging-Practices-for-Consumer-Use-Cases_2024-May-31.pdf)).
An isolated WebAuthn PRF wrapper is implemented as an experiment in
`src/lib/deviceAuthorityWebAuthn.js`. It requires user presence and
verification, checks the authenticator's backup-eligibility (`BE`) and
backup-state (`BS`) flags on an assertion, and refuses PRF absence or `BE/BS=1`;
there is no IndexedDB fallback. AES-GCM additional data binds the wrapped
secret to the exact account public key and policy event id. A Chromium virtual
authenticator test proves this browser execution path and its rejection
behavior. This does not prove a physical authenticator is tamper-resistant,
that same-origin code cannot invoke it while unlocked, or that a real
authenticator reports truthful custody flags. The wrapper has no application
call site and is not production custody.

## Authenticated record transitions

* A recovery-root-signed policy (`kind 30085`) binds account, recovery root,
  authority key, authority epoch and the unique primary device credential.
* An authority-signed registry (`kind 30086`) begins at the policy id and
  advances by one generation with an exact predecessor id. A successor may
  add one newly proved device or revoke one active device. Removed rows remain
  tombstoned; a device id or public key cannot be reused. Registry snapshots
  supplied to mutations and freshness requests must match an exact locally
  pinned head. A relay's largest generation is not accepted as proof of the
  current head.
* Enrollment uses an expiring authority-signed challenge bound to policy id,
  registry head, candidate device id/key and random nonce. The candidate must
  sign proof of possession. The resulting registry event is durable-CAS
  committed before it is distributed. If delivery is interrupted, storage
  retains that exact signed event for retry.
* Revocation is a single tombstone transition. Only `A` can write it. It does
  not erase secrets or plaintext already held by the revoked endpoint.
* Authority replacement requires `R`, increments exactly one authority epoch,
  names the old policy as predecessor, creates a fresh `A` and fresh primary
  `D`, and starts a new registry containing only that primary. The fresh
  approval is the recovery root's signature over the exact currently pinned
  predecessor; it cannot depend on the old `A`, because recovery must remain
  possible when `A` is lost or compromised. Ordinary devices cannot replace
  authority or promote themselves.
* Freshness challenges are signed by an active `D` and bind the current policy,
  exact registry head, requester, target device, purpose, operation id and
  nonce. The authority response repeats these bindings and expires after 30
  seconds. Missing, stale, mismatched or expired proof means hold the
  sensitive operation.

The exact-head argument must come from an authenticated, monotonic local
checkpoint. The helper does not fetch relays or treat a relay response as a
checkpoint. IndexedDB compare-and-swap permits only one tab to commit a
successor from a given head. A successful commit retains the exact signed
successor for retransmission; concurrent losers must reload the persisted
head and must not create an alternative successor.

## Recovery, availability and limits

Recovery can install a new authority only for peers that accept the
recovery-root-signed successor. A nonce proves a response is live; it does not
prove that an authority key has not since been replaced. A peer that has not
learned a recovery event can accept a valid response from the old authority.
The adversarial test reproduces this: an old response verifies against the
old policy and registry, while the same response fails against the new
recovery-signed policy and registry. A compromised `A` cannot forge the new
policy, but can continue answering peers that have not learned it. The
recovery fingerprint and current policy id therefore need an authenticated,
monotonic local pin, and successor acceptance must check the exact prior
policy id and increment by one. Multiple relays, timestamps, signed chains
and gossip can expose forks or withholding but cannot prove that no newer
event was withheld. A stale peer's exposure is not bounded by one 30-second
lease if a compromised old authority can keep answering it; the lease only
bounds replay/use of a single response. A trusted checkpoint/witness, quorum,
or an explicit policy of holding sends until a successor is authenticated is
required to bound that condition.

The experimental policy's availability tradeoff is explicit: when the primary
is offline or a relay withholds a response, sensitive sending stops when the
cached response expires. This prevents a relay-only outage from silently
authorizing on stale local state. It cannot stop a compromised old primary
from issuing new leases to a still-stale peer. Strict global freshness needs a
reachable trusted checkpoint/witness or an explicitly approved bounded
offline window. Neither is implemented or approved for production.

If `A` is offline, local history can remain available, but enrollment,
revocation, recovery coordination, and any action requiring fresh authority
must wait or remain queued. This prototype has no background service and does
not promise an always-online browser primary. `R` is an independent recovery
credential, not a way to recreate lost ratchet/MLS state. If both the primary
and every previously authenticated recovery path are lost, safe recovery is
impossible without asking contacts to verify a new identity.

The existing account secret `N` may remain valid for ordinary Nostr events.
This is intentionally Cipher-specific authorization: old holders may still
sign Nostr profile events. To protect the broader Nostr identity, Cipher would
need an explicitly approved new-key identity transition and contact
re-verification. This change neither migrates `N` nor claims that old copies
were erased.

## Migration boundary

Existing installations still restore the shared account key and older
account-signed registries. No automatic conversion is safe: possession of
that old key does not distinguish the owner from a formerly authorized
device. A migration needs a trusted installation to generate/pin `R`, create
`A` and `D`, authenticate the recovery fingerprint to contacts through an
independent verified channel, and stop treating `N` signatures as Cipher
device authority for those contacts. Old conversations, groups, orders,
payments and profile records remain untouched by this experimental code.

The new protocol deliberately has no TOFU migration fallback. Until a peer has
authenticated the independent recovery pin and policy chain, the new
authority is not considered established. A production rollout must preserve
legacy readers while refusing to use legacy account-signed records for new
device authorization after an explicit per-peer migration.

## Verified implementation and remaining gates

Implemented only in isolated modules:

* Versioned signed policy, registry, enrollment, revocation, replacement and
  30-second scoped freshness records (`src/lib/deviceAuthority.js`).
* Separate primary-local authority wrapping and registry-head CAS/outbox
  persistence (`src/lib/deviceAuthorityStorage.js`). The recovery root is not
  accepted by this storage API.
* Local monotonic recovery-policy pins, requiring an independently
  authenticated recovery fingerprint and exact predecessor on replacement
  (`src/lib/deviceAuthorityPinStore.js`).
* Peer-side monotonic policy/registry checkpoint history and atomic update
  application (`src/lib/deviceAuthorityPeerStore.js`).
* NIP-59 authority-update transport prototype and adversarial tests for exact
  predecessor validation, revocation delivery, replay, competing heads,
  tampering, recipient authorization and replacement.
* Offline recovery phrase/restore helpers with random word-position
  confirmation; the helper never persists or transmits `R`.
* WebAuthn PRF authority-wrap experiment and Chromium virtual-authenticator
  execution, including policy binding and backup-eligible credential refusal.
* Chromium IndexedDB checks for reload, cross-tab single-writer registry
  commit, ordinary-device denial, separate-profile isolation and replacement
  fencing.

Not implemented: production recovery phrase UX; application relay transport or
freshness request/response flow; durable relay outbox and independent-relay
sync; authenticated contact migration; profile signing capability separation;
account-secret backup changes; device-specific mailbox routing; production
DM/session integration; group revocation; locked-state key-load gating; a
trusted global recovery checkpoint; and real authenticator/vendor validation.
No production protocol may claim device revocation based on this foundation
until those integrations and an independent security review are complete.

## Recovery custody prototype and decision

`R` must be generated independently and exported only in a deliberate recovery
ceremony to a user-controlled offline backup, such as a downloadable
recovery package or printed high-entropy recovery code. It must never be
included in the ordinary account backup, relay records, browser sync, or
ordinary-device enrollment bundle. The user must verify the backup before
Cipher discards the one-time in-memory copy. Recovery on a replacement primary
uses `R` to sign a new policy epoch and creates new `A` and `D`; it does not
restore ratchet or group state, and does not make old device credentials
current. If the user loses both the primary and `R`, preserving the same
Cipher-authorized device identity is impossible; recovery would require a
separately approved identity reset and contact re-verification.

The isolated `deviceAuthorityRecovery.js` prototype encodes the independent
32-byte root as a 24-word BIP-39 phrase, asks the user to confirm four random
word positions, and restores only when the phrase matches a separately
authenticated recovery public-key pin. Tests cover valid and malformed
phrases, wrong confirmation words, missing randomness and account-key
substitution. It has no persistence, clipboard, download, log, or relay path.
A browser UI ceremony and real recovery account flow are not implemented.

The phrase is a bearer credential: anyone holding all words can replace the
authority. Cryptography cannot distinguish that person from the owner. A
second recovery passphrase could reduce harm from a stolen paper backup, but
forgetting it creates permanent lockout. A 2-of-3 guardian quorum reduces
single-secret risk but introduces trusted parties and coordination. A remote
witness helps with authority freshness but introduces infrastructure. Approval
is needed before integrating any of these tradeoffs into the user-facing
recovery ceremony. The client must not discard its in-memory `R` until the
offline backup has been verified; in this isolated prototype, the caller
remains responsible for handling that secret safely.

Before R5 production integration, Cipher must approve:

1. Whether all new sends require a primary response per operation or may use
   a bounded lease, and what happens when the primary is offline. With an
   honest authority, lease expiry holds sends after at most 30 seconds. A
   compromised old authority can keep issuing fresh leases to peers that have
   not learned its replacement, so this is not a global revocation bound.
2. How contacts independently authenticate and refresh the recovery-root
   fingerprint and authority epoch, including peers that are offline during
   replacement.
3. Whether preserving the existing Nostr public key is sufficient (Cipher-only
   revocation) or a broader Nostr identity migration is required.
4. Which platform-specific protection, if any, is required beyond
   browser-profile-local WebCrypto storage.
5. How users back up and recover `R` without exposing it to ordinary devices or
   the normal account restore phrase.
6. Whether browser deployments may use synced passkeys for local unlocking,
   or must require a device-bound authenticator/native secure storage for
   primary `A` custody.

## Isolated freshness-witness and encrypted-backup experiments

`deviceAuthorityCheckpoint.js` adds an optional peer-witness experiment. A
requester sends a random, 60-second challenge bound to the existing account
and independently pinned recovery fingerprint. A witness signs the exact
policy and registry head it has already validated from its local monotonic
checkpoint. The attestation is delivered to the requesting device in a
NIP-59 wrap; the relay sees the target device routing key, not the checkpoint
or account identity in the wrapped body. The checked authority, account, and
recovery root are barred from acting as their own witness. Witness keys and
quorum size are explicit caller inputs; no trust list or threshold is
preselected, and this module has no application or relay subscription call
site.

Adversarial tests cover a 2-of-3 quorum where two independently pinned peers
have observed recovery replacement, a compromised authority presented as a
witness, replayed and expired challenges, minimum-epoch rollback, a withheld
or offline witness leaving no quorum, a fork, and an isolated partition where
two witnesses both attest the same old head. That last case succeeds by
design: signed responses prove what those witnesses saw, not that no newer
authority event exists. If a compromised authority can answer a peer and the
peer's quorum consists of stale or compromised witnesses, that peer may
continue to treat the old authority as current. Quorum improves detection
only after enough independently trusted witnesses learn the replacement and
are reachable. It gives no guaranteed instant or globally bounded revocation.
Requiring a fresh quorum for every sensitive send would also pause delivery
when witnesses are offline or censored. The experiment therefore does not
change the existing offline-messaging policy; choosing which operations need
a quorum and whether to queue or hold them is a production decision.

The optional `deviceAuthorityRecoveryPackage.js` wraps an export copy of `R`
using Argon2id (19 MiB, 2 iterations, one lane) and AES-256-GCM. Associated
data binds the ciphertext to the existing account and recovery fingerprint;
the file carries fixed KDF parameters, random salt and nonce, and rejects
parameter edits, wrong passphrases, wrong account/root pins, and tampering.
The parameters use the current OWASP minimum recommendation as a browser
runtime floor, not a claim that a short passphrase is safe. The passphrase
requirement is only a 12-character minimum; users need a unique, high-entropy
phrase, and offline guessing remains possible if an attacker obtains the
encrypted file. Derived key and input passphrase byte buffers are cleared on
completion, although JavaScript engines do not guarantee erasure of all
copies. The package remains an optional export format, is never saved by the
helper, and does not replace the 24-word offline backup.

The 24 words themselves remain a bearer recovery credential. Anyone who
copies them can replace `A`; a separate passphrase protects only the encrypted
digital copy. Forgetting that passphrase loses that copy route, while the
paper words can still restore. Loss of both means the account cannot safely
replace its authority without a separately approved reset and contact
re-verification. BIP-39's optional passphrase is not used as a password KDF:
it uses a fixed 2,048-round PBKDF2 derivation and every passphrase creates a
valid seed, so the encrypted package uses an explicit Argon2id wrapper instead
([BIP-39](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki),
[OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html),
[RFC 9106](https://datatracker.ietf.org/doc/rfc9106/)).

Browser execution now exercises the recovery phrase and Argon2id package in
Chromium and confirms that neither helper writes the recovery secret to
`localStorage`. Node adversarial coverage checks wrong passphrase, identity,
tampering, and KDF downgrade. The optional package has no UI, download,
clipboard, account-backup integration, or user study; usability, browser
memory pressure, and platform-specific secure-file handling remain unverified.

## Contact continuity and replacement-authority pinning

The protocol can preserve the same Nostr public key, profile, contact records,
group references, orders, reviews, and payment records because the new policy
binds to the existing public account identity and does not rewrite those
records. A contact can accept a replacement `A` only by verifying an
`R`-signed successor from the exact policy id that contact already pinned,
then durably advancing its own pin. The same N identity does not authenticate
a new `R`: the isolated test constructs two valid policies for one account
identity and proves the second is rejected against the first policy's pinned
recovery fingerprint.

Initial contact pinning still needs an independent authenticated ceremony:
compare a recovery fingerprint in person, verify a QR/fingerprint through a
previously authenticated channel whose trust does not depend on the possibly
compromised account secret, or use a previously pinned independent witness
policy. Signing the first fingerprint with `N` alone is insufficient if a
former device may retain `N`. A recovery-signed successor proves continuity
from a pin already held; it cannot repair a contact that never authenticated
the original root. Contacts offline during replacement continue to have only
their old pin. Until they receive and authenticate the successor (or a fresh
trusted witness quorum proves it), they cannot distinguish an old-authority
response from the current one. Failing closed for those sends is safer, but
reduces availability. No automatic TOFU, account-key fallback, identity
rewrite, or live-user migration is implemented.

## Decision gate before full R5

R5 cannot guarantee prompt global revocation using only signatures and
ordinary relays. Choose one explicit model before production integration:

1. **Local pin plus strict hold:** accept authority changes only when a device
   receives a recovery-signed successor extending its pin. Hold sensitive
   operations when freshness is uncertain; offline history and composition
   remain available. A compromised old authority may still serve stale peers
   until they receive the replacement.
2. **Pinned peer-witness quorum:** require a configurable threshold of
   independently authenticated peers for authority-sensitive operations.
   This detects replacement only when enough non-compromised witnesses have
   learned it and can be reached. Outages, censorship, or a stale quorum pause
   those operations. Cipher must decide witness enrollment, removal,
   threshold, challenge frequency, and recovery if the witness set is lost.
3. **Public append-only transparency checkpoint:** use a monitored,
   consistency-proven log plus client gossip. This can expose equivocation to
   clients that compare checkpoints, but adds a log/monitor availability and
   trust dependency; partitioned clients still cannot know what they have not
   received. It is not decentralized merely because the log is auditable.
4. **Explicit bounded-staleness policy:** permit offline authority decisions
   for a chosen window. This trades a known stale-authorization period for
   availability and cannot stop an old authority from freshly answering a
   peer until that peer learns of replacement.

No option provides instant global revocation while allowing arbitrary offline
operation and avoiding a common reachable trust/checkpoint assumption. The
prototype does not choose among these. Before enabling R5, approve (a) whether
the witness/log dependency is acceptable or local-pin-only is sufficient,
(b) which sensitive operations fail closed, (c) how contacts authenticate
their first recovery pin, (d) backup/passphrase UX and loss behavior, and (e)
whether the unchanged Nostr identity is the intended security boundary.
