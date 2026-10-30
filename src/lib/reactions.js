export function addReaction(list, reaction) {
  const existing = Array.isArray(list) ? list : [];
  if (!reaction?.pubkey || !reaction?.emoji) return existing;
  const entry = { emoji: reaction.emoji, pubkey: reaction.pubkey, ...(reaction.id ? { id: reaction.id } : {}) };
  const at = existing.findIndex((item) => item.pubkey === reaction.pubkey && item.emoji === reaction.emoji);
  if (at >= 0) {
    // The same reaction again is a no-op, except that it may bring the event id
    // a copy made before publishing did not have yet: un-react needs it.
    if (existing[at].id || !reaction.id) return existing;
    const next = [...existing];
    next[at] = entry;
    return next;
  }
  return [...existing, entry];
}

// One kind 7 event as the reaction the screen keeps. The event id rides along:
// taking a reaction back means deleting that event.
export function reactionFromEvent(ev) {
  return { emoji: ev?.content, pubkey: ev?.pubkey, id: ev?.id };
}

// Kind 7 events for the messages we hold, in filters of `size` ids. The old
// query asked every relay for the latest 500 reactions of anyone, which holds
// almost none of ours; `#e` asks for exactly the messages on this device.
export function reactionFiltersFor(messageIds, size = 100, max = 2000) {
  const ids = [...new Set((messageIds || []).filter((id) => typeof id === 'string' && /^[0-9a-f]{64}$/i.test(id)))].slice(0, max);
  const filters = [];
  for (let i = 0; i < ids.length; i += size) {
    filters.push({ kinds: [7], '#e': ids.slice(i, i + size), limit: 500 });
  }
  return filters;
}

// Reactions whose event we deleted (here or from another device) stay gone.
export function withoutDeletedReactions(events, deletedIds) {
  const deleted = deletedIds instanceof Set ? deletedIds : new Set(deletedIds || []);
  return (events || []).filter((ev) => !deleted.has(ev?.id));
}

// Takes one account's reaction off a message. Returns the new list and the
// removed entries, so the caller can delete their events.
export function removeReaction(list, { pubkey, emoji }) {
  const existing = Array.isArray(list) ? list : [];
  const removed = existing.filter((item) => item.pubkey === pubkey && item.emoji === emoji);
  return { list: existing.filter((item) => !(item.pubkey === pubkey && item.emoji === emoji)), removed };
}

// Kind 7 arrives on the per-message subscription and on the all-groups
// subscription. Both paths must call this so the second copy is a no-op.
export function mergeReactions(prev, incoming) {
  const base = prev && typeof prev === 'object' ? prev : {};
  let next = base;
  const entries = incoming instanceof Map ? incoming.entries() : Object.entries(incoming || {});
  for (const [targetId, list] of entries) {
    if (!targetId) continue;
    const items = Array.isArray(list) ? list : [list];
    for (const reaction of items) {
      const existing = next[targetId] || [];
      const merged = addReaction(existing, reaction);
      if (merged === existing) continue;
      if (next === base) next = { ...base };
      next[targetId] = merged;
    }
  }
  return next;
}

// One filter per joined group. A single `#h` array is wrong here: this relay
// closes the entire REQ with "restricted" if any id in it is inaccessible,
// which would drop reactions for every other group too. Kind 7 is not on the
// group timeline filter. These filters are what still deliver it, including
// for a group that is not the one open on screen.
export function groupReactionFilters(groupIds) {
  const ids = [...new Set((groupIds || []).filter((id) => typeof id === 'string' && id.length > 0))];
  return ids.map((id) => ({ kinds: [7], '#h': [id] }));
}
