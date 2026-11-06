// The group actor's wire shape (Step 2 of docs/MEMBERSHIP-DESIGN.md).
//
// Send side: every kind-9 body a group box sees and the NIP-42 proof that
// opens its socket are signed by this account's per-group actor key
// (gmIdentity.actorForGroup), never by the account key. Each carries one
// `author` tag naming the actor pin.
//
// Receive side: an act counts only when
//   (a) its NIP-01 id/signature verifies over its own fields (the caller or
//       the socket frame gate does that already), and
//   (b) its event pubkey equals a pin this device holds out of band — the
//       invite-link pin stamped at join, or the doc/roster record for a
//       device holding neither. Every failing combination refuses with a
//       reason instead of improvising an answer (the H4 discipline).
//
// What is deliberately NOT here yet:
//   - control kinds (9000/9001/9002/9021/9022/9005) still sign with the
//     account key. They are wired to the same actor in Step 2 slice 2; no
//     receive path trusts both shapes at once mid-slice, so this slice lands
//     send-side only and adds no verifier that would break a mixed relay box.
//   - the roster/docs naming actor pins beside members: Slice 3.

import { finalizeEvent } from 'nostr-tools';
import { actAuthorPin, actorTag, actSignedByKnownActor, actorForGroup } from './gmIdentity';

export const GM_ACT_KIND = 9;
export const GM_PROOF_KIND = 22242;
export const GM_TAG_AUTHOR = 'author';

