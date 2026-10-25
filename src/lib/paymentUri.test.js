import assert from 'node:assert/strict';
import test from 'node:test';
import { paymentRowsFor } from './paymentUri.js';

const accepted = (extra = {}) => ({
  type: 'order_update',
  status: 'accepted',
  product: { title: 'Tee', price: '40', currency: 'USD', priceUsd: '40' },
  paymentMethods: { btc: 'bc1qorder', xmr: null },
  coinAmount: '0.001',
  coinCurrency: 'btc',
  ...extra,
});

test('the accepted card gives the buyer the coin amount, the address, and a URI with both', () => {
  assert.deepEqual(paymentRowsFor(accepted()), [
    { currency: 'BTC', address: 'bc1qorder', amount: '0.001', uri: 'bitcoin:bc1qorder?amount=0.001' },
  ]);
  const xmr = paymentRowsFor(accepted({ paymentMethods: { xmr: '8sub' }, coinAmount: '0.25', coinCurrency: 'xmr' }));
  assert.deepEqual(xmr, [{ currency: 'XMR', address: '8sub', amount: '0.25', uri: 'monero:8sub?tx_amount=0.25' }]);
});

test('only the coin the vendor priced in is offered, because only that coin is checked', () => {
  const both = paymentRowsFor(accepted({ paymentMethods: { btc: 'bc1qorder', xmr: '8sub' }, coinAmount: '0.25', coinCurrency: 'xmr' }));
  assert.deepEqual(both.map((row) => row.currency), ['XMR']);
});

test('an order with no coin amount still shows the address, and nothing shows before acceptance', () => {
  const legacy = paymentRowsFor(accepted({ coinAmount: undefined, coinCurrency: undefined }));
  assert.deepEqual(legacy, [{ currency: 'BTC', address: 'bc1qorder', amount: '', uri: 'bitcoin:bc1qorder' }]);
  assert.deepEqual(paymentRowsFor(accepted({ status: 'pending' })), []);
  assert.deepEqual(paymentRowsFor({ type: 'order_request', status: 'accepted', paymentMethods: { btc: 'bc1q' } }), []);
});
