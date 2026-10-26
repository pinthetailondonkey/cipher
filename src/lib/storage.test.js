import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateLegacyScope, resetScopeMigration, scopeKey, scopedGet } from './storage.js';

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: (key) => data.delete(key),
    key: (index) => Array.from(data.keys())[index] ?? null,
    get length() { return data.size; },
  };
}

const pk = 'aabbccdd' + 'e'.repeat(56);

test('a scoped key is the full pubkey, and a legacy drawer moves across once', () => {
  globalThis.localStorage = memoryStorage({
    cipher_active_pubkey: pk,
    [`cipher_${pk.slice(0, 8)}_receipt_order1`]: JSON.stringify({ hash: 'h1' }),
    [`cipher_${pk.slice(0, 8)}_cfg`]: '"kept"',
  });
  assert.equal(scopeKey('receipt_order1'), `cipher_${pk}_receipt_order1`);
  // First scoped read migrates: the value arrives, and the legacy key leaves.
  assert.deepEqual(scopedGet('receipt_order1', null), { hash: 'h1' });
  assert.equal(localStorage.getItem(`cipher_${pk.slice(0, 8)}_receipt_order1`), null);
  assert.equal(localStorage.getItem(`cipher_${pk}_receipt_order1`), '{"hash":"h1"}');
  assert.equal(localStorage.getItem(`cipher_${pk}_cfg`), '"kept"');
});

test('a full-scope entry wins over a legacy one and the legacy key is dropped', () => {
  resetScopeMigration();
  globalThis.localStorage = memoryStorage({
    cipher_active_pubkey: pk,
    [`cipher_${pk.slice(0, 8)}_cfg`]: '"old"',
    [`cipher_${pk}_cfg`]: '"new"',
  });
  assert.equal(scopedGet('cfg', null), 'new');
  assert.equal(localStorage.getItem(`cipher_${pk.slice(0, 8)}_cfg`), null);
});

test('a saved account sharing the legacy prefix keeps its drawer alone', () => {
  resetScopeMigration();
  const sister = 'aabbccdd' + 'f'.repeat(56);
  globalThis.localStorage = memoryStorage({
    cipher_active_pubkey: pk,
    cipher_vaults: JSON.stringify({ [pk]: {}, [sister]: {} }),
    [`cipher_${pk.slice(0, 8)}_cfg`]: '"unclear"',
  });
  migrateLegacyScope();
  assert.equal(localStorage.getItem(`cipher_${pk.slice(0, 8)}_cfg`), '"unclear"');
  assert.equal(localStorage.getItem(`cipher_${pk}_cfg`), null);
});

test('a guest scope and an unset key migrate nothing', () => {
  resetScopeMigration();
  globalThis.localStorage = memoryStorage({
    [`cipher_guest_cfg`]: '"x"',
  });
  assert.equal(scopeKey('cfg'), 'cipher_guest_cfg');
  assert.equal(localStorage.getItem('cipher_guest_cfg'), '"x"');
});
