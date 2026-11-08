import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { db, openDBFor } from '../db.js';
import { setAtRestKeyProvider } from './messageAtRest.js';
import { buildDeviceRegistryEvent, revokeDevice } from './deviceEnrollment.js';
import { buildDeviceFreshnessResponse, createDeviceFreshnessChallenge } from './deviceFreshness.js';
import { acceptDeviceRegistry, commitEnrolledDevice, loadDeviceCredential } from './deviceRegistryStore.js';
import { shouldFlushOutboxRow } from './outbox.js';
import {
  commitRatchetInitialInbound,
  commitRatchetOutbound,
  loadRatchetDeviceAccountState,
  loadPendingRatchetInbox,
  loadRatchetState,
  markRatchetInboxProcessed,
  RatchetStateConflict,
  refreshRatchetOutboundAuthorization,
} from './dmRatchetTransactions.js';

const ownerSecret = generateSecretKey();
const owner = getPublicKey(ownerSecret);
const requesterSecret = generateSecretKey();
const peerAuthoritySecret = generateSecretKey();
const peerAuthority = getPublicKey(peerAuthoritySecret);
const peerDeviceSecret = generateSecretKey();
const peerDeviceId = 'f'.repeat(32);
const VAULT_KEY = Uint8Array.from({ length: 32 }, (_, index) => index + 9);
let registryGeneration = 0;
let registryEvent = null;
let activeRows = [];
let freshnessNonceByte = 1;

globalThis.localStorage = {
  values: new Map(),
  getItem(key) { return this.values.get(key) ?? null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); },
};
setAtRestKeyProvider(() => VAULT_KEY);

async function enrollTestDevice(deviceId, now = Math.floor(Date.now() / 1000)) {
  const deviceSecret = generateSecretKey();
  const row = { deviceId, pubkey: getPublicKey(deviceSecret), status: 'active', enrolledAt: now };
  activeRows = [...activeRows, row];
  registryGeneration += 1;
  registryEvent = buildDeviceRegistryEvent({
    accountSecret: ownerSecret,
    generation: registryGeneration,
    devices: activeRows,
  }, now);
  await commitEnrolledDevice({ owner, event: registryEvent, deviceId, deviceSecret, now });
  return { deviceId, deviceSecret, registryEvent, generation: registryGeneration };
}

function deviceFreshness(deviceId, currentRegistry = registryEvent, generation = registryGeneration, now = Math.floor(Date.now() / 1000), signer = requesterSecret) {
  const challengeEvent = createDeviceFreshnessChallenge({
    requesterSecret: signer,
    authorityPubkey: owner,
    deviceId,
    now,
    randomBytes: (target) => target.fill(freshnessNonceByte++),
  });
  const freshnessResponse = buildDeviceFreshnessResponse({
    challengeEvent,
    authoritySecret: ownerSecret,
    registryEvent: currentRegistry,
    currentGeneration: generation,
    now: now + 1,
  });
  return { challengeEvent, freshnessResponse };
}

let peerNonce = 50;
function peerFreshness(generation = 1, at = Math.floor(Date.now() / 1000), status = 'active') {
  const device = {
    deviceId: peerDeviceId,
    pubkey: getPublicKey(peerDeviceSecret),
    status,
    enrolledAt: at - 10,
    ...(status === 'revoked' ? { revokedAt: at - 1 } : {}),
  };
  const registry = buildDeviceRegistryEvent({
    accountSecret: peerAuthoritySecret,
    generation,
    devices: [
      device,
      { deviceId: '9'.repeat(32), pubkey: peerAuthority, status: 'active', enrolledAt: at - 10 },
    ],
  }, at - 2);
  const challengeEvent = createDeviceFreshnessChallenge({
    requesterSecret,
    authorityPubkey: peerAuthority,
    deviceId: peerDeviceId,
    now: at,
    randomBytes: (target) => target.fill(peerNonce++),
  });
  const freshnessResponse = buildDeviceFreshnessResponse({
    challengeEvent,
    authoritySecret: peerAuthoritySecret,
    registryEvent: registry,
    currentGeneration: generation,
    now: at + 1,
  });
  return {
    peerPubkey: peerAuthority,
    peerDeviceId,
    authorization: { challengeEvent, freshnessResponse, expectedRequester: getPublicKey(requesterSecret) },
    challengeEvent,
    freshnessResponse,
    registry,
    commitAt: (at + 2) * 1000,
  };
}

