// Isolated NIP-59 transport for authenticated device-authority changes.
// These events are not published by application code. Each recipient receives
// an encrypted copy routed to that device's public credential, never account N.
import { nip59 } from 'nostr-tools';
import { getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { rumorTags, sealAndWrap } from './giftWrap.js';
import { unwrapToRumor } from './giftUnwrap.js';
import {
  verifyDeviceAuthorityPolicy, verifyDeviceAuthorityRegistry, verifyDeviceAuthorityReplacement,
} from './deviceAuthority.js';

const PROTOCOL = 'cipher-private-device-authority-update';
const HEX64 = /^[0-9a-f]{64}$/;

function policyBody(event) {
  try { return JSON.parse(event?.content || ''); } catch { return null; }
}

function deviceRow(registryEvent, pubkey) {
  return JSON.parse(registryEvent.content).devices.find((row) => row.pubkey === pubkey && row.status === 'active');
}

function validHead(event, policyEvent, predecessorEvent, now) {
  const body = policyBody(policyEvent);
  if (!event || getEventHash(event) !== event.id || !verifyEvent(event)) return false;
  const registry = JSON.parse(event.content);
  if (registry?.policyId !== policyEvent.id || registry.authorityPubkey !== body?.authorityPubkey) return false;
  return verifyDeviceAuthorityRegistry(event, policyEvent, { previousEvent: predecessorEvent, now }) !== null;
}

function validCheckpoint(checkpoint, now) {
  if (!checkpoint || checkpoint.policyId !== checkpoint.policyEvent?.id
    || checkpoint.registryId !== checkpoint.registryEvent?.id
    || !Array.isArray(checkpoint.registryHistory) || checkpoint.registryHistory.length < 1) return false;
  const policyBodyValue = policyBody(checkpoint.policyEvent);
  if (!verifyDeviceAuthorityPolicy(checkpoint.policyEvent, {
    expectedAccount: checkpoint.accountPubkey,
    expectedRecovery: checkpoint.recoveryPubkey,
    now,
  }) || policyBodyValue.accountPubkey !== checkpoint.accountPubkey) return false;
  let previous = null;
  for (const event of checkpoint.registryHistory) {
    if (!verifyDeviceAuthorityRegistry(event, checkpoint.policyEvent, { previousEvent: previous, now })) return false;
    previous = event;
  }
  return previous?.id === checkpoint.registryId;
}

function makeWrap({ payload, senderSecret, recipientPubkey, now }) {
  const senderPubkey = senderSecret instanceof Uint8Array && senderSecret.length === 32 ? getPublicKey(senderSecret) : '';
  if (!senderPubkey || !HEX64.test(recipientPubkey || '') || !Number.isSafeInteger(now)) {
    throw new Error('An authorized device credential, recipient device, and timestamp are required.');
  }
  const rumor = nip59.createRumor({ kind: 4, created_at: now, tags: rumorTags({ recipient: recipientPubkey }),
    content: JSON.stringify({ protocol: PROTOCOL, version: 1, ...payload }) }, senderSecret);
  return sealAndWrap(rumor, { senderSk: senderSecret, recipientPubkey }).wrap;
}

export function buildDeviceRegistryUpdateWrap({ policyEvent, previousRegistryEvent, nextRegistryEvent,
  previousHeadPredecessorEvent = null, senderSecret, recipientPubkey, now = Math.floor(Date.now() / 1000) } = {}) {
  const policy = policyBody(policyEvent);
  if (!policy || getPublicKey(senderSecret) !== policy.primaryDevicePubkey
    || !validHead(previousRegistryEvent, policyEvent, previousHeadPredecessorEvent, now)
    || !verifyDeviceAuthorityRegistry(nextRegistryEvent, policyEvent, { previousEvent: previousRegistryEvent, now })
    || !deviceRow(previousRegistryEvent, getPublicKey(senderSecret))
    || !deviceRow(nextRegistryEvent, recipientPubkey)) {
    throw new Error('The registry update must be sent by the current primary to an active post-update device.');
  }
  return makeWrap({ payload: { type: 'registry-update', policyEvent, previousRegistryEvent, nextRegistryEvent },
    senderSecret, recipientPubkey, now });
}

// Send an authenticated owner registry transition to a separately pinned
// contact device. The older helper above intentionally serves sibling
// devices only; this helper checks both trust domains before creating a
// private NIP-59 envelope.
export function buildPeerDeviceRegistryUpdateWrap({ policyEvent, previousRegistryEvent,
  previousHeadPredecessorEvent = null, nextRegistryEvent, senderSecret, recipientCheckpoint,
  recipientDeviceId, expectedSenderRecoveryPubkey, now = Math.floor(Date.now() / 1000) } = {}) {
  const senderPolicy = policyBody(policyEvent);
  const sender = verifyDeviceAuthorityPolicy(policyEvent, {
    expectedAccount: senderPolicy?.accountPubkey,
    expectedRecovery: expectedSenderRecoveryPubkey,
    now,
  });
  const recipientPolicyBody = policyBody(recipientCheckpoint?.policyEvent);
  const recipientPolicy = verifyDeviceAuthorityPolicy(recipientCheckpoint?.policyEvent, {
    expectedAccount: recipientCheckpoint?.accountPubkey,
    expectedRecovery: recipientCheckpoint?.recoveryPubkey,
    now,
  });
  const recipientHeadValid = recipientPolicy && validCheckpoint(recipientCheckpoint, now);
  const target = recipientHeadValid
    ? JSON.parse(recipientCheckpoint.registryEvent.content).devices.find((row) => row.deviceId === recipientDeviceId)
    : null;
  if (!sender || getPublicKey(senderSecret) !== sender.primaryDevicePubkey
    || sender.accountPubkey === recipientPolicyBody?.accountPubkey
    || !validHead(previousRegistryEvent, policyEvent, previousHeadPredecessorEvent, now)
    || !verifyDeviceAuthorityRegistry(nextRegistryEvent, policyEvent, { previousEvent: previousRegistryEvent, now })
    || !target || target.status !== 'active') {
    throw new Error('A pinned contact device and current primary-authorized registry update are required.');
  }
  return makeWrap({ payload: {
    type: 'peer-registry-update',
    senderPolicyEvent: policyEvent,
    previousRegistryEvent,
    nextRegistryEvent,
    recipientAccountPubkey: recipientCheckpoint.accountPubkey,
    recipientPolicyId: recipientCheckpoint.policyId,
    recipientRegistryId: recipientCheckpoint.registryId,
    recipientDeviceId,
  }, senderSecret, recipientPubkey: target.pubkey, now });
}

function recoveryReplacementCandidate(nextPolicyEvent, currentPolicyEvent, currentRecoveryPubkey, now) {
  const current = verifyDeviceAuthorityPolicy(currentPolicyEvent, {
    expectedAccount: policyBody(currentPolicyEvent)?.accountPubkey,
    expectedRecovery: currentRecoveryPubkey,
    now,
  });
  const nextBody = policyBody(nextPolicyEvent);
  const next = verifyDeviceAuthorityPolicy(nextPolicyEvent, {
    expectedAccount: current?.accountPubkey,
    expectedRecovery: nextBody?.recoveryPubkey,
    now,
  });
  return current && next && nextPolicyEvent.pubkey === next.recoveryPubkey
    && next.recoveryPubkey !== current.recoveryPubkey
    && next.authorityEpoch === current.authorityEpoch + 1
    && next.previousPolicyId === currentPolicyEvent.id
    && nextPolicyEvent.created_at >= currentPolicyEvent.created_at ? next : null;
}

// Deliver a recovery-root replacement candidate to a contact without treating
// the old Nostr account key or old recovery root as proof of the new identity.
// The recipient must display and compare the fingerprint before applying it.
export function buildPeerRecoveryRootReplacementWrap({ previousPolicyEvent, previousRecoveryPubkey,
  nextPolicyEvent, nextRegistryEvent, senderSecret, recipientCheckpoint, recipientDeviceId,
  now = Math.floor(Date.now() / 1000) } = {}) {
  const next = recoveryReplacementCandidate(nextPolicyEvent, previousPolicyEvent, previousRecoveryPubkey, now);
  const recipientBody = policyBody(recipientCheckpoint?.policyEvent);
  const target = validCheckpoint(recipientCheckpoint, now)
    ? JSON.parse(recipientCheckpoint.registryEvent.content).devices.find((row) => row.deviceId === recipientDeviceId)
    : null;
  if (!next || getPublicKey(senderSecret) !== next.primaryDevicePubkey
    || !verifyDeviceAuthorityRegistry(nextRegistryEvent, nextPolicyEvent, { now })
    || JSON.parse(nextRegistryEvent.content).generation !== 1
    || next.accountPubkey === recipientBody?.accountPubkey || !target || target.status !== 'active') {
    throw new Error('A valid new recovery identity and pinned contact device are required.');
  }
  return makeWrap({ payload: { type: 'peer-recovery-root-candidate', previousPolicyEvent,
    previousRecoveryPubkey, nextPolicyEvent, nextRegistryEvent,
    recipientAccountPubkey: recipientCheckpoint.accountPubkey,
    recipientPolicyId: recipientCheckpoint.policyId, recipientRegistryId: recipientCheckpoint.registryId,
    recipientDeviceId }, senderSecret, recipientPubkey: target.pubkey, now });
}

export function buildDeviceAuthorityReplacementWrap({ previousPolicyEvent, nextPolicyEvent, nextRegistryEvent,
  previousRegistryEvent, previousRegistryPredecessorEvent = null, senderSecret, recipientPubkey,
  expectedRecoveryPubkey, now = Math.floor(Date.now() / 1000) } = {}) {
  const previous = policyBody(previousPolicyEvent);
  const next = policyBody(nextPolicyEvent);
  if (!previous || !next || getPublicKey(senderSecret) !== next.primaryDevicePubkey
    || !verifyDeviceAuthorityReplacement(nextPolicyEvent, previousPolicyEvent, { recoveryPubkey: expectedRecoveryPubkey, now })
    || !verifyDeviceAuthorityRegistry(nextRegistryEvent, nextPolicyEvent, { now })
    || !validHead(previousRegistryEvent, previousPolicyEvent, previousRegistryPredecessorEvent, now)
    || !deviceRow(nextRegistryEvent, getPublicKey(senderSecret))
    || (!deviceRow(previousRegistryEvent, recipientPubkey) && !deviceRow(nextRegistryEvent, recipientPubkey))) {
    throw new Error('The replacement update must be sent by its newly recovery-authorized primary device.');
  }
  return makeWrap({ payload: { type: 'authority-replacement', previousPolicyEvent, nextPolicyEvent, nextRegistryEvent },
    senderSecret, recipientPubkey, now });
}

// The caller supplies its exact authenticated local checkpoint. Relays cannot
// choose a predecessor or authorize a sender by presenting a later snapshot.
export function openDeviceAuthorityUpdateWrap({ wrap, recipientSecret, policyEvent,
  registryEvent, registryPredecessorEvent = null, expectedRecoveryPubkey, now = Math.floor(Date.now() / 1000) } = {}) {
  try {
    const opened = unwrapToRumor(wrap, recipientSecret);
    const rumor = opened?.rumor;
    const recipient = getPublicKey(recipientSecret);
    const recipientTags = (rumor?.tags || []).filter((tag) => tag[0] === 'p');
    if (rumor?.kind !== 4 || recipientTags.length !== 1 || recipientTags[0][1] !== recipient) return null;
    const body = JSON.parse(rumor.content);
    if (body?.protocol !== PROTOCOL || body.version !== 1) return null;

    if (body.type === 'registry-update') {
      const oldPolicy = policyBody(policyEvent);
      if (!oldPolicy || rumor.pubkey !== oldPolicy.primaryDevicePubkey
        || body.policyEvent?.id !== policyEvent?.id
        || body.previousRegistryEvent?.id !== registryEvent?.id
        || !deviceRow(registryEvent, rumor.pubkey)
        || !validHead(body.previousRegistryEvent, policyEvent, registryPredecessorEvent, now)
        || !verifyDeviceAuthorityRegistry(body.nextRegistryEvent, policyEvent, { previousEvent: registryEvent, now })
        || !deviceRow(body.nextRegistryEvent, recipient)) return null;
      return { type: body.type, policyEvent, previousRegistryEvent: registryEvent,
        nextRegistryEvent: body.nextRegistryEvent };
    }

    if (body.type === 'authority-replacement') {
      const oldPolicy = policyBody(policyEvent);
      const nextPolicy = policyBody(body.nextPolicyEvent);
      if (!oldPolicy || !nextPolicy || body.previousPolicyEvent?.id !== policyEvent?.id
        || !validHead(registryEvent, policyEvent, registryPredecessorEvent, now)
        || !verifyDeviceAuthorityReplacement(body.nextPolicyEvent, policyEvent, { recoveryPubkey: expectedRecoveryPubkey, now })
        || rumor.pubkey !== nextPolicy.primaryDevicePubkey
        || !verifyDeviceAuthorityRegistry(body.nextRegistryEvent, body.nextPolicyEvent, { now })
        || (!deviceRow(registryEvent, recipient) && !deviceRow(body.nextRegistryEvent, recipient))) return null;
      return { type: body.type, previousPolicyEvent: policyEvent, nextPolicyEvent: body.nextPolicyEvent,
        nextRegistryEvent: body.nextRegistryEvent };
    }
    return null;
  } catch { return null; }
}

export function openPeerDeviceRegistryUpdateWrap({ wrap, recipientSecret, senderPolicyEvent,
  senderRecoveryPubkey, senderRegistryEvent, senderRegistryPredecessorEvent = null,
  recipientCheckpoint, now = Math.floor(Date.now() / 1000) } = {}) {
  try {
    const opened = unwrapToRumor(wrap, recipientSecret);
    const rumor = opened?.rumor;
    const recipient = getPublicKey(recipientSecret);
    const recipientTags = (rumor?.tags || []).filter((tag) => tag[0] === 'p');
    const senderPolicy = verifyDeviceAuthorityPolicy(senderPolicyEvent, {
      expectedAccount: policyBody(senderPolicyEvent)?.accountPubkey,
      expectedRecovery: senderRecoveryPubkey,
      now,
    });
    const recipientBody = policyBody(recipientCheckpoint?.policyEvent);
    const recipientPolicy = verifyDeviceAuthorityPolicy(recipientCheckpoint?.policyEvent, {
      expectedAccount: recipientCheckpoint?.accountPubkey,
      expectedRecovery: recipientCheckpoint?.recoveryPubkey,
      now,
    });
    const localDevice = recipientPolicy && recipientBody?.accountPubkey !== senderPolicy?.accountPubkey
      && validCheckpoint(recipientCheckpoint, now)
      ? JSON.parse(recipientCheckpoint.registryEvent.content).devices.find((row) =>
        row.pubkey === recipient && row.status === 'active')
      : null;
    const body = JSON.parse(rumor?.content || 'null');
    if (!senderPolicy || !localDevice || rumor?.kind !== 4 || recipientTags.length !== 1
      || recipientTags[0][1] !== recipient || !validHead(senderRegistryEvent, senderPolicyEvent,
        senderRegistryPredecessorEvent, now) || body?.protocol !== PROTOCOL || body.version !== 1
      || body.type !== 'peer-registry-update' || body.senderPolicyEvent?.id !== senderPolicyEvent.id
      || body.recipientAccountPubkey !== recipientBody.accountPubkey
      || body.recipientPolicyId !== recipientCheckpoint.policyId
      || body.recipientRegistryId !== recipientCheckpoint.registryId
      || body.recipientDeviceId !== localDevice.deviceId || !deviceRow(senderRegistryEvent, rumor.pubkey)
      || rumor.pubkey !== senderPolicy.primaryDevicePubkey
      || body.previousRegistryEvent?.id !== senderRegistryEvent.id
      || !verifyDeviceAuthorityRegistry(body.nextRegistryEvent, senderPolicyEvent,
        { previousEvent: senderRegistryEvent, now })) return null;
    return { type: 'registry-update', policyEvent: senderPolicyEvent,
      previousRegistryEvent: senderRegistryEvent, nextRegistryEvent: body.nextRegistryEvent };
  } catch { return null; }
}

export function openPeerRecoveryRootReplacementWrap({ wrap, recipientSecret, senderPolicyEvent,
  senderRecoveryPubkey, senderRegistryEvent, senderRegistryPredecessorEvent = null,
  recipientCheckpoint, now = Math.floor(Date.now() / 1000) } = {}) {
  try {
    const opened = unwrapToRumor(wrap, recipientSecret);
    const rumor = opened?.rumor;
    const recipient = getPublicKey(recipientSecret);
    const tags = (rumor?.tags || []).filter((tag) => tag[0] === 'p');
    const sender = verifyDeviceAuthorityPolicy(senderPolicyEvent, {
      expectedAccount: policyBody(senderPolicyEvent)?.accountPubkey,
      expectedRecovery: senderRecoveryPubkey,
      now,
    });
    const body = JSON.parse(rumor?.content || 'null');
    const recipientDevice = validCheckpoint(recipientCheckpoint, now)
      ? JSON.parse(recipientCheckpoint.registryEvent.content).devices.find((row) =>
        row.pubkey === recipient && row.status === 'active')
      : null;
    const candidate = sender && recoveryReplacementCandidate(body?.nextPolicyEvent,
      senderPolicyEvent, senderRecoveryPubkey, now);
    if (!sender || !candidate || !recipientDevice || rumor?.kind !== 4 || tags.length !== 1
      || tags[0][1] !== recipient || !validHead(senderRegistryEvent, senderPolicyEvent,
        senderRegistryPredecessorEvent, now)
      || rumor.pubkey !== candidate.primaryDevicePubkey
      || body?.protocol !== PROTOCOL || body.version !== 1 || body.type !== 'peer-recovery-root-candidate'
      || body.previousPolicyEvent?.id !== senderPolicyEvent.id
      || body.previousRecoveryPubkey !== senderRecoveryPubkey
      || body.recipientAccountPubkey !== recipientCheckpoint.accountPubkey
      || body.recipientPolicyId !== recipientCheckpoint.policyId
      || body.recipientRegistryId !== recipientCheckpoint.registryId
      || body.recipientDeviceId !== recipientDevice.deviceId
      || !verifyDeviceAuthorityRegistry(body.nextRegistryEvent, body.nextPolicyEvent, { now })
      || JSON.parse(body.nextRegistryEvent.content).generation !== 1) return null;
    return { type: body.type, previousPolicyEvent: senderPolicyEvent,
      nextPolicyEvent: body.nextPolicyEvent, nextRegistryEvent: body.nextRegistryEvent,
      recoveryPubkey: candidate.recoveryPubkey };
  } catch { return null; }
}
