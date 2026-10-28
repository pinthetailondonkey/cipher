'use strict';
// The desktop's device key: a random 32-byte secret that never enters the
// page. The main process keeps it in a file under the data folder, sealed
// with safeStorage (DPAPI on Windows, Keychain on macOS, libsecret/kwallet
// on Linux), and does the vault envelope's AES layer itself; the page can
// only ask for seal, open and destroy. A copy of the data folder carries
// the sealed file but not the operating system's key, which is the whole
// point of a device lock (docs/DESKTOP.md portability loses to it by
// founder ruling 2026-10-28: no PIN-only accounts).
//
// The AES layer matches the browser provider byte for byte (src/lib/
// vaultEnvelope.js): HKDF-SHA256(salt 32 zero bytes, info 'cipher-vault-3')
// to an AES-256-GCM key, and the blob layout iv[12] + ciphertext||tag, the
// shape WebCrypto emits. desktop/test proves that equivalence with node's
// own webcrypto.

const { hkdfSync, createCipheriv, createDecipheriv } = require('node:crypto');
const { join } = require('node:path');

const HKDF_SALT = Buffer.alloc(32);
const HKDF_INFO = Buffer.from('cipher-vault-3', 'utf8');
const DEVKEY_ID = 'cipher-devkey';

// A pubkey is hex, so it is always a safe filename; anything else never
// reaches the disk.
function isAccountKey(pk) {
  return typeof pk === 'string' && /^[0-9a-f]{16,128}$/i.test(pk);
}

function fileFor(dir, pk) {
  return join(dir, `devkey-${pk}.bin`);
}

// Why the device cannot hold a key, in one code. 'basic-text' is Linux with
// no keyring: Electron would store a hardcoded password in the file, which
// protects nothing, so it is treated as no protection at all. Tails is this
// case by design.
function storageProblem(safeStorage, platform) {
  if (typeof safeStorage?.isEncryptionAvailable !== 'function') return 'no-safe-storage';
  try {
    if (!safeStorage.isEncryptionAvailable()) return 'not-available';
  } catch {
    return 'not-available';
  }
  if (platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function') {
    try {
      if (safeStorage.getSelectedStorageBackend() === 'basic_text') return 'basic-text';
    } catch { /* the backend call is a hint, never a reason to crash */ }
  }
  return '';
}

function aesKey(secret) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secret), HKDF_SALT, HKDF_INFO, 32));
}

const asBytes = (value) => Uint8Array.from(value || []);

// Everything the handlers need, with the electron pieces injected so plain
// node can test it. Results are plain objects, never thrown Errors, so the
// class survives the IPC boundary: { ok: true, ... } | { ok: false, code }.
function createDeviceKeyBackend({ safeStorage, fs, dir, randomBytes, platform = process.platform }) {
  if (!fs || typeof dir !== 'string') throw new Error('device key backend needs a filesystem and a data folder');

  const badAccount = () => ({ ok: false, code: 'bad-account', message: 'Not an account this device knows.' });
  const unavailable = (code) => ({
    ok: false,
    code,
    message: 'This device cannot lock an account to itself, so it cannot open one either.',
  });

  // The secret for one account, or null when this device does not hold it.
  const secretFor = (pk) => {
    const file = fileFor(dir, pk);
    let sealed;
    try {
      sealed = fs.readFileSync(file);
    } catch {
      return null;
    }
    try {
      const secret = Buffer.from(safeStorage.decryptString(sealed), 'base64');
      if (secret.length !== 32) return null;
      return secret;
    } catch {
      return null;
    }
  };

  return {
    available() {
      const problem = storageProblem(safeStorage, platform);
      return problem ? { ok: false, code: problem } : { ok: true };
    },

    enroll(pk) {
      if (!isAccountKey(pk)) return badAccount();
      const problem = storageProblem(safeStorage, platform);
      if (problem) return unavailable(problem);
      const secret = randomBytes(32);
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(fileFor(dir, pk), safeStorage.encryptString(secret.toString('base64')), { mode: 0o600 });
      } catch (e) {
        return { ok: false, code: 'unreadable', message: `The device key could not be written. (${e.message})` };
      }
      return { ok: true, dk: { k: 'safe', id: DEVKEY_ID } };
    },

    seal(pk, id, plain, aad) {
      if (!isAccountKey(pk)) return badAccount();
      const problem = storageProblem(safeStorage, platform);
      if (problem) return unavailable(problem);
      const secret = secretFor(pk);
      if (!secret) return { ok: false, code: 'missing', message: 'This device no longer holds the key to this account.' };
      try {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', aesKey(secret), iv);
        cipher.setAAD(Buffer.from(asBytes(aad)));
        const data = Buffer.concat([cipher.update(Buffer.from(asBytes(plain))), cipher.final(), cipher.getAuthTag()]);
        return { ok: true, blob: { iv: Array.from(iv), data: Array.from(data) } };
      } catch (e) {
        return { ok: false, code: 'wrong-key', message: e.message };
      }
    },

    open(pk, id, blob, aad) {
      if (!isAccountKey(pk)) return badAccount();
      if (!blob || !Array.isArray(blob.iv) || blob.iv.length !== 12 || !Array.isArray(blob.data) || blob.data.length < 16) {
        return { ok: false, code: 'malformed', message: 'This account is not wrapped the way this device expects.' };
      }
      const secret = secretFor(pk);
      if (!secret) return { ok: false, code: 'missing', message: 'This device no longer holds the key to this account.' };
      try {
        const data = Buffer.from(blob.data);
        const decipher = createDecipheriv('aes-256-gcm', aesKey(secret), Buffer.from(blob.iv));
        decipher.setAAD(Buffer.from(asBytes(aad)));
        decipher.setAuthTag(data.subarray(data.length - 16));
        const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]);
        return { ok: true, bytes: new Uint8Array(plain) };
      } catch {
        return { ok: false, code: 'wrong-key', message: 'This device no longer holds the key to this account.' };
      }
    },

    destroy(pk) {
      if (!isAccountKey(pk)) return badAccount();
      try {
        fs.rmSync(fileFor(dir, pk), { force: true });
      } catch (e) {
        return { ok: false, code: 'unreadable', message: `The device key could not be removed. (${e.message})` };
      }
      return { ok: true };
    },
  };
}

// Wire the backend to ipcMain. Only the app's own page (the loopback UI
// server) may ask; anything else - a second window, a hijacked frame - is
// refused, which is the same line windowPolicy draws for everything else.
function registerDeviceKeyIpc({ ipcMain, backend, isAllowed }) {
  const guard = (handler) => (event, ...args) => {
    if (!isAllowed(event)) {
      return { ok: false, code: 'refused', message: 'This window cannot use the device key.' };
    }
    return handler(...args);
  };
  ipcMain.handle('cipher-device-key:available', guard(() => backend.available()));
  ipcMain.handle('cipher-device-key:enroll', guard((pk) => backend.enroll(pk)));
  ipcMain.handle('cipher-device-key:seal', guard((pk, id, plain, aad) => backend.seal(pk, id, plain, aad)));
  ipcMain.handle('cipher-device-key:open', guard((pk, id, blob, aad) => backend.open(pk, id, blob, aad)));
  ipcMain.handle('cipher-device-key:destroy', guard((pk) => backend.destroy(pk)));
}

module.exports = { createDeviceKeyBackend, registerDeviceKeyIpc, storageProblem, isAccountKey };
