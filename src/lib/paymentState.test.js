import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptAmount,
  acceptanceDemand,
  amountCovers,
  applyWatcherReport,
  assetOf,
  coinUnits,
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
  // and rounds what the coin cannot express, half up, to the coin's own
  // scale — CLAUDE.md's "round half up, never drop" — so a float's noise
  // cannot sit short of the order forever
  assert.equal(acceptAmount('0.10000000000000000000000009', 'btc'), '0.1');
  assert.equal(acceptAmount('0.1000000001', 'btc'), '0.1');
  assert.equal(acceptAmount('0.123456785', 'btc'), '0.12345679', 'a five in the first dropped place carries');
  assert.equal(acceptAmount('0.123456784', 'btc'), '0.12345678', 'a four in the first dropped place does not');
  assert.equal(acceptAmount('0.999999995', 'btc'), '1', 'the carry rolls into the whole coin');
  assert.equal(acceptAmount('0.0000000000015', 'xmr'), '0.000000000002');
  assert.throws(() => acceptAmount('0.1e3', 'btc'), /decimal string/);
  // rounding to nothing is a dropped amount wearing a zero, so it is refused
  assert.throws(() => acceptAmount('0.0000000000001', 'btc'), /rounds away to nothing/);
  assert.throws(() => acceptAmount('0.0000000000000001', 'xmr'), /rounds away to nothing/);
  assert.throws(() => acceptAmount('1', 'usd'), /not one of them/, 'a dollar price never reads as a coin the device checks');
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

const watcherArgs = (extra) => ({
  state: 'seen',
  watcherUrl: 'http://watcher.example',
  currency: 'btc',
  report: { source: 'watcher', txid: 'ab', confirmations: 3, amount: '0.00000001' },
  ...extra,
});

test('a demand with no amount, an empty one or a zero one never confirms', () => {
  for (const amount of [null, '', '0', '0.0', '0.00000000']) {
    assert.throws(() => applyWatcherReport(watcherArgs({ amount })), /amount/i, `amount ${JSON.stringify(amount)}`);
  }
  assert.equal(applyWatcherReport(watcherArgs({ amount: '0.00000001' })), 'confirmed');
});

// The currency is a string a peer typed. A name that reaches the asset table's
// prototype is not an asset: 'constructor' used to answer with a function and
// '__proto__' with an object, and the chain check then threw a raw TypeError
// (BigInt(undefined)) halfway through instead of refusing.
test('a currency that is not a coin is not an asset, however it is spelled', () => {
  for (const hostile of ['constructor', '__proto__', 'hasOwnProperty', 'toString', 'valueOf']) {
    assert.equal(assetOf(hostile), null, hostile);
    assert.equal(coinUnits('1', hostile), null, hostile);
    assert.equal(coinUnits('1', hostile.toUpperCase()), null, `${hostile} uppercased`);
  }
  // The real rails still read, and the watcher door still refuses a demand in
  // a made-up currency with its own sentence rather than a TypeError.
  assert.deepEqual(assetOf('BTC'), { scale: 8, depth: 3, chain: 'transparent' });
  assert.equal(coinUnits('1', 'xmr'), 1000000000000n);
  assert.throws(() => applyWatcherReport(watcherArgs({ currency: 'constructor', amount: '1' })), /amount/i);
  assert.throws(() => applyWatcherReport(watcherArgs({ currency: '__proto__', amount: '1' })), /amount/i);
});

test('a float is not a coin amount: a JS number never reads as one', () => {
  for (const value of [0.5, 0.1, 1, 0.00000001, 1e-7, NaN, Infinity]) {
    assert.equal(coinUnits(value, 'btc'), null, String(value));
    assert.equal(amountCovers(value, '0.00000001', 'btc'), false, `reported ${value}`);
    assert.equal(amountCovers('1', value, 'btc'), false, `expected ${value}`);
  }
  assert.equal(coinUnits('0.5', 'btc'), 50000000n);
  assert.equal(coinUnits('0.5', 'xmr'), 500000000000n);
  // 0.1 + 0.2 is not 0.3 as a float; as text there is no such drift.
  assert.equal(amountCovers('0.3', '0.3', 'btc'), true);
  assert.throws(
    () => applyWatcherReport(watcherArgs({ amount: '0.00000001', report: { source: 'watcher', txid: 'ab', confirmations: 3, amount: 0.5 } })),
    /short of the order/,
  );
  assert.throws(() => applyWatcherReport(watcherArgs({ amount: 0.5 })), /amount/i);
});

test('a threshold that is zero, negative, fractional or garbled never lowers the depth', () => {
  const shallow = (extra) => watcherArgs({ state: 'address_issued', report: { source: 'watcher', txid: 'ab', confirmations: 1, amount: '1' }, amount: '1', ...extra });
  for (const threshold of [0, -1, 0.5, 2.5, NaN, 'abc', '', {}, Infinity]) {
    assert.equal(applyWatcherReport(shallow({ threshold })), 'seen', `threshold ${String(threshold)} on a 1-deep payment`);
  }
  // Left out or null means the currency's own depth, and a real override holds.
  assert.equal(applyWatcherReport(shallow({ threshold: null })), 'seen');
  assert.equal(applyWatcherReport(shallow({})), 'seen');
  const deep = (extra) => shallow({ report: { source: 'watcher', txid: 'ab', confirmations: 2, amount: '1' }, ...extra });
  assert.equal(applyWatcherReport(deep({ threshold: 2 })), 'confirmed');
  assert.equal(applyWatcherReport(deep({ threshold: '2' })), 'confirmed');
  assert.equal(applyWatcherReport(deep({ threshold: 5 })), 'seen');
  // Xmr keeps its own default of ten when the threshold is junk.
  const xmr = { state: 'address_issued', watcherUrl: 'http://w', currency: 'xmr', amount: '1', threshold: 0, report: { source: 'watcher', txid: 'ab', confirmations: 9, amount: '1' } };
  assert.equal(applyWatcherReport(xmr), 'seen');
});
