import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REMOVED_PER_GROUP_MAX, clearMemberRemoval, recordMemberRemoval, removalAt, sentAfterRemoval,
} from './groupRemoval.js';

// The ledger writes through the scoped storage shim, which reads live localStorage.
function withStorage(run) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  return Promise.resolve(run(store)).finally(() => { delete globalThis.localStorage; });
}

const GROUP = 'removal-group';
const KICKED = 'a'.repeat(64);
const MEMBER = 'b'.repeat(64);

test('a message made after the removal is refused, one made before it still shows', () => withStorage(() => {
  assert.equal(recordMemberRemoval(GROUP, KICKED, 1000), true);
  assert.equal(removalAt(GROUP, KICKED), 1000);
  assert.equal(sentAfterRemoval(GROUP, KICKED, 1001), true, 'after the kick: refused');
  assert.equal(sentAfterRemoval(GROUP, KICKED, 999), false, 'before the kick: kept');
  assert.equal(sentAfterRemoval(GROUP, KICKED, 1000), false, 'the same second as the kick: kept');
}));

test('the ledger names one member in one group, and nobody else', () => withStorage(() => {
  recordMemberRemoval(GROUP, KICKED, 1000);
  assert.equal(sentAfterRemoval(GROUP, MEMBER, 5000), false);
  assert.equal(sentAfterRemoval('other-group', KICKED, 5000), false);
  assert.equal(sentAfterRemoval(GROUP, KICKED, 'soon'), false, 'a stamp that is not a number is not treated as late');
}));

test('a removal survives a reload: the bytes are in storage, not only in memory', () => withStorage((store) => {
  recordMemberRemoval(GROUP, KICKED, 1000);
  assert.ok([...store.values()].some((value) => value.includes(KICKED) && value.includes('1000')), 'the removal was written to storage');
}));

test('the newest removal wins; a replayed older one cannot move the line back', () => withStorage(() => {
  recordMemberRemoval(GROUP, KICKED, 1000);
  recordMemberRemoval(GROUP, KICKED, 500);
  assert.equal(removalAt(GROUP, KICKED), 1000);
  recordMemberRemoval(GROUP, KICKED, 3000);
  assert.equal(removalAt(GROUP, KICKED), 3000);
}));

test('only an add made after the removal brings the member back', () => withStorage(() => {
  recordMemberRemoval(GROUP, KICKED, 1000);
  assert.equal(clearMemberRemoval(GROUP, KICKED, 900), false, 'an add older than the kick (a replay) does not undo it');
  assert.equal(sentAfterRemoval(GROUP, KICKED, 2000), true);
  assert.equal(clearMemberRemoval(GROUP, KICKED, 1500), true);
  assert.equal(sentAfterRemoval(GROUP, KICKED, 2000), false, 're-added: their messages show again');
  assert.equal(removalAt(GROUP, KICKED), null);
}));

test('a flood of removals stays under the per-group cap, newest kept', () => withStorage(() => {
  for (let i = 0; i < REMOVED_PER_GROUP_MAX + 20; i += 1) {
    recordMemberRemoval(GROUP, i.toString(16).padStart(64, '0'), 1000 + i);
  }
  assert.equal(removalAt(GROUP, (REMOVED_PER_GROUP_MAX + 19).toString(16).padStart(64, '0')), 1000 + REMOVED_PER_GROUP_MAX + 19);
  assert.equal(removalAt(GROUP, (0).toString(16).padStart(64, '0')), null, 'the oldest rows made room');
}));
