import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { seedVault } from './fixtures.js';

// The chain check's refusal branches, at the screen. A read that failed used
// to lift the buyer's card to address_issued — a state no watcher earned — and
// then check that invented state. The catch now refuses, and an accepted order
// whose acceptance carries no usable payment details gets its own sentence
// instead of "no coin amount". Neither branch is reachable by hand in a hurry,
// which is why they get a browser control.
//
// The watcher is a routed URL on this run's own origin, answers are signed the
// way the app verifies them, and no relay, key or amount here is real.

// A real x-only point: 'f'.repeat(64) is not on the curve, so a signature the
// vendor's acceptance needs would fail before the screen ever spoke and the
// cases could pass for a reason other than the one they name. (row 15's trap,
// flagged by AUDITOR for this spec)
const PEER = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const ADDRESS = 'bc1qcatchprobe';
const AMOUNT = '0.001';
const CHECK = 'Check the chain';
const NO_DETAILS = 'This order does not have the payment details needed for a chain check. The chain was not checked.';

const sign = (token, ts, raw) =>
  createHmac('sha256', token).update(`${ts}:${raw}`).digest('hex');
// The token on the wire is the order's child: HMAC of the pasted base secret
// over the version, the currency and the address (childWatcherToken).
const childToken = (base, currency, address) =>
  createHmac('sha256', base).update(`cipher-watch-v1:${currency}:${address}`).digest('hex');

// A buyer's own request plus the vendor's acceptance, which is where the
// buyer's check reads the address and the coin amount from. `details` says
// what the acceptance carries: the issued pair, a currency with no address,
// or nothing at all.
const buyerThread = (details) => {
  const now = Math.floor(Date.now() / 1000);
  const request = {
    id: 'ord-catch', pubkey: PEER, timestamp: now - 900, isSender: true,
    isGroup: false, chatId: PEER,
    data: {
      type: 'cipher_order', status: 'created', vendorPubkey: PEER,
      product: { title: 'Washer', priceUsd: '24.00', currency: 'USD' },
      shippingAddress: '12 Made Up Street',
    },
  };
  const acceptance = {
    id: 'acc-catch', pubkey: PEER, timestamp: now - 800, isSender: false,
    isGroup: false, chatId: PEER,
    data: { type: 'order_update', orderId: request.id, status: 'accepted', ...details },
  };
  return [request, acceptance];
};

// One signed answer per ask, echoing the address and the currency the check
// asked about. Below the coin's confirmation bar, so a well-formed order gets
// "not seen yet" rather than a state the buyer's card cannot reach.
async function answerWatcher(page, collect, confirmations = 1) {
  await page.route('**/watch**', async (route) => {
    const asked = new URL(route.request().url());
    const address = asked.searchParams.get('address') || '';
    const currency = asked.searchParams.get('currency') || 'btc';
    const token = asked.searchParams.get('token') || '';
    collect.push({ address, currency, token });
    const raw = JSON.stringify({
      address, currency, txid: 'ab', confirmations, amount: AMOUNT,
      time: Math.floor(Date.now() / 1000),
    });
    const ts = String(Math.floor(Date.now() / 1000));
    await route.fulfill({
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-cipher-sig': `v1=${sign(token, ts, raw)}`,
        'x-cipher-ts': ts,
      },
      body: raw,
    });
  });
}

async function openThread(page, details) {
  await page.addInitScript(seedVault);
  // The watcher URL is built from whatever origin this run serves, so the same
  // file runs on the board's port or on a scratch one. A localhost plain-HTTP
  // watcher is the one the app allows.
  await page.addInitScript(() => {
    localStorage.setItem('cipher_network', JSON.stringify({
      overrides: { explorer: `${location.origin}/watch?token=secret` },
    }));
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 20000 });
  // The boot's own history fetch lands first, so the seed is not replaced by
  // an empty relay copy.
  await page.waitForTimeout(2000);
  const rows = buyerThread(details);
  await page.evaluate(async ({ peer, list }) => {
    const store = window.__cipherStore;
    if (!store) throw new Error('window.__cipherStore missing — the UI-test seam did not load');
    for (const row of list) await window.__cipher.saveMessage(peer, row);
    store.setState({
      profiles: { [peer]: { displayName: 'Ada', name: 'ada' } },
      dms: { [peer]: list },
    });
  }, { peer: PEER, list: rows });
  await page.getByRole('button', { name: 'Ada' }).click();
  await expect(page.getByRole('button', { name: 'Chat options' })).toBeVisible({ timeout: 10000 });
}

