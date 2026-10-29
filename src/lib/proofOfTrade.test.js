import assert from 'node:assert/strict';
import test from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { acceptPayment, canonicalReceipt, coSignPayment, countersignToSend, normalizeAmount, publicReceipt, rankVolume, rankVolumeByStanding, receiptBindsOrder, sendCountersignOnce, signPublicView, signReceipt, verifyPublicView, verifyReceipt, verifyVendorView } from './proofOfTrade.js';

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

test('both parties sign the same bytes, and one bad signature fails', () => {
  const buyerKey = schnorr.utils.randomSecretKey();
  const vendorKey = schnorr.utils.randomSecretKey();
  const body = {
    orderId: 'order-1',
    buyer: hex(schnorr.getPublicKey(buyerKey)),
    vendor: hex(schnorr.getPublicKey(vendorKey)),
    currency: 'XMR',
    address: '8secret',
    amount: '2',
    txid: 'deadbeef',
    at: 1_700_000_000,
    outcome: 'confirmed',
  };
  const vendorSigned = signReceipt(vendorKey, body);
  assert.equal(verifyReceipt(vendorSigned), false);
  const signed = coSignPayment(signReceipt(vendorKey, body), buyerKey);
  assert.equal(verifyReceipt(signed), true);
  const arriving = acceptPayment({
    type: 'order_update', status: 'paid', orderId: body.orderId, receipt: vendorSigned,
  }, buyerKey);
  assert.equal(arriving.added, true);
  assert.equal(verifyReceipt(arriving.receipt), true);
  const echoed = acceptPayment({
    type: 'order_update', status: 'paid', orderId: body.orderId, receipt: arriving.receipt,
  }, vendorKey);
  assert.equal(echoed.added, false);
  assert.equal(verifyReceipt(echoed.receipt), true);
  assert.equal(signed.body.buyer, body.buyer);
  assert.equal(signed.body.vendor, body.vendor);
  assert.equal(signed.hash, vendorSigned.hash);
  assert.equal(verifyReceipt({ ...signed, sigs: { ...signed.sigs, buyer: signed.sigs.vendor } }), false);
  assert.equal(verifyReceipt({ ...signed, sigs: { ...signed.sigs, vendor: signed.sigs.buyer } }), false);
  const view = publicReceipt(signed);
  assert.deepEqual(view, {
    v: 1,
    hash: signed.hash,
    amount: '2',
    currency: 'xmr',
    buyer: body.buyer,
    vendor: body.vendor,
  });
  assert.equal(JSON.stringify(view).includes('8secret'), false);
  assert.equal(JSON.stringify(view).includes('deadbeef'), false);
  const vendorView = signPublicView(vendorKey, view);
  assert.equal(verifyPublicView(vendorView), false);
  assert.equal(verifyVendorView(vendorView), true);
  const published = signPublicView(buyerKey, vendorView);
  assert.equal(verifyPublicView(published), true);
  assert.equal(verifyPublicView({ ...published, amount: '9' }), false);
  assert.equal('body' in published, false);
  assert.equal('address' in published, false);
  const split = rankVolumeByStanding([published, vendorView, view]);
  assert.equal(split.countersigned[0].volume, '2');
  assert.equal(split.vendor[0].vendor, body.vendor);
  const coSigned = acceptPayment({
    type: 'order_update', status: 'paid', orderId: body.orderId, receipt: vendorSigned, published: vendorView,
  }, buyerKey);
  assert.equal(verifyPublicView(coSigned.published), true);
  const ranked = rankVolume([
    view,
    { v: 1, hash: 'aa', amount: '5', currency: 'xmr', buyer: body.buyer, vendor: 'ff' },
    { v: 1, hash: 'bb', amount: '1.5', currency: 'xmr', buyer: body.buyer, vendor: body.vendor, address: '8secret', txid: 'deadbeef' },
  ]);
  assert.equal(normalizeAmount('$2.50'), '2.5');
  assert.equal(normalizeAmount(2), '2');
  assert.equal(normalizeAmount(2.5), '2.5');
  assert.equal(rankVolume([{ v: 1, hash: 'cc', amount: '2.50', currency: 'xmr', buyer: body.buyer, vendor: body.vendor }])[0].volume, '2.5');
  assert.equal(rankVolume([
    { hash: 'p1', amount: '0.000000000001', currency: 'xmr', buyer: 'aa', vendor: 'pp' },
    { hash: 'p2', amount: '0.000000000001', currency: 'xmr', buyer: 'aa', vendor: 'pp' },
  ])[0].volume, '0.000000000002');
  assert.equal(rankVolume([{ hash: 'dust', amount: '0.00000001', currency: 'btc', buyer: 'aa', vendor: 'pp' }])[0].volume, '0.00000001');
  // An amount finer than the coin counts is refused, not rounded — a crafted
  // view cannot buy its way onto the board by rounding up.
  assert.deepEqual(rankVolume([{ hash: 'dust', amount: '0.000000001', currency: 'btc', buyer: 'aa', vendor: 'pp' }]), []);
  assert.deepEqual(rankVolume([{ hash: 'up', amount: '1.000000005', currency: 'btc', buyer: 'aa', vendor: 'pp' }]), []);
  // The currency is a string a published view chose. A name that reaches the
  // scale table's prototype used to walk past the null guard and throw on
  // BigInt(scale): 'constructor' is a function and '__proto__' an object, and
  // one crafted view took the whole board down with a SyntaxError. A name
  // that is not a coin is not ranked, and the real coins are.
  for (const hostile of ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf', 'usd']) {
    assert.deepEqual(rankVolume([{ hash: 'h', amount: '1', currency: hostile, buyer: 'aa', vendor: 'pp' }]), [], hostile);
  }
  for (const coin of ['btc', 'xmr']) {
    assert.deepEqual(rankVolume([{ hash: 'h', amount: '1', currency: coin, buyer: 'aa', vendor: 'pp' }]),
      [{ vendor: 'pp', currency: coin, volume: '1' }], coin);
  }
  assert.deepEqual(ranked, [
    { vendor: 'ff', currency: 'xmr', volume: '5' },
    { vendor: body.vendor, currency: 'xmr', volume: '2' },
  ]);
  assert.equal(verifyReceipt({ ...signed, hash: `00${signed.hash.slice(2)}` }), false);
  assert.equal(verifyReceipt({ ...signed, body: { ...signed.body, txid: 'other' } }), false);
  const moved = signReceipt(vendorKey, { ...body, at: body.at + 1 });
  assert.notEqual(moved.hash, signed.hash);
});

