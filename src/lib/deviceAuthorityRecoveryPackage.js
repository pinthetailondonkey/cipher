// Optional encrypted digital copy of the recovery root. The 24-word paper
// backup remains the primary format; this package does not store that phrase.
import { argon2idAsync } from '@noble/hashes/argon2.js';
import { getPublicKey } from 'nostr-tools/pure';

const FORMAT = 'cipher-device-recovery-package-v1';
const MEMORY_KIB = 19_456;
const ITERATIONS = 2;
const PARALLELISM = 1;
const MIN_PASSPHRASE_CODEPOINTS = 12;
const encoder = new TextEncoder();

function validPubkey(value) { return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value); }
function validSecret(value) {
  if (!(value instanceof Uint8Array) || value.length !== 32) return false;
  try { getPublicKey(value); return true; } catch { return false; }
}
function requirePassphrase(value) {
  if (typeof value !== 'string' || value.trim().length === 0
    || Array.from(value).length < MIN_PASSPHRASE_CODEPOINTS) {
    throw new Error(`Use a recovery passphrase of at least ${MIN_PASSPHRASE_CODEPOINTS} characters.`);
  }
  return encoder.encode(value.normalize('NFKD'));
}
function secureRandom(length, randomBytes) {
  if (typeof randomBytes !== 'function') throw new Error('Secure randomness is unavailable for the recovery package.');
  const bytes = randomBytes(new Uint8Array(length));
  if (!(bytes instanceof Uint8Array) || bytes.length !== length) throw new Error('Secure randomness returned invalid recovery-package bytes.');
  return bytes;
}
function additionalData(accountPubkey, recoveryPubkey) {
  return encoder.encode(`${FORMAT}|${accountPubkey}|${recoveryPubkey}`);
}
async function deriveKey(passphraseBytes, salt) {
  return argon2idAsync(passphraseBytes, salt, {
    t: ITERATIONS, m: MEMORY_KIB, p: PARALLELISM, dkLen: 32, maxmem: 24 * 1024 * 1024,
  });
}

export async function sealDeviceRecoveryPackage({
  recoverySecret, accountPubkey, recoveryPubkey, passphrase,
  randomBytes = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto),
  cryptoImpl = globalThis.crypto,
} = {}) {
  if (!validSecret(recoverySecret) || !validPubkey(accountPubkey) || !validPubkey(recoveryPubkey)
    || accountPubkey === recoveryPubkey || getPublicKey(recoverySecret) !== recoveryPubkey || !cryptoImpl?.subtle) {
    throw new Error('A valid recovery root, matching recovery fingerprint, account, and WebCrypto are required.');
  }
  const password = requirePassphrase(passphrase);
  const salt = secureRandom(16, randomBytes);
  const iv = secureRandom(12, randomBytes);
  let keyBytes;
  try {
    keyBytes = await deriveKey(password, salt);
    const key = await cryptoImpl.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']);
    const ciphertext = await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv,
      additionalData: additionalData(accountPubkey, recoveryPubkey), tagLength: 128 }, key, recoverySecret);
    return { format: FORMAT, kdf: 'argon2id', version: 0x13, memoryKiB: MEMORY_KIB,
      iterations: ITERATIONS, parallelism: PARALLELISM, accountPubkey, recoveryPubkey,
      salt: Array.from(salt), iv: Array.from(iv), ciphertext: Array.from(new Uint8Array(ciphertext)) };
  } finally {
    password.fill(0);
    keyBytes?.fill(0);
  }
}

export async function openDeviceRecoveryPackage({
  package: backup, accountPubkey, recoveryPubkey, passphrase,
  cryptoImpl = globalThis.crypto,
} = {}) {
  if (backup?.format !== FORMAT || backup.kdf !== 'argon2id' || backup.version !== 0x13
    || backup.memoryKiB !== MEMORY_KIB || backup.iterations !== ITERATIONS || backup.parallelism !== PARALLELISM
    || backup.accountPubkey !== accountPubkey || backup.recoveryPubkey !== recoveryPubkey
    || !validPubkey(accountPubkey) || !validPubkey(recoveryPubkey) || accountPubkey === recoveryPubkey
    || !Array.isArray(backup.salt) || backup.salt.length !== 16
    || !Array.isArray(backup.iv) || backup.iv.length !== 12
    || !Array.isArray(backup.ciphertext) || backup.ciphertext.length !== 48
    || [...backup.salt, ...backup.iv, ...(Array.isArray(backup.ciphertext) ? backup.ciphertext : [])]
      .some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)
    || !cryptoImpl?.subtle) {
    throw new Error('The encrypted recovery package does not match this account and recovery fingerprint.');
  }
  const password = requirePassphrase(passphrase);
  let keyBytes;
  let recovered;
  try {
    keyBytes = await deriveKey(password, Uint8Array.from(backup.salt));
    const key = await cryptoImpl.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt']);
    const plaintext = await cryptoImpl.subtle.decrypt({ name: 'AES-GCM', iv: Uint8Array.from(backup.iv),
      additionalData: additionalData(accountPubkey, recoveryPubkey), tagLength: 128 }, key,
    Uint8Array.from(backup.ciphertext));
    recovered = new Uint8Array(plaintext);
    if (!validSecret(recovered) || getPublicKey(recovered) !== recoveryPubkey) {
      throw new Error('The recovery package does not contain the independently pinned recovery root.');
    }
    return recovered;
  } catch {
    recovered?.fill(0);
    throw new Error('The recovery package could not be opened with this passphrase and pinned identity.');
  } finally {
    password.fill(0);
    keyBytes?.fill(0);
  }
}

export const deviceAuthorityRecoveryPackageInternals = Object.freeze({ FORMAT, MEMORY_KIB, ITERATIONS, PARALLELISM });
