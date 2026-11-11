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

test('test-profile lane route keys join the inbox filter when provided', () => {
  const ROUTE = 'cd'.repeat(32);
  assert.deepEqual(dmSubscriptionFilters(ACCOUNT, 7, [ROUTE]), [
    { kinds: [4, 1059], '#p': [ACCOUNT, ROUTE], since: 7 },
    { kinds: [4], authors: [ACCOUNT], since: 7 },
  ]);
});

test('lane route keys are validated and never duplicate the account key', () => {
  const filters = dmSubscriptionFilters(ACCOUNT, 1, [ACCOUNT.toUpperCase(), 'zz', null, 42]);
  assert.deepEqual(filters[0]['#p'], [ACCOUNT]);
  // A legit second route rides alongside; order preserved for the pool.
  const withRoute = dmSubscriptionFilters(ACCOUNT, 1, ['ab'.repeat(32) === ACCOUNT ? 'ef'.repeat(32) : 'ef'.repeat(32)]);
  assert.equal(withRoute[0]['#p'].length, 2);
});
