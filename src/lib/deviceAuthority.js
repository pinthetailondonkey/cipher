// Isolated v2 device-authority protocol foundation.
// These signed records are protocol payloads only; this module does not publish
// them to relays or persist the authority/recovery secrets.
import { finalizeEvent, getEventHash, getPublicKey, verifyEvent, generateSecretKey } from 'nostr-tools/pure';

export const DEVICE_AUTHORITY_POLICY_KIND = 30085;
export const DEVICE_AUTHORITY_REGISTRY_KIND = 30086;
export const DEVICE_AUTHORITY_ENROLLMENT_CHALLENGE_KIND = 30087;
export const DEVICE_AUTHORITY_ENROLLMENT_PROOF_KIND = 30088;
export const DEVICE_AUTHORITY_FRESHNESS_CHALLENGE_KIND = 30089;
export const DEVICE_AUTHORITY_FRESHNESS_RESPONSE_KIND = 30090;
export const DEVICE_AUTHORITY_PROTOCOL = 'cipher-device-authority';
export const DEVICE_AUTHORITY_POLICY_TAG = 'cipher-device-authority-v2';
export const DEVICE_AUTHORITY_REGISTRY_TAG = 'cipher-device-registry-v2';
export const DEVICE_AUTHORITY_CHALLENGE_TTL_SECONDS = 300;
export const DEVICE_AUTHORITY_LEASE_SECONDS = 30;

const HEX64 = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^[0-9a-f]{32}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;
const PURPOSE = /^[a-z][a-z0-9-]{0,31}$/;

