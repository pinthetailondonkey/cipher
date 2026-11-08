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
  const secondOperation = createDeviceFreshnessChallengeV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    requesterDeviceSecret: state.primaryDevice.deviceSecret, requesterDeviceId: state.primaryDevice.deviceId,
    targetDeviceId: state.primaryDevice.deviceId, purpose: 'send-dm', operationId: 'b'.repeat(32), now: now + 1,
    randomBytes: (target) => target.fill(24),
  });
  assert.equal(verifyDeviceFreshnessResponseV2(response, secondOperation, {
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    expectedPurpose: 'send-dm', expectedOperationId: 'b'.repeat(32), now: now + 3,
  }), null, 'the current proof cannot be reused for another existing-session message');
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
  const extendedBody = JSON.parse(response.content);
  extendedBody.expiresAt = challenge.created_at + 300;
  const extendedLease = finalizeEvent({ kind: response.kind, created_at: response.created_at,
    tags: response.tags.map((tag) => tag[0] === 'expiration' ? ['expiration', String(extendedBody.expiresAt)] : tag),
    content: JSON.stringify(extendedBody) }, state.authoritySecret);
  assert.equal(verifyDeviceFreshnessResponseV2(extendedLease, challenge, {
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    expectedPurpose: 'send-dm', expectedOperationId: operationId, now: now + 3,
  }), null, 'the current protocol rejects a proposed five-minute reusable session lease');
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

test('30-second lease expires at its signed boundary and revocation fences the next authorization check', () => {
  const state = setup();
  const candidate = createIndependentDeviceCredential((target) => target.fill(19));
  const enrollmentChallenge = createDeviceEnrollmentChallengeV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    authoritySecret: state.authoritySecret, deviceId: candidate.deviceId, devicePubkey: candidate.devicePubkey,
    now: now + 1, randomBytes: (target) => target.fill(20),
  });
  const enrollmentProof = buildDeviceEnrollmentProofV2({
    challengeEvent: enrollmentChallenge, policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, deviceSecret: candidate.deviceSecret, now: now + 2,
  });
  const enrolledHead = enrollDeviceV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    challengeEvent: enrollmentChallenge, proofEvent: enrollmentProof,
    authoritySecret: state.authoritySecret, now: now + 3,
  });
  const operationId = 'e'.repeat(32);
  const freshnessChallenge = createDeviceFreshnessChallengeV2({
    policyEvent: state.policyEvent, registryEvent: enrolledHead, expectedRegistryId: enrolledHead.id,
    requesterDeviceSecret: state.primaryDevice.deviceSecret, requesterDeviceId: state.primaryDevice.deviceId,
    targetDeviceId: candidate.deviceId, purpose: 'send-dm', operationId, now: now + 4,
    randomBytes: (target) => target.fill(21),
  });
  const response = buildDeviceFreshnessResponseV2({
    policyEvent: state.policyEvent, registryEvent: enrolledHead, expectedRegistryId: enrolledHead.id,
    challengeEvent: freshnessChallenge, authoritySecret: state.authoritySecret, now: now + 5,
  });
  const verifyAt = (registryEvent, expectedRegistryId, at) => verifyDeviceFreshnessResponseV2(response, freshnessChallenge, {
    policyEvent: state.policyEvent, registryEvent, expectedRegistryId,
    expectedPurpose: 'send-dm', expectedOperationId: operationId, now: at,
  });

  assert.ok(verifyAt(enrolledHead, enrolledHead.id, now + 34), 'a lease remains valid before its expiry');
  assert.equal(verifyAt(enrolledHead, enrolledHead.id, now + 35), null,
    'expiry is exclusive: at exactly 30 seconds after issuance the lease is no longer valid');

  const revokedHead = revokeDeviceV2({
    policyEvent: state.policyEvent, registryEvent: enrolledHead, expectedRegistryId: enrolledHead.id,
    deviceId: candidate.deviceId, authoritySecret: state.authoritySecret, now: now + 6,
  });
  assert.equal(verifyAt(revokedHead, revokedHead.id, now + 7), null,
    'the old response cannot authorize against a registry head that records revocation');
  assert.ok(verifyAt(enrolledHead, enrolledHead.id, now + 7),
    'a peer pinned to the old head can still accept the bounded old lease until it learns revocation');
  assert.throws(() => createDeviceFreshnessChallengeV2({
    policyEvent: state.policyEvent, registryEvent: revokedHead, expectedRegistryId: revokedHead.id,
    requesterDeviceSecret: state.primaryDevice.deviceSecret, requesterDeviceId: state.primaryDevice.deviceId,
    targetDeviceId: candidate.deviceId, purpose: 'send-dm', operationId, now: now + 7,
    randomBytes: (target) => target.fill(22),
  }), /not authorized/i, 'the current authority cannot freshly authorize the revoked device');
});

