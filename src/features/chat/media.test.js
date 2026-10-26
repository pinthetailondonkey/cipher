import test from 'node:test';
import assert from 'node:assert/strict';
import { sortMessages, stampArrival } from './media.js';

const now = Math.floor(Date.now() / 1000);

test('same-second messages sort by arrival, not the random event id', () => {
  // The id hash is random: before arrival stamps, 'ff' before 'aa' decided
  // which message a same-second reply sat under.
  const first = { timestamp: now, local_timestamp: now * 1000, id: 'ff', arrival: 5 };
  const second = { timestamp: now, local_timestamp: now * 1000, id: 'aa', arrival: 6 };
  assert.equal(sortMessages(first, second), -1);
  assert.equal(sortMessages(second, first), 1);
});

test('a reply to a clock-skewed sender sorts by local arrival', () => {
  // Sender clock runs fast: their created_at claims later than the reply that
  // answered it. Sorting follows the local receipt millisecond instead.
  const theirs = { timestamp: now + 9, local_timestamp: (now + 9) * 1000, id: 'aa', arrival: 5 };
  const mine = { timestamp: now, local_timestamp: (now + 9) * 1000 + 1, id: 'bb', arrival: 6 };
  assert.equal(sortMessages(theirs, mine), -1);
});

test('rows without arrival stamps keep the id tiebreak', () => {
  const a = { timestamp: now, id: 'ff' };
  const b = { timestamp: now, id: 'aa' };
  assert.equal(sortMessages(a, b), -(sortMessages(b, a)));
  assert.ok(sortMessages(b, a) < 0); // 'aa' first, as the old sort did
});

test('older local_timestamp beats a stamped arrival on a fresher row', () => {
  const earlier = { timestamp: now, local_timestamp: now * 1000, id: 'ff', arrival: 9 };
  const later = { timestamp: now, local_timestamp: now * 1000 + 1, id: 'aa', arrival: 2 };
  assert.equal(sortMessages(earlier, later), -1);
});

test('arrival stamps increase by one per message and skip null', () => {
  const first = stampArrival({});
  const second = stampArrival({});
  assert.equal(second.arrival - first.arrival, 1);
  assert.equal(stampArrival(null), null);
  assert.equal(stampArrival(undefined), undefined);
});
