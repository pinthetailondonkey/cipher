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
    at: 1_700_000_000,
    outcome: 'confirmed',
  });
  assert.equal(signed.body.at, 1_700_000_000);
  assert.equal(signed.body.outcome, 'confirmed');
  const other = signReceipt(sk, { ...signed.body, at: signed.body.at + 1 });
  assert.notEqual(other.hash, signed.hash);
  const rugged = signReceipt(sk, { ...signed.body, outcome: 'rugged' });
  assert.notEqual(rugged.hash, signed.hash);
  assert.equal(verifyReceipt(signed), true);
  assert.deepEqual(publicReceipt(signed), { v: 1, hash: signed.hash });
  assert.equal(JSON.stringify(publicReceipt(signed)).includes('8secret'), false);
  assert.equal(JSON.stringify(publicReceipt(signed)).includes('deadbeef'), false);
  assert.equal(verifyReceipt({ ...signed, hash: `00${signed.hash.slice(2)}` }), false);
  assert.equal(verifyReceipt({ ...signed, body: { ...signed.body, txid: 'other' } }), false);
});
