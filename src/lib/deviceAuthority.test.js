import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import {
  buildDeviceEnrollmentProofV2,
  buildDeviceFreshnessResponseV2,
  createDeviceAuthoritySetup,
  createDeviceEnrollmentChallengeV2,
  createDeviceFreshnessChallengeV2,
  createIndependentDeviceCredential,
  enrollDeviceV2,
  replaceDeviceAuthority,
  revokeDeviceV2,
  verifyDeviceAuthorityPolicy,
  verifyDeviceAuthorityRegistry,
  verifyDeviceAuthorityReplacement,
  verifyDeviceFreshnessResponseV2,
} from './deviceAuthority.js';

const now = 1_800_000_000;
const accountSecret = generateSecretKey();
const accountPubkey = getPublicKey(accountSecret);

function setup() {
  return createDeviceAuthoritySetup({ accountPubkey, now, randomBytes: (target) => target.fill(7) });
}

test('recovery, primary authority, and device credentials are independently generated and bound', () => {
  const state = setup();
  const policy = verifyDeviceAuthorityPolicy(state.policyEvent, {
    expectedAccount: accountPubkey,
    expectedRecovery: getPublicKey(state.recoverySecret),
    now,
  });
  assert.ok(policy);
  assert.equal(state.policyEvent.pubkey, getPublicKey(state.recoverySecret));
  assert.equal(state.registryEvent.pubkey, getPublicKey(state.authoritySecret));
  assert.notEqual(policy.recoveryPubkey, policy.authorityPubkey);
  assert.notEqual(policy.authorityPubkey, policy.primaryDevicePubkey);
  assert.notEqual(policy.primaryDevicePubkey, accountPubkey);
  assert.notEqual(policy.recoveryPubkey, accountPubkey);
  assert.notEqual(policy.authorityPubkey, accountPubkey);
  assert.equal(verifyEvent(state.policyEvent), true);
  assert.equal(verifyDeviceAuthorityPolicy(state.policyEvent, {
    expectedAccount: accountPubkey,
    expectedRecovery: getPublicKey(accountSecret),
    now,
  }), null, 'the account key alone is not the recovery trust anchor');
});

test('authority enrollment requires fresh authority challenge and new-device proof; old challenges replay-fail', () => {
  const state = setup();
  const newDevice = createIndependentDeviceCredential((target) => target.fill(8));
  const challenge = createDeviceEnrollmentChallengeV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, authoritySecret: state.authoritySecret,
    deviceId: newDevice.deviceId, devicePubkey: newDevice.devicePubkey, now: now + 1,
    randomBytes: (target) => target.fill(9),
  });
  const proof = buildDeviceEnrollmentProofV2({
    challengeEvent: challenge, policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, deviceSecret: newDevice.deviceSecret, now: now + 2,
  });
  const next = enrollDeviceV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, challengeEvent: challenge, proofEvent: proof,
    authoritySecret: state.authoritySecret, now: now + 3,
  });
  const registry = verifyDeviceAuthorityRegistry(next, state.policyEvent, { previousEvent: state.registryEvent, now: now + 3 });
  assert.equal(registry.generation, 2);
  assert.ok(registry.devices.some((row) => row.pubkey === newDevice.devicePubkey && row.status === 'active'));
  assert.throws(() => enrollDeviceV2({
    policyEvent: state.policyEvent, registryEvent: next,
    expectedRegistryId: next.id, challengeEvent: challenge, proofEvent: proof,
    authoritySecret: state.authoritySecret, now: now + 4,
  }), /not authorized|invalid|replay/i);
  assert.throws(() => buildDeviceEnrollmentProofV2({
    challengeEvent: challenge, policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: 'f'.repeat(64), deviceSecret: newDevice.deviceSecret, now: now + 4,
  }), /possession|invalid|expired/i);
  const forgedProof = { ...proof, pubkey: getPublicKey(generateSecretKey()) };
  assert.throws(() => enrollDeviceV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, challengeEvent: challenge, proofEvent: forgedProof,
    authoritySecret: state.authoritySecret, now: now + 4,
  }), /not authorized/i);
});

