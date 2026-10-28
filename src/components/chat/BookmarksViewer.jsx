import { Bookmark } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
import ListRow from '../ui/ListRow';
import EmptyState from '../ui/EmptyState';
import { useModalA11y } from '../ui/modal';
import { useChatStore } from '../../store/chatStore';

export default function BookmarksViewer({ onClose, onJump }) {
  const bookmarks = useChatStore((state) => state.bookmarks);
  const panelRef = useModalA11y(true, onClose);
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
    <div ref={panelRef} tabIndex={-1} className="fixed inset-0 z-sheet flex flex-col bg-scrim md:right-auto md:left-[72px] md:top-0 md:bottom-0 md:w-[340px] md:bg-base md:border-r md:border-line md:shadow-2xl" role="dialog" aria-modal="true" aria-label="Saved">
      <div className="pointer-events-none absolute inset-0" style={{
        background: 'radial-gradient(ellipse 55% 38% at 12% 0%, var(--glow-a), transparent 65%), radial-gradient(ellipse 50% 30% at 92% 100%, var(--glow-b), transparent 70%)',
      }} />
      <div className="relative mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col">
        <ScreenHeader title="Saved" onBack={onClose} />
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {items.length === 0 ? (
            <EmptyState icon={<Bookmark size={22} />} title="Nothing saved" line="Long-press a message and choose Save." />
          ) : (
            <div className="overflow-hidden rounded-2xl border border-line bg-panel">
              {items.map(({ chatId, messageId, isGroup, message }) => (
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
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
