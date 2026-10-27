import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nip19 } from 'nostr-tools';
import { npubFromHex, pubkeyFromScanned } from './npub.js';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const NPUB_A = nip19.npubEncode(PK_A);

test('pubkeyFromScanned reads the shapes a key travels in', () => {
  assert.equal(pubkeyFromScanned(NPUB_A), PK_A);
  assert.equal(pubkeyFromScanned(`nostr:${NPUB_A}`), PK_A);
  assert.equal(pubkeyFromScanned(`nostr:${NPUB_A} `), PK_A);
  assert.equal(pubkeyFromScanned(PK_A), PK_A);
  assert.equal(pubkeyFromScanned(PK_A.toUpperCase()), PK_A);
});

test('pubkeyFromScanned refuses everything that is not a key', () => {
  assert.equal(pubkeyFromScanned(''), '');
  assert.equal(pubkeyFromScanned('https://example.com/npub1'), '');
  assert.equal(pubkeyFromScanned(`note1${NPUB_A.slice(5)}`), '');
  assert.equal(pubkeyFromScanned(`${NPUB_A}tampered-last-char`), '');
  assert.equal(pubkeyFromScanned(`nostr:${'z'.repeat(63)}`), '');
});

test('pubkeyFromScanned is the lookup end of npubFromHex', () => {
  assert.equal(pubkeyFromScanned(npubFromHex(PK_B)), PK_B);
});