test('30-second lease does not bound a compromised old authority while a peer is held at a stale checkpoint', () => {
  const state = setup();
  const request = (at, nonceByte) => createDeviceFreshnessChallengeV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    requesterDeviceSecret: state.primaryDevice.deviceSecret, requesterDeviceId: state.primaryDevice.deviceId,
    targetDeviceId: state.primaryDevice.deviceId, purpose: 'send-dm', operationId: 'f'.repeat(32), now: at,
    randomBytes: (target) => target.fill(nonceByte),
  });
  const firstChallenge = request(now + 1, 21);
  const firstResponse = buildDeviceFreshnessResponseV2({ policyEvent: state.policyEvent,
    registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    challengeEvent: firstChallenge, authoritySecret: state.authoritySecret, now: now + 2 });
  assert.ok(verifyDeviceFreshnessResponseV2(firstResponse, firstChallenge, {
    policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, expectedPurpose: 'send-dm', now: now + 3,
  }));

  const replacement = replaceDeviceAuthority({ currentPolicyEvent: state.policyEvent,
    recoverySecret: state.recoverySecret, now: now + 4 });
  const laterChallenge = request(now + 40, 22);
  const staleAuthorityResponse = buildDeviceFreshnessResponseV2({ policyEvent: state.policyEvent,
    registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    challengeEvent: laterChallenge, authoritySecret: state.authoritySecret, now: now + 41 });
  assert.ok(verifyDeviceFreshnessResponseV2(staleAuthorityResponse, laterChallenge, {
    policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, expectedPurpose: 'send-dm', now: now + 42,
  }), 'a peer that never received the recovery replacement keeps accepting newly issued short leases');
  assert.equal(verifyDeviceFreshnessResponseV2(staleAuthorityResponse, laterChallenge, {
    policyEvent: replacement.policyEvent, registryEvent: replacement.registryEvent,
    expectedRegistryId: replacement.registryEvent.id, expectedPurpose: 'send-dm', now: now + 42,
  }), null, 'the same stale response is rejected once the recovery-signed successor is pinned');
});

test('recovery replacement fences old authority responses only after the new recovery policy is pinned', () => {
  const state = setup();
  const operationId = 'f'.repeat(32);
  const challenge = createDeviceFreshnessChallengeV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    requesterDeviceSecret: state.primaryDevice.deviceSecret, requesterDeviceId: state.primaryDevice.deviceId,
    targetDeviceId: state.primaryDevice.deviceId, purpose: 'send-dm', operationId, now: now + 1,
    randomBytes: (target) => target.fill(23),
  });
  const oldAuthorityResponse = buildDeviceFreshnessResponseV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    challengeEvent: challenge, authoritySecret: state.authoritySecret, now: now + 2,
  });
  const replacement = replaceDeviceAuthority({
    currentPolicyEvent: state.policyEvent, recoverySecret: state.recoverySecret, now: now + 3,
  });

  assert.ok(verifyDeviceFreshnessResponseV2(oldAuthorityResponse, challenge, {
    policyEvent: state.policyEvent, registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    now: now + 4,
  }), 'a peer still pinned to the prior policy cannot distinguish the replaced authority');
  assert.equal(verifyDeviceFreshnessResponseV2(oldAuthorityResponse, challenge, {
    policyEvent: replacement.policyEvent, registryEvent: replacement.registryEvent,
    expectedRegistryId: replacement.registryEvent.id, now: now + 4,
  }), null, 'the prior authority is rejected once the recovery-signed successor is pinned');

  const forgedUpdate = finalizeEvent({
    kind: replacement.policyEvent.kind,
    created_at: replacement.policyEvent.created_at,
    tags: replacement.policyEvent.tags,
    content: replacement.policyEvent.content,
  }, state.authoritySecret);
  assert.equal(verifyDeviceAuthorityReplacement(forgedUpdate, state.policyEvent, {
    recoveryPubkey: getPublicKey(state.recoverySecret), now: now + 4,
  }), null, 'a compromised primary authority cannot forge a recovery-root policy replacement');
  assert.equal(verifyDeviceAuthorityReplacement(replacement.policyEvent, replacement.policyEvent, {
    recoveryPubkey: getPublicKey(state.recoverySecret), now: now + 4,
  }), null, 'a policy replay cannot advance a peer already pinned to that policy');
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
