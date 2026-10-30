import assert from 'node:assert/strict';
import test from 'node:test';
import {
  NOTIFICATION_PER_PEER_MS,
  NOTIFICATION_QUIET_MS,
  notificationAllowed,
} from './notificationThrottle.js';

test('the first notification from anyone is always allowed', () => {
  assert.equal(notificationAllowed({ peer: 'alice', now: 1_000 }), true);
  assert.equal(notificationAllowed({ peer: '', now: 1_000 }), true);
  assert.equal(notificationAllowed({ peer: 'alice', now: 0 }), true);
});

test('a second notification from the same counterparty waits out its window', () => {
  const base = { peer: 'alice', lastPerPeer: { alice: 10_000 }, lastAny: 10_000 };
  assert.equal(notificationAllowed({ ...base, now: 10_000 + NOTIFICATION_PER_PEER_MS - 1 }), false);
  assert.equal(notificationAllowed({ ...base, now: 10_000 + NOTIFICATION_PER_PEER_MS }), true);
});

test('a different counterparty still fires, but only after the quiet window', () => {
  const base = { peer: 'bob', lastPerPeer: { alice: 10_000 }, lastAny: 10_000 };
  assert.equal(notificationAllowed({ ...base, now: 10_000 + NOTIFICATION_QUIET_MS - 1 }), false);
  assert.equal(notificationAllowed({ ...base, now: 10_000 + NOTIFICATION_QUIET_MS }), true);
});

test('a burst of many senders is held to one notification per quiet window', () => {
  let lastAny = 0;
  const lastPerPeer = {};
  let shown = 0;
  for (let at = 1; at <= 10_000; at += 100) {
    const peer = `attacker-${at % 7}`;
    if (notificationAllowed({ peer, now: at, lastPerPeer, lastAny })) {
      lastPerPeer[peer] = at;
      lastAny = at;
      shown += 1;
    }
  }
  // 101 arrivals in ten seconds; the quiet window lets through one per 2s.
  assert.equal(shown, 5);
});

test('an old notification no longer gates anything', () => {
  assert.equal(notificationAllowed({
    peer: 'alice', now: 10_000_000, lastPerPeer: { alice: 10_000 }, lastAny: 10_000,
  }), true);
});
