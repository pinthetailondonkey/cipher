import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeEvent } from 'nostr-tools';
import {
  MEMBER_DOC_KIND,
  memberDocTag,
  buildMemberDocEvent,
  sealDocBody,
  openSealedDocBody,
  rememberVerifiedDoc,
  loadMemberDocHeads,
  ingestMemberDocEvent,
  __setDocsDbForTests,
} from './groupDocWire.js';
import { signDocEvent, genesisDocBody, applyDocOps, authorityPinOf } from './groupDoc.js';

const GID = 'wire-test-group'.padEnd(64, '0');
const SK = new Uint8Array(32).fill(21);
// The pin IS the authority key's compressed pubkey: doc signatures verify
// against it. Tests that fake a pin at random never verify (witnessed in the
// rememberVerifiedDoc case below via the foreign-key check).
const PIN = authorityPinOf(SK);
// SEC-1: the remediation's per-group secret, as if minted at genesis and held.
const DOC_KEY = new Uint8Array(32).fill(77);

// Fixed fixture produced with src/lib/crypto/groupDocWire.js from parent
// commit 040fda9. Its v2 AAD is cipher-gmemdoc-v2|<gid> (without the pin).
const LEGACY_V2 = {
  gid: 'legacy-v2-compatibility-audit'.padEnd(64, '0'),
  pin: '03d793631af7aa0e709439dd47fc001acd0b0727670b6670ea528ac83cb0127f4a',
  signed: {
    id: '1bab24caafc7c2997523432c438bb81e533ff015d7486c7a54b78726e961591b',
    body: {
      v: 2, t: 'gmemdoc',
      gid: 'legacy-v2-compatibility-audit'.padEnd(64, '0'),
      gen: 0, epoch: 7, parents: [],
      members: [{ pubkey: '0'.repeat(62) + 'aa', role: 'member', gen: 0 }],
      removed: [],
    },
    at: 1793999876,
    sig: 'dfbe52c2eee64a2a81a7302ed1205f50de9984d272aef9a3c58fdcd151c403a224e41d23c6023b5a1cc3846a7efc7a11c2362a4d386275475527821746821f02',
  },
  envelope: '{"v":2,"iv":"3E7NpL2idcv10sRf","ct":"HIOyKUSux1da6IHPxfD32qUW8dcyn59o+M1MXnOrZtC3ceSBcpRiBMCFsUYFpzfFd1Spoc8UFaJvfExT2uCxs4TMMvPF/0D6biJEXzwkJkWnRwcaXQH1J7CS3yu7KejCW54hNBXwOOgWg3nPkqZzogBU17WGGPDJf+QanEW3Lh4xGHmk5Hj/GEb6rSY3mcWNg8fI+CO/IC06yReWJSZi5X69sLEO0HxnSepCclG6MooklPtaH08wbZOru/7NGSvbMkek9sGCgbKcT7SjDOmv5fNz61jYb4hM2SuTWQ8qWGsGZZlZeyyboYDJcnWfz514XTUnOp8AK0grLBlZ09OZGiDKG/2MGjr0sjkkQ7F7bOLzhfHFG/X6J3fOQaYVuehqOaoEntwOXs27kzYIaV+slFqlprRLiI3PumG/29EKRvAAnHwhF9jGzmJBLneI6y4HubnQsAGqxB5kWglSvhAuI4WLJbfQqwu4PxKH3iqCYoI8uFeXi8umnqrUKlsUinG2UiQ1rXoZJPQRMpFI3qBuKn40yxzdnuBJzO75nv3iCW3Je5sjQjq7YCzvX1ipmOOTrmzf1ANbIqvWZfDjsE+z2BVzR5sHYYlXSByxdpICmP6Tk+xoE+ZmmXS/XIzGVSw6ddSO1EK/"}',
};

function pad(n) { return String(n).padStart(64, String(n % 10)); }

// In-memory Dexie-shaped table for the store law (H4).
function fakeDocsTable() {
  const rows = new Map();
  return {
    async get(key) {
      const [groupId, gen, docId] = Array.isArray(key) ? key : [null, null, null];
      const found = [...rows.values()].find((row) => (
        row.groupId === groupId && row.gen === gen && (!docId || row.docId === docId)
      ));
      // A compound primary key get([g,g,d]) must match all three; a two-part
      // get([g,g]) matches the first row at that spot in real Dexie.
      return found ? { ...found } : undefined;
    },
    async put(row) {
      rows.set(`${row.groupId}|${row.gen}|${row.docId}`, { ...row });
    },
    where(field) {
      return {
        equals: (value) => ({
          toArray: async () => [...rows.values()].filter((row) => row[field] === value),
        }),
      };
    },
  };
}

