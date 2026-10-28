import { toHex, fromHex } from './groupCipher';
import { recordGrant, getGrantRecords, getCurrentGroupKey, getAllGroupKeys, putGroupKey } from './groupKeyStore';
import { isGroupAdmin, trustedGroupCreator } from './groupMembership';
import { getMyGroups } from '../myGroups';
import { currentOwner } from '../../db';
import { loadMemberSnapshot } from './groupKeyRotation';
import { isJoinDenied } from '../groupJoinQueue';
import { keyRequestRecord } from './groupKeyRequest';
import { markSafetyChange } from '../safetyNumber.js';

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
// F1 fix (audit finding 1): a kind-4 t:'gkey' bundle re-keys a group on
// install, so any key could re-key any group. The sender must now prove
// standing in the group: the creator, an admin in the stored member snapshot,
// or an ordinary member of record — and only for epochs at or above what this
// device already holds (a stale bundle cannot roll the group back).
//
// The stored snapshot is the relay-signed 39002 list (rememberMembers only
// stores authorized frames). No snapshot, no install: an unknown gid or a
// group this device never synced is refused, which is the takeover path.
// Pure decision, unit-tested directly: the sender must be IN the snapshot.
// (Snapshot shape and its relay-signature gate are covered in
// groupMembership.test.js.)
//
// H2 fix (round-three re-hack): a role string from the relay is a CLAIM the
// relay can write about anyone — so no role skips the epoch check. The old
// gate gave any non-member role a free pass to install ANY epoch (an
// epoch-0 rollback verified end-to-end in the repro), which made one
// roster row worth a full key takeover. The epoch rule is uniform now:
// installReceivedGroupKey refuses any rollback for everyone.
//
// Audit finding (any member can force any epoch): standing as a member of
// record used to be enough to install a key at ANY epoch at or above the
// held one, so one ordinary member could ship a key they knew and move the
// whole group onto it. The rule now is by what the bundle does:
//   - no key held yet (the first key, which this device asked for - see the
//     floor in installReceivedGroupKey): a member of record, as before;
//   - a bundle that only restates or backfills epochs at or below the held
//     one: a member of record, as before (installReceivedGroupKey separately
//     refuses to overwrite any held epoch with different bytes);
//   - a bundle that carries an epoch ABOVE the held one is a rotation, and
//     only the creator or an admin rotates. The new epochs must also run on
//     from the held one with no gap (held+1, held+2, ...): a jump past the
//     next epoch is refused, so a sender cannot park the group at a number
//     of their choosing. A device that missed a rotation catches up through
//     its own key request, which is answered with every epoch it lacks.
export function senderAuthorizedForGroupKey({ snapshot, sender, maxEpoch, currentEpoch, creator = '', offeredEpochs = null }) {
  if (!sender || !Array.isArray(snapshot)) return false;
  const row = snapshot.find((member) => {
    const pubkey = typeof member === 'string' ? member : member?.pubkey;
    return String(pubkey || '').toLowerCase() === String(sender).toLowerCase();
  });
  if (!row) return false;
  if (!Number.isInteger(currentEpoch) || !Number.isInteger(maxEpoch)) return true;
  if (maxEpoch < currentEpoch) return false;
  if (maxEpoch === currentEpoch) return true;
  const who = String(sender).toLowerCase();
  const standing = snapshot.map((member) => (typeof member === 'string' ? { pubkey: member.toLowerCase() } : { ...member, pubkey: String(member?.pubkey || '').toLowerCase() }));
  if (!isGroupAdmin(standing, who, String(creator || '').toLowerCase())) return false;
  if (Array.isArray(offeredEpochs)) {
    const above = new Set(offeredEpochs.filter((epoch) => epoch > currentEpoch));
    for (let epoch = currentEpoch + 1; epoch <= maxEpoch; epoch += 1) {
      if (!above.has(epoch)) return false;
    }
  } else if (maxEpoch !== currentEpoch + 1) {
    return false;
  }
  return true;
}

// Never overwrite an epoch this device already holds with different bytes.
// An honest re-delivery or backfill restates the held bytes; a mismatch on
// ANY held epoch (not just the current one) closes the whole bundle.
export function conflictingHeldEpoch(rows, held) {
  const bytes = new Map((held || []).map((item) => [item.epoch, String(item.hex || '').toLowerCase()]));
  const hit = (rows || []).find((row) => bytes.has(row.epoch) && bytes.get(row.epoch) !== String(row.hex || '').toLowerCase());
  return hit ? hit.epoch : null;
}

