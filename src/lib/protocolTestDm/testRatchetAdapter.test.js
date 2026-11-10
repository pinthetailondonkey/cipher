// Colocated focused test for src/lib/protocolTestDm/testRatchetAdapter.js
// (TEST-PATH-ONLY). Proves the Node wasm loader works and v2 sessions
// round-trip; v1 init rejection is receiver.js's job and tested there.
import assert from 'node:assert/strict';
import test from 'node:test';
import { TestRatchetAccount, loadRatchetWasm } from './testRatchetAdapter.js';

test('wasm ratchet loads in plain Node without a browser', async () => {
  const module = await loadRatchetWasm();
  assert.equal(typeof module.DeviceAccount, 'function');
});

test('v2 outbound/inbound prekey session round-trips, continued messages decrypt', async () => {
  const alice = await TestRatchetAccount.create();
  const bob = await TestRatchetAccount.create();
  const otks = bob.generateOneTimeKeys(2);
  assert.ok(Array.isArray(otks) && otks.length === 2);
  assert.equal(bob.storedOneTimeKeyCount(), 2);
  const session = alice.createOutboundSession(bob.identity().curve25519, otks[0]);
  const firstMessage = session.encrypt(JSON.stringify({ olmVersion: 2, opId: 'op-1', body: 'hello' }));
  const received = bob.acceptInitialMessage(alice.identity().curve25519, firstMessage);
  assert.equal(received.plaintext, JSON.stringify({ olmVersion: 2, opId: 'op-1', body: 'hello' }));
  assert.equal(typeof received.sessionId, 'string');
  // The consumed OTK leaves bob's store.
  assert.equal(bob.storedOneTimeKeyCount(), 1);
  // Ratchet continues both ways.
  const secondMessage = session.encrypt('second');
  assert.equal(received.session.decrypt(secondMessage), 'second');
});
