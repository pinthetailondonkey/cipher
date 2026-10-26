import assert from 'node:assert/strict';
import test from 'node:test';
import { averageRating, clampRating, receiptBindingOf } from './reputation.js';

test('a vouch counts only when it names a receipt hash', () => {
  assert.equal(receiptBindingOf({ tags: [['p', 'ab'], ['vouch', 'true'], ['receipt', 'f'.repeat(64)]] }), 'f'.repeat(64));
  assert.equal(receiptBindingOf({ tags: [['p', 'ab'], ['vouch', 'true']] }), '');
  // An invented or mangled hash is not a binding.
  assert.equal(receiptBindingOf({ tags: [['receipt', 'zz'.repeat(32)]] }), '');
  assert.equal(receiptBindingOf({ tags: [['receipt', 'f'.repeat(63)]] }), '');
  assert.equal(receiptBindingOf({ tags: [['receipt', '']] }), '');
  assert.equal(receiptBindingOf({ tags: [['receipt', 'f'.repeat(64)]] }), 'f'.repeat(64));
  assert.equal(receiptBindingOf({}), '');
  assert.equal(receiptBindingOf(null), '');
});

test('a rating outside 0..5 clamps, and junk is a zero', () => {
  assert.equal(clampRating('5'), 5);
  assert.equal(clampRating('3'), 3);
  assert.equal(clampRating('0'), 0);
  assert.equal(clampRating('-1'), 0);
  assert.equal(clampRating('-99'), 0);
  assert.equal(clampRating('9'), 5);
  assert.equal(clampRating('abc'), 0);
  assert.equal(clampRating(undefined), 0);
});

test('an average never goes below zero, no matter how many attack reviews land', () => {
  assert.equal(averageRating(['5', '4']), '4.5');
  assert.equal(averageRating(['-5']), '0.0');
  assert.equal(averageRating(['1', '-99', '2']), '1.0');
  assert.equal(averageRating([]), '0.0');
  assert.equal(averageRating(['-1', '-1']), '0.0');
  assert.equal(averageRating(['9', '-3']), '2.5');
});
