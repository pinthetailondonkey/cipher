import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  createDeviceAuthoritySetup, createIndependentDeviceCredential, createDeviceEnrollmentChallengeV2,
  buildDeviceEnrollmentProofV2, createDeviceRecoveryRootReplacement, enrollDeviceV2, revokeDeviceV2, replaceDeviceAuthority,
} from './deviceAuthority.js';
import {
  buildDeviceAuthorityReplacementWrap, buildDeviceRegistryUpdateWrap, openDeviceAuthorityUpdateWrap,
  buildPeerDeviceRegistryUpdateWrap, openPeerDeviceRegistryUpdateWrap,
  buildPeerRecoveryRootReplacementWrap, openPeerRecoveryRootReplacementWrap,
} from './deviceAuthorityTransport.js';
import {
  applyPeerDeviceRegistryUpdate, applyPeerRecoveryRootReplacement, initializePeerDeviceAuthority, loadPeerDeviceAuthority,
} from './deviceAuthorityPeerStore.js';
import { recoveryIdentityFingerprint } from './deviceAuthorityContactVerification.js';
import 'fake-indexeddb/auto';

const now = 1_800_000_000;
function setup() {
  const accountSecret = generateSecretKey();
  const state = createDeviceAuthoritySetup({ accountPubkey: getPublicKey(accountSecret), now });
  const second = createIndependentDeviceCredential();
  const challenge = createDeviceEnrollmentChallengeV2({ policyEvent: state.policyEvent,
    registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    authoritySecret: state.authoritySecret, deviceId: second.deviceId, devicePubkey: second.devicePubkey, now: now + 1 });
  const proof = buildDeviceEnrollmentProofV2({ challengeEvent: challenge, policyEvent: state.policyEvent,
    registryEvent: state.registryEvent, expectedRegistryId: state.registryEvent.id,
    deviceSecret: second.deviceSecret, now: now + 2 });
  const enrolled = enrollDeviceV2({ policyEvent: state.policyEvent, registryEvent: state.registryEvent,
    expectedRegistryId: state.registryEvent.id, challengeEvent: challenge, proofEvent: proof,
    authoritySecret: state.authoritySecret, now: now + 3 });
  return { ...state, second, enrolled };
}

test('authority update rides authenticated private per-device NIP-59 transport', () => {
  const s = setup();
  const revoked = revokeDeviceV2({ policyEvent: s.policyEvent, registryEvent: s.enrolled,
    expectedRegistryId: s.enrolled.id, deviceId: s.second.deviceId, authoritySecret: s.authoritySecret, now: now + 4 });
  const wrap = buildDeviceRegistryUpdateWrap({ policyEvent: s.policyEvent, previousRegistryEvent: s.enrolled,
    previousHeadPredecessorEvent: s.registryEvent, nextRegistryEvent: revoked, senderSecret: s.primaryDevice.deviceSecret,
    recipientPubkey: s.primaryDevice.devicePubkey, now: now + 5 });
  const relayFrame = JSON.stringify(wrap);
  assert.equal(wrap.kind, 1059);
  assert.deepEqual(wrap.tags.find((tag) => tag[0] === 'p'), ['p', s.primaryDevice.devicePubkey]);
  for (const publicIdentity of [JSON.parse(s.policyEvent.content).accountPubkey,
    JSON.parse(s.policyEvent.content).recoveryPubkey, JSON.parse(s.policyEvent.content).authorityPubkey,
    s.primaryDevice.deviceId, s.second.deviceId]) assert.equal(relayFrame.includes(publicIdentity), false);
  const opened = openDeviceAuthorityUpdateWrap({ wrap, recipientSecret: s.primaryDevice.deviceSecret,
    policyEvent: s.policyEvent, registryEvent: s.enrolled, registryPredecessorEvent: s.registryEvent, now: now + 5 });
  assert.equal(opened?.nextRegistryEvent.id, revoked.id);
  assert.equal(openDeviceAuthorityUpdateWrap({ wrap, recipientSecret: s.second.deviceSecret,
    policyEvent: s.policyEvent, registryEvent: s.enrolled, registryPredecessorEvent: s.registryEvent, now: now + 5 }), null);
});

