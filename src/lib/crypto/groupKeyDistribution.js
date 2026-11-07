import { toHex, fromHex } from './groupCipher';
import { docKeysEqual, normalizeDocKey } from './groupDocKey';
import { recordGrant, getGrantRecords, getCurrentGroupKey, getAllGroupKeys, putGroupKey, getDocKey, putDocKey, removeDocKey } from './groupKeyStore';
import { isGroupAdmin, trustedGroupCreator } from './groupMembership';
import { getMyGroups, setMyGroups } from '../myGroups';
import { currentOwner } from '../../db';
import { loadMemberSnapshot } from './groupKeyRotation';
import { isJoinDenied } from '../groupJoinQueue';
import { keyRequestRecord } from './groupKeyRequest';
import { nip59 } from 'nostr-tools';
import { rumorTags, sealAndWrap } from '../giftWrap';
import { markSafetyChange } from '../safetyNumber.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { bytesToHex } from '@noble/hashes/utils.js';

const KEY_HEX = /^[0-9a-f]{64}$/i;

function bytesFromHex(hex) {
  const value = String(hex || '').toLowerCase();
  if (!/^(?:[0-9a-f]{2})+$/.test(value)) throw new Error('Malformed key bootstrap value.');
  return Uint8Array.from(value.match(/.{2}/g), (byte) => parseInt(byte, 16));
}

async function sha256Hex(value) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))));
}

function bootstrapUnsigned({ groupId, recipient, sender, epoch, keyHash, docKeyHash, doc }) {
  return { v: 1, gid: groupId, to: recipient, by: sender, ep: epoch, kh: keyHash, dkh: docKeyHash,
    doc: { id: doc.id, sig: doc.sig, body: doc.body } };
}

async function signBootstrap(unsigned, authoritySk) {
  const digest = await sha256Hex(JSON.stringify(unsigned));
  const signature = secp256k1.sign(bytesFromHex(digest), authoritySk, { prehash: false });
  return { ...unsigned, sig: bytesToHex(signature) };
}

/** A signed, one-recipient bootstrap grant for the first encrypted key bundle. */
export async function createGroupKeyBootstrapGrant({ groupId, recipient, sender, epoch, keyHex, docKeyHex, authoritySk, doc }) {
  if (!/^[0-9a-f]{64}$/i.test(String(recipient || '')) || !Number.isInteger(epoch) || epoch < 0) return null;
  if (!/^[0-9a-f]{64}$/i.test(String(keyHex || '')) || !/^[0-9a-f]{64}$/i.test(String(docKeyHex || ''))) return null;
  if (!doc?.id || !doc?.sig || !doc?.body || doc.body.gid !== groupId || doc.body.epoch !== epoch) return null;
  const { resolveMembership } = await import('./groupDoc.js');
  const row = resolveMembership(doc.body).find((member) => member.pubkey === recipient.toLowerCase());
  if (!row || row.actorVerified !== true || !row.actor) return null;
  const unsigned = bootstrapUnsigned({
    groupId, recipient: recipient.toLowerCase(), sender: String(sender || '').toLowerCase(), epoch,
    keyHash: await sha256Hex(String(keyHex).toLowerCase()),
    docKeyHash: await sha256Hex(String(docKeyHex).toLowerCase()), doc,
  });
  return signBootstrap(unsigned, authoritySk);
}

