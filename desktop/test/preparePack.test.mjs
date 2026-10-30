import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertDesktopDoor, assertNoTestHooks, stageWeb, checkVendorTor } from '../scripts/prepare-pack.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-pack-'));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const SHA = 'a'.repeat(40);

// A staged build only ever comes from the desktop build, and the desktop
// build is the only one carrying the onion group door: the page runs under
// the shell's own Tor, while a browser cannot open an onion at all. A
// fixture is a folder plus the manifest build-desktop.mjs writes for it: the
// source commit and a hash per file, which is what makes "fresh, this source,
// this target" checkable rather than asserted.
function makeBuild({ manifest = true, sourceSha = SHA, dirty = false, extra = null, hook = false } = {}) {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>Cipher</html>');
  fs.writeFileSync(path.join(dir, 'assets', 'egress-abc123.js'), hook ? 'window.__cipher = {};' : 'var d="wss://groups.example.com";');
  if (extra) fs.writeFileSync(path.join(dir, extra), 'not from this build');
  if (manifest) {
    const files = {};
    for (const rel of ['assets/egress-abc123.js', 'index.html']) {
      files[rel] = sha(fs.readFileSync(path.join(dir, rel)));
    }
    const body = {
      desktop: true,
      builtAt: new Date().toISOString(),
      sourceSha,
      sourceDirty: dirty,
      doorSha256: 'b'.repeat(64),
      files,
    };
    fs.writeFileSync(path.join(dir, 'cipher-desktop-build.json'), `${JSON.stringify(body, null, 2)}\n`);
  }
  return dir;
}

const opts = { expectedSha: SHA };

test('a build from this source, unedited, is accepted', () => {
  const dir = makeBuild();
  try {
    const manifest = assertDesktopDoor(dir, opts);
    assert.equal(manifest.desktop, true);
    assert.equal(manifest.sourceSha, SHA);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a web build with no manifest is refused, and the message names the fix', () => {
  const dir = makeBuild({ manifest: false });
  try {
    assert.throws(() => assertDesktopDoor(dir, opts), /No group door in the build .*build:desktop/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a manifest carried over onto different assets is refused', () => {
  const dir = makeBuild();
  try {
    fs.writeFileSync(path.join(dir, 'assets', 'egress-abc123.js'), 'var d="wss://groups.other.example";');
    assert.throws(() => assertDesktopDoor(dir, opts), /does not match the build that recorded it/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a folder with files the build did not write is refused as stale', () => {
  const dir = makeBuild({ extra: 'assets/old-chunk.js' });
  try {
    assert.throws(() => assertDesktopDoor(dir, opts), /files this build did not write/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a build missing a recorded file is refused', () => {
  const dir = makeBuild();
  try {
    fs.rmSync(path.join(dir, 'assets', 'egress-abc123.js'));
    assert.throws(() => assertDesktopDoor(dir, opts), /missing assets\/egress-abc123\.js/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a build from a different commit is refused, not packed', () => {
  const dir = makeBuild({ sourceSha: 'c'.repeat(40) });
  try {
    assert.throws(() => assertDesktopDoor(dir, opts), /the build is from cccccccccccc, not aaaaaaaaaaaa/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a build from a dirty tree is refused, because it matches no commit', () => {
  const dir = makeBuild({ dirty: true });
  try {
    assert.throws(() => assertDesktopDoor(dir, opts), /uncommitted changes/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('with no source commit to compare against, the pack is refused', () => {
  const dir = makeBuild();
  try {
    assert.throws(() => assertDesktopDoor(dir, {}), /no source commit to check the build against/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the test seam in a bundle keeps it out of the pack', () => {
  const dir = makeBuild({ hook: true });
  try {
    assert.throws(() => assertNoTestHooks(dir), /carries the test seam/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('stageWeb copies the build into a fresh folder and drops stale files', () => {
  const src = makeBuild();
  const out = tmp();
  fs.writeFileSync(path.join(out, 'stale.tar.gz'), 'old');
  try {
    stageWeb(src, out, opts);
    assert.equal(fs.existsSync(path.join(out, 'cipher-desktop-build.json')), true);
    assert.equal(fs.existsSync(path.join(out, 'stale.tar.gz')), false);
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test('stageWeb refuses a folder with no index.html', () => {
  assert.throws(() => stageWeb(tmp(), tmp(), opts), /No build at/);
});

test('checkVendorTor wants the right tor for the platform and nothing of the other', () => {
  const v = tmp();
  const dir = path.join(v, 'tor', 'tor');
  fs.mkdirSync(dir, { recursive: true });
  assert.throws(() => checkVendorTor(v, 'linux'), /fetch-tor\.sh/);
  assert.throws(() => checkVendorTor(v, 'win'), /fetch-tor-windows\.sh/);
  fs.writeFileSync(path.join(dir, 'tor'), '');
  checkVendorTor(v, 'linux');
  assert.throws(() => checkVendorTor(v, 'win'), /fetch-tor-windows\.sh/);
  fs.writeFileSync(path.join(dir, 'tor.exe'), '');
  assert.throws(() => checkVendorTor(v, 'linux'), /Windows tor\.exe/);
  assert.throws(() => checkVendorTor(v, 'win'), /Linux tor/);
  fs.rmSync(path.join(dir, 'tor'));
  checkVendorTor(v, 'win');
  assert.throws(() => checkVendorTor(v, 'mac'), /Unknown platform/);
});
