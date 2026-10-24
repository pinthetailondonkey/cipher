import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptKey, encryptKey, isLegacyVault } from '../useIdentity.js';

const LEGACY_SALT = new TextEncoder().encode('cipher_secure_salt');
const LEGACY_ITERATIONS = 100000;

async function legacyVault(skArray, secret) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'PBKDF2' },
    false,
    ['deriveKey'],
  );
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: LEGACY_SALT, iterations: LEGACY_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(skArray)),
  );
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(data)) };
}

test('current and legacy vaults decrypt, and the wrong PIN does not', async () => {
  const sk = Array.from(crypto.getRandomValues(new Uint8Array(32)));
  const pin = '123456';
  const vault = await encryptKey(sk, pin);
  assert.equal(isLegacyVault(vault), false);
  assert.deepEqual(await decryptKey(vault, pin), sk);
  await assert.rejects(() => decryptKey(vault, '654321'));

  const legacy = await legacyVault(sk, pin);
  assert.equal(isLegacyVault(legacy), true);
  assert.equal(legacy.salt, undefined);
  assert.deepEqual(await decryptKey(legacy, pin), sk);
  await assert.rejects(() => decryptKey(legacy, '000000'));
});
