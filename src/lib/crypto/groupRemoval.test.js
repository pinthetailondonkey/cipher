import assert from 'node:assert/strict';
import test from 'node:test';
import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';

import { setAtRestKeyProvider } from '../messageAtRest.js';
import {
  __setGroupKeyStoreForTests, putGroupKey, getGroupKey, getCurrentGroupKey,
} from './groupKeyStore.js';
import { generateGroupKey, toHex, fromHex } from './groupCipher.js';
import { rotateGroupEpoch } from './groupKeyRotation.js';
import { parseGroupKeyBundle, distributeGroupKey } from './groupKeyDistribution.js';
import { encodeGroupPayload, decodeGroupEvent } from './groupMessageCodec.js';

// Written by the AUDITOR lane as an untracked probe, landed here by BOSS
// unchanged except for these import paths. It executes the real rotation, the
// real NIP-44 bundle, the real sealed-at-rest key store (over an in-memory
// table) and the real message codec, with real secp256k1 identities and real
// AES-GCM.
//
// This does NOT replace the live two-account drill. Nothing here touches a
// relay or a socket; it proves the local rule only.

const GROUP = 'audit-removal-group';

// An in-memory stand-in for the Dexie groupKeys table (same unique
// [groupId+epoch] rule), copied from src/lib/crypto/groupKeyAtRest.test.js.
function fakeDb() {
  const rows = [];
  let nextId = 1;
  const collection = (match) => ({
    first: async () => { const r = rows.find(match); return r ? structuredClone(r) : undefined; },
    toArray: async () => rows.filter(match).map((r) => structuredClone(r)),
    modify: async (fn) => { rows.filter(match).forEach((r) => fn(r)); },
  });
  const table = {
    where: (index) => ({
      equals: (v) => collection(index === 'groupId' ? (r) => r.groupId === v : (r) => r.groupId === v[0] && r.epoch === v[1]),
    }),
    get: async (id) => { const r = rows.find((x) => x.id === id); return r ? structuredClone(r) : undefined; },
    toArray: async () => rows.map((r) => structuredClone(r)),
    put: async (row) => {
      const copy = structuredClone(row);
      const dupe = rows.find((r) => r.groupId === copy.groupId && r.epoch === copy.epoch && r.id !== copy.id);
      if (dupe) throw new Error('ConstraintError');
      const at = copy.id != null ? rows.findIndex((r) => r.id === copy.id) : -1;
      if (at >= 0) rows[at] = copy; else { copy.id = nextId++; rows.push(copy); }
    },
  };
  return { rows, db: { groupKeys: table, transaction: async (_m, _t, fn) => fn() } };
}

const SESSION = new Uint8Array(32).fill(9);

// One device per member, kept for the whole test: switching banks the
// store seam to that member's own table, exactly as one app instance per
// device would hold its own keys.
const devices = new Map();
function asMember(name) {
  if (!devices.has(name)) devices.set(name, fakeDb());
  const fake = devices.get(name);
  __setGroupKeyStoreForTests({ db: fake.db, owner: () => name });
  return fake;
}

