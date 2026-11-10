import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import 'fake-indexeddb/auto';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  buildDeviceEnrollmentProofV2, createDeviceAuthoritySetup, createDeviceEnrollmentChallengeV2,
  createDeviceRecoveryRootReplacement,
  createIndependentDeviceCredential, enrollDeviceV2, replaceDeviceAuthority,
} from './deviceAuthority.js';
import {
  applyPeerAuthorityReplacement, applyPeerDeviceRegistryUpdate, applyPeerRecoveryRootReplacement, initializePeerDeviceAuthority,
  loadPeerDeviceAuthority,
} from './deviceAuthorityPeerStore.js';
import { recoveryIdentityFingerprint } from './deviceAuthorityContactVerification.js';
import { activateSharedSecurityContext } from './securityContextCoordination.js';

const now = 1_800_000_000;
const securityFence = { context: { owner: 'b'.repeat(64), incarnation: 'b'.repeat(32) }, assertCurrent() {} };
beforeEach(async () => { await activateSharedSecurityContext(securityFence); });
function setup() {
  const state = createDeviceAuthoritySetup({ accountPubkey: getPublicKey(generateSecretKey()), now });
  const candidate = createIndependentDeviceCredential();
  const challengeEvent = createDeviceEnrollmentChallengeV2({ policyEvent: state.policyEvent,
    registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    authoritySecret: state.authoritySecret, deviceId: candidate.deviceId,
    devicePubkey: candidate.devicePubkey, now: now + 1 });
  const proofEvent = buildDeviceEnrollmentProofV2({ challengeEvent, policyEvent: state.policyEvent,
    registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    deviceSecret: candidate.deviceSecret, now: now + 2 });
  const nextRegistryEvent = enrollDeviceV2({ policyEvent: state.policyEvent,
    registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    challengeEvent, proofEvent, authoritySecret: state.authoritySecret, now: now + 3 });
  return { ...state, candidate, nextRegistryEvent, expectedAccountPubkey: JSON.parse(state.policyEvent.content).accountPubkey,
    expectedRecoveryPubkey: getPublicKey(state.recoverySecret) };
}

test('peer checkpoint is durable, idempotent, and rejects replay and conflicting successors across tabs', async () => {
  const s = setup();
  const args = { expectedAccountPubkey: s.expectedAccountPubkey, expectedRecoveryPubkey: s.expectedRecoveryPubkey,
    now: now + 4, securityFence };
  await initializePeerDeviceAuthority({ policyEvent: s.policyEvent, registryEvent: s.registryEvent, ...args });
  const update = { type: 'registry-update', policyEvent: s.policyEvent, previousRegistryEvent: s.registryEvent,
    nextRegistryEvent: s.nextRegistryEvent };
  const race = await Promise.allSettled([
    applyPeerDeviceRegistryUpdate({ update, ...args }), applyPeerDeviceRegistryUpdate({ update, ...args }),
  ]);
  assert.equal(race.filter((result) => result.status === 'fulfilled').length, 2);
  assert.equal(race.filter((result) => result.status === 'fulfilled' && result.value.idempotent).length, 1,
    'one tab commits; the concurrent exact retry observes the same winner');
  const loaded = await loadPeerDeviceAuthority(args);
  assert.equal(loaded.registryId, s.nextRegistryEvent.id);
  assert.equal(loaded.registryHistory.length, 2);
  assert.equal((await applyPeerDeviceRegistryUpdate({ update, ...args })).idempotent, true,
    'the exact published event can be retried after reload');

  const forkCandidate = createIndependentDeviceCredential();
  const forkChallenge = createDeviceEnrollmentChallengeV2({ policyEvent: s.policyEvent,
    registryEvent: s.registryEvent, expectedRegistryId: s.registryEvent.id, authoritySecret: s.authoritySecret,
    deviceId: forkCandidate.deviceId, devicePubkey: forkCandidate.devicePubkey, now: now + 1 });
  const forkProof = buildDeviceEnrollmentProofV2({ challengeEvent: forkChallenge,
    policyEvent: s.policyEvent, registryEvent: s.registryEvent, expectedRegistryId: s.registryEvent.id,
    deviceSecret: forkCandidate.deviceSecret, now: now + 2 });
  const competing = enrollDeviceV2({ policyEvent: s.policyEvent, registryEvent: s.registryEvent,
    expectedRegistryId: s.registryEvent.id, challengeEvent: forkChallenge, proofEvent: forkProof,
    authoritySecret: s.authoritySecret, now: now + 3 });
  await assert.rejects(applyPeerDeviceRegistryUpdate({ update: { ...update, nextRegistryEvent: competing }, ...args }),
    /exact head|stored exact head/i, 'an offline peer can apply at most one branch from a pinned predecessor');
  assert.equal((await loadPeerDeviceAuthority(args)).registryId, s.nextRegistryEvent.id);
});

