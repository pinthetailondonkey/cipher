import { toHex, fromHex } from './groupCipher';
import { recordGrant, getGrantedEpochsFor, getCurrentGroupKey, putGroupKey } from './groupKeyStore';
import { currentOwner } from '../../db';
import { loadMemberSnapshot } from './groupKeyRotation';

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

// F1 fix (audit finding 1): a kind-4 t:'gkey' bundle re-keys a group on
// install, so any key could re-key any group. The sender must now prove
// standing in the group: the creator, an admin in the stored member snapshot,
// or an ordinary member of record — and only for epochs at or above what this
// device already holds (a stale bundle cannot roll the group back).
//
// The stored snapshot is the relay-signed 39002 list (rememberMembers only
// stores authorized frames). No snapshot, no install: an unknown gid or a
// group this device never synced is refused, which is the takeover path.
// Pure decision, unit-tested directly: the sender must be IN the snapshot,
// and a non-admin of record may not roll the epoch back. (Snapshot shape and
// its relay-signature gate are covered in groupMembership.test.js.)
export function senderAuthorizedForGroupKey({ snapshot, sender, maxEpoch, currentEpoch }) {
  if (!sender || !Array.isArray(snapshot)) return false;
  const row = snapshot.find((member) => {
    const pubkey = typeof member === 'string' ? member : member?.pubkey;
    return String(pubkey || '').toLowerCase() === String(sender).toLowerCase();
  });
  if (!row) return false;
  if (typeof row === 'object' && row.role && row.role !== 'member') return true;
  return !(Number.isInteger(currentEpoch) && Number.isInteger(maxEpoch) && maxEpoch < currentEpoch);
}

export async function senderMayInstallGroupKey({ sender, groupId, maxEpoch }) {
  if (!sender || !groupId) return false;
  const snapshot = await loadMemberSnapshot(groupId);
  if (!Array.isArray(snapshot)) return false;
  const current = await getCurrentGroupKey(groupId);
  return senderAuthorizedForGroupKey({ snapshot, sender, maxEpoch, currentEpoch: current?.epoch });
}

export async function installReceivedGroupKey(payload, sender = null) {
  const rows = parseGroupKeyBundle(payload);
  if (!rows.length || !currentOwner()) return false;
  const { groupId } = rows[0];
  if (rows.some((row) => row.groupId !== groupId)) return false;
  const maxEpoch = Math.max(...rows.map((row) => row.epoch));
  const current = await getCurrentGroupKey(groupId);
  const authorized = await senderMayInstallGroupKey({ sender, groupId, maxEpoch });
  if (!authorized) {
    console.warn('[group-key] A key bundle was not installed: sender is not authorized for this group.', { groupId, epoch: maxEpoch });
    return false;
  }
  if (current && Number.isInteger(current.epoch) && maxEpoch < current.epoch) {
    console.warn('[group-key] A key bundle was not installed: it would roll the group back an epoch.', { groupId, have: current.epoch, offered: maxEpoch });
    return false;
  }
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
