import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { joinGroup } from './groupJoin.js';
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
  assert.match(bootstrap, /joinGroupById\(joinId, joinName\);/);
  for (const source of [discover, directory, bootstrap]) {
    assert.equal(source.includes('join_request'), false);
    assert.equal(source.includes('requestToJoinGroup'), false);
  }
});
