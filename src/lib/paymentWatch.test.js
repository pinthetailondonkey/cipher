import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { atomicToCoins, checkPayment, incomingMoneroTransfers, isPublicExplorer, issuePrecedes, moneroRows, parseExactAmounts, paymentWatchUrl, reportFromTransfers, rowsFromScan, verifyWatcherResponse } from './paymentWatch.js';

const TOKEN = 'secret';
const hexOf = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const signBody = async (raw, token = TOKEN) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `v1=${hexOf(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)))}`;
};

// A stand-in for a signed watcher answer. Every 200 answer carries the two
// signature headers over the exact raw text it returns.
const watcherAnswer = async (body, { token = TOKEN, tsSec, sig } = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers = { 'content-type': 'application/json', 'x-cipher-ts': String(tsSec ?? Math.floor(Date.now() / 1000)) };
  headers['x-cipher-sig'] = sig ?? (await signBody(raw, token));
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => headers[String(name).toLowerCase()] ?? null },
    text: async () => raw,
  };
};

test('an empty watcher, a public explorer, and a plain internet http watcher are refused before any request', async () => {
  let called = false;
  const fetchImpl = async () => { called = true; return { ok: true, headers: { get: () => null }, text: async () => '{}' }; };
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
  await assert.rejects(
    () => checkPayment({ watcherUrl: 'http://watch.example/payment?token=secret', address: '8abc', currency: 'xmr', state: 'address_issued', fetchImpl }),
    /must use HTTPS/,
  );
  assert.equal(called, false);
});

test('a localhost watcher over plain http is allowed', () => {
  for (const host of ['127.0.0.1:8788', 'localhost:8788', '[::1]:8788']) {
    assert.equal(new URL(paymentWatchUrl(`http://${host}/payment?token=secret`, { address: '8abc', currency: 'xmr' })).searchParams.get('address'), '8abc');
  }
});

test('a watcher you run can mark seen, then confirmed, and silence is not a success', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  assert.equal(new URL(paymentWatchUrl(watcherUrl, { address: '8abc', currency: 'xmr' })).searchParams.get('address'), '8abc');
  const pending = await checkPayment({
    watcherUrl,
    address: '8abc',
    currency: 'xmr',
    state: 'address_issued',
    fetchImpl: () => watcherAnswer({ pending: true }),
  });
  assert.equal(pending.moved, false);
  const seen = await checkPayment({
    watcherUrl,
    address: '8abc',
    currency: 'xmr',
    state: 'address_issued',
    fetchImpl: () => watcherAnswer({ txid: 'ab', confirmations: 0 }),
  });
  assert.equal(seen.moved, true);
  assert.equal(seen.state, 'seen');
  const confirmed = await checkPayment({
    watcherUrl,
    address: '8abc',
    currency: 'xmr',
    state: 'seen',
    fetchImpl: () => watcherAnswer({ source: 'watcher', txid: 'ab', confirmations: 10 }),
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

test('a forged or unsigned answer moves nothing', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  // An attacker picked a different key. The answer is well formed and says paid.
  await assert.rejects(
    () => checkPayment({
      watcherUrl,
      address: '8abc',
      currency: 'xmr',
      state: 'address_issued',
      fetchImpl: () => watcherAnswer({ txid: 'forged', confirmations: 10 }, { token: 'attacker' }),
    }),
    /signature check/,
  );
  // An older self-hosted watcher sends no signature headers.
  await assert.rejects(
    () => checkPayment({
      watcherUrl,
      address: '8abc',
      currency: 'xmr',
      state: 'address_issued',
      fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ txid: 'ab', confirmations: 10 }) }),
    }),
    /signature check/,
  );
});

test('an answer signed with the right key but an old or future time is refused', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  const now = Math.floor(Date.now() / 1000);
  await assert.rejects(
    () => checkPayment({
      watcherUrl,
      address: '8abc',
      currency: 'xmr',
      state: 'address_issued',
      fetchImpl: () => watcherAnswer({ txid: 'ab', confirmations: 10 }, { tsSec: now - 121 }),
    }),
    /signature check/,
  );
  await assert.rejects(
    () => checkPayment({
      watcherUrl,
      address: '8abc',
      currency: 'xmr',
      state: 'address_issued',
      fetchImpl: () => watcherAnswer({ txid: 'ab', confirmations: 10 }, { tsSec: now + 130 }),
    }),
    /signature check/,
  );
});

