// Local monotonic checkpoint for account-authorized device registry events.
// The registry remains out of relay-visible group traffic; these helpers do
// not publish it or claim that a relay can prove global freshness.
import { db, currentOwner } from '../db.js';
import { openRatchetState, sealRatchetState } from './ratchetStateAtRest.js';
import { verifyDeviceRegistryEvent } from './deviceEnrollment.js';
import { getPublicKey } from 'nostr-tools/pure';

export class DeviceRegistryConflict extends Error {
  constructor(accountPubkey) {
    super(`The authenticated device registry changed while updating ${accountPubkey}.`);
    this.name = 'DeviceRegistryConflict';
  }
}

function assertOwner(owner) {
  if (!owner || currentOwner() !== owner) throw new Error('Unlock the matching account before updating its device registry.');
}

export async function loadDeviceRegistry(owner, now = Math.floor(Date.now() / 1000)) {
  assertOwner(owner);
  const row = await db.deviceAuth.get(owner);
  if (!row) return null;
  const event = await openRatchetState({ owner, collection: 'device-registry', id: owner, sealed: row.sealed });
  const registry = verifyDeviceRegistryEvent(event, owner, now, { minimumGeneration: row.generation });
  if (!registry || registry.generation !== row.generation) throw new Error('The stored device registry failed authentication.');
  return { version: row.version, generation: row.generation, event, registry };
}

// A peer registry is accepted only after the caller has opened its private
// DM envelope. The signer is the peer account itself; generation checkpoints
// and equivocation checks mirror the local registry, while the event remains
// sealed under this account's at-rest key.
export async function acceptPeerDeviceRegistry(owner, event, now = Math.floor(Date.now() / 1000)) {
  assertOwner(owner);
  const peerPubkey = String(event?.pubkey || '').toLowerCase();
  const verified = verifyDeviceRegistryEvent(event, peerPubkey, now);
  if (!verified) throw new Error('The peer device registry signature, identity, or freshness is invalid.');
  const sealed = await sealRatchetState({
    owner,
    collection: 'peer-device-registry',
    id: peerPubkey,
    value: event,
  });
  let version = 0;
  await db.transaction('rw', 'peerDeviceAuth', async () => {
    assertOwner(owner);
    const existing = await db.peerDeviceAuth.get(peerPubkey);
    if (existing && verified.generation < existing.generation) throw new DeviceRegistryConflict(peerPubkey);
    if (existing && verified.generation === existing.generation) {
      if (existing.eventId !== event.id) throw new DeviceRegistryConflict(peerPubkey);
      version = existing.version;
      return;
    }
    version = (existing?.version ?? -1) + 1;
    await db.peerDeviceAuth.put({
      peerPubkey,
      generation: verified.generation,
      eventId: event.id,
      version,
      updatedAt: Date.now(),
      sealed,
    });
  });
  return version;
}

export async function loadPeerDeviceRegistry(owner, peerPubkey, now = Math.floor(Date.now() / 1000)) {
  assertOwner(owner);
  const peer = String(peerPubkey || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(peer)) throw new Error('A valid peer account is required.');
  const row = await db.peerDeviceAuth.get(peer);
  if (!row) return null;
  const event = await openRatchetState({
    owner,
    collection: 'peer-device-registry',
    id: peer,
    sealed: row.sealed,
  });
  const registry = verifyDeviceRegistryEvent(event, peer, now, { minimumGeneration: row.generation });
  if (!registry || registry.generation !== row.generation || event.id !== row.eventId) {
    throw new Error('The stored peer device registry failed authentication.');
  }
  return { version: row.version, generation: row.generation, event, registry };
}

