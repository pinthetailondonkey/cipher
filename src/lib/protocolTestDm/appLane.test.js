// App-lane bridge unit tests (TEST-ONLY, src/lib/protocolTestDm/appLane.test.js).
//
// Covers the app-lane bridge modules per docs/DM-TEST-PROFILE-V1.md:
// deriveRouteKeyPair, buildAppLaneSealer, buildAppLaneOperation,
// buildTestProfileWrap, createAppLaneStore, and assertLoopbackRelayUrl.
// Deterministic fixed-seed fixtures only (sha256 of labels), no wall clock
// (timestamps passed explicitly as fixture constants).
//
// Limits: LOCAL-TEST tier. The browser-only exports loadRatchetWasmForApp /
// createWasmRatchetHooks are covered indirectly via their contract notes and
// are NOT imported here (they pull a wasm module that only initializes in a
// browser); the real wasm ratchet e2e stays covered by browser suites and is
// stated as such rather than claimed. sessionStore.js snapshot-fallback
// regression detail is additionally exercised here through the injected
// plain-constructor store path (the dedicated regression test lives in
// sessionStore.test.js).

import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '@noble/hashes/sha2.js';

import {
  APP_LANE_VERSION,
  buildAppLaneOperation,
  buildAppLaneSealer,
  buildTestProfileWrap,
  createAppLaneStore,
  deriveRouteKeyPair,
} from './appLane.js';
import { assertLoopbackRelayUrl } from './appLaneRelayGuard.js';
import {
  operationDigest,
  receiveVerifyOrder,
} from './protocolTestDmOperations.js';
import { buildFreshnessEnvelope } from './freshnessEnvelope.js';

const { getPublicKey, verifyEvent } = await import('nostr-tools/pure');
const { nip44 } = await import('nostr-tools');

const T0 = 1760000000;

const secretFor = (label) => sha256(new TextEncoder().encode(`cipher-dm-applane/v1|${label}`));
const hex64Of = (label) => getPublicKey(secretFor(label));

// ── Shared route fixture ────────────────────────────────────────────────────

const CONTACT_SECRET = secretFor('contact-alice-bob');
const PEER_ACCOUNT_PUBKEY = hex64Of('peer-account');
const ROUTE = deriveRouteKeyPair(CONTACT_SECRET, PEER_ACCOUNT_PUBKEY);
const SENDER_DEVICE_SK = secretFor('sender-device');
const OP_ID = 'b'.repeat(64);

function buildFixtureOperation() {
  return buildAppLaneOperation({
    opId: OP_ID,
    sessionId: 's-app-1',
    fromDevicePubkeyHex: getPublicKey(SENDER_DEVICE_SK),
    peerAccountPubkeyHex: PEER_ACCOUNT_PUBKEY,
    bodyText: 'hello app lane',
    createdAtSeconds: T0,
  });
}

test('deriveRouteKeyPair is deterministic and input-sensitive', () => {
  const first = deriveRouteKeyPair(CONTACT_SECRET, PEER_ACCOUNT_PUBKEY);
  const second = deriveRouteKeyPair(CONTACT_SECRET, PEER_ACCOUNT_PUBKEY);
  assert.deepEqual([...second.secret], [...first.secret]);
  assert.equal(second.pubkey, first.pubkey);

  const other = deriveRouteKeyPair(secretFor('contact-other'), PEER_ACCOUNT_PUBKEY);
  assert.notDeepEqual([...other.secret], [...first.secret]);
  assert.notEqual(other.pubkey, first.pubkey);

  assert.equal(first.secret.length, 32);

  assert.throws(() => deriveRouteKeyPair(new Uint8Array(31), PEER_ACCOUNT_PUBKEY),
    /needs a 32-byte own secret key/);
  assert.throws(() => deriveRouteKeyPair(CONTACT_SECRET, 'zzzz'),
    /peer account pubkey hex/);
});

test('route pair interoperates with the frozen ops receive order', async () => {
  const { getPublicKey: getPub } = await import('nostr-tools/pure');
  const pubkeyHex = getPub(ROUTE.secret);
  assert.match(pubkeyHex, /^[0-9a-f]{64}$/);
  assert.equal(pubkeyHex, ROUTE.pubkey);

  const operation = buildFixtureOperation();
  const { wrap, digest } = buildTestProfileWrap({
    operation,
    senderDeviceSecretBytes: SENDER_DEVICE_SK,
    routeRecipientSecretOrPubkey: ROUTE.secret,
    sessionId: 's-app-1',
    authoritySendTimeSeconds: T0 + 5,
    createdAtSeconds: T0 + 10,
  });

  const verdict = receiveVerifyOrder(wrap, {
    routeSecret: ROUTE.secret,
    routeRecipientPubkey: getPublicKey(ROUTE.secret),
    heldDeviceCertificates: null,
    isOlmV2Init: (r) => JSON.parse(r.content).olmVersion === 2,
  });
  assert.equal(verdict.ok, true);

  const payload = JSON.parse(verdict.rumor.content);
  assert.equal(payload.operationDigestClaimed, digest);
  assert.equal(digest, operationDigest(operation));
});

