import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPublicKey, finalizeEvent } from 'nostr-tools';

// A pool that never answers a challenge cannot read a relay that demands one.
// These tests stand a relay up in place of the WebSocket and play it in the
// two manners the real group relay was measured in:
//   early  - AUTH arrives before the app asks; answering it is enough;
//   late   - the relay EOSEs the unauthenticated REQ at once, sends AUTH a
//            moment later, and never closes the subscription. Signing alone
//            cannot deliver events there, so the read has to be asked again.

const SK = Uint8Array.from({ length: 32 }, () => 170);
const PK = getPublicKey(SK);
const GROUP_RELAY = 'wss://groups.ciphertele.com';
const PUBLIC_RELAY = 'wss://relay.damus.io';

const groupEvent = finalizeEvent({
  kind: 39000, created_at: 1700000000, tags: [['d', 'room'], ['name', 'Room']], content: '',
}, SK);

function makeMannerStub({ manner = 'early', challengeMs = 0, refuse = false } = {}) {
  const sockets = [];
  const seen = { auth: 0, req: 0, refusals: 0 };
  class RelaySocket {
    constructor() {
      this.sent = [];
      this.authed = false;
      this.closed = false;
      sockets.push(this);
      setTimeout(() => { if (this.onopen) this.onopen(); }, 0);
      if (manner !== 'none' && !refuse) {
        // Give nostr-tools its onmessage assignment before the challenge lands.
        setTimeout(() => {
          seen.auth += 1;
          this.emit(['AUTH', 'challenge-test']);
        }, Math.max(challengeMs, 30));
      }
    }
    addEventListener() {}
    removeEventListener() {}
    send(raw) {
      const msg = JSON.parse(raw);
      this.sent.push(msg);
      if (msg[0] === 'AUTH') {
        if (refuse) {
          seen.refusals += 1;
          this.emit(['OK', msg[1].id, false, 'auth-required: relay mismatch']);
          this.emit(['CLOSED', 'auth', 'auth-required: relay mismatch']);
          return;
        }
        this.authed = true;
        this.emit(['OK', msg[1].id, true, '']);
        return;
      }
      if (msg[0] === 'REQ') {
        seen.req += 1;
        if (this.authed) {
          // Signed for real: the pool verifies every event it hands back, so a
          // fake signature would be dropped and the test would pass for the
          // wrong reason.
          this.emit(['EVENT', msg[1], groupEvent]);
          this.emit(['EOSE', msg[1]]);
          return;
        }
        if (manner === 'closed') {
          this.emit(['CLOSED', msg[1], 'auth-required: relay mismatch']);
          return;
        }
        this.emit(['EOSE', msg[1]]);
      }
    }
    close() { this.closed = true; }
    emit(data) { if (!this.closed && this.onmessage) this.onmessage({ data: JSON.stringify(data) }); }
  }
  RelaySocket.prototype.onopen = null;
  RelaySocket.prototype.onmessage = null;
  RelaySocket.prototype.onclose = null;
  RelaySocket.prototype.onerror = null;
  return { RelaySocket, sockets, seen };
}

