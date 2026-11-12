# Crypto cutover: staged promotion of the ratchet and MLS

Status: staging record. Nothing here changes a wire format by itself; each
cutover ships behind a feature flag that defaults off, and this document
names the gates that a flag flip must pass before it is flipped.

## Part 1 — DM double ratchet

The shipped DM path seals every DM per message: NIP-44 inside the NIP-59
seal (`useNIP44DM.js`), keyed to the conversation. Forward secrecy lasts one
message. The wasm double ratchet (`crypto/ratchet-wasm`) and its Node-side
plumbing (`src/lib/dmRatchet*`, `src/lib/ratchet*`) are tested but lived
only inside the test-profile DM lane.

The cutover change routes plain-text DMs through the same primitives the
test lane already proves, behind a persisted per-account (or per-conversation)
flag that defaults off. Shipped NIP-44 reads stay as the receive fallback so
history and un-flagged peers never break. Order messages, receipts, calls and
reads keep the NIP-44 path in this stage; they ride the ratchet only after the
flag proves itself in production use.

Wire cost of honesty: a conversation where one side has the flag on and the
other has not updated the app shows the sender's messages unreadable for the
peer until the peer updates — the same one-sided limitation the test lane's
receiver documents. The flag page says so.

## Part 2 — MLS groups

`src/lib/mlsTest/` holds a complete, tested MLS lane behind
`PROTOCOL_TEST_MLS_ENABLED`, self-described as pending governance review.
The cutover change stages the production surface: a persisted
`group_mls_mode` flag defaulting off (`src/lib/groupCryptoMode.js`, same
shape and default as the DM flag) plus the governance-readiness audit the
review asks for.

### Governance-readiness audit (2026-11-11)

What the MLS lane already satisfies:

1. **Canonical serialization + binding hashes.** `governanceBinding.js`
   hashes sorted-key canonical JSON; extensions cite the previous revision
   and the NEXT governance document cites the commit hash plus transcript
   hash. Role authorization (owner/admin-only commits) is checked at a
   pinned previous revision.
2. **Actor pins on every privileged act.** `buildGovernanceExtension`
   accepts only compressed secp256k1 pins (`[0-9a-f]{66}`), deduped and
   sorted; empty pin sets are rejected.
3. **Durable transaction boundary.** `mlsStateTransactions.js` commits
   snapshots and their protocol events in the same IndexedDB transaction
   with optimistic versioning (`MlsStateConflict`), so a state snapshot is
   never tentative while a competing writer races it.
4. **Epoch state is attested and retained.** `epochAttestation.js` and
   `pastEpochRetention.js` cover the forward/backward privacy questions the
   review raised.

What is NOT yet satisfied, stated plainly:

5. **The shipped group path does not call MLS.** Live group traffic rides
   kind-9 events sealed by `src/lib/crypto/groupCipher.js`
   (`encodeGroupPayload`/`decryptGroupMessage`, AES with sender-bound AAD,
   actor signer, rotation via `useGroupKeyReconciler.js`). That is ONE clean
   seam: `encodeGroupPayload` on send and the group event decrypt on receive
   are the only two doors, so a future MLS cutover routes through exactly
   those — no multi-callsite surgery.
6. **The governance review itself has not been run** — the lane ships its
   checklist-passing primitives but no independent reviewer has signed off.
   Until it does, `group_mls_mode` stays a dormant, default-off flag with
   NO consumer in live traffic: flipping it today changes nothing on the
   wire, which is the honest failure mode.

### The seam map (for the follow-up that actually flips traffic)

- Send: `src/hooks/useNIP29Group.js` → `encodeGroupPayload` (line-scoped
  in `flushSecuringGroupSends`) → `buildSignedAct` → kind-9 publish.
- Receive: kind-9 group event → group event decrypt (groupCipher AAD open)
  → `messageAtRest.js` wrapper (per-message rotating keys sit on top).
- Key lifecycle: `generateGroupKey` consumers in `useNIP29Group.js` and
  `useGroupKeyReconciler.js`; rotation pending is honored before any send.
- MLS replacement surface: route both doors through `src/lib/mlsTest/`
  primitives (`receiverBuffer`, `commitValidators`, `epochAttestation`),
  keep kind-9 as transport, and gate the routing on `groupMlsEnabled()`.
  Old kind-9 groupCipher messages stay readable during any transition by
  keeping the current decrypt as the fallback after the MLS attempt.

## Part 3 — Founder cutover (2026-11-12): MLS is the DEFAULT path

Direction changed by the founder: both crypto paths ship default-on for
founder testing. No toggles.

### DM double ratchet: unconditional

`src/hooks/useNIP44DM.js` routes every plain-text DM through the ratchet lane
(no flag check), every kind-1059 wrap opens through the frozen receiver first,
and inbound route keys derive unconditionally at subscription time. Non-text
payloads (orders, receipts, calls, reads) keep NIP-44. The
`Ratcheted DMs` toggle row was REMOVED from Privacy settings; the
`dm_ratchet_mode` flag module remains only as storage back-compat.

### Groups: OpenMLS through the codec seam

New bridge: `crypto/mls-wasm/src/session.rs` exposes real OpenMLS 0.9.2
engine ops over opaque handles (create/keypackage/add/join/process/encrypt/
members + JSON snapshots). `cargo test --test session_round_trip` proves the
full lifecycle in Rust; `scripts/mls-seam-browser-test.mjs` proves it inside
Chromium against the shipped wasm.

JS seam: `src/lib/mlsGroups.js` (engine per unlocked account, snapshot
persisted via scoped storage) and `src/lib/mlsGroupsRoute.js` (codec shim).
`groupMessageCodec.encodeGroupPayload` seals with MLS when the engine holds
the group (event tag `fmt=mls1`); `decodeGroupEvent` routes `fmt=mls1`
content to the engine and NEVER falls back to legacy rendering.

HONEST LIMITS for founder testing, all deliberate:
1. Engine holds ONE group per account (single-group registry). Widening is a
   documented refactor behind the same entry points.
2. The relay-borne add/welcome handshake is not yet wired into the live
   invite flow: a creator seals mls1 from day one of a NEW group; peers who
   join without their own MLS state read those events as `decrypt-failed`
   (shown honestly as undecryptable, never as fake text). Peer-engine joins
   ride the next slice.
3. Old groups keep working entirely on groupCipher: MLS engages where an
   engine group exists, registered at NEW group creation.
4. DM one-sided limitation is gone (ratchet ships to everyone), but two
   Cipher installs must BOTH be this build or newer.

## Gates before any flag flips to on-by-default

1. Both lanes' own node:test suites green (`dmRatchet*`, `ratchet*`,
   `mlsTest/*`), plus the new mode modules' tests
   (`dmRatchetMode.test.js`, `groupCryptoMode.test.js`).
2. Full `npm test` green at the cutover commit.
3. The one-sided-update limitation documented in the flag's UI copy.
4. PRIVACY-REVIEW.md updated to say the promotion exists behind the flag,
   not that the wire changed.
