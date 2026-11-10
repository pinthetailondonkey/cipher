// Colocated focused test for src/lib/protocolTestDm/freshnessEnvelope.js
// (TEST-PATH-ONLY). Mirrors sendGate.test.js style: node:test +
// node:assert/strict, one case per stable reject reason plus boundary and
// canonical-refusal coverage per docs/DM-TEST-PROFILE-V1.md section 8.
import assert from 'node:assert/strict';
import test from 'node:test';
import { jcsEncode } from './protocolTestDmWire.js';
import {
  buildFreshnessEnvelope,
  verifyFreshnessEnvelope,
} from './freshnessEnvelope.js';

const T0 = 1760000000;
const OP_ID = 'aa11bb22cc33dd44ee55ff66778899aa';
const DIGEST = 'c'.repeat(64);
const SENDER = 'sender-device-pubkey';
const ROUTE = 'route-recipient-pubkey';

const good = (overrides = {}) => ({
  opId: OP_ID,
  opDigestHex: DIGEST,
  issuedAt: T0,
  notAfter: T0 + 3600,
  senderDeviceId: SENDER,
  recipientRoutePubkey: ROUTE,
  ...overrides,
});

const verify = (envelope, nowSeconds = T0 + 60) => verifyFreshnessEnvelope(envelope, {
  expectedOpDigestHex: DIGEST,
  expectedOpId: OP_ID,
  expectedSenderDeviceId: SENDER,
  expectedRecipientRoutePubkey: ROUTE,
  nowSeconds,
});

test('a valid fresh envelope verifies', () => {
  const envelope = buildFreshnessEnvelope(good());
  const verdict = verify(envelope);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.reason, null);
  // Canonical bytes: the JCS encoding of the envelope object is reproducible.
  assert.equal(verdict.canonicalBytes, jcsEncode(envelope));
});

test('boundary: notAfter == nowSeconds is STILL VALID', () => {
  const envelope = buildFreshnessEnvelope(good({ notAfter: T0 + 60 }));
  assert.equal(verify(envelope, T0 + 60).ok, true);
});

test('boundary: one second past notAfter is expired', () => {
  const envelope = buildFreshnessEnvelope(good({ notAfter: T0 + 60 }));
  const verdict = verify(envelope, T0 + 61);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'envelope-expired');
});

for (const bad of [null, undefined, 'envelope', 42, []]) {
  test(`reject envelope-shape: envelope is ${String(bad)}`, () => {
    const verdict = verify(bad);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.reason, 'envelope-shape');
  });
}

test('reject envelope-shape: non-safe-integer timestamp', () => {
  const verdict = verify({ ...buildFreshnessEnvelope(good()), issuedAt: 1.5 });
  assert.equal(verdict.reason, 'envelope-shape');
});

test('reject envelope-shape: non-hex64 digest', () => {
  const verdict = verify({ ...buildFreshnessEnvelope(good()), opDigestHex: 'NOTHEX' });
  assert.equal(verdict.reason, 'envelope-shape');
});

test('reject envelope-shape: non-canonical key insertion order refused', () => {
  const nonCanonical = { notAfter: T0 + 3600, opId: OP_ID, opDigestHex: DIGEST, issuedAt: T0, v: 1,
    boundTarget: { recipientRoutePubkey: ROUTE, senderDeviceId: SENDER } };
  const verdict = verify(nonCanonical);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'envelope-shape');
});

test('reject digest-mismatch: differing operation digest', () => {
  const envelope = buildFreshnessEnvelope(good());
  const verdict = verifyFreshnessEnvelope(envelope, {
    expectedOpDigestHex: 'd'.repeat(64),
    expectedOpId: OP_ID,
    expectedSenderDeviceId: SENDER,
    expectedRecipientRoutePubkey: ROUTE,
    nowSeconds: T0 + 60,
  });
  assert.equal(verdict.reason, 'digest-mismatch');
});

test('reject digest-mismatch: differing opId binds to digest family', () => {
  const envelope = buildFreshnessEnvelope(good());
  const verdict = verifyFreshnessEnvelope(envelope, {
    expectedOpDigestHex: DIGEST,
    expectedOpId: 'other-op',
    expectedSenderDeviceId: SENDER,
    expectedRecipientRoutePubkey: ROUTE,
    nowSeconds: T0 + 60,
  });
  assert.equal(verdict.reason, 'digest-mismatch');
});

test('reject target-mismatch: envelope bound to another sender device', () => {
  const envelope = buildFreshnessEnvelope(good({ senderDeviceId: 'other-device' }));
  const verdict = verify(envelope);
  assert.equal(verdict.reason, 'target-mismatch');
});

test('reject target-mismatch: envelope bound to another route key', () => {
  const envelope = buildFreshnessEnvelope(good({ recipientRoutePubkey: 'other-route' }));
  const verdict = verify(envelope);
  assert.equal(verdict.reason, 'target-mismatch');
});
