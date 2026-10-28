import assert from 'node:assert/strict';
import test from 'node:test';
import { unreadCountsFor, countsAsNewUnread } from './unreadCounts.js';

test('the recount skips our own, deleted and already-read messages and counts each id once', () => {
  const msgs = [
    { id: 'a', chatId: 'p', timestamp: 10 },
    { id: 'b', chatId: 'p', timestamp: 20 },
    { id: 'c', chatId: 'p', timestamp: 30 },
    { id: 'd', chatId: 'p', timestamp: 40, isSender: true },
    { id: 'a', chatId: 'p', timestamp: 10 },
    { id: 'e', chatId: 'q', timestamp: 5 },
  ];
  assert.deepEqual(unreadCountsFor(msgs, { p: 10 }, ['c']), { p: 1, q: 1 });
  assert.deepEqual(unreadCountsFor(msgs, { p: 50, q: 50 }, new Set()), {});
});

test('a live arrival adds one only when it is new, undeleted, from them, in a closed chat and past lastRead', () => {
  const base = { alreadyStored: false, tombstoned: false, isSender: false, chatOpen: false, timestamp: 100, lastRead: 50 };
  assert.equal(countsAsNewUnread(base), true);
  assert.equal(countsAsNewUnread({ ...base, alreadyStored: true }), false);
  assert.equal(countsAsNewUnread({ ...base, tombstoned: true }), false);
  assert.equal(countsAsNewUnread({ ...base, isSender: true }), false);
  assert.equal(countsAsNewUnread({ ...base, chatOpen: true }), false);
  assert.equal(countsAsNewUnread({ ...base, timestamp: 40 }), false);
});

test('cold start: four stored messages and two live repeats stay at four', () => {
  const stored = [1, 2, 3, 4].map((n) => ({ id: `m${n}`, chatId: 'p', timestamp: n }));
  let count = unreadCountsFor(stored, {}).p;
  for (const repeat of [stored[2], stored[3]]) {
    if (countsAsNewUnread({ alreadyStored: true, tombstoned: false, isSender: false, chatOpen: false, timestamp: repeat.timestamp, lastRead: 0 })) count += 1;
  }
  assert.equal(count, 4);
});
