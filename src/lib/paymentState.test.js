import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptAmount,
  acceptanceDemand,
  amountCovers,
  applyWatcherReport,
  confirmationsRequired,
  listedItem,
  nextPaymentState,
  orderCoinAmount,
  normalizeAmount,
} from './paymentState.js';

test('a dollar price is not a coin amount', () => {
  assert.equal(orderCoinAmount({ currency: 'USD', priceUsd: '40', price: '40' }, 'btc'), null);
  assert.equal(orderCoinAmount({ currency: 'btc', price: '0.01', priceUsd: '40' }, 'btc'), '0.01');
  assert.equal(orderCoinAmount({ currency: 'xmr', price: '0.2' }, 'btc'), null);
});

test('a menu row is found only by the id the order names it', () => {
  const menu = [
    { id: 'abc', name: 'Eighth', price: '40', currency: 'USD' },
    { id: 'def', name: 'Slims', price: '20', currency: 'USD' },
  ];
  assert.equal(listedItem({ id: 'abc' }, menu), menu[0]);
  assert.equal(listedItem({ id: 'ABC' }, menu), menu[0]);
  assert.equal(listedItem({ id: 'zzz' }, menu), null);
  assert.equal(listedItem({ id: 'abc' }, []), null);
  assert.equal(listedItem({}, menu), null);
  assert.equal(listedItem({ id: 'abc' }), null);
  // a d tag matches too, because store orders name menus by their d tag
  const tagged = [{ id: '111', d: 'tagged', price: '40', currency: 'USD' }];
  assert.equal(listedItem({ id: 'tagged' }, tagged), tagged[0]);
  assert.equal(listedItem({ id: '111' }, tagged), tagged[0]);
});

test('an acceptance demands the menu price the order names', () => {
  const menu = [
    { id: 'coin', price: '0.002', currency: 'BTC' },
    { id: 'usd', price: '40', currency: 'USD' },
  ];
  // a coin-priced menu row binds the acceptance to it
  assert.deepEqual(
    acceptanceDemand({ id: 'coin', title: 'Eighth', currency: 'USD', price: '40' }, menu, 'btc').kind,
    'listing',
  );
  // the matched row prices this item, and that is the amount
  assert.deepEqual(acceptanceDemand({ id: 'coin' }, menu, 'btc'), { kind: 'listing', currency: 'btc', amount: '0.002' });
  // a dollar-priced menu row refuses, and so does an unmatched dollar order
  assert.equal(acceptanceDemand({ id: 'usd', currency: 'USD', price: '40' }, menu, 'btc').kind, 'dollars');
  assert.equal(acceptanceDemand({ currency: 'USD', price: '40' }, [], 'btc').kind, 'dollars');
  // the menu prices it in the other coin
  const unit = acceptanceDemand({ id: 'coin' }, menu, 'xmr');
  assert.equal(unit.kind, 'unit');
  assert.equal(unit.currency, 'btc');
  // an order priced in coin that this menu has no row for, and an order with
  // no price at all, stay on the old free-amount path
  assert.equal(acceptanceDemand({ id: 'coin', currency: 'btc', price: '0.002' }, [], 'btc').kind, 'unbound');
  assert.equal(acceptanceDemand(null, [], 'btc').kind, 'unbound');
});

test('an order covers its menu only when the written amount reaches the menu price', () => {
  assert.equal(amountCovers('0.5', '0.4', 'btc'), true);
  assert.equal(amountCovers('0.4', '0.4', 'btc'), true);
  assert.equal(amountCovers('0.3', '0.4', 'btc'), false);
  assert.equal(amountCovers('0.00000001', '0.01', 'btc'), false);
  // an amount coins cannot spell never covers, so it cannot slip into an order
  assert.equal(amountCovers('0.10000000000000000000000009', '0.1', 'btc'), false);
  assert.equal(amountCovers('0.2', '0.2', 'xmr'), true);
  assert.equal(amountCovers('0.000000000001', '0.000000000001', 'xmr'), true);
});

test('the accept-time parser and the watcher parser read an amount the same way', () => {
  // the one parser both sides share, spelled the way receipts spell amounts
  assert.equal(normalizeAmount('$2.50'), '2.5');
  assert.equal(normalizeAmount(' 0.010000000000 '), '0.01');
  // accept keeps what the chain can express
  assert.equal(acceptAmount('0.001', 'btc'), '0.001');
  assert.equal(acceptAmount(' 0.010000000000 ', 'btc'), '0.01');
  assert.equal(acceptAmount('0.000000000001', 'xmr'), '0.000000000001');
  // and rejects what it cannot: over-scale decimals would sit short of the
  // order forever, so they never enter an acceptance
  assert.throws(() => acceptAmount('0.10000000000000000000000009', 'btc'), /finer than BTC can count/);
  assert.throws(() => acceptAmount('0.1000000001', 'btc'), /decimal places/);
  assert.throws(() => acceptAmount('0.0000000000001', 'btc'), /finer than BTC can count/);
  assert.throws(() => acceptAmount('0.0000000000000001', 'xmr'), /finer than XMR can count/);
  assert.throws(() => acceptAmount('0.1e3', 'btc'), /decimal string/);
  // nothing rounds at acceptance: a nine on the far edge is refused, not
  // carried up, because half-up belongs to a report of a real transaction
  assert.throws(() => acceptAmount('0.999999995', 'btc'), /finer than BTC can count/);
  assert.throws(() => acceptAmount('1', 'usd'), /Accept in BTC or XMR/);
});

test('a payment moves created, address issued, seen, confirmed, and skips nothing', () => {
  assert.equal(nextPaymentState('created', 'issue'), 'address_issued');
  assert.equal(nextPaymentState('address_issued', 'see'), 'seen');
  assert.equal(nextPaymentState('seen', 'confirm'), 'confirmed');
  assert.throws(() => nextPaymentState('created', 'confirm'), /cannot confirm/);
  assert.throws(() => nextPaymentState('address_issued', 'confirm'), /cannot confirm/);
  assert.throws(() => nextPaymentState('confirmed', 'see'), /cannot see/);
});

test('a dispute is not a payment state, and the table stays pure (security S6)', () => {
  // Nothing in the walk is named after, or triggered by, a dispute: the
  // dispute's life is the order status layer, and a refund is a transaction a
  // watcher reports on its own.
  for (const state of ['created', 'address_issued', 'seen', 'confirmed']) {
    assert.throws(() => nextPaymentState(state, 'dispute'), /cannot/);
    assert.throws(() => nextPaymentState(state, 'refund'), /cannot/);
    assert.throws(() => nextPaymentState(state, 'resolve'), /cannot/);
    assert.throws(() => nextPaymentState('disputed', 'confirm'), /cannot/);
  }
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