test('relay-supplied stale, conflicting, replayed, and forged updates are rejected against the exact local head', () => {
  const s = setup();
  const revoked = revokeDeviceV2({ policyEvent: s.policyEvent, registryEvent: s.enrolled,
    expectedRegistryId: s.enrolled.id, deviceId: s.second.deviceId, authoritySecret: s.authoritySecret, now: now + 4 });
  const wrap = buildDeviceRegistryUpdateWrap({ policyEvent: s.policyEvent, previousRegistryEvent: s.enrolled,
    previousHeadPredecessorEvent: s.registryEvent, nextRegistryEvent: revoked, senderSecret: s.primaryDevice.deviceSecret,
    recipientPubkey: s.primaryDevice.devicePubkey, now: now + 5 });
  assert.equal(openDeviceAuthorityUpdateWrap({ wrap, recipientSecret: s.primaryDevice.deviceSecret,
    policyEvent: s.policyEvent, registryEvent: s.registryEvent, now: now + 5 }), null,
  'a relay cannot skip the exact previously pinned registry head');
  assert.equal(openDeviceAuthorityUpdateWrap({ wrap: { ...wrap, content: `${wrap.content}x` },
    recipientSecret: s.primaryDevice.deviceSecret, policyEvent: s.policyEvent,
    registryEvent: s.enrolled, registryPredecessorEvent: s.registryEvent, now: now + 5 }), null, 'modified transport fails NIP-59 signature/hash validation');
  assert.equal(openDeviceAuthorityUpdateWrap({ wrap, recipientSecret: s.primaryDevice.deviceSecret,
    policyEvent: s.policyEvent, registryEvent: revoked, registryPredecessorEvent: s.enrolled, now: now + 5 }), null,
  'a replay after applying the update has no matching predecessor');
  const otherCandidate = createIndependentDeviceCredential();
  const competingChallenge = createDeviceEnrollmentChallengeV2({ policyEvent: s.policyEvent,
    registryEvent: s.enrolled, expectedRegistryId: s.enrolled.id, authoritySecret: s.authoritySecret,
    deviceId: otherCandidate.deviceId, devicePubkey: otherCandidate.devicePubkey, now: now + 4 });
  const competingProof = buildDeviceEnrollmentProofV2({ challengeEvent: competingChallenge,
    policyEvent: s.policyEvent, registryEvent: s.enrolled, expectedRegistryId: s.enrolled.id,
    deviceSecret: otherCandidate.deviceSecret, now: now + 4 });
  const competingHead = enrollDeviceV2({ policyEvent: s.policyEvent, registryEvent: s.enrolled,
    expectedRegistryId: s.enrolled.id, challengeEvent: competingChallenge, proofEvent: competingProof,
    authoritySecret: s.authoritySecret, now: now + 4 });
  const competingWrap = buildDeviceRegistryUpdateWrap({ policyEvent: s.policyEvent,
    previousRegistryEvent: s.enrolled, previousHeadPredecessorEvent: s.registryEvent,
    nextRegistryEvent: competingHead, senderSecret: s.primaryDevice.deviceSecret,
    recipientPubkey: s.primaryDevice.devicePubkey, now: now + 5 });
  assert.equal(openDeviceAuthorityUpdateWrap({ wrap: competingWrap,
    recipientSecret: s.primaryDevice.deviceSecret, policyEvent: s.policyEvent,
    registryEvent: revoked, registryPredecessorEvent: s.enrolled, now: now + 5 }), null,
  'a conflicting same-generation branch cannot replace the already accepted head');
  assert.throws(() => buildDeviceRegistryUpdateWrap({ policyEvent: s.policyEvent,
    previousRegistryEvent: s.enrolled, previousHeadPredecessorEvent: s.registryEvent, nextRegistryEvent: revoked, senderSecret: s.second.deviceSecret,
    recipientPubkey: s.primaryDevice.devicePubkey, now: now + 5 }), /current primary/i);
  assert.throws(() => buildDeviceRegistryUpdateWrap({ policyEvent: s.policyEvent,
    previousRegistryEvent: s.enrolled, previousHeadPredecessorEvent: s.registryEvent, nextRegistryEvent: revoked,
    senderSecret: s.primaryDevice.deviceSecret, recipientPubkey: s.second.devicePubkey, now: now + 5 }), /post-update device/i,
  'revoked device must not receive the post-revocation registry update');
});

