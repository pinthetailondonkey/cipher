import assert from 'node:assert/strict';
import test from 'node:test';
import { publishWriteAhead } from './outbox.js';

const event = { id: 'evt-wa', kind: 4, created_at: 5, content: 'x' };

function fakeStore() {
  const rows = new Map();
  return {
    rows,
    enqueue: async (ev, relays) => { rows.set(ev.id, { ev, relays }); },
    unqueue: async (id) => { rows.delete(id); },
  };
}

test('the signed event is in the outbox before the first publish is attempted', async () => {
  const store = fakeStore();
  let rowsAtPublish = -1;
  await publishWriteAhead(event, ['wss://a'], () => {
    rowsAtPublish = store.rows.size;
    return [Promise.resolve('ok')];
  }, store);
  assert.equal(rowsAtPublish, 1);
});

test('a crash during publish leaves the row behind to be retried', async () => {
  const store = fakeStore();
  // The publish never settles: the app was closed mid-send.
  publishWriteAhead(event, null, () => [new Promise(() => {})], store);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.rows.has('evt-wa'), true);
});

test('the first relay accept removes the row, and the result is not queued', async () => {
  const store = fakeStore();
  const out = await publishWriteAhead(event, null, () => [Promise.reject(new Error('down')), Promise.resolve('ok')], store);
  assert.equal(out.queued, false);
  assert.equal(out.okCount, 1);
  assert.equal(store.rows.size, 0);
});

test('every relay refusing keeps the row and reports queued', async () => {
  const store = fakeStore();
  const out = await publishWriteAhead(event, null, () => [Promise.reject(new Error('a')), Promise.reject(new Error('b'))], store);
  assert.equal(out.queued, true);
  assert.equal(out.okCount, 0);
  assert.equal(store.rows.size, 1);
});

test('a publish that throws before any relay answers keeps the row', async () => {
  const store = fakeStore();
  const out = await publishWriteAhead(event, null, () => { throw new Error('no pool'); }, store);
  assert.equal(out.queued, true);
  assert.equal(store.rows.size, 1);
});

test('a write-ahead that fails still publishes, and queues again if every relay refuses', async () => {
  let calls = 0;
  const store = { enqueue: async () => { calls += 1; if (calls === 1) throw new Error('db closed'); }, unqueue: async () => {} };
  const ok = await publishWriteAhead(event, null, () => [Promise.resolve('ok')], store);
  assert.equal(ok.queued, false);
  calls = 0;
  const down = await publishWriteAhead(event, null, () => [Promise.reject(new Error('x'))], store);
  assert.equal(down.queued, true);
  assert.equal(calls, 2);
});

test('writeAhead:false keeps the old order for ephemeral signals: nothing queued unless every relay refuses', async () => {
  const store = fakeStore();
  let rowsAtPublish = -1;
  await publishWriteAhead(event, null, () => { rowsAtPublish = store.rows.size; return [Promise.resolve('ok')]; }, { ...store, writeAhead: false });
  assert.equal(rowsAtPublish, 0);
  assert.equal(store.rows.size, 0);
});