test('a removed member cannot read a post-removal message; a remaining member can', async () => {
  setAtRestKeyProvider(() => SESSION);

  const A = generateSecretKey(); const aPk = getPublicKey(A); // admin, rotates
  const B = generateSecretKey(); const bPk = getPublicKey(B); // stays
  const C = generateSecretKey(); const cPk = getPublicKey(C); // removed

  // Epoch 0 exists for all three, as it did before the removal.
  const epoch0 = generateGroupKey();
  for (const [who] of [['A'], ['B'], ['C']]) { asMember(who); await putGroupKey(GROUP, 0, epoch0); }
  // For the record: all three hold the same epoch-0 bytes.
  for (const who of ['A', 'B', 'C']) {
    asMember(who);
    assert.equal(toHex((await getGroupKey(GROUP, 0))), toHex(epoch0), `${who} holds epoch 0`);
  }

  // A pre-removal message, sent under epoch 0.
  const before = await encodeGroupPayload({ groupId: GROUP, payload: { type: 'text', message: 'before the kick' }, senderPubkey: aPk });
  const beforeEvent = { kind: 9, pubkey: aPk, created_at: 1, content: before.content, tags: before.tags };

  // The removal. C is not in remainingPubkeys.
  asMember('A');
  const published = [];
  const rotate = await rotateGroupEpoch({
    identity: { sk: A, pk: aPk },
    groupId: GROUP,
    remainingPubkeys: [bPk],
    publish: async (event) => { published.push(event); },
  });

  assert.equal(rotate.rotated, true, `rotation refused: ${rotate.reason}`);
  assert.equal(rotate.epoch, 1);

  // The new key reached exactly one member, and it is not C.
  assert.equal(published.length, 1, 'one bundle was published');
  const dm = published[0];
  assert.deepEqual(dm.tags.find((t) => t[0] === 'p')?.[1], bPk);
  assert.equal(published.some((e) => e.tags.some((t) => t[0] === 'p' && t[1] === cPk)), false, 'nothing addressed to the removed member');

  // C cannot open B's bundle even when handed the exact bytes.
  const forB = nip44.v2.utils.getConversationKey(A, bPk);
  const asC = nip44.v2.utils.getConversationKey(A, cPk);
  assert.throws(() => nip44.v2.decrypt(dm.content, asC), 'the removed member cannot decrypt the bundle');
  const payload = JSON.parse(nip44.v2.decrypt(dm.content, forB));
  assert.equal(payload.t, 'gkey');
  assert.equal(payload.by, aPk);

  // B installs the real bundle through the real parser and the real store.
  const rows = parseGroupKeyBundle(payload);
  assert.ok(rows.length >= 1);
  assert.equal(Math.max(...rows.map((r) => r.epoch)), 1);
  asMember('B');
  for (const row of rows) await putGroupKey(row.groupId, row.epoch, fromHex(row.hex));
  const bNow = await getCurrentGroupKey(GROUP);
  assert.equal(bNow.epoch, 1, 'B is on the new epoch');
  assert.notEqual(toHex(bNow.bytes), toHex(epoch0), 'the new epoch is different key material');

  // A writes AFTER the removal, under epoch 1.
  asMember('A');
  const after = await encodeGroupPayload({ groupId: GROUP, payload: { type: 'text', message: 'after the kick' }, senderPubkey: aPk });
  assert.equal(after.epoch, 1);
  const afterEvent = { kind: 9, pubkey: aPk, created_at: 2, content: after.content, tags: after.tags };

  // The remaining member reads it.
  asMember('B');
  const bRead = await decodeGroupEvent({ event: afterEvent, groupId: GROUP });
  assert.equal(bRead.error, undefined, `B failed: ${bRead.error} — ${bRead.reason}`);
  assert.equal(bRead.epoch, 1);
  assert.equal(bRead.parsed.message, 'after the kick');

  // The removed member, holding every key it ever had, does not.
  asMember('C');
  const cRead = await decodeGroupEvent({ event: afterEvent, groupId: GROUP });
  assert.equal(cRead.plaintext, undefined, 'the removed member read the post-removal message');
  assert.equal(cRead.parsed, undefined, 'the removed member parsed the post-removal message');
  assert.equal(cRead.pending, true, 'C has no epoch-1 key at all, so the message waits');
  assert.equal(cRead.epoch, 1);

  // And the ciphertext is bound to the real key, not merely absent from C:
  // hand C some other epoch-1 key and the AES-GCM open still fails.
  asMember('C');
  await putGroupKey(GROUP, 1, generateGroupKey());
  const cWrong = await decodeGroupEvent({ event: afterEvent, groupId: GROUP });
  assert.equal(cWrong.plaintext, undefined);
  assert.equal(cWrong.error, 'decrypt-failed');
  assert.equal(cWrong.epoch, 1);

  // The limit, stated: removal does not take back what C could already read.
  asMember('C');
  const cOld = await decodeGroupEvent({ event: beforeEvent, groupId: GROUP });
  assert.equal(cOld.parsed.message, 'before the kick', 'history stays readable to a former member');
});

test('a rotation that leaves the sender out still withholds the new epoch from the removed member', async () => {
  // Same rule through the raw distributor, in case the app ever calls it
  // directly: recipients decide who can open the bundle.
  setAtRestKeyProvider(() => SESSION);
  const A = generateSecretKey(); const aPk = getPublicKey(A);
  const B = generateSecretKey(); const bPk = getPublicKey(B);
  const C = generateSecretKey(); const cPk = getPublicKey(C);
  const newKey = generateGroupKey();
  const published = [];
  const ledger = { getGrantRecords: async () => new Map(), recordGrant: async () => {} };
  await distributeGroupKey({
    senderPrivkey: A, senderPubkey: aPk, groupId: GROUP, epoch: 7, keyBytes: newKey,
    recipients: [bPk], publish: async (e) => { published.push(e); }, ledger,
  });
  assert.equal(published.length, 1);
  assert.equal(published.some((e) => e.tags.some((t) => t[0] === 'p' && t[1] === cPk)), false);
  assert.throws(() => nip44.v2.decrypt(published[0].content, nip44.v2.utils.getConversationKey(A, cPk)));
});
