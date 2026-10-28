import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PASSKEY_CANCELLED, PASSKEY_FAILED, PASSKEY_UNAVAILABLE, PASSKEY_WRONG_ACCOUNT,
  passkeyFailureCode, passkeyFailureMessage,
} from './passkeyMessages.js';

// The saved passkey door shows these words and only these words. The
// browser's and the library's own sentences are what used to reach the
// screen, so each one is mapped here rather than passed through.
function domError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

test('a cancelled authenticator says it was cancelled', () => {
  assert.equal(passkeyFailureCode(domError('NotAllowedError', 'The operation either timed out or was not allowed.')), 'cancelled');
  assert.equal(passkeyFailureCode(domError('AbortError', 'The operation was aborted.')), 'cancelled');
  assert.equal(passkeyFailureCode(new Error('Passkey unlock was cancelled.')), 'cancelled');
  assert.equal(passkeyFailureMessage({ code: 'cancelled' }), PASSKEY_CANCELLED);
});

test('a device with no usable passkey says so instead of failing blind', () => {
  assert.equal(passkeyFailureCode(new Error('No passkey identity found on this device.')), 'unavailable');
  assert.equal(passkeyFailureCode(new Error('Passkeys are not supported in this browser.')), 'unavailable');
  assert.equal(passkeyFailureCode(new Error('This device does not support passkey-based encryption (PRF extension required).')), 'unavailable');
  assert.equal(passkeyFailureCode(domError('InvalidStateError', 'No credentials available.')), 'unavailable');
  assert.equal(passkeyFailureMessage({ code: 'unavailable' }), PASSKEY_UNAVAILABLE);
});

test('a passkey for another account is named as one', () => {
  assert.equal(passkeyFailureCode(new Error('The saved passkey belongs to a different account.')), 'wrong-account');
  assert.equal(passkeyFailureCode(new Error('Passkey identity mismatch.')), 'wrong-account');
  assert.equal(passkeyFailureMessage({ code: 'wrong-account' }), PASSKEY_WRONG_ACCOUNT);
});

test('the library\'s catch-all never reaches the screen', () => {
  assert.equal(passkeyFailureCode(new Error('Operation failed.')), 'failed');
  assert.equal(passkeyFailureMessage({ code: 'failed', error: 'Operation failed.' }), PASSKEY_FAILED);
  assert.equal(passkeyFailureMessage({ error: new Error('Operation failed.') }), PASSKEY_FAILED);
  assert.equal(passkeyFailureMessage(undefined), PASSKEY_FAILED);
  // A DOMException's own words are not the message.
  const raw = domError('NotAllowedError', 'The user denied permission to use a credential.');
  assert.equal(passkeyFailureMessage({ error: raw }), PASSKEY_CANCELLED);
  assert.notEqual(passkeyFailureMessage({ error: raw }), raw.message);
});

test('our own new-PIN sentence is passed through by code', () => {
  const sentence = 'Enter a new PIN (exactly 8 digits) to restore this account on this device.';
  assert.equal(passkeyFailureMessage({ code: 'new-pin', error: sentence }), sentence);
  // Without the code it is not passed through, even though it is plain.
  assert.equal(passkeyFailureMessage({ error: sentence }), PASSKEY_FAILED);
});
