import { db as appDb } from '../../db';
import { getPublicKey } from 'nostr-tools';
import { refetchMembersCached, trustedGroupCreator } from './groupMembership';
import { generateGroupKey, toHex } from './groupCipher';
import { distributeGroupKey } from './groupKeyDistribution';
import { getAllGroupKeys, getCurrentGroupKey, putGroupKey, getDocKey, putDocKey } from './groupKeyStore';
import { generateDocKey, normalizeDocKey } from './groupDocKey';
import { queueMemberBaseline } from './memberBaseline';
import { isJoinDenied, hasPendingJoin } from '../groupJoinQueue';

// A snapshot older than this is not grounds to refuse a key. Re-fetch first.
export const MEMBER_SNAPSHOT_MAX_AGE_SEC = 120;
// A snapshot this far in the future is a skewed relay clock, not a newer list.
export const MEMBER_SNAPSHOT_FUTURE_SKEW_SEC = 120;

export function memberKey(member) {
  const key = typeof member === 'string' ? member : member?.pubkey || '';
  return typeof key === 'string' ? key.toLowerCase() : '';
}

export function normalizeMembers(members) {
  const out = [];
  const seen = new Set();
  for (const member of members || []) {
    const pubkey = memberKey(member);
    if (!pubkey || seen.has(pubkey)) continue;
    seen.add(pubkey);
    if (member && typeof member === 'object') {
      const row = { pubkey, role: member.role || 'member' };
      const actor = String(member.actor || '').toLowerCase();
      if (member.actorVerified === true && /^0[23][0-9a-f]{64}$/.test(actor)) {
        row.actor = actor;
        row.actorVerified = true;
      }
      out.push(row);
    }
    else out.push(pubkey);
  }
  return out;
}

export function reconcileRunKey(memberSignature, epoch) {
  const epochNumber = Number.isInteger(epoch) ? epoch : 0;
  return `${memberSignature}|${epochNumber}`;
}

// Test seam: the membership table lives behind the app DB proxy, which has no
// IndexedDB in node. Tests swap in a table that can fail on purpose.
let membershipDb = null;
export function __setMembershipDbForTests(next) { membershipDb = next || null; }
const memberTable = () => (membershipDb || appDb).groupMemberSigs;

// `strict` rethrows a failed write. The rotation path needs that: a removed
// member must be stripped from the snapshot before the new epoch is stored, so a
// failed strip has to abort the rotation rather than report success.
export async function rememberMembers(groupId, members, { strict = false, pins = null, publishDoc = false } = {}) {
  const normalized = normalizeMembers(members);
  const pubkeys = normalized.map((member) => memberKey(member));
  let roles = {};
  let rotationPending = false;
  const explicitRoles = normalized.some((member) => typeof member === 'object' && member.role);
  const signature = pubkeys.join(',');
  let previousSignature = '';
  if (!explicitRoles) {
    try {
      const existing = await memberTable().get(groupId);
      previousSignature = existing?.signature || '';
      rotationPending = existing?.rotationPending === true;
      const previous = existing?.roles && typeof existing.roles === 'object' ? existing.roles : {};
      for (const pubkey of pubkeys) {
        if (previous[pubkey]) roles[pubkey] = previous[pubkey];
      }
    } catch {
      if (strict) throw new Error('Could not read the pending group-rotation state; the membership snapshot was not changed.');
      roles = {};
    }
  } else {
    for (const member of normalized) {
      if (typeof member === 'object' && member.role) roles[member.pubkey] = member.role;
    }
    try {
      const existing = await memberTable().get(groupId);
      previousSignature = existing?.signature || '';
      rotationPending = existing?.rotationPending === true;
    } catch {
      if (strict) throw new Error('Could not read the pending group-rotation state; the membership snapshot was not changed.');
      previousSignature = '';
    }
  }
  // `members` stays a string array. Dexie indexes that field, and object values fail the put.
  try {
    await memberTable().put({
      groupId,
      signature,
      members: pubkeys,
      roles,
      rotationPending,
      updatedAt: Math.floor(Date.now() / 1000),
    });
    if (publishDoc && signature !== previousSignature) {
      queueMemberBaseline(groupId, pubkeys);
      // A caller must opt in to an authority write. Relay roster and UI
      // reconciliation use this cache for display only; an omission or
      // addition from a relay must never become a signed governance change.
      publishMemberDocUpdate(groupId, pubkeys, { pins }).catch((docError) => {
        console.warn('[group-key] Member-set doc update deferred:', docError?.message || docError);
      });
    }
  } catch (error) {
    if (strict) throw error;
    console.warn('[group-key] Could not store the membership snapshot:', error);
  }
  return pubkeys.map((pubkey) => (roles[pubkey] ? { pubkey, role: roles[pubkey] } : pubkey));
}

