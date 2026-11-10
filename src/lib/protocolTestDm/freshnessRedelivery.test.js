// Focused test for the section-8 redelivery rule in
// src/lib/protocolTestDm/receiver.js (TEST-PATH-ONLY). Covers: valid
// redelivery carrying a fresh envelope after expiry windows pass, wrong
// target rejected, digest mismatch rejected, and NO-envelope duplicates
// behaving exactly as before (duplicate-suppressed).
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeviceCertificate,
  buildTestDmEnvelope,
  dedupeKeyDigest,
  operationDigest,
} from './protocolTestDmOperations.js';
import { buildFreshnessEnvelope } from './freshnessEnvelope.js';
import { SealedSessionStore, createSnapshotRollbackRunner } from './sessionStore.js';
import { createTestReceiver } from './receiver.js';

const T0 = 1760000000;

const { getPublicKey } = await import('nostr-tools/pure');
const { sha256 } = await import('@noble/hashes/sha2.js');

const deviceKey = (label) => sha256(new TextEncoder().encode(`cipher-dm-recv/v1|${label}`));
const AUTHORITY_SK = deviceKey('authority');
const RECEIVER_ROUTE_SK = deviceKey('route-receiving');
const ROUTE_PK = getPublicKey(RECEIVER_ROUTE_SK);
const HEAD = 'b'.repeat(64);
const OP_ID = 'cc11bb22cc33dd44ee55ff66778899aa';

function memoryStorage() {
  const map = new Map();
  return {
    async get(key) { return map.get(key); },
    async put(key, value) { map.set(key, value); },
    async delete(key) { map.delete(key); },
  };
}

function makeSealer() {
  // Fail-closed passthrough sealer for structure checks only (NOT a vault).
  return {
    seal: (plaintext, aad) => Buffer.from(`S:${aad}:${plaintext}`).toString('base64'),
    open: (ciphertext, _aad) => {
      const decoded = Buffer.from(ciphertext, 'base64').toString('utf8');
      if (!decoded.startsWith('S:')) throw new Error('sealed record tampered');
      return decoded.split(':').slice(2).join(':');
    },
  };
}

function buildStore() {
  const storage = memoryStorage();
  return new SealedSessionStore({
    storage,
    sealer: makeSealer(),
    transactionRunner: createSnapshotRollbackRunner(storage),
  });
}

// Builds a wrap whose Olm payload carries an optional freshnessEnvelope.
function buildWrap({ opId = OP_ID, body = 'redeliver me', authoritySendTime = T0 + 10, wrapCreatedAt = T0 + 20, freshnessEnvelope = null, senderDeviceSecretOverride = null, recipientRoutePubkeyOverride = null } = {}) {
  const senderDeviceSecret = senderDeviceSecretOverride ?? deviceKey('sender-device-carol');
  const routeRecipientPubkey = recipientRoutePubkeyOverride ?? ROUTE_PK;
  const senderDevicePubkey = getPublicKey(senderDeviceSecret);
  const certificate = buildDeviceCertificate({
    authoritySecret: AUTHORITY_SK,
    devicePubkey: senderDevicePubkey,
    registryHeadId: HEAD,
    sentAt: T0 + 5,
  });
  const operation = {
    protocol: 'cipher-dm-test-v1', version: 1, opId,
    fromDevice: senderDevicePubkey, toDevice: 'self', body,
  };
  const boundDigest = operationDigest(operation);
  const payloadObject = {
    olmVersion: 2, opId, sessionId: 'sess-redeliver',
    authoritySendTime,
    operation, operationDigestClaimed: boundDigest,
  };
  if (freshnessEnvelope != null) payloadObject.freshnessEnvelope = freshnessEnvelope;
  const { wrap } = buildTestDmEnvelope({
    operationPlaintext: operation,
    olmPayloadText: JSON.stringify(payloadObject),
    senderDeviceSecret,
    routeRecipientPubkey,
    wrapSecret: deviceKey('wrap-eph'),
    createdAt: wrapCreatedAt,
  });
  return { wrap, senderDevicePubkey, certificate, boundDigest, operation };
}

function baseReceiverOptions({ store, certificatesByDevice }) {
  return {
    routeSecret: RECEIVER_ROUTE_SK,
    routeRecipientPubkey: ROUTE_PK,
    expectedAuthorityPubkey: getPublicKey(AUTHORITY_SK),
    pinnedRegistryHeadId: HEAD,
    certificatesByDevice,
    store,
    decryptOnClone: async ({ rumorContent }) => {
      const payload = JSON.parse(rumorContent);
      return {
        plaintext: JSON.stringify(payload),
        boundDigest: payload.operationDigestClaimed,
        operationDigestClaimed: payload.operationDigestClaimed,
        operationId: payload.opId,
        sessionId: payload.sessionId ?? 'sess-init',
        advancedClonedStatePickle: `pickle-${payload.opId}`,
      };
    },
    applyOperationPlaintextBinding: (recoveredPayload, claimedDigestHex) =>
      recoveredPayload?.operation?.opId != null && claimedDigestHex != null ? 'ok' : 'mismatch',
    onApplicationEffect: async () => ({ dispatched: true }),
  };
}

