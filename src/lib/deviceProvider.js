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
