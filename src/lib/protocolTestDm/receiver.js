// Receive path for the DM TEST profile (TEST-ONLY,
// src/lib/protocolTestDm/receiver.js).
//
// Implements the FROZEN receive order of docs/DM-TEST-PROFILE-V1.md section 5
// on top of the frozen helpers in protocolTestDmOperations.js:
//
//   steps 1-5 (wrap shape, seal signature, rumor, olm-version gate, device
//   certificate chain): delegated to receiveVerifyOrder() exactly as frozen.
//   step 6: revocation cutoff via verifyDeviceCertificate's D1 grace check
//           (applied inside the certificate verdict above with nowSeconds).
//   step 7: ratchet decrypt on a CLONE of session state; commit state +
//           inbound journal ATOMICALLY through SealedSessionStore.apply ONLY
//           after steps 8-10 pass.
//   step 8: plaintext binding: recomputed operation digest == digest bound in
//           the recovered payload (DMV1-002 family).
//   step 9: dedupe by (senderDeviceId, operationId) compared BY DIGEST:
//           duplicate => no state advance; conflict => reject preserving prior.
//   step 10: application effect dispatch, exactly once, AFTER the commit.
//
// v1 init messages are rejected explicitly at step 4. No production messaging
// path is touched.

import {
  REVOKE_GRACE_SECONDS,
  dedupeKeyDigest,
  operationDigest,
  receiveVerifyOrder,
} from './protocolTestDmOperations.js';
import { verifyFreshnessEnvelope } from './freshnessEnvelope.js';

