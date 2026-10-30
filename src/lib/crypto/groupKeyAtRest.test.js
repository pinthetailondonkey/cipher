import assert from 'node:assert/strict';
import test from 'node:test';
import { setAtRestKeyProvider } from '../messageAtRest.js';
import { toHex } from './groupCipher.js';
import {
  sealGroupKeyRow, openGroupKeyRow, isSealedKeyRow,
  GroupKeyLockedError, GroupKeyUnreadableError,
} from './groupKeyAtRest.js';
import {
  __setGroupKeyStoreForTests, putGroupKey, getGroupKey, getCurrentGroupKey, getAllGroupKeys,
} from './groupKeyStore.js';

const SK = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const OTHER_SK = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);
const KEY = Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + 3) & 255);
const KEY_HEX = toHex(KEY);

const plainRow = (over = {}) => ({ groupId: 'g1', epoch: 2, keyHex: KEY_HEX, isCurrent: true, obtainedAt: 50, ...over });

// An in-memory stand-in for the Dexie groupKeys table. It keeps the same
// unique [groupId+epoch] rule and hands out copies, as IndexedDB does.
function fakeDb(initial = []) {
  const rows = initial.map((r, i) => ({ id: i + 1, ...structuredClone(r) }));
  let nextId = rows.length + 1;
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
  return {
    rows,
    db: { groupKeys: table, transaction: async (_mode, _table, fn) => fn() },
    owner: () => 'owner-pk',
  };
}
const raw = (fake) => JSON.stringify(fake.rows);

test('a sealed key row round-trips and its stored form holds no key bytes', async () => {
  setAtRestKeyProvider(() => SK);
  const stored = await sealGroupKeyRow(plainRow());
  assert.ok(isSealedKeyRow(stored));
  assert.equal('keyHex' in stored, false, 'the plaintext field is gone');
  assert.equal(stored.groupId, 'g1');
  assert.equal(stored.epoch, 2);
  assert.equal(stored.sealed.v, 1);
  assert.equal(JSON.stringify(stored).includes(KEY_HEX), false);
  assert.deepEqual(await openGroupKeyRow(stored), KEY);
});

test('a legacy plaintext row (no sealed marker) still reads', async () => {
  setAtRestKeyProvider(() => SK);
  assert.deepEqual(await openGroupKeyRow(plainRow()), KEY);
});

test('a tampered ciphertext refuses to open', async () => {
  setAtRestKeyProvider(() => SK);
  const stored = await sealGroupKeyRow(plainRow());
  const bad = { ...stored, sealed: { ...stored.sealed, ct: stored.sealed.ct.slice(0, -4) + 'AAAA' } };
  await assert.rejects(() => openGroupKeyRow(bad), GroupKeyUnreadableError);
});

test('a sealed row moved to another epoch or group refuses to open', async () => {
  setAtRestKeyProvider(() => SK);
  const stored = await sealGroupKeyRow(plainRow());
  await assert.rejects(() => openGroupKeyRow({ ...stored, epoch: 3 }), GroupKeyUnreadableError);
  await assert.rejects(() => openGroupKeyRow({ ...stored, groupId: 'g2' }), GroupKeyUnreadableError);
});

test('the wrong session key refuses to open', async () => {
  setAtRestKeyProvider(() => SK);
  const stored = await sealGroupKeyRow(plainRow());
  setAtRestKeyProvider(() => OTHER_SK);
  await assert.rejects(() => openGroupKeyRow(stored), GroupKeyUnreadableError);
});

test('with no session key nothing is sealed and nothing sealed opens', async () => {
  setAtRestKeyProvider(() => SK);
  const stored = await sealGroupKeyRow(plainRow());
  setAtRestKeyProvider(() => null);
  await assert.rejects(() => sealGroupKeyRow(plainRow()), GroupKeyLockedError);
  await assert.rejects(() => openGroupKeyRow(stored), GroupKeyLockedError);
});

test('putGroupKey stores a row with no key hex in it, and the key reads back', async () => {
  setAtRestKeyProvider(() => SK);
  const fake = fakeDb();
  __setGroupKeyStoreForTests(fake);
  await putGroupKey('g1', 1, KEY);
  assert.equal(fake.rows.length, 1);
  assert.equal(raw(fake).includes(KEY_HEX), false, 'the raw stored row must not contain the key hex');
  assert.equal('keyHex' in fake.rows[0], false);
  assert.deepEqual(await getGroupKey('g1', 1), KEY);
  const current = await getCurrentGroupKey('g1');
  assert.equal(current.epoch, 1);
  assert.deepEqual(current.bytes, KEY);
  assert.deepEqual((await getAllGroupKeys('g1')).map((k) => k.epoch), [1]);
  __setGroupKeyStoreForTests(null);
});

