import assert from 'node:assert/strict';
import test from 'node:test';
import { barUnreadTotalOf, notifTotalOf, reactionSubscriptionKey, unreadTotalOf } from './chatStore.js';

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

test('the bar badge skips muted, forever-muted, future-muted and archived chats, and keeps expired mutes', () => {
  const now = Date.now();
  const state = {
    unreadCounts: { silent: 2, loud: 3, forever: 4, timed: 5, archived: 6, expired: 1 },
    archivedChats: ['archived'],
    mutedChats: ['silent'],
    mutedUntil: { forever: 'forever', timed: now + 60000, expired: now - 1000 },
  };
  // loud counts, and the expired timed mute counts — the mute is over.
  assert.equal(barUnreadTotalOf(state), 4);
  // The raw total still counts everything it always did.
  assert.equal(unreadTotalOf(state), 21);
  // Same state again: the memo holds, no rescan.
  assert.equal(barUnreadTotalOf(state), 4);
});

test('the bar badge recovers when a mute lifts, without waiting on anything else', () => {
  const later = Date.now() + 60000;
  const state = {
    unreadCounts: { timed: 5, kept: 2 },
    archivedChats: [],
    mutedChats: [],
    mutedUntil: { timed: later },
  };
  assert.equal(barUnreadTotalOf(state), 2);
  // The timed mute expires — a new mutedUntil identity is written by the
  // unmute path, and the badge recounts on it alone.
  const expired = { ...state, mutedUntil: { timed: Date.now() - 1000 } };
  assert.equal(barUnreadTotalOf(expired), 7);
});
