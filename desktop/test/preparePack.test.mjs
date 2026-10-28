import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { assertDesktopDoor, stageWeb, checkVendorTor } from '../scripts/prepare-pack.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-pack-'));

// A staged build only ever comes from the desktop build, and the desktop
// build is the only one carrying the onion group door: the page runs under
// the shell's own Tor, while a browser cannot open an onion at all. Every
// fixture below therefore carries the door unless the test is about its
// absence.
const withDoor = (dir, door = true) => {
  fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), 'x');
  fs.writeFileSync(path.join(dir, 'assets', 'egress-abc123.js'), 'var d="wss://groups.example.com";');
  // Every bundle carries ".onion" in ordinary URL-parsing code, so presence
  // of that string proves nothing. The build's own marker file is the only
  // honest signal, and only scripts/build-desktop.mjs writes it.
  if (door) fs.writeFileSync(path.join(dir, 'cipher-desktop-build.json'), '{"desktop":true}\n');
  return dir;
};

test('stageWeb copies the build into a fresh folder and drops stale files', () => {
  const src = withDoor(tmp());
  const out = tmp();
  fs.writeFileSync(path.join(out, 'stale.tar.gz'), 'old');
  stageWeb(src, out);
  assert.equal(fs.existsSync(path.join(out, 'cipher-desktop-build.json')), true);
  assert.equal(fs.existsSync(path.join(out, 'stale.tar.gz')), false);
});

test('stageWeb refuses a folder with no index.html', () => {
  assert.throws(() => stageWeb(tmp(), tmp()), /No build at/);
});

// The guard itself: a web build left Tor for every group without a word, so
// the staging step refuses it instead of trusting whoever typed the command.
test('assertDesktopDoor accepts a build that carries the onion door', () => {
  const dir = withDoor(tmp());
  try {
    assert.doesNotThrow(() => assertDesktopDoor(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertDesktopDoor refuses a web build, and the message names the fix', () => {
  const dir = withDoor(tmp(), false);
  try {
    assert.throws(() => assertDesktopDoor(dir), /No group door in the build .*build:desktop/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assertDesktopDoor refuses a build with no assets at all rather than packing empty', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'index.html'), 'x');
    assert.throws(() => assertDesktopDoor(dir), /No group door/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
