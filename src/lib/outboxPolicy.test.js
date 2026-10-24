import assert from 'node:assert/strict';
import test from 'node:test';
import { outboxRow, settleOutboxAttempt, shouldFlushOutboxRow } from './outbox.js';

test('enqueue identity is the event id, so a second put does not create another row', () => {
  const event = { id: 'evt-1', kind: 1, created_at: 50, content: 'hi' };
  const store = new Map();
  const put = (row) => store.set(row.id, row);
  put(outboxRow(event, 1_000));
  put(outboxRow(event, 2_000));
  assert.equal(store.size, 1);
  assert.equal(store.get('evt-1').attempts, 0);
  assert.equal(store.get('evt-1').status, 'queued');
  assert.equal(store.get('evt-1').event, event);
});

test('flush waits for nextRetryAt unless forced, and a reject backs off inside the existing cap', () => {
  const queued = outboxRow({ id: 'evt-2', kind: 9, created_at: 1 }, 0);
  assert.equal(shouldFlushOutboxRow(queued, 10, false), true);
  assert.equal(shouldFlushOutboxRow({ ...queued, nextRetryAt: 500 }, 499, false), false);
  assert.equal(shouldFlushOutboxRow({ ...queued, nextRetryAt: 500 }, 500, false), true);
  assert.equal(shouldFlushOutboxRow({ ...queued, nextRetryAt: 500 }, 1, true), true);

  const samples = [];
  for (let i = 0; i < 40; i += 1) {
    const settled = settleOutboxAttempt({ attempts: 0 }, { accepted: false, now: 1_000_000, error: 'x'.repeat(800) });
    assert.equal(settled.action, 'update');
    assert.equal(settled.patch.attempts, 1);
    assert.equal(settled.patch.status, 'failed');
    assert.equal(settled.patch.lastError.length, 500);
    samples.push(settled.patch.nextRetryAt - 1_000_000);
  }
  assert.ok(samples.every((delay) => delay >= 1600 && delay <= 2400));

  const capped = settleOutboxAttempt({ attempts: 20 }, { accepted: false, now: 0, error: 'relay down' });
  const cappedDelay = capped.patch.nextRetryAt;
  assert.ok(cappedDelay >= 240_000 && cappedDelay <= 360_000);

  const accepted = settleOutboxAttempt({ attempts: 3 }, { accepted: true, now: 10 });
  assert.deepEqual(accepted, { action: 'delete' });
});
