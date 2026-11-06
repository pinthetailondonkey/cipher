import assert from 'node:assert/strict';
import test from 'node:test';
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
    signedDoc: signed, authoritySk: SK, pin: PIN, groupId: GID, createdAt: 1000,
  });
  assert.ok(event);
  assert.equal(event.kind, MEMBER_DOC_KIND);
  assert.equal(event.created_at, 1000);
  assert.deepEqual(event.tags.find((t) => t[0] === 'd'), ['d', memberDocTag(GID)]);
  // Content is a sealed envelope, not readable JSON of the body.
  assert.ok(!event.content.includes('"members"'));
});

test('wrong pin or gid reads nothing; seal/open round-trips through the real one', async () => {
  const body = await genesisDocBody({ gid: GID, epoch: 1, members: ['bb'.padStart(64, '0')] });
  const signed = await signDocEvent(body, SK);
  const sealed = await sealDocBody(signed, PIN, GID);
  const opened = await openSealedDocBody(sealed, PIN, GID);
  assert.equal(opened.id, signed.id);
  assert.deepEqual(opened.body, signed.body);
  assert.equal(await openSealedDocBody(sealed, 'ee'.repeat(33), GID), null); // wrong pin
  assert.equal(await openSealedDocBody(sealed, PIN, 'other'), null); // wrong gid AAD
  assert.equal(await openSealedDocBody('not-json', PIN, GID), null);
  assert.equal(await openSealedDocBody(JSON.stringify({ v: 2 }), PIN, GID), null);
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
    signedDoc: signed, authoritySk: SK, pin: PIN, groupId: GID, createdAt: 1000,
  });

  __setDocsDbForTests({ groupMemberDocs: fakeDocsTable() });
  try {
    const stored = await ingestMemberDocEvent(published, { pin: PIN, groupId: GID });
    assert.equal(stored?.stored, true, 'a genuine publish ingests');
    const heads = await loadMemberDocHeads(GID);
    assert.equal(heads.length, 1);
    assert.equal(heads[0].id, signed.id);

    // A relay-invented author (wrong key) never reaches the seal.
    const wrongAuthor = { ...published, pubkey: 'ee'.repeat(32) };
    assert.equal(await ingestMemberDocEvent(wrongAuthor, { pin: PIN, groupId: GID }), null);

    // Wrong d tag / wrong kind / junk content: quiet refusals, no rows.
    const badD = { ...published, tags: [['d', 'cipher-gmemdoc:' + 'other'.padEnd(64, '0')]] };
    assert.equal(await ingestMemberDocEvent(badD, { pin: PIN, groupId: GID }), null);
    assert.equal(await ingestMemberDocEvent({ ...published, kind: 30078 }, { pin: PIN, groupId: GID }), null);
    const tamperedContent = JSON.stringify({ v: 1, iv: 'AAAA', ct: 'AAAA' });
    assert.equal(await ingestMemberDocEvent(
      { ...published, content: tamperedContent }, { pin: PIN, groupId: GID },
    ), null);

    // No pin held: nothing can verify, refuse before any read.
    assert.equal(await ingestMemberDocEvent(published, { pin: '', groupId: GID }), null);
    // Idempotent re-ingest is not a conflict.
    const again = await ingestMemberDocEvent(published, { pin: PIN, groupId: GID });
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
    const material = new TextEncoder().encode(`cipher-gmemdoc-key-v1:${candidatePin}:${observerGid}`);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', material);
    const key = await globalThis.crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt']);
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

test('post-fix: member-only open works; v1 events still decode', async () => {
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
  const v1Sealed = await sealDocBody(signed, PIN, GID); // no docKey => v1
  assert.equal(JSON.parse(v1Sealed).v, 1, 'a keyless seal degrades to v1');
  const openedV1 = await openSealedDocBody(v1Sealed, PIN, GID, DOC_KEY);
  assert.equal(openedV1.id, signed.id, 'a device holding a doc key still opens legacy v1 bodies');
});
