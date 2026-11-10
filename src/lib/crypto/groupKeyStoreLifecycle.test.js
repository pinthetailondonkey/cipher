import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { closeDB, openDBFor, retireDatabaseSecurityContext, waitForSecurityContextActivation } from '../../db.js';
import { clearSessionKey, setSessionKey } from '../sessionKey.js';
import { createSecurityContextFence, establishSecurityContext, retireSecurityContext } from '../securityContextFence.js';
import {
  getDocKey,
  getGroupKey,
  getGrantedEpochsFor,
  putDocKey,
  putGroupKey,
  recordGrant,
  removeDocKey,
} from './groupKeyStore.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
    key: (index) => Array.from(values.keys())[index] ?? null,
    get length() { return values.size; },
  };
}

test('group-key writes stay bound to the originating account incarnation across same-account relock', async () => {
  const owner = 'f'.repeat(64);
  const storage = memoryStorage();
  globalThis.localStorage = storage;
  const sessionSecret = new Uint8Array(32).fill(71);
  const firstContext = establishSecurityContext({ owner, storage,
    randomId: () => 'group-key-old-incarnation-0001' });
  const firstFence = createSecurityContextFence({ context: firstContext, storage });
  setSessionKey(sessionSecret);
  openDBFor(owner, firstFence);
  await waitForSecurityContextActivation();

  await putGroupKey('lifecycle-group', 1, new Uint8Array(32).fill(1), {}, firstFence);
  let releaseStaleOperation;
  const waiting = new Promise((resolve) => { releaseStaleOperation = resolve; });
  const staleWrite = (async () => {
    await waiting;
    await putGroupKey('lifecycle-group', 2, new Uint8Array(32).fill(2), {}, firstFence);
  })();

  firstFence.invalidate('test-lock');
  firstFence.close();
  retireSecurityContext({ context: firstContext, storage });
  assert.equal((await retireDatabaseSecurityContext(firstContext)).retired, true);
  closeDB();

  const nextContext = establishSecurityContext({ owner, storage,
    randomId: () => 'group-key-new-incarnation-0002' });
  const nextFence = createSecurityContextFence({ context: nextContext, storage });
  setSessionKey(sessionSecret);
  openDBFor(owner, nextFence);
  await waitForSecurityContextActivation();

  releaseStaleOperation();
  await assert.rejects(staleWrite, { code: 'SECURITY_CONTEXT_EXPIRED' });
  await assert.rejects(
    () => putGroupKey('lifecycle-group', 2, new Uint8Array(32).fill(3)),
    { code: 'SECURITY_CONTEXT_EXPIRED' },
    'production group-key writes require the captured fence',
  );
  await assert.rejects(
    () => putDocKey('lifecycle-group', 2, new Uint8Array(32).fill(4)),
    { code: 'SECURITY_CONTEXT_EXPIRED' },
    'production governance-key writes require the captured fence',
  );
  await assert.rejects(
    () => removeDocKey('lifecycle-group'),
    { code: 'SECURITY_CONTEXT_EXPIRED' },
    'production governance-key removal requires the captured fence',
  );
  await assert.rejects(
    () => recordGrant('lifecycle-group', 'e'.repeat(64), 2),
    { code: 'SECURITY_CONTEXT_EXPIRED' },
    'production grant-ledger writes require the captured fence',
  );
  assert.deepEqual(await getGroupKey('lifecycle-group', 1, nextFence), new Uint8Array(32).fill(1));
  assert.equal(await getGroupKey('lifecycle-group', 2, nextFence), null,
    'the stale callback did not write into the replacement incarnation');
  assert.equal(await getDocKey('lifecycle-group', nextFence), null,
    'a missing captured fence did not create or remove a governance key');
  assert.deepEqual(await getGrantedEpochsFor('lifecycle-group', 'e'.repeat(64), nextFence), new Set(),
    'a missing captured fence did not mutate the grant ledger');

  nextFence.invalidate('test-cleanup');
  nextFence.close();
  retireSecurityContext({ context: nextContext, storage });
  await retireDatabaseSecurityContext(nextContext);
  closeDB();
  clearSessionKey();
});
