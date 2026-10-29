import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPool, readDirectory, whyUnavailable, READ_OK, READ_UNAVAILABLE } from './relayDirectoryRead.js';
import { installAutoAuth } from './pool.js';

const FILTER = { kinds: [39000, 9002], limit: 50 };
const URL = 'wss://groups.example.test';
const GROUP_URL = 'wss://groups.ciphertele.com';
const STRANGER_URL = 'wss://relay.example';

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
  // This pool never installed a signer, so the shared helper finds no host it
  // could answer for and the second ask cannot go out. That is the refusal,
  // not a read held open: what arms the re-issue is installAutoAuth.
  assert.equal(state.subs, 1, 'no installed signer, no second ask');
});

// A pool built the way defaultPool builds one: the factory installs the
// signer, so the library calls it in ensureRelay exactly as it does in the
// app, and answering a challenge is what makes a host eligible to wait on.
function installedPool(url, signer, relayUrl = url) {
  const state = { subs: 0, firstClosed: 0, signerCalls: 0 };
  const relay = { url: relayUrl, challenge: null, onauth: null };
  const pool = {
    close() {},
    destroy() {},
    async ensureRelay() {
      const sign = pool.automaticallyAuth?.(url);
      if (sign) relay.onauth = sign;
      return relay;
    },
  };
  installAutoAuth(pool, (_host, seen) => (seen === url ? signer : null));
  return { pool, relay, state };
}

// The whole defect row 18 was: the relay EOSEs the unproved request, asks for
// proof afterwards, and never re-sends. Signing alone is not enough, so the
// reader asks once more behind the proof. The first answer is the public half
// and its events are not published; the second answer is the read.
test('a request answered before the proof is asked a second time, and the second answer is the read', async () => {
  const identity = { pk: 'ab'.repeat(32), sk: new Uint8Array(32).fill(7) };
  let subscribes = 0;
  const { pool, relay } = installedPool(GROUP_URL, (authEvent) => {
    relay.authSigned = { ...authEvent, sig: 'signed' };
    return relay.authSigned;
  });
  relay.subscribe = (_filters, params) => {
    subscribes += 1;
    const mine = subscribes;
    queueMicrotask(() => {
      if (mine === 1) {
        // Public half: an answer, then the challenge, and the subscription is
        // never re-sent by the library.
        relay.challenge = 'challenge-1';
        if (relay.onauth) relay.onauth({ kind: 22242, created_at: 0, tags: [], content: '' });
        params.onevent?.({ id: 'public-only', kind: 39000, tags: [] });
        params.oneose?.();
        return;
      }
      params.onevent?.({ id: 'private-row', kind: 39000, tags: [] });
      params.oneose?.();
    });
    return { close() { if (mine === 1) relay.firstClosed += 1; } };
  };
  const result = await readDirectory([GROUP_URL], FILTER, { identity, createPool: () => pool });
  assert.equal(subscribes, 2, 'a second REQ went out after the proof, not a hang');
  assert.equal(relay.authSigned?.kind, 22242, 'the proof was signed by this pool');
  assert.equal(result.status, READ_OK, 'the second answer is the completed read');
  // Both halves belong once the read is proved: the public answer was the
  // same directory served without the proof, and the second answer completes
  // it. Dedup is by event id, so a row the relay sent twice is published once.
  assert.deepEqual(result.events.map((event) => event.id).sort(), ['private-row', 'public-only']);
});

// And when the proof never lands inside the read's own deadline, the answer is
// the refusal sentence — measured, not inferred from "no second REQ".
test('a proof that never lands ends in the refusal sentence, quickly', async () => {
  const identity = { pk: 'ab'.repeat(32), sk: new Uint8Array(32).fill(8) };
  let subscribes = 0;
  // A pool that signs for nobody: the host is never eligible, so the helper
  // settles at once instead of sitting out the deadline.
  const { pool, relay } = installedPool('wss://elsewhere.test', () => ({ sig: 'never used' }), GROUP_URL);
  relay.subscribe = (_filters, params) => {
    subscribes += 1;
    queueMicrotask(() => {
      relay.challenge = 'challenge-1';
      params.oneose?.();
    });
    return { close() {} };
  };
  const started = Date.now();
  const result = await readDirectory([GROUP_URL], FILTER, { identity, createPool: () => pool, timeoutMs: 4000 });
  const took = Date.now() - started;
  assert.equal(result.status, READ_UNAVAILABLE, 'a fast wrong answer is still wrong');
  assert.deepEqual(result.events, []);
  assert.equal(result.answers[0].status, 'auth');
  assert.match(whyUnavailable(result.answers), /prove itself/);
  assert.ok(took < 1000, `settled at once, not at the deadline (took ${took} ms)`);
});

// The one-directional test would miss this: a host passed straight to
// isGroupHost gives '' inside hostOf and refuses the group relay too, so a
// pool that signs for nobody would still pass every "nothing leaked" check.
test('the installed pool can answer the group host and only the group host', async () => {
  const { getPublicKey } = await import('nostr-tools');
  const sk = new Uint8Array(32).fill(9);
  const pool = await defaultPool({ pk: getPublicKey(sk), sk });
  assert.equal(typeof pool.automaticallyAuth, 'function');
  const groupSigner = pool.automaticallyAuth(GROUP_URL);
  assert.equal(typeof groupSigner, 'function', 'the group host IS eligible');
  const signed = groupSigner({ kind: 22242, created_at: 0, tags: [], content: '' });
  assert.equal(signed.pubkey, getPublicKey(sk));
  assert.equal(pool.automaticallyAuth(STRANGER_URL), null, 'a stranger host gets no signer');
});

// No account, no proof, no wait: the read is one ask and the honest answer.
test('without an identity the reader never waits for a proof', async () => {
  const pool = await defaultPool(null);
  assert.equal(pool.automaticallyAuth, undefined);
  let subscribes = 0;
  const relay = {
    url: GROUP_URL,
    challenge: null,
    subscribe(_filters, params) {
      subscribes += 1;
      queueMicrotask(() => { relay.challenge = 'challenge-1'; params.oneose?.(); });
      return { close() {} };
    },
  };
  const started = Date.now();
  const result = await readDirectory([GROUP_URL], FILTER, {
    createPool: () => ({ ensureRelay: async () => relay, close() {}, destroy() {} }),
    timeoutMs: 4000,
  });
  assert.equal(subscribes, 1);
  assert.equal(result.status, READ_UNAVAILABLE);
  assert.ok(Date.now() - started < 1000, 'no signer, no armed wait');
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
