import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';
import test from 'node:test';
import Dexie from 'dexie';
import {
  activateIndexedDbContext,
  retireIndexedDbContext,
  runAuthorizedIndexedDbWrite,
  SECURITY_CONTEXT_STORE,
} from './indexedDbContextGate.js';

let sequence = 0;
async function openTestDb() {
  const database = new Dexie(`context-gate-${++sequence}`);
  database.version(1).stores({
    [SECURITY_CONTEXT_STORE]: '&id, owner, incarnation',
    records: '&id',
  });
  await database.open();
  return database;
}

function context(incarnation) {
  return { owner: 'a'.repeat(64), incarnation };
}

const readAll = (database) => database.table('records').toArray();

test('a queued retirement serializes after an in-flight authorized write and fences later writes', async () => {
  const database = await openTestDb();
  const accountContext = context('tab-a-incarnation-0001');
  await activateIndexedDbContext(database, accountContext);

  const write = runAuthorizedIndexedDbWrite(database, { context: accountContext, stores: ['records'] }, (db) => {
    return db.table('records').put({ id: 'before-retirement', value: 1 });
  });
  const retirement = retireIndexedDbContext(database, accountContext);
  await write;
  assert.deepEqual(await retirement, { retired: true });

  await assert.rejects(
    runAuthorizedIndexedDbWrite(database, { context: accountContext, stores: ['records'] }, (db) => {
      return db.table('records').put({ id: 'after-retirement', value: 2 });
    }),
    { code: 'SECURITY_CONTEXT_EXPIRED' },
  );
  assert.deepEqual(await readAll(database), [{ id: 'before-retirement', value: 1 }]);
  database.close();
});

test('retiring one tab incarnation leaves its sibling account incarnation authorized', async () => {
  const database = await openTestDb();
  const first = context('tab-a-incarnation-0001');
  const sibling = context('tab-b-incarnation-0002');
  await activateIndexedDbContext(database, first);
  await activateIndexedDbContext(database, sibling);

  assert.deepEqual(await retireIndexedDbContext(database, first), { retired: true });
  await assert.rejects(
    runAuthorizedIndexedDbWrite(database, { context: first, stores: ['records'] }, (db) => {
      return db.table('records').put({ id: 'retired', value: 1 });
    }),
    { code: 'SECURITY_CONTEXT_EXPIRED' },
  );
  await runAuthorizedIndexedDbWrite(database, { context: sibling, stores: ['records'] }, (db) => {
    return db.table('records').put({ id: 'sibling', value: 2 });
  });
  assert.deepEqual(await readAll(database), [{ id: 'sibling', value: 2 }]);
  database.close();
});

test('a callback failure aborts data writes atomically and preserves the active marker', async () => {
  const database = await openTestDb();
  const accountContext = context('tab-a-incarnation-0001');
  await activateIndexedDbContext(database, accountContext);
  await assert.rejects(
    runAuthorizedIndexedDbWrite(database, { context: accountContext, stores: ['records'] }, async (db) => {
      await db.table('records').put({ id: 'aborted', value: 1 });
      throw new Error('injected failure');
    }),
    /injected failure/,
  );
  assert.deepEqual(await readAll(database), []);
  assert.equal(await database.table(SECURITY_CONTEXT_STORE).get(`${accountContext.owner}:${accountContext.incarnation}`)
    .then(Boolean), true);
  database.close();
});