test('outbound ratchet state and immutable Nostr event commit together with CAS', async () => {
  openDBFor(owner);
  await db.open();
  const authorization = peerFreshness();
  const event = { id: 'out-1', sig: 'signed', kind: 1059, created_at: 100 };
  const version = await commitRatchetOutbound({
    owner,
    sessionId: 'session-1',
    peerPubkey: authorization.peerPubkey,
    peerDeviceId: authorization.peerDeviceId,
    expectedVersion: null,
    state: { pickle: 'secret state' },
    event,
    authorization: authorization.authorization,
    now: authorization.commitAt,
  });
  assert.equal(version, 0);
  assert.equal((await db.outbox.get('out-1')).event.id, 'out-1');
  assert.equal((await db.outbox.get('out-1')).ratchetDelivery.freshUntil, authorization.freshnessResponse.created_at + 30);
  const storedState = await db.ratchetSessions.get('session-1');
  assert.equal(JSON.stringify(storedState).includes('secret state'), false);
  assert.deepEqual(await loadRatchetState({
    owner, collection: 'sessions', id: 'session-1', table: db.ratchetSessions,
  }), { version: 0, value: { pickle: 'secret state' } });

  await assert.rejects(commitRatchetOutbound({
    owner,
    sessionId: 'session-unbound-requester',
    peerPubkey: authorization.peerPubkey,
    peerDeviceId: authorization.peerDeviceId,
    expectedVersion: null,
    state: { pickle: 'unbound requester' },
    event: { id: 'out-unbound-requester', sig: 'signed', kind: 1059 },
    authorization: { ...authorization.authorization, expectedRequester: undefined },
    now: authorization.commitAt,
  }), /authenticated requesting device/i);
  assert.equal(await db.outbox.get('out-unbound-requester'), undefined,
    'an authority response cannot be reused without binding the request to this sender');

  await assert.rejects(commitRatchetOutbound({
    owner,
    sessionId: 'session-1',
    peerPubkey: authorization.peerPubkey,
    peerDeviceId: authorization.peerDeviceId,
    expectedVersion: null,
    state: { pickle: 'stale state' },
    event: { id: 'out-2', sig: 'signed', kind: 1059 },
    authorization: authorization.authorization,
    now: authorization.commitAt + 1000,
  }), RatchetStateConflict);
  assert.equal(await db.outbox.get('out-2'), undefined, 'a losing CAS never publishes a second event');
});

test('outbox failure rolls back the tentative ratchet state transition', async () => {
  const authorization = peerFreshness();
  const originalPut = db.outbox.put;
  db.outbox.put = async () => { throw new Error('simulated outbox write failure'); };
  try {
    await assert.rejects(commitRatchetOutbound({
      owner,
      sessionId: 'session-1',
      peerPubkey: authorization.peerPubkey,
      peerDeviceId: authorization.peerDeviceId,
      expectedVersion: 0,
      state: { pickle: 'must not commit' },
      event: { id: 'out-failed', sig: 'signed', kind: 1059 },
      authorization: authorization.authorization,
      now: authorization.commitAt,
    }), /simulated outbox write failure/);
  } finally {
    db.outbox.put = originalPut;
  }
  const state = await loadRatchetState({
    owner, collection: 'sessions', id: 'session-1', table: db.ratchetSessions,
  });
  assert.deepEqual(state, { version: 0, value: { pickle: 'secret state' } });
  assert.equal(await db.outbox.get('out-failed'), undefined);
});

