import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { db, openDBFor } from '../db.js';
import { setAtRestKeyProvider } from './messageAtRest.js';
import { commitRatchetInboundV2, commitRatchetOutboundV2, loadRatchetState,
  refreshRatchetOutboundAuthorization } from './dmRatchetTransactions.js';
import { shouldFlushOutboxRow } from './outbox.js';
import {
  buildDeviceFreshnessResponseV2,
  createDeviceAuthoritySetup,
  createDeviceFreshnessChallengeV2,
  createIndependentDeviceCredential,
  buildDeviceEnrollmentProofV2,
  createDeviceEnrollmentChallengeV2,
  enrollDeviceV2,
  revokeDeviceV2,
} from './deviceAuthority.js';
import {
  authorizeRatchetSend,
  buildAuthorizedRatchetDm,
  createRatchetOperationId,
  openAuthorizedRatchetDm,
} from './dmRatchetAuthority.js';

const now = 1_800_000_000;
let nonceSeed = 1;
const randomBytes = (target) => target.fill(nonceSeed++);
const AT_REST_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 41);
globalThis.localStorage ||= {
  data: new Map(),
  getItem(key) { return this.data.get(key) ?? null; },
  setItem(key, value) { this.data.set(key, String(value)); },
  removeItem(key) { this.data.delete(key); },
};
setAtRestKeyProvider(() => AT_REST_KEY);

function principal() {
  const setup = createDeviceAuthoritySetup({ accountPubkey: getPublicKey(generateSecretKey()), now, randomBytes });
  const secondaryDevice = createIndependentDeviceCredential(randomBytes);
  const enrollmentChallenge = createDeviceEnrollmentChallengeV2({
    policyEvent: setup.policyEvent, registryEvent: setup.registryEvent,
    expectedRegistryId: setup.registryEvent.id, authoritySecret: setup.authoritySecret,
    deviceId: secondaryDevice.deviceId, devicePubkey: secondaryDevice.devicePubkey, now: now + 1, randomBytes,
  });
  const enrollmentProof = buildDeviceEnrollmentProofV2({
    challengeEvent: enrollmentChallenge, policyEvent: setup.policyEvent, registryEvent: setup.registryEvent,
    expectedRegistryId: setup.registryEvent.id, deviceSecret: secondaryDevice.deviceSecret, now: now + 2,
  });
  const registryEvent = enrollDeviceV2({
    policyEvent: setup.policyEvent, registryEvent: setup.registryEvent,
    expectedRegistryId: setup.registryEvent.id, challengeEvent: enrollmentChallenge,
    proofEvent: enrollmentProof, authoritySecret: setup.authoritySecret, now: now + 3,
  });
  const policy = JSON.parse(setup.policyEvent.content);
  const registry = JSON.parse(registryEvent.content);
  const checkpoint = {
    accountPubkey: policy.accountPubkey,
    recoveryPubkey: policy.recoveryPubkey,
    policyEvent: setup.policyEvent,
    policyId: setup.policyEvent.id,
    registryEvent,
    registryId: registryEvent.id,
    registryHistory: [setup.registryEvent, registryEvent],
  };
  return { ...setup, registryEvent, secondaryDevice, checkpoint, policy, registry };
}

function proofFor(person, { operationId, device = person.primaryDevice, requester = person.primaryDevice, at = now + 1, purpose = 'send-dm' } = {}) {
  const challengeEvent = createDeviceFreshnessChallengeV2({
    policyEvent: person.policyEvent,
    registryEvent: person.registryEvent,
    expectedRegistryId: person.registryEvent.id,
    requesterDeviceSecret: requester.deviceSecret,
    requesterDeviceId: requester.deviceId,
    targetDeviceId: device.deviceId,
    purpose,
    operationId,
    now: at,
    randomBytes,
  });
  const responseEvent = buildDeviceFreshnessResponseV2({
    policyEvent: person.policyEvent,
    registryEvent: person.registryEvent,
    expectedRegistryId: person.registryEvent.id,
    challengeEvent,
    authoritySecret: person.authoritySecret,
    now: at + 1,
  });
  return { checkpoint: person.checkpoint, deviceId: device.deviceId, requesterDeviceId: requester.deviceId,
    challengeEvent, responseEvent };
}

test('ratchet send requires sender and exact recipient-device proofs for the same one-operation id', () => {
  const sender = principal();
  const recipient = principal();
  const operationId = createRatchetOperationId(randomBytes);
  const authorization = authorizeRatchetSend({ operationId, sender: proofFor(sender, { operationId }),
    recipient: proofFor(recipient, { operationId }), now: now + 3 });
  assert.equal(authorization.protocol, 'cipher-ratchet-authority-v2');
  assert.equal(authorization.freshUntil, now + 32);
  assert.equal(authorization.sender.registryId, sender.registryEvent.id);
  assert.equal(authorization.recipient.devicePubkey, recipient.primaryDevice.devicePubkey);
});

