import assert from 'node:assert/strict';
import test from 'node:test';
import { setAtRestKeyProvider } from './messageAtRest.js';
import { openRatchetState, sealRatchetState } from './ratchetStateAtRest.js';

const VAULT_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const RECORD = {
  owner: 'account-a',
  collection: 'sessions',
  id: 'peer-a:device-1',
  value: { pickle: 'encrypted-olm-state', pickleKey: 'private-pickle-key' },
};

test('ratchet state is sealed at rest and opens only under its owner and record identity', async () => {
  setAtRestKeyProvider(() => VAULT_KEY);
  const sealed = await sealRatchetState(RECORD);
  assert.equal(sealed.v, 1);
  const stored = JSON.stringify(sealed);
  assert.equal(stored.includes('encrypted-olm-state'), false);
  assert.equal(stored.includes('private-pickle-key'), false);
  assert.deepEqual(await openRatchetState({ ...RECORD, sealed }), RECORD.value);
  await assert.rejects(openRatchetState({ ...RECORD, owner: 'account-b', sealed }));
  await assert.rejects(openRatchetState({ ...RECORD, id: 'peer-a:device-2', sealed }));
});

test('ratchet state never falls back to plaintext when vault storage is locked', async () => {
  setAtRestKeyProvider(() => null);
  await assert.rejects(sealRatchetState(RECORD), /Unlock this account/);
  setAtRestKeyProvider(() => VAULT_KEY);
  const sealed = await sealRatchetState(RECORD);
  setAtRestKeyProvider(() => null);
  await assert.rejects(openRatchetState({ ...RECORD, sealed }), /Unlock this account/);
});

test('tampering with ratchet state ciphertext is rejected', async () => {
  setAtRestKeyProvider(() => VAULT_KEY);
  const sealed = await sealRatchetState(RECORD);
  const bytes = Uint8Array.from(atob(sealed.ct), (char) => char.charCodeAt(0));
  bytes[bytes.length - 1] ^= 1;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  await assert.rejects(openRatchetState({
    ...RECORD,
    sealed: { ...sealed, ct: btoa(binary) },
  }));
});
