// Isolated NIP-59 transport for authenticated device-authority changes.
// These events are not published by application code. Each recipient receives
// an encrypted copy routed to that device's public credential, never account N.
import { nip59 } from 'nostr-tools';
import { getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { rumorTags, sealAndWrap } from './giftWrap.js';
import { unwrapToRumor } from './giftUnwrap.js';
import {
  verifyDeviceAuthorityRegistry, verifyDeviceAuthorityReplacement,
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
