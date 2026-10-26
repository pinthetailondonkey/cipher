import { useEffect } from 'react';
import { Bell, Users } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import { useChatStore } from '../../store/chatStore';
import { db } from '../../db';

// Writing the read-marker from module scope keeps the impure time call out of
// the component; it is called from event handlers, never render.
function markChatRead(chatId) {
  db.chatReads.put({ chatId, lastRead: Math.floor(Date.now() / 1000) });
}

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
    // The unread counters are recomputed from the message database on every
    // boot, so only zeroing the counter makes the badge come back as soon as
    // the screen re-opens. Writing the durable read-marker here is what makes
    // the clear stick.
    markChatRead(item.id);
    onJump?.(item.type, item.id);
    onClose?.();
  };

  return (
    <div className="fixed inset-0 z-[999] flex flex-col bg-black" role="dialog" aria-modal="true" aria-label="Notifications">
      <div className="pointer-events-none absolute inset-0" style={{
        background: 'radial-gradient(ellipse 55% 38% at 12% 0%, var(--glow-a), transparent 65%), radial-gradient(ellipse 50% 30% at 92% 100%, var(--glow-b), transparent 70%)',
      }} />
      <div className="relative z-10 flex min-h-0 flex-1 flex-col">
      <ScreenHeader title="Notifications" onBack={onClose} />
      {notifications.length === 0 ? (
        <div className="m-4 rounded-2xl border border-line bg-panel px-4 py-16 text-center shadow-lg">
          <Bell size={28} className="mx-auto mb-3 text-accent" />
          <p className="text-[15px] font-semibold text-white">You're caught up</p>
          <p className="mt-1 text-[13px] text-white/40">New messages show up here.</p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-lg">
          {notifications.map((item) => (
            <button key={item.id} type="button" onClick={() => openNotification(item)} className="flex w-full items-center gap-3 border-b border-white/5 p-4 text-left last:border-0 active:bg-white/5">
              <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/5 text-accent">
                {item.type === 'group' ? <Users size={20} /> : <Bell size={20} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-white">{item.title}</span>
                <span className="mt-1 block truncate text-[13px] text-white/40">{item.preview}</span>
              </span>
              <span className="flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-accentInk">{item.count}</span>
            </button>
          ))}
          </div>
        </div>
      )}
      </div>
    </div>
  );
}
