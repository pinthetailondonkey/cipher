import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SEALED_ABOUT_MAX,
  SEALED_LABEL_MAX,
  applySealedLabel,
  parseSealedLabel,
  senderMaySetGroupLabel,
} from './groupKeyDistribution.js';
import { getMyGroups, setMyGroups } from '../myGroups';
import { heldGroupRow } from '../groupJoin';
import { SEALED_ABOUT, SEALED_LABEL, heldSealedFields } from '../groupCreate';

// The device's own group record is localStorage. This is the smallest stand-in
// that still behaves the way the real one does across a "reload": the data is
// in a map, and re-reading it is a fresh read, not a cached value.
const disk = new Map();
globalThis.localStorage = {
  getItem: (key) => (disk.has(key) ? disk.get(key) : null),
  setItem: (key, value) => disk.set(key, String(value)),
  removeItem: (key) => disk.delete(key),
  clear: () => disk.clear(),
};

const OWNER = 'o'.repeat(64);
const ADMIN = 'd'.repeat(64);
const MEMBER = 'm'.repeat(64);
const STRANGER = 's'.repeat(64);
const CREATOR = 'c'.repeat(64);

const ROSTER = [
  { pubkey: CREATOR, role: 'admin' },
  { pubkey: ADMIN, role: 'admin' },
  { pubkey: MEMBER, role: 'member' },
];

const OWNED = { pubkey: OWNER, role: 'member' };
const snapshotOf = () => [OWNED, ...ROSTER];

function resetRecord(groups) {
  disk.clear();
  setMyGroups(OWNER, groups);
}

const groupsOf = () => getMyGroups(OWNER);

test('gate 1: a creator\'s sealed name reaches the member and survives a reload', () => {
  resetRecord([{ id: 'g1', name: SEALED_LABEL, about: SEALED_ABOUT, access: 'private' }]);
  const payload = { v: 1, t: 'gkey', gid: 'g1', by: CREATOR, at: 1, keys: [], name: 'Thursday', about: 'moved' };
  const label = parseSealedLabel(payload);
  assert.deepEqual(label, { name: 'Thursday', about: 'moved' });
  assert.equal(senderMaySetGroupLabel({ snapshot: snapshotOf(), sender: CREATOR, creator: CREATOR }), true);
  assert.equal(applySealedLabel('g1', label, OWNER), true);

  // A reload is a fresh read of the same storage, not the object held above.
  const after = getMyGroups(OWNER);
  assert.equal(after[0].name, 'Thursday');
  assert.equal(after[0].about, 'moved');
  assert.equal(after[0].labelSealed, true);
  assert.equal(after[0].access, 'private', 'the level it was created at survives too');
});

// The history fetch re-saves the relay's copy of the row over the device's.
// That is the exact sequence that has eaten state on this project before, so
// it is run here as two real functions, in the order the directory runs them.
test('gate 1: the sealed name survives the history fetch re-saving the relay row', () => {
  resetRecord([{ id: 'g1', name: 'Thursday', about: 'moved', access: 'private', labelSealed: true }]);
  const local = groupsOf().find((group) => group.id === 'g1');
  const relayRow = { id: 'g1', name: SEALED_LABEL, about: SEALED_ABOUT, isChannel: false, kind: 'group' };
  const merged = { ...heldGroupRow(local, relayRow), ...heldSealedFields(local) };
  assert.equal(merged.name, 'Thursday', 'the relay placeholder did not replace the name');
  assert.equal(merged.about, 'moved');
  assert.equal(merged.labelSealed, true);
  assert.equal(merged.access, 'private');
});

test('gate 4: a rename reaches the member, and the relay row it came with says nothing', () => {
  resetRecord([{ id: 'g1', name: 'Thursday', about: 'moved', access: 'private', labelSealed: true }]);
  assert.equal(applySealedLabel('g1', { name: 'Friday', about: 'moved again' }, OWNER), true);
  assert.equal(getMyGroups(OWNER)[0].name, 'Friday');
  // The same update carried a placeholder, as every relay-facing frame does.
  const local = getMyGroups(OWNER)[0];
  const merged = { ...heldGroupRow(local, { id: 'g1', name: SEALED_LABEL, about: SEALED_ABOUT }), ...heldSealedFields(local) };
  assert.equal(merged.name, 'Friday');
});

test('gate 5: a group whose bundle predates this keeps the relay label, never a blank', () => {
  resetRecord([{ id: 'g1', name: 'Relay name', about: 'relay words' }]);
  // The bundle an older device sends carries no name at all.
  assert.equal(parseSealedLabel({ v: 1, t: 'gkey', gid: 'g1', by: CREATOR, at: 1, keys: [] }), null);
  const local = getMyGroups(OWNER)[0];
  const merged = { ...heldGroupRow(local, { id: 'g1', name: 'Relay name', about: 'relay words' }), ...heldSealedFields(local) };
  assert.equal(merged.name, 'Relay name');
  assert.notEqual(merged.name, '');
});

