// Colocated focused test for src/lib/protocolTestDm/contactPin.js
// (TEST-PATH-ONLY). Proves: bundle carries exactly one route pubkey +
// certificate + ONE one-time key, sealed private retention with session
// confirmation and retention limit expiry, duplicate initial-message dedupe,
// and depletion refill producing next entries.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTACT_PIN_CONSTANTS, createContactPinStore, verifyReceivedBundle } from './contactPin.js';

const passthroughSealer = {
  seal: (plaintext, aad) => Buffer.from(`P:${aad}:${plaintext}`).toString('base64'),
  open: (ciphertext, _aad) => {
    const decoded = Buffer.from(ciphertext, 'base64').toString('utf8');
    if (!decoded.startsWith('P:')) throw new Error('tampered');
    return decoded.split(':').slice(2).join(':');
  },
};

function makeCertificateStub(pubkeyHex = '9'.repeat(64)) {
  return { id: `cert-${pubkeyHex.slice(0, 8)}`, pubkey: pubkeyHex };
}

test('bundle carries exactly the three frozen fields', () => {
  const store = createContactPinStore({ sealer: passthroughSealer });
  const certificate = makeCertificateStub();
  const bundle = store.buildVerifiedPinBundle({
    routePubkey: 'route:v1:' + 'ab'.repeat(16),
    deviceCertificate: certificate,
    oneTimeKeyPublic: 'OTKPUBKEY-123456',
  });
  assert.equal(bundle.kind, 'cipher-contact-pin-v1');
  assert.equal(Object.keys(bundle).filter((key) => ['routePubkey', 'deviceCertificate', 'oneTimeKeyPublic'].includes(key)).length, 3);
});

test('bundle construction refuses missing or weak fields', () => {
  const store = createContactPinStore({ sealer: passthroughSealer });
  assert.throws(() => store.buildVerifiedPinBundle({ deviceCertificate: {}, oneTimeKeyPublic: 'x'.repeat(20) }), /route pubkey/);
  assert.throws(() => store.buildVerifiedPinBundle({ routePubkey: 'route:v1:' + 'a'.repeat(32), deviceCertificate: {}, oneTimeKeyPublic: 'x'.repeat(20) }), /certificate/);
  assert.throws(() => store.buildVerifiedPinBundle({ routePubkey: 'route:v1:' + 'a'.repeat(32), deviceCertificate: makeCertificateStub(), oneTimeKeyPublic: '' }), /one-time key/);
});

test('private one-time keys stay held until the session is confirmed', () => {
  const store = createContactPinStore({ sealer: passthroughSealer });
  store.holdOneTimePrivateKey({ otkId: 'otk-1', privateKeyText: 'PRIVATE-A' });
  assert.equal(store.openHeldPrivateKey('otk-1'), 'PRIVATE-A');
  const refused = store.consumeOneTimeKey({ otkId: 'otk-missing' });
  assert.deepEqual(refused, { consumed: false, reason: 'not-held' });
  const consumed = store.consumeOneTimeKey({ otkId: 'otk-1', sessionId: 'sess-77' });
  assert.equal(consumed.consumed, true);
  // After confirmation the private material is no longer handed out.
  assert.equal(store.openHeldPrivateKey('otk-1'), null);
  assert.ok(store.records.confirmedSessionOtkIds.has('sess-77'));
});

test('retention limit expires still-held keys (TEST DEFAULT 24h, REVIEWER-OPEN)', async () => {
  const store = createContactPinStore({ sealer: passthroughSealer });
  const issuedAtMs = 1000;
  store.holdOneTimePrivateKey({ otkId: 'otk-old', privateKeyText: 'PRIVATE-B', issuedAtMs });
  assert.equal(store.expireOldRetention(issuedAtMs + CONTACT_PIN_CONSTANTS.ONE_TIME_KEY_RETENTION_SECONDS * 1000), 0,
    'exactly at the boundary the key is still retained');
  assert.equal(store.expireOldRetention(issuedAtMs + CONTACT_PIN_CONSTANTS.ONE_TIME_KEY_RETENTION_SECONDS * 1000 + 1), 1,
    'one ms past the boundary retention releases it');
  assert.equal(await Promise.resolve(store.records.pendingPrivateOtksById.get('otk-old').sealed), null,
    'expired entry drops its private material best-effort');
  assert.equal(store.openHeldPrivateKey('otk-old'), null);
});

test('duplicate initial messages dedupe by operation id', () => {
  const store = createContactPinStore({ sealer: passthroughSealer });
  const first = store.claimInitialOperationId('op-first-contact');
  assert.deepEqual(first, { claimed: true, duplicate: false });
  const second = store.claimInitialOperationId('op-first-contact');
  assert.deepEqual(second, { claimed: false, duplicate: true });
});

test('depletion refill produces fresh held entries after consumption', () => {
  const store = createContactPinStore({ sealer: passthroughSealer });
  let serial = 0;
  const refill = store.refillAfterDepletion({
    generateNewKeyPair: () => ({ publicHalf: `PUB-${serial}`, privateHalf: `PRIV-${serial++}` }),
    count: 2,
  });
  assert.equal(refill.length, 2);
  assert.notEqual(refill[0].otkId, refill[1].otkId);
  assert.equal(store.heldCount(), 2);
  assert.equal(store.openHeldPrivateKey(refill[1].otkId), 'PRIV-1');
  // Consume one; a further refill restores the pool.
  store.consumeOneTimeKey({ otkId: refill[0].otkId, sessionId: 'sess-r2' });
  assert.equal(store.heldCount(), 1);
});

test('received bundle verification fails closed on shape/authority problems', () => {
  const authorityPubkey = 'c'.repeat(64);
  assert.equal(verifyReceivedBundle(null).ok, false);
  assert.equal(verifyReceivedBundle({ version: 99 }).reason, 'bundle-shape');
  assert.equal(
    verifyReceivedBundle({
      version: 1, kind: 'cipher-contact-pin-v1', oneTimeKeyPublic: 'K',
      deviceCertificate: { pubkey: 'd'.repeat(64) },
    }, { expectedAuthorityPubkeyForDevice: authorityPubkey }).reason,
    'bundle-wrong-authority',
  );
  assert.equal(
    verifyReceivedBundle({
      version: 1, kind: 'cipher-contact-pin-v1',
      deviceCertificate: { pubkey: authorityPubkey },
    }).reason,
    'bundle-missing-one-time-key',
  );
});
