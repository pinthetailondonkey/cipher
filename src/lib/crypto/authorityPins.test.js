import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rememberAuthorityPin,
  readAuthorityPin,
  forgetAuthorityPin,
  authorityPinGetterFor,
} from './authorityPins.js';

const OWNER = 'a'.repeat(64);
const GID = 'group-1';
const PIN = 'ef'.repeat(33);

class FakeStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

test('pin persists under the account scope and reads back', () => {
  const storage = new FakeStorage();
  globalThis.localStorage = storage;
  assert.equal(rememberAuthorityPin(OWNER, GID, PIN), true);
  assert.equal(readAuthorityPin(OWNER, GID), PIN);
  // A different account's scope does not see it.
  assert.equal(readAuthorityPin('b'.repeat(64), GID), '');
  // Malformed pins are refused at the door.
  assert.equal(rememberAuthorityPin(OWNER, 'g2', 'zz'), false);
  assert.equal(readAuthorityPin(OWNER, 'g2'), '');
});

test('memory fallback survives a throwing localStorage', () => {
  const failing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() {} };
  globalThis.localStorage = failing;
  assert.equal(rememberAuthorityPin(OWNER, GID, PIN), true);
  assert.equal(readAuthorityPin(OWNER, GID), PIN);
});

test('forget clears both layers; getter binds for loadDocStanding', () => {
  globalThis.localStorage = new FakeStorage();
  rememberAuthorityPin(OWNER, GID, PIN);
  forgetAuthorityPin(OWNER, GID);
  assert.equal(readAuthorityPin(OWNER, GID), '');
  const get = authorityPinGetterFor(OWNER);
  rememberAuthorityPin(OWNER, GID, PIN);
  return get(GID).then((pin) => assert.equal(pin, PIN));
});
