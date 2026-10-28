import assert from 'node:assert/strict';
import test from 'node:test';
import { pickUnlockAccount } from './accountPick.js';

const real = { vault: { v: 'real' }, createdAt: 10, confirmed: true };
const draft = { vault: { v: 'draft' }, createdAt: 20, confirmed: false };

test('a draft is never the account the unlock opens, even when the pointer names it', () => {
  const picked = pickUnlockAccount({ real, draft }, 'draft');
  assert.equal(picked.pk, 'real');
  assert.deepEqual(picked.vault, { v: 'real' });
});

test('the active finished account is kept; absent or guest pointers fall to the newest finished one', () => {
  const older = { vault: { v: 'older' }, createdAt: 1 };
  assert.equal(pickUnlockAccount({ real, older }, 'older').pk, 'older');
  assert.equal(pickUnlockAccount({ real, older }, null).pk, 'real');
  assert.equal(pickUnlockAccount({ real, older }, 'guest').pk, 'real');
  assert.equal(pickUnlockAccount({ real, older }, 'gone').pk, 'real');
});

test('a finished account saved before the draft flag existed counts as finished', () => {
  assert.equal(pickUnlockAccount({ old: { vault: { v: 1 }, createdAt: 5 } }, 'old').pk, 'old');
});

test('only drafts: nothing to open, and the single-vault slot does not speak for them', () => {
  assert.equal(pickUnlockAccount({ draft }, 'draft', JSON.stringify({ v: 'mirror-of-draft' })), null);
  assert.equal(pickUnlockAccount({}, null, null), null);
});

test('no table at all: the single-vault slot is used, with no account to count against', () => {
  const picked = pickUnlockAccount({}, null, JSON.stringify({ v: 'legacy' }));
  assert.equal(picked.pk, null);
  assert.deepEqual(picked.vault, { v: 'legacy' });
  assert.equal(pickUnlockAccount({}, null, 'not json'), null);
});

import { confirmDraftAccount, passkeyOffered } from './accountPick.js';

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
  };
}

test('an abandoned second account leaves the first account\'s pointer, mirror and PIN target alone', () => {
  // State createVault now leaves behind: the draft is in the table, nothing else moved.
  const storage = memoryStorage({
    cipher_vaults: JSON.stringify({ real, draft }),
    cipher_active_pubkey: 'real',
    cipher_vault: JSON.stringify(real.vault),
    cipher_handle: 'first',
  });
  const picked = pickUnlockAccount(JSON.parse(storage.getItem('cipher_vaults')), storage.getItem('cipher_active_pubkey'), storage.getItem('cipher_vault'));
  assert.equal(picked.pk, 'real');
  assert.equal(storage.getItem('cipher_handle'), 'first');
});

test('confirming the words is what makes a draft the active account and the mirror', () => {
  const storage = memoryStorage({
    cipher_vaults: JSON.stringify({ real, draft: { ...draft, handle: 'second' } }),
    cipher_active_pubkey: 'real',
    cipher_vault: JSON.stringify(real.vault),
  });
  const result = confirmDraftAccount(storage);
  assert.equal(result.pk, 'draft');
  assert.equal(storage.getItem('cipher_active_pubkey'), 'draft');
  assert.equal(storage.getItem('cipher_vault'), JSON.stringify(draft.vault));
  assert.equal(storage.getItem('cipher_handle'), 'second');
  assert.equal(JSON.parse(storage.getItem('cipher_vaults')).draft.confirmed, true);
  assert.equal(confirmDraftAccount(storage), null);
});

test('a saved passkey is not a way in for an account that was never finished', () => {
  const base = {
    cipher_vaults: JSON.stringify({ draft }),
    cipher_biometric_enabled: 'true',
    cipher_biometric_pubkey: 'draft',
  };
  assert.equal(passkeyOffered(memoryStorage(base)), false);
  assert.equal(passkeyOffered(memoryStorage({ ...base, cipher_vaults: JSON.stringify({ draft: real }) })), true);
  assert.equal(passkeyOffered(memoryStorage({ ...base, cipher_biometric_enabled: 'false' })), false);
  assert.equal(passkeyOffered(memoryStorage({})), false);
});
