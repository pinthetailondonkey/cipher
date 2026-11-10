// Colocated focused test for src/lib/protocolTestDm/testPublisher.js
// (TEST-PATH-ONLY). Proves: empty default allowlist, kind/route-tag refusals,
// AUTH -> freshness recheck -> fence -> exact-bytes send order with a scripted
// fake socket adapter, and identical-byte retry.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PUBLISHER_CONSTANTS,
  buildNip42AuthEvent,
  createTestPublisher,
} from './testPublisher.js';

const T0 = 1760000000;
const goodGateInputs = () => ({
  checkpointAuthenticated: true,
  pinnedHeadCreatedAtSeconds: T0,
  nowSeconds: T0,
  targetKnownAtHead: true,
  targetDeviceActive: true,
});

// Route tag must be >=32 chars and NOT match the 64-hex account key pattern.
const ROUTE_TAG_PREFIXED = 'route:v1:abcdef0123456789abcdef0123456789ff';
const ACCOUNT_KEY_64HEX = 'a'.repeat(64);

function makeWrapEvent(idSuffix, pTag) {
  return {
    id: `w${idSuffix}`,
    kind: PUBLISHER_CONSTANTS.WRAP_KIND,
    tags: [['p', pTag]],
    content: 'ciphertext',
    pubkey: 'f'.repeat(64),
    created_at: T0,
    sig: 's',
  };
}

// Scripted fake connection: plays relay frames in order; records client sends.
function scriptedConnection(frames) {
  const sent = [];
  const queue = [...frames];
  return async () => ({
    sent,
    socket: { send(text) { sent.push(text); } },
    nextFrame: async (predicate, timeoutMs = 2000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const frame = queue.shift();
        if (frame !== undefined && predicate(frame)) return frame;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error('fake relay: no matching frame');
    },
    close: async () => {},
  });
}

function basePublisherOptions() {
  return {
    allowedRelayUrls: ['ws://127.0.0.1:1/test-relay'],
    buildAuthEvent: ({ relayUrl, challenge }) =>
      buildNip42AuthEvent({
        routeSecretKeyHex: '11'.repeat(32), relayUrl, challenge,
      }),
    securityFenceCheck: async () => true,
    sendGateInputs: goodGateInputs,
    clockMs: () => T0 * 1000,
  };
}

test('default deny list: publisher created without allowlisted relays refuses everything', async () => {
  const connectCalls = [];
  const publisher = createTestPublisher({
    ...basePublisherOptions(), allowedRelayUrls: [],
    connectSocket: async (u) => { connectCalls.push(u); return scriptedConnection([])(u); },
  });
  assert.equal(publisher.canUseRelay('ws://127.0.0.1:1/test-relay'), false);
  const result = await publisher.publish({ relayUrl: 'ws://127.0.0.1:1/test-relay', row: {} });
  assert.equal(result.published, false);
  assert.match(result.reason, /relay-not-allowlisted/);
  assert.equal(connectCalls.length, 0, 'no socket may be opened to a non-allowlisted relay');
});

test('refuses rows whose outer kind is not the profile wrap kind', async () => {
  const publisher = createTestPublisher({ ...basePublisherOptions(), connectSocket: scriptedConnection([]) });
  const badKind = { parsedEvent: { ...makeWrapEvent('x', ROUTE_TAG_PREFIXED), kind: 4 }, bytes: '{}' };
  const verdict = await publisher.publish({ relayUrl: 'ws://127.0.0.1:1/test-relay', row: badKind });
  assert.match(verdict.reason, /publisher-refused-kind-4/);
});

for (const [label, tag, expected] of [
  ['64-hex account pubkey as route tag is refused', ACCOUNT_KEY_64HEX, 'publisher-account-key-pattern-as-route-tag'],
  ['route tag too short is refused', 'short', 'publisher-route-tag-too-short'],
]) {
  test(`row validation: ${label}`, async () => {
    const publisher = createTestPublisher({ ...basePublisherOptions(), connectSocket: scriptedConnection([]) });
    const row = { parsedEvent: makeWrapEvent('y', tag), bytes: '{}' };
    const verdict = await publisher.publish({ relayUrl: 'ws://127.0.0.1:1/test-relay', row });
    assert.equal(verdict.reason, expected);
    assert.equal(verdict.published, false);
  });
}

