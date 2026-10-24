import { useCallback } from 'react';
import { useChatStore } from '../store/chatStore';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays, groupRelays, queryWithTimeout } from '../lib/relays';

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
            if (!reactionMap[targetId].find((r) => r.pubkey === ev.pubkey && r.emoji === ev.content)) {
              reactionMap[targetId].push({ emoji: ev.content, pubkey: ev.pubkey });
            }
          });
          setReactions((prev) => ({ ...prev, ...reactionMap }));
        }

        // 2. Subscribe to live reactions
        if (isMounted) {
          sub = pool.subscribe(allRelays, { kinds: [7], '#e': msgIds }, {
            onevent: (ev) => {
              if (!isMounted) return;
              const targetId = ev.tags.find(t => t[0] === 'e')?.[1];
              if (!targetId) return;
              setReactions(prev => {
                const existing = prev[targetId] || [];
                if (existing.find(r => r.pubkey === ev.pubkey && r.emoji === ev.content)) return prev;
                return { ...prev, [targetId]: [...existing, { emoji: ev.content, pubkey: ev.pubkey }] };
              });
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

  return { sendReaction, subscribeToReactions };
}
