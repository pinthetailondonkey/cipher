// Browser device key: a random 32-byte secret held under a passkey's PRF.
//
// nostr-passkey (already a dependency) wraps a 32-byte secret under the
// authenticator's PRF output and keeps only the wrapped copy in localStorage
// (cipher_devkey_<pk>). We hand it a random 32 bytes instead of a Nostr key:
// the secret never sits in storage in the clear, and unwrapping it needs the
// authenticator on this device (or the person's synced passkeys). A copy of
// the stored files carries the wrapped secret but not the authenticator.
//
// Every seal or open needs the secret. It is kept in memory for the life of
// the page once fetched, so an upgrade or a session does not prompt for the
// authenticator over and over; forget() drops it.

import {
  DeviceKeyCancelled,
  DeviceKeyMissing,
  DeviceKeyUnavailable,
  makeSecretProvider,
} from './vaultEnvelope.js';

const KIND = 'prf';
export const prfStorageKey = (pk) => `cipher_devkey_${pk}`;

const secrets = new Map();

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// The browser says "not allowed" both when the person dismisses the prompt and
// when the authenticator does not hold the credential. Neither is a wrong PIN.
function classify(error) {
  if (error?.name === 'AbortError' || error?.name === 'NotAllowedError') return new DeviceKeyCancelled();
  if (error?.name === 'SecurityError' || error?.name === 'NotSupportedError') {
    return new DeviceKeyUnavailable('webauthn-refused', error.message);
  }
  return new DeviceKeyMissing('prf-failed', error?.message);
}

// A WebAuthn relying-party id must be a domain name; an IP address is not one.
function hostCanBeRpId(hostname) {
  if (!hostname) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false;
  if (hostname.includes(':')) return false;
  return true;
}

export function prfEnvironmentProblem(env = globalThis) {
  const win = env.window || env;
  const loc = env.location || win.location;
  if (!win.PublicKeyCredential) return 'no-webauthn';
  if (typeof env.navigator?.credentials?.create !== 'function') return 'no-webauthn';
  if (win.isSecureContext === false) return 'insecure-context';
  if (!hostCanBeRpId(loc?.hostname)) return 'bad-rp-id';
  return '';
}

async function readPasskeyLib() {
  return import('nostr-passkey');
}

async function loadSecret(pk) {
  const cached = secrets.get(pk);
  if (cached) return cached;
  const lib = await readPasskeyLib();
  const options = { storageKey: prfStorageKey(pk) };
  if (!lib.hasStoredPasskeyIdentity(options)) throw new DeviceKeyMissing('no-record');
  let result;
  try {
    result = await lib.unlockPasskeyIdentity(undefined, options);
  } catch (error) {
    throw classify(error);
  }
  if (!(result?.secretKey instanceof Uint8Array) || result.secretKey.length !== 32) {
    throw new DeviceKeyMissing('prf-failed');
  }
  secrets.set(pk, result.secretKey);
  return result.secretKey;
}

export const prfProvider = makeSecretProvider({
  kind: KIND,
  async available() {
    return prfEnvironmentProblem() === '';
  },
  // Makes the passkey and the wrapped secret. Needs a person at the screen:
  // the browser asks for their fingerprint, face or security key.
  async enroll(pk) {
    const problem = prfEnvironmentProblem();
    if (problem) throw new DeviceKeyUnavailable(problem);
    const lib = await readPasskeyLib();
    const options = { rpName: 'Cipher', userName: 'cipher device lock', displayName: 'Cipher device lock', storageKey: prfStorageKey(pk) };
    let secret;
    let created;
    // 32 random bytes are a valid secp256k1 scalar except with negligible
    // probability; the library insists on one, so retry rather than assume.
    for (let attempt = 0; attempt < 4 && !created; attempt += 1) {
      secret = crypto.getRandomValues(new Uint8Array(32));
      try {
        created = await lib.importPasskeyIdentityFromNsec(toHex(secret), options);
      } catch (error) {
        lib.clearPasskeyIdentity(options);
        if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') throw new DeviceKeyCancelled();
        if (/PRF extension required/i.test(error?.message || '')) throw new DeviceKeyUnavailable('no-prf');
        if (/Passkeys are not supported/i.test(error?.message || '')) throw new DeviceKeyUnavailable('no-webauthn');
        if (attempt === 3) throw classify(error);
      }
    }
    secrets.set(pk, secret);
    return { k: KIND, id: created.record.credentialId, rpId: created.record.rpId };
  },
  getSecret: (pk) => loadSecret(pk),
  async destroy(pk) {
    secrets.delete(pk);
    try {
      (await readPasskeyLib()).clearPasskeyIdentity({ storageKey: prfStorageKey(pk) });
    } catch {
      // Falls through to the plain removal below.
    }
    try { localStorage.removeItem(prfStorageKey(pk)); } catch { /* storage may be unavailable */ }
  },
  // Forgets the in-memory secret so the next use asks the authenticator again.
  // The upgrade uses this to prove the stored copy, not just memory, opens.
  forget(pk) {
    if (pk) secrets.delete(pk); else secrets.clear();
  },
});
