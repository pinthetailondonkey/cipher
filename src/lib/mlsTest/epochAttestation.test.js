import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ATTEST_T,
  detectEquivocation,
  signEpochAttestation,
  verifyEpochAttestation,
} from './epochAttestation.js';
import { newKey } from './testingKeys.js';

const TRANSRIPT = 'ab'.repeat(32);
const COMMIT = 'cd'.repeat(32);

test('a member signs one attestation per epoch and a receiver verifies it', async () => {
  const member = newKey();
  const att = await signEpochAttestation({
    groupId: 'g1',
    epoch: 3,
    transcriptHash: TRANSRIPT,
    commitHash: COMMIT,
    secretKey: member.secretKey,
  });
  assert.ok(att);
  assert.equal(att.binding.t, ATTEST_T.toLowerCase());
  const verified = await verifyEpochAttestation(att);
  assert.equal(verified.epoch, 3);
  assert.equal(verified.transcriptHash, TRANSRIPT);
});

test('a forged attestation (wrong transcript hash) fails verification', async () => {
  const member = newKey();
  const att = await signEpochAttestation({
    groupId: 'g1',
    epoch: 1,
    transcriptHash: TRANSRIPT,
    commitHash: COMMIT,
    secretKey: member.secretKey,
  });
  const forged = {
    ...att,
    binding: { ...att.binding, transcriptHash: 'ef'.repeat(32) },
  };
  assert.equal(await verifyEpochAttestation(forged), null);
});

test('a different key signing the same binding verifies against its own pubkey', async () => {
  const other = newKey();
  const att = await signEpochAttestation({
    groupId: 'g1',
    epoch: 1,
    transcriptHash: TRANSRIPT,
    commitHash: COMMIT,
    secretKey: other.secretKey,
  });
  assert.equal(att.pubkey, other.publicKey);
  assert.ok(await verifyEpochAttestation(att));
});

test('two relays showing different transcript hashes for one epoch is equivocation', () => {
  const member = newKey();
  const good = {
    groupId: 'g1', epoch: 2, transcriptHash: TRANSRIPT, pubkey: member.publicKey,
  };
  const forked = {
    groupId: 'g1', epoch: 2, transcriptHash: 'ef'.repeat(32), pubkey: member.publicKey,
  };
  const result = detectEquivocation({ groupId: 'g1', epoch: 2, relaySets: [[good], [forked]] });
  assert.equal(result.equivocation, true);
});

test('agreement across two relays is not equivocation', () => {
  const member = newKey();
  const good = {
    groupId: 'g1', epoch: 2, transcriptHash: TRANSRIPT, pubkey: member.publicKey,
  };
  const result = detectEquivocation({ groupId: 'g1', epoch: 2, relaySets: [[good], [{ ...good, pubkey: newKey().publicKey }]] });
  assert.equal(result.equivocation, false);
  assert.equal(result.transcriptHash, TRANSRIPT);
});

test('a single relay is insufficient to decide equivocation either way', () => {
  const member = newKey();
  const good = {
    groupId: 'g1', epoch: 2, transcriptHash: TRANSRIPT, pubkey: member.publicKey,
  };
  const result = detectEquivocation({ groupId: 'g1', epoch: 2, relaySets: [[good]] });
  assert.equal(result.equivocation, false);
  assert.equal(result.reason, 'insufficient-relays');
});