// A rotation marker is durable because an accepted governance removal can
// precede successful key distribution. Senders and grant responders fail
// closed while it is set, including after a reload or device restart.
export async function setGroupRotationPending(groupId, pending) {
  if (!groupId) throw new Error('A group is required to update rotation state.');
  const table = memberTable();
  const existing = await table.get(groupId);
  if (!pending && !existing?.rotationPending) return true;
  const row = {
    ...(existing || {}),
    groupId,
    signature: existing?.signature || '',
    members: Array.isArray(existing?.members) ? existing.members : [],
    roles: existing?.roles && typeof existing.roles === 'object' ? existing.roles : {},
    rotationPending: Boolean(pending),
    updatedAt: Math.floor(Date.now() / 1000),
  };
  await table.put(row);
  return true;
}

export async function isGroupRotationPending(groupId) {
  try {
    return (await memberTable().get(groupId))?.rotationPending === true;
  } catch {
    // A failed marker read is treated as pending: availability must not turn
    // an uncertain authorization/key state into permission to send.
    return true;
  }
}

export async function loadMemberSnapshot(groupId) {
  // Doc first (Step 1d): a group with a verified member-set document and its
  // pin answers from the doc; the relay roster is display fallback. Groups
  // without either keep the pre-doc behaviour unchanged.
  const docRecord = await loadDocFirstSnapshotRecord(groupId);
  if (docRecord) return docRecord.members;
  const record = await loadMemberSnapshotRecord(groupId);
  return record ? record.members : null;
}

