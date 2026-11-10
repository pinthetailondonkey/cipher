import test from 'node:test';
import assert from 'node:assert/strict';
import { publishRatchetEventAtProofBoundary, RatchetDeliveryHeld } from './ratchetProofAwareTransport.js';

const wait = () => new Promise((resolve) => setImmediate(resolve));

class LocalRelaySocket {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.sent = [];
    this.closed = false;
    LocalRelaySocket.instances.push(this);
  }

  send(raw) {
    if (this.closed) throw new Error('socket closed');
    this.sent.push(JSON.parse(raw));
  }

  open() { this.onopen?.(); }
  receive(frame) { this.onmessage?.({ data: JSON.stringify(frame) }); }
  close() { this.closed = true; this.onclose?.({}); }
}

function setup({ clock = { value: 10_000 }, freshUntil = 20, assertCurrent = () => {} } = {}) {
  LocalRelaySocket.instances = [];
  const event = {
    id: 'event-id', sig: 'signed', kind: 1059, content: JSON.stringify({
      operationId: 'operation-id', operationDigest: 'immutable-digest', ciphertext: 'ratchet-ciphertext',
    }),
  };
  const promise = publishRatchetEventAtProofBoundary({
    url: 'ws://127.0.0.1:19001', event, freshUntil,
    assertCurrent, WebSocketImpl: LocalRelaySocket,
    now: () => clock.value, timeoutMs: 500,
  });
  return { event, promise, clock, socket: () => LocalRelaySocket.instances[0] };
}

test('proof expires while connecting: no EVENT reaches the local relay socket', async () => {
  const { promise, clock, socket } = setup();
  clock.value = 20_000;
  socket().open();
  await assert.rejects(promise, RatchetDeliveryHeld);
  assert.deepEqual(socket().sent, []);
});

test('proof expires during asynchronous AUTH signing: no AUTH or second EVENT is sent', async () => {
  LocalRelaySocket.instances = [];
  const clock = { value: 10_000 };
  let resolveSigner;
  const event = { id: 'event-id', sig: 'signed', kind: 1059, content: 'immutable-operation' };
  const pending = publishRatchetEventAtProofBoundary({
    url: 'ws://127.0.0.1:19001', event, freshUntil: 20,
    WebSocketImpl: LocalRelaySocket, now: () => clock.value, timeoutMs: 500,
    createAuthEvent: () => new Promise((resolve) => { resolveSigner = resolve; }),
  });
  const local = LocalRelaySocket.instances[0];
  local.open();
  local.receive(['AUTH', 'local-challenge']);
  await wait();
  clock.value = 20_000;
  resolveSigner({ id: 'auth-id', sig: 'signed-auth' });
  await assert.rejects(pending, RatchetDeliveryHeld);
  assert.deepEqual(local.sent.map((frame) => frame[0]), ['EVENT']);
});

test('proof expires after AUTH acknowledgement and before event resend', async () => {
  const clock = { value: 10_000 };
  LocalRelaySocket.instances = [];
  const pending = publishRatchetEventAtProofBoundary({
    url: 'ws://127.0.0.1:19001', event: { id: 'event-id', sig: 'signed' },
    freshUntil: 20, WebSocketImpl: LocalRelaySocket, now: () => clock.value,
    createAuthEvent: async () => ({ id: 'auth-id', sig: 'signed-auth' }), timeoutMs: 500,
  });
  const local = LocalRelaySocket.instances[0];
  local.open();
  local.receive(['AUTH', 'local-challenge']);
  await wait();
  assert.deepEqual(local.sent.map((frame) => frame[0]), ['EVENT', 'AUTH']);
  clock.value = 20_000;
  local.receive(['OK', 'auth-id', true, '']);
  await assert.rejects(pending, RatchetDeliveryHeld);
  assert.deepEqual(local.sent.map((frame) => frame[0]), ['EVENT', 'AUTH']);
});

test('NIP-42 auth-required refusal is held until challenge auth then resends exact event', async () => {
  LocalRelaySocket.instances = [];
  const event = { id: 'event-id', sig: 'signed', content: 'same-immutable-event' };
  const pending = publishRatchetEventAtProofBoundary({
    url: 'ws://127.0.0.1:19001', event, freshUntil: 20,
    WebSocketImpl: LocalRelaySocket, now: () => 10_000, timeoutMs: 500,
    createAuthEvent: async () => ({ id: 'auth-id', sig: 'signed-auth' }),
  });
  const local = LocalRelaySocket.instances[0];
  local.open();
  local.receive(['OK', event.id, false, 'auth-required: login']);
  local.receive(['AUTH', 'local-challenge']);
  await wait();
  local.receive(['OK', 'auth-id', true, 'authenticated']);
  assert.deepEqual(local.sent.map((frame) => frame[0]), ['EVENT', 'AUTH', 'EVENT']);
  assert.deepEqual(local.sent[0], local.sent[2]);
  local.receive(['OK', event.id, true, 'saved']);
  assert.equal((await pending).accepted, true);
});

test('valid proof is checked at handoff and relay acknowledgement resolves the attempt', async () => {
  const { promise, event, socket } = setup();
  socket().open();
  assert.deepEqual(socket().sent, [['EVENT', event]]);
  socket().receive(['OK', event.id, true, 'saved']);
  assert.deepEqual(await promise, { accepted: true, eventId: event.id });
});

test('lost acknowledgement retry uses the exact committed event and operation bytes', async () => {
  const clock = { value: 10_000 };
  const first = setup({ clock });
  first.socket().open();
  first.socket().close();
  await assert.rejects(first.promise, /closed before acknowledgement/);

  const retry = setup({ clock });
  retry.socket().open();
  assert.deepEqual(retry.socket().sent[0], ['EVENT', first.event]);
  retry.socket().receive(['OK', first.event.id, true, 'saved']);
  await retry.promise;
  assert.equal(retry.event.content, first.event.content);
  assert.match(retry.event.content, /immutable-digest/);
});

test('stale account fence holds publication before socket handoff', async () => {
  let current = true;
  const { promise, socket } = setup({ assertCurrent() { if (!current) throw new Error('stale account context'); } });
  current = false;
  socket().open();
  await assert.rejects(promise, /stale account context/);
  assert.deepEqual(socket().sent, []);
});
