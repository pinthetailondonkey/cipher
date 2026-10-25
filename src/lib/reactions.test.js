import assert from 'node:assert/strict';
import test from 'node:test';
import { groupReactionFilters, mergeReactions } from './reactions.js';
import { groupRelayFilters, groupTimelinePlans } from './crypto/groupMembership.js';

test('kind 7 from a second subscription does not double-apply', () => {
  const reaction = { emoji: '🔥', pubkey: 'a'.repeat(64) };
  const once = mergeReactions({}, { msg1: [reaction] });
  const twice = mergeReactions(once, { msg1: reaction });
  assert.equal(twice, once);
  assert.deepEqual(once.msg1, [reaction]);
  const other = mergeReactions(once, { msg1: { emoji: '🔥', pubkey: 'b'.repeat(64) } });
  assert.equal(other.msg1.length, 2);
});

test('kind 7 for every joined group is its own filter, not the open chat', () => {
  const open = 'group-open';
  const other = 'group-other';
  const filters = groupReactionFilters([open, other, open, '']);
  assert.deepEqual(filters, [
    { kinds: [7], '#h': [open] },
    { kinds: [7], '#h': [other] },
  ]);
  assert.equal(filters.some((filter) => filter['#h'].includes(other)), true);
  assert.equal(filters.some((filter) => filter['#h'].length > 1), false);
  const [timeline] = groupRelayFilters([open]);
  assert.equal(timeline.kinds.includes(7), false);
  const plans = groupTimelinePlans([open, other]);
  assert.equal(plans.every((plan) => plan.filters[0]['#h'].length === 1), true);
  assert.deepEqual(groupReactionFilters([]), []);
});
