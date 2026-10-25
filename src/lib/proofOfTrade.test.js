import assert from 'node:assert/strict';
import test from 'node:test';
import { schnorr } from '@noble/curves/secp256k1.js';
import { publicReceipt, signReceipt, verifyReceipt } from './proofOfTrade.js';

test('a receipt signs, verifies, and publishes only the hash', () => {
  const sk = schnorr.utils.randomSecretKey();
  const signed = signReceipt(sk, {
    orderId: 'order-1',
    buyer: 'aa',
    vendor: 'bb',
    currency: 'XMR',
    address: '8secret',
    amount: '2',
    txid: 'deadbeef',
  });
  assert.equal(verifyReceipt(signed), true);
  assert.deepEqual(publicReceipt(signed), { v: 1, hash: signed.hash });
  assert.equal(JSON.stringify(publicReceipt(signed)).includes('8secret'), false);
  assert.equal(JSON.stringify(publicReceipt(signed)).includes('deadbeef'), false);
  assert.equal(verifyReceipt({ ...signed, hash: `00${signed.hash.slice(2)}` }), false);
  assert.equal(verifyReceipt({ ...signed, body: { ...signed.body, txid: 'other' } }), false);
});
