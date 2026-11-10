import assert from 'node:assert/strict';
import test from 'node:test';
import { PAST_EPOCH_RETENTION, createRetentionWrapper } from './pastEpochRetention.js';

test('keys inside the retention window decrypt; keys beyond it are destroyed', async () => {
  const w = createRetentionWrapper({});
  for (let e = 0; e <= 6; e += 1) w.advanceEpoch(e, `key-${e}`);
  assert.equal(w.currentEpoch, 6);
  await assert.ok(await w.decrypt(6));
  await assert.ok(await w.decrypt(6 - PAST_EPOCH_RETENTION + 1)); // epoch 3 retained
  // Epochs at or below 6 - 4 = 2 are wiped.
  assert.equal(w.has(2), false);
  await assert.rejects(() => w.decrypt(2), /destroyed/);
});

test('decryption of an out-of-window epoch fails hard, never falls back', async () => {
  const w = createRetentionWrapper({ retention: 2 });
  for (let e = 0; e <= 5; e += 1) w.advanceEpoch(e, `key-${e}`);
  assert.equal(w._keyCount(), 2); // 4 and 5 within the two-epoch window
  await assert.rejects(() => w.decrypt(0));
});

test('a returning device inside the window can chain-replay', () => {
  const w = createRetentionWrapper({});
  for (let e = 0; e <= 4; e += 1) w.advanceEpoch(e, `key-${e}`);
  assert.equal(w.canChainReplay(3), true);
  assert.equal(w.canChainReplay(0), false); // snapshot at the boundary is a gap
});

test('the default retention value is the documented profile constant', () => {
  const w = createRetentionWrapper({});
  assert.equal(w.retention, 4);
  assert.equal(PAST_EPOCH_RETENTION, 4);
});