/** Verify the grant and its embedded authority-signed membership head. */
export async function verifyGroupKeyBootstrapGrant({ grant, groupId, recipient, sender, epoch, keyHex, docKeyHex, pin }) {
  try {
    if (!grant || grant.v !== 1 || grant.gid !== groupId
      || grant.to !== String(recipient || '').toLowerCase()
      || grant.by !== String(sender || '').toLowerCase()
      || grant.ep !== epoch || !/^[0-9a-f]{128}$/i.test(grant.sig || '')) return null;
    if (!/^[0-9a-f]{66}$/i.test(String(pin || ''))) return null;
    const doc = grant.doc;
    const { verifySignedDoc, resolveMembership } = await import('./groupDoc.js');
    const opened = await verifySignedDoc({ signed: doc, pin });
    if (!opened || opened.gid !== groupId || opened.epoch !== epoch || opened.id !== doc.id) return null;
    const row = resolveMembership(opened).find((member) => member.pubkey === String(recipient).toLowerCase());
    if (!row || row.actorVerified !== true || !row.actor) return null;
    if (grant.kh !== await sha256Hex(String(keyHex).toLowerCase())
      || grant.dkh !== await sha256Hex(String(docKeyHex).toLowerCase())) return null;
    const unsigned = bootstrapUnsigned({
      groupId, recipient: grant.to, sender: grant.by, epoch, keyHash: grant.kh,
      docKeyHash: grant.dkh, doc,
    });
    const digest = bytesFromHex(await sha256Hex(JSON.stringify(unsigned)));
    if (!secp256k1.verify(bytesFromHex(grant.sig), digest, bytesFromHex(pin), { prehash: false })) return null;
    return { signedDoc: doc, opened };
  } catch {
    return null;
  }
}

// A private group's real name and description ride the same sealed envelope
// the group key rides. The envelope is NIP-44 to each recipient already; this
// adds two strings to the payload inside it and changes nothing about the
// sealing itself.
//
// Lengths are the create screen's own limits. A label longer than the screen
// could produce is not a name this app wrote, so it is refused rather than
// truncated into something else.
export const SEALED_LABEL_MAX = 80;
export const SEALED_ABOUT_MAX = 500;

// Returns { name, about } or null. Null is the ordinary answer for every
// public group and for every bundle sent before this existed, so a missing
// label is never an error.
export function parseSealedLabel(payload) {
  if (!payload || (payload.t !== 'gkey' && payload.type !== 'gkey')) return null;
  if (typeof payload.name !== 'string') return null;
  const name = payload.name;
  if (!name || name.length > SEALED_LABEL_MAX) return null;
  const about = typeof payload.about === 'string' ? payload.about : '';
  if (about.length > SEALED_ABOUT_MAX) return null;
  return { name, about };
}

// The label is a relay-facing fact about the whole group, so the senders are
// the people who may speak for the whole group: the creator, or an admin in
// the stored snapshot. A plain member may still install a key bundle — but a
// member who could rename a group on another member's screen has a phishing
// surface wearing a name the reader trusts.
//
// Resolved against the SNAPSHOT (the relay-signed 39002), never against
// anything the sender says about themselves.
export function senderMaySetGroupLabel({ snapshot, sender, creator = '' }) {
  if (!sender || !Array.isArray(snapshot) || !snapshot.length) return false;
  const who = String(sender).toLowerCase();
  const standing = snapshot.map((member) => (typeof member === 'string'
    ? { pubkey: member.toLowerCase() }
    : { ...member, pubkey: String(member?.pubkey || '').toLowerCase() }));
  if (!standing.some((member) => member.pubkey === who)) return false;
  return isGroupAdmin(standing, who, String(creator || '').toLowerCase());
}

