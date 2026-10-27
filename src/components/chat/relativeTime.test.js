import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRelativeTime } from './relativeTime.js';

const now = new Date('2026-10-26T12:00:00Z').getTime();

test('seconds-old messages read "now"', () => {
  assert.equal(formatRelativeTime(now / 1000 - 5, now), 'now');
  assert.equal(formatRelativeTime(now, now), 'now');
  assert.equal(formatRelativeTime(now / 1000, now), 'now'); // future clamps
});

test('under an hour reads minutes', () => {
  assert.equal(formatRelativeTime(now - 60_000, now), '1m');
  assert.equal(formatRelativeTime(now - 59 * 60_000, now), '59m');
});

test('under a day reads hours', () => {
  assert.equal(formatRelativeTime(now - 3_600_000, now), '1h');
  assert.equal(formatRelativeTime(now - 23 * 3_600_000, now), '23h');
});

test('inside the week reads the weekday', () => {
  // Monday 12:00 before a Monday 12:00 now: exactly 7 days = the edge.
  const monday = now - 7 * 86_400_000 + 60_000;
  const label = formatRelativeTime(monday, now);
  assert.equal(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].includes(label), true);
  // Nostr seconds and donated milliseconds agree.
  assert.equal(formatRelativeTime(monday / 1000, now), label);
});

test('older reads month and day', () => {
  assert.equal(formatRelativeTime(now - 8 * 86_400_000, now), 'Oct 18');
  assert.equal(formatRelativeTime(new Date('2026-01-05T10:00:00Z').getTime(), now), 'Jan 5');
});

test('absent and zero timestamps label empty', () => {
  assert.equal(formatRelativeTime(null, now), '');
  assert.equal(formatRelativeTime(0, now), '');
});