test('a re-delivered epoch rewrites the row in place and keeps obtainedAt', async () => {
  setAtRestKeyProvider(() => SK);
  const fake = fakeDb();
  __setGroupKeyStoreForTests(fake);
  await putGroupKey('g1', 1, KEY);
  const firstAt = fake.rows[0].obtainedAt;
  fake.rows[0].obtainedAt = 5;
  await putGroupKey('g1', 1, KEY);
  assert.equal(fake.rows.length, 1);
  assert.equal(fake.rows[0].obtainedAt, 5);
  assert.ok(firstAt >= 0);
  await putGroupKey('g1', 2, OTHER_SK);
  assert.equal(fake.rows.find((r) => r.epoch === 1).isCurrent, false);
  __setGroupKeyStoreForTests(null);
});

test('old plaintext rows still read and are resealed on first use while unlocked', async () => {
  setAtRestKeyProvider(() => SK);
  const fake = fakeDb([plainRow({ epoch: 1 }), plainRow({ epoch: 2, keyHex: toHex(OTHER_SK) })]);
  assert.ok(raw(fake).includes(KEY_HEX), 'the legacy rows start as plaintext');
  __setGroupKeyStoreForTests(fake);
  assert.deepEqual(await getGroupKey('g1', 1), KEY, 'a legacy row reads');
  assert.equal(raw(fake).includes(KEY_HEX), false, 'the first read reseals it');
  assert.equal(raw(fake).includes(toHex(OTHER_SK)), false);
  assert.equal(fake.rows.every(isSealedKeyRow), true);
  assert.deepEqual(await getGroupKey('g1', 2), OTHER_SK);
  assert.equal(fake.rows[0].obtainedAt, 50, 'resealing keeps the other fields');
  __setGroupKeyStoreForTests(null);
});

test('while locked, reads return nothing and a write is refused with nothing stored', async () => {
  setAtRestKeyProvider(() => SK);
  const fake = fakeDb();
  __setGroupKeyStoreForTests(fake);
  await putGroupKey('g1', 1, KEY);
  const before = raw(fake);
  setAtRestKeyProvider(() => null);
  assert.equal(await getGroupKey('g1', 1), null);
  assert.equal(await getCurrentGroupKey('g1'), null);
  assert.deepEqual(await getAllGroupKeys('g1'), []);
  await assert.rejects(() => putGroupKey('g1', 2, OTHER_SK), GroupKeyLockedError);
  assert.equal(raw(fake), before, 'the refused write touched nothing');
  __setGroupKeyStoreForTests(null);
});

test('a legacy plaintext row is not handed out while locked', async () => {
  setAtRestKeyProvider(() => null);
  const fake = fakeDb([plainRow({ epoch: 1 })]);
  __setGroupKeyStoreForTests(fake);
  assert.equal(await getGroupKey('g1', 1), null);
  assert.equal(await getCurrentGroupKey('g1'), null);
  assert.equal(fake.rows[0].keyHex, KEY_HEX, 'and it is not resealed or changed while locked');
  __setGroupKeyStoreForTests(null);
});

test('an unreadable newest key throws, never reads as no-key or falls back to an older epoch', async () => {
  setAtRestKeyProvider(() => SK);
  const fake = fakeDb();
  __setGroupKeyStoreForTests(fake);
  await putGroupKey('g1', 1, KEY);
  await putGroupKey('g1', 2, OTHER_SK);
  const newest = fake.rows.find((r) => r.epoch === 2);
  newest.sealed.ct = newest.sealed.ct.slice(0, -4) + 'AAAA';
  await assert.rejects(() => getCurrentGroupKey('g1'), GroupKeyUnreadableError);
  assert.equal(await getGroupKey('g1', 2), null, 'a single read of it is "no key", nothing decrypts');
  assert.deepEqual(await getGroupKey('g1', 1), KEY, 'the intact epoch still reads');
  __setGroupKeyStoreForTests(null);
});
