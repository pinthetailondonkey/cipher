import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { unreadCountsFor } from '../../lib/unreadCounts';
import { db, deletedMessageIds, saveMessage, openDBFor, sweepTempMessages } from '../../db';
import { getMyGroups } from '../../lib/myGroups';
import { relayCopyOverRow } from '../../lib/groupJoin';
import { mergeReactions, reactionFiltersFor, reactionFromEvent, withoutDeletedReactions } from '../../lib/reactions';
import { generalRelays, groupRelays, queryAllPages, queryFirstAnswer, queryWithTimeout } from '../../lib/relays';
import { getAuthenticatedPool } from '../../lib/pool';
import { useChatStore } from '../../store/chatStore';
import { scopedGet, scopedSet } from '../../lib/storage';
import { shortNpub } from '../../lib/npub';
import { getPrivacy, allowsTyping } from '../../lib/privacy';
import { decodeGroupEvent } from '../../lib/crypto/groupMessageCodec';
import { resumeKeyRequestIds } from '../../lib/crypto/groupKeyRequest';
import { useGroupKeyReconciler } from '../../hooks/useGroupKeyReconciler';
import { flushSecuringGroupSends } from '../../hooks/useNIP29Group';
import { bindMemberBaselinePublisher, sealMemberBaseline } from '../../lib/crypto/memberBaseline';
import { sortMessages } from './media';
import { rowExpired, timerSweepKeepsRow } from '../../lib/disappearing';
import { listingFromEvent, vendorListingFilter } from '../../lib/listing';
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
  const loading = useChatStore((s) => s.loading);
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
            name: meta.name || meta.display_name || shortNpub(ev.pubkey),
            displayName: meta.display_name || meta.name || shortNpub(ev.pubkey),
            picture: meta.picture || null, about: meta.about || '',
          };
          fresh[ev.pubkey] = profile;
          await db.profiles.put(profile);
        } catch {}
      }
      if (Object.keys(fresh).length > 0) setProfiles(prev => ({ ...prev, ...fresh }));
    } catch (err) { console.error('[profiles] fetch failed:', err); }
  };

  // One grouping for both draws — the rows this device holds at the start of
  // a login and the rows it holds after the relays answered — so the early
  // draw can never grow a different shape from the late one.
  const splitRows = async (rows) => {
    const finalDms = {};
    const finalGroups = {};
    let n = 0;
    for (const msg of rows) {
      if (++n % 50 === 0) await new Promise((r) => setTimeout(r, 0)); // yield to UI
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
    return { finalDms, finalGroups };
  };

  // The last known good state of this account, on this device, with no relay
  // asked: the chats, the rows and the unread counts from the previous
  // session. It is not a copy — it is the account's own database, named by
  // pubkey (db.js openDBFor), so it cannot serve one handle's chats to
  // another account. The relays replace it as soon as they answer.
  const drawHeldChats = async () => {
    try {
      const rows = (await db.messages.toArray()).filter((msg) => !rowExpired(msg));
      if (rows.length === 0) return false;
      const { finalDms, finalGroups } = await splitRows(rows);
      const reads = await db.chatReads.toArray();
      const readMap = {};
      reads.forEach(r => { readMap[r.chatId] = r.lastRead; });
      const localDeleted = new Set(await deletedMessageIds());
      setUnreadCounts(unreadCountsFor(rows, readMap, localDeleted));
      setDms(finalDms);
      setGroupMessages(finalGroups);
      return true;
    } catch (error) {
      console.warn('[chat] Could not draw the chats this device holds:', error);
      return false;
    }
  };

  const fetchChats = async (showLoader = false) => {
    if (showLoader) setLoading(true);
    try {
      // What this device already holds, drawn before any relay is asked. The
      // account's own database is the only cache that cannot mix accounts up:
      // openDBFor(pubkey) names it, and every row in it was written by this
      // account on this device. A login with every relay silent still opens
      // the chats it opened last time.
      // A device that holds chats opens on them. The loader is the only thing
      // between a person and their list, so it goes as soon as there is a list
      // to show; the relays refresh it underneath and the fresh rows replace
      // these when they arrive.
      //
      // LIMITS, named here rather than only in the commit:
      // - A deletion made on another device shows for a moment, between this
      //   draw and the kind-5 list landing. Bounded by the deletion query's
      //   cap, and the rows go as soon as it answers.
      // - A cold device, or a fresh restore, holds nothing to draw. It gets
      //   the loader exactly as before; this costs it nothing and gains it
      //   nothing.
      // - An offline cold unlock is not this branch's problem (fix/offline-warm).
      if (await drawHeldChats()) setLoading(false);
      const pool = await getAuthenticatedPool(identity);
      // Stage 1 and stage 2 are independent — fetchDMs() takes no arguments
      // and reads nothing stage 1 produces (useNIP44DM.js:362) — so the DM
      // history starts now instead of after the group read gives up. The one
      // real dependency is later: the reactions query needs this stage's
      // deletion list, and it still waits for it.
      const stageOne = Promise.all([
        queryFirstAnswer(pool, groupRelays, { kinds: [39000, 9002], limit: 100 }),
        queryFirstAnswer(pool, generalRelays, { kinds: [5], authors: [identity.pk], limit: 500 }),
      ]);
      const stageTwo = Promise.resolve()
        .then(() => fetchDMs())
        .catch((error) => { console.error('[chat] DM history fetch failed:', error); return []; });
      const [groupMetaEvents, delEvents] = await stageOne;
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
      // F3: metadata events name no creator — ev.pubkey is just who signed
      // the newest edit, and an attacker can publish one. A known local
      // record keeps its own creator; the claim only fills a brand-new row.
      parsedGroupsNow.forEach(pg => {
        const existing = allGroupsMap.get(pg.id);
        if (existing) {
          allGroupsMap.set(pg.id, relayCopyOverRow(existing, pg));
        } else {
          allGroupsMap.set(pg.id, pg);
        }
      });
      setGroups(Array.from(allGroupsMap.values()));
      const dmPubkeys = await stageTwo;
      const deleted = new Set();
      delEvents.forEach(ev => {
        if (ev.pubkey === identity.pk) {
          const targetId = ev.tags.find(t => t[0] === 'e')?.[1];
          if (targetId) deleted.add(targetId);
        }
      });
      (await deletedMessageIds()).forEach((id) => deleted.add(id));
      // Reactions to the messages this device holds, asked for by id in
      // batches (newest first, capped). The old query took the latest 500
      // reactions of anyone, which held almost none of ours. A reaction whose
      // event we deleted stays gone.
      try {
        const held = (await db.messages.toArray())
          .filter((m) => m && typeof m.id === 'string')
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
          .map((m) => m.id);
        const batches = await Promise.allSettled(
          reactionFiltersFor(held).map((filter) => queryWithTimeout(pool, generalRelays, filter)),
        );
        const reactionMap = {};
        for (const batch of batches) {
          if (batch.status !== 'fulfilled') continue;
          withoutDeletedReactions(batch.value, deleted).forEach((ev) => {
            const targetId = ev.tags.find(t => t[0] === 'e')?.[1];
            if (!targetId) return;
            if (!reactionMap[targetId]) reactionMap[targetId] = [];
            reactionMap[targetId].push(reactionFromEvent(ev));
          });
        }
        setReactions((prev) => mergeReactions(prev, reactionMap));
      } catch (error) {
        console.warn('[reactions] Could not load reactions for the messages on this device:', error);
      }
      setDeletedMsgs(deleted);
      await sweepTempMessages();
      const allDbMsgs = await db.messages.toArray();
      // The carried stamp dies first: a row whose own expires_at is past is
      // dead on load, whatever the local timer says — a local timer that is
      // missing (fresh device, restored account) is exactly how expired rows
      // used to resurrect. The dead rows also leave the database, so the
      // death survives the next load instead of repeating every one.
      const expiredIds = [];
      for (const msg of allDbMsgs) {
        if (rowExpired(msg)) expiredIds.push(msg.id);
      }
      if (expiredIds.length) {
        db.messages.bulkDelete(expiredIds).catch((error) => console.error('[disappearing] Could not delete expired messages:', error));
      }
      const liveDbMsgs = expiredIds.length ? allDbMsgs.filter((msg) => !expiredIds.includes(msg.id)) : allDbMsgs;
      const reads = await db.chatReads.toArray();
      const readMap = {};
      reads.forEach(r => { readMap[r.chatId] = r.lastRead; });
      const counts = unreadCountsFor(liveDbMsgs, readMap, deleted);
      setUnreadCounts(counts);
      const { finalDms, finalGroups } = await splitRows(liveDbMsgs);
      setDms(finalDms);
      setGroupMessages(finalGroups);
      if (dmPubkeys.length > 0) fetchProfilesForPubkeys(dmPubkeys);
    } catch (err) {
      console.error('Fetch error:', err);
      // A refresh the relays refused used to be silent: the press looked
      // like a dead button. The failure is said out loud instead.
      useChatStore.getState().setToast({ type: 'error', message: 'The chats could not be refreshed.' });
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
      // A join still waiting on the owner opens no group subscriptions: the
      // relay refuses them for an account it has not admitted, and a stream
      // of refusals is not a chat. They start when a proof says the account
      // is inside.
      const joinedIds = getMyGroups(identity.pk)
        .filter((group) => group.membership !== 'pending')
        .map((group) => group.id)
        .filter(Boolean);
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
      // The carried stamp is the death this device can always see: a row
      // whose own expires_at is past is dead whatever the chat timer is —
      // the seeding timer lives in the sender's payload, and keying only on
      // the local setting is how swept rows resurrected after every save.
      let kept = messages.filter((message) => {
        if (rowExpired(message, now)) {
          if (message.id) expiredIds.push(message.id);
          return false;
        }
        return true;
      });
      if (kept.length !== messages.length) messages = kept;
      if (!timerStr || timerStr === 'off') return messages;
      let seconds = 0;
      if (String(timerStr).endsWith('m')) seconds = parseInt(timerStr, 10) * 60;
      else if (timerStr === '1h') seconds = 3600;
      else if (timerStr === '24h') seconds = 86400;
      else if (timerStr === '7d') seconds = 604800;
      else if (timerStr === '30d') seconds = 2592000;
      if (!seconds) return messages;
      const timerKept = messages.filter((message) => {
        const keep = timerSweepKeepsRow(message, now, seconds);
        if (!keep && message.id) expiredIds.push(message.id);
        return keep;
      });
      return timerKept.length === messages.length ? messages : timerKept;
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
    // Link shapes (user-specified): /note#<fragment> opens a burn note — the
    // fragment is the key, never sent to any server. /<groupid> joins a group,
    // same as the older ?g= / ?group= / ?join= shapes which keep working.
    // ?product=&vendor= is a shared shop card: the listing id and the vendor
    // that published it, copied by the Menus screen's link button.
    const path = window.location.pathname;
    const pathGroup = path.match(/^\/([0-9a-f]{64})\/?$/)?.[1] || null;
    const pathNote = path === '/note' || path === '/note/' ? window.location.hash.slice(1) : null;
    const directId = urlParams.get('g') || urlParams.get('group') || urlParams.get('join') || pathGroup;
    const naddr = urlParams.get('naddr');
    const noteFragment = pathNote;
    const productParam = urlParams.get('product');
    const vendorParam = urlParams.get('vendor');
    const linkedProduct = !!productParam && !!vendorParam;
    if ((!directId && !naddr && !noteFragment && !linkedProduct) || !identity?.pk) return undefined;
    let cancelled = false;
    (async () => {
      if (noteFragment) {
        try {
          const { openDeadDropNote } = await import('../../lib/deadDrop');
          const pool = await getAuthenticatedPool(identity);
          const opened = await openDeadDropNote({ identity, fragment: noteFragment, pool, relays: generalRelays });
          if (!cancelled) {
            useChatStore.getState().setToast({ type: 'info', message: 'Note opened. Copy it now — it will not open again.' });
            await navigator.clipboard.writeText(opened.text).catch(() => {});
          }
        } catch (error) {
          if (!cancelled) useChatStore.getState().setToast({ type: 'error', message: error.message || 'The note could not be opened.' });
        } finally {
          // The link has done its one job; clean the address bar either way.
          window.history.replaceState(null, '', '/');
        }
        return;
      }
      if (linkedProduct) {
        // The link names one listing this vendor published. The read is the
        // storefront's own vendor-listing filter, shared through
        // lib/listing.js; the id answers only against rows fetched under
        // that vendor's key, so a link cannot aim another vendor's listing.
        const miss = () => {
          // The miss lands on the vendor's shop, not nowhere: their listings
          // are at least reachable where the dead link was handed over.
          if (/^[0-9a-f]{64}$/.test(String(vendorParam))) useChatStore.getState().setVendorStorefrontPubkey(vendorParam);
        };
        try {
          const pool = await getAuthenticatedPool(identity);
          const events = await queryWithTimeout(pool, generalRelays, vendorListingFilter(vendorParam));
          if (cancelled) return;
          const listing = events.map(listingFromEvent).find((row) => String(row.id) === String(productParam));
          if (listing) {
            useChatStore.getState().setCheckoutProduct(listing);
          } else {
            useChatStore.getState().setToast({ type: 'error', message: 'That product is no longer listed.' });
            miss();
          }
        } catch (error) {
          console.error('[product link] Could not load the listing:', error);
          useChatStore.getState().setToast({ type: 'error', message: 'That product is no longer listed.' });
          miss();
        } finally {
          // The link has done its one job; clean the address bar either way,
          // the way the group join drops the search params when it lands.
          if (window.location.search.length > 0) window.history.replaceState({}, document.title, window.location.pathname);
        }
        return;
      }
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
      // The link must point at a group the relays know, and it carries no
      // name: a forged address used to organize a group row this device
      // never chose and name it out of the link's URL (drill residual).
      // The words the row gets come from the group's own standing records,
      // same as any other join. Groups stay open, so joining still needs
      // no approval — it does need the group to exist.
      // Three answers, three words. A group the relay proved it does not hold
      // is not found. A group the relay would not talk about is not the same
      // claim, and the link still tries the join, so the relay's own answer
      // is the one that names the outcome.
      let read = null;
      try {
        const { fetchGroupMetadataOutcome } = await import('../../hooks/useNIP29Group');
        read = await fetchGroupMetadataOutcome(identity, joinId);
      } catch (error) {
        console.warn('[join] Link did not point at a group:', error);
      }
      if (read?.status === 'absent') {
        useChatStore.getState().setToast({ type: 'error', message: 'No group found at that address.' });
        return;
      }
      if (read?.status === 'unavailable') {
        useChatStore.getState().setToast({ type: 'info', message: 'The relay would not say whether that group exists. Trying to join anyway.' });
      }
      joinGroupById(joinId);
    })();
    return () => { cancelled = true; };
  }, [identity?.pk]);
  // A shared chat link (?chat=<pubkey>) is resolved after the history fetch
  // lands (master §2): the store's own openChat sets the view, and the read
  // marker moves the way tapping the row would. The link has done its one
  // job afterwards, so the search params drop from the address bar — the
  // way the group join lands. Hex keys and npubs both resolve.
  useEffect(() => {
    if (loading || !identity?.pk) return undefined;
    const urlParams = new URLSearchParams(window.location.search);
    const chatParam = urlParams.get('chat');
    if (!chatParam) return undefined;
    let cancelled = false;
    (async () => {
      let peer = '';
      if (/^[0-9a-f]{64}$/i.test(chatParam)) {
        peer = chatParam.toLowerCase();
      } else if (chatParam.startsWith('npub1')) {
        try {
          const { nip19 } = await import('nostr-tools');
          const decoded = nip19.decode(chatParam);
          if (decoded.type === 'npub') {
            const data = decoded.data;
            peer = typeof data === 'string' ? data : Array.from(data).map((byte) => byte.toString(16).padStart(2, '0')).join('');
          }
        } catch (error) {
          console.warn('[chat link] Could not read the address:', error);
        }
      }
      if (!peer || cancelled || peer === identity.pk) return;
      try {
        await db.chatReads.put({ chatId: peer, lastRead: Math.floor(Date.now() / 1000) });
        setUnreadCounts((prev) => ({ ...prev, [peer]: 0 }));
      } catch {}
      useChatStore.getState().openChat('dm', peer);
      if (window.location.search.length > 0) {
        window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
      }
    })();
    return () => { cancelled = true; };
  }, [loading, identity?.pk]);

  return { fetchChats };
}
