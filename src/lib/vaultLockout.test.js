import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCKED_OUT_MESSAGE,
  MIN_PIN_LENGTH,
  PIN_FAILURE_LIMIT,
  pinFailureKey,
  pinFailureMessage,
  readPinFailures,
  recordPinFailure,
  failPinAttempt,
  removeAccountVault,
  resetPinFailures,
} from './vaultLockout.js';

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
  };
}

test('PIN failure counters are per account and do not share the global key', () => {
  const storage = memoryStorage({ cipher_fails: '4' });
  assert.equal(MIN_PIN_LENGTH, 6);
  assert.equal(PIN_FAILURE_LIMIT, 5);
  assert.equal(pinFailureKey('pk-a'), 'cipher_fails_pk-a');
  assert.equal(pinFailureKey(''), 'cipher_fails_legacy');

  const first = recordPinFailure(storage, 'pk-a');
  assert.equal(first.fails, 1);
  assert.equal(first.lockedOut, false);
  assert.equal(readPinFailures(storage, 'pk-b'), 0);
  assert.equal(storage.getItem('cipher_fails'), '4');

  recordPinFailure(storage, 'pk-b');
  assert.equal(readPinFailures(storage, 'pk-a'), 1);
  assert.equal(readPinFailures(storage, 'pk-b'), 1);
});

test('the fifth failure locks that account only, and success clears it', () => {
  const storage = memoryStorage();
  let last = null;
  for (let i = 0; i < 4; i += 1) last = recordPinFailure(storage, 'pk-a');
  assert.equal(last.remaining, 1);
  assert.equal(last.lockedOut, false);
  assert.match(pinFailureMessage(last.remaining), /deletes this account/);
  assert.doesNotMatch(pinFailureMessage(3), /deletes this account/);

  recordPinFailure(storage, 'pk-b');
  const locked = recordPinFailure(storage, 'pk-a');
  assert.equal(locked.lockedOut, true);
  assert.equal(locked.remaining, 0);
  assert.equal(readPinFailures(storage, 'pk-b'), 1);

  resetPinFailures(storage, 'pk-a');
  assert.equal(readPinFailures(storage, 'pk-a'), 0);
  assert.equal(storage.getItem('cipher_fails'), null);
  assert.equal(readPinFailures(storage, 'pk-b'), 1);
});

test('a fifth wrong PIN on any path removes that account and keeps the others', () => {
  const vaultA = { iv: [1], data: [2], salt: [3] };
  const vaultB = { iv: [4], data: [5], salt: [6] };
  const storage = memoryStorage({
    cipher_vaults: JSON.stringify({ 'pk-a': { vault: vaultA, handle: 'a' }, 'pk-b': { vault: vaultB, handle: 'b' } }),
    cipher_vault: JSON.stringify(vaultB),
    cipher_handle: 'b',
    cipher_active_pubkey: 'pk-a',
  });
  // Account switch and restore-by-handle target an account that is not the active one.
  for (let i = 0; i < 4; i += 1) assert.equal(failPinAttempt(storage, 'pk-b').lockedOut, false);
  assert.ok(JSON.parse(storage.getItem('cipher_vaults'))['pk-b']);
  const locked = failPinAttempt(storage, 'pk-b');
  assert.equal(locked.lockedOut, true);
  const vaults = JSON.parse(storage.getItem('cipher_vaults'));
  assert.equal('pk-b' in vaults, false);
  assert.deepEqual(vaults['pk-a'].vault, vaultA);
  assert.equal(storage.getItem('cipher_vault'), null);
  assert.equal(storage.getItem('cipher_handle'), null);
  assert.equal(storage.getItem('cipher_active_pubkey'), 'pk-a');
  assert.equal(readPinFailures(storage, 'pk-b'), 0);
  assert.match(LOCKED_OUT_MESSAGE, /removed from this device/);
});

test('locking out the active account clears the active pointer and leaves a legacy vault that is not its own', () => {
  const vaultA = { iv: [1], data: [2], salt: [3] };
  const other = { iv: [9], data: [9], salt: [9] };
  const storage = memoryStorage({
    cipher_vaults: JSON.stringify({ 'pk-a': { vault: vaultA, handle: 'a' } }),
    cipher_vault: JSON.stringify(other),
    cipher_active_pubkey: 'pk-a',
  });
  removeAccountVault(storage, 'pk-a');
  assert.deepEqual(JSON.parse(storage.getItem('cipher_vaults')), {});
  assert.equal(storage.getItem('cipher_active_pubkey'), null);
  assert.equal(storage.getItem('cipher_vault'), JSON.stringify(other));
});