function json(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function signed(event) {
  try { return !!event && getEventHash(event) === event.id && verifyEvent(event); }
  catch { return false; }
}

function secretKey(value) {
  return value instanceof Uint8Array && value.length === 32;
}

function validPubkey(value) {
  return typeof value === 'string' && HEX64.test(value);
}

function validDeviceId(value) {
  return typeof value === 'string' && DEVICE_ID.test(value);
}

function timestamp(now) {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('A valid protocol timestamp is required.');
}

function nonce(randomBytes) {
  if (typeof randomBytes !== 'function') throw new Error('Secure randomness is unavailable.');
  const bytes = randomBytes(new Uint8Array(32));
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('Secure randomness returned invalid bytes.');
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function randomDeviceId(randomBytes) {
  if (typeof randomBytes !== 'function') throw new Error('Secure randomness is unavailable for a device id.');
  const bytes = randomBytes(new Uint8Array(16));
  if (!(bytes instanceof Uint8Array) || bytes.length !== 16) throw new Error('Secure randomness returned an invalid device id.');
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function oneTag(event, name, expected) {
  const rows = event.tags.filter((tag) => tag[0] === name);
  return rows.length === 1 && rows[0][1] === expected;
}

function parsePolicy(event, { accountPubkey, recoveryPubkey, now = Math.floor(Date.now() / 1000), allowOld = false } = {}) {
  if (!signed(event) || event.kind !== DEVICE_AUTHORITY_POLICY_KIND || !Number.isSafeInteger(event.created_at)
    || event.created_at > now + 300 || (!allowOld && now - event.created_at > 365 * 86400)
    || !validPubkey(accountPubkey) || !validPubkey(recoveryPubkey) || event.pubkey !== recoveryPubkey
    || !oneTag(event, 'd', DEVICE_AUTHORITY_POLICY_TAG)) return null;
  const body = json(event.content);
  if (body?.protocol !== DEVICE_AUTHORITY_PROTOCOL || body.version !== 2 || body.type !== 'policy'
    || body.accountPubkey !== accountPubkey || body.recoveryPubkey !== recoveryPubkey
    || !validPubkey(body.authorityPubkey) || !Number.isSafeInteger(body.authorityEpoch) || body.authorityEpoch < 1
    || !validDeviceId(body.primaryDeviceId) || !validPubkey(body.primaryDevicePubkey)
    || body.authorityPubkey === recoveryPubkey || body.authorityPubkey === accountPubkey
    || body.primaryDevicePubkey === recoveryPubkey || body.primaryDevicePubkey === accountPubkey
    || body.primaryDevicePubkey === body.authorityPubkey || body.createdAt !== event.created_at) return null;
  if (body.authorityEpoch === 1) {
    if (body.previousPolicyId !== null) return null;
  } else if (!/^[0-9a-f]{64}$/.test(body.previousPolicyId || '')) return null;
  return body;
}

function policyFor(event, now = Math.floor(Date.now() / 1000)) {
  const body = json(event?.content);
  if (!body || !validPubkey(body.accountPubkey) || !validPubkey(body.recoveryPubkey)) return null;
  return parsePolicy(event, { accountPubkey: body.accountPubkey, recoveryPubkey: body.recoveryPubkey, now, allowOld: true });
}

function rowMap(rows) {
  return new Map(rows.map((row) => [row.deviceId, row]));
}

function validRows(rows, { allowNoActive = false } = {}) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 256) return false;
  const ids = new Set();
  const keys = new Set();
  let active = 0;
  for (const row of rows) {
    if (!row || !validDeviceId(row.deviceId) || !validPubkey(row.pubkey)
      || Object.keys(row).some((key) => !['deviceId', 'pubkey', 'status', 'enrolledAt', 'revokedAt'].includes(key))
      || !['active', 'revoked'].includes(row.status) || !Number.isSafeInteger(row.enrolledAt) || row.enrolledAt <= 0
      || (row.status === 'active' && row.revokedAt !== undefined)
      || (row.status === 'revoked' && (!Number.isSafeInteger(row.revokedAt) || row.revokedAt < row.enrolledAt))) return false;
    if (ids.has(row.deviceId) || keys.has(row.pubkey)) return false;
    ids.add(row.deviceId);
    keys.add(row.pubkey);
    if (row.status === 'active') active += 1;
  }
  return allowNoActive || active > 0;
}

function parseRegistry(event, policyEvent, now = Math.floor(Date.now() / 1000)) {
  const policy = policyFor(policyEvent, now);
  if (!policy || !signed(event) || event.kind !== DEVICE_AUTHORITY_REGISTRY_KIND
    || event.pubkey !== policy.authorityPubkey || !Number.isSafeInteger(event.created_at)
    || event.created_at < policyEvent.created_at || event.created_at > now + 300 || now - event.created_at > 365 * 86400
    || !oneTag(event, 'd', DEVICE_AUTHORITY_REGISTRY_TAG)) return null;
  const body = json(event.content);
  if (body?.protocol !== DEVICE_AUTHORITY_PROTOCOL || body.version !== 2 || body.type !== 'registry'
    || body.accountPubkey !== policy.accountPubkey || body.recoveryPubkey !== policy.recoveryPubkey
    || body.policyId !== policyEvent.id || body.authorityPubkey !== policy.authorityPubkey
    || body.authorityEpoch !== policy.authorityEpoch || !Number.isSafeInteger(body.generation) || body.generation < 1
    || !validRows(body.devices) || body.createdAt !== event.created_at
    || body.devices.some((row) => [policy.accountPubkey, policy.recoveryPubkey, policy.authorityPubkey].includes(row.pubkey))) return null;
  const primary = body.devices.find((row) => row.deviceId === policy.primaryDeviceId);
  if (!primary || primary.pubkey !== policy.primaryDevicePubkey || primary.status !== 'active') return null;
  if (body.generation === 1) {
    if (body.previousRegistryId !== policyEvent.id || body.devices.length !== 1 || !primary
      || primary.pubkey !== policy.primaryDevicePubkey || primary.status !== 'active') return null;
  } else if (!/^[0-9a-f]{64}$/.test(body.previousRegistryId || '')) return null;
  return body;
}

function requireRegistryHead(event, policyEvent, expectedRegistryId, now) {
  const registry = parseRegistry(event, policyEvent, now);
  const policy = policyFor(policyEvent, now);
  const expected = expectedRegistryId || (registry?.generation === 1 ? policyEvent?.id : '');
  if (!registry || !policy || !/^[0-9a-f]{64}$/.test(expected || '') || event.id !== expected) return null;
  return registry;
}

function validateSuccessor(previousEvent, nextEvent, policyEvent, now) {
  const previous = parseRegistry(previousEvent, policyEvent, now);
  const next = parseRegistry(nextEvent, policyEvent, now);
  if (!previous || !next || next.generation !== previous.generation + 1
    || next.previousRegistryId !== previousEvent.id || nextEvent.created_at < previousEvent.created_at) return null;
  const before = rowMap(previous.devices);
  const after = rowMap(next.devices);
  const added = [];
  const changed = [];
  for (const [id, oldRow] of before) {
    const newRow = after.get(id);
    if (!newRow) return null;
    if (JSON.stringify(oldRow) !== JSON.stringify(newRow)) {
      if (oldRow.status !== 'active' || newRow.status !== 'revoked'
        || oldRow.pubkey !== newRow.pubkey || oldRow.enrolledAt !== newRow.enrolledAt
        || !Number.isSafeInteger(newRow.revokedAt) || newRow.revokedAt < oldRow.enrolledAt) return null;
      changed.push(id);
    }
  }
  for (const [id, row] of after) if (!before.has(id)) added.push(row);
  if (changed.length + added.length !== 1 || (changed.length === 1 && added.length !== 0)
    || (added.length === 1 && (added[0].status !== 'active' || added[0].enrolledAt < previousEvent.created_at))) return null;
  return next;
}

function makePolicy({ accountPubkey, recoverySecret, authoritySecret, primaryDevice, authorityEpoch = 1, previousPolicyId = null, now }) {
  timestamp(now);
  if (!validPubkey(accountPubkey) || !secretKey(recoverySecret) || !secretKey(authoritySecret)
    || !primaryDevice || !validDeviceId(primaryDevice.deviceId) || !secretKey(primaryDevice.deviceSecret)) {
    throw new Error('The account authority policy input is malformed.');
  }
  const recoveryPubkey = getPublicKey(recoverySecret);
  const authorityPubkey = getPublicKey(authoritySecret);
  const primaryDevicePubkey = getPublicKey(primaryDevice.deviceSecret);
  if (new Set([accountPubkey, recoveryPubkey, authorityPubkey, primaryDevicePubkey]).size !== 4) {
    throw new Error('Recovery, authority, account, and device credentials must be independent keys.');
  }
  if (!Number.isSafeInteger(authorityEpoch) || authorityEpoch < 1
    || (authorityEpoch === 1 ? previousPolicyId !== null : !/^[0-9a-f]{64}$/.test(previousPolicyId || ''))) {
    throw new Error('The authority epoch transition is malformed.');
  }
  return finalizeEvent({
    kind: DEVICE_AUTHORITY_POLICY_KIND,
    created_at: now,
    tags: [['d', DEVICE_AUTHORITY_POLICY_TAG]],
    content: JSON.stringify({
      protocol: DEVICE_AUTHORITY_PROTOCOL, version: 2, type: 'policy', accountPubkey,
      recoveryPubkey, authorityPubkey, authorityEpoch, primaryDeviceId: primaryDevice.deviceId,
      primaryDevicePubkey, previousPolicyId, createdAt: now,
    }),
  }, recoverySecret);
}

export function createIndependentDeviceCredential(randomBytes = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto)) {
  const deviceSecret = generateSecretKey();
  return { deviceId: randomDeviceId(randomBytes), devicePubkey: getPublicKey(deviceSecret), deviceSecret };
}

