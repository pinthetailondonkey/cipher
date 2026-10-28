import assert from 'node:assert/strict';
import test from 'node:test';
import { decryptKey, encryptKey, isLegacyVault } from '../useIdentity.js';
import { destroyDeviceKeys, sealNewVault, upgradeStoredVault } from './deviceLock.js';
import { DeviceKeyCancelled, DeviceKeyMissing, DeviceKeyUnavailable, isDeviceVault, makeSecretProvider } from './vaultEnvelope.js';

const PK = 'd'.repeat(64);
const OTHER = 'e'.repeat(64);
const PIN = '12345678';
const newSk = () => Array.from(crypto.getRandomValues(new Uint8Array(32)));

function memoryStorage(seed = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => { data.set(k, String(v)); },
    removeItem: (k) => { data.delete(k); },
    key: (i) => Array.from(data.keys())[i] ?? null,
    get length() { return data.size; },
    snapshot: () => JSON.stringify(Array.from(data.entries()).sort()),
  };
}

function fakeProvider({ failOn = null, secrets = new Map(), destroyed = [] } = {}) {
  const cache = new Map();
  const provider = makeSecretProvider({
    kind: 'prf',
    available: async () => true,
    enroll: async (pk) => {
      if (failOn === 'enroll') throw new DeviceKeyCancelled();
      secrets.set(pk, crypto.getRandomValues(new Uint8Array(32)));
      cache.set(pk, secrets.get(pk));
      return { k: 'prf', id: 'fake' };
    },
    getSecret: async (pk) => {
      if (failOn === 'get' && !cache.has(pk)) throw new DeviceKeyMissing('gone');
      if (cache.has(pk)) return cache.get(pk);
      const secret = secrets.get(pk);
      if (!secret) throw new DeviceKeyMissing('no-key');
      cache.set(pk, secret);
      return secret;
    },
    destroy: async (pk) => { secrets.delete(pk); cache.delete(pk); destroyed.push(pk); },
    forget: (pk) => { cache.delete(pk); },
  });
  return { provider, secrets, destroyed };
}

const deps = (provider) => ({
  provider,
  encrypt: encryptKey,
  open: (vault, pin, pk) => decryptKey(vault, pin, { pk, provider }),
  isLegacy: isLegacyVault,
});

async function legacyNoSalt(sk, pin) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), { name: 'PBKDF2' }, false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode('cipher_secure_salt'), iterations: 100000, hash: 'SHA-256' },
    material, { name: 'AES-GCM', length: 256 }, false, ['encrypt'],
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(sk)));
  return { iv: Array.from(iv), data: Array.from(new Uint8Array(data)) };
}

function seededStorage(vault, extra = {}) {
  return memoryStorage({
    cipher_vaults: JSON.stringify({ [PK]: { vault, handle: 'me', displayName: 'me', createdAt: 1, confirmed: true }, [OTHER]: { vault: { other: 1 }, handle: 'x' } }),
    cipher_vault: JSON.stringify(vault),
    cipher_active_pubkey: PK,
    ...extra,
  });
}

test('a new account is born under the device key, or not at all', async () => {
  const { provider } = fakeProvider();
  const sk = newSk();
  const vault = await sealNewVault({ ...deps(provider), pk: PK, pin: PIN, skArray: sk });
  assert.equal(isDeviceVault(vault), true);
  assert.deepEqual(await decryptKey(vault, PIN, { pk: PK, provider }), sk);
  // No provider: no PIN-only vault is ever made.
  await assert.rejects(() => sealNewVault({ ...deps(null), pk: PK, pin: PIN, skArray: sk }), DeviceKeyUnavailable);
  const unavailable = makeSecretProvider({ kind: 'prf', available: async () => false, enroll: async () => { throw new Error('no'); }, getSecret: async () => { throw new Error('no'); }, destroy: async () => {} });
  await assert.rejects(() => sealNewVault({ ...deps(unavailable), pk: PK, pin: PIN, skArray: sk }), DeviceKeyUnavailable);
});

