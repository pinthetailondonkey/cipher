import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPool, readDirectory, whyUnavailable, READ_OK, READ_UNAVAILABLE } from './relayDirectoryRead.js';

const FILTER = { kinds: [39000, 9002], limit: 50 };
const URL = 'wss://groups.example.test';

// The shape a real pool has. `behaviour` says what the relay does.
function fakePool(behaviour) {
  return {
    closed: [],
    destroyed: false,
    async ensureRelay() {
      if (behaviour === 'refuse') throw new Error('WebSocket connection to the relay failed');
      return {
        subscribe(_filters, params) {
          let closed = false;
          const closer = { close(reason) { closed = true; params.onclose?.(reason || 'closed'); } };
          if (behaviour === 'eose') queueMicrotask(() => params.oneose?.());
          if (behaviour === 'eose-with-events') {
            queueMicrotask(() => {
              params.onevent?.({ id: 'a', kind: 39000, tags: [] });
              params.oneose?.();
            });
          }
          if (behaviour === 'auth') queueMicrotask(() => params.onclose?.('auth-required: we need an AUTH event'));
          if (behaviour === 'silent') { /* never answers */ }
          return closer;
        },
      };
    },
    close(urls) { this.closed.push(...urls); },
    destroy() { this.destroyed = true; },
  };
}

test('a relay that will not connect is unavailability, not an empty directory', async () => {
  const pool = fakePool('refuse');
  const result = await readDirectory([URL], FILTER, { createPool: () => pool });
  // The old code resolved [] here and the screen said the network was empty.
  assert.equal(result.status, READ_UNAVAILABLE);
  assert.deepEqual(result.events, []);
  assert.equal(result.answers[0].status, 'unreachable');
  assert.equal(pool.destroyed, true);
});

test('a completed read with no events is an empty directory', async () => {
  const result = await readDirectory([URL], FILTER, { createPool: () => fakePool('eose') });
  assert.equal(result.status, READ_OK);
  assert.deepEqual(result.events, []);
});

test('a completed read keeps the events it was sent', async () => {
  const result = await readDirectory([URL], FILTER, { createPool: () => fakePool('eose-with-events') });
  assert.equal(result.status, READ_OK);
  assert.equal(result.events.length, 1);
});

test('a subscription refusal proves nothing', async () => {
  const result = await readDirectory([URL], FILTER, { createPool: () => fakePool('auth') });
  assert.equal(result.status, READ_UNAVAILABLE);
  assert.match(whyUnavailable(result.answers), /prove itself/);
});

test('a relay that never answers is unavailability at the deadline', async () => {
  const started = Date.now();
  const result = await readDirectory([URL], FILTER, { timeoutMs: 60, createPool: () => fakePool('silent') });
  assert.equal(result.status, READ_UNAVAILABLE);
  assert.equal(result.answers[0].status, 'timeout');
  assert.ok(Date.now() - started < 2000, 'the read is bounded, not left hanging');
});

test('one answering relay is enough, and events from the other are kept', async () => {
  const pool = {
    ensureRelay: async (url) => ({
      subscribe(_filters, params) {
        if (url === 'wss://dead.test') return { close() {} };
        queueMicrotask(() => { params.onevent?.({ id: url, kind: 39000, tags: [] }); params.oneose?.(); });
        return { close() {} };
      },
    }),
    close() {},
    destroy() {},
  };
  const result = await readDirectory([URL, 'wss://dead.test'], FILTER, { timeoutMs: 200, createPool: () => pool });
  assert.equal(result.status, READ_OK);
  assert.equal(result.events.length, 1);
});

test('no configured relay is its own unavailable answer', async () => {
  const result = await readDirectory([], FILTER, {});
  assert.equal(result.status, READ_UNAVAILABLE);
  assert.match(whyUnavailable(result.answers), /No relay/);
});

// The identity goes with the read: a member-scoped relay can only answer an
// account that proves itself, and the proof is signed by the pool.
test('the reader hands the account to the pool it builds', async () => {
  const identity = { pk: 'ab'.repeat(32), sk: new Uint8Array(32).fill(1) };
  let handed = null;
  const result = await readDirectory([URL], FILTER, {
    identity,
    createPool: (account) => { handed = account; return fakePool('eose'); },
  });
  assert.equal(handed, identity);
  assert.equal(result.status, READ_OK);
});

// The relay answered "prove yourself" instead of answering the request. That
// is not an empty directory: the account was never admitted, so the read stops
// at the refusal and says so. Re-issuing the request afterwards is one shared
// helper (OPSEC's), not a second mechanism here.
test('a relay that closes for a proof is a refusal, not an empty directory', async () => {
  const identity = { pk: 'ab'.repeat(32), sk: new Uint8Array(32).fill(2) };
  const calls = { auth: 0, subs: 0 };
  const pool = {
    async ensureRelay() {
      return {
        subscribe(_filters, params) {
          calls.subs += 1;
          queueMicrotask(() => params.onclose?.('auth-required: this relay needs an AUTH event'));
          return { close() {} };
        },
        async auth(signer) { calls.auth += 1; return signer({ kind: 22242, created_at: 0, tags: [], content: '' }); },
      };
    },
    close() {},
    destroy() {},
  };
  const result = await readDirectory([URL], FILTER, { identity, createPool: () => pool });
  assert.equal(result.status, READ_UNAVAILABLE);
  assert.deepEqual(result.events, []);
  assert.equal(result.answers[0].status, 'auth');
  assert.match(whyUnavailable(result.answers), /prove itself/);
});

