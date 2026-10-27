import assert from 'node:assert/strict';
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
  reviewEligibility,
  reviewOfferForOrder,
  reviewSummaryOf,
  reviewsForVendor,
  saveReview,
  wholeMonthsBetween,
} from './vendorReviews.js';
import { publicReceipt, rememberPublicView, signPublicView, signReceipt, verifyPublicView } from './proofOfTrade.js';


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

test('the offer reads the scoped records and the derived order state', () => {
  memoryStorage();
  const { buyer, vendor } = boundDeal({ orderId: 'order-2', at: 1_700_000_000 });
  const messages = [
    { id: 'order-2', isSender: true, pubkey: buyer, data: { type: 'cipher_order', status: 'pending' } },
    { id: 'u1', isSender: false, pubkey: vendor, timestamp: 2, data: { type: 'order_update', orderId: 'order-2', status: 'completed' } },
  ];
  const offer = reviewOfferForOrder({ messages, order: messages[0], buyerPubkey: buyer, vendorPubkey: vendor });
  assert.ok(offer);
  assert.equal(offer.orderId, 'order-2');
  assert.equal(offer.vendorPubkey, vendor);
  assert.equal(offer.orderMonth, '2023-11');
  // A deal not yet completed: no offer, no button.
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
