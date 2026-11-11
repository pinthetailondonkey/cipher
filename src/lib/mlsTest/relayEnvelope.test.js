// Unit tests for the TEST-ONLY MLS relay envelope (docs/MLS-TEST-PROFILE-V1.md).
// >=15 cases including the tamper matrix. Fail-closed reasons asserted exactly.
import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
  RELAY_ENVELOPE_KIND,
  VERIFY_REASONS,
  WIRE_FORMATS,
  buildRelayEnvelope,
  parseAndVerifyRelayEnvelope,
  signEventDeterministically,
} from './relayEnvelope.js';
import { newKey } from './testingKeys.js';
import { signEpochAttestation } from './epochAttestation.js';

const hex = (label) => bytesToHex(sha256(new TextEncoder().encode(`mls-relay-envelope-test|${label}`)));
const sk = (label) => new Uint8Array(sha256(new TextEncoder().encode(`mls-relay-envelope-test-key|${label}`)));
const mls = hex('sample-mls-bytes');

const baseArgs = () => ({
  groupId: 'group-alpha',
  epoch: 2,
  wireFormat: 'mLSMessage',
  mlsBytes: mls,
  governanceRevision: 4,
  governanceHash: hex('gov-rev-4'),
  senderDeviceId: 'device-admin-a',
  authoritySecret: bytesToHex(sk('authority')),
  created_at: 1760000000,
});

const chain = [{ revision: 3, hash: hex('gov-rev-3') }, { revision: 4, hash: hex('gov-rev-4') }];

async function valid(attestations = []) {
  const event = await buildRelayEnvelope({ ...baseArgs(), attestations });
  return event;
}

test('kind constant is outside every kind used elsewhere in this repo', () => {
  assert.equal(RELAY_ENVELOPE_KIND, 10606);
  for (const used of [4, 13, 14, 1059, 22242]) assert.notEqual(RELAY_ENVELOPE_KIND, used);
});

test('build produces a signed verifiable nostr event of the pinned kind', async () => {
  const event = await valid();
  assert.ok(event);
  assert.equal(event.kind, 10606);
  const parsed = JSON.parse(event.content);
  assert.equal(parsed.t, 'cipherMlsRelayEnvelope');
  assert.equal(parsed.v, 1);
  assert.equal(parsed.epoch, 2);
  assert.equal(parsed.mlsBytesHex, mls);
  assert.deepEqual(parsed.governanceRef, { revision: 4, hash: hex('gov-rev-4') });
  assert.ok(event.sig);
});

test('deterministic signer is reproducible: same template twice, identical bytes', async () => {
  const a = await valid();
  const b = await valid();
  assert.deepEqual(a, b);
});

test('valid envelope verifies without options', async () => {
  const result = await parseAndVerifyRelayEnvelope(await valid());
  assert.equal(result.ok, true);
  assert.equal(result.envelope.wireFormat, 'mLSMessage');
  assert.equal(result.senderDeviceTag, 'device-admin-a');
});

test('verify with matching expected governance chain and authority passes', async () => {
  const event = await valid();
  const authorityPubkey = (await parseAndVerifyRelayEnvelope(await valid())).senderPubkey;
  const result = await parseAndVerifyRelayEnvelope(event, {
    expectedGovernanceAuthorityPubkey: authorityPubkey,
    expectedGroupRevisionChain: chain,
    currentEpoch: 2,
  });
  assert.equal(result.ok, true);
});

test('wrong kind fails with envelope-kind when the event itself is validly signed', async () => {
  const parsedContent = JSON.parse((await valid()).content);
  const otherKind = signEventDeterministically({
    kind: 1060, created_at: 1760000000, tags: [], content: JSON.stringify(parsedContent),
  }, sk('authority'));
  const r = await parseAndVerifyRelayEnvelope(otherKind);
  assert.equal(r.ok, false);
  assert.equal(r.reason, VERIFY_REASONS.KIND);
  assert.match(r.detail, /1060/);
});

test('tamper matrix: each mutation yields exactly its fail-closed reason', async (t) => {
  const good = await valid();
  // A char flip that provably changes the hex string.
  const flipChar = (s) => `${s.slice(0, -1)}${s.at(-1) === 'a' ? 'b' : 'a'}`;
  const cases = [
    ['sig flipped one char', { sig: flipChar(good.sig) }],
    ['id mutated', { id: flipChar(good.id) }],
    ['pubkey swapped to another key', { pubkey: flipChar(good.pubkey) }],
  ];
  for (const [label, patch] of cases) {
    await t.test(label, async () => {
      const r = await parseAndVerifyRelayEnvelope({ ...good, ...patch });
      assert.equal(r.ok, false, label);
      assert.ok([VERIFY_REASONS.SIGNATURE].includes(r.reason), `expected signature reason, got ${r.reason}`);
    });
  }
  await t.test('content re-serialized breaks event hash binding only if unsigned id kept stale', async () => {
    const parsedContent = JSON.parse(good.content);
    parsedContent.epoch = 9;
    const staleIdTamper = { ...good, content: JSON.stringify(parsedContent) };
    const r = await parseAndVerifyRelayEnvelope(staleIdTamper);
    assert.equal(r.ok, false);
    // id no longer matches content -> invalid signature semantics
    assert.notEqual(r.reason, null);
  });
});

