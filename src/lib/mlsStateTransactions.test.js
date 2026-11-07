import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { db, openDBFor } from '../db.js';
import { setAtRestKeyProvider } from './messageAtRest.js';
import {
  commitMlsInbound,
  commitMlsOutbound,
  loadMlsState,
  loadPendingMlsInbox,
  markMlsInboxProcessed,
  MlsStateConflict,
} from './mlsStateTransactions.js';

const owner = `mls-transaction-test-${Date.now()}`;
const VAULT_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 33);
globalThis.localStorage = {
  values: new Map(),
  getItem(key) { return this.values.get(key) ?? null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); },
};
setAtRestKeyProvider(() => VAULT_KEY);
openDBFor(owner);

test('MLS state and immutable outbound commit enter IndexedDB atomically', async () => {
  await db.open();
  const event = { id: 'mls-out-1', sig: 'signed', kind: 9, created_at: 10 };
  assert.equal(await commitMlsOutbound({
    owner, groupId: 'group-a', expectedVersion: null,
    state: { providerSnapshot: 'private MLS storage' }, event, now: 100,
  }), 0);
  assert.equal((await db.outbox.get(event.id)).event.id, event.id);
  assert.equal(JSON.stringify(await db.mlsGroups.get('group-a')).includes('private MLS storage'), false);
  assert.deepEqual(await loadMlsState(owner, 'group-a'), {
    version: 0,
    value: { providerSnapshot: 'private MLS storage' },
  });
  await assert.rejects(commitMlsOutbound({
    owner, groupId: 'group-a', expectedVersion: null,
    state: { providerSnapshot: 'stale' }, event: { id: 'mls-out-stale', sig: 'signed' },
  }), MlsStateConflict);
  assert.equal(await db.outbox.get('mls-out-stale'), undefined);
});

test('outbox failure leaves the old MLS epoch and state untouched', async () => {
  const before = await loadMlsState(owner, 'group-a');
  const originalPut = db.outbox.put;
  db.outbox.put = async () => { throw new Error('simulated outbox storage failure'); };
  try {
    await assert.rejects(commitMlsOutbound({
      owner, groupId: 'group-a', expectedVersion: 0,
      state: { providerSnapshot: 'uncommitted next epoch' },
      event: { id: 'mls-out-failed', sig: 'signed' },
    }), /simulated outbox storage failure/);
  } finally {
    db.outbox.put = originalPut;
  }
  assert.deepEqual(await loadMlsState(owner, 'group-a'), before);
  assert.equal(await db.outbox.get('mls-out-failed'), undefined);
});

test('MLS receive advances state only with a sealed idempotent journal and resumes after restart', async () => {
  const outcome = await commitMlsInbound({
    owner, groupId: 'group-a', expectedVersion: 0,
    state: { providerSnapshot: 'accepted remote commit' },
    eventId: 'mls-in-1', journal: { event: { id: 'mls-in-1' }, plaintext: 'private text' }, now: 300,
  });
  assert.deepEqual(outcome, { version: 1, duplicate: false });
  const [rawState, rawInbox] = await Promise.all([
    db.mlsGroups.get('group-a'), db.mlsInbox.get('mls-in-1'),
  ]);
  assert.equal(JSON.stringify(rawState).includes('accepted remote commit'), false);
  assert.equal(JSON.stringify(rawInbox).includes('private text'), false);
  assert.deepEqual((await loadPendingMlsInbox(owner))[0].journal.plaintext, 'private text');
  const duplicate = await commitMlsInbound({
    owner, groupId: 'group-a', expectedVersion: 1,
    state: { providerSnapshot: 'must not apply twice' },
    eventId: 'mls-in-1', journal: { duplicate: true }, now: 301,
  });
  assert.deepEqual(duplicate, { version: 1, duplicate: true });
  assert.deepEqual((await loadMlsState(owner, 'group-a')).value, { providerSnapshot: 'accepted remote commit' });
  await markMlsInboxProcessed(owner, 'mls-in-1');
  assert.equal((await loadPendingMlsInbox(owner)).length, 0);
});
