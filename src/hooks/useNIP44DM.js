import { useCallback, useEffect } from 'react';
import { db, openDBFor, saveMessage, markSentMessagesRead, markChatRead } from '../db';
import { countsAsNewUnread } from '../lib/unreadCounts';
import { receiptTime } from '../lib/messageMerge';
import { dmControlAction, dmExpired, installMemberGroupKey } from './useGroupKeyMember';
import { showNotification } from '../lib/notifications';
import { useChatStore } from '../store/chatStore';
import { getAuthenticatedPool } from '../lib/pool';
import { generalRelays, queryAllPages } from '../lib/relays';
import { publishWriteAhead, startOutboxSync } from '../lib/outbox';
import { allowsTyping } from '../lib/privacy';
import { publishOwnRelayList, relaysForPeer } from '../lib/dmRelays';
import { sortMessages, stampArrival } from '../features/chat/media';
import { withBuzzTag } from '../lib/pushGateway';
import { conversationKey } from '../lib/dmKeys';
import { noteFirstSeen } from '../lib/safetyNumber';
import { clampedExpiresAt } from '../lib/disappearing';
import { acceptPayment, rememberPublicView, receiptBindsOrder, sendCountersignOnce, stripArrivingReceiptMark } from '../lib/proofOfTrade';
import { deviceWatchedOrderOf, orderRecordForReceipt } from '../lib/orderActions';
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

  // Audit F4: storing or cosigning an incoming receipt is only for an order
  // this device tracks that is accepted or further along, and only when every
  // field the order already fixed matches (orderId, coin amount, issued
  // address, the two parties of this chat). A fabricated update can still
  // render as an order_update bubble, but it plants no receipt and harvests
  // no signature.
  const receiptMayBind = useCallback(async (data, counterparty) => {
    try {
      if (!identity?.pk || !data?.orderId || !data?.receipt?.body) return false;
      const messages = await db.messages.where('chatId').equals(counterparty).toArray();
      const record = orderRecordForReceipt(messages, data.orderId, identity.pk);
      if (!record) {
        console.warn('[orders] A receipt arrived for an order this device does not track as accepted. It was not stored or signed.');
        return false;
      }
      const bound = receiptBindsOrder({
        receipt: data.receipt,
        orderId: data.orderId,
        orderCoinAmount: record.coinAmount,
        issuedAddress: record.issuedAddress,
        orderCurrency: record.coinCurrency,
        buyerPubkey: record.isBuyer ? identity.pk : counterparty,
        vendorPubkey: record.isBuyer ? counterparty : identity.pk,
        update: data,
      });
      if (!bound) console.warn('[orders] A receipt did not match the order it arrived under. It was not stored or signed.');
      // N1 fix (round-three re-hack): a buyer's co-signature on a receipt,
      // and on its public view if one rides along, must mean THIS device saw
      // the money with its own watcher — not that the vendor wrote a
      // confirmed receipt over a txid that never happened. The buyer's own
      // check writes seen or confirmed on the order card (security S6);
      // until one landed there, a receipt arriving stores nothing, signs
      // nothing and stays a claim. Their own check is one button away.
      if (bound && record.isBuyer && !deviceWatchedOrderOf(messages, data.orderId)) {
        console.warn('[orders] A receipt arrived before this device checked the payment with its own watcher. It was not stored or signed.');
        return false;
      }
      return bound;
    } catch (error) {
      console.warn('[orders] The receipt could not be checked against the order:', error);
      return false;
    }
  }, [identity]);

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
      let pool = null;
      try {
        pool = await getAuthenticatedPool(identity);
        publishOwnRelayList(identity).catch(() => {});
        targets = await relaysForPeer(identity, targetDm);
      } catch (publishError) {
        console.warn('[DM] Offline publish deferred to outbox:', publishError);
      }
      // Write-ahead (see publishWriteAhead): the signed event is in the outbox
      // before any relay is tried, so a close between sign and publish cannot
      // lose it. Calls and read marks are ephemeral and keep the old order.
      const ephemeral = payload?.type === 'call' || payload?.type === 'read';
      const sent = await publishWriteAhead(event, targets, () => {
        if (!pool) throw new Error('No relay connection yet.');
        return pool.publish(targets, event);
      }, { writeAhead: !ephemeral });
      if (!sent.queued) return { success: true, event, results: sent.results, relayCount: sent.okCount };
      console.warn('[DM] All relays rejected:', sent.results);
      return { success: true, queued: true, event, results: sent.results, relayCount: 0 };
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
        // The serving relay is the safety number's honest input (drill round
        // three): a key first seen on a different relay set must derive a
        // different code, or the relay-swap warning the derivation promises
        // is dead. The library hands the relay to receivedEvent just before
        // the event reaches onevent, so a per-id note is the whole wiring —
        // no pool-wide relay tracking, no second subscription, dedup kept.
        // A duplicate that loses the relay race leaves an entry nobody
        // reads; the map clears itself long before that could matter.
        const servingRelay = new Map();
        const sub = pool.subscribe(generalRelays, filter, {
          receivedEvent: (relay, id) => {
            if (servingRelay.size > 500) servingRelay.clear();
            servingRelay.set(id, relay.url);
          },
          onevent: async (event) => {
            if (!mounted.current) return;
            try {
              const { nip44 } = await import('nostr-tools');
              const isSender = event.pubkey === identity.pk;
              const counterparty = isSender ? event.tags.find(t => t[0] === 'p')?.[1] : event.pubkey;
              if (!counterparty) return;
              // Safety numbers: first time this key speaks to us, freeze
              // where we actually saw it — the relay that served this event
              // when the caller knows it, the configured set otherwise
              // (the history arm has no per-event attribution). Fire-and-
              // forget — never blocks ingestion.
              const serving = servingRelay.get(event.id);
              servingRelay.delete(event.id);
              noteFirstSeen(counterparty, serving ? [serving] : null).catch(() => {});
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
                  // Only someone we have written to gets the refusal; a stranger's offer gets silence.
                  const thread = useChatStore.getState().dms?.[counterparty] || [];
                  const known = thread.some((message) => message?.isSender);
                  await handleCallSignal({ data, from: counterparty, known, eventId: event.id, createdAt: event.created_at });
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
                // Only the peer's receipt means "they read it". Our own receipt,
                // echoed back from the relay, says nothing about our messages.
                if (isSender) return;
                const upTo = receiptTime(data, event.created_at);
                // Written to the database first: the history fetch re-saves
                // our messages as 'sent', and a tick held only in memory died
                // on reload. Scoped to messages at or before the receipt.
                await markSentMessagesRead(counterparty, upTo);
                setDms(prev => {
                  const msgs = prev[counterparty] || [];
                  return { ...prev, [counterparty]: msgs.map(m => (m.isSender && Number(m.timestamp) <= upTo && m.deliveryStatus !== 'sending' && m.deliveryStatus !== 'failed' ? { ...m, read: true, deliveryStatus: 'read' } : m)) };
                });
                return;
              }
              // Audit H9, moved ahead of the engines (drill round three): an
              // expired message is dead on arrival. The drop used to sit
              // AFTER this block, so a key bundle that aged out in flight
              // still installed, and a stale receipt still countersigned.
              if (dmExpired(data)) {
                console.log('[DM] Dropping expired message', { from: counterparty.slice(0, 8), expires_at: data.expires_at });
                return;
              }
              // The stamp the row will carry is the one the roster promised:
              // clamped to the longest choice the timer offers, and a stamp
              // that is not a future whole-seconds integer carries no
              // sentence, so the saved row honors nothing from it. (drill
              // round residual — the receiver never clamps sender-written
              // stamps)
              if (data.expires_at != null) {
                data = { ...data, expires_at: clampedExpiresAt(data.expires_at) ?? undefined };
              }
              if (dmControlAction(data) === 'gkey') {
                openDBFor(identity.pk);
                const installed = await installMemberGroupKey(data, event.pubkey);
                if (!installed) console.error('[group-key] A key message arrived and was not installed.');
                return;
              }
              if (data.type === 'pin') return;
              if (data.type === 'order_update' && data.receipt && !isSender) {
                // The mark says this device accepted this receipt, so the wire
                // may not carry it in. Stripped before the gate is asked, and
                // written back only if the gate says yes.
                data = stripArrivingReceiptMark(data);
                if (await receiptMayBind(data, counterparty)) {
                  const accepted = acceptPayment(data, identity.sk);
                  if (accepted) {
                    // The gate above said yes, and that answer is written onto
                    // the receipt this row keeps. Nothing else sets it, and the
                    // ledger reads direction only from a receipt carrying it —
                    // the body is the peer's text, never evidence by itself.
                    const boundReceipt = { ...accepted.receipt, bound: true };
                    scopedSet(`receipt_${data.orderId}`, boundReceipt);
                    // S10: the mark of a receipt this device countersigned
                    // after it passed the order binding. A stored receipt
                    // without this mark is never re-signed for a dispute.
                    scopedSet(`bound_receipt_${data.orderId}`, accepted.receipt.hash);
                    if (accepted.published) rememberPublicView(accepted.published);
                    data = { ...data, receipt: boundReceipt, ...(accepted.published ? { published: accepted.published } : {}) };
                    // The peer gets the unmarked receipt: the mark is this
                    // device's own record of its own decision.
                    sendCountersign(sendDM, counterparty, data.orderId, accepted);
                  }
                }
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
              // Read before the save: whether this id is already stored, was
              // deleted here, and where the chat's read marker stands.
              const alreadyStored = !isSender && !!(await db.messages.get(event.id));
              const tombstoned = !isSender && !!(await db.tombstones.get(event.id));
              const lastRead = isSender ? 0 : ((await db.chatReads.get(counterparty))?.lastRead || 0);
              await saveMessage(counterparty, newMsg);
              if (!isSender) {
                const state = useChatStore.getState();
                const chatOpen = state.activeDm === counterparty;
                if (countsAsNewUnread({ alreadyStored, tombstoned, isSender, chatOpen, timestamp: event.created_at, lastRead })) {
                  state.setUnreadCounts(prev => ({ ...prev, [counterparty]: (prev[counterparty] || 0) + 1 }));
                } else if (chatOpen && !tombstoned) {
                  // Arriving into the chat on screen is reading it: the marker
                  // moves, or the message counts as unread after a reload.
                  markChatRead(counterparty, Math.max(Math.floor(Date.now() / 1000), event.created_at));
                }
              }
              if (!isSender && data.type !== 'typing' && data.type !== 'read' && !shouldSuppress(counterparty)) {
                // S11: the counterparty is the throttle key. Ingestion above
                // is untouched — the message has already landed and marked unread.
                showNotification(data.type === 'order_request' ? 'order' : 'message', counterparty);
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
  }, [identity, setDms, setTypingUsers, sendDM, receiptMayBind]);

  // FULL FETCH OF DM HISTORY
  const fetchDMs = useCallback(async () => {
    const pool = await getAuthenticatedPool(identity);
    const { nip44 } = await import('nostr-tools');
    const [sentDms, recvDms] = await Promise.all([
      queryAllPages(pool, generalRelays, { kinds: [4], authors: [identity.pk] }),
      queryAllPages(pool, generalRelays, { kinds: [4], '#p': [identity.pk] })
    ]);
    const allDms = Array.from(new Map([...sentDms, ...recvDms].map(ev => [ev.id, ev])).values());
    const readUpTo = new Map();
    for (const ev of allDms) {
      try {
        const isSender = ev.pubkey === identity.pk;
        const counterparty = isSender ? ev.tags.find(t => t[0] === 'p')?.[1] : ev.pubkey;
        if (!counterparty) continue;
        // Safety numbers: same first-seen freeze on the history path. A
        // merged history fetch has no per-event attribution, so the honest
        // first-seen answer here is the set the query itself ran on.
        noteFirstSeen(counterparty).catch(() => {});
        const blocked = useChatStore.getState().blockedUsers || [];
        if (blocked.includes(counterparty)) continue;
        const shared = conversationKey(identity.sk, counterparty);
        let text;
        try { text = nip44.v2.decrypt(ev.content, shared); }
        catch (e) { continue; }
        let data = {};
        try { data = JSON.parse(text); } catch (e) { data = { type: 'text', message: text }; }
        // Audit H9, moved ahead of the engines (drill round three): same
        // ordering as the live arm — an expired message runs no key install
        // and countersigns no receipt, and it saves nowhere.
        if (dmExpired(data)) continue;
        if (dmControlAction(data) === 'gkey') {
          openDBFor(identity.pk);
          const installed = await installMemberGroupKey(data, ev.pubkey);
          if (!installed) console.error('[group-key] A key message arrived and was not installed.');
          continue;
        }
        if (data.type === 'read' && !isSender) {
          // Receipts that came in while the app was closed: keep the newest
          // per peer and apply it after the loop.
          const upTo = receiptTime(data, ev.created_at);
          if (Number.isFinite(upTo) && upTo > (readUpTo.get(counterparty) ?? 0)) readUpTo.set(counterparty, upTo);
          continue;
        }
        if (data.type === 'typing' || data.type === 'read' || data.type === 'pin' || data.type === 'call') {
          continue;
        }
        if (!isSender && data.type === 'order_update' && data.receipt) {
          // Same strip as the live path, for the same reason: the copy that
          // comes back through history is the peer's text too.
          data = stripArrivingReceiptMark(data);
          if (await receiptMayBind(data, counterparty)) {
            const accepted = acceptPayment(data, identity.sk);
            if (accepted) {
              // The same mark as the live path, written at the same place: the
              // gate said yes, and only this line may say so.
              const boundReceipt = { ...accepted.receipt, bound: true };
              scopedSet(`receipt_${data.orderId}`, boundReceipt);
              // S10: same bound mark as the live path, so the dispute button
              // can never re-sign a receipt this device never cosigned.
              scopedSet(`bound_receipt_${data.orderId}`, accepted.receipt.hash);
              if (accepted.published) rememberPublicView(accepted.published);
              data = { ...data, receipt: boundReceipt, ...(accepted.published ? { published: accepted.published } : {}) };
              sendCountersign(sendDM, counterparty, data.orderId, accepted);
            }
          }
        }
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
    for (const [peer, upTo] of readUpTo) await markSentMessagesRead(peer, upTo);
    const counterparties = new Set();
    for (const ev of allDms) {
      const isSender = ev.pubkey === identity.pk;
      const counterparty = isSender ? ev.tags.find(t => t[0] === 'p')?.[1] : ev.pubkey;
      if (counterparty) counterparties.add(counterparty);
    }
    // The drill (round three, 4d) caught commit 9b07acd dropping this
    // return: the hook then resolves undefined and every app load throws
    // reading .length of it in useChatBootstrap — profile loading dies
    // with it.
    return [...counterparties];
  }, [identity, sendDM, receiptMayBind]);

  return { sendDM, sendTypingIndicator, subscribeToDMs, fetchDMs };
}
