import { useEffect, useMemo } from 'react';
import { getCurrentGroupKey, getAllGroupKeys, getGrantedEpochsFor, putGroupKey } from '../lib/crypto/groupKeyStore';
import { distributeGroupKey } from '../lib/crypto/groupKeyDistribution';
import { generateGroupKey } from '../lib/crypto/groupCipher';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays } from '../lib/relays';
import { db, currentOwner } from '../db';
const completedRuns = new Map();
const inFlightRuns = new Map();
const memberPubkeys = (members) => Array.from(new Set(
  (Array.isArray(members) ? members : [])
    .map((member) => typeof member === 'string' ? member : member?.pubkey)
    .filter(Boolean)
)).sort();

export function useGroupKeyReconciler({
  groupId,
  members,
  isOwner,
  groups,
  fetchGroupMembers,
  syncGroupMessages,
  identity,
  enabled = true,
}) {
  const stableIdentity = useMemo(
    () => ({ pk: identity?.pk, sk: identity?.sk }),
    [identity?.pk, identity?.sk]
  );

  useEffect(() => {
    if (!enabled || !stableIdentity.sk || !stableIdentity.pk) return undefined;
    const joinedGroups = Array.isArray(groups)
      ? groups.filter((group) => group?.id)
      : groupId ? [{ id: groupId, creator: isOwner ? stableIdentity.pk : '' }] : [];
    if (joinedGroups.length === 0) return undefined;
    let active = true;
    const joinedGroupIds = new Set(joinedGroups.map((group) => group.id));
    const historySyncs = new Map();
    const syncGroupHistory = (id) => {
      if (!syncGroupMessages) return Promise.resolve();
      const existing = historySyncs.get(id);
      if (existing) return existing;
      const promise = Promise.resolve()
        .then(() => syncGroupMessages(id))
        .finally(() => historySyncs.delete(id));
      historySyncs.set(id, promise);
      return promise;
    };

    const syncGroup = async (group) => {
      let groupMembers = group.id === groupId && Array.isArray(members) ? members : null;
      if (!groupMembers && fetchGroupMembers) {
        groupMembers = await fetchGroupMembers(group.id);
      }
      if (!active) return;
      if (Array.isArray(groupMembers) && groupMembers.length > 0 && group.creator === stableIdentity.pk) {
        await reconcileGroupKeys({
          groupId: group.id,
          members: groupMembers,
          isOwner: true,
          identity: stableIdentity,
        });
      }
      if (active) await syncGroupHistory(group.id);
    };

    const syncAllGroups = async () => {
      for (const group of joinedGroups) {
        if (!active) return;
        try {
          await syncGroup(group);
        } catch (error) {
          console.error(`[group-key] Background reconciliation failed for ${group.id}:`, error);
        }
      }
    };

    const handleGroupKeyUpdated = (event) => {
      const updatedGroupId = event.detail?.groupId;
      if (!updatedGroupId || !joinedGroupIds.has(updatedGroupId)) return;
      const group = joinedGroups.find((entry) => entry.id === updatedGroupId);
      if (group && active) {
        syncGroupHistory(updatedGroupId).catch((error) => {
          console.error(`[group-key] History refresh failed for ${updatedGroupId}:`, error);
        });
      }
    };

    const handleOnline = () => {
      syncAllGroups();
    };

    syncAllGroups();
    window.addEventListener('cipher:group-key-updated', handleGroupKeyUpdated);
    window.addEventListener('online', handleOnline);
    return () => {
      active = false;
      window.removeEventListener('cipher:group-key-updated', handleGroupKeyUpdated);
      window.removeEventListener('online', handleOnline);
    };
  }, [
    groupId,
    members,
    isOwner,
    groups,
    fetchGroupMembers,
    syncGroupMessages,
    stableIdentity,
    enabled,
  ]);
}
export async function reconcileGroupKeys({ groupId, members, isOwner, identity }) {
  if (!groupId || !identity?.sk || !identity?.pk || !isOwner || !currentOwner()) return;
  const normalizedMembers = memberPubkeys(members);
  const signature = `${normalizedMembers.join(',')}|${identity.pk}`;
  if (completedRuns.get(groupId) === signature) return;
  const existing = inFlightRuns.get(groupId);
  if (existing?.signature === signature) return existing.promise;
  const promise = reconcile({ groupId, members: normalizedMembers, isOwner, identity })
    .then((result) => {
      completedRuns.set(groupId, signature);
      return result;
    })
    .finally(() => {
      if (inFlightRuns.get(groupId)?.promise === promise) inFlightRuns.delete(groupId);
    });
  inFlightRuns.set(groupId, { signature, promise });
  return promise;
}

async function reconcile({ groupId, members, isOwner, identity }) {
  if (!isOwner) return;
  const pool = await getAuthenticatedPool(identity);
  const publish = async (ev) => {
    const results = await Promise.allSettled(pool.publish(generalRelays, ev));
    if (!results.some(r => r.status === 'fulfilled')) throw new Error('all relays rejected');
  };
  let current = await getCurrentGroupKey(groupId);
  if (!current) {
    const key = generateGroupKey();
    await putGroupKey(groupId, 1, key);
    current = { epoch: 1, bytes: key };
    await distributeGroupKey({ senderPrivkey: identity.sk, senderPubkey: identity.pk, groupId, epoch: 1, keyBytes: key, recipients: dedupe([...members, identity.pk]), publish });
    await safePutSnapshot(groupId, members);
    return;
  }
  const prev = await safeGetSnapshot(groupId);
  const prevSet = new Set(prev || []);
  const currentSet = new Set(members);
  const removed = [...prevSet].filter(pk => !currentSet.has(pk));
  if (removed.length > 0) {
    const nextEpoch = current.epoch + 1;
    const newKey = generateGroupKey();
    await putGroupKey(groupId, nextEpoch, newKey);
    const priorEpochs = (await getAllGroupKeys(groupId)).filter(e => e.epoch !== nextEpoch);
    await distributeGroupKey({ senderPrivkey: identity.sk, senderPubkey: identity.pk, groupId, epoch: nextEpoch, keyBytes: newKey, recipients: dedupe([...members, identity.pk]), extraEpochs: priorEpochs, publish });
    await safePutSnapshot(groupId, members);
    return;
  }
  await safePutSnapshot(groupId, members);

  const allEpochs = await getAllGroupKeys(groupId);
  const recipients = [];
  for (const pk of members) {
    const granted = await getGrantedEpochsFor(groupId, pk);
    if (!granted.has(current.epoch)) recipients.push(pk);
  }
  if (!recipients.length) return;
  await distributeGroupKey({
    senderPrivkey: identity.sk,
    senderPubkey: identity.pk,
    groupId,
    epoch: current.epoch,
    keyBytes: current.bytes,
    recipients: dedupe([...recipients, identity.pk]),
    extraEpochs: allEpochs.filter(e => e.epoch !== current.epoch),
    publish,
  });
}
async function safeGetSnapshot(groupId) {
  try {
    const row = await db.groupMemberSigs.get(groupId);
    return row?.members ? memberPubkeys(row.members) : null;
  } catch {
    return null;
  }
}
async function safePutSnapshot(groupId, members) {
  const normalized = memberPubkeys(members);
  try {
    await db.groupMemberSigs.put({
      groupId,
      signature: normalized.join(','),
      members: normalized,
      updatedAt: Math.floor(Date.now() / 1000),
    });
  } catch {}
}
function dedupe(arr) { return Array.from(new Set(arr.filter(Boolean))); }