test('registry mutations require exact pinned head; stale relay snapshots cannot authorize changes', () => {
  const state = setup();
  const newDevice = createIndependentDeviceCredential((target) => target.fill(10));
  const challenge = createDeviceEnrollmentChallengeV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    authoritySecret: state.authoritySecret, deviceId: newDevice.deviceId,
    devicePubkey: newDevice.devicePubkey, now: now + 1, randomBytes: (target) => target.fill(11),
  });
  const proof = buildDeviceEnrollmentProofV2({
    challengeEvent: challenge, policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, deviceSecret: newDevice.deviceSecret, now: now + 2,
  });
  const head2 = enrollDeviceV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    challengeEvent: challenge, proofEvent: proof, authoritySecret: state.authoritySecret, now: now + 3,
  });
  assert.throws(() => revokeDeviceV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: head2.id,
    deviceId: state.primaryDevice.deviceId, authoritySecret: state.authoritySecret, now: now + 4,
  }), /authorized/i, 'the relay cannot make a stale head look current');
  assert.throws(() => createDeviceEnrollmentChallengeV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: head2.id,
    authoritySecret: state.authoritySecret, deviceId: 'c'.repeat(32), devicePubkey: getPublicKey(generateSecretKey()),
    now: now + 4, randomBytes: (target) => target.fill(12),
  }), /invalid/i);
});

test('revocation is tombstoned and a revoked key cannot be reactivated or reused', () => {
  const state = setup();
  const newDevice = createIndependentDeviceCredential((target) => target.fill(13));
  const challenge = createDeviceEnrollmentChallengeV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    authoritySecret: state.authoritySecret, deviceId: newDevice.deviceId,
    devicePubkey: newDevice.devicePubkey, now: now + 1, randomBytes: (target) => target.fill(14),
  });
  const proof = buildDeviceEnrollmentProofV2({
    challengeEvent: challenge, policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, deviceSecret: newDevice.deviceSecret, now: now + 2,
  });
  const head2 = enrollDeviceV2({ policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, challengeEvent: challenge, proofEvent: proof,
    authoritySecret: state.authoritySecret, now: now + 3 });
  const head3 = revokeDeviceV2({ policyEvent: state.policyEvent, registryEvent: head2,
    expectedRegistryId: head2.id, deviceId: newDevice.deviceId, authoritySecret: state.authoritySecret, now: now + 4 });
  const registry = verifyDeviceAuthorityRegistry(head3, state.policyEvent, { previousEvent: head2, now: now + 4 });
  assert.equal(registry.devices.find((row) => row.deviceId === newDevice.deviceId).status, 'revoked');
  assert.equal(verifyDeviceAuthorityRegistry(head3, state.policyEvent, { previousEvent: state.registryEvent, now: now + 4 }), null);
  assert.throws(() => createDeviceEnrollmentChallengeV2({
    policyEvent: state.policyEvent, registryEvent: head3, expectedRegistryId: head3.id,
    authoritySecret: state.authoritySecret, deviceId: newDevice.deviceId,
    devicePubkey: newDevice.devicePubkey, now: now + 5, randomBytes: (target) => target.fill(15),
  }), /invalid/i);
  assert.throws(() => revokeDeviceV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, deviceId: state.primaryDevice.deviceId,
    authoritySecret: state.authoritySecret, now: now + 6,
  }), /only be replaced through recovery/i);
});

test('a signed higher-generation snapshot cannot skip authorized transitions or add multiple devices at once', () => {
  const state = setup();
  const body = JSON.parse(state.registryEvent.content);
  body.generation = 2;
  body.previousRegistryId = state.registryEvent.id;
  body.devices.push(
    { deviceId: 'a'.repeat(32), pubkey: getPublicKey(generateSecretKey()), status: 'active', enrolledAt: now + 1 },
    { deviceId: 'b'.repeat(32), pubkey: getPublicKey(generateSecretKey()), status: 'active', enrolledAt: now + 1 },
  );
  body.createdAt = now + 1;
  const forgedSuccessor = finalizeEvent({
    kind: state.registryEvent.kind, created_at: now + 1, tags: state.registryEvent.tags,
    content: JSON.stringify(body),
  }, state.authoritySecret);
  assert.equal(verifyDeviceAuthorityRegistry(forgedSuccessor, state.policyEvent, {
    previousEvent: state.registryEvent, now: now + 1,
  }), null);
});

