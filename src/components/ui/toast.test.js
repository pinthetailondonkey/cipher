import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { pushToast, dropToast, queued } from './toast.js';

// The queue is module state shared by every test below, so each one starts
// from an empty slate. queued() is the same view the renderer reads, so the
// assertions watch what the screen would show, not module internals.
const clearQueue = () => {
  for (const entry of queued()) dropToast(entry.id);
};

after(clearQueue);

test('a repeat of a live message replaces its banner instead of stacking', () => {
  clearQueue();
  const first = pushToast({ type: 'success', message: 'Copied!' });
  const second = pushToast({ type: 'success', message: 'Copied!' });
  const live = queued();
  assert.equal(live.length, 1, 'the same message must not stack a second banner');
  assert.equal(live[0].id, second, 'the live banner is the newest push');
  assert.notEqual(live[0].id, first, 'the displaced push is gone from the queue');
});

test('distinct messages still stack', () => {
  clearQueue();
  pushToast({ type: 'success', message: 'Copied!' });
  pushToast({ type: 'error', message: 'Could not copy.' });
  const messages = queued().map((entry) => entry.message);
  assert.deepEqual(messages, ['Copied!', 'Could not copy.']);
});

test('the queue is capped when more distinct messages than the cap land', () => {
  clearQueue();
  const pushed = ['one', 'two', 'three', 'four', 'five'].map((message) => pushToast({ type: 'info', message }));
  const live = queued();
  assert.equal(live.length, 3, 'the tower never grows past three banners');
  assert.deepEqual(live.map((entry) => entry.message), ['three', 'four', 'five'], 'the oldest banners fall off first');
  assert.equal(live.at(-1).id, pushed.at(-1), 'the newest banner stays live');
});
