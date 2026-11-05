import assert from 'node:assert/strict';
import test from 'node:test';
import { makeSubscriptionGuard, setupChatSubscriptions } from './chatSubscriptions.js';

// fix 3: the effect awaits the history fetch before it can subscribe. A
// cleanup that lands inside that await used to let every later subscription
// open with nothing left to close it. These tests own the delayed promise and
// the subscription objects, so the race is driven, not hoped for.

function world() {
  const live = new Set();
  const opened = [];
  const subscribeTo = (name) => (...args) => {
    opened.push({ name, args });
    const close = () => live.delete(name);
    live.add(name);
    return close;
  };
  return {
    live,
    opened,
    subscribeToDMs: subscribeTo('dms'),
    subscribeToGroups: subscribeTo('groups'),
    subscribeToGroupReactions: subscribeTo('reactions'),
  };
}

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('a cleanup during the history fetch leaves no subscription live', async () => {
  const w = world();
  const gate = deferred();
  const guard = makeSubscriptionGuard();
  const run = setupChatSubscriptions({
    guard,
    fetchChats: () => gate.promise,
    subscribeToDMs: w.subscribeToDMs,
    subscribeToGroups: w.subscribeToGroups,
    subscribeToGroupReactions: w.subscribeToGroupReactions,
    since: 1,
    readTargets: () => ({ joinedIds: ['g1'], groupIds: ['g1'] }),
  });
  // The effect is torn down while it is still awaiting the fetch.
  guard.cleanup();
  assert.equal(w.live.size, 0, 'nothing has subscribed yet');
  gate.resolve();
  await run;
  assert.equal(w.live.size, 0, 'no subscription created after cancellation stays live');
  // The guard returns before every subscribe call, so nothing opens at all.
  assert.deepEqual(w.opened.map((entry) => entry.name), []);
});

test('a cleanup after the DM subscription closes it and starts nothing else', async () => {
  const w = world();
  const guard = makeSubscriptionGuard();
  await setupChatSubscriptions({
    guard,
    fetchChats: async () => {},
    subscribeToDMs: w.subscribeToDMs,
    subscribeToGroups: w.subscribeToGroups,
    subscribeToGroupReactions: w.subscribeToGroupReactions,
    since: 1,
    // Cleanup lands after the DM subscription, while the targets are read.
    readTargets: () => {
      guard.cleanup();
      return { joinedIds: ['g1'], groupIds: ['g1'] };
    },
  });
  assert.deepEqual(w.opened.map((entry) => entry.name), ['dms'], 'only the DM subscription was ever opened');
  assert.equal(w.live.size, 0, 'and cleanup closed it');
});

test('an uninterrupted setup keeps every subscription and closes all on cleanup', async () => {
  const w = world();
  const guard = makeSubscriptionGuard();
  await setupChatSubscriptions({
    guard,
    fetchChats: async () => {},
    subscribeToDMs: w.subscribeToDMs,
    subscribeToGroups: w.subscribeToGroups,
    subscribeToGroupReactions: w.subscribeToGroupReactions,
    since: 1,
    readTargets: () => ({ joinedIds: ['g1'], groupIds: ['g1'] }),
  });
  assert.deepEqual([...w.live].sort(), ['dms', 'groups', 'reactions'], 'the happy path is unchanged');
  guard.cleanup();
  assert.equal(w.live.size, 0, 'cleanup closes every one');
});

test('a pending join still opens no group subscriptions', async () => {
  const w = world();
  const guard = makeSubscriptionGuard();
  await setupChatSubscriptions({
    guard,
    fetchChats: async () => {},
    subscribeToDMs: w.subscribeToDMs,
    subscribeToGroups: w.subscribeToGroups,
    subscribeToGroupReactions: w.subscribeToGroupReactions,
    since: 1,
    // joinedIds carries the pending join; groupIds is what may be followed.
    readTargets: () => ({ joinedIds: ['g1'], groupIds: [] }),
  });
  // The DM stream always opens; the group stream waits for admission, but the
  // reaction stream follows joined ids exactly as it did before. (fix 3)
  assert.deepEqual(w.opened.map((entry) => entry.name), ['dms', 'reactions']);
  guard.cleanup();
});
