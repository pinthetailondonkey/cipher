import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import { webcrypto } from 'node:crypto';
import 'fake-indexeddb/auto';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  buildDeviceEnrollmentProofV2, createDeviceAuthoritySetup, createDeviceEnrollmentChallengeV2,
  createIndependentDeviceCredential, enrollDeviceV2, replaceDeviceAuthority,
} from './deviceAuthority.js';
import {
  commitPrimaryRegistryHead as storeCommitRegistry,
  loadPrimaryAuthoritySecret as storeLoadAuthority,
  loadPrimaryAuthorityState as storeLoadState,
  loadPrimaryDeviceSecret as storeLoadDevice,
  storePrimaryAuthoritySecret as storeAuthoritySecret,
} from './deviceAuthorityStorage.js';
import { activateSharedSecurityContext } from './securityContextCoordination.js';

const now = 1_800_000_000;
const securityFence = { context: { owner: 'c'.repeat(64), incarnation: 'c'.repeat(32) }, assertCurrent() {} };
const commitPrimaryRegistryHead = (args) => storeCommitRegistry({ ...args, securityFence });
const loadPrimaryAuthoritySecret = (args) => storeLoadAuthority({ ...args, securityFence });
const loadPrimaryAuthorityState = (args) => storeLoadState({ ...args, securityFence });
const loadPrimaryDeviceSecret = (args) => storeLoadDevice({ ...args, securityFence });
const storePrimaryAuthoritySecret = (args) => storeAuthoritySecret({ ...args, securityFence });
beforeEach(async () => { await activateSharedSecurityContext(securityFence); });

test('primary authority is wrapped by a separate non-extractable local key and checks device and policy binding', async () => {
  const state = createDeviceAuthoritySetup({ accountPubkey: getPublicKey(generateSecretKey()), now });
  const expectedRecoveryPubkey = getPublicKey(state.recoverySecret);
  await storePrimaryAuthoritySecret({ ...state, primaryDeviceSecret: state.primaryDevice.deviceSecret, expectedRecoveryPubkey, now, cryptoImpl: webcrypto });
  const opened = await loadPrimaryAuthoritySecret({
    policyEvent: state.policyEvent, expectedRecoveryPubkey,
    primaryDeviceSecret: state.primaryDevice.deviceSecret, now, cryptoImpl: webcrypto,
  });
  assert.deepEqual(opened, state.authoritySecret);
  assert.deepEqual(await loadPrimaryDeviceSecret({
    policyEvent: state.policyEvent, expectedRecoveryPubkey,
    now, cryptoImpl: webcrypto,
  }), state.primaryDevice.deviceSecret, 'the primary device credential survives a reload in the installation-local store');
  await assert.rejects(loadPrimaryAuthoritySecret({
    policyEvent: state.policyEvent, expectedRecoveryPubkey, primaryDeviceSecret: generateSecretKey(), now,
    cryptoImpl: webcrypto,
  }), /not the primary device/i);
  await assert.rejects(loadPrimaryAuthoritySecret({
    policyEvent: state.policyEvent, expectedRecoveryPubkey: getPublicKey(generateSecretKey()),
    primaryDeviceSecret: state.primaryDevice.deviceSecret, now, cryptoImpl: webcrypto,
  }), /pinned recovery policy/i);
});