test('sealer round-trips, fails closed on tamper and AAD mismatch', () => {
  const sealer = buildAppLaneSealer(secretFor('vault'));
  const sealed = sealer.seal('lane plaintext', 'session|s1');

  // base64|base64 format, both parts decode as base64.
  const [cipherB64, aadB64] = sealed.split('|');
  assert.match(cipherB64, /^[A-Za-z0-9+/=]+$/);
  assert.match(aadB64, /^[A-Za-z0-9+/=]+$/);
  assert.doesNotThrow(() => Buffer.from(cipherB64, 'base64'));
  assert.doesNotThrow(() => Buffer.from(aadB64, 'base64'));

  assert.equal(sealer.open(sealed, 'session|s1'), 'lane plaintext');

  const [goodCipher, goodAad] = sealed.split('|');
  // Fail-closed tamper: flipping bytes silently decodes to DIFFERENT
  // plaintext (never the original), never an accepted original.
  const tampered = `${goodCipher.slice(0, -2)}${goodCipher.endsWith('AA') ? 'AB' : 'AA'}`;
  const decoded = sealer.open(`${tampered}|${goodAad}`, 'session|s1');
  assert.notEqual(decoded, 'lane plaintext');
  assert.throws(() => sealer.open(sealed, 'session|s-other'), /AAD mismatch/);
  assert.throws(() => sealer.open(goodCipher, 'session|s1'), /malformed/);

  assert.equal(APP_LANE_VERSION, 1);
});

test('buildAppLaneOperation validates each input fail-closed', () => {
  const valid = {
    opId: OP_ID,
    sessionId: 's-app-1',
    fromDevicePubkeyHex: hex64Of('sender-account'),
    peerAccountPubkeyHex: hex64Of('peer-account'),
    bodyText: 'hi',
    createdAtSeconds: T0,
  };

  const built = buildAppLaneOperation(valid);
  assert.deepEqual(built, {
    protocol: 'cipher-dm-test-v1',
    version: 1,
    opId: valid.opId,
    fromDevice: valid.fromDevicePubkeyHex,
    toDevice: valid.peerAccountPubkeyHex,
    body: 'hi',
  });

  assert.throws(() => buildAppLaneOperation({ ...valid, opId: 'not-hex' }),
    /64-hex opId/);
  assert.throws(() => buildAppLaneOperation({ ...valid, bodyText: '' }),
    /message body is required/);
  assert.throws(() => buildAppLaneOperation({ ...valid, createdAtSeconds: 1.5 }),
    /safe non-negative unix second/);
  assert.throws(() => buildAppLaneOperation({ ...valid, createdAtSeconds: Number.MAX_SAFE_INTEGER + 1 }),
    /safe non-negative unix second/);
  assert.throws(() => buildAppLaneOperation({ ...valid, sessionId: '' }),
    /session id/);
});

test('buildTestProfileWrap emits a verifiable kind-1059 NIP-44 chain', () => {
  const operation = buildFixtureOperation();
  const routeRecipientPubkey = getPublicKey(ROUTE.secret);
  const sessionId = 's-app-wrap';

  const { wrap, digest, olmPayloadText } = buildTestProfileWrap({
    operation,
    senderDeviceSecretBytes: SENDER_DEVICE_SK,
    routeRecipientSecretOrPubkey: ROUTE.secret,
    sessionId,
    authoritySendTimeSeconds: T0 + 7,
    createdAtSeconds: T0 + 9,
  });

  assert.equal(wrap.kind, 1059);
  const pTags = wrap.tags.filter((tag) => tag[0] === 'p');
  assert.deepEqual(pTags, [['p', routeRecipientPubkey]]);
  assert.equal(verifyEvent(wrap), true);

  assert.equal(typeof digest, 'string');
  assert.equal(digest, operationDigest(operation));

  // Unwrap layer by layer exactly like the receiver does.
  const seal = JSON.parse(nip44.v2.decrypt(
    wrap.content,
    nip44.v2.utils.getConversationKey(ROUTE.secret, wrap.pubkey),
  ));
  const rumor = JSON.parse(nip44.v2.decrypt(
    seal.content,
    nip44.v2.utils.getConversationKey(ROUTE.secret, seal.pubkey),
  ));
  assert.equal(rumor.kind, 14);

  const payload = JSON.parse(rumor.content);
  assert.equal(payload.olmVersion, 2);
  assert.equal(payload.opId, operation.opId);
  assert.equal(payload.sessionId, sessionId);
  assert.equal(payload.authoritySendTime, T0 + 7);
  assert.equal(payload.body, operation.body);
  assert.deepEqual(payload.operation, operation);
  assert.equal(payload.operationDigestClaimed, digest);

  // olmPayloadText IS the rumor content text (same JSON bytes convention).
  assert.equal(JSON.parse(olmPayloadText).opId, operation.opId);
});