test('authorized ratchet payload is NIP-59 sealed and relay fields expose no account or authority record', () => {
  const sender = principal();
  const recipient = principal();
  const operationId = createRatchetOperationId(randomBytes);
  const authorization = authorizeRatchetSend({ operationId,
    sender: proofFor(sender, { operationId }),
    recipient: proofFor(recipient, { operationId, device: recipient.secondaryDevice }),
    now: now + 4 });
  const sealed = buildAuthorizedRatchetDm({ authorization, ratchetCiphertext: 'opaque-ratchet-ciphertext',
    senderDeviceSecret: sender.primaryDevice.deviceSecret,
    recipientDevicePubkey: recipient.secondaryDevice.devicePubkey, createdAt: now + 5 });
  assert.equal(sealed.wrap.kind, 1059);
  assert.deepEqual(sealed.wrap.tags.filter(([tag]) => tag === 'p').map(([, value]) => value),
    [recipient.secondaryDevice.devicePubkey]);
  assert.equal(JSON.stringify(sealed.wrap).includes(sender.checkpoint.accountPubkey), false);
  assert.equal(JSON.stringify(sealed.wrap).includes(recipient.checkpoint.accountPubkey), false);
  assert.equal(JSON.stringify(sealed.wrap).includes(sender.checkpoint.recoveryPubkey), false);
  assert.equal(JSON.stringify(sealed.wrap).includes(recipient.checkpoint.recoveryPubkey), false);
  assert.equal(JSON.stringify(sealed.wrap).includes('cipher-ratchet-dm-v2'), false);
  const opened = openAuthorizedRatchetDm({ wrap: sealed.wrap,
    recipientDeviceSecret: recipient.secondaryDevice.deviceSecret,
    senderCheckpoint: sender.checkpoint, recipientCheckpoint: recipient.checkpoint,
    recipientDeviceId: recipient.secondaryDevice.deviceId,
    recipientRequesterDeviceId: recipient.primaryDevice.deviceId, now: now + 6 });
  assert.equal(opened.operationId, operationId);
  assert.equal(opened.ratchetCiphertext, 'opaque-ratchet-ciphertext');
  assert.equal(opened.applicationPayload, undefined,
    'application content is not carried beside the ratchet ciphertext in the NIP-59 rumor');
  assert.equal(openAuthorizedRatchetDm({ wrap: sealed.wrap,
    recipientDeviceSecret: recipient.secondaryDevice.deviceSecret,
    senderCheckpoint: sender.checkpoint, recipientCheckpoint: recipient.checkpoint,
    recipientDeviceId: recipient.secondaryDevice.deviceId,
    recipientRequesterDeviceId: recipient.primaryDevice.deviceId, now: now + 33 }), null,
  'a delayed wrap without an independently refreshed proof is held');
});

test('ratchet send fails closed for absent, replayed, mismatched, stale, or account-key-only proofs', () => {
  const sender = principal();
  const recipient = principal();
  const operationId = createRatchetOperationId(randomBytes);
  const senderProof = proofFor(sender, { operationId });
  const recipientProof = proofFor(recipient, { operationId });
  assert.equal(authorizeRatchetSend({ operationId, sender: senderProof, recipient: null, now: now + 3 }), null);
  assert.equal(authorizeRatchetSend({ operationId: 'f'.repeat(32), sender: senderProof,
    recipient: recipientProof, now: now + 3 }), null, 'a proof cannot be replayed for a different operation');
  assert.equal(authorizeRatchetSend({ operationId, sender: senderProof,
    recipient: { ...recipientProof, checkpoint: sender.checkpoint }, now: now + 3 }), null,
  'a peer proof cannot be reinterpreted under the sender recovery pin');
  assert.equal(authorizeRatchetSend({ operationId, sender: senderProof,
    recipient: proofFor(recipient, { operationId, purpose: 'enroll-device' }), now: now + 3 }), null);
  assert.equal(authorizeRatchetSend({ operationId, sender: senderProof,
    recipient: recipientProof, now: now + 33 }), null, 'expired proofs cannot authorize a send');
  const forged = { ...recipientProof, responseEvent: { ...recipientProof.responseEvent, pubkey: recipient.checkpoint.accountPubkey } };
  assert.equal(authorizeRatchetSend({ operationId, sender: senderProof, recipient: forged, now: now + 3 }), null,
    'the account key cannot impersonate the independent authority');
});

