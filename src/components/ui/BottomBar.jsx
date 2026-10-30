import { haptic } from '../../lib/haptics';
import { TABS } from '../../lib/tabs.js';
import { barUnreadTotalOf, ordersNeedActionOf, useChatStore } from '../../store/chatStore';

// The below-md shell bar (15.1, UI-SPEC): the four primary destinations in
// the founder's fixed order, pinned under whatever pane is active. The set
// and order are not this file's to know — it maps tabs.js, like the md+ rail
// and the palette. Flat and solid, not glassy: it sits at z-fab so a sheet
// (z-sheet) covers it whole. The shell hides it inside a conversation, so
// nothing here ever fights a thread for the bottom edge. Badges ride Chats
// and Orders only — tabs.js says which — and a zero hides, never renders 0.
export default function BottomBar({ activeId, onSelect }) {
  const unread = useChatStore(barUnreadTotalOf);
  const needsAction = useChatStore(ordersNeedActionOf);
  const counts = { unread, needsAction };

  return (
    <nav aria-label="Tabs" className="fixed inset-x-0 bottom-0 z-fab border-t border-line bg-panelStrong pb-safe md:hidden">
      <div className="mx-auto flex h-14 w-full max-w-md items-stretch">
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
              className={`relative flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 ${active ? 'text-accentText' : 'text-ink/40'}`}
            >
              <span className={`relative flex h-7 w-12 items-center justify-center ${active ? 'text-accentText' : ''}`}>
                <Icon size={20} strokeWidth={active ? 2.5 : 2} fill={active ? 'currentColor' : 'none'} aria-hidden="true" />
                {badge > 0 && (
                  <span className="absolute -right-0.5 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[11px] font-bold leading-none text-accentInk">
                    {badge > 99 ? '99+' : badge}
                  </span>
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