export function createTestReceiver({
  routeSecret, // Uint8Array/hex secret for the locally held route key
  routeRecipientPubkey,
  expectedAuthorityPubkey,
  pinnedRegistryHeadId,
  revocationEffectiveAt = null, // seconds or null
  certificatesByDevice = null, // map devicePubkey -> certificate event
  deviceStatusAtHead, // (devicePubkey) => {known, active}
  store, // SealedSessionStore instance (module 1)
  decryptOnClone, // async ({clonedSessionOrAccount, rumorContent}) => {operationPlaintextText, boundDigest, sessionId, advancedClonedStatePickle, messageKind:'prekey'|'normal', olmVersion}
  applyOperationPlaintextBinding, // (recoveredPayloadObject, claimedDigestHex) => 'ok'|'mismatch'
  onApplicationEffect = null, // async (effect) => void; dispatched exactly once post-commit
  verifyFreshnessForRedelivery = null, // (freshnessEnvelope, {computedDigestHex, senderDeviceId, recipientRoutePubkey, nowSeconds}) => {ok, reason} per profile section 8
}) {
  const journalSeen = new Map(); // dedupeTupleKey -> digest

  function fail(result) {
    return result;
  }

  async function receive(wrapEvent, { nowSeconds } = {}) {
    if (!(typeof nowSeconds === 'number')) throw new Error('receive needs nowSeconds.');
    if (!store || typeof store.apply !== 'function') throw new Error('receiver needs a sealed session store.');

    // ── Steps 1-5: frozen wire verification order ───────────────────────
    const status = deviceStatusAtHead ?? (() => ({ known: true, active: true }));
    const wire = receiveVerifyOrder(wrapEvent, {
      routeSecret,
      routeRecipientPubkey,
      expectedAuthorityPubkey,
      expectedRegistryHeadId: pinnedRegistryHeadId,
      nowSeconds,
      revocationEffectiveAt,
      heldDeviceCertificates: certificatesByDevice
        ? buildCertificateLookup(certificatesByDevice)
        : null,
      isOlmV2Init: (rumor) => {
        try {
          return JSON.parse(rumor.content).olmVersion === 2;
        } catch { return false; }
      },
    });
    if (!wire.ok) {
      return fail({ accepted: false, step: wire.step, reason: wire.reason });
    }
    const senderDevicePubkey = wire.sealPubkey;

    // Target-device-active-at-head check (step 5 continuation): the receiving
    // device knows its own enrollment; the SENDER device must be active at the
    // cited head per the profile's step 5 wording for new-session acceptance.
    const senderStatus = status(senderDevicePubkey);
    if (!senderStatus.known) return fail({ accepted: false, step: 5, reason: 'sender-device-unknown-at-head' });
    if (!senderStatus.active) return fail({ accepted: false, step: 5, reason: 'sender-device-inactive-at-head' });

    // Step 6: revocation cutoff lives inside verifyDeviceCertificate via
    // revocationEffectiveAt + REVOKE_GRACE_SECONDS. When the caller supplies a
    // stored send time (from the payload) re-check it here explicitly.
    const payload = safeParse(wire.rumor.content);
    if (payload == null) return fail({ accepted: false, step: 7, reason: 'payload-unparseable' });
    if (revocationEffectiveAt != null && Number.isSafeInteger(payload.authoritySendTime)) {
      if (payload.authoritySendTime > revocationEffectiveAt + REVOKE_GRACE_SECONDS) {
        return fail({ accepted: false, step: 6, reason: 'revoked-after-grace' });
      }
    }

    // ── Steps 7-9: decrypt ON A CLONE, then binding + dedupe before commit ──
    let decrypted;
    try {
      decrypted = await decryptOnClone({
        rumorContent: wire.rumor.content,
        payload,
      });
    } catch (error) {
      return fail({ accepted: false, step: 7, reason: `ratchet-decrypt:${error?.message ?? String(error)}` });
    }

    // Step 8: plaintext binding.
    const binding = applyOperationPlaintextBinding(
      JSON.parse(decrypted.plaintext), decrypted.boundDigest,
    );
    if (binding !== 'ok') {
      return fail({ accepted: false, step: 8, reason: `plaintext-binding-${binding}` });
    }

    // Recompute the operation digest from recovered plaintext independently.
    const recoveredPayload = safeParse(decrypted.plaintext);
    const opObject = recoveredPayload?.operation ?? recoveredPayload;
    const computedDigest = operationDigest(opObject);
    if (computedDigest !== decrypted.operationDigestClaimed) {
      return fail({ accepted: false, step: 8, reason: 'digest-mismatch' });
    }

    // Step 9: dedupe by (senderDeviceId, operationId) COMPARED BY DIGEST.
    // Journal stores BOTH digests: dedupeTupleDigest identifies the tuple;
    // operationContentDigest catches an envelope mutated while claiming the
    // same operation id (semantic vector DMV1-009).
    const tupleKey = `${senderDevicePubkey}:${decrypted.operationId}`;
    const candidateTupleDigest = dedupeKeyDigest(senderDevicePubkey, decrypted.operationId);
    const priorEntry = journalSeen.get(tupleKey)
      ?? await store.getInboundJournalEntry(senderDevicePubkey, decrypted.operationId)
      ?? null;
    if (priorEntry != null && priorEntry.dedupeDigest === candidateTupleDigest) {
      const priorOperationDigest = priorEntry.operationContentDigest ?? null;
      if (priorOperationDigest === computedDigest) {
        // Profile section 8: when the redelivered payload carries a
        // freshnessEnvelope field, it must verify before duplicate
        // suppression. Without the envelope field the behavior is exactly
        // the pre-envelope duplicate-suppressed path (no change). A present
        // but invalid envelope rejects the redelivery at step 9.
        if (recoveredPayload?.freshnessEnvelope != null) {
          const freshnessContext = {
            computedDigestHex: computedDigest,
            senderDeviceId: senderDevicePubkey,
            recipientRoutePubkey: routeRecipientPubkey,
            nowSeconds,
          };
          const freshness = typeof verifyFreshnessForRedelivery === 'function'
            ? verifyFreshnessForRedelivery(recoveredPayload.freshnessEnvelope, freshnessContext)
            : verifyFreshnessEnvelope(recoveredPayload.freshnessEnvelope, {
              expectedOpDigestHex: computedDigest,
              expectedOpId: decrypted.operationId,
              expectedSenderDeviceId: senderDevicePubkey,
              expectedRecipientRoutePubkey: routeRecipientPubkey,
              nowSeconds,
            });
          if (!freshness.ok) {
            return fail({ accepted: false, step: 9, reason: 'redelivery-freshness-rejected', detail: freshness.reason });
          }
        }
        // Duplicate: effect dispatched ONCE from the prior commit is not
        // repeated and the ratchet does NOT advance again.
        return fail({ accepted: true, duplicate: true, step: 9, reason: 'duplicate-suppressed' });
      }
      return fail({ accepted: false, step: 9, reason: 'dedupe-conflict-different-digest' });
    }

    // Step 7+9 combined commit: advanced CLONE state becomes the durable state,
    // committed together with the inbound journal row atomically.
    await store.apply({
      sessionMutation: {
        sessionId: decrypted.sessionId,
        state: {
          version: 1, sessionId: decrypted.sessionId,
          senderDeviceId: senderDevicePubkey,
          pickledRatchetState: decrypted.advancedClonedStatePickle,
          lastOperationId: decrypted.operationId,
        },
      },
      inboundJournalEntry: {
        senderDeviceId: senderDevicePubkey,
        operationId: decrypted.operationId,
        dedupeDigest: candidateTupleDigest,
        operationContentDigest: computedDigest,
        appliedEffectPayload: recoveredPayload?.body ?? null,
      },
    }, { label: `receive:${decrypted.operationId}` });
    journalSeen.set(tupleKey, { dedupeDigest: candidateTupleDigest, operationContentDigest: computedDigest });

    // Step 10: application effect EXACTLY ONCE, after commit.
    let effectResult = null;
    if (onApplicationEffect) {
      effectResult = await onApplicationEffect({
        senderDeviceId: senderDevicePubkey,
        operationId: decrypted.operationId,
        body: recoveredPayload?.body ?? null,
        // App-lane dispatch needs both account identities for chat keying:
        // fromDevice files the inbound message under the sender's account,
        // toDevice confirms direction.
        fromDevicePubkey: opObject?.fromDevice ?? null,
        toDevicePubkey: opObject?.toDevice ?? null,
      });
    }
    return {
      accepted: true, duplicate: false, step: 10, reason: null,
      sessionId: decrypted.sessionId,
      effectResult,
    };
  }

  return { receive };
}

function safeParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function buildCertificateLookup(map) {
  // receiveVerifyOrder expects a lookup keyed by SEAL pubkey (= device).
  return new Proxy({}, {
    get: (_target, prop) => (typeof prop === 'string' ? map[prop] ?? null : undefined),
  });
}
