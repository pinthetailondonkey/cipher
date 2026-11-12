import assert from 'node:assert/strict';
import test from 'node:test';

// Pure-logic tests for the MLS route shim's group binding state machine.
// The wasm engine itself is proven by the Rust round-trip test and the
// browser seam proof; here the routing decisions are pinned without wasm.

const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => (memory.has(key) ? memory.get(key) : null),
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
  key: (index) => Array.from(memory.keys())[index] || null,
  get length() { return memory.size; },
};

const { ready, registerGroupRef, clearGroupRef } = await import('./mlsGroupsRoute.js');

test('ready is false before any registration', async () => {
  localStorage.setItem('cipher_active_pubkey', 'aa'.repeat(32));
  assert.equal(await ready('group-1'), false);
});

test('registering a group makes only that groupId ready', async () => {
  localStorage.setItem('cipher_active_pubkey', 'bb'.repeat(32));
  registerGroupRef('group-7', '{"v":1,"t":"cipherMlsGroupRef","group_id":"AAAA"}');
  assert.equal(await ready('group-7'), true);
  assert.equal(await ready('group-other'), false);
});

test('clearGroupRef turns readiness off without touching the stored ref shape', async () => {
  localStorage.setItem('cipher_active_pubkey', 'cc'.repeat(32));
  registerGroupRef('group-x', '{"v":1}');
  clearGroupRef();
  assert.equal(await ready('group-x'), false);
});

test('a corrupted stored ref reads as not-ready, never throws', async () => {
  localStorage.setItem('cipher_active_pubkey', 'dd'.repeat(32));
  registerGroupRef('ok-group', '{"v":1,"t":"cipherMlsGroupRef","group_id":"BBBB"}');
  assert.equal(await ready('ok-group'), true);
  // Match the exact scoped name storage.js derives for THIS account only;
  // earlier tests left refs under other accounts' prefixes.
  const scopedKey = [...memory.keys()].find((k) => k.startsWith(`cipher_${'dd'.repeat(32)}_mls_group_ref_v1`));
  assert.ok(scopedKey, 'expected this account\'s ref row to exist');
  memory.set(scopedKey, '{definitely-not-json');
  assert.equal(await ready('ok-group'), false);
});
