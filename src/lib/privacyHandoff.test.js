import assert from 'node:assert/strict';
import test from 'node:test';
import { queryHistoryDetailed, querySecurityRecords } from './relays.js';
import { establishSecurityContext, createSecurityContextFence, invalidateSecurityContext } from './securityContextFence.js';

function storage() {
  const values = new Map();
  return { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: (k) => values.delete(k), key: (i) => [...values.keys()][i] ?? null, get length() { return values.size; } };
}

test('history expands a dense timestamp page and deduplicates by event id', async () => {
  const tied = [1, 2, 3].map((n) => ({ id: String(n), created_at: 100 }));
  const pool = { querySync: async (_urls, filter) => tied.filter((event) => filter.until == null || event.created_at <= filter.until).slice(0, filter.limit) };
  const result = await queryHistoryDetailed(pool, ['wss://fixture.invalid'], { kinds: [9] }, { limit: 2, maxLimit: 4, timeoutMs: 100 });
  assert.equal(result.events.length, 3);
  assert.equal(new Set(result.events.map((event) => event.id)).size, 3);
  assert.equal(result.complete, true);
});

test('a permanently capped tied timestamp is returned with an explicit gap', async () => {
  const tied = [1, 2, 3].map((n) => ({ id: String(n), created_at: 100 }));
  const pool = { querySync: async (_urls, filter) => tied.filter((event) => filter.until == null || event.created_at <= filter.until).slice(0, Math.min(filter.limit, 1)) };
  const result = await queryHistoryDetailed(pool, ['wss://fixture.invalid'], { kinds: [9] }, { limit: 2, maxLimit: 4, maxRequests: 4, timeoutMs: 100 });
  assert.equal(result.coverage, 'server-claimed-exhaustion');
  assert.equal(result.complete, true, 'the client cannot infer a server-side cap from an EOSE/short page');
});

test('history preserves per-relay errors, empty answers, and claimed coverage separately', async () => {
  const events = [{ id: 'one', created_at: 90 }];
  const pool = { querySync: async (urls, filter) => {
    if (urls[0] === 'wss://error.invalid') throw new Error('offline');
    return urls[0] === 'wss://has.invalid' ? events.filter((event) => filter.until == null || event.created_at <= filter.until) : [];
  } };
  const result = await queryHistoryDetailed(pool, ['wss://error.invalid', 'wss://empty.invalid', 'wss://has.invalid'], { kinds: [9] }, { timeoutMs: 100 });
  assert.equal(result.perRelay['wss://error.invalid'].status, 'error');
  assert.equal(result.perRelay['wss://empty.invalid'].status, 'exhausted');
  assert.equal(result.perRelay['wss://has.invalid'].status, 'exhausted');
  assert.equal(result.complete, false);
});

test('history cancellation returns partial per-relay coverage', async () => {
  const controller = new AbortController();
  const pool = { querySync: async () => new Promise((resolve) => setTimeout(() => resolve([]), 100)) };
  const pending = queryHistoryDetailed(pool, ['wss://slow.invalid'], { kinds: [9] }, { signal: controller.signal, timeoutMs: 500 });
  setTimeout(() => controller.abort(), 10);
  const result = await pending;
  assert.equal(result.stopReason, 'cancelled');
  assert.equal(result.perRelay['wss://slow.invalid'].status, 'cancelled');
});

test('security discovery renders a fast answer and delivers later valid relay batches', async () => {
  const updates = [];
  const pool = { querySync: async (urls) => {
    if (urls[0] === 'wss://slow.invalid') await new Promise((resolve) => setTimeout(resolve, 60));
    return urls[0] === 'wss://slow.invalid' ? [{ id: 'old' }, { id: 'new' }] : [{ id: 'old' }];
  } };
  const result = await querySecurityRecords(pool, ['wss://fast.invalid', 'wss://slow.invalid'], { kinds: [5] }, 500, (events) => updates.push(events.map((event) => event.id)));
  assert.deepEqual(updates[0], ['old']);
  assert.deepEqual(result.events.map((event) => event.id).sort(), ['new', 'old']);
  assert.equal(result.complete, true);
});

