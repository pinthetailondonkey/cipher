// Atomic persistence boundary for the DM Double Ratchet. The library's state
// is treated as a tentative clone until the matching ciphertext/journal is
// committed. Callers must discard the mutated WASM object if a CAS fails.
import { db, currentOwner } from '../db.js';
import { outboxRow } from './outbox.js';
import { openRatchetState, sealRatchetState } from './ratchetStateAtRest.js';

export class RatchetStateConflict extends Error {
  constructor(collection, id) {
    super(`Ratchet state changed while processing ${collection}:${id}.`);
    this.name = 'RatchetStateConflict';
  }
}

function assertOwner(owner) {
  if (!owner || currentOwner() !== owner) {
    throw new Error('The unlocked account database changed before ratchet state could be committed.');
  }
}

async function currentVersion(table, id) {
  return (await table.get(id))?.version ?? null;
}

function assertVersion(actual, expected, collection, id) {
  if (actual !== expected) throw new RatchetStateConflict(collection, id);
}

function nextVersion(expected) {
  return expected === null ? 0 : expected + 1;
}

export async function loadRatchetState({ owner, collection, id, table }) {
  assertOwner(owner);
  const row = await table.get(id);
  if (!row) return null;
  const value = await openRatchetState({ owner, collection, id, sealed: row.sealed });
  return { version: row.version, value };
}

// Used when publishing a device identity/prekey bundle. Keeping the account
// pickle and signed bundle in one transaction prevents a published key from
// becoming orphaned if local state storage fails.
export async function commitRatchetDevicePublication({
  owner, deviceId, expectedVersion, state, event, relays = null, now = Date.now(),
}) {
  assertOwner(owner);
  if (!event?.id || !event?.sig) throw new Error('A signed prekey publication event is required.');
  const sealed = await sealRatchetState({
    owner, collection: 'devices', id: deviceId, value: state,
  });
  const version = nextVersion(expectedVersion);
  await db.transaction('rw', 'ratchetDevices', 'outbox', async () => {
    assertOwner(owner);
    assertVersion(await currentVersion(db.ratchetDevices, deviceId), expectedVersion, 'devices', deviceId);
    await db.ratchetDevices.put({ deviceId, version, updatedAt: now, sealed });
    await db.outbox.put(outboxRow(event, now, relays));
  });
  return version;
}

export async function commitRatchetOutbound({
  owner, sessionId, peerPubkey, peerDeviceId, expectedVersion, state,
  event, relays = null, now = Date.now(),
}) {
  assertOwner(owner);
  if (!event?.id || !event?.sig) throw new Error('A signed ratchet message is required.');
  const sealed = await sealRatchetState({
    owner, collection: 'sessions', id: sessionId, value: state,
  });
  const version = nextVersion(expectedVersion);
  await db.transaction('rw', 'ratchetSessions', 'outbox', async () => {
    assertOwner(owner);
    assertVersion(await currentVersion(db.ratchetSessions, sessionId), expectedVersion, 'sessions', sessionId);
    await db.ratchetSessions.put({
      sessionId, peerPubkey, peerDeviceId, version, updatedAt: now, sealed,
    });
    await db.outbox.put(outboxRow(event, now, relays));
  });
  return version;
}

// First inbound prekey message consumes a device one-time key. Commit that
// account mutation, its new session and an encrypted recovery journal
// together. A failed transaction leaves the saved OTK and session untouched.
export async function commitRatchetInitialInbound({
  owner, deviceId, expectedDeviceVersion, deviceState,
  sessionId, peerPubkey, peerDeviceId, sessionState,
  eventId, chatId, journal, now = Date.now(),
}) {
  assertOwner(owner);
  if (!eventId || !chatId) throw new Error('An inbound ratchet event needs stable identity and routing.');
  const [sealedDevice, sealedSession, sealedJournal] = await Promise.all([
    sealRatchetState({ owner, collection: 'devices', id: deviceId, value: deviceState }),
    sealRatchetState({ owner, collection: 'sessions', id: sessionId, value: sessionState }),
    sealRatchetState({ owner, collection: 'inbox', id: eventId, value: journal }),
  ]);
  const deviceVersion = nextVersion(expectedDeviceVersion);
  await db.transaction('rw', 'ratchetDevices', 'ratchetSessions', 'ratchetInbox', async () => {
    assertOwner(owner);
    assertVersion(await currentVersion(db.ratchetDevices, deviceId), expectedDeviceVersion, 'devices', deviceId);
    if (await db.ratchetInbox.get(eventId)) return;
    await db.ratchetDevices.put({ deviceId, version: deviceVersion, updatedAt: now, sealed: sealedDevice });
    await db.ratchetSessions.put({
      sessionId, peerPubkey, peerDeviceId, version: 0, updatedAt: now, sealed: sealedSession,
    });
    await db.ratchetInbox.put({
      eventId, chatId, status: 'pending', receivedAt: now, sealed: sealedJournal,
    });
  });
  return deviceVersion;
}

export async function commitRatchetInbound({
  owner, sessionId, expectedVersion, sessionState, eventId, chatId,
  journal, now = Date.now(),
}) {
  assertOwner(owner);
  if (!eventId || !chatId) throw new Error('An inbound ratchet event needs stable identity and routing.');
  const [sealedSession, sealedJournal] = await Promise.all([
    sealRatchetState({ owner, collection: 'sessions', id: sessionId, value: sessionState }),
    sealRatchetState({ owner, collection: 'inbox', id: eventId, value: journal }),
  ]);
  const version = nextVersion(expectedVersion);
  await db.transaction('rw', 'ratchetSessions', 'ratchetInbox', async () => {
    assertOwner(owner);
    assertVersion(await currentVersion(db.ratchetSessions, sessionId), expectedVersion, 'sessions', sessionId);
    if (await db.ratchetInbox.get(eventId)) return;
    const existing = await db.ratchetSessions.get(sessionId);
    await db.ratchetSessions.put({
      ...existing, sessionId, version, updatedAt: now, sealed: sealedSession,
    });
    await db.ratchetInbox.put({
      eventId, chatId, status: 'pending', receivedAt: now, sealed: sealedJournal,
    });
  });
  return version;
}

export async function loadPendingRatchetInbox(owner) {
  assertOwner(owner);
  const rows = await db.ratchetInbox.where('status').equals('pending').sortBy('receivedAt');
  return Promise.all(rows.map(async (row) => ({
    ...row,
    journal: await openRatchetState({
      owner, collection: 'inbox', id: row.eventId, sealed: row.sealed,
    }),
  })));
}

export async function markRatchetInboxProcessed(owner, eventId) {
  assertOwner(owner);
  await db.transaction('rw', 'ratchetInbox', async () => {
    assertOwner(owner);
    const row = await db.ratchetInbox.get(eventId);
    if (row?.status === 'pending') {
      await db.ratchetInbox.put({ ...row, status: 'processed', processedAt: Date.now() });
    }
  });
}
