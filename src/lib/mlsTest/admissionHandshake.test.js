import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAdmissionRequest,
  verifyAdmissionRequest,
  bindActorToAccount,
} from './admissionHandshake.js';
import { newKey } from './testingKeys.js';

const LEAF_HASH = 'ab'.repeat(32);

test('the owner accepts an admission request signed by the applicant account key', async () => {
  const account = newKey();
  const request = await buildAdmissionRequest({
    groupId: 'g1',
    leafKeyHash: LEAF_HASH,
    nonce: 'a-nonce-of-length-16!!!',
    accountSecretKey: account.secretKey,
  });
  assert.ok(request);
  const verified = await verifyAdmissionRequest({ ...request, receivedAt: Date.now() });
  assert.equal(verified.pubkey, account.publicKey);
  assert.equal(verified.leafKeyHash, LEAF_HASH);
});

test('a forged admission request (different signer) fails verification', async () => {
  const account = newKey();
  const forged = await buildAdmissionRequest({
    groupId: 'g1',
    leafKeyHash: LEAF_HASH,
    nonce: 'nonce-for-forgery!!',
    accountSecretKey: account.secretKey,
  });
  const attacker = newKey();
  const resigned = { ...forged, pubkey: attacker.publicKey };
  assert.equal(await verifyAdmissionRequest(resigned), null);
});

test('an admission request older than the D3 window is refused', async () => {
  const account = newKey();
  const request = await buildAdmissionRequest({
    groupId: 'g1',
    leafKeyHash: LEAF_HASH,
    nonce: 'another-nonce-16!!',
    accountSecretKey: account.secretKey,
  });
  assert.equal(await verifyAdmissionRequest(
    { ...request, receivedAt: Date.now() - 24 * 60 * 60 * 1000 - 1000 },
    { now: Date.now() },
  ), null);
  assert.ok(await verifyAdmissionRequest({ ...request, receivedAt: Date.now() }));
});

test('the owner records the account-to-actor binding locally before a Welcome', async () => {
  const account = newKey();
  const actor = newKey();
  const request = await buildAdmissionRequest({
    groupId: 'g1',
    leafKeyHash: LEAF_HASH,
    nonce: 'binding-nonce-16!!',
    accountSecretKey: account.secretKey,
  });
  const binding = bindActorToAccount({
    admission: request,
    actorPublicKey: actor.publicKey,
    knownAccountPubkey: account.publicKey,
  });
  assert.equal(binding.accountPubkey, account.publicKey);
  assert.ok(binding.actorPublicKey);
  // Binding to a different account pubkey fails.
  assert.equal(bindActorToAccount({
    admission: request,
    actorPublicKey: actor.publicKey,
    knownAccountPubkey: newKey().publicKey,
  }), null);
});