export function createDeviceAuthoritySetup({ accountPubkey, now = Math.floor(Date.now() / 1000), randomBytes } = {}) {
  const recoverySecret = generateSecretKey();
  const authoritySecret = generateSecretKey();
  const primaryDevice = createIndependentDeviceCredential(randomBytes);
  const policyEvent = makePolicy({ accountPubkey, recoverySecret, authoritySecret, primaryDevice, now });
  const registryEvent = buildInitialDeviceRegistry({ policyEvent, authoritySecret, primaryDevice, now });
  return { recoverySecret, authoritySecret, primaryDevice, policyEvent, registryEvent };
}

export function verifyDeviceAuthorityPolicy(event, { expectedAccount, expectedRecovery, now = Math.floor(Date.now() / 1000) } = {}) {
  return parsePolicy(event, { accountPubkey: expectedAccount, recoveryPubkey: expectedRecovery, now });
}

export function replaceDeviceAuthority({ currentPolicyEvent, recoverySecret, nextAuthoritySecret = generateSecretKey(), nextPrimaryDevice = createIndependentDeviceCredential(), now = Math.floor(Date.now() / 1000) }) {
  const current = policyFor(currentPolicyEvent, now);
  if (!current || currentPolicyEvent.pubkey !== getPublicKey(recoverySecret)) throw new Error('The recovery root cannot authenticate the current authority policy.');
  if (getPublicKey(nextAuthoritySecret) === current.authorityPubkey) throw new Error('Authority replacement requires a fresh independent key.');
  const policyEvent = makePolicy({
    accountPubkey: current.accountPubkey, recoverySecret, authoritySecret: nextAuthoritySecret,
    primaryDevice: nextPrimaryDevice, authorityEpoch: current.authorityEpoch + 1,
    previousPolicyId: currentPolicyEvent.id, now,
  });
  const registryEvent = buildInitialDeviceRegistry({ policyEvent, authoritySecret: nextAuthoritySecret, primaryDevice: nextPrimaryDevice, now });
  return {
    authoritySecret: nextAuthoritySecret,
    primaryDevice: nextPrimaryDevice,
    policyEvent,
    registryEvent,
  };
}