export async function senderMayInstallGroupKey({ sender, groupId, maxEpoch, offeredEpochs = null }) {
  if (!sender || !groupId) return false;
  const snapshot = await loadMemberSnapshot(groupId);
  if (!Array.isArray(snapshot)) return false;
  const current = await getCurrentGroupKey(groupId);
  const owner = currentOwner();
  const claimed = (getMyGroups(owner).find((group) => group?.id === groupId) || {}).creator;
  const creator = trustedGroupCreator({ creator: claimed, identityPk: owner, snapshot });
  return senderAuthorizedForGroupKey({ snapshot, sender, maxEpoch, currentEpoch: current?.epoch, creator, offeredEpochs });
}

// The floor, as a pure decision: a device with no key installs one only on
// evidence it asked. Kept as it was - an unsolicited bundle is still refused.
export function installFloorAllows({ hasKey, asked }) {
  return Boolean(hasKey || asked);
}

export async function installReceivedGroupKey(payload, sender = null) {
  const rows = parseGroupKeyBundle(payload);
  if (!rows.length || !currentOwner()) return false;
  const { groupId } = rows[0];
  if (rows.some((row) => row.groupId !== groupId)) return false;
  const maxEpoch = Math.max(...rows.map((row) => row.epoch));
  const current = await getCurrentGroupKey(groupId);
  // The receiver arm of the kick wall (drills D2): the owner says who is
  // removed, but that ledger lives on the OWNER's device — the victim's own
  // copy is what stops the re-arm. A device that read its own kick (kind 9001
  // naming it, from an authorized admin) holds a self-removal record, and NO
  // incoming key bundle re-arms it until that device's own add-back receipt
  // (kind 9000) clears the record.
  if (currentOwner() && isJoinDenied(groupId, currentOwner())) {
    console.warn('[group-key] A key bundle was not installed: this device was removed from the group.', { groupId, epoch: maxEpoch });
    return false;
  }
  // Drills D4: the rollback guard is keyed-device-only, so a keyless device —
  // a fresh sync, exactly the window before its own gkey_req round-trip —
  // adopted ANY epoch a member of record shipped as its current key and wrote
  // its first outbound messages under a colluder-held key. The floor: this
  // device accepts a first key only on evidence it asked for one. Nothing
  // installs a group key unsolicited, so an empty request record means the
  // bundle is not the reply to this device's own request. An exhausted record
  // still counts — the ladder stopping does not unmake the ask, and the
  // manual retry (resetKeyRequest) is what renews it.
  if (!installFloorAllows({ hasKey: Boolean(current), asked: Boolean(keyRequestRecord(currentOwner(), groupId)) })) {
    console.warn('[group-key] A key bundle was not installed: this device has not asked this group for a key.', { groupId, epoch: maxEpoch });
    return false;
  }
  const authorized = await senderMayInstallGroupKey({ sender, groupId, maxEpoch, offeredEpochs: rows.map((row) => row.epoch) });
  if (!authorized) {
    console.warn('[group-key] A key bundle was not installed: sender is not authorized for this group.', { groupId, epoch: maxEpoch });
    return false;
  }
  if (current && Number.isInteger(current.epoch) && maxEpoch < current.epoch) {
    console.warn('[group-key] A key bundle was not installed: it would roll the group back an epoch.', { groupId, have: current.epoch, offered: maxEpoch });
    return false;
  }
  // Drills D2: a same-epoch bundle with different bytes is an overwrite, not
  // a roll forward — the current key replaced by a colluder-known one under
  // the same epoch number, which the rollback guard never sees. Honest
  // backfills re-state the held epoch with the held bytes, so only a byte
  // mismatch closes the whole bundle.
  const heldRows = (await getAllGroupKeys(groupId)).map((item) => ({ epoch: item.epoch, hex: toHex(item.bytes) }));
  const conflict = conflictingHeldEpoch(rows, heldRows);
  if (conflict !== null) {
    console.warn('[group-key] A key bundle was not installed: it re-states a held epoch with different bytes.', { groupId, epoch: conflict });
    return false;
  }
  // The safety flag rides the install that changed key material, after
  // the guards all passed — never on a refused bundle.
  const keyMaterialMoved = safetyChangeFromInstall({ currentEpoch: current?.epoch, maxEpoch });
  for (const row of rows) await putGroupKey(row.groupId, row.epoch, fromHex(row.hex));
  if (keyMaterialMoved) markSafetyChange(sender);
  return true;
}

