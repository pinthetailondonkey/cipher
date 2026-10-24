import Logo from './components/Logo';
import { getMyGroups, setMyGroups } from './lib/myGroups';
import { lazy, Suspense, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { RefreshCw, Search, Bookmark, Bell, QrCode } from 'lucide-react';
import { uploadToBlossom } from '@nostr-wot/blossom';
import { db, saveMessage, openDBFor } from './db';
import ChatList from './components/chat/ChatList';
import CreateGroupModal from './components/chat/CreateGroupModal';
import FloatingMenu from './components/chat/FloatingMenu';
import MyProfileModal from './components/chat/MyProfileModal';
import SearchView from './components/chat/SearchView';
import BookmarksViewer from './components/chat/BookmarksViewer';
import NotificationCenter from './components/chat/NotificationCenter';
import QRScanner from './components/chat/QRScanner';
import MessageSearchResults from './components/chat/MessageSearchResults';
import BroadcastModal from './components/chat/BroadcastModal';
import ProductEditModal from './components/chat/ProductEditModal';
import { generalRelays, groupRelays, queryAllPages, queryWithTimeout } from './lib/relays';
import { getAuthenticatedPool } from './lib/pool';
import { useChatStore } from './store/chatStore';
import { scopedGet, scopedSet, scopedRemove } from './lib/storage';
import { haptic } from './lib/haptics';
import { useNIP44DM } from './hooks/useNIP44DM';
import { useNIP29Group } from './hooks/useNIP29Group';
import { decodeGroupEvent } from './lib/crypto/groupMessageCodec';
import { useGroupKeyReconciler } from './hooks/useGroupKeyReconciler';
import { useReactions } from './hooks/useReactions';
import { useReputation } from './hooks/useReputation';
import { compressImage } from './lib/imageCompression';
import { getOrderPaymentMethods } from './lib/vendorPayments';

const VendorStorefront = lazy(() => import('./components/chat/VendorStorefront'));
const DmView = lazy(() => import('./components/chat/DmView'));
const GroupView = lazy(() => import('./components/chat/GroupView'));
const ProfileModal = lazy(() => import('./components/ProfileModal'));

const copyToClipboard = async (text) => {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn('[Clipboard] Modern API failed, trying fallback', err);
  }
  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    return successful;
  } catch (err) {
    console.error('[Clipboard] Fallback failed', err);
    return false;
  }
};

// Blossom uses a signer object (not a Nostr event publish) — unavoidable exception
// to the "no inline finalizeEvent" rule because there is no useBlossom hook.
const blossomSigner = (identity) => ({
  getPublicKey: async () => identity.pk,
  signEvent: async (event) => {
    const { finalizeEvent } = await import('nostr-tools');
    return finalizeEvent(event, identity.sk);
  },
});

