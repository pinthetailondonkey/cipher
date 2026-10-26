import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { atomicToCoins, checkPayment, isPublicExplorer, moneroRows, parseExactAmounts, paymentWatchUrl, reportFromTransfers, rowsFromScan } from './paymentWatch.js';

test('an empty watcher and a public explorer are refused before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, text: async () => JSON.stringify({}) }; };
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
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ pending: true }) }),
  });
  assert.equal(pending.moved, false);
  const mempool = await checkPayment({
    watcherUrl,
    address: '8abc',
    currency: 'xmr',
    state: 'address_issued',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ txid: 'ab', confirmations: 0 }) }),
  });
  // A txid in the mempool names no depth: on the app side, seen waits for the chain.
  assert.deepEqual(mempool, { moved: false, state: 'address_issued' });
  const seen = await checkPayment({
    watcherUrl,
    address: '8abc',
    currency: 'xmr',
    state: 'address_issued',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ txid: 'ab', confirmations: 1 }) }),
  });
  assert.equal(seen.moved, true);
  assert.equal(seen.state, 'seen');
  const confirmed = await checkPayment({
    watcherUrl,
    address: '8abc',
    currency: 'xmr',
    state: 'seen',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ source: 'watcher', txid: 'ab', confirmations: 10 }) }),
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

test('a short payment does not move, and a covering payment does', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  const short = await checkPayment({
    watcherUrl,
    address: 'bcrt1q',
    currency: 'btc',
    state: 'address_issued',
    amount: '0.01',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ txid: 'dust', confirmations: 3, amount: '0.00000001' }) }),
  });
  assert.deepEqual(short, { moved: false, short: true, state: 'address_issued' });
  const paid = await checkPayment({
    watcherUrl,
    address: 'bcrt1q',
    currency: 'btc',
    state: 'address_issued',
    amount: '0.01',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ txid: 'paid', confirmations: 3, amount: '0.01' }) }),
  });
  assert.equal(paid.moved, true);
  assert.equal(paid.state, 'confirmed');
  assert.equal(paid.report.amount, '0.01');
  await assert.rejects(
    () => checkPayment({
      watcherUrl,
      address: 'bcrt1q',
      currency: 'btc',
      state: 'address_issued',
      amount: '0.01',
      fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ txid: 'bare', confirmations: 3 }) }),
    }),
    /did not report an amount/,
  );
});

test('a reply without a confirmations count moves nothing, and its digits are not rounded', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  await assert.rejects(
    () => checkPayment({
      watcherUrl, address: '8abc', currency: 'xmr', state: 'address_issued',
      fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ txid: 'ab' }) }),
    }),
    /names no confirmations/,
  );
  await assert.rejects(
    () => checkPayment({
      watcherUrl, address: '8abc', currency: 'xmr', state: 'address_issued',
      fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify({ txid: 'ab', confirmations: -4 }) }),
    }),
    /names no confirmations/,
  );
  const kept = await checkPayment({
    watcherUrl, address: '8abc', currency: 'xmr', state: 'seen', amount: '0.5',
    fetchImpl: async () => ({ ok: true, text: async () => '{"txid":"ab","confirmations":10,"amount":9007199254740993}' }),
  });
  // The digits survive quoting: the value is a claim of 9 quadrillion whole
  // coins, over the supply, so it reads short instead of rounding to 2^53.
  assert.deepEqual(kept, { moved: false, short: true, state: 'seen' });
});

test('wallet transfers become a watcher report, and a miss stays pending', () => {
  assert.deepEqual(reportFromTransfers([
    { address: 'other', txid: 'no', confirmations: 3 },
    { address: '8abc', txid: 'yes', confirmations: 2 },
  ], '8abc', 'xmr'), { source: 'watcher', txid: 'yes', confirmations: 2, confirmed: false });
  assert.equal(reportFromTransfers([{ address: '8abc', txid: 'yes', confirmations: 9 }], '8abc', 'xmr').confirmed, false);
  assert.equal(reportFromTransfers([{ address: '8abc', txid: 'yes', confirmations: 10 }], '8abc', 'xmr').confirmed, true);
  assert.deepEqual(reportFromTransfers([], '8abc', 'xmr'), { pending: true });
  const watcher = fs.readFileSync(new URL('../../scripts/payment-watcher.mjs', import.meta.url), 'utf8');
  assert.match(watcher, /reportFromTransfers\(rows, address, 'xmr'\)/);
  assert.equal(reportFromTransfers([
    { address: 'bcrt1q', txid: 'small', confirmations: 3, amount: 0.00000001 },
    { address: 'bcrt1q', txid: 'aaaa', confirmations: 3, amount: 0.02 },
    { address: 'bcrt1q', txid: 'bbbb', confirmations: 3, amount: 0.02 },
  ], 'bcrt1q', 'btc').txid, 'bbbb');
});

