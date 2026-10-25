import { toHex, fromHex } from './groupCipher';
import { recordGrant, getGrantedEpochsFor, putGroupKey } from './groupKeyStore';
import { currentOwner } from '../../db';

const KEY_HEX = /^[0-9a-f]{64}$/i;

export function parseGroupKeyBundle(payload) {
  if (!payload || (payload.t !== 'gkey' && payload.type !== 'gkey')) return [];
  const groupId = payload.gid || payload.groupId;
  if (typeof groupId !== 'string' || !groupId) return [];
  const out = [];
  for (const item of payload.keys || []) {
    const epoch = Number(item?.ep ?? item?.epoch);
    const hex = String(item?.k || item?.key || '');
    if (!Number.isInteger(epoch) || epoch < 0 || !KEY_HEX.test(hex)) continue;
    out.push({ groupId, epoch, hex: hex.toLowerCase() });
  }
  return out;
}

export async function installReceivedGroupKey(payload) {
  const rows = parseGroupKeyBundle(payload);
  if (!rows.length || !currentOwner()) return false;
  for (const row of rows) await putGroupKey(row.groupId, row.epoch, fromHex(row.hex));
  return true;
}

export function epochsToBackfill(allEpochs, currentEpoch) {
  return (allEpochs || []).filter((item) => item && item.epoch !== currentEpoch && item.bytes);
}

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
