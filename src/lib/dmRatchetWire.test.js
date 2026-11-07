import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  buildDeviceRegistryEvent,
  revokeDevice,
} from './deviceEnrollment.js';
import {
  buildDmRatchetBundleEvent,
  DM_RATCHET_BUNDLE_D_TAG_PREFIX,
  DM_RATCHET_VERSION,
  makeDmRatchetBundle,
  selectDmRatchetPrekey,
  verifyDmRatchetBundleEvent,
} from './dmRatchetWire.js';

const key = (number) => Buffer.alloc(32, number).toString('base64').replace(/=+$/, '');
const now = 1_800_000_000;
const accountSecret = generateSecretKey();
const account = getPublicKey(accountSecret);
const deviceSecret = generateSecretKey();
const devicePubkey = getPublicKey(deviceSecret);
const deviceId = 'a'.repeat(32);
const registryEvent = buildDeviceRegistryEvent({
  accountSecret,
  generation: 7,
  devices: [
    { deviceId, pubkey: devicePubkey, status: 'active', enrolledAt: now - 60 },
    { deviceId: 'b'.repeat(32), pubkey: account, status: 'active', enrolledAt: now - 60 },
  ],
}, now - 1);

function bundle(overrides = {}) {
  return makeDmRatchetBundle({
    deviceId,
    generation: 1,
    ed25519: key(1),
    curve25519: key(2),
    oneTimeKeys: [key(3), key(4)],
    fallbackKeys: [key(5)],
    expiresAt: now + 3600,
    ...overrides,
  });
}

test('new ratchet prekey bundles are signed by an independently enrolled device credential', () => {
  const signed = buildDmRatchetBundleEvent(bundle(), deviceSecret, registryEvent, account, now);
  assert.equal(signed.pubkey, devicePubkey);
  assert.notEqual(signed.pubkey, account, 'the device credential is independent from the account identity');
  assert.equal(signed.content.includes(account), false, 'the directory bundle itself does not expose the account key');
  assert.equal(verifyDmRatchetBundleEvent(signed, account, now, { registryEvent })?.generation, 1);
  assert.equal(verifyDmRatchetBundleEvent(signed, 'f'.repeat(64), now, { registryEvent }), null);
  assert.equal(verifyDmRatchetBundleEvent(signed, account, now), null, 'a device signature is insufficient without account authorization');
  assert.equal(verifyDmRatchetBundleEvent({ ...signed, content: signed.content.replace(key(3), key(8)) }, account, now, { registryEvent }), null);
  assert.equal(verifyDmRatchetBundleEvent({ ...signed, id: '0'.repeat(64) }, account, now, { registryEvent }), null);
  assert.equal(signed.tags.find((tag) => tag[0] === 'd')[1], `${DM_RATCHET_BUNDLE_D_TAG_PREFIX}${deviceId}`);
  assert.equal(signed.content.includes(key(3)), true, 'only public prekey material appears in the bundle');
  assert.equal(DM_RATCHET_VERSION, 3);
});

test('revoked, stale, forged and expired device authorization fails closed', () => {
  const revoked = revokeDevice({ registryEvent, deviceId, accountSecret, now });
  const bundleEvent = buildDmRatchetBundleEvent(bundle(), deviceSecret, registryEvent, account, now);
  assert.equal(verifyDmRatchetBundleEvent(bundleEvent, account, now, { registryEvent: revoked, minimumRegistryGeneration: 8 }), null);
  assert.equal(verifyDmRatchetBundleEvent(bundleEvent, account, now, { registryEvent, minimumRegistryGeneration: 8 }), null);
  assert.throws(() => buildDmRatchetBundleEvent(bundle(), deviceSecret, revoked, account, now), /not authorized/i);
  assert.equal(verifyDmRatchetBundleEvent(bundleEvent, account, now + 4000, { registryEvent }), null);
});

test('historical account-signed v2 bundle records remain verifiable as legacy input', () => {
  const legacy = { ...bundle(), version: 2 };
  assert.throws(() => buildDmRatchetBundleEvent(legacy, accountSecret, registryEvent, account, now), /enrolled device format/i);
  const signed = finalizeEvent({
    kind: 30078,
    created_at: now,
    tags: [['d', `cipher-dm-ratchet-v2:${deviceId}`], ['expiration', String(legacy.expiresAt)]],
    content: JSON.stringify(legacy),
  }, accountSecret);
  assert.equal(verifyDmRatchetBundleEvent(signed, account, now)?.version, 2);
});

test('expired, malformed and duplicate-key bundles fail closed', () => {
  assert.throws(() => buildDmRatchetBundleEvent(bundle({ expiresAt: now - 1 }), deviceSecret, registryEvent, account, now), /malformed|expired/i);
  const duplicate = bundle({ oneTimeKeys: [key(3), key(3)] });
  assert.throws(() => buildDmRatchetBundleEvent(duplicate, deviceSecret, registryEvent, account, now), /valid|malformed/i);
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
