import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPayment, isPublicExplorer, paymentWatchUrl, reportFromTransfers, rowsFromScan } from './paymentWatch.js';

test('an empty watcher and a public explorer are refused before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  await assert.rejects(
    () => checkPayment({ watcherUrl: '', address: '8abc', currency: 'xmr', state: 'address_issued', fetchImpl }),
    /block explorer/,
  );
  await assert.rejects(
    () => checkPayment({ watcherUrl: 'https://mempool.space/api/address/abc', address: 'bc1q', currency: 'btc', state: 'address_issued', fetchImpl }),
    /block explorer/,
  );
  assert.equal(isPublicExplorer('https://xmr.xmrchain.net/tx/ab'), true);
  await assert.rejects(
    () => checkPayment({ watcherUrl: 'https://watch.example/payment', address: '8abc', currency: 'xmr', state: 'address_issued', fetchImpl }),
    /needs a token/,
  );
  assert.equal(called, false);
});

test('a watcher you run can mark seen, then confirmed, and silence is not a success', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  assert.equal(new URL(paymentWatchUrl(watcherUrl, { address: '8abc', currency: 'xmr' })).searchParams.get('address'), '8abc');
  const pending = await checkPayment({
    watcherUrl,
    address: '8abc',
    currency: 'xmr',
    state: 'address_issued',
    fetchImpl: async () => ({ ok: true, json: async () => ({ pending: true }) }),
  });
  assert.equal(pending.moved, false);
  const seen = await checkPayment({
    watcherUrl,
    address: '8abc',
    currency: 'xmr',
    state: 'address_issued',
    fetchImpl: async () => ({ ok: true, json: async () => ({ txid: 'ab', confirmations: 0 }) }),
  });
  assert.equal(seen.moved, true);
  assert.equal(seen.state, 'seen');
  const confirmed = await checkPayment({
    watcherUrl,
    address: '8abc',
    currency: 'xmr',
    state: 'seen',
    fetchImpl: async () => ({ ok: true, json: async () => ({ source: 'watcher', txid: 'ab', confirmations: 10 }) }),
  });
  assert.equal(confirmed.state, 'confirmed');
  await assert.rejects(
    () => checkPayment({
      watcherUrl,
      address: '8abc',
      currency: 'xmr',
      state: 'address_issued',
      fetchImpl: async () => { throw new Error('offline'); },
    }),
    /did not answer/,
  );
});

test('wallet transfers become a watcher report, and a miss stays pending', () => {
  assert.deepEqual(reportFromTransfers([
    { address: 'other', txid: 'no', confirmations: 3 },
    { address: '8abc', txid: 'yes', confirmations: 2 },
  ], '8abc'), { source: 'watcher', txid: 'yes', confirmations: 2, confirmed: false });
  assert.deepEqual(reportFromTransfers([], '8abc'), { pending: true });
  assert.equal(reportFromTransfers([
    { address: 'bcrt1q', txid: 'small', confirmations: 3, amount: 0.00000001 },
    { address: 'bcrt1q', txid: 'aaaa', confirmations: 3, amount: 0.02 },
    { address: 'bcrt1q', txid: 'bbbb', confirmations: 3, amount: 0.02 },
  ], 'bcrt1q', 'btc').txid, 'bbbb');
});

test('a stock-node scan of one address becomes a bitcoin report', () => {
  const scan = { height: 104, unspents: [{ txid: 'aa', height: 102, amount: 0.01 }] };
  assert.deepEqual(reportFromTransfers(rowsFromScan(scan, 'bcrt1q'), 'bcrt1q', 'btc'), {
    source: 'watcher', txid: 'aa', confirmations: 3, confirmed: true, amount: 0.01,
  });
  const counted = { unspents: [{ txid: 'bb', confirmations: 1 }] };
  assert.equal(reportFromTransfers(rowsFromScan(counted, 'bc1q'), 'bc1q', 'btc').confirmed, false);
  assert.deepEqual(reportFromTransfers(rowsFromScan({ unspents: [] }, 'bc1q'), 'bc1q', 'btc'), { pending: true });
});
