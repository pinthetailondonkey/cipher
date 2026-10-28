// Bundled into a page by devicePrf.spec.js. Exposes the real provider and the
// real vault code on window so a virtual authenticator can drive them.
import { decryptKey, encryptKey } from '../../../src/useIdentity.js';
import { prfProvider } from '../../../src/lib/devicePrf.js';
import { setDeviceProvider, wrapDeviceVault } from '../../../src/lib/vaultEnvelope.js';

setDeviceProvider(prfProvider);

const describe = (error) => ({ name: error?.name, code: error?.code, message: error?.message });

window.H = {
  async enrollAndSeal(pk, pin, sk) {
    try {
      const dk = await prfProvider.enroll(pk);
      prfProvider.forget(pk);
      const inner = await encryptKey(sk, pin);
      const vault = await wrapDeviceVault(prfProvider, pk, dk, inner);
      return { ok: true, vault };
    } catch (error) { return { ok: false, error: describe(error) }; }
  },
  async open(pk, pin, vault, { fresh = true } = {}) {
    try {
      if (fresh) prfProvider.forget(pk);
      return { ok: true, sk: await decryptKey(vault, pin, { pk }) };
    } catch (error) { return { ok: false, error: describe(error) }; }
  },
  async destroy(pk) { await prfProvider.destroy(pk); },
  has: (pk) => localStorage.getItem(`cipher_devkey_${pk}`) !== null,
};