// Recovery-root replacement is intentionally not accepted as a cryptographic
// successor by itself. Existing contacts must compare the new root fingerprint
// independently; this helper only creates the new-root-signed candidate.
export function createDeviceRecoveryRootReplacement({ currentPolicyEvent, newRecoverySecret,
  nextAuthoritySecret = generateSecretKey(), nextPrimaryDevice = createIndependentDeviceCredential(),
  now = Math.floor(Date.now() / 1000) } = {}) {
  const current = policyFor(currentPolicyEvent, now);
  if (!current || !secretKey(newRecoverySecret)
    || getPublicKey(newRecoverySecret) === current.recoveryPubkey) {
    throw new Error('A new independent recovery root and current policy are required.');
  }
  const policyEvent = makePolicy({
    accountPubkey: current.accountPubkey,
    recoverySecret: newRecoverySecret,
    authoritySecret: nextAuthoritySecret,
    primaryDevice: nextPrimaryDevice,
    authorityEpoch: current.authorityEpoch + 1,
    previousPolicyId: currentPolicyEvent.id,
    now,
  });
  const registryEvent = buildInitialDeviceRegistry({ policyEvent, authoritySecret: nextAuthoritySecret,
    primaryDevice: nextPrimaryDevice, now });
  return { recoverySecret: newRecoverySecret, authoritySecret: nextAuthoritySecret,
    primaryDevice: nextPrimaryDevice, policyEvent, registryEvent };
}

export function verifyDeviceAuthorityReplacement(nextPolicyEvent, currentPolicyEvent, { recoveryPubkey, now = Math.floor(Date.now() / 1000) } = {}) {
  const current = policyFor(currentPolicyEvent, now);
  if (!current || !parsePolicy(nextPolicyEvent, { accountPubkey: current.accountPubkey, recoveryPubkey, now })
    || nextPolicyEvent.pubkey !== recoveryPubkey) return null;
  const next = policyFor(nextPolicyEvent, now);
  if (next.authorityEpoch !== current.authorityEpoch + 1 || next.previousPolicyId !== currentPolicyEvent.id
    || nextPolicyEvent.created_at < currentPolicyEvent.created_at
    || next.recoveryPubkey !== current.recoveryPubkey || next.authorityPubkey === current.authorityPubkey
    || next.primaryDevicePubkey === current.primaryDevicePubkey) return null;
  return next;
}

export function buildInitialDeviceRegistry({ policyEvent, authoritySecret, primaryDevice, now = Math.floor(Date.now() / 1000) }) {
  const policy = policyFor(policyEvent, now);
  if (!policy || !secretKey(authoritySecret) || getPublicKey(authoritySecret) !== policy.authorityPubkey
    || getPublicKey(primaryDevice?.deviceSecret) !== policy.primaryDevicePubkey
    || primaryDevice.deviceId !== policy.primaryDeviceId) throw new Error('The primary device is not authorized by this recovery policy.');
  return finalizeEvent({
    kind: DEVICE_AUTHORITY_REGISTRY_KIND, created_at: now, tags: [['d', DEVICE_AUTHORITY_REGISTRY_TAG]],
    content: JSON.stringify({
      protocol: DEVICE_AUTHORITY_PROTOCOL, version: 2, type: 'registry', accountPubkey: policy.accountPubkey,
      recoveryPubkey: policy.recoveryPubkey, policyId: policyEvent.id, authorityPubkey: policy.authorityPubkey,
      authorityEpoch: policy.authorityEpoch, generation: 1, previousRegistryId: policyEvent.id,
      devices: [{ deviceId: primaryDevice.deviceId, pubkey: policy.primaryDevicePubkey, status: 'active', enrolledAt: now }],
      createdAt: now,
    }),
  }, authoritySecret);
}