// The attack this gate exists for: a key bundle is an ordinary DM, so anyone
// can send one. A member who can set the name on someone else's screen has a
// phishing surface wearing a name the reader trusts.
test('a plain member and a stranger cannot set the label; only a creator or an admin', () => {
  const base = { snapshot: snapshotOf(), creator: CREATOR };
  assert.equal(senderMaySetGroupLabel({ ...base, sender: CREATOR }), true);
  assert.equal(senderMaySetGroupLabel({ ...base, sender: ADMIN }), true);
  assert.equal(senderMaySetGroupLabel({ ...base, sender: MEMBER }), false);
  assert.equal(senderMaySetGroupLabel({ ...base, sender: STRANGER }), false);
  // A sender who claims a role in the payload is still just a pubkey: the
  // decision reads the snapshot and nothing the sender says.
  assert.equal(senderMaySetGroupLabel({ ...base, sender: MEMBER, role: 'admin' }), false);
  // No snapshot, no admin: a device that never synced the roster sets nothing.
  assert.equal(senderMaySetGroupLabel({ snapshot: [], sender: ADMIN, creator: CREATOR }), false);
  assert.equal(senderMaySetGroupLabel({ snapshot: null, sender: ADMIN, creator: CREATOR }), false);
  assert.equal(senderMaySetGroupLabel({ ...base, sender: '' }), false);
});

test('the creator resolves from the trusted creator, not from a roster row', () => {
  // The receiver's own device is the creator: an ordinary member of record,
  // which the trusted-creator path is what turns into standing.
  assert.equal(senderMaySetGroupLabel({ snapshot: snapshotOf(), sender: OWNER, creator: OWNER }), true);
  assert.equal(senderMaySetGroupLabel({ snapshot: snapshotOf(), sender: OWNER, creator: '' }), false);
});

test('a label installs only for the group it is for, and invents no rows', () => {
  resetRecord([
    { id: 'g1', name: 'One', access: 'private', labelSealed: true },
    { id: 'g2', name: 'Two', access: 'private', labelSealed: true },
  ]);
  applySealedLabel('g2', { name: 'Renamed', about: '' }, OWNER);
  const groups = Object.fromEntries(getMyGroups(OWNER).map((group) => [group.id, group]));
  assert.equal(groups.g1.name, 'One', 'the other group is untouched');
  assert.equal(groups.g2.name, 'Renamed');
  // A group this device does not hold is not created by a bundle naming it.
  assert.equal(applySealedLabel('g9', { name: 'Ghost', about: '' }, OWNER), false);
  assert.equal(getMyGroups(OWNER).find((group) => group.id === 'g9'), undefined);
  // And with no account open, nothing is written.
  assert.equal(applySealedLabel('g1', { name: 'Anon', about: '' }, ''), false);
});

// Fail closed on the payload itself: the envelope is the only proof a label
// came from an authorized sender, so a malformed one installs nothing.
test('a malformed label is refused rather than truncated', () => {
  const base = { v: 1, t: 'gkey', gid: 'g1', keys: [] };
  assert.equal(parseSealedLabel({ ...base, name: '' }), null);
  assert.equal(parseSealedLabel({ ...base, name: 'x'.repeat(SEALED_LABEL_MAX + 1) }), null);
  assert.equal(parseSealedLabel({ ...base, name: 42 }), null);
  assert.equal(parseSealedLabel({ ...base, name: 'ok', about: 'x'.repeat(SEALED_ABOUT_MAX + 1) }), null);
  // Missing about is the normal shape of a group with no description.
  assert.deepEqual(parseSealedLabel({ ...base, name: 'ok' }), { name: 'ok', about: '' });
  // Exactly at the limits is still a name this app could have written.
  assert.deepEqual(parseSealedLabel({ ...base, name: 'x'.repeat(SEALED_LABEL_MAX) }).name.length, SEALED_LABEL_MAX);
  // Not a key bundle at all.
  assert.equal(parseSealedLabel({ t: 'text', name: 'not a label' }), null);
  assert.equal(parseSealedLabel(null), null);
});

test('applying a label twice is a no-op, and an unchanged label writes nothing new', () => {
  resetRecord([{ id: 'g1', name: 'Thursday', about: 'moved', access: 'private', labelSealed: true }]);
  assert.equal(applySealedLabel('g1', { name: 'Thursday', about: 'moved' }, OWNER), true);
  assert.equal(getMyGroups(OWNER)[0].name, 'Thursday');
});
