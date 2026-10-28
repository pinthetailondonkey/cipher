import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { heldGroupRow, joinGroup, mergeGroupProfile } from './groupJoin.js';
import { getMyGroups } from './myGroups.js';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
  };
}

const identity = { pk: 'ab'.repeat(32), sk: new Uint8Array(32) };

test('a join publishes kind 9021 before the group is saved on this device', async () => {
  globalThis.localStorage = memoryStorage();
  const steps = [];
  const nip29 = {
    parseGroupReference: (raw) => ({ id: String(raw).trim() }),
    loadGroupProfile: async (_identity, id, name) => { steps.push('profile'); return { id, name: name || 'Room', creator: 'cd'.repeat(32) }; },
    publishGroupJoin: async (_identity, id) => { steps.push(`join:${id}`); assert.equal(getMyGroups(identity.pk).length, 0); },
  };
  const group = await joinGroup(identity, ' room1 ', { name: 'Room', nip29 });
  assert.deepEqual(steps, ['profile', 'join:room1']);
  assert.deepEqual(getMyGroups(identity.pk).map((item) => item.id), ['room1']);
  assert.equal(group.isChannel, false);
});

test('a join the relay refuses saves nothing', async () => {
  globalThis.localStorage = memoryStorage();
  const nip29 = {
    parseGroupReference: (raw) => ({ id: raw }),
    loadGroupProfile: async (_identity, id) => ({ id, name: 'Room' }),
    publishGroupJoin: async () => { throw new Error('Group relay AUTH timed out'); },
  };
  await assert.rejects(() => joinGroup(identity, 'room2', { nip29 }), /AUTH timed out/);
  assert.deepEqual(getMyGroups(identity.pk), []);
  await assert.rejects(() => joinGroup(identity, '', { nip29: { ...nip29, parseGroupReference: () => ({ id: '' }) } }), /could not be read/);
});

test('invite links, search, and Discover all join the same way, and nobody sends a join request', () => {
  const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  const discover = read('../Discover.jsx');
  const directory = read('../features/chat/useGroupDirectory.js');
  const bootstrap = read('../features/chat/useChatBootstrap.js');
  assert.match(discover, /await joinGroup\(identity, group\.id/);
  assert.match(directory, /await joinGroup\(identity, groupId/);
  // A deep link joins only on relay evidence and carries no name: a forged
  // address used to silent-join a phantom row named out of the URL.
  assert.match(bootstrap, /joinGroupById\(joinId\);/);
  assert.match(bootstrap, /No group found at that address/);
  assert.match(bootstrap, /fetchGroupMetadata/);
  assert.doesNotMatch(bootstrap, /get\('name'\)/);
  for (const source of [discover, directory, bootstrap]) {
    assert.equal(source.includes('join_request'), false);
    assert.equal(source.includes('requestToJoinGroup'), false);
  }
});

// Drill residual: the newest signed metadata event can call a held group
// anything. A directory rebuild or a re-join must not splat that claim
// over a row the device already holds — a legitimate rename arrives
// through the admin-authorized kind-9002 announcement path, which is the
// same standing the row's own writes always needed.
test('a held row keeps the words it holds; a new row takes the incoming ones', () => {
  const held = { id: 'g1', name: 'Thursday', about: 'moved to Fridays', isChannel: false, creator: 'ff'.repeat(32) };
  const incoming = { id: 'g1', name: 'REAL-NAME-ATTACKER', about: 'forged meta', isChannel: true, creator: 'aa'.repeat(32) };
  const merged = heldGroupRow(held, incoming);
  assert.equal(merged.name, 'Thursday', 'the held name survives the refresh');
  assert.equal(merged.about, 'moved to Fridays', 'the held about survives too');
  assert.equal(merged.isChannel, false, 'the held shape survives');
  assert.equal(merged.creator, 'aa'.repeat(32), 'creator keeps the F3 hold at the caller, not here');
  // A row with empty held words adopts the incoming ones rather than
  // blanking a group into a nameless row.
  const halfHeld = heldGroupRow({ id: 'g2', name: '' }, { id: 'g2', name: 'Relay Room', about: '', isChannel: null });
  assert.equal(halfHeld.name, 'Relay Room');
  assert.equal(halfHeld.about, '');
  assert.equal(halfHeld.isChannel, null, 'isChannel falls through when the held row says nothing');
  // No held row: the incoming one passes through untouched.
  assert.deepEqual(heldGroupRow(null, incoming), incoming);
});

// Bug #9 root cause: the profile refresh spread creator: '' over the creator
// the device knew, so the owner's group lost its owner and the Join requests
// panel and Approve button vanished.
test('a profile refresh never erases a known creator, and undefined picture equals empty', () => {
  const OWNER = 'ab'.repeat(32);
  // A new group: no picture field at all, creator known.
  const current = { id: 'g1', name: 'Room', about: '', creator: OWNER };
  const profile = { id: 'g1', name: 'Room', about: '', picture: '', isChannel: false, creator: '' };
  const { changed, next } = mergeGroupProfile(current, profile);
  assert.equal(next.creator, OWNER);
  assert.equal(changed, true, 'isChannel is learned once');
  // The old merge, for the witness: the spread wipes the creator.
  assert.equal({ ...current, ...profile }.creator, '');
  // Once settled, the same refresh changes nothing (undefined !== '' no longer loops).
  assert.equal(mergeGroupProfile(next, profile).changed, false);
});

test('a profile refresh merges only the words the profile has, and a joiner can still learn a creator', () => {
  const OWNER = 'ab'.repeat(32);
  const OTHER = 'cd'.repeat(32);
  const held = { id: 'g1', name: 'Old', about: 'about', picture: 'p.png', creator: OWNER, isChannel: false };
  const renamed = mergeGroupProfile(held, { id: 'g1', name: 'New', about: '', picture: '', creator: '' });
  assert.deepEqual(renamed.next, { ...held, name: 'New' });
  assert.equal(renamed.changed, true);
  // A creator already known is not replaced by a profile's claim.
  assert.equal(mergeGroupProfile(held, { id: 'g1', name: 'Old', creator: OTHER }).next.creator, OWNER);
  // A row with no creator takes one the profile actually carries (an invite author).
  assert.equal(mergeGroupProfile({ id: 'g1', name: 'Old' }, { id: 'g1', name: 'Old', creator: OTHER }).next.creator, OTHER);
  // Nothing in, nothing changed.
  assert.equal(mergeGroupProfile(held, { id: 'g1' }).changed, false);
  assert.deepEqual(mergeGroupProfile(null, null).next, {});
});

test('GroupView refreshes the open group through the merge, not a spread', () => {
  const view = fs.readFileSync(new URL('../components/chat/GroupView.jsx', import.meta.url), 'utf8');
  assert.match(view, /mergeGroupProfile\(current, profile\)/);
  assert.doesNotMatch(view, /\.\.\.current, \.\.\.profile/);
  assert.doesNotMatch(view, /\.\.\.group, \.\.\.profile/);
});
