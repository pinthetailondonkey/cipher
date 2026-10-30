import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import {
  canDisplayReview,
  dealsProvenForVendor,
  monthLabelOf,
  monthsActiveForVendor,
  normalizeReview,
  orderMonthOf,
  provenBannerOf,
  provenDealsForVendor,
  provenLinesOf,
  createReviewPublisher,
  boundReceiptsByHash,
  parseReviewEvent,
  reviewsFromWire,
  REVIEW_WIRING_LANDED,
  reviewEligibility,
  reviewOfferForOrder,
  reviewSummaryOf,
  reviewsForVendor,
  ridersOfRow,
  riderComposeOf,
  saveReview,
  provenEntriesOf,
  wholeMonthsBetween,
} from './vendorReviews.js';
import { publicReceipt, rememberPublicView, signPublicView, signReceipt, verifyPublicView } from './proofOfTrade.js';
import { RIDER_WORDS, markOwnRider } from './disputes.js';


function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function memoryStorage() {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
    key: (index) => Array.from(memory.keys())[index] || null,
    get length() { return memory.size; },
  };
  return memory;
}

// One real bound deal: the vendor's receipt, countersigned by the buyer,
// stored the way the DM path stores it, with the binding mark beside it.
// The buyer is the active account, so the scoped readers find its records.
function boundDeal({ orderId, buyerKey, vendorKey, at = 1_700_000_000, outcome = 'confirmed' } = {}) {
  const buyerKeyFinal = buyerKey || schnorr.utils.randomSecretKey();
  const vendorKeyFinal = vendorKey || schnorr.utils.randomSecretKey();
  const buyer = hex(schnorr.getPublicKey(buyerKeyFinal));
  const vendor = hex(schnorr.getPublicKey(vendorKeyFinal));
  const receipt = signReceipt(vendorKeyFinal, {
    orderId, buyer, vendor, currency: 'btc',
    address: 'bc1qorder', amount: '0.01', txid: 'aa', at, outcome,
  });
  const signed = signReceipt(buyerKeyFinal, receipt.body, receipt);
  globalThis.localStorage.setItem('cipher_active_pubkey', buyer);
  globalThis.localStorage.setItem(`cipher_${buyer}_receipt_${orderId}`, JSON.stringify(signed));
  globalThis.localStorage.setItem(`cipher_${buyer}_bound_receipt_${orderId}`, JSON.stringify(signed.hash));
  return { buyerKey: buyerKeyFinal, vendorKey: vendorKeyFinal, buyer, vendor, receipt: signed };
}

test('the order month is the year-month of the payment, in UTC', () => {
  assert.equal(orderMonthOf(1_700_000_000), '2023-11');
  assert.equal(orderMonthOf(0), '');
  assert.equal(orderMonthOf(null), '');
  assert.equal(orderMonthOf('not a time'), '');
  assert.equal(monthLabelOf('2025-03'), 'Order from March 2025');
  assert.equal(monthLabelOf('2025-13'), '');
  assert.equal(monthLabelOf(''), '');
});

test('whole months count a month only once it is reached again', () => {
  // Jan 15 2025 to Mar 14 2026: the 15th is not yet reached — 13 whole months.
  assert.equal(wholeMonthsBetween(1_736_899_200, 1_773_446_400), 13);
  // One day later the 15th arrives: 14 whole months.
  assert.equal(wholeMonthsBetween(1_736_899_200, 1_773_532_800), 14);
  assert.equal(wholeMonthsBetween(0, 0), 0);
  assert.equal(wholeMonthsBetween('no', 'no'), 0);
});

test('eligibility is the bound receipt, the buyer role, and a completed deal', () => {
  memoryStorage();
  const { buyer, vendor, receipt } = boundDeal({ orderId: 'order-1' });
  const otherVendor = hex(schnorr.getPublicKey(schnorr.utils.randomSecretKey()));
  const ok = {
    receipt,
    boundHash: receipt.hash,
    buyerPubkey: buyer,
    vendorPubkey: vendor,
    status: 'completed',
  };
  assert.equal(reviewEligibility(ok), true);
  // A pending deal reviews nothing.
  assert.equal(reviewEligibility({ ...ok, status: 'paid' }), false);
  // The vendor of the trade is not the reviewer.
  assert.equal(reviewEligibility({ ...ok, buyerPubkey: vendor }), false);
  // A receipt bound to another vendor does not carry this review.
  assert.equal(reviewEligibility({ ...ok, vendorPubkey: otherVendor }), false);
  // An unbound receipt never qualifies.
  assert.equal(reviewEligibility({ ...ok, boundHash: 'ff'.repeat(32) }), false);
  // A tampered receipt never qualifies.
  const tampered = { ...receipt, body: { ...receipt.body, amount: '9' } };
  assert.equal(reviewEligibility({ ...ok, receipt: tampered }), false);
  assert.equal(reviewEligibility(null), false);
});

