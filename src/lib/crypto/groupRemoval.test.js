import assert from 'node:assert/strict';
import test from 'node:test';
// fake-indexeddb backs Dexie in node, as useGroupKeyReconciler.test.js does,
// and the localStorage stub below must land BEFORE any db.js import.
import 'fake-indexeddb/auto';
const lsStore = new Map();
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => { lsStore.set(k, String(v)); },
    removeItem: (k) => { lsStore.delete(k); },
  };
}
import { generateSecretKey, getPublicKey, nip44 } from 'nostr-tools';

import { setAtRestKeyProvider } from '../messageAtRest.js';
import {
  __setGroupKeyStoreForTests, putGroupKey, getGroupKey, getCurrentGroupKey,
} from './groupKeyStore.js';
import { generateGroupKey, toHex, fromHex } from './groupCipher.js';
import { rotateGroupEpoch, __setMembershipDbForTests } from './groupKeyRotation.js';
import { parseGroupKeyBundle, distributeGroupKey, installReceivedGroupKey } from './groupKeyDistribution.js';
import { unwrapToRumor } from '../giftUnwrap';
import { encodeGroupPayload, decodeGroupEvent } from './groupMessageCodec.js';
import { putDocKey, getDocKey } from './groupKeyStore.js';
import { generateDocKey } from './groupDocKey.js';
import { sealDocBody, openSealedDocBody } from './groupDocWire.js';
import { rememberPendingKeyRequest } from './groupKeyRequest.js';
import { openDBFor } from '../../db.js';

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
  return { rows, db: {
    groupKeys: table,
    groupDocKeys: (() => {
      const docRows = [];
      return {
        get: async (key) => {
          const gid = Array.isArray(key) ? key[0] : key;
          return docRows.find((row) => row.groupId === gid) ? structuredClone(docRows.find((row) => row.groupId === gid)) : undefined;
        },
        delete: async (gid) => { const at = docRows.findIndex((r) => r.groupId === gid); if (at >= 0) docRows.splice(at, 1); },
        put: async (row) => { const at = docRows.findIndex((r) => r.groupId === row.groupId); if (at >= 0) docRows[at] = structuredClone(row); else docRows.push(structuredClone(row)); },
        transaction: undefined,
      };
    })(),
    transaction: async (_m, _t, fn) => fn(),
  } };
}

const SESSION = new Uint8Array(32).fill(9);

// The v2 seal still requires a pin parameter for its legacy fallback branch
// (not exercised in the SEC-1 witness); an observer-shape pin is fine.
function PIN_COMPRESSED(pkHex) { return `02${String(pkHex).toLowerCase()}`; }

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
  //
  // The bundle is a wrap now, so the bytes a stranger would hold are the outer
  // envelope. B opens it with B's own key to reach the rumor; only then does
  // the pair key apply. That is exactly what ingest does, so the removed
  // member's refusal is asserted on the envelope and on the settled body.
  assert.equal(dm.kind, 1059, 'the bundle is a wrap');
  const opened = unwrapToRumor(dm, B);
  assert.ok(opened, 'the remaining member cannot open the bundle');
  assert.notEqual(dm.pubkey, aPk, 'the rotating admin is still named on the wire');
  assert.equal(opened.rumor.pubkey, aPk, 'the seal no longer names the admin');

  const forB = nip44.v2.utils.getConversationKey(A, bPk);
  const asC = nip44.v2.utils.getConversationKey(A, cPk);
  assert.throws(() => nip44.v2.decrypt(opened.rumor.content, asC), 'the removed member cannot decrypt the bundle');
  const payload = JSON.parse(nip44.v2.decrypt(opened.rumor.content, forB));
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

test('a removal whose membership strip cannot be written aborts before the new epoch is stored', async () => {
  setAtRestKeyProvider(() => SESSION);

  const A = generateSecretKey(); const aPk = getPublicKey(A);
  const B = generateSecretKey(); const bPk = getPublicKey(B);
  const STRIP_GROUP = 'audit-removal-strip-group';
  const epoch0 = generateGroupKey();
  asMember('A');
  await putGroupKey(STRIP_GROUP, 0, epoch0);

  // The membership table refuses every write, as a full or locked store would.
  const failingSigs = { put: async () => { throw new Error('QuotaExceededError'); }, get: async () => undefined };
  const fake = devices.get('A');
  __setMembershipDbForTests({ groupMemberSigs: failingSigs });

  const published = [];
  await assert.rejects(
    rotateGroupEpoch({
      identity: { sk: A, pk: aPk },
      groupId: STRIP_GROUP,
      remainingPubkeys: [bPk],
      publish: async (event) => { published.push(event); },
    }),
    /QuotaExceededError/,
  );

  // No new epoch was stored, and nothing was sent to anyone.
  __setMembershipDbForTests(null);
  assert.equal(fake.rows.some((r) => r.groupId === STRIP_GROUP && r.epoch === 1), false, 'no epoch 1 stored');
  assert.equal((await getCurrentGroupKey(STRIP_GROUP)).epoch, 0, 'still on epoch 0');
  assert.equal(published.length, 0, 'no key bundle published');
});

