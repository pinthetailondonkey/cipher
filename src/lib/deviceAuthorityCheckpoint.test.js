import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import {
  buildDeviceEnrollmentProofV2, createDeviceAuthoritySetup, createDeviceEnrollmentChallengeV2,
  createIndependentDeviceCredential, enrollDeviceV2, replaceDeviceAuthority,
} from './deviceAuthority.js';
import {
  buildPeerCheckpointAttestationWrap, createPeerCheckpointAttestation, createPeerCheckpointChallenge,
  findPeerCheckpointEquivocations, openPeerCheckpointAttestationWrap, verifyPeerCheckpointAttestation,
  verifyPeerCheckpointQuorum,
} from './deviceAuthorityCheckpoint.js';

const now = 1_800_000_000;

function peerCheckpoint(policyEvent, registryEvent, registryHistory = [registryEvent]) {
  const policy = JSON.parse(policyEvent.content);
  return { accountPubkey: policy.accountPubkey, recoveryPubkey: policy.recoveryPubkey,
    policyEvent, policyId: policyEvent.id, registryEvent, registryId: registryEvent.id,
    registryHistory };
}

function enroll(state, registryEvent, at, marker) {
  const device = createIndependentDeviceCredential();
  const challengeEvent = createDeviceEnrollmentChallengeV2({ policyEvent: state.policyEvent,
    registryEvent, expectedRegistryId: registryEvent.id, authoritySecret: state.authoritySecret,
    deviceId: device.deviceId, devicePubkey: device.devicePubkey, now: at,
    randomBytes: (target) => target.fill(marker) });
  const proofEvent = buildDeviceEnrollmentProofV2({ challengeEvent, policyEvent: state.policyEvent,
    registryEvent, expectedRegistryId: registryEvent.id, deviceSecret: device.deviceSecret, now: at + 1 });
  return enrollDeviceV2({ policyEvent: state.policyEvent, registryEvent, expectedRegistryId: registryEvent.id,
    challengeEvent, proofEvent, authoritySecret: state.authoritySecret, now: at + 2 });
}

test('a trusted witness quorum advances a stale contact only when enough pinned peers saw recovery replacement', () => {
  const state = createDeviceAuthoritySetup({ accountPubkey: getPublicKey(generateSecretKey()), now });
  const recoveryPubkey = getPublicKey(state.recoverySecret);
  const replacement = replaceDeviceAuthority({ currentPolicyEvent: state.policyEvent,
    recoverySecret: state.recoverySecret, now: now + 1 });
  const oldCheckpoint = peerCheckpoint(state.policyEvent, state.registryEvent);
  const newCheckpoint = peerCheckpoint(replacement.policyEvent, replacement.registryEvent);
  const witnesses = [generateSecretKey(), generateSecretKey(), generateSecretKey()];
  const trustedWitnessPubkeys = witnesses.map(getPublicKey);
  const challenge = createPeerCheckpointChallenge({ accountPubkey: oldCheckpoint.accountPubkey,
    recoveryPubkey, now: now + 10, randomBytes: (target) => target.fill(0x5a) });
  const attest = (checkpoint, secret, at = now + 11, c = challenge) => createPeerCheckpointAttestation({
    checkpoint, challenge: c, witnessSecret: secret, now: at,
  });
  const newHeads = [attest(newCheckpoint, witnesses[0]), attest(newCheckpoint, witnesses[1])];
  const oldHead = attest(oldCheckpoint, witnesses[2]);
  const quorum = verifyPeerCheckpointQuorum([...newHeads, oldHead], {
    accountPubkey: oldCheckpoint.accountPubkey, recoveryPubkey, challengeNonce: challenge.nonce,
    challengeIssuedAt: challenge.issuedAt, trustedWitnessPubkeys, requiredWitnesses: 2,
    minimumAuthorityEpoch: 1, minimumRegistryGeneration: 1, now: now + 12,
  });
  assert.equal(quorum?.policyEventId, replacement.policyEvent.id,
    'the R-signed replacement is authenticated by two independently pinned peers');
  assert.equal(quorum.authorityEpoch, 2);

  const split = verifyPeerCheckpointQuorum([newHeads[0], oldHead], {
    accountPubkey: oldCheckpoint.accountPubkey, recoveryPubkey, challengeNonce: challenge.nonce,
    challengeIssuedAt: challenge.issuedAt, trustedWitnessPubkeys, requiredWitnesses: 2,
    now: now + 12,
  });
  assert.equal(split, null, 'relay censorship or offline witnesses with no quorum must fail closed');
  const stalePartition = verifyPeerCheckpointQuorum([attest(oldCheckpoint, witnesses[1]), oldHead], {
    accountPubkey: oldCheckpoint.accountPubkey, recoveryPubkey, challengeNonce: challenge.nonce,
    challengeIssuedAt: challenge.issuedAt, trustedWitnessPubkeys, requiredWitnesses: 2,
    now: now + 12,
  });
  assert.equal(stalePartition?.policyEventId, state.policyEvent.id,
    'a quorum that has itself been isolated and stayed stale cannot prove that a newer event exists');

  assert.equal(verifyPeerCheckpointAttestation(newHeads[0], {
    accountPubkey: oldCheckpoint.accountPubkey, recoveryPubkey, challengeNonce: 'f'.repeat(64),
    challengeIssuedAt: challenge.issuedAt, trustedWitnessPubkeys, now: now + 12,
  }), null, 'witness receipts cannot be replayed for a different challenge');
  assert.equal(verifyPeerCheckpointAttestation(attest(newCheckpoint, witnesses[0]), {
    accountPubkey: oldCheckpoint.accountPubkey, recoveryPubkey, challengeNonce: challenge.nonce,
    challengeIssuedAt: challenge.issuedAt, trustedWitnessPubkeys: [getPublicKey(state.authoritySecret)], now: now + 12,
  }), null, 'the compromised authority is not a substitute for a separately trusted witness');
  assert.throws(() => attest(oldCheckpoint, state.authoritySecret), /must be independent/i,
    'the authority whose status is being checked cannot witness itself');
  assert.equal(verifyPeerCheckpointQuorum(newHeads, {
    accountPubkey: oldCheckpoint.accountPubkey, recoveryPubkey, challengeNonce: challenge.nonce,
    challengeIssuedAt: challenge.issuedAt, trustedWitnessPubkeys, requiredWitnesses: 2,
    minimumAuthorityEpoch: 3, now: now + 12,
  }), null, 'a minimum pinned epoch prevents policy rollback');
  assert.equal(verifyPeerCheckpointQuorum(newHeads, {
    accountPubkey: oldCheckpoint.accountPubkey, recoveryPubkey, challengeNonce: challenge.nonce,
    challengeIssuedAt: challenge.issuedAt, trustedWitnessPubkeys, requiredWitnesses: 2,
    now: now + 72,
  }), null, 'old receipts expire and cannot provide liveness');
});