test('verifyWatcherResponse takes valid, and refuses tampered, wrong key, stale, future, or unsigned', async () => {
  const raw = JSON.stringify({ txid: 'ab', confirmations: 3, amount: '0.01' });
  const sig = await signBody(raw);
  const now = Math.floor(Date.now() / 1000);
  const check = (over) => verifyWatcherResponse({ rawBody: raw, sig, ts: String(now), token: TOKEN, nowSec: now, ...over });
  assert.equal(await check({}), true);
  assert.equal(await check({ rawBody: `${raw} ` }), false);
  assert.equal(await check({ rawBody: raw.replace('0.01', '0.99') }), false);
  assert.equal(await check({ token: 'other' }), false);
  assert.equal(await check({ sig: `v1=${'0'.repeat(64)}` }), false);
  assert.equal(await check({ sig: sig.slice(3) }), false);
  assert.equal(await check({ sig: undefined }), false);
  assert.equal(await check({ ts: String(now - 121) }), false);
  assert.equal(await check({ ts: String(now + 121) }), false);
  assert.equal(await check({ ts: String(now - 120) }), true);
  assert.equal(await check({ ts: String(now + 120) }), true);
  assert.equal(await check({ ts: 'yesterday' }), false);
  assert.equal(await check({ rawBody: '' }), false);
  assert.equal(await check({ nowSec: 'n/a' }), false);
});

test('a short payment does not move, and a covering payment does', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  const short = await checkPayment({
    watcherUrl,
    address: 'bcrt1q',
    currency: 'btc',
    state: 'address_issued',
    amount: '0.01',
    fetchImpl: () => watcherAnswer({ txid: 'dust', confirmations: 3, amount: '0.00000001' }),
  });
  assert.deepEqual(short, { moved: false, short: true, state: 'address_issued' });
  const paid = await checkPayment({
    watcherUrl,
    address: 'bcrt1q',
    currency: 'btc',
    state: 'address_issued',
    amount: '0.01',
    fetchImpl: () => watcherAnswer({ txid: 'paid', confirmations: 3, amount: '0.01' }),
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
      fetchImpl: () => watcherAnswer({ txid: 'bare', confirmations: 3 }),
    }),
    /did not report an amount/,
  );
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
  const answer = (rows) => () => watcherAnswer(reportFromTransfers(moneroRows(rows), '8sub', 'xmr'));
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
  assert.match(watcher, /incomingMoneroTransfers\(/);
  assert.match(watcher, /exactAmounts: true/);
});

