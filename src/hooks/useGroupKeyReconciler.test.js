import assert from 'node:assert/strict';
import test from 'node:test';

// The node test runs before any browser bundle: fake-indexeddb backs the real
// Dexie tables (grants, member signatures) that the reconciler reads through
// db.js, so the reconciler's store calls resolve instead of hanging on a dead
// stub. groupKeys goes through the store seam (faked below); grants and the
// owner marker go through the real Dexie instance here.
import 'fake-indexeddb/auto';

// db.js's HMR-restore block and openDBFor write through localStorage, which
// node does not have: stub the minimal surface before db.js is imported.
const lsStore = new Map();
if (typeof globalThis.localStorage === 'undefined') {
  globalThis.localStorage = {
    getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
    setItem: (k, v) => { lsStore.set(k, String(v)); },
    removeItem: (k) => { lsStore.delete(k); },
  };
}

import { generateSecretKey, getPublicKey } from 'nostr-tools';

import { setAtRestKeyProvider } from '../lib/messageAtRest.js';
import { openDBFor } from '../db.js';
import {
  __setGroupKeyStoreForTests, getCurrentGroupKey,
} from '../lib/crypto/groupKeyStore.js';
import { generateGroupKey, toHex } from '../lib/crypto/groupCipher.js';
import { __setMembershipDbForTests, rememberMembers, setGroupRotationPending } from '../lib/crypto/groupKeyRotation.js';
import { reconcileGroupKeys } from './useGroupKeyReconciler.js';

// A pre-remediation group with no held governance key cannot safely be
// rotated. The reconciler must stop before changing its roster, chat epoch,
// or sending a key bundle instead of silently minting a replacement.

const SESSION = new Uint8Array(32).fill(9);

// In-memory stand-in for the Dexie groupKeys table behind the store seam
// (same unique [groupId+epoch] rule the real table enforces).
function fakeKeyTable() {
  const rows = [];
  let nextId = 1;
  const collection = (index, v) => ({
    first: async () => {
      const r = rows.find((x) => (index === 'groupId' ? x.groupId === v : x.groupId === v[0] && x.epoch === v[1]));
      return r ? structuredClone(r) : undefined;
    },
    toArray: async () => rows.filter((x) => (index === 'groupId' ? x.groupId === v : x.groupId === v[0] && x.epoch === v[1])).map((r) => structuredClone(r)),
    modify: async (fn) => { rows.filter((x) => (index === 'groupId' ? x.groupId === v : x.groupId === v[0] && x.epoch === v[1])).forEach((r) => fn(r)); },
  });
  return {
    rows,
    where: (index) => ({ equals: (v) => collection(index, v) }),
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
}

// The table plus the transaction wrapper the store seam expects.
function fakeKeyDb(keyTable) {
  return {
    groupKeys: keyTable,
    groupDocKeys: { get: async () => undefined, put: async () => {}, delete: async () => {} },
    transaction: async (_mode, _table, fn) => fn(),
  };
}

test('the reconciler refuses to rotate a legacy group without its governance key', async () => {
  setAtRestKeyProvider(() => SESSION);

  const A = generateSecretKey(); const aPk = getPublicKey(A);
  const B = generateSecretKey(); const bPk = getPublicKey(B);
  const GROUP = 'reconciler-strict-strip-group';

  // The reconciler gates on the app DB's current owner: open A's account the
  // way the app does at unlock. fake-indexeddb backs the real Dexie instance.
  openDBFor(aPk);

  // Seed: epoch 0 exists as a SEALED row behind the store seam (a plaintext
  // keyHex row reads as legacy and gets rewritten, so the seed is sealed with
  // the same helper the app uses).
  const keyTable = fakeKeyTable();
  __setGroupKeyStoreForTests({ db: fakeKeyDb(keyTable), owner: () => aPk });
  const { sealGroupKeyRow } = await import('../lib/crypto/groupKeyAtRest.js');
  const seeded = await sealGroupKeyRow({ groupId: GROUP, epoch: 0, keyHex: toHex(generateGroupKey()), owner: aPk, obtainedAt: Date.now() });
  keyTable.rows.push(seeded);

  // The membership table refuses every write, as a full or locked store would.
  let stripAttempted = false;
  __setMembershipDbForTests({ groupMemberSigs: { put: async () => { stripAttempted = true; throw new Error("QuotaExceededError"); }, get: async () => ({ members: [aPk, bPk], roles: {}, updatedAt: 1 }) } });

  const published = [];
  const currentFence = { context: { owner: aPk, incarnation: 'reconciler-test-incarnation' }, assertCurrent() {} };
  // Removal: B is gone from the roster.
  await assert.rejects(
    reconcileGroupKeys({
      groupId: GROUP,
      members: [aPk],
      isOwner: true,
      identity: { sk: A, pk: aPk, securityFence: currentFence },
      publish: async (event) => { published.push(event); },
    }),
    /No readable governance-doc key/,
  );

  __setMembershipDbForTests(null);
  // No new epoch was stored, and nothing was sent to anyone.
  assert.equal(stripAttempted, false, 'a legacy group without a held governance key is not silently changed');
  assert.equal(keyTable.rows.some((r) => r.groupId === GROUP && r.epoch === 1), false, 'no epoch 1 stored');
  assert.equal((await getCurrentGroupKey(GROUP))?.epoch, 0, 'still on epoch 0');
  assert.equal(published.length, 0, 'no key bundle published');

  const staleFence = { ...currentFence, assertCurrent() {
    const error = new Error('retired account context');
    error.code = 'SECURITY_CONTEXT_EXPIRED';
    throw error;
  } };
  await assert.rejects(reconcileGroupKeys({
    groupId: GROUP,
    members: [aPk],
    isOwner: true,
    identity: { sk: A, pk: aPk, securityFence: staleFence },
  }), { code: 'SECURITY_CONTEXT_EXPIRED' });
  assert.equal(keyTable.rows.some((r) => r.groupId === GROUP && r.epoch === 1), false, 'a retired incarnation cannot rotate keys');
  assert.equal(published.length, 0, 'a retired incarnation cannot publish group keys');
});

test('membership writes stop if the account incarnation expires during an IndexedDB read', async () => {
  const owner = getPublicKey(generateSecretKey());
  const context = { owner, incarnation: 'reconciler-race-incarnation' };
  let current = true;
  const fence = {
    context,
    assertCurrent() {
      if (current) return;
      const error = new Error('retired account context');
      error.code = 'SECURITY_CONTEXT_EXPIRED';
      throw error;
    },
  };
  let puts = 0;
  __setMembershipDbForTests({ groupMemberSigs: {
    get: async () => { current = false; return undefined; },
    put: async () => { puts += 1; },
  } });

  await assert.rejects(
    rememberMembers('fenced-membership-read', [owner], {
      strict: true, securityFence: fence, owner,
    }),
    { code: 'SECURITY_CONTEXT_EXPIRED' },
  );
  assert.equal(puts, 0, 'no membership row is written after the read returns to a retired context');

  current = true;
  await assert.rejects(
    setGroupRotationPending('fenced-rotation-read', true, { securityFence: fence, owner }),
    { code: 'SECURITY_CONTEXT_EXPIRED' },
  );
  assert.equal(puts, 0, 'no rotation marker is written after the read returns to a retired context');
  __setMembershipDbForTests(null);
});
