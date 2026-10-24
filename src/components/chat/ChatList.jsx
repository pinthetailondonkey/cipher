import React from 'react';
import { Users, Megaphone } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import Avatar from '../ui/Avatar';
import { pressable } from '../ui/Button';

export default function ChatList({ onOpenChat }) {
  const dms = useChatStore((s) => s.dms);
  const groups = useChatStore((s) => s.groups);
  const groupMessages = useChatStore((s) => s.groupMessages);
  const profiles = useChatStore((s) => s.profiles);
  const unreadCounts = useChatStore((s) => s.unreadCounts);

  const dmList = Object.entries(dms).map(([pubkey, msgs]) => {
    const profile = profiles[pubkey];
    const safeProfile = (profile && profile.name && !/^[0-9a-f]{8,64}$/i.test(profile.name))
      ? profile
      : { displayName: `User ${pubkey.slice(0, 4)}`, picture: null, name: pubkey.slice(0, 4) };
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

  if (allChats.length === 0) {
    return <p className="mt-10 text-center text-[13px] text-white/40">No chats yet. Tap + to start.</p>;
  }

  return (
    <div className="flex w-full flex-col bg-black">
      {allChats.map((chat, i) => {
        const isLast = i === allChats.length - 1;
        const row = `flex w-full items-center justify-between border-white/5 px-4 py-3 text-left active:bg-white/10 ${pressable} ${!isLast ? 'border-b' : ''}`;

        if (chat.type === 'dm') {
          const profile = profiles[chat.id] || { displayName: `User ${chat.id.slice(0, 4)}`, picture: null };
          return (
            <button
              key={chat.id}
              type="button"
              onClick={() => onOpenChat('dm', chat.id)}
              className={row}
            >
              <span className="flex min-w-0 items-center gap-3">
                <Avatar src={profile.picture} name={profile.displayName || profile.name} />
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-semibold text-white">{profile.displayName}</span>
                  <span className="block truncate text-[13px] text-white/40">
                    {chat.lastMsg?.data?.type === 'cipher_order' ? 'Order'
                      : chat.lastMsg?.data?.type === 'image' ? 'Photo'
                      : chat.lastMsg?.data?.type === 'audio' ? 'Voice note'
                      : chat.lastMsg?.data?.message || 'Tap to chat'}
                  </span>
                </span>
              </span>
              <span className="ml-2 flex shrink-0 flex-col items-end gap-1">
                {chat.lastMsg?.timestamp && (
                  <span className="text-[11px] font-medium text-white/30">
                    {new Date(chat.lastMsg.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
                {unreadCounts[chat.id] > 0 && (
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white">
                    {unreadCounts[chat.id]}
                  </span>
                )}
              </span>
            </button>
          );
        }

        const Icon = chat.group.isChannel ? Megaphone : Users;
        return (
          <button
            key={chat.id}
            type="button"
            onClick={() => onOpenChat('group', chat.id, chat.group)}
            className={row}
          >
            <span className="flex min-w-0 items-center gap-3">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/10 bg-[#111] text-blue-500">
                <Icon size={22} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[15px] font-semibold text-white">
                  {chat.group.name && !chat.group.name.startsWith('Group ') ? chat.group.name : 'Unnamed Group'}
                </span>
                <span className="block truncate text-[13px] text-white/40">
                  {chat.group.isChannel ? 'Channel' : 'Public group'}
                </span>
              </span>
            </span>
            {unreadCounts[chat.id] > 0 && (
              <span className="ml-2 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white">
                {unreadCounts[chat.id]}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
