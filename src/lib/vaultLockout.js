export const PIN_FAILURE_LIMIT = 5;
export const MIN_PIN_LENGTH = 6;

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
  resetPinFailures(storage, pubkey);
}

// Every path that decrypts a vault with a PIN counts a wrong PIN here, so the
// fifth one locks that account out whichever screen it was typed on.
export function failPinAttempt(storage, pubkey) {
  const result = recordPinFailure(storage, pubkey);
  if (result.lockedOut) removeAccountVault(storage, pubkey);
  return result;
}

export function pinFailureMessage(remaining) {
  const left = remaining === 1 ? '1 attempt left' : `${remaining} attempts left`;
  const warning = remaining <= 2
    ? ' The next lockout deletes this account from this device, including the encrypted recovery phrase stored here. Only the 12 words you wrote down can bring it back.'
    : '';
  return `Wrong PIN. ${left}.${warning}`;
}
