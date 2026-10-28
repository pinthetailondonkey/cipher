import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { BUILD_ID_PLACEHOLDER, stampServiceWorker } from './stamp-sw.mjs';

const source = fs.readFileSync(path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'public', 'sw.js'), 'utf8');

test('the shipped sw.js carries the placeholder in its cache name', () => {
  assert.match(source, new RegExp(`const CACHE_NAME = 'cipher-shell-${BUILD_ID_PLACEHOLDER}'`));
});

test('stamping swaps the placeholder for a build id and leaves no placeholder', () => {
  const stamped = stampServiceWorker(source, '<script src="/assets/index-AAA.js">');
  assert.ok(!stamped.includes(BUILD_ID_PLACEHOLDER));
  assert.match(stamped, /const CACHE_NAME = 'cipher-shell-[0-9a-f]{12}'/);
});

test('a different build gets a different cache name, the same build the same one', () => {
  const a = stampServiceWorker(source, '<script src="/assets/index-AAA.js">');
  const b = stampServiceWorker(source, '<script src="/assets/index-BBB.js">');
  assert.notEqual(a, b);
  assert.equal(a, stampServiceWorker(source, '<script src="/assets/index-AAA.js">'));
});

test('a worker with no placeholder is refused, not silently left unversioned', () => {
  assert.throws(() => stampServiceWorker("const CACHE_NAME = 'cipher-shell-v1';", 'x'), /no __BUILD_ID__/);
});
