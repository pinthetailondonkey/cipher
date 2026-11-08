// Atomic persistence boundary for the DM Double Ratchet. The library's state
// is treated as a tentative clone until the matching ciphertext/journal is
// committed. Callers must discard the mutated WASM object if a CAS fails.
import { db, currentOwner } from '../db.js';
import { outboxRow } from './outbox.js';
import { openRatchetState, sealRatchetState } from './ratchetStateAtRest.js';
import { getPublicKey } from 'nostr-tools/pure';
import { verifyDeviceRegistryEvent } from './deviceEnrollment.js';
import { verifyDeviceFreshnessResponse } from './deviceFreshness.js';
import { authorizeRatchetSend, buildAuthorizedRatchetDm, openAuthorizedRatchetDm } from './dmRatchetAuthority.js';

export class RatchetStateConflict extends Error {
  constructor(collection, id) {
    super(`Ratchet state changed while processing ${collection}:${id}.`);
    this.name = 'RatchetStateConflict';
  }
}

function assertOwner(owner) {
  if (!owner || currentOwner() !== owner) {
    throw new Error('The unlocked account database changed before ratchet state could be committed.');
  }
}

async function currentVersion(table, id) {
  return (await table.get(id))?.version ?? null;
}

function assertVersion(actual, expected, collection, id) {
  if (actual !== expected) throw new RatchetStateConflict(collection, id);
}

function nextVersion(expected) {
  return expected === null ? 0 : expected + 1;
}

async function digestApplicationPayload(payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload ?? null));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function secretFromHex(secretHex) {
  if (typeof secretHex !== 'string' || !/^(?:[0-9a-f]{2}){32}$/i.test(secretHex)) return null;
  return Uint8Array.from({ length: 32 }, (_, index) => Number.parseInt(secretHex.slice(index * 2, index * 2 + 2), 16));
}

export async function loadRatchetState({ owner, collection, id, table }) {
  assertOwner(owner);
  const row = await table.get(id);
  if (!row) return null;
  const value = await openRatchetState({ owner, collection, id, sealed: row.sealed });
  return { version: row.version, value };
}

export async function loadRatchetDeviceAccountState(owner, deviceId) {
  const loaded = await loadRatchetState({
    owner, collection: 'devices', id: deviceId, table: db.ratchetDevices,
  });
  if (!loaded) return null;
  const state = loaded.value?.ratchetAccountState ?? loaded.value;
  return { version: loaded.version, value: state };
}

// Used when publishing a device identity/prekey bundle. Keeping the account
// pickle and signed bundle in one transaction prevents a published key from
// becoming orphaned if local state storage fails.
export async function commitRatchetDevicePublication({
  owner, deviceId, expectedVersion, state, event, relays = null, now = Date.now(),
}) {
  assertOwner(owner);
  if (!event?.id || !event?.sig) throw new Error('A signed prekey publication event is required.');
  const previous = await loadRatchetState({ owner, collection: 'devices', id: deviceId, table: db.ratchetDevices });
  if (!previous || previous.value?.deviceId !== deviceId || typeof previous.value?.secretHex !== 'string') {
    throw new Error('Ratchet account state requires an existing enrolled device credential.');
  }
  assertVersion(previous.version, expectedVersion, 'devices', deviceId);
  const sealed = await sealRatchetState({
    owner,
    collection: 'devices',
    id: deviceId,
    value: { ...previous.value, ratchetAccountState: state },
  });
  const version = nextVersion(expectedVersion);
  await db.transaction('rw', 'ratchetDevices', 'outbox', async () => {
    assertOwner(owner);
    assertVersion(await currentVersion(db.ratchetDevices, deviceId), expectedVersion, 'devices', deviceId);
    await db.ratchetDevices.put({ deviceId, version, updatedAt: now, sealed });
    await db.outbox.put(outboxRow(event, now, relays));
  });
  return version;
}

