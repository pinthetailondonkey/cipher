import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { atomicToCoins, checkPayment, childWatcherToken, incomingMoneroTransfers, isPublicExplorer, issuePrecedes, moneroRows, parseExactAmounts, paymentWatchUrl, reportFromTransfers, rowsFromScan, verifyWatcherResponse } from './paymentWatch.js';

const TOKEN = 'secret';
const hexOf = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
// The wire token is the order's child: HMAC of the base secret over the
// payment asked about. A check signs and verifies under that child, never
// the base token.
const signBody = async (raw, token = TOKEN, tsSec, address = '', currency = '') => {
  const wire = address ? await childWatcherToken(token, address, currency) : token;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(wire), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const ts = String(tsSec ?? Math.floor(Date.now() / 1000));
  return `v1=${hexOf(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${ts}:${raw}`)))}`;
};

// A stand-in for a signed watcher answer. Every 200 answer carries the two
// signature headers over the exact raw text it returns, keyed by the child
// token of the payment the body names — what a real watcher now derives.
// signFor signs under a different payment's child, which is how a mismatch
// between the ask and the answer still reaches the echo gate.
const watcherAnswer = async (body, { token = TOKEN, tsSec, sig, signFor } = {}) => {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const ts = String(tsSec ?? Math.floor(Date.now() / 1000));
  const headers = { 'content-type': 'application/json', 'x-cipher-ts': ts };
  const signAddress = signFor?.address ?? body.address;
  const signCurrency = signFor?.currency ?? body.currency;
  headers['x-cipher-sig'] = sig ?? (await signBody(raw, token, ts, signAddress, signCurrency));
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
  // A lookalike trades on an explorer's name. It is not the explorer's
  // child, but it is no watcher you run, and the plain check handed the
  // token to it as if it were one. (security re-attack)
  assert.equal(isPublicExplorer('https://xmrchain.net.evil.tld/payment?token=secret'), true);
  assert.equal(isPublicExplorer('https://mempool.space.'), true);
  assert.equal(isPublicExplorer('https://watch.example/payment?token=secret'), false);
  await assert.rejects(
    () => checkPayment({ watcherUrl: 'https://xmrchain.net.evil.tld/payment?token=secret', address: '8abc', currency: 'xmr', state: 'address_issued', fetchImpl }),
    /block explorer/,
  );
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
    fetchImpl: () => watcherAnswer({ address: '8abc', currency: 'xmr', pending: true }),
  });
  assert.equal(pending.moved, false);
  const seen = await checkPayment({
    watcherUrl,
    address: '8abc',
    currency: 'xmr',
    state: 'address_issued',
    fetchImpl: () => watcherAnswer({ address: '8abc', currency: 'xmr', txid: 'ab', confirmations: 0 }),
  });
  assert.equal(seen.moved, true);
  assert.equal(seen.state, 'seen');
  const confirmed = await checkPayment({
    watcherUrl,
    address: '8abc',
    currency: 'xmr',
    state: 'seen',
    fetchImpl: () => watcherAnswer({ address: '8abc', currency: 'xmr', source: 'watcher', txid: 'ab', confirmations: 10 }),
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

// A report names ONE transaction, and the receipt is written from the name.
// A list or a joined string used to be coerced into "aa11,bb22": the receipt
// was signed naming two transactions, and the consumed ledger, which keys on
// the literal string, let the same transfer confirm a second order. (C4)
test('an answer that does not name exactly one transaction moves nothing', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  const base = { watcherUrl, address: '8abc', currency: 'xmr', state: 'address_issued' };
  // An empty answer is the older "not seen yet" no-op, not a refusal.
  const blank = await checkPayment({ ...base, fetchImpl: () => watcherAnswer({ address: '8abc', currency: 'xmr', txid: '', confirmations: 10 }) });
  assert.equal(blank.moved, false);
  // A number is the case a JSON answer actually produces when a watcher
  // formats its transaction as a number instead of a string. It is not a
  // name this app can sign a receipt from, so it is refused like the rest,
  // never coerced into "42".
  for (const txid of [['ab', 'cd'], { id: 'ab' }, 42, 1.5, 0.1 + 0.2, 'ab,cd', 'ab cd', 'ab\ncd', '   ']) {
    await assert.rejects(
      () => checkPayment({ ...base, fetchImpl: () => watcherAnswer({ address: '8abc', currency: 'xmr', txid, confirmations: 10 }) }),
      /did not name a single transaction/,
      `txid ${JSON.stringify(txid)} confirmed a payment`,
    );
  }
  // One token still moves, and its own padding is trimmed away rather than
  // refused — an honest watcher that pads is not the failure this guards.
  const seen = await checkPayment({
    ...base,
    fetchImpl: () => watcherAnswer({ address: '8abc', currency: 'xmr', txid: '  ab  ', confirmations: 0 }),
  });
  assert.equal(seen.moved, true);
  assert.equal(seen.state, 'seen');
  assert.equal(seen.report.txid, 'ab');
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

test('an answer that does not name the payment asked about answers nothing', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  // An honestly signed report for one order, carried onto a second order on
  // another device: the bytes are real, the ask is not. The signature
  // cannot see this — the child token healthy-client check is passed by
  // signing under the ASKED payment's child — so the echo gate is what
  // meets it. (security re-attack)
  await assert.rejects(
    () => checkPayment({
      watcherUrl,
      address: '8other',
      currency: 'xmr',
      state: 'address_issued',
      fetchImpl: () => watcherAnswer({ address: '8abc', currency: 'xmr', txid: 'ab', confirmations: 10 }, { signFor: { address: '8other', currency: 'xmr' } }),
    }),
    /does not name the payment/,
  );
  // The same address under another currency is refused the same way.
  await assert.rejects(
    () => checkPayment({
      watcherUrl,
      address: '8abc',
      currency: 'btc',
      state: 'address_issued',
      fetchImpl: () => watcherAnswer({ address: '8abc', currency: 'xmr', txid: 'ab', confirmations: 10 }, { signFor: { address: '8abc', currency: 'btc' } }),
    }),
    /does not name the payment/,
  );
});

test('verifyWatcherResponse takes valid, and refuses tampered, wrong key, stale, future, or unsigned', async () => {
  const raw = JSON.stringify({ txid: 'ab', confirmations: 3, amount: '0.01' });
  const ts = Math.floor(Date.now() / 1000);
  const sig = await signBody(raw, TOKEN, ts);
  const check = (over) => verifyWatcherResponse({ rawBody: raw, sig, ts: String(ts), token: TOKEN, nowSec: ts, ...over });
  assert.equal(await check({}), true);
  assert.equal(await check({ rawBody: `${raw} ` }), false);
  assert.equal(await check({ rawBody: raw.replace('0.01', '0.99') }), false);
  assert.equal(await check({ token: 'other' }), false);
  assert.equal(await check({ sig: `v1=${'0'.repeat(64)}` }), false);
  assert.equal(await check({ sig: sig.slice(3) }), false);
  assert.equal(await check({ sig: undefined }), false);
  assert.equal(await check({ ts: String(ts - 121) }), false);
  assert.equal(await check({ ts: String(ts + 121) }), false);
  assert.equal(await check({ ts: 'yesterday' }), false);
  assert.equal(await check({ rawBody: '' }), false);
  assert.equal(await check({ nowSec: 'n/a' }), false);
  // The timestamp sits inside the signed bytes, so a captured answer cannot
  // be replayed with a re-stamped date: the new stamp fails the signature.
  // (security F6)
  assert.equal(await check({ ts: String(ts - 1) }), false);
  const edgeOld = await signBody(raw, TOKEN, ts - 120);
  assert.equal(await verifyWatcherResponse({ rawBody: raw, sig: edgeOld, ts: String(ts - 120), token: TOKEN, nowSec: ts }), true);
  const edgeFuture = await signBody(raw, TOKEN, ts + 120);
  assert.equal(await verifyWatcherResponse({ rawBody: raw, sig: edgeFuture, ts: String(ts + 120), token: TOKEN, nowSec: ts }), true);
});

test('a short payment does not move, and a covering payment does', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  const short = await checkPayment({
    watcherUrl,
    address: 'bcrt1q',
    currency: 'btc',
    state: 'address_issued',
    amount: '0.01',
    fetchImpl: () => watcherAnswer({ address: 'bcrt1q', currency: 'btc', txid: 'dust', confirmations: 3, amount: '0.00000001' }),
  });
  assert.deepEqual(short, { moved: false, short: true, state: 'address_issued' });
  const paid = await checkPayment({
    watcherUrl,
    address: 'bcrt1q',
    currency: 'btc',
    state: 'address_issued',
    amount: '0.01',
    fetchImpl: () => watcherAnswer({ address: 'bcrt1q', currency: 'btc', txid: 'paid', confirmations: 3, amount: '0.01' }),
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
      fetchImpl: () => watcherAnswer({ address: 'bcrt1q', currency: 'btc', txid: 'bare', confirmations: 3 }),
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
    { address: 'bcrt1q', txid: 'small', confirmations: 3, amount: '0.00000001' },
    { address: 'bcrt1q', txid: 'aaaa', confirmations: 3, amount: '0.02' },
    { address: 'bcrt1q', txid: 'bbbb', confirmations: 3, amount: '0.02' },
  ], 'bcrt1q', 'btc').txid, 'bbbb');
});

test('a stock-node scan of one address becomes a bitcoin report', () => {
  const scan = { height: 104, unspents: [{ txid: 'aa', height: 102, amount: '0.01' }] };
  assert.deepEqual(reportFromTransfers(rowsFromScan(scan, 'bcrt1q'), 'bcrt1q', 'btc'), {
    source: 'watcher', txid: 'aa', confirmations: 3, confirmed: true, amount: '0.01', outputAmount: '0.01',
  });
  const counted = { unspents: [{ txid: 'bb', confirmations: 1 }] };
  assert.equal(reportFromTransfers(rowsFromScan(counted, 'bc1q'), 'bc1q', 'btc').confirmed, false);
  assert.deepEqual(reportFromTransfers(rowsFromScan({ unspents: [] }, 'bc1q'), 'bc1q', 'btc'), { pending: true });
});

test('a Monero piconero amount is shifted to whole XMR before it is compared', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  const answer = (rows) => () => watcherAnswer({ address: '8sub', currency: 'xmr', ...reportFromTransfers(moneroRows(rows), '8sub', 'xmr') });
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
  const oneTx = { height: 110, unspents: [{ txid: 'aa', height: 108, amount: '0.006' }, { txid: 'aa', height: 108, amount: '0.004' }] };
  const report = reportFromTransfers(rowsFromScan(oneTx, 'bc1q'), 'bc1q', 'btc');
  assert.equal(report.amount, '0.01');
  assert.equal(report.outputAmount, '0.006');
  assert.equal(report.txid, 'aa');
  const paid = await checkPayment({
    watcherUrl, address: 'bc1q', currency: 'btc', state: 'address_issued', amount: '0.01',
    fetchImpl: () => watcherAnswer({ address: 'bc1q', currency: 'btc', ...report }),
  });
  assert.equal(paid.state, 'confirmed');
  assert.equal(paid.report.outputAmount, '0.006');
  const twoTx = { height: 110, unspents: [{ txid: 'bb', height: 108, amount: '0.004' }, { txid: 'aa', height: 108, amount: '0.006' }] };
  const split = reportFromTransfers(rowsFromScan(twoTx, 'bc1q'), 'bc1q', 'btc');
  // A receipt names one transaction: the amount is that transaction's own
  // outputs, never the sum across two transactions.
  assert.equal(split.amount, '0.006');
  assert.equal(split.txid, 'aa');
  const shallow = { height: 110, unspents: [{ txid: 'aa', height: 108, amount: '0.006' }, { txid: 'aa', height: 110, amount: '0.004' }] };
  const young = reportFromTransfers(rowsFromScan(shallow, 'bc1q'), 'bc1q', 'btc');
  assert.equal(young.confirmations, 1);
  assert.equal(young.confirmed, false);
});

test('a report carries the oldest time of its covering rows, and a scan keeps its height', () => {
  const rows = moneroRows([
    { address: '8sub', txid: 'a', confirmations: 10, amount: 300000000000, timestamp: 2000, type: 'in' },
    { address: '8sub', txid: 'a', confirmations: 10, amount: 200000000000, timestamp: 1000, type: 'in' },
  ]);
  const report = reportFromTransfers(rows, '8sub', 'xmr');
  assert.equal(report.time, 1000);
  assert.equal(report.amount, '0.5');
  // One undated part and the report carries no date, so an order with an
  // issuance time refuses to consume the txid.
  const partly = reportFromTransfers([
    { address: '8sub', txid: 'a', confirmations: 10, amount: '0.3', timestamp: 2000 },
    { address: '8sub', txid: 'a', confirmations: 10, amount: '0.2' },
  ], '8sub', 'xmr');
  assert.equal(partly.time, undefined);
  const scan = rowsFromScan({ height: 104, unspents: [{ txid: 'aa', height: 102, amount: '0.01' }] }, 'bc1q');
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
    fetchImpl: () => watcherAnswer({ address: '8sub', currency: 'xmr', txid: 'old', confirmations: 10, amount: '0.5', time: issuedAt - 3600 }),
  });
  assert.deepEqual(stale, { moved: false, stale: true, state: 'address_issued' });
  const fresh = await checkPayment({
    watcherUrl,
    address: '8sub',
    currency: 'xmr',
    state: 'address_issued',
    issuedAt,
    fetchImpl: () => watcherAnswer({ address: '8sub', currency: 'xmr', txid: 'new', confirmations: 10, amount: '0.5', time: issuedAt + 60 }),
  });
  assert.equal(fresh.moved, true);
  assert.equal(fresh.state, 'confirmed');
  // An undated report is not refused here; the order refuses to consume it
  // at confirmation instead, which is where the txid is spoken for.
  const undated = await checkPayment({
    watcherUrl,
    address: '8sub',
    currency: 'xmr',
    state: 'address_issued',
    issuedAt,
    fetchImpl: () => watcherAnswer({ address: '8sub', currency: 'xmr', txid: 'ab', confirmations: 1, amount: '0.5' }),
  });
  assert.equal(undated.moved, true);
  assert.equal(undated.state, 'seen');
  // The pure gate: equal time is not before issuance, a missing one proves nothing.
  assert.equal(issuePrecedes({ time: issuedAt - 1 }, issuedAt), true);
  assert.equal(issuePrecedes({ time: issuedAt }, issuedAt), false);
  assert.equal(issuePrecedes({}, issuedAt), false);
  assert.equal(issuePrecedes({ time: 5 }, undefined), false);
  assert.equal(issuePrecedes({ time: 5 }, 'yesterday'), false);
});

test('the watcher signs every answer it gives, and the phone verifies the raw body', () => {
  const watcher = fs.readFileSync(new URL('../../scripts/payment-watcher.mjs', import.meta.url), 'utf8');
  // The wire credential is the order's child token, derived on both sides
  // from the base secret over the payment asked about. The base token
  // authenticates nothing. (drill round three)
  assert.match(watcher, /await childWatcherToken\(watchToken, address, currency\)/);
  assert.match(watcher, /await tokenMatches\(presented, address, currency\)/);
  assert.match(watcher, /createHmac\('sha256', token\)/);
  assert.match(watcher, /x-cipher-sig/);
  assert.match(watcher, /x-cipher-ts/);
  // The answer names what it answers for, so a signed reply for one order
  // cannot be replayed as another order's. (security re-attack)
  assert.match(watcher, /signedAnswer\(res, address, currency, report\)/);
  assert.match(watcher, /address, currency, \.\.\.report/);
  const app = fs.readFileSync(new URL('./paymentWatch.js', import.meta.url), 'utf8');
  assert.match(app, /x-cipher-sig/);
  assert.match(app, /x-cipher-ts/);
  // The body is verified before it is parsed, so JSON round-tripping cannot
  // sneak a byte past the check.
  assert.match(app, /parseExactAmounts\(raw\)/);
  // The check never walks out with the pasted base token.
  assert.match(app, /childWatcherToken\(baseToken, address, currency\)/);
});

test('a child token is bound to the payment asked about', async () => {
  const child = await childWatcherToken(TOKEN, '8abc', 'xmr');
  assert.equal(typeof child, 'string');
  assert.match(child, /^[0-9a-f]{64}$/);
  assert.equal(child, await childWatcherToken(TOKEN, '8abc', 'xmr')); // deterministic
  assert.notEqual(child, await childWatcherToken(TOKEN, '8other', 'xmr')); // another order
  assert.notEqual(child, await childWatcherToken(TOKEN, '8abc', 'btc')); // another currency
  assert.notEqual(child, await childWatcherToken('other', '8abc', 'xmr')); // another watcher
  assert.notEqual(child, TOKEN); // the base secret never doubles as its own child
  // The request URL walks out with the child, never the pasted base token.
  const url = new URL(paymentWatchUrl(`https://watch.example/payment?token=${TOKEN}`, { address: '8abc', currency: 'xmr', token: child }));
  assert.equal(url.searchParams.get('token'), child);
});

