import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

// Desktop code is CommonJS (electron's main); tests read it without electron.
const require = createRequire(import.meta.url);
const { createDataDir, dataDirBeside, resolveAppRoot } = require('../src/paths.js');

test('the data folder sits beside the app root, always named data', () => {
  assert.equal(dataDirBeside('/opt/Cipher'), '/opt/Cipher/data');
  assert.equal(dataDirBeside('/home/me/cipher/desktop'), '/home/me/cipher/desktop/data');
  assert.equal(dataDirBeside('relative/root'), path.resolve('relative/root', 'data'));
});

test('the packaged app root is the folder the program runs from', () => {
  // electron-builder's linux-unpacked layout: <bundle>/cipher
  assert.equal(
    resolveAppRoot('/downloads/Cipher-1.0.0/linux-unpacked/cipher', { isPackaged: true, projectDir: '/x' }),
    '/downloads/Cipher-1.0.0/linux-unpacked',
  );
  // a bin/ layout keeps the folder above it
  assert.equal(
    resolveAppRoot('/opt/cipher/bin/cipher', { isPackaged: true, projectDir: '/x' }),
    '/opt/cipher',
  );
});

test('dev runs keep data inside the project, not beside the electron binary', () => {
  // in dev the executable is node_modules/electron/dist/electron, which is
  // NOT where data should go; the project dir decides
  assert.equal(
    resolveAppRoot('/repo/desktop/node_modules/electron/dist/electron', { isPackaged: false, projectDir: '/repo/desktop' }),
    '/repo/desktop',
  );
  // the result is the same no matter where the program was started from
  assert.equal(
    resolveAppRoot('/tmp/anything/cipher', { isPackaged: true, projectDir: '/repo/desktop' }),
    '/tmp/anything',
  );
});

test('a data folder that cannot be written fails in plain words', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-paths-'));
  try {
    // a file where the folder should be: nothing can be written through it
    fs.writeFileSync(path.join(tmp, 'data'), 'a file, not a folder');
    assert.throws(
      () => createDataDir(path.join(tmp, 'data', 'x')),
      (e) => /portable build/.test(e.message) && /cannot write/.test(e.message),
    );
    // the working case creates the folder and writes through it
    assert.equal(createDataDir(path.join(tmp, 'ok', 'data')), path.join(tmp, 'ok', 'data'));
    assert.equal(fs.statSync(path.join(tmp, 'ok', 'data')).isDirectory(), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