export default function Chat({ identity }) {
  const {
    view, setView, activeDm, setActiveDm, activeGroup, setActiveGroup,
    dms, setDms, groups, groupMessages, setGroupMessages,
    setReactions, deletedMsgs, setDeletedMsgs,
    replyingTo, setReplyingTo, loading, setLoading,
    uploadingImage, setUploadingImage, isRecording, setIsRecording,
    profiles, setProfiles, setUnreadCounts,
    selectedMessage, setSelectedMessage,
    newMessage, setNewMessage,
    toast, setToast,
    typingUsers, setTypingUsers, groupTypingUsers, setGroupTypingUsers,
    vendorStorefrontPubkey, setVendorStorefrontPubkey,
    editingProduct, setEditingProduct,
    broadcastProduct, setBroadcastProduct,
    showQRScanner, setShowQRScanner,
    showNotifCenter, setShowNotifCenter,
    showBookmarks, setShowBookmarks,
    forwardingMsg, setForwardingMsg,
    profilePubkey, setProfilePubkey,
  } = useChatStore();

  const searchResults = useChatStore(s => s.searchResults);
  const showCreateGroup = useChatStore(s => s.showCreateGroup);
  const setShowCreateGroup = useChatStore(s => s.setShowCreateGroup);
  const disappearingTimers = useChatStore(s => s.disappearingTimers);
  const setGroupsStore = useChatStore(s => s.setGroups);
  const groupSubscriptionKey = groups.map(group => group.id).sort().join('|');

  const [lockedUsername, setLockedUsername] = useState(scopedGet('my_username', ''));
  const lastTypingSent = useRef(0);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const chatMountedRef = useRef(false);

  useEffect(() => {
    chatMountedRef.current = true;
    return () => {
      chatMountedRef.current = false;
      const recorder = mediaRecorderRef.current;
      if (!recorder) return;
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== 'inactive') recorder.stop();
      recorder.stream.getTracks().forEach((track) => track.stop());
      mediaRecorderRef.current = null;
    };
  }, []);

  const { sendDM, subscribeToDMs, sendTypingIndicator, fetchDMs } = useNIP44DM({ identity });
  const {
    sendGroupMessage, subscribeToGroups, pinMessage, unpinMessage, fetchPinnedMessage, requestGroupKey,
    sendGroupTypingIndicator, createGroup: createGroupHook, leaveGroup: leaveGroupHook,
    fetchGroupMembers,
  } = useNIP29Group({ identity });
  const { sendReaction } = useReactions({ identity });
  const { sendVouch } = useReputation({ identity });
  const syncIdentity = useMemo(
    () => ({ pk: identity?.pk, sk: identity?.sk }),
    [identity?.pk, identity?.sk]
  );
  const syncGroupMessages = useCallback(async (groupId) => {
    const pool = await getAuthenticatedPool(syncIdentity);
    const events = await queryAllPages(pool, groupRelays, { kinds: [9], '#h': [groupId] });
    const syncedMessages = [];

    for (const event of events) {
      const decoded = await decodeGroupEvent({ event, groupId });
      if (decoded.error) {
        console.warn('[Chat] Could not decrypt group history event:', event.id, decoded.reason);
        continue;
      }
      const replyTag = event.tags.find((tag) => tag[0] === 'e' && tag[3] === 'reply');
      const clientId = event.tags.find((tag) => tag[0] === 'client')?.[1];
      const message = {
        id: event.id,
        clientId,
        isSender: event.pubkey === syncIdentity.pk,
        pubkey: event.pubkey,
        timestamp: event.created_at,
        rawContent: decoded.pending ? null : decoded.plaintext,
        ciphertext: decoded.pending ? event.content : null,
        epoch: decoded.epoch,
        pending: !!decoded.pending,
        replyTo: replyTag ? replyTag[1] : null,
        isGroup: true,
      };
      await saveMessage(groupId, message);
      syncedMessages.push(message);
    }

    if (syncedMessages.length > 0) {
      setGroupMessages((previous) => {
        const current = previous[groupId] || [];
        const byId = new Map(current.map((message) => [message.id, message]));
        syncedMessages.forEach((message) => byId.set(message.id, message));
        return {
          ...previous,
          [groupId]: Array.from(byId.values()).sort((a, b) => a.timestamp - b.timestamp),
        };
      });
    }
  }, [syncIdentity, setGroupMessages]);

  useGroupKeyReconciler({
    groups,
    fetchGroupMembers,
    syncGroupMessages,
    identity,
  });

  const setGroups = useCallback((val) => {
    setGroupsStore((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      const myGroupsRaw = localStorage.getItem('cipher_my_groups_' + identity?.pk?.slice(0, 16));
      const myGroupIds = new Set(myGroupsRaw ? JSON.parse(myGroupsRaw).map(g => g.id) : []);
      return (next || []).filter(g => myGroupIds.has(g.id));
    });
  }, [identity?.pk, setGroupsStore]);

  useEffect(() => {
    if (identity?.pk) openDBFor(identity.pk);
  }, [identity?.pk]);

  useEffect(() => {
    const handleOutboxStatus = async (event) => {
      const messageId = event.detail?.id;
      const deliveryStatus = event.detail?.status;
      if (!messageId || !deliveryStatus) return;
      try {
        const [message, outboxEntry] = await Promise.all([
          db.messages.get(messageId),
          db.outbox.get(messageId),
        ]);
        if (!message) return;
        const currentStatus = outboxEntry?.status || 'sent';
        const updatedMessage = { ...message, deliveryStatus: currentStatus };
        if (message.deliveryStatus !== currentStatus) await db.messages.put(updatedMessage);
        if (message.isGroup) {
          setGroupMessages((current) => ({
            ...current,
            [message.chatId]: (current[message.chatId] || []).map((item) => item.id === messageId ? updatedMessage : item),
          }));
        } else {
          setDms((current) => ({
            ...current,
            [message.chatId]: (current[message.chatId] || []).map((item) => item.id === messageId ? updatedMessage : item),
          }));
        }
      } catch (error) {
        console.error('[outbox] Could not update the sent message:', messageId, error);
      }
    };
    window.addEventListener('cipher:outbox-status', handleOutboxStatus);
    return () => window.removeEventListener('cipher:outbox-status', handleOutboxStatus);
  }, [setDms, setGroupMessages]);

  useEffect(() => {
    if (!identity?.pk) return;
    const fetchMyUsername = async () => {
      try {
        const pool = await getAuthenticatedPool(identity);
        const evs = await queryWithTimeout(pool, generalRelays, {
          kinds: [30078], authors: [identity.pk], '#d': ['username'],
        });
        if (evs && evs.length > 0) {
          const username = evs[0].tags.find(t => t[0] === 'username')?.[1];
          if (username && username !== lockedUsername) {
            setLockedUsername(username);
            scopedSet('my_username', username);
            useChatStore.getState().setMyUsername(username);
          }
        }
      } catch (e) { console.error('Failed to restore username', e); }
    };
    fetchMyUsername();
  }, [identity?.pk]);

  const sortMessages = (a, b) => {
    const timeA = a.local_timestamp || (a.timestamp * 1000);
    const timeB = b.local_timestamp || (b.timestamp * 1000);
    if (timeA !== timeB) return timeA - timeB;
    return (a.id || '').localeCompare(b.id || '');
  };

  const fetchProfilesForPubkeys = async (pubkeys) => {
    if (!pubkeys || pubkeys.length === 0) return;
    try {
      const cached = await db.profiles.bulkGet(pubkeys);
      const cachedMap = {};
      cached.forEach(p => { if (p) cachedMap[p.pubkey] = p; });
      setProfiles(prev => ({ ...prev, ...cachedMap }));
      const missing = pubkeys.filter(pk => !cachedMap[pk]);
      if (missing.length === 0) return;
      const pool = await getAuthenticatedPool(identity);
      const allRelays = [...new Set([...generalRelays, ...groupRelays])];
      const events = await queryWithTimeout(pool, allRelays, { kinds: [0], authors: missing }, 4000);
      const fresh = {};
      for (const ev of events) {
        try {
          const meta = JSON.parse(ev.content);
          const profile = {
            pubkey: ev.pubkey,
            name: meta.name || meta.display_name || ev.pubkey.slice(0, 8),
            displayName: meta.display_name || meta.name || ev.pubkey.slice(0, 8),
            picture: meta.picture || null, about: meta.about || '',
          };
          fresh[ev.pubkey] = profile;
          await db.profiles.put(profile);
        } catch {}
      }
      if (Object.keys(fresh).length > 0) setProfiles(prev => ({ ...prev, ...fresh }));
    } catch (err) { console.error('[profiles] fetch failed:', err); }
  };

  const fetchChats = async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      const pool = await getAuthenticatedPool(identity);
      const [groupMetaEvents, reactionsEvents, delEvents] = await Promise.all([
        queryWithTimeout(pool, groupRelays, { kinds: [39000, 9002], limit: 100 }),
        queryWithTimeout(pool, generalRelays, { kinds: [7], limit: 500 }),
        queryWithTimeout(pool, generalRelays, { kinds: [5], limit: 100 }),
      ]);
      const localGroupsNow = getMyGroups(identity.pk);
      const uniqueGroupsNow = Array.from(new Map(groupMetaEvents.map(ev => {
        const hTag = ev.tags.find(t => t[0] === 'h')?.[1] || ev.tags.find(t => t[0] === 'd')?.[1];
        return [hTag, ev];
      })).values());
      const parsedGroupsNow = uniqueGroupsNow.map(ev => {
        const getTag = (t) => ev.tags.find(x => x[0] === t)?.[1];
        return {
          id: getTag('h') || getTag('d'),
          name: getTag('name') || 'Unnamed',
          about: getTag('about') || '',
          isChannel: ev.tags.some(t => t[0] === 'channel' || t[0] === 'broadcast'),
          creator: ev.pubkey,
        };
      }).filter(g => g.id);
      // DM history goes through useNIP44DM.fetchDMs() — no inline nip44 here
      const allGroupsMap = new Map(localGroupsNow.map(g => [g.id, g]));
      parsedGroupsNow.forEach(pg => {
        if (allGroupsMap.has(pg.id)) {
          allGroupsMap.set(pg.id, { ...allGroupsMap.get(pg.id), ...pg });
        } else {
          allGroupsMap.set(pg.id, pg);
        }
      });
      setGroups(Array.from(allGroupsMap.values()));
      const dmPubkeys = await fetchDMs();
      const reactionMap = {};
      reactionsEvents.forEach(ev => {
        const targetId = ev.tags.find(t => t[0] === 'e')?.[1];
        if (targetId) {
          if (!reactionMap[targetId]) reactionMap[targetId] = [];
          if (!reactionMap[targetId].find(r => r.pubkey === ev.pubkey && r.emoji === ev.content)) {
            reactionMap[targetId].push({ emoji: ev.content, pubkey: ev.pubkey });
          }
        }
      });
      setReactions(reactionMap);
      const deleted = new Set();
      delEvents.forEach(ev => {
        if (ev.pubkey === identity.pk) {
          const targetId = ev.tags.find(t => t[0] === 'e')?.[1];
          if (targetId) deleted.add(targetId);
        }
      });
      setDeletedMsgs(deleted);
      const allDbMsgs = await db.messages.toArray();
      const reads = await db.chatReads.toArray();
      const readMap = {};
      reads.forEach(r => { readMap[r.chatId] = r.lastRead; });
      const counts = {};
      allDbMsgs.forEach(msg => {
        if (!msg.isSender) {
          const lastRead = readMap[msg.chatId] || 0;
          if (msg.timestamp > lastRead) counts[msg.chatId] = (counts[msg.chatId] || 0) + 1;
        }
      });
      setUnreadCounts(counts);
      const finalDms = {};
      const finalGroups = {};
      let _j = 0;
      for (const msg of allDbMsgs) {
        if (++_j % 50 === 0) await new Promise(r => setTimeout(r, 0)); // Yield to UI
        if (msg.isGroup === true) {
          if (!finalGroups[msg.chatId]) finalGroups[msg.chatId] = [];
          finalGroups[msg.chatId].push(msg);
        } else {
          if (!finalDms[msg.chatId]) finalDms[msg.chatId] = [];
          finalDms[msg.chatId].push(msg);
        }
      }
      Object.keys(finalDms).forEach(k => finalDms[k].sort(sortMessages));
      Object.keys(finalGroups).forEach(k => finalGroups[k].sort(sortMessages));
      setDms(finalDms);
      setGroupMessages(finalGroups);
      if (dmPubkeys.length > 0) fetchProfilesForPubkeys(dmPubkeys);
    } catch (err) {
      console.error('Fetch error:', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!identity.sk) return;
    let cleanupDMs = null;
    let cleanupGroups = null;
    const setup = async () => {
      const since = Math.floor(Date.now() / 1000) - 604800;
      await fetchChats(true);
      cleanupDMs = subscribeToDMs(since);
      const groupIds = getMyGroups(identity.pk).map(g => g.id);
      if (groupIds.length > 0) cleanupGroups = subscribeToGroups(groupIds, since);
    };
    setup();
    return () => {
      if (cleanupDMs) cleanupDMs();
      if (cleanupGroups) cleanupGroups();
    };
  }, [identity.sk, identity.pk, groupSubscriptionKey]);

  useEffect(() => {
    if (!identity?.sk) return;
    fetchGroups().catch((e) => console.error('[init] fetchGroups:', e));
  }, [identity?.sk]);

  // DM typing — routed through useNIP44DM hook
  useEffect(() => {
    if (!newMessage.trim() || view !== 'dm' || !activeDm || !identity.sk) return;
    if (Date.now() - lastTypingSent.current < 2500) return;
    const timer = setTimeout(async () => {
      await sendTypingIndicator(activeDm);
      lastTypingSent.current = Date.now();
    }, 200);
    return () => clearTimeout(timer);
  }, [newMessage, view, activeDm, identity.sk, sendTypingIndicator]);

  // Group typing — routed through useNIP29Group hook
  useEffect(() => {
    if (!newMessage.trim() || view !== 'group' || !activeGroup || !identity.sk) return;
    if (Date.now() - lastTypingSent.current < 2500) return;
    const timer = setTimeout(async () => {
      await sendGroupTypingIndicator(activeGroup.id);
      lastTypingSent.current = Date.now();
    }, 200);
    return () => clearTimeout(timer);
  }, [newMessage, view, activeGroup, identity.sk, sendGroupTypingIndicator]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setTypingUsers(prev => {
        const next = { ...prev };
        let changed = false;
        for (const pk in next) if (now - next[pk] > 2500) { delete next[pk]; changed = true; }
        return changed ? next : prev;
      });
      setGroupTypingUsers(prev => {
        const next = { ...prev };
        let changed = false;
        for (const pk in next) if (now - next[pk] > 2500) { delete next[pk]; changed = true; }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [setTypingUsers, setGroupTypingUsers]);

  useEffect(() => {
    if (activeGroup && groupMessages[activeGroup.id]) {
      const pks = new Set(groupMessages[activeGroup.id].map(m => m.pubkey));
      if (pks.size > 0) fetchProfilesForPubkeys([...pks]);
    }
  }, [activeGroup, groupMessages]);

  useEffect(() => {
    const interval = setInterval(async () => {
      const now = Math.floor(Date.now() / 1000);
      setDms(prev => {
        let changed = false;
        const next = { ...prev };
        for (const [pk, msgs] of Object.entries(prev)) {
          const timerStr = disappearingTimers[pk];
          if (timerStr && timerStr !== 'off') {
            let seconds = 0;
            if (timerStr.endsWith('m')) seconds = parseInt(timerStr) * 60;
            else if (timerStr === '1h') seconds = 3600;
            else if (timerStr === '24h') seconds = 86400;
            else if (timerStr === '7d') seconds = 604800;
            if (seconds > 0) {
              const filtered = msgs.filter(m => (now - m.timestamp) < seconds);
              if (filtered.length !== msgs.length) { next[pk] = filtered; changed = true; }
            }
          }
        }
        return changed ? next : prev;
      });
      setGroupMessages(prev => {
        let changed = false;
        const next = { ...prev };
        for (const [gid, msgs] of Object.entries(prev)) {
          const timerStr = disappearingTimers[gid];
          if (timerStr && timerStr !== 'off') {
            let seconds = 0;
            if (timerStr.endsWith('m')) seconds = parseInt(timerStr) * 60;
            else if (timerStr === '1h') seconds = 3600;
            else if (timerStr === '24h') seconds = 86400;
            else if (timerStr === '7d') seconds = 604800;
            if (seconds > 0) {
              const filtered = msgs.filter(m => (now - m.timestamp) < seconds);
              if (filtered.length !== msgs.length) { next[gid] = filtered; changed = true; }
            }
          }
        }
        return changed ? next : prev;
      });
    }, 5000);
    return () => clearInterval(interval);
  }, [disappearingTimers, setDms, setGroupMessages]);

  useEffect(() => {
    if (!identity?.pk) return;
    const lastUser = localStorage.getItem('cipher_last_user');
    if (lastUser && lastUser !== identity.pk) {
      useChatStore.setState({ dms: {}, groups: [], groupMessages: {}, profiles: {}, unreadCounts: {}, reactions: {} });
      db.messages.clear().catch(console.error);
      db.chatReads.clear().catch(console.error);
      localStorage.removeItem('cipher_my_groups');
    }
    localStorage.setItem('cipher_last_user', identity.pk);
  }, [identity?.pk]);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const joinId = urlParams.get('group') || urlParams.get('join') || urlParams.get('g');
    const joinName = urlParams.get('name');
    if (joinId && identity?.pk) {
      (async () => {
        try {
          const pool = await getAuthenticatedPool(identity);
          const events = await queryWithTimeout(pool, groupRelays, { kinds: [9002], limit: 200 }, 3000);
          const match = events.find(ev => ev.tags.find(t => t[0] === 'h')?.[1] === joinId);
          const creator = match?.pubkey;
          if (creator && creator !== identity.pk) {
            await requestToJoinGroup(joinId, joinName, creator);
          } else {
            joinGroupById(joinId, joinName);
          }
        } catch {
          joinGroupById(joinId, joinName);
        }
      })();
    }
  }, [identity?.pk]);


  const handleOrderAction = async (action, msg) => {
    if (!['accept_order', 'decline_order', 'cancel_order', 'confirm_payment', 'mark_shipped', 'confirm_delivery', 'report_issue'].includes(action)) {
      return false;
    }
  
      if (action === 'accept_order') {
        const baseBtc = scopedGet('btc_address', localStorage.getItem('cipher_btc_address') || localStorage.getItem('cipher_btc') || '');
        const baseXmr = scopedGet('xmr_address', localStorage.getItem('cipher_xmr_address') || localStorage.getItem('cipher_xmr') || '');
        let paymentMethods;
        try {
          paymentMethods = await getOrderPaymentMethods(
            identity,
            msg.data.orderId || msg.id,
            { btc: baseBtc, xmr: baseXmr },
            msg.data.paymentMethod || 'btc',
          );
        } catch (error) {
          console.error('[orders] Could not prepare private payment addresses:', error);
          setToast({ type: 'error', message: error?.message || 'Could not create order payment addresses.' });
          setSelectedMessage(null);
          return true;
        }
        if (!paymentMethods.btc && !paymentMethods.xmr) {
          setToast({ type: 'error', message: 'Set payment addresses in Profile first' });
          setSelectedMessage(null);
          return true;
        }
        const payload = {
          type: 'order_update', orderId: msg.id,
          productName: msg.data.product?.title || msg.data.productName,
          product: msg.data.product || null,
          status: 'accepted', paymentMethods,
        };
        const result = await sendDM(msg.pubkey, payload);
        if (!result.success) {
          setToast({ type: 'error', message: result.error || 'Could not send order acceptance.' });
          setSelectedMessage(null);
          return true;
        }
        updateLocalOrder(msg.pubkey, msg.id, { status: 'accepted', paymentMethods: payload.paymentMethods });
        setToast({ type: 'success', message: result.queued ? 'Acceptance queued; it will send when connected.' : 'Order accepted' });
        setSelectedMessage(null); return;
      }
      if (action === 'decline_order' || action === 'cancel_order') {
        const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title, status: 'cancelled' };
        await sendDM(msg.pubkey, payload);
        updateLocalOrder(msg.pubkey, msg.id, { status: 'cancelled' });
        setToast({ type: 'success', message: 'Order cancelled' });
        setSelectedMessage(null); return;
      }
      if (action === 'confirm_payment') {
        const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title || msg.data.productName, status: 'paid', shippingAddress: msg.data.shippingAddress };
        await sendDM(msg.pubkey, payload);
        updateLocalOrder(msg.pubkey, msg.id, { status: 'paid', shippingAddress: msg.data.shippingAddress });
        setToast({ type: 'success', message: 'Payment confirmed' });
        setSelectedMessage(null); return;
      }
      if (action === 'mark_shipped') {
        const tracking = msg.data?.tracking || '';
        const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title || msg.data.productName, status: 'shipped', tracking };
        await sendDM(msg.pubkey, payload);
        updateLocalOrder(msg.pubkey, msg.id, { status: 'shipped', tracking });
        setToast({ type: 'success', message: tracking ? 'Shipped' : 'Marked shipped' });
        setSelectedMessage(null); return;
      }
      if (action === 'confirm_delivery') {
        const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title || msg.data.productName, status: 'completed' };
        await sendDM(msg.pubkey, payload);
        updateLocalOrder(msg.pubkey, msg.id, { status: 'completed' });
        if (scopedGet('auto_vouch_on_delivery', true)) {
          const vouchResult = await sendVouch(msg.pubkey);
          if (!vouchResult.success) console.error('[orders] Automatic delivery vouch failed:', vouchResult.error);
        }
        setToast({ type: 'success', message: 'Delivered' });
        setSelectedMessage(null); return;
      }
      if (action === 'report_issue') {
        useChatStore.getState().openDialog({
          title: 'Report an Issue', hasInput: true, placeholder: 'e.g. Not shipped, wrong item, damaged',
          type: 'danger', confirmText: 'Submit',
          onConfirm: async (reason) => {
            if (!reason || !reason.trim()) return;
            const payload = { type: 'order_update', orderId: msg.id, productName: msg.data.product?.title, status: 'disputed', disputeReason: reason.trim() };
            await sendDM(msg.pubkey, payload);
            updateLocalOrder(msg.pubkey, msg.id, { status: 'disputed', disputeReason: reason.trim() });
            setToast({ type: 'success', message: 'Issue reported' });
          },
        });
        setSelectedMessage(null); return;
      }
  
    return true;
  };

  const startOrderWithVendor = async (vendorPubkey, product, listingId) => {
    if (!identity?.sk || !vendorPubkey) {
      setToast({ type: 'error', message: 'Unlock your account to contact the seller.' });
      return;
    }
    if (vendorPubkey === identity.pk) {
      setToast({ type: 'error', message: 'You cannot place an order with yourself.' });
      return;
    }

    const orderProduct = {
      id: listingId || product.id || null,
      title: product.title || product.name || 'Product',
      price: product.price || product.priceUsd || '',
      currency: product.currency || (product.priceUsd ? 'USD' : ''),
      priceUsd: product.priceUsd,
      image: product.image || '',
      description: product.description || '',
    };
    const paymentMethod = scopedGet('preferred_payment_method', 'btc');
    const payload = { type: 'order_request', status: 'pending', paymentMethod, product: orderProduct };
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMessage = {
      id: tempId,
      clientId: tempId,
      isSender: true,
      isGroup: false,
      pubkey: identity.pk,
      timestamp: Math.floor(Date.now() / 1000),
      local_timestamp: Date.now(),
      deliveryStatus: 'sending',
      data: payload,
    };

    openChat('dm', vendorPubkey);
    setVendorStorefrontPubkey(null);
    setDms((current) => ({
      ...current,
      [vendorPubkey]: [...(current[vendorPubkey] || []), optimisticMessage],
    }));
    await saveMessage(vendorPubkey, optimisticMessage);

    const result = await sendDM(vendorPubkey, payload, tempId);
    if (!result.success) {
      setDms((current) => ({
        ...current,
        [vendorPubkey]: (current[vendorPubkey] || []).filter((message) => message.clientId !== tempId),
      }));
      await db.messages.delete(tempId);
      setToast({ type: 'error', message: result.error || 'The order request could not be sent.' });
      return;
    }

    let confirmedMessage = {
      ...optimisticMessage,
      id: result.event.id,
      timestamp: result.event.created_at,
      deliveryStatus: result.queued ? 'queued' : 'sent',
    };
    await saveMessage(vendorPubkey, confirmedMessage);
    if (result.queued && !(await db.outbox.get(result.event.id))) {
      confirmedMessage = { ...confirmedMessage, deliveryStatus: 'sent' };
      await saveMessage(vendorPubkey, confirmedMessage);
    }
    setDms((current) => ({
      ...current,
      [vendorPubkey]: (current[vendorPubkey] || []).map((message) => (
        message.clientId === tempId ? confirmedMessage : message
      )),
    }));
    setToast({
      type: 'success',
      message: result.queued ? 'Order saved and will send when connected.' : 'Order request sent to seller.',
    });
  };

  const handleMessageAction = async (action, secondArg = null) => {
    let msg;
    let emojiOverride = null;
    if (secondArg && typeof secondArg === 'object' && secondArg.id && secondArg.pubkey) {
      msg = secondArg;
    } else if (typeof secondArg === 'string') {
      emojiOverride = secondArg;
      msg = selectedMessage;
    } else {
      msg = selectedMessage;
    }
    if (!msg) return;

    if (action === 'react' && emojiOverride) {
      await sendReaction(msg.id, emojiOverride, !!activeGroup, activeGroup?.id, msg.pubkey);
      setSelectedMessage(null); return;
    }
    if (action === 'reply') { setReplyingTo(msg); setSelectedMessage(null); return; }
    if (action === 'copy') {
      copyToClipboard(msg.data?.message || msg.rawContent || msg.text || '');
      setToast({ type: 'success', message: 'Copied' });
      setSelectedMessage(null); return;
    }
    if (action === 'forward') {
      const senderName = profiles[msg.pubkey]?.displayName || profiles[msg.pubkey]?.name || (msg.pubkey === identity.pk ? 'You' : `User ${msg.pubkey.slice(0, 4)}`);
      setForwardingMsg({ data: msg.data || { type: 'text', message: msg.rawContent }, originalSenderName: senderName, id: msg.id });
      setSelectedMessage(null); return;
    }
    if (action === 'bookmark') {
      const chatId = activeDm || activeGroup?.id;
      if (chatId) {
        useChatStore.getState().toggleBookmark(chatId, msg.id);
        const isBm = useChatStore.getState().isBookmarked(chatId, msg.id);
        setToast({ type: 'success', message: isBm ? 'Saved' : 'Unsaved' });
      }
      setSelectedMessage(null); return;
    }
    if (action === 'select') {
      useChatStore.getState().toggleSelectionMode();
      useChatStore.getState().toggleSelectedMsg(msg.id);
      setSelectedMessage(null); return;
    }
    if (action === 'edit') {
      useChatStore.getState().openDialog({
        title: 'Edit Message', hasInput: true, inputDefault: msg.text || msg.data?.message || '',
        onConfirm: async (newText) => {
          if (!newText || newText === msg.text) return;
          useChatStore.getState().addMessageEdit(msg.id, { previousText: msg.text || msg.data?.message || '' });
          try {
            const original = await db.messages.get(msg.id);
            if (original) {
              const updated = { ...original, data: { ...original.data, message: newText, edited: true }, edited: true };
              await db.messages.put(updated);
              if (activeDm) setDms(prev => ({ ...prev, [activeDm]: (prev[activeDm] || []).map(m => m.id === msg.id ? updated : m) }));
              else if (activeGroup) setGroupMessages(prev => ({ ...prev, [activeGroup.id]: (prev[activeGroup.id] || []).map(m => m.id === msg.id ? updated : m) }));
            }
          } catch (e) { console.error(e); }
        },
      });
      setSelectedMessage(null); return;
    }
    if (action === 'delete') {
      try {
        await db.messages.delete(msg.id);
        setDeletedMsgs(prev => new Set(prev).add(msg.id));
        if (msg.pubkey === identity.pk) {
          const { finalizeEvent } = await import('nostr-tools');
          const pool = await getAuthenticatedPool(identity);
          const deletionEvent = finalizeEvent({
            kind: 5,
            tags: [['e', msg.id]],
            content: 'Deleted',
          }, identity.sk);
          const results = await Promise.allSettled(pool.publish(generalRelays, deletionEvent));
          const published = results.some((result) => result.status === 'fulfilled');
          setToast({
            type: published ? 'success' : 'error',
            message: published ? 'Deleted for everyone' : 'Deleted locally; relay sync failed',
          });
        } else {
          setToast({ type: 'success', message: 'Deleted locally' });
        }
      } catch (e) {
        console.error('[Chat] Message deletion failed:', e);
        setToast({ type: 'error', message: 'Deleted locally; relay sync failed' });
      }
      setSelectedMessage(null); return;
    }
    if (action === 'pin' && activeGroup) {
      await pinMessage(activeGroup.id, msg.id);
      setToast({ type: 'success', message: 'Pinned' });
      setSelectedMessage(null); return;
    }
    if (action === 'report_scam' || action === 'report') {
      setToast({ type: 'success', message: 'Report submitted' });
      setSelectedMessage(null); return;
    }
    if (action === 'view_vendor') {
      setVendorStorefrontPubkey(msg.pubkey);
      setSelectedMessage(null); return;
    }
    if (action === 'buy_product') {
      setSelectedMessage(null);
      await startOrderWithVendor(msg.pubkey, msg.data || {}, msg.id);
      return;
    }
    if (action === 'broadcast_product') { setBroadcastProduct(msg.data); setSelectedMessage(null); return; }
    if (action === 'edit_product') { setEditingProduct({ msg, product: msg.data }); setSelectedMessage(null); return; }
    if (action === 'mark_sold_out') {
      try {
        const updatedPayload = { ...(msg.data || {}), soldOut: true };
        if (activeGroup) await sendGroupMessage(activeGroup.id, updatedPayload);
        setToast({ type: 'success', message: 'Marked sold out' });
      } catch (e) { setToast({ type: 'error', message: 'Failed' }); }
      setSelectedMessage(null); return;
    }
    // Order actions delegated to handleOrderAction
    if (await handleOrderAction(action, msg)) return;
    setSelectedMessage(null);
  };

  const handleForwardSubmit = async (targetId, isGroup) => {
    if (!forwardingMsg) return;
    const data = forwardingMsg.data || {};
    try {
      if (isGroup) await sendGroupMessage(targetId, data, null, null);
      else await sendDM(targetId, data, null, null);
      setToast({ type: 'success', message: 'Message forwarded!' });
      setForwardingMsg(null);
    } catch (e) {
      console.error('Forward failed:', e);
      setToast({ type: 'error', message: 'Failed to forward message' });
    }
  };

  const handleImageUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    setUploadingImage(true);
    const caption = newMessage;
    setNewMessage('');
    try {
      const urls = [];
      for (const file of files) {
        const compressedFile = await compressImage(file);
        const blob = await uploadToBlossom(compressedFile, { signer: blossomSigner(identity) });
        urls.push(blob.url);
      }
      await sendMessage(caption, false, null, urls);
      setToast({ type: 'success', message: urls.length > 1 ? 'Album sent!' : 'Image sent!' });
    } catch (err) {
      console.error(err);
      setToast({ type: 'error', message: 'Upload failed' });
    } finally {
      setUploadingImage(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!chatMountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mediaRecorder.onstop = async () => {
        if (!chatMountedRef.current) return;
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const file = new File([audioBlob], 'voice_note.webm', { type: 'audio/webm' });
        setUploadingImage(true);
        setToast({ type: 'success', message: 'Uploading voice note...' });
        try {
          const blob = await uploadToBlossom(file, { signer: blossomSigner(identity) });
          await sendMessage('', false, blob.url);
          setToast({ type: 'success', message: 'Voice note sent!' });
        } catch (err) {
          console.error(err);
          setToast({ type: 'error', message: 'Voice upload failed' });
        } finally {
          if (chatMountedRef.current) setUploadingImage(false);
        }
      };
      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error(err);
      if (chatMountedRef.current) setToast({ type: 'error', message: 'Microphone access denied' });
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      mediaRecorderRef.current = null;
      setIsRecording(false);
    }
  };

  const updateLocalOrder = (peerPubkey, orderId, updateData) => {
    useChatStore.getState().setDms(prev => {
      const msgs = prev[peerPubkey] || [];
      const updated = msgs.map(m => m.id === orderId ? { ...m, data: { ...m.data, ...updateData } } : m);
      return { ...prev, [peerPubkey]: updated };
    });
  };

  const handleSaveEditedProduct = async (updatedProduct) => {
    if (!editingProduct) return;
    try {
      const { msg } = editingProduct;
      const payload = {
        type: 'product', title: updatedProduct.title, priceUsd: updatedProduct.priceUsd,
        image: updatedProduct.image, description: updatedProduct.description, updatedFrom: msg.id,
      };
      if (msg.isGroup && activeGroup) await sendGroupMessage(activeGroup.id, payload);
      else if (activeDm) await sendDM(activeDm, payload);
      setToast({ type: 'success', message: 'Product updated!' });
      setEditingProduct(null);
    } catch (e) {
      setToast({ type: 'error', message: 'Failed to update product' });
    }
  };

  const sendMessage = async (text, isImage = false, audioUrl = null, imageUrls = null, customPayload = null) => {
    if (!text.trim() && !audioUrl && !customPayload && !imageUrls) return;
    haptic('light');
    const tempId = `temp-${Date.now()}`;
    let msgPayload = { type: 'text', message: text };
    if (isImage) msgPayload = { type: 'image', url: text, metadata_stripped: true };
    if (audioUrl) msgPayload = { type: 'audio', url: audioUrl };
    if (imageUrls) msgPayload = { type: 'album', urls: imageUrls, message: text };
    if (customPayload) msgPayload = customPayload;
    const _chatIdForTimer = (view === 'dm' ? activeDm : activeGroup?.id);
    const _timerStr = useChatStore.getState().disappearingTimers?.[_chatIdForTimer];
    const _secs = (() => {
      if (!_timerStr || _timerStr === 'off') return 0;
      if (_timerStr.endsWith('m')) return parseInt(_timerStr) * 60 || 0;
      if (_timerStr === '1h') return 3600;
      if (_timerStr === '24h') return 86400;
      if (_timerStr === '7d') return 604800;
      return 0;
    })();
    if (_secs > 0 && !msgPayload.expires_at) msgPayload.expires_at = Math.floor(Date.now() / 1000) + _secs;
    const replyId = replyingTo ? replyingTo.id : null;
    const isDmView = view === 'dm';
    const chatId = isDmView ? activeDm : activeGroup?.id;
    const newMsg = {
      id: tempId, clientId: tempId, isSender: true, pubkey: identity.pk,
      timestamp: Math.floor(Date.now() / 1000), local_timestamp: Date.now(), replyTo: replyId,
      deliveryStatus: 'sending',
    };
    if (isDmView && activeDm) {
      newMsg.data = msgPayload;
      newMsg.isGroup = false;
      setDms(prev => {
        const messages = prev[activeDm] || [];
        if (messages.some((message) => message.id === tempId || message.clientId === tempId)) return prev;
        return { ...prev, [activeDm]: [...messages, newMsg].sort(sortMessages) };
      });
    } else if (activeGroup) {
      newMsg.rawContent = JSON.stringify(msgPayload);
      newMsg.isGroup = true;
      useChatStore.getState().setGroupMessages(prev => {
        const msgs = prev[activeGroup.id] || [];
        if (msgs.some((message) => message.id === tempId || message.clientId === tempId)) return prev;
        return { ...prev, [activeGroup.id]: [...msgs, newMsg] };
      });
      await saveMessage(activeGroup.id, newMsg);
      const result = await sendGroupMessage(activeGroup.id, msgPayload, tempId, replyId);
      if (!result.success) {
        useChatStore.getState().setGroupMessages(prev => ({
          ...prev,
          [activeGroup.id]: (prev[activeGroup.id] || []).filter((message) => message.id !== tempId && message.clientId !== tempId),
        }));
        try {
          await db.messages.delete(tempId);
        } catch (error) {
          console.error('[Chat] Failed to remove unsent group message:', error);
        }
        if (result.error === 'NO_KEY') setToast({ type: 'error', message: 'Securing group... please try again in a moment.' });
        else setToast({ type: 'error', message: 'Failed to send to group' });
      } else if (result.event?.id) {
        const outboxEntry = result.queued ? await db.outbox.get(result.event.id) : null;
        const deliveryStatus = result.queued && outboxEntry ? 'queued' : 'sent';
        let confirmedMessage;
        useChatStore.getState().setGroupMessages(prev => ({
          ...prev,
          [activeGroup.id]: (prev[activeGroup.id] || []).map((message) => {
            if (message.clientId !== tempId) return message;
            confirmedMessage = {
              ...message,
              id: result.event.id,
              timestamp: result.event.created_at,
              deliveryStatus,
            };
            return confirmedMessage;
          }),
        }));
        await saveMessage(activeGroup.id, confirmedMessage || {
          ...newMsg,
          id: result.event.id,
          timestamp: result.event.created_at,
          deliveryStatus,
        });
      }
    }
    if (isDmView && activeDm) await saveMessage(activeDm, newMsg);
    setReplyingTo(null);
    if (activeDm) scopedRemove(`draft-dm-${activeDm}`);
    if (activeGroup) scopedRemove(`draft-group-${activeGroup.id}`);
    if (activeDm) {
      const result = await sendDM(activeDm, msgPayload, tempId, replyId);
      if (!result.success) {
        setDms(prev => ({
          ...prev,
          [activeDm]: (prev[activeDm] || []).filter((message) => message.id !== tempId && message.clientId !== tempId),
        }));
        try {
          await db.messages.delete(tempId);
        } catch (error) {
          console.error('[Chat] Failed to remove unsent direct message:', error);
        }
        setToast({ type: 'error', message: 'Failed to send: ' + (result.error || 'unknown') });
      } else if (result.event?.id) {
        const outboxEntry = result.queued ? await db.outbox.get(result.event.id) : null;
        const deliveryStatus = result.queued && outboxEntry ? 'queued' : 'sent';
        let confirmedMessage;
        setDms(prev => ({
          ...prev,
          [activeDm]: (prev[activeDm] || []).map((message) => {
            if (message.clientId !== tempId) return message;
            confirmedMessage = {
              ...message,
              id: result.event.id,
              timestamp: result.event.created_at,
              deliveryStatus,
            };
            return confirmedMessage;
          }),
        }));
        await saveMessage(activeDm, confirmedMessage || {
          ...newMsg,
          id: result.event.id,
          timestamp: result.event.created_at,
          deliveryStatus,
        });
      }
    }
  };

  const handlePostListing = async (listingData) => {
    const state = useChatStore.getState();
    if (!state.postListingGroup) return;
    const payload = {
      type: 'product', title: listingData.title, priceUsd: listingData.priceUsd,
      image: listingData.image, description: listingData.description,
      dropUntil: listingData.dropUntil || null, stock: listingData.stock || null,
    };
    const res = await sendGroupMessage(state.postListingGroup.id, payload);
    if (res.success) setToast({ type: 'success', message: 'Listing posted to group!' });
    else setToast({ type: 'error', message: 'Failed to post listing' });
  };

  const handleBroadcastSubmit = async (groupIds, product) => {
    const payload = {
      type: 'product',
      title: product.title || product.name,
      priceUsd: product.priceUsd || product.price,
      currency: product.currency,
      image: product.image,
      description: product.description,
    };
    const results = await Promise.allSettled([...new Set(groupIds)].map((groupId) => sendGroupMessage(groupId, payload)));
    const delivered = results.filter((result) => result.status === 'fulfilled' && result.value?.success && !result.value.queued).length;
    const queued = results.filter((result) => result.status === 'fulfilled' && result.value?.success && result.value.queued).length;
    const failed = results.length - delivered - queued;
    results.forEach((result, index) => {
      if (result.status === 'rejected') console.error(`[broadcast] Failed to post to ${groupIds[index]}:`, result.reason);
      else if (!result.value?.success) console.error(`[broadcast] Failed to post to ${groupIds[index]}:`, result.value?.error);
    });
    setToast({
      type: failed ? 'error' : 'success',
      message: `Posted to ${delivered}; queued ${queued}; failed ${failed}.`,
    });
    setBroadcastProduct(null);
  };

  const ToastUI = () => toast && (
    <div className="fixed top-safe left-1/2 -translate-x-1/2 z-[200] bg-surfaceLight border border-white/10 px-5 py-3 rounded-2xl shadow-2xl animate-slide-up flex items-center gap-3">
      <div className={`w-2 h-2 rounded-full ${toast.type === 'error' ? 'bg-red-500' : 'bg-green-500'}`} />
      <span className="text-sm font-semibold text-white">{toast.message}</span>
    </div>
  );

  const handleBulkForward = () => {
    const selectedIds = useChatStore.getState().selectedMsgs;
    if (selectedIds.length === 0) return;
    setToast({ type: 'info', message: 'Select a chat to forward ' + selectedIds.length + ' messages' });
    const firstId = selectedIds[0];
    const msgs = activeDm ? (dms[activeDm] || []) : (groupMessages[activeGroup?.id] || []);
    const msg = msgs.find(m => m.id === firstId);
    if (msg) {
      setForwardingMsg({ data: msg.data || { type: 'text', message: msg.rawContent }, originalSenderName: 'You', id: msg.id });
    }
    useChatStore.getState().clearSelection();
  };

  const handleBulkDelete = () => {
    const selectedIds = useChatStore.getState().selectedMsgs;
    if (selectedIds.length === 0) return;
    useChatStore.getState().openDialog({
      title: 'Delete Messages',
      message: `Delete ${selectedIds.length} message${selectedIds.length !== 1 ? 's' : ''}? This cannot be undone.`,
      type: 'danger', confirmText: 'Delete',
      onConfirm: async () => {
        const chatId = activeDm || activeGroup?.id;
        if (!chatId) return;
        for (const id of selectedIds) await db.messages.delete(id);
        useChatStore.getState().setDeletedMsgs(new Set([...useChatStore.getState().deletedMsgs, ...selectedIds]));
        useChatStore.getState().clearSelection();
        setToast({ type: 'success', message: 'Messages deleted' });
      },
    });
  };

  const markAsRead = async (chatId) => {
    try {
      await db.chatReads.put({ chatId, lastRead: Math.floor(Date.now() / 1000) });
      setUnreadCounts(prev => ({ ...prev, [chatId]: 0 }));
    } catch {}
  };

  const openChat = (type, id, groupObj = null) => {
    markAsRead(id);
    setTypingUsers({});
    setGroupTypingUsers({});
    if (type === 'dm') {
      setActiveDm(id); setActiveGroup(null); setView('dm');
    } else {
      setActiveGroup(groupObj); setActiveDm(null); setView('group');
    }
  };

  const requestToJoinGroup = async (groupId, groupName, groupCreator) => {
    if (!groupCreator) return joinGroupById(groupId, groupName);
    const payload = {
      type: 'join_request', groupId, groupName,
      requester: identity.pk,
      requesterName: profiles[identity.pk]?.displayName || identity.pk.slice(0, 8)
    };
    await sendDM(groupCreator, payload);
    setToast({ type: 'success', message: "Join request sent to admin. You will be notified when approved." });
    useChatStore.getState().addJoinRequest(groupId, identity.pk);
  };

  const joinGroupById = async (groupId, passedName = null, channel = false) => {
    if (!groupId) return;
    setLoading(true);
    let realName = passedName || 'Unnamed Group';
    try {
      const localGroups = getMyGroups(identity.pk);
      const localMatch = localGroups.find(g => g.id === groupId);
      let isChannel = !!(channel || localMatch?.isChannel);
      if (!passedName && localMatch && localMatch.name && localMatch.name !== 'Unnamed Group') {
        realName = localMatch.name;
      } else if (!passedName) {
        try {
          const pool = await getAuthenticatedPool(identity);
          const events = await queryWithTimeout(pool, groupRelays, { kinds: [9002], limit: 200 }, 3000);
          const match = events.find(ev => ev.tags.find(t => t[0] === 'h')?.[1] === groupId);
          if (match) {
            const nameTag = match.tags.find(t => t[0] === 'name')?.[1];
            if (nameTag) realName = nameTag;
            isChannel = match.tags.some((tag) => tag[0] === 'channel' || tag[0] === 'broadcast');
          }
        } catch (e) {}
      }
      if (realName === 'Unnamed Group') {
        const userInput = window.prompt("What is this group called?", "");
        if (userInput && userInput.trim()) realName = userInput.trim();
      }
      const newGroupObj = { id: groupId, name: realName, isChannel, creator: '' };
      const existingGroups = getMyGroups(identity.pk);
      if (!existingGroups.find(g => g.id === newGroupObj.id)) setMyGroups(identity.pk, [...existingGroups, newGroupObj]);
      const idx = localGroups.findIndex(g => g.id === groupId);
      if (idx === -1) localGroups.push(newGroupObj);
      else localGroups[idx].name = realName;
      setMyGroups(identity.pk, localGroups);
      setGroups(prev => [newGroupObj, ...(prev || []).filter(g => g.id !== groupId)]);
      openChat('group', groupId, newGroupObj);
      setToast({ type: 'success', message: 'Joined group' });
    } catch (err) {
      console.error('[joinGroupById] error:', err);
    } finally {
      setLoading(false);
      if (window.location.search.length > 0) window.history.replaceState({}, document.title, window.location.pathname);
    }
  };

  const fetchGroups = async () => {
    try {
      const pool = await getAuthenticatedPool(identity);
      const events = await queryWithTimeout(pool, groupRelays, { kinds: [39000, 9002], limit: 200 });
      const parsed = events.map(ev => {
        const tag = (n) => ev.tags.find((t) => t[0] === n)?.[1];
        const id = tag('d') || tag('h') || ev.id;
        return {
          id,
          name: tag('name') || id,
          about: tag('about') || '',
          isChannel: !!(tag('channel') || tag('broadcast')),
          kind: 'group',
          raw: ev,
        };
      });
      const uniqueGroups = Array.from(new Map(parsed.map(g => [g.id, g])).values());
      const localGroups = getMyGroups(identity.pk);
      const allGroups = [...uniqueGroups];
      localGroups.forEach(lg => {
        if (!allGroups.find(g => g.id === lg.id)) allGroups.push(lg);
      });
      setGroups(allGroups);
      return allGroups;
    } catch (e) { 
      console.error("[fetchGroups] failed:", e); 
      return []; 
    }
  };

  const createGroup = async (e) => {
    if (e) e.preventDefault();
    const state = useChatStore.getState();
    if (!state.newGroupName.trim()) return;
    const gName = state.newGroupName;
    const gAbout = state.newGroupAbout;
    const gChannel = state.isChannel;
    state.setShowCreateGroup(false);
    state.setShowMenu(false);
    state.setNewGroupName(""); 
    state.setNewGroupAbout(""); 
    state.setIsChannel(false);
    try {
      const group = await createGroupHook(gName.trim(), gAbout.trim(), gChannel);
      if (group) openChat('group', group.id, group);
      setToast({ type: 'success', message: 'Group created!' });
    } catch (err) { 
      console.error("[createGroup] FAILED:", err); 
      state.setShowCreateGroup(true);
      state.setNewGroupName(gName);
      state.setNewGroupAbout(gAbout);
      state.setIsChannel(gChannel);
      setToast({ type: 'error', message: 'Failed to create group' });
    }
  };

  const handleGlobalSearch = async (query) => {
    if (!query.trim()) return;
    const results = [];
    const state = useChatStore.getState();
    Object.entries(state.dms).forEach(([pubkey, msgs]) => {
      msgs.forEach(msg => {
        const text = msg.data?.message || '';
        if (text.toLowerCase().includes(query.toLowerCase())) {
          results.push({ type: 'dm', pubkey, msg, name: state.profiles[pubkey]?.displayName || pubkey.slice(0, 8), text });
        }
      });
    });
    Object.entries(state.groupMessages).forEach(([groupId, msgs]) => {
      msgs.forEach(msg => {
        try {
          const parsed = JSON.parse(msg.rawContent || '{}');
          if ((parsed.message || '').toLowerCase().includes(query.toLowerCase())) {
            const group = state.groups.find(g => g.id === groupId);
            results.push({ type: 'group', groupId, msg, name: group?.name || groupId.slice(0, 8), text: parsed.message });
          }
        } catch (e) {}
      });
    });
    setToast({ type: 'info', message: `Found ${results.length} results for "${query}"` });
    useChatStore.getState().setSearchResults(results);
    setView('search');
  };

  const handleSearch = async () => {
    const state = useChatStore.getState();
    if (!state.searchQuery.trim()) return;
    state.setIsSearching(true);
    state.setSearchResults([]);
    let rawQuery = state.searchQuery.trim();

    try {
      if (rawQuery.startsWith('http')) {
        const url = new URL(rawQuery);
        const gp = url.searchParams.get('group');
        const np = url.searchParams.get('naddr');
        if (gp) { rawQuery = gp; } 
        else if (np) {
          const { nip19 } = await import('nostr-tools');
          const d = nip19.decode(np);
          if (d.type === 'naddr') rawQuery = d.data.identifier;
        }
      }
    } catch (e) {}

    if (rawQuery.startsWith('@')) {
      const usernameToFind = rawQuery.slice(1).toLowerCase().trim();
      console.log('🔍 [Search] Looking for username:', usernameToFind);
      
      try {
        const pool = await getAuthenticatedPool(identity);

        // 1. INSTANT LOCAL CHECK (Vaults)
        const vaults = JSON.parse(localStorage.getItem('cipher_vaults') || '{}');
        for (const [pk, data] of Object.entries(vaults)) {
          const h = (data.handle || '').toLowerCase();
          const dn = (data.displayName || '').toLowerCase();
          if (h === usernameToFind || dn === usernameToFind) {
            console.log('✅ [Search] Found in local vaults:', pk);
            state.setSearchResults([{ type: 'user', pubkey: pk, name: '@' + (data.handle || usernameToFind), picture: null }]);
            state.setIsSearching(false);
            return;
          }
        }

        // 2. CIPHER REGISTRY (kind 10003)
        const regEvents = await queryWithTimeout(pool, ['wss://groups.aegispayhq.com'], { kinds: [10003], limit: 500 }, 4000);
        const regMatches = regEvents.filter(ev => {
          const usernameTag = ev.tags.find(t => t[0] === 'username')?.[1];
          const tTag = ev.tags.find(t => t[0] === 't' && t[1] === 'cipher_username_' + usernameToFind);
          return usernameTag === usernameToFind || tTag;
        });
        if (regMatches.length > 0) {
          console.log('✅ [Search] Found in Cipher Registry');
          state.setSearchResults([{ type: 'user', pubkey: regMatches[0].pubkey, name: '@' + usernameToFind, picture: null }]);
          state.setIsSearching(false);
          return;
        }

        // 3. VERTEX DVM SEARCH
        let dvmPool;
        try {
          const { finalizeEvent } = await import('nostr-tools');
          dvmPool = new SimplePool();
          const requestEvent = finalizeEvent({
            kind: 5315, created_at: Math.floor(Date.now() / 1000),
            tags: [['param', 'search', usernameToFind], ['param', 'limit', '10']], content: ''
          }, identity.sk);
          await Promise.allSettled(dvmPool.publish(['wss://groups.aegispayhq.com'], requestEvent));
          
          const responseEvents = await Promise.race([
            dvmPool.querySync(['wss://groups.aegispayhq.com'], { kinds: [6315], '#e': [requestEvent.id] }),
            new Promise(resolve => setTimeout(() => resolve([]), 3500))
          ]);

          if (false && responseEvents.length > 0) {
            const pubkeys = JSON.parse(responseEvents[0].content).map(p => p.pubkey);
            if (pubkeys.length > 0) {
              const profileEvents = await pool.querySync(['wss://groups.aegispayhq.com'], { kinds: [0], authors: pubkeys });
              const profiles = profileEvents.map(ev => {
                const data = JSON.parse(ev.content);
                return { type: 'user', pubkey: ev.pubkey, name: data.display_name || data.name || ev.pubkey.slice(0, 8), picture: data.picture };
              });
              if (profiles.length > 0) {
                console.log('✅ [Search] Found via Vertex DVM');
                state.setSearchResults(profiles);
                state.setIsSearching(false);
                return;
              }
            }
          }
        } catch (e) {
          console.warn('Vertex DVM error:', e);
        } finally {
          dvmPool?.destroy();
        }

        // 4. NIP-50 FALLBACK (With strict filtering to kill random people)
        console.log('🔍 [Search] Querying NIP-50 fallback...');
        const publicSearchRelays = ['wss://groups.aegispayhq.com'];
        const events = await Promise.race([
          pool.querySync(publicSearchRelays, { kinds: [0], search: usernameToFind, limit: 100 }),
          new Promise(resolve => setTimeout(() => resolve([]), 4000))
        ]);
        
        if (events.length > 0) {
          // THE FIX: Filter out the trash (like Retardino)
          const profiles = events.map(ev => {
            try {
              const d = JSON.parse(ev.content);
              const n = (d.name || '').toLowerCase();
              const dn = (d.display_name || '').toLowerCase();
              const nip05 = (d.nip05 || '').toLowerCase().split('@')[0];
              
              // Only include if the search term actually matches their name/username
              if (n.includes(usernameToFind) || dn.includes(usernameToFind) || nip05.includes(usernameToFind)) {
                return { type: 'user', pubkey: ev.pubkey, name: d.display_name || d.name || ev.pubkey.slice(0, 8), picture: d.picture };
              }
              return null;
            } catch { return null; }
          }).filter(Boolean);

          if (profiles.length > 0) {
            console.log('✅ [Search] Found via NIP-50 with strict filter');
            state.setSearchResults(profiles);
            state.setIsSearching(false);
            return;
          }
        }

        console.log('❌ [Search] Exhausted all methods. Not found.');
        state.setSearchResults([]);
        setToast({ type: 'error', message: '@' + usernameToFind + ' not found.' });

      } catch (err) {
        console.error("Username search failed:", err);
        state.setSearchResults([]);
        setToast({ type: 'error', message: 'Search failed: ' + err.message });
      } finally {
        state.setIsSearching(false);
      }
      return;
    }

    rawQuery = rawQuery.replace(/^@/, '');
    if (/^[0-9a-f]{64,}$/i.test(rawQuery)) rawQuery = rawQuery.slice(0, 64);
    if (rawQuery.length >= 12 && rawQuery.length <= 20 && /^[a-z0-9_-]+$/i.test(rawQuery) && !rawQuery.includes(' ')) {
      state.setSearchResults([{ type: 'group', id: rawQuery, name: 'Group ' + rawQuery, isChannel: false, creator: '' }]);
      state.setIsSearching(false);
      return;
    }

    const isNpub = rawQuery.startsWith('npub1');
    const isHex = /^[0-9a-f]{64}$/i.test(rawQuery);
    const isPartialHex = /^[0-9a-f]{10,63}$/i.test(rawQuery);
    const isNip05 = rawQuery.includes('@');

    if (isPartialHex) {
      setToast({ type: 'error', message: "Hex public keys must be exactly 64 characters." });
      state.setIsSearching(false); return;
    }
    
    let pool;
    try {
      const { SimplePool, nip19 } = await import('nostr-tools');
      pool = new SimplePool({ enablePing: true, enableReconnect: true });

      const localMatches = await db.profiles.filter(p => 
        (p.name && p.name.toLowerCase().includes(rawQuery.toLowerCase())) || 
        (p.displayName && p.displayName.toLowerCase().includes(rawQuery.toLowerCase()))
      ).toArray();

      if (localMatches.length > 0) {
        state.setSearchResults(localMatches.map(p => ({ type: 'user', pubkey: p.pubkey, name: p.displayName, picture: p.picture })));
        state.setIsSearching(false); return;
      }

      if (isNip05 && !isNpub) {
        const [name, domain] = rawQuery.split('@');
        try {
          const res = await fetch(`https://${domain}/.well-known/nostr.json?name=${name}`);
          const data = await res.json();
          const targetPubkey = data.names?.[name];
          if (targetPubkey) {
            state.setSearchResults([{ type: 'user', pubkey: targetPubkey, name, picture: null }]);
            state.setIsSearching(false); return;
          }
        } catch (e) {}
      }

      if (isNpub || isHex) {
        let targetPubkey = rawQuery;
        if (isNpub) {
          const decoded = nip19.decode(rawQuery);
          targetPubkey = decoded.data;
          if (typeof targetPubkey !== 'string') {
            targetPubkey = Array.from(targetPubkey).map(b => b.toString(16).padStart(2, '0')).join('');
          }
        }
        state.setSearchResults([{ type: 'user', pubkey: targetPubkey, name: targetPubkey.slice(0, 8), picture: null }]);
        
        const profileEvents = await queryWithTimeout(pool, ['wss://groups.aegispayhq.com'], { kinds: [0], authors: [targetPubkey] }, 4000);

        if (profileEvents.length > 0) {
          try {
            const p = JSON.parse(profileEvents[0].content);
            state.setSearchResults([{ 
              type: 'user', pubkey: targetPubkey, 
              name: p.display_name || p.name || targetPubkey.slice(0, 8), 
              picture: p.picture 
            }]);
          } catch (e) {}
        }
        state.setIsSearching(false); return;
      }

      // --- VERTEX DVM PROFILE SEARCH ---
      let dvmPool;
      try {
        const { finalizeEvent } = await import('nostr-tools');
        dvmPool = new SimplePool();
        const requestEvent = finalizeEvent({
          kind: 5315,
          created_at: Math.floor(Date.now() / 1000),
          tags: [['param', 'search', rawQuery], ['param', 'limit', '10']],
          content: ''
        }, identity.sk);

        await Promise.allSettled(dvmPool.publish(['wss://groups.aegispayhq.com'], requestEvent));

        const responseEvents = await Promise.race([
          dvmPool.querySync(['wss://groups.aegispayhq.com'], { kinds: [6315], '#e': [requestEvent.id] }),
          new Promise(resolve => setTimeout(() => resolve([]), 4000))
        ]);

        if (false && responseEvents.length > 0) {
          const responseEvent = responseEvents[0];
          const pubkeys = JSON.parse(responseEvent.content).map(p => p.pubkey);
          
          if (pubkeys.length > 0) {
            const profileEvents = await pool.querySync(['wss://groups.aegispayhq.com'], { kinds: [0], authors: pubkeys });
            const profiles = profileEvents.map(ev => {
              const data = JSON.parse(ev.content);
              return { type: 'user', pubkey: ev.pubkey, name: data.display_name || data.name || ev.pubkey.slice(0, 8), picture: data.picture };
            });
            state.setSearchResults(profiles);
            state.setIsSearching(false);
            return;
          }
        }
      } catch (dvmError) {
        console.warn("Vertex DVM search failed, falling back to NIP-50...", dvmError);
      } finally {
        dvmPool?.destroy();
      }

      const publicSearchRelays = ['wss://groups.aegispayhq.com'];
      const events = await Promise.race([
        Promise.all([
          pool.querySync(publicSearchRelays, { kinds: [0, 41], search: rawQuery, limit: 30 }),
          pool.querySync(['wss://groups.aegispayhq.com'], { kinds: [9002], limit: 200 })
        ]).then(res => [...res[0], ...res[1]]),
        new Promise(resolve => setTimeout(() => resolve([]), 4000))
      ]);

      const matchedProfiles = [];
      const matchedGroups = [];

      events.forEach(ev => {
        if (ev.kind === 0) {
          try {
            const d = JSON.parse(ev.content);
            matchedProfiles.push({ type: 'user', pubkey: ev.pubkey, name: d.display_name || d.name || ev.pubkey.slice(0, 8), picture: d.picture });
          } catch (e) {}
        } else if (ev.kind === 41) {
          try {
            const d = JSON.parse(ev.content);
            matchedGroups.push({ type: 'group', id: ev.tags.find(t => t[0] === 'd')?.[1], name: d.name, isChannel: d.isChannel, creator: ev.pubkey });
          } catch (e) {}
        } else if (ev.kind === 39000 || ev.kind === 9002) {
          const getTag = (t) => ev.tags.find(x => x[0] === t)?.[1];
          const groupId = getTag('h') || getTag('d');
          const groupName = getTag('name');
          if (groupId && groupName && groupName.toLowerCase().includes(rawQuery.toLowerCase())) {
            matchedGroups.push({
              type: 'group',
              id: groupId,
              name: groupName,
              isChannel: ev.tags.some((tag) => tag[0] === 'channel' || tag[0] === 'broadcast'),
              creator: ev.pubkey,
            });
          }
        }
      });

      const uniqueUsers = Array.from(new Map(matchedProfiles.map(p => [p.pubkey, p])).values());
      const uniqueGroups = Array.from(new Map(matchedGroups.map(g => [g.id, g])).values());
      state.setSearchResults([...uniqueUsers.slice(0, 10), ...uniqueGroups.slice(0, 10)]);
    } catch (err) { 
      console.error("Search failed entirely:", err); 
    } finally { 
      pool?.destroy();
      state.setIsSearching(false); 
    }
  };

  if (loading) {
    return (
      <div className="p-4 h-full animate-fade-in">
        <div className="flex justify-between items-center mb-6 px-2">
          <div className="h-8 w-24 bg-surfaceLight rounded-lg animate-pulse" />
          <div className="flex gap-2">
            <div className="h-8 w-8 bg-surfaceLight rounded-full animate-pulse" />
            <div className="h-8 w-8 bg-surfaceLight rounded-full animate-pulse" />
          </div>
        </div>
        <div className="space-y-3">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="bg-surface p-4 rounded-2xl border border-white/5 flex items-center gap-4">
              <div className="w-12 h-12 rounded-full bg-surfaceLight animate-pulse shrink-0" />
              <div className="flex-1 space-y-2">
                <div className="h-4 bg-surfaceLight rounded animate-pulse w-1/3" />
                <div className="h-3 bg-surfaceLight rounded animate-pulse w-1/2" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (view === 'list') {
    return (
      <motion.div initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} transition={{ duration: 0.2 }} className="flex-1 overflow-y-auto min-h-0 p-4 pb-24 relative">
        <ToastUI />
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-3">
            <Logo size={28} />
            <h2 className="text-2xl font-black tracking-tighter text-white">Cipher</h2>
          </div>
          <div className="flex gap-1">
            <button onClick={() => setShowBookmarks(true)} className="p-2 text-white/50 hover:text-white transition-colors"><Bookmark size={20}/></button>
            <button onClick={() => setShowNotifCenter(true)} className="p-2 text-white/50 hover:text-white transition-colors" aria-label="Notifications"><Bell size={20}/></button>
            <button onClick={() => setShowQRScanner(true)} className="p-2 text-white/50 hover:text-white transition-colors" aria-label="Scan QR code"><QrCode size={20}/></button>
            <button onClick={fetchChats} className="p-2 text-white/50 hover:text-white transition-colors"><RefreshCw size={20}/></button>
            <button onClick={() => setView('search')} className="p-2 text-white/50 hover:text-white transition-colors"><Search size={20}/></button>
          </div>
        </div>

        <ChatList onOpenChat={openChat} />

        <CreateGroupModal isOpen={showCreateGroup} onClose={() => setShowCreateGroup(false)} createGroup={createGroup} />
        <FloatingMenu /><MyProfileModal identity={identity} />
        {showBookmarks && <BookmarksViewer onClose={() => setShowBookmarks(false)} />}
        {showNotifCenter && <NotificationCenter onClose={() => setShowNotifCenter(false)} onJump={(type, id) => {
          if (type === 'group') {
            const group = groups.find((item) => item.id === id);
            if (group) openChat('group', id, group);
          } else {
            openChat('dm', id);
          }
        }} />}
        {showQRScanner && <QRScanner onClose={() => setShowQRScanner(false)} />}
      </motion.div>
    )
  }

  if (view === 'search' && searchResults.length > 0 && searchResults[0]?.msg) {
    return <MessageSearchResults identity={identity} setView={setView} openChat={openChat} />;
  }

  if (view === 'search') {
    return <SearchView ToastUI={ToastUI} handleSearch={handleSearch} joinGroupById={joinGroupById} openChat={openChat} />;
  }

  if (view === 'dm' && activeDm) {
    return (
      <>
        <Suspense fallback={<div className="flex h-full items-center justify-center bg-black"><div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-blue-500" /></div>}>
        <DmView identity={identity} sendMessage={sendMessage} handleMessageAction={handleMessageAction} handleImageUpload={handleImageUpload} startRecording={startRecording} stopRecording={stopRecording} handleForwardSubmit={handleForwardSubmit} />
        {profilePubkey && <ProfileModal pubkey={profilePubkey} identity={identity} onClose={() => setProfilePubkey(null)} onMessage={(pubkey) => { setProfilePubkey(null); openChat('dm', pubkey); }} />}
        {showBookmarks && <BookmarksViewer onClose={() => setShowBookmarks(false)} onJump={(chatId, msgId, isGroup) => {
            if (isGroup) { const g = groups.find(x => x.id === chatId); if (g) openChat('group', chatId, g); } else { openChat('dm', chatId); }
            setTimeout(() => { const el = document.getElementById(`msg-${msgId}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 500);
          }} />}
        {showNotifCenter && <NotificationCenter onClose={() => setShowNotifCenter(false)} onJump={(type, id) => {
            if (type === 'group') { const g = groups.find(x => x.id === id); if (g) openChat('group', id, g); } else { openChat('dm', id); }
          }} />}
        {showQRScanner && <QRScanner onClose={() => setShowQRScanner(false)} />}
        <BroadcastModal isOpen={!!broadcastProduct} onClose={() => setBroadcastProduct(null)} product={broadcastProduct} groups={groups} onBroadcast={handleBroadcastSubmit} />
        <ProductEditModal editingProduct={editingProduct} onClose={() => setEditingProduct(null)} onSubmit={handleSaveEditedProduct} identity={identity} />
        <VendorStorefront isOpen={!!vendorStorefrontPubkey} onClose={() => setVendorStorefrontPubkey(null)} vendorPubkey={vendorStorefrontPubkey} profiles={profiles} identity={identity} onOpenChat={(pk) => openChat('dm', pk)} onBuy={(product, vendorPubkey) => startOrderWithVendor(vendorPubkey, product, product.id)} />
        </Suspense>
      </>
    );
  }

  if (view === 'group' && activeGroup) {
    return (
      <>
        <Suspense fallback={<div className="flex h-full items-center justify-center bg-black"><div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-blue-500" /></div>}>
        <GroupView identity={identity} sendMessage={sendMessage} handleMessageAction={handleMessageAction} handleImageUpload={handleImageUpload} startRecording={startRecording} stopRecording={stopRecording} handleForwardSubmit={handleForwardSubmit} fetchGroupMembers={fetchGroupMembers} fetchPinnedMessage={fetchPinnedMessage} pinMessage={pinMessage} unpinMessage={unpinMessage} />
        {profilePubkey && <ProfileModal pubkey={profilePubkey} identity={identity} onClose={() => setProfilePubkey(null)} onMessage={(pubkey) => { setProfilePubkey(null); openChat('dm', pubkey); }} />}
        {showBookmarks && <BookmarksViewer onClose={() => setShowBookmarks(false)} onJump={(chatId, msgId, isGroup) => {
            if (isGroup) { const g = groups.find(x => x.id === chatId); if (g) openChat('group', chatId, g); } else { openChat('dm', chatId); }
            setTimeout(() => { const el = document.getElementById(`msg-${msgId}`); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }, 500);
          }} />}
        {showNotifCenter && <NotificationCenter onClose={() => setShowNotifCenter(false)} onJump={(type, id) => {
            if (type === 'group') { const g = groups.find(x => x.id === id); if (g) openChat('group', id, g); } else { openChat('dm', id); }
          }} />}
        {showQRScanner && <QRScanner onClose={() => setShowQRScanner(false)} />}
        <BroadcastModal isOpen={!!broadcastProduct} onClose={() => setBroadcastProduct(null)} product={broadcastProduct} groups={groups} onBroadcast={handleBroadcastSubmit} />
        <ProductEditModal editingProduct={editingProduct} onClose={() => setEditingProduct(null)} onSubmit={handleSaveEditedProduct} identity={identity} />
        <VendorStorefront isOpen={!!vendorStorefrontPubkey} onClose={() => setVendorStorefrontPubkey(null)} vendorPubkey={vendorStorefrontPubkey} profiles={profiles} identity={identity} onOpenChat={(pk) => openChat('dm', pk)} onBuy={(product, vendorPubkey) => startOrderWithVendor(vendorPubkey, product, product.id)} />
        </Suspense>
      </>
    );
  }

  return null;
}
