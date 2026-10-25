import assert from 'node:assert/strict';
import test from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { publicReceipt, signReceipt, verifyReceipt } from './proofOfTrade.js';

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
  assert.deepEqual(publicReceipt(signed), { v: 1, hash: signed.hash });
  assert.equal(JSON.stringify(publicReceipt(signed)).includes('8secret'), false);
  assert.equal(JSON.stringify(publicReceipt(signed)).includes('deadbeef'), false);
  assert.equal(verifyReceipt({ ...signed, hash: `00${signed.hash.slice(2)}` }), false);
  assert.equal(verifyReceipt({ ...signed, body: { ...signed.body, txid: 'other' } }), false);
  const moved = signReceipt(vendorKey, { ...body, at: body.at + 1 });
  assert.notEqual(moved.hash, signed.hash);
});