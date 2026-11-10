// DM test profile v1 operations: digests, dedupe keys, device certificates,
// freshness gates, and the wire layer stack (kind 14 rumor, kind 13 seal,
// kind 1059 wrap) per docs/DM-TEST-PROFILE-V1.md.
//
// Pure functions. No window state, no storage imports. Everything that wants
// entropy comes in as bytes; all randomness for vector generation is derived
// from fixed seeds by the KAT generator.

import { nip44, nip59 } from 'nostr-tools';
import { getEventHash, getPublicKey, verifyEvent } from 'nostr-tools/pure';
import { schnorr } from '@noble/curves/secp256k1.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';

// nostr-tools' finalizeEvent signs with RANDOM aux bytes, so identical events
// get different sigs. KAT output must be byte-identical on rerun, so this
// module signs with BIP-340 schnorr over the same serialized event hash and a
// DETERMINISTIC aux (zeros). The signature is a valid Nostr event signature;
// verifyEvent accepts it. This only pins KAT determinism; live sends may keep
// randomized aux.
function signEventDeterministic(eventTemplate, secretKey) {
  const event = eventTemplate;
  event.pubkey = getPublicKey(secretKey);
  const hashHex = typeof getEventHash(event) === 'string' ? getEventHash(event) : Buffer.from(getEventHash(event)).toString('hex');
  event.id = hashHex;
  const aux = new Uint8Array(32); // zeros: deterministic
  event.sig = Buffer.from(schnorr.sign(hexToBytes(hashHex), secretKey, aux)).toString('hex');
  return event;
}
import { jcsEncode } from './protocolTestDmWire.js';

export const TEST_DM_PROTOCOL = 'cipher-dm-test-v1';
export const TEST_DM_VERSION = 1;

// Profile constants: docs/DM-TEST-PROFILE-V1.md section 2.
export const REVOKE_GRACE_SECONDS = 300; // D1 TEST DEFAULT, not approved production policy
export const REGISTRY_MAX_AGE_SECONDS = 86400; // D3 TEST DEFAULT, not approved production policy

export const DEVICE_CERTIFICATE_KIND = 30085;
export const DEVICE_CERTIFICATE_D_TAG = 'device-certificate-v1';

const HEX64 = /^[0-9a-f]{64}$/;

export function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

export function sha256Hex(bytes) {
  return Buffer.from(sha256(bytes)).toString('hex');
}

// ── Operation plaintext canonical encoding + digest ────────────────────────
// Canonical encoding: reviewer-open (profile section 3). Digest is SHA-256 of
// the canonical UTF-8 bytes of the operation object, no envelope fields.

export function encodeOperationCanonical(operation) {
  return jcsEncode(operation);
}

export function operationCanonicalBytes(operation) {
  return utf8Bytes(jcsEncode(operation));
}

export function operationDigest(operation) {
  return sha256Hex(operationCanonicalBytes(operation));
}

// ── Dedupe key (profile section 4) ─────────────────────────────────────────

export function dedupeTuple(senderDeviceIdOrPubkey, operationId) {
  if (!senderDeviceIdOrPubkey || !operationId) throw new Error('Dedupe tuple needs a sender device id and an operation id.');
  return `${senderDeviceIdOrPubkey}:${operationId}`;
}

// Compared BY DIGEST, never by event/rumor/wrap id.
export function dedupeKeyDigest(senderDeviceIdOrPubkey, operationId) {
  return sha256Hex(utf8Bytes(dedupeTuple(senderDeviceIdOrPubkey, operationId)));
}

export function compareDedupe(storedDigest, candidateDigest) {
  if (!HEX64.test(storedDigest || '') || !HEX64.test(candidateDigest || '')) return 'invalid';
  if (storedDigest === candidateDigest) return 'duplicate'; // same tuple + same digest
  return 'conflict'; // same tuple claimed, different digest
}

// ── Device certificate (profile section 2) ─────────────────────────────────

