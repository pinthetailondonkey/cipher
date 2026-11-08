import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { db, openDBFor } from '../db.js';
import { setAtRestKeyProvider } from './messageAtRest.js';
import { buildDeviceRegistryEvent } from './deviceEnrollment.js';
import {
  acceptDeviceRegistry,
  commitEnrolledDevice,
  DeviceRegistryConflict,
  acceptPeerDeviceRegistry,
  loadDeviceCredential,
  loadPeerDeviceRegistry,
  loadDeviceRegistry,
} from './deviceRegistryStore.js';
import { commitRatchetDevicePublication, loadRatchetDeviceAccountState } from './dmRatchetTransactions.js';

const secret = generateSecretKey();
const owner = getPublicKey(secret);
const now = 1_800_000_000;
globalThis.localStorage = {
  values: new Map(),
  getItem(key) { return this.values.get(key) ?? null; },
  setItem(key, value) { this.values.set(key, String(value)); },
  removeItem(key) { this.values.delete(key); },
};
setAtRestKeyProvider(() => new Uint8Array(32).fill(44));
openDBFor(owner);

function event(generation, deviceRows) {
  return buildDeviceRegistryEvent({ accountSecret: secret, generation, devices: deviceRows }, now + generation);
}

test('the account database stores only sealed device authority and retains a monotonic generation checkpoint', async () => {
  await db.open();
  const row = { deviceId: 'a'.repeat(32), pubkey: owner, status: 'active', enrolledAt: now };
  const first = event(1, [row]);
  const next = event(2, [row, { deviceId: 'b'.repeat(32), pubkey: '1'.repeat(64), status: 'active', enrolledAt: now + 2 }]);
  await acceptDeviceRegistry(owner, first, now + 1);
  const storedFirst = await db.deviceAuth.get(owner);
  assert.equal(JSON.stringify(storedFirst).includes(first.content), false);
  await acceptDeviceRegistry(owner, next, now + 3);
  assert.deepEqual((await loadDeviceRegistry(owner, now + 3)).generation, 2);
  await assert.rejects(acceptDeviceRegistry(owner, first, now + 4), DeviceRegistryConflict);
  assert.equal((await loadDeviceRegistry(owner, now + 4)).event.id, next.id);
});

test('equal-generation equivocation and unaccounted signers are rejected', async () => {
  const row = { deviceId: 'c'.repeat(32), pubkey: owner, status: 'active', enrolledAt: now };
  const generation = 3;
  const accepted = event(generation, [row]);
  await acceptDeviceRegistry(owner, accepted, now + generation);
  const equivocation = event(generation, [row, { deviceId: 'd'.repeat(32), pubkey: '2'.repeat(64), status: 'active', enrolledAt: now + 1 }]);
  await assert.rejects(acceptDeviceRegistry(owner, equivocation, now + generation), DeviceRegistryConflict);
  const forged = { ...accepted, pubkey: 'f'.repeat(64) };
  await assert.rejects(acceptDeviceRegistry(owner, forged, now + generation), /signature|invalid/i);
});

test('device secret and authorization checkpoint commit together; revocation removes the local secret', async () => {
  const deviceSecret = generateSecretKey();
  const deviceId = 'e'.repeat(32);
  const root = { deviceId: 'c'.repeat(32), pubkey: owner, status: 'active', enrolledAt: now };
  const proposed = { deviceId, pubkey: getPublicKey(deviceSecret), status: 'active', enrolledAt: now + 4 };
  const enrollment = event(4, [root, proposed]);
  const before = await loadDeviceRegistry(owner, now + 4);
  const originalPut = db.ratchetDevices.put;
  db.ratchetDevices.put = async () => { throw new Error('device key storage failed'); };
  try {
    await assert.rejects(commitEnrolledDevice({ owner, event: enrollment, deviceId, deviceSecret, now: now + 4 }), /device key storage failed/);
  } finally {
    db.ratchetDevices.put = originalPut;
  }
  assert.equal((await loadDeviceRegistry(owner, now + 4)).generation, before.generation);
  assert.equal(await db.ratchetDevices.get(deviceId), undefined);

  await commitEnrolledDevice({ owner, event: enrollment, deviceId, deviceSecret, now: now + 4 });
  const rawDevice = await db.ratchetDevices.get(deviceId);
  assert.equal(JSON.stringify(rawDevice).includes(Buffer.from(deviceSecret).toString('hex')), false);
  assert.deepEqual(await loadDeviceCredential(owner, deviceId, now + 4), deviceSecret);

  const revoked = event(5, [root, { ...proposed, status: 'revoked', revokedAt: now + 5 }]);
  await acceptDeviceRegistry(owner, revoked, now + 5);
  assert.equal(await db.ratchetDevices.get(deviceId), undefined);
  await assert.rejects(loadDeviceCredential(owner, deviceId, now + 5), /unavailable|revoked/i);
});

