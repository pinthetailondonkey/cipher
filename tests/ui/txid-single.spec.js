import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seedVault } from './fixtures.js';

// Row 15 at the screen. A watcher answer must name ONE transaction, and the
// refusal has to be read where it matters: on the order's stored state and on
// the absence of a receipt, not on a ledger count. The positive control shows
// the same click writing a receipt when the answer does name one, so the
// refusal case cannot pass by asserting nothing.
//
// The watcher is a routed URL on this run's own origin, its answers are signed
// the way the app verifies them, and no relay, key or amount here is real.

// A real x-only pubkey: the vendor's update is signed and addressed to this
// key, and a made-up hex string is not a curve point, so the send would fail
// with a field-element error before the screen ever spoke.
const PEER = [...schnorr.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0)))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');
const ADDRESS = 'bc1qtxtprobe';
const AMOUNT = '0.001';
const CHECK = 'Check the chain';
const REFUSED = 'The watcher did not name a single transaction. Nothing was marked on the order.';
const CONFIRMATIONS = 3; // bitcoin's bar; a confirmed answer is what signs a receipt

const sign = (token, ts, raw) =>
  createHmac('sha256', token).update(`${ts}:${raw}`).digest('hex');
const childToken = (base, currency, address) =>
  createHmac('sha256', base).update(`cipher-watch-v1:${currency}:${address}`).digest('hex');

// The vendor's own view of an order: the buyer's request arrived, and this
// device accepted it with its own issued pair. The check reads the pair from
// this device's own acceptance, which is where a vendor's address lives.
const vendorThread = () => {
  const now = Math.floor(Date.now() / 1000);
  const request = {
    id: 'ord-txid', pubkey: PEER, timestamp: now - 900, isSender: false,
    isGroup: false, chatId: PEER,
    data: {
      type: 'cipher_order', status: 'created', vendorPubkey: PEER,
      product: { title: 'Washer', priceUsd: '24.00', currency: 'USD' },
      shippingAddress: '12 Made Up Street',
    },
  };
  const acceptance = {
    id: 'acc-txid', pubkey: PEER, timestamp: now - 800, isSender: true,
    isGroup: false, chatId: PEER,
    data: {
      type: 'order_update', orderId: request.id, status: 'accepted',
      // The payment state this device earned when it accepted: the check's
      // own state chain starts here, and without it a confirmed answer is
      // refused as "has to be seen before it can be confirmed".
      paymentState: 'address_issued',
      coinCurrency: 'btc', coinAmount: AMOUNT, issuedAt: now - 799,
      paymentMethods: { btc: ADDRESS },
    },
  };
  return [request, acceptance];
};

// One signed answer per ask, echoing the ask and naming `txid` exactly as it
// is given: a single string for the control, a list for the refusal.
// `answers` is a list of { txid, confirmations } in the order they are asked,
// so a step-up (seen, then confirmed) can be scripted without a second route.
async function answerWatcher(page, asked, answers) {
  const queue = [...answers];
  await page.route('**/watch**', async (route) => {
    const url = new URL(route.request().url());
    const address = url.searchParams.get('address') || '';
    const currency = url.searchParams.get('currency') || 'btc';
    const token = url.searchParams.get('token') || '';
    const next = queue.length > 1 ? queue.shift() : queue[0];
    asked.push({ address, currency, token, txid: next.txid });
    const raw = JSON.stringify({
      address, currency, txid: next.txid, confirmations: next.confirmations, amount: AMOUNT,
      time: Math.floor(Date.now() / 1000),
    });
    const ts = String(Math.floor(Date.now() / 1000));
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'x-cipher-sig': `v1=${sign(token, ts, raw)}`, 'x-cipher-ts': ts },
      body: raw,
    });
  });
}

async function openThread(page) {
  await page.addInitScript(seedVault);
  await page.addInitScript(() => {
    localStorage.setItem('cipher_network', JSON.stringify({
      overrides: { explorer: `${location.origin}/watch?token=secret` },
    }));
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 20000 });
  await page.waitForTimeout(2000);
  const rows = vendorThread();
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

// What this device stores about the order, read back after the click: every
// receipt-shaped key, and the order row's own status, payment state and local
// patch. The ledger key is listed as a key, never counted: a refusal has to
// show no receipt and no state move, whatever the ledger holds.
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

test.use({ serviceWorkers: 'block' });

test.describe('a report names one transaction', () => {
  test('control: an answer naming one transaction writes the receipt once', async ({ page }) => {
    const asked = [];
    await answerWatcher(page, asked, [{ txid: 'ab', confirmations: CONFIRMATIONS }]);
    await openThread(page);
    const before = await snapshot(page);
    expect(before.keys, 'control: nothing is stored before the check').toEqual([]);

    await page.getByRole('button', { name: CHECK, exact: true }).first().click();
    // The receipt is what this control is about, and it is written before the
    // update leaves the device: wait for the stored key, not for the toast,
    // because no relay answers on this run.
    await expect.poll(async () => (await snapshot(page)).keys.some((key) => /_receipt_/.test(key)), {
      timeout: 20000, message: 'a confirmed answer writes a receipt',
    }).toBe(true);
    expect(asked.length, 'the watcher was asked exactly once').toBe(1);
    for (const one of asked) expect(one).toMatchObject({ address: ADDRESS, currency: 'btc', token: childToken('secret', 'btc', ADDRESS) });
    const after = await snapshot(page);
    expect(after.keys.length, 'a receipt and its ledger entry exist after a confirmed answer').toBeGreaterThan(before.keys.length);
    expect(after.keys.some((key) => /_receipt_/.test(key)), 'the receipt is stored').toBe(true);
  });

  test('a watcher that names two transactions writes no receipt and moves no order', async ({ page }) => {
    const asked = [];
    await answerWatcher(page, asked, [{ txid: ['ab', 'cd'], confirmations: CONFIRMATIONS }]);
    await openThread(page);
    const before = await snapshot(page);

    await page.getByRole('button', { name: CHECK, exact: true }).first().click();
    await expect(page.getByText(REFUSED)).toBeVisible({ timeout: 15000 });
    expect((await page.getByRole('status').innerText()).trim()).toBe(REFUSED);
    expect(asked.length, 'the watcher was asked once, and its answer was refused').toBe(1);
    const after = await snapshot(page);
    expect(after.keys, 'no receipt and no ledger entry were written').toEqual(before.keys);
    expect(after.keys.some((key) => /_receipt_/.test(key)), 'no receipt is stored').toBe(false);
    expect(after.rows, 'the order row is exactly as it was').toEqual(before.rows);
  });

  test('a watcher that names its transaction as a number writes no receipt either', async ({ page }) => {
    const asked = [];
    await answerWatcher(page, asked, [{ txid: 42, confirmations: CONFIRMATIONS }]);
    await openThread(page);
    const before = await snapshot(page);

    await page.getByRole('button', { name: CHECK, exact: true }).first().click();
    await expect(page.getByText(REFUSED)).toBeVisible({ timeout: 15000 });
    const after = await snapshot(page);
    expect(after.keys, 'no receipt and no ledger entry were written').toEqual(before.keys);
    expect(after.rows, 'the order row is exactly as it was').toEqual(before.rows);
  });
});
