import assert from 'node:assert/strict';
import test from 'node:test';
import { applyWatcherReport, nextPaymentState } from './paymentState.js';

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
