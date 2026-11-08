// Signed, public prekey directory records for Nostr-delivered DM ratchets.
// The relay may replay/withhold these records, but cannot alter or forge one.
import { finalizeEvent, getEventHash, verifyEvent } from 'nostr-tools/pure';
import { getPublicKey } from 'nostr-tools/pure';
import { verifyDeviceRegistryEvent } from './deviceEnrollment.js';
import { verifyDeviceFreshnessResponse } from './deviceFreshness.js';

export const DM_RATCHET_BUNDLE_KIND = 30078;
export const DM_RATCHET_PROTOCOL = 'cipher-olm-ratchet';
export const DM_RATCHET_VERSION = 3;
export const DM_RATCHET_BUNDLE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DM_RATCHET_BUNDLE_D_TAG_PREFIX = 'cipher-dm-ratchet-v3:';

const DEVICE_ID_RE = /^[0-9a-f]{32}$/;
const ACCOUNT_PUBKEY_RE = /^[0-9a-f]{64}$/;
const PUBLIC_KEY_RE = /^[A-Za-z0-9+/]{43}$/;

function deviceTag(deviceId) {
  return `${DM_RATCHET_BUNDLE_D_TAG_PREFIX}${deviceId}`;
}

function parseJson(value) {
  try { return JSON.parse(value); } catch { return null; }
}

export function makeDmRatchetBundle({
  deviceId,
  generation,
  ed25519,
  curve25519,
  oneTimeKeys = [],
  fallbackKeys = [],
  expiresAt,
}) {
  return {
    protocol: DM_RATCHET_PROTOCOL,
    version: DM_RATCHET_VERSION,
    deviceId,
    generation,
    ed25519,
    curve25519,
    oneTimeKeys,
    fallbackKeys,
    expiresAt,
  };
}

export function buildDmRatchetBundleEvent(bundle, deviceSecret, registryEvent, expectedAccount, now = Math.floor(Date.now() / 1000)) {
  if (bundle?.version !== DM_RATCHET_VERSION) throw new Error('New ratchet bundles require the enrolled device format.');
  if (!validateBundleShape(bundle, now) || bundle.expiresAt > now + DM_RATCHET_BUNDLE_TTL_SECONDS) {
    throw new Error('Ratchet bundle is malformed or expired.');
  }
  const devicePubkey = getPublicKey(deviceSecret);
  const registry = verifyDeviceRegistryEvent(registryEvent, expectedAccount, now);
  if (!registry || !registry.devices.some((row) => row.deviceId === bundle.deviceId
    && row.pubkey === devicePubkey && row.status === 'active')) {
    throw new Error('The device is not authorized by a valid account-signed registry.');
  }
  return finalizeEvent({
    kind: DM_RATCHET_BUNDLE_KIND,
    created_at: now,
    tags: [
      ['d', deviceTag(bundle.deviceId)],
      ['expiration', String(bundle.expiresAt)],
    ],
    content: JSON.stringify(bundle),
  }, deviceSecret);
}

function validateBundleShape(bundle, now, { allowExpired = false } = {}) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return false;
  if (bundle.protocol !== DM_RATCHET_PROTOCOL || bundle.version !== DM_RATCHET_VERSION) return false;
  if (typeof bundle.deviceId !== 'string' || !DEVICE_ID_RE.test(bundle.deviceId)) return false;
  if (!Number.isSafeInteger(bundle.generation) || bundle.generation < 1) return false;
  if (!PUBLIC_KEY_RE.test(bundle.ed25519 || '') || !PUBLIC_KEY_RE.test(bundle.curve25519 || '')) return false;
  if (!Array.isArray(bundle.oneTimeKeys) || bundle.oneTimeKeys.length > 50) return false;
  if (!Array.isArray(bundle.fallbackKeys) || bundle.fallbackKeys.length > 2) return false;
  const keys = [...bundle.oneTimeKeys, ...bundle.fallbackKeys];
  if (keys.some((key) => typeof key !== 'string' || !PUBLIC_KEY_RE.test(key))) return false;
  if (new Set(keys).size !== keys.length) return false;
  if (!Number.isSafeInteger(bundle.expiresAt) || bundle.expiresAt <= 0) return false;
  if (!allowExpired && bundle.expiresAt <= now) return false;
  return true;
}

export function verifyDmRatchetBundleEvent(event, expectedAccount, now = Math.floor(Date.now() / 1000), {
  challengeEvent = null,
  freshnessResponse = null,
  expectedRequester = null,
  minimumRegistryGeneration = 1,
} = {}) {
  try {
    if (!ACCOUNT_PUBKEY_RE.test(expectedRequester || '') || !event || event.kind !== DM_RATCHET_BUNDLE_KIND) return null;
    if (getEventHash(event) !== event.id || !verifyEvent(event)) return null;
    if (!Number.isSafeInteger(event.created_at) || event.created_at > now + 300) return null;
    const dTags = event.tags.filter((tag) => tag[0] === 'd');
    const expirationTags = event.tags.filter((tag) => tag[0] === 'expiration');
    if (dTags.length !== 1 || expirationTags.length !== 1) return null;
    const bundle = parseJson(event.content);
    if (!validateBundleShape(bundle, now)) return null;
    if (bundle.expiresAt <= event.created_at
      || bundle.expiresAt > event.created_at + DM_RATCHET_BUNDLE_TTL_SECONDS
      || event.created_at + DM_RATCHET_BUNDLE_TTL_SECONDS <= now) return null;
    const fresh = verifyDeviceFreshnessResponse(freshnessResponse, challengeEvent, {
      expectedAuthority: expectedAccount,
      expectedRequester,
      expectedDeviceId: bundle.deviceId,
      minimumRegistryGeneration,
      now,
    });
    if (!fresh || fresh.devicePubkey !== event.pubkey || fresh.status !== 'active') return null;
    if (dTags[0][1] !== deviceTag(bundle.deviceId)) return null;
    if (Number(expirationTags[0][1]) !== bundle.expiresAt) return null;
    return bundle;
  } catch {
    return null;
  }
}

export function selectDmRatchetPrekey({
  event, expectedAccount, expectedRequester, challengeEvent, freshnessResponse,
  minimumRegistryGeneration = 1,
  now = Math.floor(Date.now() / 1000),
  randomBytes = globalThis.crypto?.getRandomValues?.bind(globalThis.crypto),
} = {}) {
  const bundle = verifyDmRatchetBundleEvent(event, expectedAccount, now, {
    challengeEvent, freshnessResponse, expectedRequester, minimumRegistryGeneration,
  });
  if (!bundle) throw new Error('A fresh authority response and a valid current device prekey are required.');
  const candidates = bundle.oneTimeKeys.length ? bundle.oneTimeKeys : bundle.fallbackKeys;
  if (!candidates.length) throw new Error('The peer device has no ratchet prekey available.');
  if (typeof randomBytes !== 'function') throw new Error('Secure randomness is unavailable for ratchet prekey selection.');
  const random = new Uint32Array(1);
  randomBytes(random);
  return candidates[random[0] % candidates.length];
}
