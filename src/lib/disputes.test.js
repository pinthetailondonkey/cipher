import assert from 'node:assert/strict';
import test from 'node:test';
import { DISPUTE_KIND, RIDER_WORDS, markOwnRider, ownRiderTaken, parseDispute, riderPairKey, riderRefusal, ridersForReview } from './disputes.js';

// The own-rider ledger lives in scoped localStorage; the browser fallback
// (absent storage) makes writes a no-op, so tests hand it a fresh one.
if (!globalThis.localStorage) {
  const map = new Map();
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

const VENDOR = 'a'.repeat(64);
const BUYER = 'c'.repeat(64);
const REVIEW = 'd'.repeat(64);
const RECEIPT = 'ee'.repeat(32);
const REVIEW_EVENT = { id: REVIEW.repeat(1), kind: 10005, pubkey: BUYER, created_at: 900, tags: [['p', VENDOR], ['rating', '5'], ['receipt', RECEIPT]], content: 'went fine' };

const riderEvent = ({ rider, author = VENDOR, receipt = RECEIPT, review = REVIEW, created_at = 2000, text = 'what happened', id = rider + created_at, p = VENDOR, kind = DISPUTE_KIND }) => ({
  kind, id, pubkey: author, created_at,
  tags: [['p', p], ['receipt', receipt], ['review', review], ['rider', rider]],
  content: text,
});

test('a dispute parses only a real rider on a real pair: right kind, known word, hex bindings, words to say', () => {
  for (const word of RIDER_WORDS) assert.equal(parseDispute(riderEvent({ rider: word })).rider, word, word + ' is a rider word');
  const parsed = parseDispute(riderEvent({ rider: 'vendor-flag', created_at: 2100 }));
  assert.deepEqual({ ...parsed, id: undefined }, {
    rider: 'vendor-flag', vendor: VENDOR, receipt: RECEIPT, review: REVIEW,
    text: 'what happened', author: VENDOR, created_at: 2100, id: undefined,
  });
  assert.equal(parseDispute({ ...riderEvent({ rider: 'vendor-flag' }), kind: 10008 }), null, 'a vendor-reported number is never a dispute');
  assert.equal(parseDispute(riderEvent({ rider: 'vendor-said' })), null, 'no rider word beyond the founder three');
  assert.equal(parseDispute(riderEvent({ rider: 'vendor-flag', receipt: 'zz' })), null, 'the receipt binding is 64 hex or nothing');
  assert.equal(parseDispute(riderEvent({ rider: 'vendor-flag', review: 'd'.repeat(63) })), null, 'the rider names a review event');
  assert.equal(parseDispute(riderEvent({ rider: 'vendor-flag', text: '   ' })), null, 'a rider with nothing to say is nothing');
  assert.equal(parseDispute(riderEvent({ rider: 'vendor-flag', kind: 10005 })), null);
  assert.equal(parseDispute(null), null);
});

test('ridersForReview one-shot: exactly one of each rider word per (receipt, review), first landed wins, nothing deleted', () => {
  const events = [
    riderEvent({ rider: 'vendor-flag', created_at: 2000, text: 'flag: never sent', id: 'aa' }),
    riderEvent({ rider: 'vendor-rebuttal', created_at: 3000, text: 'rebuttal: it shipped', id: 'ac' }),
    riderEvent({ rider: 'buyer-supplement', author: BUYER, created_at: 4000, text: 'supplement: tracking says no', id: 'cc' }),
    // A duplicate rider word is ignored, not consumed — it stays published.
    riderEvent({ rider: 'vendor-flag', created_at: 5000, text: 'a second flag', id: 'dd' }),
    // Same-second duplicate: the smaller event id is the record.
    riderEvent({ rider: 'vendor-rebuttal', created_at: 3000, text: 'twin rebuttal', id: 'ab' }),  ];
  const out = ridersForReview({ vendor: VENDOR, receipt: RECEIPT, review: REVIEW }, events);
  assert.equal(out['vendor-flag'].text, 'flag: never sent', 'the first flag landed is the record');
  assert.equal(out['vendor-rebuttal'].text, 'twin rebuttal', 'the smaller id wins a same-second tie');
  assert.equal(out['buyer-supplement'].text, 'supplement: tracking says no');
  assert.deepEqual(Object.keys(out).sort(), [...RIDER_WORDS].sort(), 'every rider word is a key, taken or not');
  // An untouched review answers with three nulls — the thread is all doors.
  const untouched = ridersForReview({ vendor: VENDOR, receipt: RECEIPT, review: REVIEW }, [REVIEW_EVENT]);
  assert.deepEqual(untouched, { 'vendor-flag': null, 'vendor-rebuttal': null, 'buyer-supplement': null });
  assert.deepEqual(ridersForReview(null, events), { 'vendor-flag': null, 'vendor-rebuttal': null, 'buyer-supplement': null });
  assert.deepEqual(ridersForReview({ vendor: VENDOR, receipt: RECEIPT, review: REVIEW }, []), untouched);
});

test('authorship a reader can check: vendor riders are the vendor\'s, a supplement is never the vendor\'s', () => {
  const events = [
    riderEvent({ rider: 'vendor-flag', author: BUYER, text: 'stranger flagging' }),
    riderEvent({ rider: 'vendor-rebuttal', author: BUYER, text: 'stranger rebuttal' }),
    riderEvent({ rider: 'buyer-supplement', author: VENDOR, text: 'vendor rote-supplementing' }),
  ];
  assert.deepEqual(ridersForReview({ vendor: VENDOR, receipt: RECEIPT, review: REVIEW }, events), {
    'vendor-flag': null, 'vendor-rebuttal': null, 'buyer-supplement': null,
  });
  // A rider for a different pair never answers for this one.
  const foreign = [
    riderEvent({ rider: 'vendor-flag', receipt: '11'.repeat(32), text: 'other trade' }),
    riderEvent({ rider: 'vendor-rebuttal', review: 'd1'.repeat(32), text: 'other review' }),
    riderEvent({ rider: 'buyer-supplement', author: BUYER, p: BUYER, text: 'other shop' }),
  ];
  assert.deepEqual(ridersForReview({ vendor: VENDOR, receipt: RECEIPT, review: REVIEW }, foreign), {
    'vendor-flag': null, 'vendor-rebuttal': null, 'buyer-supplement': null,
  });
  // p names the thread: a rider stored under another shop's pubkey stays there.
  const SHOP2 = 'e'.repeat(64);
  const otherShop = [riderEvent({ rider: 'buyer-supplement', author: BUYER, p: SHOP2, text: 'other shop' })];
  assert.equal(ridersForReview({ vendor: SHOP2, receipt: RECEIPT, review: REVIEW }, otherShop)['buyer-supplement']?.text, 'other shop');
  assert.deepEqual(ridersForReview({ vendor: VENDOR, receipt: RECEIPT, review: REVIEW }, otherShop), {
    'vendor-flag': null, 'vendor-rebuttal': null, 'buyer-supplement': null,
  });
});

test('the own-rider ledger: a word this device spent stays spent, through a reload and a partial fetch', () => {
  const key = riderPairKey(VENDOR, RECEIPT, REVIEW);
  assert.equal(ownRiderTaken(VENDOR, RECEIPT, REVIEW, 'vendor-rebuttal'), false, 'nothing posted yet');
  assert.equal(ownRiderTaken(VENDOR, RECEIPT, REVIEW, 'not-a-word'), false, 'an unknown rider word is never taken');
  assert.equal(markOwnRider(VENDOR, RECEIPT, REVIEW, 'vendor-rebuttal', 'aa'.repeat(32)), true, 'the sign spends the word');
  assert.equal(ownRiderTaken(VENDOR, RECEIPT, REVIEW, 'vendor-rebuttal'), true);
  assert.equal(ownRiderTaken(VENDOR, RECEIPT, REVIEW, 'vendor-flag'), false, 'the other words are still open on this pair');
  assert.equal(ownRiderTaken(VENDOR, RECEIPT, 'd1'.repeat(32), 'vendor-rebuttal'), false, 'another review is another thread');
  assert.equal(markOwnRider(VENDOR, RECEIPT, REVIEW, 'vendor-flag', ''), false, 'an event with no id marks nothing');
  assert.equal(ownRiderTaken(VENDOR, RECEIPT, REVIEW, 'vendor-flag'), false, 'an id-less mark never hardened');
  assert.equal(key.includes(VENDOR) && key.includes(RECEIPT) && key.includes(REVIEW), true, 'the pair key spells the three bindings');
});

test('riderRefusal: the words a rider must pass before anything is signed', () => {
  const R2 = 'd2'.repeat(32); // a fresh review pair, so the ledger tests above stay beside the point
  const good = { author: VENDOR, vendor: VENDOR, receiptHash: RECEIPT, review: R2, rider: 'vendor-flag', text: 'never sent' };
  assert.equal(riderRefusal(good), null, 'an honest vendor flag meets no wall');
  assert.equal(riderRefusal({ ...good, rider: 'vendor-rebuttal' }), null, 'the vendor may also rebut');
  assert.equal(riderRefusal({ ...good, author: BUYER, rider: 'buyer-supplement' }), null, 'the buyer may supplement');
  assert.match(riderRefusal({ ...good, rider: 'shout' }), /not a rider word/, 'no rider word beyond the founder three');
  assert.match(riderRefusal({ ...good, receiptHash: 'zz' }), /receipt/, 'the receipt binding comes first');
  assert.match(riderRefusal({ ...good, review: 'no' }), /review event/, 'the rider names a review');
  assert.match(riderRefusal({ ...good, text: '  ' }), /says something/, 'an empty rider is nothing');
  assert.match(riderRefusal({ ...good, author: BUYER }), /vendor/, 'a stranger never flags or rebuts for the vendor');
  assert.match(riderRefusal({ ...good, author: BUYER, rider: 'vendor-rebuttal' }), /vendor/, 'the rebuttal too');
  assert.match(riderRefusal({ ...good, rider: 'buyer-supplement' }), /co-sign a buyer supplement/, 'a vendor never supplements for the buyer');
  // one-shot on the composite pair: spend it, then refuse a second sign
  assert.equal(markOwnRider(VENDOR, RECEIPT, R2, 'vendor-flag', 'e1'.repeat(32)), true);
  assert.match(riderRefusal(good), /already spent its one word/, 'a spent word refuses the same sign');
  // and the buyers side of one-shot
  assert.equal(markOwnRider(VENDOR, RECEIPT, R2, 'buyer-supplement', 'e2'.repeat(32)), true);
  assert.match(riderRefusal({ ...good, author: BUYER, rider: 'buyer-supplement' }), /already spent/, 'the buyer word spent is spent');
});