test('peer registries are authenticated, sealed at rest, and reject replay or same-generation equivocation', async () => {
  const peerSecret = generateSecretKey();
  const peer = getPublicKey(peerSecret);
  const peerDevice = generateSecretKey();
  const makePeerEvent = (generation, deviceSecret = peerDevice) => buildDeviceRegistryEvent({
    accountSecret: peerSecret,
    generation,
    devices: [{
      deviceId: '9'.repeat(32),
      pubkey: getPublicKey(deviceSecret),
      status: 'active',
      enrolledAt: now - 3,
    }],
  }, now - 2);
  const first = makePeerEvent(1);
  await acceptPeerDeviceRegistry(owner, first, now);
  const stored = await db.peerDeviceAuth.get(peer);
  assert.equal(JSON.stringify(stored).includes(first.content), false,
    'the peer registry content must be encrypted in IndexedDB');
  assert.equal((await loadPeerDeviceRegistry(owner, peer, now)).event.id, first.id);

  const next = makePeerEvent(2);
  await acceptPeerDeviceRegistry(owner, next, now);
  assert.equal((await loadPeerDeviceRegistry(owner, peer, now)).generation, 2);
  await assert.rejects(acceptPeerDeviceRegistry(owner, first, now), DeviceRegistryConflict,
    'an old signed registry cannot roll back a peer checkpoint');

  const equivocation = makePeerEvent(2, generateSecretKey());
  await assert.rejects(acceptPeerDeviceRegistry(owner, equivocation, now), DeviceRegistryConflict,
    'a second signed registry at the same generation is not silently selected');
  assert.equal((await loadPeerDeviceRegistry(owner, peer, now)).event.id, next.id);
});

test('peer registry verification and persistence failures never replace the last accepted checkpoint', async () => {
  const peerSecret = generateSecretKey();
  const peer = getPublicKey(peerSecret);
  const makePeerEvent = (generation) => buildDeviceRegistryEvent({
    accountSecret: peerSecret,
    generation,
    devices: [{ deviceId: '8'.repeat(32), pubkey: peer, status: 'active', enrolledAt: now - 3 }],
  }, now - 2);
  const first = makePeerEvent(1);
  const next = makePeerEvent(2);
  await acceptPeerDeviceRegistry(owner, first, now);
  const before = await loadPeerDeviceRegistry(owner, peer, now);

  const forged = { ...next, pubkey: owner };
  await assert.rejects(acceptPeerDeviceRegistry(owner, forged, now), /signature|invalid/i);

  const originalPut = db.peerDeviceAuth.put;
  db.peerDeviceAuth.put = async () => { throw new Error('peer registry storage failed'); };
  try {
    await assert.rejects(acceptPeerDeviceRegistry(owner, next, now), /peer registry storage failed/);
  } finally {
    db.peerDeviceAuth.put = originalPut;
  }
  const after = await loadPeerDeviceRegistry(owner, peer, now);
  assert.equal(after.event.id, before.event.id);
  assert.equal(after.generation, before.generation);
});

test('publishing ratchet account state cannot overwrite the enrolled device credential', async () => {
  const deviceSecret = generateSecretKey();
  const deviceId = 'f'.repeat(32);
  const root = { deviceId: 'c'.repeat(32), pubkey: owner, status: 'active', enrolledAt: now };
  const device = { deviceId, pubkey: getPublicKey(deviceSecret), status: 'active', enrolledAt: now + 20 };
  const enrollment = event(20, [root, device]);
  await commitEnrolledDevice({ owner, event: enrollment, deviceId, deviceSecret, now: now + 20 });

  await commitRatchetDevicePublication({
    owner,
    deviceId,
    expectedVersion: 0,
    state: { accountPickle: 'ratchet-account-state' },
    event: { id: 'bundle-publication', sig: 'signed' },
    now: now + 21,
  });

  assert.deepEqual(await loadDeviceCredential(owner, deviceId, now + 21), deviceSecret);
  assert.deepEqual(await loadRatchetDeviceAccountState(owner, deviceId), {
    version: 1, value: { accountPickle: 'ratchet-account-state' },
  });
});