// Where the sealed label lives, and why here.
//
// PLAINTEXT AT REST, ON PURPOSE, AND IT MATCHES WHAT IS ALREADY THERE: the
// device's own group record (cipher_my_groups_<pk>) holds every group's name
// and description as plain text today, on this device, for public and private
// groups alike. Putting the sealed label there adds no exposure that the same
// string did not already have. It is NOT in the group-keys table: that table
// exists to hold sealed material, and a plaintext field beside an encrypted
// key would make its plaintext surface larger, in exactly the place someone
// audits key hygiene.
//
// Sealing group names at rest is a separate piece of work, with its own
// migration over every stored row. It is not done here.
//
// The row is only ever updated for a group this device already holds. A bundle
// naming a group that is not in the record invents nothing.
export function applySealedLabel(groupId, label, owner = currentOwner()) {
  if (!groupId || !label || typeof label.name !== 'string' || !label.name) return false;
  if (!owner) return false;
  const groups = getMyGroups(owner);
  const index = groups.findIndex((group) => group?.id === groupId);
  if (index === -1) return false;
  const held = groups[index];
  if (held.labelSealed && held.name === label.name && (held.about || '') === label.about) return true;
  groups[index] = { ...held, name: label.name, about: label.about, labelSealed: true };
  setMyGroups(owner, groups);
  // The open screen re-reads from the same records the reload does; this is
  // the signal to do it now rather than at the next refresh. The group id is
  // the only thing in the event that a console or a crash log could carry.
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('cipher:group-label-updated', { detail: { groupId } }));
  }
  return true;
}

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
//   - a legacy bundle that only restates older epochs at or below the held
//     one: a member of record may install an unheld history key, while
//     installReceivedGroupKey refuses to overwrite held bytes. New senders in
//     this client do not publish those historical keys automatically;
//   - a bundle that carries an epoch ABOVE the held one is a rotation, and
//     only the creator or an admin rotates. The new epochs must also run on
//     from the held one with no gap (held+1, held+2, ...): a jump past the
//     next epoch is refused, so a sender cannot park the group at a number
//     of their choosing. A device that missed a rotation requests current
//     access only; old epochs are not automatically regranted.
export function senderAuthorizedForGroupKey({ snapshot, sender, maxEpoch, currentEpoch, creator = '', offeredEpochs = null, allowCurrentEpochResync = false }) {
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
  if (allowCurrentEpochResync && Array.isArray(offeredEpochs)
    && offeredEpochs.length === 1 && offeredEpochs[0] === maxEpoch) return true;
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

export async function senderMayInstallGroupKey({ sender, groupId, maxEpoch, offeredEpochs = null, allowCurrentEpochResync = false }) {
  if (!sender || !groupId) return false;
  const owner = currentOwner();
  const { readAuthorityPin } = await import('./authorityPins.js');
  const securedPin = readAuthorityPin(owner, groupId);
  // A secured group never falls back to a relay roster when its signed doc is
  // unavailable. Older groups with no out-of-band authority pin retain their
  // legacy roster behavior until they migrate through an authenticated invite.
  const snapshot = securedPin
    ? await (await import('./groupKeyRotation.js')).loadVerifiedMemberSnapshot(groupId)
    : await loadMemberSnapshot(groupId);
  if (!Array.isArray(snapshot)) return false;
  const current = await getCurrentGroupKey(groupId);
  const claimed = (getMyGroups(owner).find((group) => group?.id === groupId) || {}).creator;
  const creator = trustedGroupCreator({ creator: claimed, identityPk: owner, snapshot });
  return senderAuthorizedForGroupKey({ snapshot, sender, maxEpoch, currentEpoch: current?.epoch, creator, offeredEpochs, allowCurrentEpochResync });
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
  const allowCurrentEpochResync = payload?.resync === true && rows.length === 1;
  if (payload?.resync === true && !allowCurrentEpochResync) return false;
  let authorized = await senderMayInstallGroupKey({
    sender, groupId, maxEpoch, offeredEpochs: rows.map((row) => row.epoch), allowCurrentEpochResync,
  });
  const { readAuthorityPin } = await import('./authorityPins.js');
  const pinnedAuthority = readAuthorityPin(currentOwner(), groupId);
  // For a secured group, first-key adoption always needs a grant signed by
  // the out-of-band authority pin. A partially persisted doc cannot turn a
  // relay roster or a normal member into a bootstrap signer.
  if (pinnedAuthority && !current) authorized = false;
  let priorDocKey = await getDocKey(groupId);
  const docKeyHex = typeof payload?.dk === 'string' ? payload.dk : '';
  // Also restore a doc-key-lost returning device: the pinned owner grant can
  // re-establish the current signed head even when an older chat key remains.
  const singleEpochBootstrap = rows.length === 1
    && Boolean(keyRequestRecord(currentOwner(), groupId))
    && !isJoinDenied(groupId, currentOwner()) && /^[0-9a-f]{64}$/.test(docKeyHex);
  // A locally held older document may still name the recipient after they
  // have been removed, so it cannot bypass a bootstrap that the sender chose
  // to include. Verify and persist every supplied authority proof before
  // accepting its key. In particular, do not treat an invalid proof as an
  // optional hint merely because the stale snapshot authorizes the sender.
  if (payload?.bootstrap !== undefined) {
    if (!singleEpochBootstrap || !pinnedAuthority) {
      console.warn('[group-key] A key bundle was not installed: its authority bootstrap is not valid for this device.');
      return false;
    }
    const verified = await verifyGroupKeyBootstrapGrant({
      grant: payload?.bootstrap, groupId, recipient: currentOwner(), sender,
      epoch: maxEpoch, keyHex: rows[0].hex, docKeyHex, pin: pinnedAuthority,
    });
    if (!verified) {
      console.warn('[group-key] A key bundle was not installed: its authority bootstrap failed verification.', { groupId, epoch: maxEpoch });
      return false;
    }
    const { rememberVerifiedDoc } = await import('./groupDocWire.js');
    const stored = await rememberVerifiedDoc({ groupId, pin: pinnedAuthority, signed: verified.signedDoc });
    if (!stored?.stored) {
      console.warn('[group-key] A key bundle was not installed: its verified governance document could not be stored.', { groupId, epoch: maxEpoch });
      return false;
    }
    // Keep the prior secret available for rollback if at-rest storage fails
    // below. The verified new head is persisted, while the rotation barrier
    // on the sender prevents grants until a failed local install is retried.
    authorized = true;
  }
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
  // New bundles always carry a valid governance secret. Adopt it BEFORE chat
  // epochs so a storage failure cannot leave this device with new chat keys
  // but no key for the corresponding authorization document.
  const hasDocKeyField = Object.prototype.hasOwnProperty.call(payload || {}, 'dk');
  if (hasDocKeyField && !/^[0-9a-f]{64}$/.test(docKeyHex)) {
    console.warn('[group-key] A key bundle was not installed: its governance-doc key is malformed.', { groupId, epoch: maxEpoch });
    return false;
  }
  let adoptedDocKey = false;
  if (/^[0-9a-f]{64}$/.test(docKeyHex)) {
    if (docKeyAdoptionAllows({ heldEpoch: priorDocKey?.epoch, offeredEpoch: maxEpoch })) {
      adoptedDocKey = await putDocKey(groupId, maxEpoch, fromHex(docKeyHex));
      if (!adoptedDocKey) {
        console.warn('[group-key] A key bundle was not installed: the governance-doc key could not be stored.', { groupId, epoch: maxEpoch });
        return false;
      }
      if (priorDocKey) {
        console.info('[group-key] Governance-doc key rolled forward by an accepted bundle.', { groupId, epoch: maxEpoch });
      }
    } else if (!priorDocKey || !docKeysEqual(priorDocKey.bytes, fromHex(docKeyHex))) {
      console.warn('[group-key] A key bundle was not installed: its governance-doc key is stale.', { groupId, epoch: maxEpoch });
      return false;
    }
  }
  const keyMaterialMoved = safetyChangeFromInstall({ currentEpoch: current?.epoch, maxEpoch });
  try {
    for (const row of rows) await putGroupKey(row.groupId, row.epoch, fromHex(row.hex));
  } catch (error) {
    if (adoptedDocKey) {
      if (priorDocKey) await putDocKey(groupId, priorDocKey.epoch, priorDocKey.bytes);
      else await removeDocKey(groupId);
    }
    console.warn('[group-key] A key bundle was not fully installed:', error?.message || error);
    return false;
  }
  if (keyMaterialMoved) markSafetyChange(sender);
  // The sealed label, if this bundle carries one. It is a separate decision
  // from the key: installing the key is what a member of record may do, but
  // naming the group is what only its creator or an admin may do. A plain
  // member's bundle still installs its key and its label is dropped.
  //
  // Applied only for the group id this bundle is for (rows[0].groupId, which
  // every row was checked against above) and only to a row this device
  // already holds — applySealedLabel invents nothing.
  const label = parseSealedLabel(payload);
  if (label) {
    const owner = currentOwner();
    const snapshot = await loadMemberSnapshot(groupId);
    const claimed = (getMyGroups(owner).find((group) => group?.id === groupId) || {}).creator;
    const creator = trustedGroupCreator({ creator: claimed, identityPk: owner, snapshot });
    if (senderMaySetGroupLabel({ snapshot, sender, creator })) {
      applySealedLabel(groupId, label, owner);
    } else {
      // The group id only: the label is the thing being kept off the wire and
      // out of logs.
      console.warn('[group-key] A sealed group name was not applied: the sender may not set it.', { groupId });
    }
  }
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

// SEC-1 pure decision: should an ACCEPTED bundle's doc-key ride change this
// device's held governance-doc secret? Same posture as chat keys — nothing
// held adopts, and only a strictly newer epoch rolls forward, so a re-delivery
// or restatement can never overwrite what the store already sealed.
export function docKeyAdoptionAllows({ heldEpoch, offeredEpoch }) {
  if (!Number.isInteger(offeredEpoch) || offeredEpoch < 0) return false;
  if (!Number.isInteger(heldEpoch)) return true; // nothing held: adopt
  return offeredEpoch > heldEpoch; // roll forward only
}

// Bug #9: the grant ledger is a record of what was SENT, not of what a member
// installed - the install floor refuses a key a device did not ask for, so an
// unsolicited bundle (sent when the owner approves a member who has not yet
// asked) is dropped by the member while the ledger says "granted". The
// member's own gkey_req that follows was then skipped by the same ledger and
// never answered, and the composer sat on Securing forever.
//
// An explicit request is therefore never blocked by the ledger. It is answered
// with the current epoch only and is rate limited. Older keys are not
// backfilled on admission, reconciliation, or device recovery. Historical
// access has no implicit grant path; it requires a future explicit,
// owner-authorized recovery action.
export const REGRANT_WINDOW_SEC = 60;

export function epochsToSend({ records, epoch, explicit = false, nowSec = Math.floor(Date.now() / 1000), windowSec = REGRANT_WINDOW_SEC } = {}) {
  const held = records instanceof Map ? records : new Map();
  if (!Number.isInteger(epoch) || epoch < 0) return [];
  if (!explicit) return held.has(epoch) ? [] : [epoch];
  const answeredAt = held.get(epoch)?.answeredAt;
  return Number.isFinite(answeredAt) && nowSec - answeredAt < windowSec ? [] : [epoch];
}

const grantLedger = { getGrantRecords, recordGrant };

export async function distributeGroupKey({ senderPrivkey, senderPubkey, groupId, epoch, keyBytes, recipients, publish, answerRequest = false, label = null, ledger = grantLedger, docKey, bootstrapRecipient = null }) {
  const { nip44 } = await import('nostr-tools');
  // SEC-1: the governance-doc key rides every bundle this call ships. An
  // explicit `docKey` wins (rotation hands its freshly minted secret over);
  // otherwise what this device holds now travels, so every existing grant,
  // regrant and label-ride path delivers the current secret with zero
  // per-caller wiring. Missing or unreadable state blocks the bundle.
  let resolvedDocKey = normalizeDocKey(docKey);
  if (!resolvedDocKey && docKey === undefined) {
    const held = await getDocKey(groupId).catch(() => null);
    resolvedDocKey = normalizeDocKey(held?.bytes);
  }
  if (!resolvedDocKey) throw new Error('A readable governance-doc key is required before distributing new group keys. Recover the shared key; do not generate a replacement.');
  let bootstrapContext = null;
  if (bootstrapRecipient) {
    const owner = currentOwner();
    const { getSessionKey } = await import('../sessionKey.js');
    const { groupAuthorityKey } = await import('./groupAuthority.js');
    const { readAuthorityPin } = await import('./authorityPins.js');
    const { loadMemberDocHeads } = await import('./groupDocWire.js');
    const accountSk = getSessionKey();
    if (!owner || owner.toLowerCase() !== String(senderPubkey || '').toLowerCase()
      || !accountSk || accountSk.length !== 32) {
      throw new Error('A first key grant requires the unlocked group-authority account.');
    }
    const heldPin = readAuthorityPin(owner, groupId);
    const authority = await groupAuthorityKey(accountSk, groupId);
    if (!heldPin || authority.pin !== heldPin) {
      throw new Error('A first key grant requires the pinned group-authority signing key.');
    }
    const head = (await loadMemberDocHeads(groupId))[0];
    if (!head || head.body?.gid !== groupId || head.body?.epoch !== epoch) {
      throw new Error(`A first key grant requires the current verified governance document (document epoch ${head?.body?.epoch ?? 'missing'}, key epoch ${epoch}).`);
    }
    bootstrapContext = { authoritySk: authority.privateKeyBytes, doc: head };
  }
  const now = Math.floor(Date.now() / 1000);
  const results = await Promise.allSettled(recipients.map(async (recipientPubkey) => {
    const records = await ledger.getGrantRecords(groupId, recipientPubkey);
    const needed = epochsToSend({ records, epoch, explicit: answerRequest, nowSec: now });
    // A label is not a key, but it travels in the key's envelope and the
    // ledger above records keys. Without this a member who already holds the
    // epoch would be skipped and would never hear a rename — the ledger would
    // be quietly answering the wrong question. So a label always rides: with
    // whatever epochs are missing, or, if none are, by restating the current
    // one (the receiver accepts a restated held epoch with the held bytes and
    // refuses any other bytes, so the restatement cannot carry a new key).
    const carrying = label ? (needed.length ? needed : [epoch]) : needed;
    if (!carrying.length) return;
    const bundles = carrying.map((ep) => ({ ep, k: toHex(keyBytes) }));
    // SEC-1: the resolved doc key (caller-passed or held) rides every
    // bundle - grants, rotations, regrants and label rides all pass here,
    // so any accepted install adopts or rolls forward to exactly what the
    // sender holds now.
    let bootstrap = null;
    if (bootstrapContext && String(recipientPubkey).toLowerCase() === String(bootstrapRecipient).toLowerCase()) {
      bootstrap = await createGroupKeyBootstrapGrant({
        groupId, recipient: recipientPubkey, sender: senderPubkey, epoch,
        keyHex: toHex(keyBytes), docKeyHex: toHex(resolvedDocKey),
        authoritySk: bootstrapContext.authoritySk, doc: bootstrapContext.doc,
      });
      if (!bootstrap) throw new Error('The pinned authority could not authorize this first key grant from the current membership document.');
    }
    const payload = {
      v: 1, t: 'gkey', gid: groupId, by: senderPubkey, at: now, keys: bundles,
      ...(answerRequest ? { resync: true } : {}),
      ...(label ? { name: label.name, about: label.about || '' } : {}),
      dk: toHex(resolvedDocKey),
      ...(bootstrap ? { bootstrap } : {}),
    };
    const shared = nip44.v2.utils.getConversationKey(senderPrivkey, recipientPubkey);
    const wrapped = nip44.v2.encrypt(JSON.stringify(payload), shared);
    // Was a bare kind-4 signed by the sender, so every grant put the sender's
    // key on the message relay next to each recipient's, once per member, in
    // one second. A rotation therefore handed the relay the member set of a
    // group whose roster it never reads, and tied that group to the message
    // relay. It now travels the same two layers as a message: the envelope
    // carries no sender, and the seal names who granted what.
    //
    // The receiver needs no change: its ingest already unwraps a 1059 into the
    // rumor before reading data, and takes the counterparty from the rumor.
    const rumor = nip59.createRumor({
      kind: 4,
      created_at: now,
      tags: rumorTags({ recipient: recipientPubkey }),
      content: wrapped,
    }, senderPrivkey);
    const { wrap } = sealAndWrap(rumor, { senderSk: senderPrivkey, recipientPubkey });
    await publish(wrap);
    for (const bundle of bundles) await ledger.recordGrant(groupId, recipientPubkey, bundle.ep, { answered: answerRequest });
  }));
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    throw new Error(`Could not distribute group keys to ${failures.length} member(s).`);
  }
}
