// Which device key provider this page uses. One answer per environment:
// the operating system store on desktop first (the page is served from a
// loopback address, which WebAuthn cannot use), then the browser's passkey
// (PRF); the Android Keystore is added where that platform is built. Where
// none can hold a key, there is none, and the app does not create or keep
// accounts.

import { getDeviceProvider, setDeviceProvider } from './vaultEnvelope.js';
import { desktopProvider } from './deviceDesktop.js';
import { prfProvider } from './devicePrf.js';

const candidates = () => [desktopProvider, prfProvider];

export async function ensureDeviceProvider() {
  const current = getDeviceProvider();
  if (current) return current;
  for (const candidate of candidates()) {
    try {
      if (await candidate.available()) {
        setDeviceProvider(candidate);
        return candidate;
      }
    } catch { /* a provider that cannot even answer is not available */ }
  }
  return null;
}

// Drop only the in-memory copy for an account being locked. Providers without
// a page-memory cache may omit this method.
export function forgetDeviceProviderSecret(pubkey) {
  if (!pubkey) return false;
  const provider = getDeviceProvider();
  if (typeof provider?.forget !== 'function') return true;
  provider.forget(pubkey);
  return true;
}

// One plain sentence for a screen that must say why it cannot go on. The
// check runs before any recovery words are asked for: a device that cannot
// hold a key cannot make or take an account, and telling someone after their
// words are on screen is too late.
export const DEVICE_UNAVAILABLE_COPY = 'This device cannot lock an account to itself. Cipher accounts are locked to the device they are made on, so a new one cannot be made here. Open Cipher where the device can keep a key, and try again.';

export async function deviceLockReady() {
  try {
    return !!(await ensureDeviceProvider());
  } catch {
    return false;
  }
}
