import { DeviceKeyCancelled, DeviceKeyError, DeviceKeyUnavailable } from './vaultEnvelope.js';

export const PIN_FAILURE_LIMIT = 5;
// A NEW PIN (create, restore from words, recover on a fresh device) needs 8.
// An account made before that keeps its shorter PIN: unlocking never checks
// the new minimum, and relay-restore on this device only checks the old floor.
export const MIN_PIN_LENGTH = 8;
export const MIN_EXISTING_PIN_LENGTH = 6;

// Exactly eight digits, nothing else. The screens already cap the field at
// eight, so the central rule has to agree with them or a paste, a script or a
// future screen can mint a 9-digit "8-digit" PIN that the next screen refuses.
// Digits only: the field strips everything else, so a letter can never be a
// PIN. Unlocking and relay-restore never call this, so a 6-digit account made
// before the rule keeps opening with its own PIN.
export function isAcceptableNewPin(pin) {
  return typeof pin === 'string' && /^[0-9]{8}$/.test(pin);
}

// A vault envelope this device can still try to open. Anything else is a
// damaged copy, and asking a PIN of it would read the refusal as a wrong PIN
// and spend one of the five attempts that delete the account.
export function isDamagedVault(vault) {
  if (!vault || typeof vault !== 'object') return true;
  if (!Array.isArray(vault.iv) || !Array.isArray(vault.data)) return true;
  // KDF metadata: a current envelope carries salt (a non-empty byte array)
  // and iter (a positive number); a legacy envelope carries neither. A
  // present field of the wrong shape fails PBKDF2 before any PIN is tried,
  // so it answers damaged here rather than spend an attempt. What no guard
  // can see: metadata that is shaped right but wrong in value — a salt of
  // three bytes, say — derives a key that fails only at the GCM tag, exactly
  // like a wrong PIN. That failure is charged like one and cannot be told
  // apart; the lock-screen spec measures it.
  if (vault.salt !== undefined && !(Array.isArray(vault.salt) && vault.salt.length > 0)) return true;
  if (vault.iter !== undefined && !(typeof vault.iter === 'number' && Number.isFinite(vault.iter) && vault.iter >= 1)) return true;
  return false;
}

// An entry too short to be any account's PIN is not a guess: it is an empty
// or half-typed field. It is refused before the vault is touched and never
// counts toward the five-wrong-PINs wipe.
export function isPlausiblePin(pin) {
  return typeof pin === 'string' && pin.length >= MIN_EXISTING_PIN_LENGTH;
}

export const PIN_TOO_SHORT_MESSAGE = `Enter your PIN (${MIN_EXISTING_PIN_LENGTH} digits or more). Nothing was counted.`;

export function pinFailureKey(pubkey) {
  return pubkey ? `cipher_fails_${pubkey}` : 'cipher_fails_legacy';
}

