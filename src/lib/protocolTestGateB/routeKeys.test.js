// Colocated focused KAT tests for src/lib/protocolTestGateB/routeKeys.js
// (TEST-PATH-ONLY). All expected values are fixed-seed deterministic test
// vectors frozen per docs/SCOPED-ROUTE-DISCOVERY-SPEC-V1.md sections 1.1-1.2.
// They pin the exact HKDF/SHA-256 domain-separated derivations so an
// independent second implementation can be compared byte-for-byte.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ROUTE_KEYS_CONSTANTS,
  deriveRouteSecret,
  discoveryBlindTag,
  rotateRouteSecret,
  verifyBlindTag,
} from './routeKeys.js';

// ── Fixed-seed KAT vectors ────────────────────────────────────────────────
// contactSecret = hex of seed string 'cipher-kat-contact-seed-v1' (30 bytes);
// deviceIdBytes = hex of seed string 'cipher-kat-device-0001' (24 bytes);
// direction bytes 0x01 / 0x02 per spec. Vector expected values below were
// generated once from this module and MUST be byte-stable thereafter.
const KAT_CONTACT_SECRET_HEX = Buffer
  .from('cipher-kat-contact-seed-v1', 'utf8').toString('hex');
const KAT_DEVICE_ID_HEX = Buffer
  .from('cipher-kat-device-0001', 'utf8').toString('hex');
const KAT_EXPECTED = {
  dirToRecipient: {
    routeSecretHex: '171ca00deb5d5c7166d24d7524ba55d146da35262d2224463c4feb46da3b1f34',
    blindTagHex: '9072807eb4b09fd5279eaea01bd297bc530f5dfe5643e978b19f9a4ffc37f657',
  },
  dirToSender: {
    routeSecretHex: 'bf2a69817c5f2a405ad53b9a014907e63f18088a3d2b3fa99d9b114f102af0bd',
    blindTagHex: '16f0fbde7e1c807c098e6542ad1ec3826e90d7ce62d17f2ea37535cc69519c43',
  },
  rotation: {
    0: 'da0fa304b0e7d5fb8e3604db28fb774163c41883cdb592c26aa8843d1bda337a',
    1: '60bcdc5b83c6d8feebdb98b286208792d53cf6b52f5c14e4592b01a56e31cdfc',
    4294967296: 'cfd4af75e5c5664bf5c5b7cfe8529bd0de04a33672fda289d7f8ea259754744f',
  },
  discovery: {
    handle: 'Cipher.Example.User',
    saltHex: 'a1'.repeat(16),
    blindTagHex: '2fcfdb2f054d426e5f369da17fba9024261b0b0f6bdb4266d784c5e3a1bc58c0',
  },
};

// The vectors above were generated once from this module on first authoring
// and are committed as FIXED expected values; they must be byte-stable across
// implementations and runs.

test('KAT: deriveRouteSecret recipient direction matches frozen vector', () => {
  const out = deriveRouteSecret({
    contactSecret: Buffer.from(KAT_CONTACT_SECRET_HEX, 'hex'),
    deviceIdBytes: Buffer.from(KAT_DEVICE_ID_HEX, 'hex'),
    directionByte: ROUTE_KEYS_CONSTANTS.DIRECTION_TO_RECIPIENT,
  });
  assert.equal(out.routeSecretHex, KAT_EXPECTED.dirToRecipient.routeSecretHex);
  assert.equal(out.blindTagHex, KAT_EXPECTED.dirToRecipient.blindTagHex);
  assert.equal(out.routeSecretHex.length, 64, 'route secret is 256 bits');
  assert.equal(out.blindTagHex.length, 64, 'blind tag is 256 bits');
});

test('KAT: deriveRouteSecret sender direction differs from recipient', () => {
  const out = deriveRouteSecret({
    contactSecret: Buffer.from(KAT_CONTACT_SECRET_HEX, 'hex'),
    deviceIdBytes: Buffer.from(KAT_DEVICE_ID_HEX, 'hex'),
    directionByte: ROUTE_KEYS_CONSTANTS.DIRECTION_TO_SENDER,
  });
  assert.notEqual(out.routeSecretHex, KAT_EXPECTED.dirToRecipient.routeSecretHex);
  assert.notEqual(out.blindTagHex, KAT_EXPECTED.dirToRecipient.blindTagHex);
});

