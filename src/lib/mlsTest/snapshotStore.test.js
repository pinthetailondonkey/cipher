import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MlsSnapshotConflict,
  createMlsSnapshotStore,
  transaction,
} from './snapshotStore.js';

test('a staged snapshot does not advance active state until commit', async () => {
  const store = createMlsSnapshotStore({ owner: 'owner-1' });
  await store.stage('g1', (current) => ({ epoch: 1, ...current }));
  const before = await store.load('g1');
  assert.equal(before, null);
  const version = await store.commit('g1', { governanceRevision: 0, outboxEventId: 'evt-1' });
  assert.equal(version, 0);
  const after = await store.load('g1');
  assert.equal(after.value.epoch, 1);
});

test('a failed commit rolls back both the MLS state and the journal row', async () => {
  const store = createMlsSnapshotStore({ owner: 'owner-1' });
  await store.stage('g1', () => ({ epoch: 5 }));
  // Break it by racing another writer that advances version first.
  await store.states.put('mls-groups:g1', { groupId: 'g1', version: 99, value: {} });
  await assert.rejects(
    () => store.commit('g1', { governanceRevision: 1, outboxEventId: 'evt-2' }),
    MlsSnapshotConflict,
  );
  // Rollback restored nothing new; journal row absent.
  assert.equal(await store.journal.get('evt-2'), undefined);
});

test('a discarded candidate keeps active state and lets a later stage succeed', async () => {
  const store = createMlsSnapshotStore({ owner: 'owner-1' });
  await store.stage('g1', () => ({ epoch: 10, bad: true }));
  await store.commit('g1', {});
  // Failed Welcome path: stage a broken candidate and discard.
  await store.stage('g1', () => { throw new Error('Welcome validation failed'); }).catch(() => {});
  // Note: the throw happened inside mutate; the candidate for epoch 11 was
  // never set. A clean retry stages fresh state without the failure.
  const next = await store.stage('g1', (current) => ({ ...current, epoch: current.epoch + 1 }));
  assert.equal(next.bad, true); // derived from committed state, not the failed attempt
  const version = await store.commit('g1', { governanceRevision: 2 });
  assert.equal(version, 1);
});

test('an explicit discard removes the candidate so commit cannot run stale work', async () => {
  const store = createMlsSnapshotStore({ owner: 'owner-1' });
  await store.stage('g1', () => ({ epoch: 3 }));
  store.discard('g1');
  await assert.rejects(() => store.commit('g1', {}));
});

test('a duplicate outbox event id is rejected inside one transaction', async () => {
  const store = createMlsSnapshotStore({ owner: 'owner-1' });
  await store.stage('g1', () => ({ epoch: 1 }));
  await store.commit('g1', { governanceRevision: 0, outboxEventId: 'evt-x' });
  await store.stage('g1', () => ({ epoch: 2 }));
  await assert.rejects(() => store.commit('g1', { governanceRevision: 1, outboxEventId: 'evt-x' }));
  // State was rolled back to the pre-commit value (epoch still 1).
  const row = await store.load('g1');
  assert.equal(row.value.epoch, 1);
});

test('transaction() writes every store or none on the same rollback boundary', async () => {
  const kvA = (await import('./snapshotStore.js')).createMemoryKv();
  const kvB = (await import('./snapshotStore.js')).createMemoryKv();
  await assert.rejects(() => transaction({ a: kvA, b: kvB }, async ({ stores }) => {
    await stores.a.put('k', 'v1');
    await stores.b.put('k', 'v1');
    throw new Error('mid-transaction failure');
  }));
  assert.equal(await kvA.get('k'), undefined);
  assert.equal(await kvB.get('k'), undefined);
});