test('outcome is the vendor assertion at signing, not a dispute', () => {
  const base = {
    orderId: 'order-1', buyer: 'aa', vendor: 'bb', currency: 'xmr', address: '8', amount: '1', txid: 'ab', at: 10,
  };
  assert.equal(canonicalReceipt({ ...base, outcome: 'confirmed' }).outcome, 'confirmed');
  assert.equal(canonicalReceipt({ ...base, outcome: 'disputed' }).outcome, '');
  assert.throws(() => canonicalReceipt({ ...base, at: undefined }), /time/);
  assert.throws(() => canonicalReceipt({ ...base, at: 0 }), /time/);
});

test('a bad time or a missing amount does not throw', () => {
  assert.equal(verifyReceipt({
    hash: '00',
    body: { orderId: 'x', buyer: 'aa', vendor: 'bb', currency: 'xmr', address: '8', amount: '1', txid: 'ab', at: 0, outcome: 'confirmed' },
    sigs: { buyer: 'aa', vendor: 'bb' },
  }), false);
  assert.equal(verifyPublicView({
    v: 1, hash: 'aa', amount: '', currency: 'xmr', buyer: 'aa', vendor: 'bb', sigs: { buyer: '11', vendor: '22' },
  }), false);
  assert.equal(publicReceipt({ body: { at: 0, amount: '1', buyer: 'aa', vendor: 'bb' } }), null);
});