test('doc event builds with the right kind/tag and seals its content', async () => {
  const body = await genesisDocBody({ gid: GID, epoch: 1, members: ['aa'.padStart(64, '0')] });
  const signed = await signDocEvent(body, SK);
  const event = await buildMemberDocEvent({
    signedDoc: signed, authoritySk: SK, pin: PIN, groupId: GID, createdAt: 1000, docKey: DOC_KEY,
  });
  assert.ok(event);
  assert.equal(JSON.parse(event.content).v, 2, 'every newly built event uses v2');
  assert.equal(event.kind, MEMBER_DOC_KIND);
  assert.equal(event.created_at, 1000);
  assert.deepEqual(event.tags.find((t) => t[0] === 'd'), ['d', memberDocTag(GID)]);
  // Content is a sealed envelope, not readable JSON of the body.
  assert.ok(!event.content.includes('"members"'));
});

test('new governance-document publication refuses a missing or malformed secret', async () => {
  const signed = await signDocEvent(
    await genesisDocBody({ gid: GID, epoch: 1, members: ['aa'.padStart(64, '0')] }),
    SK,
  );
  await assert.rejects(
    buildMemberDocEvent({ signedDoc: signed, authoritySk: SK, pin: PIN, groupId: GID, createdAt: 1000 }),
    /governance-doc key/i,
  );
  await assert.rejects(
    sealDocBody(signed, PIN, GID, new Uint8Array(31)),
    /governance-doc key/i,
  );
});

test('wrong pin or gid reads nothing; seal/open round-trips through the real one', async () => {
  const body = await genesisDocBody({ gid: GID, epoch: 1, members: ['bb'.padStart(64, '0')] });
  const signed = await signDocEvent(body, SK);
  const sealed = await sealDocBody(signed, PIN, GID, DOC_KEY);
  const opened = await openSealedDocBody(sealed, PIN, GID, DOC_KEY);
  assert.equal(opened.id, signed.id);
  assert.deepEqual(opened.body, signed.body);
  assert.equal(await openSealedDocBody(sealed, 'ee'.repeat(33), GID), null); // wrong pin
  assert.equal(await openSealedDocBody(sealed, PIN, 'other'), null); // wrong gid AAD
  assert.equal(await openSealedDocBody('not-json', PIN, GID), null);
  assert.equal(await openSealedDocBody(JSON.stringify({ v: 2 }), PIN, GID), null);
});

test('parent-commit v2 fixture decrypts with its original AAD and held key', async () => {
  assert.equal(LEGACY_V2.pin, PIN, 'fixture authority is the deterministic test authority');
  const opened = await openSealedDocBody(LEGACY_V2.envelope, LEGACY_V2.pin, LEGACY_V2.gid, DOC_KEY);
  assert.equal(opened?.id, LEGACY_V2.signed.id);
  assert.deepEqual(opened?.body, LEGACY_V2.signed.body);
  assert.equal(await openSealedDocBody(LEGACY_V2.envelope, LEGACY_V2.pin, LEGACY_V2.gid, new Uint8Array(32).fill(78)), null);
  assert.equal(await openSealedDocBody(LEGACY_V2.envelope, LEGACY_V2.pin, LEGACY_V2.gid), null);

  // Only public fields are available to this simulated observer. Even trying
  // the old public pin/gid-derived v1 material as a candidate v2 secret fails.
  const publicMaterial = new TextEncoder().encode(`cipher-gmemdoc-key-v1:${LEGACY_V2.pin}:${LEGACY_V2.gid}`);
  const publicDerivedCandidate = new Uint8Array(await crypto.subtle.digest('SHA-256', publicMaterial));
  assert.equal(await openSealedDocBody(LEGACY_V2.envelope, LEGACY_V2.pin, LEGACY_V2.gid, publicDerivedCandidate), null);

  // Wrap the fixed ciphertext in a real signed kind-30079 event and exercise
  // the same verification + storage door used by relay ingestion.
  const event = finalizeEvent({
    kind: MEMBER_DOC_KIND,
    created_at: 1800000000,
    tags: [['d', memberDocTag(LEGACY_V2.gid)]],
    content: LEGACY_V2.envelope,
  }, SK);
  __setDocsDbForTests({ groupMemberDocs: fakeDocsTable() });
  try {
    const stored = await ingestMemberDocEvent(event, {
      pin: LEGACY_V2.pin, groupId: LEGACY_V2.gid, docKey: DOC_KEY,
    });
    assert.equal(stored?.stored, true, 'legacy-v2 event passes signature verification and at-rest storage');
    assert.equal((await loadMemberDocHeads(LEGACY_V2.gid))[0]?.id, LEGACY_V2.signed.id);
    assert.equal(await ingestMemberDocEvent(event, {
      pin: LEGACY_V2.pin, groupId: LEGACY_V2.gid, docKey: new Uint8Array(32).fill(78),
    }), null, 'wrong key is rejected by actual ingest');
  } finally { __setDocsDbForTests(null); }
});

