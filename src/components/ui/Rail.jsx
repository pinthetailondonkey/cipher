import { useEffect } from 'react';
import { haptic } from '../../lib/haptics';

// The md+ shell rail: a 72px icon strip pinned to the left edge (master §2).
// Items are real destinations only — the caller passes what exists — and
// every item answers its position key: 1/2/3 held with the command key
// jumps to the matching rail item. Labels ride a hover tooltip, not a
// widening rail, so pane geometry stays keyed to the 72px strip.
export default function Rail({ label, items, activeId }) {
  useEffect(() => {
    const onKeyDown = (event) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      const position = Number(event.key);
      if (!Number.isInteger(position) || position < 1 || position > items.length) return;
      const item = items[position - 1];
      if (!item) return;
      event.preventDefault();
      item.onSelect?.();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [items]);

  return (
    <nav aria-label={label} className="fixed bottom-0 left-0 top-0 z-fab hidden w-[72px] flex-col items-center gap-1.5 border-r border-line bg-panelStrong pt-4 md:flex">
      {items.map((item, index) => {
        const Icon = item.icon;
        const active = item.id === activeId;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => { haptic('light'); item.onSelect?.(); }}
            aria-label={item.label}
            aria-current={active ? 'page' : undefined}
            title={`${item.label} — ${eventKey(index + 1)}`}
            className={`group/btn relative flex h-14 w-14 flex-col items-center justify-center gap-1 rounded-2xl ${active ? 'text-accentText' : 'text-ink/40 hover:text-ink/60'}`}
          >
            <span className={`relative flex h-9 w-9 items-center justify-center rounded-full ${active ? 'bg-accentSoft' : 'group-hover/btn:bg-ink/10'}`}>
              <Icon size={22} strokeWidth={active ? 2.5 : 2} />
              {item.badge > 0 && (
                <span className="absolute -right-1 -top-1 flex h-[16px] min-w-[16px] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-bold text-accentInk">
                  {item.badge > 99 ? '99+' : item.badge}
                </span>
              )}
            </span>
            <span
              role="tooltip"
              className="pointer-events-none absolute left-[calc(100%+10px)] top-1/2 z-fab -translate-y-1/2 whitespace-nowrap rounded-lg border border-line bg-panelStrong px-2.5 py-1.5 text-[12px] font-medium text-ink opacity-0 shadow-xl transition-opacity duration-150 group-hover/btn:opacity-100 group-focus-visible/btn:opacity-100"
            >
              {item.label}
              <span className="ml-1.5 text-[10px] text-inkSubtle">{eventKey(index + 1)}</span>
            </span>
          </button>
        );
      })}
    </nav>
  );
}

function eventKey(position) {
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  return `${mac ? '⌘' : 'Ctrl+'}${position}`;
}
