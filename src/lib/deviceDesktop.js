// Desktop device key: the secret never enters the page. The desktop shell
// (desktop/src/deviceKey.js) holds it in the main process sealed by the
// operating system, and this provider is only the asking voice: the same
// seal/open/destroy the passkey provider does in the browser, done across
// the preload bridge. Every refusal comes back as a plain {ok, code} shape
// (an Error's class would not survive the IPC boundary) and is turned into
// the same typed DeviceKeyErrors, so the PIN counter treats them the same
// way: none of them is ever a wrong PIN.

import { DeviceKeyMissing, DeviceKeyUnavailable } from './vaultEnvelope.js';

const KIND = 'safe';

const bridge = () => (typeof window === 'undefined' ? undefined : window.cipherDeviceKey);

const UNAVAILABLE_CODES = ['not-available', 'basic-text', 'no-safe-storage', 'unreadable'];

function typed(result) {
  if (result?.ok === true) return result;
  const code = result?.code || 'missing';
  if (UNAVAILABLE_CODES.includes(code)) {
    throw new DeviceKeyUnavailable(code, result?.message);
  }
  throw new DeviceKeyMissing(code, result?.message);
}

export const desktopProvider = {
  kind: KIND,
  // Never throws: a page without the bridge (the browser build) simply has
  // no desktop key, and the passkey provider is asked next.
  async available() {
    try {
      return (await bridge()?.available())?.ok === true;
    } catch {
      return false;
    }
  },
  async enroll(pk) {
    return typed(await bridge().enroll(pk)).dk;
  },
  async seal(pk, dk, bytes, aad) {
    return typed(await bridge().seal(pk, dk?.id, bytes, aad)).blob;
  },
  async open(pk, dk, blob, aad) {
    return typed(await bridge().open(pk, dk?.id, blob, aad)).bytes;
  },
  async destroy(pk, dk) {
    await typed(await bridge().destroy(pk, dk?.id));
  },
};
