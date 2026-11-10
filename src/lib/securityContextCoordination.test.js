import assert from 'node:assert/strict';
import test from 'node:test';
import 'fake-indexeddb/auto';
import {
  activateSharedSecurityContext, retireOwnerSharedSecurityContexts,
  retireSharedSecurityContext, withSharedSecurityContext,
} from './securityContextCoordination.js';

const owner = 'f'.repeat(64);
const context = (incarnation) => ({ owner, incarnation: incarnation.repeat(16) });
const fence = (value) => ({ context: value, assertCurrent() {} });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('lock retirement waits for a standalone authority transaction and blocks every later stale write', async () => {
  const active = context('a');
  await activateSharedSecurityContext(fence(active));
  let releaseWrite;
  let enteredWrite;
  const started = new Promise((resolve) => { enteredWrite = resolve; });
  const pendingWrite = new Promise((resolve) => { releaseWrite = resolve; });
  const effects = [];

  const writer = withSharedSecurityContext(fence(active), async () => {
    enteredWrite();
    await pendingWrite;
    effects.push('write-committed');
  });
  await started;
  let retirementFinished = false;
  const retirement = retireSharedSecurityContext(active, async () => {
    effects.push('account-db-and-allocator-retired');
    return { retired: true };
  }).then((result) => { retirementFinished = true; return result; });
  await tick();
  assert.equal(retirementFinished, false, 'retirement cannot pass an already-running standalone write');
  releaseWrite();
  await writer;
  assert.equal((await retirement).retired, true);
  assert.deepEqual(effects, ['write-committed', 'account-db-and-allocator-retired']);
  await assert.rejects(withSharedSecurityContext(fence(active), async () => effects.push('stale-write')),
    /durably retired/i);
  assert.deepEqual(effects, ['write-committed', 'account-db-and-allocator-retired']);
});

test('owner removal drains all incarnations while preserving unrelated-owner markers', async () => {
  const first = context('b');
  const second = context('c');
  const unrelated = { owner: '1'.repeat(64), incarnation: 'd'.repeat(32) };
  await Promise.all([first, second, unrelated].map((value) => activateSharedSecurityContext(fence(value))));
  const result = await retireOwnerSharedSecurityContexts(owner, async () => ({ retired: true }));
  assert.equal(result.retired, true);
  assert.equal(result.count, 2);
  await assert.rejects(withSharedSecurityContext(fence(first), async () => {}), /durably retired/i);
  await assert.rejects(withSharedSecurityContext(fence(second), async () => {}), /durably retired/i);
  assert.equal(await withSharedSecurityContext(fence(unrelated), async () => 'still active'), 'still active');
});

test('failed resource retirement retains the coordination marker for explicit retry', async () => {
  const active = context('e');
  await activateSharedSecurityContext(fence(active));
  const failed = await retireSharedSecurityContext(active, async () => ({ retired: false, error: 'database blocked' }));
  assert.equal(failed.retired, false);
  assert.equal(await withSharedSecurityContext(fence(active), async () => true), true);
});

test('a locally retired context cannot recreate its durable marker', async () => {
  const active = context('9');
  let current = true;
  const capturedFence = { context: active, assertCurrent() {
    if (!current) throw Object.assign(new Error('expired'), { code: 'SECURITY_CONTEXT_EXPIRED' });
  } };
  await activateSharedSecurityContext(capturedFence);
  assert.equal((await retireSharedSecurityContext(active, async () => ({ retired: true }))).retired, true);
  current = false;
  await assert.rejects(activateSharedSecurityContext(capturedFence), /expired/i);
  await assert.rejects(withSharedSecurityContext(capturedFence, async () => true), /expired/i);
});
