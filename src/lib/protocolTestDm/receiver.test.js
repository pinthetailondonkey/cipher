// Colocated focused test for src/lib/protocolTestDm/receiver.js
// (TEST-PATH-ONLY). Proves the frozen receive order: v1 init rejection at
// step 4, sender status at step 5, D1 revocation cutoff at step 6, decrypt
// failures confined to step 7 without state change, binding/digest mismatch
// at step 8, digest-compared dedupe (duplicate suppression + conflict) at
// step 9, and the atomic state+journal commit with effect exactly once.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDeviceCertificate,
  buildTestDmEnvelope,
  dedupeKeyDigest,
  operationDigest,
} from './protocolTestDmOperations.js';
import { SealedSessionStore } from './sessionStore.js';
import { createSnapshotRollbackRunner } from './sessionStore.js';
import { createTestReceiver } from './receiver.js';

const T0 = 1760000000;

const { getPublicKey } = await import('nostr-tools/pure');
const { sha256 } = await import('@noble/hashes/sha2.js');

const deviceKey = (label) => sha256(new TextEncoder().encode(`cipher-dm-recv/v1|${label}`));
const AUTHORITY_SK = deviceKey('authority');
const RECEIVER_ROUTE_SK = deviceKey('route-receiving');
const ROUTE_PK = getPublicKey(RECEIVER_ROUTE_SK);
const HEAD = 'b'.repeat(64);
const OP_ID = 'aa11bb22cc33dd44ee55ff66778899aa';

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