test('the base token authenticates nothing on the wire — only the order\'s child does', async () => {
  process.env.WATCH_TOKEN = TOKEN;
  const { server } = await import('../../scripts/payment-watcher.mjs');
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const ask = async (token) => fetch(
      `http://127.0.0.1:${port}/payment?address=8abc&currency=xmr`,
      { headers: { Authorization: `Bearer ${token}` } },
    ).then((response) => response.status);
    // The pasted base secret answers nothing: dead on the wire, whatever it
    // could have unlocked before. (drill round three)
    assert.equal(await ask(TOKEN), 401);
    // The child passes the lock; the next honest wall is the missing node.
    const child = await childWatcherToken(TOKEN, '8abc', 'xmr');
    assert.equal(await ask(child), 503);
    // A child captured for another order's address opens nothing here.
    assert.equal(await ask(await childWatcherToken(TOKEN, '8other', 'xmr')), 401);
  } finally {
    server.close();
  }
});

test('a transfer time that is not a sane unix second carries no weight', async () => {
  // A report timestamped in milliseconds would read as "the future" and
  // pass every issuance comparison. Out-of-range dates are dropped instead,
  // which is exactly the undated case: seen may proceed, confirming
  // refuses when the order knows when its address was issued.
  const watcherUrl = 'https://watch.example/payment?token=secret';
  const ms = await checkPayment({
    watcherUrl,
    address: '8sub',
    currency: 'xmr',
    state: 'address_issued',
    issuedAt: Math.floor(Date.now() / 1000),
    fetchImpl: () => watcherAnswer({ address: '8sub', currency: 'xmr', txid: 'ms', confirmations: 10, amount: '0.5', time: Date.now() * 12 }),
  });
  // The date is dropped, so the report looks undated — the same one the
  // order refuses to consume at confirmation time.
  assert.equal(ms.state, 'confirmed');
  assert.equal(ms.report?.time, undefined);
  const ago = () => watcherAnswer({ address: '8sub', currency: 'xmr', txid: 'old', confirmations: 10, amount: '0.5', time: 3141592653 });
  const future = await checkPayment({
    watcherUrl,
    address: '8sub',
    currency: 'xmr',
    state: 'address_issued',
    fetchImpl: ago,
  });
  assert.equal(future.report?.time, undefined);
});

