import { useEffect, useMemo } from 'react';
import { getCurrentGroupKey, getGrantedEpochsFor, putGroupKey, getDocKey, putDocKey } from '../lib/crypto/groupKeyStore';
import { distributeGroupKey } from '../lib/crypto/groupKeyDistribution';
import { generateGroupKey } from '../lib/crypto/groupCipher';
import { generateDocKey, normalizeDocKey } from '../lib/crypto/groupDocKey';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays, queryWithTimeout } from '../lib/relays';
import { relaysForPeer } from '../lib/dmRelays';
import { currentOwner } from '../db';
import { rememberMembers, publishMemberDocUpdate, loadMemberSnapshot, loadVerifiedMemberSnapshot, setGroupRotationPending, isGroupRotationPending, reconcileRunKey } from '../lib/crypto/groupKeyRotation';
import { decryptMemberBaselines, MEMBER_BASELINE_KIND, memberBaselineTag } from '../lib/crypto/memberBaseline';
const completedRuns = new Map();
const inFlightRuns = new Map();
const memberPubkeys = (members) => Array.from(new Set(
  (Array.isArray(members) ? members : [])
    .map((member) => typeof member === 'string' ? member : member?.pubkey)
    .filter(Boolean)
)).sort();

export function useGroupKeyReconciler({
  groupId,
  isOwner,
  groups,
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
      // Reconciliation may rotate and distribute keys. Its recipient set
      // must come from signed governance standing, never a relay roster that
      // can omit or add members.
      const groupMembers = await loadVerifiedMemberSnapshot(group.id);
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
    isOwner,
    groups,
    syncGroupMessages,
    stableIdentity,
    enabled,
  ]);
}
export async function reconcileGroupKeys({ groupId, members, isOwner, identity }) {
  if (!groupId || !identity?.sk || !identity?.pk || !isOwner || !currentOwner()) return;
  const normalizedMembers = memberPubkeys(members);
  const signature = `${normalizedMembers.join(',')}|${identity.pk}`;
  const current = await getCurrentGroupKey(groupId);
  const epoch = current?.epoch ?? 0;
  const runKey = reconcileRunKey(signature, epoch);
  if (completedRuns.get(groupId) === runKey) return;
  const existing = inFlightRuns.get(groupId);
  if (existing?.runKey === runKey) return existing.promise;
  const promise = reconcile({ groupId, members: normalizedMembers, isOwner, identity })
    .then((result) => {
      const doneEpoch = Number.isInteger(result?.epoch) ? result.epoch : epoch;
      completedRuns.set(groupId, reconcileRunKey(signature, doneEpoch));
      return result;
    })
    .finally(() => {
      if (inFlightRuns.get(groupId)?.promise === promise) inFlightRuns.delete(groupId);
    });
  inFlightRuns.set(groupId, { runKey, promise });
  return promise;
}