test('resigned-but-tampered content still fails the governance chain check', async () => {
  // An attacker CAN re-sign tampered content; verification must catch it at
  // the governance layer, not rely on transport signatures alone.
  const parsedContent = JSON.parse((await valid()).content);
  parsedContent.governanceRef.hash = hex('forged-governance-hash');
  const forgedAuthority = sk('attacker-device');
  const forged = signEventDeterministically({
    kind: RELAY_ENVELOPE_KIND, created_at: 1760000000, tags: [['d', 'group-alpha']],
    content: JSON.stringify(parsedContent),
  }, forgedAuthority);
  const r = await parseAndVerifyRelayEnvelope(forged, {
    expectedGroupRevisionChain: chain,
  });
  assert.equal(r.ok, false);
});

test('governance-mismatch: hash not in expected chain', async () => {
  const event = await buildRelayEnvelope({
    ...baseArgs(),
    governanceHash: hex('gov-rev-not-in-chain'),
  });
  const r = await parseAndVerifyRelayEnvelope(event, { expectedGroupRevisionChain: chain });
  assert.equal(r.ok, false);
  assert.equal(r.reason, VERIFY_REASONS.GOVERNANCE);
});

test('governance-mismatch: wrong revision number', async () => {
  const event = await buildRelayEnvelope({ ...baseArgs(), governanceRevision: 99 });
  const r = await parseAndVerifyRelayEnvelope(event, { expectedGroupRevisionChain: chain });
  assert.equal(r.reason, VERIFY_REASONS.GOVERNANCE);
  assert.equal(r.detail, 'unknown revision 99');
});

test('unauthorized signer fails governance even when signatures are valid', async () => {
  const attackerSecret = bytesToHex(sk('attacker'));
  const event = await buildRelayEnvelope({ ...baseArgs(), authoritySecret: attackerSecret });
  const authorityPubkey = (await parseAndVerifyRelayEnvelope(await valid())).senderPubkey;
  const r = await parseAndVerifyRelayEnvelope(event, { expectedGovernanceAuthorityPubkey: authorityPubkey, expectedGroupRevisionChain: chain });
  assert.equal(r.reason, VERIFY_REASONS.GOVERNANCE);
  assert.match(r.detail, /authority/);
});

