import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPublicKey, finalizeEvent } from 'nostr-tools';
import { RELAY_SETS, urlsFor } from './egress.js';
import {
  VENDOR_CARD_FIELDS,
  buildVendorCardEvent,
  publishVendorCard,
  vendorCardContent,
  vendorCardRelays,
} from './vendorCard.js';

// The boundary this row ships is one sentence long: a vendor's card may reach
// the group relay, an ordinary account's may not. Both directions are checked
// here, and the content is checked field by field, because the failure this
// guards against is not a crash — it is a card that carries one more thing
// than it said it would.

const SK = Uint8Array.from({ length: 32 }, () => 170);
const PK = getPublicKey(SK);
const identity = { pk: PK, sk: SK };
const GROUP_RELAY = urlsFor('group-only')[0];

function spyPool() {
  const calls = [];
  return {
    calls,
    publish(relays, event) {
      calls.push({ relays: [...relays], event });
      return [Promise.resolve('accepted')];
    },
    close() {},
  };
}

test('the card target is the group relay and nothing else', () => {
  assert.deepEqual(RELAY_SETS.vendorCard, ['group-relay'], 'the inventory row names one host');
  const targets = vendorCardRelays();
  assert.equal(targets.length, 1, 'one target');
  assert.deepEqual(targets, urlsFor('group-only'), 'the same host the groups themselves use');
  assert.ok(GROUP_RELAY);
});

test('an ordinary account publishes nothing, and no pool is opened for it', async () => {
  const pool = spyPool();
  const card = await publishVendorCard({ isVendor: false, identity, profile: { name: 'Someone' }, pool });
  assert.equal(card.published, false);
  assert.equal(card.skipped, 'not-a-vendor');
  assert.equal(pool.calls.length, 0, 'no publish, so no event and no connection');
});

test('a vendor publishes one card, to the group relay', async () => {
  const pool = spyPool();
  const card = await publishVendorCard({
    isVendor: true,
    identity,
    profile: { name: 'Ana', displayName: 'Ana', about: 'Flowers', picture: 'https://example.test/a.png' },
    pool,
  });
  assert.equal(card.published, true);
  assert.equal(pool.calls.length, 1, 'one event, one publish call');
  assert.deepEqual(pool.calls[0].relays, vendorCardRelays(), 'the group relay, exactly');
  assert.equal(pool.calls[0].event.kind, 0);
  assert.equal(pool.calls[0].event.pubkey, PK);
});

test('the card carries four named fields and cannot be widened by the profile it is given', async () => {
  const pool = spyPool();
  const profile = {
    name: 'Ana',
    displayName: 'Ana B',
    about: 'Flowers',
    picture: 'https://example.test/a.png',
    // Nothing below belongs on a public card. Each one would be a leak if the
    // content were spread instead of rebuilt.
    txid: 'aa'.repeat(32),
    orderId: 'order-1',
    balance: '0.5',
    address: 'bc1qexample',
    reviews: [{ stars: 5 }],
    privkey: 'never',
  };
  await publishVendorCard({ isVendor: true, identity, profile, pool });
  const content = JSON.parse(pool.calls[0].event.content);
  assert.deepEqual(Object.keys(content).sort(), [...VENDOR_CARD_FIELDS].sort());
  assert.deepEqual(content, {
    name: 'Ana',
    display_name: 'Ana B',
    about: 'Flowers',
    picture: 'https://example.test/a.png',
  });
});

test('a signed event carrying a fifth field is refused rather than published', async () => {
  const pool = spyPool();
  const wide = finalizeEvent({
    kind: 0,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content: JSON.stringify({ name: 'Ana', display_name: 'Ana', about: '', picture: '', txid: 'aa'.repeat(32) }),
  }, SK);
  const card = await publishVendorCard({ isVendor: true, identity, event: wide, pool });
  assert.equal(card.published, false);
  assert.equal(card.skipped, 'card-carries-extra');
  assert.equal(pool.calls.length, 0, 'the wide event never reaches the wire');
});

test('with the group relay switched off there is no target and no publish', async () => {
  const pool = spyPool();
  const card = await publishVendorCard({ isVendor: true, identity, profile: { name: 'Ana' }, relays: [], pool });
  assert.equal(card.published, false);
  assert.equal(card.skipped, 'group-relay-off');
  assert.equal(pool.calls.length, 0);
});

test('a locked account cannot build a card', async () => {
  const pool = spyPool();
  const card = await publishVendorCard({ isVendor: true, identity: { pk: PK }, profile: { name: 'Ana' }, pool });
  assert.equal(card.published, false);
  assert.equal(card.skipped, 'no-account');
  assert.equal(pool.calls.length, 0);
  assert.equal(await buildVendorCardEvent({ name: 'Ana' }, null), null);
});

test('the card the profile editor signs is the card it publishes', async () => {
  // The editor hands over the event it just signed rather than signing twice,
  // so the two relays hold one event, not two that merely look alike.
  const profile = { name: 'Ana', display_name: 'Ana', about: 'Flowers', picture: '' };
  const signed = await buildVendorCardEvent(profile, SK, Date.UTC(2026, 9, 29));
  const same = await buildVendorCardEvent(profile, SK, Date.UTC(2026, 9, 29));
  assert.equal(signed.id, same.id, 'same input, same event id');
  assert.deepEqual(vendorCardContent(profile), JSON.parse(signed.content));
});