// And when the relay refuses the proof as well, the answer is a refusal — not
// "nothing here". This is the branch the screen's sentence comes from.
test('a refusal that survives the proof is named as a refusal', async () => {
  const identity = { pk: 'ab'.repeat(32), sk: new Uint8Array(32).fill(3) };
  const pool = {
    async ensureRelay() {
      return {
        subscribe(_filters, params) {
          queueMicrotask(() => params.onclose?.('auth-required: not on the list'));
          return { close() {} };
        },
        async auth() {},
      };
    },
    close() {},
    destroy() {},
  };
  const result = await readDirectory([URL], FILTER, { identity, createPool: () => pool });
  assert.equal(result.status, READ_UNAVAILABLE);
  assert.deepEqual(result.events, []);
  assert.equal(result.answers[0].status, 'auth');
  assert.match(whyUnavailable(result.answers), /prove itself/);
});

// Measured on the shipped relay (AUDITOR, 2026-10-29, plain build): the request
// is answered with end-of-stored-events before the AUTH lands, and the relay
// never re-sends it. Those events are the public half of the read; counting
// that EOSE as proof is what made the screen say the directory was empty.
test('an answer that arrives before the account is proved is not proof the read completed', async () => {
  const identity = { pk: 'ab'.repeat(32), sk: new Uint8Array(32).fill(5) };
  const state = { subs: 0, challenge: null, authPromise: null };
  const relay = {
    get challenge() { return state.challenge; },
    get authPromise() { return state.authPromise; },
    subscribe(_filters, params) {
      state.subs += 1;
      queueMicrotask(() => {
        state.challenge = 'challenge-1';
        state.authPromise = Promise.resolve({ kind: 22242, sig: 'signed' });
        queueMicrotask(() => {
          params.onevent?.({ id: 'public-only', kind: 39000, tags: [] });
          params.oneose?.();
        });
      });
      return { close() {} };
    },
  };
  const pool = { ensureRelay: async () => relay, close() {}, destroy() {} };
  const result = await readDirectory([URL], FILTER, { identity, createPool: () => pool });
  assert.equal(result.status, READ_UNAVAILABLE, 'the private half was never read');
  assert.deepEqual(result.events, [], 'events from an unproved answer are not published');
  assert.equal(result.answers[0].status, 'auth');
  assert.match(whyUnavailable(result.answers), /prove itself/);
  assert.equal(state.subs, 1, 'the reader does not invent a re-issue of its own');
});

// And a read that is never challenged is not held open waiting for one.
test('an account with nothing to prove is read once, then answered', async () => {
  const identity = { pk: 'ab'.repeat(32), sk: new Uint8Array(32).fill(6) };
  const state = { subs: 0 };
  const relay = {
    challenge: null,
    authPromise: null,
    subscribe(_filters, params) {
      state.subs += 1;
      queueMicrotask(() => { params.onevent?.({ id: 'open', kind: 39000, tags: [] }); params.oneose?.(); });
      return { close() {} };
    },
  };
  const pool = { ensureRelay: async () => relay, close() {}, destroy() {} };
  const started = Date.now();
  const result = await readDirectory([URL], FILTER, { identity, createPool: () => pool });
  assert.equal(result.status, READ_OK);
  assert.equal(state.subs, 1);
  assert.ok(Date.now() - started < 1000, 'the wait for a challenge is bounded and short');
});

// nostr-tools 2.25 reads the signer from `automaticallyAuth`; it does not read
// a constructor option spelled `onauth`. This pins the shape that works.
test('the pool this reader builds can answer a relay challenge', async () => {
  const { getPublicKey } = await import('nostr-tools');
  const sk = new Uint8Array(32).fill(4);
  const pool = await defaultPool({ pk: getPublicKey(sk), sk });
  assert.equal(typeof pool.automaticallyAuth, 'function', 'a challenge has a signer to answer with');
  // The proof names this account, so only the group host gets one. A relay we
  // merely read from must not be able to ask who this person is.
  assert.equal(pool.automaticallyAuth('wss://relay.example'), null, 'a stranger relay gets no signer');
  const signed = pool.automaticallyAuth('wss://groups.ciphertele.com/')({ kind: 22242, created_at: 0, tags: [], content: '' });
  assert.equal(signed.kind, 22242);
  assert.equal(signed.pubkey, getPublicKey(sk));
  assert.ok(signed.sig);
  const bare = await defaultPool(null);
  assert.equal(bare.automaticallyAuth, undefined, 'no account, no claim to prove');
});

test('events from a relay whose read never completed are not published', async () => {
  const pool = {
    ensureRelay: async () => ({
      subscribe(_filters, params) {
        // Events arrive, then the relay closes without ever saying EOSE.
        params.onevent?.({ id: 'partial', kind: 39000, tags: [] });
        queueMicrotask(() => params.onevent?.({ id: 'partial-2', kind: 39000, tags: [] }));
        return { close() {} };
      },
    }),
    close() {},
    destroy() {},
  };
  const result = await readDirectory([URL], FILTER, { timeoutMs: 80, createPool: () => pool });
  assert.equal(result.status, READ_UNAVAILABLE);
  assert.deepEqual(result.events, []);
});