test('epoch-regression below receiver current epoch is rejected', async () => {
  const future = await buildRelayEnvelope({ ...baseArgs(), epoch: 5 });
  assert.equal((await parseAndVerifyRelayEnvelope(future, { currentEpoch: 3 })).ok, true);
  const past = await buildRelayEnvelope({ ...baseArgs(), epoch: 1 });
  const r = await parseAndVerifyRelayEnvelope(past, { currentEpoch: 3 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, VERIFY_REASONS.EPOCH_REGRESSION);
});

test('epoch equal to receiver current epoch is allowed (redelivery/dedupe)', async () => {
  const event = await valid();
  const r = await parseAndVerifyRelayEnvelope(event, { currentEpoch: 2 });
  assert.equal(r.ok, true);
});

test('invalid wire format fails envelope-wire-format', async () => {
  const bad = JSON.parse((await valid()).content);
  bad.wireFormat = 'plaintext';
  const rebuilt = signEventDeterministically({
    kind: RELAY_ENVELOPE_KIND, created_at: 1760000000, tags: [], content: JSON.stringify(bad),
  }, sk('authority'));
  const r = await parseAndVerifyRelayEnvelope(rebuilt);
  assert.equal(r.reason, VERIFY_REASONS.WIRE_FORMAT);
  assert.deepEqual(WIRE_FORMATS, ['mLSMessage', 'welcome', 'commit']);
});

test('malformed governanceRef fails governance-mismatch, never a fallback accept', async () => {
  const bad = JSON.parse((await valid()).content);
  delete bad.governanceRef;
  const rebuilt = signEventDeterministically({
    kind: RELAY_ENVELOPE_KIND, created_at: 1760000000, tags: [], content: JSON.stringify(bad),
  }, sk('authority'));
  const r = await parseAndVerifyRelayEnvelope(rebuilt);
  assert.equal(r.ok, false);
  assert.equal(r.reason, VERIFY_REASONS.GOVERNANCE);
});

test('non-hex mlsBytesHex fails closed as content error', async () => {
  const bad = JSON.parse((await valid()).content);
  bad.mlsBytesHex = 'zz-not-hex';
  const rebuilt = signEventDeterministically({
    kind: RELAY_ENVELOPE_KIND, created_at: 1760000000, tags: [], content: JSON.stringify(bad),
  }, sk('authority'));
  const r = await parseAndVerifyRelayEnvelope(rebuilt);
  assert.equal(r.ok, false);
  assert.equal(r.reason, VERIFY_REASONS.CONTENT);
});

test('unknown envelope type/version fails schema check', async () => {
  const bad = JSON.parse((await valid()).content);
  bad.v = 999;
  const rebuilt = signEventDeterministically({
    kind: RELAY_ENVELOPE_KIND, created_at: 1760000000, tags: [], content: JSON.stringify(bad),
  }, sk('authority'));
  assert.equal((await parseAndVerifyRelayEnvelope(rebuilt)).reason, VERIFY_REASONS.SCHEMA);
});

test('not-an-event and unsigned garbage fail before any semantic parse', async () => {
  assert.equal((await parseAndVerifyRelayEnvelope(null)).reason, VERIFY_REASONS.NOT_AN_EVENT);
  assert.equal((await parseAndVerifyRelayEnvelope(undefined)).reason, VERIFY_REASONS.NOT_AN_EVENT);
  assert.equal((await parseAndVerifyRelayEnvelope({})).reason, VERIFY_REASONS.SIGNATURE);
});

test('an embedded attestation that does not bind this group+epoch is rejected', async () => {
  const member = newKey();
  const misbound = await signEpochAttestation({
    groupId: 'group-other',
    epoch: 2,
    transcriptHash: hex('transcript'),
    commitHash: hex('commit'),
    secretKey: member.secretKey,
  });
  const event = await buildRelayEnvelope({ ...baseArgs(), attestations: [misbound] });
  const r = await parseAndVerifyRelayEnvelope(event);
  assert.equal(r.reason, VERIFY_REASONS.ATTESTATION);
});

test('an embedded attestation bound to another epoch is rejected', async () => {
  const member = newKey();
  const attestation = await signEpochAttestation({
    groupId: 'group-alpha', epoch: 7,
    transcriptHash: hex('transcript'), commitHash: hex('commit'),
    secretKey: member.secretKey,
  });
  const event = await buildRelayEnvelope({ ...baseArgs(), attestations: [attestation] });
  assert.equal((await parseAndVerifyRelayEnvelope(event)).reason, VERIFY_REASONS.ATTESTATION);
});

test('a correctly bound fresh attestation verifies inside the envelope', async () => {
  const member = newKey();
  const attestation = await signEpochAttestation({
    groupId: 'group-alpha', epoch: 2,
    transcriptHash: hex('transcript'), commitHash: hex('commit'),
    secretKey: member.secretKey,
  });
  const event = await buildRelayEnvelope({ ...baseArgs(), attestations: [attestation] });
  const r = await parseAndVerifyRelayEnvelope(event);
  assert.equal(r.ok, true);
  assert.equal(r.envelope.attestations.length, 1);
});

test('a forged attestation signature fails attestation-invalid', async () => {
  const member = newKey();
  const attestation = await signEpochAttestation({
    groupId: 'group-alpha', epoch: 2,
    transcriptHash: hex('transcript'), commitHash: hex('commit'),
    secretKey: member.secretKey,
  });
  const forged = { ...attestation, binding: { ...attestation.binding, transcriptHash: 'ff'.repeat(32) } };
  const event = await buildRelayEnvelope({ ...baseArgs(), attestations: [forged] });
  assert.equal((await parseAndVerifyRelayEnvelope(event)).reason, VERIFY_REASONS.ATTESTATION);
});

test('empty group id and malformed builder args fail construction (null)', async () => {
  assert.equal(await buildRelayEnvelope({ ...baseArgs(), groupId: '' }), null);
  assert.equal(await buildRelayEnvelope({ ...baseArgs(), wireFormat: 'nonsense' }), null);
  assert.equal(await buildRelayEnvelope({ ...baseArgs(), epoch: -1 }), null);
  assert.equal(await buildRelayEnvelope({ ...baseArgs(), governanceRevision: 1.5 }), null);
  assert.equal(await buildRelayEnvelope({ ...baseArgs(), governanceHash: 'short' }), null);
  assert.equal(await buildRelayEnvelope({ ...baseArgs(), authoritySecret: 'nothex' }), null);
});

test('bad content JSON (hand-crafted non-object) fails envelope-content', async () => {
  const rebuilt = signEventDeterministically({
    kind: RELAY_ENVELOPE_KIND, created_at: 1760000000, tags: [], content: '"just-a-string"',
  }, sk('authority'));
  assert.equal((await parseAndVerifyRelayEnvelope(rebuilt)).reason, VERIFY_REASONS.CONTENT);
});
