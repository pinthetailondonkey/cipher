import test from 'node:test';
import assert from 'node:assert/strict';
import { readDirectory, whyUnavailable, READ_OK, READ_UNAVAILABLE } from './relayDirectoryRead.js';

const FILTER = { kinds: [39000, 9002], limit: 50 };
const URL = 'wss://groups.example.test';

// The shape a real pool has. `behaviour` says what the relay does.
function fakePool(behaviour) {
  return {
    closed: [],
    destroyed: false,
    async ensureRelay() {
      if (behaviour === 'refuse') throw new Error('WebSocket connection to the relay failed');
      return {
        subscribe(_filters, params) {
          let closed = false;
          const closer = { close(reason) { closed = true; params.onclose?.(reason || 'closed'); } };
          if (behaviour === 'eose') queueMicrotask(() => params.oneose?.());
          if (behaviour === 'eose-with-events') {
            queueMicrotask(() => {
              params.onevent?.({ id: 'a', kind: 39000, tags: [] });
              params.oneose?.();
            });
          }
          if (behaviour === 'auth') queueMicrotask(() => params.onclose?.('auth-required: we need an AUTH event'));
          if (behaviour === 'silent') { /* never answers */ }
          return closer;
        },
      };
    },
    close(urls) { this.closed.push(...urls); },
    destroy() { this.destroyed = true; },
  };
}

test('a relay that will not connect is unavailability, not an empty directory', async () => {
  const pool = fakePool('refuse');
  const result = await readDirectory([URL], FILTER, { createPool: () => pool });
  // The old code resolved [] here and the screen said the network was empty.
  assert.equal(result.status, READ_UNAVAILABLE);
  assert.deepEqual(result.events, []);
  assert.equal(result.answers[0].status, 'unreachable');
  assert.equal(pool.destroyed, true);
});

test('a completed read with no events is an empty directory', async () => {
  const result = await readDirectory([URL], FILTER, { createPool: () => fakePool('eose') });
  assert.equal(result.status, READ_OK);
  assert.deepEqual(result.events, []);
});

test('a completed read keeps the events it was sent', async () => {
  const result = await readDirectory([URL], FILTER, { createPool: () => fakePool('eose-with-events') });
  assert.equal(result.status, READ_OK);
  assert.equal(result.events.length, 1);
});

test('a subscription refusal proves nothing', async () => {
  const result = await readDirectory([URL], FILTER, { createPool: () => fakePool('auth') });
  assert.equal(result.status, READ_UNAVAILABLE);
  assert.match(whyUnavailable(result.answers), /prove itself/);
});

test('a relay that never answers is unavailability at the deadline', async () => {
  const started = Date.now();
  const result = await readDirectory([URL], FILTER, { timeoutMs: 60, createPool: () => fakePool('silent') });
  assert.equal(result.status, READ_UNAVAILABLE);
  assert.equal(result.answers[0].status, 'timeout');
  assert.ok(Date.now() - started < 2000, 'the read is bounded, not left hanging');
});

test('one answering relay is enough, and events from the other are kept', async () => {
  const pool = {
    ensureRelay: async (url) => ({
      subscribe(_filters, params) {
        if (url === 'wss://dead.test') return { close() {} };
        queueMicrotask(() => { params.onevent?.({ id: url, kind: 39000, tags: [] }); params.oneose?.(); });
        return { close() {} };
      },
    }),
    close() {},
    destroy() {},
  };
  const result = await readDirectory([URL, 'wss://dead.test'], FILTER, { timeoutMs: 200, createPool: () => pool });
  assert.equal(result.status, READ_OK);
  assert.equal(result.events.length, 1);
});

test('no configured relay is its own unavailable answer', async () => {
  const result = await readDirectory([], FILTER, {});
  assert.equal(result.status, READ_UNAVAILABLE);
  assert.match(whyUnavailable(result.answers), /No relay/);
});

test('events from a relay whose read never completed are not published', async () => {
  const pool = {
    ensureRelay: async () => ({
      subscribe(_filters, params) {
        // Events arrive, then the relay closes without ever saying EOSE.
        params.onevent?.({ id: 'partial', kind: 39000, tags: [] });
        queueMicrotask(() => params.onevent?.({ id: 'partial-2', kind: 39000, tags: [] }));
        return { close() {} };
      },
    }),
    close() {},
    destroy() {},
  };
  const result = await readDirectory([URL], FILTER, { timeoutMs: 80, createPool: () => pool });
  assert.equal(result.status, READ_UNAVAILABLE);
  assert.deepEqual(result.events, []);
});
