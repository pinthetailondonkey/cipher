import assert from 'node:assert/strict';
import test from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { publicReceipt, rankVolume, signReceipt, verifyReceipt } from './proofOfTrade.js';

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
  const signed = signReceipt(buyerKey, vendorSigned.body, vendorSigned);
  assert.equal(verifyReceipt(signed), true);
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
  const ranked = rankVolume([
    view,
    { v: 1, hash: 'aa', amount: '5', currency: 'xmr', buyer: body.buyer, vendor: 'ff' },
    { v: 1, hash: 'bb', amount: '1.5', currency: 'xmr', buyer: body.buyer, vendor: body.vendor, address: '8secret', txid: 'deadbeef' },
  ]);
  assert.deepEqual(ranked, [
    { vendor: 'ff', currency: 'xmr', volume: '5' },
    { vendor: body.vendor, currency: 'xmr', volume: '2' },
  ]);
  assert.equal(verifyReceipt({ ...signed, hash: `00${signed.hash.slice(2)}` }), false);
  assert.equal(verifyReceipt({ ...signed, body: { ...signed.body, txid: 'other' } }), false);
  const moved = signReceipt(vendorKey, { ...body, at: body.at + 1 });
  assert.notEqual(moved.hash, signed.hash);
});