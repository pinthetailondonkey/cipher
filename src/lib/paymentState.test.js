import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWatcherReport, confirmationsRequired, nextPaymentState, orderCoinAmount } from './paymentState.js';

test('a dollar price is not a coin amount', () => {
  assert.equal(orderCoinAmount({ currency: 'USD', priceUsd: '40', price: '40' }, 'btc'), null);
  assert.equal(orderCoinAmount({ currency: 'btc', price: '0.01', priceUsd: '40' }, 'btc'), '0.01');
  assert.equal(orderCoinAmount({ currency: 'xmr', price: '0.2' }, 'btc'), null);
});

test('a payment moves created, address issued, seen, confirmed, and skips nothing', () => {
  assert.equal(nextPaymentState('created', 'issue'), 'address_issued');
  assert.equal(nextPaymentState('address_issued', 'see'), 'seen');
  assert.equal(nextPaymentState('seen', 'confirm'), 'confirmed');
  assert.throws(() => nextPaymentState('created', 'confirm'), /cannot confirm/);
  assert.throws(() => nextPaymentState('address_issued', 'confirm'), /cannot confirm/);
  assert.throws(() => nextPaymentState('confirmed', 'see'), /cannot see/);
});

test('the vendor device cannot confirm a payment, and an empty watcher refuses', () => {
  assert.throws(
    () => applyWatcherReport({ state: 'address_issued', watcherUrl: '', report: { source: 'watcher', txid: 'ab', confirmations: 10 } }),
    /does not check a block explorer/,
  );
  assert.throws(
    () => applyWatcherReport({ state: 'address_issued', watcherUrl: 'http://watcher.example', report: { source: 'vendor', txid: 'ab' } }),
    /Only a watcher report/,
  );
  assert.equal(
    applyWatcherReport({ state: 'address_issued', watcherUrl: 'http://watcher.example', report: { source: 'watcher', txid: 'ab', confirmations: 0 } }),
    'seen',
  );
  assert.equal(
    applyWatcherReport({ state: 'address_issued', watcherUrl: 'http://watcher.example', report: { source: 'watcher', txid: 'ab', confirmations: 10 } }),
    'confirmed',
  );
});

test('confirmation depth is per currency, and a flag alone cannot confirm', () => {
  assert.equal(confirmationsRequired('btc'), 3);
  assert.equal(confirmationsRequired('xmr'), 10);
  assert.equal(confirmationsRequired('btc', { btc: 6 }), 6);
  assert.equal(
    applyWatcherReport({
      state: 'address_issued',
      watcherUrl: 'http://watcher.example',
      currency: 'btc',
      report: { source: 'watcher', txid: 'ab', confirmations: 3, confirmed: false },
    }),
    'confirmed',
  );
  assert.throws(
    () => applyWatcherReport({
      state: 'seen',
      watcherUrl: 'http://watcher.example',
      currency: 'btc',
      report: { source: 'watcher', txid: 'ab', confirmations: 2, confirmed: true },
    }),
    /did not move/,
  );
  assert.throws(
    () => applyWatcherReport({
      state: 'seen',
      watcherUrl: 'http://watcher.example',
      currency: 'xmr',
      report: { source: 'watcher', txid: 'ab', confirmations: 9, confirmed: true },
    }),
    /did not move/,
  );
  assert.throws(
    () => applyWatcherReport({
      state: 'address_issued',
      watcherUrl: 'http://watcher.example',
      currency: 'btc',
      amount: '0.01',
      report: { source: 'watcher', txid: 'dust', confirmations: 3, amount: '0.00000001' },
    }),
    /short of the order/,
  );
  assert.throws(
    () => applyWatcherReport({
      state: 'address_issued',
      watcherUrl: 'http://watcher.example',
      currency: 'btc',
      amount: '0.01',
      report: { source: 'watcher', txid: 'bare', confirmations: 3 },
    }),
    /did not report an amount/,
  );
  assert.equal(
    applyWatcherReport({
      state: 'address_issued',
      watcherUrl: 'http://watcher.example',
      currency: 'btc',
      amount: '0.01',
      report: { source: 'watcher', txid: 'paid', confirmations: 3, amount: '0.01' },
    }),
    'confirmed',
  );
});
