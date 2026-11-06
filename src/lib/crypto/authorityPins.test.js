import assert from 'node:assert/strict';
import test from 'node:test';
import {
  rememberAuthorityPin,
  readAuthorityPin,
  forgetAuthorityPin,
  authorityPinGetterFor,
  rememberActorBinding,
  readActorBindings,
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

// ── Step 2 slice 3: verified act bindings (publisher capture) ───────────────

test('a verified act binding records, reads back, and refuses junk', () => {
  const account = '41'.repeat(32);
  const pin = '02ab'.repeat(16) + 'cd'; // 66 hex
  assert.equal(pin.length, 66);
  new FakeStorage().map.clear();
  globalThis.localStorage = new FakeStorage();
  assert.equal(rememberActorBinding(OWNER, 'g-capture', account, pin), true);
  assert.deepEqual(readActorBindings(OWNER, 'g-capture'), { [account]: pin });
  // Case normalization on both halves.
  rememberActorBinding(OWNER.toUpperCase(), 'g-capture', account, pin);
  assert.deepEqual(readActorBindings(OWNER, 'g-capture'), { [account]: pin });
  // A second pin for the same account replaces the first (newest decode won).
  const newer = '03ee'.repeat(16) + 'ff';
  rememberActorBinding(OWNER, 'g-capture', account, newer);
  assert.deepEqual(readActorBindings(OWNER, 'g-capture'), { [account]: newer });
  // Accounts are scoped per group; another group reads nothing.
  assert.deepEqual(readActorBindings(OWNER, 'g-other'), {});
  // Junk shapes are refused at the door.
  assert.equal(rememberActorBinding('', 'g', account, pin), false);
  assert.equal(rememberActorBinding(OWNER, '', account, pin), false);
  assert.equal(rememberActorBinding(OWNER, 'g-capture', 'zz', pin), false);
  assert.equal(rememberActorBinding(OWNER, 'g-capture', account, '66-not'), false);
  // Corrupt stored JSON reads empty rather than throwing.
  localStorage.setItem(`cipher_group_actor_pin_${OWNER.slice(0, 16)}_g-junk`, '{oops');
  assert.deepEqual(readActorBindings(OWNER, 'g-junk'), {});
});
