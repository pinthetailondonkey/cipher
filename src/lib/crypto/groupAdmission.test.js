import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey } from 'nostr-tools';
import { buildAdmissionRequest, openAdmissionRequest } from './groupAdmission.js';
import { setSessionKey } from '../sessionKey.js';

test('independent account can privately prove its group actor to a pinned owner', async () => {
  const ownerSk = generateSecretKey();
  const applicantSk = generateSecretKey();
  const owner = { pk: getPublicKey(ownerSk), sk: ownerSk };
  const applicant = { pk: getPublicKey(applicantSk), sk: applicantSk };
  const groupId = 'phase0-private-join';
  setSessionKey(ownerSk);
  const ownerPin = await actorPin(owner, groupId);
  setSessionKey(applicantSk);
  const request = await buildAdmissionRequest({ identity: applicant, groupId, ownerPin });
  setSessionKey(ownerSk);
  const opened = await openAdmissionRequest({ identity: owner, groupId, event: request });
  assert.equal(opened.accountPubkey, applicant.pk);
  assert.notEqual(owner.pk, applicant.pk);
  assert.equal(opened.actorPubkey, request.pubkey);
  assert.equal(JSON.stringify(request).includes(applicant.pk), false);
});

async function actorPin(identity, groupId) {
  const { resolveActorSigner } = await import('./gmIdentityWire.js');
  return (await resolveActorSigner({ identity, groupId })).pin;
}

test('admission proof refuses wrong group, wrong owner pin, malformed request and replay nonce', async () => {
  const ownerSk = generateSecretKey();
  const applicantSk = generateSecretKey();
  const owner = { pk: getPublicKey(ownerSk), sk: ownerSk };
  const otherOwnerSk = generateSecretKey();
  const otherOwner = { pk: getPublicKey(otherOwnerSk), sk: otherOwnerSk };
  const applicant = { pk: getPublicKey(applicantSk), sk: applicantSk };
  const groupId = 'phase0-private-join';
  setSessionKey(ownerSk);
  const { resolveActorSigner } = await import('./gmIdentityWire.js');
  const ownerPin = (await resolveActorSigner({ identity: owner, groupId })).pin;
  setSessionKey(applicantSk);
  const request = await buildAdmissionRequest({ identity: applicant, groupId, ownerPin, nonce: 'ab'.repeat(32) });

  setSessionKey(ownerSk);
  await assert.rejects(openAdmissionRequest({ identity: owner, groupId: 'other-group', event: request }));
  await assert.rejects(buildAdmissionRequest({ identity: applicant, groupId, ownerPin: '00'.repeat(33) }));
  assert.equal((await openAdmissionRequest({ identity: owner, groupId, event: request })).nonce, 'ab'.repeat(32));
  // A relay observer or unrelated group member has only public event fields;
  // a different random account/actor key cannot open the admission ciphertext.
  setSessionKey(otherOwnerSk);
  await assert.rejects(openAdmissionRequest({ identity: otherOwner, groupId, event: request }));
  setSessionKey(ownerSk);
  await assert.rejects(openAdmissionRequest({
    identity: owner, groupId, event: request, seenNonces: new Set(['ab'.repeat(32)]),
  }), /replay/i);
  await assert.rejects(openAdmissionRequest({
    identity: owner,
    groupId,
    event: { ...request, content: `${request.content.slice(0, -2)}aa` },
  }));
});
