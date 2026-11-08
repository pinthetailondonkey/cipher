import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  buildDeviceRegistryEvent,
  revokeDevice,
} from './deviceEnrollment.js';
import { buildDeviceFreshnessResponse, createDeviceFreshnessChallenge } from './deviceFreshness.js';
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
const requesterSecret = generateSecretKey();
const requesterPubkey = getPublicKey(requesterSecret);
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

let nonceByte = 1;
function freshness(registry = registryEvent, at = now, generation = JSON.parse(registry.content).generation) {
  const challengeEvent = createDeviceFreshnessChallenge({
    requesterSecret,
    authorityPubkey: account,
    deviceId,
    now: at,
    randomBytes: (target) => target.fill(nonceByte++),
  });
  const freshnessResponse = buildDeviceFreshnessResponse({
    challengeEvent,
    authoritySecret: accountSecret,
    registryEvent: registry,
    currentGeneration: generation,
    now: at + 1,
  });
  return { challengeEvent, freshnessResponse };
}

test('new ratchet prekey bundles are signed by an independently enrolled device credential', () => {
  const signed = buildDmRatchetBundleEvent(bundle(), deviceSecret, registryEvent, account, now);
  assert.equal(signed.pubkey, devicePubkey);
  assert.notEqual(signed.pubkey, account, 'the device credential is independent from the account identity');
  assert.equal(signed.content.includes(account), false, 'the directory bundle itself does not expose the account key');
  const proof = freshness();
  assert.equal(verifyDmRatchetBundleEvent(signed, account, now + 1, { ...proof, expectedRequester: requesterPubkey })?.generation, 1);
  assert.equal(verifyDmRatchetBundleEvent(signed, 'f'.repeat(64), now + 1, { ...proof, expectedRequester: requesterPubkey }), null);
  assert.equal(verifyDmRatchetBundleEvent(signed, account, now + 1), null, 'a device signature and registry snapshot are insufficient without a fresh authority response');
  assert.equal(verifyDmRatchetBundleEvent({ ...signed, content: signed.content.replace(key(3), key(8)) }, account, now + 1, { ...proof, expectedRequester: requesterPubkey }), null);
  assert.equal(verifyDmRatchetBundleEvent({ ...signed, id: '0'.repeat(64) }, account, now + 1, { ...proof, expectedRequester: requesterPubkey }), null);
  assert.equal(signed.tags.find((tag) => tag[0] === 'd')[1], `${DM_RATCHET_BUNDLE_D_TAG_PREFIX}${deviceId}`);
  assert.equal(signed.content.includes(key(3)), true, 'only public prekey material appears in the bundle');
  assert.equal(DM_RATCHET_VERSION, 3);
});

test('revoked, stale, forged and expired device authorization fails closed', () => {
  const revoked = revokeDevice({ registryEvent, deviceId, accountSecret, now });
  const bundleEvent = buildDmRatchetBundleEvent(bundle(), deviceSecret, registryEvent, account, now);
  const proof = freshness();
  assert.equal(verifyDmRatchetBundleEvent(bundleEvent, account, now + 1, {
    ...proof, expectedRequester: requesterPubkey, minimumRegistryGeneration: 8,
  }), null);
  assert.throws(() => buildDmRatchetBundleEvent(bundle(), deviceSecret, revoked, account, now), /not authorized/i);
  assert.equal(verifyDmRatchetBundleEvent(bundleEvent, account, now + 4000, {
    ...proof, expectedRequester: requesterPubkey,
  }), null, 'freshness proof expires quickly');
});

test('legacy account-signed v2 bundle cannot authorize a new ratchet session', () => {
  const legacy = { ...bundle(), version: 2 };
  assert.throws(() => buildDmRatchetBundleEvent(legacy, accountSecret, registryEvent, account, now), /enrolled device format/i);
  const signed = finalizeEvent({
    kind: 30078,
    created_at: now,
    tags: [['d', `cipher-dm-ratchet-v2:${deviceId}`], ['expiration', String(legacy.expiresAt)]],
    content: JSON.stringify(legacy),
  }, accountSecret);
  assert.equal(verifyDmRatchetBundleEvent(signed, account, now)?.version, undefined);
  assert.throws(() => selectDmRatchetPrekey({ event: signed, expectedAccount: account, ...freshness() }, (target) => target.fill(1)), /fresh|valid|prekey/i);
});

test('expired, malformed and duplicate-key bundles fail closed', () => {
  assert.throws(() => buildDmRatchetBundleEvent(bundle({ expiresAt: now - 1 }), deviceSecret, registryEvent, account, now), /malformed|expired/i);
  const duplicate = bundle({ oneTimeKeys: [key(3), key(3)] });
  assert.throws(() => buildDmRatchetBundleEvent(duplicate, deviceSecret, registryEvent, account, now), /valid|malformed/i);
});

test('initial prekey selection uses secure randomness and prefers one-time keys', () => {
  const signed = buildDmRatchetBundleEvent(bundle(), deviceSecret, registryEvent, account, now);
  const proof = freshness();
  let wasSecure = false;
  const selected = selectDmRatchetPrekey({ event: signed, expectedAccount: account, ...proof, now: now + 1, randomBytes: (target) => {
    wasSecure = true;
    target[0] = 1;
    return target;
  }, expectedRequester: requesterPubkey });
  assert.equal(wasSecure, true);
  assert.equal(selected, key(4));
  const fallback = buildDmRatchetBundleEvent(bundle({ oneTimeKeys: [] }), deviceSecret, registryEvent, account, now);
  assert.equal(selectDmRatchetPrekey({
    event: fallback,
    expectedAccount: account,
    expectedRequester: requesterPubkey,
    ...freshness(),
    now: now + 1,
    randomBytes: (target) => {
      target[0] = 0;
      return target;
    },
  }), key(5));
  assert.throws(() => selectDmRatchetPrekey({ event: signed, expectedAccount: account, expectedRequester: requesterPubkey, ...freshness(), now: now + 1, randomBytes: null }), /Secure randomness/);
});

test('an arbitrarily old signed prekey event cannot be kept alive with a future expiry', () => {
  const current = buildDmRatchetBundleEvent(bundle({ expiresAt: now + 10_000 }), deviceSecret, registryEvent, account, now);
  const stale = finalizeEvent({ ...current, created_at: now - (8 * 24 * 60 * 60) }, deviceSecret);
  assert.equal(verifyDmRatchetBundleEvent(stale, account, now, { ...freshness(), expectedRequester: requesterPubkey }), null);
});

test('a lower-generation registry snapshot cannot authorize a prekey send without a fresh authority response', () => {
  const staleRegistry = buildDeviceRegistryEvent({
    accountSecret,
    generation: 6,
    devices: registryEvent ? JSON.parse(registryEvent.content).devices : [],
  }, now - 2);
  const staleBundle = buildDmRatchetBundleEvent(bundle(), deviceSecret, staleRegistry, account, now - 1);
  const challenge = createDeviceFreshnessChallenge({ requesterSecret, authorityPubkey: account, deviceId, now, randomBytes: (target) => target.fill(88) });
  assert.throws(() => buildDeviceFreshnessResponse({
    challengeEvent: challenge,
    authoritySecret: accountSecret,
    registryEvent: staleRegistry,
    currentGeneration: 7,
    now: now + 1,
  }), /current registry|active/i);
  assert.equal(verifyDmRatchetBundleEvent(staleBundle, account, now, { challengeEvent: challenge, expectedRequester: requesterPubkey }), null,
    'a signed snapshot alone is not evidence that it is current');
});
