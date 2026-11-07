import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  buildDmRatchetBundleEvent,
  makeDmRatchetBundle,
  selectDmRatchetPrekey,
  verifyDmRatchetBundleEvent,
} from './dmRatchetWire.js';

const key = (number) => Buffer.alloc(32, number).toString('base64').replace(/=+$/, '');
const now = 1_800_000_000;
const sk = generateSecretKey();
const author = getPublicKey(sk);

function bundle(overrides = {}) {
  return makeDmRatchetBundle({
    deviceId: 'a'.repeat(32),
    generation: 1,
    ed25519: key(1),
    curve25519: key(2),
    oneTimeKeys: [key(3), key(4)],
    fallbackKeys: [key(5)],
    expiresAt: now + 3600,
    ...overrides,
  });
}

test('a ratchet prekey event is account-signed, generation-bound, and relay-readable only as public key material', () => {
  const signed = buildDmRatchetBundleEvent(bundle(), sk, now);
  assert.equal(verifyDmRatchetBundleEvent(signed, author, now).generation, 1);
  assert.equal(verifyDmRatchetBundleEvent(signed, 'f'.repeat(64), now), null);
  assert.equal(verifyDmRatchetBundleEvent({ ...signed, content: signed.content.replace(key(3), key(8)) }, author, now), null);
  assert.equal(verifyDmRatchetBundleEvent({ ...signed, id: '0'.repeat(64) }, author, now), null);
  assert.equal(signed.kind, 30078);
  assert.equal(signed.tags.find((tag) => tag[0] === 'd')[1], `cipher-dm-ratchet-v2:${'a'.repeat(32)}`);
  assert.equal(signed.content.includes(key(3)), true, 'the directory intentionally exposes public prekeys');
});

test('expired, malformed and duplicate-key bundles fail closed', () => {
  const valid = buildDmRatchetBundleEvent(bundle(), sk, now);
  assert.equal(verifyDmRatchetBundleEvent(valid, author, now + 4000), null);
  assert.equal(verifyDmRatchetBundleEvent({ ...valid, tags: [['d', 'wrong']] }, author, now), null);
  const duplicate = buildDmRatchetBundleEvent(bundle({ oneTimeKeys: [key(3), key(3)] }), sk, now);
  assert.equal(verifyDmRatchetBundleEvent(duplicate, author, now), null);
});

test('initial prekey selection uses secure randomness and prefers one-time keys', () => {
  let wasSecure = false;
  const selected = selectDmRatchetPrekey(bundle(), (target) => {
    wasSecure = true;
    target[0] = 1;
    return target;
  });
  assert.equal(wasSecure, true);
  assert.equal(selected, key(4));
  assert.equal(selectDmRatchetPrekey(bundle({ oneTimeKeys: [] }), (target) => {
    target[0] = 0;
    return target;
  }), key(5));
  assert.throws(() => selectDmRatchetPrekey(bundle(), null), /Secure randomness/);
});
