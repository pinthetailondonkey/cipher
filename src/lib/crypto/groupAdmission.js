// Private first-contact proof for NIP-29 closed-group admission.
// The request stays in the existing NIP-29 9021 event. Its content is NIP-44
// ciphertext to an authority actor pin learned from an invite link; the
// plaintext is a short-lived account-signed binding of gid, actor and nonce.
// A request is evidence for an owner review only. It never grants membership.

import { finalizeEvent, getPublicKey, nip44, verifyEvent } from 'nostr-tools';
import { resolveActorSigner, buildControlAct } from './gmIdentityWire.js';
import { getSessionKey } from '../sessionKey.js';

const PURPOSE = 'cipher-group-admission-v1';
const HEX64 = /^[0-9a-f]{64}$/;
const HEX66 = /^[0-9a-f]{66}$/;
// Requests can wait for an owner to come back online. This is a stale-request
// bound, not a relay challenge; a pending ticket is separately persisted and
// replayed tickets never approve themselves.
const MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

function secretBytes(value) {
  if (value instanceof Uint8Array && value.length === 32) return value;
  if (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)) {
    return Uint8Array.from(value.match(/.{2}/g), (part) => Number.parseInt(part, 16));
  }
  throw new Error('Unlock your account to request admission.');
}

function xOnly(pin) {
  const text = String(pin || '').toLowerCase();
  if (HEX64.test(text)) return text;
  if (HEX66.test(text) && /^0[23]/.test(text)) return text.slice(2);
  throw new Error('A trusted group invite is required to request admission.');
}

function tagValue(event, name) {
  const values = (event?.tags || []).filter((tag) => tag?.[0] === name);
  if (values.length !== 1 || typeof values[0][1] !== 'string') throw new Error(`Invalid admission ${name} tag.`);
  return values[0][1];
}

function nonceValue(value) {
  if (value) {
    const nonce = String(value).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error('Invalid admission nonce.');
    return nonce;
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (part) => part.toString(16).padStart(2, '0')).join('');
}

export async function buildAdmissionRequest({ identity, groupId, ownerPin, nonce, createdAt } = {}) {
  if (!identity?.pk || !groupId) throw new Error('Unlock your account before requesting admission.');
  const recipient = xOnly(ownerPin);
  const accountSk = secretBytes(identity.sk);
  if (getPublicKey(accountSk) !== String(identity.pk).toLowerCase()) throw new Error('Account key does not match the unlocked identity.');
  if (getPublicKey(secretBytes(getSessionKey())) !== String(identity.pk).toLowerCase()) throw new Error('The unlocked account does not match this identity.');
  const signer = await resolveActorSigner({ identity, groupId });
  if (!signer) throw new Error('Unlock your account before requesting admission.');
  const ticketNonce = nonceValue(nonce);
  const at = Number.isInteger(Number(createdAt)) ? Math.floor(Number(createdAt)) : Math.floor(Date.now() / 1000);
  const proof = finalizeEvent({
    kind: 20000,
    created_at: at,
    tags: [
      ['purpose', PURPOSE],
      ['h', groupId],
      ['actor', signer.wireSender],
      ['nonce', ticketNonce],
    ],
    content: '',
  }, accountSk);
  if (proof.pubkey !== String(identity.pk).toLowerCase()) throw new Error('Account key does not match the unlocked identity.');
  const shared = nip44.v2.utils.getConversationKey(signer.skBytes, recipient);
  const content = nip44.v2.encrypt(JSON.stringify(proof), shared);
  const event = await buildControlAct({ identity, groupId, kind: 9021, tags: [['h', groupId]], content, createdAt: at });
  if (!event) throw new Error('Could not sign the admission request.');
  return event;
}

export async function openAdmissionRequest({ identity, groupId, event, now = Math.floor(Date.now() / 1000), seenNonces = null } = {}) {
  if (!identity?.pk || !groupId || !event || event.kind !== 9021 || !verifyEvent(event)) {
    throw new Error('Invalid signed admission request.');
  }
  if (tagValue(event, 'h') !== groupId) throw new Error('Admission request names another group.');
  if (getPublicKey(secretBytes(identity.sk)) !== String(identity.pk).toLowerCase()) throw new Error('Account key does not match the unlocked identity.');
  if (getPublicKey(secretBytes(getSessionKey())) !== String(identity.pk).toLowerCase()) throw new Error('The unlocked account does not match this identity.');
  const signer = await resolveActorSigner({ identity, groupId });
  if (!signer) throw new Error('Unlock the owner account to review admission.');
  const actorPin = tagValue(event, 'author').toLowerCase();
  if (!HEX66.test(actorPin) || actorPin.slice(2) !== event.pubkey.toLowerCase()) {
    throw new Error('Admission actor signature does not match its pin.');
  }
  const shared = nip44.v2.utils.getConversationKey(signer.skBytes, event.pubkey);
  let proof;
  try { proof = JSON.parse(nip44.v2.decrypt(event.content, shared)); }
  catch { throw new Error('Admission request is not addressed to this group authority.'); }
  if (!verifyEvent(proof) || proof.kind !== 20000 || proof.content !== '') throw new Error('Invalid account admission proof.');
  if (tagValue(proof, 'purpose') !== PURPOSE || tagValue(proof, 'h') !== groupId) throw new Error('Admission proof names another purpose or group.');
  if (tagValue(proof, 'actor') !== event.pubkey.toLowerCase()) throw new Error('Admission proof names another group actor.');
  const nonce = tagValue(proof, 'nonce').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(nonce)) throw new Error('Invalid admission nonce.');
  if (proof.created_at > now + 60 || now - proof.created_at > MAX_AGE_SECONDS) throw new Error('Admission request expired.');
  if (seenNonces?.has(nonce)) throw new Error('Admission request replay detected.');
  return {
    accountPubkey: proof.pubkey.toLowerCase(),
    actorPubkey: event.pubkey.toLowerCase(),
    actorPin,
    nonce,
    eventId: event.id,
    createdAt: proof.created_at,
  };
}
