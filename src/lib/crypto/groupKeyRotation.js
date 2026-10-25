import { db } from '../../db';
import { refetchMembersCached } from './groupMembership';
import { generateGroupKey } from './groupCipher';
import { distributeGroupKey } from './groupKeyDistribution';
import { getAllGroupKeys, getCurrentGroupKey, putGroupKey } from './groupKeyStore';
import { queueMemberBaseline } from './memberBaseline';

// A snapshot older than this is not grounds to refuse a key. Re-fetch first.
export const MEMBER_SNAPSHOT_MAX_AGE_SEC = 120;
// A snapshot this far in the future is a skewed relay clock, not a newer list.
export const MEMBER_SNAPSHOT_FUTURE_SKEW_SEC = 120;

export function memberKey(member) {
  return typeof member === 'string' ? member : member?.pubkey || '';
}

export function normalizeMembers(members) {
  const out = [];
  const seen = new Set();
  for (const member of members || []) {
    const pubkey = memberKey(member);
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    if (member && typeof member === 'object') out.push({ pubkey, role: member.role || 'member' });
    else out.push(pubkey);
  }
  return out;
}

export function reconcileRunKey(memberSignature, epoch) {
  const epochNumber = Number.isInteger(epoch) ? epoch : 0;
  return `${memberSignature}|${epochNumber}`;
}

export async function rememberMembers(groupId, members) {
  const normalized = normalizeMembers(members);
  const pubkeys = normalized.map((member) => memberKey(member));
  let roles = {};
  const explicitRoles = normalized.some((member) => typeof member === 'object' && member.role);
  const signature = pubkeys.join(',');
  let previousSignature = '';
  if (!explicitRoles) {
    try {
      const existing = await db.groupMemberSigs.get(groupId);
      previousSignature = existing?.signature || '';
      const previous = existing?.roles && typeof existing.roles === 'object' ? existing.roles : {};
      for (const pubkey of pubkeys) {
        if (previous[pubkey]) roles[pubkey] = previous[pubkey];
      }
    } catch {
      roles = {};
    }
  } else {
    for (const member of normalized) {
      if (typeof member === 'object' && member.role) roles[member.pubkey] = member.role;
    }
    try {
      const existing = await db.groupMemberSigs.get(groupId);
      previousSignature = existing?.signature || '';
    } catch {
      previousSignature = '';
    }
  }
  // `members` stays a string array. Dexie indexes that field, and object values fail the put.
  try {
    await db.groupMemberSigs.put({
      groupId,
      signature,
      members: pubkeys,
      roles,
      updatedAt: Math.floor(Date.now() / 1000),
    });
    if (signature !== previousSignature) queueMemberBaseline(groupId, pubkeys);
  } catch (error) {
    console.warn('[group-key] Could not store the membership snapshot:', error);
  }
  return pubkeys.map((pubkey) => (roles[pubkey] ? { pubkey, role: roles[pubkey] } : pubkey));
}

export async function loadMemberSnapshot(groupId) {
  const record = await loadMemberSnapshotRecord(groupId);
  return record ? record.members : null;
}

export async function loadMemberSnapshotRecord(groupId) {
  try {
    const row = await db.groupMemberSigs.get(groupId);
    if (!Array.isArray(row?.members)) return null;
    const roles = row.roles && typeof row.roles === 'object' ? row.roles : {};
    const members = row.members.filter(Boolean).map((member) => {
      const pubkey = memberKey(member);
      const role = roles[pubkey] || (member && typeof member === 'object' ? member.role : '');
      return role ? { pubkey, role } : pubkey;
    });
    return { members, updatedAt: row.updatedAt };
  } catch {
    return null;
  }
}

export function requesterMayReceiveKey(snapshot, requester) {
  if (!requester || !Array.isArray(snapshot)) return false;
  return snapshot.some((member) => memberKey(member) === requester);
}

/**
 * | Re-read  | Cached list vs key age | Names peer? | Result |
 * | -------- | ---------------------- | ----------- | ------ |
 * | succeeds | —                      | yes         | allow  |
 * | succeeds | —                      | no          | deny   |
 * | fails    | newer or equal         | yes         | allow  |
 * | fails    | older                  | yes         | deny   |
 * | fails    | none                   | —           | deny   |
 *
 * Rows 3 and 4 differ. A failed re-read still grants a list that names the
 * peer and is at least as new as the key. It does not grant an older list.
 * A successful re-read is the whole answer: the cached list's age is ignored.
 */
export const GRANT_DECISION_TABLE = [
  ['succeeds', '—', 'yes', 'allow'],
  ['succeeds', '—', 'no', 'deny'],
  ['fails', 'newer or equal', 'yes', 'allow'],
  ['fails', 'older', 'yes', 'deny'],
  ['fails', 'none', '—', 'deny'],
];
export function keyRequestDecision({
  requester,
  creator,
  snapshot,
  updatedAt,
  nowSec = Math.floor(Date.now() / 1000),
  refetched,
  keyObtainedAt,
}) {
  if (!requester) return 'deny';
  if (creator && requester === creator) return 'allow';
  const named = requesterMayReceiveKey(snapshot, requester);
  const age = Number.isFinite(updatedAt) ? nowSec - updatedAt : Infinity;
  const clockOk = age >= -MEMBER_SNAPSHOT_FUTURE_SKEW_SEC;
  const fresh = clockOk
    && age <= MEMBER_SNAPSHOT_MAX_AGE_SEC
    && Array.isArray(snapshot);
  const snapshotCoversKey = named
    && clockOk
    && Number.isFinite(updatedAt)
    && (!Number.isFinite(keyObtainedAt) || updatedAt >= keyObtainedAt);
  // A fresh list that already covers this key does not need a re-read.
  // A list older than the key never takes this path, even inside 120s.
  if (refetched === undefined) {
    if (fresh && snapshotCoversKey) return 'allow';
    return 'refetch';
  }
  // Successful re-read. The cached list's age is not consulted.
  if (Array.isArray(refetched)) return requesterMayReceiveKey(refetched, requester) ? 'allow' : 'deny';
  // Failed re-read. Rows 3 and 4 of GRANT_DECISION_TABLE.
  return snapshotCoversKey ? 'allow' : 'deny';
}

export async function resolveKeyRequest({
  requester,
  creator,
  snapshot,
  updatedAt,
  keyObtainedAt,
  nowSec,
  refetch,
}) {
  let decision = keyRequestDecision({
    requester, creator, snapshot, updatedAt, keyObtainedAt, nowSec,
  });
  if (decision !== 'refetch') return decision;
  let refetched = null;
  try {
    const result = await refetch();
    refetched = Array.isArray(result) ? result : null;
  } catch {
    refetched = null;
  }
  return keyRequestDecision({
    requester, creator, snapshot, updatedAt, keyObtainedAt, nowSec, refetched,
  });
}

// Live key requests go through here. A list that omits the requester is not a
// refusal until the relay is read again. That read, and a failed read, are
// reused inside the membership cache (the failed read for 45s) so a burst of
// requests does not become a query per request.
export async function grantKeyRequest({
  groupId,
  requester,
  creator,
  snapshot,
  updatedAt,
  keyObtainedAt,
  now = Date.now(),
  fetchMembers,
}) {
  return resolveKeyRequest({
    requester,
    creator,
    snapshot,
    updatedAt,
    keyObtainedAt,
    nowSec: Math.floor(now / 1000),
    refetch: async () => {
      const cached = await refetchMembersCached({
        groupId,
        requester,
        now,
        refetch: fetchMembers,
      });
      return cached.members;
    },
  });
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
