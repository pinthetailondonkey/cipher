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
import { assertSecurityContextOwner } from '../lib/securityContextFence';
const completedRuns = new Map();
const inFlightRuns = new Map();
const assertCurrent = (identity) => assertSecurityContextOwner(identity?.securityFence, identity?.pk);
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
    () => ({ pk: identity?.pk, sk: identity?.sk, securityFence: identity?.securityFence }),
    [identity?.pk, identity?.sk, identity?.securityFence]
  );

  useEffect(() => {
    if (!enabled || !stableIdentity.sk || !stableIdentity.pk || !stableIdentity.securityFence) return undefined;
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
      assertCurrent(stableIdentity);
      const groupMembers = await loadVerifiedMemberSnapshot(group.id);
      if (!active) return;
      assertCurrent(stableIdentity);
      if (Array.isArray(groupMembers) && groupMembers.length > 0 && group.creator === stableIdentity.pk) {
        await reconcileGroupKeys({
          groupId: group.id,
          members: groupMembers,
          isOwner: true,
          identity: stableIdentity,
        });
      }
      if (active) {
        assertCurrent(stableIdentity);
        await syncGroupHistory(group.id);
        assertCurrent(stableIdentity);
      }
    };

    const syncAllGroups = async () => {
      for (const group of joinedGroups) {
        if (!active) return;
        try {
          await syncGroup(group);
        } catch (error) {
          if (error?.code === 'SECURITY_CONTEXT_EXPIRED') return;
          console.error(`[group-key] Background reconciliation failed for ${group.id}:`, error);
        }
      }
    };

    const handleGroupKeyUpdated = (event) => {
      const updatedGroupId = event.detail?.groupId;
      if (!updatedGroupId || !joinedGroupIds.has(updatedGroupId)) return;
      const group = joinedGroups.find((entry) => entry.id === updatedGroupId);
      if (group && active) {
        try { assertCurrent(stableIdentity); } catch { return; }
        syncGroupHistory(updatedGroupId).catch((error) => {
          if (error?.code === 'SECURITY_CONTEXT_EXPIRED') return;
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
  assertCurrent(identity);
  const normalizedMembers = memberPubkeys(members);
  const signature = `${normalizedMembers.join(',')}|${identity.pk}`;
  const current = await getCurrentGroupKey(groupId, identity.securityFence);
  assertCurrent(identity);
  const epoch = current?.epoch ?? 0;
  const runKey = reconcileRunKey(signature, epoch);
  if (completedRuns.get(groupId) === runKey) return;
  const existing = inFlightRuns.get(groupId);
  const incarnation = identity.securityFence.context.incarnation;
  if (existing?.runKey === runKey) {
    if (existing.incarnation === incarnation) return existing.promise;
    return existing.promise.catch(() => {}).then(() => reconcileGroupKeys({ groupId, members, isOwner, identity }));
  }
  const promise = reconcile({ groupId, members: normalizedMembers, isOwner, identity })
    .then((result) => {
      assertCurrent(identity);
      const doneEpoch = Number.isInteger(result?.epoch) ? result.epoch : epoch;
      completedRuns.set(groupId, reconcileRunKey(signature, doneEpoch));
      return result;
    })
    .finally(() => {
      if (inFlightRuns.get(groupId)?.promise === promise) inFlightRuns.delete(groupId);
    });
  inFlightRuns.set(groupId, { runKey, incarnation, promise });
  return promise;
}

async function reconcile({ groupId, members, isOwner, identity }) {
  if (!isOwner) return;
  assertCurrent(identity);
  const pool = await getAuthenticatedPool(identity);
  assertCurrent(identity);
  const publish = async (ev) => {
    assertCurrent(identity);
    const peer = ev.tags?.find((tag) => tag[0] === 'p')?.[1];
    const relays = peer ? await relaysForPeer(identity, peer) : generalRelays.slice();
    assertCurrent(identity);
    const results = await Promise.allSettled(pool.publish(relays.length ? relays : generalRelays, ev));
    assertCurrent(identity);
    if (!results.some(r => r.status === 'fulfilled')) throw new Error('all relays rejected');
  };
  let current = await getCurrentGroupKey(groupId, identity.securityFence);
  assertCurrent(identity);
  if (!current) {
    // This is an existing group reconciliation path, not group creation: it
    // may reuse a held secret, but must never invent one that could strand
    // members on a prior governance-key generation.
    const reconcilerDocKey = normalizeDocKey((await getDocKey(groupId, identity.securityFence).catch((error) => {
      if (error?.code === 'SECURITY_CONTEXT_EXPIRED') throw error;
      return null;
    }))?.bytes);
    assertCurrent(identity);
    if (!reconcilerDocKey) throw new Error('No readable governance-doc key is held; group key bootstrap is blocked until the shared key is recovered.');
    const key = generateGroupKey();
    assertCurrent(identity);
    await putGroupKey(groupId, 1, key, {}, identity.securityFence);
    assertCurrent(identity);
    current = { epoch: 1, bytes: key };
    await distributeGroupKey({ senderPrivkey: identity.sk, senderPubkey: identity.pk, groupId, epoch: 1, keyBytes: key, recipients: dedupe([...members, identity.pk]), docKey: reconcilerDocKey, publish, securityFence: identity.securityFence });
    assertCurrent(identity);
    await safePutSnapshot(groupId, members, identity);
    return { epoch: 1 };
  }
  const prev = await baselineMembers(groupId, identity, pool);
  assertCurrent(identity);
  const prevSet = new Set(prev || []);
  const currentSet = new Set(members);
  const removed = [...prevSet].filter(pk => !currentSet.has(pk));
  if (removed.length > 0) {
    const rotationWasPending = await isGroupRotationPending(groupId);
    assertCurrent(identity);
    // The strip is the removal guarantee: the removed member must be off the
    // snapshot before the new epoch exists, or a failed snapshot write leaves
    // them on the record while the rotation reports success (the same gap
    // rotateGroupEpoch closed with strict). Strict here aborts the removal
    // before putGroupKey stores the new epoch or anything is published.
    const priorDoc = await getDocKey(groupId, identity.securityFence).catch((error) => {
      if (error?.code === 'SECURITY_CONTEXT_EXPIRED') throw error;
      return null;
    });
    assertCurrent(identity);
    const priorDocKey = normalizeDocKey(priorDoc?.bytes);
    if (!priorDocKey) throw new Error('No readable governance-doc key is held; removal rotation is blocked until the key is recovered.');
    const { loadMemberDocHeads } = await import('../lib/crypto/groupDocWire.js');
    assertCurrent(identity);
    const { resolveMembership } = await import('../lib/crypto/groupDoc.js');
    assertCurrent(identity);
    const docHeads = await loadMemberDocHeads(groupId);
    assertCurrent(identity);
    if (!docHeads.length) throw new Error('No verified member-set document is held; removal rotation is blocked until it is recovered.');
    const heldRows = resolveMembership(docHeads[0]);
    const heldMembers = heldRows.map((row) => row.pubkey).sort();
    const nextMembers = [...members].sort();
    const docMembershipChanges = heldMembers.length !== nextMembers.length
      || heldMembers.some((pubkey, index) => pubkey !== nextMembers[index]);
    let reconcilerRotatedDocKey = priorDocKey;
    if (docMembershipChanges) {
      reconcilerRotatedDocKey = generateDocKey();
      assertCurrent(identity);
      if (!(await putDocKey(groupId, (priorDoc?.epoch || 0) + 1, reconcilerRotatedDocKey, identity.securityFence))) {
        throw new Error('Could not store the rotated governance-doc key; no membership or chat-key change was made.');
      }
      assertCurrent(identity);
    }
    try {
      assertCurrent(identity);
      await setGroupRotationPending(groupId, true, { securityFence: identity.securityFence, owner: identity.pk });
      assertCurrent(identity);
      await rememberMembers(groupId, members, { strict: true, publishDoc: false, securityFence: identity.securityFence, owner: identity.pk });
      assertCurrent(identity);
    } catch (error) {
      if (docMembershipChanges) {
        assertCurrent(identity);
        const restored = await putDocKey(groupId, Number.isInteger(priorDoc?.epoch) ? priorDoc.epoch : 0, priorDocKey, identity.securityFence);
        assertCurrent(identity);
        if (!restored) throw new Error('Rotation staging failed and the prior governance key could not be restored. Sending and key grants remain paused.', { cause: error });
      }
      if (!rotationWasPending) {
        assertCurrent(identity);
        await setGroupRotationPending(groupId, false, { securityFence: identity.securityFence, owner: identity.pk }).catch(() => {});
      }
      throw error;
    }
    try {
      assertCurrent(identity);
      await publishMemberDocUpdate(groupId, members, { securityFence: identity.securityFence, owner: identity.pk });
      assertCurrent(identity);
    } catch (error) {
      if (docMembershipChanges && error?.published === false) {
        assertCurrent(identity);
        const restored = await putDocKey(groupId, Number.isInteger(priorDoc?.epoch) ? priorDoc.epoch : 0, priorDocKey, identity.securityFence);
        assertCurrent(identity);
        if (!restored) throw new Error('The update was refused and the prior governance key could not be restored. Recover the held key before retrying.', { cause: error });
      }
      if (error?.published === false) {
        try {
          assertCurrent(identity);
          await rememberMembers(groupId, heldRows, { strict: true, publishDoc: false, securityFence: identity.securityFence, owner: identity.pk });
          assertCurrent(identity);
          if (!rotationWasPending) {
            await setGroupRotationPending(groupId, false, { securityFence: identity.securityFence, owner: identity.pk });
            assertCurrent(identity);
          }
        } catch (restoreError) {
          throw new Error('The relay refused the governance update, but local rotation state could not be restored. Sending and key grants remain paused until recovery.', { cause: restoreError });
        }
      }
      throw error;
    }
    const nextEpoch = current.epoch + 1;
    const newKey = generateGroupKey();
    assertCurrent(identity);
    await putGroupKey(groupId, nextEpoch, newKey, {}, identity.securityFence);
    assertCurrent(identity);
    await distributeGroupKey({ senderPrivkey: identity.sk, senderPubkey: identity.pk, groupId, epoch: nextEpoch, keyBytes: newKey, recipients: dedupe([...members, identity.pk]), docKey: reconcilerRotatedDocKey, publish, securityFence: identity.securityFence });
    assertCurrent(identity);
    await safePutSnapshot(groupId, members, identity);
    assertCurrent(identity);
    await setGroupRotationPending(groupId, false, { securityFence: identity.securityFence, owner: identity.pk });
    assertCurrent(identity);
    return { epoch: nextEpoch };
  }
  await safePutSnapshot(groupId, members, identity);
  assertCurrent(identity);

  const recipients = [];
  for (const pk of members) {
    const granted = await getGrantedEpochsFor(groupId, pk, identity.securityFence);
    assertCurrent(identity);
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
    securityFence: identity.securityFence,
  });
  assertCurrent(identity);
  return { epoch: current.epoch };
}
async function baselineMembers(groupId, identity, pool) {
  assertCurrent(identity);
  const local = await safeGetSnapshot(groupId, identity);
  assertCurrent(identity);
  if (local && local.length) return local;
  try {
    const events = await queryWithTimeout(pool, generalRelays, {
      kinds: [MEMBER_BASELINE_KIND],
      authors: [identity.pk],
      '#d': [memberBaselineTag(groupId)],
    });
    assertCurrent(identity);
    const restored = await decryptMemberBaselines(events, identity.sk, identity.pk, groupId);
    assertCurrent(identity);
    if (restored?.members?.length) {
      assertCurrent(identity);
      await rememberMembers(groupId, restored.members, { securityFence: identity.securityFence, owner: identity.pk });
      assertCurrent(identity);
      return memberPubkeys(restored.members);
    }
  } catch (error) {
    if (error?.code === 'SECURITY_CONTEXT_EXPIRED') throw error;
    console.warn('[group-key] Could not restore the membership baseline:', error);
  }
  return null;
}
async function safeGetSnapshot(groupId, identity) {
  try {
    assertCurrent(identity);
    const members = await loadMemberSnapshot(groupId);
    assertCurrent(identity);
    return members ? memberPubkeys(members) : null;
  } catch (error) {
    if (error?.code === 'SECURITY_CONTEXT_EXPIRED') throw error;
    return null;
  }
}
async function safePutSnapshot(groupId, members, identity) {
  try {
    assertCurrent(identity);
    await rememberMembers(groupId, members, { securityFence: identity.securityFence, owner: identity.pk });
    assertCurrent(identity);
  } catch (error) {
    if (error?.code === 'SECURITY_CONTEXT_EXPIRED') throw error;
    console.error('[group-key] Could not store the membership snapshot:', error);
  }
}
function dedupe(arr) { return Array.from(new Set(arr.filter(Boolean))); }
