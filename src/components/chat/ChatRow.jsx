import { useRef, useState } from 'react';
import { motion, useMotionValue, useTransform, animate } from 'framer-motion';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Ban,
  Bell,
  BellOff,
  Eye,
  Pin,
  PinOff,
  Store,
} from 'lucide-react';
import { haptic } from '../../lib/haptics';
import useLongPress from '../../hooks/useLongPress';
import Badge from '../ui/Badge';
import { formatRelativeTime } from './relativeTime';

// Mute durations for the swipe-left and kebab submenu, mapped onto the
// store's setMuteDuration values: 0 clears, -1 is forever, otherwise a
// timed mutedUntil timestamp.
const MUTE_DURATIONS = [
  { label: '8 hours', ms: 8 * 60 * 60 * 1000 },
  { label: '1 day', ms: 24 * 60 * 60 * 1000 },
  { label: '1 week', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'Forever', ms: -1 },
];

const SWIPE_TRIGGER = 72;

const initialsOf = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2)
  .map((word) => word[0].toUpperCase()).join('') || '?';

export function MenuItem({ icon, children, onClick, danger = false }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-[44px] w-full items-center gap-2.5 px-3 py-2.5 text-left text-[14px] font-medium active:bg-ink/5 ${danger ? 'text-danger' : 'text-ink'}`}
    >
      {icon}
      {children}
    </button>
  );
}

// One chat row: 72px at normal text, taller when the reader's own type size
// makes it taller — nothing is measured against a fixed height. Swipe right
// pins, swipe left opens the mute durations; both also live in the row menu.
// The menu is no longer a permanently visible three-dot: a long press, a
// right click, or the Context Menu key (Shift+F10) opens it, so the row
// keeps its actions without a button on every line. The preview stays
// blurred until its own line is tapped, and that line says so in words.
export default function ChatRow({
  chat,
  name,
  previewText,
  typing,
  unread,
  muted,
  pinned,
  archived,
  blocked,
  menuDoor,
  isRevealed,
  menuOpen,
  menuPanel,
  divider,
  onOpen,
  onReveal,
  onMenuOpen,
  onMenuClose,
  onMenuBack,
  onOpenMuteMenu,
  onMute,
  onUnmute,
  onTogglePin,
  onToggleArchive,
  onViewShop,
  onToggleBlock,
}) {
  const x = useMotionValue(0);
  // A drag's click arrives at drag end, so a short window is right for it.
  // A press's click can arrive long after the press fired — a finger or a
  // mouse held down to read the menu — so the press leaves a flag instead:
  // the next click is swallowed once, and pointerdown clears it so a press
  // that ends in a cancel without a click cannot eat a later real click.
  const lastDragAt = useRef(0);
  const pressFired = useRef(false);
  const clickConsumed = () => {
    if (pressFired.current) {
      pressFired.current = false;
      return true;
    }
    return Date.now() - lastDragAt.current < 300;
  };

  // The row's menu door: a 500ms still finger. A drift, a lift or a cancel
  // gives the press up (the hook owns the timer and its cleanup).
  const pressProps = useLongPress(() => {
    pressFired.current = true;
    haptic('light');
    onMenuOpen();
  });
  const onPointerDown = (event) => {
    pressFired.current = false;
    pressProps.onPointerDown(event);
  };
  const pinOpacity = useTransform(x, [12, SWIPE_TRIGGER], [0, 1]);
  const muteOpacity = useTransform(x, [-SWIPE_TRIGGER, -12], [1, 0]);
  const isDm = chat.type === 'dm';
  const blurred = Boolean(previewText) && !isRevealed;

  const commitSwipe = (info) => {
    const offset = info.offset.x;
    animate(x, 0, { type: 'spring', stiffness: 420, damping: 34 });
    if (Math.abs(offset) > 10) lastDragAt.current = Date.now();
    if (Math.abs(offset) < SWIPE_TRIGGER) return;
    haptic('light');
    if (offset > 0) onTogglePin();
    else onOpenMuteMenu();
  };

  // The keyboard door to the menu the mouse and the finger already have.
  const menuKey = (event) => {
    if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      onMenuOpen();
    }
  };

  const timeLabel = formatRelativeTime(chat.lastMsg?.timestamp);
  // A picture that fails to load leaves initials, never an empty hole.
  const picture = isDm ? chat.profile.picture : null;
  const [pictureFailed, setPictureFailed] = useState(false);
  const showPicture = Boolean(picture) && !pictureFailed;
  const initials = (
    <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border border-line bg-panelAlt text-[15px] font-semibold text-accentText">
      {initialsOf(name)}
    </span>
  );
  const avatar = showPicture ? (
    <img
      src={picture}
      alt=""
      onError={() => setPictureFailed(true)}
      className="h-12 w-12 shrink-0 rounded-full border border-line object-cover"
    />
  ) : initials;

  const preview = typing ? (
    <span aria-label="typing" className="text-accentText transition-all duration-200 select-none">
      <span className="inline-flex items-center gap-1">
        typing
        <span className="typing-dots inline-flex items-center gap-0.5 text-[15px] leading-none" aria-hidden="true">
          <span>·</span><span>·</span><span>·</span>
        </span>
      </span>
    </span>
  ) : blurred ? (
    /* DESIGN.md: a hidden preview is the blurred line plus one small eye
       icon, never a labelled reveal pill. The icon is the control; the
       words are its spoken label, not text on the row. */
    <button
      type="button"
      onClick={() => { if (clickConsumed()) return; onReveal(); }}
      aria-label="Show message preview"
      className="flex min-w-0 flex-1 items-center gap-2 text-left"
    >
      <span aria-hidden="true" className="min-w-0 flex-1 truncate text-[14px] text-inkMuted blur-[5px] select-none">{previewText}</span>
      <Eye size={14} aria-hidden="true" className="shrink-0 text-inkMuted" />
    </button>
  ) : (
    <button type="button" onClick={() => { if (clickConsumed()) return; onOpen(); }} className="min-w-0 flex-1 truncate text-left text-[14px] text-inkMuted">
      {previewText || (isDm ? 'Tap to chat' : (chat.group.isChannel ? 'Menu' : 'Public group'))}
    </button>
  );

  return (
    <div
      className="relative"
      {...pressProps}
      onPointerDown={onPointerDown}
      onPointerLeave={pressProps.onPointerCancel}
      onContextMenu={(e) => { e.preventDefault(); onMenuOpen(); }}
    >
      <motion.div style={{ opacity: pinOpacity }} className="pointer-events-none absolute inset-0 flex items-center gap-2 bg-accentSoft pl-5 text-accentText">
        {pinned ? <PinOff size={16} /> : <Pin size={16} />}
        <span className="text-[13px] font-semibold">{pinned ? 'Unpin' : 'Pin'}</span>
      </motion.div>
      <motion.div style={{ opacity: muteOpacity }} className="pointer-events-none absolute inset-0 flex items-center justify-end gap-2 bg-accentSoft pr-5 text-accentText">
        <span className="text-[13px] font-semibold">{muted ? 'Unmute' : 'Mute'}</span>
        <BellOff size={16} />
      </motion.div>
      <motion.div
        style={{ x }}
        drag="x"
        dragDirectionLock
        dragConstraints={{ left: -110, right: 110 }}
        dragElastic={0.25}
        onDragEnd={(e, info) => commitSwipe(info)}
      >
        {/* Avatar sits outside the bordered column, so the divider starts
            under the text and never runs through the picture. */}
        <div className="flex items-stretch gap-3 pl-4">
          <span className="flex shrink-0 items-center">{avatar}</span>
          <div className={`flex min-h-[72px] min-w-0 flex-1 items-center gap-2 pr-4 ${divider ? 'border-b border-line' : ''}`}>
            <div className="min-w-0 flex-1 py-2.5">
              <button
                type="button"
                onClick={() => {
                  if (clickConsumed()) return;
                  onOpen();
                }}
                onKeyDown={menuKey}
                className="flex w-full items-baseline gap-2 text-left"
              >
                <span className="min-w-0 flex-1 break-words text-[16px] font-semibold text-ink">{name}</span>
                {pinned && <Pin size={12} className="shrink-0 text-inkSubtle" />}
              </button>
              <div className="mt-0.5 flex items-center gap-2">
                {preview}
                {chat.vendor && !typing && !blurred && (
                  <span className="shrink-0 text-[12px] font-semibold text-accentText">Menu</span>
                )}
              </div>
            </div>
            <span className="flex shrink-0 flex-col items-end gap-1">
              {timeLabel && <span className="text-[12px] font-medium text-inkSubtle">{timeLabel}</span>}
              {unread > 0 ? (
                <Badge tone="unread" title={`${unread} unread`}>{unread > 99 ? '99+' : unread}</Badge>
              ) : (muted && <BellOff size={12} className="text-inkSubtle" />)}
            </span>
          </div>
        </div>
      </motion.div>
      {menuOpen && (
        <>
          <button
            type="button"
            aria-label="Close options"
            onClick={onMenuClose}
            className="fixed inset-0 z-fab cursor-default"
          />
          <div
            role="menu"
            onKeyDown={(e) => { if (e.key === 'Escape') onMenuClose(); }}
            className="absolute right-3 top-3 z-fab w-44 overflow-hidden rounded-xl border border-lineStrong bg-panelStrong shadow-lg"
          >
            {menuPanel === 'mute' ? (
              <>
                <MenuItem icon={<ArrowLeft size={14} className="text-inkMuted" />} onClick={onMenuBack}>
                  Mute for
                </MenuItem>
                {MUTE_DURATIONS.map((duration) => (
                  <MenuItem key={duration.label} onClick={() => { onMute(duration.ms); onMenuClose(); }}>
                    {duration.label}
                  </MenuItem>
                ))}
                {muted && <MenuItem icon={<Bell size={14} className="text-inkMuted" />} onClick={() => { onUnmute(); onMenuClose(); }}>Unmute</MenuItem>}
              </>
            ) : (
              <>
                <MenuItem
                  icon={muted ? <Bell size={14} className="text-inkMuted" /> : <BellOff size={14} className="text-inkMuted" />}
                  onClick={() => { if (muted) { onUnmute(); onMenuClose(); } else onOpenMuteMenu(); }}
                >
                  {muted ? 'Unmute' : 'Mute'}
                </MenuItem>
                <MenuItem
                  icon={pinned ? <PinOff size={14} className="text-inkMuted" /> : <Pin size={14} className="text-inkMuted" />}
                  onClick={() => { onTogglePin(); onMenuClose(); }}
                >
                  {pinned ? 'Unpin' : 'Pin'}
                </MenuItem>
                <MenuItem
                  icon={archived ? <ArchiveRestore size={14} className="text-inkMuted" /> : <Archive size={14} className="text-inkMuted" />}
                  onClick={() => { onToggleArchive(); onMenuClose(); }}
                >
                  {archived ? 'Unarchive' : 'Archive'}
                </MenuItem>
                {isDm && menuDoor && (
                  <MenuItem icon={<Store size={14} className="text-inkMuted" />} onClick={() => { onViewShop(); onMenuClose(); }}>
                    Their menu
                  </MenuItem>
                )}
                {isDm && (
                  <MenuItem danger icon={<Ban size={14} className="text-danger" />} onClick={() => { onToggleBlock(); onMenuClose(); }}>
                    {blocked ? 'Unblock peer' : 'Block peer'}
                  </MenuItem>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
