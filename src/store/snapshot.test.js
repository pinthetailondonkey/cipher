import assert from 'node:assert/strict';
import test from 'node:test';
import { notifTotalOf, reactionSubscriptionKey, unreadTotalOf } from './chatStore.js';

test('a repeated store read does not build a new reaction key or unread total', () => {
  const messages = [{ id: 'a' }, { id: 'temp-1' }, { id: 'b' }];
  const state = { view: 'dm', activeDm: 'peer', dms: { peer: messages }, unreadCounts: { peer: 2, other: 1 }, notifAck: { peer: 1 } };
  const key = reactionSubscriptionKey(state);
  assert.equal(reactionSubscriptionKey(state), key);
  assert.equal(key, 'a,b');
  const unread = unreadTotalOf(state);
  assert.equal(unreadTotalOf(state), unread);
  assert.equal(unread, 3);
  const fresh = notifTotalOf(state);
  assert.equal(notifTotalOf(state), fresh);
  assert.equal(fresh, 2);
});
