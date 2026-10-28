import assert from 'node:assert/strict';
import test from 'node:test';
import { dropPendingJoin, queuePendingJoin } from '../groupJoinQueue.js';
import { grantKeyRequest } from './groupKeyRotation.js';
import { ASKS_PER_GROUP_MAX, approvalKeySend, clearKeyAsk, keyAskAt, rememberKeyAsk } from './groupKeyAsks.js';

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

const GROUP = 'ask-group';
const OWNER = 'o'.repeat(64);
const B = 'b'.repeat(64);

test('an unanswered key request is remembered per member per group, and clearing marks it answered', () => withStorage(() => {
  assert.equal(keyAskAt(GROUP, B), null, 'nobody asked yet');
  rememberKeyAsk(GROUP, B, 300);
  assert.equal(keyAskAt(GROUP, B), 300);
  assert.equal(keyAskAt(GROUP, 'c'.repeat(64)), null, 'another member never asked');
  assert.equal(keyAskAt('other-group', B), null, 'the ask names one group');
  assert.equal(clearKeyAsk(GROUP, B), true);
  assert.equal(keyAskAt(GROUP, B), null, 'answered: the ask is gone');
  assert.equal(clearKeyAsk(GROUP, B), false, 'clearing again changes nothing');
}));

test('the ask survives a reload: the bytes are in storage, not only in memory', () => withStorage((store) => {
  rememberKeyAsk(GROUP, B, 300);
  assert.ok([...store.values()].some((value) => value.includes(B) && value.includes('300')), 'the ask was written to storage');
}));

test('the newest ask wins, and a flood of asks stays under the per-group cap', () => withStorage(() => {
  rememberKeyAsk(GROUP, B, 300);
  rememberKeyAsk(GROUP, B, 900);
  assert.equal(keyAskAt(GROUP, B), 900);
  for (let i = 0; i < ASKS_PER_GROUP_MAX + 20; i += 1) {
    rememberKeyAsk(GROUP, i.toString(16).padStart(64, '0'), 1000 + i);
  }
  assert.equal(keyAskAt(GROUP, (ASKS_PER_GROUP_MAX + 19).toString(16).padStart(64, '0')), 1000 + ASKS_PER_GROUP_MAX + 19);
  assert.equal(keyAskAt(GROUP, B), null, 'the oldest asks made room');
}));

test('the approval decision sends only on a standing ask, a held key and an allow', () => {
  assert.deepEqual(approvalKeySend({ askedAt: 300, hasKey: true, decision: 'allow' }), { send: true });
  assert.equal(approvalKeySend({ askedAt: null, hasKey: true, decision: 'allow' }).send, false, 'no ask: nothing to answer');
  assert.equal(approvalKeySend({ askedAt: 300 }).send, false, 'no key held: nothing to send');
  assert.equal(approvalKeySend({ askedAt: 300, hasKey: true, decision: 'deny' }).send, false, 'the grant rules refused: no send');
  assert.equal(approvalKeySend({}).send, false, 'no decision at all: no send');
});

// The full chain on the real decision logic: B asks while their join is
// pending and is refused on the queue row; the owner approves, which drops
// the row and names B on the snapshot; the standing ask is then answered at
// the approval instead of B's own retry ladder.
test('a member who asked while pending is answerable the moment the owner approves', () => withStorage(async () => {
  const snapshotAt = (members, at) => ({ snapshot: members, updatedAt: at, keyObtainedAt: 150 });
  queuePendingJoin(GROUP, { pubkey: B, eventId: 'j1', at: 100 });
  const whilePending = await grantKeyRequest({
    groupId: GROUP, requester: B, creator: OWNER, selfCreated: true,
    ...snapshotAt([OWNER], 250),
    now: 1_000_000,
    fetchMembers: async () => [OWNER],
  });
  assert.equal(whilePending, 'deny', 'the pending row refuses the key, as it must');
  rememberKeyAsk(GROUP, B, 300);
  dropPendingJoin(GROUP, B);
  const approved = await grantKeyRequest({
    groupId: GROUP, requester: B, creator: OWNER, selfCreated: true,
    ...snapshotAt([OWNER, B], 250),
    now: 1_000_000,
    fetchMembers: async () => [OWNER, B],
  });
  assert.equal(approved, 'allow');
  const plan = approvalKeySend({ askedAt: keyAskAt(GROUP, B), hasKey: true, decision: approved });
  assert.equal(plan.send, true, 'the approval click answers the standing ask');
}));