// The doc publisher behind rememberMembers. Reads this device's held head,
// diffs its membership against the stored roster, folds admit/remove ops onto
// gen+1, signs with the per-group authority key derived from the UNLOCKED
// account secret (sessionKey), stores it verified, publishes to both relay
// sets. Refuses rather than fabricates when pin, head or derivation parity is
// missing: a device that cannot name its signer never signs governance.
// Test seams: owner + pool come from here so the node suite runs the whole
// path without Dexie or sockets.
let docOpEnv = null;
export function __setDocOpEnvForTests(next) { docOpEnv = next || null; }
function docOwner() {
  if (docOpEnv?.owner) return docOpEnv.owner;
  return currentOwner();
}
async function docPool(identity) {
  if (docOpEnv?.publish) return { publish: docOpEnv.publish };
  return getAuthenticatedPool(identity);
}
export async function publishMemberDocUpdate(groupId, pubkeys, { pins = null, roleChanges = null } = {}) {
  const owner = docOwner();
  if (!owner) throw new Error('No account open.');
  const { readAuthorityPin } = await import('./authorityPins.js');
  const { groupAuthorityKey } = await import('./groupAuthority.js');
  const { applyDocOps, signDocEvent, canonicalBody, resolveMembership } = await import('./groupDoc.js');
  const { buildMemberDocEvent, rememberVerifiedDoc, loadMemberDocHeads } = await import('./groupDocWire.js');
  const { getSessionKey } = await import('../sessionKey.js');
  const relays = await import('../relays');

  const pin = readAuthorityPin(owner, groupId);
  if (!pin) throw new Error('No authority pin held for this group.');
  const heads = await loadMemberDocHeads(groupId);
  const head = heads[0];
  if (!head) throw new Error('No member-set doc held for this group.');
  const accountSk = getSessionKey();
  if (!accountSk || accountSk.length !== 32) throw new Error('Account locked; the doc update waits for unlock.');
  const { privateKeyBytes, pin: derivedPin } = await groupAuthorityKey(accountSk, groupId);
  // Derivation parity: the key this device derives must be the one the pin
  // names. A member device that joined by invite has no signing side here.
  if (derivedPin !== String(pin).toLowerCase()) {
    throw new Error('This device does not hold the signing side of this group authority.');
  }
  // New documents are v2 only. Never mint a replacement here: if this signer
  // lost the shared secret, publication must stop so existing members are not
  // stranded by a locally invented key.
  let docKeyForSeal = null;
  try {
    docKeyForSeal = normalizeDocKey((await getDocKey(groupId))?.bytes);
  } catch (error) {
    throw new Error(`Could not read the held governance-doc key: ${error?.message || error}`);
  }
  if (!docKeyForSeal) throw new Error('No readable governance-doc key is held; document publication is blocked until the key is recovered.');

  const before = new Set(resolveMembership(head).map((row) => row.pubkey));
  const after = new Set(normalizeMembers(pubkeys).map(memberKey)
    .filter((pubkey) => /^[0-9a-f]{64}$/.test(pubkey)));
  const verifiedPins = new Map(Object.entries(pins || {})
    .map(([pubkey, actor]) => [String(pubkey).toLowerCase(), String(actor || '').toLowerCase()])
    .filter(([pubkey, actor]) => /^[0-9a-f]{64}$/.test(pubkey) && /^0[23][0-9a-f]{64}$/.test(actor)));
  // A document author can verify its own legacy actor binding locally: the
  // authority signer was just derived from this unlocked account secret, and
  // the public key check ensures the account row really belongs to it. This
  // lets existing v1/v2 groups migrate to proof-backed v3 controls on their
  // next signed document update without trusting old actor hints or a relay.
  const signerAccount = getPublicKey(accountSk).toLowerCase();
  if (signerAccount === String(owner).toLowerCase() && after.has(signerAccount)) {
    verifiedPins.set(signerAccount, derivedPin.toLowerCase());
  }
  const admit = [...after].filter((pubkey) => !before.has(pubkey)).map((pubkey) => {
    // Step 2 slice 3: an admit carries the member's actor pin when this
    // device has verified one (its own derivation, or an act-derived binding
    // the caller passed in). The roster is where the pin→account map lives.
    const pin = verifiedPins.get(pubkey) || '';
    return pin ? { pubkey, pin, actorVerified: true } : pubkey;
  });
  const heldRows = new Map(resolveMembership(head).map((row) => [row.pubkey, row]));
  const bind = [...after].filter((pubkey) => before.has(pubkey) && verifiedPins.has(pubkey))
    .filter((pubkey) => heldRows.get(pubkey)?.actorVerified !== true
      || heldRows.get(pubkey)?.actor !== verifiedPins.get(pubkey))
    .map((pubkey) => ({ pubkey, pin: verifiedPins.get(pubkey), actorVerified: true }));
  const requestedRoles = Object.entries(roleChanges || {}).map(([pubkey, role]) => [
    String(pubkey).toLowerCase(), String(role || '').toLowerCase(),
  ]);
  const unknownRoleChange = requestedRoles.find(([pubkey, role]) => (
    !/^[0-9a-f]{64}$/.test(pubkey) || !['admin', 'member'].includes(role) || !after.has(pubkey)
  ));
  if (unknownRoleChange) throw new Error('Role changes must name an existing governance member and a supported role.');
  if (requestedRoles.some(([pubkey, role]) => pubkey === signerAccount && role !== 'admin')) {
    throw new Error('The governance authority account must remain an administrator.');
  }
  const promote = [];
  const demote = [];
  const activeRows = new Map(resolveMembership(head).map((row) => [row.pubkey, row]));
  // The authority signer is the creator's account in this protocol. Repair old
  // v1/v2 rows on the next signed update so every reader sees the same admin.
  if (signerAccount === String(owner).toLowerCase() && after.has(signerAccount)
    && activeRows.get(signerAccount)?.role !== 'admin') promote.push(signerAccount);
  for (const [pubkey, role] of requestedRoles) {
    const held = activeRows.get(pubkey)?.role;
    if (role === 'admin' && held !== 'admin') promote.push(pubkey);
    if (role === 'member' && held === 'admin') demote.push(pubkey);
  }
  const remove = [...before].filter((pubkey) => !after.has(pubkey));
  let signed = head;
  if (admit.length || bind.length || remove.length || promote.length || demote.length) {
    const nextGen = canonicalBody(head).gen + 1;
    const body = applyDocOps(head, { admit, bind, remove, promote, demote, gen: nextGen });
    if (!body) throw new Error('Could not fold membership ops onto the held head.');
    signed = await signDocEvent(body, privateKeyBytes);
  }
  // H2 stamp: created_at at least now; gen stays the ordering truth.
  const nowSec = Math.floor(Date.now() / 1000);
  const event = await buildMemberDocEvent({
    signedDoc: signed, authoritySk: privateKeyBytes, pin, groupId, createdAt: nowSec,
    docKey: docKeyForSeal,
  });
  if (!event) throw new Error('Could not build the doc event.');
  const pool = await docPool(identityLike(owner, accountSk));
  const targets = [...new Set([...relays.groupRelays, ...relays.generalRelays])].filter(Boolean);
  if (!targets.length) throw new Error('No relay accepted the member-set doc update window.');
  // SimplePool.publish returns per-relay promises; the seam may hand back a
  // single promise instead, which normalizes to the same gate here.
  const published = pool.publish(targets, event);
  const results = await Promise.allSettled(
    Array.isArray(published) ? published : [Promise.resolve(published)],
  );
  if (!results.some((result) => result.status === 'fulfilled')) {
    const error = new Error('Relays rejected the member-set doc update.');
    error.published = false;
    throw error;
  }
  let stored;
  try {
    stored = await rememberVerifiedDoc({ groupId, pin, signed });
  } catch (cause) {
    const error = new Error('The encrypted member-set doc was published but could not be stored locally; refresh it from a relay before another membership change.', { cause });
    error.published = true;
    throw error;
  }
  if (!stored?.stored) {
    const error = new Error('The encrypted member-set doc was published but could not be stored locally; refresh it from a relay before another membership change.');
    error.published = true;
    throw error;
  }
  return signed.id;
}

