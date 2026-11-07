// Experimental, account-authorized device enrollment records. These are
// protocol helpers only: no application or relay path consumes them yet.
// The account key authorizes a device; the new device proves possession of a
// separate Nostr signing key before it can be added to that signed registry.
import { finalizeEvent, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { generateSecretKey } from 'nostr-tools/pure';

export const DEVICE_ENROLLMENT_CHALLENGE_KIND = 30080;
export const DEVICE_ENROLLMENT_PROOF_KIND = 30081;
export const DEVICE_REGISTRY_KIND = 30082;
export const DEVICE_REGISTRY_PROTOCOL = 'cipher-device-registry';
export const DEVICE_REGISTRY_TAG = 'cipher-device-registry-v1';
export const DEVICE_CHALLENGE_TTL_SECONDS = 300;
const DEVICE_ID_RE = /^[0-9a-f]{32}$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[A-Za-z0-9_-]{43}$/;
const REGISTRY_MAX_AGE = 90 * 24 * 60 * 60;

function json(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function secureNonce(randomBytes) {
  if (typeof randomBytes !== 'function') throw new Error('Secure randomness is unavailable for device enrollment.');
  const bytes = randomBytes(new Uint8Array(32));
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('Device enrollment randomness returned invalid bytes.');
  return BufferlessBase64Url(bytes);
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createDeviceCredential(randomBytes = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto)) {
  const deviceIdBytes = randomBytes?.(new Uint8Array(16));
  if (!(deviceIdBytes instanceof Uint8Array) || deviceIdBytes.length !== 16) {
    throw new Error('Secure randomness is unavailable for a new device credential.');
  }
  const deviceSecret = generateSecretKey();
  return {
    deviceId: hex(deviceIdBytes),
    devicePubkey: getPublicKey(deviceSecret),
    deviceSecret,
  };
}

function BufferlessBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function signed(event) {
  return !!event && getEventHash(event) === event.id && verifyEvent(event);
}

function validChallenge(event, now) {
  if (!signed(event) || event.kind !== DEVICE_ENROLLMENT_CHALLENGE_KIND
    || !Number.isSafeInteger(event.created_at) || event.created_at > now + 300) return null;
  const body = json(event.content);
  const expiration = event.tags.filter((tag) => tag[0] === 'expiration');
  if (body?.protocol !== DEVICE_REGISTRY_PROTOCOL || body?.version !== 1
    || body.accountPubkey !== event.pubkey || !PUBKEY_RE.test(body.accountPubkey || '')
    || !DEVICE_ID_RE.test(body.deviceId || '') || !PUBKEY_RE.test(body.devicePubkey || '')
    || !NONCE_RE.test(body.nonce || '') || body.expiresAt !== event.created_at + DEVICE_CHALLENGE_TTL_SECONDS
    || expiration.length !== 1 || Number(expiration[0][1]) !== body.expiresAt
    || now >= body.expiresAt) return null;
  return body;
}

function validDeviceRows(devices) {
  if (!Array.isArray(devices) || devices.length < 1 || devices.length > 64) return false;
  const ids = new Set();
  const keys = new Set();
  let active = 0;
  for (const row of devices) {
    if (!row || !DEVICE_ID_RE.test(row.deviceId || '') || !PUBKEY_RE.test(row.pubkey || '')
      || !['active', 'revoked'].includes(row.status)
      || !Number.isSafeInteger(row.enrolledAt) || row.enrolledAt <= 0
      || (row.status === 'revoked' && (!Number.isSafeInteger(row.revokedAt) || row.revokedAt < row.enrolledAt))
      || (row.status === 'active' && row.revokedAt !== undefined)) return false;
    if (ids.has(row.deviceId) || keys.has(row.pubkey)) return false;
    ids.add(row.deviceId);
    keys.add(row.pubkey);
    if (row.status === 'active') active += 1;
  }
  return active > 0;
}

function validateRegistryEvent(event, expectedAccount, now) {
  if (!signed(event) || event.kind !== DEVICE_REGISTRY_KIND || event.pubkey !== expectedAccount
    || !PUBKEY_RE.test(expectedAccount || '') || !Number.isSafeInteger(event.created_at)
    || event.created_at > now + 300 || now - event.created_at > REGISTRY_MAX_AGE) return null;
  const tags = event.tags.filter((tag) => tag[0] === 'd');
  if (tags.length !== 1 || tags[0][1] !== DEVICE_REGISTRY_TAG) return null;
  const body = json(event.content);
  if (body?.protocol !== DEVICE_REGISTRY_PROTOCOL || body?.version !== 1
    || body.accountPubkey !== expectedAccount || !Number.isSafeInteger(body.generation)
    || body.generation < 1 || !validDeviceRows(body.devices)) return null;
  return body;
}

export function createDeviceEnrollmentChallenge({
  accountSecret, deviceId, devicePubkey, now = Math.floor(Date.now() / 1000),
  randomBytes = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto),
}) {
  if (!DEVICE_ID_RE.test(deviceId || '') || !PUBKEY_RE.test(devicePubkey || '')
    || !Number.isSafeInteger(now) || now <= 0) throw new Error('Device enrollment challenge is malformed.');
  const accountPubkey = getPublicKey(accountSecret);
  const content = {
    protocol: DEVICE_REGISTRY_PROTOCOL,
    version: 1,
    accountPubkey,
    deviceId,
    devicePubkey,
    nonce: secureNonce(randomBytes),
    expiresAt: now + DEVICE_CHALLENGE_TTL_SECONDS,
  };
  return finalizeEvent({
    kind: DEVICE_ENROLLMENT_CHALLENGE_KIND,
    created_at: now,
    tags: [['expiration', String(content.expiresAt)]],
    content: JSON.stringify(content),
  }, accountSecret);
}

export function buildDeviceEnrollmentProof(challengeEvent, deviceSecret, now = Math.floor(Date.now() / 1000)) {
  const challenge = validChallenge(challengeEvent, now);
  if (!challenge) throw new Error('The account enrollment challenge is invalid or expired.');
  if (getPublicKey(deviceSecret) !== challenge.devicePubkey) throw new Error('This device key does not match the enrollment challenge.');
  return finalizeEvent({
    kind: DEVICE_ENROLLMENT_PROOF_KIND,
    created_at: now,
    tags: [['e', challengeEvent.id]],
    content: JSON.stringify({
      protocol: DEVICE_REGISTRY_PROTOCOL,
      version: 1,
      accountPubkey: challenge.accountPubkey,
      deviceId: challenge.deviceId,
      challengeId: challengeEvent.id,
      nonce: challenge.nonce,
    }),
  }, deviceSecret);
}

export function verifyDeviceEnrollmentProof(challengeEvent, proofEvent, now = Math.floor(Date.now() / 1000)) {
  const challenge = validChallenge(challengeEvent, now);
  if (!challenge || !signed(proofEvent) || proofEvent.kind !== DEVICE_ENROLLMENT_PROOF_KIND
    || proofEvent.pubkey !== challenge.devicePubkey || proofEvent.created_at < challengeEvent.created_at
    || proofEvent.created_at > challenge.expiresAt || proofEvent.created_at > now + 300) return null;
  const tags = proofEvent.tags.filter((tag) => tag[0] === 'e');
  const body = json(proofEvent.content);
  if (tags.length !== 1 || tags[0][1] !== challengeEvent.id
    || body?.protocol !== DEVICE_REGISTRY_PROTOCOL || body?.version !== 1
    || body.accountPubkey !== challenge.accountPubkey || body.deviceId !== challenge.deviceId
    || body.challengeId !== challengeEvent.id || body.nonce !== challenge.nonce) return null;
  return { accountPubkey: challenge.accountPubkey, deviceId: challenge.deviceId, pubkey: challenge.devicePubkey };
}

export function buildDeviceRegistryEvent({ accountSecret, generation, devices }, now = Math.floor(Date.now() / 1000)) {
  const accountPubkey = getPublicKey(accountSecret);
  if (!Number.isSafeInteger(now) || now <= 0 || !Number.isSafeInteger(generation) || generation < 1 || !validDeviceRows(devices)) {
    throw new Error('The device registry is malformed.');
  }
  return finalizeEvent({
    kind: DEVICE_REGISTRY_KIND,
    created_at: now,
    tags: [['d', DEVICE_REGISTRY_TAG]],
    content: JSON.stringify({
      protocol: DEVICE_REGISTRY_PROTOCOL,
      version: 1,
      accountPubkey,
      generation,
      devices,
    }),
  }, accountSecret);
}

export function verifyDeviceRegistryEvent(event, expectedAccount, now = Math.floor(Date.now() / 1000), { minimumGeneration = 1 } = {}) {
  try {
    const body = validateRegistryEvent(event, expectedAccount, now);
    return body && body.generation >= minimumGeneration ? body : null;
  } catch { return null; }
}

export function enrollDevice({ registryEvent, challengeEvent, proofEvent, accountSecret, now = Math.floor(Date.now() / 1000) }) {
  const accountPubkey = getPublicKey(accountSecret);
  const registry = validateRegistryEvent(registryEvent, accountPubkey, now);
  const proof = verifyDeviceEnrollmentProof(challengeEvent, proofEvent, now);
  if (!registry || !proof || proof.accountPubkey !== accountPubkey) throw new Error('Device enrollment authorization could not be verified.');
  if (registry.devices.some((device) => device.deviceId === proof.deviceId || device.pubkey === proof.pubkey)) {
    throw new Error('This device is already enrolled or its credential was previously revoked.');
  }
  if (registry.devices.length >= 64) throw new Error('The device registry is full.');
  return buildDeviceRegistryEvent({
    accountSecret,
    generation: registry.generation + 1,
    devices: [...registry.devices, { ...proof, status: 'active', enrolledAt: now }],
  }, now);
}

export function revokeDevice({ registryEvent, deviceId, accountSecret, now = Math.floor(Date.now() / 1000) }) {
  const accountPubkey = getPublicKey(accountSecret);
  const registry = validateRegistryEvent(registryEvent, accountPubkey, now);
  if (!registry) throw new Error('The signed device registry is invalid or too old.');
  const target = registry.devices.find((device) => device.deviceId === deviceId && device.status === 'active');
  if (!target) throw new Error('The device is not active in this registry.');
  const devices = registry.devices.map((device) => device.deviceId === deviceId
    ? { ...device, status: 'revoked', revokedAt: now }
    : device);
  if (!devices.some((device) => device.status === 'active')) throw new Error('The last active device cannot be revoked.');
  return buildDeviceRegistryEvent({ accountSecret, generation: registry.generation + 1, devices }, now);
}
