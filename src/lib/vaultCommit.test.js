import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commitWithRollback } from './vaultCommit.js';

// A storage that refuses on demand, like a full or locked one.
function fakeStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem(key, value) {
      if (this.refuse && this.refuse(key)) throw new Error('write refused');
      data.set(key, String(value));
    },
    removeItem: (key) => { data.delete(key); },
    dump: () => Object.fromEntries(data),
    refuse: null,
  };
}

test('every write lands when storage takes them all', () => {
  const storage = fakeStorage({ cipher_vaults: '{"old":"table"}' });
  commitWithRollback(storage, [
    { key: 'cipher_vaults', value: '{"new":"table"}' },
    { key: 'cipher_active_pubkey', value: 'pk' },
    { key: 'cipher_vault', value: '{"v":3}' },
  ]);
  assert.deepEqual(storage.dump(), {
    cipher_vaults: '{"new":"table"}',
    cipher_active_pubkey: 'pk',
    cipher_vault: '{"v":3}',
  });
});

test('a refusal mid-commit puts the table, the pointer and the mirror back exactly', () => {
  const storage = fakeStorage({
    cipher_vaults: '{"prior":"table"}',
    cipher_active_pubkey: 'prior-pk',
    cipher_vault: '{"prior":"mirror"}',
  });
  storage.refuse = (key) => key === 'cipher_vault';
  assert.throws(() => commitWithRollback(storage, [
    { key: 'cipher_vaults', value: '{"new":"table"}' },
    { key: 'cipher_active_pubkey', value: 'new-pk' },
    { key: 'cipher_vault', value: '{"new":"mirror"}' },
  ]), /write refused/);
  // The two writes that landed before the refusal are gone again.
  assert.deepEqual(storage.dump(), {
    cipher_vaults: '{"prior":"table"}',
    cipher_active_pubkey: 'prior-pk',
    cipher_vault: '{"prior":"mirror"}',
  });
});

test('a slot that did not exist before the commit is removed again, not left empty', () => {
  const storage = fakeStorage({ cipher_vaults: '{"prior":"table"}' });
  storage.refuse = (key) => key === 'cipher_active_pubkey';
  assert.throws(() => commitWithRollback(storage, [
    { key: 'cipher_vaults', value: '{"new":"table"}' },
    { key: 'cipher_active_pubkey', value: 'new-pk' },
  ]));
  assert.deepEqual(storage.dump(), { cipher_vaults: '{"prior":"table"}' });
});

test('the original error travels even when the undo writes also fail', () => {
  const storage = fakeStorage({ cipher_vaults: '{"prior":"table"}' });
  // Every setItem is refused — the commit's writes and the undo's alike.
  // The undo's failure is swallowed; the commit's failure is not.
  storage.refuse = () => true;
  assert.throws(() => commitWithRollback(storage, [
    { key: 'cipher_vaults', value: '{"new":"table"}' },
  ]), /write refused/);
});

test('extra slots ride the same commit', () => {
  const storage = fakeStorage({ cipher_handle: 'prior-handle' });
  storage.refuse = (key) => key === 'cipher_biometric_enabled';
  assert.throws(() => commitWithRollback(storage, [
    { key: 'cipher_vaults', value: '{"new":"table"}' },
    { key: 'cipher_handle', value: 'new-handle' },
    { key: 'cipher_biometric_enabled', value: 'true' },
  ]));
  assert.equal(storage.getItem('cipher_handle'), 'prior-handle');
  assert.equal(storage.getItem('cipher_vaults'), null);
});
