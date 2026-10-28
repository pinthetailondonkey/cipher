import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GKEY_RETRY_CAP_MS,
  GKEY_RETRY_JITTER,
  GKEY_RETRY_MAX_ATTEMPTS,
  SECURING_STUCK_MS,
  claimSecuringSend,
  dropSecuringSend,
  exhaustKeyRequest,
  groupKeyRequestPending,
  keyRequestPlan,
  keyRequestRecord,
  loadPendingKeyRequests,
  loadSecuringSends,
  queueSecuringSend,
  releaseSecuringSend,
  resetKeyRequest,
  resumeKeyRequestIds,
  retryBaseDelay,
  securingPhase,
  shouldFlushSecuring,
  startGroupKeyRequests,
  stopAllGroupKeyRequests,
} from './groupKeyRequest.js';

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
}

async function settle() {
  for (let i = 0; i < 6; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test('retry delays stay inside ±30% of a base that doubles up to the cap', () => {
  const steady = { random: () => 0.5 };
  assert.equal(retryBaseDelay(0), 2000);
  assert.equal(retryBaseDelay(4), 32000);
  assert.equal(retryBaseDelay(5), 64000);
  assert.equal(retryBaseDelay(30), GKEY_RETRY_CAP_MS);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const mid = keyRequestPlan(attempt, false, steady);
    assert.equal(mid.publish, true);
    assert.equal(mid.exhausted, false);
    assert.ok(mid.base <= GKEY_RETRY_CAP_MS);
    assert.equal(mid.delay, mid.base);
    const low = keyRequestPlan(attempt, false, { random: () => 0 });
    const high = keyRequestPlan(attempt, false, { random: () => 1 });
    assert.equal(low.delay, Math.round(mid.base * (1 - GKEY_RETRY_JITTER)));
    assert.equal(high.delay, Math.round(mid.base * (1 + GKEY_RETRY_JITTER)));
    assert.notEqual(low.delay, high.delay);
  }
  assert.equal(keyRequestPlan(3, true, steady).publish, false);
  assert.equal(keyRequestPlan(GKEY_RETRY_MAX_ATTEMPTS, false, steady).exhausted, true);
  assert.equal(keyRequestPlan(GKEY_RETRY_MAX_ATTEMPTS, false, steady).publish, false);
  assert.equal(keyRequestPlan(GKEY_RETRY_MAX_ATTEMPTS - 1, false, steady).publish, true);
});

test('two members do not share a retry schedule', () => {
  const series = (seed) => {
    let state = seed;
    const random = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    return [0, 1, 2, 3, 4].map((attempt) => keyRequestPlan(attempt, false, { random }).delay);
  };
  assert.notDeepEqual(series(1), series(99));
});

test('the ladder keeps scheduling after the old 62s dead end', async () => {
  const storage = memoryStorage();
  const pubkey = 'd'.repeat(64);
  const timers = [];
  let publishes = 0;
  try {
    startGroupKeyRequests({
      groupId: 'g-long',
      pubkey,
      storage,
      random: () => 0.5,
      schedule: (fn, ms) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer;
      },
      clearTimer: () => {},
      hasKey: async () => false,
      publish: async () => { publishes += 1; },
    });
    await settle();
    assert.equal(publishes, 1);
    for (let n = 0; n < 6; n += 1) {
      assert.ok(timers[n], `missing timer ${n}`);
      timers[n].fn();
      await settle();
    }
    assert.equal(publishes, 7);
    assert.equal(timers[4].ms, 32000);
    assert.equal(timers[5].ms, 64000);
    assert.equal(loadPendingKeyRequests(pubkey, storage).includes('g-long'), true);
  } finally {
    stopAllGroupKeyRequests();
  }
});

test('a securing key request resumes after the in-memory ladder is dropped', async () => {
  const storage = memoryStorage();
  const pubkey = 'e'.repeat(64);
  const other = 'f'.repeat(64);
  let publishes = 0;
  let keyed = false;
  const timers = [];
  try {
    startGroupKeyRequests({
      groupId: 'g-resume',
      pubkey,
      storage,
      random: () => 0.5,
      schedule: (fn, _ms) => setTimeout(fn, 60_000),
      hasKey: async () => false,
      publish: async () => { publishes += 1; },
    });
    await settle();
    assert.equal(publishes, 1);
    assert.deepEqual(loadPendingKeyRequests(pubkey, storage), ['g-resume']);
    assert.deepEqual(loadPendingKeyRequests(other, storage), []);
    stopAllGroupKeyRequests();
    assert.equal(groupKeyRequestPending('g-resume'), false);
    assert.deepEqual(resumeKeyRequestIds({ pubkey, storage }), ['g-resume']);

    const resumed = resumeKeyRequestIds({ pubkey, storage, hasKey: {} })[0];
    startGroupKeyRequests({
      groupId: resumed,
      pubkey,
      storage,
      random: () => 0.5,
      schedule: (fn, ms) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer;
      },
      clearTimer: () => {},
      hasKey: async () => keyed,
      publish: async () => { publishes += 1; },
    });
    await settle();
    assert.equal(publishes, 2);
    keyed = true;
    timers.at(-1).fn();
    await settle();
    assert.equal(publishes, 2);
    assert.deepEqual(loadPendingKeyRequests(pubkey, storage), []);
    assert.deepEqual(resumeKeyRequestIds({ pubkey, storage }), []);
  } finally {
    stopAllGroupKeyRequests();
  }
});