test('the offer is gated off at launch, so no order door opens and nothing publishes', () => {
  memoryStorage();
  const { buyer, vendor } = boundDeal({ orderId: 'order-2', at: 1_700_000_000 });
  const messages = [
    { id: 'order-2', isSender: true, pubkey: buyer, data: { type: 'cipher_order', status: 'pending' } },
    { id: 'u1', isSender: false, pubkey: vendor, timestamp: 2, data: { type: 'order_update', orderId: 'order-2', status: 'completed' } },
  ];
  // This is the strongest case there is — a completed, bound, verified deal
  // with the buyer's key on it — and with the fuse down it still offers
  // nothing. Review eligibility itself (the receipt, the binding, the
  // completed state, the buyer's key) stays covered by its own cases above,
  // so flipping the fuse back on is the only thing between the door and the
  // record it reads.
  const offer = reviewOfferForOrder({ messages, order: messages[0], buyerPubkey: buyer, vendorPubkey: vendor });
  assert.equal(offer, null, 'row 22: reviews are absent at launch, so no order offers one');
  // A deal not yet completed: no offer either.
  const early = reviewOfferForOrder({
    messages: [messages[0]],
    order: messages[0],
    buyerPubkey: buyer,
    vendorPubkey: vendor,
  });
  assert.equal(early, null);
  // A viewer who is not the buyer: no offer.
  assert.equal(reviewOfferForOrder({ messages, order: messages[0], buyerPubkey: vendor, vendorPubkey: vendor }), null);
});

