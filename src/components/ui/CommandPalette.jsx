import { useEffect, useMemo, useRef, useState } from 'react';
import { Compass, MessageSquare, Search, User, Users } from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import { noHexName } from '../../lib/npub';
import { useModalA11y } from './modal';

// The md+ command palette (master §2): ⌘K jumps to a chat, a group or one
// of the three shell tabs. Its data sources are the lists the store already
// holds — DM keys, the groups array, the tab names — nothing new is fetched
// and nothing new is published. Filter-as-you-type, arrow keys walk, Enter
// activates, Escape closes.
export default function CommandPalette({ open, onClose, onOpenChat, onNavigateTab, activeTab }) {
  const dms = useChatStore((state) => state.dms);
  const groups = useChatStore((state) => state.groups);
  const profiles = useChatStore((state) => state.profiles);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef(null);
  const panelRef = useModalA11y(open, onClose);

  const items = useMemo(() => {
    const screens = [
      { id: 'tab-chat', label: 'Chats', kind: 'Screen', icon: MessageSquare, run: () => onNavigateTab?.('chat') },
      { id: 'tab-explore', label: 'Shop', kind: 'Screen', icon: Compass, run: () => onNavigateTab?.('explore') },
      { id: 'tab-profile', label: 'Profile', kind: 'Screen', icon: User, run: () => onNavigateTab?.('profile') },
    ];
    const chats = Object.keys(dms).map((pubkey) => ({
      id: `dm-${pubkey}`,
      label: noHexName(profiles[pubkey], pubkey),
      kind: 'Chat',
      icon: MessageSquare,
      run: () => onOpenChat?.('dm', pubkey),
    }));
    const groupRows = (Array.isArray(groups) ? groups : []).map((group) => ({
      id: `group-${group.id}`,
      label: group.name || 'Group',
      kind: 'Group',
      icon: Users,
      run: () => onOpenChat?.('group', group.id, group),
    }));
    return [...screens, ...chats, ...groupRows];
  }, [dms, groups, profiles, onOpenChat, onNavigateTab]);

  const needle = query.trim().toLowerCase();
  const matches = useMemo(() => (
    needle ? items.filter((item) => item.label.toLowerCase().includes(needle)) : items
  ), [items, needle]);

  // The highlight never points past the filtered list, and a new filter
  // starts the walk from the top again.
  useEffect(() => {
    setHighlight((at) => Math.min(at, Math.max(matches.length - 1, 0)));
  }, [matches.length]);
  useEffect(() => {
    if (open) {
      setQuery('');
      setHighlight(0);
      // The panel hook focuses the dialog shell; the field is the real
      // entry point, so it takes over on the next frame.
      const timer = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [open]);

  if (!open) return null;

  const activate = (item) => {
    if (!item) return;
    onClose?.();
    item.run?.();
  };
  const onKeyDown = (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((at) => (matches.length ? (at + 1) % matches.length : 0));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((at) => (matches.length ? (at - 1 + matches.length) % matches.length : 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      activate(matches[highlight]);
    }
  };

  return (
    <div
      className="fixed inset-0 z-sheet flex items-start justify-center bg-scrim/60 pt-[12vh]"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Jump to"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="w-full max-w-md overflow-hidden rounded-[28px] border border-line bg-panelStrong shadow-2xl outline-none"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
          <Search size={16} className="text-ink/40" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setHighlight(0); }}
            placeholder="Jump to a chat, group or screen"
            aria-label="Jump to a chat, group or screen"
            aria-controls="command-palette-list"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-ink placeholder-ink/30 focus:outline-none"
          />
        </div>
        <div role="listbox" id="command-palette-list" aria-label="Jump results" aria-activedescendant={matches[highlight] ? optionId(matches[highlight]) : undefined} className="max-h-[50vh] overflow-y-auto p-1.5">
          {matches.map((item, index) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                id={optionId(item)}
                role="option"
                aria-selected={index === highlight}
                onMouseMove={() => setHighlight(index)}
                onClick={() => activate(item)}
                className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left ${index === highlight ? 'bg-accentSoft' : 'hover:bg-ink/5'}`}
              >
                <Icon size={16} className={`flex-none ${index === highlight ? 'text-accentText' : 'text-ink/40'}`} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-ink">{item.label}</span>
                <span className="flex-none text-[11px] uppercase tracking-wider text-inkSubtle">{item.kind}</span>
              </button>
            );
          })}
          {matches.length === 0 && (
            <p className="px-3 py-6 text-center text-[13px] text-inkMuted">Nothing matches that.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function optionId(item) {
  return `command-palette-option-${item.id}`;
}
