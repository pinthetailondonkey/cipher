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

test('opening an account database applies the queue', () => {
  const db = fs.readFileSync(new URL('../db.js', import.meta.url), 'utf8');
  assert.equal((db.match(/writeQueue\.flush\(_current\)/g) || []).length, 2);
  assert.match(db, /put: \(\.\.\.args\) => writeQueue\.enqueue\(tableName, 'put', args\)/);
  assert.equal(db.includes('flushQueue'), false);
});
