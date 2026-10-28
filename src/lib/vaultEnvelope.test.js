import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptKey, encryptKey, isLegacyVault, openVault } from '../useIdentity.js';
import {
  DeviceKeyCancelled,
  DeviceKeyError,
  DeviceKeyMissing,
  DEVICE_VAULT_VERSION,
  deviceVaultAad,
  isDeviceVault,
  makeSecretProvider,
  setDeviceProvider,
  wrapDeviceVault,
} from './vaultEnvelope.js';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);

// A provider whose device secret is a random 32 bytes held in memory: the
// stand-in for the authenticator, the OS key store or the Android Keystore.
function fakeProvider(kind = 'prf', secrets = new Map()) {
  return makeSecretProvider({
    kind,
    available: async () => true,
    enroll: async (pk) => {
      secrets.set(pk, crypto.getRandomValues(new Uint8Array(32)));
      return { k: kind, id: `fake-${pk.slice(0, 4)}` };
    },
    getSecret: async (pk) => {
      const secret = secrets.get(pk);
      if (!secret) throw new DeviceKeyMissing('no-key');
      return secret;
    },
    destroy: async (pk) => { secrets.delete(pk); },
  });
}

async function sealed(provider, pk, pin, sk) {
  const dk = await provider.enroll(pk);
  const inner = await encryptKey(sk, pin);
  return { vault: await wrapDeviceVault(provider, pk, dk, inner), inner };
}

const newSk = () => Array.from(crypto.getRandomValues(new Uint8Array(32)));

test('a device vault is version 3, is not a legacy vault, and opens with the right device and PIN', async () => {
  const provider = fakeProvider();
  const sk = newSk();
  const { vault } = await sealed(provider, PK_A, '12345678', sk);
  assert.equal(vault.v, DEVICE_VAULT_VERSION);
  assert.equal(isDeviceVault(vault), true);
  // An old bundle calls isLegacyVault: a v3 vault has no top level salt and
  // must not be taken for a no-salt legacy vault (it would be read with the
  // wrong key and every correct PIN would count as wrong).
  assert.equal(isLegacyVault(vault), false);
  assert.equal(vault.salt, undefined);
  assert.deepEqual(await decryptKey(vault, '12345678', { pk: PK_A, provider }), sk);
});

test('the outer layer is the device and the inner layer stays the PIN vault byte for byte', async () => {
  const provider = fakeProvider();
  const sk = newSk();
  const { vault, inner } = await sealed(provider, PK_A, '12345678', sk);
  const opened = await provider.open(PK_A, vault.dk, { iv: vault.iv, data: vault.data }, new TextEncoder().encode(deviceVaultAad(PK_A, 'prf')));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(opened)), inner);
});

test('right device with the wrong PIN opens the outer layer and fails the inner one with a plain crypto error', async () => {
  const provider = fakeProvider();
  const { vault } = await sealed(provider, PK_A, '12345678', newSk());
  await assert.rejects(
    () => decryptKey(vault, '00000000', { pk: PK_A, provider }),
    (error) => !(error instanceof DeviceKeyError),
  );
});

test('a copied vault with the right PIN but no device key cannot open', async () => {
  const sk = newSk();
  const { vault } = await sealed(fakeProvider(), PK_A, '12345678', sk);
  await assert.rejects(() => decryptKey(vault, '12345678', { pk: PK_A, provider: fakeProvider() }), DeviceKeyMissing);
  await assert.rejects(() => decryptKey(vault, '12345678', { pk: PK_A, provider: null }), DeviceKeyMissing);
  await assert.rejects(() => decryptKey(vault, '12345678', { pk: PK_A }), DeviceKeyMissing);
});

test('a same-kind provider with a different secret cannot open the blob', async () => {
  const secrets = new Map();
  const provider = fakeProvider('prf', secrets);
  const { vault } = await sealed(provider, PK_A, '12345678', newSk());
  secrets.set(PK_A, crypto.getRandomValues(new Uint8Array(32)));
  await assert.rejects(() => decryptKey(vault, '12345678', { pk: PK_A, provider }), DeviceKeyMissing);
});