test('revoked recipient and stale registry checkpoints cannot establish a ratchet send', () => {
  const sender = principal();
  const recipient = principal();
  const operationId = createRatchetOperationId(randomBytes);
  const senderProof = proofFor(sender, { operationId });
  const recipientDevice = recipient.secondaryDevice;
  const recipientProof = proofFor(recipient, { operationId, device: recipientDevice });
  const revokedRegistryEvent = revokeDeviceV2({
    policyEvent: recipient.policyEvent,
    registryEvent: recipient.registryEvent,
    expectedRegistryId: recipient.registryEvent.id,
    deviceId: recipientDevice.deviceId,
    authoritySecret: recipient.authoritySecret,
    now: now + 5,
  });
  const revokedRecipient = {
    ...recipient,
    registryEvent: revokedRegistryEvent,
    checkpoint: {
      ...recipient.checkpoint,
      registryEvent: revokedRegistryEvent,
      registryId: revokedRegistryEvent.id,
      registryHistory: [...recipient.checkpoint.registryHistory, revokedRegistryEvent],
    },
  };
  assert.equal(authorizeRatchetSend({ operationId, sender: senderProof,
    recipient: { ...recipientProof, checkpoint: revokedRecipient.checkpoint }, now: now + 6 }), null,
  'a signed removal in the current checkpoint fences an earlier operation proof');
  assert.equal(authorizeRatchetSend({ operationId, sender: senderProof,
    recipient: recipientProof, now: now + 6 })?.recipient.deviceId, recipientDevice.deviceId,
  'a peer with only the older checkpoint cannot know about a withheld revocation');
});

test('v2 ratchet transaction commits proofs, ciphertext, state and operation id together and deduplicates retries', async () => {
  const sender = principal();
  const recipient = principal();
  const operationId = createRatchetOperationId(randomBytes);
  openDBFor(sender.checkpoint.accountPubkey);
  await db.open();
  const input = {
    owner: sender.checkpoint.accountPubkey,
    sessionId: 'session-authority-v2',
    peerPubkey: recipient.checkpoint.accountPubkey,
    peerDeviceId: recipient.secondaryDevice.deviceId,
    expectedVersion: null,
    state: { chainKey: 'advanced-once' },
    ratchetCiphertext: 'ciphertext-a',
    senderDeviceSecret: sender.primaryDevice.deviceSecret,
    authorization: {
      operationId,
      sender: proofFor(sender, { operationId }),
      recipient: proofFor(recipient, { operationId, device: recipient.secondaryDevice }),
    },
    securityFence: { context: { owner: sender.checkpoint.accountPubkey }, assertCurrent() {} },
    now: (now + 5) * 1000,
  };
  const committed = await commitRatchetOutboundV2(input);
  assert.equal(committed.alreadyCommitted, false);
  assert.equal((await db.outbox.get(committed.eventId)).ratchetDelivery.protocol, 'cipher-ratchet-device-delivery-v2');
  assert.equal(shouldFlushOutboxRow(await db.outbox.get(committed.eventId), input.now), true);
  assert.equal(shouldFlushOutboxRow(await db.outbox.get(committed.eventId), input.now + 31_000, true), false,
    'forcing an outbox retry cannot bypass proof expiry');
  await assert.rejects(refreshRatchetOutboundAuthorization({ owner: input.owner,
    eventId: committed.eventId, expectedRequester: sender.primaryDevice.devicePubkey }),
  /no recipient-device authorization fence/i,
  'the older v1 authorization refresh helper cannot refresh the v2 embedded proof');
  const duplicate = await commitRatchetOutboundV2({ ...input, expectedVersion: 0, state: { chainKey: 'advanced-once' },
    ratchetCiphertext: 'ciphertext-a' });
  assert.deepEqual({ eventId: duplicate.eventId, alreadyCommitted: duplicate.alreadyCommitted },
    { eventId: committed.eventId, alreadyCommitted: true });
  await assert.rejects(commitRatchetOutboundV2({ ...input, expectedVersion: 0,
    ratchetCiphertext: 'different-ciphertext' }), /different content/i,
  'the same operation id cannot alias a different ratchet transition even when the application payload matches');
  await assert.rejects(commitRatchetOutboundV2({ ...input, expectedVersion: 0,
    state: { chainKey: 'different-state' } }), /different content/i,
  'the same operation id cannot alias a different committed ratchet state');
  assert.deepEqual(await loadRatchetState({ owner: input.owner, collection: 'sessions', id: input.sessionId,
    table: db.ratchetSessions }), { version: 0, value: { chainKey: 'advanced-once' } });
});

