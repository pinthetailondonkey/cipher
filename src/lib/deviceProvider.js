// Which device key provider this page uses. One answer per environment:
// the browser's passkey (PRF) today; the operating system store on desktop and
// the Android Keystore are added where those platforms are built. Where none
// can hold a key, there is none, and the app does not create or keep accounts.

import { getDeviceProvider, setDeviceProvider } from './vaultEnvelope.js';
import { prfProvider } from './devicePrf.js';

const candidates = () => [prfProvider];

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
