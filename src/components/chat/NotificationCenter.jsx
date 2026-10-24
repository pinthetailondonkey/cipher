import { useEffect } from 'react';
import { Bell, Users } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import { useChatStore } from '../../store/chatStore';

function previewText(message) {
  const data = message?.data;
  if (data?.type === 'cipher_order' || data?.type === 'order_request') return 'New order';
  if (data?.type === 'order_update') return 'Order update';
  if (data?.type === 'image') return 'Photo';
  if (data?.type === 'audio') return 'Voice note';
  if (typeof data?.message === 'string' && data.message) return data.message;
  if (typeof message?.rawContent === 'string' && message.rawContent && !message.rawContent.startsWith('{')) return message.rawContent;
  return 'New message';
}

export default function NotificationCenter({ onClose, onJump }) {
  const unreadCounts = useChatStore((state) => state.unreadCounts);
  const dms = useChatStore((state) => state.dms);
  const groupMessages = useChatStore((state) => state.groupMessages);
  const groups = useChatStore((state) => state.groups);
  const profiles = useChatStore((state) => state.profiles);

  useEffect(() => {
    useChatStore.getState().ackNotifications();
  }, []);

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
        title: group?.name || sender?.displayName || sender?.name || 'New message',
        preview: previewText(latest),
      };
    });

  const openNotification = (item) => {
    useChatStore.getState().setUnreadCounts((current) => ({ ...current, [item.id]: 0 }));
    onJump?.(item.type, item.id);
    onClose?.();
  };

  return (
    <div className="fixed inset-0 z-[999] flex flex-col bg-black" role="dialog" aria-modal="true" aria-label="Notifications">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-10%] top-[-10%] h-[50%] w-[50%] rounded-full bg-blue-600/20 blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] h-[50%] w-[50%] rounded-full bg-purple-600/10 blur-[120px]" />
      </div>
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <ScreenHeader title="Notifications" onBack={onClose} />
      {notifications.length === 0 ? (
        <div className="m-4 rounded-2xl border border-white/10 bg-[#0A0A0A]/60 px-4 py-16 text-center shadow-2xl backdrop-blur-2xl">
          <Bell size={28} className="mx-auto mb-3 text-blue-500" />
          <p className="text-[15px] font-semibold text-white">You're caught up</p>
          <p className="mt-1 text-[13px] text-white/40">New messages show up here.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="overflow-hidden rounded-2xl border border-white/10 bg-[#0A0A0A]/60 shadow-2xl backdrop-blur-2xl">
          {notifications.map((item) => (
            <button key={item.id} type="button" onClick={() => openNotification(item)} className="flex w-full items-center gap-3 border-b border-white/5 p-4 text-left last:border-0 active:bg-white/5">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-blue-500">
                {item.type === 'group' ? <Users size={20} /> : <Bell size={20} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-white">{item.title}</span>
                <span className="mt-1 block truncate text-[13px] text-white/40">{item.preview}</span>
              </span>
              <span className="flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-blue-500 px-1.5 text-[10px] font-bold text-white">{item.count}</span>
            </button>
          ))}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
