// Experimental, decentralized freshness proofs for device authorization.
// Requests and responses are protocol payloads: transport them only inside an
// authenticated private DM envelope. Publishing either event in the clear
// would expose the account/device registry to relays.
import { finalizeEvent, getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { verifyDeviceRegistryEvent } from './deviceEnrollment.js';

export const DEVICE_FRESHNESS_CHALLENGE_KIND = 30083;
export const DEVICE_FRESHNESS_RESPONSE_KIND = 30084;
export const DEVICE_FRESHNESS_PROTOCOL = 'cipher-device-freshness';
export const DEVICE_FRESHNESS_CHALLENGE_TTL_SECONDS = 120;
export const DEVICE_FRESHNESS_RESPONSE_TTL_SECONDS = 30;

const HEX64 = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^[0-9a-f]{32}$/;
const NONCE = /^[A-Za-z0-9_-]{43}$/;

function json(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function base64url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function nonceFrom(randomBytes) {
  if (typeof randomBytes !== 'function') throw new Error('Secure randomness is unavailable for a freshness challenge.');
  const bytes = randomBytes(new Uint8Array(32));
  if (!(bytes instanceof Uint8Array) || bytes.length !== 32) throw new Error('Freshness challenge randomness is invalid.');
  return base64url(bytes);
}

function signed(event) {
  return !!event && getEventHash(event) === event.id && verifyEvent(event);
}

function parseChallenge(event, now) {
  if (!signed(event) || event.kind !== DEVICE_FRESHNESS_CHALLENGE_KIND
    || !Number.isSafeInteger(event.created_at) || event.created_at > now + 300) return null;
  const body = json(event.content);
  const expiration = event.tags.filter((tag) => tag[0] === 'expiration');
  const recipient = event.tags.filter((tag) => tag[0] === 'p');
  if (body?.protocol !== DEVICE_FRESHNESS_PROTOCOL || body.version !== 1
    || body.requesterPubkey !== event.pubkey || !HEX64.test(body.requesterPubkey || '')
    || !HEX64.test(body.authorityPubkey || '') || !DEVICE_ID.test(body.deviceId || '')
    || !NONCE.test(body.nonce || '') || body.issuedAt !== event.created_at
    || body.expiresAt !== event.created_at + DEVICE_FRESHNESS_CHALLENGE_TTL_SECONDS
    || expiration.length !== 1 || Number(expiration[0][1]) !== body.expiresAt
    || recipient.length !== 1 || recipient[0][1] !== body.authorityPubkey
    || now >= body.expiresAt || now - event.created_at > DEVICE_FRESHNESS_CHALLENGE_TTL_SECONDS) return null;
  return body;
}

export function createDeviceFreshnessChallenge({
  requesterSecret, authorityPubkey, deviceId,
  now = Math.floor(Date.now() / 1000),
  randomBytes = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto),
}) {
  const requesterPubkey = requesterSecret instanceof Uint8Array && requesterSecret.length === 32
    ? getPublicKey(requesterSecret) : '';
  if (!HEX64.test(requesterPubkey) || !HEX64.test(authorityPubkey || '')
    || !DEVICE_ID.test(deviceId || '') || !Number.isSafeInteger(now) || now <= 0) {
    throw new Error('The device freshness challenge is malformed.');
  }
  const body = {
    protocol: DEVICE_FRESHNESS_PROTOCOL,
    version: 1,
    requesterPubkey,
    authorityPubkey,
    deviceId,
    nonce: nonceFrom(randomBytes),
    issuedAt: now,
    expiresAt: now + DEVICE_FRESHNESS_CHALLENGE_TTL_SECONDS,
  };
  return finalizeEvent({
    kind: DEVICE_FRESHNESS_CHALLENGE_KIND,
    created_at: now,
    tags: [['p', authorityPubkey], ['expiration', String(body.expiresAt)]],
    content: JSON.stringify(body),
  }, requesterSecret);
}

// currentGeneration must come from the authority's locally sealed monotonic
// checkpoint, not from a relay response. This makes relay withholding fail
// closed and prevents an old signed registry from being certified by a
// correctly functioning authority device.
export function buildDeviceFreshnessResponse({
  challengeEvent, authoritySecret, registryEvent, currentGeneration,
  now = Math.floor(Date.now() / 1000),
}) {
  const challenge = parseChallenge(challengeEvent, now);
  const authorityPubkey = authoritySecret instanceof Uint8Array && authoritySecret.length === 32
    ? getPublicKey(authoritySecret) : '';
  const registry = verifyDeviceRegistryEvent(registryEvent, authorityPubkey, now, {
    minimumGeneration: currentGeneration,
  });
  if (!challenge || challenge.authorityPubkey !== authorityPubkey
    || !Number.isSafeInteger(currentGeneration) || currentGeneration < 1
    || !registry || registry.generation !== currentGeneration
    || !registry.devices.some((row) => row.deviceId === challenge.deviceId && row.status === 'active')) {
    throw new Error('The authority cannot prove this device is active in its current registry.');
  }
  const device = registry.devices.find((row) => row.deviceId === challenge.deviceId);
  const expiresAt = Math.min(challenge.expiresAt, now + DEVICE_FRESHNESS_RESPONSE_TTL_SECONDS);
  const content = {
    protocol: DEVICE_FRESHNESS_PROTOCOL,
    version: 1,
    challengeId: challengeEvent.id,
    challengeNonce: challenge.nonce,
    requesterPubkey: challenge.requesterPubkey,
    authorityPubkey,
    deviceId: challenge.deviceId,
    devicePubkey: device.pubkey,
    deviceStatus: device.status,
    registryGeneration: registry.generation,
    issuedAt: now,
    expiresAt,
  };
  return finalizeEvent({
    kind: DEVICE_FRESHNESS_RESPONSE_KIND,
    created_at: now,
    tags: [['e', challengeEvent.id], ['p', challenge.requesterPubkey], ['expiration', String(expiresAt)]],
    content: JSON.stringify(content),
  }, authoritySecret);
}

export function verifyDeviceFreshnessResponse(responseEvent, challengeEvent, {
  expectedAuthority,
  expectedRequester,
  expectedDeviceId,
  minimumRegistryGeneration = 1,
  now = Math.floor(Date.now() / 1000),
} = {}) {
  try {
    const challenge = parseChallenge(challengeEvent, now);
    if (!challenge || !signed(responseEvent) || responseEvent.kind !== DEVICE_FRESHNESS_RESPONSE_KIND
      || responseEvent.pubkey !== challenge.authorityPubkey
      || !Number.isSafeInteger(responseEvent.created_at) || responseEvent.created_at < challenge.issuedAt
      || responseEvent.created_at > now + 300 || now - responseEvent.created_at > DEVICE_FRESHNESS_RESPONSE_TTL_SECONDS) return null;
    const body = json(responseEvent.content);
    const eventTags = responseEvent.tags.filter((tag) => tag[0] === 'e');
    const recipientTags = responseEvent.tags.filter((tag) => tag[0] === 'p');
    const expirationTags = responseEvent.tags.filter((tag) => tag[0] === 'expiration');
    if (body?.protocol !== DEVICE_FRESHNESS_PROTOCOL || body.version !== 1
      || body.challengeId !== challengeEvent.id || body.challengeNonce !== challenge.nonce
      || body.requesterPubkey !== challenge.requesterPubkey
      || body.authorityPubkey !== challenge.authorityPubkey || body.deviceId !== challenge.deviceId
      || !HEX64.test(body.devicePubkey || '') || body.deviceStatus !== 'active'
      || !Number.isSafeInteger(body.registryGeneration) || body.registryGeneration < minimumRegistryGeneration
      || body.issuedAt !== responseEvent.created_at || !Number.isSafeInteger(body.expiresAt)
      || body.expiresAt <= now || body.expiresAt > challenge.expiresAt
      || body.expiresAt > responseEvent.created_at + DEVICE_FRESHNESS_RESPONSE_TTL_SECONDS
      || eventTags.length !== 1 || eventTags[0][1] !== challengeEvent.id
      || recipientTags.length !== 1 || recipientTags[0][1] !== challenge.requesterPubkey
      || expirationTags.length !== 1 || Number(expirationTags[0][1]) !== body.expiresAt
      || (expectedAuthority && body.authorityPubkey !== expectedAuthority)
      || (expectedRequester && body.requesterPubkey !== expectedRequester)
      || (expectedDeviceId && body.deviceId !== expectedDeviceId)) return null;
    return {
      authorityPubkey: body.authorityPubkey,
      requesterPubkey: body.requesterPubkey,
      deviceId: body.deviceId,
      devicePubkey: body.devicePubkey,
      status: body.deviceStatus,
      generation: body.registryGeneration,
      freshUntil: body.expiresAt,
    };
  } catch {
    return null;
  }
}
