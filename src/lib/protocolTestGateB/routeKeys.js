// Scoped route-key derivation primitives for the Gate B TEST path
// (TEST-ONLY, src/lib/protocolTestGateB/routeKeys.js).
//
// Frozen spec: docs/SCOPED-ROUTE-DISCOVERY-SPEC-V1.md sections 1.1-1.2.
// Pure functions over node:crypto only; no storage, no relay, no app path.
//   deriveRouteSecret({ contactSecret, deviceIdBytes, directionByte }) ->
//     { routeSecretHex (32-byte / 256-bit), blindTagHex } via
//     HKDF-SHA256(contactSecret, salt=deviceIdBytes,
//                 info="cipher-route-v1|dir=" + directionByte)
//     blindTag = SHA-256("cipher-route-blind-v1" || routeSecret)
//   rotateRouteSecret(prevSecretHex, rotationCounter) ->
//     next = SHA-256("cipher-route-rotate-v1" || prevSecret || LE64(counter))
//   verifyBlindTag(blindTagHex, handle, saltHex) -> bool, with
//     discovery blind tag = SHA-256("cipher-discovery-blind-v1" ||
//                                   handleLowercaseUTF8 || saltHex)
// NOTE: deriveRouteSecret takes `handleBlindTagKey` as an accepted alias of
// contactSecret so a discovery-blob lookup can derive the same route secret
// from the out-of-band key material without publishing anything.
import { createHash, createHmac } from 'node:crypto';

export const ROUTE_KEYS_CONSTANTS = Object.freeze({
  // Gate B floor is >=128 bits; frozen derivation emits 256 bits (32 bytes).
  ROUTE_SECRET_BYTES: 32,
  DIRECTION_TO_RECIPIENT: 0x01,
  DIRECTION_TO_SENDER: 0x02,
  ROUTE_INFO_PREFIX: 'cipher-route-v1|dir=',
  BLIND_TAG_DOMAIN: 'cipher-route-blind-v1',
  ROTATE_DOMAIN: 'cipher-route-rotate-v1',
  DISCOVERY_BLIND_DOMAIN: 'cipher-discovery-blind-v1',
});

function hkdfSha256(ikm, salt, info, length) {
  // Minimal RFC 5869 HKDF over HMAC-SHA256 (pure node:crypto, no extract/
  // expand assumptions beyond the spec).
  const salted = salt.length > 0 ? salt : Buffer.alloc(32, 0);
  const prk = createHmac('sha256', salted).update(ikm).digest();
  const chunks = [];
  let prev = Buffer.alloc(0);
  for (let i = 1; chunks.join('').length < length; i += 1) {
    prev = createHmac('sha256', prk)
      .update(Buffer.concat([prev, Buffer.from(info), Buffer.from([i])]))
      .digest();
    chunks.push(prev);
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function normalizeContactSecret(contactSecret) {
  if (typeof contactSecret === 'string') {
    const bytes = Buffer.from(contactSecret, 'utf8');
    if (bytes.length < 16) throw new Error('contactSecret needs >=128 bits of material.');
    return bytes;
  }
  if (contactSecret instanceof Uint8Array || Buffer.isBuffer(contactSecret)) {
    if (contactSecret.length < 16) throw new Error('contactSecret needs >=128 bits of material.');
    return Buffer.from(contactSecret);
  }
  throw new Error('contactSecret must be a string or byte array.');
}

export function deriveRouteSecret({ contactSecret, handleBlindTagKey, deviceIdBytes, directionByte }) {
  const ikmRaw = contactSecret ?? handleBlindTagKey;
  if (ikmRaw === undefined || ikmRaw === null) throw new Error('deriveRouteSecret needs contactSecret.');
  if (!(deviceIdBytes instanceof Uint8Array) || deviceIdBytes.length < 8) {
    throw new Error('deriveRouteSecret needs deviceIdBytes (>=8 bytes).');
  }
  if (!Number.isInteger(directionByte) || directionByte < 0 || directionByte > 255) {
    throw new Error('deriveRouteSecret needs a direction byte 0-255.');
  }
  const ikm = normalizeContactSecret(ikmRaw);
  const routeSecret = hkdfSha256(
    ikm,
    Buffer.from(deviceIdBytes),
    ROUTE_KEYS_CONSTANTS.ROUTE_INFO_PREFIX + directionByte,
    ROUTE_KEYS_CONSTANTS.ROUTE_SECRET_BYTES,
  );
  const blindTag = createHash('sha256')
    .update(ROUTE_KEYS_CONSTANTS.BLIND_TAG_DOMAIN)
    .update(routeSecret)
    .digest();
  return { routeSecretHex: routeSecret.toString('hex'), blindTagHex: blindTag.toString('hex') };
}

export function rotateRouteSecret(prevSecretHex, rotationCounter) {
  if (typeof prevSecretHex !== 'string' || prevSecretHex.length < 32) {
    throw new Error('rotateRouteSecret needs a >=128-bit prev secret hex.');
  }
  if (!Number.isInteger(rotationCounter) || rotationCounter < 0 || rotationCounter > Number.MAX_SAFE_INTEGER) {
    throw new Error('rotateRouteSecret needs a non-negative integer counter.');
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64LE(BigInt(rotationCounter));
  const next = createHash('sha256')
    .update(ROUTE_KEYS_CONSTANTS.ROTATE_DOMAIN)
    .update(Buffer.from(prevSecretHex, 'hex'))
    .update(counter)
    .digest();
  return next.toString('hex');
}

export function discoveryBlindTag(handle, saltHex) {
  if (typeof handle !== 'string' || handle.length === 0) throw new Error('discoveryBlindTag needs a handle.');
  if (typeof saltHex !== 'string' || saltHex.length < 32) throw new Error('discoveryBlindTag needs a 128-bit salt hex.');
  return createHash('sha256')
    .update(ROUTE_KEYS_CONSTANTS.DISCOVERY_BLIND_DOMAIN)
    .update(handle.toLowerCase(), 'utf8')
    .update(saltHex, 'utf8')
    .digest('hex');
}

export function verifyBlindTag(blindTagHex, handle, saltHex) {
  return discoveryBlindTag(handle, saltHex) === blindTagHex;
}
