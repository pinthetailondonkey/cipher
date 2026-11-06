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
  __setDocsDbForTests,
} from './groupDocWire.js';
import { signDocEvent, genesisDocBody, applyDocOps, authorityPinOf } from './groupDoc.js';
import { groupAuthorityKey } from './groupAuthority.js';

const GID = 'wire-test-group'.padEnd(64, '0');
const SK = new Uint8Array(32).fill(21);
// The pin IS the authority key's compressed pubkey: doc signatures verify
// against it. Tests that fake a pin at random never verify (witnessed in the
// rememberVerifiedDoc case below via the foreign-key check).
const PIN = authorityPinOf(SK);

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