test('a self-trade does not verify', () => {
  const key = schnorr.utils.randomSecretKey();
  const pub = hex(schnorr.getPublicKey(key));
  const receipt = signReceipt(key, {
    orderId: 'self', buyer: pub, vendor: pub, currency: 'xmr', address: '8', amount: '1', txid: 'ab', at: 10, outcome: 'confirmed',
  });
  const copied = { ...receipt, sigs: { buyer: receipt.sigs.buyer, vendor: receipt.sigs.buyer } };
  assert.equal(verifyReceipt(copied), false);
});

test('a second ranking of the same views does not verify again', () => {
  const buyerKey = schnorr.utils.randomSecretKey();
  const vendorKey = schnorr.utils.randomSecretKey();
  const buyer = hex(schnorr.getPublicKey(buyerKey));
  const vendor = hex(schnorr.getPublicKey(vendorKey));
  const view = { v: 1, hash: 'ab', amount: '1', currency: 'xmr', buyer, vendor };
  const published = signPublicView(buyerKey, signPublicView(vendorKey, view));
  const once = rankVolumeByStanding([published]);
  const twice = rankVolumeByStanding([published]);
  assert.equal(twice.countersigned[0].volume, once.countersigned[0].volume);
});

test('a receipt binds only the order it matches', () => {
  const buyerKey = schnorr.utils.randomSecretKey();
  const vendorKey = schnorr.utils.randomSecretKey();
  const buyer = hex(schnorr.getPublicKey(buyerKey));
  const vendor = hex(schnorr.getPublicKey(vendorKey));
  const bindings = {
    orderId: 'order-1',
    orderCoinAmount: '0.01',
    issuedAddress: 'bc1qorder',
    orderCurrency: 'btc',
    buyerPubkey: buyer,
    vendorPubkey: vendor,
    update: { orderId: 'order-1' },
  };
  const receipt = signReceipt(vendorKey, {
    orderId: 'order-1', buyer, vendor, currency: 'btc',
    address: 'bc1qorder', amount: '0.01', txid: 'aa', at: 1_700_000_000, outcome: 'confirmed',
  });
  assert.equal(receiptBindsOrder({ ...bindings, receipt }), true);
  // A larger single output may cover the order; a smaller one never does.
  const overpaid = signReceipt(vendorKey, {
    ...receipt.body, amount: '0.02', txid: 'bb', at: 1_700_000_001, outcome: 'confirmed',
  });
  assert.equal(receiptBindsOrder({ ...bindings, receipt: overpaid, orderCoinAmount: '0.01' }), true);
  const bind = (over = {}, overBody = {}) => receiptBindsOrder({
    ...bindings, ...over,
    receipt: { body: { ...receipt.body, ...overBody } },
  });
  // Wrong orderId on the receipt, or on the update that carried it.
  assert.equal(bind({ orderId: 'order-2' }), false);
  assert.equal(bind({ update: { orderId: 'order-9' } }), false);
  // Amount short of the order, or an order this device has no amount for.
  assert.equal(bind({ orderCoinAmount: '0.011' }), false);
  assert.equal(bind({ orderCoinAmount: null }), false);
  assert.equal(bind({ orderCoinAmount: '' }), false);
  // An amount finer than the coin counts is refused, not rounded — the
  // 0.9999999999999 shape must not walk through a 1 gate by rounding up.
  assert.equal(bind({ orderCoinAmount: '1' }, { amount: '0.9999999999999' }), false);
  assert.equal(bind({ orderCoinAmount: '1' }, { amount: '1.0000000000001' }), false);
  assert.equal(bind({ orderCoinAmount: '1.00000001' }, { amount: '1.00000001' }), true);
  // A receipt in another coin never binds.
  assert.equal(bind({}, { currency: 'xmr' }), false);
  // Address mismatches on the receipt, or on the update.
  assert.equal(bind({}, { address: 'bc1qother' }), false);
  assert.equal(bind({ update: { orderId: 'order-1', address: 'bc1qother' } }), false);
  assert.equal(bind({ issuedAddress: '' }), false);
  // The receipt must name exactly the two parties of this chat.
  assert.equal(bind({ buyerPubkey: 'ff' }), false);
  assert.equal(bind({ vendorPubkey: 'ff' }), false);
  // No receipt body, no binding.
  assert.equal(receiptBindsOrder({ ...bindings, receipt: null }), false);
  assert.equal(receiptBindsOrder({ ...bindings, receipt: { sigs: receipt.sigs } }), false);
});

