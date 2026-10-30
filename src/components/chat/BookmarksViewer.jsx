import { Bookmark } from 'lucide-react';
import Sheet from '../ui/Sheet';
import ListRow from '../ui/ListRow';
import EmptyState from '../ui/EmptyState';
import { useChatStore } from '../../store/chatStore';

export default function BookmarksViewer({ onClose, onJump }) {
  const bookmarks = useChatStore((state) => state.bookmarks);
  const dms = useChatStore((state) => state.dms);
  const groups = useChatStore((state) => state.groupMessages);
  const groupList = useChatStore((state) => state.groups);

  const items = (Array.isArray(bookmarks) ? bookmarks : []).map(({ chatId, msgId: messageId }) => {
    const isGroup = groupList.some((group) => group.id === chatId);
    const messages = (isGroup ? groups : dms)?.[chatId] || [];
    return {
      chatId,
      messageId,
      isGroup,
      message: messages.find((item) => item.id === messageId || item.clientId === messageId),
    };
  }).filter((item) => item.message);

  return (
    <Sheet open onClose={onClose} title="Saved" bodyClassName="max-h-[68vh] overflow-y-auto pb-4">
      {items.length === 0 ? (
        <EmptyState icon={<Bookmark size={22} />} title="Nothing saved" line="Long-press a message and choose Save." />
      ) : (
        items.map(({ chatId, messageId, isGroup, message }) => (
          <ListRow
            key={`${chatId}:${messageId}`}
            onClick={() => {
              onJump?.(chatId, messageId, isGroup);
              onClose?.();
            }}
            leading={<Bookmark size={18} className="shrink-0 text-ink/40" />}
            title={isGroup ? groupList.find((group) => group.id === chatId)?.name || 'Group' : 'Direct message'}
            subtitle={message.data?.message || message.rawContent || message.data?.url || 'Saved message'}
          />
        ))
      )}
    </Sheet>
  );
}