test('an outgoing Monero spend never reads as an incoming payment', () => {
  const rows = incomingMoneroTransfers({
    in: [{ txid: 'arrived', address: '8sub', confirmations: 10, amount: 500000000000, type: 'in' }],
    out: [{ txid: 'selfsend', address: '8sub', confirmations: 1, amount: 900000000000, type: 'out' }],
    pending: [{ txid: 'mypend', address: '8sub', amount: 900000000000, type: 'pending' }],
    pool: [{ txid: 'pool1', address: '8sub', confirmations: 0, amount: 300000000000, type: 'pool' }],
  });
  assert.deepEqual(rows.map((row) => row.txid), ['arrived', 'pool1']);
  // A send that the wallet filed in an arriving bucket is still dropped,
  // because its own label says what it is.
  assert.deepEqual(incomingMoneroTransfers({ in: [{ txid: 'x', address: '8sub', type: 'pending' }] }), []);
  // The script asks only for the arriving buckets, so money leaving is never
  // even fetched, and the row filter is what it leans on.
  const watcher = fs.readFileSync(new URL('../../scripts/payment-watcher.mjs', import.meta.url), 'utf8');
  assert.match(watcher, /in: true, pool: true/);
  assert.match(watcher, /incomingMoneroTransfers\(result\)/);
  const report = reportFromTransfers(rows, '8sub', 'xmr');
  assert.equal(report.txid, 'arrived');
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
    fetchImpl: () => watcherAnswer(report),
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

test('a report carries the oldest time of its covering rows, and a scan keeps its height', () => {
  const rows = moneroRows([
    { address: '8sub', txid: 'a', confirmations: 10, amount: 300000000000, timestamp: 2000, type: 'in' },
    { address: '8sub', txid: 'b', confirmations: 10, amount: 200000000000, timestamp: 1000, type: 'in' },
  ]);
  const report = reportFromTransfers(rows, '8sub', 'xmr');
  assert.equal(report.time, 1000);
  assert.equal(report.amount, '0.5');
  // One undated part and the report carries no date, so an order with an
  // issuance time refuses to consume the txid.
  const partly = reportFromTransfers([
    { address: '8sub', txid: 'a', confirmations: 10, amount: 0.3, timestamp: 2000 },
    { address: '8sub', txid: 'b', confirmations: 10, amount: 0.2 },
  ], '8sub', 'xmr');
  assert.equal(partly.time, undefined);
  const scan = rowsFromScan({ height: 104, unspents: [{ txid: 'aa', height: 102, amount: 0.01 }] }, 'bc1q');
  assert.equal(scan[0].height, 102);
});

test('a transfer recorded before the order\'s address was issued cannot pay it', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  const issuedAt = Math.floor(Date.now() / 1000) - 600;
  const stale = await checkPayment({
    watcherUrl,
    address: '8sub',
    currency: 'xmr',
    state: 'address_issued',
    issuedAt,
    fetchImpl: () => watcherAnswer({ txid: 'old', confirmations: 10, amount: '0.5', time: issuedAt - 3600 }),
  });
  assert.deepEqual(stale, { moved: false, stale: true, state: 'address_issued' });
  const fresh = await checkPayment({
    watcherUrl,
    address: '8sub',
    currency: 'xmr',
    state: 'address_issued',
    issuedAt,
    fetchImpl: () => watcherAnswer({ txid: 'new', confirmations: 10, amount: '0.5', time: issuedAt + 60 }),
  });
  assert.equal(fresh.moved, true);
  assert.equal(fresh.state, 'confirmed');
  // An undated report is not refused here; the order refuses to consume it
  // at confirmation instead, which is where the txid is spoken for.
  const undated = await checkPayment({
    watcherUrl,
    address: '8sub',
    currency: 'xmr',
    state: 'seen',
    issuedAt,
    fetchImpl: () => watcherAnswer({ txid: 'ab', confirmations: 1, amount: '0.5' }),
  });
  assert.equal(undated.moved, true);
  // The pure gate: equal time is not before issuance, a missing one proves nothing.
  assert.equal(issuePrecedes({ time: issuedAt - 1 }, issuedAt), true);
  assert.equal(issuePrecedes({ time: issuedAt }, issuedAt), false);
  assert.equal(issuePrecedes({}, issuedAt), false);
  assert.equal(issuePrecedes({ time: 5 }, undefined), false);
  assert.equal(issuePrecedes({ time: 5 }, 'yesterday'), false);
});

test('the watcher signs every answer it gives, and the phone verifies the raw body', () => {
  const watcher = fs.readFileSync(new URL('../../scripts/payment-watcher.mjs', import.meta.url), 'utf8');
  assert.match(watcher, /createHmac\('sha256', watchToken\)/);
  assert.match(watcher, /x-cipher-sig/);
  assert.match(watcher, /x-cipher-ts/);
  const app = fs.readFileSync(new URL('./paymentWatch.js', import.meta.url), 'utf8');
  assert.match(app, /x-cipher-sig/);
  assert.match(app, /x-cipher-ts/);
  // The body is verified before it is parsed, so JSON round-tripping cannot
  // sneak a byte past the check.
  assert.match(app, /parseExactAmounts\(raw\)/);
});