test('KAT: string contactSecret matches byte-array vector', () => {
  const out = deriveRouteSecret({
    contactSecret: Buffer.from(KAT_CONTACT_SECRET_HEX, 'hex').toString('utf8'),
    deviceIdBytes: Buffer.from(KAT_DEVICE_ID_HEX, 'hex'),
    directionByte: ROUTE_KEYS_CONSTANTS.DIRECTION_TO_RECIPIENT,
  });
  assert.equal(out.routeSecretHex, KAT_EXPECTED.dirToRecipient.routeSecretHex);
});

test('KAT: handleBlindTagKey alias derives identically', () => {
  const out = deriveRouteSecret({
    handleBlindTagKey: Buffer.from(KAT_CONTACT_SECRET_HEX, 'hex'),
    deviceIdBytes: Buffer.from(KAT_DEVICE_ID_HEX, 'hex'),
    directionByte: ROUTE_KEYS_CONSTANTS.DIRECTION_TO_RECIPIENT,
  });
  assert.equal(out.routeSecretHex, KAT_EXPECTED.dirToRecipient.routeSecretHex);
});

test('KAT: different deviceId salt produces uncorrelated route', () => {
  const other = Buffer.from('cipher-kat-device-0002', 'utf8');
  const out = deriveRouteSecret({
    contactSecret: Buffer.from(KAT_CONTACT_SECRET_HEX, 'hex'),
    deviceIdBytes: other,
    directionByte: ROUTE_KEYS_CONSTANTS.DIRECTION_TO_RECIPIENT,
  });
  assert.notEqual(out.routeSecretHex, KAT_EXPECTED.dirToRecipient.routeSecretHex);
});

test('KAT: rotation chain frozen vectors at counters 0, 1, 2^32', () => {
  assert.equal(
    rotateRouteSecret(KAT_EXPECTED.dirToRecipient.routeSecretHex, 0),
    KAT_EXPECTED.rotation[0],
  );
  assert.equal(
    rotateRouteSecret(KAT_EXPECTED.dirToRecipient.routeSecretHex, 1),
    KAT_EXPECTED.rotation[1],
  );
  assert.equal(
    rotateRouteSecret(KAT_EXPECTED.dirToRecipient.routeSecretHex, 4294967296),
    KAT_EXPECTED.rotation[4294967296],
  );
});

test('KAT: verifyBlindTag accepts exact handle+salt, rejects wrong', () => {
  const { handle, saltHex, blindTagHex } = KAT_EXPECTED.discovery;
  assert.equal(verifyBlindTag(blindTagHex, handle, saltHex), true);
  assert.equal(verifyBlindTag(blindTagHex, handle.toLowerCase(), saltHex), true,
    'handle comparison is case-normalized');
  assert.equal(verifyBlindTag(blindTagHex, handle, 'bb'.repeat(16)), false);
  assert.equal(verifyBlindTag(blindTagHex, `${handle}x`, saltHex), false);
  assert.equal(
    discoveryBlindTag(handle, saltHex),
    discoveryBlindTag(handle.toLowerCase(), saltHex),
  );
});

test('rejects undersized contact secret and bad direction bytes', () => {
  assert.throws(() => deriveRouteSecret({
    contactSecret: Buffer.alloc(8),
    deviceIdBytes: Buffer.alloc(8),
    directionByte: 0x01,
  }), /128 bits/);
  assert.throws(() => deriveRouteSecret({
    contactSecret: Buffer.alloc(16),
    deviceIdBytes: Buffer.alloc(8),
    directionByte: 256,
  }), /direction/);
  assert.throws(() => rotateRouteSecret('ab'.repeat(8), 0), /128-bit/);
  assert.throws(() => verifyBlindTag('x'.repeat(64), 'h', 'a'.repeat(31)), /salt/);
  assert.throws(() => verifyBlindTag('x'.repeat(64), 'h', ''), /salt/);
});
