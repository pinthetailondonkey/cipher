// Pairwise transport for the account-signed device registry. The registry is
// never a public Nostr directory: each contact gets a sealed kind-1059 copy
// through the same sender-hidden DM envelope used for ordinary messages.
import { nip44, nip59 } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
import { verifyDeviceRegistryEvent } from './deviceEnrollment.js';
import { rumorTags, sealAndWrap } from './giftWrap.js';
import { unwrapToRumor } from './giftUnwrap.js';

const PAYLOAD_PROTOCOL = 'cipher-private-device-registry';
const HEX64 = /^[0-9a-f]{64}$/;

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function buildPrivateDeviceRegistryWrap({ registryEvent, senderSecret, recipientPubkey, now = Math.floor(Date.now() / 1000) }) {
  const senderPubkey = senderSecret instanceof Uint8Array && senderSecret.length === 32
    ? getPublicKey(senderSecret)
    : '';
  const recipient = String(recipientPubkey || '').toLowerCase();
  if (!senderPubkey || !HEX64.test(recipient)
    || !verifyDeviceRegistryEvent(registryEvent, senderPubkey, now)) {
    throw new Error('A valid account-signed device registry and private recipient are required.');
  }
  const body = JSON.stringify({ protocol: PAYLOAD_PROTOCOL, version: 1, registryEvent });
  const shared = nip44.v2.utils.getConversationKey(senderSecret, recipient);
  const rumor = nip59.createRumor({
    kind: 4,
    created_at: now,
    tags: rumorTags({ recipient }),
    content: nip44.v2.encrypt(body, shared),
  }, senderSecret);
  return sealAndWrap(rumor, { senderSk: senderSecret, recipientPubkey: recipient }).wrap;
}

export function openPrivateDeviceRegistryWrap({ wrap, recipientSecret, now = Math.floor(Date.now() / 1000) }) {
  try {
    const opened = unwrapToRumor(wrap, recipientSecret);
    const recipient = getPublicKey(recipientSecret);
    const rumor = opened?.rumor;
    const recipientTags = (rumor?.tags || []).filter((tag) => tag[0] === 'p');
    if (rumor?.kind !== 4 || recipientTags.length !== 1 || recipientTags[0][1] !== recipient) return null;
    const shared = nip44.v2.utils.getConversationKey(recipientSecret, rumor.pubkey);
    const body = parseJson(nip44.v2.decrypt(rumor.content, shared));
    if (body?.protocol !== PAYLOAD_PROTOCOL || body?.version !== 1) return null;
    const registry = verifyDeviceRegistryEvent(body.registryEvent, rumor.pubkey, now);
    if (!registry) return null;
    return { senderPubkey: rumor.pubkey, event: body.registryEvent, registry };
  } catch {
    return null;
  }
}