async function reconcile({ groupId, members, isOwner, identity }) {
  if (!isOwner) return;
  const pool = await getAuthenticatedPool(identity);
  const publish = async (ev) => {
    const peer = ev.tags?.find((tag) => tag[0] === 'p')?.[1];
    const relays = peer ? await relaysForPeer(identity, peer) : generalRelays.slice();
    const results = await Promise.allSettled(pool.publish(relays.length ? relays : generalRelays, ev));
    if (!results.some(r => r.status === 'fulfilled')) throw new Error('all relays rejected');
  };
  let current = await getCurrentGroupKey(groupId);
  if (!current) {
    // This is an existing group reconciliation path, not group creation: it
    // may reuse a held secret, but must never invent one that could strand
    // members on a prior governance-key generation.
    const reconcilerDocKey = normalizeDocKey((await getDocKey(groupId).catch(() => null))?.bytes);
    if (!reconcilerDocKey) throw new Error('No readable governance-doc key is held; group key bootstrap is blocked until the shared key is recovered.');
    const key = generateGroupKey();
    await putGroupKey(groupId, 1, key);
    current = { epoch: 1, bytes: key };
    await distributeGroupKey({ senderPrivkey: identity.sk, senderPubkey: identity.pk, groupId, epoch: 1, keyBytes: key, recipients: dedupe([...members, identity.pk]), docKey: reconcilerDocKey, publish });
    await safePutSnapshot(groupId, members);
    return { epoch: 1 };
  }
  const prev = await baselineMembers(groupId, identity, pool);
  const prevSet = new Set(prev || []);
  const currentSet = new Set(members);
  const removed = [...prevSet].filter(pk => !currentSet.has(pk));
  if (removed.length > 0) {
    const rotationWasPending = await isGroupRotationPending(groupId);
    // The strip is the removal guarantee: the removed member must be off the
    // snapshot before the new epoch exists, or a failed snapshot write leaves
    // them on the record while the rotation reports success (the same gap
    // rotateGroupEpoch closed with strict). Strict here aborts the removal
    // before putGroupKey stores the new epoch or anything is published.
    const priorDoc = await getDocKey(groupId).catch(() => null);
    const priorDocKey = normalizeDocKey(priorDoc?.bytes);
    if (!priorDocKey) throw new Error('No readable governance-doc key is held; removal rotation is blocked until the key is recovered.');
    const { loadMemberDocHeads } = await import('../lib/crypto/groupDocWire.js');
    const { resolveMembership } = await import('../lib/crypto/groupDoc.js');
    const docHeads = await loadMemberDocHeads(groupId);
    if (!docHeads.length) throw new Error('No verified member-set document is held; removal rotation is blocked until it is recovered.');
    const heldRows = resolveMembership(docHeads[0]);
    const heldMembers = heldRows.map((row) => row.pubkey).sort();
    const nextMembers = [...members].sort();
    const docMembershipChanges = heldMembers.length !== nextMembers.length
      || heldMembers.some((pubkey, index) => pubkey !== nextMembers[index]);
    let reconcilerRotatedDocKey = priorDocKey;
    if (docMembershipChanges) {
      reconcilerRotatedDocKey = generateDocKey();
      if (!(await putDocKey(groupId, (priorDoc?.epoch || 0) + 1, reconcilerRotatedDocKey))) {
        throw new Error('Could not store the rotated governance-doc key; no membership or chat-key change was made.');
      }
    }
    try {
      await setGroupRotationPending(groupId, true);
      await rememberMembers(groupId, members, { strict: true, publishDoc: false });
    } catch (error) {
      if (docMembershipChanges) {
        const restored = await putDocKey(groupId, Number.isInteger(priorDoc?.epoch) ? priorDoc.epoch : 0, priorDocKey);
        if (!restored) throw new Error('Rotation staging failed and the prior governance key could not be restored. Sending and key grants remain paused.', { cause: error });
      }
      if (!rotationWasPending) await setGroupRotationPending(groupId, false).catch(() => {});
      throw error;
    }
    try {
      await publishMemberDocUpdate(groupId, members);
    } catch (error) {
      if (docMembershipChanges && error?.published === false) {
        const restored = await putDocKey(groupId, Number.isInteger(priorDoc?.epoch) ? priorDoc.epoch : 0, priorDocKey);
        if (!restored) throw new Error('The update was refused and the prior governance key could not be restored. Recover the held key before retrying.', { cause: error });
      }
      if (error?.published === false) {
        try {
          await rememberMembers(groupId, heldRows, { strict: true, publishDoc: false });
          if (!rotationWasPending) await setGroupRotationPending(groupId, false);
        } catch (restoreError) {
          throw new Error('The relay refused the governance update, but local rotation state could not be restored. Sending and key grants remain paused until recovery.', { cause: restoreError });
        }
      }
      throw error;
    }
    const nextEpoch = current.epoch + 1;
    const newKey = generateGroupKey();
    await putGroupKey(groupId, nextEpoch, newKey);
    await distributeGroupKey({ senderPrivkey: identity.sk, senderPubkey: identity.pk, groupId, epoch: nextEpoch, keyBytes: newKey, recipients: dedupe([...members, identity.pk]), docKey: reconcilerRotatedDocKey, publish });
    await safePutSnapshot(groupId, members);
    await setGroupRotationPending(groupId, false);
    return { epoch: nextEpoch };
  }
  await safePutSnapshot(groupId, members);

  const recipients = [];
  for (const pk of members) {
    const granted = await getGrantedEpochsFor(groupId, pk);
    if (!granted.has(current.epoch)) recipients.push(pk);
  }
  if (!recipients.length) return { epoch: current.epoch };
  await distributeGroupKey({
    senderPrivkey: identity.sk,
    senderPubkey: identity.pk,
    groupId,
    epoch: current.epoch,
    keyBytes: current.bytes,
    recipients: dedupe([...recipients, identity.pk]),
    publish,
  });
  return { epoch: current.epoch };
}
async function baselineMembers(groupId, identity, pool) {
  const local = await safeGetSnapshot(groupId);
  if (local && local.length) return local;
  try {
    const events = await queryWithTimeout(pool, generalRelays, {
      kinds: [MEMBER_BASELINE_KIND],
      authors: [identity.pk],
      '#d': [memberBaselineTag(groupId)],
    });
    const restored = await decryptMemberBaselines(events, identity.sk, identity.pk, groupId);
    if (restored?.members?.length) {
      await rememberMembers(groupId, restored.members);
      return memberPubkeys(restored.members);
    }
  } catch (error) {
    console.warn('[group-key] Could not restore the membership baseline:', error);
  }
  return null;
}
async function safeGetSnapshot(groupId) {
  try {
    const members = await loadMemberSnapshot(groupId);
    return members ? memberPubkeys(members) : null;
  } catch {
    return null;
  }
}
async function safePutSnapshot(groupId, members) {
  try {
    await rememberMembers(groupId, members);
  } catch (error) {
    console.error('[group-key] Could not store the membership snapshot:', error);
  }
}
function dedupe(arr) { return Array.from(new Set(arr.filter(Boolean))); }
