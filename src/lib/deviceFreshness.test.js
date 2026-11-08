import assert from 'node:assert/strict';
import test from 'node:test';
import { nip44, nip59 } from 'nostr-tools';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { buildDeviceRegistryEvent, revokeDevice } from './deviceEnrollment.js';
import { rumorTags, sealAndWrap } from './giftWrap.js';
import { unwrapToRumor } from './giftUnwrap.js';
import {
  buildDeviceFreshnessResponse,
  createDeviceFreshnessChallenge,
  verifyDeviceFreshnessResponse,
} from './deviceFreshness.js';

const now = 1_800_000_000;
const authoritySecret = generateSecretKey();
const authority = getPublicKey(authoritySecret);
const requesterSecret = generateSecretKey();
const requester = getPublicKey(requesterSecret);
const deviceSecret = generateSecretKey();
const deviceId = 'c'.repeat(32);
const registry = buildDeviceRegistryEvent({
  accountSecret: authoritySecret,
  generation: 4,
  devices: [
    { deviceId, pubkey: getPublicKey(deviceSecret), status: 'active', enrolledAt: now - 20 },
    { deviceId: 'd'.repeat(32), pubkey: authority, status: 'active', enrolledAt: now - 20 },
  ],
}, now - 10);

let nonceByte = 1;
function challenge(at = now, target = deviceId) {
  return createDeviceFreshnessChallenge({
    requesterSecret,
    authorityPubkey: authority,
    deviceId: target,
    now: at,
    randomBytes: (bytes) => bytes.fill(nonceByte++),
  });
}

function response(challengeEvent, registryEvent = registry, generation = 4, at = now + 1) {
  return buildDeviceFreshnessResponse({
    challengeEvent,
    authoritySecret,
    registryEvent,
    currentGeneration: generation,
    now: at,
  });
}

test('fresh authority response binds current registry, requested device, requester and nonce', () => {
  const request = challenge();
  const answer = response(request);
  const proof = verifyDeviceFreshnessResponse(answer, request, {
    expectedAuthority: authority,
    expectedRequester: requester,
    expectedDeviceId: deviceId,
    minimumRegistryGeneration: 4,
    now: now + 2,
  });
  assert.equal(proof.generation, 4);
  assert.equal(proof.generation, 4);
  assert.equal(proof.devicePubkey, getPublicKey(deviceSecret));
  assert.equal(answer.content.includes('registryEvent'), false, 'the response does not disclose the authority’s full device roster');
  assert.equal(proof.deviceId, deviceId);
  assert.equal(proof.freshUntil, now + 31);
  assert.equal(verifyDeviceFreshnessResponse(answer, challenge(), { now: now + 2 }), null,
    'a response for a different nonce cannot be replayed');
  assert.equal(verifyDeviceFreshnessResponse(answer, request, {
    expectedDeviceId: 'd'.repeat(32), now: now + 2,
  }), null, 'a response cannot authorize another device');
  assert.equal(verifyDeviceFreshnessResponse({ ...answer, content: answer.content + 'x' }, request, { now: now + 2 }), null,
    'a modified authority response fails signature/hash validation');
});

test('missing, stale and expired authority responses fail closed', () => {
  const request = challenge();
  assert.equal(verifyDeviceFreshnessResponse(null, request, { now: now + 1 }), null,
    'withheld responses provide no authorization');

  const nextRegistry = buildDeviceRegistryEvent({
    accountSecret: authoritySecret,
    generation: 5,
    devices: JSON.parse(registry.content).devices,
  }, now);
  const staleRequest = challenge(now + 1);
  assert.throws(() => response(staleRequest, registry, 5, now + 2), /current registry|active/i,
    'the authority must not certify a registry below its sealed generation checkpoint');

  const expiringRequest = challenge(now + 1);
  const expiringAnswer = response(expiringRequest, nextRegistry, 5, now + 2);
  assert.equal(verifyDeviceFreshnessResponse(expiringAnswer, expiringRequest, {
    minimumRegistryGeneration: 5,
    now: now + 33,
  }), null, 'an authority answer is usable only for its short expiry window');
  assert.equal(verifyDeviceFreshnessResponse(expiringAnswer, expiringRequest, {
    minimumRegistryGeneration: 6,
    now: now + 3,
  }), null, 'a lower generation cannot override a previously held checkpoint');
});

test('an authority refuses to certify a revoked device', () => {
  const revoked = revokeDevice({ registryEvent: registry, deviceId, accountSecret: authoritySecret, now });
  const request = challenge();
  assert.throws(() => response(request, revoked, 5), /current registry|active/i);
  const signatureFromWrongAuthority = finalizeEvent({
    kind: 30084,
    created_at: now + 1,
    tags: [['e', request.id], ['p', requester], ['expiration', String(now + 20)]],
    content: JSON.stringify({ protocol: 'cipher-device-freshness', version: 1 }),
  }, generateSecretKey());
  assert.equal(verifyDeviceFreshnessResponse(signatureFromWrongAuthority, request, { now: now + 2 }), null);
});

test('freshness response can ride the existing private DM envelope without exposing account or device keys', () => {
  const request = challenge();
  const answer = response(request);
  const shared = nip44.v2.utils.getConversationKey(authoritySecret, requester);
  const rumor = nip59.createRumor({
    kind: 4,
    created_at: now + 1,
    tags: rumorTags({ recipient: requester }),
    content: nip44.v2.encrypt(JSON.stringify(answer), shared),
  }, authoritySecret);
  const { wrap } = sealAndWrap(rumor, { senderSk: authoritySecret, recipientPubkey: requester });
  const relayFrame = JSON.stringify(wrap);
  assert.equal(wrap.kind, 1059);
  assert.ok(relayFrame.includes(requester), 'the existing DM recipient-routing tag remains visible');
  assert.equal(relayFrame.includes(authority), false, 'the authority account key stays inside the seal');
  assert.equal(relayFrame.includes(deviceId), false, 'the challenged device id stays inside the seal');
  assert.equal(relayFrame.includes(getPublicKey(deviceSecret)), false, 'the device signing key stays inside the seal');

  const opened = unwrapToRumor(wrap, requesterSecret);
  const openedShared = nip44.v2.utils.getConversationKey(requesterSecret, opened.rumor.pubkey);
  const receivedResponse = JSON.parse(nip44.v2.decrypt(opened.rumor.content, openedShared));
  assert.equal(verifyDeviceFreshnessResponse(receivedResponse, request, {
    expectedAuthority: authority,
    expectedRequester: requester,
    expectedDeviceId: deviceId,
    now: now + 2,
  }).generation, 4);
});