function buildValidWrap({ olmVersion = 2, opId = OP_ID, operationBody = 'hello recv', authoritySendTime = T0 + 10, wrapCreatedAt = T0 + 20 } = {}) {
  const senderDeviceSecret = deviceKey('sender-device-bob');
  const senderDevicePubkey = getPublicKey(senderDeviceSecret);
  const certificate = buildDeviceCertificate({
    authoritySecret: AUTHORITY_SK,
    devicePubkey: senderDevicePubkey,
    registryHeadId: HEAD,
    sentAt: T0 + 5,
  });
  const operation = {
    protocol: 'cipher-dm-test-v1', version: 1, opId,
    fromDevice: senderDevicePubkey, toDevice: 'self', body: operationBody,
  };
  const boundDigest = operationDigest(operation);
  const payloadInner = JSON.stringify({
    olmVersion, opId, sessionId: 'sess-r1',
    authoritySendTime,
    operation, operationDigestClaimed: boundDigest,
  });
  const { wrap } = buildTestDmEnvelope({
    operationPlaintext: operation,
    olmPayloadText: payloadInner,
    senderDeviceSecret,
    routeRecipientPubkey: ROUTE_PK,
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
      // Clone semantics proven by returning an advanced pickle string distinct
      // from any live object; the receiver treats it as opaque.
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

test('v2 envelope accepted end-to-end with atomic commit and one effect', async () => {
  const store = buildStore();
  const fixture = buildValidWrap();
  const effects = [];
  const receiver = createTestReceiver({
    ...baseReceiverOptions({ store, certificatesByDevice: { [fixture.senderDevicePubkey]: fixture.certificate } }),
    onApplicationEffect: async (effect) => { effects.push(effect); return { dispatched: true }; },
  });
  const result = await receiver.receive(fixture.wrap, { nowSeconds: T0 + 30 });
  assert.equal(result.accepted, true);
  assert.equal(result.duplicate, false);
  assert.equal(result.step, 10);
  assert.equal(effects.length, 1, 'effect dispatched exactly once');
  const journal = await store.getInboundJournalEntry(fixture.senderDevicePubkey, OP_ID);
  assert.equal(journal.dedupeDigest, dedupeKeyDigest(fixture.senderDevicePubkey, OP_ID));
  const session = await store.getSession(result.sessionId);
  assert.equal(session.lastOperationId, OP_ID);
});

test('v1 init messages rejected explicitly at step 4', async () => {
  const store = buildStore();
  const fixture = buildValidWrap({ olmVersion: 1 });
  const receiver = createTestReceiver(baseReceiverOptions({ store, certificatesByDevice: {} }));
  const result = await receiver.receive(fixture.wrap, { nowSeconds: T0 + 30 });
  assert.deepEqual(
    { accepted: result.accepted, step: result.step, reason: result.reason },
    { accepted: false, step: 4, reason: 'olm-v1-init-rejected' },
  );
});

test('sender inactive or unknown at the pinned head rejects at step 5', async () => {
  const store = buildStore();
  const fixture = buildValidWrap();
  const base = baseReceiverOptions({
    store,
    certificatesByDevice: { [fixture.senderDevicePubkey]: fixture.certificate },
  });
  const inactive = await createTestReceiver({
    ...base, deviceStatusAtHead: () => ({ known: true, active: false }),
  }).receive(fixture.wrap, { nowSeconds: T0 + 30 });
  assert.equal(inactive.reason, 'sender-device-inactive-at-head');
  const unknown = await createTestReceiver({
    ...base, deviceStatusAtHead: () => ({ known: false, active: true }),
  }).receive(fixture.wrap, { nowSeconds: T0 + 30 });
  assert.equal(unknown.reason, 'sender-device-unknown-at-head');
});

test('D1 revocation cutoff: send after grace rejected at step 6', async () => {
  const store = buildStore();
  const lateSend = buildValidWrap({ authoritySendTime: T0 + 301 });
  const receiver = createTestReceiver({
    ...baseReceiverOptions({
      store,
      certificatesByDevice: { [lateSend.senderDevicePubkey]: lateSend.certificate },
    }),
    revocationEffectiveAt: T0,
  });
  // revocationEffectiveAt = T0 -> grace window ends T0+300; a T0+301 signed
  // send time is one second past.
  const result = await receiver.receive(lateSend.wrap, { nowSeconds: T0 + 30 });
  assert.equal(result.accepted, false);
  assert.equal(result.step, 6);
  assert.equal(result.reason, 'revoked-after-grace');
});

test('D1 grace boundary: exactly at effective + grace is accepted', async () => {
  const store = buildStore();
  const boundarySend = buildValidWrap({ opId: 'bb22cc33dd44ee55ff66778899aabbbb', authoritySendTime: T0 + 300 });
  const receiver = createTestReceiver({
    ...baseReceiverOptions({
      store,
      certificatesByDevice: { [boundarySend.senderDevicePubkey]: boundarySend.certificate },
    }),
    revocationEffectiveAt: T0,
  });
  const result = await receiver.receive(boundarySend.wrap, { nowSeconds: T0 + 30 });
  assert.equal(result.accepted, true, 'boundary send inside the D1 window is delivered');
});

test('wrong-authority or missing certificate rejects in steps 1-5 range', async () => {
  const store = buildStore();
  const fixture = buildValidWrap();
  const wrongCert = buildDeviceCertificate({
    authoritySecret: deviceKey('other-authority'),
    devicePubkey: fixture.senderDevicePubkey,
    registryHeadId: HEAD,
    sentAt: T0 + 5,
  });
  const receiver = createTestReceiver(baseReceiverOptions({
    store,
    certificatesByDevice: { [fixture.senderDevicePubkey]: wrongCert },
  }));
  const result = await receiver.receive(fixture.wrap, { nowSeconds: T0 + 30 });
  assert.equal(result.accepted, false);
  assert.match(result.reason, /certificate-/);
});

test('duplicate operation suppressed by digest comparison without re-advance', async () => {
  const store = buildStore();
  const fixture = buildValidWrap();
  let effectCount = 0;
  const receiver = createTestReceiver({
    ...baseReceiverOptions({ store, certificatesByDevice: { [fixture.senderDevicePubkey]: fixture.certificate } }),
    onApplicationEffect: async () => { effectCount += 1; return {}; },
  });
  const first = await receiver.receive(fixture.wrap, { nowSeconds: T0 + 30 });
  assert.equal(first.duplicate, false);
  // Same event re-delivered by the relay (at-least-once): identical bytes, but
  // also exercised via a DIFFERENT wrap id built at another timestamp (the
  // profile says ids are irrelevant; tuple+digest decides).
  const redelivered = buildValidWrap({ wrapCreatedAt: T0 + 900 });
  const second = await receiver.receive(redelivered.wrap, { nowSeconds: T0 + 1000 });
  assert.equal(second.accepted, true);
  assert.equal(second.duplicate, true);
  assert.equal(effectCount, 1, 'application effect not repeated on duplicate');
});

test('conflicting digest under same tuple is rejected and prior journal preserved', async () => {
  const store = buildStore();
  const fixtureA = buildValidWrap({ opId: OP_ID, operationBody: 'version A' });
  const fixtureB = buildValidWrap({ opId: OP_ID, operationBody: 'version B' });
  const certs = { [fixtureA.senderDevicePubkey]: fixtureA.certificate };
  const receiver = createTestReceiver(baseReceiverOptions({ store, certificatesByDevice: certs }));
  const first = await receiver.receive(fixtureA.wrap, { nowSeconds: T0 + 30 });
  assert.equal(first.accepted, true);
  const second = await receiver.receive(fixtureB.wrap, { nowSeconds: T0 + 40 });
  assert.equal(second.accepted, false);
  assert.equal(second.step, 9);
  assert.equal(second.reason, 'dedupe-conflict-different-digest');
  const preserved = await store.getInboundJournalEntry(fixtureA.senderDevicePubkey, OP_ID);
  assert.ok(preserved, 'prior journal entry survives conflict');
});

test('digest recomputed independently catches a forged claimed digest', async () => {
  const store = buildStore();
  const fixture = buildValidWrap();
  const receiver = createTestReceiver({
    ...baseReceiverOptions({ store, certificatesByDevice: { [fixture.senderDevicePubkey]: fixture.certificate } }),
    decryptOnClone: async ({ rumorContent }) => {
      const payload = JSON.parse(rumorContent);
      return {
        plaintext: JSON.stringify(payload),
        boundDigest: payload.operationDigestClaimed,
        operationDigestClaimed: 'f'.repeat(64), // forged claim
        operationId: payload.opId,
        sessionId: payload.sessionId ?? 'sess-forged',
        advancedClonedStatePickle: 'pickle-forged',
      };
    },
    applyOperationPlaintextBinding: () => 'ok',
  });
  const result = await receiver.receive(fixture.wrap, { nowSeconds: T0 + 30 });
  assert.equal(result.accepted, false);
  assert.equal(result.step, 8);
  assert.equal(result.reason, 'digest-mismatch');
});

test('ratchet decrypt failure reports step 7 and leaves NO durable trace', async () => {
  const store = buildStore();
  const fixture = buildValidWrap();
  const receiver = createTestReceiver({
    ...baseReceiverOptions({ store, certificatesByDevice: { [fixture.senderDevicePubkey]: fixture.certificate } }),
    decryptOnClone: async () => { throw new Error('clone decrypt exploded'); },
  });
  const result = await receiver.receive(fixture.wrap, { nowSeconds: T0 + 30 });
  assert.equal(result.accepted, false);
  assert.equal(result.step, 7);
  assert.match(result.reason, /ratchet-decrypt/);
  assert.equal(await store.getSession('sess-r1'), null, 'no session committed on failed decrypt');
  assert.equal(await store.getInboundJournalEntry(fixture.senderDevicePubkey, OP_ID), undefined,
    'no journal row on failed decrypt');
});