export async function commitRatchetOutbound({
  owner, sessionId, peerPubkey, peerDeviceId, expectedVersion, state,
  event, relays = null, authorization = null, now = Date.now(),
}) {
  assertOwner(owner);
  if (!event?.id || !event?.sig) throw new Error('A signed ratchet message is required.');
  if (!/^[0-9a-f]{64}$/.test(authorization?.expectedRequester || '')) {
    throw new Error('The ratchet send must name its authenticated requesting device.');
  }
  const fresh = verifyDeviceFreshnessResponse(
    authorization?.freshnessResponse,
    authorization?.challengeEvent,
    {
      expectedAuthority: peerPubkey,
      expectedRequester: authorization?.expectedRequester,
      expectedDeviceId: peerDeviceId,
      minimumRegistryGeneration: authorization?.minimumRegistryGeneration ?? 1,
      now: Math.floor(now / 1000),
    },
  );
  if (!fresh) throw new Error('A fresh authenticated authorization for this recipient device is required.');
  const sealed = await sealRatchetState({
    owner, collection: 'sessions', id: sessionId, value: state,
  });
  const version = nextVersion(expectedVersion);
  await db.transaction('rw', 'ratchetSessions', 'outbox', async () => {
    assertOwner(owner);
    assertVersion(await currentVersion(db.ratchetSessions, sessionId), expectedVersion, 'sessions', sessionId);
    await db.ratchetSessions.put({
      sessionId, peerPubkey, peerDeviceId, version, updatedAt: now, sealed,
    });
    await db.outbox.put(outboxRow(event, now, relays, {
      ratchetDelivery: {
        protocol: 'cipher-ratchet-device-delivery-v1',
        peerPubkey,
        peerDeviceId,
        registryGeneration: fresh.generation,
        freshUntil: fresh.freshUntil,
      },
    }));
  });
  return version;
}

// R5 isolated path: validate both independent authorities, put their proofs
// inside the NIP-59 seal, then atomically commit the ratchet state, immutable
// event, and operation-id journal. No production DM caller uses this until a
// separately approved protocol migration.
export async function commitRatchetOutboundV2({
  owner, sessionId, peerPubkey, peerDeviceId, expectedVersion, state,
  ratchetCiphertext, applicationPayload = null, senderDeviceSecret,
  authorization, relays = null, now = Date.now(),
}) {
  assertOwner(owner);
  if (!/^[0-9a-f]{64}$/.test(owner || '') || !sessionId || !/^[0-9a-f]{64}$/.test(peerPubkey || '')
    || !/^[0-9a-f]{32}$/.test(peerDeviceId || '') || typeof ratchetCiphertext !== 'string'
    || !ratchetCiphertext || !(senderDeviceSecret instanceof Uint8Array)) {
    throw new Error('A valid account, ratchet session, device target, and ciphertext are required.');
  }
  const nowSeconds = Math.floor(now / 1000);
  const operationId = authorization?.operationId;
  if (!/^[0-9a-f]{32}$/.test(operationId || '')) throw new Error('A unique ratchet operation id is required.');
  const authorized = authorizeRatchetSend({
    operationId,
    sender: authorization.sender,
    recipient: authorization.recipient,
    now: nowSeconds,
  });
  if (!authorized || authorized.sender.accountPubkey !== owner
    || authorized.recipient.accountPubkey !== peerPubkey
    || authorized.recipient.deviceId !== peerDeviceId) {
    throw new Error('Fresh independent sender and recipient device authorization is required.');
  }
  const payloadDigest = await digestApplicationPayload(applicationPayload);
  const existingOperation = await db.ratchetInbox.get(operationId);
  if (existingOperation) {
    const journal = await openRatchetState({ owner, collection: 'inbox', id: operationId, sealed: existingOperation.sealed });
    if (journal?.protocol !== 'cipher-ratchet-outbound-operation-v2'
      || journal.sessionId !== sessionId || journal.payloadDigest !== payloadDigest) {
      throw new Error('The ratchet operation id was already committed for different content.');
    }
    return { version: null, eventId: journal.eventId, alreadyCommitted: true };
  }
  const sealedMessage = buildAuthorizedRatchetDm({
    authorization: authorized,
    ratchetCiphertext,
    applicationPayload,
    senderDeviceSecret,
    recipientDevicePubkey: authorized.recipient.devicePubkey,
    createdAt: nowSeconds,
    clientId: operationId,
  });
  const event = sealedMessage.wrap;
  if (!event?.id || !event?.sig || event.kind !== 1059) throw new Error('A valid NIP-59 ratchet message is required.');
  const sealedState = await sealRatchetState({ owner, collection: 'sessions', id: sessionId, value: state });
  const sealedJournal = await sealRatchetState({
    owner, collection: 'inbox', id: operationId,
    value: { protocol: 'cipher-ratchet-outbound-operation-v2', operationId, sessionId,
      payloadDigest, eventId: event.id, peerPubkey, peerDeviceId },
  });
  const version = nextVersion(expectedVersion);
  let alreadyCommitted = false;
  await db.transaction('rw', 'ratchetSessions', 'outbox', 'ratchetInbox', async () => {
    assertOwner(owner);
    const prior = await db.ratchetInbox.get(operationId);
    if (prior) {
      alreadyCommitted = true;
      return;
    }
    assertVersion(await currentVersion(db.ratchetSessions, sessionId), expectedVersion, 'sessions', sessionId);
    await db.ratchetSessions.put({ sessionId, peerPubkey, peerDeviceId, version, updatedAt: now, sealed: sealedState });
    await db.outbox.put(outboxRow(event, now, relays, {
      ratchetDelivery: {
        protocol: 'cipher-ratchet-device-delivery-v2',
        peerPubkey,
        peerDeviceId,
        peerPolicyId: authorized.recipient.policyId,
        peerAuthorityEpoch: authorized.recipient.authorityEpoch,
        peerRegistryId: authorized.recipient.registryId,
        localPolicyId: authorized.sender.policyId,
        localAuthorityEpoch: authorized.sender.authorityEpoch,
        localRegistryId: authorized.sender.registryId,
        operationId,
        freshUntil: authorized.freshUntil,
      },
    }));
    await db.ratchetInbox.put({ eventId: operationId, chatId: sessionId, status: 'outbound-committed',
      receivedAt: now, sealed: sealedJournal });
  });
  if (alreadyCommitted) {
    const journalRow = await db.ratchetInbox.get(operationId);
    const journal = await openRatchetState({ owner, collection: 'inbox', id: operationId, sealed: journalRow.sealed });
    if (journal?.sessionId !== sessionId || journal?.payloadDigest !== payloadDigest) {
      throw new Error('A concurrent ratchet operation id was committed for different content.');
    }
    return { version: null, eventId: journal.eventId, alreadyCommitted: true };
  }
  return { version, eventId: event.id, event, alreadyCommitted: false };
}