export function verifyDeviceAuthorityRegistry(event, policyEvent, { previousEvent = null, now = Math.floor(Date.now() / 1000) } = {}) {
  const body = parseRegistry(event, policyEvent, now);
  if (!body) return null;
  if (body.generation === 1) return body;
  if (!previousEvent) return null;
  return validateSuccessor(previousEvent, event, policyEvent, now);
}

function parseEnrollmentChallenge(event, policyEvent, registryEvent, now, expectedRegistryId) {
  const policy = policyFor(policyEvent, now);
  const registry = requireRegistryHead(registryEvent, policyEvent, expectedRegistryId, now);
  if (!policy || !registry || !signed(event) || event.kind !== DEVICE_AUTHORITY_ENROLLMENT_CHALLENGE_KIND
    || event.pubkey !== policy.authorityPubkey || !Number.isSafeInteger(event.created_at)
    || event.created_at > now + 300 || now >= event.created_at + DEVICE_AUTHORITY_CHALLENGE_TTL_SECONDS) return null;
  const body = json(event.content);
  if (body?.protocol !== DEVICE_AUTHORITY_PROTOCOL || body.version !== 2 || body.type !== 'enrollment-challenge'
    || body.accountPubkey !== policy.accountPubkey || body.policyId !== policyEvent.id
    || body.registryId !== registryEvent.id || body.authorityEpoch !== policy.authorityEpoch
    || !validDeviceId(body.deviceId) || !validPubkey(body.devicePubkey) || !NONCE.test(body.nonce || '')
    || body.issuedAt !== event.created_at || body.expiresAt !== event.created_at + DEVICE_AUTHORITY_CHALLENGE_TTL_SECONDS
    || registry.devices.some((row) => row.deviceId === body.deviceId || row.pubkey === body.devicePubkey)) return null;
  return body;
}

export function createDeviceEnrollmentChallengeV2({ policyEvent, registryEvent, expectedRegistryId, authoritySecret, deviceId, devicePubkey, now = Math.floor(Date.now() / 1000), randomBytes = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto) }) {
  const policy = policyFor(policyEvent, now);
  const registry = requireRegistryHead(registryEvent, policyEvent, expectedRegistryId, now);
  if (!policy || !registry || getPublicKey(authoritySecret) !== policy.authorityPubkey
    || !validDeviceId(deviceId) || !validPubkey(devicePubkey)
    || registry.devices.some((row) => row.deviceId === deviceId || row.pubkey === devicePubkey)) throw new Error('The new device enrollment request is invalid.');
  const body = {
    protocol: DEVICE_AUTHORITY_PROTOCOL, version: 2, type: 'enrollment-challenge', accountPubkey: policy.accountPubkey,
    policyId: policyEvent.id, registryId: registryEvent.id, authorityEpoch: policy.authorityEpoch,
    deviceId, devicePubkey, nonce: nonce(randomBytes), issuedAt: now,
    expiresAt: now + DEVICE_AUTHORITY_CHALLENGE_TTL_SECONDS,
  };
  return finalizeEvent({ kind: DEVICE_AUTHORITY_ENROLLMENT_CHALLENGE_KIND, created_at: now, tags: [], content: JSON.stringify(body) }, authoritySecret);
}

export function buildDeviceEnrollmentProofV2({ challengeEvent, policyEvent, registryEvent, expectedRegistryId, deviceSecret, now = Math.floor(Date.now() / 1000) }) {
  const challenge = parseEnrollmentChallenge(challengeEvent, policyEvent, registryEvent, now, expectedRegistryId);
  if (!challenge || getPublicKey(deviceSecret) !== challenge.devicePubkey) throw new Error('The enrolled device could not prove possession of its new key.');
  return finalizeEvent({
    kind: DEVICE_AUTHORITY_ENROLLMENT_PROOF_KIND, created_at: now, tags: [['e', challengeEvent.id]],
    content: JSON.stringify({ protocol: DEVICE_AUTHORITY_PROTOCOL, version: 2, type: 'enrollment-proof',
      accountPubkey: challenge.accountPubkey, policyId: challenge.policyId, registryId: challenge.registryId,
      authorityEpoch: challenge.authorityEpoch, deviceId: challenge.deviceId, nonce: challenge.nonce, challengeId: challengeEvent.id }),
  }, deviceSecret);
}