test('row 22: the launch gate is read by every review surface, and the code is kept', () => {
  // Shape, not behaviour: the fuse is down, and each piece that would
  // publish or draw a review consults it. The days the door is down, a
  // surface that stops consulting the flag is the bug this catches.
  assert.equal(REVIEW_WIRING_LANDED, false);
  const lib = readFileSync(new URL('./vendorReviews.js', import.meta.url), 'utf8');
  assert.match(lib, /export const REVIEW_WIRING_LANDED = false;/);
  assert.match(lib, /if \(!REVIEW_WIRING_LANDED\) return null;\n  if \(!order\?\.id/, 'row 22: the offer reads the launch gate');
  assert.match(lib, /if \(!REVIEW_WIRING_LANDED\) return null;/, 'row 22: the publisher reads the launch gate');
  const hook = readFileSync(new URL('../hooks/useVendorReviews.js', import.meta.url), 'utf8');
  assert.match(hook, /if \(!REVIEW_WIRING_LANDED\) rows = \[\];/, 'row 22: the reader draws no review row while the gate is down');
  const page = readFileSync(new URL('../components/chat/VendorProfilePage.jsx', import.meta.url), 'utf8');
  assert.match(page, /\{REVIEW_WIRING_LANDED && summary\.count > 0 && \(/, 'row 22: the summary block reads the launch gate');
  assert.match(page, /\{REVIEW_WIRING_LANDED && reviews\.length > 0 && \(/, 'row 22: the review list reads the launch gate');
  assert.match(page, /\{REVIEW_WIRING_LANDED && reviews\.length === 0 && \(/, 'row 22: the empty-reviews line reads the launch gate');
});

test('a review row normalizes, and display re-derives from the receipt', () => {
  memoryStorage();
  const { buyer, vendor, receipt } = boundDeal({ orderId: 'order-3' });
  const row = normalizeReview({
    vendorPubkey: vendor,
    buyerPubkey: buyer,
    stars: 4,
    verdict: 'Right on time.',
    orderMonth: '2023-11',
    receiptHash: receipt.hash,
    createdAt: 1_700_500_000,
    orderId: 'order-3',
    receipt,
  });
  assert.equal(row.stars, 4);
  assert.equal(row.orderMonth, '2023-11');
  // The binding mark is on this device, the outcome reads confirmed: it shows.
  assert.equal(canDisplayReview(row), true);
  // Without the binding mark on this device it is void.
  globalThis.localStorage.setItem(`cipher_${buyer}_bound_receipt_order-3`, JSON.stringify('ff'.repeat(32)));
  assert.equal(canDisplayReview(row), false);
  globalThis.localStorage.setItem(`cipher_${buyer}_bound_receipt_order-3`, JSON.stringify(receipt.hash));
  // A refunded outcome is not a verified purchase.
  const refunded = boundDeal({ orderId: 'order-4', outcome: 'refunded' });
  const refundedRow = normalizeReview({
    vendorPubkey: refunded.vendor,
    buyerPubkey: refunded.buyer,
    stars: 2,
    verdict: 'Returned the money.',
    orderMonth: '2023-11',
    receiptHash: refunded.receipt.hash,
    createdAt: 1_700_500_000,
    orderId: 'order-4',
    receipt: refunded.receipt,
  });
  assert.equal(canDisplayReview(refundedRow), false);
  // A receipt that no longer verifies never renders, whatever the row says.
  const broken = { ...row, receipt: { ...row.receipt, body: { ...row.receipt.body, amount: '9' } } };
  assert.equal(canDisplayReview(broken), false);
  assert.equal(canDisplayReview(null), false);
});

test('a review saves against its receipt hash, one per deal', async () => {
  memoryStorage();
  const { buyer, vendor, receipt } = boundDeal({ orderId: 'order-5' });
  const memory = new Map();
  const table = {
    put: async (row) => { memory.set(row.receiptHash, row); return memory.size; },
    get: async (key) => memory.get(key) || undefined,
    where: () => ({ equals: () => ({ toArray: async () => [...memory.values()].filter((row) => row.vendorPubkey === vendor) }) }),
  };
  const saved = await saveReview({
    vendorPubkey: vendor,
    buyerPubkey: buyer,
    stars: 5,
    verdict: 'Solid.',
    receiptHash: receipt.hash,
    orderId: 'order-5',
    receipt,
  }, table);
  assert.equal(saved.orderMonth, orderMonthOf(1_700_000_000));
  // A second review of the same deal replaces the first — one per receipt.
  await saveReview({ ...saved, stars: 3, verdict: 'Changed my mind.' }, table);
  const rows = await reviewsForVendor(vendor, table);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stars, 3);
  // Bad shapes are refused, not stored.
  await assert.rejects(() => saveReview({ ...saved, stars: 9 }, table));
  await assert.rejects(() => saveReview({ ...saved, verdict: '' }, table));
  await assert.rejects(() => saveReview({ ...saved, receiptHash: 'nothex' }, table));
  await assert.rejects(() => saveReview({ ...saved, vendorPubkey: buyer }, table));
});

test('the summary is a count and an average of the displayed rows', () => {
  assert.deepEqual(reviewSummaryOf([]), { count: 0, average: '0.0' });
  const rows = [
    { stars: 5 }, { stars: 4 }, { stars: 5 },
  ];
  assert.deepEqual(reviewSummaryOf(rows), { count: 3, average: '4.7' });
  const averageOf = (values) => (values.length ? (values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : '0.0');
  assert.deepEqual(reviewSummaryOf(rows, averageOf), { count: 3, average: '4.7' });
});

test('deals proven counts distinct bound receipts a public view names', () => {
  memoryStorage();
  const { buyerKey, vendorKey, vendor, receipt } = boundDeal({ orderId: 'order-6' });
  // No public view yet: nothing is proven.
  assert.equal(dealsProvenForVendor(vendor), 0);
  // The buyer signs the view, the vendor completes it: the deal is proven.
  const view = publicReceipt(receipt);
  assert.equal(verifyPublicView(signPublicView(vendorKey, signPublicView(buyerKey, view))), true);
  rememberPublicView(signPublicView(vendorKey, signPublicView(buyerKey, view)));
  assert.equal(dealsProvenForVendor(vendor), 1);
  // A second bound deal with the same vendor makes two.
  const second = boundDeal({ orderId: 'order-7', buyerKey, vendorKey, at: 1_700_100_000 });
  rememberPublicView(signPublicView(vendorKey, signPublicView(buyerKey, publicReceipt(second.receipt))));
  assert.equal(dealsProvenForVendor(vendor), 2);
  // A bound receipt the view never named proves nothing extra, and another
  // vendor's deal does not land on this vendor's count.
  const strangerSeller = schnorr.utils.randomSecretKey();
  const stranger = boundDeal({ orderId: 'order-8', buyerKey, vendorKey: strangerSeller });
  assert.equal(dealsProvenForVendor(stranger.vendor), 0);
  assert.equal(dealsProvenForVendor(vendor), 2);
  assert.equal(dealsProvenForVendor(''), 0);
  // Months active: whole months since the earliest receipt of this vendor.
  assert.equal(monthsActiveForVendor(vendor, 1_700_000_000), 0);
  assert.ok(monthsActiveForVendor(vendor, 1_736_918_400) >= 1);
  assert.equal(monthsActiveForVendor(''), 0);
});

test('the proven count is keyed by rail, nothing blended', () => {
  memoryStorage();
  const { buyerKey, vendorKey, vendor, receipt } = boundDeal({ orderId: 'order-9', outcome: 'confirmed' });
  const xmrDeal = boundDeal({ orderId: 'order-10', buyerKey, vendorKey, at: 1_700_100_000 });
  // An XMR-settled deal: re-sign the receipt body with the currency swapped,
  // both sides, then bind it the way the countersign writes.
  const xmrBody = { ...xmrDeal.receipt.body, currency: 'xmr' };
  const vendorSigned = signReceipt(vendorKey, xmrBody);
  const xmrSigned = signReceipt(buyerKey, xmrBody, vendorSigned);
  globalThis.localStorage.setItem(`cipher_${xmrDeal.buyer}_receipt_order-10`, JSON.stringify(xmrSigned));
  globalThis.localStorage.setItem(`cipher_${xmrDeal.buyer}_bound_receipt_order-10`, JSON.stringify(xmrSigned.hash));
  const viewBtc = publicReceipt(receipt);
  rememberPublicView(signPublicView(vendorKey, signPublicView(buyerKey, viewBtc)));
  const viewXmr = publicReceipt(xmrSigned);
  rememberPublicView(signPublicView(vendorKey, signPublicView(buyerKey, viewXmr)));
  const keyed = provenDealsForVendor(vendor);
  assert.deepEqual(Object.keys(keyed), ['btc', 'xmr']);
  assert.equal(keyed.btc.count, 1);
  assert.equal(keyed.btc.phrasing, 'proven');
  assert.deepEqual(keyed.btc.txids, ['aa']);
  assert.equal(keyed.xmr.count, 1);
  assert.equal(keyed.xmr.phrasing, 'recorded');
  // The plain "how many" total counts across rails; the banner never sums.
  assert.equal(dealsProvenForVendor(vendor), 2);
  // Nothing proven: the object is empty, not a shaped zero.
  assert.deepEqual(provenDealsForVendor(''), {});
});

test('the banner words are the contract\'s, one line per rail, never summed', () => {
  assert.equal(provenBannerOf({ count: 1, phrasing: 'proven' }), '1 deal proven. One tap shows the txids.');
  assert.equal(provenBannerOf({ count: 3, phrasing: 'proven' }), '3 deals proven. One tap shows the txids.');
  assert.equal(provenBannerOf({ count: 1, phrasing: 'recorded' }), '1 deal recorded on chain.');
  assert.equal(provenBannerOf({ count: 0, phrasing: 'proven' }), '');
  // Rail order is stable: btc first, xmr second, further rails after.
  assert.deepEqual(
    provenLinesOf({
      xmr: { count: 2, phrasing: 'recorded' },
      btc: { count: 1, phrasing: 'proven' },
    }),
    ['1 deal proven. One tap shows the txids.', '2 deals recorded on chain.'],
  );
  assert.deepEqual(provenLinesOf({}), []);
  // An unknown rail gets no invented wording — a neutral pass-through that
  // names the rail, with no claim attached.
  assert.equal(provenBannerOf({ count: 4, phrasing: 'woven', rail: 'zec' }), '4 deals · zec');
  assert.equal(provenBannerOf(null), '');
});

test('the fuse is down: no publisher is built, even over a working sendReview', async () => {
  // Launch state. With the fuse down there is no publisher at all — not a
  // publisher that refuses late, and not one a caller can talk past. A real
  // sendReview is offered here precisely to prove the gate does not depend
  // on one being absent, and that nothing was sent.
  assert.equal(REVIEW_WIRING_LANDED, false);
  assert.equal(createReviewPublisher({}), null);
  assert.equal(createReviewPublisher(null), null);
  const sent = [];
  const sendReview = async (targetPubkey, rating, text, receiptHash) => {
    sent.push([targetPubkey, rating, text, receiptHash]);
    return { success: true };
  };
  assert.equal(createReviewPublisher({ sendReview }), null, 'row 22: nothing builds a publisher while reviews are absent');
  assert.deepEqual(sent, []);
  // Coverage note, recorded rather than papered over: the publisher body's
  // own contract — exactly four fields, in sendReview's argument shape, the
  // order month never submitted, a refusal's own words, a throw shaped as
  // { success: false, error } — is not exercised while the fuse is down,
  // because there is no way to build the publisher. Whoever flips the fuse
  // back up restores the body's cases with it; this test then asserts the
  // publisher exists and these become the publisher's tests again.
});

const WIRE_VENDOR = 'b'.repeat(64);
const WIRE_BUYER = 'cc'.repeat(32);
const WIRE_HASH = 'de'.repeat(32);
const STRANGER_HASH = 'fa'.repeat(32);
const REVIEW_EVENT_ID = 'd4'.repeat(32);

function wireEvent({ id = REVIEW_EVENT_ID, author = WIRE_BUYER, vendor = WIRE_VENDOR, receipt = WIRE_HASH, rating = '4', text = 'Fine deal.', created_at = 1_700_200_000, kind = 10005 } = {}) {
  return { kind, id, pubkey: author, created_at, tags: [['p', vendor], ['rating', rating], ['receipt', receipt]], content: text };
}

test('a wire review parses only a vendor-bound, receipt-bound, self-review-free row', () => {
  const parsed = parseReviewEvent(wireEvent(), WIRE_VENDOR);
  assert.equal(parsed.source, 'wire');
  assert.equal(parsed.author, WIRE_BUYER);
  assert.equal(parsed.stars, 4);
  assert.equal(parsed.verdict, 'Fine deal.');
  assert.equal(parsed.receiptHash, WIRE_HASH);
  assert.equal(parsed.createdAt, 1_700_200_000);
  // A wrong kind, a stranger vendor tag, a loose hash, a blank rating, a
  // self-review, or a wordless row answer nothing.
  assert.equal(parseReviewEvent({ ...wireEvent(), kind: 10004 }, WIRE_VENDOR), null);
  assert.equal(parseReviewEvent(wireEvent({ vendor: '9'.repeat(64) }), WIRE_VENDOR), null);
  assert.equal(parseReviewEvent(wireEvent({ receipt: 'zz' }), WIRE_VENDOR), null);
  assert.equal(parseReviewEvent(wireEvent({ rating: '' }), WIRE_VENDOR), null);
  assert.equal(parseReviewEvent(wireEvent({ text: '   ' }), WIRE_VENDOR), null);
  assert.equal(parseReviewEvent(wireEvent({ author: WIRE_VENDOR }), WIRE_VENDOR), null);
  assert.equal(parseReviewEvent(null, WIRE_VENDOR), null);
  assert.equal(parseReviewEvent(wireEvent(), ''), null);
});

test('the display reads the live thread: wire rows preferred for their own signer, local-only rows kept, transplants refused', () => {
  memoryStorage();
  const { buyer, vendor, receipt } = boundDeal({ orderId: 'order-w' });
  const localRow = {
    vendorPubkey: vendor,
    buyerPubkey: buyer,
    stars: 3,
    verdict: 'Local words.',
    receiptHash: receipt.hash,
    createdAt: 900,
    orderId: 'order-w',
    orderMonth: '2023-11',
    receipt,
  };
  // A stranger's review naming this device's receipt hash: a transplant —
  // the wire signer is not the receipt's buyer, so the local row stands.
  const transplantOccasion = reviewsFromWire({
    vendorPubkey: vendor,
    wireEvents: [wireEvent({ vendor, receipt: receipt.hash, author: WIRE_BUYER, text: 'I was not even there.' })],
    localRows: [localRow],
    receiptsByHash: {},
  });
  assert.equal(transplantOccasion.length, 1);
  assert.equal(transplantOccasion[0].verdict, 'Local words.');
  assert.equal(transplantOccasion[0].source, 'local');
  // The buyer's own wire copy is the same review: the wire row wins; the
  // month and the receipt evidence stay this device's, from the receipt.
  const own = reviewsFromWire({
    vendorPubkey: vendor,
    wireEvents: [wireEvent({ vendor, receipt: receipt.hash, author: buyer, text: 'Wire words.', created_at: 1_700_200_000 })],
    localRows: [localRow],
    receiptsByHash: boundReceiptsByHash(),
  });
  assert.equal(own.length, 1);
  assert.equal(own[0].verdict, 'Wire words.', 'the wire row is preferred');
  assert.equal(own[0].stars, 4);
  assert.equal(own[0].source, 'wire');
  assert.equal(own[0].orderMonth, '2023-11', 'the month still derives from the local receipt evidence');
  assert.equal(own[0].id, REVIEW_EVENT_ID, 'the wire event id is kept for the rider thread');
  assert.equal(own[0].createdAt, 1_700_200_000);
  // Local-only rows stay visible, newest first.
  const localOnly = reviewsFromWire({ vendorPubkey: vendor, wireEvents: [], localRows: [localRow], receiptsByHash: {} });
  assert.equal(localOnly.length, 1);
  assert.equal(localOnly[0].orderId, 'order-w');
  // A wire-only deal this device holds a bound receipt for: month derived,
  // nothing about the order invented. One this device does not: no month,
  // no chip evidence, and the buyer is the wire author.
  const secondDeal = boundDeal({ orderId: 'order-w2', at: 1_700_100_000 });
  const rows = reviewsFromWire({
    vendorPubkey: vendor,
    wireEvents: [
      wireEvent({ vendor, receipt: secondDeal.receipt.hash, author: secondDeal.buyer, text: 'Two deals fine.', id: 'e2', created_at: 1_700_300_000 }),
      wireEvent({ vendor, receipt: STRANGER_HASH, author: WIRE_BUYER, text: 'Who is this?', id: 'e3', created_at: 1_700_400_000 }),
    ],
    localRows: [],
    receiptsByHash: boundReceiptsByHash(),
  });
  assert.equal(rows.length, 2, 'the transplanted-shape pair is gone: both wire rows name hashes no local row holds');
  const known = rows.find((row) => row.receiptHash === secondDeal.receipt.hash);
  assert.equal(known.orderMonth, orderMonthOf(1_700_100_000), 'the month derives from the bound receipt this device holds');
  assert.equal(known.buyerPubkey, secondDeal.buyer, 'the buyer is the wire author');
  assert.deepEqual(known.receipt, secondDeal.receipt, 'the row keeps the receipt it derived its evidence from');
  const unknown = rows.find((row) => row.receiptHash === STRANGER_HASH);
  assert.equal(unknown.orderMonth, '', 'no receipt evidence, no month — nothing invented');
  assert.ok(unknown.buyerPubkey);
  // Newest first across wire rows.
  assert.equal(rows[0].receiptHash, STRANGER_HASH);
});

test('riders of record ride a wire row through its own pair', () => {
  const row = { source: 'wire', id: REVIEW_EVENT_ID, vendorPubkey: WIRE_VENDOR, receiptHash: WIRE_HASH, buyerPubkey: WIRE_BUYER };
  const flagEvent = {
    kind: 10006, id: 'ff1', pubkey: WIRE_VENDOR, created_at: 2000,
    tags: [['p', WIRE_VENDOR], ['receipt', WIRE_HASH], ['review', REVIEW_EVENT_ID], ['rider', 'vendor-flag']],
    content: 'This deal never happened.',
  };
  const ridersArray = ridersOfRow(row, [flagEvent]);
  assert.equal(ridersArray.length, 1);
  assert.equal(ridersArray[0].rider, 'vendor-flag');
  assert.equal(ridersArray[0].text, 'This deal never happened.');
  // A row with no wire id has nothing to ride — no riders.
  assert.deepEqual(ridersOfRow({ vendorPubkey: WIRE_VENDOR, receiptHash: WIRE_HASH }, [flagEvent]), []);
  // RIDER_WORDS stays the founder three: vendor riders are the vendor's, a
  // supplement is never the vendor's, and each word lands once per pair.
  assert.deepEqual([...RIDER_WORDS].sort(), ['buyer-supplement', 'vendor-flag', 'vendor-rebuttal']);
});

test('the rider compose gate: authorship first, one shot per word per pair, ledger and wire both checked', () => {
  memoryStorage();
  const wireRow = { source: 'wire', id: REVIEW_EVENT_ID, vendorPubkey: WIRE_VENDOR, receiptHash: WIRE_HASH, buyerPubkey: WIRE_BUYER };
  // The vendor gets exactly the two vendor words, both free.
  const vendorWords = riderComposeOf(wireRow, { authorPubkey: WIRE_VENDOR, disputeEvents: [] });
  assert.deepEqual(vendorWords, [{ rider: 'vendor-flag', taken: false }, { rider: 'vendor-rebuttal', taken: false }]);
  // The buyer gets exactly the supplement.
  assert.deepEqual(riderComposeOf(wireRow, { authorPubkey: WIRE_BUYER, disputeEvents: [] }), [{ rider: 'buyer-supplement', taken: false }]);
  // A stranger gets nothing — no affordance at all.
  assert.equal(riderComposeOf(wireRow, { authorPubkey: '9'.repeat(64), disputeEvents: [] }), null);
  assert.equal(riderComposeOf(wireRow, { authorPubkey: null, disputeEvents: [] }), null);
  assert.equal(riderComposeOf(null, { authorPubkey: WIRE_VENDOR, disputeEvents: [] }), null);
  // The vendor never co-signs a supplement, whoever asks.
  const { vendor } = boundDeal({ orderId: 'order-r1' });
  const vendorRow = { source: 'wire', id: REVIEW_EVENT_ID, vendorPubkey: vendor, receiptHash: WIRE_HASH, buyerPubkey: vendor };
  assert.deepEqual(riderComposeOf(vendorRow, { authorPubkey: vendor, disputeEvents: [] }),
    [{ rider: 'vendor-flag', taken: false }, { rider: 'vendor-rebuttal', taken: false }]);
  // A rider of record on the wire has spent its word: the gate refuses it.
  const flagEvent = {
    kind: 10006, id: 'ff9', pubkey: WIRE_VENDOR, created_at: 2000,
    tags: [['p', WIRE_VENDOR], ['receipt', WIRE_HASH], ['review', REVIEW_EVENT_ID], ['rider', 'vendor-flag']],
    content: 'This deal never happened.',
  };
  const spent = riderComposeOf(wireRow, { authorPubkey: WIRE_VENDOR, disputeEvents: [flagEvent] });
  assert.deepEqual(spent, [{ rider: 'vendor-flag', taken: true }, { rider: 'vendor-rebuttal', taken: false }]);
  // A word this device already signed — the refetch may not have seen it —
  // is taken just the same, out of the local ledger.
  const vehicle = { ...wireRow, receiptHash: 'e1'.repeat(32), buyerPubkey: WIRE_BUYER };
  markOwnRider(WIRE_VENDOR, 'e1'.repeat(32), REVIEW_EVENT_ID, 'vendor-rebuttal', 'rr9');
  const ledgerSpent = riderComposeOf(vehicle, { authorPubkey: WIRE_VENDOR, disputeEvents: [] });
  assert.deepEqual(ledgerSpent, [{ rider: 'vendor-flag', taken: false }, { rider: 'vendor-rebuttal', taken: true }]);
  // A row with no wire event id rides nothing.
  assert.equal(riderComposeOf({ vendorPubkey: WIRE_VENDOR, receiptHash: WIRE_HASH }, { authorPubkey: WIRE_VENDOR, disputeEvents: [] }), null);
});

test('the tap-through reads the contract entries: the txids ride, rails stay apart', () => {
  // The entries the banner taps come out in the contract's own shape and
  // order, one per rail, never summed.
  const entries = provenEntriesOf({
    xmr: { count: 2, txids: ['cc'.repeat(32)], phrasing: 'recorded' },
    btc: { count: 1, txids: ['aa'.repeat(32)], phrasing: 'proven' },
  });
  assert.deepEqual(entries, [
    { count: 1, rail: 'btc', txids: ['aa'.repeat(32)], phrasing: 'proven' },
    { count: 2, rail: 'xmr', txids: ['cc'.repeat(32)], phrasing: 'recorded' },
  ]);
  assert.deepEqual(provenEntriesOf({}), []);
  assert.deepEqual(provenEntriesOf(null), []);
  // The BTC banner words are still the founder's, unchanged by the tap.
  assert.equal(provenBannerOf(entries[0]), '1 deal proven. One tap shows the txids.');
  assert.equal(provenBannerOf(entries[1]), '2 deals recorded on chain.');
});