// Refresh only the authorization fence for an already sealed, pending event.
// The immutable ciphertext and ratchet state never change during this retry.
export async function refreshRatchetOutboundAuthorization({
  owner, eventId, challengeEvent, freshnessResponse, expectedRequester,
  now = Date.now(),
}) {
  assertOwner(owner);
  if (!/^[0-9a-f]{64}$/.test(expectedRequester || '')) {
    throw new Error('The authorization refresh must name its authenticated requesting device.');
  }
  const pending = await db.outbox.get(eventId);
  const held = pending?.ratchetDelivery;
  if (!pending || pending.event?.id !== eventId
    || held?.protocol !== 'cipher-ratchet-device-delivery-v1') {
    throw new Error('The pending ratchet event has no recipient-device authorization fence.');
  }
  const fresh = verifyDeviceFreshnessResponse(freshnessResponse, challengeEvent, {
    expectedAuthority: held.peerPubkey,
    expectedRequester,
    expectedDeviceId: held.peerDeviceId,
    minimumRegistryGeneration: held.registryGeneration,
    now: Math.floor(now / 1000),
  });
  if (!fresh) throw new Error('A fresh authorization for the same active recipient device is required.');
  await db.transaction('rw', 'outbox', async () => {
    assertOwner(owner);
    const current = await db.outbox.get(eventId);
    const currentFence = current?.ratchetDelivery;
    if (current?.event?.id !== eventId
      || currentFence?.protocol !== 'cipher-ratchet-device-delivery-v1'
      || currentFence.peerPubkey !== held.peerPubkey
      || currentFence.peerDeviceId !== held.peerDeviceId
      || currentFence.registryGeneration > fresh.generation) {
      throw new Error('The pending ratchet authorization changed during refresh.');
    }
    await db.outbox.put({
      ...current,
      status: 'queued',
      nextRetryAt: 0,
      ratchetDelivery: {
        ...currentFence,
        registryGeneration: fresh.generation,
        freshUntil: fresh.freshUntil,
      },
    });
  });
  return { freshUntil: fresh.freshUntil, registryGeneration: fresh.generation };
}