function validEnrollmentProof(proofEvent, challengeEvent, challenge, now) {
  if (!signed(proofEvent) || proofEvent.kind !== DEVICE_AUTHORITY_ENROLLMENT_PROOF_KIND
    || proofEvent.pubkey !== challenge.devicePubkey || proofEvent.created_at < challenge.issuedAt
    || proofEvent.created_at >= challenge.expiresAt || proofEvent.created_at > now + 300
    || !oneTag(proofEvent, 'e', challengeEvent.id)) return false;
  const body = json(proofEvent.content);
  return body?.protocol === DEVICE_AUTHORITY_PROTOCOL && body.version === 2 && body.type === 'enrollment-proof'
    && body.accountPubkey === challenge.accountPubkey && body.policyId === challenge.policyId
    && body.registryId === challenge.registryId && body.authorityEpoch === challenge.authorityEpoch
    && body.deviceId === challenge.deviceId && body.nonce === challenge.nonce && body.challengeId === challengeEvent.id;
}

export function enrollDeviceV2({ policyEvent, registryEvent, expectedRegistryId, challengeEvent, proofEvent, authoritySecret, now = Math.floor(Date.now() / 1000) }) {
  const policy = policyFor(policyEvent, now);
  const registry = requireRegistryHead(registryEvent, policyEvent, expectedRegistryId, now);
  const challenge = parseEnrollmentChallenge(challengeEvent, policyEvent, registryEvent, now, expectedRegistryId);
  if (!policy || !registry || !challenge || getPublicKey(authoritySecret) !== policy.authorityPubkey
    || !validEnrollmentProof(proofEvent, challengeEvent, challenge, now)) throw new Error('Device enrollment is not authorized.');
  const devices = [...registry.devices, { deviceId: challenge.deviceId, pubkey: challenge.devicePubkey, status: 'active', enrolledAt: now }];
  return buildRegistrySuccessor({ policyEvent, previousEvent: registryEvent, devices, authoritySecret, now });
}

export function revokeDeviceV2({ policyEvent, registryEvent, expectedRegistryId, deviceId, authoritySecret, now = Math.floor(Date.now() / 1000) }) {
  const policy = policyFor(policyEvent, now);
  const registry = requireRegistryHead(registryEvent, policyEvent, expectedRegistryId, now);
  if (!policy || !registry || getPublicKey(authoritySecret) !== policy.authorityPubkey) throw new Error('The device registry is not authorized for revocation.');
  const target = registry.devices.find((row) => row.deviceId === deviceId && row.status === 'active');
  if (!target) throw new Error('This device is not active in the current registry.');
  if (deviceId === policy.primaryDeviceId) throw new Error('The primary authority device can only be replaced through recovery.');
  const devices = registry.devices.map((row) => row.deviceId === deviceId ? { ...row, status: 'revoked', revokedAt: now } : row);
  return buildRegistrySuccessor({ policyEvent, previousEvent: registryEvent, devices, authoritySecret, now });
}

function buildRegistrySuccessor({ policyEvent, previousEvent, devices, authoritySecret, now }) {
  const policy = policyFor(policyEvent, now);
  const previous = parseRegistry(previousEvent, policyEvent, now);
  if (!policy || !previous || getPublicKey(authoritySecret) !== policy.authorityPubkey || !validRows(devices, { allowNoActive: true })) {
    throw new Error('The registry successor is malformed or not authorized.');
  }
  const event = finalizeEvent({
    kind: DEVICE_AUTHORITY_REGISTRY_KIND, created_at: now, tags: [['d', DEVICE_AUTHORITY_REGISTRY_TAG]],
    content: JSON.stringify({ protocol: DEVICE_AUTHORITY_PROTOCOL, version: 2, type: 'registry',
      accountPubkey: policy.accountPubkey, recoveryPubkey: policy.recoveryPubkey, policyId: policyEvent.id,
      authorityPubkey: policy.authorityPubkey, authorityEpoch: policy.authorityEpoch,
      generation: previous.generation + 1, previousRegistryId: previousEvent.id, devices, createdAt: now }),
  }, authoritySecret);
  if (!validateSuccessor(previousEvent, event, policyEvent, now)) throw new Error('The requested registry change violates monotonic device authorization.');
  return event;
}