test('recovery-authorized replacement reaches an active device through the new primary credential', () => {
  const s = setup();
  const replacement = replaceDeviceAuthority({ currentPolicyEvent: s.policyEvent,
    recoverySecret: s.recoverySecret, now: now + 10 });
  const wrap = buildDeviceAuthorityReplacementWrap({ previousPolicyEvent: s.policyEvent,
    nextPolicyEvent: replacement.policyEvent, nextRegistryEvent: replacement.registryEvent,
    previousRegistryEvent: s.enrolled, previousRegistryPredecessorEvent: s.registryEvent,
    senderSecret: replacement.primaryDevice.deviceSecret, recipientPubkey: s.second.devicePubkey,
    expectedRecoveryPubkey: getPublicKey(s.recoverySecret), now: now + 11 });
  const opened = openDeviceAuthorityUpdateWrap({ wrap, recipientSecret: s.second.deviceSecret,
    policyEvent: s.policyEvent, registryEvent: s.enrolled, registryPredecessorEvent: s.registryEvent,
    expectedRecoveryPubkey: getPublicKey(s.recoverySecret), now: now + 11 });
  assert.equal(opened?.nextPolicyEvent.id, replacement.policyEvent.id);
  assert.equal(openDeviceAuthorityUpdateWrap({ wrap, recipientSecret: s.primaryDevice.deviceSecret,
    policyEvent: s.policyEvent, registryEvent: s.enrolled, registryPredecessorEvent: s.registryEvent,
    expectedRecoveryPubkey: getPublicKey(s.recoverySecret), now: now + 11 }), null,
  'old primary is not an update recipient under the new registry');
});

test('revocation update reaches an independently pinned contact privately and advances its peer checkpoint', async () => {
  const sender = setup();
  const recipient = setup();
  const senderPolicy = JSON.parse(sender.policyEvent.content);
  const recipientPolicy = JSON.parse(recipient.policyEvent.content);
  const recipientCheckpoint = {
    accountPubkey: recipientPolicy.accountPubkey,
    recoveryPubkey: recipientPolicy.recoveryPubkey,
    policyEvent: recipient.policyEvent,
    policyId: recipient.policyEvent.id,
    registryEvent: recipient.enrolled,
    registryId: recipient.enrolled.id,
    registryHistory: [recipient.registryEvent, recipient.enrolled],
  };
  const revoked = revokeDeviceV2({ policyEvent: sender.policyEvent, registryEvent: sender.enrolled,
    expectedRegistryId: sender.enrolled.id, deviceId: sender.second.deviceId,
    authoritySecret: sender.authoritySecret, now: now + 4 });
  const wrap = buildPeerDeviceRegistryUpdateWrap({
    policyEvent: sender.policyEvent,
    previousRegistryEvent: sender.enrolled,
    previousHeadPredecessorEvent: sender.registryEvent,
    nextRegistryEvent: revoked,
    senderSecret: sender.primaryDevice.deviceSecret,
    expectedSenderRecoveryPubkey: senderPolicy.recoveryPubkey,
    recipientCheckpoint,
    recipientDeviceId: recipient.second.deviceId,
    now: now + 5,
  });
  assert.equal(wrap.kind, 1059);
  const serialized = JSON.stringify(wrap);
  for (const privateOrAccountIdentity of [senderPolicy.accountPubkey, senderPolicy.recoveryPubkey,
    recipientPolicy.accountPubkey, recipientPolicy.recoveryPubkey, senderPolicy.authorityPubkey]) {
    assert.equal(serialized.includes(privateOrAccountIdentity), false);
  }
  const opened = openPeerDeviceRegistryUpdateWrap({
    wrap,
    recipientSecret: recipient.second.deviceSecret,
    senderPolicyEvent: sender.policyEvent,
    senderRecoveryPubkey: senderPolicy.recoveryPubkey,
    senderRegistryEvent: sender.enrolled,
    senderRegistryPredecessorEvent: sender.registryEvent,
    recipientCheckpoint,
    now: now + 5,
  });
  assert.equal(opened?.nextRegistryEvent.id, revoked.id);

  const args = { expectedAccountPubkey: senderPolicy.accountPubkey,
    expectedRecoveryPubkey: senderPolicy.recoveryPubkey, now: now + 6 };
  await initializePeerDeviceAuthority({ policyEvent: sender.policyEvent,
    registryEvent: sender.registryEvent, ...args });
  await applyPeerDeviceRegistryUpdate({ update: { type: 'registry-update', policyEvent: sender.policyEvent,
    previousRegistryEvent: sender.registryEvent, nextRegistryEvent: sender.enrolled }, ...args });
  const applied = await applyPeerDeviceRegistryUpdate({ update: opened, ...args });
  assert.equal(applied.registryId, revoked.id);
  const current = await loadPeerDeviceAuthority(args);
  assert.equal(JSON.parse(current.registryEvent.content).devices.find((row) =>
    row.deviceId === sender.second.deviceId).status, 'revoked');
  assert.equal(openPeerDeviceRegistryUpdateWrap({
    wrap, recipientSecret: recipient.primaryDevice.deviceSecret,
    senderPolicyEvent: sender.policyEvent, senderRecoveryPubkey: senderPolicy.recoveryPubkey,
    senderRegistryEvent: sender.enrolled, senderRegistryPredecessorEvent: sender.registryEvent,
    recipientCheckpoint, now: now + 5,
  }), null, 'a different device key cannot open an update addressed to the enrolled recipient device');
});