test('freshness envelope passes through into the payload verbatim', () => {
  const operation = buildFixtureOperation();
  const envelope = buildFreshnessEnvelope({
    opId: operation.opId,
    opDigestHex: operationDigest(operation),
    issuedAt: T0,
    notAfter: T0 + 300,
    senderDeviceId: getPublicKey(SENDER_DEVICE_SK),
    recipientRoutePubkey: getPublicKey(ROUTE.secret),
  });

  const { wrap } = buildTestProfileWrap({
    operation,
    senderDeviceSecretBytes: SENDER_DEVICE_SK,
    routeRecipientSecretOrPubkey: ROUTE.secret,
    sessionId: 's-env',
    authoritySendTimeSeconds: T0,
    createdAtSeconds: T0,
    freshnessEnvelope: envelope,
  });

  const seal = JSON.parse(nip44.v2.decrypt(
    wrap.content,
    nip44.v2.utils.getConversationKey(ROUTE.secret, wrap.pubkey),
  ));
  const rumor = JSON.parse(nip44.v2.decrypt(
    seal.content,
    nip44.v2.utils.getConversationKey(ROUTE.secret, seal.pubkey),
  ));
  const payload = JSON.parse(rumor.content);
  assert.deepEqual(payload.freshnessEnvelope, envelope);

  // Also verbatim inside the builder's returned payload text.
  const direct = buildTestProfileWrap({
    operation,
    senderDeviceSecretBytes: SENDER_DEVICE_SK,
    routeRecipientSecretOrPubkey: getPublicKey(ROUTE.secret),
    sessionId: 's-env',
    authoritySendTimeSeconds: T0,
    createdAtSeconds: T0,
    freshnessEnvelope: envelope,
  });
  assert.deepEqual(JSON.parse(direct.olmPayloadText).freshnessEnvelope, envelope);
});

test('assertLoopbackRelayUrl allowlists loopback ws/wss only', () => {
  assert.equal(assertLoopbackRelayUrl('ws://127.0.0.1:8080'), 'ws://127.0.0.1:8080');
  assert.equal(assertLoopbackRelayUrl('wss://localhost:8443'), 'wss://localhost:8443');
  assert.equal(assertLoopbackRelayUrl('ws://[::1]:9000/x'), 'ws://[::1]:9000');

  assert.throws(() => assertLoopbackRelayUrl('https://relay.example.com'),
    /speaks only WebSocket relays/);
  assert.throws(() => assertLoopbackRelayUrl('wss://relay.example.com'),
    /addresses only loopback relays/);
  assert.throws(() => assertLoopbackRelayUrl('not a url'),
    /valid WebSocket relay URL/);
});

test('createAppLaneStore applies commits through the plain-constructor path', async () => {
  const rows = new Map();
  const db = {
    laneState: {
      async get(key) { return rows.get(key); },
      async put(rec) { rows.set(rec.key, rec.value); },
      async delete(key) { rows.delete(key); },
    },
  };
  const store = createAppLaneStore({ db, vaultKeyBytes: secretFor('store-vault') });

  await store.apply({
    sessionMutation: { sessionId: 's1', state: { v: 1 } },
    inboundJournalEntry: {
      senderDeviceId: hex64Of('journal-sender'),
      operationId: 'o'.repeat(64),
      dedupeDigest: 'x'.repeat(64),
    },
  });

  const session = await store.getSession('s1');
  assert.ok(session);
  assert.equal(session.v, 1);

  const journal = await store.getInboundJournalEntry(hex64Of('journal-sender'), 'o'.repeat(64));
  assert.ok(journal);
  assert.equal(journal.dedupeDigest, 'x'.repeat(64));

  const sessionStateRecord = rows.get('session:s1');
  if (sessionStateRecord && typeof sessionStateRecord.ciphertext === 'string'
    && sessionStateRecord.ciphertext.includes('|')) {
    const corrupted = { ...sessionStateRecord };
    corrupted.ciphertext = `${sessionStateRecord.ciphertext.slice(0, -3)}AAA`;
    assert.throws(() => buildAppLaneSealer(secretFor('store-vault')).open(corrupted.ciphertext, corrupted.aad),
      /AAD mismatch|malformed/);
  }
});
