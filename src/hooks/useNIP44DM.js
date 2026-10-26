import { useCallback, useEffect } from 'react';
import { db, openDBFor, saveMessage } from '../db';
import { dmControlAction, installMemberGroupKey } from './useGroupKeyMember';
import { showNotification } from '../lib/notifications';
import { useChatStore } from '../store/chatStore';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays, queryAllPages } from '../lib/relays';
import { enqueueNostrEvent, startOutboxSync } from '../lib/outbox';
import { allowsTyping } from '../lib/privacy';
import { publishOwnRelayList, relaysForPeer } from '../lib/dmRelays';
import { sortMessages, stampArrival } from '../features/chat/media';
import { withBuzzTag } from '../lib/pushGateway';
import { conversationKey } from '../lib/dmKeys';
import { noteFirstSeen } from '../lib/safetyNumber';
import { acceptPayment, rememberPublicView, sendCountersignOnce } from '../lib/proofOfTrade';
import { scopedSet } from '../lib/storage';

function sendCountersign(sendDM, counterparty, orderId, accepted) {
  return sendCountersignOnce({
    sendDM,
    counterparty,
    orderId,
    accepted,
    onFailure: (error) => {
      console.error('[orders] The buyer signature was not sent:', error);
      useChatStore.getState().setToast({
        type: 'error',
        message: 'Your signature on the payment receipt did not send. Cipher will try again the next time it loads your chats.',
      });
    },
  });
}

const shouldSuppress = (chatId) => {
  const state = useChatStore.getState();
  const mutedUntil = state.mutedUntil?.[chatId];
  const isMuted = mutedUntil === 'forever' || (mutedUntil && mutedUntil > Date.now());
  const isArchived = state.archivedChats?.includes(chatId);
  return isMuted || isArchived;
};