test('two conflicting authority branches signed by one witness are detectable as equivocation', () => {
  const state = createDeviceAuthoritySetup({ accountPubkey: getPublicKey(generateSecretKey()), now });
  const left = enroll(state, state.registryEvent, now + 1, 0x11);
  const right = enroll(state, state.registryEvent, now + 1, 0x22);
  assert.notEqual(left.id, right.id);
  const checkpointLeft = peerCheckpoint(state.policyEvent, left, [state.registryEvent, left]);
  const checkpointRight = peerCheckpoint(state.policyEvent, right, [state.registryEvent, right]);
  const witnessSecret = generateSecretKey();
  const challenge = createPeerCheckpointChallenge({ accountPubkey: checkpointLeft.accountPubkey,
    recoveryPubkey: checkpointLeft.recoveryPubkey, now: now + 5,
    randomBytes: (target) => target.fill(0x31) });
  const events = [checkpointLeft, checkpointRight].map((checkpoint) => createPeerCheckpointAttestation({
    checkpoint, challenge, witnessSecret, now: now + 6,
  }));
  const evidence = findPeerCheckpointEquivocations(events);
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].events.length, 2);
});

test('witness delivery is NIP-59 sealed and reveals only the target device routing key', () => {
  const state = createDeviceAuthoritySetup({ accountPubkey: getPublicKey(generateSecretKey()), now });
  const witnessSecret = generateSecretKey();
  const recipient = createIndependentDeviceCredential();
  const checkpoint = peerCheckpoint(state.policyEvent, state.registryEvent);
  const challenge = createPeerCheckpointChallenge({ accountPubkey: checkpoint.accountPubkey,
    recoveryPubkey: checkpoint.recoveryPubkey, now: now + 1, randomBytes: (target) => target.fill(0x41) });
  const event = createPeerCheckpointAttestation({ checkpoint, challenge, witnessSecret, now: now + 2 });
  const wrap = buildPeerCheckpointAttestationWrap({ attestationEvent: event, witnessSecret,
    recipientPubkey: recipient.devicePubkey, now: now + 2 });
  const wire = JSON.stringify(wrap);
  assert.deepEqual(wrap.tags.find((tag) => tag[0] === 'p'), ['p', recipient.devicePubkey]);
  for (const value of [checkpoint.accountPubkey, checkpoint.recoveryPubkey, event.pubkey,
    checkpoint.policyId, checkpoint.registryId]) assert.equal(wire.includes(value), false);
  const opened = openPeerCheckpointAttestationWrap({ wrap, recipientSecret: recipient.deviceSecret,
    expectedWitnessPubkey: getPublicKey(witnessSecret) });
  assert.equal(opened?.id, event.id);
  assert.equal(openPeerCheckpointAttestationWrap({ wrap, recipientSecret: generateSecretKey(),
    expectedWitnessPubkey: getPublicKey(witnessSecret) }), null);
});
