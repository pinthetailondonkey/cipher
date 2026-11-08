// Offline recovery-root mnemonic helpers. This module never persists, sends,
// logs, or derives R from the account key or a relay record.
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { getPublicKey } from 'nostr-tools/pure';

const RECOVERY_WORD_COUNT = 24;
const CONFIRMATION_COUNT = 4;

function validSecret(secret) {
  if (!(secret instanceof Uint8Array) || secret.length !== 32) return false;
  try { getPublicKey(secret); return true; } catch { return false; }
}

function normalizePhrase(value) {
  if (Array.isArray(value)) value = value.join(' ');
  if (typeof value !== 'string') throw new Error('Enter the 24-word Cipher recovery phrase.');
  const words = value.trim().toLowerCase().split(/\s+/);
  if (words.length !== RECOVERY_WORD_COUNT) throw new Error('The Cipher recovery phrase must contain 24 words.');
  return words.join(' ');
}

function choosePositions(randomBytes) {
  if (typeof randomBytes !== 'function') throw new Error('Secure randomness is unavailable for recovery confirmation.');
  const chosen = new Set();
  for (let attempt = 0; attempt < 64 && chosen.size < CONFIRMATION_COUNT; attempt += 1) {
    const bytes = randomBytes(new Uint8Array(16));
    if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new Error('Secure randomness returned invalid confirmation bytes.');
    for (const byte of bytes) {
      if (byte >= 240) continue; // rejection sampling avoids modulo bias for 24 positions
      chosen.add(byte % RECOVERY_WORD_COUNT);
      if (chosen.size === CONFIRMATION_COUNT) break;
    }
  }
  if (chosen.size !== CONFIRMATION_COUNT) throw new Error('Could not create a recovery backup confirmation challenge.');
  return [...chosen].sort((left, right) => left - right);
}

export function prepareOfflineRecoveryBackup({
  recoverySecret, randomBytes = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto),
} = {}) {
  if (!validSecret(recoverySecret)) throw new Error('A valid independent recovery root is required.');
  const words = entropyToMnemonic(recoverySecret, wordlist).split(' ');
  if (words.length !== RECOVERY_WORD_COUNT) throw new Error('The recovery root did not encode as a 24-word phrase.');
  return {
    format: 'cipher-device-recovery-v1',
    words,
    confirmationPositions: choosePositions(randomBytes).map((index) => index + 1),
  };
}

// This catches transcription/handling errors before the caller confirms that
// the paper or offline copy is safely stored. It does not authenticate a user:
// anyone holding all 24 words holds R.
export function verifyOfflineRecoveryBackup({ recoverySecret, confirmationPositions, confirmationAnswers } = {}) {
  if (!validSecret(recoverySecret) || !Array.isArray(confirmationPositions)
    || confirmationPositions.length !== CONFIRMATION_COUNT || !Array.isArray(confirmationAnswers)
    || confirmationAnswers.length !== CONFIRMATION_COUNT) return false;
  const expectedWords = entropyToMnemonic(recoverySecret, wordlist).split(' ');
  const seen = new Set();
  return confirmationPositions.every((position, index) => {
    if (!Number.isInteger(position) || position < 1 || position > RECOVERY_WORD_COUNT || seen.has(position)) return false;
    seen.add(position);
    return typeof confirmationAnswers[index] === 'string'
      && confirmationAnswers[index].trim().toLowerCase() === expectedWords[position - 1];
  });
}

// Restore is bound to a recovery fingerprint already authenticated through an
// existing Cipher policy/contact ceremony. N, A, and a relay-supplied policy
// are deliberately not accepted as substitutes for expectedRecoveryPubkey.
export function restoreOfflineRecoverySecret({ phrase, expectedRecoveryPubkey } = {}) {
  const normalized = normalizePhrase(phrase);
  if (!/^[0-9a-f]{64}$/.test(expectedRecoveryPubkey || '')) throw new Error('An independently pinned recovery fingerprint is required.');
  let entropy;
  try { entropy = mnemonicToEntropy(normalized, wordlist); }
  catch { throw new Error('The recovery phrase is invalid or its checksum does not match.'); }
  if (!(entropy instanceof Uint8Array) || entropy.length !== 32) {
    entropy?.fill?.(0);
    throw new Error('The recovery phrase is not a 256-bit Cipher recovery key.');
  }
  try {
    if (getPublicKey(entropy) !== expectedRecoveryPubkey) throw new Error('The recovery phrase does not match the independently pinned recovery fingerprint.');
    return entropy;
  } catch (error) {
    entropy.fill(0);
    throw error;
  }
}
