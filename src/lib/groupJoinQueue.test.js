import assert from 'node:assert/strict';
import test from 'node:test';
import {
  JOIN_REQUESTS_EVENT, clearJoinDenial, denyPendingJoin, dropPendingJoin, hasPendingJoin, isJoinDenied,
  loadPendingJoins, pendingJoinsFor, queuePendingJoin, subscribeJoinRequests,
  withoutDenied,
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

test('a denied sender stays denied: the 9021 replay cannot re-queue them', () => {
  withStorage(() => {
    queuePendingJoin(GROUP, { pubkey: PK, eventId: 'ev3', at: 10 });
    assert.equal(denyPendingJoin(GROUP, PK), true);
    assert.equal(isJoinDenied(GROUP, PK), true);
    assert.deepEqual(pendingJoinsFor(GROUP), []);
    // A deny was recorded in per-account storage before the row went.
    const raw = globalThis.localStorage.getItem(`cipher_${getActivePubkey().slice(0, 8)}_join_denied`);
    assert.match(raw, /"a+"/);
    // The replayed 9021 runs through the same queue call from fresh state.
    assert.equal(queuePendingJoin(GROUP, { pubkey: PK, eventId: 'ev3', at: 20 }), false);
    assert.equal(loadPendingJoins()[GROUP], undefined);
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

test('a deny strips the sender from a relay roster: an open-join relay cannot bring them back', () => {
  withStorage(() => {
    assert.equal(denyPendingJoin(GROUP, PK), true);
    const roster = [{ pubkey: PK, role: 'member' }, { pubkey: OTHER, role: 'admin' }, OTHER];
    assert.deepEqual(withoutDenied(GROUP, roster), [{ pubkey: OTHER, role: 'admin' }, OTHER]);
    // A group with nothing denied hands the rows back untouched.
    const OTHER_GROUP = 'open-group';
    assert.deepEqual(withoutDenied(OTHER_GROUP, roster), roster);
    // No groupId or no rows at all: nothing to strip.
    assert.deepEqual(withoutDenied('', roster), roster);
    assert.deepEqual(withoutDenied(GROUP, null), []);
  });
});

test('a pending row outvotes the relay roster on the grant path (drills D1-B/D1-D)', () => {
  withStorage(() => {
    queuePendingJoin(GROUP, { pubkey: PK, eventId: 'ev1', at: 10 });
    // A relay can name the queued sender; the pending row says nobody has
    // approved them yet, so the grant path must refuse outright.
    assert.equal(hasPendingJoin(GROUP, PK), true);
    // A peer who was never queued decides from the roster as before.
    assert.equal(hasPendingJoin(GROUP, OTHER), false);
    // The owner's approval drops the row; a roster naming them then stands.
    dropPendingJoin(GROUP, PK);
    assert.equal(hasPendingJoin(GROUP, PK), false);
    // Case-blind: the attacker's own casing buys nothing.
    queuePendingJoin(GROUP, { pubkey: PK, at: 10 });
    assert.equal(hasPendingJoin(GROUP, PK.toUpperCase()), true);
    assert.equal(hasPendingJoin('', PK), false);
  });
});

test('the owner clears the denial and the sender becomes grantable again (drills D1-E)', () => {
  withStorage(() => {
    denyPendingJoin(GROUP, PK);
    assert.equal(isJoinDenied(GROUP, PK), true);
    // Owner-initiated re-add clears the record — the relay's word never does.
    assert.equal(clearJoinDenial(GROUP, PK), true);
    assert.equal(isJoinDenied(GROUP, PK), false);
    // Clearing an absent denial is a no-op, not an error.
    assert.equal(clearJoinDenial(GROUP, PK), false);
    assert.equal(clearJoinDenial('', PK), false);
    // Deny survives through the same call shape as before, and re-add still works.
    denyPendingJoin(GROUP, OTHER);
    clearJoinDenial(GROUP, OTHER);
    assert.equal(isJoinDenied(GROUP, OTHER), false);
  });
});
