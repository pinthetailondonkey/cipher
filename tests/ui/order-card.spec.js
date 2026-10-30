import { test, expect } from '@playwright/test';
import { seedVault } from './fixtures.js';

// An order card has to render. Nothing in the suite drew one before this file,
// which is how every order card could crash the whole app while the node tests
// and the browser suite both stayed green.
//
// Each case seeds a thread through the app's own database and then opens it,
// because opening a chat re-reads history into the store: a seed that only
// lives in memory is replaced by the stored copy. Synthetic peer, synthetic
// order, no relay.

const PEER = 'f'.repeat(64);

const CARD = {
  cipher_order: {
    type: 'cipher_order', status: 'accepted', vendorPubkey: PEER,
    product: { title: 'Washer', priceUsd: '24.00', currency: 'USD' },
    shippingAddress: '12 Made Up Street',
  },
  order_request: {
    type: 'order_request', status: 'created', vendorPubkey: PEER,
    product: { title: 'Washer', priceUsd: '24.00', currency: 'USD' },
  },
  order_update: {
    type: 'order_update', status: 'shipped', orderId: 'order-1', vendorPubkey: PEER,
    product: { title: 'Washer', priceUsd: '24.00', currency: 'USD' },
  },
};

async function openWithCard(page, content) {
  await page.addInitScript(seedVault);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Chats' })).toBeVisible({ timeout: 20000 });
  // The boot's history fetch is allowed to land first, so the seed written
  // after this point is not replaced by the relay's empty copy.
  await page.waitForTimeout(2000);
  await page.evaluate(async ({ peer, data }) => {
    const store = window.__cipherStore;
    if (!store) throw new Error('window.__cipherStore missing — the UI-test seam did not load');
    const now = Math.floor(Date.now() / 1000);
    const row = { id: `ord-${data.type}`, pubkey: peer, timestamp: now - 900, isSender: false, data };
    await window.__cipher.saveMessage(peer, { ...row, isGroup: false, chatId: peer });
    store.setState({
      profiles: { [peer]: { displayName: 'Ada', name: 'ada' } },
      dms: { [peer]: [row] },
    });
  }, { peer: PEER, data: content });
  await page.getByRole('button', { name: 'Ada' }).click();
  await expect(page.getByRole('button', { name: 'Chat options' })).toBeVisible({ timeout: 10000 });
}

test.describe('order cards render', () => {
  for (const [type, content] of Object.entries(CARD)) {
    test(`${type} draws its card and does not crash`, async ({ page }) => {
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await openWithCard(page, content);

      // The crash screen is the failure this file exists for.
      await expect(page.getByRole('heading', { name: 'Something went wrong', exact: true })).toHaveCount(0);
      // The card itself: the product name, on the card, in the thread.
      await expect(page.getByText('Washer')).toBeVisible();
      expect(errors, `uncaught errors while drawing ${type}`).toEqual([]);
    });
  }

  test('a peer cannot put escrow words on a card while escrow is switched off', async ({ page }) => {
    // A VALID quote, not a decoy. escrowForCard re-derives every number and
    // rejects anything that does not add up, so a malformed payload would
    // prove nothing: it is refused on its own merits and the test would pass
    // with the switch deleted. This one is accepted — asserted below, before
    // the card is opened — so what the card then withholds is the switch's
    // doing alone. Values are synthetic (a made-up 2-of-2 script and its
    // address); no key here exists anywhere.
    const QUOTE = {
      scriptHex: '632103393510ea4724ec8e6b29cc15ee3d646af770ae48a7241162deb6d4041a731ef8ad21035a9791a266cfd1dd6ea666529d648da59be6781ad625dd72473c831344b11c6dac6702400bb27521035a9791a266cfd1dd6ea666529d648da59be6781ad625dd72473c831344b11c6dac68',
      address: 'bc1qd2h5c8mm7pzhzcpfxsfhhd3tmgk09unv8vclnkydg7p5cj6rt98qfkcklh',
      priceSats: '50000000', buyerFeeSats: '1250000', vendorFeeSats: '1250000',
      feeOutSats: '2500000', depositSats: '51250000', delayBlocks: 2880, issuedAt: 1700000000,
    };
    // The positive control: this device accepts the quote. If this ever goes
    // null the test below stops meaning anything, so it fails loudly here.
    const { escrowForCard } = await import('../../src/lib/escrowActions.js');
    expect(escrowForCard({ escrow: QUOTE }), 'control: the quote must be one this device accepts').toBeTruthy();

    await openWithCard(page, { ...CARD.cipher_order, escrow: QUOTE });
    await expect(page.getByText('Washer')).toBeVisible();
    // What the card withholds is the fact box and the progress timeline.
    // The separate payment-row path (escrowRowsFor, ungated) is NOT covered
    // here and is a known open defect, not something this test certifies.
    await expect(page.getByRole('list', { name: 'Escrow progress' })).toHaveCount(0);
    await expect(page.getByText('Accepted (escrow)')).toHaveCount(0);
    await expect(page.getByText(/deposit/i)).toHaveCount(0);
  });
});
