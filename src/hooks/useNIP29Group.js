import { useCallback, useEffect } from 'react';
import { finalizeEvent, nip19 } from 'nostr-tools';
import { db, saveMessage } from '../db';
import { showNotification } from '../lib/notifications';
import { useChatStore } from '../store/chatStore';
import { getAuthenticatedPool } from '../lib/pool';
import { groupRelays, generalRelays, queryWithTimeout } from '../lib/relays';
import { allowsTyping } from '../lib/privacy';
import { getMyGroups, setMyGroups } from '../lib/myGroups';
import { encodeGroupPayload, decodeGroupEvent } from '../lib/crypto/groupMessageCodec';
import { getAllGroupKeys, getCurrentGroupKey, putGroupKey } from '../lib/crypto/groupKeyStore';
import { authorizeGroupControl } from '../lib/crypto/groupMembership';
import { loadMemberSnapshot, patchMemberSnapshot, rememberMembers, requesterMayReceiveKey, rotateGroupEpoch } from '../lib/crypto/groupKeyRotation';
import { generateGroupKey } from '../lib/crypto/groupCipher';
import { distributeGroupKey } from '../lib/crypto/groupKeyDistribution';
import { enqueueNostrEvent, startOutboxSync } from '../lib/outbox';

const GROUP_RELAY_URL = 'wss://groups.aegispayhq.com';

async function publishKeyDm(identity, dmEvent) {
  const pool = await getAuthenticatedPool(identity);
  const results = await Promise.allSettled(pool.publish(generalRelays, dmEvent));
  if (!results.some((result) => result.status === 'fulfilled')) throw new Error('dm rejected');
}

function controlContext(groupId) {
  const state = useChatStore.getState();
  const group = (state.groups || []).find((item) => item.id === groupId)
    || (state.activeGroup?.id === groupId ? state.activeGroup : null);
  const live = state.activeGroup?.id === groupId ? state.groupMembers : null;
  return {
    creator: group?.creator || '',
    members: Array.isArray(live) && live.length ? live : (group?.members || []),
  };
}
const groupSessions = new Map();

export function parseGroupReference(value) {
  const raw = String(value || '').trim();
  if (!raw) return { id: '', relays: [], author: '' };
  if (/^naddr1/i.test(raw)) {
    try {
      const decoded = nip19.decode(raw);
      if (decoded?.type === 'naddr') {
        return {
          id: String(decoded.data?.identifier || '').trim(),
          relays: Array.isArray(decoded.data?.relays) ? decoded.data.relays : [],
          author: decoded.data?.pubkey || '',
          kind: decoded.data?.kind,
        };
      }
    } catch (error) {
      console.warn('[NIP29] naddr could not be decoded, keeping the raw value:', error);
    }
  }
  return { id: raw, relays: [], author: '' };
}

async function fetchGroupMetadata(identity, groupId) {
  const pool = await getAuthenticatedPool(identity);
  const [metadata, legacy] = await Promise.all([
    queryWithTimeout(pool, groupRelays, { kinds: [39000], '#d': [groupId], limit: 10 }, 4000).catch(() => []),
    queryWithTimeout(pool, groupRelays, { kinds: [9002], '#h': [groupId], limit: 10 }, 4000).catch(() => []),
  ]);
  const latest = [...metadata, ...legacy].sort((a, b) => (b.created_at || 0) - (a.created_at || 0))[0];
  if (!latest) return {};
  const tag = (name) => latest.tags?.find((item) => item[0] === name)?.[1] || '';
  let content = {};
  try { content = JSON.parse(latest.content || '{}'); } catch { content = {}; }
  return {
    name: tag('name') || content.name || content.display_name || '',
    about: tag('about') || content.about || '',
    picture: tag('picture') || content.picture || '',
    creator: latest.pubkey || '',
  };
}

function sameOutgoingMessage(message, event, identity, clientId) {
  if (!message) return false;
  if (message.id === event.id) return true;
  if (clientId && (message.id === clientId || message.clientId === clientId)) return true;
  return !!(
    message.isSender
    && event.pubkey === identity?.pk
    && String(message.id || '').startsWith('temp-')
    && Math.abs((message.timestamp || 0) - (event.created_at || 0)) <= 8
  );
}

