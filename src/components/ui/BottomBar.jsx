import { haptic } from '../../lib/haptics';
import { TABS } from '../../lib/tabs.js';
import { barUnreadTotalOf, ordersNeedActionOf, useChatStore } from '../../store/chatStore';

// The below-md shell bar (telegram-pass §7): the four primary destinations in
// the founder's fixed order, as one row of equal cells under a hairline. The
// set and order are not this file's to know — it maps tabs.js, like the md+
// rail and the palette. The shell owns where the row sits and when it steps
// aside inside a conversation (traps 1 and 8); this file owns the anatomy:
// 48px cells in the bar-height row, `--panel-strong` ground, the active cell
// in `--accent-text` at 2.4 stroke. A badge rides Chats and Orders only —
// tabs.js says which — and is a 6px dot, never a count, so it cannot widen a
// cell; a zero hides, never renders 0.
export default function BottomBar({ activeId, onSelect }) {
  const unread = useChatStore(barUnreadTotalOf);
  const needsAction = useChatStore(ordersNeedActionOf);
  const counts = { unread, needsAction };

  return (
    <nav aria-label="Tabs" className="z-fab border-t border-line bg-panelStrong pb-safe md:hidden">
      <div className="grid h-[var(--bar-h)] w-full grid-flow-col auto-cols-fr items-center">
        {TABS.map((tab) => {
          const active = tab.id === activeId;
          const Icon = tab.icon;
          const badge = tab.badge ? counts[tab.badge] || 0 : 0;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => { haptic('light'); if (!active) onSelect?.(tab.id); }}
              aria-current={active ? 'page' : undefined}
              className={`relative flex h-12 flex-col items-center justify-center gap-0.5 ${active ? 'text-accentText' : 'text-ink/40'}`}
            >
              <span className="relative flex h-6 w-12 items-center justify-center">
                <Icon size={20} strokeWidth={active ? 2.4 : 2} fill={active && tab.fills ? 'currentColor' : 'none'} aria-hidden="true" />
                {badge > 0 && (
                  <span aria-hidden="true" className="absolute -right-0.5 -top-0 h-1.5 w-1.5 rounded-full bg-accent" />
                )}
              </span>
              <span className="text-[12px] font-semibold leading-none">{tab.label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