test('a locked or double-spent Monero row is held out of the count', async () => {
  const now = 1_800_000_000;
  const arrived = { txid: 'ok', address: '8sub', amount: 500000000000, type: 'in', height: 1000, confirmations: 10, unlock_time: 0 };
  const ids = (result) => incomingMoneroTransfers(result, { nowSec: now }).map((row) => row.txid);
  assert.deepEqual(ids({ in: [arrived] }), ['ok']);
  // A block-height lock is held until the chain reaches it (tip here is 1009).
  assert.deepEqual(ids({ in: [{ ...arrived, txid: 'h1', unlock_time: 1010 }] }), []);
  assert.deepEqual(ids({ in: [{ ...arrived, txid: 'h2', unlock_time: 1009 }] }), ['h2']);
  // A unix-time lock is held until the clock passes it.
  assert.deepEqual(ids({ in: [{ ...arrived, txid: 't1', unlock_time: now + 3600 }] }), []);
  assert.deepEqual(ids({ in: [{ ...arrived, txid: 't2', unlock_time: now - 3600 }] }), ['t2']);
  // A pool row has no block, so a height lock on it cannot be shown to have passed.
  assert.deepEqual(ids({ pool: [{ txid: 'p1', address: '8sub', amount: 1, type: 'pool', confirmations: 0, unlock_time: 5 }] }), []);
  assert.deepEqual(ids({ pool: [{ txid: 'p0', address: '8sub', amount: 1, type: 'pool', confirmations: 0, unlock_time: 0 }] }), ['p0']);
  // A garbled lock fails closed.
  assert.deepEqual(ids({ in: [{ ...arrived, txid: 'g', unlock_time: 'soon' }] }), []);
  // A pool row the wallet saw double-spent never counts.
  assert.deepEqual(ids({ pool: [{ txid: 'ds', address: '8sub', amount: 1, type: 'pool', double_spend_seen: true }] }), []);
  // So a locked payment reads as nothing arrived yet, not as a confirmed one.
  const locked = incomingMoneroTransfers({ in: [{ ...arrived, txid: 'lk', unlock_time: 99999999 }] }, { nowSec: now });
  assert.deepEqual(reportFromTransfers(locked, '8sub', 'xmr'), { pending: true });
});

