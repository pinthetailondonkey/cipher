import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOIN_REQUESTS_EVENT, dropPendingJoin, loadPendingJoins, pendingJoinsFor,
  queuePendingJoin, subscribeJoinRequests,
} from './groupJoinQueue.js';
import { getActivePubkey } from './storage.js';

// The queue writes through the scoped storage shim, which reads live
// localStorage. A fixed store stands in for it, per account.
function withStorage(run) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
  return Promise.resolve(run()).finally(() => { delete globalThis.localStorage; });
}

const PK = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const GROUP = 'join-group';

test('a first-time 9021 sender queues once, and a repeat does not stack rows', () => {
  withStorage(() => {
    assert.equal(queuePendingJoin(GROUP, { pubkey: PK, eventId: 'ev1', at: 100 }), true);
    assert.equal(queuePendingJoin(GROUP, { pubkey: PK, eventId: 'ev2', at: 200 }), false);
    assert.deepEqual(pendingJoinsFor(GROUP), [{ pubkey: PK, eventId: 'ev1', at: 100 }]);
    assert.deepEqual(loadPendingJoins()[OTHER] ?? [], []);
  });
});

test('a join request is written to storage, and a stored one reads back after a reopen', () => {
  withStorage(() => {
    queuePendingJoin(GROUP, { pubkey: OTHER, eventId: 'ev9', at: 42 });
    // The write went to storage, not to a hook's state.
    const raw = globalThis.localStorage.getItem(`cipher_${getActivePubkey().slice(0, 8)}_join_pending`);
    assert.match(raw, /"pubkey":"b+"/);
    // A reopen reads back the stored rows through the same shim.
    globalThis.localStorage.setItem(`cipher_${getActivePubkey().slice(0, 8)}_join_pending`, raw);
    assert.deepEqual(loadPendingJoins()[GROUP], [{ pubkey: OTHER, eventId: 'ev9', at: 42 }]);
  });
});

test('nothing is queued without a pubkey worth reading, and drop removes exactly one row', () => {
  withStorage(() => {
    assert.equal(queuePendingJoin(GROUP, { pubkey: 'not-a-key' }), false);
    assert.equal(queuePendingJoin('', { pubkey: PK }), false);
    assert.deepEqual(pendingJoinsFor(GROUP), []);
    queuePendingJoin(GROUP, { pubkey: PK });
    queuePendingJoin(GROUP, { pubkey: OTHER });
    assert.equal(dropPendingJoin(GROUP, PK), true);
    assert.equal(dropPendingJoin(GROUP, PK), false);
    assert.deepEqual(pendingJoinsFor(GROUP).map((row) => row.pubkey), [OTHER]);
    dropPendingJoin(GROUP, OTHER);
    assert.deepEqual(pendingJoinsFor(GROUP), []);
    assert.equal(loadPendingJoins()[GROUP], undefined);
  });
});

test('the queue tells the screen it changed', () => {
  withStorage(() => {
    const seen = [];
    const stop = subscribeJoinRequests(() => seen.push(JOIN_REQUESTS_EVENT));
    try {
      if (typeof window !== 'undefined') {
        queuePendingJoin(GROUP, { pubkey: PK });
        dropPendingJoin(GROUP, PK);
        assert.deepEqual(seen, [JOIN_REQUESTS_EVENT, JOIN_REQUESTS_EVENT]);
      }
    } finally {
      stop();
    }
  });
});
