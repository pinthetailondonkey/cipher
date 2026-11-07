import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { db, openDBFor } from '../db.js';
import { setAtRestKeyProvider } from './messageAtRest.js';
import {
  commitRatchetInitialInbound,
  commitRatchetOutbound,
  loadPendingRatchetInbox,
  loadRatchetState,
  markRatchetInboxProcessed,
  RatchetStateConflict,
} from './dmRatchetTransactions.js';

const owner = `ratchet-test-${Date.now()}`;
const VAULT_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 9);

globalThis.localStorage = {
  values: new Map(),
  getItem(key) { return this.values.get(key) ?? null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); },
};
setAtRestKeyProvider(() => VAULT_KEY);

test('outbound ratchet state and immutable Nostr event commit together with CAS', async () => {
  openDBFor(owner);
  await db.open();
  const event = { id: 'out-1', sig: 'signed', kind: 1059, created_at: 100 };
  const version = await commitRatchetOutbound({
    owner,
    sessionId: 'session-1',
    peerPubkey: 'peer',
    peerDeviceId: 'device-1',
    expectedVersion: null,
    state: { pickle: 'secret state' },
    event,
    now: 1000,
  });
  assert.equal(version, 0);
  assert.equal((await db.outbox.get('out-1')).event.id, 'out-1');
  const storedState = await db.ratchetSessions.get('session-1');
  assert.equal(JSON.stringify(storedState).includes('secret state'), false);
  assert.deepEqual(await loadRatchetState({
    owner, collection: 'sessions', id: 'session-1', table: db.ratchetSessions,
  }), { version: 0, value: { pickle: 'secret state' } });

  await assert.rejects(commitRatchetOutbound({
    owner,
    sessionId: 'session-1',
    peerPubkey: 'peer',
    peerDeviceId: 'device-1',
    expectedVersion: null,
    state: { pickle: 'stale state' },
    event: { id: 'out-2', sig: 'signed', kind: 1059 },
  }), RatchetStateConflict);
  assert.equal(await db.outbox.get('out-2'), undefined, 'a losing CAS never publishes a second event');
});

test('outbox failure rolls back the tentative ratchet state transition', async () => {
  const originalPut = db.outbox.put;
  db.outbox.put = async () => { throw new Error('simulated outbox write failure'); };
  try {
    await assert.rejects(commitRatchetOutbound({
      owner,
      sessionId: 'session-1',
      peerPubkey: 'peer',
      peerDeviceId: 'device-1',
      expectedVersion: 0,
      state: { pickle: 'must not commit' },
      event: { id: 'out-failed', sig: 'signed', kind: 1059 },
    }), /simulated outbox write failure/);
  } finally {
    db.outbox.put = originalPut;
  }
  const state = await loadRatchetState({
    owner, collection: 'sessions', id: 'session-1', table: db.ratchetSessions,
  });
  assert.deepEqual(state, { version: 0, value: { pickle: 'secret state' } });
  assert.equal(await db.outbox.get('out-failed'), undefined);
});

test('consumed prekey, new session and sealed inbox journal are one transaction', async () => {
  const eventId = 'incoming-1';
  await commitRatchetInitialInbound({
    owner,
    deviceId: 'local-device',
    expectedDeviceVersion: null,
    deviceState: { pickle: 'account after OTK consumption' },
    sessionId: 'session-in',
    peerPubkey: 'peer',
    peerDeviceId: 'device-peer',
    sessionState: { pickle: 'new session' },
    eventId,
    chatId: 'peer',
    journal: { event: { id: eventId }, payload: { message: 'private plaintext' } },
    now: 2000,
  });
  const [device, session, rawJournal] = await Promise.all([
    db.ratchetDevices.get('local-device'),
    db.ratchetSessions.get('session-in'),
    db.ratchetInbox.get(eventId),
  ]);
  assert.equal(JSON.stringify(device).includes('account after OTK'), false);
  assert.equal(JSON.stringify(session).includes('new session'), false);
  assert.equal(JSON.stringify(rawJournal).includes('private plaintext'), false);
  const pending = await loadPendingRatchetInbox(owner);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].journal.payload.message, 'private plaintext');
  await markRatchetInboxProcessed(owner, eventId);
  assert.equal((await loadPendingRatchetInbox(owner)).length, 0);
});