test('a send waiting on a key survives reload and stays on the account that queued it', () => {
  const storage = memoryStorage();
  const pubkey = 'a'.repeat(64);
  const other = 'b'.repeat(64);
  queueSecuringSend(pubkey, {
    id: 'temp-1',
    groupId: 'g',
    payload: { type: 'text', message: 'hello' },
    replyId: null,
  }, storage);
  assert.equal(loadSecuringSends(pubkey, storage)[0].payload.message, 'hello');
  assert.equal(loadSecuringSends(other, storage).length, 0);
  assert.deepEqual(resumeKeyRequestIds({
    pubkey,
    storage,
    joinedIds: ['joined'],
    hasKey: { joined: true },
  }), []);
  dropSecuringSend(pubkey, 'temp-1', storage);
  assert.equal(loadSecuringSends(pubkey, storage).length, 0);
});

test('a waiting send is claimed by one flush only, so a key arriving twice sends it once', () => {
  const pubkey = 'd'.repeat(64);
  // The key-updated event reaches two listeners; both flush the same queue.
  assert.equal(claimSecuringSend(pubkey, 'temp-1'), true, 'the first flush takes the send');
  assert.equal(claimSecuringSend(pubkey, 'temp-1'), false, 'the second flush finds it taken');
  assert.equal(claimSecuringSend(pubkey, 'temp-2'), true, 'another send is its own claim');
  assert.equal(claimSecuringSend('e'.repeat(64), 'temp-1'), true, 'another account is its own claim');
  // A flush that did not publish gives the send back, so a later key still sends it.
  releaseSecuringSend(pubkey, 'temp-1');
  assert.equal(claimSecuringSend(pubkey, 'temp-1'), true, 'a released send can be claimed again');
  // A send that went out is dropped; its claim goes with it.
  releaseSecuringSend(pubkey, 'temp-1');
  releaseSecuringSend(pubkey, 'temp-2');
});

test('the ladder stops at the attempt cap and a reload does not start it over', async () => {
  const storage = memoryStorage();
  const pubkey = 'c'.repeat(64);
  const timers = [];
  let publishes = 0;
  let exhausted = 0;
  try {
    startGroupKeyRequests({
      groupId: 'g-cap',
      pubkey,
      storage,
      attempt: GKEY_RETRY_MAX_ATTEMPTS - 1,
      random: () => 0.5,
      schedule: (fn, ms) => {
        const timer = { fn, ms };
        timers.push(timer);
        return timer;
      },
      clearTimer: () => {},
      hasKey: async () => false,
      publish: async () => { publishes += 1; },
      onExhausted: () => { exhausted += 1; },
    });
    await settle();
    assert.equal(publishes, 1);
    timers.at(-1).fn();
    await settle();
    assert.equal(publishes, 1);
    assert.equal(exhausted, 1);
    assert.equal(keyRequestRecord(pubkey, 'g-cap', storage).exhausted, true);
    assert.equal(loadPendingKeyRequests(pubkey, storage).includes('g-cap'), false);
    stopAllGroupKeyRequests();
    startGroupKeyRequests({
      groupId: 'g-cap',
      pubkey,
      storage,
      attempt: keyRequestRecord(pubkey, 'g-cap', storage).attempts,
      random: () => 0.5,
      schedule: (fn) => { fn(); return {}; },
      clearTimer: () => {},
      hasKey: async () => false,
      publish: async () => { publishes += 1; },
    });
    await settle();
    assert.equal(publishes, 1);
    resetKeyRequest(pubkey, 'g-cap', storage);
    assert.equal(keyRequestRecord(pubkey, 'g-cap', storage).exhausted, false);
    assert.equal(keyRequestRecord(pubkey, 'g-cap', storage).attempts, 0);
  } finally {
    stopAllGroupKeyRequests();
  }
});

test('securing becomes stuck after the threshold and a retry resets the clock', () => {
  const storage = memoryStorage();
  const pubkey = '9'.repeat(64);
  const started = 1_000_000;
  queueSecuringSend(pubkey, {
    id: 'list-1',
    groupId: 'g',
    payload: { type: 'product', title: 'Sample' },
    since: started,
  }, storage);
  assert.equal(securingPhase(started, started + SECURING_STUCK_MS - 1), 'securing');
  assert.equal(securingPhase(started, started + SECURING_STUCK_MS), 'stuck');
  assert.equal(SECURING_STUCK_MS, 180_000);
  assert.equal(loadSecuringSends(pubkey, storage)[0].payload.type, 'product');
  exhaustKeyRequest(pubkey, 'g', storage);
  assert.equal(keyRequestRecord(pubkey, 'g', storage).exhausted, true);
  const waiting = loadSecuringSends(pubkey, storage);
  assert.deepEqual(shouldFlushSecuring({
    groupId: 'g',
    sends: waiting,
    exhausted: true,
  }), { flush: true, ids: ['list-1'], exhausted: true });
});
