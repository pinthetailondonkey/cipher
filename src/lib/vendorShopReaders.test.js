import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchVendorThread } from './vendorShopReaders.js';

const VENDOR = 'a'.repeat(64);

// queryWithTimeout is imported directly by the reader, so stub the relays
// module's seam: a fake pool whose querySync resolves per filter kind.
function fakePool(byKind) {
  return {
    querySync: async (_relays, filter) => byKind[filter.kinds[0]] || [],
  };
}

test('fetchVendorThread hands over the three public faces of one shop, nothing else', async () => {
  const review = { id: 'r1', kind: 10005, pubkey: 'c'.repeat(64), tags: [['p', VENDOR], ['receipt', 'ee'.repeat(32)]], content: 'fine' };
  const dispute = { id: 'r2', kind: 10006, pubkey: VENDOR, tags: [['p', VENDOR], ['rider', 'vendor-flag']], content: 'never sent' };
  const bulletin = { id: 'r3', kind: 10007, pubkey: VENDOR, tags: [['rail', 'btc'], ['bulletin', 'proven']], content: '{"txids":[]}' };
  const other = { id: 'r4', kind: 10004, pubkey: 'c'.repeat(64), tags: [['p', VENDOR]], content: 'a vouch is not a review' };
  const pool = fakePool({ 10005: [review, other], 10006: [dispute], 10007: [bulletin] });
  const out = await fetchVendorThread(pool, ['wss://relay.example'], VENDOR);
  assert.deepEqual(out, { reviews: [review, other], disputes: [dispute], bulletins: [bulletin] },
    'the reader fetches and hands over; derivations live in their own modules');
});

test('the reader fails closed on an empty ask: no vendor, no pool, no relays — no fetch', async () => {
  const pool = fakePool({});
  assert.deepEqual(await fetchVendorThread(pool, ['wss://relay.example'], ''), { reviews: [], disputes: [], bulletins: [] });
  assert.deepEqual(await fetchVendorThread(null, ['wss://relay.example'], VENDOR), { reviews: [], disputes: [], bulletins: [] });
  assert.deepEqual(await fetchVendorThread(pool, [], VENDOR), { reviews: [], disputes: [], bulletins: [] });
});