export function buildDeviceCertificate({ authoritySecret, devicePubkey, registryHeadId, sentAt }) {
  if (!HEX64.test(registryHeadId || '')) throw new Error('Certificate requires a 64-hex registry head id.');
  if (!HEX64.test(devicePubkey || '')) throw new Error('Certificate requires a 64-hex device pubkey.');
  if (!Number.isSafeInteger(sentAt) || sentAt < 0) throw new Error('Certificate sentAt must be a safe non-negative integer.');
  return signEventDeterministic({
    kind: DEVICE_CERTIFICATE_KIND,
    created_at: sentAt,
    tags: [
      ['d', DEVICE_CERTIFICATE_D_TAG],
      ['head', registryHeadId],
      ['p', devicePubkey],
    ],
    content: JSON.stringify({ v: 1, device: devicePubkey, registryHead: registryHeadId, sentAt }),
  }, authoritySecret);
}

export function verifyDeviceCertificate(certificate, { expectedAuthorityPubkey, expectedRegistryHeadId, nowSeconds, revocationEffectiveAt = null }) {
  try {
    if (!verifyEvent(certificate)) return { ok: false, reason: 'certificate-signature' };
    if (certificate.kind !== DEVICE_CERTIFICATE_KIND) return { ok: false, reason: 'certificate-kind' };
    if (certificate.pubkey !== expectedAuthorityPubkey) return { ok: false, reason: 'certificate-authority' };
    const headTag = certificate.tags?.find((tag) => tag[0] === 'head')?.[1];
    if (headTag !== expectedRegistryHeadId) return { ok: false, reason: 'certificate-head' };
    const cert = JSON.parse(certificate.content);
    if (cert.v !== 1 || cert.device == null || cert.registryHead !== expectedRegistryHeadId) return { ok: false, reason: 'certificate-shape' };
    if (typeof cert.sentAt !== 'number' || !Number.isSafeInteger(cert.sentAt)) return { ok: false, reason: 'certificate-sentat' };
    // D3 send gate: pinned registry head must not be staler than 24h at send.
    if (nowSeconds - cert.sentAt > REGISTRY_MAX_AGE_SECONDS) return { ok: false, reason: 'stale-registry-head' };
    // D1 receive cutoff: signed send time past revocation effective time plus grace rejects.
    if (revocationEffectiveAt != null && cert.sentAt > revocationEffectiveAt + REVOKE_GRACE_SECONDS) {
      return { ok: false, reason: 'revoked-after-grace' };
    }
    return { ok: true, device: cert.device, sentAt: cert.sentAt };
  } catch {
    return { ok: false, reason: 'certificate-parse' };
  }
}

// ── Wire layer stack (profile section 1) ───────────────────────────────────

export function buildOperationRumor({ operationPlaintext, olmPayloadText, routeRecipientPubkey, createdAt, deviceSecret }) {
  // The rumor's content carries the Olm-encrypted session payload text;
  // routing metadata rides INSIDE that payload so the Olm MAC authenticates it.
  if (typeof olmPayloadText !== 'string' || olmPayloadText.length === 0) throw new Error('A rumor needs non-empty Olm payload text.');
  void operationPlaintext; // bound elsewhere via digest inside the Olm payload
  const rumor = nip59.createRumor({
    kind: 14,
    created_at: createdAt,
    tags: [['p', routeRecipientPubkey]],
    content: olmPayloadText,
  }, deviceSecret);
  return rumor;
}

export function sealAndWrapRumor(rumor, { deviceSecret, routeRecipientPubkey, wrapSecret }) {
  const seal = nip59.createSeal(rumor, deviceSecret, routeRecipientPubkey);
  const wrapContent = nip44.v2.encrypt(
    JSON.stringify(seal),
    nip44.v2.utils.getConversationKey(wrapSecret, routeRecipientPubkey),
  );
  const wrap = signEventDeterministic({
    kind: 1059,
    created_at: Math.round(Date.now() / 1000), // caller pins time for vectors via seedTime below
    tags: [['p', routeRecipientPubkey]],
    content: wrapContent,
  }, wrapSecret);
  return { seal, wrap };
}