export function createDeviceFreshnessChallengeV2({ policyEvent, registryEvent, expectedRegistryId, requesterDeviceSecret, requesterDeviceId, targetDeviceId, purpose, operationId, now = Math.floor(Date.now() / 1000), randomBytes = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto) }) {
  timestamp(now);
  const policy = policyFor(policyEvent, now);
  const registry = requireRegistryHead(registryEvent, policyEvent, expectedRegistryId, now);
  const requesterPubkey = secretKey(requesterDeviceSecret) ? getPublicKey(requesterDeviceSecret) : '';
  if (!policy || !registry || !validDeviceId(requesterDeviceId) || !validDeviceId(targetDeviceId)
    || !registry.devices.some((row) => row.deviceId === requesterDeviceId && row.pubkey === requesterPubkey && row.status === 'active')
    || !registry.devices.some((row) => row.deviceId === targetDeviceId && row.status === 'active')
    || !PURPOSE.test(purpose || '') || !/^[0-9a-f]{32}$/.test(operationId || '')) throw new Error('The device freshness request is not authorized.');
  const body = { protocol: DEVICE_AUTHORITY_PROTOCOL, version: 2, type: 'freshness-challenge',
    accountPubkey: policy.accountPubkey, recoveryPubkey: policy.recoveryPubkey, policyId: policyEvent.id,
    registryId: registryEvent.id, authorityEpoch: policy.authorityEpoch, requesterDeviceId,
    requesterPubkey, targetDeviceId, purpose, operationId, nonce: nonce(randomBytes), issuedAt: now,
    expiresAt: now + DEVICE_AUTHORITY_CHALLENGE_TTL_SECONDS };
  return finalizeEvent({ kind: DEVICE_AUTHORITY_FRESHNESS_CHALLENGE_KIND, created_at: now, tags: [], content: JSON.stringify(body) }, requesterDeviceSecret);
}

function parseFreshnessChallenge(event, policyEvent, registryEvent, now, expectedRegistryId) {
  const policy = policyFor(policyEvent, now);
  const registry = requireRegistryHead(registryEvent, policyEvent, expectedRegistryId, now);
  if (!policy || !registry || !signed(event) || event.kind !== DEVICE_AUTHORITY_FRESHNESS_CHALLENGE_KIND
    || !Number.isSafeInteger(event.created_at) || event.created_at > now + 300
    || now >= event.created_at + DEVICE_AUTHORITY_CHALLENGE_TTL_SECONDS) return null;
  const body = json(event.content);
  const requester = registry.devices.find((row) => row.deviceId === body?.requesterDeviceId);
  const target = registry.devices.find((row) => row.deviceId === body?.targetDeviceId);
  if (body?.protocol !== DEVICE_AUTHORITY_PROTOCOL || body.version !== 2 || body.type !== 'freshness-challenge'
    || body.accountPubkey !== policy.accountPubkey || body.recoveryPubkey !== policy.recoveryPubkey
    || body.policyId !== policyEvent.id || body.registryId !== registryEvent.id || body.authorityEpoch !== policy.authorityEpoch
    || !requester || requester.status !== 'active' || requester.pubkey !== event.pubkey
    || !target || target.status !== 'active' || !validDeviceId(body.targetDeviceId)
    || !PURPOSE.test(body.purpose || '') || !/^[0-9a-f]{32}$/.test(body.operationId || '')
    || !NONCE.test(body.nonce || '') || body.issuedAt !== event.created_at
    || body.expiresAt !== event.created_at + DEVICE_AUTHORITY_CHALLENGE_TTL_SECONDS) return null;
  return body;
}