test('only the independent recovery root can replace authority; the old authority is fenced by the new policy epoch', () => {
  const state = setup();
  const replacement = replaceDeviceAuthority({
    currentPolicyEvent: state.policyEvent, recoverySecret: state.recoverySecret, now: now + 1,
  });
  assert.ok(verifyDeviceAuthorityReplacement(replacement.policyEvent, state.policyEvent, {
    recoveryPubkey: getPublicKey(state.recoverySecret), now: now + 1,
  }));
  assert.equal(verifyDeviceAuthorityReplacement(replacement.policyEvent, state.policyEvent, {
    recoveryPubkey: getPublicKey(accountSecret), now: now + 1,
  }), null);
  assert.equal(verifyDeviceAuthorityPolicy(replacement.policyEvent, {
    expectedAccount: accountPubkey, expectedRecovery: getPublicKey(state.recoverySecret), now: now + 1,
  }).authorityEpoch, 2);
  assert.throws(() => revokeDeviceV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, deviceId: state.primaryDevice.deviceId,
    authoritySecret: accountSecret, now: now + 1,
  }), /authorized/i, 'the retained Nostr account secret is not a Cipher device authority');
  assert.throws(() => createDeviceEnrollmentChallengeV2({
    policyEvent: replacement.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    authoritySecret: state.authoritySecret, deviceId: 'd'.repeat(32), devicePubkey: getPublicKey(generateSecretKey()),
    now: now + 2, randomBytes: (target) => target.fill(16),
  }), /invalid/i, 'the retired authority cannot create a challenge under the new policy');
});

test('freshness is scoped to pinned authority epoch, exact registry head, purpose and operation; expiry fails closed', () => {
  const state = setup();
  const operationId = 'a'.repeat(32);
  const challenge = createDeviceFreshnessChallengeV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    requesterDeviceSecret: state.primaryDevice.deviceSecret, requesterDeviceId: state.primaryDevice.deviceId,
    targetDeviceId: state.primaryDevice.deviceId, purpose: 'send-dm', operationId, now: now + 1,
    randomBytes: (target) => target.fill(17),
  });
  const response = buildDeviceFreshnessResponseV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    challengeEvent: challenge, authoritySecret: state.authoritySecret, now: now + 2,
  });
  assert.ok(verifyDeviceFreshnessResponseV2(response, challenge, {
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    expectedPurpose: 'send-dm', expectedOperationId: operationId, now: now + 3,
  }));
  assert.equal(verifyDeviceFreshnessResponseV2(response, challenge, {
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: 'f'.repeat(64), now: now + 3,
  }), null);
  assert.equal(verifyDeviceFreshnessResponseV2(response, challenge, {
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    expectedPurpose: 'enroll-device', expectedOperationId: operationId, now: now + 3,
  }), null);
  assert.equal(verifyDeviceFreshnessResponseV2(response, challenge, {
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    expectedPurpose: 'send-dm', expectedOperationId: operationId, now: now + 34,
  }), null, 'expired leases never authorize a send');
  const futureDated = buildDeviceFreshnessResponseV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    challengeEvent: challenge, authoritySecret: state.authoritySecret, now: now + 20,
  });
  assert.equal(verifyDeviceFreshnessResponseV2(futureDated, challenge, {
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    now: now + 3,
  }), null, 'future timestamps cannot stretch a lease beyond 30 seconds from verification time');
  assert.equal(verifyDeviceFreshnessResponseV2(null, challenge, {
    policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, now: now + 3,
  }), null, 'an offline or withholding authority leaves the operation held');
  assert.throws(() => createDeviceFreshnessChallengeV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    requesterDeviceSecret: generateSecretKey(), requesterDeviceId: state.primaryDevice.deviceId,
    targetDeviceId: state.primaryDevice.deviceId, purpose: 'send-dm', operationId,
    now: now + 1, randomBytes: (target) => target.fill(18),
  }), /not authorized/i);
});

test('authority replacement is recoverable only with the independent root and creates a clean primary credential', () => {
  const state = setup();
  const before = state.policyEvent.id;
  const replacement = replaceDeviceAuthority({
    currentPolicyEvent: state.policyEvent, recoverySecret: state.recoverySecret, now: now + 10,
  });
  assert.notEqual(replacement.policyEvent.id, before);
  assert.notEqual(getPublicKey(replacement.authoritySecret), getPublicKey(state.authoritySecret));
  assert.notEqual(replacement.primaryDevice.devicePubkey, state.primaryDevice.devicePubkey);
  assert.notEqual(getPublicKey(replacement.authoritySecret), getPublicKey(replacement.primaryDevice.deviceSecret));
  assert.throws(() => replaceDeviceAuthority({
    currentPolicyEvent: state.policyEvent, recoverySecret: accountSecret, now: now + 11,
  }), /recovery root/i);
});