// First inbound prekey message consumes a device one-time key. Commit that
// account mutation, its new session and an encrypted recovery journal
// together. A failed transaction leaves the saved OTK and session untouched.
export async function commitRatchetInitialInbound({
  owner, deviceId, expectedDeviceVersion, deviceState,
  sessionId, peerPubkey, peerDeviceId, sessionState,
  eventId, chatId, journal, now = Date.now(),
}) {
  assertOwner(owner);
  if (!eventId || !chatId) throw new Error('An inbound ratchet event needs stable identity and routing.');
  const existingDevice = await loadRatchetState({
    owner, collection: 'devices', id: deviceId, table: db.ratchetDevices,
  });
  if (!existingDevice || existingDevice.value?.deviceId !== deviceId
    || typeof existingDevice.value?.secretHex !== 'string') {
    throw new Error('Initial-session setup requires the existing enrolled device credential.');
  }
  assertVersion(existingDevice.version, expectedDeviceVersion, 'devices', deviceId);
  const [sealedDevice, sealedSession, sealedJournal] = await Promise.all([
    sealRatchetState({
      owner,
      collection: 'devices',
      id: deviceId,
      value: { ...existingDevice.value, ratchetAccountState: deviceState },
    }),
    sealRatchetState({ owner, collection: 'sessions', id: sessionId, value: sessionState }),
    sealRatchetState({ owner, collection: 'inbox', id: eventId, value: journal }),
  ]);
  const deviceVersion = nextVersion(expectedDeviceVersion);
  await db.transaction('rw', 'ratchetDevices', 'ratchetSessions', 'ratchetInbox', async () => {
    assertOwner(owner);
    assertVersion(await currentVersion(db.ratchetDevices, deviceId), expectedDeviceVersion, 'devices', deviceId);
    if (await db.ratchetInbox.get(eventId)) return;
    assertVersion(await currentVersion(db.ratchetSessions, sessionId), null, 'sessions', sessionId);
    await db.ratchetDevices.put({ deviceId, version: deviceVersion, updatedAt: now, sealed: sealedDevice });
    await db.ratchetSessions.put({
      sessionId, peerPubkey, peerDeviceId, version: 0, updatedAt: now, sealed: sealedSession,
    });
    await db.ratchetInbox.put({
      eventId, chatId, status: 'pending', receivedAt: now, sealed: sealedJournal,
    });
  });
  return deviceVersion;
}

