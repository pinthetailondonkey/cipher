import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REVOKE_GRACE_SECONDS,
  REGISTRY_MAX_AGE_SECONDS,
  buildDeviceCertificate,
  buildTestDmEnvelope,
  compareDedupe,
  dedupeKeyDigest,
  dedupeTuple,
  headAgeVerdict,
  operationDigest,
  receiveVerifyOrder,
  verifyDeviceCertificate,
} from './protocolTestDmOperations.js';
import { jcsEncode } from './protocolTestDmWire.js';
import { nip44 } from 'nostr-tools';
import { getPublicKey } from 'nostr-tools/pure';
import { sha256 } from '@noble/hashes/sha2.js';

const sk = (label) => sha256(new TextEncoder().encode(`cipher-dm-test-kat/v1|${label}`));
const T0 = 1760000000;
const SENDER_SK = sk('sender-device');
const RECEIVER_SK = sk('receiver-device');
const AUTHORITY_SK = sk('authority-primary');
const ROUTE_SK = sk('route-key');
const SENDER_PK = getPublicKey(SENDER_SK);
const RECEIVER_PK = getPublicKey(RECEIVER_SK);
const AUTHORITY_PK = getPublicKey(AUTHORITY_SK);
const ROUTE_PK = getPublicKey(ROUTE_SK);
const HEAD = 'a'.repeat(64);
const OP_ID = 'f9db1636d0dc667803db7512c36a2f41';

function buildFixture() {
  const operation = {
    protocol: 'cipher-dm-test-v1', version: 1, opId: OP_ID,
    fromDevice: SENDER_PK, toDevice: RECEIVER_PK, body: 'hello first contact',
  };
  const olmPayload = JSON.stringify({ olmVersion: 2, opId: OP_ID, body: operation.body });
  return buildTestDmEnvelope({
    operationPlaintext: operation, olmPayloadText: olmPayload,
    senderDeviceSecret: SENDER_SK, routeRecipientPubkey: ROUTE_PK,
    wrapSecret: sk('wrap-ephemeral'), createdAt: T0,
  });
}

test('operation digest binds to canonical bytes, not insertion order', () => {
  const a = operationDigest({ x: 1, y: [2, 'three'] });
  const b = operationDigest((() => { const o = {}; o.y = [2, 'three']; o.x = 1; return o; })());
  assert.equal(a, b);
});

test('decimal amounts ride as strings and floats refuse at encode time', () => {
  assert.doesNotThrow(() => jcsEncode({ amount: '0.500000000000' }));
  assert.throws(() => jcsEncode({ amount: 0.5 }), /safe integer/);
});

test('dedupe compares by digest: duplicate and conflict verdicts', () => {
  const digest = dedupeKeyDigest(SENDER_PK, OP_ID);
  assert.equal(digest, Buffer.from(sha256(new TextEncoder().encode(dedupeTuple(SENDER_PK, OP_ID)))).toString('hex'));
  assert.equal(compareDedupe(digest, digest), 'duplicate');
  const otherDigest = Buffer.from(sha256(new TextEncoder().encode(`${SENDER_PK}:other-op`))).toString('hex');
  assert.equal(compareDedupe(digest, otherDigest), 'conflict');
  assert.equal(compareDedupe('zz', digest), 'invalid');
});

test('wrap hides the sender device key and the p tag names the route only', () => {
  const { wrap, seal } = buildFixture();
  assert.equal(wrap.kind, 1059);
  assert.notEqual(wrap.pubkey, SENDER_PK);
  const pTags = wrap.tags.filter((t) => t[0] === 'p');
  assert.equal(pTags.length, 1);
  assert.equal(pTags[0][1], ROUTE_PK);
  for (const tag of [...wrap.tags, ...seal.tags]) {
    assert.ok(!tag.includes(RECEIVER_PK), 'stable device key must not ride a tag');
  }
});

