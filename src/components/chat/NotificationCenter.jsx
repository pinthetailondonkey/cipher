import { Bell, Users, X } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';

export default function NotificationCenter({ onClose, onJump }) {
  const unreadCounts = useChatStore((state) => state.unreadCounts);
  const dms = useChatStore((state) => state.dms);
  const groupMessages = useChatStore((state) => state.groupMessages);
  const groups = useChatStore((state) => state.groups);
  const profiles = useChatStore((state) => state.profiles);

  const notifications = Object.entries(unreadCounts || {})
    .filter(([, count]) => Number(count) > 0)
    .map(([id, count]) => {
      const group = groups.find((item) => item.id === id);
      const messages = group ? groupMessages[id] : dms[id];
      const latest = [...(messages || [])].reverse().find((message) => !message.isSender);
      const sender = latest?.pubkey ? profiles[latest.pubkey] : null;
      return {
        id,
        count,
        type: group ? 'group' : 'dm',
        title: group?.name || sender?.displayName || sender?.name || id.slice(0, 12),
        preview: latest?.data?.message || latest?.rawContent || 'Unread messages',
      };
    });

  const openNotification = (item) => {
    useChatStore.getState().setUnreadCounts((current) => ({ ...current, [item.id]: 0 }));
    onJump?.(item.type, item.id);
    onClose?.();
  };

  return (
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Notifications">
      <div className="flex h-[80vh] w-full max-w-sm flex-col rounded-3xl border border-white/10 bg-[#0A0A0A] p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-bold text-white">Notifications</h2>
          <button type="button" onClick={onClose} className="p-2 text-white/50 hover:text-white" aria-label="Close notifications"><X size={20} /></button>
        </div>
        {notifications.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center text-white/40">
            <Bell size={40} className="mb-3" />
            <p className="text-sm">You’re all caught up!</p>
          </div>
        ) : (
          <div className="-mx-6 flex-1 overflow-y-auto">
            {notifications.map((item) => (
              <button key={item.id} type="button" onClick={() => openNotification(item)} className="flex w-full items-center gap-3 border-b border-white/5 px-6 py-4 text-left hover:bg-white/5">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-[#111] text-white/60">
                  {item.type === 'group' ? <Users size={20} /> : <Bell size={20} />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold text-white">{item.title}</span>
                  <span className="mt-1 block truncate text-[13px] text-white/40">{item.preview}</span>
                </span>
                <span className="rounded-full bg-blue-600 px-2 py-0.5 text-xs font-semibold text-white">{item.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
