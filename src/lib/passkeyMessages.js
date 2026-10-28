// Plain words for a saved passkey that did not open the account.
//
// The browser throws DOMExceptions and nostr-passkey throws its own
// sentences ("Operation failed.", "Passkey unlock was cancelled."). None of
// that belongs on a screen someone is using to get back into their account.
// Two exceptions are our own words and are passed through by code, never by
// matching the string.

export const PASSKEY_CANCELLED = 'Passkey cancelled. Enter your PIN, or use your recovery phrase.';
export const PASSKEY_UNAVAILABLE = 'No saved passkey on this device. Enter your PIN, or use your recovery phrase.';
export const PASSKEY_FAILED = 'That passkey could not be used. Enter your PIN, or use your recovery phrase.';
export const PASSKEY_WRONG_ACCOUNT = 'This saved passkey belongs to a different account.';

const CANCEL_WORDS = /cancel|denied|abort|not allowed|timed out|timeout/i;
const UNAVAILABLE_WORDS = /no passkey|not found|not supported|not available|prf|no credential/i;
const WRONG_ACCOUNT_WORDS = /different account|identity mismatch/i;

// One code per plain message. A thrown DOMException carries its name
// ("NotAllowedError", "InvalidStateError"); a library sentence carries its
// words. Anything unrecognised is a plain failure, never the raw text.
export function passkeyFailureCode(error) {
  if (!error) return 'failed';
  const name = typeof error.name === 'string' ? error.name : '';
  const message = typeof error.message === 'string' ? error.message : String(error);
  if (WRONG_ACCOUNT_WORDS.test(message)) return 'wrong-account';
  if (name === 'InvalidStateError' || UNAVAILABLE_WORDS.test(message)) return 'unavailable';
  if (name === 'NotAllowedError' || name === 'AbortError' || CANCEL_WORDS.test(message)) return 'cancelled';
  return 'failed';
}

// Takes {code, error} from unlockWithBiometric, or a thrown error, and
// answers with a sentence a person can act on.
export function passkeyFailureMessage(result) {
  if (!result) return PASSKEY_FAILED;
  const code = result.code || passkeyFailureCode(result.error ?? result);
  if (code === 'wrong-account') return PASSKEY_WRONG_ACCOUNT;
  // Our own words, composed by the unlock path with the PIN length in them.
  if (code === 'new-pin' && typeof result.error === 'string' && result.error) return result.error;
  if (code === 'cancelled') return PASSKEY_CANCELLED;
  if (code === 'unavailable') return PASSKEY_UNAVAILABLE;
  return PASSKEY_FAILED;
}