export function readPinFailures(storage, pubkey) {
  const value = parseInt(storage.getItem(pinFailureKey(pubkey)) || '0', 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function resetPinFailures(storage, pubkey) {
  storage.removeItem(pinFailureKey(pubkey));
  storage.removeItem('cipher_fails');
}

export function recordPinFailure(storage, pubkey) {
  const fails = readPinFailures(storage, pubkey) + 1;
  storage.setItem(pinFailureKey(pubkey), String(fails));
  const remaining = Math.max(0, PIN_FAILURE_LIMIT - fails);
  return { fails, remaining, lockedOut: fails >= PIN_FAILURE_LIMIT };
}

export const LOCKED_OUT_MESSAGE = 'Five wrong PINs. This account was removed from this device. Only its 12 words can bring it back.';

// Removes one account's vault from this device. The legacy single-vault keys
// go only when they hold this account's vault. Other accounts stay intact.
export function removeAccountVault(storage, pubkey) {
  let vaults = {};
  try {
    vaults = JSON.parse(storage.getItem('cipher_vaults') || '{}') || {};
  } catch {
    vaults = {};
  }
  const legacy = storage.getItem('cipher_vault');
  const entry = pubkey ? vaults[pubkey] : null;
  const legacyIsThis = !!legacy && (!pubkey || !entry || JSON.stringify(entry.vault) === legacy);
  if (pubkey) delete vaults[pubkey];
  storage.setItem('cipher_vaults', JSON.stringify(vaults));
  if (legacyIsThis) {
    storage.removeItem('cipher_vault');
    storage.removeItem('cipher_handle');
  }
  if (!pubkey || storage.getItem('cipher_active_pubkey') === pubkey) storage.removeItem('cipher_active_pubkey');
  // The device key's stored record goes with the vault it locked. (Keys held
  // outside storage are destroyed by the caller: storage cannot reach them.)
  if (pubkey) storage.removeItem(`cipher_devkey_${pubkey}`);
  resetPinFailures(storage, pubkey);
}

function storageKeys(storage) {
  const keys = [];
  const count = Number(storage.length) || 0;
  for (let i = 0; i < count; i += 1) {
    const key = storage.key(i);
    if (key) keys.push(key);
  }
  return keys;
}

// Everything this device keeps for one account outside its vault: scoped
// settings, receipts and drafts, the passkey wrapper, the group list, and the
// pointers that name it. A scoped prefix shared with another saved account is
// left alone so that account's settings survive. The database is separate.
export function removeAccountKeys(storage, pubkey) {
  if (!pubkey) return [];
  let others = [];
  try {
    others = Object.keys(JSON.parse(storage.getItem('cipher_vaults') || '{}') || {}).filter((pk) => pk !== pubkey);
  } catch {
    others = [];
  }
  const prefix = pubkey.slice(0, 8);
  const sharedScope = others.some((pk) => pk.slice(0, 8) === prefix);
  const exact = new Set([
    `cipher_passkey_${pubkey}`,
    `cipher_devkey_${pubkey}`,
    pinFailureKey(pubkey),
    `cipher_my_groups_${pubkey.slice(0, 16)}`,
    `cipher_migrated_v1_${prefix}`,
  ]);
  const removed = storageKeys(storage).filter((key) => exact.has(key)
    // The full-pubkey drawer is this account's alone, whatever prefixes are
    // saved on the device. (security A2)
    || key.startsWith(`cipher_${pubkey}_`)
    || (!sharedScope && key.startsWith(`cipher_${prefix}_`)));
  if (storage.getItem('cipher_biometric_pubkey') === pubkey) removed.push('cipher_biometric_pubkey', 'cipher_biometric_enabled');
  for (const pointer of ['cipher_db_owner', 'cipher_last_user', 'cipher_active_pubkey']) {
    if (storage.getItem(pointer) === pubkey) removed.push(pointer);
  }
  removed.forEach((key) => storage.removeItem(key));
  return removed;
}

// Every path that decrypts a vault with a PIN counts a wrong PIN here, so the
// fifth one locks that account out whichever screen it was typed on. The
// caller still deletes the account's database, which storage cannot reach.
export function failPinAttempt(storage, pubkey) {
  const result = recordPinFailure(storage, pubkey);
  if (result.lockedOut) {
    removeAccountVault(storage, pubkey);
    removeAccountKeys(storage, pubkey);
  }
  return result;
}

// The unlock paths call this for every failed open. Only a wrong PIN is a
// guess and only a guess counts toward the wipe. A cancelled device prompt, a
// missing device key or an unusable provider is not a PIN guess: it never
// touches the counter, so the wipe cannot be triggered by closing a dialog or
// by moving the files, and a real lockout still needs the device in hand.
export function failUnlockAttempt(storage, pubkey, error) {
  if (error instanceof DeviceKeyError) {
    return {
      counted: false,
      lockedOut: false,
      remaining: Math.max(0, PIN_FAILURE_LIMIT - readPinFailures(storage, pubkey)),
      deviceKey: error.code,
    };
  }
  return { counted: true, ...failPinAttempt(storage, pubkey) };
}

export function deviceKeyFailureMessage(error) {
  if (error instanceof DeviceKeyCancelled) {
    return 'The device prompt was cancelled, so nothing was counted. Try again when you are ready.';
  }
  if (error instanceof DeviceKeyUnavailable) {
    return 'This device cannot lock an account to itself, so it cannot open this one. Restore the account from its 12 words on a device that can.';
  }
  return 'This device no longer holds the key to this account. Nothing was counted and nothing was deleted. Restore the account with its 12 words.';
}

// Shown when the PIN was right but the account could not be locked to this
// device. Nothing was changed and the person is not let in as they are.
export function deviceLockUpgradeMessage(error) {
  if (error instanceof DeviceKeyCancelled) {
    return 'Your PIN is right, but this account must be locked to this device before it opens. The prompt was cancelled and nothing changed. Enter your PIN again to try once more.';
  }
  if (error instanceof DeviceKeyUnavailable) {
    return 'Your PIN is right, but this device cannot lock an account to itself, and Cipher no longer opens accounts that are not locked. Nothing was deleted. Restore the account from its 12 words on a device that can.';
  }
  return 'Your PIN is right, but this account could not be locked to this device. Nothing changed and nothing was deleted. Try again, or restore the account from its 12 words.';
}

export function pinFailureMessage(remaining) {
  const left = remaining === 1 ? '1 attempt left' : `${remaining} attempts left`;
  const warning = remaining <= 2
    ? ' The next lockout deletes this account from this device, including the encrypted recovery phrase stored here. Only the 12 words you wrote down can bring it back.'
    : '';
  return `Wrong PIN. ${left}.${warning}`;
}
