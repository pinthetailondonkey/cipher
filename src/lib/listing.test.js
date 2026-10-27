import assert from 'node:assert/strict';
import test from 'node:test';
import { listingFromEvent, orderPriceLabel, orderProduct, priceLabel, readCachedProducts, markCachedProductDelivery, PRODUCT_DELIVERY_WORDS } from './listing.js';
import { orderCoinAmount } from './paymentState.js';

// Node has no localStorage; the store helpers persist to it lazily.
if (!globalThis.localStorage) {
  let backing = {};
  globalThis.localStorage = {
    getItem: (k) => (k in backing ? backing[k] : null),
    setItem: (k, v) => { backing[k] = String(v); },
    removeItem: (k) => { delete backing[k]; },
    clear: () => { backing = {}; },
  };
}

const event = (amount, currency) => ({
  id: `ev-${currency}`,
  pubkey: 'ab'.repeat(32),
  tags: [['d', `item-${currency}`], ['title', `Tee in ${currency}`], ['price', amount, currency], ['image', 'https://img.example/t.jpg'], ['payment', 'btc:bc1qmain']],
});

test('a listing priced in BTC or XMR is not read as dollars, from the shop card to the order card', () => {
  const btc = listingFromEvent(event('0.001', 'BTC'));
  const xmr = listingFromEvent(event('0.25', 'XMR'));
  const usd = listingFromEvent(event('40', 'USD'));
  assert.equal(priceLabel(btc.price, btc.currency), '0.001 BTC');
  assert.equal(priceLabel(xmr.price, xmr.currency), '0.25 XMR');
  assert.equal(priceLabel(usd.price, usd.currency), '$40');
  assert.equal('priceUsd' in btc, false);
  assert.equal(usd.priceUsd, '40');

  const card = (listing) => orderPriceLabel({ type: 'cipher_order', product: orderProduct(listing) });
  assert.equal(card(btc), '0.001 BTC');
  assert.equal(card(xmr), '0.25 XMR');
  assert.equal(card(usd), '$40');

  // The vendor accepting the order reads the coin amount straight from it.
  assert.equal(orderCoinAmount(orderProduct(btc), 'btc'), '0.001');
  assert.equal(orderCoinAmount(orderProduct(xmr), 'xmr'), '0.25');
  assert.equal(orderCoinAmount(orderProduct(usd), 'btc'), null);
});

test('a listing carries no payment address — a menu is not a coin you can pay directly', () => {
  // The event still carries payment tags as they arrive from the wire; the
  // listing must not turn them into addresses a checkout could offer. That
  // entry point skipped the order flow: no accept, no issued address, no
  // receipt, nothing to ship against. (security S2)
  assert.equal('btc' in listingFromEvent(event('40', 'USD')), false);
  assert.equal('xmr' in listingFromEvent(event('40', 'USD')), false);
  assert.equal(listingFromEvent(event('40', 'USD')).btc, undefined);
});

test('older orders that only carried priceUsd still show dollars', () => {
  assert.equal(orderPriceLabel({ product: { priceUsd: '12', price: '12' } }), '$12');
  assert.equal(orderPriceLabel({ product: { price: '0.5', currency: 'xmr' } }), '0.5 XMR');
  assert.equal(orderPriceLabel({ product: {} }), '');
});

test('the one product store reads, marks delivery, and survives its own neighbours', () => {
  localStorage.clear();
  const rowA = { id: 'ev-a', vendorPubkey: 'f'.repeat(64), name: 'Tee' };
  const rowB = { id: 'ev-b', vendorPubkey: 'f'.repeat(64), name: 'Pack' };
  localStorage.setItem('cipher_cached_products', JSON.stringify([rowA, rowB]));

  const marked = markCachedProductDelivery('ev-a', 'queued');
  assert.equal(marked.delivery, 'queued');
  const rows = readCachedProducts();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.id === 'ev-a').delivery, 'queued');
  assert.equal(rows.find((row) => row.id === 'ev-b').delivery, undefined);

  // A published word never rides the writer's say-so: only the doors set it.
  assert.deepEqual(Object.keys(PRODUCT_DELIVERY_WORDS), ['queued', 'unconfirmed']);
});

test('the product store answers corrupted or absent JSON with an empty list', () => {
  localStorage.clear();
  assert.deepEqual(readCachedProducts(), []);
  localStorage.setItem('cipher_cached_products', '{not an array');
  assert.deepEqual(readCachedProducts(), []);
  localStorage.setItem('cipher_cached_products', JSON.stringify({ id: 'object' }));
  assert.deepEqual(readCachedProducts(), []);
  localStorage.clear();
});
