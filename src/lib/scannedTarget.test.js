import test from 'node:test';
import assert from 'node:assert/strict';
import { nip19 } from 'nostr-tools';
import { scannedTargets, scannedHref } from './scannedTarget.js';

const GROUP = 'a'.repeat(64);
const PK = 'b'.repeat(64);

test('a scanned Cipher group link names the group', () => {
  assert.deepEqual(scannedTargets(`https://cipher.example/?g=${GROUP}`), [{ kind: 'group', id: GROUP }]);
  assert.deepEqual(scannedTargets(`https://cipher.example/${GROUP}`), [{ kind: 'group', id: GROUP }]);
  assert.deepEqual(scannedTargets(`https://cipher.example/?join=${GROUP}`), [{ kind: 'group', id: GROUP }]);
});

test('a scanned naddr for a group names the group by its identifier', () => {
  const naddr = nip19.naddrEncode({ kind: 39000, pubkey: PK, identifier: 'front-room' });
  assert.deepEqual(scannedTargets(naddr), [{ kind: 'group', id: 'front-room' }]);
  assert.deepEqual(scannedTargets(`https://cipher.example/?naddr=${naddr}`), [{ kind: 'group', id: 'front-room' }]);
});

test('a bare 64-hex code offers both doors, because the shape is ambiguous', () => {
  const targets = scannedTargets(GROUP);
  assert.deepEqual(targets.map((t) => t.kind), ['group', 'profile']);
  assert.equal(targets[0].id, GROUP);
});

test('a key still opens a profile', () => {
  const npub = nip19.npubEncode(PK);
  assert.deepEqual(scannedTargets(npub), [{ kind: 'profile', value: npub }]);
  assert.deepEqual(scannedTargets(`nostr:${npub}`), [{ kind: 'profile', value: npub }]);
});

test('the other link shapes the app hands out are recognised', () => {
  assert.deepEqual(scannedTargets('https://cipher.example/note#frag123'), [{ kind: 'note', fragment: 'frag123' }]);
  assert.deepEqual(scannedTargets('https://cipher.example/?product=p1&vendor=v1'), [{ kind: 'product', id: 'p1', vendor: 'v1' }]);
  assert.deepEqual(scannedTargets('https://cipher.example/?chat=c1'), [{ kind: 'chat', value: 'c1' }]);
});

test('something that is none of these is not acted on', () => {
  assert.deepEqual(scannedTargets('hello there'), []);
  assert.deepEqual(scannedTargets('https://example.com/random'), []);
  assert.deepEqual(scannedTargets(''), []);
  assert.deepEqual(scannedTargets('ftp://cipher.example/?g=' + GROUP), []);
  assert.deepEqual(scannedTargets('naddr1broken'), []);
});

test('a door has a place to go, and it is the boot path every link uses', () => {
  assert.equal(scannedHref({ kind: 'group', id: GROUP }, 'https://cipher.example'), `https://cipher.example/?g=${GROUP}`);
  assert.equal(scannedHref({ kind: 'note', fragment: 'f1' }, 'https://cipher.example'), 'https://cipher.example/note#f1');
  assert.equal(scannedHref({ kind: 'profile', value: 'npub1x' }, 'https://cipher.example'), '');
});
