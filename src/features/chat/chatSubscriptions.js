// The thread bootstrap's subscription lifecycle, kept out of the hook so the
// cancellation race can be driven directly. The setup awaits the chat history
// fetch before it can know which groups to follow, so a cleanup that lands
// mid-await used to leave the subscriptions it created afterwards running with
// nothing left to close them. A guard closes every subscription the moment it
// is created after cancellation; cleanup closes the rest.

export function makeSubscriptionGuard() {
  let cancelled = false;
  const cleanups = [];
  return {
    get cancelled() { return cancelled; },
    // Register a subscription's close. A subscription minted after the effect
    // was torn down is closed immediately, never left live.
    track(close) {
      if (typeof close !== 'function') return close;
      if (cancelled) { close(); return close; }
      cleanups.push(close);
      return close;
    },
    cleanup() {
      cancelled = true;
      while (cleanups.length) {
        const close = cleanups.shift();
        try { close(); } catch (error) {
          console.error('[chat] A subscription did not close cleanly:', error);
        }
      }
    },
  };
}

// One run of the setup. `readTargets` is called after the history fetch (the
// original ordering) and returns the group ids this device may subscribe to;
// it is a callback so a test needs no Dexie or identity.
export async function setupChatSubscriptions({
  guard,
  fetchChats,
  subscribeToDMs,
  subscribeToGroups,
  subscribeToGroupReactions,
  since,
  readTargets,
}) {
  await fetchChats();
  if (guard.cancelled) return;
  guard.track(subscribeToDMs(since));
  const { joinedIds = [], groupIds = [] } = readTargets ? readTargets() : {};
  if (guard.cancelled) return;
  // A join still waiting on the owner opens no group subscriptions: the relay
  // refuses them for an account it has not admitted, and a stream of refusals
  // is not a chat. They start when a proof says the account is inside.
  if (groupIds.length > 0) guard.track(subscribeToGroups(groupIds, since));
  if (guard.cancelled) return;
  if (typeof subscribeToGroupReactions === 'function' && joinedIds.length > 0) {
    guard.track(subscribeToGroupReactions(joinedIds));
  }
}
