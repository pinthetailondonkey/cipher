// Unwrapping a NIP-59 gift wrap, shared by the DM hook and the push gateway.
//
// A wrapped DM arrives as kind 1059 (the wrap, signed by an anonymous key)
// carrying a kind-13 seal, which carries the rumor: the old kind-4 shape with
// its p/e/client tags and the NIP-44 payload. The recipient's private key
// opens both layers. Legacy bare kind-4 events keep opening during the
// transition so an old message never goes unread.

import { nip44, verifyEvent, getEventHash } from 'nostr-tools';
import { GIFT_WRAP_KIND, SEAL_KIND } from './giftWrap.js';

export function isGiftWrap(event) {
  return event?.kind === GIFT_WRAP_KIND;
}

export function isSeal(event) {
  return event?.kind === SEAL_KIND;
}

function openEnvelope(envelope, recipientSk) {
  // NIP-44 against the envelope's own pubkey: the wrap layer keys off the
  // random wrapper, the seal layer off the sender.
  const shared = nip44.v2.utils.getConversationKey(recipientSk, envelope.pubkey);
  const text = nip44.v2.decrypt(envelope.content, shared);
  return JSON.parse(text);
}

// Opens a wrap and hands back both layers: the verified kind-13 seal and the
// rumor it carried (content still the encrypted string, tags intact). Null
// when this key cannot open it or the inner shapes are not what NIP-59
// promises. A malformed input never throws: the relay can hand us anything.
export function unwrapToRumor(wrap, recipientSk) {
  if (!isGiftWrap(wrap)) return null;
  try {
    const seal = openEnvelope(wrap, recipientSk);
    if (!isSeal(seal) || !verifyEvent(seal)) return null;
    const rumor = openEnvelope(seal, recipientSk);
    if (!rumor || rumor.pubkey !== seal.pubkey || typeof rumor.content !== 'string') return null;
    // A rumor is unsigned by design: NIP-59 seals the hash, not a sig. The id
    // must still match its own serialization, so a relay cannot mutate it.
    if (rumor.id !== getEventHash(rumor)) return null;
    return { seal, rumor };
  } catch {
    return null;
  }
}

// From a sealed payload, read back what the send path hid inside: the buzz
// label rides in the payload's `t` field.
export function labelFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload.t;
  return typeof raw === 'string' ? raw : null;
}
