import assert from 'node:assert/strict';
import { test } from 'node:test';
import React from 'react';
import useLongPress from './useLongPress.js';

// Drives the real hook through React's own dispatcher, so useRef, useCallback
// and useEffect run the code a mounted row runs — no DOM, no extra packages,
// pointer events as plain objects. React 19.3 keeps the dispatcher slot at
// `H` on the client internals; if a React upgrade reshapes it, the assert
// below fails loudly instead of the harness silently testing nothing.
const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
  || React.__CLIENT_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;

// A minimal renderer: refs and callbacks keep one slot table each across
// renders (as React does for a stable hook order), effects run on commit,
// cleanups armed for unmount — the lifecycle a row goes through.
const mountHook = (onLongPress) => {
  assert.ok(internals, 'React internals moved — update this harness to drive the real hook');
  const refs = [];
  const callbacks = [];
  const pendingEffects = [];
  const cleanups = [];
  const render = (callback) => {
    let refSlot = 0;
    let callbackSlot = 0;
    const previousDispatcher = internals.H;
    internals.H = {
      useRef: (initial) => {
        if (refSlot >= refs.length) refs.push({ current: initial });
        return refs[refSlot++];
      },
      useCallback: (factory) => {
        if (callbackSlot >= callbacks.length) callbacks.push(factory);
        return callbacks[callbackSlot++];
      },
      useEffect: (effect) => {
        pendingEffects.push(effect);
      },
    };
    try {
      // oxlint-disable-next-line react-hooks/rules-of-hooks
      return useLongPress(callback);
    } finally {
      internals.H = previousDispatcher;
    }
  };
  const commit = () => {
    for (const effect of pendingEffects.splice(0)) cleanups.push(effect());
  };
  const props = render(onLongPress);
  commit();
  return {
    props,
    render,
    commit,
    unmount: () => {
      for (const cleanup of cleanups.splice(0)) cleanup?.();
    },
  };
};

// Pointer events as plain objects, only the fields the hook reads.
const down = (x = 0, y = 0) => ({ clientX: x, clientY: y, button: 0, isPrimary: true });
const move = (x, y) => ({ clientX: x, clientY: y, isPrimary: true });

test('a press fires exactly at 500ms and hands over the press event', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const { props } = mountHook((event) => calls.push(event));
  props.onPointerDown(down(10, 20));
  t.mock.timers.tick(499);
  assert.equal(calls.length, 0, '499ms is still holding, not a press');
  t.mock.timers.tick(1);
  assert.equal(calls.length, 1, 'the 500th tick is the press');
  assert.equal(calls[0].clientX, 10, 'the press carries the event it started from');
});

test('a 7px drift keeps the press; an 8px travel cancels it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const patient = [];
  const held = mountHook(() => patient.push('held'));
  held.props.onPointerDown(down());
  held.props.onPointerMove(move(7, 3));
  t.mock.timers.tick(500);
  assert.deepEqual(patient, ['held'], '58px of squared travel is under the 8px line, so the press stands');

  t.mock.timers.reset();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cancelled = [];
  const dragged = mountHook(() => cancelled.push('fired'));
  dragged.props.onPointerDown(down());
  dragged.props.onPointerMove(move(8, 0));
  t.mock.timers.tick(1000);
  assert.deepEqual(cancelled, [], '8px of travel cancels the press, even after the full 500ms');
});

test('a lift before 500ms gives up the press', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const { props } = mountHook(() => calls.push('fired'));
  props.onPointerDown(down());
  t.mock.timers.tick(300);
  props.onPointerUp();
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, [], 'a lifted finger is not a press');
});

test('a system cancel gives up the press', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const { props } = mountHook(() => calls.push('fired'));
  props.onPointerDown(down());
  t.mock.timers.tick(300);
  props.onPointerCancel();
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, [], 'a cancelled pointer is not a press');
});

test('a second press restarts the clock instead of stacking a second timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const { props } = mountHook(() => calls.push('fired'));
  props.onPointerDown(down());
  t.mock.timers.tick(400);
  props.onPointerDown(down());
  t.mock.timers.tick(400);
  assert.deepEqual(calls, [], '400ms since the restart is still holding');
  t.mock.timers.tick(100);
  assert.deepEqual(calls, ['fired'], 'the press fires once, on the restarted clock');
});

test('an unmounted row never fires its pending press', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const mounted = mountHook(() => calls.push('late'));
  mounted.props.onPointerDown(down());
  mounted.unmount();
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, [], 'the timer died with the component');
});

test('the press fires the callback the last render handed it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const seen = [];
  const mounted = mountHook(() => seen.push('stale'));
  mounted.render(() => seen.push('fresh'));
  mounted.commit();
  mounted.props.onPointerDown(down());
  t.mock.timers.tick(500);
  assert.deepEqual(seen, ['fresh'], 'a re-render between mount and press swaps the callback in');
});

test('a second finger or a right-click never starts a press', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const { props } = mountHook(() => calls.push('fired'));
  props.onPointerDown({ clientX: 0, clientY: 0, button: 0, isPrimary: false });
  props.onPointerDown({ clientX: 0, clientY: 0, button: 2, isPrimary: true });
  t.mock.timers.tick(1000);
  assert.deepEqual(calls, [], 'only the primary pointer starts a press');
});