async function withPool(stub, run) {
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = stub.RelaySocket;
  const mod = await import('./pool.js');
  const identity = { pk: PK, sk: SK };
  const pool = await mod.getAuthenticatedPool(identity);
  try {
    await run({ pool, mod, identity });
  } finally {
    mod.clearPool();
    if (previous === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previous;
  }
}

test('late challenge: signing alone leaves the first read empty, and the helper asks again', async () => {
  const stub = makeMannerStub({ manner: 'late', challengeMs: 120 });
  await withPool(stub, async ({ pool, mod }) => {
    const plain = await pool.querySync([GROUP_RELAY], { kinds: [39000], limit: 1 });
    assert.equal(plain.length, 0, 'measured: the library does not re-issue, so a plain read stays empty');
    const events = await mod.querySyncAfterAuth(pool, [GROUP_RELAY], { kinds: [39000], limit: 1 });
    assert.equal(events.length, 1, 'the read asked again once the AUTH landed');
    assert.equal(stub.seen.auth, 1, 'one challenge, one answer');
  });
});

test('the re-issued read delivers each event once, never twice', async () => {
  const stub = makeMannerStub({ manner: 'late', challengeMs: 120 });
  await withPool(stub, async ({ pool, mod }) => {
    const events = await mod.querySyncAfterAuth(pool, [GROUP_RELAY], { kinds: [39000], limit: 5 });
    assert.equal(events.length, 1, 'no double delivery across the pre-AUTH and post-AUTH read');
    const ids = events.map((e) => e.id);
    assert.deepEqual(ids, [...new Set(ids)], 'no duplicate ids');
  });
});

test('a relay that closes with auth-required is not asked twice', async () => {
  const stub = makeMannerStub({ manner: 'closed', challengeMs: 0 });
  await withPool(stub, async ({ pool, mod }) => {
    const events = await mod.querySyncAfterAuth(pool, [GROUP_RELAY], { kinds: [39000], limit: 5 });
    assert.equal(events.length, 1, 'the event arrived');
    console.log('CLOSED manner reqs=', stub.seen.req, 'auth=', stub.seen.auth);
    assert.ok(stub.seen.req <= 2, `the library's own retry only, got ${stub.seen.req} REQs`);
  });
});

test('when AUTH is refused the read settles instead of spinning', async () => {
  const stub = makeMannerStub({ refuse: true });
  await withPool(stub, async ({ pool, mod }) => {
    const started = Date.now();
    const events = await mod.querySyncAfterAuth(pool, [GROUP_RELAY], { kinds: [39000], limit: 1 }, 600);
    const elapsed = Date.now() - started;
    assert.equal(events.length, 0, 'nothing is invented');
    assert.ok(elapsed < 3000, `settled in ${elapsed} ms rather than waiting forever`);
    assert.equal(stub.seen.req, 1, 'no re-issue without a successful AUTH');
  });
});

test('an empty public read is never held: the wait arms only where a signer does', async () => {
  // No challenge ever arrives on a public relay: the pool has no signer there,
  // so an empty answer has to settle at once rather than waiting out the window.
  const stub = makeMannerStub({ manner: 'none' });
  await withPool(stub, async ({ pool, mod }) => {
    const started = Date.now();
    const events = await mod.querySyncAfterAuth(pool, [PUBLIC_RELAY], { kinds: [1], limit: 1 }, 4000);
    const elapsed = Date.now() - started;
    assert.equal(events.length, 0, 'nothing is invented');
    assert.equal(stub.seen.req, 1, 'asked once, not re-issued');
    assert.equal(stub.seen.auth, 0, 'no challenge was ever sent');
    assert.ok(elapsed < 1000, `settled in ${elapsed} ms instead of waiting out the 4000 ms deadline`);
  });
});

test('a per-relay reader holding its own relay object can re-open the read', async () => {
  // The directory reader subscribes on relay.subscribe directly, so it cannot
  // use the pool-shaped helper. This is the shape it calls.
  const stub = makeMannerStub({ manner: 'late', challengeMs: 120 });
  await withPool(stub, async ({ pool, mod }) => {
    const relay = await pool.ensureRelay(GROUP_RELAY);
    const collected = [];
    const closer = await mod.reissueAfterAuth(pool, relay, [{ kinds: [39000], limit: 1 }], {
      onevent: (event) => collected.push(event),
      oneose: () => {},
    });
    assert.ok(closer, 'the read was re-opened after the AUTH');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(collected.length, 1, 'the event arrived on the re-opened read');
    assert.equal(stub.seen.req, 1, 'one read, opened after the AUTH, not one before it');
  });
});

test('the per-relay shape is not held on a relay with no signer', async () => {
  const stub = makeMannerStub({ manner: 'none' });
  await withPool(stub, async ({ pool, mod }) => {
    const relay = await pool.ensureRelay(PUBLIC_RELAY);
    const started = Date.now();
    const closer = await mod.reissueAfterAuth(pool, relay, [{ kinds: [1] }], {}, 4000);
    assert.equal(closer, null, 'no second read where no challenge can arrive');
    assert.ok(Date.now() - started < 1000, 'settled at once');
  });
});

test('the group relay still re-issues once it has answered its challenge', async () => {
  // The same helper on the one host that does challenge: eligibility is not a
  // blanket "never wait", it is exactly the host the pool can sign for.
  const stub = makeMannerStub({ manner: 'late', challengeMs: 120 });
  await withPool(stub, async ({ pool, mod }) => {
    const events = await mod.querySyncAfterAuth(pool, [GROUP_RELAY], { kinds: [39000], limit: 1 }, 4000);
    assert.equal(events.length, 1, 'the group event arrived after the AUTH');
    assert.equal(stub.seen.req, 2, 'the read was asked again');
  });
});

test('a pool this file did not build can re-issue, once the install arms it', async () => {
  // The directory reader builds its own pool so it can close it at settle. On
  // that pool the wait half alone does nothing: eligibility is empty, so the
  // re-issue resolves null for the group host too and the read stays empty.
  // The install is what makes the two halves travel together.
  const stub = makeMannerStub({ manner: 'late', challengeMs: 120 });
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = stub.RelaySocket;
  const mod = await import('./pool.js');
  const { SimplePool, finalizeEvent } = await import('nostr-tools');
  const groupHost = new URL(GROUP_RELAY).host;
  try {
    const unarmed = new SimplePool();
    const bare = await unarmed.ensureRelay(GROUP_RELAY);
    assert.equal(
      await mod.reissueAfterAuth(unarmed, bare, [{ kinds: [39000] }], {}, 300),
      null,
      'an unarmed pool never waits, so the reader must install',
    );
    unarmed.destroy();

    const own = new SimplePool();
    mod.installAutoAuth(own, (host) => (
      host === groupHost ? (authEvent) => finalizeEvent(authEvent, SK) : null
    ));
    const relay = await own.ensureRelay(GROUP_RELAY);
    const collected = [];
    const closer = await mod.reissueAfterAuth(own, relay, [{ kinds: [39000], limit: 1 }], {
      onevent: (event) => collected.push(event),
      oneose: () => {},
    });
    assert.ok(closer, 'the re-issue ran on a pool this file did not build');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(collected.length, 1, 'the event arrived on the re-opened read');
    const answered = stub.sockets.filter((socket) => socket.sent.some((msg) => msg[0] === 'AUTH'));
    assert.equal(answered.length, 1, 'exactly one socket answered the challenge — the installed pool, not the bare one');
    own.destroy();
  } finally {
    if (previous === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previous;
  }
});

test('the install answers for its own hosts only', async () => {
  const stub = makeMannerStub({ manner: 'none' });
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = stub.RelaySocket;
  const mod = await import('./pool.js');
  const { SimplePool, finalizeEvent } = await import('nostr-tools');
  const groupHost = new URL(GROUP_RELAY).host;
  try {
    const own = new SimplePool();
    mod.installAutoAuth(own, (host) => (
      host === groupHost ? (authEvent) => finalizeEvent(authEvent, SK) : null
    ));
    const started = Date.now();
    const relay = await own.ensureRelay(PUBLIC_RELAY);
    const closer = await mod.reissueAfterAuth(own, relay, [{ kinds: [1] }], {}, 4000);
    assert.equal(closer, null, 'no second read where this pool has no signer');
    assert.ok(Date.now() - started < 1000, 'settled at once, not held for the deadline');
    own.destroy();
  } finally {
    if (previous === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previous;
  }
});

test('the choke point every read passes through re-issues, on the pool the app builds', async () => {
  // src/lib/relays.js has one line that every app read routes through, and the
  // pool below is the account pool — the consumer's, not one this test built.
  // A test that constructed its own pool could not see the failure the install
  // exists for: no eligibility, so no second ask.
  const stub = makeMannerStub({ manner: 'late', challengeMs: 120 });
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = stub.RelaySocket;
  const mod = await import('./pool.js');
  const { queryWithTimeout } = await import('./relays.js');
  try {
    const pool = await mod.getAuthenticatedPool({ pk: PK, sk: SK });
    const events = await queryWithTimeout(pool, [GROUP_RELAY], { kinds: [39000], limit: 1 }, 4000);
    assert.equal(events.length, 1, 'the read came back with the event after the AUTH');
    assert.equal(stub.seen.req, 2, 'a second REQ went out through the choke point');
  } finally {
    mod.clearPool();
    if (previous === undefined) delete globalThis.WebSocket;
    else globalThis.WebSocket = previous;
  }
});

// The original case, kept: a relay that challenges on connect and refuses any
// REQ it did not see a matching AUTH for. This one is the red on the base tree
// (no AUTH is ever sent) and the green once the pool answers. Its stub also
// checks the signature names this account.
function makeRelayStub() {
  const sockets = [];
  class RelaySocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.authed = false;
      this.closed = false;
      sockets.push(this);
      setTimeout(() => {
        if (this.onopen) this.onopen();
        this.emit(['AUTH', 'challenge-test']);
      }, 0);
    }
    addEventListener() {}
    removeEventListener() {}
    send(raw) {
      const msg = JSON.parse(raw);
      this.sent.push(msg);
      if (msg[0] === 'AUTH' && msg[1]?.kind === 22242 && msg[1]?.pubkey === PK) {
        this.authed = true;
        this.emit(['OK', msg[1].id, true, '']);
        return;
      }
      if (msg[0] === 'REQ') {
        const subId = msg[1];
        if (!this.authed) {
          this.emit(['CLOSED', subId, 'auth-required: relay mismatch']);
          return;
        }
        // Signed for real: the pool verifies every event it hands back, so a
        // fake signature would be dropped and the test would pass for the
        // wrong reason.
        this.emit(['EVENT', subId, finalizeEvent({ kind: 39000, created_at: 1700000000, tags: [['d', 'room']], content: '' }, SK)]);
        this.emit(['EOSE', subId]);
        return;
      }
      if (msg[0] === 'CLOSE') return;
    }
    close() { this.closed = true; }
    emit(data) {
      if (this.closed) return;
      if (this.onmessage) this.onmessage({ data: JSON.stringify(data) });
    }
  }
  RelaySocket.prototype.onopen = null;
  RelaySocket.prototype.onmessage = null;
  RelaySocket.prototype.onclose = null;
  RelaySocket.prototype.onerror = null;
  return { RelaySocket, sockets };
}

test('a challenged read through the account pool is answered with a signed AUTH', async () => {
  const { RelaySocket, sockets } = makeRelayStub();
  globalThis.WebSocket = RelaySocket;

  const { getAuthenticatedPool, clearPool } = await import('./pool.js');
  const identity = { pk: PK, sk: SK };
  const pool = await getAuthenticatedPool(identity);

  assert.equal(pool.automaticallyAuth, pool.automaticallyAuth, 'sanity');
  try {
    const events = await pool.querySync([GROUP_RELAY], { kinds: [39000], limit: 1 });
    assert.equal(sockets.length, 1, 'the relay was dialled once');
    const authFrame = sockets[0].sent.find((m) => m[0] === 'AUTH');
    assert.ok(authFrame, 'the pool answered the AUTH challenge');
    assert.equal(authFrame[1].kind, 22242);
    assert.equal(authFrame[1].pubkey, PK);
    assert.equal(events.length, 1, 'the read returned the event the relay gates behind AUTH');
  } finally {
    clearPool();
    delete globalThis.WebSocket;
  }
});
