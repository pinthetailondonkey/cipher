import { test, expect } from '@playwright/test';
import { createHmac } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seedVault } from './fixtures.js';

// Row 6b at the screen: the shared-address refusal must read this device's
// own rails and nothing else. The rails are a literal { btc, xmr }, so an
// order naming 'constructor' or '__proto__' used to make the lookup answer
// with a prototype member instead of an address.
//
// Every case records the sentence the screen actually said and whether the
// watcher was asked, because a refusal that fires is not the same fact as
// the refusal this guard is about firing. Nothing here is real: the watcher
// is a routed URL on this run's own origin, and its answer is signed the way
// the app verifies it.

// A real x-only pubkey: the vendor's acceptance is addressed to this key, and
// a made-up hex string is not a curve point.
const PEER = [...schnorr.getPublicKey(Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 1 : 0)))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');
const SHARED = 'bc1qsharedaccount';
const OWN = 'bc1qperorder';
const AMOUNT = '0.001';
const CHECK = 'Check the chain';
const S1 = 'This order was issued the shared account address';
const NO_ADDRESS = 'This order has no payment address to check.';
// Row 14's no-details refusal. It sits ahead of the shared-address gate, so
// under a hostile coin name it answers first: the order's currency and
// address fail its own check before the rails are read at all. The sentence
// moved; the facts the row is about did not, and all of them stay asserted.
const NO_DETAILS = 'This order does not have the payment details needed for a chain check. The chain was not checked.';

const sign = (token, ts, raw) => createHmac('sha256', token).update(`${ts}:${raw}`).digest('hex');

// The vendor's own view of an order: the buyer's request arrived, and this
// device accepted it with its own pair. `currency` is what the acceptance
// names, `address` is the address it issued under btc.
const vendorThread = (address, currency) => {
  const now = Math.floor(Date.now() / 1000);
  const request = {
    id: 'ord-sh1', pubkey: PEER, timestamp: now - 900, isSender: false,
    isGroup: false, chatId: PEER,
    data: {
      type: 'cipher_order', status: 'created', vendorPubkey: PEER,
      product: { title: 'Washer', priceUsd: '24.00', currency: 'USD' },
      shippingAddress: '12 Made Up Street',
    },
  };
  const acceptance = {
    id: 'acc-sh1', pubkey: PEER, timestamp: now - 800, isSender: true,
    isGroup: false, chatId: PEER,
    data: {
      type: 'order_update', orderId: request.id, status: 'accepted',
      paymentState: 'address_issued',
      coinCurrency: currency, coinAmount: AMOUNT, issuedAt: now - 799,
      paymentMethods: { btc: address },
    },
  };
  return [request, acceptance];
};

// The shared account address, written the way the profile screen writes it:
// cipher_<pubkey>_btc_address, JSON-encoded. The scope is read off this run,
// never assumed, so the write lands on the drawer the check itself reads.
const seedSharedAddress = (page, shared) => page.evaluate((value) => {
  const pk = localStorage.getItem('cipher_active_pubkey')
    || localStorage.getItem('cipher_db_owner') || 'guest';
  localStorage.setItem(`cipher_${pk}_btc_address`, JSON.stringify(value));
  return `cipher_${pk}_btc_address`;
}, shared);

async function openThread(page, address, currency) {
  const asked = [];
  // No relay is reachable on this run, by either door. A run that shared a
  // peer key with another lane's run could otherwise receive a stranger's
  // copy of the same conversation and read its order state instead of the
  // rows this test seeded. WebSockets are stubbed before any script runs,
  // because a boot socket connects before a route could matter.
  await page.addInitScript(() => {
    class OfflineSocket {
      constructor() { this.readyState = 0; OfflineSocket.opened += 1; }
      addEventListener() {}
      removeEventListener() {}
      send() {}
      close() { this.readyState = 3; }
    }
    OfflineSocket.opened = 0;
    window.WebSocket = OfflineSocket;
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
    return route.abort();
  });
  await page.route('**/watch**', async (route) => {
    const url = new URL(route.request().url());
    const askedAddress = url.searchParams.get('address') || '';
    const askedCurrency = url.searchParams.get('currency') || 'btc';
    const token = url.searchParams.get('token') || '';
    asked.push({ address: askedAddress, currency: askedCurrency });
    const raw = JSON.stringify({
      address: askedAddress, currency: askedCurrency, txid: 'ab', confirmations: 3, amount: AMOUNT,
      time: Math.floor(Date.now() / 1000),
    });
    const ts = String(Math.floor(Date.now() / 1000));
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'x-cipher-sig': `v1=${sign(token, ts, raw)}`, 'x-cipher-ts': ts },
      body: raw,
    });
  });
  await page.addInitScript(seedVault);
  await page.addInitScript(() => {
    localStorage.setItem('cipher_network', JSON.stringify({
      overrides: { explorer: `${location.origin}/watch?token=secret` },
    }));
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 20000 });
  // The seam arrives through a dynamic import after first paint, so wait for
  // it rather than for a fixed delay.
  await expect.poll(() => page.evaluate(() => typeof window.__cipherStore), {
    timeout: 20000, message: 'the UI-test seam loads',
  }).toBe('function');
  const rows = vendorThread(address, currency);
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
  // The card's own check button is the thing every case presses: wait for it
  // here, so a case never fails on a thread that has not drawn yet.
  await expect(page.getByRole('button', { name: CHECK, exact: true }).first()).toBeVisible({ timeout: 15000 });
  return asked;
}

