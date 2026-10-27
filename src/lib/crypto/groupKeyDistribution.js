import { toHex, fromHex } from './groupCipher';
import { recordGrant, getGrantedEpochsFor, getCurrentGroupKey, putGroupKey } from './groupKeyStore';
import { currentOwner } from '../../db';
import { loadMemberSnapshot } from './groupKeyRotation';
import { keyRequestRecord } from './groupKeyRequest';

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
export function senderAuthorizedForGroupKey({ snapshot, sender, maxEpoch, currentEpoch }) {
  if (!sender || !Array.isArray(snapshot)) return false;
  const row = snapshot.find((member) => {
    const pubkey = typeof member === 'string' ? member : member?.pubkey;
    return String(pubkey || '').toLowerCase() === String(sender).toLowerCase();
  });
  if (!row) return false;
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
  // Drills D4: the rollback guard is keyed-device-only, so a keyless device —
  // a fresh sync, exactly the window before its own gkey_req round-trip —
  // adopted ANY epoch a member of record shipped as its current key and wrote
  // its first outbound messages under a colluder-held key. The floor: this
  // device accepts a first key only on evidence it asked for one. Nothing
  // installs a group key unsolicited, so an empty request record means the
  // bundle is not the reply to this device's own request. An exhausted record
  // still counts — the ladder stopping does not unmake the ask, and the
  // manual retry (resetKeyRequest) is what renews it.
  if (!current && !keyRequestRecord(currentOwner(), groupId)) {
    console.warn('[group-key] A key bundle was not installed: this device has not asked this group for a key.', { groupId, epoch: maxEpoch });
    return false;
  }
  const authorized = await senderMayInstallGroupKey({ sender, groupId, maxEpoch });
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
  if (current && rows.some((row) => row.epoch === current.epoch && row.hex !== toHex(current.bytes))) {
    console.warn('[group-key] A key bundle was not installed: it re-states the held epoch with different bytes.', { groupId, epoch: current.epoch });
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
