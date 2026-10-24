import { toHex } from './groupCipher';
import { recordGrant, getGrantedEpochsFor } from './groupKeyStore';

export function missingEpochs(granted, epoch, extraEpochs = []) {
  const missing = [];
  if (!granted.has(epoch)) missing.push(epoch);
  for (const prior of extraEpochs) {
    if (prior && !granted.has(prior.epoch) && prior.epoch !== epoch && !missing.includes(prior.epoch)) missing.push(prior.epoch);
  }
  return missing;
}

export async function distributeGroupKey({ senderPrivkey, senderPubkey, groupId, epoch, keyBytes, recipients, publish, extraEpochs = [] }) {
  const { nip44, finalizeEvent } = await import('nostr-tools');
  const now = Math.floor(Date.now() / 1000);
  const results = await Promise.allSettled(recipients.map(async (recipientPubkey) => {
    const granted = await getGrantedEpochsFor(groupId, recipientPubkey);
    const needed = missingEpochs(granted, epoch, extraEpochs);
    if (!needed.length) return;
    const byEpoch = new Map([[epoch, keyBytes], ...extraEpochs.map((item) => [item.epoch, item.bytes])]);
    const bundles = needed.map((ep) => ({ ep, k: toHex(byEpoch.get(ep)) }));
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