test('new recovery root is delivered only as a candidate and needs independent contact fingerprint confirmation', async () => {
  const sender = setup();
  const recipient = setup();
  const senderPolicy = JSON.parse(sender.policyEvent.content);
  const recipientPolicy = JSON.parse(recipient.policyEvent.content);
  const recipientCheckpoint = {
    accountPubkey: recipientPolicy.accountPubkey, recoveryPubkey: recipientPolicy.recoveryPubkey,
    policyEvent: recipient.policyEvent, policyId: recipient.policyEvent.id,
    registryEvent: recipient.enrolled, registryId: recipient.enrolled.id,
    registryHistory: [recipient.registryEvent, recipient.enrolled],
  };
  const replacement = createDeviceRecoveryRootReplacement({ currentPolicyEvent: sender.policyEvent,
    newRecoverySecret: generateSecretKey(), now: now + 6 });
  const wrap = buildPeerRecoveryRootReplacementWrap({ previousPolicyEvent: sender.policyEvent,
    previousRecoveryPubkey: senderPolicy.recoveryPubkey, nextPolicyEvent: replacement.policyEvent,
    nextRegistryEvent: replacement.registryEvent, senderSecret: replacement.primaryDevice.deviceSecret,
    recipientCheckpoint, recipientDeviceId: recipient.second.deviceId, now: now + 7 });
  const candidate = openPeerRecoveryRootReplacementWrap({ wrap,
    recipientSecret: recipient.second.deviceSecret, senderPolicyEvent: sender.policyEvent,
    senderRecoveryPubkey: senderPolicy.recoveryPubkey, senderRegistryEvent: sender.enrolled,
    senderRegistryPredecessorEvent: sender.registryEvent, recipientCheckpoint, now: now + 7 });
  assert.equal(candidate?.nextPolicyEvent.id, replacement.policyEvent.id);
  const args = { expectedAccountPubkey: senderPolicy.accountPubkey,
    expectedRecoveryPubkey: senderPolicy.recoveryPubkey, expectedOldRecoveryPubkey: senderPolicy.recoveryPubkey,
    now: now + 8 };
  await initializePeerDeviceAuthority({ policyEvent: sender.policyEvent,
    registryEvent: sender.registryEvent, ...args });
  await applyPeerDeviceRegistryUpdate({ update: { type: 'registry-update', policyEvent: sender.policyEvent,
    previousRegistryEvent: sender.registryEvent, nextRegistryEvent: sender.enrolled }, ...args });
  await assert.rejects(applyPeerRecoveryRootReplacement({ ...candidate,
    currentPolicyEvent: candidate.previousPolicyEvent,
    nextRegistryEvent: replacement.registryEvent, ...args, confirmedFingerprint: '' }), /not independently confirmed/i);
  const newRecoveryPubkey = JSON.parse(replacement.policyEvent.content).recoveryPubkey;
  const fingerprint = recoveryIdentityFingerprint(senderPolicy.accountPubkey, newRecoveryPubkey);
  await applyPeerRecoveryRootReplacement({ ...candidate, currentPolicyEvent: candidate.previousPolicyEvent,
    nextRegistryEvent: replacement.registryEvent,
    ...args, confirmedFingerprint: fingerprint });
  const pinned = await loadPeerDeviceAuthority({ expectedAccountPubkey: senderPolicy.accountPubkey,
    expectedRecoveryPubkey: newRecoveryPubkey, now: now + 9 });
  assert.equal(pinned.policyId, replacement.policyEvent.id);
});
