import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCKED_OUT_MESSAGE,
  MIN_PIN_LENGTH,
  MIN_EXISTING_PIN_LENGTH,
  isAcceptableNewPin,
  PIN_FAILURE_LIMIT,
  pinFailureKey,
  pinFailureMessage,
  readPinFailures,
  recordPinFailure,
  failPinAttempt,
  failUnlockAttempt,
  deviceKeyFailureMessage,
  deviceLockUpgradeMessage,
  removeAccountKeys,
  removeAccountVault,
  resetPinFailures,
} from './vaultLockout.js';
import { DeviceKeyCancelled, DeviceKeyMissing, DeviceKeyUnavailable } from './vaultEnvelope.js';

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); },
    key(index) { return Array.from(data.keys())[index] ?? null; },
    get length() { return data.size; },
  };
}

test('PIN failure counters are per account and do not share the global key', () => {
  const storage = memoryStorage({ cipher_fails: '4' });
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

test('a lockout also clears the scoped data, passkey, and pointers of that account, and nothing of the others', () => {
  const a = 'aaaaaaaa' + '1'.repeat(56);
  const b = 'bbbbbbbb' + '2'.repeat(56);
  const storage = memoryStorage({
    cipher_vaults: JSON.stringify({ [a]: { vault: { iv: [1] } }, [b]: { vault: { iv: [2] } } }),
    cipher_active_pubkey: b,
    cipher_db_owner: a,
    cipher_biometric_pubkey: a,
    cipher_biometric_enabled: 'true',
    [`cipher_passkey_${a}`]: '{"wrapped":1}',
    [`cipher_passkey_${b}`]: '{"wrapped":2}',
    [`cipher_my_groups_${a.slice(0, 16)}`]: '[]',
    cipher_aaaaaaaa_receipt_x: '{}',
    cipher_aaaaaaaa_blocked: '[]',
    cipher_bbbbbbbb_blocked: '["z"]',
    cipher_network: '{}',
  });
  for (let i = 0; i < 5; i += 1) failPinAttempt(storage, a);
  for (const gone of [`cipher_passkey_${a}`, `cipher_my_groups_${a.slice(0, 16)}`, 'cipher_aaaaaaaa_receipt_x', 'cipher_aaaaaaaa_blocked', 'cipher_db_owner', 'cipher_biometric_pubkey', 'cipher_biometric_enabled']) {
    assert.equal(storage.getItem(gone), null, gone);
  }
  for (const kept of [`cipher_passkey_${b}`, 'cipher_bbbbbbbb_blocked', 'cipher_network', 'cipher_active_pubkey']) {
    assert.notEqual(storage.getItem(kept), null, kept);
  }
  assert.ok(JSON.parse(storage.getItem('cipher_vaults'))[b]);
});

test('a scoped prefix shared with another saved account is left in place', () => {
  const a = 'cccccccc' + '1'.repeat(56);
  const twin = 'cccccccc' + '9'.repeat(56);
  const storage = memoryStorage({
    cipher_vaults: JSON.stringify({ [a]: {}, [twin]: {} }),
    cipher_cccccccc_blocked: '["kept"]',
    [`cipher_passkey_${a}`]: '{}',
  });
  const removed = removeAccountKeys(storage, a);
  assert.deepEqual(removed, [`cipher_passkey_${a}`]);
  assert.equal(storage.getItem('cipher_cccccccc_blocked'), '["kept"]');
});

test('a new PIN needs 8 digits; an existing account keeps its shorter PIN', () => {
  assert.equal(MIN_PIN_LENGTH, 8);
  assert.equal(isAcceptableNewPin('1234567'), false);
  assert.equal(isAcceptableNewPin('123456'), false);
  assert.equal(isAcceptableNewPin('12345678'), true);
  assert.equal(isAcceptableNewPin(''), false);
  assert.equal(isAcceptableNewPin(undefined), false);
  assert.equal(isAcceptableNewPin(12345678), false);
  // Unlocking and relay-restore only check the old floor, so a 6-digit
  // account made before this change still opens with its 6-digit PIN.
  assert.equal(MIN_EXISTING_PIN_LENGTH, 6);
  assert.ok(MIN_EXISTING_PIN_LENGTH < MIN_PIN_LENGTH);
});

test('only a wrong PIN counts toward the wipe: a cancelled prompt or a missing device key never does', () => {
  const storage = memoryStorage({ cipher_fails_pk: '4' });
  for (const error of [new DeviceKeyCancelled(), new DeviceKeyMissing('no-provider'), new DeviceKeyMissing('wrong-key'), new DeviceKeyUnavailable()]) {
    for (let i = 0; i < 10; i += 1) {
      const result = failUnlockAttempt(storage, 'pk', error);
      assert.equal(result.counted, false);
      assert.equal(result.lockedOut, false);
      assert.equal(result.remaining, 1);
      assert.equal(result.deviceKey, error.code);
    }
  }
  assert.equal(readPinFailures(storage, 'pk'), 4);
  assert.equal(storage.getItem('cipher_vaults'), null);
});

test('a plain crypto failure still counts, and the fifth still wipes the account', () => {
  const vaults = JSON.stringify({ pk: { vault: { v: 3 } } });
  const storage = memoryStorage({ cipher_vaults: vaults, cipher_active_pubkey: 'pk' });
  let last;
  for (let i = 0; i < 5; i += 1) last = failUnlockAttempt(storage, 'pk', new Error('OperationError'));
  assert.equal(last.counted, true);
  assert.equal(last.lockedOut, true);
  assert.equal(JSON.parse(storage.getItem('cipher_vaults')).pk, undefined);
  assert.equal(storage.getItem('cipher_active_pubkey'), null);
});

test('a device key failure says what happened in plain words and never mentions a wrong PIN', () => {
  assert.match(deviceKeyFailureMessage(new DeviceKeyCancelled()), /nothing was counted/i);
  assert.match(deviceKeyFailureMessage(new DeviceKeyMissing()), /12 words/);
  for (const error of [new DeviceKeyCancelled(), new DeviceKeyMissing(), new DeviceKeyUnavailable()]) {
    assert.doesNotMatch(deviceKeyFailureMessage(error), /wrong pin/i);
  }
});

test('an upgrade that could not lock the account says nothing changed and points to the 12 words', () => {
  for (const error of [new DeviceKeyCancelled(), new DeviceKeyMissing(), new DeviceKeyUnavailable()]) {
    const message = deviceLockUpgradeMessage(error);
    assert.match(message, /nothing/i);
    assert.doesNotMatch(message, /wrong pin/i);
  }
  assert.match(deviceLockUpgradeMessage(new DeviceKeyUnavailable()), /12 words/);
  assert.match(deviceLockUpgradeMessage(new DeviceKeyMissing()), /12 words/);
});
