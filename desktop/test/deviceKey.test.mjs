import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { webcrypto } = require('node:crypto');
const { randomBytes } = require('node:crypto');
const { createDeviceKeyBackend, registerDeviceKeyIpc } = require('../src/deviceKey.js');
const { isUiUrl } = require('../src/windowPolicy.js');

// A safeStorage that stands in for the operating system: it "seals" with a
// marker only it can read back. The seal itself is not under test.
const MARKER = Buffer.from('sealed-v1:');
function fakeSafeStorage({ available = true, backend = 'gnome_libsecret' } = {}) {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (text) => Buffer.concat([MARKER, Buffer.from(text, 'utf8')]),
    decryptString: (sealed) => {
      if (!Buffer.isBuffer(sealed) || !sealed.subarray(0, MARKER.length).equals(MARKER)) {
        throw new Error('not sealed by this store');
      }
      return sealed.subarray(MARKER.length).toString('utf8');
    },
  };
}

const PK = 'ab'.repeat(32);

function freshBackend(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-devicekey-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    backend: createDeviceKeyBackend({
      safeStorage: fakeSafeStorage(),
      fs,
      dir,
      randomBytes,
      ...opts,
    }),
  };
}

test('available is a plain answer, and weak stores say no', () => {
  const make = (safeStorage, platform) => createDeviceKeyBackend({ safeStorage, fs, dir: '.', platform });
  assert.deepEqual(make(fakeSafeStorage(), 'linux').available(), { ok: true });
  // basic_text is a hardcoded password in the file, which protects nothing.
  assert.equal(make(fakeSafeStorage({ backend: 'basic_text' }), 'linux').available().code, 'basic-text');
  assert.equal(make(fakeSafeStorage({ available: false }), 'win32').available().code, 'not-available');
  // The backend hint is only consulted on Linux; elsewhere it is not a reason to refuse.
  assert.deepEqual(make(fakeSafeStorage({ backend: 'basic_text' }), 'win32').available(), { ok: true });
});

test('enroll writes one sealed file for that account only', (t) => {
  const { dir, backend } = freshBackend(t);
  const result = backend.enroll(PK);
  assert.deepEqual(result, { ok: true, dk: { k: 'safe', id: 'cipher-devkey' } });
  const file = path.join(dir, `devkey-${PK}.bin`);
  assert.ok(fs.existsSync(file));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(backend.enroll('../elsewhere').code, 'bad-account');
  assert.equal(backend.enroll('short').code, 'bad-account');
});

test('a second enroll reuses the key instead of overwriting it, and replacement is refused', (t) => {
  const { dir, backend } = freshBackend(t);
  assert.equal(backend.enroll(PK).ok, true);
  const file = path.join(dir, `devkey-${PK}.bin`);
  const first = fs.readFileSync(file);
  // The same account enrolled again: the file is untouched, because a vault
  // may already be wrapped under it.
  assert.equal(backend.enroll(PK).ok, true);
  assert.deepEqual(fs.readFileSync(file), first);
  assert.equal(backend.has(PK).has, true);
  // Replacing a working key has no verified flow yet, so it is refused
  // rather than done silently.
  const refused = backend.enroll(PK, { replace: true });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'replace-refused');
  assert.deepEqual(fs.readFileSync(file), first);
  // An account this device does not know reports no key.
  assert.equal(backend.has('cd'.repeat(32)).has, false);
});

test('seal and open round-trip, and nothing else opens it', (t) => {
  const { backend } = freshBackend(t);
  const aad = Buffer.from(`cipher-vault-3|${PK}|safe`);
  const plain = Buffer.from('{"v":2,"iv":[1,2],"data":[9,9],"salt":"s","iter":600000}');
  assert.equal(backend.enroll(PK).ok, true);
  assert.equal(backend.seal(PK, 'cipher-devkey', plain, aad).ok, true);
  const blob = backend.seal(PK, 'cipher-devkey', plain, aad).blob;
  assert.equal(blob.iv.length, 12);
  // WebCrypto puts the 16-byte tag at the end of the ciphertext; the desktop
  // backend must emit the same shape so nothing downstream branches on who
  // sealed a vault.
  assert.equal(blob.data.length, plain.length + 16);
  assert.deepEqual(Buffer.from(backend.open(PK, 'cipher-devkey', blob, aad).bytes), plain);
  assert.equal(backend.open(PK, 'cipher-devkey', blob, Buffer.from(`cipher-vault-3|${PK}|prf`)).code, 'wrong-key');
  assert.equal(backend.open(PK, 'cipher-devkey', { iv: [1, 2], data: [3] }, aad).code, 'malformed');
});