function memoryStorage() {
  const memory = new Map();
  globalThis.localStorage = {
    getItem: (key) => (memory.has(key) ? memory.get(key) : null),
    setItem: (key, value) => memory.set(key, String(value)),
    removeItem: (key) => memory.delete(key),
    key: (index) => Array.from(memory.keys())[index] || null,
    get length() { return memory.size; },
  };
}

function vendorOnlyOrder(orderId) {
  const buyerKey = schnorr.utils.randomSecretKey();
  const vendorKey = schnorr.utils.randomSecretKey();
  const vendor = hex(schnorr.getPublicKey(vendorKey));
  const receipt = signReceipt(vendorKey, {
    orderId, buyer: hex(schnorr.getPublicKey(buyerKey)), vendor, currency: 'btc',
    address: 'bc1qorder', amount: '0.01', txid: 'aa', at: 1_700_000_000, outcome: 'confirmed',
  });
  return { buyerKey, vendor, relayCopy: { type: 'order_update', status: 'paid', orderId, receipt } };
}

test('opening the app twice sends the buyer signature to the vendor once', async () => {
  memoryStorage();
  const { buyerKey, vendor, relayCopy } = vendorOnlyOrder('order-twice');
  const sends = [];
  const sendDM = async (to, payload) => { sends.push({ to, payload }); return { success: true }; };
  const first = acceptPayment(relayCopy, buyerKey);
  assert.equal(first.added, true);
  assert.equal(await sendCountersignOnce({ sendDM, counterparty: vendor, orderId: 'order-twice', accepted: first }), true);
  // The relay serves the same vendor-only receipt again, so acceptPayment still says added.
  const second = acceptPayment(relayCopy, buyerKey);
  assert.equal(second.added, true);
  assert.equal(countersignToSend(second, first.receipt.hash), false);
  assert.equal(await sendCountersignOnce({ sendDM, counterparty: vendor, orderId: 'order-twice', accepted: second }), false);
  assert.equal(sends.length, 1);
  assert.equal(sends[0].to, vendor);
  assert.equal(verifyReceipt(sends[0].payload.receipt), true);
});

test('a countersign that does not send says so, and the next load tries again', async () => {
  memoryStorage();
  const { buyerKey, vendor, relayCopy } = vendorOnlyOrder('order-retry');
  const failures = [];
  const onFailure = (error) => failures.push(error);
  const accepted = acceptPayment(relayCopy, buyerKey);
  const rejected = async () => ({ success: false, error: 'All relays rejected' });
  assert.equal(await sendCountersignOnce({ sendDM: rejected, counterparty: vendor, orderId: 'order-retry', accepted, onFailure }), false);
  const thrown = async () => { throw new Error('socket closed'); };
  assert.equal(await sendCountersignOnce({ sendDM: thrown, counterparty: vendor, orderId: 'order-retry', accepted, onFailure }), false);
  assert.deepEqual(failures, ['All relays rejected', 'socket closed']);
  let sent = 0;
  let release;
  const slow = () => new Promise((resolve) => { sent += 1; release = () => resolve({ success: true }); });
  const both = [
    sendCountersignOnce({ sendDM: slow, counterparty: vendor, orderId: 'order-retry', accepted, onFailure }),
    sendCountersignOnce({ sendDM: slow, counterparty: vendor, orderId: 'order-retry', accepted, onFailure }),
  ];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual(await Promise.all(both), [true, false]);
  assert.equal(sent, 1);
});

