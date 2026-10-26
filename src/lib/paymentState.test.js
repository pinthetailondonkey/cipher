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

test('an amount past the coin supply is a unit mix-up, and refuses rather than covers', () => {
  for (const amount of ['500000000000', '5e23', '9e9e9']) {
    assert.throws(
      () => applyWatcherReport({
        state: 'address_issued',
        watcherUrl: 'http://watcher.example',
        currency: 'xmr',
        amount: '0.5',
        report: { source: 'watcher', txid: 'atomic', confirmations: 10, amount },
      }),
      /(short of the order|is not a plain decimal coin amount)/,
      amount,
    );
  }
  assert.throws(
    () => applyWatcherReport({
      state: 'address_issued',
      watcherUrl: 'http://watcher.example',
      currency: 'btc',
      amount: '0.01',
      report: { source: 'watcher', txid: 'capped', confirmations: 3, amount: '21000000.1' },
    }),
    /short of the order/,
  );
  // A number from the wire is never a coin amount: it was rounded in JSON.
  assert.throws(
    () => applyWatcherReport({
      state: 'address_issued',
      watcherUrl: 'http://watcher.example',
      currency: 'btc',
      amount: '0.01',
      report: { source: 'watcher', txid: 'num', confirmations: 3, amount: 0.01 },
    }),
    /short of the order/,
  );
  // Plain orders inside the supply keep working.
  assert.equal(
    applyWatcherReport({
      state: 'address_issued',
      watcherUrl: 'http://watcher.example',
      currency: 'btc',
      amount: '0.01',
      report: { source: 'watcher', txid: 'ok', confirmations: 3, amount: '0.02' },
    }),
    'confirmed',
  );
});
