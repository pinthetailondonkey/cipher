import assert from 'node:assert/strict';
import test from 'node:test';
import { clampGroupBody, clampedExpiresAt, rowExpired, rowExpiresAt } from './disappearing.js';

const dataRow = (seconds) => ({ data: { type: 'text', expires_at: seconds }, timestamp: 1000 });
const groupRow = (seconds, json) => ({ rawContent: json ?? JSON.stringify({ type: 'text', message: 'hi', expires_at: seconds }), data: { type: 'text', message: 'hi' }, timestamp: 1000 });

test('the carried stamp reads from a dm row, a group row, or not at all — malformed is no stamp', () => {
  assert.equal(rowExpiresAt(dataRow(2000)), 2000);
  assert.equal(rowExpiresAt(groupRow(3000)), 3000, 'the group row carries it in the rawContent JSON');
  assert.equal(rowExpiresAt(groupRow(null, JSON.stringify({ type: 'text', message: 'hi' }))), null, 'no stamp is not an expiry');
  assert.equal(rowExpiresAt(groupRow(null, '{not json')), null, 'malformed JSON is no stamp');
  assert.equal(rowExpiresAt(dataRow(-5)), null, 'a past-tense negative stamp is nothing to honor');
  assert.equal(rowExpiresAt(dataRow('2000')), 2000, 'a string stamp coerces');
  assert.equal(rowExpiresAt(dataRow('2000.5')), null, 'a fractionated stamp is no stamp');
  assert.equal(rowExpiresAt(null), null);
  assert.equal(rowExpiresAt({}), null);
});

test('a row past its carried stamp is dead — the whole-seconds clock, "now" counts', () => {
  assert.equal(rowExpired(dataRow(1000), 999), false, 'one second before, still alive');
  assert.equal(rowExpired(dataRow(1000), 1000), true, 'now counts as dead');
  assert.equal(rowExpired(dataRow(1000), 1001), true);
  assert.equal(rowExpired(rowExpiresAt ? { data: {} } : null, 1000), false, 'a row with no stamp never dies by this answer alone');
});

test('the receiver honors the stamp only as far as the roster promised: clamped, nothing absurd', () => {
  const now = 10000;
  assert.equal(clampedExpiresAt(now + 3600, now), now + 3600, 'an ordinary stamp carries untouched');
  assert.equal(clampedExpiresAt(now + 2592000, now), now + 2592000, 'exactly the roster\'s longest is honored');
  assert.equal(clampedExpiresAt(now + 2592001, now), now + 2592000, 'beyond it, the stamp is the longest');
  assert.equal(clampedExpiresAt(now + 1e12, now), now + 2592000, 'a never-dies stamp does not survive the save');
  assert.equal(clampedExpiresAt(now, now), null, 'now is dead on arrival');
  assert.equal(clampedExpiresAt(now - 5, now), null, 'a past stamp is dead on arrival already');
  assert.equal(clampedExpiresAt('1.5', now), null, 'a fractionated stamp carries no sentence');
  assert.equal(clampedExpiresAt('zz', now), null);
});

test('the group body carries a clamped stamp, and the saved JSON agrees with the kept body', () => {
  const now = 10000;
  const body = (json) => clampGroupBody(JSON.parse(json), json, now);
  // No stamp: the body comes back untouched, not rebuilt.
  const bare = clampGroupBody({ type: 'text', message: 'hi' }, JSON.stringify({ type: 'text', message: 'hi' }), now);
  assert.deepEqual(bare, {
    parsed: { type: 'text', message: 'hi' },
    plaintext: JSON.stringify({ type: 'text', message: 'hi' }),
  });
  // An ordinary stamp moves nothing — the object is the same sentence.
  const plain = body(JSON.stringify({ type: 'text', message: 'hi', expires_at: now + 3600 }));
  assert.equal(plain.parsed.expires_at, now + 3600);
  // Beyond the roster's longest, both the body and the JSON agree at 30 days.
  const far = body(JSON.stringify({ type: 'text', message: 'hi', expires_at: now + 1e12 }));
  assert.equal(far.parsed.expires_at, now + 2592000);
  assert.deepEqual(JSON.parse(far.plaintext), { type: 'text', message: 'hi', expires_at: now + 2592000 });
  // A dead stamp is stripped, and the saved JSON carries it no longer.
  const dead = body(JSON.stringify({ type: 'text', message: 'hi', expires_at: now - 5 }));
  assert.deepEqual(JSON.parse(dead.plaintext), { type: 'text', message: 'hi' });
  // Plain text that is not JSON keeps both parts untouched — nothing crashes.
  const raw = clampGroupBody({ expires_at: now + 3600 }, 'not json at all', now);
  assert.equal(raw.plaintext, 'not json at all');
  assert.deepEqual(raw.parsed, { expires_at: now + 3600 });
});
