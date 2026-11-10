import assert from 'node:assert/strict';
import test from 'node:test';
import { publishToRelay } from '../useIdentity.js';

test('identity profile publication does not send after its captured context expires while connecting', async () => {
  const originalWebSocket = globalThis.WebSocket;
  const sockets = [];
  class DelayedWebSocket {
    static OPEN = 1;
    readyState = 0;
    sent = [];
    constructor(url) { this.url = url; sockets.push(this); }
    send(value) { this.sent.push(value); }
    close() { this.readyState = 3; }
  }
  globalThis.WebSocket = DelayedWebSocket;
  let current = true;
  const owner = 'a'.repeat(64);
  const fence = { context: { owner }, assertCurrent() {
    if (!current) throw Object.assign(new Error('expired'), { code: 'SECURITY_CONTEXT_EXPIRED' });
  } };
  try {
    const publishing = publishToRelay('wss://relay.invalid', {
      id: 'event-id', pubkey: owner, kind: 0, created_at: 1, tags: [], content: '', sig: 'signature',
    }, new Uint8Array(32), 1000, fence);
    assert.equal(sockets.length, 1);
    current = false;
    sockets[0].readyState = DelayedWebSocket.OPEN;
    sockets[0].onopen();
    await assert.rejects(publishing, { code: 'SECURITY_CONTEXT_EXPIRED' });
    assert.deepEqual(sockets[0].sent, []);
    assert.equal(sockets[0].readyState, 3);
    await assert.rejects(publishToRelay('wss://relay.invalid', {
      id: 'event-id', pubkey: owner, kind: 0, created_at: 1, tags: [], content: '', sig: 'signature',
    }, new Uint8Array(32)), /account security context/);
    assert.equal(sockets.length, 1);
  } finally {
    globalThis.WebSocket = originalWebSocket;
  }
});