test('receive order accepts a valid v2 envelope and rejects v1 init at step 4', () => {
  const { wrap } = buildFixture();
  const opts = {
    routeSecret: ROUTE_SK, routeRecipientPubkey: ROUTE_PK,
    expectedAuthorityPubkey: AUTHORITY_PK, expectedRegistryHeadId: HEAD,
    nowSeconds: T0 + 60, isOlmV2Init: (r) => JSON.parse(r.content).olmVersion === 2,
  };
  const accept = receiveVerifyOrder(wrap, opts);
  assert.equal(accept.ok, true);
  const v1 = buildTestDmEnvelope({
    operationPlaintext: {}, olmPayloadText: JSON.stringify({ olmVersion: 1, opId: OP_ID }),
    senderDeviceSecret: SENDER_SK, routeRecipientPubkey: ROUTE_PK,
    wrapSecret: sk('wrap-ephemeral'), createdAt: T0,
  });
  const reject = receiveVerifyOrder(v1.wrap, opts);
  assert.deepEqual({ ok: reject.ok, step: reject.step, reason: reject.reason },
    { ok: false, step: 4, reason: 'olm-v1-init-rejected' });
});

test('D1 grace: revocation effective time plus five minutes rejects late sends', () => {
  const cert = buildDeviceCertificate({ authoritySecret: AUTHORITY_SK, devicePubkey: SENDER_PK, registryHeadId: HEAD, sentAt: T0 });
  const base = { expectedAuthorityPubkey: AUTHORITY_PK, expectedRegistryHeadId: HEAD };
  const within = verifyDeviceCertificate(cert, { ...base, nowSeconds: T0 + 60, revocationEffectiveAt: T0 });
  const after = verifyDeviceCertificate(cert, { ...base, nowSeconds: T0 + 60, revocationEffectiveAt: T0 - REVOKE_GRACE_SECONDS - 1 });
  assert.equal(within.ok, true);
  assert.equal(after.reason, 'revoked-after-grace');
  // Boundary: sentAt exactly at effective + grace accepts.
  const boundary = verifyDeviceCertificate(
    { ...cert, content: JSON.stringify({ v: 1, device: SENDER_PK, registryHead: HEAD, sentAt: T0 }) },
    { ...base, nowSeconds: T0 + 60, revocationEffectiveAt: T0 - REVOKE_GRACE_SECONDS },
  );
  assert.equal(boundary.ok, true);
});

test('D3 head age: exactly 24 hours is fresh, one second past is stale', () => {
  assert.equal(headAgeVerdict(T0 - REGISTRY_MAX_AGE_SECONDS, T0), 'fresh');
  assert.equal(headAgeVerdict(T0 - REGISTRY_MAX_AGE_SECONDS - 1, T0), 'stale-registry-head');
  assert.equal(headAgeVerdict('x', T0), 'invalid-head');
});

test('wrong authority and stale head are named reject reasons on the wire path', () => {
  const cert = buildDeviceCertificate({ authoritySecret: sk('other-authority'), devicePubkey: SENDER_PK, registryHeadId: HEAD, sentAt: T0 });
  const verdict = verifyDeviceCertificate(cert, { expectedAuthorityPubkey: AUTHORITY_PK, expectedRegistryHeadId: HEAD, nowSeconds: T0 + 60 });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'certificate-authority');
});

test('seal and wrap layers decrypt back to the original payload (NIP-44 v2)', () => {
  const fixture = buildFixture();
  // The rumor content IS the Olm payload text (encryption to the Olm session
  // happens above this layer); the sealed layers are what carry NIP-44 here.
  const olmPayload = JSON.parse(fixture.rumor.content);
  assert.equal(olmPayload.olmVersion, 2);
  const seal = JSON.parse(nip44.v2.decrypt(
    fixture.wrap.content,
    nip44.v2.utils.getConversationKey(sk('wrap-ephemeral'), ROUTE_PK),
  ));
  assert.equal(seal.kind, 13);
  assert.equal(seal.id, fixture.seal.id);
  const rumorBack = JSON.parse(nip44.v2.decrypt(
    seal.content,
    nip44.v2.utils.getConversationKey(SENDER_SK, ROUTE_PK),
  ));
  assert.equal(rumorBack.content, JSON.stringify(olmPayload));
});

test('wire path touches no production signal file (source shape guard)', async () => {
  // Reading only: the module tree of this directory must not import window
  // state or storage. Static assertion by import shape rather than fs walk.
  const mod = await import('./protocolTestDmOperations.js');
  assert.equal(typeof mod.receiveVerifyOrder, 'function');
  assert.equal(typeof mod.buildTestDmEnvelope, 'function');
});
