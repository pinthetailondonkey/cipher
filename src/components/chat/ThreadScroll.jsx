import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { ChevronDown, Forward, Trash2, X } from 'lucide-react';
import './thread.css';

function dayLabel(tsSec) {
  const date = new Date(tsSec * 1000);
  const now = new Date();
  const yesterday = new Date(Date.now() - 86400000);
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(date, now)) return 'Today';
  if (same(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// Select mode top bar: count, then Forward, Delete, Cancel.
export function SelectBar({ count, onForward, onDelete, onCancel }) {
  return (
    <motion.div
      initial={{ y: -56 }}
      animate={{ y: 0 }}
      transition={{ duration: 0.15 }}
      className="z-fab absolute inset-x-0 top-0 border-b border-line bg-panelStrong pt-safe"
      role="toolbar"
      aria-label="Selected messages"
    >
      <div className="flex h-14 items-center justify-between gap-2 px-3">
        <span className="text-[15px] font-semibold text-ink">{count} selected</span>
        <span className="flex items-center">
          <button
            type="button"
            onClick={onForward}
            disabled={!count}
            className="flex min-h-[44px] items-center gap-1 px-2 text-[14px] font-semibold text-accentText disabled:opacity-40"
          >
            <Forward size={16} /> Forward
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={!count}
            className="flex min-h-[44px] items-center gap-1 px-2 text-[14px] font-semibold text-danger disabled:opacity-40"
          >
            <Trash2 size={16} /> Delete
          </button>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel selection"
            className="touch-target flex items-center justify-center text-ink/70"
          >
            <X size={18} />
          </button>
        </span>
      </div>
    </motion.div>
  );
}

// The shared thread body: date chips, run boundaries, sticky grouping,
// scroll-to-bottom FAB, content-visibility past 50 bubbles. DM and group
// pass a renderMessage callback; the bubble itself stays in MessageBubble.
export default function ThreadScroll({ messages, emptyState, renderMessage }) {
  const scrollRef = useRef(null);
  const atBottomRef = useRef(true);
  const tickingRef = useRef(false);
  const [showFab, setShowFab] = useState(false);
  const [belowCount, setBelowCount] = useState(0);

  const rows = useMemo(() => {
    const flat = messages.map((message, index) => ({
      message,
      index,
      runStart: index === 0 || messages[index - 1].isSender !== message.isSender,
      runEnd: index === messages.length - 1 || messages[index + 1].isSender !== message.isSender,
    }));
    const groups = [];
    let current = null;
    for (const row of flat) {
      const ts = Number(row.message.timestamp);
      const label = Number.isFinite(ts) && ts > 0 ? dayLabel(ts) : '';
      if (!current || current.label !== label) {
        current = { label, rows: [] };
        groups.push(current);
      }
      current.rows.push(row);
    }
    return groups;
  }, [messages]);

  const virtualize = messages.length > 50;

  const scrollToBottom = useCallback((behavior = 'auto') => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    const last = messages[messages.length - 1];
    // Auto-scroll on the owner's send and whenever the thread is read to
    // the bottom; a new arrival below the fold leaves the FAB to carry it.
    if (!last || atBottomRef.current || last.isSender) {
      scrollToBottom('auto');
    }
  }, [messages, scrollToBottom]);

  const measure = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distance < 80;
    const up = distance > 400;
    setShowFab(up);
    if (!up) {
      setBelowCount(0);
      return;
    }
    const markers = el.querySelectorAll('[data-msg-row]');
    let count = 0;
    const box = el.getBoundingClientRect();
    for (const row of markers) {
      const rect = row.getBoundingClientRect();
      // A row whose top cleared the viewport bottom is unread-from here.
      if (rect.top >= box.bottom - 4) count += 1;
    }
    setBelowCount(count);
  };

  const onScroll = () => {
    if (tickingRef.current) return;
    tickingRef.current = true;
    requestAnimationFrame(() => {
      tickingRef.current = false;
      measure();
    });
  };

  return (
    <>
      <div ref={scrollRef} onScroll={onScroll} className="flex min-h-0 flex-1 flex-col overflow-y-auto py-2">
        {rows.length === 0 || !rows[0]?.rows.length ? emptyState : rows.map((group, groupIndex) => (
          <div key={group.rows[0].message.clientId || group.rows[0].message.id || groupIndex}>
            {group.label && (
              <div className="pointer-events-none py-1">
                <span className="sticky top-2 z-10 mx-auto flex w-fit justify-center rounded-full border border-line bg-panelStrong px-3 py-1 text-[11px] font-semibold text-inkMuted shadow-lg">
                  {group.label}
                </span>
              </div>
            )}
            {group.rows.map(({ message, runStart, runEnd }) => (
              <div key={message.clientId || message.id || message.securingSince} data-msg-row className={virtualize ? 'msg-cv pt-0.5' : 'pt-0.5'}>
                {renderMessage(message, { runStart, runEnd })}
              </div>
            ))}
          </div>
        ))}
      </div>
      {showFab && (
        <button
          type="button"
          onClick={() => scrollToBottom('smooth')}
          aria-label="Scroll to latest messages"
          className="z-fab absolute right-4 flex h-11 w-11 items-center justify-center rounded-full border border-line bg-panelStrong shadow-lg active:scale-95"
          style={{ bottom: 'calc(var(--sab) + 6.75rem)' }}
        >
          <ChevronDown size={18} />
          {belowCount > 0 && (
            <span className="absolute -right-1 -top-1 rounded-full bg-accent px-1.5 py-0.5 text-[10px] font-bold leading-none text-accentInk">
              {belowCount > 99 ? '99+' : belowCount}
            </span>
          )}
        </button>
      )}
    </>
  );
}
