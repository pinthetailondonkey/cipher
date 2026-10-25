import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createShakeDetector, requestMotionAccess } from './shakeDetector.js';

const still = { x: 0, y: 9.8, z: 0 };
const jolt = { x: 30, y: -20, z: 15 };

function shake(feed, start, readings, step = 100) {
  return readings.map((reading, index) => feed(reading, start + index * step));
}

test('three hard jolts inside a second wipe; fewer, slower, or before arming do not', () => {
  // Each change between still and jolt is one spike, so the fourth reading is the third spike.
  const feed = createShakeDetector({ armAt: 0 });
  assert.deepEqual(shake(feed, 10_000, [still, jolt, still, jolt]), [false, false, false, true]);

  const two = createShakeDetector({ armAt: 0 });
  assert.deepEqual(shake(two, 0, [still, jolt, still]), [false, false, false]);

  const armed = createShakeDetector({ armAt: 1000 });
  assert.deepEqual(shake(armed, 0, [still, jolt, still, jolt]), [false, false, false, false]);

  const slow = createShakeDetector({ armAt: 0 });
  assert.equal(shake(slow, 0, [still, { x: 1, y: 9, z: 1 }, still, { x: 2, y: 9, z: 0 }, still]).some(Boolean), false);

  // Spikes more than a second apart start the count again.
  const spread = createShakeDetector({ armAt: 0 });
  assert.equal(shake(spread, 0, [still, jolt, still, jolt, still], 1300).some(Boolean), false);
});

test('motion access follows what the platform answers', async () => {
  const original = globalThis.DeviceMotionEvent;
  try {
    delete globalThis.DeviceMotionEvent;
    assert.equal(await requestMotionAccess(), 'unsupported');
    globalThis.DeviceMotionEvent = function DeviceMotionEvent() {};
    assert.equal(await requestMotionAccess(), 'granted');
    globalThis.DeviceMotionEvent.requestPermission = async () => 'denied';
    assert.equal(await requestMotionAccess(), 'denied');
    globalThis.DeviceMotionEvent.requestPermission = async () => { throw new Error('not from a tap'); };
    assert.equal(await requestMotionAccess(), 'denied');
  } finally {
    if (original) globalThis.DeviceMotionEvent = original;
    else delete globalThis.DeviceMotionEvent;
  }
});

test('a setting turns shake to wipe on, and the app listens only then', async () => {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
    key: (index) => Array.from(memory.keys())[index] ?? null,
    get length() { return memory.size; },
  };
  const { useChatStore } = await import('../store/chatStore.js');
  assert.equal(useChatStore.getState().panicWipeEnabled, false);
  useChatStore.getState().setPanicWipeEnabled(true);
  assert.equal(useChatStore.getState().panicWipeEnabled, true);
  assert.equal(localStorage.getItem('cipher_panic_wipe'), 'true');
  useChatStore.getState().setPanicWipeEnabled(false);
  assert.equal(localStorage.getItem('cipher_panic_wipe'), 'false');

  const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(read('../components/chat/PrivacySettings.jsx'), /label="Shake to wipe"[^\n]*onChange=\{togglePanicWipe\}/);
  assert.match(read('../components/chat/PrivacySettings.jsx'), /setPanicWipeEnabled\(true\)/);
  assert.match(read('../App.jsx'), /usePanicWipe\(identity, panicWipeEnabled\)/);
  const hook = read('../hooks/usePanicWipe.js');
  assert.match(hook, /if \(!enabled\) return;/);
  assert.match(hook, /if \(shaken\(event\.accelerationIncludingGravity \|\| event\.acceleration\)\) triggerWipe\(\);/);
});
