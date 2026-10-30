import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LIB_PRF_CONTEXT_V2,
  WALLET_CONTEXT,
  deriveLibraryKey,
  deriveWalletKey,
  devicePrfInput,
  hasSecondKey,
  normalizePrfOutput,
  openAccountKey,
  sealAccountKey,
  walletPrfInput,
  withSecondKey,
} from './prfTwoInput.js';
import { DeviceKeyError, isDeviceKeyError, isDeviceVault } from './vaultEnvelope.js';

const PK = 'a'.repeat(64);
const OTHER_PK = 'b'.repeat(64);
const bytes = (n, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * seed + 3) & 0xff);
const account = bytes(32, 11);

test('the library constants this file mirrors have not moved', () => {
  // If nostr-passkey ever renames these, every vault sealed today stops
  // opening. Pinned here so the suite fails instead of a person.
  assert.equal(LIB_PRF_CONTEXT_V2, 'nostr-passkey-nsec-v2');
  assert.equal(WALLET_CONTEXT, 'cipher-wallet-a2');
});

test('the two inputs are asked with different contexts, so one is never the other', async () => {
  const salt = bytes(16, 5);
  const deviceInput = await devicePrfInput(salt);
  const walletInputSalt = bytes(16, 5);
  const walletInput = await walletPrfInput(walletInputSalt);
  // Same bytes in, different question asked: the inputs must not collide.
  assert.notDeepEqual(deviceInput, walletInput);
  assert.equal(deviceInput.length, 32);
  assert.equal(walletInput.length, 32);
});

test('the two keys are independent: neither opens what the other wrapped', async () => {
  const first = bytes(32, 13);
  const second = bytes(32, 17);
  const salt = bytes(16, 19);
  const libraryKey = await deriveLibraryKey(first, salt);
  const walletKey = await deriveWalletKey(second, salt);
  const blob = await sealAccountKey(account, walletKey, PK);

  const opened = await openAccountKey(blob, walletKey, PK);
  assert.deepEqual(Array.from(opened), Array.from(account));

  await assert.rejects(
    () => crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(blob.iv) }, libraryKey, new Uint8Array(blob.data)),
    'the device key must not open the account key blob',
  );
});

test('the same salt asked twice never yields the same key as the other input', async () => {
  const prf = bytes(32, 23);
  const salt = bytes(16, 3);
  const a = await deriveLibraryKey(prf, salt);
  const b = await deriveWalletKey(prf, salt);
  const probe = bytes(16, 29);
  const iv = new Uint8Array(12);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, a, probe);
  await assert.rejects(() => crypto.subtle.decrypt({ name: 'AES-GCM', iv }, b, ct));
});

test('a blob is bound to the account it was sealed for', async () => {
  const walletKey = await deriveWalletKey(bytes(32, 31), bytes(16, 37));
  const blob = await sealAccountKey(account, walletKey, PK);
  await assert.rejects(() => openAccountKey(blob, walletKey, OTHER_PK), (error) => {
    assert.equal(error.code, 'wallet-wrong-key');
    assert.ok(isDeviceKeyError(error));
    return true;
  });
});

test('a corrupted or half-written blob refuses as a DEVICE error, never a wrong PIN', async () => {
  const walletKey = await deriveWalletKey(bytes(32, 41), bytes(16, 43));
  for (const blob of [null, {}, { iv: [], data: [] }]) {
    await assert.rejects(() => openAccountKey(blob, walletKey, PK), (error) => {
      assert.ok(error instanceof DeviceKeyError, `not a device error: ${error?.constructor?.name}`);
      assert.equal(error.code, 'wallet-malformed');
      return true;
    });
  }
  // Right shape, wrong key: still a device error, still nothing charged.
  const real = await sealAccountKey(account, walletKey, PK);
  const otherKey = await deriveWalletKey(bytes(32, 47), bytes(16, 43));
  await assert.rejects(() => openAccountKey(real, otherKey, PK), (error) => {
    assert.ok(isDeviceKeyError(error));
    assert.equal(error.code, 'wallet-wrong-key');
    return true;
  });
  // Right shape, right key, garbage ciphertext: the same refusal, not a crash.
  await assert.rejects(
    () => openAccountKey({ iv: Array(12).fill(0), data: Array(8).fill(1) }, walletKey, PK),
    (error) => { assert.ok(isDeviceKeyError(error)); assert.equal(error.code, 'wallet-wrong-key'); return true; },
  );
});