test('valid redelivery after expiry windows pass accepts with envelope verification', async () => {
  const store = buildStore();
  const fixture = buildWrap();
  // Freshness window issued at T0, valid for one hour; the redelivery check
  // happens long after D3-relevant head age would be stale for a NEW send.
  const envelope = buildFreshnessEnvelope({
    opId: fixture.operation.opId,
    opDigestHex: fixture.boundDigest,
    issuedAt: T0,
    notAfter: T0 + 3600,
    senderDeviceId: fixture.senderDevicePubkey,
    recipientRoutePubkey: ROUTE_PK,
  });
  const redelivered = buildWrap({ freshnessEnvelope: envelope, wrapCreatedAt: T0 + 900 });
  assert.equal(redelivered.boundDigest, fixture.boundDigest, 'same operation bytes, same digest');
  let effectCount = 0;
  const receiver = createTestReceiver({
    ...baseReceiverOptions({ store, certificatesByDevice: { [fixture.senderDevicePubkey]: fixture.certificate } }),
    onApplicationEffect: async () => { effectCount += 1; },
  });
  const first = await receiver.receive(fixture.wrap, { nowSeconds: T0 + 30 });
  assert.equal(first.accepted, true);
  assert.equal(first.duplicate, false);
  const second = await receiver.receive(redelivered.wrap, { nowSeconds: T0 + 1800 });
  assert.equal(second.accepted, true);
  assert.equal(second.duplicate, true);
  assert.equal(effectCount, 1, 'effect still exactly once');
});

test('redelivery with envelope bound to a WRONG TARGET rejects at step 9', async () => {
  const store = buildStore();
  const fixture = buildWrap();
  const wrongTargetEnvelope = buildFreshnessEnvelope({
    opId: fixture.operation.opId,
    opDigestHex: fixture.boundDigest,
    issuedAt: T0,
    notAfter: T0 + 3600,
    senderDeviceId: 'some-other-device-pubkey',
    recipientRoutePubkey: ROUTE_PK,
  });
  const redelivered = buildWrap({ freshnessEnvelope: wrongTargetEnvelope, wrapCreatedAt: T0 + 900 });
  const receiver = createTestReceiver(baseReceiverOptions({ store, certificatesByDevice: { [fixture.senderDevicePubkey]: fixture.certificate } }));
  const first = await receiver.receive(fixture.wrap, { nowSeconds: T0 + 30 });
  assert.equal(first.accepted, true);
  const second = await receiver.receive(redelivered.wrap, { nowSeconds: T0 + 60 });
  assert.equal(second.accepted, false);
  assert.equal(second.step, 9);
  assert.equal(second.reason, 'redelivery-freshness-rejected');
});

test('redelivery with WRONG DIGEST in the envelope rejects at step 9', async () => {
  const store = buildStore();
  const fixture = buildWrap();
  const mismatchedEnvelope = buildFreshnessEnvelope({
    opId: fixture.operation.opId,
    opDigestHex: 'd'.repeat(64),
    issuedAt: T0,
    notAfter: T0 + 3600,
    senderDeviceId: fixture.senderDevicePubkey,
    recipientRoutePubkey: ROUTE_PK,
  });
  const redelivered = buildWrap({ freshnessEnvelope: mismatchedEnvelope, wrapCreatedAt: T0 + 900 });
  const receiver = createTestReceiver(baseReceiverOptions({ store, certificatesByDevice: { [fixture.senderDevicePubkey]: fixture.certificate } }));
  const first = await receiver.receive(fixture.wrap, { nowSeconds: T0 + 30 });
  assert.equal(first.accepted, true);
  const second = await receiver.receive(redelivered.wrap, { nowSeconds: T0 + 60 });
  assert.equal(second.accepted, false);
  assert.equal(second.step, 9);
  assert.equal(second.reason, 'redelivery-freshness-rejected');
});

test('redelivery with EXPIRED envelope (notAfter < now) rejects at step 9', async () => {
  const store = buildStore();
  const fixture = buildWrap();
  const expiredEnvelope = buildFreshnessEnvelope({
    opId: fixture.operation.opId,
    opDigestHex: fixture.boundDigest,
    issuedAt: T0 - 7200,
    notAfter: T0 - 3600,
    senderDeviceId: fixture.senderDevicePubkey,
    recipientRoutePubkey: ROUTE_PK,
  });
  const redelivered = buildWrap({ freshnessEnvelope: expiredEnvelope, wrapCreatedAt: T0 + 900 });
  const receiver = createTestReceiver(baseReceiverOptions({ store, certificatesByDevice: { [fixture.senderDevicePubkey]: fixture.certificate } }));
  const first = await receiver.receive(fixture.wrap, { nowSeconds: T0 + 30 });
  assert.equal(first.accepted, true);
  const second = await receiver.receive(redelivered.wrap, { nowSeconds: T0 + 60 });
  assert.equal(second.reason, 'redelivery-freshness-rejected');
});

test('redelivery WITHOUT an envelope behaves exactly as today (duplicate-suppressed)', async () => {
  const store = buildStore();
  const fixture = buildWrap();
  let effectCount = 0;
  const receiver = createTestReceiver({
    ...baseReceiverOptions({ store, certificatesByDevice: { [fixture.senderDevicePubkey]: fixture.certificate } }),
    onApplicationEffect: async () => { effectCount += 1; },
  });
  const first = await receiver.receive(fixture.wrap, { nowSeconds: T0 + 30 });
  assert.equal(first.accepted, true);
  const second = await receiver.receive(buildWrap({ wrapCreatedAt: T0 + 900 }).wrap, { nowSeconds: T0 + 1000 });
  assert.equal(second.accepted, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.reason, 'duplicate-suppressed');
  assert.equal(effectCount, 1);
  assert.ok(await store.getInboundJournalEntry(fixture.senderDevicePubkey, OP_ID));
  assert.equal((await store.getInboundJournalEntry(fixture.senderDevicePubkey, OP_ID)).dedupeDigest, dedupeKeyDigest(fixture.senderDevicePubkey, OP_ID));
});