// R5 isolated receive boundary. The NIP-59 envelope and both authority proofs
// are checked before the caller advances a tentative ratchet state. The
// operation id is the inbox key, so alternate wraps/retries cannot apply a
// commerce or message effect twice. Callers must discard callback state if
// this transaction conflicts or fails.
export async function commitRatchetInboundV2({
  owner, deviceId, recipientDeviceSecret, senderCheckpoint, recipientCheckpoint,
  recipientRequesterDeviceId, wrap, expectedVersion, processRatchetMessage,
  now = Date.now(),
}) {
  assertOwner(owner);
  if (!/^[0-9a-f]{64}$/.test(owner || '') || !/^[0-9a-f]{32}$/.test(deviceId || '')
    || typeof processRatchetMessage !== 'function') {
    throw new Error('An authenticated recipient device and ratchet message processor are required.');
  }
  const opened = openAuthorizedRatchetDm({
    wrap, recipientDeviceSecret, senderCheckpoint, recipientCheckpoint,
    recipientDeviceId: deviceId, recipientRequesterDeviceId,
    now: Math.floor(now / 1000),
  });
  if (!opened || opened.recipientDeviceId !== deviceId || opened.recipientAccountPubkey !== owner) {
    throw new Error('The ratchet message lacks fresh sender and recipient authority proofs.');
  }
  const claimToken = Array.from(crypto.getRandomValues(new Uint8Array(16)),
    (byte) => byte.toString(16).padStart(2, '0')).join('');
  let duplicateRow = null;
  let busy = false;
  await db.transaction('rw', 'ratchetInbox', async () => {
    assertOwner(owner);
    const current = await db.ratchetInbox.get(opened.operationId);
    if (!current) {
      await db.ratchetInbox.add({ eventId: opened.operationId, chatId: '', status: 'processing',
        receivedAt: now, rumorId: opened.rumorId, senderAccountPubkey: opened.senderAccountPubkey,
        claimToken, claimUntil: now + 60_000 });
      return;
    }
    if (current.rumorId !== opened.rumorId || current.senderAccountPubkey !== opened.senderAccountPubkey) {
      throw new Error('A ratchet operation id was replayed with different authenticated content.');
    }
    if (current.status !== 'processing') {
      duplicateRow = current;
      return;
    }
    if (current.claimUntil > now) {
      busy = true;
      return;
    }
    await db.ratchetInbox.put({ ...current, claimToken, claimUntil: now + 60_000 });
  });
  if (duplicateRow) {
    const previous = await openRatchetState({ owner, collection: 'inbox', id: opened.operationId, sealed: duplicateRow.sealed });
    if (previous?.protocol !== 'cipher-ratchet-inbound-operation-v2'
      || previous.senderAccountPubkey !== opened.senderAccountPubkey
      || previous.rumorId !== opened.rumorId) {
      throw new Error('The ratchet operation id does not match its durable receive journal.');
    }
    return { duplicate: true, operationId: opened.operationId, rumorId: opened.rumorId };
  }
  if (busy) return { busy: true, duplicate: false, operationId: opened.operationId, rumorId: opened.rumorId };

  // This callback may only prepare a tentative cryptographic transition and a
  // journal. It must not apply messages, orders, receipts or payment effects.
  // The durable reservation prevents concurrent tabs from running it twice;
  // the final state/journal transaction below is the only commit point.
  try {
    const transition = await processRatchetMessage({
      ratchetCiphertext: opened.ratchetCiphertext,
      applicationPayload: opened.applicationPayload,
      senderAccountPubkey: opened.senderAccountPubkey,
      senderDeviceId: opened.senderDeviceId,
      operationId: opened.operationId,
      expectedVersion,
    });
    if (!transition?.sessionId || !transition.sessionState || !transition.journal || !transition.chatId) {
      throw new Error('The ratchet processor did not return a complete durable transition.');
    }
    const version = nextVersion(expectedVersion);
    const [sealedSession, sealedJournal] = await Promise.all([
      sealRatchetState({ owner, collection: 'sessions', id: transition.sessionId, value: transition.sessionState }),
      sealRatchetState({
        owner, collection: 'inbox', id: opened.operationId,
        value: { protocol: 'cipher-ratchet-inbound-operation-v2', operationId: opened.operationId,
          rumorId: opened.rumorId, senderAccountPubkey: opened.senderAccountPubkey,
          senderDeviceId: opened.senderDeviceId, applicationPayload: opened.applicationPayload,
          journal: transition.journal },
      }),
    ]);
    await db.transaction('rw', 'ratchetSessions', 'ratchetInbox', async () => {
      assertOwner(owner);
      const current = await db.ratchetInbox.get(opened.operationId);
      if (current?.status !== 'processing' || current.claimToken !== claimToken) {
        throw new Error('The receive reservation expired or was claimed by another tab.');
      }
      assertVersion(await currentVersion(db.ratchetSessions, transition.sessionId), expectedVersion,
        'sessions', transition.sessionId);
      await db.ratchetSessions.put({ sessionId: transition.sessionId,
        peerPubkey: opened.senderAccountPubkey, peerDeviceId: opened.senderDeviceId,
        version, updatedAt: now, sealed: sealedSession });
      await db.ratchetInbox.put({ eventId: opened.operationId, chatId: transition.chatId,
        status: 'pending', receivedAt: now, rumorId: opened.rumorId,
        senderAccountPubkey: opened.senderAccountPubkey, sealed: sealedJournal });
    });
    return { duplicate: false, version, operationId: opened.operationId, rumorId: opened.rumorId,
      applicationPayload: opened.applicationPayload };
  } catch (error) {
    await db.transaction('rw', 'ratchetInbox', async () => {
      assertOwner(owner);
      const current = await db.ratchetInbox.get(opened.operationId);
      if (current?.status === 'processing' && current.claimToken === claimToken) {
        await db.ratchetInbox.delete(opened.operationId);
      }
    });
    throw error;
  }
}

