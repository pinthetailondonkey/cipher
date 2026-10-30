import test from 'node:test';
import assert from 'node:assert/strict';
import { canOpenWithPasskey, hasStoredPasskey } from './passkeyRecord.js';

// The Face ID door must show exactly when the unlock path would find a
// record: same key resolution (active pubkey first, then the biometric
// pointer), same storage key, record-shaped value. The case that matters
// most is the two-account device — a record for the other account must
// NOT light the door (a door that always fails is worse than no door).
function mockStorage(entries) {
  const map = new Map(entries);
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
  };
}

const RECORD_A = JSON.stringify({ version: 2, credentialId: 'cred', encryptedNsec: 'enc', pubkey: 'a'.repeat(64), salt: 's', rpId: 'ciphermessenger.org' });

test('record for the active pubkey lights the door', () => {
  assert.equal(hasStoredPasskey(mockStorage([
    ['cipher_active_pubkey', 'a'.repeat(64)],
    ['cipher_passkey_' + 'a'.repeat(64), RECORD_A],
  ])), true);
});

test('record found through the biometric pointer when no active pointer exists', () => {
  assert.equal(hasStoredPasskey(mockStorage([
    ['cipher_biometric_pubkey', 'a'.repeat(64)],
    ['cipher_passkey_' + 'a'.repeat(64), RECORD_A],
  ])), true);
});

test('record for a DIFFERENT saved account does not light the door', () => {
  // Active account B has no record; the only record belongs to A.
  assert.equal(hasStoredPasskey(mockStorage([
    ['cipher_active_pubkey', 'b'.repeat(64)],
    ['cipher_passkey_' + 'a'.repeat(64), RECORD_A],
  ])), false);
});

test('active pubkey outranks the biometric pointer, same as the unlock path', () => {
  // The unlock reads cipher_passkey_<active pubkey> first. A stale biometric
  // pointer naming a RECORDED account (A) must not light the door while a
  // live active pointer names an unrecorded one (B) — resolving the pointer
  // the other way round would show a door that always fails.
  assert.equal(hasStoredPasskey(mockStorage([
    ['cipher_active_pubkey', 'b'.repeat(64)],
    ['cipher_biometric_pubkey', 'a'.repeat(64)],
    ['cipher_passkey_' + 'a'.repeat(64), RECORD_A],
  ])), false);
});

test('orphan record with no pointers stays dark', () => {
  // The unlock falls back to the library default key when no pointer
  // exists, never to an orphaned cipher_passkey_* entry.
  assert.equal(hasStoredPasskey(mockStorage([
    ['cipher_passkey_' + 'a'.repeat(64), RECORD_A],
  ])), false);
});

test('malformed record does not light the door', () => {
  assert.equal(hasStoredPasskey(mockStorage([
    ['cipher_active_pubkey', 'a'.repeat(64)],
    ['cipher_passkey_' + 'a'.repeat(64), 'not-json'],
  ])), false);
  assert.equal(hasStoredPasskey(mockStorage([
    ['cipher_active_pubkey', 'a'.repeat(64)],
    ['cipher_passkey_' + 'a'.repeat(64), JSON.stringify({ version: 2 })],
  ])), false);
});

test('broken storage stays dark instead of throwing', () => {
  assert.equal(hasStoredPasskey({ getItem: () => { throw new Error('denied'); } }), false);
});

test('the door needs a device that can answer PRF, not just a saved record', async () => {
  const withRecord = mockStorage([
    ['cipher_active_pubkey', 'a'.repeat(64)],
    ['cipher_passkey_' + 'a'.repeat(64), RECORD_A],
  ]);
  // Both halves hold: the door opens.
  assert.equal(await canOpenWithPasskey(withRecord, async () => true), true);
  // A record on a browser that cannot do PRF is a door that always fails.
  assert.equal(await canOpenWithPasskey(withRecord, async () => false), false);
  // A capability check that throws is not support.
  assert.equal(await canOpenWithPasskey(withRecord, async () => { throw new Error('no crypto'); }), false);
  // No check supplied, no door.
  assert.equal(await canOpenWithPasskey(withRecord, undefined), false);
  // No record, no door, whatever the device says it can do.
  assert.equal(await canOpenWithPasskey(mockStorage([]), async () => true), false);
});
