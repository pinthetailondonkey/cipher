import { db } from '../../db';
import { generateGroupKey } from './groupCipher';
import { distributeGroupKey } from './groupKeyDistribution';
import { getAllGroupKeys, getCurrentGroupKey, putGroupKey } from './groupKeyStore';

export async function rememberMembers(groupId, members) {
  const normalized = [...new Set((members || []).filter(Boolean))];
  try {
    await db.groupMemberSigs.put({
      groupId,
      signature: normalized.join(','),
      members: normalized,
      updatedAt: Math.floor(Date.now() / 1000),
    });
  } catch (error) {
    console.warn('[group-key] Could not store the membership snapshot:', error);
  }
  return normalized;
}

export async function loadMemberSnapshot(groupId) {
  try {
    const row = await db.groupMemberSigs.get(groupId);
    return Array.isArray(row?.members) ? row.members.filter(Boolean) : null;
  } catch {
    return null;
  }
}

export function requesterMayReceiveKey(snapshot, requester) {
  return Array.isArray(snapshot) && snapshot.includes(requester);
}

export async function patchMemberSnapshot(groupId, mutate) {
  const snapshot = await loadMemberSnapshot(groupId);
  if (!Array.isArray(snapshot)) return null;
  let next = null;
  try {
    next = mutate(snapshot);
  } catch {
    return null;
  }
  if (!Array.isArray(next)) return null;
  return rememberMembers(groupId, next);
}

export async function rotateGroupEpoch({ identity, groupId, remainingPubkeys, publish }) {
  const current = await getCurrentGroupKey(groupId);
  if (!current) return { rotated: false, reason: 'no-key' };
  const recipients = [...new Set((remainingPubkeys || []).filter(Boolean))];
  const nextEpoch = current.epoch + 1;
  const newKey = generateGroupKey();
  await putGroupKey(groupId, nextEpoch, newKey);
  // Drop the removed member from the snapshot before distribution. A failed
  // publish must not leave them eligible to re-request the new epoch.
  await rememberMembers(groupId, recipients);
  const prior = (await getAllGroupKeys(groupId)).filter((epoch) => epoch.epoch !== nextEpoch);
  if (recipients.length > 0) {
    await distributeGroupKey({
      senderPrivkey: identity.sk,
      senderPubkey: identity.pk,
      groupId,
      epoch: nextEpoch,
      keyBytes: newKey,
      recipients,
      extraEpochs: prior,
      publish,
    });
  }
  return { rotated: true, epoch: nextEpoch };
}
