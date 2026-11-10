import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { clearSessionKey, getSessionKey, setSessionKey } from './sessionKey.js';
import { atRestSecretBytes, openMessageRow, isSealedRow, trySealMessageRow } from './messageAtRest.js';

// fix 4: the raw account secret used to be written to sessionStorage, so a
// reload silently restored the session while a second copy of the raw key sat
// in storage. It lives in memory now; boot has no key, so a reload unlocks
// again. These tests drive the module and prove the at-rest seal follows it.

const key = (seed = 0) => Uint8Array.from({ length: 32 }, (_, i) => (i + seed) & 255);

test('the session key is memory only: set, read, clear', () => {
  clearSessionKey();
  assert.equal(getSessionKey(), null, 'a fresh boot has no key');
  const sk = key();
  setSessionKey(sk);
  assert.deepEqual(getSessionKey(), sk);
  // A copy is kept, so later mutation of the source does not rewrite it.
  sk[0] = 99;
  assert.equal(getSessionKey()[0], 0);
  clearSessionKey();
  assert.equal(getSessionKey(), null, 'lock and wipe leave nothing behind');
});

test('a reload with no key reads as locked and the account must unlock again', () => {
  setSessionKey(key());
  assert.ok(atRestSecretBytes(), 'unlocked');
  // A reload drops the module state; the test simulates it by clearing.
  clearSessionKey();
  assert.equal(getSessionKey(), null);
  assert.equal(atRestSecretBytes(), null, 'boot is locked until unlock sets it again');
});

test('at-rest sealing follows the in-memory key, never sessionStorage', async () => {
  clearSessionKey();
  setSessionKey(key(1));
  const row = await trySealMessageRow({
    id: 'm1', chatId: 'dm:peer', timestamp: 1, isSender: false,
    data: { type: 'text', message: 'hi' }, deliveryStatus: 'sent',
  });
  assert.ok(isSealedRow(row), 'the row is sealed with the in-memory key');
  assert.equal((await openMessageRow(row)).data.message, 'hi', 'and opens while unlocked');
  // Locked: the sealed payload is gone even though the stored row is intact.
  clearSessionKey();
  const locked = await openMessageRow(row);
  assert.equal(locked.id, 'm1');
  assert.equal(locked.data, undefined, 'a locked device cannot read sealed rows');
  // Unlock again: the same in-memory key opens it.
  setSessionKey(key(1));
  assert.equal((await openMessageRow(row)).data.message, 'hi');
  clearSessionKey();
});

test('useIdentity keeps the secret in memory and clears it on lock and wipe', () => {
  const src = fs.readFileSync(new URL('../useIdentity.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /cipher_session_sk/, 'the localStorage/sessionStorage key is gone');
  assert.doesNotMatch(src, /sessionStorage\.(setItem|removeItem|getItem)\('cipher_session_sk'/, 'no raw-secret storage writes remain');
  assert.match(src, /import \{ clearSessionKey, getSessionKey, setSessionKey \} from '\.\/lib\/sessionKey'/, 'the memory helpers are imported');
  // Lock retires the per-tab context; its invalidation callback clears the
  // in-memory key. The panic wipe clears it as its first step too.
  assert.match(src, /const lockApp = async \(\) => \{\s*const retirement = await retireCurrentContext\('local-lock'\)/);
  assert.match(src, /const retireCurrentContext = async \(reason = 'local-lock'\) => \{[\s\S]*?fence\.invalidate\(reason\)[\s\S]*?else \{\s*clearSessionKey\(\)/);
  assert.match(src, /const onContextInvalidated = \(context\) => \{[\s\S]*?clearSessionKey\(\)/);
  assert.match(src, /runPanicWipe\(\{[\s\S]{0,400}?stop: \[[\s\S]{0,300}?clearSessionKey\(\)/, 'the wipe clears the in-memory key');
});
