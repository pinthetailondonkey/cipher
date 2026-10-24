import { showNotification } from '../lib/notifications';
import { useChatStore } from '../store/chatStore';

const shouldSuppress = (chatId) => {
  const state = useChatStore.getState();
  const mutedUntil = state.mutedUntil?.[chatId];
  const isMuted = mutedUntil === 'forever' || (mutedUntil && mutedUntil > Date.now());
  const isArchived = state.archivedChats?.includes(chatId);
  return isMuted || isArchived;
};
import { useCallback, useEffect } from 'react';

import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays, queryAllPages } from '../lib/relays';
import { saveMessage } from '../db';
import { enqueueNostrEvent, startOutboxSync } from '../lib/outbox';

export function useNIP44DM({ identity }) {
  const setDms = useChatStore((s) => s.setDms);
  const setTypingUsers = useChatStore((s) => s.setTypingUsers);

  useEffect(() => {
    if (!identity?.sk) return undefined;
    return startOutboxSync(identity);
  }, [identity?.pk, identity?.sk]);

  const sortMessages = (a, b) => {
    const tA = a.local_timestamp || (a.timestamp * 1000);
    const tB = b.local_timestamp || (b.timestamp * 1000);
    if (tA !== tB) return tA - tB;
    return (a.id || '').localeCompare(b.id || '');
  };

  // SEND A DM
  const sendDM = useCallback(async (recipientPubkey, payload, clientId = null, replyId = null) => {
    if (!recipientPubkey || !identity?.sk) return { success: false, error: 'Missing params' };

    // Defensive: trim and cap length
    let targetDm = recipientPubkey.trim();
    if (targetDm.length > 64) targetDm = targetDm.slice(0, 64);

    try {
      const { finalizeEvent, nip44 } = await import('nostr-tools');
      const shared = nip44.v2.utils.getConversationKey(identity.sk, targetDm);
      const encrypted = nip44.v2.encrypt(JSON.stringify(payload), shared);
      const tags = [['p', targetDm]];
      if (clientId) tags.push(['client', clientId]);
      if (replyId) tags.push(['e', replyId, '', 'reply']);
      const event = finalizeEvent({
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: encrypted
      }, identity.sk);

      let results;
      try {
        const pool = await getAuthenticatedPool(identity);
        results = await Promise.allSettled(pool.publish(generalRelays, event));
      } catch (publishError) {
        console.warn('[DM] Offline publish deferred to outbox:', publishError);
        await enqueueNostrEvent(event);
        return { success: true, queued: true, event, relayCount: 0 };
      }
      const okCount = results.filter(r => r.status === 'fulfilled').length;
      if (okCount > 0) return { success: true, event, results, relayCount: okCount };
      console.warn('[DM] All relays rejected:', results);
      await enqueueNostrEvent(event);
      return { success: true, queued: true, event, results, relayCount: 0 };
    } catch (err) {
      console.error('[useNIP44DM] Send failed:', err);
      return { success: false, error: err.message };
    }
  }, [identity]);

  // SEND TYPING INDICATOR
  const sendTypingIndicator = useCallback(async (recipientPubkey) => {
    if (!recipientPubkey || !identity?.sk) return;
    try {
      const { finalizeEvent, nip44 } = await import('nostr-tools');
      const pool = await getAuthenticatedPool(identity);
      const shared = nip44.v2.utils.getConversationKey(identity.sk, recipientPubkey);
      const encrypted = nip44.v2.encrypt(JSON.stringify({ type: 'typing' }), shared);
      const ev = finalizeEvent({
        kind: 4, // Use kind 4 so strict relays accept it
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', recipientPubkey]],
        content: encrypted
      }, identity.sk);
      const results = await Promise.allSettled(pool.publish(generalRelays, ev));
      if (results.every((result) => result.status === 'rejected')) {
        console.warn('[DM] Typing indicator was rejected by all relays:', results);
      }
    } catch (error) {
      console.warn('[DM] Could not send typing indicator:', error);
    }
  }, [identity]);

  // SUBSCRIBE TO INCOMING + OUTGOING DMs
  const subscribeToDMs = useCallback((since) => {
    let subs = [];
    const mounted = { current: true };

    const setup = async () => {
      const pool = await getAuthenticatedPool(identity);
      if (!mounted.current) return;
      const dmFilters = [
        { kinds: [4], '#p': [identity.pk], since },
        { kinds: [4], authors: [identity.pk], since }
      ];
      for (const filter of dmFilters) {
        if (!mounted.current) break;
        const sub = pool.subscribe(generalRelays, filter, {
          onevent: async (event) => {
            if (!mounted.current) return;
            try {
              const { nip44 } = await import('nostr-tools');
              const isSender = event.pubkey === identity.pk;
              const counterparty = isSender ? event.tags.find(t => t[0] === 'p')?.[1] : event.pubkey;
              if (!counterparty) return;
              // Audit H8: drop messages from blocked users at ingestion
              const blocked = useChatStore.getState().blockedUsers || [];
              if (blocked.includes(counterparty)) return;
              const shared = nip44.v2.utils.getConversationKey(identity.sk, counterparty);
              let text;
              try { text = nip44.v2.decrypt(event.content, shared); }
              catch (e) { return; }
              let data = {};
              try { data = JSON.parse(text); } catch (e) { data = { type: 'text', message: text }; }

              if (data.type === 'typing') {
                const age = (Date.now() / 1000) - event.created_at;
                if (age < 10 && event.pubkey !== identity.pk) {
                  setTypingUsers(prev => ({ ...prev, [counterparty]: Date.now() }));
                }
                return;
              }
              if (data.type === 'read') {
                setDms(prev => {
                  const msgs = prev[counterparty] || [];
                  return { ...prev, [counterparty]: msgs.map(m => m.isSender ? { ...m, read: true } : m) };
                });
                return;
              }
              if (data.type === 'gkey' || data.type === 'pin') return;
              // Audit H9: drop messages that already expired (delivery lag)
              if (data.expires_at && Math.floor(Date.now() / 1000) >= data.expires_at) {
                console.log('[DM] Dropping expired message', { from: counterparty.slice(0, 8), expires_at: data.expires_at });
                return;
              }

              const replyTag = event.tags.find(t => t[0] === 'e' && t[3] === 'reply');
              const clientId = event.tags.find(t => t[0] === 'client')?.[1];
              const newMsg = {
                id: event.id, clientId, isSender,
                timestamp: event.created_at, data,
                pubkey: event.pubkey,
                deliveryStatus: isSender ? 'sent' : undefined,
                replyTo: replyTag ? replyTag[1] : null
              };
              if (isSender && clientId) {
                const optimisticMessage = await db.messages.where('clientId').equals(clientId).first();
                if (optimisticMessage?.chatId === counterparty && optimisticMessage.isSender && optimisticMessage.id !== event.id) {
                  await db.messages.delete(optimisticMessage.id);
                }
              }
              await saveMessage(counterparty, newMsg);
              if (!isSender) {
                const state = useChatStore.getState();
                if (state.activeDm !== counterparty) {
                  state.setUnreadCounts(prev => ({ ...prev, [counterparty]: (prev[counterparty] || 0) + 1 }));
                }
              }
              if (!isSender && data.type !== 'typing' && data.type !== 'read' && !shouldSuppress(counterparty)) {
                showNotification(data.type === 'order_request' ? 'order' : 'message');
              }
              setDms(prev => {
                const chatMsgs = prev[counterparty] || [];
                const filtered = isSender && clientId
                  ? chatMsgs.filter(m => m.clientId !== clientId)
                  : chatMsgs;
                if (filtered.some((message) => message.id === event.id)) return prev;
                return { ...prev, [counterparty]: [...filtered, newMsg].sort(sortMessages) };
              });
            } catch (e) { console.error('Live DM error:', e); }
          }
        });
        if (mounted.current) subs.push(sub);
        else sub.close();
      }
    };
    setup().catch((error) => {
      if (mounted.current) console.error('[DM] Failed to start subscriptions:', error);
    });
    return () => {
      mounted.current = false;
      subs.forEach(s => { try { s.close(); } catch (e) {} });
    };
  }, [identity, setDms, setTypingUsers]);

  // FULL FETCH OF DM HISTORY
  const fetchDMs = useCallback(async () => {
    const pool = await getAuthenticatedPool(identity);
    const { nip44 } = await import('nostr-tools');
    const [sentDms, recvDms] = await Promise.all([
      queryAllPages(pool, generalRelays, { kinds: [4], authors: [identity.pk] }),
      queryAllPages(pool, generalRelays, { kinds: [4], '#p': [identity.pk] })
    ]);
    const allDms = Array.from(new Map([...sentDms, ...recvDms].map(ev => [ev.id, ev])).values());
    for (const ev of allDms) {
      try {
        const isSender = ev.pubkey === identity.pk;
        const counterparty = isSender ? ev.tags.find(t => t[0] === 'p')?.[1] : ev.pubkey;
        if (!counterparty) continue;
        const blocked = useChatStore.getState().blockedUsers || [];
        if (blocked.includes(counterparty)) continue;
        const shared = nip44.v2.utils.getConversationKey(identity.sk, counterparty);
        let text;
        try { text = nip44.v2.decrypt(ev.content, shared); }
        catch (e) { continue; }
        let data = {};
        try { data = JSON.parse(text); } catch (e) { data = { type: 'text', message: text }; }
        if (data.type === 'gkey' || data.type === 'typing' || data.type === 'read' || data.type === 'pin') continue;
        if (data.expires_at && Math.floor(Date.now() / 1000) >= data.expires_at) continue;
        const replyTag = ev.tags.find(t => t[0] === 'e' && t[3] === 'reply');
        const clientId = ev.tags.find(t => t[0] === 'client')?.[1];
        if (isSender && clientId) {
          const optimisticMessage = await db.messages.where('clientId').equals(clientId).first();
          if (optimisticMessage?.chatId === counterparty && optimisticMessage.isSender && optimisticMessage.id !== ev.id) {
            await db.messages.delete(optimisticMessage.id);
          }
        }
        await saveMessage(counterparty, {
          id: ev.id, clientId, isSender,
          timestamp: ev.created_at, data,
          pubkey: ev.pubkey,
          replyTo: replyTag ? replyTag[1] : null,
          deliveryStatus: isSender ? 'sent' : undefined,
          isGroup: false
        });
      } catch (e) {}
    }
    const counterparties = new Set();
    for (const ev of allDms) {
      const isSender = ev.pubkey === identity.pk;
      const counterparty = isSender ? ev.tags.find(t => t[0] === 'p')?.[1] : ev.pubkey;
      if (counterparty) counterparties.add(counterparty);
    }
    return [...counterparties];
  }, [identity]);

  return { sendDM, sendTypingIndicator, subscribeToDMs, fetchDMs };
}