test('a replacement authority atomically supersedes the old primary row; stale policies cannot reopen it', async () => {
  const state = createDeviceAuthoritySetup({ accountPubkey: getPublicKey(generateSecretKey()), now });
  const expectedRecoveryPubkey = getPublicKey(state.recoverySecret);
  await storePrimaryAuthoritySecret({ ...state, primaryDeviceSecret: state.primaryDevice.deviceSecret, expectedRecoveryPubkey, now, cryptoImpl: webcrypto });
  const replacement = replaceDeviceAuthority({ currentPolicyEvent: state.policyEvent, recoverySecret: state.recoverySecret, now: now + 1 });
  await storePrimaryAuthoritySecret({
    ...replacement,
    policyEvent: replacement.policyEvent,
    primaryDeviceSecret: replacement.primaryDevice.deviceSecret,
    expectedRecoveryPubkey,
    expectedPreviousPolicyId: state.policyEvent.id,
    now: now + 1,
    cryptoImpl: webcrypto,
  });
  await assert.rejects(loadPrimaryAuthoritySecret({
    policyEvent: state.policyEvent, expectedRecoveryPubkey,
    primaryDeviceSecret: state.primaryDevice.deviceSecret, now: now + 2, cryptoImpl: webcrypto,
  }), /stale|another policy/i);
  const opened = await loadPrimaryAuthoritySecret({
    policyEvent: replacement.policyEvent, expectedRecoveryPubkey,
    primaryDeviceSecret: replacement.primaryDevice.deviceSecret, now: now + 2, cryptoImpl: webcrypto,
  });
  assert.deepEqual(opened, replacement.authoritySecret);
  await assert.rejects(storePrimaryAuthoritySecret({
    ...state, primaryDeviceSecret: state.primaryDevice.deviceSecret, expectedRecoveryPubkey, now: now + 3, cryptoImpl: webcrypto,
  }), /changed|interrupted/i, 'old primary cannot overwrite the newer stored policy');
});

test('account secret and recovery root are not storage unlock inputs', async () => {
  const state = createDeviceAuthoritySetup({ accountPubkey: getPublicKey(generateSecretKey()), now });
  await storePrimaryAuthoritySecret({
    policyEvent: state.policyEvent, expectedRecoveryPubkey: getPublicKey(state.recoverySecret),
    primaryDeviceSecret: state.primaryDevice.deviceSecret, authoritySecret: state.authoritySecret,
    registryEvent: state.registryEvent, now, cryptoImpl: webcrypto,
  });
  await assert.rejects(loadPrimaryAuthoritySecret({
    policyEvent: state.policyEvent, expectedRecoveryPubkey: getPublicKey(state.recoverySecret),
    primaryDeviceSecret: state.recoverySecret, now, cryptoImpl: webcrypto,
  }), /not the primary device/i);
});

test('registry head compare-and-swap is durable, single-writer, and leaves the signed event for retry', async () => {
  const state = createDeviceAuthoritySetup({ accountPubkey: getPublicKey(generateSecretKey()), now });
  const expectedRecoveryPubkey = getPublicKey(state.recoverySecret);
  await storePrimaryAuthoritySecret({ ...state, primaryDeviceSecret: state.primaryDevice.deviceSecret, expectedRecoveryPubkey, now, cryptoImpl: webcrypto });
  const candidate = createIndependentDeviceCredential();
  const challenge = createDeviceEnrollmentChallengeV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, authoritySecret: state.authoritySecret,
    deviceId: candidate.deviceId, devicePubkey: candidate.devicePubkey, now: now + 1,
  });
  const proof = buildDeviceEnrollmentProofV2({
    challengeEvent: challenge, policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, deviceSecret: candidate.deviceSecret, now: now + 2,
  });
  const next = enrollDeviceV2({
    policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, challengeEvent: challenge, proofEvent: proof,
    authoritySecret: state.authoritySecret, now: now + 3,
  });
  const commit = () => commitPrimaryRegistryHead({
    policyEvent: state.policyEvent, expectedRecoveryPubkey,
    primaryDeviceSecret: state.primaryDevice.deviceSecret, authoritySecret: state.authoritySecret,
    previousRegistryEvent: state.registryEvent, nextRegistryEvent: next, now: now + 4, cryptoImpl: webcrypto,
  });
  const raced = await Promise.allSettled([commit(), commit()]);
  assert.equal(raced.filter((result) => result.status === 'fulfilled').length, 1);
  const recovered = await loadPrimaryAuthorityState({
    policyEvent: state.policyEvent, expectedRecoveryPubkey,
    primaryDeviceSecret: state.primaryDevice.deviceSecret, expectedRegistryId: next.id,
    now: now + 5, cryptoImpl: webcrypto,
  });
  assert.equal(recovered.registryId, next.id);
  assert.equal(recovered.generation, 2);
  assert.equal(recovered.registryEvent.id, next.id, 'the exact committed event survives for delivery retry after a crash');
  assert.equal(recovered.registryEvent.sig, next.sig);
  assert.deepEqual(recovered.authoritySecret, state.authoritySecret);
});