// What this device holds about the order: its own stored receipt and ledger
// keys, and the card's state as the message row carries it. A refused check
// moves none of it.
const snapshot = (page) => page.evaluate(() => {
  const keys = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (/_receipt_|_consumed_txids$|_bound_receipt_/.test(key)) keys.push(key);
  }
  const store = window.__cipherStore.getState();
  const peer = Object.keys(store.dms)[0];
  const rows = (store.dms[peer] || []).map((row) => ({
    id: row.id,
    status: row.data?.status ?? null,
    paymentState: row.data?.paymentState ?? null,
    patch: row.localPatch ?? null,
  }));
  return { keys: keys.sort(), rows };
});

// The preview build registers the app's service worker, and a request the
// worker handles never reaches page.route: the routed watcher would answer
// nobody, and the "asks no watcher" half of each case would pass without ever
// being able to ask. Blocking the worker is what makes the route observable; it
// changes nothing about the refusal logic under test.
test.use({ serviceWorkers: 'block' });

test.describe('the chain check refuses instead of pretending', () => {
  test('control: a well-formed order asks the watcher once, under this order\'s child token', async ({ page }) => {
    const asked = [];
    await answerWatcher(page, asked);
    await openThread(page, {
      coinCurrency: 'btc', coinAmount: AMOUNT, issuedAt: Math.floor(Date.now() / 1000) - 600,
      paymentMethods: { btc: ADDRESS },
    });
    const before = await snapshot(page);
    expect(before.keys, 'control: nothing is stored before the check').toEqual([]);

    await page.getByRole('button', { name: CHECK, exact: true }).first().click();
    // This is the positive control the refusal cases are measured against:
    // the same click, on a card that carries its details, DOES reach out.
    await expect(page.getByText('Your watcher has not seen this payment yet.')).toBeVisible({ timeout: 15000 });
    expect(asked.length, 'the watcher was asked exactly once').toBe(1);
    expect(asked[0]).toEqual({ address: ADDRESS, currency: 'btc', token: childToken('secret', 'btc', ADDRESS) });
    const after = await snapshot(page);
    expect(after, 'a not-yet-seen answer writes nothing').toEqual(before);
  });

  test('a history read that fails says so, asks no watcher, and moves nothing', async ({ page }) => {
    const asked = [];
    await answerWatcher(page, asked);
    await openThread(page, {
      coinCurrency: 'btc', coinAmount: AMOUNT, issuedAt: Math.floor(Date.now() / 1000) - 600,
      paymentMethods: { btc: ADDRESS },
    });
    const before = await snapshot(page);
    // The click re-reads this chat from the database. Fail that read after the
    // page is up, so the failure is inside the click and not at boot. The
    // range is what the read is built from; the cursor and getAll are the
    // reads behind it.
    await page.evaluate(() => {
      const fail = function fail() { throw new Error('forced read failure'); };
      IDBKeyRange.only = fail;
      for (const proto of [IDBIndex.prototype, IDBObjectStore.prototype]) {
        proto.getAll = fail;
        proto.openCursor = fail;
      }
    });

    await page.getByRole('button', { name: CHECK, exact: true }).first().click();
    await expect(page.getByText('The check could not be done, so nothing changed.')).toBeVisible({ timeout: 15000 });
    // One sentence on the card, and not the ledger-record refusal that lives
    // in the same payment surface: two refusals must never speak at once.
    expect((await page.getByRole('status').innerText()).trim()).toBe('The check could not be done, so nothing changed.');
    await expect(page.getByText('could not read its payment record', { exact: false })).toHaveCount(0);
    expect(asked.length, 'the watcher was never asked after a failed read').toBe(0);
    // Nothing was accepted, so the check is still the card's offer.
    await expect(page.getByRole('button', { name: CHECK, exact: true })).toHaveCount(1);
    const after = await snapshot(page);
    expect(after, 'nothing about the order changed').toEqual(before);
  });

  test('an accepted order with no payment details says so, and asks no watcher', async ({ page }) => {
    const asked = [];
    await answerWatcher(page, asked);
    await openThread(page, {});
    const before = await snapshot(page);

    await page.getByRole('button', { name: CHECK, exact: true }).first().click();
    await expect(page.getByText(NO_DETAILS)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('This order has no coin amount, so it cannot be checked.')).toHaveCount(0);
    expect((await page.getByRole('status').innerText()).trim()).toBe(NO_DETAILS);
    expect(asked.length, 'the watcher was never asked').toBe(0);
    await expect(page.getByRole('button', { name: CHECK, exact: true })).toHaveCount(1);
    const after = await snapshot(page);
    expect(after, 'nothing about the order changed').toEqual(before);
  });

  // The guard has two operands, and the cases above reach it through the
  // empty pair. This one reaches it from the other side: a currency named
  // with no pair at all. It must land on the same sentence, ask no watcher,
  // and move nothing.
  test('an acceptance that names a currency and no pair at all says so, and asks no watcher', async ({ page }) => {
    const asked = [];
    await answerWatcher(page, asked);
    await openThread(page, {
      coinCurrency: 'btc', coinAmount: AMOUNT, issuedAt: Math.floor(Date.now() / 1000) - 600,
    });
    const before = await snapshot(page);

    await page.getByRole('button', { name: CHECK, exact: true }).first().click();
    await expect(page.getByText(NO_DETAILS)).toBeVisible({ timeout: 15000 });
    expect((await page.getByRole('status').innerText()).trim()).toBe(NO_DETAILS);
    expect(asked.length, 'the watcher was never asked').toBe(0);
    expect(await snapshot(page), 'nothing about the order changed').toEqual(before);
  });

  // The other side of the same operand: a pair that carries an address but no
  // currency named is NOT a refusal. The pair names its own coin, the check
  // derives it, and the card reaches the watcher exactly as the control does.
  // This is what keeps the guard from over-refusing a well-formed order.
  test('an acceptance that carries an address but names no currency derives the coin and checks', async ({ page }) => {
    const asked = [];
    await answerWatcher(page, asked);
    await openThread(page, {
      coinAmount: AMOUNT, issuedAt: Math.floor(Date.now() / 1000) - 600,
      paymentMethods: { btc: ADDRESS },
    });
    const before = await snapshot(page);

    await page.getByRole('button', { name: CHECK, exact: true }).first().click();
    await expect(page.getByText('Your watcher has not seen this payment yet.')).toBeVisible({ timeout: 15000 });
    await expect(page.getByText(NO_DETAILS)).toHaveCount(0);
    expect(asked.length, 'the watcher was asked exactly once').toBe(1);
    expect(asked[0]).toEqual({ address: ADDRESS, currency: 'btc', token: childToken('secret', 'btc', ADDRESS) });
    expect(await snapshot(page), 'a not-yet-seen answer writes nothing').toEqual(before);
  });

  test('an acceptance that names a currency but no address says so too, and asks no watcher', async ({ page }) => {
    const asked = [];
    await answerWatcher(page, asked);
    await openThread(page, {
      coinCurrency: 'btc', coinAmount: AMOUNT, issuedAt: Math.floor(Date.now() / 1000) - 600,
      paymentMethods: { btc: '' },
    });
    const before = await snapshot(page);

    await page.getByRole('button', { name: CHECK, exact: true }).first().click();
    await expect(page.getByText(NO_DETAILS)).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('This order has no coin amount, so it cannot be checked.')).toHaveCount(0);
    expect((await page.getByRole('status').innerText()).trim()).toBe(NO_DETAILS);
    expect(asked.length, 'the watcher was never asked').toBe(0);
    const after = await snapshot(page);
    expect(after, 'nothing about the order changed').toEqual(before);
  });
});