// The dead detector, wired (drill residual): markSafetyChange needed a
// caller. A bundle that moves this device's key forward — the device's
// first key for the group, or a roll past the held epoch — is the
// contact changing the key material this device trusts. The safety
// number itself stays pinned to first-seen; the flag is what a screen
// read of it leads with ("key changed — re-verify"). A re-delivery, a
// backfill of a prior epoch, or a stale bundle moves nothing and flags
// nothing. Pure decision, the same shape as the guard above it.
export function safetyChangeFromInstall({ currentEpoch, maxEpoch }) {
  if (!Number.isInteger(maxEpoch)) return false;
  if (!Number.isInteger(currentEpoch)) return true; // the first key this device holds
  return maxEpoch > currentEpoch;
}

export function epochsToBackfill(allEpochs, currentEpoch) {  return (allEpochs || []).filter((item) => item && item.epoch !== currentEpoch && item.bytes);
}

export function missingEpochs(granted, epoch, extraEpochs = []) {
  const missing = [];
  if (!granted.has(epoch)) missing.push(epoch);
  for (const prior of extraEpochs) {
    if (prior && !granted.has(prior.epoch) && prior.epoch !== epoch && !missing.includes(prior.epoch)) missing.push(prior.epoch);
  }
  return missing;
}

// Bug #9: the grant ledger is a record of what was SENT, not of what a member
// installed - the install floor refuses a key a device did not ask for, so an
// unsolicited bundle (sent when the owner approves a member who has not yet
// asked) is dropped by the member while the ledger says "granted". The
// member's own gkey_req that follows was then skipped by the same ledger and
// never answered, and the composer sat on Securing forever.
//
// An explicit request is therefore never blocked by the ledger. It is answered
// with the current key and every prior epoch, and only rate limited: an epoch
// that already answered a request for this member inside the window is not
// sent again. An unsolicited send (the reconciler's) never counts toward that
// window, so a request arriving right after one is answered at once.
export const REGRANT_WINDOW_SEC = 60;

export function epochsToSend({ records, epoch, extraEpochs = [], explicit = false, nowSec = Math.floor(Date.now() / 1000), windowSec = REGRANT_WINDOW_SEC } = {}) {
  const held = records instanceof Map ? records : new Map();
  if (!explicit) return missingEpochs(new Set(held.keys()), epoch, extraEpochs);
  const all = [epoch];
  for (const prior of extraEpochs) {
    if (prior && !all.includes(prior.epoch)) all.push(prior.epoch);
  }
  return all.filter((ep) => {
    const answeredAt = held.get(ep)?.answeredAt;
    return !(Number.isFinite(answeredAt) && nowSec - answeredAt < windowSec);
  });
}

const grantLedger = { getGrantRecords, recordGrant };

export async function distributeGroupKey({ senderPrivkey, senderPubkey, groupId, epoch, keyBytes, recipients, publish, extraEpochs = [], answerRequest = false, ledger = grantLedger }) {
  const { nip44, finalizeEvent } = await import('nostr-tools');
  const now = Math.floor(Date.now() / 1000);
  const results = await Promise.allSettled(recipients.map(async (recipientPubkey) => {
    const records = await ledger.getGrantRecords(groupId, recipientPubkey);
    const needed = epochsToSend({ records, epoch, extraEpochs, explicit: answerRequest, nowSec: now });
    if (!needed.length) return;
    const byEpoch = new Map([[epoch, keyBytes], ...extraEpochs.map((item) => [item.epoch, item.bytes])]);
    const bundles = needed.map((ep) => ({ ep, k: toHex(byEpoch.get(ep)) }));
    const payload = { v: 1, t: 'gkey', gid: groupId, by: senderPubkey, at: now, keys: bundles };
    const shared = nip44.v2.utils.getConversationKey(senderPrivkey, recipientPubkey);
    const wrapped = nip44.v2.encrypt(JSON.stringify(payload), shared);
    const event = finalizeEvent({ kind: 4, created_at: now, tags: [['p', recipientPubkey]], content: wrapped }, senderPrivkey);
    await publish(event);
    for (const bundle of bundles) await ledger.recordGrant(groupId, recipientPubkey, bundle.ep, { answered: answerRequest });
  }));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(`Could not distribute group keys to ${failures.length} member(s).`);
  }
}
