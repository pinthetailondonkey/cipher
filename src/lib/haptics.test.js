import assert from 'node:assert/strict';
import test from 'node:test';
import { BUZZ_HAPTIC, buzzHaptic, haptic } from './haptics.js';

function withVibrate(run) {
  const calls = [];
  const original = globalThis.navigator;
  globalThis.navigator = { vibrate: (pattern) => { calls.push(pattern); return true; } };
  try { run(calls); } finally {
    if (original === undefined) delete globalThis.navigator;
    else globalThis.navigator = original;
  }
}

test('haptic maps styles to vibration patterns', () => {
  withVibrate((calls) => {
    haptic('light');
    haptic('medium');
    haptic('heavy');
    haptic('error');
    haptic('none-such'); // unknown styles stay silent
    assert.deepEqual(calls, [10, 25, [50, 30, 50], [50, 50, 50, 50]]);
  });
});

test('buzzHaptic keys off the buzz tags: msg and order heavy, call the ring pattern', () => {
  withVibrate((calls) => {
    buzzHaptic('msg');
    buzzHaptic('order');
    buzzHaptic('call');
    // Anything the tag engine does not stamp buzzes nothing.
    buzzHaptic(null);
    buzzHaptic(undefined);
    buzzHaptic('typing');
    assert.deepEqual(calls, [
      [50, 30, 50],
      [50, 30, 50],
      [300, 150, 300],
    ]);
  });
});

test('BUZZ_HAPTIC names the pattern per tag', () => {
  assert.deepEqual(BUZZ_HAPTIC, { msg: 'heavy', order: 'heavy', call: 'ring' });
});
