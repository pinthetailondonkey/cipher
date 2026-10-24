import { toHex } from './groupCipher';
import { recordGrant, getGrantedEpochsFor } from './groupKeyStore';
export async function distributeGroupKey({ senderPrivkey, senderPubkey, groupId, epoch, keyBytes, recipients, publish, extraEpochs = [] }) {
  const { nip44, finalizeEvent } = await import('nostr-tools');
  const now = Math.floor(Date.now() / 1000);
  const results = await Promise.allSettled(recipients.map(async (recipientPubkey) => {
    const granted = await getGrantedEpochsFor(groupId, recipientPubkey);
    const bundles = [];
    if (!granted.has(epoch)) bundles.push({ ep: epoch, k: toHex(keyBytes) });
    for (const e of extraEpochs) { if (!granted.has(e.epoch)) bundles.push({ ep: e.epoch, k: toHex(e.bytes) }); }
    if (!bundles.length) return;
    const payload = { v: 1, t: 'gkey', gid: groupId, by: senderPubkey, at: now, keys: bundles };
    const shared = nip44.v2.utils.getConversationKey(senderPrivkey, recipientPubkey);
    const wrapped = nip44.v2.encrypt(JSON.stringify(payload), shared);
    const event = finalizeEvent({ kind: 4, created_at: now, tags: [['p', recipientPubkey]], content: wrapped }, senderPrivkey);
    await publish(event);
    for (const bundle of bundles) await recordGrant(groupId, recipientPubkey, bundle.ep);
  }));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(`Could not distribute group keys to ${failures.length} member(s).`);
  }
}
