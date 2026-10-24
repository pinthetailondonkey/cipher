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

export function pinFailureMessage(remaining) {
  const left = remaining === 1 ? '1 attempt left' : `${remaining} attempts left`;
  const warning = remaining <= 2
    ? ' The next lockout deletes this account from this device, including the encrypted recovery phrase stored here. Only the 12 words you wrote down can bring it back.'
    : '';
  return `Wrong PIN. ${left}.${warning}`;
}
