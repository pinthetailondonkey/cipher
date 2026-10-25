export function addReaction(list, reaction) {
  const existing = Array.isArray(list) ? list : [];
  if (!reaction?.pubkey || !reaction?.emoji) return existing;
  if (existing.some((item) => item.pubkey === reaction.pubkey && item.emoji === reaction.emoji)) {
    return existing;
  }
  return [...existing, { emoji: reaction.emoji, pubkey: reaction.pubkey }];
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