test('a stored salt handed in as text is refused, not silently read as bytes', async () => {
  // The lab found this one the hard way: a base64url string coerced to bytes is
  // a different PRF input, so a different key, and only a real authenticator
  // shows it. Refuse the string and name the fix.
  await assert.rejects(() => devicePrfInput('c2FsdA'), TypeError);
  await assert.rejects(() => walletPrfInput('c2FsdA'), TypeError);
  assert.equal(typeof devicePrfInput(new Uint8Array(16)).then, 'function');
});

test('a PRF output that is not 32 bytes is hashed the way the library hashes it', async () => {
  const short = bytes(16, 53);
  const normalized = await normalizePrfOutput(short);
  assert.equal(normalized.length, 32);
  const expected = new Uint8Array(await crypto.subtle.digest('SHA-256', short));
  assert.deepEqual(Array.from(normalized), Array.from(expected));
  const exact = bytes(32, 59);
  assert.deepEqual(Array.from(await normalizePrfOutput(exact)), Array.from(exact));
});

test('adding the second key leaves the version, the kind and the device layer untouched', async () => {
  const deviceLayer = { iv: [1, 2, 3], data: [4, 5, 6] };
  const vault = { v: 3, dk: { k: 'prf', id: 'cred', rpId: 'ciphermessenger.org' }, ...deviceLayer };
  const next = withSecondKey(vault, { salt2: 'c2FsdA', wallet: { iv: [9], data: [8] } });

  assert.equal(next.v, 3, 'a version bump would send an old build down the legacy path and charge a PIN');
  assert.equal(next.dk.k, 'prf');
  assert.equal(next.dk.id, 'cred');
  assert.equal(next.dk.rpId, 'ciphermessenger.org');
  assert.deepEqual(next.iv, deviceLayer.iv);
  assert.deepEqual(next.data, deviceLayer.data);
  assert.equal(isDeviceVault(next), true);
  assert.equal(hasSecondKey(next), true);

  // The original object is not mutated: a caller that fails to save must not
  // leave the page believing the migration happened.
  assert.equal(hasSecondKey(vault), false);
});

test('a vault without the marker is not treated as carrying one', () => {
  assert.equal(hasSecondKey({ v: 3, dk: { k: 'prf' } }), false);
  assert.equal(hasSecondKey({ v: 3, dk: { k: 'prf', scheme: 'a2' } }), false, 'salt2 without a blob is half a key');
  assert.equal(hasSecondKey({ v: 3, dk: { k: 'prf', scheme: 'a2', salt2: 'x' } }), false);
  assert.equal(hasSecondKey(null), false);
});

test('THE VERSION-BUMP CONTROL: a v4 blob carrying a dk marker is not a device vault and does charge', async () => {
  // The false-green guard. If the marker ever moves to a version bump, this
  // is the test that fails: v4 is read as a legacy vault, the GCM open throws
  // a plain error, and the PIN counter counts it — five of those wipe the
  // account of someone whose PIN was right.
  const bumped = { v: 4, dk: { k: 'prf', scheme: 'a2', salt2: 'c2FsdA' }, iv: [1], data: [2] };
  assert.equal(isDeviceVault(bumped), false, 'a bump must be visible as a non-device vault');
  const shapeError = new Error('OperationError: the operation failed');
  assert.equal(isDeviceKeyError(shapeError), false, 'and its failure must reach the PIN counter');
  // The control that must stay true for the marker to be safe:
  assert.equal(isDeviceVault({ v: 3, dk: { k: 'prf', scheme: 'a2', salt2: 'c2FsdA' } }), true);
});