test('a lost or unreadable device key is missing, never silent success', (t) => {
  const { dir, backend } = freshBackend(t);
  assert.equal(backend.enroll(PK).ok, true);
  fs.rmSync(path.join(dir, `devkey-${PK}.bin`));
  assert.equal(backend.seal(PK, 'cipher-devkey', Buffer.from('x'), Buffer.from('a')).code, 'missing');
  assert.equal(backend.destroy(PK).ok, true);
  // A file that is not sealed by this store (copied from elsewhere, restored
  // from a broken backup) is as good as gone.
  fs.writeFileSync(path.join(dir, `devkey-${PK}.bin`), Buffer.from('not a sealed store'));
  assert.equal(backend.open(PK, 'cipher-devkey', { iv: new Array(12).fill(0), data: new Array(32).fill(7) }, Buffer.from('a')).code, 'missing');
});

test('destroy removes the key and tolerates an already-clean device', (t) => {
  const { dir, backend } = freshBackend(t);
  backend.enroll(PK);
  assert.equal(backend.destroy(PK).ok, true);
  assert.ok(!fs.existsSync(path.join(dir, `devkey-${PK}.bin`)));
  assert.equal(backend.destroy(PK).ok, true);
});

// The whole point of matching vaultEnvelope's scheme byte for byte: a blob
// sealed by the main process must open with the same WebCrypto the page
// uses, and one sealed by WebCrypto must open in the main process.
test('the desktop seal and the page WebCrypto open each other', async (t) => {
  const { dir, backend } = freshBackend(t);
  const safeStorage = fakeSafeStorage();
  assert.equal(backend.enroll(PK).ok, true);
  const secret = Buffer.from(
    safeStorage.decryptString(fs.readFileSync(path.join(dir, `devkey-${PK}.bin`))),
    'base64',
  );
  assert.equal(secret.length, 32);
  const aad = new TextEncoder().encode(`cipher-vault-3|${PK}|safe`);
  const plain = new TextEncoder().encode(JSON.stringify({ iv: [4, 5], data: [8, 8], salt: 's', iter: 600000 }));

  const key = await webcrypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
  const aes = await webcrypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: new TextEncoder().encode('cipher-vault-3') },
    key,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  const sealed = backend.seal(PK, 'cipher-devkey', Buffer.from(plain), Buffer.from(aad)).blob;
  const opened = await webcrypto.subtle.decrypt(
    { name: 'AES-GCM', iv: new Uint8Array(sealed.iv), additionalData: aad },
    aes,
    new Uint8Array(sealed.data),
  );
  assert.deepEqual(Buffer.from(opened), Buffer.from(plain));

  const fromWeb = await webcrypto.subtle.encrypt(
    { name: 'AES-GCM', iv: new Uint8Array(12).fill(3), additionalData: aad },
    aes,
    plain,
  );
  const back = backend.open(PK, 'cipher-devkey', {
    iv: new Array(12).fill(3),
    data: Array.from(new Uint8Array(fromWeb)),
  }, Buffer.from(aad));
  assert.equal(back.ok, true);
  assert.deepEqual(Buffer.from(back.bytes), Buffer.from(plain));
});

test('only the app page may ask for the key', (t) => {
  const handlers = {};
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  const backend = freshBackend(t).backend;
  registerDeviceKeyIpc({ ipcMain, backend, isAllowed: (event) => isUiUrl(event.senderFrame ? event.senderFrame.url : '', 9151) });

  const allowed = handlers['cipher-device-key:available']({ senderFrame: { url: 'http://127.0.0.1:9151/' } });
  assert.equal(allowed.ok, true);
  for (const url of ['http://localhost:9151/', 'http://127.0.0.1:9152/', 'https://127.0.0.1:9151/', 'http://evil.example/']) {
    assert.equal(handlers['cipher-device-key:available']({ senderFrame: { url } }).code, 'refused', url);
  }
  // No frame to name: refused, never guessed at.
  assert.equal(handlers['cipher-device-key:available']({}).code, 'refused');
  assert.equal(handlers['cipher-device-key:destroy']({ senderFrame: { url: 'http://127.0.0.1:9151/' } }, 'ab'.repeat(32)).ok, true);
});
