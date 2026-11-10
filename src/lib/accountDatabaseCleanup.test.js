import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { accountDatabaseNames, deleteAccountDatabase } from '../db.js';

function openDatabase(name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('test');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function createDatabase(name) {
  (await openDatabase(name)).close();
}

function listDatabases() {
  return indexedDB.databases().then((rows) => rows.map(({ name }) => name));
}

test('account removal deletes the main, primary-authority, and policy-pin databases', async () => {
  const owner = 'a'.repeat(64);
  const names = accountDatabaseNames(owner);
  const unrelatedPeerDatabase = `CipherAuthorityPeerV2_${'b'.repeat(24)}`;
  await Promise.all([...names, unrelatedPeerDatabase].map(createDatabase));

  const result = await deleteAccountDatabase(owner);
  assert.deepEqual(result, { success: true, deleted: names, failures: [] });
  const remaining = await listDatabases();
  assert.equal(names.some((name) => remaining.includes(name)), false);
  assert.equal(remaining.includes(unrelatedPeerDatabase), true,
    'a peer checkpoint with no local-owner provenance is not deleted as if it belonged to this account');
  await new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(unrelatedPeerDatabase);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
});

test('an invalid owner cannot produce an account database deletion inventory', () => {
  assert.throws(() => accountDatabaseNames('not-an-account'), /valid account identity/);
  assert.throws(() => deleteAccountDatabase('not-an-account'), /valid account identity/);
});

test('a blocked authority database is reported while other owner databases are still deleted', async () => {
  const owner = 'c'.repeat(64);
  const names = accountDatabaseNames(owner);
  const held = await openDatabase(names[1]);
  await Promise.all([createDatabase(names[0]), createDatabase(names[2])]);
  try {
    const result = await deleteAccountDatabase(owner);
    assert.equal(result.success, false);
    assert.deepEqual(result.deleted, [names[0], names[2]]);
    assert.deepEqual(result.failures, [{ name: names[1], status: 'blocked' }]);
  } finally {
    held.close();
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal((await listDatabases()).includes(names[1]), false,
    'the browser may finish the request after its blocker closes, but the returned result stays honestly blocked');
});
