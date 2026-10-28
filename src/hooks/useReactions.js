import { useCallback } from 'react';
import { useChatStore } from '../store/chatStore';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays, groupRelays, queryWithTimeout } from '../lib/relays';
import { db } from '../db';
import { mergeReactions, groupReactionFilters, reactionFromEvent, removeReaction, withoutDeletedReactions } from '../lib/reactions';

// A reaction event we deleted stays gone for this device, whatever a relay
// serves again. The deleted ids live in the same tombstone table as deleted
// messages.
async function deletedIdsAmong(events) {
  try {
    const rows = await Promise.all((events || []).map((ev) => (ev?.id ? db.tombstones.get(ev.id) : null)));
    return new Set(rows.map((row, i) => (row ? events[i].id : null)).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function useReactions({ identity }) {
  const setReactions = useChatStore((s) => s.setReactions);

  const sendReaction = useCallback(async (msgId, emoji, isGroup, groupId, authorPubkey) => {
    console.log("🚨 SEND REACTION HOOK:", { msgId, emoji, isGroup, groupId, authorPubkey });
    if (!msgId || !emoji || !identity?.sk) return { success: false };
    try {
      const { finalizeEvent } = await import('nostr-tools');
      const pool = await getAuthenticatedPool(identity);
      const relays = isGroup ? groupRelays : generalRelays;

      const existing = useChatStore.getState().reactions?.[msgId] || [];
      const mine = existing.find((r) => r.pubkey === identity.pk && r.emoji === emoji);
      if (mine) {
        // Taking a reaction back: delete our reaction event (kind 5) and keep
        // that deletion on this device, or the next load brings it back.
        let ids = mine.id ? [mine.id] : [];
        if (!ids.length) {
          try {
            const own = await queryWithTimeout(pool, relays, { kinds: [7], authors: [identity.pk], '#e': [String(msgId)] }, 4000);
            ids = own.filter((ev) => ev.content === emoji).map((ev) => ev.id);
          } catch (error) {
            console.warn('[useReactions] could not look up our reaction:', error);
          }
        }
        for (const id of ids) {
          try { await db.tombstones.put({ id, chatId: 'reaction', at: Date.now() }); } catch (error) {
            console.warn('[useReactions] could not keep the removal on this device:', error);
          }
          const del = finalizeEvent({
            kind: 5,
            created_at: Math.floor(Date.now() / 1000),
            tags: [['e', id], ['k', '7']],
            content: '',
          }, identity.sk);
          Promise.allSettled(pool.publish(relays, del)).catch(() => {});
        }
        setReactions((prev) => ({ ...prev, [msgId]: removeReaction(prev[msgId], { pubkey: identity.pk, emoji }).list }));
        return { success: true, removed: ids.length };
      }

      const tags = [['e', String(msgId)]];
      if (authorPubkey) tags.push(['p', String(authorPubkey)]);
      if (isGroup && groupId) tags.push(['h', String(groupId)]);

      const ev = finalizeEvent({
        kind: 7,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: emoji
      }, identity.sk);

      const results = await Promise.allSettled(pool.publish(relays, ev));
      // The reaction is kept on screen only if a relay took it: a reaction no
      // relay holds is gone after the next load, and the screen lied.
      if (!results.some((result) => result.status === 'fulfilled')) {
        return { success: false, error: 'No relay accepted the reaction.', results };
      }
      setReactions((prev) => mergeReactions(prev, { [msgId]: reactionFromEvent(ev) }));
      return { success: true, results };
    } catch (e) {
      console.error('[useReactions] send failed:', e);
      return { success: false, error: e.message };
    }
  }, [identity, setReactions]);

  const subscribeToReactions = useCallback((msgIds) => {
    if (!msgIds || msgIds.length === 0) return () => {};
    let sub = null;
    let isMounted = true;

    const setup = async () => {
      try {
        const pool = await getAuthenticatedPool(identity);
        const allRelays = [...new Set([...generalRelays, ...groupRelays])];

        // 1. Fetch historical reactions
        const found = await queryWithTimeout(pool, allRelays, { kinds: [7], '#e': msgIds, limit: 500 }, 4000);
        const gone = await deletedIdsAmong(found);
        const events = withoutDeletedReactions(found, gone);
        if (isMounted && events.length > 0) {
          const reactionMap = {};
          events.forEach((ev) => {
            const targetId = ev.tags.find((t) => t[0] === 'e')?.[1];
            if (!targetId) return;
            if (!reactionMap[targetId]) reactionMap[targetId] = [];
            reactionMap[targetId].push(reactionFromEvent(ev));
          });
          setReactions((prev) => mergeReactions(prev, reactionMap));
        }

        // 2. Subscribe to live reactions
        if (isMounted) {
          sub = pool.subscribe(allRelays, { kinds: [7], '#e': msgIds }, {
            onevent: async (ev) => {
              if (!isMounted) return;
              const targetId = ev.tags.find(t => t[0] === 'e')?.[1];
              if (!targetId) return;
              if ((await deletedIdsAmong([ev])).size) return;
              if (!isMounted) return;
              setReactions((prev) => mergeReactions(prev, {
                [targetId]: reactionFromEvent(ev),
              }));
            }
          });
        }
      } catch (e) {
        console.error('[useReactions] subscribe failed:', e);
      }
    };

    setup();

    return () => {
      isMounted = false;
      if (sub) sub.close();
    };
  }, [identity, setReactions]);

  const subscribeToGroupReactions = useCallback((groupIds) => {
    const filters = groupReactionFilters(groupIds);
    if (!filters.length || !identity?.sk) return () => {};
    const subs = [];
    const byGroup = new Map();
    let isMounted = true;
    const onLeft = (event) => {
      const id = event.detail?.groupId;
      const sub = byGroup.get(id);
      if (!sub) return;
      try { sub.close(); } catch { /* already closed */ }
      byGroup.delete(id);
    };
    if (typeof window !== 'undefined') window.addEventListener('cipher:group-left', onLeft);

    const apply = async (ev) => {
      const targetId = ev.tags?.find((tag) => tag[0] === 'e')?.[1];
      if (!targetId) return;
      if ((await deletedIdsAmong([ev])).size) return;
      setReactions((prev) => mergeReactions(prev, {
        [targetId]: reactionFromEvent(ev),
      }));
    };

    const setup = async () => {
      try {
        const pool = await getAuthenticatedPool(identity);
        const batches = await Promise.allSettled(filters.map((filter) => (
          queryWithTimeout(pool, groupRelays, { ...filter, limit: 200 }, 4000)
        )));
        if (isMounted) {
          for (const batch of batches) {
            if (batch.status === 'fulfilled') batch.value.forEach(apply);
          }
        }
        if (!isMounted) return;
        for (const filter of filters) {
          const sub = pool.subscribe(groupRelays, filter, {
            onevent: (ev) => {
              if (!isMounted) return;
              apply(ev);
            },
          });
          subs.push(sub);
          byGroup.set(filter['#h'][0], sub);
        }
      } catch (e) {
        console.error('[useReactions] group subscribe failed:', e);
      }
    };

    setup();
    return () => {
      isMounted = false;
      if (typeof window !== 'undefined') window.removeEventListener('cipher:group-left', onLeft);
      for (const sub of subs) sub.close();
    };
  }, [identity, setReactions]);

  return { sendReaction, subscribeToReactions, subscribeToGroupReactions };
}
