import assert from 'node:assert/strict';
import test from 'node:test';
import { runPanicWipe } from './panicWipe.js';

const quiet = { error() {}, warn() {} };

function store(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    clear: () => { Object.keys(data).forEach((k) => delete data[k]); },
  };
}

function fakeIndexedDB(names, { blockFor = [] } = {}) {
  const deleted = [];
  return {
    deleted,
    databases: async () => names.map((name) => ({ name })),
    deleteDatabase(name) {
      const request = {};
      setTimeout(() => {
        if (blockFor.includes(name)) { request.onblocked?.(); return; }
        deleted.push(name);
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
}

function world(extra = {}) {
  const local = store({ cipher_vault: 'SECRET', cipher_db_owner: 'aa'.repeat(32), cipher_vaults: JSON.stringify({ [`bb`.repeat(32)]: {} }) });
  const session = store({ cipher_session_sk: '[1]' });
  const idb = fakeIndexedDB(['Other']);
  const cacheNames = ['c1', 'c2'];
  const cacheDeleted = [];
  let unregistered = 0;
  let reloads = 0;
  return {
    local, session, idb, cacheDeleted,
    reloads: () => reloads,
    unregistered: () => unregistered,
    env: {
      log: quiet,
      localStorage: local,
      sessionStorage: session,
      indexedDB: idb,
      serviceWorker: { getRegistrations: async () => [{ unregister: async () => { unregistered += 1; } }] },
      caches: { keys: async () => cacheNames, delete: async (n) => { cacheDeleted.push(n); } },
      reload: () => { reloads += 1; },
      ...extra,
    },
  };
}

test('a clean wipe deletes every database, storage, caches and workers, then reloads once', async () => {
  const w = world();
  const { failures } = await runPanicWipe(w.env);
  assert.deepEqual(failures, []);
  assert.deepEqual(w.idb.deleted.sort(), [`CipherDB_v7_${'aa'.repeat(8)}`, `CipherDB_v7_${'bb'.repeat(8)}`, 'Other'].sort());
  assert.deepEqual(w.local.data, {});
  assert.deepEqual(w.session.data, {});
  assert.deepEqual(w.cacheDeleted, ['c1', 'c2']);
  assert.equal(w.unregistered(), 1);
  assert.equal(w.reloads(), 1);
});

test('a stop step that throws or rejects does not skip a single deletion', async () => {
  const w = world();
  w.env.stop = [
    async () => { throw new Error('injected: dynamic import failed'); },
    () => { throw new Error('injected: sync throw'); },
    async () => { w.stopRan = true; },
  ];
  const { failures } = await runPanicWipe(w.env);
  assert.equal(failures.length, 2);
  assert.equal(w.stopRan, true);
  assert.equal(w.idb.deleted.length, 3);
  assert.deepEqual(w.local.data, {});
  assert.deepEqual(w.session.data, {});
  assert.deepEqual(w.cacheDeleted, ['c1', 'c2']);
  assert.equal(w.unregistered(), 1);
  assert.equal(w.reloads(), 1);
});

test('a stop step that never answers is cut off and the wipe still completes', async () => {
  const w = world();
  w.env.stop = [() => new Promise(() => {})];
  const started = Date.now();
  const { failures } = await runPanicWipe(w.env);
  assert.ok(Date.now() - started < 4000);
  assert.deepEqual(failures, ['stop 1']);
  assert.equal(w.idb.deleted.length, 3);
  assert.deepEqual(w.local.data, {});
  assert.equal(w.reloads(), 1);
});

test('storage is cleared even when every other step fails', async () => {
  const w = world();
  w.env.stop = [async () => { throw new Error('x'); }];
  w.env.indexedDB = { databases: async () => { throw new Error('no'); }, deleteDatabase: () => { throw new Error('no'); } };
  w.env.serviceWorker = { getRegistrations: async () => { throw new Error('no'); } };
  w.env.caches = { keys: async () => { throw new Error('no'); } };
  const { failures } = await runPanicWipe(w.env);
  assert.ok(failures.includes('delete databases'));
  assert.ok(failures.includes('service workers'));
  assert.ok(failures.includes('caches'));
  assert.deepEqual(w.local.data, {});
  assert.deepEqual(w.session.data, {});
  assert.equal(w.reloads(), 1);
});

test('a blocked database delete is reported and the rest still goes', async () => {
  const w = world();
  w.env.indexedDB = fakeIndexedDB(['Stuck', 'Fine'], { blockFor: ['Stuck'] });
  const { failures } = await runPanicWipe(w.env);
  assert.deepEqual(failures, ['delete databases']);
  assert.ok(w.env.indexedDB.deleted.includes('Fine'));
  assert.deepEqual(w.local.data, {});
  assert.deepEqual(w.cacheDeleted, ['c1', 'c2']);
  assert.equal(w.reloads(), 1);
});

test('a localStorage that throws on clear does not stop the database deletions', async () => {
  const w = world();
  w.env.localStorage = { getItem: w.local.getItem, clear: () => { throw new Error('quota'); } };
  const { failures } = await runPanicWipe(w.env);
  assert.ok(failures.includes('clear localStorage'));
  assert.equal(w.idb.deleted.length, 3);
  assert.deepEqual(w.session.data, {});
  assert.equal(w.reloads(), 1);
});

test('a reload that throws still resolves, and the wipe reports it', async () => {
  const w = world();
  w.env.reload = () => { throw new Error('nope'); };
  const { failures } = await runPanicWipe(w.env);
  assert.deepEqual(failures, ['reload']);
});
