import { db as appDb } from '../../db';
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

// Test seam: the membership table lives behind the app DB proxy, which has no
// IndexedDB in node. Tests swap in a table that can fail on purpose.
let membershipDb = null;
export function __setMembershipDbForTests(next) { membershipDb = next || null; }
const memberTable = () => (membershipDb || appDb).groupMemberSigs;

// `strict` rethrows a failed write. The rotation path needs that: a removed
// member must be stripped from the snapshot before the new epoch is stored, so a
// failed strip has to abort the rotation rather than report success.
export async function rememberMembers(groupId, members, { strict = false, pins = null, publishDoc = true } = {}) {
  const normalized = normalizeMembers(members);
  const pubkeys = normalized.map((member) => memberKey(member));
  let roles = {};
  const explicitRoles = normalized.some((member) => typeof member === 'object' && member.role);
  const signature = pubkeys.join(',');
  let previousSignature = '';
  if (!explicitRoles) {
    try {
      const existing = await memberTable().get(groupId);
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
      const existing = await memberTable().get(groupId);
      previousSignature = existing?.signature || '';
    } catch {
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
      updatedAt: Math.floor(Date.now() / 1000),
    });
    if (publishDoc && signature !== previousSignature) {
      queueMemberBaseline(groupId, pubkeys);
      // The relay-backed governance doc follows this roster write. Publication
      // is fire-and-forget here, but it fails closed without the held key and
      // leaves the last verified doc head intact if it cannot be published.
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
export async function publishMemberDocUpdate(groupId, pubkeys, { pins = null } = {}) {
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
  const after = new Set((pubkeys || []).map((pubkey) => String(pubkey).toLowerCase()).filter(Boolean));
  const admit = [...after].filter((pubkey) => !before.has(pubkey)).map((pubkey) => {
    // Step 2 slice 3: an admit carries the member's actor pin when this
    // device has verified one (its own derivation, or an act-derived binding
    // the caller passed in). The roster is where the pin→account map lives.
    const pin = typeof pins === 'object' && pins ? String(pins[pubkey] || '').toLowerCase() : '';
    return /^[0-9a-f]{66}$/.test(pin) ? { pubkey, pin } : pubkey;
  });
  const remove = [...before].filter((pubkey) => !after.has(pubkey));
  let signed = head;
  if (admit.length || remove.length) {
    const nextGen = canonicalBody(head).gen + 1;
    const body = applyDocOps(head, { admit, remove, gen: nextGen });
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
    throw new Error('Relays rejected the member-set doc update.');
  }
  const stored = await rememberVerifiedDoc({ groupId, pin, signed });
  if (!stored?.stored) throw new Error('The encrypted member-set doc was published but could not be stored locally; refresh it from a relay before another membership change.');
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
  // SEC-3: the pin-verified member-set document, when this device holds one,
  // is the membership source of truth for this decision. The relay roster is
  // whatever the relay says about its own list — true enough to start, but a
  // relay that adds an account to its own roster must not be able to mint a
  // key recipient once the group has a signed roster of its own.
  let verifiedMembers = null;
  try {
    const docRecord = await loadDocFirstSnapshotRecord(groupId);
    // An empty standing is still a held doc (everyone was removed), so the
    // test is `is an array`, not `is a non-empty array`.
    if (Array.isArray(docRecord?.members)) verifiedMembers = docRecord.members;
  } catch { /* no doc held: the relay roster stays the source, as before */ }
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
  const heldMembers = resolveMembership(heads[0]).map((row) => row.pubkey).sort();
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
  // Publish and hold the removal document under the newly stored secret
  // before changing the chat epoch. A relay failure leaves the old chat key
  // and membership snapshot intact. A retry uses whichever doc key matches
  // the last successfully held document, never a replacement for a no-op.
  await publishMemberDocUpdate(groupId, recipients);
  // Drills D3-C/D3-E: the record is stripped BEFORE the new epoch lands.
  // The old order — key first, strip after — left a window where a grant
  // request saw the new epoch on a record that still named the removed
  // member, and both timestamps stamp the same whole second, so the
  // "newer snapshot" check collapsed to equality and shipped the key the
  // rotation existed to withhold.
  await rememberMembers(groupId, recipients, { strict: true, publishDoc: false });
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
  return { rotated: true, epoch: nextEpoch };
}
