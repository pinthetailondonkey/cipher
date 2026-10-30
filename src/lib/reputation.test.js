import assert from 'node:assert/strict';
import test from 'node:test';
import { averageRating, clampRating, receiptBindingOf, vouchCoversTrade, vouchTradeOf } from './reputation.js';

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

test('a vouch counts only when its named trade holds both the target and the author', () => {
  // security S8: the receipt hash is private, so a reader cannot check it
  // against the trade. The vendor and buyer tags under the author's own
  // signature are what keep one real trade from vouching for a stranger.
  const target = 'a'.repeat(64);
  const author = 'b'.repeat(64);
  const stranger = 'c'.repeat(64);
  const bound = {
    pubkey: author,
    tags: [
      ['p', target], ['vouch', 'true'], ['receipt', 'd'.repeat(64)],
      ['trade_vendor', target], ['trade_buyer', author],
    ],
  };
  assert.deepEqual(vouchTradeOf(bound), { vendor: target, buyer: author });
  assert.equal(vouchCoversTrade(bound, target), true);
  // The vouching party stood in a different trade: not the target's.
  assert.equal(vouchCoversTrade(bound, stranger), false);
  // The same receipt, transplanted: it names someone else as the author.
  assert.equal(vouchCoversTrade({ ...bound, pubkey: stranger }, target), false);
  // A self-vouch fails the author/target split even with well-formed tags.
  assert.equal(vouchCoversTrade({ ...bound, pubkey: target }, target), false);
  // Case-blind: an uppercase twin of the vendor tag names the same person.
  assert.equal(vouchCoversTrade({ ...bound, tags: bound.tags.map(([k, v]) => [k, k === 'trade_vendor' ? v.toUpperCase() : v]) }, target), true);
  // No trade tags at all: the vouch is not transplantable, so it counts nowhere.
  assert.equal(vouchTradeOf({ tags: [['p', target], ['vouch', 'true'], ['receipt', 'd'.repeat(64)]] }), null);
  assert.equal(vouchCoversTrade({ pubkey: author, tags: [['p', target], ['vouch', 'true'], ['receipt', 'd'.repeat(64)]] }, target), false);
  // A trade naming the same key as both sides is a fabricated trade.
  assert.equal(vouchTradeOf({ pubkey: author, tags: [['trade_vendor', target], ['trade_buyer', target]] }), null);
});