test('the blob is bound to its account and its provider kind', async () => {
  const secrets = new Map();
  const provider = fakeProvider('prf', secrets);
  const { vault } = await sealed(provider, PK_A, '12345678', newSk());
  // Same device secret, but the blob is presented as another account's.
  secrets.set(PK_B, secrets.get(PK_A));
  await assert.rejects(() => decryptKey(vault, '12345678', { pk: PK_B, provider }), DeviceKeyMissing);
  // Downgrade or swap of the provider kind inside dk.
  const relabelled = { ...vault, dk: { ...vault.dk, k: 'safe' } };
  await assert.rejects(() => decryptKey(relabelled, '12345678', { pk: PK_A, provider }), DeviceKeyMissing);
  await assert.rejects(() => decryptKey(vault, '12345678', { pk: PK_A, provider: fakeProvider('safe', secrets) }), DeviceKeyMissing);
});

test('a tampered or malformed outer blob is a missing-key error, never a wrong PIN', async () => {
  const provider = fakeProvider();
  const { vault } = await sealed(provider, PK_A, '12345678', newSk());
  const flipped = { ...vault, data: vault.data.map((byte, i) => (i === 3 ? byte ^ 1 : byte)) };
  await assert.rejects(() => decryptKey(flipped, '12345678', { pk: PK_A, provider }), DeviceKeyMissing);
  await assert.rejects(() => decryptKey({ ...vault, data: 'junk' }, '12345678', { pk: PK_A, provider }), DeviceKeyMissing);
  await assert.rejects(() => decryptKey({ v: 3 }, '12345678', { pk: PK_A, provider }), DeviceKeyMissing);
  await assert.rejects(() => decryptKey(vault, '12345678', { provider }), DeviceKeyMissing);
});

test('a provider that is cancelled by the person surfaces as DeviceKeyCancelled', async () => {
  const provider = makeSecretProvider({
    kind: 'prf',
    available: async () => true,
    enroll: async () => ({ k: 'prf', id: 'x' }),
    getSecret: async () => { throw new DeviceKeyCancelled(); },
    destroy: async () => {},
  });
  const sealedWith = await sealed(fakeProvider(), PK_A, '12345678', newSk());
  await assert.rejects(() => decryptKey(sealedWith.vault, '12345678', { pk: PK_A, provider }), DeviceKeyCancelled);
});

test('a v2 vault and a legacy no-salt vault still open exactly as before, with or without a provider', async () => {
  const sk = newSk();
  const v2 = await encryptKey(sk, '12345678');
  assert.equal(isDeviceVault(v2), false);
  assert.deepEqual(await decryptKey(v2, '12345678'), sk);
  assert.deepEqual(await decryptKey(v2, '12345678', { pk: PK_A, provider: fakeProvider() }), sk);
});

test('a v3 vault wrapping a v3 vault is refused, when built and when opened', async () => {
  const provider = fakeProvider();
  const dk = await provider.enroll(PK_A);
  const inner = await encryptKey(newSk(), '12345678');
  const once = await wrapDeviceVault(provider, PK_A, dk, inner);
  await assert.rejects(() => wrapDeviceVault(provider, PK_A, dk, once), DeviceKeyError);
  // Built by hand, as an attacker or a bug would.
  const aad = new TextEncoder().encode(deviceVaultAad(PK_A, dk.k));
  const sealedTwice = await provider.seal(PK_A, dk, new TextEncoder().encode(JSON.stringify(once)), aad);
  const twice = { v: 3, dk, ...sealedTwice };
  await assert.rejects(() => decryptKey(twice, '12345678', { pk: PK_A, provider }), DeviceKeyMissing);
});

test('openVault, the one door every unlock path uses, uses the page provider and keeps the failure types apart', async () => {
  const provider = fakeProvider();
  const sk = newSk();
  const { vault } = await sealed(provider, PK_A, '12345678', sk);
  setDeviceProvider(provider);
  try {
    assert.deepEqual(await openVault(vault, '12345678', PK_A), sk);
    await assert.rejects(() => openVault(vault, '00000000', PK_A), (e) => !(e instanceof DeviceKeyError));
  } finally {
    setDeviceProvider(null);
  }
  await assert.rejects(() => openVault(vault, '12345678', PK_A), DeviceKeyMissing);
  const v2 = await encryptKey(sk, '12345678');
  assert.deepEqual(await openVault(v2, '12345678', null), sk);
});
