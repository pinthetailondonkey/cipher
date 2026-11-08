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

The records use Nostr event signatures as an encoding and authentication
primitive, but this prototype has no relay transport. Policy and registry
events expose the account-to-device binding in their content; a future
transport must carry them only inside an authenticated encrypted channel.
Publishing these kinds to an ordinary relay would violate the privacy goal.

This is browser-profile isolation, not a hardware-backed device identity. A
compromised primary browser origin, OS, or copied browser profile may expose
the authority and device credentials. A non-extractable `CryptoKey` prevents
ordinary export through WebCrypto; it does not protect against malicious
same-origin code that can invoke decryption while the profile is open.
The storage helper also does not yet bind key loading to Cipher's locked or
unlocked UI state. Production integration must add that gate and verify that a
locked profile cannot request `D` or `A` from the helper.

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
  `D`, and starts a new registry containing only that primary. Ordinary
  devices cannot replace authority or promote themselves.
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
Multiple relays, timestamps, signed chains and gossip can expose forks or
withholding but cannot prove that no newer event was withheld.

The current experimental policy uses a 30-second lease inside a known pinned
authority epoch. It therefore accepts a bounded interval between a valid
response and a later revocation. Strict instant revocation requires a reachable
trusted checkpoint/witness policy or per-operation online authorization, and
must hold sends if that trust source is unavailable. That availability policy
has not been approved for production.

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
* Adversarial node tests and a Chromium IndexedDB test. The browser test checks
  reload, concurrent-tab single-writer registry commit, ordinary-device
  denial, separate-profile isolation, and recovery replacement fencing.

Not implemented: user recovery-root backup/export flow; authority or policy
relay transport; authenticated contact migration; freshness transport; profile
signing capability separation; account-secret backup changes; device-specific
mailbox routing; production DM/session integration; group revocation; hardware
key binding; a trusted global recovery checkpoint. No production protocol may
claim device revocation based on this foundation until those integrations and
an independent security review are complete.

Before R5 production integration, Cipher must approve:

1. Whether all new sends require a primary response per operation or may use
   the prototype's 30-second lease, and what happens when the primary is
   offline.
2. How contacts independently authenticate and refresh the recovery-root
   fingerprint and authority epoch, including peers that are offline during
   replacement.
3. Whether preserving the existing Nostr public key is sufficient (Cipher-only
   revocation) or a broader Nostr identity migration is required.
4. Which platform-specific protection, if any, is required beyond
   browser-profile-local WebCrypto storage.
5. How users back up and recover `R` without exposing it to ordinary devices or
   the normal account restore phrase.
