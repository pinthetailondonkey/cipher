import {
  Bookmark, Copy, Forward, Pencil, Pin, Radio, Reply, ShoppingBag, Store, Trash2, SquareCheck,
} from 'lucide-react';
import Sheet from '../ui/Sheet';
import { haptic } from '../../lib/haptics';

export const REACTION_CHOICES = ['❤️', '👍', '🔥', '😂', '😮', '😢', '🙏'];

const ICONS = {
  reply: Reply,
  copy: Copy,
  forward: Forward,
  pin: Pin,
  edit: Pencil,
  delete: Trash2,
  select: SquareCheck,
  bookmark: Bookmark,
  buy_product: ShoppingBag,
  view_vendor: Store,
  broadcast_product: Radio,
};

// Long-press / right-click context menu, worn as the shared Sheet.
export default function MessageContextMenu({ open, onClose, onAction, items = [] }) {
  const act = (action, emojiOverride) => {
    haptic('light');
    onAction(action, emojiOverride);
    onClose();
  };

  return (
    <Sheet open={open} onClose={onClose} title="Message">
      <div className="flex justify-between px-4 pb-3 pt-2">
        {REACTION_CHOICES.map((emoji) => (
          <button
            key={emoji}
            type="button"
            aria-label={`React ${emoji}`}
            onClick={() => act('react', emoji)}
            className="touch-target flex items-center justify-center text-[22px] active:scale-95"
          >
            {emoji}
          </button>
        ))}
      </div>
      <div className="mx-2 mb-2 grid grid-cols-4 gap-1">
        {items.map((item) => {
          const Icon = ICONS[item.action] || Reply;
          return (
            <button
              key={item.action}
              type="button"
              onClick={() => act(item.action)}
              className={`flex flex-col items-center justify-center gap-1 rounded-2xl px-2 min-h-[44px] text-[12px] font-semibold active:bg-ink/10 ${item.danger ? 'text-danger' : 'text-ink'}`}
            >
              <Icon size={18} />
              {item.label}
            </button>
          );
        })}
      </div>
    </Sheet>
  );
}