test('ratchet outbox holds expired authorization and refreshes only the same device fence', async () => {
  const first = peerFreshness(1);
  const event = { id: 'out-auth-refresh', sig: 'signed', kind: 1059, created_at: 100 };
  await commitRatchetOutbound({
    owner,
    sessionId: 'session-auth-refresh',
    peerPubkey: first.peerPubkey,
    peerDeviceId: first.peerDeviceId,
    expectedVersion: null,
    state: { pickle: 'ratchet-before-refresh' },
    event,
    authorization: first.authorization,
    now: first.commitAt,
  });
  const pending = await db.outbox.get(event.id);
  const expiredAt = (first.freshnessResponse.created_at + 30) * 1000;
  assert.equal(shouldFlushOutboxRow(pending, expiredAt, true), false,
    'a forced retry cannot publish after recipient authorization expires');
  await assert.rejects(refreshRatchetOutboundAuthorization({
    owner,
    eventId: event.id,
    ...first.authorization,
    now: expiredAt,
  }), /fresh authorization/i);

  const second = peerFreshness(2, first.freshnessResponse.created_at + 31);
  const refreshed = await refreshRatchetOutboundAuthorization({
    owner,
    eventId: event.id,
    ...second.authorization,
    now: second.commitAt,
  });
  assert.equal(refreshed.registryGeneration, 2);
  const held = await db.outbox.get(event.id);
  assert.equal(held.event.id, event.id, 'authorization refresh never changes the immutable event');
  assert.equal(shouldFlushOutboxRow(held, (second.freshnessResponse.created_at + 1) * 1000), true);
  assert.deepEqual(await loadRatchetState({
    owner, collection: 'sessions', id: 'session-auth-refresh', table: db.ratchetSessions,
  }), { version: 0, value: { pickle: 'ratchet-before-refresh' } },
  'authorization refresh never advances or resets ratchet state');

  const older = peerFreshness(1, second.freshnessResponse.created_at + 1);
  await assert.rejects(refreshRatchetOutboundAuthorization({
    owner,
    eventId: event.id,
    ...older.authorization,
    now: older.commitAt,
  }), /fresh authorization/i, 'a lower generation cannot revive the pending event');
  assert.equal((await db.outbox.get(event.id)).ratchetDelivery.registryGeneration, 2);
  assert.throws(() => peerFreshness(3, second.freshnessResponse.created_at + 2, 'revoked'), /cannot prove this device/i);
  assert.equal(shouldFlushOutboxRow(await db.outbox.get(event.id), (second.freshnessResponse.created_at + 31) * 1000, true), false);
});

test('consumed prekey, new session and sealed inbox journal are one transaction', async () => {
  const localDevice = await enrollTestDevice('a'.repeat(32));
  const eventId = 'incoming-1';
  await commitRatchetInitialInbound({
    owner,
    deviceId: localDevice.deviceId,
    expectedDeviceVersion: 0,
    deviceState: { pickle: 'account after OTK consumption' },
    sessionId: 'session-in',
    peerPubkey: 'peer',
    peerDeviceId: 'device-peer',
    sessionState: { pickle: 'new session' },
    eventId,
    chatId: 'peer',
    journal: { event: { id: eventId }, payload: { message: 'private plaintext' } },
    now: 2000,
  });
  const [device, session, rawJournal] = await Promise.all([
    db.ratchetDevices.get(localDevice.deviceId),
    db.ratchetSessions.get('session-in'),
    db.ratchetInbox.get(eventId),
  ]);
  assert.equal(JSON.stringify(device).includes('account after OTK'), false);
  assert.deepEqual(await loadDeviceCredential(owner, localDevice.deviceId), localDevice.deviceSecret,
    'consuming a prekey preserves the independent device credential');
  assert.deepEqual(await loadRatchetDeviceAccountState(owner, localDevice.deviceId), {
    version: 1, value: { pickle: 'account after OTK consumption' },
  });
  assert.equal(JSON.stringify(session).includes('new session'), false);
  assert.equal(JSON.stringify(rawJournal).includes('private plaintext'), false);
  const proof = deviceFreshness(localDevice.deviceId, registryEvent, registryGeneration, Math.floor(Date.now() / 1000), localDevice.deviceSecret);
  const pending = await loadPendingRatchetInbox(owner, {
    deviceId: localDevice.deviceId,
    ...proof,
    now: proof.freshnessResponse.created_at + 1,
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].journal.payload.message, 'private plaintext');
  await markRatchetInboxProcessed(owner, eventId);
  const afterProcessProof = deviceFreshness(localDevice.deviceId, registryEvent, registryGeneration, Math.floor(Date.now() / 1000), localDevice.deviceSecret);
  assert.equal((await loadPendingRatchetInbox(owner, {
    deviceId: localDevice.deviceId,
    ...afterProcessProof,
    now: afterProcessProof.freshnessResponse.created_at + 1,
  })).length, 0);
});

