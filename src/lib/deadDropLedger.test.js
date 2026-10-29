import assert from 'node:assert/strict';
import test from 'node:test';

// A burn note's promise is made to a DEVICE, not to an account: "this note was
// already opened on this device." The ledger was scoped by the active account,
// so a stranger with no account spent a note under the guest scope and the same
// link opened a second time the moment they made an account. This file holds
// the promise to the words on the screen.
const map = new Map();
globalThis.localStorage = {
  getItem: (k) => (map.has(k) ? map.get(k) : null),
  setItem: (k, v) => map.set(k, String(v)),
  removeItem: (k) => map.delete(k),
  clear: () => map.clear(),
  key: (i) => Array.from(map.keys())[i] ?? null,
  get length() { return map.size; },
};

const { deadDropConsumed, markDeadDropConsumed } = await import('./deadDrop.js');

const signIn = (pubkey) => localStorage.setItem('cipher_active_pubkey', pubkey);

test('a note opened with no account stays opened once the account exists', () => {
  localStorage.clear();
  const hash = 'a'.repeat(64);
  assert.equal(deadDropConsumed(hash), false, 'nothing spent yet');
  markDeadDropConsumed(hash);
  assert.equal(deadDropConsumed(hash), true, 'spent under the guest scope');

  signIn('f'.repeat(64));
  assert.equal(deadDropConsumed(hash), true,
    'the same link must not open a second time because an account was made');
});

test('a note opened on one account stays opened on another account of the same device', () => {
  localStorage.clear();
  signIn('1'.repeat(64));
  const hash = 'b'.repeat(64);
  markDeadDropConsumed(hash);

  signIn('2'.repeat(64));
  assert.equal(deadDropConsumed(hash), true, 'the promise is to the device, not the account');
});

test('marking the same note twice is still one entry, and a new note is not spent by it', () => {
  localStorage.clear();
  const first = 'c'.repeat(64);
  const second = 'd'.repeat(64);
  markDeadDropConsumed(first);
  markDeadDropConsumed(first);
  assert.equal(deadDropConsumed(first), true);
  assert.equal(deadDropConsumed(second), false, 'burning one note never burns another');
});