function hexToBytes(hex) {
  const text = String(hex || '').toLowerCase();
  if (!/^[0-9a-f]+$/.test(text) || text.length % 2) throw new Error('Bad hex.');
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(text.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHexLower(bytes) {
  return Array.from(bytes || [], (b) => b.toString(16).padStart(2, '0')).join('');
}

function toSkBytes(skLike) {
  if (skLike instanceof Uint8Array) return skLike.length === 32 ? skLike : null;
  if (typeof skLike === 'string') {
    try { return hexToBytes(skLike); } catch { return null; }
  }
  return null;
}

async function signerFor(ownerPk, groupId) {
  const actor = await actorForGroup(ownerPk, groupId);
  if (!actor) return null;
  // nostr-tools' finalizeEvent takes BYTE secret keys, so the signer holds
  // both forms: bytes for signing, hex for logs. Never a bare string at the
  // signing call — that throws deep inside noble instead of refusing here.
  const skBytes = toSkBytes(actor.privateKeyBytes);
  if (!skBytes) return null;
  const pin = String(actor.pin).toLowerCase();
  // The cipher's senderPubkey and the wire event's own pubkey are BOTH forms:
  // event.pubkey is always x-only (64), while the invite-link pin rides
  // compressed (66). The groupCipher AAD binds whatever string each side
  // passes, so one side must be named canonical for it — and the only value
  // a receiver can re-derive without a lookup table is event.pubkey itself,
  // i.e. X-ONLY. WireSender is what every encode call passes; the 66-char
  // pin stays in the `author` tag where the Step-1 chain reads it.
  const wireSender = pin.length === 66 && /^0[23]/.test(pin) ? pin.slice(2) : pin;
  return { skHex: bytesToHexLower(skBytes), skBytes, pin, wireSender, ownerPk };
}

// Resolve once, use twice. The group-cipher AAD binds the SENDER PUBKEY that
// sits on the wire event (groupCipher.js aad()); after Step 2 that field is
// the actor pin, so the encoder must fold the SAME pin into its additional
// data or every receiver's decrypt refuses. Signing and encrypting therefore
// draw from one resolved signer — never two derivations racing.
// Returns { skHex, pin } or null when there is nothing to sign with.
export async function resolveActorSigner({ identity, groupId }) {
  if (!identity?.pk || !groupId) return null;
  return signerFor(identity.pk, groupId);
}

// The signer's byte form: what callers pass straight into nostr-tools. Kept
// exported for call sites (AUTH, hook arms) that never need the hex twin.

// The ONLY door from a group-screen intent to a signed kind-9. A pending
// encode (the group has no held key yet) returns { pending: true } untouched,
// so callers keep their Securing-state semantics exactly as before.
//
// Tags carry the h/ep/client/reply extras the codec and call site already
// produced; the `author` pin tag is appended here. An explicit signer (from
// resolveActorSigner) is honored so a caller can encrypt-and-sign from ONE
// derivation; when absent this resolves its own.
export async function buildSignedAct({ identity, groupId, content, tags, createdAt, signer = null }) {
  if (!identity?.pk || !groupId || typeof content !== 'string') return null;
  if (!Array.isArray(tags)) return null;
  const known = signer || await signerFor(identity.pk, groupId);
  if (!known) return null;
  const nowSec = Number.isInteger(Number(createdAt))
    ? Math.floor(Number(createdAt))
    : Math.floor(Date.now() / 1000);
  return finalizeEvent(
    {
      kind: GM_ACT_KIND,
      created_at: nowSec,
      tags: [...tags, ...actorTag(known.pin)],
      content,
    },
    known.skBytes,
  );
}

// The control kinds' door (Step 2 slice 2): same signer, same author tag, any
// kind the membership protocol uses. Unlike buildSignedAct the content is NOT
// sealed — control events are plaintext by protocol — so all identity-level
// trust flows from (a) the signature over its own fields and (b) the receiver's
// out-of-band resolution of this pin back to an account through the doc's
// standing rows. A null return means no derivation available; callers refuse
// rather than falling back to the account key.
export async function buildControlAct({ identity, groupId, kind, tags, createdAt, content = '' }) {
  if (!identity?.pk || !groupId || !Number.isInteger(Number(kind))) return null;
  if (!Array.isArray(tags)) return null;
  const known = await signerFor(identity.pk, groupId);
  if (!known) return null;
  const nowSec = Number.isInteger(Number(createdAt))
    ? Math.floor(Number(createdAt))
    : Math.floor(Date.now() / 1000);
  return finalizeEvent(
    {
      kind: Number(kind),
      created_at: nowSec,
      tags: [...tags, ...actorTag(known.pin)],
      content,
    },
    known.skBytes,
  );
}

// ── Proofs (NIP-42) ────────────────────────────────────────────────────────

// Sign one relay challenge with this group's actor key. The template comes
// back exactly as nostr-tools builds it (kind 22242, relay + challenge tags,
// empty content); the ACTOR's key signs it and its pin rides alongside.
//
// Returns { event, pin }, or null when there is nothing to sign with (locked
// tab, unknown owner): the socket handler then leaves the challenge unanswered
// rather than falling back to the account key, which is the whole point.
export async function signActProof({ identity, groupId, relayUrl, challenge, createdAt }) {
  if (!identity?.pk || !challenge) return null;
  const signer = await signerFor(identity.pk, groupId);
  if (!signer) return null;
  const nowSec = Number.isInteger(Number(createdAt))
    ? Math.floor(Number(createdAt))
    : Math.floor(Date.now() / 1000);
  const event = finalizeEvent(
    {
      kind: GM_PROOF_KIND,
      created_at: nowSec,
      tags: [
        // relay/challenge are NIP-42 wire tag names, not UI copy.
        ['relay', String(relayUrl || '')],
        ['challenge', String(challenge)],
        ...actorTag(signer.pin),
      ],
      content: '',
    },
    signer.skBytes,
  );
  return { event, pin: signer.pin };
}

// Strip the author tag before a proof template enters nostr-tools internals
// or any legacy comparison test. Kept exported: pool tests read raw frames.
export function stripAuthorTag(tags = []) {
  return (tags || []).filter((tag) => !(Array.isArray(tag) && tag[0] === GM_TAG_AUTHOR));
}

export function actorPinsFromEvents(events) {
  const pins = new Set();
  for (const ev of events || []) {
    const pin = actAuthorPin(ev);
    if (pin) pins.add(pin);
  }
  return [...pins];
}

export { actAuthorPin, actSignedByKnownActor, actorForGroup };