test('full send order over AUTH: recheck gate -> fence -> EXACT bytes on socket', async () => {
  const order = [];
  let eventBytesSeenOnSocket = null;
  const connectAdapter = async () => {
    const conn = await scriptedConnection([
      '["AUTH","challenge-value-123"]',
      '["OK","wx",true,"authenticated"]',
      '["OK","wx",true,"saved"]',
    ])();
    const originalSend = conn.socket.send.bind(conn.socket);
    conn.socket.send = (text) => {
      order.push(text.startsWith('["AUTH"') ? 'AUTH' : 'EVENT');
      if (text.startsWith('["EVENT"')) eventBytesSeenOnSocket = text;
      originalSend(text);
    };
    return conn;
  };
  const fenceTracker = [];
  const publisher = createTestPublisher({
    ...basePublisherOptions(),
    securityFenceCheck: async () => { fenceTracker.push(Date.now()); return true; },
    connectSocket: connectAdapter,
  });
  const wrapEvent = makeWrapEvent('x', ROUTE_TAG_PREFIXED);
  const exactBytes = JSON.stringify(['EVENT', wrapEvent]);
  const result = await publisher.publish({
    relayUrl: 'ws://127.0.0.1:1/test-relay',
    row: { parsedEvent: wrapEvent, bytes: exactBytes },
  });
  assert.deepEqual(
    { published: result.published, reason: result.reason ?? null },
    { published: true, reason: null },
  );
  assert.equal(eventBytesSeenOnSocket, exactBytes, 'the socket carried EXACT pre-built bytes');
  assert.deepEqual(order, ['AUTH', 'EVENT']);
  assert.ok(publisher.captures.some((capture) => capture.direction === 'auth-result' && capture.ok === true));
  assert.ok(publisher.captures.some((capture) => capture.direction === 'event-ack'));
});

test('freshness rejected at post-AUTH recheck publishes nothing', async () => {
  let sendsAfterRecheck = 0;
  const connectAdapter = async () => {
    const conn = await scriptedConnection([
      '["AUTH","challenge-abc"]',
      '["OK","wz",true,"authenticated"]',
    ])();
    const originalSend = conn.socket.send.bind(conn.socket);
    conn.socket.send = (text) => { if (text.startsWith('["EVENT"')) sendsAfterRecheck += 1; originalSend(text); };
    return conn;
  };
  const publisher = createTestPublisher({
    ...basePublisherOptions(),
    // Gate goes stale between AUTH and EVENT (head ages out).
    sendGateInputs: () => ({ ...goodGateInputs(), nowSeconds: T0 + 86400 + 5 }),
    connectSocket: connectAdapter,
  });
  const wrapEvent = makeWrapEvent('z', ROUTE_TAG_PREFIXED);
  const result = await publisher.publish({
    relayUrl: 'ws://127.0.0.1:1/test-relay',
    row: { parsedEvent: wrapEvent, bytes: JSON.stringify(['EVENT', wrapEvent]) },
  });
  assert.equal(result.published, false);
  assert.match(result.reason, /freshness.*stale-pinned-registry-head/);
  assert.equal(sendsAfterRecheck, 0, 'no EVENT after expiry');
});

test('fence invalidated blocks the socket send', async () => {
  const publisher = createTestPublisher({
    ...basePublisherOptions(),
    securityFenceCheck: async () => false,
    connectSocket: scriptedConnection([
      '["AUTH","challenge-f"]',
      '["OK","wf",true,"authenticated"]',
    ]),
  });
  const wrapEvent = makeWrapEvent('f', ROUTE_TAG_PREFIXED);
  const result = await publisher.publish({
    relayUrl: 'ws://127.0.0.1:1/test-relay',
    row: { parsedEvent: wrapEvent, bytes: JSON.stringify(['EVENT', wrapEvent]) },
  });
  assert.equal(result.reason, 'security-fence-invalidated');
});

test('retry resends IDENTICAL bytes and never rebuilds the payload', async () => {
  const attempts = [];
  const makeConnect = () => async () => {
    const conn = await scriptedConnection([
      '["AUTH","challenge-r"]',
      '["OK","wr",true,"authenticated"]',
      '["OK","wr",true,"saved"]',
    ])();
    const originalSend = conn.socket.send.bind(conn.socket);
    conn.socket.send = (text) => { if (text.startsWith('["EVENT"')) attempts.push(text); originalSend(text); };
    return conn;
  };
  const publisher = createTestPublisher({
    ...basePublisherOptions(),
    connectSocket: makeConnect(),
  });
  const wrapEvent = makeWrapEvent('r', ROUTE_TAG_PREFIXED);
  const firstBytes = JSON.stringify(['EVENT', wrapEvent]);
  await publisher.retryIdenticalBytes({
    relayUrl: 'ws://127.0.0.1:1/test-relay',
    row: { parsedEvent: wrapEvent, firstAttemptBytes: firstBytes },
  });
  await publisher.retryIdenticalBytes({
    relayUrl: 'ws://127.0.0.1:1/test-relay',
    row: { parsedEvent: wrapEvent, firstAttemptBytes: firstBytes },
  });
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], firstBytes);
  assert.equal(attempts[1], firstBytes, 'byte-identical retry payload');
});

test('retry refuses when no original bytes are recorded', async () => {
  const publisher = createTestPublisher({ ...basePublisherOptions(), connectSocket: scriptedConnection([]) });
  const result = await publisher.retryIdenticalBytes({
    relayUrl: 'ws://127.0.0.1:1/test-relay', row: {},
  });
  assert.equal(result.reason, 'retry-missing-original-bytes');
});
