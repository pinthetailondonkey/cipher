import { test } from 'node:test';
import assert from 'node:assert/strict';

import { listingFromEvent, menuShareLink, productShareLink, soldOutFromEvent } from './listing.js';

const VENDOR = 'a'.repeat(64);

test('menuShareLink builds one whole-menu URL per vendor', () => {
  const link = menuShareLink(VENDOR, 'https://cipher.example');
  const url = new URL(link);
  assert.equal(url.origin, 'https://cipher.example');
  assert.equal(url.searchParams.get('vendor'), VENDOR);
  // The menu link is not a product link: it carries no item id.
  assert.equal(url.searchParams.get('product'), null);
});

test('menuShareLink falls back to window origin and rejects empty vendors', () => {
  assert.equal(menuShareLink(''), '');
  assert.equal(menuShareLink(null), '');
  globalThis.window = { location: { origin: 'https://origin.example' } };
  try {
    const url = new URL(menuShareLink(VENDOR));
    assert.equal(url.searchParams.get('vendor'), VENDOR);
    assert.equal(url.origin, 'https://origin.example');
  } finally {
    delete globalThis.window;
  }
});

test('productShareLink still names its own product beside vendor', () => {
  const url = new URL(productShareLink({ id: 'ev-1', vendorPubkey: VENDOR }, 'https://cipher.example'));
  assert.equal(url.searchParams.get('product'), 'ev-1');
  assert.equal(url.searchParams.get('vendor'), VENDOR);
});

test('sold_out tag reads as sold out, absence and negations read as in stock', () => {
  assert.equal(soldOutFromEvent([['sold_out', '1']]), true);
  assert.equal(soldOutFromEvent([['sold_out', 'true']]), true);
  assert.equal(soldOutFromEvent([['sold_out', 'yes']]), true);
  assert.equal(soldOutFromEvent([['sold_out', '0']]), false);
  assert.equal(soldOutFromEvent([['sold_out', 'false']]), false);
  assert.equal(soldOutFromEvent([['sold_out', 'no']]), false);
  assert.equal(soldOutFromEvent([['sold_out', '']]), false);
  assert.equal(soldOutFromEvent([]), false);
  assert.equal(soldOutFromEvent(undefined), false);
});

test('listingFromEvent carries soldOut for both listings on the wire', () => {
  const base = { id: 'ev', pubkey: VENDOR, tags: [['d', 'soup'], ['title', 'Soup'], ['price', '12', 'USD']] };
  assert.equal(listingFromEvent(base).soldOut, false);
  assert.equal(listingFromEvent({ ...base, tags: [...base.tags, ['sold_out', 'yes']] }).soldOut, true);
});
