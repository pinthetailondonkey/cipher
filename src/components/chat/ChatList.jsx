import React, { useRef, useState } from 'react';
import { Archive, ArchiveRestore, Bell, BellOff, Megaphone, MoreVertical, Users } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import Avatar from '../ui/Avatar';
import { pressable } from '../ui/Button';
import { noHexName } from '../../lib/npub';

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

  const [revealed, setRevealed] = useState(() => new Set());
  const [menuFor, setMenuFor] = useState(null);
  const pressTimer = useRef(null);
  const suppressClick = useRef(false);

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
    || (typeof mutedUntil[id] === 'number' && mutedUntil[id] > Date.now());

  const dmList = Object.entries(dms).map(([pubkey, msgs]) => {
    const profile = profiles[pubkey];
    const safeProfile = (profile && profile.name && !/^[0-9a-f]{8,64}$/i.test(profile.name))
      ? profile
      : { displayName: noHexName(profile, pubkey), picture: null, name: noHexName(profile, pubkey) };
    return { type: 'dm', id: pubkey, lastMsg: msgs[msgs.length - 1], profile: safeProfile };
  });

  const groupList = groups.map(g => ({
    type: 'group',
    id: g.id,
    group: g,
    lastMsg: groupMessages[g.id]?.[groupMessages[g.id].length - 1]
  }));

  const chatMap = new Map();
  [...dmList, ...groupList].forEach(c => chatMap.set(c.id, c));

  const allChats = Array.from(chatMap.values()).sort(
    (a, b) => (b.lastMsg?.timestamp || 0) - (a.lastMsg?.timestamp || 0)
  );

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
    return <p className="mx-4 mt-6 rounded-2xl border border-line bg-panel shadow-lg px-4 py-10 text-center text-[13px] text-ink/40">No chats yet. Tap + to start.</p>;
  }

  const active = allChats.filter(c => !archivedChats.includes(c.id));
  const archived = allChats.filter(c => archivedChats.includes(c.id));

  const renderRow = (chat) => {
    const isDm = chat.type === 'dm';
    const name = isDm
      ? chat.profile.displayName
      : (chat.group.name && !chat.group.name.startsWith('Group ') ? chat.group.name : 'Unnamed Group');
    const previewText = previewOf(chat);
    const isRevealed = revealed.has(chat.id);
    const unread = unreadCounts[chat.id] || 0;
    const Icon = chat.group?.isChannel ? Megaphone : Users;

    return (
      <div key={chat.id} className="relative flex items-stretch border-b border-ink/5 last:border-0">
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
          className={`flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left active:bg-ink/5 ${pressable}`}
        >
          {isDm ? (
            <Avatar src={chat.profile.picture} name={name} className="!h-10 !w-10 !text-[13px]" />
          ) : (
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-ink/10 bg-scrim text-accent">
              <Icon size={18} />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[15px] font-semibold text-ink">{name}</span>
              {chat.lastMsg?.timestamp && (
                <span className="shrink-0 text-[11px] font-medium text-ink/30">
                  {new Date(chat.lastMsg.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
            </span>
            <span className="mt-0.5 flex items-center justify-between gap-2">
              <span
                className={`block truncate text-[13px] text-ink/40 transition-all duration-200 select-none ${previewText && !isRevealed ? 'blur-[5px]' : ''}`}
              >
                {previewText || (isDm ? 'Tap to chat' : (chat.group.isChannel ? 'Channel' : 'Public group'))}
              </span>
              {unread > 0 ? (
                <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-bold text-accentInk">
                  {unread}
                </span>
              ) : (isMuted(chat.id) && <BellOff size={13} className="shrink-0 text-ink/30" />)}
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-label="Chat options"
          onClick={() => setMenuFor(menuFor === chat.id ? null : chat.id)}
          className="flex w-10 shrink-0 items-center justify-center text-ink/25 hover:text-ink/60 active:bg-ink/5"
        >
          <MoreVertical size={16} />
        </button>
        {menuFor === chat.id && (
          <>
            <button type="button" aria-label="Close options" onClick={() => setMenuFor(null)} className="fixed inset-0 z-10 cursor-default" />
            <div className="absolute right-2 top-2 z-20 w-40 overflow-hidden rounded-xl border border-line bg-panel shadow-lg">
              <button
                type="button"
                onClick={() => { useChatStore.getState().toggleMuteChat(chat.id); setMenuFor(null); }}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[14px] font-medium text-ink active:bg-ink/5"
              >
                {isMuted(chat.id) ? <BellOff size={14} className="text-ink/45" /> : <Bell size={14} className="text-ink/45" />}
                {isMuted(chat.id) ? 'Unmute' : 'Mute'}
              </button>
              <button
                type="button"
                onClick={() => { useChatStore.getState().toggleArchiveChat(chat.id); setMenuFor(null); }}
                className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[14px] font-medium text-ink active:bg-ink/5"
              >
                {archivedChats.includes(chat.id) ? <ArchiveRestore size={14} className="text-ink/45" /> : <Archive size={14} className="text-ink/45" />}
                {archivedChats.includes(chat.id) ? 'Unarchive' : 'Archive'}
              </button>
            </div>
          </>
        )}
      </div>
    );
  };

  return (
    <div className="px-3 pb-4">
      {active.length > 0 && (
        <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-lg">
          {active.map(renderRow)}
        </div>
      )}
      {archived.length > 0 && (
        <>
          <p className="px-1 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-ink/30">Archived</p>
          <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-lg">
            {archived.map(renderRow)}
          </div>
        </>
      )}
    </div>
  );
}