test('withheld updates leave the saved checkpoint unchanged, and recovery replacement atomically fences the old policy', async () => {
  const s = setup();
  const args = { expectedAccountPubkey: s.expectedAccountPubkey, expectedRecoveryPubkey: s.expectedRecoveryPubkey,
    now: now + 10, securityFence };
  await initializePeerDeviceAuthority({ policyEvent: s.policyEvent, registryEvent: s.registryEvent, ...args });
  const before = await loadPeerDeviceAuthority(args);
  assert.equal(before.registryId, s.registryEvent.id,
    'withholding means no update is applied; fresh-send authorization must separately expire and fail closed');
  const replacement = replaceDeviceAuthority({ currentPolicyEvent: s.policyEvent,
    recoverySecret: s.recoverySecret, now: now + 11 });
  const result = await applyPeerAuthorityReplacement({ update: { type: 'authority-replacement',
    previousPolicyEvent: s.policyEvent, nextPolicyEvent: replacement.policyEvent,
    nextRegistryEvent: replacement.registryEvent }, ...args, now: now + 12 });
  assert.equal(result.policyId, replacement.policyEvent.id);
  const loaded = await loadPeerDeviceAuthority({ ...args, now: now + 12 });
  assert.equal(loaded.policyId, replacement.policyEvent.id);
  assert.equal(loaded.registryHistory.length, 1);
  await assert.rejects(applyPeerDeviceRegistryUpdate({ update: { type: 'registry-update',
    policyEvent: s.policyEvent, previousRegistryEvent: s.registryEvent, nextRegistryEvent: s.nextRegistryEvent }, ...args,
  }), /exact head|policy update/i, 'a delayed old-authority update cannot cross the recovery replacement');
});

test('new recovery root requires independent fingerprint confirmation and fences old account-key trust', async () => {
  const s = setup();
  const args = { expectedAccountPubkey: s.expectedAccountPubkey,
    expectedRecoveryPubkey: s.expectedRecoveryPubkey, expectedOldRecoveryPubkey: s.expectedRecoveryPubkey,
    now: now + 20, securityFence };
  await initializePeerDeviceAuthority({ policyEvent: s.policyEvent, registryEvent: s.registryEvent, ...args });
  const nextRoot = createDeviceRecoveryRootReplacement({ currentPolicyEvent: s.policyEvent,
    newRecoverySecret: generateSecretKey(), now: now + 21 });
  const nextRecoveryPubkey = JSON.parse(nextRoot.policyEvent.content).recoveryPubkey;
  const fingerprint = recoveryIdentityFingerprint(s.expectedAccountPubkey, nextRecoveryPubkey);
  await assert.rejects(applyPeerRecoveryRootReplacement({ currentPolicyEvent: s.policyEvent,
    nextPolicyEvent: nextRoot.policyEvent, nextRegistryEvent: nextRoot.registryEvent,
    ...args, confirmedFingerprint: '' }), /not independently confirmed/i);
  await assert.rejects(applyPeerRecoveryRootReplacement({ currentPolicyEvent: s.policyEvent,
    nextPolicyEvent: nextRoot.policyEvent, nextRegistryEvent: nextRoot.registryEvent,
    ...args, confirmedFingerprint: '0000 0000' }), /not independently confirmed/i);
  assert.equal((await loadPeerDeviceAuthority(args)).policyId, s.policyEvent.id,
    'failed contact verification leaves the old pin untouched');

  const result = await applyPeerRecoveryRootReplacement({ currentPolicyEvent: s.policyEvent,
    nextPolicyEvent: nextRoot.policyEvent, nextRegistryEvent: nextRoot.registryEvent,
    ...args, confirmedFingerprint: fingerprint.replaceAll(' ', '  ') });
  assert.equal(result.policyId, nextRoot.policyEvent.id);
  const nextArgs = { expectedAccountPubkey: s.expectedAccountPubkey,
    expectedRecoveryPubkey: nextRecoveryPubkey, now: now + 22, securityFence };
  const loaded = await loadPeerDeviceAuthority(nextArgs);
  assert.equal(loaded.policyId, nextRoot.policyEvent.id);
  assert.equal(loaded.registryId, nextRoot.registryEvent.id);
  await assert.rejects(loadPeerDeviceAuthority(args), /missing or inconsistent|pinned recovery policy/i,
    'the account key and prior recovery root cannot roll the contact back');
  assert.equal((await applyPeerRecoveryRootReplacement({ currentPolicyEvent: s.policyEvent,
    nextPolicyEvent: nextRoot.policyEvent, nextRegistryEvent: nextRoot.registryEvent,
    expectedAccountPubkey: s.expectedAccountPubkey, expectedOldRecoveryPubkey: s.expectedRecoveryPubkey,
    confirmedFingerprint: fingerprint, now: now + 22, securityFence })).idempotent, true);
});