test('a PIN vault is upgraded in place: entry and mirror move together, the inner PIN vault is unchanged', async () => {
  const { provider } = fakeProvider();
  const sk = newSk();
  const v2 = await encryptKey(sk, PIN);
  const storage = seededStorage(v2);
  const upgraded = await upgradeStoredVault({ ...deps(provider), storage, pk: PK, vault: v2, pin: PIN, skArray: sk, activePk: PK });
  assert.equal(isDeviceVault(upgraded), true);
  const entry = JSON.parse(storage.getItem('cipher_vaults'))[PK].vault;
  assert.deepEqual(entry, upgraded);
  assert.equal(storage.getItem('cipher_vault'), JSON.stringify(entry));
  assert.deepEqual(JSON.parse(storage.getItem('cipher_vaults'))[OTHER], { vault: { other: 1 }, handle: 'x' });
  assert.deepEqual(await decryptKey(entry, PIN, { pk: PK, provider }), sk);
  // The same call again is a no-op.
  assert.deepEqual(await upgradeStoredVault({ ...deps(provider), storage, pk: PK, vault: entry, pin: PIN, skArray: sk, activePk: PK }), entry);
});

test('a legacy no-salt vault is rebuilt as a current PIN vault and then wrapped', async () => {
  const { provider } = fakeProvider();
  const sk = newSk();
  const old = await legacyNoSalt(sk, PIN);
  const storage = seededStorage(old);
  const upgraded = await upgradeStoredVault({ ...deps(provider), storage, pk: PK, vault: old, pin: PIN, skArray: sk, activePk: PK });
  assert.equal(isDeviceVault(upgraded), true);
  assert.deepEqual(await decryptKey(upgraded, PIN, { pk: PK, provider }), sk);
  assert.equal(storage.getItem('cipher_vault'), JSON.stringify(upgraded));
});

test('an account that lived only in the single-vault slot gets its own entry and becomes active', async () => {
  const { provider } = fakeProvider();
  const sk = newSk();
  const v2 = await encryptKey(sk, PIN);
  const storage = memoryStorage({ cipher_vault: JSON.stringify(v2), cipher_handle: 'old' });
  const upgraded = await upgradeStoredVault({ ...deps(provider), storage, pk: PK, vault: v2, pin: PIN, skArray: sk, activePk: null });
  const entries = JSON.parse(storage.getItem('cipher_vaults'));
  assert.deepEqual(entries[PK].vault, upgraded);
  assert.equal(entries[PK].handle, 'old');
  assert.equal(storage.getItem('cipher_active_pubkey'), PK);
  assert.equal(storage.getItem('cipher_vault'), JSON.stringify(upgraded));
});

test('a failure at any step leaves the old vault exactly as it was and removes the new key', async () => {
  const sk = newSk();
  const v2 = await encryptKey(sk, PIN);

  for (const failOn of ['enroll', 'get']) {
    const { provider, secrets, destroyed } = fakeProvider({ failOn });
    const storage = seededStorage(v2);
    const before = storage.snapshot();
    await assert.rejects(() => upgradeStoredVault({ ...deps(provider), storage, pk: PK, vault: v2, pin: PIN, skArray: sk, activePk: PK }), (e) => e instanceof DeviceKeyCancelled || e instanceof DeviceKeyMissing);
    assert.equal(storage.snapshot(), before, failOn);
    if (failOn === 'get') {
      assert.deepEqual(destroyed, [PK]);
      assert.equal(secrets.has(PK), false);
    }
  }

  // The new vault does not give back the same key: refused, nothing written.
  const { provider, destroyed } = fakeProvider();
  const storage = seededStorage(v2);
  const before = storage.snapshot();
  const wrongOpen = async () => newSk();
  await assert.rejects(() => upgradeStoredVault({ ...deps(provider), open: wrongOpen, storage, pk: PK, vault: v2, pin: PIN, skArray: sk, activePk: PK }), DeviceKeyUnavailable);
  assert.equal(storage.snapshot(), before);
  assert.deepEqual(destroyed, [PK]);

  // No provider: explained, nothing written.
  const storage2 = seededStorage(v2);
  const before2 = storage2.snapshot();
  await assert.rejects(() => upgradeStoredVault({ ...deps(null), storage: storage2, pk: PK, vault: v2, pin: PIN, skArray: sk, activePk: PK }), DeviceKeyUnavailable);
  assert.equal(storage2.snapshot(), before2);
});

