// Disabled-by-default bridge between independent device authority and the
// experimental DM ratchet. Every message operation needs two fresh proofs:
// the sender's authority and the exact recipient device's authority.
import {
  verifyDeviceAuthorityPolicy,
  verifyDeviceAuthorityRegistry,
  verifyDeviceFreshnessResponseV2,
} from './deviceAuthority.js';
import { nip59 } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
import { rumorTags, sealAndWrap } from './giftWrap.js';
import { unwrapToRumor } from './giftUnwrap.js';

const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DM_SEND_PURPOSE = 'send-dm';

export function createRatchetOperationId(randomBytes = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto)) {
  if (typeof randomBytes !== 'function') throw new Error('Secure randomness is unavailable for a ratchet operation.');
  const bytes = randomBytes(new Uint8Array(16));
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new Error('Secure randomness returned an invalid ratchet operation id.');
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function checkedCheckpoint(checkpoint, now) {
  if (!checkpoint || !HEX64.test(checkpoint.accountPubkey || '') || !HEX64.test(checkpoint.recoveryPubkey || '')
    || checkpoint.policyId !== checkpoint.policyEvent?.id || checkpoint.registryId !== checkpoint.registryEvent?.id
    || !Array.isArray(checkpoint.registryHistory) || checkpoint.registryHistory.length < 1) return null;
  const policy = verifyDeviceAuthorityPolicy(checkpoint.policyEvent, {
    expectedAccount: checkpoint.accountPubkey,
    expectedRecovery: checkpoint.recoveryPubkey,
    now,
  });
  if (!policy) return null;
  let previous = null;
  for (const event of checkpoint.registryHistory) {
    if (!verifyDeviceAuthorityRegistry(event, checkpoint.policyEvent, { previousEvent: previous, now })) return null;
    previous = event;
  }
  if (previous?.id !== checkpoint.registryId || previous?.id !== checkpoint.registryEvent.id) return null;
  return { policy, registryEvent: previous };
}

// A proof is accepted only against a locally authenticated checkpoint. For a
// peer, callers must pass the result of loadPeerDeviceAuthority(), never a
// relay snapshot. The challenge and response are also embedded by the caller
// inside the NIP-59 sealed message before it is wrapped for relay delivery.
export function verifyRatchetDeviceProof({
  checkpoint, deviceId, requesterDeviceId, operationId, purpose = DM_SEND_PURPOSE,
  challengeEvent, responseEvent, now = Math.floor(Date.now() / 1000),
} = {}) {
  if (!HEX32.test(deviceId || '') || !HEX32.test(requesterDeviceId || '')
    || !HEX32.test(operationId || '') || purpose !== DM_SEND_PURPOSE) return null;
  const checked = checkedCheckpoint(checkpoint, now);
  if (!checked) return null;
  const proof = verifyDeviceFreshnessResponseV2(responseEvent, challengeEvent, {
    policyEvent: checkpoint.policyEvent,
    registryEvent: checked.registryEvent,
    expectedRegistryId: checkpoint.registryId,
    expectedPurpose: purpose,
    expectedOperationId: operationId,
    now,
  });
  if (!proof || proof.deviceId !== deviceId || proof.accountPubkey !== checkpoint.accountPubkey
    || proof.authorityEpoch !== checked.policy.authorityEpoch
    || proof.registryId !== checkpoint.registryId) return null;
  let challenge;
  try { challenge = JSON.parse(challengeEvent.content); } catch { return null; }
  if (challenge?.requesterDeviceId !== requesterDeviceId || challenge?.targetDeviceId !== deviceId) return null;
  const target = JSON.parse(checked.registryEvent.content).devices.find((row) => row.deviceId === deviceId);
  if (!target || target.status !== 'active' || target.pubkey !== proof.devicePubkey) return null;
  return {
    accountPubkey: checkpoint.accountPubkey,
    recoveryPubkey: checkpoint.recoveryPubkey,
    policyId: checkpoint.policyId,
    authorityEpoch: checked.policy.authorityEpoch,
    registryId: checkpoint.registryId,
    registryGeneration: JSON.parse(checked.registryEvent.content).generation,
    deviceId,
    devicePubkey: target.pubkey,
    operationId,
    purpose,
    freshUntil: proof.freshUntil,
    challengeEvent,
    responseEvent,
  };
}

// The sending account proves its current device is authorized, while the
// peer's independently pinned authority proves the precise target device is
// still active. Both proofs are scoped to the same single message operation.
export function authorizeRatchetSend({ operationId, sender, recipient, now = Math.floor(Date.now() / 1000) } = {}) {
  if (!HEX32.test(operationId || '') || !sender || !recipient
    || sender.deviceId !== sender.requesterDeviceId) return null;
  const senderProof = verifyRatchetDeviceProof({ ...sender, operationId, purpose: DM_SEND_PURPOSE, now });
  const recipientProof = verifyRatchetDeviceProof({ ...recipient, operationId, purpose: DM_SEND_PURPOSE, now });
  if (!senderProof || !recipientProof || senderProof.accountPubkey === recipientProof.accountPubkey
    || senderProof.devicePubkey === recipientProof.devicePubkey) return null;
  return {
    protocol: 'cipher-ratchet-authority-v2',
    operationId,
    purpose: DM_SEND_PURPOSE,
    sender: senderProof,
    recipient: recipientProof,
    freshUntil: Math.min(senderProof.freshUntil, recipientProof.freshUntil),
  };
}

// Build the only wire payload accepted by the isolated v2 ratchet path. The
// authorization proofs are inside the NIP-59 seal, so relays see neither
// account identity nor registry/recovery records. The per-device p tag is
// still relay-visible and is a known correlation surface.
export function buildAuthorizedRatchetDm({ authorization, ratchetCiphertext,
  senderDeviceSecret, recipientDevicePubkey, createdAt = Math.floor(Date.now() / 1000), clientId = null } = {}) {
  if (authorization?.protocol !== 'cipher-ratchet-authority-v2'
    || !HEX32.test(authorization.operationId || '')
    || typeof ratchetCiphertext !== 'string' || !ratchetCiphertext
    || getPublicKey(senderDeviceSecret) !== authorization.sender.devicePubkey
    || recipientDevicePubkey !== authorization.recipient.devicePubkey
    || !Number.isSafeInteger(createdAt) || authorization.freshUntil <= createdAt) {
    throw new Error('A fresh, device-bound ratchet authorization and ciphertext are required.');
  }
  const content = JSON.stringify({
    protocol: 'cipher-ratchet-dm-v2',
    version: 2,
    operationId: authorization.operationId,
    ratchetCiphertext,
    senderProof: {
      challengeEvent: authorization.sender.challengeEvent,
      responseEvent: authorization.sender.responseEvent,
    },
    recipientProof: {
      challengeEvent: authorization.recipient.challengeEvent,
      responseEvent: authorization.recipient.responseEvent,
    },
  });
  const rumor = nip59.createRumor({ kind: 4, created_at: createdAt,
    tags: rumorTags({ recipient: recipientDevicePubkey, clientId }), content }, senderDeviceSecret);
  return { ...sealAndWrap(rumor, { senderSk: senderDeviceSecret, recipientPubkey: recipientDevicePubkey }),
    operationId: authorization.operationId, rumorId: rumor.id };
}

export function openAuthorizedRatchetDm({ wrap, recipientDeviceSecret, senderCheckpoint, recipientCheckpoint,
  recipientDeviceId, recipientRequesterDeviceId, now = Math.floor(Date.now() / 1000) } = {}) {
  const opened = unwrapToRumor(wrap, recipientDeviceSecret);
  if (!opened || opened.rumor.kind !== 4) return null;
  let body;
  try { body = JSON.parse(opened.rumor.content); } catch { return null; }
  const recipientPubkey = getPublicKey(recipientDeviceSecret);
  const recipients = opened.rumor.tags.filter((tag) => tag[0] === 'p');
  if (body?.protocol !== 'cipher-ratchet-dm-v2' || body.version !== 2
    || !HEX32.test(body.operationId || '') || typeof body.ratchetCiphertext !== 'string'
    || !Array.isArray(body.senderProof?.challengeEvent?.tags)
    || !Array.isArray(body.recipientProof?.challengeEvent?.tags)
    || recipients.length !== 1 || recipients[0][1] !== recipientPubkey) return null;
  const senderProof = verifyRatchetDeviceProof({ checkpoint: senderCheckpoint,
    deviceId: JSON.parse(senderCheckpoint?.registryEvent?.content || 'null')?.devices
      ?.find((row) => row.pubkey === opened.rumor.pubkey)?.deviceId,
    requesterDeviceId: JSON.parse(body.senderProof.challengeEvent.content || 'null')?.requesterDeviceId,
    operationId: body.operationId, challengeEvent: body.senderProof.challengeEvent,
    responseEvent: body.senderProof.responseEvent, now });
  const recipientProof = verifyRatchetDeviceProof({ checkpoint: recipientCheckpoint,
    deviceId: recipientDeviceId, requesterDeviceId: recipientRequesterDeviceId,
    operationId: body.operationId, challengeEvent: body.recipientProof.challengeEvent,
    responseEvent: body.recipientProof.responseEvent, now });
  if (!senderProof || !recipientProof || senderProof.devicePubkey !== opened.rumor.pubkey
    || recipientProof.devicePubkey !== recipientPubkey) return null;
  return { rumorId: opened.rumor.id, operationId: body.operationId,
    senderAccountPubkey: senderProof.accountPubkey, senderDeviceId: senderProof.deviceId,
    recipientAccountPubkey: recipientProof.accountPubkey, recipientDeviceId: recipientProof.deviceId,
    ratchetCiphertext: body.ratchetCiphertext, senderProof, recipientProof };
}

export const dmRatchetAuthorityInternals = Object.freeze({ DM_SEND_PURPOSE });