test('the vendor signature is never granted to a one-sided receipt, and a doctored view rides nowhere', () => {
  // security F4 re-attack: a buyer-fabricated receipt on a real order passes
  // every binding check — the amount and address are the order's own — so
  // only the watcher-side role may originate the vendor signature. A
  // vendor-only receipt is the normal artifact the buyer receives; the
  // reverse, a buyer-only receipt reaching the vendor, is fabricated, and
  // the vendor's device refusing to cosign is what keeps its fake txid
  // from being certified.
  const buyerKey = schnorr.utils.randomSecretKey();
  const vendorKey = schnorr.utils.randomSecretKey();
  const body = {
    orderId: 'order-harvest',
    buyer: hex(schnorr.getPublicKey(buyerKey)),
    vendor: hex(schnorr.getPublicKey(vendorKey)),
    currency: 'xmr',
    address: '8secret',
    amount: '2',
    txid: 'fabricated',
    at: 1_700_000_000,
    outcome: 'confirmed',
  };
  const buyerOnly = signReceipt(buyerKey, body);
  assert.equal(verifyReceipt(buyerOnly), false);
  const refused = acceptPayment({
    type: 'order_update', status: 'paid', orderId: body.orderId, receipt: buyerOnly,
  }, vendorKey);
  assert.equal(refused, null);
  // A doctored public view beside a real receipt is dropped, not signed.
  const real = coSignPayment(signReceipt(vendorKey, body), buyerKey);
  assert.equal(verifyReceipt(real), true);
  const doctored = acceptPayment({
    type: 'order_update', status: 'paid', orderId: body.orderId, receipt: real, published: { ...publicReceipt(real), amount: '999' },
  }, vendorKey);
  assert.equal(doctored.published, null);
  assert.equal(verifyReceipt(doctored.receipt), true);
  // The matching view still carries: the buyer's countersign of the view
  // rides beside the receipt, and the vendor's device completes it.
  const buyerView = signPublicView(buyerKey, publicReceipt(real));
  const carried = acceptPayment({
    type: 'order_update', status: 'paid', orderId: body.orderId, receipt: real, published: buyerView,
  }, vendorKey);
  assert.equal(verifyPublicView(carried.published), true);
});

test('the view the countersign blesses comes from the signed body, never the envelope', () => {
  // security re-attack A1: the receipt's top-level amount/currency/buyer/
  // vendor fields are outside the signature. A malicious vendor re-sending
  // the real two-signed receipt with an inflated top-level amount, plus a
  // matching doctored view, must not get the buyer's signature on the lie —
  // the compare reads the body only, so expected and view can no longer
  // both agree on attacker-chosen values.
  const buyerKey = schnorr.utils.randomSecretKey();
  const vendorKey = schnorr.utils.randomSecretKey();
  const body = {
    orderId: 'order-envelope',
    buyer: hex(schnorr.getPublicKey(buyerKey)),
    vendor: hex(schnorr.getPublicKey(vendorKey)),
    currency: 'xmr',
    address: '8secret',
    amount: '2',
    txid: 'ab',
    at: 1_700_000_000,
    outcome: 'confirmed',
  };
  const real = coSignPayment(signReceipt(vendorKey, body), buyerKey);
  const inflated = { ...real, amount: '7000' };
  const inflatedView = { ...publicReceipt(real), amount: '7000' };
  const wanting = acceptPayment({
    type: 'order_update', status: 'paid', orderId: body.orderId, receipt: inflated,
    published: inflatedView,
  }, buyerKey);
  // The receipt still verifies (the top-level fields are not in the signed
  // bytes), but the view it proposes names 7000 where the body says 2, so
  // the buyer's signature never lands on it.
  assert.equal(verifyReceipt(wanting.receipt), true);
  assert.equal(wanting.published, null);
  // The same lie credited to a third party rides nowhere either.
  const accomplice = { ...real, vendor: hex(schnorr.utils.randomSecretKey()) };
  const named = acceptPayment({
    type: 'order_update', status: 'paid', orderId: body.orderId, receipt: accomplice,
    published: { ...publicReceipt(real), vendor: accomplice.vendor },
  }, buyerKey);
  assert.equal(named.published, null);
});
