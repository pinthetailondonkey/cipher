import assert from 'node:assert/strict';
import test from 'node:test';
import { dmSubscriptionFilters } from './dmSubscription.js';

const ACCOUNT = 'ab'.repeat(32);

test('live DM subscription filters expose the account routing key for legacy-compatible inbox delivery', () => {
  assert.deepEqual(dmSubscriptionFilters(ACCOUNT, 123), [
    { kinds: [4, 1059], '#p': [ACCOUNT], since: 123 },
    { kinds: [4], authors: [ACCOUNT], since: 123 },
  ]);
});

test('malformed account identities cannot create broad DM subscriptions', () => {
  assert.deepEqual(dmSubscriptionFilters('', 123), []);
  assert.deepEqual(dmSubscriptionFilters('bad', 123), []);
  assert.deepEqual(dmSubscriptionFilters(null, 123), []);
});
