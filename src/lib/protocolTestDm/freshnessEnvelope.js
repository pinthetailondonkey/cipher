// Freshness envelope for retry-after-expiry redelivery (TEST-PATH-ONLY,
// src/lib/protocolTestDm/freshnessEnvelope.js).
//
// Implements docs/DM-TEST-PROFILE-V1.md section 8: the canonical
// `freshnessEnvelope` carried INSIDE the Olm-encrypted payload of a
// redelivered operation. The envelope is authenticated by the Olm MAC
// (it rides inside the MAC'd plaintext) and bound by recomputing the
// operation digest per section 3; there is NO separate kind 13-sealed
// event for it (that shape was considered and rejected as out of scope).
//
// Frozen envelope shape (section 8, canonical, JCS-encoded):
//   {
//     v: 1,                              // NOTE presented canonically:
//     opId,                              //   serialized key order is the JCS
//     opDigestHex,                       //   sort (boundTarget first); see
//     issuedAt,                          //   buildFreshnessEnvelope below.
//     notAfter,
//     boundTarget: { senderDeviceId, recipientRoutePubkey },
//   }
//
// Fail-closed rules: non-safe-integer timestamps and non-hex64 digests
// reject with reason 'envelope-shape'; an envelope object whose key
// insertion order is not the JCS sort is likewise refused (it would not
// reproduce its own canonical bytes). Verification returns ONE of the
// stable reasons: 'envelope-shape' | 'digest-mismatch' |
// 'target-mismatch' | 'envelope-expired'.

import { jcsEncode } from './protocolTestDmWire.js';
import { sha256Hex } from './protocolTestDmOperations.js';

export const FRESHNESS_ENVELOPE_VERSION = 1;

const HEX64 = /^[0-9a-f]{64}$/;

const isSafeNonNegativeInt = (value) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

function keysAreJcsSorted(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return true;
  const keys = Object.keys(value);
  for (let i = 1; i < keys.length; i += 1) {
    if (!(keys[i - 1] < keys[i])) return false;
  }
  return keys.every((key) => keysAreJcsSorted(value[key]));
}

// Key order note: an envelope must PRESENT canonically. The builder emits
// keys already in the JCS sort (boundTarget, issuedAt, notAfter,
// opDigestHex, opId; boundTarget inner: recipientRoutePubkey,
// senderDeviceId) so its own output passes verifyFreshnessEnvelope without
// reordering, and a parsed envelope whose key order is not the JCS sort is
// refused as non-canonical.
export function buildFreshnessEnvelope({
  opId, opDigestHex, issuedAt, notAfter, senderDeviceId, recipientRoutePubkey,
}) {
  if (typeof opId !== 'string' || opId.length === 0) throw new Error('Freshness envelope needs a non-empty opId.');
  if (!HEX64.test(opDigestHex || '')) throw new Error('Freshness envelope needs a 64-hex operation digest.');
  if (!isSafeNonNegativeInt(issuedAt)) throw new Error('Freshness envelope issuedAt must be a safe non-negative integer.');
  if (!isSafeNonNegativeInt(notAfter)) throw new Error('Freshness envelope notAfter must be a safe non-negative integer.');
  if (notAfter < issuedAt) throw new Error('Freshness envelope notAfter must not precede issuedAt.');
  if (typeof senderDeviceId !== 'string' || senderDeviceId.length === 0) throw new Error('Freshness envelope needs a senderDeviceId.');
  if (typeof recipientRoutePubkey !== 'string' || recipientRoutePubkey.length === 0) throw new Error('Freshness envelope needs a recipientRoutePubkey.');
  return {
    boundTarget: { recipientRoutePubkey, senderDeviceId },
    issuedAt,
    notAfter,
    opDigestHex,
    opId,
    v: FRESHNESS_ENVELOPE_VERSION,
  };
}

export function verifyFreshnessEnvelope(envelope, {
  expectedOpDigestHex,
  expectedOpId,
  expectedSenderDeviceId,
  expectedRecipientRoutePubkey,
  nowSeconds,
}) {
  const shapeFail = () => ({ ok: false, reason: 'envelope-shape' });
  try {
    if (envelope == null || typeof envelope !== 'object' || Array.isArray(envelope)) return shapeFail();
    if (!keysAreJcsSorted(envelope)) return shapeFail(); // non-canonical input refused
    if (envelope.v !== FRESHNESS_ENVELOPE_VERSION) return shapeFail();
    if (typeof envelope.opId !== 'string' || envelope.opId.length === 0) return shapeFail();
    if (typeof envelope.opDigestHex !== 'string' || !HEX64.test(envelope.opDigestHex)) return shapeFail();
    if (!isSafeNonNegativeInt(envelope.issuedAt)) return shapeFail();
    if (!isSafeNonNegativeInt(envelope.notAfter)) return shapeFail();
    if (envelope.notAfter < envelope.issuedAt) return shapeFail();
    const target = envelope.boundTarget;
    if (target == null || typeof target !== 'object' || Array.isArray(target)) return shapeFail();
    if (typeof target.senderDeviceId !== 'string' || target.senderDeviceId.length === 0) return shapeFail();
    if (typeof target.recipientRoutePubkey !== 'string' || target.recipientRoutePubkey.length === 0) return shapeFail();
    if (Object.keys(target).length !== 2) return shapeFail();
    if (!Number.isSafeInteger(nowSeconds)) return shapeFail();
    if (!HEX64.test(expectedOpDigestHex || '')) return shapeFail();

    if (envelope.opId !== expectedOpId) return { ok: false, reason: 'digest-mismatch' };
    if (envelope.opDigestHex !== expectedOpDigestHex) return { ok: false, reason: 'digest-mismatch' };
    if (target.senderDeviceId !== expectedSenderDeviceId
      || target.recipientRoutePubkey !== expectedRecipientRoutePubkey) {
      return { ok: false, reason: 'target-mismatch' };
    }
    // Boundary semantics: notAfter == now is STILL VALID; strictly earlier expires.
    if (envelope.notAfter < nowSeconds) return { ok: false, reason: 'envelope-expired' };
    return { ok: true, reason: null, canonicalBytes: jcsEncode(envelope), envelopeSha256Hex: sha256Hex(Buffer.from(jcsEncode(envelope), 'utf8')) };
  } catch {
    return shapeFail();
  }
}