test('a payment split across two transactions does not confirm an order, and a receipt names the transaction that paid', async () => {
  const watcherUrl = 'https://watch.example/payment?token=secret';
  const twoTx = { height: 110, unspents: [{ txid: 'aa', height: 108, amount: '0.006' }, { txid: 'bb', height: 108, amount: '0.004' }] };
  const split = reportFromTransfers(rowsFromScan(twoTx, 'bc1q'), 'bc1q', 'btc');
  assert.equal(split.txid, 'aa');
  assert.equal(split.amount, '0.006');
  const short = await checkPayment({
    watcherUrl, address: 'bc1q', currency: 'btc', state: 'address_issued', amount: '0.01',
    fetchImpl: () => watcherAnswer({ address: 'bc1q', currency: 'btc', ...split }),
  });
  assert.deepEqual(short, { moved: false, short: true, state: 'address_issued' });
  // The same split on Monero.
  const xmr = reportFromTransfers(moneroRows([
    { address: '8sub', txid: 'x1', confirmations: 10, amount: 300000000000 },
    { address: '8sub', txid: 'x2', confirmations: 10, amount: 200000000000 },
  ]), '8sub', 'xmr');
  assert.equal(xmr.txid, 'x1');
  assert.equal(xmr.amount, '0.3');
  // One transaction that covers the order by itself still confirms, with its outputs summed.
  const whole = { height: 110, unspents: [{ txid: 'cc', height: 108, amount: '0.006' }, { txid: 'cc', height: 108, amount: '0.004' }, { txid: 'dd', height: 108, amount: '0.001' }] };
  const one = reportFromTransfers(rowsFromScan(whole, 'bc1q'), 'bc1q', 'btc');
  assert.equal(one.txid, 'cc');
  assert.equal(one.amount, '0.01');
  assert.equal(one.outputAmount, '0.006');
});

test('a bitcoin amount is quoted before parsing, and a float row counts for nothing', () => {
  const core = '{"result":{"total_amount":0.30000000,"unspents":[{"txid":"aa","height":5,"amount":0.10000001},{"txid":"bb","height":5,"amount":3}]}}';
  const scan = parseExactAmounts(core).result;
  assert.deepEqual(scan.unspents.map((row) => row.amount), ['0.10000001', '3']);
  const rows = rowsFromScan({ height: 6, unspents: scan.unspents }, 'bc1q');
  assert.deepEqual(rows.map((row) => row.amount), ['0.10000001', '3']);
  // A number that reaches the row builder is a float, not a coin amount: the
  // row is kept but carries no amount, so the report is short of any order.
  const floats = rowsFromScan({ height: 6, unspents: [{ txid: 'aa', height: 5, amount: 0.5 }] }, 'bc1q');
  assert.equal(floats[0].amount, undefined);
  assert.equal(reportFromTransfers(floats, 'bc1q', 'btc').amount, undefined);
  const watcher = fs.readFileSync(new URL('../../scripts/payment-watcher.mjs', import.meta.url), 'utf8');
  assert.match(watcher, /scantxoutset[\s\S]{0,200}exactAmounts: true/);
});