test('a stock-node scan of one address becomes a bitcoin report', () => {
  const scan = { height: 104, unspents: [{ txid: 'aa', height: 102, amount: 0.01 }] };
  assert.deepEqual(reportFromTransfers(rowsFromScan(scan, 'bcrt1q'), 'bcrt1q', 'btc'), {
    source: 'watcher', txid: 'aa', confirmations: 3, confirmed: true, amount: '0.01', outputAmount: '0.01',
  });
  const counted = { unspents: [{ txid: 'bb', confirmations: 1 }] };
  assert.equal(reportFromTransfers(rowsFromScan(counted, 'bc1q'), 'bc1q', 'btc').confirmed, false);
  assert.deepEqual(reportFromTransfers(rowsFromScan({ unspents: [] }, 'bc1q'), 'bc1q', 'btc'), { pending: true });
});

test('a Monero piconero amount is shifted to whole XMR before it is compared', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  const answer = (rows) => async () => ({ ok: true, text: async () => JSON.stringify(reportFromTransfers(moneroRows(rows), '8sub', 'xmr')) });
  const full = reportFromTransfers(moneroRows([{ address: '8sub', txid: 'full', confirmations: 10, amount: 500000000000 }]), '8sub', 'xmr');
  assert.equal(full.amount, '0.5');
  assert.equal(full.outputAmount, '0.5');
  const covered = await checkPayment({
    watcherUrl, address: '8sub', currency: 'xmr', state: 'address_issued', amount: '0.5',
    fetchImpl: answer([{ address: '8sub', txid: 'full', confirmations: 10, amount: 500000000000 }]),
  });
  assert.equal(covered.state, 'confirmed');
  const over = await checkPayment({
    watcherUrl, address: '8sub', currency: 'xmr', state: 'address_issued', amount: '0.6',
    fetchImpl: answer([{ address: '8sub', txid: 'full', confirmations: 10, amount: 500000000000 }]),
  });
  assert.deepEqual(over, { moved: false, short: true, state: 'address_issued' });
  const tiny = await checkPayment({
    watcherUrl, address: '8sub', currency: 'xmr', state: 'address_issued', amount: '0.5',
    fetchImpl: answer([{ address: '8sub', txid: 'tiny', confirmations: 10, amount: 1 }]),
  });
  assert.deepEqual(tiny, { moved: false, short: true, state: 'address_issued' });
  assert.equal(atomicToCoins(1, 'xmr'), '0.000000000001');
  assert.equal(atomicToCoins('9007199254740993', 'xmr'), '9007.199254740993');
  assert.equal(atomicToCoins(0.5, 'xmr'), null);
  assert.equal(parseExactAmounts('{"result":{"in":[{"amount":9007199254740993,"txid":"a"}]}}').result.in[0].amount, '9007199254740993');
  const watcher = fs.readFileSync(new URL('../../scripts/payment-watcher.mjs', import.meta.url), 'utf8');
  assert.match(watcher, /moneroRows\(\[/);
  assert.match(watcher, /exactAmounts: true/);
});

test('a payment split across two outputs is summed, and the receipt keeps the largest', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  const oneTx = { height: 110, unspents: [{ txid: 'aa', height: 108, amount: 0.006 }, { txid: 'aa', height: 108, amount: 0.004 }] };
  const report = reportFromTransfers(rowsFromScan(oneTx, 'bc1q'), 'bc1q', 'btc');
  assert.equal(report.amount, '0.01');
  assert.equal(report.outputAmount, '0.006');
  assert.equal(report.txid, 'aa');
  const paid = await checkPayment({
    watcherUrl, address: 'bc1q', currency: 'btc', state: 'address_issued', amount: '0.01',
    fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify(report) }),
  });
  assert.equal(paid.state, 'confirmed');
  assert.equal(paid.report.outputAmount, '0.006');
  const twoTx = { height: 110, unspents: [{ txid: 'bb', height: 108, amount: 0.004 }, { txid: 'aa', height: 108, amount: 0.006 }] };
  const split = reportFromTransfers(rowsFromScan(twoTx, 'bc1q'), 'bc1q', 'btc');
  assert.equal(split.amount, '0.01');
  assert.equal(split.txid, 'aa');
  const shallow = { height: 110, unspents: [{ txid: 'aa', height: 108, amount: 0.006 }, { txid: 'bb', height: 110, amount: 0.004 }] };
  const young = reportFromTransfers(rowsFromScan(shallow, 'bc1q'), 'bc1q', 'btc');
  assert.equal(young.confirmations, 1);
  assert.equal(young.confirmed, false);
});
