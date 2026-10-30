import assert from 'node:assert/strict';
import test from 'node:test';
import { encryptKey, decryptKey, isLegacyVault } from '../useIdentity.js';
import { sealNewVault, upgradeStoredVault } from './deviceLock.js';
import { DeviceKeyCancelled, DeviceKeyUnavailable, makeSecretProvider } from './vaultEnvelope.js';

// The overwrite: enrolling a second time used to make a fresh secret and
// write it over the one an existing vault is wrapped under, so that vault
// became unopenable and the account was lost. A stored key is now reused, and
// a key is destroyed only when this attempt is the one that made it.

const PK = 'f'.repeat(64);
const PIN = '12345678';
const sk = () => Array.from(crypto.getRandomValues(new Uint8Array(32)));

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    get length() { return data.size; },
  };
}

// A provider that behaves like the real ones after the repair: an existing
// key is reused, a new one is made only when there is none.
function provider({ failVerify = false, cancelOnSecond = false } = {}) {
  const secrets = new Map();
  const calls = { enroll: 0, destroy: 0 };
  const provider = makeSecretProvider({
    kind: 'prf',
    available: async () => true,
    hasKey: async (pk) => secrets.has(pk),
    enroll: async (pk) => {
      calls.enroll += 1;
      if (secrets.has(pk)) {
        if (cancelOnSecond) throw new DeviceKeyCancelled();
        return { k: 'prf', id: 'existing' };
      }
      secrets.set(pk, crypto.getRandomValues(new Uint8Array(32)));
      return { k: 'prf', id: 'made' };
    },
    getSecret: async (pk) => {
      const secret = secrets.get(pk);
      if (!secret) throw new Error('no key');
      return secret;
    },
    destroy: async (pk) => { calls.destroy += 1; secrets.delete(pk); },
    forget: () => {},
  });
  if (failVerify) {
    // The read-back gives a different inner vault: the wrap did not hold.
    const seal = provider.seal;
    provider.seal = async (...args) => seal(...args);
    provider.open = async () => new TextEncoder().encode(JSON.stringify({ iv: [9], data: [9], tampered: true }));
  }
  return { provider, secrets, calls };
}

const deps = (p) => ({
  provider: p,
  encrypt: encryptKey,
  open: (vault, pin, pk) => decryptKey(vault, pin, { pk, provider: p }),
  isLegacy: isLegacyVault,
});

test('a key this device already holds is reused, and the stored vault still opens', async () => {
  const { provider: p, secrets, calls } = provider();
  const storage = memoryStorage();
  const keys = sk();
  const first = await upgradeStoredVault({ storage, pk: PK, vault: await encryptKey(keys, PIN), pin: PIN, skArray: keys, activePk: PK, ...deps(p) });
  const secretAfterFirst = secrets.get(PK);

  // A second wrap of the same account (an interrupted upgrade retried).
  const second = await upgradeStoredVault({ storage, pk: PK, vault: await encryptKey(keys, PIN), pin: PIN, skArray: keys, activePk: PK, ...deps(p) });
  assert.equal(calls.enroll, 2, 'enroll was asked twice');
  assert.equal(secrets.get(PK), secretAfterFirst, 'the secret was not replaced');
  // Both vaults open with the one device key, and the PIN.
  assert.deepEqual(await decryptKey(first, PIN, { pk: PK, provider: p }), keys);
  assert.deepEqual(await decryptKey(second, PIN, { pk: PK, provider: p }), keys);
});

test('a failed read-back does not destroy a key that was already there', async () => {
  const { provider: p, secrets, calls } = provider();
  // The account already has a key and a device vault that opens with it.
  const keys = sk();
  const vault = await sealNewVault({ pk: PK, pin: PIN, skArray: keys, ...deps(p) });
  const before = secrets.get(PK);
  assert.deepEqual(await decryptKey(vault, PIN, { pk: PK, provider: p }), keys);

  // Now a wrap whose read-back fails, on a stale copy of the account.
  const broken = provider({ failVerify: true });
  broken.secrets.set(PK, before);
  await assert.rejects(
    upgradeStoredVault({ storage: memoryStorage(), pk: PK, vault: await encryptKey(keys, PIN), pin: PIN, skArray: keys, activePk: PK, ...deps(broken.provider) }),
    (error) => error instanceof DeviceKeyUnavailable,
  );
  assert.equal(broken.secrets.get(PK), before, 'the pre-existing key survived the failure');
  assert.equal(broken.calls.destroy, 0, 'nothing was destroyed');
  // And the vault that was already stored still opens.
  assert.deepEqual(await decryptKey(vault, PIN, { pk: PK, provider: p }), keys);
  assert.equal(calls.destroy, 0);
});

test('a key made by a failed attempt is destroyed, so no orphan stays', async () => {
  const broken = provider({ failVerify: true });
  await assert.rejects(
    sealNewVault({ pk: PK, pin: PIN, skArray: sk(), ...deps(broken.provider) }),
    (error) => error instanceof DeviceKeyUnavailable,
  );
  assert.equal(broken.calls.destroy, 1);
  assert.equal(broken.secrets.has(PK), false);
});

test('a cancelled authenticator leaves the existing key alone', async () => {
  const { provider: p, secrets } = provider({ cancelOnSecond: true });
  const keys = sk();
  await sealNewVault({ pk: PK, pin: PIN, skArray: keys, ...deps(p) });
  const before = secrets.get(PK);
  await assert.rejects(
    sealNewVault({ pk: PK, pin: PIN, skArray: keys, ...deps(p) }),
    (error) => error instanceof DeviceKeyCancelled,
  );
  assert.equal(secrets.get(PK), before);
});

test('a storage write that fails puts the old vault back and keeps a reused key', async () => {
  const { provider: p, secrets, calls } = provider();
  const keys = sk();
  // A key already exists (a previous, interrupted attempt made it).
  await p.enroll(PK);
  const before = secrets.get(PK);
  const original = await encryptKey(keys, PIN);
  const storage = memoryStorage();
  storage.setItem('cipher_vaults', JSON.stringify({ [PK]: { vault: original, handle: 'a' } }));
  storage.setItem('cipher_active_pubkey', PK);
  const realSet = storage.setItem;
  // The first write of the new tables fails, as a full quota would.
  storage.setItem = (k, v) => {
    if (k === 'cipher_vaults') throw new Error('quota');
    realSet(k, v);
  };
  await assert.rejects(
    upgradeStoredVault({ storage, pk: PK, vault: await encryptKey(keys, PIN), pin: PIN, skArray: keys, activePk: PK, ...deps(p) }),
    (error) => error instanceof DeviceKeyUnavailable,
  );
  assert.equal(secrets.get(PK), before, 'the reused key is still here');
  assert.equal(calls.destroy, 0);
  // The entry on disk still holds the old PIN vault, not the new one.
  const entry = JSON.parse(storage.getItem('cipher_vaults') || '{}')[PK];
  assert.ok(entry?.vault?.salt, 'the vault on disk is still the original PIN vault');
});