function identityLike(pkHex, skBytes) {
  return { pk: pkHex, sk: toHex(skBytes) };
}

async function loadDocFirstSnapshotRecord(groupId) {
  try {
    const { loadDocStanding } = await import('./memberDocStanding.js');
    const standing = await loadDocStanding(groupId);
    // null is "no verified doc held"; an EMPTY array is still a held doc
    // (everyone removed), and the doc branch must own that answer.
    if (!Array.isArray(standing)) return null;
    return { members: standing, updatedAt: Math.floor(Date.now() / 1000), source: 'doc' };
  } catch {
    return null;
  }
}

// Authorization callers that must not fall back to a relay roster use this
// explicit read. `null` means no verified governance document is held; an
// empty array means a held document intentionally has no current members.
export async function loadVerifiedMemberSnapshot(groupId) {
  const record = await loadDocFirstSnapshotRecord(groupId);
  return Array.isArray(record?.members) ? record.members : null;
}

export async function loadMemberSnapshotRecord(groupId) {
  try {
    const row = await memberTable().get(groupId);
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
 * Rows 1/2 (successful re-read) and rows 3-5 apply when NO verified doc is
 * held. When this device holds one, its membership decides the `named`
 * column for every row — a relay can confirm but not widen (SEC-3).
 *
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
  // Drills D3-C: a same-second tie used to count as "covers" — the exact
  // equality a mid-flight rotation stamps — and shipped a withheld key.
  // The tie is now fail-closed and the row is strictly newer.
  ['fails', 'strictly newer', 'yes', 'allow'],
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
  selfCreated = false,
  verifiedMembers = null,
}) {
  if (!requester) return 'deny';
  // F3: a self-claimed creator buys nothing. The shortcut fires only when the
  // claim has standing — this device created the group, or the claimed
  // creator holds a non-member role in the relay-signed snapshot — and the
  // requester is that vetted name.
  const vetted = trustedGroupCreator({ creator, selfCreated, snapshot });
  if (vetted && requester === vetted) return 'allow';
  // SEC-3: when this device holds a pin-verified member-set document, its
  // membership IS the answer. A relay roster is a list the relay writes about
  // anyone, so "add an account to my own roster" used to be enough to mint a
  // key recipient — worse, a successful re-read decided on the relay list
  // ALONE (rows 1/2), so the doc's stricter truth was never consulted. The
  // doc names the requester or it does not; the relay can only confirm.
  const holdsVerified = Array.isArray(verifiedMembers);
  const named = holdsVerified
    ? requesterMayReceiveKey(verifiedMembers, requester)
    : requesterMayReceiveKey(snapshot, requester);
  const age = Number.isFinite(updatedAt) ? nowSec - updatedAt : Infinity;
  const clockOk = age >= -MEMBER_SNAPSHOT_FUTURE_SKEW_SEC;
  const fresh = clockOk
    && age <= MEMBER_SNAPSHOT_MAX_AGE_SEC
    && Array.isArray(snapshot);
  const snapshotCoversKey = named
    && clockOk
    && Number.isFinite(updatedAt)
    && (!Number.isFinite(keyObtainedAt) || updatedAt > keyObtainedAt);
  // A fresh list that already covers this key does not need a re-read.
  // A list older than the key never takes this path, even inside 120s.
  // Strictly newer (drills D3-C): a same-second tie reads as "older" and
  // falls to the re-read, fail-closed — whole-second stamps collapse the
  // "newer" question at exactly the moment a rotation is mid-flight.
  if (refetched === undefined) {
    if (fresh && snapshotCoversKey) return 'allow';
    return 'refetch';
  }
  // Successful re-read. A held verified doc is the source of truth; without
  // one the fresh relay list is the answer, exactly as before.
  if (Array.isArray(refetched)) {
    if (holdsVerified) return named ? 'allow' : 'deny';
    return requesterMayReceiveKey(refetched, requester) ? 'allow' : 'deny';
  }
  // Failed re-read, but a verified doc is held: the doc already answered.
  if (holdsVerified) return named ? 'allow' : 'deny';
  // Failed re-read and no doc. Rows 3 and 4 of GRANT_DECISION_TABLE.
  return snapshotCoversKey ? 'allow' : 'deny';
}

