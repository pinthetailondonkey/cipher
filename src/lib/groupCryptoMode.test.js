import assert from 'node:assert/strict';
import test from 'node:test';
import { GROUP_MLS_KEY, groupMlsEnabled, setGroupMls } from './groupCryptoMode.js';
import { scopedGet } from './storage.js';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  key: (index) => Array.from(memory.keys())[index] || null,
  get length() { return memory.size; },
};

test('the MLS flag defaults off', () => {
  localStorage.setItem('cipher_active_pubkey', '9a'.repeat(32));
  assert.equal(groupMlsEnabled(), false);
});

test('setGroupMls(true) persists under the scoped account key and reads back on', () => {
  localStorage.setItem('cipher_active_pubkey', 'bc'.repeat(32));
  assert.equal(setGroupMls(true), true);
  assert.equal(scopedGet(GROUP_MLS_KEY, false), true);
  assert.equal(groupMlsEnabled(), true);
});

test('truthy junk stays off; only the literal boolean true enables', () => {
  localStorage.setItem('cipher_active_pubkey', 'de'.repeat(32));
  setGroupMls('on');
  assert.equal(groupMlsEnabled(), false);
  setGroupMls(1);
  assert.equal(groupMlsEnabled(), false);
  setGroupMls(true);
  assert.equal(groupMlsEnabled(), true);
});

test('setGroupMls(false) and non-boolean arguments both land at off', () => {
  localStorage.setItem('cipher_active_pubkey', 'f0'.repeat(32));
  setGroupMls(true);
  setGroupMls(false);
  assert.equal(groupMlsEnabled(), false);
  setGroupMls(undefined);
  assert.equal(groupMlsEnabled(), false);
});

test('scopes are independent: one account opting in does not flip another', () => {
  const first = '11'.repeat(32);
  const second = '22'.repeat(32);
  localStorage.setItem('cipher_active_pubkey', first);
  setGroupMls(true);
  localStorage.setItem('cipher_active_pubkey', second);
  assert.equal(groupMlsEnabled(), false);
  localStorage.setItem('cipher_active_pubkey', first);
  assert.equal(groupMlsEnabled(), true);
});