test('v2 inbound requires authority proofs, recovers expired processing claims, and deduplicates repeated wraps', async () => {
  const sender = principal();
  const recipient = principal();
  const operationId = createRatchetOperationId(randomBytes);
  const authorization = authorizeRatchetSend({ operationId,
    sender: proofFor(sender, { operationId }),
    recipient: proofFor(recipient, { operationId, device: recipient.secondaryDevice }),
    now: now + 4 });
  const message = buildAuthorizedRatchetDm({ authorization, ratchetCiphertext: 'ratchet-step-1',
    senderDeviceSecret: sender.primaryDevice.deviceSecret,
    recipientDevicePubkey: recipient.secondaryDevice.devicePubkey, createdAt: now + 5 });
  const owner = recipient.checkpoint.accountPubkey;
  openDBFor(owner);
  await db.open();
  await db.ratchetInbox.put({ eventId: operationId, chatId: '', status: 'processing',
    receivedAt: (now + 1) * 1000, rumorId: message.rumorId,
    senderAccountPubkey: sender.checkpoint.accountPubkey,
    claimToken: 'interrupted-tab', claimUntil: (now + 5) * 1000 });
  let processCount = 0;
  const input = {
    owner,
    deviceId: recipient.secondaryDevice.deviceId,
    recipientDeviceSecret: recipient.secondaryDevice.deviceSecret,
    senderCheckpoint: sender.checkpoint,
    recipientCheckpoint: recipient.checkpoint,
    recipientRequesterDeviceId: recipient.primaryDevice.deviceId,
    wrap: message.wrap,
    securityFence: { context: { owner }, assertCurrent() {} },
    expectedVersion: null,
    now: (now + 6) * 1000,
    processRatchetMessage: async (processorInput) => {
      processCount += 1;
      assert.equal(Object.hasOwn(processorInput, 'applicationPayload'), false,
        'the inbound callback obtains plaintext from the ratchet ciphertext, not a parallel rumor field');
      const { operationId: receivedId, ratchetCiphertext } = processorInput;
      assert.equal(receivedId, operationId);
      assert.equal(ratchetCiphertext, 'ratchet-step-1');
      // The fake processor models plaintext yielded by the ratchet library;
      // it is not sourced from the NIP-59 rumor.
      return { sessionId: 'inbound-session-v2', sessionState: { receiveKey: 'advanced-once' },
        applicationPayload: { kind: 'order-receipt', id: 'effect-once' },
        chatId: 'chat-with-sender', journal: { payload: { kind: 'order-receipt', id: 'effect-once' } } };
    },
  };
  const received = await commitRatchetInboundV2(input);
  assert.equal(received.duplicate, false);
  assert.equal(received.applicationPayload.id, 'effect-once');
  const duplicate = await commitRatchetInboundV2(input);
  assert.equal(duplicate.duplicate, true);
  assert.equal(processCount, 1, 'a repeated delivery cannot advance ratchet state or reapply commerce payload');
  assert.deepEqual(await loadRatchetState({ owner, collection: 'sessions', id: 'inbound-session-v2',
    table: db.ratchetSessions }), { version: 0, value: { receiveKey: 'advanced-once' } });
});

test('v2 ratchet transactions fail closed when the account lifecycle fence is missing or expires mid-operation', async () => {
  const sender = principal();
  const recipient = principal();
  const operationId = createRatchetOperationId(randomBytes);
  openDBFor(sender.checkpoint.accountPubkey);
  await db.open();
  const base = {
    owner: sender.checkpoint.accountPubkey, sessionId: 'lifecycle-fenced-session',
    peerPubkey: recipient.checkpoint.accountPubkey, peerDeviceId: recipient.primaryDevice.deviceId,
    expectedVersion: null, state: { sendChain: 'must-not-commit' }, ratchetCiphertext: 'fenced-ciphertext',
    senderDeviceSecret: sender.primaryDevice.deviceSecret,
    authorization: { operationId, sender: proofFor(sender, { operationId }), recipient: proofFor(recipient, { operationId }) },
    now: (now + 5) * 1000,
  };
  await assert.rejects(commitRatchetOutboundV2(base), /security context/i);
  await assert.rejects(commitRatchetOutboundV2({ ...base,
    securityFence: { context: { owner: 'f'.repeat(64) }, assertCurrent() {} } }), /security context/i);
  assert.equal(await db.outbox.count(), 0);
  assert.equal(await db.ratchetSessions.count(), 0);

  let current = true;
  const fence = { context: { owner: sender.checkpoint.accountPubkey },
    assertCurrent() { if (!current) throw Object.assign(new Error('expired context'), { code: 'SECURITY_CONTEXT_EXPIRED' }); } };
  const operation = commitRatchetOutboundV2({ ...base, securityFence: fence });
  current = false;
  await assert.rejects(operation, /expired context/i);
  assert.equal(await db.outbox.count(), 0, 'a lock racing with sealing cannot persist or publish a message');
  assert.equal(await db.ratchetSessions.count(), 0, 'a lock racing with sealing cannot advance the ratchet');
});
