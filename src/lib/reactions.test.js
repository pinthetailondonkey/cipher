import assert from 'node:assert/strict';
import test from 'node:test';
import { groupReactionFilters, mergeReactions, reactionFiltersFor, reactionFromEvent, removeReaction, withoutDeletedReactions } from './reactions.js';
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

test('the reaction query asks for the messages we hold by #e, in batches, never for everyone\'s latest', () => {
  const ids = Array.from({ length: 250 }, (_, i) => i.toString(16).padStart(64, '0'));
  const filters = reactionFiltersFor([...ids, 'temp-1', ids[0]]);
  assert.equal(filters.length, 3);
  assert.deepEqual(filters.map((f) => f['#e'].length), [100, 100, 50]);
  assert.ok(filters.every((f) => f.kinds[0] === 7 && f['#e'].length > 0));
  assert.deepEqual(reactionFiltersFor([]), []);
  assert.equal(reactionFiltersFor(ids, 100, 120).flatMap((f) => f['#e']).length, 120);
});

test('a reaction keeps its event id so it can be taken back, and a copy without the id adopts it', () => {
  const me = 'a'.repeat(64);
  const first = mergeReactions({}, { m: { emoji: '+', pubkey: me } });
  const withId = mergeReactions(first, { m: reactionFromEvent({ id: 'e'.repeat(64), content: '+', pubkey: me }) });
  assert.equal(withId.m.length, 1);
  assert.equal(withId.m[0].id, 'e'.repeat(64));
  const { list, removed } = removeReaction(withId.m, { pubkey: me, emoji: '+' });
  assert.deepEqual(list, []);
  assert.equal(removed[0].id, 'e'.repeat(64));
});

test('a reaction whose event was deleted is dropped from what a relay serves again', () => {
  const evs = [{ id: 'x', content: '+' }, { id: 'y', content: '+' }];
  assert.deepEqual(withoutDeletedReactions(evs, new Set(['x'])).map((e) => e.id), ['y']);
});

test('sending a reaction keeps it only if a relay took it, and taking it back publishes a kind 5', async () => {
  const fs = await import('node:fs');
  const hook = fs.readFileSync(new URL('../hooks/useReactions.js', import.meta.url), 'utf8');
  assert.match(hook, /results\.some\(\(result\) => result\.status === 'fulfilled'\)/);
  assert.match(hook, /kind: 5,/);
  assert.match(hook, /db\.tombstones\.put\(\{ id, chatId: 'reaction'/);
  const boot = fs.readFileSync(new URL('../features/chat/useChatBootstrap.js', import.meta.url), 'utf8');
  assert.equal(/\{ kinds: \[7\], limit: 500 \}/.test(boot), false);
  assert.match(boot, /reactionFiltersFor\(held\)/);
});
