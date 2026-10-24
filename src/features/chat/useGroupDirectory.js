import { useCallback } from 'react';
import { db } from '../../db';
import { getMyGroups, setMyGroups } from '../../lib/myGroups';
import { groupRelays, queryWithTimeout } from '../../lib/relays';
import { getAuthenticatedPool } from '../../lib/pool';
import { useChatStore } from '../../store/chatStore';
import { parseGroupReference, loadGroupProfile } from '../../hooks/useNIP29Group';

export function useMyGroups(pubkey) {
  const setGroupsStore = useChatStore((s) => s.setGroups);
  return useCallback((val) => {
    setGroupsStore((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      const myGroupsRaw = localStorage.getItem('cipher_my_groups_' + pubkey?.slice(0, 16));
      const myGroupIds = new Set(myGroupsRaw ? JSON.parse(myGroupsRaw).map((g) => g.id) : []);
      return (next || []).filter((g) => myGroupIds.has(g.id));
    });
  }, [pubkey, setGroupsStore]);
}

export function useGroupDirectory({ identity, sendDM, createGroupHook, setGroups }) {
  const setLoading = useChatStore((s) => s.setLoading);
  const setToast = useChatStore((s) => s.setToast);
  const profiles = useChatStore((s) => s.profiles);
  const setUnreadCounts = useChatStore((s) => s.setUnreadCounts);
  const setTypingUsers = useChatStore((s) => s.setTypingUsers);
  const setGroupTypingUsers = useChatStore((s) => s.setGroupTypingUsers);
  const setActiveDm = useChatStore((s) => s.setActiveDm);
  const setActiveGroup = useChatStore((s) => s.setActiveGroup);
  const setView = useChatStore((s) => s.setView);

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
    try {
      const parsed = parseGroupReference(groupId);
      const resolvedId = parsed.id;
      if (!resolvedId) throw new Error('That group address could not be read.');
      const profile = await loadGroupProfile(identity, resolvedId, passedName);
      const newGroupObj = { ...profile, isChannel: !!(channel || profile.isChannel) };
      const localGroups = getMyGroups(identity.pk);
      const idx = localGroups.findIndex(g => g.id === newGroupObj.id);
      if (idx === -1) localGroups.push(newGroupObj);
      else localGroups[idx] = { ...localGroups[idx], ...newGroupObj };
      setMyGroups(identity.pk, localGroups);
      setGroups(prev => [newGroupObj, ...(prev || []).filter(g => g.id !== newGroupObj.id)]);
      openChat('group', newGroupObj.id, newGroupObj);
      setToast({ type: 'success', message: 'Joined group' });
    } catch (err) {
      console.error('[joinGroupById] error:', err);
      setToast({ type: 'error', message: err?.message || 'Could not join that group.' });
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
  return { markAsRead, openChat, requestToJoinGroup, joinGroupById, fetchGroups, createGroup };
}