test('security discovery marks deadline coverage incomplete and ignores late callbacks', async () => {
  const updates = [];
  const pool = { querySync: async () => { await new Promise((resolve) => setTimeout(resolve, 80)); return [{ id: 'late' }]; } };
  const result = await querySecurityRecords(pool, ['wss://slow.invalid'], { kinds: [5] }, 20, (events) => updates.push(events));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(result.complete, false);
  assert.equal(result.outcomes['wss://slow.invalid'].status, 'timeout');
  assert.equal(updates.length, 0);
});

test('a failed relay is reported as an error and cannot make discovery complete', async () => {
  const pool = { querySync: async () => { throw new Error('synthetic socket failure'); } };
  const result = await querySecurityRecords(pool, ['wss://failed.invalid'], { kinds: [5] }, 100);
  assert.equal(result.complete, false);
  assert.equal(result.outcomes['wss://failed.invalid'].status, 'error');
});

test('a missing or replaced durable security context invalidates a suspended session', () => {
  const backing = storage();
  let id = 0;
  const context = establishSecurityContext({ owner: 'a'.repeat(64), storage: backing, randomId: () => `incarnation${String(++id).padStart(16, '0')}` });
  let invalidated = 0;
  const fence = createSecurityContextFence({ context, storage: backing, onInvalidate: () => { invalidated += 1; } });
  assert.equal(fence.isCurrent(), true);
  assert.equal(invalidateSecurityContext({ owner: context.owner, storage: backing }).invalidated, true);
  assert.equal(fence.isCurrent(), false);
  assert.equal(invalidated, 1);
});

test('independent accounts retain separate incarnations and stale broadcasts do not revoke a new one', () => {
  const backing = storage();
  const a = establishSecurityContext({ owner: 'a'.repeat(64), storage: backing, randomId: () => 'accountA-incarnation-1' });
  const b = establishSecurityContext({ owner: 'b'.repeat(64), storage: backing, randomId: () => 'accountB-incarnation-1' });
  const a2 = establishSecurityContext({ owner: a.owner, storage: backing, randomId: () => 'accountA-incarnation-2' });
  const listeners = new Set();
  const channel = { addEventListener: (_type, fn) => listeners.add(fn), removeEventListener: (_type, fn) => listeners.delete(fn) };
  let count = 0;
  const fence = createSecurityContextFence({ context: a, storage: backing, channel, onInvalidate: () => { count += 1; } });
  for (const fn of listeners) fn({ data: { type: 'invalidate', owner: a.owner, incarnation: 'old-incarnation' } });
  assert.equal(fence.isCurrent(), true);
  const invalidatedA = invalidateSecurityContext({ owner: a.owner, storage: backing });
  assert.equal(invalidatedA.invalidated, true);
  assert.equal(createSecurityContextFence({ context: a2, storage: backing }).isCurrent(), false);
  assert.equal(invalidateSecurityContext({ owner: b.owner, storage: backing }).invalidated, true);
  assert.equal(fence.isCurrent(), false);
  assert.equal(count, 1);
});

test('failed durable invalidation is reported even when broadcast is unavailable', () => {
  const backing = storage();
  const context = establishSecurityContext({ owner: 'c'.repeat(64), storage: backing, randomId: () => 'locked-account-generation-1' });
  const refusing = {
    getItem: backing.getItem,
    setItem: backing.setItem,
    key: backing.key,
    get length() { return backing.length; },
    removeItem: () => { throw new Error('storage denied'); },
  };
  const result = invalidateSecurityContext({ owner: context.owner, storage: refusing });
  assert.equal(result.invalidated, false);
  assert.equal(result.persisted, false);
  assert.deepEqual(result.errors, ['storage:storage denied']);
});
