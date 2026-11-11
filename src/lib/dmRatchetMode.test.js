import assert from 'node:assert/strict';
import test from 'node:test';
import { DM_RATCHET_KEY, dmRatchetEnabled, setDmRatchet } from './dmRatchetMode.js';
import { scopedGet } from './storage.js';

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  key: (index) => Array.from(memory.keys())[index] || null,
  get length() { return memory.size; },
};

test('the ratchet flag defaults off', () => {
  localStorage.setItem('cipher_active_pubkey', 'cd'.repeat(32));
  assert.equal(dmRatchetEnabled(), false);
});

test('setDmRatchet(true) persists under the scoped account key and reads back on', () => {
  localStorage.setItem('cipher_active_pubkey', 'ef'.repeat(32));
  assert.equal(setDmRatchet(true), true);
  assert.equal(scopedGet(DM_RATCHET_KEY, false), true);
  assert.equal(dmRatchetEnabled(), true);
});

test('only the literal boolean true turns the flag on; truthy junk stays off', () => {
  localStorage.setItem('cipher_active_pubkey', 'ab'.repeat(32));
  setDmRatchet('yes');
  assert.equal(dmRatchetEnabled(), false);
  setDmRatchet(1);
  assert.equal(dmRatchetEnabled(), false);
  setDmRatchet(true);
  assert.equal(dmRatchetEnabled(), true);
});

test('setDmRatchet(false) and non-boolean arguments both land at off', () => {
  localStorage.setItem('cipher_active_pubkey', '12'.repeat(32));
  setDmRatchet(true);
  setDmRatchet(false);
  assert.equal(dmRatchetEnabled(), false);
  setDmRatchet(undefined);
  assert.equal(dmRatchetEnabled(), false);
});

test('scopes are independent: one account opting in does not flip another', () => {
  const alice = '34'.repeat(32);
  const bob = '56'.repeat(32);
  localStorage.setItem('cipher_active_pubkey', alice);
  setDmRatchet(true);
  localStorage.setItem('cipher_active_pubkey', bob);
  assert.equal(dmRatchetEnabled(), false);
  setDmRatchet(false);
  localStorage.setItem('cipher_active_pubkey', alice);
  assert.equal(dmRatchetEnabled(), true);
});