function mergeGroupMessage(existing, incoming) {
  if (!existing) return incoming;
  const rawContent = incoming.rawContent || existing.rawContent || null;
  return {
    ...existing,
    ...incoming,
    clientId: incoming.clientId || existing.clientId,
    rawContent,
    pending: !rawContent && !!incoming.pending,
    deliveryStatus: incoming.deliveryStatus || existing.deliveryStatus || 'sent',
  };
}

function withGroupTag(groupId, tags = []) {
  return [['h', groupId], ...tags.filter((tag) => tag[0] !== 'h')];
}

export async function loadGroupProfile(identity, rawId, passedName = null) {
  const parsed = parseGroupReference(rawId);
  const groupId = parsed.id;
  if (!groupId) throw new Error('Missing group id');
  let meta = {};
  try { meta = await fetchGroupMetadata(identity, groupId); }
  catch (error) { console.warn('[NIP29] Group metadata lookup failed:', error); }
  const name = meta.name || (passedName && passedName !== 'Unnamed Group' ? passedName : '') || groupId.slice(0, 12);
  return {
    id: groupId,
    name,
    about: meta.about || '',
    picture: meta.picture || '',
    isChannel: false,
    creator: meta.creator || parsed.author || '',
  };
}

function rejectAuthWaiters(session, error) {
  const pending = session.authWaiters.splice(0);
  pending.forEach((waiter) => waiter.reject(error));
}

function flushGroupSubs(session) {
  if (session.ws?.readyState !== WebSocket.OPEN) return;
  for (const [subId, filter] of session.subs) {
    session.ws.send(JSON.stringify(['REQ', subId, filter]));
  }
}

function markGroupAuthed(session) {
  session.authed = true;
  flushGroupSubs(session);
  const pending = session.authWaiters.splice(0);
  pending.forEach((waiter) => waiter.resolve());
}

function sendAuthResponse(session, challenge) {
  if (!challenge || !session.identity?.sk || session.authSent) return;
  const authEvent = finalizeEvent({
    kind: 22242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['relay', GROUP_RELAY_URL],
      ['challenge', challenge],
    ],
    content: '',
  }, session.identity.sk);
  session.authEventId = authEvent.id;
  session.authSent = true;
  session.ws.send(JSON.stringify(['AUTH', authEvent]));
}

function handleGroupSocketFrame(session, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (error) {
    console.warn('[NIP29] Ignoring malformed group relay frame:', error);
    return;
  }

  if (msg[0] === 'AUTH') {
    const challenge = typeof msg[1] === 'string' ? msg[1] : msg[1]?.challenge;
    try {
      sendAuthResponse(session, challenge);
    } catch (error) {
      console.error('[NIP29] Failed to authenticate group relay:', error);
      rejectAuthWaiters(session, error);
    }
    return;
  }

  if (msg[0] === 'OK') {
    const eventId = msg[1];
    const accepted = msg[2] === true;
    const reason = msg[3] || '';
    if (eventId && eventId === session.authEventId) {
      if (accepted) markGroupAuthed(session);
      else {
        session.authSent = false;
        console.error('[NIP29] Group relay rejected NIP-42 authentication:', reason);
        rejectAuthWaiters(session, new Error(reason || 'AUTH rejected'));
      }
      return;
    }
    const waiter = session.okWaiters.get(eventId);
    if (waiter) {
      session.okWaiters.delete(eventId);
      clearTimeout(waiter.timer);
      if (accepted) waiter.resolve(msg);
      else waiter.reject(new Error(reason || 'relay rejected event'));
    }
  }

  for (const listener of session.listeners) {
    try { listener(msg); } catch (error) { console.error('[NIP29] Group frame listener failed:', error); }
  }
}

function connectGroupSocket(session) {
  if (session.closed) return;
  session.authed = false;
  session.authSent = false;
  session.authEventId = null;
  const ws = new WebSocket(GROUP_RELAY_URL);
  session.ws = ws;

  ws.onopen = () => {
    session.attempt = 0;
    console.log('✅ Group WS connected');
    window.dispatchEvent(new CustomEvent('cipher:relay-connected', { detail: { url: GROUP_RELAY_URL } }));
  };

  ws.onmessage = (event) => handleGroupSocketFrame(session, event.data);

  ws.onerror = (event) => console.error('Group WS error:', event);

  ws.onclose = (event) => {
    console.log('❌ Group WS closed:', event.reason || event.code);
    session.authed = false;
    session.authSent = false;
    rejectAuthWaiters(session, new Error('Group relay socket closed'));
    for (const [eventId, waiter] of session.okWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Group relay socket closed'));
      session.okWaiters.delete(eventId);
    }
    if (!session.closed) {
      const attempt = session.attempt || 0;
      session.attempt = attempt + 1;
      const delay = Math.min(30000, 1000 * (2 ** Math.min(attempt, 5)));
      session.reconnectTimer = setTimeout(() => connectGroupSocket(session), delay);
    }
  };
}