export function buildDeviceFreshnessResponseV2({ policyEvent, registryEvent, expectedRegistryId, challengeEvent, authoritySecret, now = Math.floor(Date.now() / 1000) }) {
  const policy = policyFor(policyEvent, now);
  const registry = requireRegistryHead(registryEvent, policyEvent, expectedRegistryId, now);
  const challenge = parseFreshnessChallenge(challengeEvent, policyEvent, registryEvent, now, expectedRegistryId);
  if (!policy || !registry || !challenge || getPublicKey(authoritySecret) !== policy.authorityPubkey) throw new Error('The authority cannot authorize a stale or inactive device.');
  const target = registry.devices.find((row) => row.deviceId === challenge.targetDeviceId && row.status === 'active');
  const expiresAt = Math.min(now + DEVICE_AUTHORITY_LEASE_SECONDS, challenge.expiresAt);
  return finalizeEvent({ kind: DEVICE_AUTHORITY_FRESHNESS_RESPONSE_KIND, created_at: now,
    tags: [['e', challengeEvent.id], ['expiration', String(expiresAt)]],
    content: JSON.stringify({ protocol: DEVICE_AUTHORITY_PROTOCOL, version: 2, type: 'freshness-response',
      challengeId: challengeEvent.id, nonce: challenge.nonce, accountPubkey: policy.accountPubkey,
      recoveryPubkey: policy.recoveryPubkey, policyId: policyEvent.id, registryId: registryEvent.id,
      authorityEpoch: policy.authorityEpoch, requesterDeviceId: challenge.requesterDeviceId,
      requesterPubkey: challenge.requesterPubkey, targetDeviceId: target.deviceId, targetPubkey: target.pubkey,
      purpose: challenge.purpose, operationId: challenge.operationId, issuedAt: now, expiresAt }) }, authoritySecret);
}

export function verifyDeviceFreshnessResponseV2(responseEvent, challengeEvent, {
  policyEvent, registryEvent, expectedPurpose, expectedOperationId,
  expectedRegistryId,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  try {
    const policy = policyFor(policyEvent, now);
    const registry = requireRegistryHead(registryEvent, policyEvent, expectedRegistryId, now);
    const challenge = parseFreshnessChallenge(challengeEvent, policyEvent, registryEvent, now, expectedRegistryId);
    if (!policy || !registry || !challenge || !signed(responseEvent)
      || responseEvent.kind !== DEVICE_AUTHORITY_FRESHNESS_RESPONSE_KIND
      || responseEvent.pubkey !== policy.authorityPubkey || responseEvent.created_at < challenge.issuedAt
      || responseEvent.created_at > now + 300 || now - responseEvent.created_at > DEVICE_AUTHORITY_LEASE_SECONDS) return null;
    const body = json(responseEvent.content);
    const expiryTags = responseEvent.tags.filter((tag) => tag[0] === 'expiration');
    if (body?.protocol !== DEVICE_AUTHORITY_PROTOCOL || body.version !== 2 || body.type !== 'freshness-response'
      || body.challengeId !== challengeEvent.id || body.nonce !== challenge.nonce
      || body.accountPubkey !== policy.accountPubkey || body.recoveryPubkey !== policy.recoveryPubkey
      || body.policyId !== policyEvent.id || body.registryId !== registryEvent.id || body.authorityEpoch !== policy.authorityEpoch
      || body.requesterDeviceId !== challenge.requesterDeviceId || body.requesterPubkey !== challenge.requesterPubkey
      || body.targetDeviceId !== challenge.targetDeviceId || body.purpose !== challenge.purpose
      || body.operationId !== challenge.operationId || body.issuedAt !== responseEvent.created_at
      || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= now
      || body.expiresAt > responseEvent.created_at + DEVICE_AUTHORITY_LEASE_SECONDS
      || body.expiresAt > now + DEVICE_AUTHORITY_LEASE_SECONDS
      || body.expiresAt > challenge.expiresAt || expiryTags.length !== 1 || Number(expiryTags[0][1]) !== body.expiresAt
      || (expectedPurpose && challenge.purpose !== expectedPurpose)
      || (expectedOperationId && challenge.operationId !== expectedOperationId)) return null;
    const target = registry.devices.find((row) => row.deviceId === body.targetDeviceId && row.status === 'active');
    if (!target || target.pubkey !== body.targetPubkey) return null;
    return { accountPubkey: body.accountPubkey, authorityEpoch: body.authorityEpoch, registryId: body.registryId,
      deviceId: body.targetDeviceId, devicePubkey: body.targetPubkey, purpose: body.purpose,
      operationId: body.operationId, freshUntil: body.expiresAt };
  } catch { return null; }
}