export async function acceptDeviceRegistry(owner, event, now = Math.floor(Date.now() / 1000)) {
  assertOwner(owner);
  const verified = verifyDeviceRegistryEvent(event, owner, now);
  if (!verified) throw new Error('The device registry signature, account binding, or freshness is invalid.');
  const sealed = await sealRatchetState({ owner, collection: 'device-registry', id: owner, value: event });
  let version = 0;
  await db.transaction('rw', 'deviceAuth', 'ratchetDevices', async () => {
    assertOwner(owner);
    const existing = await db.deviceAuth.get(owner);
    if (existing && verified.generation < existing.generation) throw new DeviceRegistryConflict(owner);
    if (existing && verified.generation === existing.generation) {
      if (existing.eventId !== event.id) throw new DeviceRegistryConflict(owner);
      version = existing.version;
      return;
    }
    version = (existing?.version ?? -1) + 1;
    await db.deviceAuth.put({
      accountPubkey: owner,
      generation: verified.generation,
      eventId: event.id,
      version,
      updatedAt: Date.now(),
      sealed,
    });
    const revokedIds = new Set(verified.devices.filter((device) => device.status === 'revoked').map((device) => device.deviceId));
    const localDeviceRows = await db.ratchetDevices.toArray();
    for (const row of localDeviceRows) {
      if (revokedIds.has(row.deviceId)) await db.ratchetDevices.delete(row.deviceId);
    }
  });
  return version;
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(value) {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2}){32}$/i.test(value)) return null;
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(value.slice(index * 2, index * 2 + 2), 16));
}

// Enrolling a device and storing its independent signing secret are one local
// transaction. If the write fails, neither the registry checkpoint nor the
// credential becomes durable; callers must not publish the device bundle.
export async function commitEnrolledDevice({
  owner, event, deviceId, deviceSecret, now = Math.floor(Date.now() / 1000),
}) {
  assertOwner(owner);
  if (!(deviceSecret instanceof Uint8Array) || deviceSecret.length !== 32) {
    throw new Error('A valid independent device signing secret is required.');
  }
  const registry = verifyDeviceRegistryEvent(event, owner, now);
  const devicePubkey = getPublicKey(deviceSecret);
  if (!registry?.devices.some((device) => device.deviceId === deviceId
    && device.pubkey === devicePubkey && device.status === 'active')) {
    throw new Error('The account has not authorized this device credential.');
  }
  const [sealedRegistry, sealedCredential] = await Promise.all([
    sealRatchetState({ owner, collection: 'device-registry', id: owner, value: event }),
    sealRatchetState({
      owner,
      collection: 'devices',
      id: deviceId,
      value: { deviceId, secretHex: bytesToHex(deviceSecret) },
    }),
  ]);
  let version = 0;
  await db.transaction('rw', 'deviceAuth', 'ratchetDevices', async () => {
    assertOwner(owner);
    const [authRow, deviceRow] = await Promise.all([
      db.deviceAuth.get(owner),
      db.ratchetDevices.get(deviceId),
    ]);
    if (deviceRow) throw new DeviceRegistryConflict(owner);
    if (authRow && registry.generation <= authRow.generation) throw new DeviceRegistryConflict(owner);
    version = (authRow?.version ?? -1) + 1;
    await db.deviceAuth.put({
      accountPubkey: owner,
      generation: registry.generation,
      eventId: event.id,
      version,
      updatedAt: Date.now(),
      sealed: sealedRegistry,
    });
    await db.ratchetDevices.put({ deviceId, version: 0, updatedAt: Date.now(), sealed: sealedCredential });
  });
  return version;
}

export async function loadDeviceCredential(owner, deviceId, now = Math.floor(Date.now() / 1000)) {
  assertOwner(owner);
  const [authRow, deviceRow] = await Promise.all([
    db.deviceAuth.get(owner),
    db.ratchetDevices.get(deviceId),
  ]);
  if (!authRow || !deviceRow) throw new Error('The enrolled device credential is unavailable.');
  const [event, credential] = await Promise.all([
    openRatchetState({ owner, collection: 'device-registry', id: owner, sealed: authRow.sealed }),
    openRatchetState({ owner, collection: 'devices', id: deviceId, sealed: deviceRow.sealed }),
  ]);
  const registry = verifyDeviceRegistryEvent(event, owner, now, { minimumGeneration: authRow.generation });
  const secret = hexToBytes(credential?.secretHex);
  if (!registry || registry.generation !== authRow.generation
    || credential?.deviceId !== deviceId || !secret
    || !registry.devices.some((device) => device.deviceId === deviceId
      && device.pubkey === getPublicKey(secret) && device.status === 'active')) {
    throw new Error('The device credential is revoked or failed account authorization.');
  }
  return secret;
}