test('rememberVerifiedDoc stores only verified docs; tampered refused', async () => {
  const table = fakeDocsTable();
  __setDocsDbForTests({ groupMemberDocs: table });
  const body = await genesisDocBody({ gid: GID, epoch: 1, members: ['cc'.padStart(64, '0')] });
  const signed = await signDocEvent(body, SK);
  const stored = await rememberVerifiedDoc({ groupId: GID, pin: PIN, signed });
  assert.ok(stored?.stored);

  const tampered = { ...signed, body: { ...signed.body, gen: 42 } };
  assert.equal(await rememberVerifiedDoc({ groupId: GID, pin: PIN, signed: tampered }), null);
  // Re-storage of the same doc id is idempotent (a second relay's copy).
  const again = await rememberVerifiedDoc({ groupId: GID, pin: PIN, signed });
  assert.ok(again?.stored);

  // A doc signed by a DIFFERENT key verifies to nothing against this pin.
  const otherPinSK = new Uint8Array(32).fill(5);
  const foreignSigned = await signDocEvent(
    await genesisDocBody({ gid: GID, epoch: 1, members: [] }),
    otherPinSK,
  );
  const foreignStored = await rememberVerifiedDoc({ groupId: GID, pin: PIN, signed: foreignSigned });
  assert.equal(foreignStored, null);
  __setDocsDbForTests(null);
});

test('at rest: next generation stores alongside; conflict pair keeps both ids', async () => {
  const table = fakeDocsTable();
  __setDocsDbForTests({ groupMemberDocs: table });
  const base = await signDocEvent(
    await genesisDocBody({ gid: GID, epoch: 1, members: ['d1'.padStart(64, '0')] }),
    SK,
  );
  await rememberVerifiedDoc({ groupId: GID, pin: PIN, signed: base });
  const next = await signDocEvent(applyDocOps(base.body, { admit: ['dd'.padStart(64, '0')], gen: 1 }), SK);
  assert.notEqual(next.id, base.id);
  await rememberVerifiedDoc({ groupId: GID, pin: PIN, signed: next });

  const heads = await loadMemberDocHeads(GID);
  assert.equal(heads.length, 2);
  assert.equal(heads[0]._gen, 1); // higher gen first (H2 at rest)

  // Equal-gen different-id pair: both rows survive, neither overwrites.
  const divergent = await signDocEvent({
    ...applyDocOps(base.body, { admit: [pad(5)], gen: 1 }),
  }, SK);
  await rememberVerifiedDoc({ groupId: GID, pin: PIN, signed: divergent });
  const afterConflict = await loadMemberDocHeads(GID);
  const atGen1 = afterConflict.filter((h) => h._gen === 1);
  assert.equal(atGen1.length, 2);
  assert.ok(atGen1.some((h) => h.id === next.id));
  assert.ok(atGen1.some((h) => h.id === divergent.id));
  __setDocsDbForTests(null);
});

// ── Step 1 receive: a relayed doc event becomes an at-rest verified row ────