test('a storage write that fails halfway is rolled back, and the new key goes with it', async () => {
  const sk = newSk();
  const v2 = await encryptKey(sk, PIN);
  const { provider, destroyed } = fakeProvider();
  const storage = seededStorage(v2);
  const before = storage.snapshot();
  const realSet = storage.setItem;
  let writes = 0;
  storage.setItem = (k, v) => {
    if (k === 'cipher_vault' && JSON.parse(v).v === 3) { writes += 1; throw new Error('quota'); }
    realSet(k, v);
  };
  await assert.rejects(() => upgradeStoredVault({ ...deps(provider), storage, pk: PK, vault: v2, pin: PIN, skArray: sk, activePk: PK }), DeviceKeyUnavailable);
  storage.setItem = realSet;
  assert.equal(writes, 1);
  assert.equal(storage.snapshot(), before);
  assert.deepEqual(destroyed, [PK]);
});

test('the other account\'s mirror is not touched when this account is upgraded', async () => {
  const { provider } = fakeProvider();
  const sk = newSk();
  const v2 = await encryptKey(sk, PIN);
  const otherMirror = JSON.stringify({ someone: 'else' });
  const storage = seededStorage(v2, { cipher_vault: otherMirror, cipher_active_pubkey: OTHER });
  await upgradeStoredVault({ ...deps(provider), storage, pk: PK, vault: v2, pin: PIN, skArray: sk, activePk: OTHER });
  assert.equal(storage.getItem('cipher_vault'), otherMirror);
  assert.equal(isDeviceVault(JSON.parse(storage.getItem('cipher_vaults'))[PK].vault), true);
});

test('an account opened without its PIN (by passkey) is wrapped as it is and the check is the device layer alone', async () => {
  const { provider } = fakeProvider();
  const sk = newSk();
  const v2 = await encryptKey(sk, PIN);
  const old = await legacyNoSalt(sk, PIN);
  for (const vault of [v2, old]) {
    const storage = seededStorage(vault);
    const upgraded = await upgradeStoredVault({ ...deps(provider), storage, pk: PK, vault, pin: null, skArray: sk, activePk: PK });
    assert.equal(isDeviceVault(upgraded), true);
    assert.deepEqual(await decryptKey(upgraded, PIN, { pk: PK, provider }), sk);
    assert.equal(storage.getItem('cipher_vault'), JSON.stringify(upgraded));
  }
});

test('after the device key is destroyed a copy of the old vault is dead ciphertext, even with the right PIN', async () => {
  const { provider, secrets } = fakeProvider();
  const sk = newSk();
  const vault = await sealNewVault({ ...deps(provider), pk: PK, pin: PIN, skArray: sk });
  const copy = JSON.parse(JSON.stringify(vault));
  assert.deepEqual(await decryptKey(copy, PIN, { pk: PK, provider }), sk);
  assert.deepEqual(await destroyDeviceKeys(provider, [PK]), []);
  assert.equal(secrets.has(PK), false);
  await assert.rejects(() => decryptKey(copy, PIN, { pk: PK, provider }), DeviceKeyMissing);
});

test('restoring over an account makes a fresh device key, so the old vault copy cannot open any more', async () => {
  const { provider } = fakeProvider();
  const sk = newSk();
  const first = await sealNewVault({ ...deps(provider), pk: PK, pin: PIN, skArray: sk });
  const second = await sealNewVault({ ...deps(provider), pk: PK, pin: '87654321', skArray: sk });
  assert.deepEqual(await decryptKey(second, '87654321', { pk: PK, provider }), sk);
  await assert.rejects(() => decryptKey(first, PIN, { pk: PK, provider }), DeviceKeyMissing);
});

test('destroying keys never throws, never hangs, and reports what it could not confirm', async () => {
  const stuck = makeSecretProvider({
    kind: 'prf',
    available: async () => true,
    enroll: async () => ({ k: 'prf', id: 'x' }),
    getSecret: async () => new Uint8Array(32),
    destroy: async (pk) => { if (pk === 'hang') await new Promise(() => {}); if (pk === 'boom') throw new Error('native'); },
  });
  const started = Date.now();
  const failed = await destroyDeviceKeys(stuck, ['ok', 'hang', 'boom', ''], { timeoutMs: 50 });
  assert.deepEqual(failed.sort(), ['boom', 'hang']);
  assert.ok(Date.now() - started < 1000);
  assert.deepEqual(await destroyDeviceKeys(null, ['a']), []);
});
