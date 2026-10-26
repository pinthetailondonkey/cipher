import { Bookmark } from 'lucide-react';
import ScreenHeader from '../ui/ScreenHeader';
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
    <div className="fixed inset-0 z-[999] flex flex-col bg-scrim md:right-auto md:left-[72px] md:top-0 md:bottom-0 md:w-[340px] md:bg-base md:border-r md:border-line md:shadow-2xl" role="dialog" aria-modal="true" aria-label="Saved">
      <div className="pointer-events-none absolute inset-0" style={{
        background: 'radial-gradient(ellipse 55% 38% at 12% 0%, var(--glow-a), transparent 65%), radial-gradient(ellipse 50% 30% at 92% 100%, var(--glow-b), transparent 70%)',
      }} />
      <div className="relative z-10 mx-auto flex min-h-0 w-full max-w-md flex-1 flex-col">
        <ScreenHeader title="Saved" onBack={onClose} />
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {items.length === 0 ? (
            <div className="rounded-2xl border border-line bg-panel px-4 py-16 text-center shadow-lg">
              <Bookmark size={28} className="mx-auto mb-3 text-ink/30" />
              <p className="text-[15px] font-semibold text-ink">Nothing saved</p>
              <p className="mt-1 text-[13px] text-ink/40">Long-press a message and choose Save.</p>
            </div>
          ) : (
            <div className="overflow-hidden rounded-2xl border border-line bg-panel shadow-lg">
              {items.map(({ chatId, messageId, isGroup, message }) => (
                <button
                  key={`${chatId}:${messageId}`}
                  type="button"
                  onClick={() => {
                    onJump?.(chatId, messageId, isGroup);
                    onClose?.();
                  }}
                  className="flex w-full items-start gap-3 border-b border-ink/5 p-4 text-left last:border-0 active:bg-ink/5"
                >
                  <Bookmark size={18} className="mt-0.5 shrink-0 text-ink/40" />
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-semibold text-ink">{isGroup ? groupList.find((group) => group.id === chatId)?.name || 'Group' : 'Direct message'}</span>
                    <span className="mt-1 block truncate text-[13px] text-ink/40">{message.data?.message || message.rawContent || message.data?.url || 'Saved message'}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
