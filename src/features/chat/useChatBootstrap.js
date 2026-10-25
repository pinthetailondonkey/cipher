import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { db, saveMessage, openDBFor } from '../../db';
import { getMyGroups } from '../../lib/myGroups';
import { mergeReactions } from '../../lib/reactions';
import { generalRelays, groupRelays, queryAllPages, queryWithTimeout } from '../../lib/relays';
import { getAuthenticatedPool } from '../../lib/pool';
import { useChatStore } from '../../store/chatStore';
import { scopedGet, scopedSet } from '../../lib/storage';
import { getPrivacy, allowsTyping } from '../../lib/privacy';
import { decodeGroupEvent } from '../../lib/crypto/groupMessageCodec';
import { resumeKeyRequestIds } from '../../lib/crypto/groupKeyRequest';
import { useGroupKeyReconciler } from '../../hooks/useGroupKeyReconciler';
import { flushSecuringGroupSends } from '../../hooks/useNIP29Group';
import { bindMemberBaselinePublisher, sealMemberBaseline } from '../../lib/crypto/memberBaseline';
import { activeUrl, entryById } from '../../lib/egress';
import { isNativeShell, registerWithGateway, subscribeBrowser, subscribeNative } from '../../lib/pushGateway';

export function useChatBootstrap({
  identity,
  fetchDMs,
  subscribeToDMs,
  subscribeToGroups,
  subscribeToGroupReactions,
  sendTypingIndicator,
  sendDM,
  sendGroupTypingIndicator,
  fetchGroupMembers,
  setGroups,
  fetchGroups,
  joinGroupById,
}) {
  const groups = useChatStore((s) => s.groups);
  const groupMessages = useChatStore((s) => s.groupMessages);
  const setGroupMessages = useChatStore((s) => s.setGroupMessages);
  const setDms = useChatStore((s) => s.setDms);
  const setProfiles = useChatStore((s) => s.setProfiles);
  const setLoading = useChatStore((s) => s.setLoading);
  const setReactions = useChatStore((s) => s.setReactions);
  const setDeletedMsgs = useChatStore((s) => s.setDeletedMsgs);
  const setUnreadCounts = useChatStore((s) => s.setUnreadCounts);
  const newMessage = useChatStore((s) => s.newMessage);
  const view = useChatStore((s) => s.view);
  const activeDm = useChatStore((s) => s.activeDm);
  const activeGroup = useChatStore((s) => s.activeGroup);
  const setTypingUsers = useChatStore((s) => s.setTypingUsers);
  const setGroupTypingUsers = useChatStore((s) => s.setGroupTypingUsers);
  const disappearingTimers = useChatStore((s) => s.disappearingTimers);
  const [lockedUsername, setLockedUsername] = useState(() => scopedGet('my_username', ''));
  const lastTypingSent = useRef(0);
  const groupSubscriptionKey = groups.map((group) => group.id).sort().join('|');
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

  useEffect(() => {
    if (!identity?.sk) return undefined;
    const onKey = (event) => {
      const groupId = event.detail?.groupId;
      if (!groupId) return;
      flushSecuringGroupSends(identity, groupId).catch((error) => {
        console.warn('[group-key] Could not send messages waiting on the key:', error);
      });
    };
    window.addEventListener('cipher:group-key-updated', onKey);
    return () => window.removeEventListener('cipher:group-key-updated', onKey);
  }, [identity?.pk, identity?.sk]);

  useEffect(() => {
    if (identity?.pk) openDBFor(identity.pk);
  }, [identity?.pk]);

  useEffect(() => {
    if (!identity?.pk) return undefined;
    let cancelled = false;
    let told = false;
    const run = () => {
      const gateway = activeUrl(entryById('push'));
      if (!gateway) return;
      const shell = isNativeShell();
      registerWithGateway({
        gatewayUrl: gateway,
        pubkey: identity.pk,
        subscribe: shell ? undefined : subscribeBrowser,
        native: shell ? subscribeNative : undefined,
      }).then((result) => {
        if (cancelled || result.buzzing || told) return;
        told = true;
        console.warn('[push]', result.reason);
        useChatStore.getState().setToast({ type: 'info', message: result.reason });
      }).catch((error) => {
        if (cancelled) return;
        console.error('[push] Gateway registration failed:', error);
        useChatStore.getState().setToast({ type: 'error', message: error?.message || 'The push gateway did not accept this phone.' });
      });
    };
    run();
    window.addEventListener('cipher:network', run);
    return () => {
      cancelled = true;
      window.removeEventListener('cipher:network', run);
    };
  }, [identity?.pk]);

  useEffect(() => {
    if (!identity?.sk || !identity?.pk) return undefined;
    return bindMemberBaselinePublisher(async (groupId, members) => {
      const pool = await getAuthenticatedPool(identity);
      const event = await sealMemberBaseline({
        senderPrivkey: identity.sk,
        senderPubkey: identity.pk,
        groupId,
        members,
      });
      const relays = generalRelays.slice();
      if (!relays.length) throw new Error('No relay is available for the membership baseline.');
      const results = await Promise.allSettled(pool.publish(relays, event));
      if (!results.some((result) => result.status === 'fulfilled')) {
        throw new Error('Relays rejected the membership baseline.');
      }
    });
  }, [identity?.pk, identity?.sk]);

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
          reactionMap[targetId].push({ emoji: ev.content, pubkey: ev.pubkey });
        }
      });
      setReactions((prev) => mergeReactions(prev, reactionMap));
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
    let cleanupGroupReactions = null;
    const setup = async () => {
      const since = Math.floor(Date.now() / 1000) - 604800;
      await fetchChats(true);
      cleanupDMs = subscribeToDMs(since);
      const joinedIds = getMyGroups(identity.pk).map((group) => group.id).filter(Boolean);
      const groupIds = resumeKeyRequestIds({
        pubkey: identity.pk,
        joinedIds,
      });
      if (groupIds.length > 0) cleanupGroups = subscribeToGroups(groupIds, since);
      if (typeof subscribeToGroupReactions === 'function' && joinedIds.length > 0) {
        cleanupGroupReactions = subscribeToGroupReactions(joinedIds);
      }
    };
    setup();
    return () => {
      if (cleanupDMs) cleanupDMs();
      if (cleanupGroups) cleanupGroups();
      if (cleanupGroupReactions) cleanupGroupReactions();
    };
  }, [identity.sk, identity.pk, groupSubscriptionKey]);

  useEffect(() => {
    if (!identity?.sk) return;
    fetchGroups().catch((e) => console.error('[init] fetchGroups:', e));
  }, [identity?.sk]);

  // DM typing — routed through useNIP44DM hook
  useEffect(() => {
    if (!newMessage.trim() || view !== 'dm' || !activeDm || !identity.sk || !allowsTyping()) return;
    if (Date.now() - lastTypingSent.current < 2500) return;
    const timer = setTimeout(async () => {
      await sendTypingIndicator(activeDm);
      lastTypingSent.current = Date.now();
    }, 200);
    return () => clearTimeout(timer);
  }, [newMessage, view, activeDm, identity.sk, sendTypingIndicator]);

  // Group typing — routed through useNIP29Group hook
  useEffect(() => {
    if (!newMessage.trim() || view !== 'group' || !activeGroup || !identity.sk || !allowsTyping()) return;
    if (Date.now() - lastTypingSent.current < 2500) return;
    const timer = setTimeout(async () => {
      await sendGroupTypingIndicator(activeGroup.id);
      lastTypingSent.current = Date.now();
    }, 200);
    return () => clearTimeout(timer);
  }, [newMessage, view, activeGroup, identity.sk, sendGroupTypingIndicator]);

  useEffect(() => {
    if (view !== 'dm' || !activeDm || !identity?.sk || !getPrivacy().readReceipts || !sendDM) return undefined;
    sendDM(activeDm, { type: 'read', at: Math.floor(Date.now() / 1000) }).catch((error) => {
      console.warn('[DM] Read receipt failed:', error);
    });
    return undefined;
  }, [view, activeDm, identity?.sk, sendDM]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setTypingUsers(prev => {
        const next = { ...prev };
        let changed = false;
        for (const pk in next) if (now - next[pk] > 6000) { delete next[pk]; changed = true; }
        return changed ? next : prev;
      });
      setGroupTypingUsers(prev => {
        const next = { ...prev };
        let changed = false;
        for (const pk in next) if (now - next[pk] > 6000) { delete next[pk]; changed = true; }
        return changed ? next : prev;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [setTypingUsers, setGroupTypingUsers]);

  const groupSenderKey = useMemo(() => {
    if (!activeGroup?.id) return '';
    return [...new Set((groupMessages[activeGroup.id] || []).map((message) => message.pubkey))].sort().join(',');
  }, [activeGroup?.id, groupMessages]);

  useEffect(() => {
    if (!groupSenderKey) return;
    fetchProfilesForPubkeys(groupSenderKey.split(','));
  }, [groupSenderKey]);

  useEffect(() => {
    const interval = setInterval(async () => {
      const now = Math.floor(Date.now() / 1000);
      const expiredIds = [];
    const expire = (messages, timerStr) => {
      if (!timerStr || timerStr === 'off') return messages;
      let seconds = 0;
      if (String(timerStr).endsWith('m')) seconds = parseInt(timerStr, 10) * 60;
      else if (timerStr === '1h') seconds = 3600;
      else if (timerStr === '24h') seconds = 86400;
      else if (timerStr === '7d') seconds = 604800;
      if (!seconds) return messages;
      const kept = messages.filter((message) => {
        const keep = (now - message.timestamp) < seconds;
        if (!keep && message.id) expiredIds.push(message.id);
        return keep;
      });
      return kept.length === messages.length ? messages : kept;
    };
    setDms((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [pk, msgs] of Object.entries(prev)) {
        const kept = expire(msgs, disappearingTimers[pk]);
        if (kept !== msgs) { next[pk] = kept; changed = true; }
      }
      return changed ? next : prev;
    });
    setGroupMessages((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const [gid, msgs] of Object.entries(prev)) {
        const kept = expire(msgs, disappearingTimers[gid]);
        if (kept !== msgs) { next[gid] = kept; changed = true; }
      }
      return changed ? next : prev;
    });
    if (expiredIds.length) db.messages.bulkDelete(expiredIds).catch((error) => console.error('[disappearing] Could not delete expired messages:', error));
    }, 5000);
    return () => clearInterval(interval);
  }, [disappearingTimers, setDms, setGroupMessages]);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const directId = urlParams.get('g') || urlParams.get('group') || urlParams.get('join');
    const naddr = urlParams.get('naddr');
    const joinName = urlParams.get('name');
    if ((!directId && !naddr) || !identity?.pk) return undefined;
    let cancelled = false;
    (async () => {
      let joinId = directId;
      if (!joinId && naddr) {
        try {
          const { parseGroupReference } = await import('../../hooks/useNIP29Group');
          joinId = parseGroupReference(naddr).id;
        } catch (error) {
          console.warn('[join] Could not read invite:', error);
        }
      }
      if (!joinId || cancelled) return;
      // Groups are open, so an invite joins directly.
      joinGroupById(joinId, joinName);
    })();
    return () => { cancelled = true; };
  }, [identity?.pk]);
  return { fetchChats };
}
