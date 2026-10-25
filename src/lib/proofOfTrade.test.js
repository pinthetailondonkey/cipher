import assert from 'node:assert/strict';
import test from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { acceptPayment, canonicalReceipt, normalizeAmount, publicReceipt, rankVolume, rankVolumeByStanding, receiptAtPayment, signPublicView, signReceipt, verifyPublicView, verifyReceipt, verifyVendorView } from './proofOfTrade.js';

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
  const signed = receiptAtPayment(vendorKey, buyerKey, body);
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
  assert.deepEqual(rankVolume([{ hash: 'dust', amount: '0.000000001', currency: 'btc', buyer: 'aa', vendor: 'pp' }]), []);
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

test('a self-trade does not verify', () => {
  const key = schnorr.utils.randomSecretKey();
  const pub = hex(schnorr.getPublicKey(key));
  const receipt = signReceipt(key, {
    orderId: 'self', buyer: pub, vendor: pub, currency: 'xmr', address: '8', amount: '1', txid: 'ab', at: 10, outcome: 'confirmed',
  });
  const copied = { ...receipt, sigs: { buyer: receipt.sigs.buyer, vendor: receipt.sigs.buyer } };
  assert.equal(verifyReceipt(copied), false);
});