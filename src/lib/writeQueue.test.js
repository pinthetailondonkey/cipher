import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createWriteQueue } from './writeQueue.js';

function fakeDatabase() {
  const rows = new Map();
  return {
    messages: {
      put: async (row) => { rows.set(row.id, row); },
      add: async (row) => { if (rows.has(row.id)) throw new Error('exists'); rows.set(row.id, row); },
      get: async (id) => rows.get(id),
    },
  };
}

test('a write made before the database opens is there to read after it opens', async () => {
  const queue = createWriteQueue();
  await queue.enqueue('messages', 'put', [{ id: 'early', chatId: 'peer', data: { message: 'hi' } }]);
  await queue.enqueue('messages', 'put', [{ id: 'early', chatId: 'peer', data: { message: 'edited' } }]);
  assert.equal(queue.size(), 2);
  const database = fakeDatabase();
  assert.equal(await database.messages.get('early'), undefined);
  assert.deepEqual(await queue.flush(database), { applied: 2, failed: 0 });
  assert.equal((await database.messages.get('early')).data.message, 'edited');
  assert.equal(queue.size(), 0);
});

test('a queued write that fails on open is counted and logged, and the rest still apply', async () => {
  const queue = createWriteQueue();
  const database = fakeDatabase();
  await database.messages.put({ id: 'dup' });
  await queue.enqueue('messages', 'add', [{ id: 'dup' }]);
  await queue.enqueue('messages', 'put', [{ id: 'after' }]);
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    assert.deepEqual(await queue.flush(database), { applied: 1, failed: 1 });
  } finally {
    console.error = original;
  }
  assert.ok(await database.messages.get('after'));
  assert.equal(logged.length, 1);
});

test('a queued write cannot flush into another account or after its captured context expires', async () => {
  const queue = createWriteQueue();
  let current = true;
  const fence = { assertCurrent() { if (!current) throw new Error('expired context'); } };
  await queue.enqueue('messages', 'put', [{ id: 'old-account' }], { owner: 'account-a', securityFence: fence });
  await queue.enqueue('messages', 'put', [{ id: 'stale-incarnation' }], { owner: 'account-b', securityFence: fence });
  const database = fakeDatabase();
  const logged = [];
  const original = console.error;
  console.error = (...args) => logged.push(args);
  try {
    assert.deepEqual(await queue.flush(database, { owner: 'account-b', securityFence: fence, requireContext: true }), { applied: 1, failed: 1 });
    current = false;
    await queue.enqueue('messages', 'put', [{ id: 'expired' }], { owner: 'account-b', securityFence: fence });
    assert.deepEqual(await queue.flush(database, { owner: 'account-b', securityFence: fence, requireContext: true }), { applied: 0, failed: 1 });
  } finally {
    console.error = original;
  }
  assert.equal(await database.messages.get('old-account'), undefined);
  assert.deepEqual(await database.messages.get('stale-incarnation'), { id: 'stale-incarnation' });
  assert.equal(await database.messages.get('expired'), undefined);
  assert.equal(logged.length, 2);
});

test('opening an account database applies the queue through the at-rest view', () => {
  const db = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  // A queued message must not reach the raw Dexie store in plaintext: the
  // flush target routes `messages` through messagesView (the at-rest seal).
  assert.equal((db.match(/writeQueue\.flush\(flushTargetFor\(database, owner, securityFence\)/g) || []).length, 1);
  assert.match(db, /if \(name === 'messages'\) return messagesView\(d\.messages\)/);
  assert.match(db, /put: \(\.\.\.args\) => writeQueue\.enqueue\(tableName, 'put', args,/);
  assert.match(db, /Do not restore a database handle from the persisted owner string after HMR/);
  assert.equal(db.includes("const saved = localStorage.getItem('cipher_db_owner')"), false);
  assert.equal(db.includes('flushQueue'), false);
});
