// The one-scan path: both PRF outputs from a single credentials.get().
//
// nostr-passkey's unlock asks for one input and returns one key. It has no
// argument for a second input, and it holds no second record, so this is the
// one place that talks to the authenticator directly. Everything it computes
// is in prfTwoInput.js, and the first key it derives is proved equal to the
// library's before any vault is written — a mismatch here would lock people
// out of vaults that work today.
//
// The account key it seals is the same 32-byte account secret the PIN vault
// holds. It is not the device secret: losing one must not open the other.
//
// LIMIT, stated where the code lives and not only in a commit message: a
// virtual authenticator is not a phone. Chromium's CDP authenticator proves
// this code path, and nothing about iOS or Android returning a second output.
// If a platform drops it, this refuses as DeviceKeyMissing — so the device
// path stands down and the PIN keeps working. That is what makes it safe to
// carry forward before a phone has said anything.

import {
  DeviceKeyCancelled,
  DeviceKeyMissing,
  DeviceKeyUnavailable,
} from './vaultEnvelope.js';
import {
  base64UrlToBytes,
  bytesToBase64Url,
  deriveLibraryKey,
  deriveWalletKey,
  devicePrfInput,
  hasSecondKey,
  normalizePrfOutput,
  openAccountKey,
  sealAccountKey,
  walletPrfInput,
  withSecondKey,
} from './prfTwoInput.js';

// Same classification the rest of the device-key code uses: a dismissed prompt
// is not a missing key, and a browser without PRF is not a wrong PIN.
function classify(error) {
  if (error?.name === 'AbortError' || error?.name === 'NotAllowedError') return new DeviceKeyCancelled();
  if (error?.name === 'SecurityError' || error?.name === 'NotSupportedError') {
    return new DeviceKeyUnavailable('webauthn-refused', error.message);
  }
  return new DeviceKeyMissing('prf-failed', error?.message);
}

// One gesture, two inputs, two outputs. This is the whole ceremony.
//
// salt1 and salt2 are BYTES. A stored salt is base64url text, so the caller
// decodes it first: passing the text was a silent wrong key in the lab.
export async function requestTwoOutputs({ credentialId, rpId, salt1, salt2, credentials = globalThis.navigator?.credentials }) {
  if (!credentials?.get) throw new DeviceKeyUnavailable('no-webauthn');
  const first = await devicePrfInput(salt1);
  const second = await walletPrfInput(salt2);
  let credential;
  try {
    credential = await credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rpId,
        allowCredentials: [{ id: base64UrlToBytes(credentialId), type: 'public-key' }],
        userVerification: 'required',
        extensions: { prf: { eval: { first, second } } },
      },
    });
  } catch (error) {
    throw classify(error);
  }
  if (!credential) throw new DeviceKeyCancelled();
  let results;
  try {
    results = credential.getClientExtensionResults?.().prf?.results;
  } catch {
    results = null;
  }
  // A platform that answers the first input and drops the second is not a
  // failure of the account: it means this device cannot do one scan yet, and
  // the PIN keeps working. DeviceKeyMissing keeps it out of the PIN counter.
  if (!results?.first) throw new DeviceKeyMissing('prf-failed');
  if (!results?.second) throw new DeviceKeyMissing('second-input-missing');
  return {
    first: await normalizePrfOutput(results.first),
    second: await normalizePrfOutput(results.second),
  };
}

// Opens the account with one scan. Throws a DeviceKeyError for every way the
// device path can go wrong, so the caller reads a refusal and never a wrong
// PIN: the person may be holding the right phone and typing the right PIN.
export async function openAccountWithOneScan({ pk, vault, outputs }) {
  const dk = vault?.dk;
  if (!hasSecondKey(vault)) throw new DeviceKeyMissing('no-second-key');
  if (vault.v !== 3) throw new DeviceKeyMissing('malformed');
  const salt2 = base64UrlToBytes(dk.salt2);
  const walletKey = await deriveWalletKey(outputs.second, salt2);
  return openAccountKey(vault.wallet, walletKey, pk);
}

// Seals the account key under the second input and returns the next vault
// object — v, dk.k and the device layer are carried over untouched. Callers
// write it to storage themselves.
//
// salt2 is the SAME salt the outputs were asked with, and it is what gets
// stored: the second key is only reproducible from that salt, so writing a
// fresh one here would make a working migration that no later scan can open.
// That is the kind of bug a single-run lab cannot see, so the lab now unlocks
// twice.
//
// A vault that already carries a working second key is refused unless
// `replace` is set: replacing a working key silently is how a person ends up
// with a phone that opens an account it should not. The corrupted case is the
// one that MUST be replaceable — a half-written or stale second key refuses to
// open, the person uses the PIN, and this rewrites it.
export async function migrateToSecondKey({ pk, vault, accountSecret, outputs, salt2, replace = false }) {
  if (!vault || vault.v !== 3 || !vault.dk || typeof vault.dk.k !== 'string') throw new DeviceKeyMissing('malformed');
  // Bytes, not the stored base64url text: a string here is a silent wrong key.
  if (!(salt2 instanceof Uint8Array) || salt2.length === 0) throw new DeviceKeyMissing('missing-salt');
  if (hasSecondKey(vault) && !replace) throw new DeviceKeyUnavailable('second-key-present');
  const walletKey = await deriveWalletKey(outputs.second, salt2);
  const wallet = await sealAccountKey(accountSecret, walletKey, pk);
  // Prove the blob opens before anyone depends on it. A seal that cannot be
  // read back is a refusal now, not a locked-out person later.
  const check = await openAccountKey(wallet, walletKey, pk);
  const same = check.length === accountSecret.length && check.every((byte, i) => byte === accountSecret[i]);
  if (!same) throw new DeviceKeyMissing('seal-verify-failed');
  return withSecondKey(vault, { salt2: bytesToBase64Url(salt2), wallet });
}

// The first half of the proof that this page derives what the library derives.
// Given the same inputs, both must produce the same unwrapped device secret.
export async function deviceKeyFromFirst(outputs, recordSaltBytes) {
  return deriveLibraryKey(outputs.first, recordSaltBytes);
}