test('ingestMemberDocEvent stores a genuine publish and refuses every forged shape', async () => {
  // The creator's own derived key pair: the event must be authored by the
  // x-only form of the pin, sealed under pin+gid, and verify against pin.
  const body = await genesisDocBody({ gid: GID, epoch: 1, members: ['aa'.padStart(64, '0')] });
  const signed = await signDocEvent(body, SK);
  const published = await buildMemberDocEvent({
    signedDoc: signed, authoritySk: SK, pin: PIN, groupId: GID, createdAt: 1000, docKey: DOC_KEY,
  });

  __setDocsDbForTests({ groupMemberDocs: fakeDocsTable() });
  try {
    const stored = await ingestMemberDocEvent(published, { pin: PIN, groupId: GID, docKey: DOC_KEY });
    assert.equal(stored?.stored, true, 'a genuine publish ingests');
    const heads = await loadMemberDocHeads(GID);
    assert.equal(heads.length, 1);
    assert.equal(heads[0].id, signed.id);

    // A relay-invented author (wrong key) never reaches the seal.
    const wrongAuthor = { ...published, pubkey: 'ee'.repeat(32) };
    assert.equal(await ingestMemberDocEvent(wrongAuthor, { pin: PIN, groupId: GID, docKey: DOC_KEY }), null);

    // Wrong d tag / wrong kind / junk content: quiet refusals, no rows.
    const badD = { ...published, tags: [['d', 'cipher-gmemdoc:' + 'other'.padEnd(64, '0')]] };
    assert.equal(await ingestMemberDocEvent(badD, { pin: PIN, groupId: GID, docKey: DOC_KEY }), null);
    assert.equal(await ingestMemberDocEvent({ ...published, kind: 30078 }, { pin: PIN, groupId: GID, docKey: DOC_KEY }), null);
    const tamperedContent = JSON.stringify({ v: 1, iv: 'AAAA', ct: 'AAAA' });
    assert.equal(await ingestMemberDocEvent(
      { ...published, content: tamperedContent }, { pin: PIN, groupId: GID, docKey: DOC_KEY },
    ), null);

    // No pin held: nothing can verify, refuse before any read.
    assert.equal(await ingestMemberDocEvent(published, { pin: '', groupId: GID }), null);
    // Idempotent re-ingest is not a conflict.
    const again = await ingestMemberDocEvent(published, { pin: PIN, groupId: GID, docKey: DOC_KEY });
    assert.equal(again?.stored, true);
    assert.equal((await loadMemberDocHeads(GID)).length, 1);
  } finally {
    __setDocsDbForTests(null);
  }
});

// ── SEC-1: a passive relay observer must not be able to read the roster ────
//
// The claim under attack: an observer who sees a kind-30079 event on a relay
// can recover the sealed member-set document using ONLY fields printed on
// that wire event (content envelope, d-tag gid, author pubkey). If that
// succeeds, private-group membership metadata is public to every relay.
//
// The observer here is written INLINE deliberately: it imports nothing from
// the module under test except WebCrypto itself, so no "test helper" can be
// accused of carrying knowledge the wire does not.
test('SEC-1 observer attacks: derive the doc key from published event fields alone', async () => {
  const body = await genesisDocBody({
    gid: GID, epoch: 1,
    members: ['ee'.padStart(64, '0')],
    actorPins: { ['ee'.padStart(64, '0')]: PIN },
  });
  const signed = await signDocEvent(body, SK);
  // Post-fix seal: a HELD doc key (what every remediated device carries after
  // its first accepted bundle) drives envelope v2. The observer model stays
  // honest: it reads `event` alone and knows nothing of the random secret.
  const event = await buildMemberDocEvent({
    signedDoc: signed, authoritySk: SK, pin: PIN, groupId: GID, createdAt: 1000,
    docKey: DOC_KEY,
  });

  // Everything below reads `event` only.
  const dTag = event.tags.find((t) => t[0] === 'd')?.[1] || '';
  const observerGid = dTag.slice('cipher-gmemdoc:'.length);
  // The compressed pin IS derivable: it is 02 || author-pubkey for even-y keys,
  // 03 || author for odd-y. Try both shapes exactly as a real attacker would.
  const envelope = JSON.parse(event.content);
  assert.ok((envelope?.v === 1 || envelope?.v === 2) && envelope.iv && envelope.ct, 'event content is the sealed envelope');

  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  let opened = null;
  for (const prefix of ['02', '03', '']) {
    const candidatePin = `${prefix}${event.pubkey.toLowerCase()}`;
    assert.equal(await openSealedDocBody(event.content, candidatePin, observerGid), null, 'public event data without a governance key cannot open new v2');
    const publicDocMaterial = new TextEncoder().encode(`cipher-gmemdoc-key-v1:${candidatePin}:${observerGid}`);
    const publicDocCandidate = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', publicDocMaterial));
    assert.equal(await openSealedDocBody(event.content, candidatePin, observerGid, publicDocCandidate), null, 'publicly derived v1 material is not accepted as a v2 key');
    const key = await globalThis.crypto.subtle.importKey('raw', publicDocCandidate, { name: 'AES-GCM' }, false, ['decrypt']);
    try {
      const pt = await globalThis.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: unb64(envelope.iv), additionalData: new TextEncoder().encode(`cipher-gmemdoc-v1|${observerGid}`) },
        key,
        unb64(envelope.ct),
      );
      opened = JSON.parse(new TextDecoder().decode(pt));
      break;
    } catch { /* next shape */ }
  }

  if (!opened) {
    // Post-fix state: the observer could NOT recover the document.
    assert.ok(true, 'observer derives nothing - remediation held');
    return;
  }
  // Pre-fix state (the vulnerability): the observer just read the whole
  // roster off the wire. Keep this branch asserted so the test documents
  // exactly how complete the leak was, then fail at the end as RED.
  assert.ok(opened.body?.members?.length > 0, 'pre-fix: full member rows recovered by observer');
  assert.fail('SEC-1 CONFIRMED pre-fix: relay observer decrypted the membership document from public event fields alone.');
});

