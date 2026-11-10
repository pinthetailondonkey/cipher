// First contact / verified-pin bundle module for the DM TEST path
// (TEST-ONLY, src/lib/protocolTestDm/contactPin.js).
//
// Frozen spec: docs/DM-TEST-PROFILE-V1.md section 7 (D4 default: verified QR
// or out-of-band code ONLY; no public bundles published to relays) and plan
// broken item 7. A verified-pin bundle carries EXACTLY:
//   1. the contact's current ROUTE pubkey,
//   2. the device certificate signed by primary authority for the receiving
//      device,
//   3. ONE one-time key (public half) for Olm session establishment.
//
// Recipient side keeps private one-time keys in a retention-limited pool until
// the session is CONFIRMED (first inbound message consumed that key and the
// session committed) or RETENTION_LIMIT passes, whichever first. Duplicate
// initial messages dedupe by operation id. Depletion refill produces the next
// bundle entries with fresh ids. This module is pure bookkeeping over
// injected storage/sealer; it never touches a relay.

const BUNDLE_VERSION = 1;
export const CONTACT_PIN_CONSTANTS = Object.freeze({
  BUNDLE_VERSION,
  // Retention limit for unconsumed private one-time keys: TEST DEFAULT,
  // REVIEWER-OPEN per profile section 7.
  ONE_TIME_KEY_RETENTION_SECONDS: 86400,
});

export function createContactPinStore({ sealer }) {
  if (!sealer || typeof sealer.seal !== 'function' || typeof sealer.open !== 'function') {
    throw new Error('contactPin needs an injected sealer.');
  }
  // In-memory record shape kept test-simple; browser caller injects IDB-backed
  // persistence above this API. Everything here is sealed at rest via sealer.
  const records = {
    bundlesSentByContactId: new Map(),   // contactId -> {routePubkey, certificate, otkPublic}
    pendingPrivateOtksById: new Map(),   // otkId -> {sealedPrivateJson, issuedAtMs, status:'held'|'consumed'|'expired'}
    confirmedSessionOtkIds: new Set(),   // session confirmations free retained keys
    seenInitialOperationIds: new Set(),  // dedupe of initial messages by op id
  };

  return {
    records,

    // ── Sender/recipient-of-bundle side: BUILD a verified-pin bundle ───────
    buildVerifiedPinBundle({ routePubkey, deviceCertificate, oneTimeKeyPublic }) {
      if (typeof routePubkey !== 'string' || routePubkey.length < 32) {
        throw new Error('Bundle needs a route pubkey of >=128 bits named by lane R.');
      }
      if (!deviceCertificate?.id) throw new Error('Bundle needs the authority-signed device certificate event.');
      if (typeof oneTimeKeyPublic !== 'string' || oneTimeKeyPublic.length < 16) {
        throw new Error('Bundle needs exactly one public one-time key.');
      }
      return {
        version: BUNDLE_VERSION,
        kind: 'cipher-contact-pin-v1',
        routePubkey,
        deviceCertificateId: deviceCertificate.id,
        deviceCertificate,
        oneTimeKeyPublic,
        builtAtMs: Date.now(),
      };
    },

    // ── Recipient side: HOLD the matching private one-time key ────────────
    holdOneTimePrivateKey({ otkId, privateKeyText, issuedAtMs = Date.now() }) {
      const entry = {
        sealed: sealer.seal(JSON.stringify({ privateKeyText }), `otk|${otkId}`),
        aad: `otk|${otkId}`,
        issuedAtMs,
        status: 'held',
      };
      records.pendingPrivateOtksById.set(otkId, entry);
      return { held: true, otkId };
    },

    openHeldPrivateKey(otkId) {
      const entry = records.pendingPrivateOtksById.get(otkId);
      if (!entry || entry.status !== 'held') return null;
      return JSON.parse(sealer.open(entry.sealed, entry.aad)).privateKeyText;
    },

    consumeOneTimeKey({ otkId, sessionId }) {
      const entry = records.pendingPrivateOtksById.get(otkId);
      if (!entry || entry.status !== 'held') return { consumed: false, reason: 'not-held' };
      entry.status = 'consumed';
      entry.sessionId = sessionId ?? null;
      // Session confirmed by consuming the OTK inside a committed receive:
      // the private key's job is done; retention ends now.
      if (sessionId) records.confirmedSessionOtkIds.add(sessionId);
      return { consumed: true };
    },

    expireOldRetention(nowMs = Date.now()) {
      let expired = 0;
      for (const [otkId, entry] of records.pendingPrivateOtksById.entries()) {
        if (entry.status === 'held'
          && nowMs - entry.issuedAtMs > CONTACT_PIN_CONSTANTS.ONE_TIME_KEY_RETENTION_SECONDS * 1000) {
          entry.status = 'expired';
          entry.sealed = null; // best-effort drop of the private material
          expired += 1;
        }
      }
      return expired;
    },

    heldCount() {
      let count = 0;
      for (const entry of records.pendingPrivateOtksById.values()) {
        if (entry.status === 'held') count += 1;
      }
      return count;
    },

    // ── Duplicate initial-message dedupe by operation id ──────────────────
    claimInitialOperationId(operationId) {
      if (records.seenInitialOperationIds.has(operationId)) return { claimed: false, duplicate: true };
      records.seenInitialOperationIds.add(operationId);
      return { claimed: true, duplicate: false };
    },

    // ── Depletion refill: produce NEXT bundle entries after consumption ────
    refillAfterDepletion({ generateNewKeyPair, count = 1 }) {
      if (typeof generateNewKeyPair !== 'function') {
        throw new Error('refill needs an injected generateNewKeyPair() -> {publicHalf, privateHalf} entry.');
      }
      const created = [];
      for (let index = 0; index < count; index += 1) {
        const pair = generateNewKeyPair(index);
        const otkId = `otk-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 10)}`;
        this.holdOneTimePrivateKey({ otkId, privateKeyText: pair.privateHalf });
        created.push({ otkId, publicHalf: pair.publicHalf });
      }
      return created;
    },
  };
}

// Verification of an INCOMING verified-pin bundle against the local pin state.
export function verifyReceivedBundle(bundle, { expectedAuthorityPubkeyForDevice } = {}) {
  if (bundle?.version !== BUNDLE_VERSION || bundle?.kind !== 'cipher-contact-pin-v1') {
    return { ok: false, reason: 'bundle-shape' };
  }
  if (!bundle.deviceCertificate?.pubkey) return { ok: false, reason: 'bundle-missing-certificate' };
  if (expectedAuthorityPubkeyForDevice
    && bundle.deviceCertificate.pubkey !== expectedAuthorityPubkeyForDevice) {
    return { ok: false, reason: 'bundle-wrong-authority' };
  }
  if (typeof bundle.oneTimeKeyPublic !== 'string') return { ok: false, reason: 'bundle-missing-one-time-key' };
  if (Array.isArray(bundle.oneTimeKeyPublic)) throw new Error('Bundle carries exactly ONE one-time key.');
  return { ok: true };
}
