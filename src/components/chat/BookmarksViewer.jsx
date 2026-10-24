import { useChatStore } from '../../store/chatStore';
import { Bookmark, X } from 'lucide-react';

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
    <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-label="Bookmarks">
      <div className="flex h-[80vh] w-full max-w-sm flex-col rounded-3xl border border-white/10 bg-[#0A0A0A] p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-xl font-bold text-white">Bookmarks</h2>
          <button type="button" onClick={onClose} className="p-2 text-white/50 hover:text-white" aria-label="Close bookmarks"><X size={20} /></button>
        </div>
        {items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center text-white/40">
            <Bookmark size={40} className="mb-3" />
            <p className="text-sm">No bookmarks yet.</p>
          </div>
        ) : (
          <div className="-mx-6 flex-1 overflow-y-auto">
            {items.map(({ chatId, messageId, isGroup, message }) => (
              <button
                key={`${chatId}:${messageId}`}
                type="button"
                onClick={() => {
                  onJump?.(chatId, messageId, isGroup);
                  onClose?.();
                }}
                className="flex w-full items-start gap-3 border-b border-white/5 px-6 py-4 text-left hover:bg-white/5"
              >
                <Bookmark size={18} className="mt-0.5 shrink-0 text-white/40" />
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-semibold text-white">{isGroup ? groupList.find((group) => group.id === chatId)?.name || 'Group' : 'Direct message'}</span>
                  <span className="mt-1 block truncate text-[13px] text-white/40">{message.data?.message || message.rawContent || message.data?.url || 'Saved message'}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
