import React from 'react';
import { Users, Megaphone } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';

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
    return <p className="text-center text-white/40 mt-10 text-sm">No chats yet. Tap + to start.</p>;
  }

  return (
    <div className="flex flex-col w-full">
      {allChats.map((chat, i) => {
        const isLast = i === allChats.length - 1;
        
        if (chat.type === 'dm') {
          const profile = profiles[chat.id] || { displayName: `User ${chat.id.slice(0, 4)}`, picture: null };
          return (
            <div
              key={chat.id}
              onClick={() => onOpenChat('dm', chat.id)}
              className={`flex items-center justify-between px-4 py-3 hover:bg-white/5 active:bg-white/10 transition-colors cursor-pointer ${!isLast ? 'border-b border-white/5' : ''}`}
            >
              <div className="flex items-center gap-3">
                {profile.picture ? (
                  <img src={profile.picture} className="w-12 h-12 rounded-full object-cover shrink-0" />
                ) : (
                  <div className="w-12 h-12 rounded-full bg-blue-600/20 text-blue-400 flex items-center justify-center font-bold text-lg shrink-0">
                    {profile.displayName.charAt(0)}
                  </div>
                )}
                <div className="min-w-0">
                  <h3 className="text-[15px] font-semibold text-white truncate">{profile.displayName}</h3>
                  <p className="text-[13px] text-white/40 truncate">
                    {chat.lastMsg?.data?.type === 'cipher_order' ? '📦 Order'
                      : chat.lastMsg?.data?.type === 'image' ? '🖼️ Photo'
                      : chat.lastMsg?.data?.type === 'audio' ? '🎤 Voice Note'
                      : chat.lastMsg?.data?.message || 'Tap to chat'}
                  </p>
                </div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0 ml-2">
                {chat.lastMsg?.timestamp && (
                  <span className="text-[11px] text-white/30 font-medium">
                    {new Date(chat.lastMsg.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
                {unreadCounts[chat.id] > 0 && (
                  <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center text-[10px] font-bold text-white">
                    {unreadCounts[chat.id]}
                  </div>
                )}
              </div>
            </div>
          );
        } else {
          const Icon = chat.group.isChannel ? Megaphone : Users;
          return (
            <div
              key={chat.id}
              onClick={() => onOpenChat('group', chat.id, chat.group)}
              className={`flex items-center justify-between px-4 py-3 hover:bg-white/5 active:bg-white/10 transition-colors cursor-pointer ${!isLast ? 'border-b border-white/5' : ''}`}
            >
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-[#111] border border-white/10 flex items-center justify-center text-blue-500 shrink-0">
                  <Icon size={22} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-[15px] font-semibold text-white truncate">
                    {chat.group.name && !chat.group.name.startsWith('Group ') ? chat.group.name : 'Unnamed Group'}
                  </h3>
                  <p className="text-[13px] text-white/40 truncate">
                    {chat.group.isChannel ? '📢 Channel' : '👥 Public Group'}
                  </p>
                </div>
              </div>
              {unreadCounts[chat.id] > 0 && (
                <div className="flex flex-col items-end shrink-0 ml-2">
                  <div className="w-5 h-5 rounded-full bg-blue-600 flex items-center justify-center text-[10px] font-bold text-white">
                    {unreadCounts[chat.id]}
                  </div>
                </div>
              )}
            </div>
          );
        }
      })}
    </div>
  );
}
