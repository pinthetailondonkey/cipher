import { useEffect, useRef } from 'react';
import { Bell, Users } from 'lucide-react';
import Sheet from '../ui/Sheet';
import ListRow from '../ui/ListRow';
import Badge from '../ui/Badge';
import EmptyState from '../ui/EmptyState';
import { useChatStore } from '../../store/chatStore';
import { markChatRead } from '../../db';
import { assertSecurityContextOwner } from '../../lib/securityContextFence.js';

// Keep the impure clock read in an event-only helper, never component render.
function persistNotificationRead(chatId, securityFence, owner) {
  if (import.meta.env?.VITE_TEST_HOOKS === '1' && typeof window !== 'undefined'
    && typeof window.__cipherNotificationRead === 'function') {
    return window.__cipherNotificationRead(chatId, securityFence, owner);
  }
  return markChatRead(chatId, Math.floor(Date.now() / 1000), securityFence, owner);
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

export default function NotificationCenter({ identity, onClose, onJump }) {
  const unreadCounts = useChatStore((state) => state.unreadCounts);
  const dms = useChatStore((state) => state.dms);
  const groupMessages = useChatStore((state) => state.groupMessages);
  const groups = useChatStore((state) => state.groups);
  const profiles = useChatStore((state) => state.profiles);
  const openNotificationRef = useRef(null);

  useEffect(() => {
    try {
      assertSecurityContextOwner(identity?.securityFence, identity?.pk);
      useChatStore.getState().ackNotifications();
    } catch {}
  }, [identity?.securityFence, identity?.pk]);

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

  const openNotification = async (item) => {
    const securityFence = identity?.securityFence;
    try {
      assertSecurityContextOwner(securityFence, identity?.pk);
    } catch { return; }
    // The unread counters are recomputed from the message database on every
    // boot, so only zeroing the counter makes the badge come back as soon as
    // the screen re-opens. Writing the durable read-marker here is what makes
    // the clear stick.
    await persistNotificationRead(item.id, securityFence, identity?.pk);
    try {
      assertSecurityContextOwner(securityFence, identity?.pk);
    } catch { return; }
    useChatStore.getState().setUnreadCounts((current) => ({ ...current, [item.id]: 0 }));
    onJump?.(item.type, item.id);
    onClose?.();
  };
  useEffect(() => { openNotificationRef.current = openNotification; });

  useEffect(() => {
    if (import.meta.env?.VITE_TEST_HOOKS !== '1' || typeof window === 'undefined') return undefined;
    window.__notificationOpen = (...args) => openNotificationRef.current?.(...args);
    return () => { delete window.__notificationOpen; };
  }, []);

  return (
    <Sheet open onClose={onClose} title="Notifications" bodyClassName="max-h-[68vh] overflow-y-auto pb-4">
      {notifications.length === 0 ? (
        <EmptyState icon={<Bell size={22} className="text-accentText" />} title="You're caught up" line="New messages show up here." />
      ) : (
        notifications.map((item) => (
          <ListRow
            key={item.id}
            onClick={() => { void openNotification(item); }}
            leading={(
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-ink/5 text-accentText">
                {item.type === 'group' ? <Users size={18} /> : <Bell size={18} />}
              </span>
            )}
            title={item.title}
            subtitle={item.preview}
            trailing={<Badge tone="accent">{item.count}</Badge>}
          />
        ))
      )}
    </Sheet>
  );
}