export function useNIP44DM({ identity }) {
  const setDms = useChatStore((s) => s.setDms);
  const setTypingUsers = useChatStore((s) => s.setTypingUsers);

  useEffect(() => {
    if (!identity?.sk) return undefined;
    return startOutboxSync(identity);
  }, [identity?.pk, identity?.sk]);

  // SEND A DM
  const sendDM = useCallback(async (recipientPubkey, payload, clientId = null, replyId = null) => {
    if (!recipientPubkey || !identity?.sk) return { success: false, error: 'Missing params' };

    // Defensive: trim and cap length
    let targetDm = recipientPubkey.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(targetDm)) return { success: false, error: 'That is not a valid public key.' };

    try {
      const { finalizeEvent, nip44 } = await import('nostr-tools');
      const shared = conversationKey(identity.sk, targetDm);
      const encrypted = nip44.v2.encrypt(JSON.stringify(payload), shared);
      const tags = withBuzzTag([
        ['p', targetDm],
        ...(clientId ? [['client', clientId]] : []),
        ...(replyId ? [['e', replyId, '', 'reply']] : []),
      ], payload);
      const event = finalizeEvent({
        kind: 4,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: encrypted
      }, identity.sk);

      let targets = generalRelays.slice();
      let results;
      try {
        const pool = await getAuthenticatedPool(identity);
        publishOwnRelayList(identity).catch(() => {});
        targets = await relaysForPeer(identity, targetDm);
        results = await Promise.allSettled(pool.publish(targets, event));
      } catch (publishError) {
        console.warn('[DM] Offline publish deferred to outbox:', publishError);
        await enqueueNostrEvent(event, targets);
        return { success: true, queued: true, event, relayCount: 0 };
      }
      const okCount = results.filter(r => r.status === 'fulfilled').length;
      if (okCount > 0) return { success: true, event, results, relayCount: okCount };
      console.warn('[DM] All relays rejected:', results);
      await enqueueNostrEvent(event, targets);
      return { success: true, queued: true, event, results, relayCount: 0 };
    } catch (err) {
      console.error('[useNIP44DM] Send failed:', err);
      return { success: false, error: err.message };
    }
  }, [identity]);

  // SEND TYPING INDICATOR
  const sendTypingIndicator = useCallback(async (recipientPubkey) => {
    if (!recipientPubkey || !identity?.sk || !/^[0-9a-f]{64}$/i.test(recipientPubkey) || !allowsTyping()) return;
    try {
      const { finalizeEvent, nip44 } = await import('nostr-tools');
      const pool = await getAuthenticatedPool(identity);
      const targets = await relaysForPeer(identity, recipientPubkey);
      const shared = conversationKey(identity.sk, recipientPubkey);
      const encrypted = nip44.v2.encrypt(JSON.stringify({ type: 'typing' }), shared);
      const ev = finalizeEvent({
        kind: 4, // Use kind 4 so strict relays accept it
        created_at: Math.floor(Date.now() / 1000),
        tags: [['p', recipientPubkey]],
        content: encrypted
      }, identity.sk);
      const results = await Promise.allSettled(pool.publish(targets.length ? targets : generalRelays, ev));
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
      publishOwnRelayList(identity).catch(() => {});
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
              // Safety numbers: first time this key speaks to us, freeze where
              // we saw it. Fire-and-forget — never blocks ingestion.
              noteFirstSeen(counterparty).catch(() => {});
              // Audit H8: drop messages from blocked users at ingestion
              const blocked = useChatStore.getState().blockedUsers || [];
              if (blocked.includes(counterparty)) return;
              const shared = conversationKey(identity.sk, counterparty);
              let text;
              try { text = nip44.v2.decrypt(event.content, shared); }
              catch (e) { return; }
              let data = {};
              try { data = JSON.parse(text); } catch (e) { data = { type: 'text', message: text }; }

              if (data.type === 'call') {
                if (!isSender) {
                  const { handleCallSignal } = await import('../lib/voiceCall');
                  await handleCallSignal({ data, from: counterparty, eventId: event.id, createdAt: event.created_at });
                }
                return;
              }
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
                  return { ...prev, [counterparty]: msgs.map(m => m.isSender ? { ...m, read: true, deliveryStatus: 'read' } : m) };
                });
                return;
              }
              if (dmControlAction(data) === 'gkey') {
                openDBFor(identity.pk);
                const installed = await installMemberGroupKey(data, event.pubkey);
                if (!installed) console.error('[group-key] A key message arrived and was not installed.');
                return;
              }
              if (data.type === 'pin') return;
              if (data.type === 'order_update' && data.receipt && !isSender) {
                const accepted = acceptPayment(data, identity.sk);
                if (accepted) {
                  scopedSet(`receipt_${data.orderId}`, accepted.receipt);
                  if (accepted.published) rememberPublicView(accepted.published);
                  data = { ...data, receipt: accepted.receipt, ...(accepted.published ? { published: accepted.published } : {}) };
                  sendCountersign(sendDM, counterparty, data.orderId, accepted);
                }
              }
              // Audit H9: drop messages that already expired (delivery lag)
              if (data.expires_at && Math.floor(Date.now() / 1000) >= data.expires_at) {
                console.log('[DM] Dropping expired message', { from: counterparty.slice(0, 8), expires_at: data.expires_at });
                return;
              }

              const replyTag = event.tags.find(t => t[0] === 'e' && t[3] === 'reply');
              const clientId = event.tags.find(t => t[0] === 'client')?.[1];
              const newMsg = stampArrival({
                id: event.id, clientId, isSender,
                timestamp: event.created_at, data,
                pubkey: event.pubkey,
                local_timestamp: Date.now(),
                deliveryStatus: isSender ? 'sent' : undefined,
                replyTo: replyTag ? replyTag[1] : null
              });
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
  }, [identity, setDms, setTypingUsers, sendDM]);

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
        // Safety numbers: same first-seen freeze on the history path.
        noteFirstSeen(counterparty).catch(() => {});
        const blocked = useChatStore.getState().blockedUsers || [];
        if (blocked.includes(counterparty)) continue;
        const shared = conversationKey(identity.sk, counterparty);
        let text;
        try { text = nip44.v2.decrypt(ev.content, shared); }
        catch (e) { continue; }
        let data = {};
        try { data = JSON.parse(text); } catch (e) { data = { type: 'text', message: text }; }
        if (dmControlAction(data) === 'gkey') {
          openDBFor(identity.pk);
          const installed = await installMemberGroupKey(data, ev.pubkey);
          if (!installed) console.error('[group-key] A key message arrived and was not installed.');
          continue;
        }
        if (data.type === 'typing' || data.type === 'read' || data.type === 'pin' || data.type === 'call') {
          continue;
        }
        if (!isSender && data.type === 'order_update' && data.receipt) {
          const accepted = acceptPayment(data, identity.sk);
          if (accepted) {
            scopedSet(`receipt_${data.orderId}`, accepted.receipt);
            if (accepted.published) rememberPublicView(accepted.published);
            data = { ...data, receipt: accepted.receipt, ...(accepted.published ? { published: accepted.published } : {}) };
            sendCountersign(sendDM, counterparty, data.orderId, accepted);
          }
        }
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
      } catch (error) {
        console.error('[DM] Could not save a message:', error);
      }
    }
    const counterparties = new Set();
    for (const ev of allDms) {
      const isSender = ev.pubkey === identity.pk;
      const counterparty = isSender ? ev.tags.find(t => t[0] === 'p')?.[1] : ev.pubkey;
      if (counterparty) counterparties.add(counterparty);
    }
  }, [identity, sendDM]);

  return { sendDM, sendTypingIndicator, subscribeToDMs, fetchDMs };
}