export async function resolveKeyRequest({
  requester,
  creator,
  snapshot,
  updatedAt,
  keyObtainedAt,
  nowSec,
  selfCreated = false,
  verifiedMembers = null,
  refetch,
}) {
  let decision = keyRequestDecision({
    requester, creator, snapshot, updatedAt, keyObtainedAt, nowSec, selfCreated, verifiedMembers,
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
    requester, creator, snapshot, updatedAt, keyObtainedAt, nowSec, selfCreated, refetched, verifiedMembers,
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
  selfCreated = false,
  fetchMembers,
}) {
  if (await isGroupRotationPending(groupId)) return 'deny';
  // A pin-verified v1/v2/v3 document is the only authorization source for a
  // key grant. Historical signed documents remain readable, but an absent or
  // temporarily unreadable document is not a legacy-mode signal: letting the
  // relay roster fill that gap would let a relay mint recipients exactly when
  // the signed state is unavailable. Such groups must recover the document
  // from an authorized member before key delivery resumes.
  let verifiedMembers = null;
  try {
    const docRecord = await loadDocFirstSnapshotRecord(groupId);
    // An empty standing is still a held doc (everyone was removed), so the
    // test is `is an array`, not `is a non-empty array`.
    if (Array.isArray(docRecord?.members)) verifiedMembers = docRecord.members;
  } catch { return 'deny'; }
  if (!Array.isArray(verifiedMembers)) return 'deny';
  // H1 fix (round-three re-hack): the deny outvotes the relay on the GRANT
  // path too, not only on the 9021 replay arm. The cached-snapshot fast
  // path and a relay-widened re-read both used to grant a key to a peer
  // the owner already denied. Key provision to a denied person is refused
  // outright, whatever the roster happens to name right now.
  if (isJoinDenied(groupId, requester)) return 'deny';
  // Drills D1-B/D1-D: a queued-but-never-approved sender gets nothing from
  // any roster that names them, cached or relay-fresh. The owner approves
  // by dropping the row — only then can a roster decision stand.
  if (hasPendingJoin(groupId, requester)) return 'deny';
  return resolveKeyRequest({
    requester,
    creator,
    snapshot,
    updatedAt,
    keyObtainedAt,
    selfCreated,
    verifiedMembers,
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
  const rotationWasPending = await isGroupRotationPending(groupId);
  const current = await getCurrentGroupKey(groupId);
  if (!current) return { rotated: false, reason: 'no-key' };
  const priorDoc = await getDocKey(groupId).catch(() => null);
  const priorDocKey = normalizeDocKey(priorDoc?.bytes);
  if (!priorDocKey) {
    return { rotated: false, reason: 'missing-doc-key' };
  }
  const [{ loadMemberDocHeads }, { resolveMembership }] = await Promise.all([
    import('./groupDocWire.js'), import('./groupDoc.js'),
  ]);
  const heads = await loadMemberDocHeads(groupId);
  if (!heads.length) return { rotated: false, reason: 'missing-member-doc' };
  const recipients = [...new Set((remainingPubkeys || []).filter(Boolean))];
  const heldSnapshot = resolveMembership(heads[0]);
  const heldMembers = heldSnapshot.map((row) => row.pubkey).sort();
  const nextMembers = [...recipients].sort();
  const docMembershipChanges = heldMembers.length !== nextMembers.length
    || heldMembers.some((pubkey, index) => pubkey !== nextMembers[index]);
  const nextEpoch = current.epoch + 1;
  const newKey = generateGroupKey();
  // Never rotate chat membership when the shared governance secret is absent
  // or unreadable. A fresh local secret would strand every current member.
  let rotatedDocKey = priorDocKey;
  if (docMembershipChanges) {
    rotatedDocKey = generateDocKey();
    const storedDocKey = await putDocKey(groupId, (priorDoc?.epoch || 0) + 1, rotatedDocKey);
    if (!storedDocKey) throw new Error('Could not store the rotated governance-doc key; membership and chat keys were left unchanged. Unlock storage and retry.');
  }
  // Stage the local recipient set and a durable send/grant barrier before the
  // signed removal can reach a relay. A failed cache write therefore cannot
  // leave a published authorization change paired with the old chat epoch.
  try {
    await setGroupRotationPending(groupId, true);
  } catch (error) {
    if (docMembershipChanges) {
      const restoredKey = await putDocKey(groupId, Number.isInteger(priorDoc?.epoch) ? priorDoc.epoch : 0, priorDocKey);
      if (!restoredKey) throw new Error('Could not stage rotation state or restore the prior governance key. Recover the held key before retrying.', { cause: error });
    }
    throw error;
  }
  try {
    await rememberMembers(groupId, recipients, { strict: true, publishDoc: false });
  } catch (error) {
    try {
      await rememberMembers(groupId, heldSnapshot, { strict: true, publishDoc: false });
      if (docMembershipChanges) {
        const restoredKey = await putDocKey(groupId, Number.isInteger(priorDoc?.epoch) ? priorDoc.epoch : 0, priorDocKey);
        if (!restoredKey) throw new Error('The prior governance key could not be restored.');
      }
      if (!rotationWasPending) await setGroupRotationPending(groupId, false);
    } catch (restoreError) {
      throw new Error('The local rotation could not be staged or restored. Sending and key grants remain paused until recovery.', { cause: restoreError });
    }
    throw error;
  }
  // Publish the new document under its stored key. A definite refusal is safe
  // to roll back; an accepted event whose local persistence failed keeps the
  // barrier and new key so relay refresh can recover it.
  try {
    await publishMemberDocUpdate(groupId, recipients);
  } catch (error) {
    if (error?.published === false) {
      if (docMembershipChanges) {
        const restoredKey = await putDocKey(groupId, Number.isInteger(priorDoc?.epoch) ? priorDoc.epoch : 0, priorDocKey);
        if (!restoredKey) throw new Error('The update was refused and the prior governance key could not be restored. Recover the held key before retrying.', { cause: error });
      }
      try {
        await rememberMembers(groupId, heldSnapshot, { strict: true, publishDoc: false });
        if (!rotationWasPending) await setGroupRotationPending(groupId, false);
      } catch (restoreError) {
        throw new Error('The relay refused the governance update, but local rotation state could not be restored. Sending and key grants remain paused until recovery.', { cause: restoreError });
      }
    }
    throw error;
  }
  await putGroupKey(groupId, nextEpoch, newKey);
  // A failed publish must not leave them eligible to re-request the new
  // epoch — the strip above already saw to that.
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
      docKey: rotatedDocKey,
      publish,
    });
  }
  await setGroupRotationPending(groupId, false);
  return { rotated: true, epoch: nextEpoch };
}
