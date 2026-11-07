// Unwrapping a NIP-59 gift wrap, shared by the DM hook and the push gateway.
//
// A wrapped DM arrives as kind 1059 (the wrap, signed by an anonymous key)
// carrying a kind-13 seal, which carries the rumor: the old kind-4 shape with
// its p/e/client tags and the NIP-44 payload. The recipient's private key
// opens both layers. Legacy bare kind-4 events keep opening during the
// transition so an old message never goes unread.

import { nip44, verifyEvent, getEventHash } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
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
    if (getEventHash(wrap) !== wrap.id || !verifyEvent(wrap)) return null;
    const recipient = getPublicKey(recipientSk);
    const recipients = (wrap.tags || []).filter((tag) => tag[0] === 'p');
    if (recipients.length !== 1 || recipients[0][1] !== recipient) return null;
    const seal = openEnvelope(wrap, recipientSk);
    if (!isSeal(seal) || !verifyEvent(seal)) return null;
    const rumor = openEnvelope(seal, recipientSk);
    if (!rumor || rumor.pubkey !== seal.pubkey || typeof rumor.content !== 'string') return null;
    // A rumor is unsigned by design: NIP-59 seals the hash, not a sig. The id
    // must still match its own serialization, so a relay cannot mutate it.
    if (rumor.id !== getEventHash(rumor)) return null;
    const rumorRecipients = (rumor.tags || []).filter((tag) => tag[0] === 'p');
    if (rumorRecipients.length !== 1 || !/^[0-9a-f]{64}$/i.test(rumorRecipients[0][1] || '')) return null;
    return { seal, rumor };
  } catch {
    return null;
  }
}

// Single verification gate for live and history DM ingestion. Wrapped events
// resolve to the authenticated inner rumor id, so seeing the same rumor via
// two wraps or a later history query does not create two application messages.
// Legacy kind-4 events remain readable but must retain their original Nostr
// signature and event hash.
export function openDmTransportEvent(event, recipientSk) {
  try {
    if (isGiftWrap(event)) {
      const opened = unwrapToRumor(event, recipientSk);
      if (opened?.rumor?.kind !== 4) return null;
      const recipients = (opened.rumor.tags || []).filter((tag) => tag[0] === 'p');
      return recipients.length === 1 && recipients[0][1] === getPublicKey(recipientSk)
        ? opened.rumor
        : null;
    }
    if (event?.kind !== 4 || getEventHash(event) !== event.id || !verifyEvent(event)) return null;
    const recipients = (event.tags || []).filter((tag) => tag[0] === 'p');
    if (recipients.length !== 1 || !/^[0-9a-f]{64}$/i.test(recipients[0][1] || '')) return null;
    return event;
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