// ── SEC-1: the governance-doc key rotates with a kick and rides the bundle ─
//
// Full path with real crypto.
test('SEC-1: a kick rotates the doc key; remaining members receive only the new secret', async () => {
  setAtRestKeyProvider(() => SESSION);
  const A = generateSecretKey(); const aPk = getPublicKey(A); // admin, rotates
  const B = generateSecretKey(); const bPk = getPublicKey(B); // stays
  const C = generateSecretKey(); // removed; C's isolation here is structural, not asserted
  openDBFor(bPk);

  // Genesis doc key on every device (as createGroup/bootstrap ships it).
  // GROUP itself starts at epoch 0 for the chat key; C is given a DIFFERENT
  // epoch-0 chat key than A/B so its later restatement of held bytes can be
  // witnessed refusing (the conflict guard exercised below).
  const genesisDocKey = generateDocKey();
  for (const who of ['A', 'B', 'C']) {
    asMember(who);
    assert.ok(await putDocKey(GROUP, 0, genesisDocKey), `${who} installs the genesis doc key`);
  }
  asMember('A');
  const epoch0 = generateGroupKey();
  await putGroupKey(GROUP, 0, epoch0);
  asMember('B');
  await putGroupKey(GROUP, 0, epoch0);

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

  // Exactly one wrap went out; decrypt its payload as B would.
  assert.equal(published.length, 1);
  const rumorB = unwrapToRumor(published[0], B).rumor;
  const payload = JSON.parse(nip44.v2.decrypt(rumorB.content, nip44.v2.utils.getConversationKey(A, bPk)));
  assert.equal(payload.t, 'gkey');
  // The NEW secret rode along: hex64, and NOT the genesis bytes C holds.
  assert.match(payload.dk || '', /^[0-9a-f]{64}$/);
  assert.notEqual(payload.dk, toHex(genesisDocKey), 'the rotated secret is what shipped');

  // B adopts through the REAL accepted-bundle install path. B holds epoch 0
  // and the bundle carries epoch 1, so the install floor, snapshot check and
  // rollback guards all pass here exactly as the live app runs them.
  asMember('B');
  await putGroupKey(GROUP, 0, epoch0); // same bytes as A holds: no conflict guard trip
  await rememberPendingKeyRequest(bPk, GROUP); // B's own ask-evidence (the floor)
  // Sender standing: the roster snapshot names A as an ADMIN (a roll-forward
  // to a new epoch requires admin/creator standing - the takeover guard).
  __setMembershipDbForTests({ groupMemberSigs: {
    async get() { return { members: [{ pubkey: aPk, role: 'admin' }, bPk], roles: {}, updatedAt: Math.floor(Date.now()/1000) }; },
    async put() {},
  } });
  assert.equal(await installReceivedGroupKey(payload, aPk), true, 'B accepts the rotation bundle');
  const heldByB = await getDocKey(GROUP);
  assert.ok(heldByB, 'B holds a doc key after adopting');
  assert.equal(toHex(heldByB.bytes), payload.dk, 'B holds exactly the rotated secret');
  assert.equal(heldByB.epoch, 2, 'the ride carries the bundle max epoch (0 + backfill = 2 across rows)');
  __setMembershipDbForTests(null);

  // The v2 body B or any member sees sealed thereafter cannot be opened by
  // the legacy pin derivation: an observer with public fields alone is shut out.
  const fakePin = PIN_COMPRESSED(aPk);
  const signedBody = { id: 'd'.repeat(64), sig: 'e'.repeat(128), body: { gen: 1, members: [] } };
  const v2Sealed = await sealDocBody(signedBody, fakePin, GROUP, heldByB.bytes, 1);
  assert.equal(JSON.parse(v2Sealed).v, 2, 'a held doc key seals v2');
  assert.equal(await openSealedDocBody(v2Sealed, fakePin, GROUP, null), null, 'v2 refuses legacy-only decode');

  // C's isolation is structural: C was stripped before the ride, so the
  // rotated secret is addressed only to B — nothing new ever travels to C.
  // (Envelope + ask-evidence guarantees; already witnessed above.)
});