// ── Remediated path checks: v2 sealing + legacy decode coexistence ──────────

test('post-fix: member-only open works; historical v1 events still decode', async () => {
  const body = await genesisDocBody({ gid: GID, epoch: 1, members: ['aa'.padStart(64, '0')] });
  const signed = await signDocEvent(body, SK);
  const v2 = await buildMemberDocEvent({ signedDoc: signed, authoritySk: SK, pin: PIN, groupId: GID, createdAt: 2000, docKey: DOC_KEY });
  assert.equal(JSON.parse(v2.content).v, 2, 'a held doc key seals envelope v2');
  // A member holding the secret opens through the ingest door (the live arm).
  __setDocsDbForTests({ groupMemberDocs: fakeDocsTable() });
  try {
    const stored = await ingestMemberDocEvent(v2, { pin: PIN, groupId: GID, docKey: DOC_KEY });
    assert.equal(stored?.stored, true, 'member with the secret ingests the v2 publish');
  } finally { __setDocsDbForTests(null); }

  // A stale-held reader (wrong generation's secret) cannot open a newer v2
  // body — and crucially, v2 NEVER falls back to the publicly derivable
  // legacy derivation, even when pin+gid are exactly right.
  const wrongKey = new Uint8Array(32).fill(78);
  assert.equal(await openSealedDocBody(v2.content, PIN, GID, wrongKey), null, 'a wrong held secret does not open a v2 body');
  assert.equal(await openSealedDocBody(v2.content, PIN, GID, null), null, 'no held secret refuses v2 rather than leaking via legacy derivation');

  // Legacy v1 events already on relays keep decoding (remediation-agnostic):
  // Historical wire fixture: v1 may be opened, but no current sealing API is
  // allowed to create it. Build it independently to model an old relay event.
  const legacyMaterial = new TextEncoder().encode(`cipher-gmemdoc-key-v1:${PIN.toLowerCase()}:${GID}`);
  const legacyDigest = await crypto.subtle.digest('SHA-256', legacyMaterial);
  const legacyKey = await crypto.subtle.importKey('raw', legacyDigest, { name: 'AES-GCM' }, false, ['encrypt']);
  const legacyIv = crypto.getRandomValues(new Uint8Array(12));
  const legacyPlaintext = new TextEncoder().encode(JSON.stringify({ id: signed.id, sig: signed.sig, body: signed.body }));
  const legacyCt = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: legacyIv, additionalData: new TextEncoder().encode(`cipher-gmemdoc-v1|${GID}`) },
    legacyKey,
    legacyPlaintext,
  );
  const toB64 = (bytes) => btoa(String.fromCharCode(...bytes));
  const v1Sealed = JSON.stringify({ v: 1, iv: toB64(legacyIv), ct: toB64(new Uint8Array(legacyCt)) });
  const openedV1 = await openSealedDocBody(v1Sealed, PIN, GID, DOC_KEY);
  assert.equal(openedV1.id, signed.id, 'a device holding a doc key still opens legacy v1 bodies');
});
