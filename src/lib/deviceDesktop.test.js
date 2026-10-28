import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopProvider } from './deviceDesktop.js';
import { DeviceKeyMissing, DeviceKeyUnavailable, isDeviceKeyError } from './vaultEnvelope.js';

// The real bridge lives in the desktop preload; this fake records every ask
// and answers with the same {ok, ...} shapes the main process sends. One
// bridge at a time, installed for the body's whole run: two installs racing
// swap the same global under each other.
function withBridge(answers, body) {
  const calls = [];
  const bridge = new Proxy({}, {
    get(_target, ask) {
      return async (...args) => {
        calls.push([ask, ...args]);
        const answer = answers[ask];
        return typeof answer === 'function' ? answer(...args) : answer;
      };
    },
  });
  const before = globalThis.window;
  globalThis.window = { cipherDeviceKey: bridge };
  return Promise.resolve(body(calls)).finally(() => {
    if (before === undefined) delete globalThis.window;
    else globalThis.window = before;
  });
}

test('a page without the bridge has no desktop key, and that is not an error', async () => {
  const before = globalThis.window;
  delete globalThis.window;
  try {
    assert.equal(await desktopProvider.available(), false);
  } finally {
    if (before !== undefined) globalThis.window = before;
  }
});

test('available answers yes only when the desktop store can hold a key', async () => {
  await withBridge({ available: { ok: true } }, async () => {
    assert.equal(await desktopProvider.available(), true);
  });
  await withBridge({ available: { ok: false, code: 'basic-text' } }, async () => {
    assert.equal(await desktopProvider.available(), false);
  });
});

test('enroll, seal, open and destroy cross the bridge with the same shapes', () => withBridge({
  available: { ok: true },
  enroll: { ok: true, dk: { k: 'safe', id: 'cipher-devkey' } },
  seal: { ok: true, blob: { iv: [1, 2, 3], data: [4, 5, 6] } },
  open: { ok: true, bytes: new Uint8Array([7, 7, 7]) },
  destroy: { ok: true },
}, async (calls) => {
  const pk = 'ab'.repeat(32);
  const dk = await desktopProvider.enroll(pk);
  assert.deepEqual(dk, { k: 'safe', id: 'cipher-devkey' });
  const bytes = new Uint8Array([1]);
  const aad = new Uint8Array([2]);
  const blob = await desktopProvider.seal(pk, dk, bytes, aad);
  assert.deepEqual(blob, { iv: [1, 2, 3], data: [4, 5, 6] });
  const opened = await desktopProvider.open(pk, dk, blob, aad);
  assert.deepEqual(Array.from(opened), [7, 7, 7]);
  await desktopProvider.destroy(pk, dk);

  const byAsk = Object.fromEntries(calls.map(([ask, ...rest]) => [ask, rest]));
  assert.deepEqual(byAsk.enroll, [pk]);
  assert.deepEqual(byAsk.seal, [pk, 'cipher-devkey', bytes, aad]);
  assert.deepEqual(byAsk.open, [pk, 'cipher-devkey', blob, aad]);
  assert.equal(byAsk.destroy[0], pk);
}));

test('a store that cannot hold a key is unavailable, never a wrong PIN', async () => {
  await withBridge({ enroll: { ok: false, code: 'basic-text', message: 'no keyring' } }, async () => {
    const unavailable = await desktopProvider.enroll('ab'.repeat(32)).then(() => null, (e) => e);
    assert.ok(unavailable instanceof DeviceKeyUnavailable);
    assert.equal(unavailable.code, 'basic-text');
    assert.ok(isDeviceKeyError(unavailable));
  });
});

test('a lost device key is missing, never a wrong PIN', async () => {
  const pk = 'ab'.repeat(32);
  const answers = {
    seal: { ok: false, code: 'missing', message: 'gone' },
    open: { ok: false },
    destroy: { ok: false, code: 'unreadable', message: 'locked' },
  };
  await withBridge(answers, async () => {
    const missing = await desktopProvider.seal(pk, { id: 'x' }, new Uint8Array(), new Uint8Array()).then(() => null, (e) => e);
    assert.ok(missing instanceof DeviceKeyMissing);
    assert.equal(missing.code, 'missing');
    // No code at all still reads as missing, never as a wrong PIN.
    const bare = await desktopProvider.open(pk, { id: 'x' }, { iv: [], data: [] }, new Uint8Array()).then(() => null, (e) => e);
    assert.ok(bare instanceof DeviceKeyMissing);
    assert.equal(bare.code, 'missing');
    const unreadable = await desktopProvider.destroy(pk, { id: 'x' }).then(() => null, (e) => e);
    assert.ok(unreadable instanceof DeviceKeyUnavailable);
    assert.ok(isDeviceKeyError(unreadable));
  });
});