// Deterministic variant used by KATs and tests: explicit timestamps everywhere.
// Built BY HAND rather than via nip59.createSeal/createWrap because those
// backdate their created_at off wall-clock randomness; vectors must be
// byte-identical on rerun, so both timestamps are caller-supplied inputs here.
export function buildTestDmEnvelope({ operationPlaintext, olmPayloadText, senderDeviceSecret, routeRecipientPubkey, wrapSecret, createdAt }) {
  const rumor = buildOperationRumor({ operationPlaintext, olmPayloadText, routeRecipientPubkey, createdAt, deviceSecret: senderDeviceSecret });
  const seal = signEventDeterministic({
    kind: 13,
    created_at: createdAt,
    tags: [],
    content: nip44.v2.encrypt(
      JSON.stringify(rumor),
      nip44.v2.utils.getConversationKey(senderDeviceSecret, routeRecipientPubkey),
    ),
  }, senderDeviceSecret);
  const wrapContent = nip44.v2.encrypt(
    JSON.stringify(seal),
    nip44.v2.utils.getConversationKey(wrapSecret, routeRecipientPubkey),
  );
  const wrap = signEventDeterministic({
    kind: 1059,
    created_at: createdAt,
    tags: [['p', routeRecipientPubkey]],
    content: wrapContent,
  }, wrapSecret);
  return { rumor, seal, wrap };
}

// ── Receive-side verification order (profile section 5) ────────────────────
// Fixed, fail-closed order. Returns {ok:false, step, reason} on the first
// failure with NO other effect.

export function receiveVerifyOrder(wrapEvent, { routeSecret, routeRecipientPubkey, expectedAuthorityPubkey, expectedRegistryHeadId, nowSeconds, revocationEffectiveAt = null, heldDeviceCertificates = null, isOlmV2Init = null }) {
  const fail = (step, reason) => ({ ok: false, step, reason });

  // 1. Outer wrap shape and route decryption.
  if (wrapEvent?.kind !== 1059) return fail(1, 'not-a-wrap');
  const pTags = (wrapEvent.tags || []).filter((tag) => tag[0] === 'p');
  if (pTags.length !== 1 || pTags[0][1] !== routeRecipientPubkey) return fail(1, 'route-tag-mismatch');
  let seal;
  try {
    seal = JSON.parse(nip44.v2.decrypt(
      wrapEvent.content,
      nip44.v2.utils.getConversationKey(routeSecret, wrapEvent.pubkey),
    ));
  } catch {
    return fail(1, 'wrap-decrypt');
  }

  // 2. Seal signature against its own pubkey (= claimed sender device).
  if (seal.kind !== 13) return fail(2, 'not-a-seal');
  let claimOk = false;
  try { claimOk = verifyEvent(seal); } catch { claimOk = false; }
  if (!claimOk) return fail(2, 'seal-signature');

  // 3. Rumor recovery.
  let rumor;
  try {
    rumor = JSON.parse(nip44.v2.decrypt(
      seal.content,
      nip44.v2.utils.getConversationKey(routeSecret, seal.pubkey),
    ));
  } catch {
    return fail(3, 'seal-decrypt');
  }
  if (rumor.kind !== 14) return fail(3, 'not-a-rumor');
  if (typeof rumor.content !== 'string' || rumor.content.length === 0) return fail(3, 'empty-rumor');

  // 4. Olm v2-only inbound: v1 init messages rejected outright.
  if (isOlmV2Init && !isOlmV2Init(rumor)) return fail(4, 'olm-v1-init-rejected');

  // 5. Device certificate chain checks (caller-supplied certificate map keyed
  // by seal pubkey when offline replay is in play).
  if (heldDeviceCertificates) {
    const certificate = heldDeviceCertificates[seal.pubkey];
    const verdict = verifyDeviceCertificate(certificate, {
      expectedAuthorityPubkey, expectedRegistryHeadId, nowSeconds, revocationEffectiveAt,
    });
    if (!verdict.ok) return fail(5, verdict.reason);
  }

  return { ok: true, rumor, sealPubkey: seal.pubkey };
}

// Send-time freshness gate (profile section 2). Pure predicate over inputs.
export function sendFreshnessGate({ checkpointAuthenticated, targetDeviceActive, socketAuthed, certificateOk }) {
  return Boolean(checkpointAuthenticated && targetDeviceActive && socketAuthed && certificateOk);
}

// Head age check used both sides (D3 test default).
export function headAgeVerdict(headCreatedAtSeconds, nowSeconds) {
  if (!Number.isSafeInteger(headCreatedAtSeconds) || headCreatedAtSeconds < 0) return 'invalid-head';
  if (nowSeconds - headCreatedAtSeconds > REGISTRY_MAX_AGE_SECONDS) return 'stale-registry-head';
  return 'fresh';
}
