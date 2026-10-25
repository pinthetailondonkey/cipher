import { useCallback } from 'react';
import { useChatStore } from '../store/chatStore';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays, groupRelays, queryWithTimeout } from '../lib/relays';
import { mergeReactions, groupReactionFilters } from '../lib/reactions';

export function useReactions({ identity }) {
  const setReactions = useChatStore((s) => s.setReactions);

  const sendReaction = useCallback(async (msgId, emoji, isGroup, groupId, authorPubkey) => {
    console.log("🚨 SEND REACTION HOOK:", { msgId, emoji, isGroup, groupId, authorPubkey });
    if (!msgId || !emoji || !identity?.sk) return { success: false };
    try {
      const { finalizeEvent } = await import('nostr-tools');
      const pool = await getAuthenticatedPool(identity);

      const tags = [['e', String(msgId)]];
      if (authorPubkey) tags.push(['p', String(authorPubkey)]);
      if (isGroup && groupId) tags.push(['h', String(groupId)]);

      const ev = finalizeEvent({
        kind: 7,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: emoji
      }, identity.sk);

      const relays = isGroup ? groupRelays : generalRelays;
      const results = await Promise.allSettled(pool.publish(relays, ev));


      // Optimistic update
      setReactions((prev) => {
        const existing = prev[msgId] || [];
        const alreadyMine = existing.find((r) => r.pubkey === identity.pk && r.emoji === emoji);
        const filtered = existing.filter((r) => !(r.pubkey === identity.pk && r.emoji === emoji));
        if (alreadyMine) {
          return { ...prev, [msgId]: filtered };
        }
        return { ...prev, [msgId]: [...filtered, { emoji, pubkey: identity.pk }] };
      });

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
        const events = await queryWithTimeout(pool, allRelays, { kinds: [7], '#e': msgIds, limit: 500 }, 4000);
        if (isMounted && events.length > 0) {
          const reactionMap = {};
          events.forEach((ev) => {
            const targetId = ev.tags.find((t) => t[0] === 'e')?.[1];
            if (!targetId) return;
            if (!reactionMap[targetId]) reactionMap[targetId] = [];
            reactionMap[targetId].push({ emoji: ev.content, pubkey: ev.pubkey });
          });
          setReactions((prev) => mergeReactions(prev, reactionMap));
        }

        // 2. Subscribe to live reactions
        if (isMounted) {
          sub = pool.subscribe(allRelays, { kinds: [7], '#e': msgIds }, {
            onevent: (ev) => {
              if (!isMounted) return;
              const targetId = ev.tags.find(t => t[0] === 'e')?.[1];
              if (!targetId) return;
              setReactions((prev) => mergeReactions(prev, {
                [targetId]: { emoji: ev.content, pubkey: ev.pubkey },
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

    const apply = (ev) => {
      const targetId = ev.tags?.find((tag) => tag[0] === 'e')?.[1];
      if (!targetId) return;
      setReactions((prev) => mergeReactions(prev, {
        [targetId]: { emoji: ev.content, pubkey: ev.pubkey },
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
