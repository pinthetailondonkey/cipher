import React, { useEffect, useRef, useState } from 'react';
import { Archive, ArchiveRestore, Bell, BellOff, MoreVertical } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import Avatar from '../ui/Avatar';
import { pressable } from '../ui/Button';
import { noHexName } from '../../lib/npub';

// The anchor's segmented filter: All / Menus / Vendors. A client-side filter
// over the same list — the drawer stays navigation, this only narrows rows.
// A menu is a channel-type space; a vendor is a chat where commerce happened
// (an order crossed it, or the peer sent a product — their storefront
// speaking in the thread). The store carries no per-peer vendor flag.
const SEGMENTS = [
  { key: 'all', label: 'All' },
  { key: 'menus', label: 'Menus' },
  { key: 'vendors', label: 'Vendors' },
];

const initialsOf = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2)
  .map((word) => word[0].toUpperCase()).join('') || '?';

// One row = one tap target plus a kebab (mute / archive, persisted by the
// store). The preview line is blurred until the row is long-pressed; the
// reveal holds until you leave the list — opening a chat unmounts this
// component, which resets it.
export default function ChatList({ onOpenChat }) {
  const dms = useChatStore((s) => s.dms);
  const groups = useChatStore((s) => s.groups);
  const groupMessages = useChatStore((s) => s.groupMessages);
  const profiles = useChatStore((s) => s.profiles);
  const unreadCounts = useChatStore((s) => s.unreadCounts);
  const mutedChats = useChatStore((s) => s.mutedChats);
  const mutedUntil = useChatStore((s) => s.mutedUntil);
  const archivedChats = useChatStore((s) => s.archivedChats);
  const typingUsers = useChatStore((s) => s.typingUsers);
  const groupTypingUsers = useChatStore((s) => s.groupTypingUsers);

  const [segment, setSegment] = useState('all');
  const [revealed, setRevealed] = useState(() => new Set());
  const [menuFor, setMenuFor] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const pressTimer = useRef(null);
  const suppressClick = useRef(false);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  const startPress = (id) => {
    cancelPress();
    suppressClick.current = false;
    pressTimer.current = window.setTimeout(() => {
      suppressClick.current = true;
      setRevealed((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }, 450);
  };
  const cancelPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  const open = (type, id, group) => {
    setRevealed(new Set());
    onOpenChat(type, id, group);
  };
  const isMuted = (id) => mutedChats.includes(id)
    || mutedUntil[id] === 'forever'
    || (typeof mutedUntil[id] === 'number' && mutedUntil[id] > now);

  const dmList = Object.entries(dms).map(([pubkey, msgs]) => {
    const profile = profiles[pubkey];
    const safeProfile = (profile && profile.name && !/^[0-9a-f]{8,64}$/i.test(profile.name))
      ? profile
      : { displayName: noHexName(profile, pubkey), picture: null, name: noHexName(profile, pubkey) };
    const commercial = msgs.some((m) => m.data?.type === 'cipher_order' || m.data?.type === 'order_request' || m.data?.type === 'product');
    return { type: 'dm', id: pubkey, lastMsg: msgs[msgs.length - 1], profile: safeProfile, vendor: commercial };
  });

  const groupList = groups.map(g => ({
    type: 'group',
    id: g.id,
    group: g,
    menu: g.isChannel === true,
    lastMsg: groupMessages[g.id]?.[groupMessages[g.id].length - 1]
  }));

  const chatMap = new Map();
  [...dmList, ...groupList].forEach(c => chatMap.set(c.id, c));

  const allChats = Array.from(chatMap.values()).sort(
    (a, b) => (b.lastMsg?.timestamp || 0) - (a.lastMsg?.timestamp || 0)
  );

  // Typing state, per row: DMs key by the peer, group typing is one set for
  // every group (the store keys it by member), so it lights any group row.
  const typingFor = (chat) => {
    const fresh = (stamp) => stamp && now - stamp < 6000;
    if (chat.type === 'dm') return fresh(typingUsers[chat.id]);
    return Object.values(groupTypingUsers || {}).some(fresh);
  };

  const previewOf = (chat) => {
    const m = chat.lastMsg;
    if (!m) return null;
    const text = m.data?.type === 'cipher_order' ? 'Order'
      : m.data?.type === 'image' ? 'Photo'
      : m.data?.type === 'audio' ? 'Voice note'
      : (m.data?.message || m.rawContent || 'Message');
    if (chat.type === 'group' && m.pubkey) {
      const sender = m.isSender ? 'You' : noHexName(profiles[m.pubkey], m.pubkey);
      return `${sender}: ${text}`;
    }
    return text;
  };

  if (allChats.length === 0) {
    return <p className="mx-4 mt-6 rounded-2xl border border-line bg-panel px-4 py-10 text-center text-[13px] text-inkMuted">No chats yet. Tap + to start.</p>;
  }

  const active = allChats.filter(c => !archivedChats.includes(c.id));
  const archived = allChats.filter(c => archivedChats.includes(c.id));
  const shownChats = active.filter((chat) => {
    if (segment === 'menus') return chat.type === 'group' && chat.menu === true;
    if (segment === 'vendors') return chat.vendor === true;
    return true;
  });

  const renderRow = (chat) => {
    const isDm = chat.type === 'dm';
    const name = isDm
      ? chat.profile.displayName
      : (chat.group.name && !chat.group.name.startsWith('Group ') ? chat.group.name : 'Unnamed Group');
    const previewText = previewOf(chat);
    const isRevealed = revealed.has(chat.id);
    const unread = unreadCounts[chat.id] || 0;
    const typing = typingFor(chat);

    return (
      <div key={chat.id} className="relative flex items-stretch border-b border-line last:border-0">
        <button
          type="button"
          onClick={() => {
            if (suppressClick.current) { suppressClick.current = false; return; }
            open(chat.type, chat.id, chat.group);
          }}
          onPointerDown={() => startPress(chat.id)}
          onPointerUp={cancelPress}
          onPointerLeave={cancelPress}
          onPointerCancel={cancelPress}
          onContextMenu={(e) => e.preventDefault()}
          className={`flex min-h-[64px] min-w-0 flex-1 items-center gap-3 px-4 py-2 text-left active:bg-ink/5 ${pressable}`}
        >
          {isDm ? (
            <Avatar src={chat.profile.picture} name={name} className="!h-10 !w-10 !text-[13px]" />
          ) : (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-panelAlt text-[13px] font-semibold text-accentText">
              {initialsOf(name)}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[15px] font-semibold text-ink">{name}</span>
              {chat.lastMsg?.timestamp && (
                <span className="shrink-0 text-[11px] font-medium text-inkSubtle">
                  {new Date(chat.lastMsg.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </span>
            <span className="mt-0.5 flex items-center justify-between gap-2">
              <span
                className={`block truncate text-[13px] transition-all duration-200 select-none ${typing ? 'text-accentText' : 'text-inkMuted'} ${previewText && !isRevealed ? 'blur-[5px]' : ''}`}
              >
                {typing ? 'typing…' : (previewText || (isDm ? 'Tap to chat' : (chat.group.isChannel ? 'Channel' : 'Public group')))}
              </span>
              {unread > 0 ? (
                <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accentInk">
                  {unread}
                </span>
              ) : (isMuted(chat.id) && <BellOff size={13} className="shrink-0 text-inkSubtle" />)}
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-label="Chat options"
          onClick={() => setMenuFor(menuFor === chat.id ? null : chat.id)}
          className="flex w-11 shrink-0 items-center justify-center text-inkMuted hover:text-ink active:bg-ink/5"
        >
          <MoreVertical size={16} />
        </button>
        {menuFor === chat.id && (
          <>
            <button type="button" aria-label="Close options" onClick={() => setMenuFor(null)} className="fixed inset-0 z-10 cursor-default" />
            <div className="absolute right-2 top-2 z-20 w-40 overflow-hidden rounded-xl border border-lineStrong bg-panelStrong">
              <button
                type="button"
                onClick={() => { useChatStore.getState().toggleMuteChat(chat.id); setMenuFor(null); }}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[14px] font-medium text-ink active:bg-ink/5"
              >
                {isMuted(chat.id) ? <BellOff size={14} className="text-inkMuted" /> : <Bell size={14} className="text-inkMuted" />}
                {isMuted(chat.id) ? 'Unmute' : 'Mute'}
              </button>
              <button
                type="button"
                onClick={() => { useChatStore.getState().toggleArchiveChat(chat.id); setMenuFor(null); }}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[14px] font-medium text-ink active:bg-ink/5"
              >
                {archivedChats.includes(chat.id) ? <ArchiveRestore size={14} className="text-inkMuted" /> : <Archive size={14} className="text-inkMuted" />}
                {archivedChats.includes(chat.id) ? 'Unarchive' : 'Archive'}
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="px-4 pb-4">
      <div className="flex gap-1 rounded-full bg-panel p-1" role="group" aria-label="Filter chats">
        {SEGMENTS.map((seg) => (
          <button
            key={seg.key}
            type="button"
            aria-pressed={segment === seg.key}
            onClick={() => setSegment(seg.key)}
            className={`min-h-[36px] flex-1 rounded-full px-3 py-1.5 text-[13px] font-bold ${segment === seg.key ? 'bg-accent text-accentInk' : 'text-inkMuted'} active:bg-ink/5 ${pressable}`}
          >
            {seg.label}
          </button>
        ))}
      </div>
      {shownChats.length > 0 && (
        <div className="overflow-hidden">
          {shownChats.map(renderRow)}
        </div>
      )}
      {shownChats.length === 0 && segment !== 'all' && (
        <p className="px-4 py-10 text-center text-[13px] text-inkMuted">
          {segment === 'menus' ? 'No menus here yet.' : 'No vendor chats yet.'}
        </p>
      )}
      {archived.length > 0 && (
        <>
          <p className="px-1 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-inkSubtle">Archived</p>
          <div className="overflow-hidden">
            {archived.map(renderRow)}
          </div>
        </>
      )}
    </div>
  );
}
