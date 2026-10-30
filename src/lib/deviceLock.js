// Putting a vault under the device key, and moving old vaults there.
//
// Every account is locked to the device it lives on: a vault that is not a
// device vault (v3) is never kept as it is. New vaults are born v3; old PIN
// vaults are upgraded in place at the next unlock. Both go through the same
// wrap-and-verify, and nothing is written to storage until the new vault has
// been opened again from scratch and gave back the same key.
//
// encrypt(skArray, pin) builds a PIN vault; open(vault, pin, pk) opens any
// vault (the caller's single door, which resolves the device provider).

import {
  DeviceKeyUnavailable,
  isDeviceKeyError,
  isDeviceVault,
  unwrapDeviceVault,
  wrapDeviceVault,
} from './vaultEnvelope.js';

const sameKey = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

async function destroyQuietly(provider, pk, dk) {
  try { await provider.destroy(pk, dk); } catch { /* nothing more can be done here */ }
}

// Builds a device vault around an inner PIN vault and proves it opens. If
// anything fails the device key made for it is destroyed, so no orphan stays.
async function wrapAndVerify({ provider, pk, pin, skArray, open, innerFor }) {
  // pin === null: the PIN is not known (the account was opened by its
  // passkey). The inner PIN vault is wrapped as it is and the check is that
  // the device layer gives that same inner vault back.
  if (!provider) throw new DeviceKeyUnavailable('no-provider');
  if (!(await provider.available())) throw new DeviceKeyUnavailable('unavailable');
  // Was a key already here before this call? If so it stays, whatever happens
  // below: the vault on disk may only open with it, and nothing in this
  // function has replaced that vault yet.
  const hadKey = typeof provider.hasKey === 'function' ? (await provider.hasKey(pk)) === true : false;
  // The authenticator step comes first, before the slow PIN hashing: some
  // browsers only accept it soon after the tap that started the action. An
  // existing key is reused by the provider, never overwritten.
  const dk = await provider.enroll(pk);
  try {
    provider.forget?.(pk);
    const inner = await innerFor();
    const vault = await wrapDeviceVault(provider, pk, dk, inner);
    // Read it back the way the next unlock will: secret fetched fresh.
    provider.forget?.(pk);
    if (pin === null) {
      const back = await unwrapDeviceVault(vault, pk, provider);
      if (JSON.stringify(back) !== JSON.stringify(inner)) throw new DeviceKeyUnavailable('verify-failed');
    } else {
      const back = await open(vault, pin, pk);
      if (!sameKey(back, skArray)) throw new DeviceKeyUnavailable('verify-failed');
    }
    return { vault, hadKey };
  } catch (error) {
    // Only a key made by this attempt is destroyed. Destroying a reused one
    // would be the same lockout the reuse is there to prevent.
    if (!hadKey) await destroyQuietly(provider, pk, dk);
    throw isDeviceKeyError(error) ? error : new DeviceKeyUnavailable('wrap-failed', error?.message);
  }
}

// A new account's vault (create, restore from words, new device). There is no
// PIN-only fallback: without a device key the account is not created.
export async function sealNewVault({ provider, pk, pin, skArray, encrypt, open }) {
  return (await wrapAndVerify({ provider, pk, pin, skArray, open, innerFor: () => encrypt(skArray, pin) })).vault;
}

function readVaults(storage) {
  try { return JSON.parse(storage.getItem('cipher_vaults') || '{}') || {}; } catch { return {}; }
}

// An existing vault that opened with the right PIN. If it is already a device
// vault it is returned as it is. Otherwise it is wrapped; a legacy no-salt
// vault is first rebuilt as a current PIN vault, exactly as unlock always did,
// and a current PIN vault is wrapped byte for byte. The entry and the
// cipher_vault mirror change together, or not at all.
export async function upgradeStoredVault({ storage, provider, pk, vault, pin, skArray, encrypt, open, isLegacy, activePk }) {
  if (isDeviceVault(vault)) return vault;
  const { vault: next, hadKey } = await wrapAndVerify({
    provider,
    pk,
    pin,
    skArray,
    open,
    innerFor: async () => (pin !== null && isLegacy(vault) ? encrypt(skArray, pin) : vault),
  });
  const before = {
    vaults: storage.getItem('cipher_vaults'),
    mirror: storage.getItem('cipher_vault'),
    active: storage.getItem('cipher_active_pubkey'),
  };
  try {
    const vaults = readVaults(storage);
    const entryBefore = vaults[pk]?.vault;
    // The mirror is rewritten when it held this account's vault, or when no
    // account was active (the single-vault layout), as unlock did before.
    const mirrorIsThis = before.mirror !== null
      && (!activePk || activePk === pk || (entryBefore && JSON.stringify(entryBefore) === before.mirror));
    if (vaults[pk]) {
      vaults[pk] = { ...vaults[pk], vault: next };
    } else {
      // An account that so far lived only in the single-vault slot gets its
      // own entry, because a device vault is bound to the account it names.
      const handle = storage.getItem('cipher_handle') || 'account';
      vaults[pk] = { vault: next, handle, displayName: handle, createdAt: Date.now(), confirmed: true };
      storage.setItem('cipher_active_pubkey', pk);
    }
    storage.setItem('cipher_vaults', JSON.stringify(vaults));
    if (mirrorIsThis) storage.setItem('cipher_vault', JSON.stringify(next));
  } catch (error) {
    // Put every slot back as it was. Only if that worked is the new key
    // destroyed; if storage will not even take the old values back, the key
    // stays, because the new vault may be the only one that opens.
    let restored = true;
    const put = (key, value) => {
      try {
        if (value === null) storage.removeItem(key); else storage.setItem(key, value);
      } catch { restored = false; }
    };
    put('cipher_vaults', before.vaults);
    put('cipher_vault', before.mirror);
    put('cipher_active_pubkey', before.active);
    // A reused key is never destroyed here: the restored vault still opens
    // with it. Only a key made for this attempt goes.
    if (restored && !hadKey) await destroyQuietly(provider, pk);
    throw new DeviceKeyUnavailable('write-failed', error?.message);
  }
  return next;
}

// Destroys the device key of each account. Never throws and never waits
// longer than timeoutMs: a wipe must finish even if a native store is slow.
// Returns the accounts whose key could not be confirmed destroyed.
export async function destroyDeviceKeys(provider, pubkeys, { timeoutMs = 2500 } = {}) {
  if (!provider) return [];
  const failed = [];
  const one = async (pk) => {
    try {
      await Promise.race([
        provider.destroy(pk),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
      ]);
    } catch {
      failed.push(pk);
    }
  };
  await Promise.all(pubkeys.filter(Boolean).map(one));
  return failed;
}
