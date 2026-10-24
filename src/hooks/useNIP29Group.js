import { showNotification } from '../lib/notifications';
import { useChatStore } from '../store/chatStore';

const shouldSuppressGroup = (groupId) => {
  const state = useChatStore.getState();
  const mutedUntil = state.mutedUntil?.[groupId];
  const isMuted = mutedUntil === 'forever' || (mutedUntil && mutedUntil > Date.now());
  const isArchived = state.archivedChats?.includes(groupId);
  return isMuted || isArchived;
};
import { useCallback, useEffect } from 'react';
import { getAuthenticatedPool } from '../lib/pool';
import { groupRelays, generalRelays, queryWithTimeout } from '../lib/relays';
import { saveMessage } from '../db';
import { getMyGroups, setMyGroups } from '../lib/myGroups';
import { encodeGroupPayload, decodeGroupEvent } from '../lib/crypto/groupMessageCodec';
import { putGroupKey, getAllGroupKeys, getCurrentGroupKey } from '../lib/crypto/groupKeyStore';
import { generateGroupKey } from '../lib/crypto/groupCipher';
import { distributeGroupKey } from '../lib/crypto/groupKeyDistribution';
import { enqueueNostrEvent, startOutboxSync } from '../lib/outbox';

export function useNIP29Group({ identity }) {
  const setGroupsStore = useChatStore((s) => s.setGroups);
  const setGroups = useCallback((val) => {
    setGroupsStore((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      // Strict filter: only allow groups the user has explicitly joined/created.
      // This kills the relay WS listener that injects "lmfao".
      const myGroupIds = new Set(getMyGroups(identity?.pk).map(g => g.id));
      return next.filter(g => myGroupIds.has(g.id));
    });
  }, [identity?.pk, setGroupsStore]);
  const setGroupMessages = useChatStore((s) => s.setGroupMessages);
  const setGroupMembers = useChatStore((s) => s.setGroupMembers);
  const setGroupTypingUsers = useChatStore((s) => s.setGroupTypingUsers);
  const setPinnedMessages = useChatStore((s) => s.setPinnedMessages);
  const activeGroup = useChatStore((s) => s.activeGroup);

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

  const appendSystemMessage = useCallback((groupId, text, eventId = null) => {
    const id = eventId ? 'sys-' + eventId : 'sys-' + Date.now() + Math.random().toString(36).substr(2, 9);
    setGroupMessages(prev => {
      const msgs = prev[groupId] || [];
      if (msgs.find(m => m.id === id)) return prev;
      return {
        ...prev,
        [groupId]: [
          ...msgs,
          {
            id, isSender: false, isGroup: true, type: 'system',
            timestamp: Math.floor(Date.now() / 1000),
            rawContent: JSON.stringify({ type: 'system', message: text })
          }
        ].sort(sortMessages)
      };
    });
  }, [setGroupMessages]);

  // CREATE GROUP
  const createGroup = useCallback(async (name, about, isChannel) => {
    const { finalizeEvent } = await import('nostr-tools');
    const pool = await getAuthenticatedPool(identity);
    const groupId = (globalThis.crypto?.randomUUID?.() || Date.now().toString()).replace(/-/g, '').slice(0, 16);

    const createEv = finalizeEvent({
      kind: 9007, created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId], ['name', name], ['about', about || ''], ['open'], ['p', identity.pk, 'admin']],
      content: ''
    }, identity.sk);

    const r9007 = await Promise.allSettled(pool.publish(groupRelays, createEv));
    const ok = r9007.some(r => r.status === 'fulfilled');
    if (!ok) throw new Error('No relay accepted 9007');

    const metaTags = [['h', groupId], ['name', name], ['about', about || '']];
    if (isChannel) {
      metaTags.push(['channel', 'true']);
      metaTags.push(['broadcast', 'true']);
    }
    
    const metaEv = finalizeEvent({
      kind: 9002, created_at: Math.floor(Date.now() / 1000),
      tags: metaTags,
      content: ''
    }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, metaEv));

    const joinEv = finalizeEvent({
      kind: 9021, created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId]], content: 'Creator'
    }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, joinEv));

    try {
      const existing = await getCurrentGroupKey(groupId);
      if (!existing) {
        const key = generateGroupKey();
        await putGroupKey(groupId, 1, key);
        await distributeGroupKey({
          senderPrivkey: identity.sk, senderPubkey: identity.pk,
          groupId, epoch: 1, keyBytes: key, recipients: [identity.pk],
          publish: async (dmEv) => {
            const results = await Promise.allSettled(pool.publish(groupRelays, dmEv));
            if (!results.some(r => r.status === 'fulfilled')) throw new Error('dm rejected');
          },
        });
      }
    } catch (e) { console.warn('[createGroup] key bootstrap deferred', e); }

    appendSystemMessage(groupId, 'You created the group');
    const newGroup = { id: groupId, name, about: about || '', isChannel, creator: identity.pk, members: [identity.pk] };

    const localGroups = getMyGroups(identity.pk);
    if (!localGroups.find(g => g.id === groupId)) {
      localGroups.push(newGroup);
      setMyGroups(identity.pk, localGroups);
    }
    setGroups(prev => [newGroup, ...(prev || []).filter(g => g.id !== groupId)]);

    return newGroup;
  }, [identity, setGroups]);

  // JOIN GROUP
  const joinGroupById = useCallback(async (groupId, passedName = null) => {
    if (!groupId) return;
    let realName = passedName || 'Unnamed Group';

    const localGroups = getMyGroups(identity.pk);
    const localMatch = localGroups.find(g => g.id === groupId);
    if (!passedName && localMatch?.name && localMatch.name !== 'Unnamed Group') {
      realName = localMatch.name;
    } else if (!passedName) {
      try {
        const pool = await getAuthenticatedPool(identity);
        const events = await queryWithTimeout(pool, groupRelays, { kinds: [9002], limit: 200 }, 3000);
        const match = events.find(ev => ev.tags.find(t => t[0] === 'h')?.[1] === groupId);
        if (match) {
          const nameTag = match.tags.find(t => t[0] === 'name')?.[1];
          if (nameTag) realName = nameTag;
        }
      } catch (e) {}
    }

    if (realName === 'Unnamed Group') {
      const userInput = window.prompt('What is this group called?', '');
      if (userInput && userInput.trim()) realName = userInput.trim();
    }

    const newGroup = { id: groupId, name: realName, isChannel: false, creator: '' };
    const idx = localGroups.findIndex(g => g.id === groupId);
    if (idx === -1) localGroups.push(newGroup);
    else localGroups[idx].name = realName;
    setMyGroups(identity.pk, localGroups);
    setGroups(prev => [newGroup, ...(prev || []).filter(g => g.id !== groupId)]);

    return newGroup;
  }, [identity, setGroups]);

  // LEAVE GROUP
  const leaveGroup = useCallback(async (groupId) => {
    const { finalizeEvent } = await import('nostr-tools');
    const pool = await getAuthenticatedPool(identity);
    const leaveEv = finalizeEvent({
      kind: 9022, created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId]], content: ''
    }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, leaveEv));
    appendSystemMessage(groupId, 'You left the group', leaveEv.id);

    const localGroups = getMyGroups(identity.pk);
    const updated = localGroups.filter(g => g.id !== groupId);
    setMyGroups(identity.pk, updated);
    setGroups(updated);
  }, [identity, setGroups]);

  // SEND GROUP MESSAGE
  const sendGroupMessage = useCallback(async (groupId, payload, clientId = null, replyId = null) => {
    try {
      const { finalizeEvent } = await import('nostr-tools');
      const pool = await getAuthenticatedPool(identity);
      const encoded = await encodeGroupPayload({ groupId, payload, senderPubkey: identity.pk, waitForKey: true });
      if (encoded.pending) {
        try {
          const reqEv = finalizeEvent({
            kind: 9, created_at: Math.floor(Date.now() / 1000),
            tags: [['h', groupId]],
            content: JSON.stringify({ type: 'gkey_req' })
          }, identity.sk);
          Promise.allSettled(pool.publish(groupRelays, reqEv)).then((results) => {
            if (results.every((result) => result.status === 'rejected')) {
              console.warn('[NIP29] All relays rejected the group key request:', results);
            }
          });
        } catch (error) {
          console.error('[NIP29] Failed to request a group key:', error);
        }
        return { success: false, error: 'NO_KEY' };
      }
      const tags = [['h', groupId], ...encoded.tags];
      if (clientId) tags.push(['client', clientId]);
      if (replyId) tags.push(['e', replyId, '', 'reply']);
      const event = finalizeEvent({
        kind: 9, created_at: Math.floor(Date.now() / 1000),
        tags, content: encoded.content
      }, identity.sk);
      const results = await Promise.allSettled(pool.publish(groupRelays, event));
      const relayCount = results.filter((result) => result.status === 'fulfilled').length;
      if (relayCount === 0) {
        console.warn('[NIP29] All group relays rejected the message:', results);
        await enqueueNostrEvent(event);
        return { success: true, queued: true, event, results, relayCount: 0 };
      }
      return { success: true, event, results, relayCount };
    } catch (error) {
      console.error('[NIP29] Failed to send group message:', error);
      return { success: false, error: error?.message || 'Group message failed' };
    }
  }, [identity]);

  // SEND GROUP TYPING INDICATOR
  const requestGroupKey = useCallback(async (groupId) => {
    try {
      const { finalizeEvent } = await import('nostr-tools');
      const pool = await getAuthenticatedPool(identity);
      const ev = finalizeEvent({
        kind: 9, created_at: Math.floor(Date.now() / 1000),
        tags: [['h', groupId]], content: JSON.stringify({ type: 'gkey_req' })
      }, identity.sk);
      pool.publish(groupRelays, ev);
    } catch (e) {}
  }, [identity]);

  const sendGroupTypingIndicator = useCallback(async (groupId) => {
    try {
      const { finalizeEvent } = await import('nostr-tools');
      const pool = await getAuthenticatedPool(identity);
      const encoded = await encodeGroupPayload({ groupId, payload: { type: 'typing' }, senderPubkey: identity.pk });
      if (encoded.pending) return;
      const ev = finalizeEvent({
        kind: 9, created_at: Math.floor(Date.now() / 1000),
        tags: [['h', groupId], ...encoded.tags], content: encoded.content
      }, identity.sk);
      pool.publish(groupRelays, ev);
    } catch (e) {}
  }, [identity]);

  // ADMIN ACTIONS
  const kickMember = useCallback(async (groupId, memberPubkey) => {
    const { finalizeEvent } = await import('nostr-tools');
    const pool = await getAuthenticatedPool(identity);
    const allMembers = useChatStore.getState().groupMembers || [];
    const remaining = allMembers.filter(m => m.pubkey !== memberPubkey).map(m => m.pubkey);
    if (!remaining.includes(identity.pk)) remaining.push(identity.pk);
    const ev = finalizeEvent({
      kind: 9001, created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId], ['p', memberPubkey]], content: ''
    }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, ev));
    setGroupMembers(prev => prev.filter(m => m.pubkey !== memberPubkey));
    appendSystemMessage(groupId, `User ${memberPubkey.slice(0, 6)}... was kicked from the group`, ev.id);
    // Rotation handled by useGroupKeyReconciler (audit H10)
    // kickMember only publishes the 9001 relay event  }
  }, [identity, setGroupMembers]);

  const promoteMember = useCallback(async (groupId, memberPubkey, isAdmin) => {
    const { finalizeEvent } = await import('nostr-tools');
    const pool = await getAuthenticatedPool(identity);
    const ev = finalizeEvent({
      kind: 9000, created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId], ['p', memberPubkey], ['role', isAdmin ? 'member' : 'admin']],
      content: ''
    }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, ev));
    setGroupMembers(prev => prev.map(m => m.pubkey === memberPubkey ? { ...m, role: isAdmin ? 'member' : 'admin' } : m));
    appendSystemMessage(groupId, `User ${memberPubkey.slice(0, 6)}... was ${isAdmin ? 'demoted to member' : 'promoted to admin'}`, ev.id);
  }, [identity, setGroupMembers]);

  // ADD MEMBER
  const addMember = useCallback(async (groupId, memberPubkey) => {
    const { finalizeEvent } = await import('nostr-tools');
    const pool = await getAuthenticatedPool(identity);
    const ev = finalizeEvent({
      kind: 9000, created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId], ['p', memberPubkey]], content: ''
    }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, ev));
    appendSystemMessage(groupId, `User ${memberPubkey.slice(0, 6)}... was added to the group`, ev.id);
    setGroupMembers(prev => {
      if (prev.findIndex(x => x.pubkey === memberPubkey) === -1) {
        return [...prev, { pubkey: memberPubkey, role: 'member' }];
      }
      return prev;
    });
  }, [identity, setGroupMembers]);

  // UPDATE GROUP SETTINGS (name, about, avatar)
  const updateGroupSettings = useCallback(async (groupId, updates) => {
    const { finalizeEvent } = await import('nostr-tools');
    const pool = await getAuthenticatedPool(identity);
    
    const tags = [['h', groupId]];
    if (updates.name) tags.push(['name', updates.name]);
    if (updates.about !== undefined) tags.push(['about', updates.about]);
    if (updates.avatar) tags.push(['picture', updates.avatar]);
    if (updates.requireApproval !== undefined) {
      tags.push(['join', updates.requireApproval ? 'approval' : 'open']);
    }
    
    const ev = finalizeEvent({
      kind: 9002,
      created_at: Math.floor(Date.now() / 1000),
      tags,
      content: ''
    }, identity.sk);
    
    await Promise.allSettled(pool.publish(groupRelays, ev));
    
    // Update local group in store
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, ...updates } : g));
    
    // System message
    if (updates.name) {
      appendSystemMessage(groupId, `Group name changed to "${updates.name}"`, ev.id);
    } else if (updates.avatar) {
      appendSystemMessage(groupId, 'Group photo was updated', ev.id);
    } else if (updates.requireApproval !== undefined) {
      appendSystemMessage(groupId, updates.requireApproval ? 'Joining this group now requires admin approval' : 'This group is now open to join', ev.id);
    } else if (updates.about !== undefined) {
      appendSystemMessage(groupId, 'Group description was updated', ev.id);
    }
    
    return { success: true };
  }, [identity, setGroups]);

  // FETCH MEMBERS
  const fetchGroupMembers = useCallback(async (groupId) => {
      try {
        const pool = await getAuthenticatedPool(identity);
        const [byDTag, byHTag] = await Promise.all([
          queryWithTimeout(pool, groupRelays, { kinds: [39002], '#d': [groupId] }),
          queryWithTimeout(pool, groupRelays, { kinds: [39002], '#h': [groupId] }),
        ]);
        const latest = Array.from(new Map([...byDTag, ...byHTag].map((event) => [event.id, event])).values())
          .sort((a, b) => b.created_at - a.created_at)[0];
        if (!latest) {
          console.warn(`[NIP29] No membership snapshot found for group ${groupId}`);
          return null;
        }
        const members = latest.tags
          .filter((tag) => tag[0] === 'p' && tag[1])
          .map((tag) => ({ pubkey: tag[1], role: tag[2] || 'member' }));
        if (!members.some((member) => member.pubkey === identity.pk)) {
          members.push({ pubkey: identity.pk, role: activeGroup?.creator === identity.pk ? 'admin' : 'member' });
        }
        if (useChatStore.getState().activeGroup?.id === groupId) setGroupMembers(members);
        return members;
      } catch (err) {
        console.error('[useNIP29Group] fetchGroupMembers failed:', err);
        return null;
      }
    }, [identity?.pk, identity?.sk, setGroupMembers]);

  // RAW WEBSOCKET SUBSCRIPTION (NIP-42 AUTH + join + subscribe)
  const subscribeToGroups = useCallback((groupIds, since) => {
    if (!groupIds || groupIds.length === 0) return () => {};

    let ws;
    let authSent = false;
    let sentReq = false;
    let isMounted = true;
    let keyHandler = null;
    let authEventId = null;
    let reconnectTimer = null;

    const connect = () => {
      if (!isMounted) return;
      authSent = false;
      sentReq = false;
      authEventId = null;
      ws = new WebSocket('wss://groups.aegispayhq.com');

      ws.onopen = () => {
        if (!isMounted) return;
        console.log('✅ Group WS connected');
        window.dispatchEvent(new CustomEvent('cipher:relay-connected', {
          detail: { url: 'wss://groups.aegispayhq.com' },
        }));
      };

      ws.onmessage = async (e) => {
        if (!isMounted) return;
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch (error) {
          console.warn('[NIP29] Ignoring malformed group relay frame:', error);
          return;
        }

        if (msg[0] === 'AUTH') {
          if (authSent || !identity?.sk) return;
          try {
            const { finalizeEvent } = await import('nostr-tools');
            const challenge = typeof msg[1] === 'string' ? msg[1] : msg[1]?.challenge;
            if (!challenge || ws.readyState !== WebSocket.OPEN) return;
            const authEv = finalizeEvent({
              kind: 22242, created_at: Math.floor(Date.now() / 1000),
              tags: [['relay', 'wss://groups.aegispayhq.com'], ['challenge', challenge]],
              content: ''
            }, identity.sk);
            authEventId = authEv.id;
            ws.send(JSON.stringify(['AUTH', authEv]));
            authSent = true;
          } catch (error) {
            console.error('[NIP29] Failed to authenticate group relay:', error);
          }
        }
        else if (msg[0] === 'OK' && msg[1] === authEventId && msg[2] === true && !sentReq) {
          sentReq = true;
          for (const gid of groupIds) {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify(['REQ', `group-sub-${gid}`, { kinds: [7, 9, 39002, 9021, 9022, 9000, 9001, 9002], '#h': [gid], since }]));
            }
          }
        } else if (msg[0] === 'OK' && msg[1] === authEventId && msg[2] === false) {
          console.error('[NIP29] Group relay rejected NIP-42 authentication:', msg[3]);
        }
        else if (msg[0] === 'EVENT' && typeof msg[1] === 'string' && msg[1].startsWith('group-sub-')) {
          const event = msg[2];
          const hTag = event.tags.find(t => t[0] === 'h');
          if (!hTag) return;
          const groupId = hTag[1];

          if (event.kind === 9021) { // Join
            const pk = event.pubkey;
            if (useChatStore.getState().activeGroup?.id === groupId) {
              setGroupMembers(prev => {
                let updated = Array.isArray(prev) ? [...prev] : [];
                if (updated.findIndex(m => m.pubkey === pk) === -1) updated.push({ pubkey: pk, role: 'member' });
                return updated;
              });
            }
            if (pk !== identity.pk) appendSystemMessage(groupId, `User ${pk.slice(0, 6)}... joined the group`, event.id);
            return;
          }
          if (event.kind === 9022) { // Leave
            const pk = event.pubkey;
            if (useChatStore.getState().activeGroup?.id === groupId) {
              setGroupMembers(prev => Array.isArray(prev) ? prev.filter(m => m.pubkey !== pk) : []);
            }
            appendSystemMessage(groupId, `User ${pk.slice(0, 6)}... left the group`, event.id);
            return;
          }
          if (event.kind === 9000) { // Add / Promote
            const pk = event.tags.find(t => t[0] === 'p')?.[1];
            const role = event.tags.find(t => t[0] === 'role')?.[1] || 'member';
            if (useChatStore.getState().activeGroup?.id === groupId) {
              setGroupMembers(prev => {
                let updated = Array.isArray(prev) ? [...prev] : [];
                const idx = updated.findIndex(m => m.pubkey === pk);
                if (idx !== -1) updated[idx] = { ...updated[idx], role };
                else updated.push({ pubkey: pk, role });
                return updated;
              });
            }
            appendSystemMessage(groupId, `User ${pk.slice(0, 6)}... was ${role === 'admin' ? 'promoted to admin' : 'demoted to member'}`, event.id);
            return;
          }
          if (event.kind === 9001) { // Kick
            const pk = event.tags.find(t => t[0] === 'p')?.[1];
            if (useChatStore.getState().activeGroup?.id === groupId) {
              setGroupMembers(prev => Array.isArray(prev) ? prev.filter(m => m.pubkey !== pk) : []);
            }
            appendSystemMessage(groupId, `User ${pk.slice(0, 6)}... was kicked from the group`, event.id);
            return;
          }
          if (event.kind === 9002) { // Metadata (Name/About)
            const name = event.tags.find(t => t[0] === 'name')?.[1];
            const about = event.tags.find(t => t[0] === 'about')?.[1];
            if (name) appendSystemMessage(groupId, `Group name was changed to "${name}"`, event.id);
            else if (about) appendSystemMessage(groupId, `Group description was updated`, event.id);
            return;
          }

          if (event.kind === 39002) {
            const t = event.tags.filter(x => x[0] === 'p');
            const m = t.map(x => ({ pubkey: x[1], role: x[2] || 'member' }));
            if (!m.find(x => x.pubkey === identity.pk)) {
              m.push({ pubkey: identity.pk, role: 'member' });
            }
            if (useChatStore.getState().activeGroup?.id === groupId) setGroupMembers(m);
            return;
          }

          // Handle Reaction Events
          if (event.kind === 7) {
            const targetId = event.tags.find(t => t[0] === 'e')?.[1];
            if (targetId) {
              useChatStore.getState().setReactions(prev => {
                const existing = prev[targetId] || [];
                if (existing.find(r => r.pubkey === event.pubkey && r.emoji === event.content)) return prev;
                return { ...prev, [targetId]: [...existing, { emoji: event.content, pubkey: event.pubkey }] };
              });
            }
            return;
          }

          // Audit H8: drop messages from blocked senders
          const _blocked = useChatStore.getState().blockedUsers || [];
          if (_blocked.includes(event.pubkey) && event.pubkey !== identity.pk) return;

          let isGkeyReq = false;
          try {
            const parsedQuick = JSON.parse(event.content);
            if (parsedQuick.type === 'gkey_req') {
              isGkeyReq = true;
              if (event.pubkey !== identity.pk) {
                const current = await getCurrentGroupKey(groupId);
                if (current) {
                  const pool = await getAuthenticatedPool(identity);
                  await distributeGroupKey({
                    senderPrivkey: identity.sk, senderPubkey: identity.pk,
                    groupId, epoch: current.epoch, keyBytes: current.bytes,
                    recipients: [event.pubkey],
                    publish: async (dmEv) => {
                      const results = await Promise.allSettled(pool.publish(generalRelays, dmEv));
                      if (!results.some(r => r.status === 'fulfilled')) throw new Error('dm rejected');
                    },
                  });
                }
              }
            }
          } catch (e) {}
          if (isGkeyReq) return;

          let parsed = {};
          let plaintext = event.content;
          let isPending = false;
          let decEpoch = null;
          const decoded = await decodeGroupEvent({ event, groupId });
          if (decoded.pending) { isPending = true; decEpoch = decoded.epoch; }
          else if (decoded.error) { console.warn('[group-decrypt] failed', decoded.reason); return; }
          else { plaintext = decoded.plaintext; parsed = decoded.parsed || {}; decEpoch = decoded.epoch; }

          // Audit H9: drop already-expired group messages
          if (parsed.expires_at && Math.floor(Date.now() / 1000) >= parsed.expires_at) {
            return;
          }

          if (!isPending && parsed.type === 'typing') {
            const age = (Date.now() / 1000) - event.created_at;
            if (age < 10 && event.pubkey !== identity.pk) {
              setGroupTypingUsers(prev => ({ ...prev, [event.pubkey]: Date.now() }));
            }
            // Don't save typing events to Dexie (audit H6)
            return;
          }

          // Safety net: If a message comes from someone not in the list, add them
          if (event.pubkey !== identity.pk) {
            setGroupMembers(prev => {
              if (prev.findIndex(m => m.pubkey === event.pubkey) === -1) {
                return [...prev, { pubkey: event.pubkey, role: 'member' }];
              }
              return prev;
            });
          }

          const replyTag = event.tags.find(t => t[0] === 'e' && t[3] === 'reply');
          const clientId = event.tags.find(t => t[0] === 'client')?.[1];

          if (event.pubkey === identity.pk && clientId) {
            const optimisticMessage = await db.messages.where('clientId').equals(clientId).first();
            if (optimisticMessage?.chatId === groupId && optimisticMessage.isSender && optimisticMessage.id !== event.id) {
              await db.messages.delete(optimisticMessage.id);
            }
          }

          setGroupMessages(prev => {
            const groupMsgs = prev[groupId] || [];
            const existingIndex = groupMsgs.findIndex(m => {
              if (m.id === event.id) return true;
              if (clientId && event.pubkey === identity.pk && m.isSender && m.clientId === clientId) return true;
              if (m.isSender === (event.pubkey === identity.pk) && !isPending && parsed.message) {
                let oldData = {};
                try { oldData = JSON.parse(m.rawContent || '{}'); } catch(e) {}
                return oldData.message === parsed.message && Math.abs(m.timestamp - event.created_at) < 5;
              }
              return false;
            });

            const baseMsg = {
              id: event.id, clientId, isSender: event.pubkey === identity.pk,
              pubkey: event.pubkey, timestamp: event.created_at,
              deliveryStatus: event.pubkey === identity.pk ? 'sent' : undefined,
              local_timestamp: Date.now(),
              rawContent: isPending ? null : plaintext,
              ciphertext: isPending ? event.content : null,
              epoch: decEpoch, pending: isPending,
              replyTo: replyTag ? replyTag[1] : null, isGroup: true
            };

            if (existingIndex >= 0) {
              const newMsgs = [...groupMsgs];
              newMsgs[existingIndex] = { ...newMsgs[existingIndex], ...baseMsg };
              saveMessage(groupId, newMsgs[existingIndex]);
              return { ...prev, [groupId]: newMsgs };
            } else {
              saveMessage(groupId, baseMsg);
              if (event.pubkey !== identity.pk && !isPending && !shouldSuppressGroup(groupId)) {
                // Check if this is a reply to us or a mention of us
                const replyTag = event.tags.find(t => t[0] === 'e' && t[3] === 'reply');
                let isReplyToMe = false;
                let isMentioned = false;
                
                if (replyTag) {
                  const msgs = useChatStore.getState().groupMessages[groupId] || [];
                  const originalMsg = msgs.find(m => m.id === replyTag[1]);
                  isReplyToMe = originalMsg && originalMsg.isSender;
                }
                
                // Check for @mention of our username
                try {
                  const myProfile = useChatStore.getState().profiles[identity.pk];
                  const myUsername = myProfile?.name || myProfile?.username;
                  if (myUsername && parsed.message && parsed.message.includes('@' + myUsername)) {
                    isMentioned = true;
                  }
                } catch (e) {}
                
                if (isReplyToMe) {
                  showNotification(`💬 Reply in ${groupId.slice(0, 6)}`, parsed.message || 'Replied to you');
                } else if (isMentioned) {
                  showNotification(`📣 You were mentioned`, parsed.message || 'Mentioned you');
                } else {
                  showNotification('New Group Message', parsed.message || 'New attachment');
                }
              }
              return { ...prev, [groupId]: [...groupMsgs, baseMsg].sort(sortMessages) };
            }
          });
        }
        else if (msg[0] === 'CLOSED') {
          console.log('❌ Group WS closed:', msg[2]);
        }
      };

      if (keyHandler) window.removeEventListener('cipher:group-key-updated', keyHandler);
      keyHandler = async (e) => {
        const { groupId: gid } = e.detail;
        if (!groupIds.includes(gid)) return;
        try {
          const pool = await getAuthenticatedPool(identity);
          const events = await queryWithTimeout(pool, groupRelays, { kinds: [9], '#h': [gid], limit: 100 }, 4000);
          for (const event of events) {
            const decoded = await decodeGroupEvent({ event, groupId: gid });
            if (decoded.pending || decoded.error) continue;
            const parsed = decoded.parsed || {};
            if (parsed.type === 'typing') continue;
            const replyTag = event.tags.find(t => t[0] === 'e' && t[3] === 'reply');
            const clientId = event.tags.find(t => t[0] === 'client')?.[1];
            setGroupMessages(prev => {
              const groupMsgs = prev[gid] || [];
              const idx = groupMsgs.findIndex(m => m.id === event.id);
              const newMsg = {
                id: event.id, clientId, isSender: event.pubkey === identity.pk,
                pubkey: event.pubkey, timestamp: event.created_at,
                deliveryStatus: event.pubkey === identity.pk ? 'sent' : undefined,
                local_timestamp: Date.now(), rawContent: decoded.plaintext,
                epoch: decoded.epoch, pending: false,
                replyTo: replyTag ? replyTag[1] : null, isGroup: true,
              };
              if (idx >= 0) {
                const u = [...groupMsgs];
                u[idx] = { ...u[idx], ...newMsg };
                saveMessage(gid, u[idx]);
                return { ...prev, [gid]: u };
              }
              saveMessage(gid, newMsg);
              return { ...prev, [gid]: [...groupMsgs, newMsg].sort(sortMessages) };
            });
          }
        } catch (err) { console.warn('[group-key] refresh failed', err); }
      };
      window.addEventListener('cipher:group-key-updated', keyHandler);

      ws.onclose = (e) => {
        console.log('❌ Group WS closed:', e.reason);
        if (isMounted) reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = (e) => console.error('Group WS error:', e);
    };

    connect();

    return () => {
      isMounted = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (keyHandler) window.removeEventListener('cipher:group-key-updated', keyHandler);
      if (ws) ws.close();
    };
  }, [identity, setGroupMessages, setGroupTypingUsers]);

  const pinMessage = useCallback(async (groupId, messageEventId) => {
    const { finalizeEvent } = await import('nostr-tools');
    const pool = await getAuthenticatedPool(identity);
    const ev = finalizeEvent({
      kind: 9005,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId], ['e', messageEventId]],
      content: ''
    }, identity.sk);
    const results = await Promise.allSettled(pool.publish(groupRelays, ev));
    if (!results.some((result) => result.status === 'fulfilled')) {
      throw new Error('All group relays rejected the pin.');
    }
    setPinnedMessages(prev => ({ ...prev, [groupId]: messageEventId }));
    return { success: true };
  }, [identity?.pk, identity?.sk, setPinnedMessages]);

  const unpinMessage = useCallback(async (groupId) => {
    const { finalizeEvent } = await import('nostr-tools');
    const pool = await getAuthenticatedPool(identity);
    const ev = finalizeEvent({
      kind: 9005,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId]],
      content: 'unpin'
    }, identity.sk);
    const results = await Promise.allSettled(pool.publish(groupRelays, ev));
    if (!results.some((result) => result.status === 'fulfilled')) {
      throw new Error('All group relays rejected the unpin.');
    }
    setPinnedMessages(prev => ({ ...prev, [groupId]: null }));
    return { success: true };
  }, [identity?.pk, identity?.sk, setPinnedMessages]);

  const fetchPinnedMessage = useCallback(async (groupId) => {
    try {
      const pool = await getAuthenticatedPool(identity);
      const events = await queryWithTimeout(pool, groupRelays, { kinds: [9005], '#h': [groupId], limit: 10 }, 3000);
      if (events.length === 0) {
        setPinnedMessages(prev => ({ ...prev, [groupId]: null }));
        return null;
      }
      events.sort((a, b) => b.created_at - a.created_at);
      const eTag = events[0].tags.find(t => t[0] === 'e')?.[1];
      setPinnedMessages(prev => ({ ...prev, [groupId]: eTag || null }));
      return eTag || null;
    } catch (e) {
      return null;
    }
  }, [identity?.pk, identity?.sk, setPinnedMessages]);

  return {
    createGroup,
    joinGroupById,
    addMember,
    leaveGroup,
    sendGroupMessage,
    sendGroupTypingIndicator,
    requestGroupKey,
    kickMember,
    promoteMember,
    fetchGroupMembers,
    updateGroupSettings,
    subscribeToGroups,
    pinMessage,
    unpinMessage,
    fetchPinnedMessage,
  };
}