test('a second initial message cannot reset an existing peer session', async () => {
  const sessionId = 'session-reset-guard';
  const localDevice = await enrollTestDevice('e'.repeat(32));
  await commitRatchetInitialInbound({
    owner,
    deviceId: localDevice.deviceId,
    expectedDeviceVersion: 0,
    deviceState: { accountPickle: 'after-first-prekey' },
    sessionId,
    peerPubkey: 'peer',
    peerDeviceId: 'peer-device',
    sessionState: { pickle: 'established-session' },
    eventId: 'initial-event-1',
    chatId: 'peer',
    journal: { payload: 'first' },
  });
  const before = await loadRatchetState({ owner, collection: 'sessions', id: sessionId, table: db.ratchetSessions });
  await assert.rejects(commitRatchetInitialInbound({
    owner,
    deviceId: localDevice.deviceId,
    expectedDeviceVersion: 1,
    deviceState: { accountPickle: 'after-second-prekey' },
    sessionId,
    peerPubkey: 'peer',
    peerDeviceId: 'peer-device',
    sessionState: { pickle: 'attacker-reset-session' },
    eventId: 'initial-event-2',
    chatId: 'peer',
    journal: { payload: 'second' },
  }), /conflict|already exists/i);
  assert.deepEqual(await loadRatchetState({ owner, collection: 'sessions', id: sessionId, table: db.ratchetSessions }), before);
  assert.equal(await db.ratchetInbox.get('initial-event-2'), undefined);
  await markRatchetInboxProcessed(owner, 'initial-event-1');
});

test('pending ratchet plaintext is unavailable without a fresh active-device authorization', async () => {
  const localDevice = await enrollTestDevice('b'.repeat(32));
  await commitRatchetInitialInbound({
    owner,
    deviceId: localDevice.deviceId,
    expectedDeviceVersion: 0,
    deviceState: { accountPickle: 'pending-account' },
    sessionId: 'session-pending-gate',
    peerPubkey: 'peer',
    peerDeviceId: 'peer-device',
    sessionState: { pickle: 'pending-session' },
    eventId: 'pending-gate-event',
    chatId: 'peer',
    journal: { payload: 'must-not-open-after-revocation' },
  });
  await assert.rejects(loadPendingRatchetInbox(owner), /fresh|authorization|device/i);
  const foreignProof = deviceFreshness(localDevice.deviceId);
  await assert.rejects(loadPendingRatchetInbox(owner, {
    deviceId: localDevice.deviceId,
    ...foreignProof,
    now: foreignProof.freshnessResponse.created_at + 1,
  }), /this active device credential/i);
  const proof = deviceFreshness(localDevice.deviceId, registryEvent, registryGeneration, Math.floor(Date.now() / 1000), localDevice.deviceSecret);
  assert.equal((await loadPendingRatchetInbox(owner, {
    deviceId: localDevice.deviceId,
    ...proof,
    now: proof.freshnessResponse.created_at + 1,
  })).length, 1);

  const revoked = revokeDevice({
    registryEvent,
    deviceId: localDevice.deviceId,
    accountSecret: ownerSecret,
    now: proof.freshnessResponse.created_at + 2,
  });
  await acceptDeviceRegistry(owner, revoked, proof.freshnessResponse.created_at + 2);
  await assert.rejects(loadPendingRatchetInbox(owner, {
    deviceId: localDevice.deviceId,
    ...proof,
    now: proof.freshnessResponse.created_at + 3,
  }), /fresh|authorization|device/i);
  await assert.rejects(loadDeviceCredential(owner, localDevice.deviceId), /unavailable|revoked/i);
});
