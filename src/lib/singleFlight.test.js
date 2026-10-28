import test from 'node:test';
import assert from 'node:assert/strict';
import { createSingleFlight } from './singleFlight.js';

// A double tap on Buy posts one order request, not two. The second press is
// dropped while the first is in flight, and a run that fails does not leave
// the button locked out.

test('a second call while the first is in flight runs nothing', async () => {
  const run = createSingleFlight();
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = run(async () => { calls += 1; await gate; return 'first'; });
  const second = await run(async () => { calls += 1; return 'second'; });
  assert.equal(second, undefined);
  release();
  assert.equal(await first, 'first');
  assert.equal(calls, 1);
});

test('a failed run releases the guard', async () => {
  const run = createSingleFlight();
  const failed = await run(async () => { throw new Error('relay refused'); }).catch((e) => e.message);
  assert.equal(failed, 'relay refused');
  assert.equal(await run(async () => 'next'), 'next');
});

test('a rejected run releases the guard', async () => {
  const run = createSingleFlight();
  await run(async () => Promise.reject(new Error('timeout'))).catch(() => {});
  let ran = false;
  await run(async () => { ran = true; });
  assert.equal(ran, true);
});

test('sequential calls are not dropped', async () => {
  const run = createSingleFlight();
  const a = await run(async () => 1);
  const b = await run(async () => 2);
  assert.deepEqual([a, b], [1, 2]);
});
