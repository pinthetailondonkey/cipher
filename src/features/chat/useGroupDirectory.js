import { useCallback } from 'react';
import { db } from '../../db';
import { getMyGroups } from '../../lib/myGroups';
import { groupRelays, queryWithTimeout } from '../../lib/relays';
import { getAuthenticatedPool } from '../../lib/pool';
import { useChatStore } from '../../store/chatStore';
import { PENDING_JOIN, heldGroupRow, joinGroup, joinRefusal } from '../../lib/groupJoin';

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

export function useGroupDirectory({ identity, createGroupHook, setGroups }) {
  const setLoading = useChatStore((s) => s.setLoading);
  const setToast = useChatStore((s) => s.setToast);
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

  const joinGroupById = async (groupId, passedName = null, channel = false) => {
    if (!groupId) return;
    setLoading(true);
    try {
      const newGroupObj = await joinGroup(identity, groupId, { name: passedName, channel });
      // The store row obeys the same law as the saved one: a held row keeps
      // its name (drill residual).
      setGroups(prev => [
        heldGroupRow((prev || []).find((g) => g.id === newGroupObj.id), newGroupObj),
        ...((prev || []).filter((g) => g.id !== newGroupObj.id)),
      ]);
      // A join the relay has not confirmed is a request, not a room. The
      // chat is not opened, because opening it is what starts the reads the
      // relay would refuse; the row stays in the list carrying the state.
      if (newGroupObj.membership === 'pending') {
        setToast({ type: 'success', message: PENDING_JOIN });
        return;
      }
      openChat('group', newGroupObj.id, newGroupObj);
      setToast({ type: 'success', message: 'Joined group' });
    } catch (err) {
      console.error('[joinGroupById] error:', err);
      // The relay's own reason is machine text and never reaches the screen.
      setToast({ type: 'error', message: joinRefusal(err) });
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
      // A row the device holds is named by the device's records; a
      // directory rebuild restating relay metadata must not rename it.
      const held = new Map(localGroups.map((lg) => [lg.id, lg]));
      const allGroups = uniqueGroups.map((g) => heldGroupRow(held.get(g.id), g));
      localGroups.forEach((lg) => {
        if (!allGroups.find((g) => g.id === lg.id)) allGroups.push(lg);
      });
      setGroups(allGroups);
      return allGroups;
    } catch (e) { 
      console.error("[fetchGroups] failed:", e); 
      return []; 
    }
  };

  const createGroup = async (e, listed = true) => {
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
      const group = await createGroupHook(gName.trim(), gAbout.trim(), gChannel, { listed });
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
  return { markAsRead, openChat, joinGroupById, fetchGroups, createGroup };
}
