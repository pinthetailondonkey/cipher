import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { averageRating, clampRating, profileAgeDays, receiptBindingOf, tradeEvidenceOf, vouchCoversTrade, vouchTradeOf } from './reputation.js';

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

test('receipt hashes and self-reported party tags remain endorsements only', () => {
  const event = { pubkey: 'aa', tags: [['receipt', 'f'.repeat(64)], ['trade_vendor', 'bb'], ['trade_buyer', 'aa']] };
  assert.equal(tradeEvidenceOf(event).state, 'unverified-endorsement');
  assert.equal(tradeEvidenceOf({ tags: [['receipt', 'f'.repeat(64)]] }).state, 'unverified-endorsement');
});

test('social vouch counts stay visible without shield or threshold trust styling', () => {
  const menu = fs.readFileSync(new URL('../components/chat/VendorMenuHome.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(menu, /ShieldCheck/);
  assert.doesNotMatch(menu, /vouchCount\s*>=/);
  assert.match(menu, /\$\{vouchCount\} \$\{vouchCount === 1 \? 'vouch' : 'vouches'\}/);
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

// fix 6: a kind-0 created_at is written by its publisher, is rewritten on
// every profile edit, and is not proof of account age. It no longer qualifies
// a vouch into the trusted count; the apparent age is a label, and a future
// stamp reads as zero so it can never look older than it is.
test('a profile timestamp is a label, never verified age, and a future stamp cannot age an account', () => {
  const now = 1_700_000_000;
  assert.equal(profileAgeDays(now - 8 * 86400, now), 8);
  assert.equal(profileAgeDays(now, now), 0);
  assert.equal(profileAgeDays(0, now), 0, 'a missing stamp is zero');
  assert.equal(profileAgeDays(undefined, now), 0);
  assert.equal(profileAgeDays('nonsense', now), 0);
  assert.equal(profileAgeDays(now + 5 * 86400, now), 0, 'a future stamp reads zero, never negative');
});

test('the vouch count no longer gates on the publisher timestamp', () => {
  const hook = fs.readFileSync(new URL('../hooks/useReputation.js', import.meta.url), 'utf8');
  assert.doesNotMatch(hook, /MIN_VOUCHER_AGE_DAYS/, 'the age constant is gone');
  assert.match(hook, /vouchCount: vouchInfos\.length/, 'the count is every eligible vouch');
  assert.match(hook, /ageVerified: false/, 'and the age is marked unverified');
});
