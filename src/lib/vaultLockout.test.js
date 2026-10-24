import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MIN_PIN_LENGTH,
  PIN_FAILURE_LIMIT,
  pinFailureKey,
  pinFailureMessage,
  readPinFailures,
  recordPinFailure,
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