export function closeGroupSessions() {
  for (const session of groupSessions.values()) {
    session.closed = true;
    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);
    try { session.ws?.close(); } catch {}
    rejectAuthWaiters(session, new Error('Signed out'));
    for (const waiter of session.okWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('Signed out'));
    }
    session.okWaiters.clear();
    session.listeners.clear();
    session.subs.clear();
  }
  groupSessions.clear();
}

function openGroupRelaySession(identity) {
  if (!identity?.pk || !identity?.sk) throw new Error('Group relay requires a signed-in key');
  const existing = groupSessions.get(identity.pk);
  if (existing && !existing.closed) {
    existing.identity = identity;
    return existing;
  }

  const session = {
    identity,
    ws: null,
    authed: false,
    authSent: false,
    authEventId: null,
    closed: false,
    reconnectTimer: null,
    authWaiters: [],
    okWaiters: new Map(),
    subs: new Map(),
    listeners: new Set(),
  };
  groupSessions.set(identity.pk, session);
  connectGroupSocket(session);
  return session;
}

function whenGroupAuthed(session) {
  if (session.authed && session.ws?.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve: () => { clearTimeout(waiter.timer); resolve(); },
      reject: (error) => { clearTimeout(waiter.timer); reject(error); },
    };
    waiter.timer = setTimeout(() => {
      const index = session.authWaiters.indexOf(waiter);
      if (index !== -1) session.authWaiters.splice(index, 1);
      reject(new Error('Group relay AUTH timed out'));
    }, 12000);
    session.authWaiters.push(waiter);
  });
}

async function publishAuthedGroupEvent(identity, event) {
  const session = openGroupRelaySession(identity);
  await whenGroupAuthed(session);
  if (!event.tags?.some((tag) => tag[0] === 'h' && tag[1])) {
    throw new Error('Group event is missing the h tag');
  }
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      session.okWaiters.delete(event.id);
      reject(new Error('Group relay OK timed out'));
    }, 12000);
    session.okWaiters.set(event.id, { resolve, reject, timer });
    try {
      session.ws.send(JSON.stringify(['EVENT', event]));
    } catch (error) {
      clearTimeout(timer);
      session.okWaiters.delete(event.id);
      reject(error);
    }
  });
  return event;
}

const shouldSuppressGroup = (groupId) => {
  const state = useChatStore.getState();
  const mutedUntil = state.mutedUntil?.[groupId];
  const isMuted = mutedUntil === 'forever' || (mutedUntil && mutedUntil > Date.now());
  const isArchived = state.archivedChats?.includes(groupId);
  return isMuted || isArchived;
};

