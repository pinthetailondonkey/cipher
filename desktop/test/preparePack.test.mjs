import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { stageWeb, checkVendorTor } from '../scripts/prepare-pack.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cipher-pack-'));

test('stageWeb copies the build into a fresh folder and drops stale files', () => {
  const src = tmp();
  const out = tmp();
  fs.mkdirSync(path.join(src, 'assets'));
  fs.writeFileSync(path.join(src, 'index.html'), 'x');
  fs.writeFileSync(path.join(src, 'assets', 'a.js'), 'y');
  fs.writeFileSync(path.join(out, 'stale.tar.gz'), 'old');
  stageWeb(src, out);
  assert.equal(fs.readFileSync(path.join(out, 'assets', 'a.js'), 'utf8'), 'y');
  assert.equal(fs.existsSync(path.join(out, 'stale.tar.gz')), false);
});

test('stageWeb refuses a folder with no index.html', () => {
  assert.throws(() => stageWeb(tmp(), tmp()), /No web build/);
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