// Toasts are brief, so nothing is read after a fixed delay: the status region
// is sampled until words appear, and every distinct sentence is kept. A case
// then reports what the screen said, not what it happened to say at second 5.
async function wordsSaid(page, timeout = 12000) {
  const seen = [];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const said = (await page.getByRole('status').innerText().catch(() => '')).trim();
    if (said && !seen.includes(said)) seen.push(said);
    if (said) return { first: seen[0], seen };
    await page.waitForTimeout(150);
  }
  return { first: '', seen };
}

test.use({ serviceWorkers: 'block' });

test.describe('the shared-address refusal reads the device\'s own rails', () => {
  test('control 1 — btc, address IS the shared address: S1 fires and no watcher is asked', async ({ page }) => {
    const asked = await openThread(page, SHARED, 'btc');
    await seedSharedAddress(page, SHARED);
    await page.getByRole('button', { name: CHECK, exact: true }).first().click();
    await expect(page.getByText(S1, { exact: false })).toBeVisible({ timeout: 15000 });
    expect(asked.length, 'the watcher was never asked').toBe(0);
  });

  test('line 1 — constructor, address IS the shared address', async ({ page }) => {
    const asked = await openThread(page, SHARED, 'constructor');
    await seedSharedAddress(page, SHARED);
    await page.getByRole('button', { name: CHECK, exact: true }).first().click();
    const { first } = await wordsSaid(page);
    console.log('[row6b] constructor + shared ->', JSON.stringify(first), '| S1:', first.includes(S1), '| NO_DETAILS:', first.includes(NO_DETAILS), '| NO_ADDRESS:', first.includes(NO_ADDRESS), '| asks:', asked.length);
    // Measured, not assumed: on the base tree this same click said the
    // shared-address sentence, because the methods lookup answered with the
    // Object function and the rails lookup answered with the same function
    // text — two things that are not addresses matched each other. With the
    // lookup guarded there is no address at all, which is the true reason.
    //
    // The sentence is row 14's, not row 6b's: the no-details refusal reads
    // the order's currency and address before the rails are consulted, so a
    // hostile coin name is refused there first. Pinning the exact sentence
    // keeps this a fact about what the screen says, not a loosened "some
    // refusal fired" — the two facts that matter stay asserted under it.
    expect(first, 'a made-up coin name is refused for having no usable payment details').toContain(NO_DETAILS);
    expect(first, 'the no-address refusal is not the one that fires here').not.toContain(NO_ADDRESS);
    expect(first, 'and is not accused of being the shared address').not.toContain(S1);
    expect(asked.length, 'no check leaves the device under a made-up currency').toBe(0);
  });

  test('line 2 — __proto__, address IS the shared address', async ({ page }) => {
    const asked = await openThread(page, SHARED, '__proto__');
    await seedSharedAddress(page, SHARED);
    await page.getByRole('button', { name: CHECK, exact: true }).first().click();
    const { first } = await wordsSaid(page);
    console.log('[row6b] __proto__ + shared ->', JSON.stringify(first), '| S1:', first.includes(S1), '| NO_DETAILS:', first.includes(NO_DETAILS), '| NO_ADDRESS:', first.includes(NO_ADDRESS), '| asks:', asked.length);
    expect(first, 'a made-up coin name is refused for having no usable payment details').toContain(NO_DETAILS);
    expect(first, 'the no-address refusal is not the one that fires here').not.toContain(NO_ADDRESS);
    expect(first, 'and is not accused of being the shared address').not.toContain(S1);
    expect(asked.length, 'no check leaves the device under a made-up currency').toBe(0);
  });

  test('line 3 — btc, address IS the shared address, with the guard in place', async ({ page }) => {
    // Same case as control 1, kept beside the two hostile names so the three
    // lines of the delta are read in one run.
    const asked = await openThread(page, SHARED, 'btc');
    await seedSharedAddress(page, SHARED);
    await page.getByRole('button', { name: CHECK, exact: true }).first().click();
    const { first } = await wordsSaid(page);
    console.log('[row6b] btc + shared ->', JSON.stringify(first), '| S1:', first.includes(S1), '| asks:', asked.length);
    expect(first.includes(S1), 'S1 still fires for a real coin').toBe(true);
    expect(asked.length, 'the watcher was never asked').toBe(0);
  });

  test('line 4 — a per-order address under btc: no over-refusal, and the check runs', async ({ page }) => {
    const asked = await openThread(page, OWN, 'btc');
    await seedSharedAddress(page, SHARED);
    await page.getByRole('button', { name: CHECK, exact: true }).first().click();
    const { seen } = await wordsSaid(page, 8000);
    console.log('[row6b] btc + per-order ->', JSON.stringify(seen), '| asked:', asked.length);
    expect(seen.join(' ').includes(S1), 'the shared-address refusal does not fire on a per-order address').toBe(false);
    expect(seen.join(' ').includes(NO_ADDRESS), 'and the order is not refused for having no address').toBe(false);
    expect(asked.length, 'the check reached the watcher once').toBe(1);
  });
});
