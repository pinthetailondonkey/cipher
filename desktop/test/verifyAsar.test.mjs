import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { verifyAsar } from '../scripts/verify-asar.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-asar-'));
const SHA = 'd'.repeat(40);

// A real asar keeps each packed file's bytes verbatim after a JSON header, so
// these fixtures only need the same strings in the same order.
function asar({ seam = false, manifest = true, sha = SHA } = {}) {
  const dir = tmp();
  const file = path.join(dir, 'app.asar');
  const header = JSON.stringify({ files: { web: { files: manifest ? { 'cipher-desktop-build.json': {}, 'index.html': {} } : { 'index.html': {} } } } });
  const body = (manifest ? JSON.stringify({ sourceSha: sha, desktop: true }) : '')
    + '<html>Cipher</html>'
    + (seam ? 'window.__cipher = {};' : 'var d="wss://groups.example.com";');
  fs.writeFileSync(file, Buffer.concat([Buffer.from(header, 'latin1'), Buffer.from(body, 'latin1')]));
  return file;
}

test('a packed archive with no seam and a manifest is accepted', () => {
  assert.equal(verifyAsar(asar(), { expectedSha: SHA }).expectedSha, SHA);
});

test('a packed archive carrying the test seam is refused', () => {
  assert.throws(() => verifyAsar(asar({ seam: true })), /test seam/);
});

test('a packed archive with no manifest cannot be traced and is refused', () => {
  assert.throws(() => verifyAsar(asar({ manifest: false })), /no build manifest/);
});

test('a packed archive from a different source commit is refused', () => {
  assert.throws(() => verifyAsar(asar(), { expectedSha: 'e'.repeat(40) }), /stale or from another tree/);
});

// The packaging scripts call this without a variable set more often than not,
// which used to mean the SHA was never compared. Now an unset expectation is
// a refusal, not a pass.
test('an archive with no source commit to check against is refused', () => {
  const env = process.env.CIPHER_EXPECT_SHA;
  delete process.env.CIPHER_EXPECT_SHA;
  try {
    assert.throws(() => verifyAsar(asar(), {}), /cannot be checked against a source commit/);
  } finally {
    if (env !== undefined) process.env.CIPHER_EXPECT_SHA = env;
  }
});