export function useNIP29Group({ identity }) {
  const setGroupsStore = useChatStore((s) => s.setGroups);
  const setGroups = useCallback((val) => {
    setGroupsStore((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      const myGroupIds = new Set(getMyGroups(identity?.pk).map(g => g.id));
      return (Array.isArray(next) ? next : []).filter(g => myGroupIds.has(g.id));
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

  const createGroup = useCallback(async (name, about, isChannel) => {
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
          publish: (dmEvent) => publishKeyDm(identity, dmEvent),
        });
        await rememberMembers(groupId, [identity.pk]);
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
  }, [identity, setGroups, appendSystemMessage]);

  const joinGroupById = useCallback(async (groupId, passedName = null) => {
    const profile = await loadGroupProfile(identity, groupId, passedName);
    if (!profile.id) return;
    const newGroup = { ...profile };
    const localGroups = getMyGroups(identity.pk);
    const idx = localGroups.findIndex(g => g.id === newGroup.id);
    if (idx === -1) localGroups.push(newGroup);
    else localGroups[idx] = { ...localGroups[idx], ...newGroup };
    setMyGroups(identity.pk, localGroups);
    setGroups(prev => [newGroup, ...(prev || []).filter(g => g.id !== newGroup.id)]);
    const active = useChatStore.getState().activeGroup;
    if (active?.id === newGroup.id) useChatStore.getState().setActiveGroup({ ...active, ...newGroup });
    return newGroup;
  }, [identity, setGroups]);

  const leaveGroup = useCallback(async (groupId) => {
    const pool = await getAuthenticatedPool(identity);
    const known = useChatStore.getState().groupMembers || [];
    const remaining = known.map((member) => member.pubkey).filter((pubkey) => pubkey && pubkey !== identity.pk);
    try {
      const rotation = await rotateGroupEpoch({
        identity,
        groupId,
        remainingPubkeys: remaining,
        publish: (dmEvent) => publishKeyDm(identity, dmEvent),
      });
      if (!rotation?.rotated) await rememberMembers(groupId, remaining);
    } catch (error) {
      console.error('[group-key] Could not rotate the key after a member left:', error);
      try { await rememberMembers(groupId, remaining); } catch (snapshotError) {
        console.error('[group-key] Could not update the membership snapshot:', snapshotError);
      }
    }
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
  }, [identity, setGroups, appendSystemMessage]);

  const sendGroupMessage = useCallback(async (groupId, payload, clientId = null, replyId = null) => {
    try {
      const encoded = await encodeGroupPayload({ groupId, payload, senderPubkey: identity.pk, waitForKey: true });
      if (encoded.pending) {
        try {
          const reqEvent = finalizeEvent({
            kind: 9,
            created_at: Math.floor(Date.now() / 1000),
            tags: withGroupTag(groupId),
            content: JSON.stringify({ type: 'gkey_req' }),
          }, identity.sk);
          await publishAuthedGroupEvent(identity, reqEvent);
        } catch (error) {
          console.error('[NIP29] Failed to request a group key:', error);
        }
        return { success: false, error: 'NO_KEY' };
      }
      const tags = withGroupTag(groupId, encoded.tags);
      if (clientId) tags.push(['client', clientId]);
      if (replyId) tags.push(['e', replyId, '', 'reply']);
      const event = finalizeEvent({
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags,
        content: encoded.content,
      }, identity.sk);
      try {
        await publishAuthedGroupEvent(identity, event);
        return { success: true, event, relayCount: 1 };
      } catch (error) {
        console.warn('[NIP29] Group relay did not accept the message after AUTH:', error);
        await enqueueNostrEvent(event);
        return { success: true, queued: true, event, relayCount: 0 };
      }
    } catch (error) {
      console.error('[NIP29] Failed to send group message:', error);
      return { success: false, error: error?.message || 'Group message failed' };
    }
  }, [identity]);

  const requestGroupKey = useCallback(async (groupId) => {
    try {
      const ev = finalizeEvent({
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags: withGroupTag(groupId),
        content: JSON.stringify({ type: 'gkey_req' }),
      }, identity.sk);
      await publishAuthedGroupEvent(identity, ev);
    } catch (e) {}
  }, [identity]);

  const sendGroupTypingIndicator = useCallback(async (groupId) => {
    if (!allowsTyping()) return;
    try {
      const encoded = await encodeGroupPayload({ groupId, payload: { type: 'typing' }, senderPubkey: identity.pk });
      if (encoded.pending) return;
      const ev = finalizeEvent({
        kind: 9,
        created_at: Math.floor(Date.now() / 1000),
        tags: withGroupTag(groupId, encoded.tags),
        content: encoded.content,
      }, identity.sk);
      await publishAuthedGroupEvent(identity, ev);
    } catch (e) {}
  }, [identity]);

  const kickMember = useCallback(async (groupId, memberPubkey) => {
    const pool = await getAuthenticatedPool(identity);
    const allMembers = useChatStore.getState().groupMembers || [];
    const remaining = allMembers.filter(m => m.pubkey !== memberPubkey).map(m => m.pubkey);
    if (!remaining.includes(identity.pk)) remaining.push(identity.pk);
    try {
      const rotation = await rotateGroupEpoch({
        identity,
        groupId,
        remainingPubkeys: remaining,
        publish: (dmEvent) => publishKeyDm(identity, dmEvent),
      });
      if (!rotation?.rotated) await rememberMembers(groupId, remaining);
    } catch (error) {
      console.error('[group-key] Could not rotate the key after a kick:', error);
      try { await rememberMembers(groupId, remaining); } catch (snapshotError) {
        console.error('[group-key] Could not update the membership snapshot:', snapshotError);
      }
    }
    const ev = finalizeEvent({
      kind: 9001, created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId], ['p', memberPubkey]], content: ''
    }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, ev));
    setGroupMembers(prev => prev.filter(m => m.pubkey !== memberPubkey));
    appendSystemMessage(groupId, `User ${memberPubkey.slice(0, 6)}... was kicked from the group`, ev.id);
  }, [identity, setGroupMembers, appendSystemMessage]);

  const promoteMember = useCallback(async (groupId, memberPubkey, isAdmin) => {
    const pool = await getAuthenticatedPool(identity);
    const ev = finalizeEvent({
      kind: 9000, created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId], ['p', memberPubkey], ['role', isAdmin ? 'member' : 'admin']],
      content: ''
    }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, ev));
    setGroupMembers(prev => prev.map(m => m.pubkey === memberPubkey ? { ...m, role: isAdmin ? 'member' : 'admin' } : m));
    appendSystemMessage(groupId, `User ${memberPubkey.slice(0, 6)}... was ${isAdmin ? 'demoted to member' : 'promoted to admin'}`, ev.id);
  }, [identity, setGroupMembers, appendSystemMessage]);

  const addMember = useCallback(async (groupId, memberPubkey) => {
    const pool = await getAuthenticatedPool(identity);
    const ev = finalizeEvent({
      kind: 9000, created_at: Math.floor(Date.now() / 1000),
      tags: [['h', groupId], ['p', memberPubkey]], content: ''
    }, identity.sk);
    await Promise.allSettled(pool.publish(groupRelays, ev));
    const snapshot = await loadMemberSnapshot(groupId);
    await rememberMembers(groupId, [...new Set([...(snapshot || []), memberPubkey, identity.pk])]);
    appendSystemMessage(groupId, `User ${memberPubkey.slice(0, 6)}... was added to the group`, ev.id);
    setGroupMembers(prev => {
      if (prev.findIndex(x => x.pubkey === memberPubkey) === -1) {
        return [...prev, { pubkey: memberPubkey, role: 'member' }];
      }
      return prev;
    });
  }, [identity, setGroupMembers, appendSystemMessage]);

  const updateGroupSettings = useCallback(async (groupId, updates) => {
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
    setGroups(prev => prev.map(g => g.id === groupId ? { ...g, ...updates } : g));
    if (updates.name) appendSystemMessage(groupId, `Group name changed to "${updates.name}"`, ev.id);
    else if (updates.avatar) appendSystemMessage(groupId, 'Group photo was updated', ev.id);
    else if (updates.requireApproval !== undefined) appendSystemMessage(groupId, updates.requireApproval ? 'Joining this group now requires admin approval' : 'This group is now open to join', ev.id);
    else if (updates.about !== undefined) appendSystemMessage(groupId, 'Group description was updated', ev.id);
    return { success: true };
  }, [identity, setGroups, appendSystemMessage]);

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
  }, [identity?.pk, identity?.sk, activeGroup?.creator, setGroupMembers]);

  const subscribeToGroups = useCallback((groupIds, since) => {
    if (!groupIds || groupIds.length === 0 || !identity?.sk) return () => {};
    const session = openGroupRelaySession(identity);
    const subId = `group-sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const filter = { kinds: [9], '#h': [...groupIds] };
    if (Number.isFinite(since)) filter.since = since;
    session.subs.set(subId, filter);
    if (session.authed && session.ws?.readyState === WebSocket.OPEN) {
      session.ws.send(JSON.stringify(['REQ', subId, filter]));
    }

    let keyHandler = null;

    const onFrame = async (msg) => {
      if (msg[0] === 'CLOSED' && msg[1] === subId) {
        console.log('❌ Group subscription closed:', msg[2]);
        return;
      }
      if (msg[0] !== 'EVENT' || msg[1] !== subId) return;
      const event = msg[2];
      if (!event?.tags) return;
      const hTag = event.tags.find(t => t[0] === 'h');
      if (!hTag?.[1]) return;
      const groupId = hTag[1];
      if (!groupIds.includes(groupId)) return;
      if ([9000, 9001, 9002, 9021, 9022, 39002].includes(event.kind)) {
        const { creator, members } = controlContext(groupId);
        const subject = event.kind === 9021 || event.kind === 9022
          ? event.pubkey
          : (event.tags.find((tag) => tag[0] === 'p')?.[1] || event.pubkey);
        if (!authorizeGroupControl({ kind: event.kind, sender: event.pubkey, subject, members, creator })) {
          console.warn('[group] Ignored an unauthorized membership event', event.kind, event.id);
          return;
        }
      }

      if (event.kind === 9021) {
        const pk = event.pubkey;
        await patchMemberSnapshot(groupId, (members) => (members.includes(pk) ? members : [...members, pk]));
        if (useChatStore.getState().activeGroup?.id === groupId) {
          setGroupMembers(prev => {
            const updated = Array.isArray(prev) ? [...prev] : [];
            if (updated.findIndex(m => m.pubkey === pk) === -1) updated.push({ pubkey: pk, role: 'member' });
            return updated;
          });
        }
        if (pk !== identity.pk) appendSystemMessage(groupId, `User ${pk.slice(0, 6)}... joined the group`, event.id);
        return;
      }
      if (event.kind === 9022) {
        const pk = event.pubkey;
        await patchMemberSnapshot(groupId, (members) => members.filter((member) => member !== pk));
        if (useChatStore.getState().activeGroup?.id === groupId) {
          setGroupMembers(prev => Array.isArray(prev) ? prev.filter(m => m.pubkey !== pk) : []);
        }
        appendSystemMessage(groupId, `User ${pk.slice(0, 6)}... left the group`, event.id);
        return;
      }
      if (event.kind === 9000) {
        const pk = event.tags.find(t => t[0] === 'p')?.[1];
        const role = event.tags.find(t => t[0] === 'role')?.[1] || 'member';
        if (pk) await patchMemberSnapshot(groupId, (members) => (members.includes(pk) ? members : [...members, pk]));
        if (useChatStore.getState().activeGroup?.id === groupId) {
          setGroupMembers(prev => {
            const updated = Array.isArray(prev) ? [...prev] : [];
            const idx = updated.findIndex(m => m.pubkey === pk);
            if (idx !== -1) updated[idx] = { ...updated[idx], role };
            else updated.push({ pubkey: pk, role });
            return updated;
          });
        }
        appendSystemMessage(groupId, `User ${pk.slice(0, 6)}... was ${role === 'admin' ? 'promoted to admin' : 'demoted to member'}`, event.id);
        return;
      }
      if (event.kind === 9001) {
        const pk = event.tags.find(t => t[0] === 'p')?.[1];
        if (pk) await patchMemberSnapshot(groupId, (members) => members.filter((member) => member !== pk));
        if (useChatStore.getState().activeGroup?.id === groupId) {
          setGroupMembers(prev => Array.isArray(prev) ? prev.filter(m => m.pubkey !== pk) : []);
        }
        appendSystemMessage(groupId, `User ${pk.slice(0, 6)}... was kicked from the group`, event.id);
        return;
      }
      if (event.kind === 9002) {
        const name = event.tags.find(t => t[0] === 'name')?.[1];
        const about = event.tags.find(t => t[0] === 'about')?.[1];
        if (name) appendSystemMessage(groupId, `Group name was changed to "${name}"`, event.id);
        else if (about) appendSystemMessage(groupId, 'Group description was updated', event.id);
        return;
      }
      if (event.kind === 39002) {
        const members = event.tags.filter(x => x[0] === 'p').map(x => ({ pubkey: x[1], role: x[2] || 'member' }));
        if (!members.find(x => x.pubkey === identity.pk)) members.push({ pubkey: identity.pk, role: 'member' });
        await rememberMembers(groupId, members.map((member) => member.pubkey));
        if (useChatStore.getState().activeGroup?.id === groupId) setGroupMembers(members);
        return;
      }
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
      if (event.kind !== 9) return;

      const blocked = useChatStore.getState().blockedUsers || [];
      if (blocked.includes(event.pubkey) && event.pubkey !== identity.pk) return;

      let isGkeyReq = false;
      try {
        const parsedQuick = JSON.parse(event.content);
        if (parsedQuick.type === 'gkey_req') {
          isGkeyReq = true;
          if (event.pubkey !== identity.pk) {
            const snapshot = await loadMemberSnapshot(groupId);
            if (!requesterMayReceiveKey(snapshot, event.pubkey)) return;
            const current = await getCurrentGroupKey(groupId);
            if (current) {
              const prior = (await getAllGroupKeys(groupId)).filter((epoch) => epoch.epoch !== current.epoch);
              await distributeGroupKey({
                senderPrivkey: identity.sk, senderPubkey: identity.pk,
                groupId, epoch: current.epoch, keyBytes: current.bytes,
                recipients: [event.pubkey],
                extraEpochs: prior,
                publish: (dmEvent) => publishKeyDm(identity, dmEvent),
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
      else if (decoded.error) {
        console.warn('[group-decrypt] failed', decoded.reason);
        plaintext = typeof event.content === 'string' ? event.content : '';
        parsed = { type: 'text', message: plaintext || 'Message unavailable' };
      }
      else { plaintext = decoded.plaintext; parsed = decoded.parsed || {}; decEpoch = decoded.epoch; }
      if (!parsed || typeof parsed !== 'object') parsed = { type: 'text', message: typeof plaintext === 'string' ? plaintext : '' };

      if (parsed.expires_at && Math.floor(Date.now() / 1000) >= parsed.expires_at) return;

      if (!isPending && parsed.type === 'typing') {
        const age = (Date.now() / 1000) - event.created_at;
        if (age < 10 && event.pubkey !== identity.pk) {
          setGroupTypingUsers(prev => ({ ...prev, [event.pubkey]: Date.now() }));
        }
        return;
      }

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
        const existingIndex = groupMsgs.findIndex((m) => sameOutgoingMessage(m, event, identity, clientId));

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
          newMsgs[existingIndex] = mergeGroupMessage(newMsgs[existingIndex], baseMsg);
          saveMessage(groupId, newMsgs[existingIndex]);
          return { ...prev, [groupId]: newMsgs };
        }
        saveMessage(groupId, baseMsg);
        if (event.pubkey !== identity.pk && !isPending && !shouldSuppressGroup(groupId)) {
          let isReplyToMe = false;
          let isMentioned = false;
          if (replyTag) {
            const msgs = useChatStore.getState().groupMessages[groupId] || [];
            const originalMsg = msgs.find(m => m.id === replyTag[1]);
            isReplyToMe = originalMsg && originalMsg.isSender;
          }
          try {
            const myProfile = useChatStore.getState().profiles[identity.pk];
            const myUsername = myProfile?.name || myProfile?.username;
            if (myUsername && parsed.message && parsed.message.includes('@' + myUsername)) isMentioned = true;
          } catch (e) {}
          if (isReplyToMe) showNotification(`💬 Reply in ${groupId.slice(0, 6)}`, parsed.message || 'Replied to you');
          else if (isMentioned) showNotification('📣 You were mentioned', parsed.message || 'Mentioned you');
          else showNotification('New Group Message', parsed.message || 'New attachment');
        }
        return { ...prev, [groupId]: [...groupMsgs, baseMsg].sort(sortMessages) };
      });
    };

    session.listeners.add(onFrame);

    keyHandler = async (e) => {
      const { groupId: gid } = e.detail || {};
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
            const idx = groupMsgs.findIndex((m) => sameOutgoingMessage(m, event, identity, clientId));
            const newMsg = {
              id: event.id, clientId, isSender: event.pubkey === identity.pk,
              pubkey: event.pubkey, timestamp: event.created_at,
              deliveryStatus: event.pubkey === identity.pk ? 'sent' : undefined,
              local_timestamp: Date.now(), rawContent: decoded.plaintext,
              epoch: decoded.epoch, pending: false,
              replyTo: replyTag ? replyTag[1] : null, isGroup: true,
            };
            if (idx >= 0) {
              const updated = [...groupMsgs];
              updated[idx] = mergeGroupMessage(updated[idx], newMsg);
              saveMessage(gid, updated[idx]);
              return { ...prev, [gid]: updated };
            }
            saveMessage(gid, newMsg);
            return { ...prev, [gid]: [...groupMsgs, newMsg].sort(sortMessages) };
          });
        }
      } catch (err) { console.warn('[group-key] refresh failed', err); }
    };
    window.addEventListener('cipher:group-key-updated', keyHandler);

    return () => {
      session.listeners.delete(onFrame);
      session.subs.delete(subId);
      if (session.ws?.readyState === WebSocket.OPEN) {
        try { session.ws.send(JSON.stringify(['CLOSE', subId])); } catch (e) {}
      }
      if (keyHandler) window.removeEventListener('cipher:group-key-updated', keyHandler);
    };
  }, [identity, setGroupMessages, setGroupTypingUsers, setGroupMembers, appendSystemMessage]);

  const pinMessage = useCallback(async (groupId, messageEventId) => {
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

