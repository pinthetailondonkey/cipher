import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  buildDeviceEnrollmentProof,
  buildDeviceRegistryEvent,
  createDeviceCredential,
  createDeviceEnrollmentChallenge,
  enrollDevice,
  revokeDevice,
  verifyDeviceEnrollmentProof,
  verifyDeviceRegistryEvent,
} from './deviceEnrollment.js';

const now = 1_800_000_000;
const accountSecret = generateSecretKey();
const account = getPublicKey(accountSecret);
const deviceSecret = generateSecretKey();
const devicePubkey = getPublicKey(deviceSecret);
const otherDeviceSecret = generateSecretKey();

function initialRegistry() {
  return {
    protocol: 'cipher-device-registry',
    version: 1,
    generation: 4,
    devices: [{ deviceId: 'a'.repeat(32), pubkey: account, status: 'active', enrolledAt: now - 10 }],
  };
}

test('device enrollment requires an account challenge and a proof signed by the new device', () => {
  const challenge = createDeviceEnrollmentChallenge({
    accountSecret, deviceId: 'b'.repeat(32), devicePubkey, now,
    randomBytes: (target) => target.fill(9),
  });
  const proof = buildDeviceEnrollmentProof(challenge, deviceSecret, now + 1);
  assert.ok(verifyDeviceEnrollmentProof(challenge, proof, now + 1));
  assert.equal(verifyDeviceEnrollmentProof(challenge, { ...proof, pubkey: account }, now + 1), null);
  assert.equal(verifyDeviceEnrollmentProof(challenge, proof, now + 301), null);
});

test('new local device credentials use secure random ids and an independent signing key', () => {
  const device = createDeviceCredential((target) => target.fill(17));
  assert.match(device.deviceId, /^[0-9a-f]{32}$/);
  assert.equal(device.devicePubkey, getPublicKey(device.deviceSecret));
  assert.notEqual(device.devicePubkey, account);
  assert.throws(() => createDeviceCredential(null), /Secure randomness/i);
});

test('only the account can enroll a proved device; registry generations reject stale replay', () => {
  const registry = buildRegistry(initialRegistry(), accountSecret, now);
  const challenge = createDeviceEnrollmentChallenge({
    accountSecret, deviceId: 'b'.repeat(32), devicePubkey, now,
    randomBytes: (target) => target.fill(7),
  });
  const proof = buildDeviceEnrollmentProof(challenge, deviceSecret, now + 1);
  const enrolled = enrollDevice({ registryEvent: registry, challengeEvent: challenge, proofEvent: proof, accountSecret, now: now + 2 });
  const parsed = verifyDeviceRegistryEvent(enrolled, account, now + 2, { minimumGeneration: 5 });
  assert.equal(parsed.generation, 5);
  assert.equal(parsed.devices.find((entry) => entry.deviceId === 'b'.repeat(32)).pubkey, devicePubkey);
  assert.equal(verifyDeviceRegistryEvent(registry, account, now + 2, { minimumGeneration: 5 }), null);
  assert.throws(() => enrollDevice({ registryEvent: enrolled, challengeEvent: challenge, proofEvent: proof, accountSecret, now: now + 3 }), /already|fresh|replay/i);
});

test('revocation is an account-signed monotonic state transition and revoked devices cannot be re-enrolled', () => {
  const registry = buildRegistry(initialRegistry(), accountSecret, now);
  const challenge = createDeviceEnrollmentChallenge({
    accountSecret, deviceId: 'c'.repeat(32), devicePubkey: getPublicKey(otherDeviceSecret), now,
    randomBytes: (target) => target.fill(5),
  });
  const proof = buildDeviceEnrollmentProof(challenge, otherDeviceSecret, now + 1);
  const enrolled = enrollDevice({ registryEvent: registry, challengeEvent: challenge, proofEvent: proof, accountSecret, now: now + 2 });
  const revoked = revokeDevice({ registryEvent: enrolled, deviceId: 'c'.repeat(32), accountSecret, now: now + 3 });
  const parsed = verifyDeviceRegistryEvent(revoked, account, now + 3, { minimumGeneration: 6 });
  assert.equal(parsed.generation, 6);
  assert.equal(parsed.devices.find((entry) => entry.deviceId === 'c'.repeat(32)).status, 'revoked');
  assert.equal(verifyDeviceRegistryEvent(enrolled, account, now + 3, { minimumGeneration: 6 }), null);
  assert.throws(() => enrollDevice({ registryEvent: revoked, challengeEvent: challenge, proofEvent: proof, accountSecret, now: now + 4 }), /already enrolled|revoked/i);
});

function buildRegistry(state, secret, timestamp) {
  return buildDeviceRegistryEvent({ ...state, accountSecret: secret }, timestamp);
}
