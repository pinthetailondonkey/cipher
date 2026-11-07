// Durable transaction boundary for the isolated OpenMLS prototype. A state
// snapshot is tentative until its matching protocol event or inbox journal
// commits in the same IndexedDB transaction. This does not wire MLS into live
// group traffic.
import { db, currentOwner } from '../db.js';
import { outboxRow } from './outbox.js';
import { openRatchetState, sealRatchetState } from './ratchetStateAtRest.js';

export class MlsStateConflict extends Error {
  constructor(groupId) {
    super(`MLS group state changed while processing ${groupId}.`);
    this.name = 'MlsStateConflict';
  }
}

function assertOwner(owner) {
  if (!owner || currentOwner() !== owner) {
    throw new Error('The unlocked account database changed before MLS state could be committed.');
  }
}

async function rowVersion(groupId) {
  return (await db.mlsGroups.get(groupId))?.version ?? null;
}

function assertVersion(actual, expected, groupId) {
  if (actual !== expected) throw new MlsStateConflict(groupId);
}

function nextVersion(expected) {
  return expected === null ? 0 : expected + 1;
}

async function seal(owner, groupId, state) {
  return sealRatchetState({ owner, collection: 'mls-groups', id: groupId, value: state });
}

export async function loadMlsState(owner, groupId) {
  assertOwner(owner);
  const row = await db.mlsGroups.get(groupId);
  if (!row) return null;
  return {
    version: row.version,
    value: await openRatchetState({ owner, collection: 'mls-groups', id: groupId, sealed: row.sealed }),
  };
}

// The OpenMLS snapshot must include every storage-provider value needed to
// restore the group. The immutable commit is put in the ordinary outbox in
// the same transaction; a retry republishes that exact event without another
// MLS state transition.
export async function commitMlsOutbound({
  owner, groupId, expectedVersion, state, event, relays = null, now = Date.now(),
}) {
  assertOwner(owner);
  if (!groupId || !event?.id || !event?.sig) throw new Error('An MLS commit event and group id are required.');
  const sealed = await seal(owner, groupId, state);
  const version = nextVersion(expectedVersion);
  await db.transaction('rw', 'mlsGroups', 'outbox', async () => {
    assertOwner(owner);
    assertVersion(await rowVersion(groupId), expectedVersion, groupId);
    if (await db.outbox.get(event.id)) throw new Error('This MLS event is already durable; retry the existing outbox row.');
    await db.mlsGroups.put({ groupId, version, updatedAt: now, sealed });
    await db.outbox.put(outboxRow(event, now, relays));
  });
  return version;
}

// Persist an accepted MLS transition and a sealed, idempotent journal together.
// A welcome acceptance uses the same boundary: the snapshot includes the
// consumed key package and new group, so a failed transaction consumes neither.
export async function commitMlsInbound({
  owner, groupId, expectedVersion, state, eventId, journal, now = Date.now(),
}) {
  assertOwner(owner);
  if (!groupId || !eventId) throw new Error('An MLS inbound transition needs stable group and event identity.');
  const [sealedState, sealedJournal] = await Promise.all([
    seal(owner, groupId, state),
    sealRatchetState({ owner, collection: 'mls-inbox', id: eventId, value: journal }),
  ]);
  const version = nextVersion(expectedVersion);
  let duplicate = false;
  await db.transaction('rw', 'mlsGroups', 'mlsInbox', async () => {
    assertOwner(owner);
    assertVersion(await rowVersion(groupId), expectedVersion, groupId);
    if (await db.mlsInbox.get(eventId)) {
      duplicate = true;
      return;
    }
    await db.mlsGroups.put({ groupId, version, updatedAt: now, sealed: sealedState });
    await db.mlsInbox.put({
      eventId, groupId, status: 'pending', receivedAt: now, sealed: sealedJournal,
    });
  });
  return { version: duplicate ? expectedVersion : version, duplicate };
}

export async function loadPendingMlsInbox(owner) {
  assertOwner(owner);
  const rows = await db.mlsInbox.where('status').equals('pending').sortBy('receivedAt');
  return Promise.all(rows.map(async (row) => ({
    ...row,
    journal: await openRatchetState({ owner, collection: 'mls-inbox', id: row.eventId, sealed: row.sealed }),
  })));
}

export async function markMlsInboxProcessed(owner, eventId) {
  assertOwner(owner);
  await db.transaction('rw', 'mlsInbox', async () => {
    assertOwner(owner);
    const row = await db.mlsInbox.get(eventId);
    if (row?.status === 'pending') {
      await db.mlsInbox.put({ ...row, status: 'processed', processedAt: Date.now() });
    }
  });
}