export async function commitRatchetInbound({
  owner, sessionId, expectedVersion, sessionState, eventId, chatId,
  journal, now = Date.now(),
}) {
  assertOwner(owner);
  if (!eventId || !chatId) throw new Error('An inbound ratchet event needs stable identity and routing.');
  const [sealedSession, sealedJournal] = await Promise.all([
    sealRatchetState({ owner, collection: 'sessions', id: sessionId, value: sessionState }),
    sealRatchetState({ owner, collection: 'inbox', id: eventId, value: journal }),
  ]);
  const version = nextVersion(expectedVersion);
  await db.transaction('rw', 'ratchetSessions', 'ratchetInbox', async () => {
    assertOwner(owner);
    assertVersion(await currentVersion(db.ratchetSessions, sessionId), expectedVersion, 'sessions', sessionId);
    if (await db.ratchetInbox.get(eventId)) return;
    const existing = await db.ratchetSessions.get(sessionId);
    await db.ratchetSessions.put({
      ...existing, sessionId, version, updatedAt: now, sealed: sealedSession,
    });
    await db.ratchetInbox.put({
      eventId, chatId, status: 'pending', receivedAt: now, sealed: sealedJournal,
    });
  });
  return version;
}

export async function loadPendingRatchetInbox(owner, {
  deviceId, challengeEvent, freshnessResponse, now = Math.floor(Date.now() / 1000),
} = {}) {
  assertOwner(owner);
  if (!/^[0-9a-f]{32}$/.test(deviceId || '')) {
    throw new Error('A valid enrolled device is required to open pending DM messages.');
  }
  // Take one IndexedDB snapshot so a concurrent local revocation cannot be
  // observed halfway through the authorization/read sequence. Verification
  // and decryption happen after this read transaction, against the sealed rows
  // captured together at its serialization point.
  const [checkpoint, credentialRow, rows] = await db.transaction(
    'r', 'deviceAuth', 'ratchetDevices', 'ratchetInbox', async () => Promise.all([
      db.deviceAuth.get(owner),
      db.ratchetDevices.get(deviceId),
      db.ratchetInbox.where('status').equals('pending').sortBy('receivedAt'),
    ]),
  );
  if (!checkpoint || !credentialRow) {
    throw new Error('The active device authorization state is unavailable.');
  }
  const fresh = verifyDeviceFreshnessResponse(freshnessResponse, challengeEvent, {
    expectedAuthority: owner,
    expectedDeviceId: deviceId,
    minimumRegistryGeneration: checkpoint.generation,
    now,
  });
  if (!fresh) throw new Error('Fresh authority authorization is required before opening pending DM messages.');
  const [registryEvent, credential] = await Promise.all([
    openRatchetState({ owner, collection: 'device-registry', id: owner, sealed: checkpoint.sealed }),
    openRatchetState({ owner, collection: 'devices', id: deviceId, sealed: credentialRow.sealed }),
  ]);
  const registry = verifyDeviceRegistryEvent(registryEvent, owner, now, {
    minimumGeneration: checkpoint.generation,
  });
  const deviceSecret = secretFromHex(credential?.secretHex);
  if (!registry || registry.generation !== checkpoint.generation
    || credential?.deviceId !== deviceId
    || !deviceSecret
    || !registry.devices.some((row) => row.deviceId === deviceId
      && row.pubkey === getPublicKey(deviceSecret)
      && row.status === 'active')) {
    throw new Error('Pending DM authorization belongs to a revoked or invalid local device.');
  }
  if (fresh.generation < registry.generation) {
    throw new Error('The freshness response is older than this device’s held authorization state.');
  }
  if (fresh.requesterPubkey !== getPublicKey(deviceSecret)) {
    throw new Error('Pending DM authorization must be requested by this active device credential.');
  }
  const opened = await Promise.all(rows.map(async (row) => ({
    ...row,
    journal: await openRatchetState({
      owner, collection: 'inbox', id: row.eventId, sealed: row.sealed,
    }),
  })));
  const [latestCheckpoint, latestCredential] = await db.transaction(
    'r', 'deviceAuth', 'ratchetDevices', async () => Promise.all([
      db.deviceAuth.get(owner),
      db.ratchetDevices.get(deviceId),
    ]),
  );
  if (latestCheckpoint?.version !== checkpoint.version
    || latestCheckpoint?.eventId !== checkpoint.eventId
    || latestCredential?.version !== credentialRow.version) {
    throw new Error('Device authorization changed while opening pending DM messages.');
  }
  return opened;
}

export async function markRatchetInboxProcessed(owner, eventId) {
  assertOwner(owner);
  await db.transaction('rw', 'ratchetInbox', async () => {
    assertOwner(owner);
    const row = await db.ratchetInbox.get(eventId);
    if (row?.status === 'pending') {
      await db.ratchetInbox.put({ ...row, status: 'processed', processedAt: Date.now() });
    }
  });
}
