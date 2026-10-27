import React, { useEffect, useRef, useState } from 'react';
import { motion, useMotionValue, useTransform, animate } from 'framer-motion';
import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Bell,
  BellOff,
  Ban,
  ChevronDown,
  ChevronUp,
  Flame,
  MessageSquare,
  MoreVertical,
  Pin,
  PinOff,
  Search,
  Store,
  Users,
  X,
} from 'lucide-react';
import { useChatStore } from '../../store/chatStore';
import { haptic } from '../../lib/haptics';
import { noHexName } from '../../lib/npub';
import Logo from '../Logo';
import Avatar from '../ui/Avatar';
import IconButton from '../ui/IconButton';
import Segmented from '../ui/Segmented';
import ListRow from '../ui/ListRow';
import Badge from '../ui/Badge';
import EmptyState from '../ui/EmptyState';
import { SkeletonList } from '../ui/Skeleton';
import { formatRelativeTime } from './relativeTime';

// The segmented filter: All / Menus / Vendors. A client-side filter over the
// same list — a menu is a channel-type space; a vendor is a chat where
// commerce happened (an order crossed it, or the peer sent a product). The
// store carries no per-peer vendor flag.
const SEGMENTS = [
  { key: 'all', label: 'All' },
  { key: 'menus', label: 'Menus' },
  { key: 'vendors', label: 'Vendors' },
];

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

function MenuItem({ icon, children, onClick, danger = false }) {
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

// One chat row. Swipe right pins, swipe left opens the mute durations;
// both also live in the row kebab. The preview line is blurred until the
// row is long-pressed; the reveal holds until you leave the list.
function ChatRow({
  chat,
  name,
  previewText,
  typing,
  unread,
  muted,
  pinned,
  archived,
  blocked,
  isRevealed,
  menuOpen,
  menuPanel,
  onOpen,
  onPressStart,
  onPressCancel,
  onMenuToggle,
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
  const lastDragAt = useRef(0);
  const pinOpacity = useTransform(x, [12, SWIPE_TRIGGER], [0, 1]);
  const muteOpacity = useTransform(x, [-SWIPE_TRIGGER, -12], [1, 0]);
  const isDm = chat.type === 'dm';

  const commitSwipe = (info) => {
    const offset = info.offset.x;
    animate(x, 0, { type: 'spring', stiffness: 420, damping: 34 });
    if (Math.abs(offset) > 10) lastDragAt.current = Date.now();
    if (Math.abs(offset) < SWIPE_TRIGGER) return;
    haptic('light');
    if (offset > 0) onTogglePin();
    else onOpenMuteMenu();
  };

  const timeLabel = formatRelativeTime(chat.lastMsg?.timestamp);
  const avatar = isDm ? (
    <Avatar src={chat.profile.picture} name={name} className="!h-10 !w-10 !text-[13px]" />
  ) : (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-line bg-panelAlt text-[13px] font-semibold text-accentText">
      {initialsOf(name)}
    </span>
  );

  return (
    <div className="relative">
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
        <ListRow
          className="border-b border-line last:border-b-0"
          dense={pinned}
          leading={avatar}
          onClick={() => {
            if (Date.now() - lastDragAt.current < 300) return;
            onOpen();
          }}
          onPointerDown={onPressStart}
          onPointerUp={onPressCancel}
          onPointerLeave={onPressCancel}
          onPointerCancel={onPressCancel}
          onContextMenu={(e) => e.preventDefault()}
          title={(
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[15px] font-semibold text-ink">{name}</span>
              <span className="flex shrink-0 items-center gap-1">
                {timeLabel && <span className="text-[11px] font-medium text-inkSubtle">{timeLabel}</span>}
                {pinned && <Pin size={12} className="text-inkSubtle" />}
              </span>
            </span>
          )}
          subtitle={(
            <span className="mt-0.5 flex items-center justify-between gap-2">
              <span
                aria-label={typing ? 'typing' : undefined}
                className={`block truncate text-[13px] transition-all duration-200 select-none ${typing ? 'text-accentText' : 'text-inkMuted'} ${previewText && !isRevealed ? 'blur-[5px]' : ''}`}
              >
                {typing ? (
                  <span className="inline-flex items-center gap-1">
                    typing
                    <span className="typing-dots inline-flex items-center gap-0.5 text-[15px] leading-none" aria-hidden="true">
                      <span>·</span><span>·</span><span>·</span>
                    </span>
                  </span>
                ) : (previewText || (isDm ? 'Tap to chat' : (chat.group.isChannel ? 'Channel' : 'Public group')))}
              </span>
              {chat.vendor && !typing && (
                <span className="shrink-0 text-[12px] font-semibold text-accentText">Shop</span>
              )}
            </span>
          )}
          meta={(
            <span className="flex shrink-0 flex-col items-end gap-1">
              {unread > 0 ? (
                <Badge tone="unread" title={`${unread} unread`}>{unread > 99 ? '99+' : unread}</Badge>
              ) : (muted && <BellOff size={12} className="text-inkSubtle" />)}
            </span>
          )}
          trailing={(
            <span className="relative shrink-0">
              <IconButton
                icon={<MoreVertical size={16} />}
                label="Chat options"
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                className="h-11 w-11"
                onClick={onMenuToggle}
              />
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
                    className="absolute right-2 top-2 z-fab w-44 overflow-hidden rounded-xl border border-lineStrong bg-panelStrong shadow-lg"
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
                        {chat.vendor && isDm && (
                          <MenuItem icon={<Store size={14} className="text-inkMuted" />} onClick={() => { onViewShop(); onMenuClose(); }}>
                            View shop
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
            </span>
          )}
        />
      </motion.div>
    </div>
  );
}

// The chat list, Telegram anatomy with the cipher skin: logo chip + title,
// in-place filter, kebab (New chat / New group / Burn note — the same
// actions the floating menu wires), segmented filter, PINNED section,
// 64px rows, archived section.
export default function ChatList({ onOpenChat }) {
  const dms = useChatStore((s) => s.dms);
  const groups = useChatStore((s) => s.groups);
  const groupMessages = useChatStore((s) => s.groupMessages);
  const profiles = useChatStore((s) => s.profiles);
  const unreadCounts = useChatStore((s) => s.unreadCounts);
  const mutedChats = useChatStore((s) => s.mutedChats);
  const mutedUntil = useChatStore((s) => s.mutedUntil);
  const archivedChats = useChatStore((s) => s.archivedChats);
  const pinnedChats = useChatStore((s) => s.pinnedChats);
  const blockedUsers = useChatStore((s) => s.blockedUsers);
  const typingUsers = useChatStore((s) => s.typingUsers);
  const loading = useChatStore((s) => s.loading);
  const setView = useChatStore((s) => s.setView);
  const setShowCreateGroup = useChatStore((s) => s.setShowCreateGroup);
  const setShowDeadDrop = useChatStore((s) => s.setShowDeadDrop);
  const setVendorStorefrontPubkey = useChatStore((s) => s.setVendorStorefrontPubkey);
  const togglePinChat = useChatStore((s) => s.togglePinChat);

  const [segment, setSegment] = useState('all');
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [revealed, setRevealed] = useState(() => new Set());
  const [menuFor, setMenuFor] = useState(null);
  const [menuPanel, setMenuPanel] = useState('main');
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const pressTimer = useRef(null);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  const startPress = (id) => {
    cancelPress();
    pressTimer.current = window.setTimeout(() => {
      setRevealed((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    }, 450);
  };
  const cancelPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };
  const open = (type, id, group) => {
    setRevealed(new Set());
    onOpenChat(type, id, group);
  };
  const isMuted = (id) => mutedChats.includes(id)
    || mutedUntil[id] === 'forever'
    || (typeof mutedUntil[id] === 'number' && mutedUntil[id] > now);

  // Durations land as timed mutedUntil values; unmute clears both the
  // timed map and the legacy boolean list.
  const muteFor = (id, durationMs = 0) => {
    useChatStore.getState().setMuteDuration(id, durationMs);
    if (durationMs === 0 && mutedChats.includes(id)) {
      useChatStore.getState().toggleMuteChat(id);
    }
  };

  const dmList = Object.entries(dms).map(([pubkey, msgs]) => {
    const profile = profiles[pubkey];
    const safeProfile = (profile && profile.name && !/^[0-9a-f]{8,64}$/i.test(profile.name))
      ? profile
      : { displayName: noHexName(profile, pubkey), picture: null, name: noHexName(profile, pubkey) };
    const commercial = msgs.some((m) => m.data?.type === 'cipher_order' || m.data?.type === 'order_request' || m.data?.type === 'product');
    return { type: 'dm', id: pubkey, lastMsg: msgs[msgs.length - 1], profile: safeProfile, vendor: commercial };
  });

  const groupList = groups.map(g => ({
    type: 'group',
    id: g.id,
    group: g,
    menu: g.isChannel === true,
    lastMsg: groupMessages[g.id]?.[groupMessages[g.id].length - 1]
  }));

  const chatMap = new Map();
  [...dmList, ...groupList].forEach(c => chatMap.set(c.id, c));

  const allChats = Array.from(chatMap.values()).sort(
    (a, b) => (b.lastMsg?.timestamp || 0) - (a.lastMsg?.timestamp || 0)
  );

  // Typing state, per row. DMs key by the peer in the store, so they light
  // truthfully. Group typing is one set for every group (the store keys it
  // by member, not group), so it cannot be attributed to a row — it stays
  // DM-only until the store keys it per group.
  const typingFor = (chat) => {
    if (chat.type !== 'dm') return false;
    const at = typingUsers[chat.id];
    return Boolean(at && now - at < 6000);
  };

  const previewOf = (chat) => {
    const m = chat.lastMsg;
    if (!m) return null;
    const text = m.data?.type === 'cipher_order' ? 'Order'
      : m.data?.type === 'image' ? 'Photo'
      : m.data?.type === 'audio' ? 'Voice note'
      : (m.data?.message || m.rawContent || 'Message');
    if (chat.type === 'group' && m.pubkey) {
      const sender = m.isSender ? 'You' : noHexName(profiles[m.pubkey], m.pubkey);
      return `${sender}: ${text}`;
    }
    return text;
  };

  const nameOf = (chat) => (chat.type === 'dm'
    ? chat.profile.displayName
    : (chat.group.name && !chat.group.name.startsWith('Group ') ? chat.group.name : 'Unnamed Group'));

  if (loading) {
    return (
      <div className="px-4 pb-4">
        <SkeletonList rows={6} />
      </div>
    );
  }

  if (allChats.length === 0) {
    return (
      <div className="px-4 pb-4">
        <EmptyState
          icon={<MessageSquare size={24} />}
          title="No chats yet — your first message starts the cipher"
          actionLabel="New chat"
          onAction={() => setView('search')}
        />
      </div>
    );
  }

  const needle = query.trim().toLowerCase();
  const active = allChats.filter(c => !archivedChats.includes(c.id));
  const archived = allChats.filter(c => archivedChats.includes(c.id));
  const shownChats = active.filter((chat) => {
    if (segment === 'menus') return chat.type === 'group' && chat.menu === true;
    if (segment === 'vendors') return chat.vendor === true;
    return true;
  }).filter((chat) => {
    if (!needle) return true;
    const name = nameOf(chat).toLowerCase();
    const preview = (previewOf(chat) || '').toLowerCase();
    return name.includes(needle) || preview.includes(needle);
  });
  const shownArchived = archived.filter((chat) => {
    if (!needle) return true;
    return nameOf(chat).toLowerCase().includes(needle) || (previewOf(chat) || '').toLowerCase().includes(needle);
  });

  const renderRow = (chat, { pinned = false } = {}) => (
    <ChatRow
      key={chat.id}
      chat={chat}
      name={nameOf(chat)}
      previewText={previewOf(chat)}
      typing={typingFor(chat)}
      unread={unreadCounts[chat.id] || 0}
      muted={isMuted(chat.id)}
      pinned={pinned}
      archived={archivedChats.includes(chat.id)}
      blocked={chat.type === 'dm' && blockedUsers.includes(chat.id)}
      isRevealed={revealed.has(chat.id)}
      menuOpen={menuFor === chat.id}
      menuPanel={menuPanel}
      onOpen={() => open(chat.type, chat.id, chat.group)}
      onPressStart={() => startPress(chat.id)}
      onPressCancel={cancelPress}
      onMenuToggle={() => {
        setMenuPanel('main');
        setMenuFor(menuFor === chat.id ? null : chat.id);
      }}
      onMenuClose={() => { setMenuFor(null); setMenuPanel('main'); }}
      onMenuBack={() => setMenuPanel('main')}
      onOpenMuteMenu={() => { setMenuPanel('mute'); setMenuFor(chat.id); }}
      onMute={(durationMs) => muteFor(chat.id, durationMs)}
      onUnmute={() => muteFor(chat.id, 0)}
      onTogglePin={() => { haptic('light'); togglePinChat(chat.id); }}
      onToggleArchive={() => useChatStore.getState().toggleArchiveChat(chat.id)}
      onViewShop={() => setVendorStorefrontPubkey(chat.id)}
      onToggleBlock={() => useChatStore.getState().toggleBlockUser(chat.id)}
    />
  );

  const pinnedRows = shownChats.filter(c => pinnedChats.includes(c.id));
  const regularRows = shownChats.filter(c => !pinnedChats.includes(c.id));

  return (
    <div className="px-4 pb-4">
      {/* Header row: logo chip + title left, filter and kebab right. */}
      <div className="mb-2 flex items-center justify-between gap-2 pt-3 md:px-3">
        <div className="flex min-w-0 items-center gap-2">
          <Logo size={20} />
          <h2 className="text-xl font-bold tracking-tight text-ink">Chats</h2>
        </div>
        {searchOpen ? (
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setSearchOpen(false); setQuery(''); }
              }}
              placeholder="Filter chats"
              aria-label="Filter chats"
              autoFocus
              className="h-11 min-w-0 flex-1 rounded-full border border-line bg-panel px-4 text-[14px] text-ink outline-none focus:border-accent"
            />
            <IconButton
              icon={<X size={18} />}
              label="Close filter"
              onClick={() => { setSearchOpen(false); setQuery(''); }}
            />
          </div>
        ) : (
          <div className="flex items-center">
            <IconButton
              icon={<Search size={20} />}
              label="Search chats"
              onClick={() => setSearchOpen(true)}
            />
            <span className="relative">
              <IconButton
                icon={<MoreVertical size={20} />}
                label="Chat list menu"
                aria-expanded={headerMenuOpen}
                aria-haspopup="menu"
                onClick={() => setHeaderMenuOpen(!headerMenuOpen)}
              />
              {headerMenuOpen && (
                <>
                  <button
                    type="button"
                    aria-label="Close menu"
                    onClick={() => setHeaderMenuOpen(false)}
                    className="fixed inset-0 z-fab cursor-default"
                  />
                  <div
                    role="menu"
                    onKeyDown={(e) => { if (e.key === 'Escape') setHeaderMenuOpen(false); }}
                    className="absolute right-0 top-11 z-fab w-44 overflow-hidden rounded-xl border border-lineStrong bg-panelStrong shadow-lg"
                  >
                    {/* Same actors the floating menu wires — this kebab is the primary door. */}
                    <MenuItem icon={<MessageSquare size={14} className="text-inkMuted" />} onClick={() => { setHeaderMenuOpen(false); setView('search'); }}>
                      New chat
                    </MenuItem>
                    <MenuItem icon={<Users size={14} className="text-inkMuted" />} onClick={() => { setHeaderMenuOpen(false); setShowCreateGroup(true); }}>
                      New group
                    </MenuItem>
                    <MenuItem icon={<Flame size={14} className="text-inkMuted" />} onClick={() => { setHeaderMenuOpen(false); setShowDeadDrop(true); }}>
                      Burn note
                    </MenuItem>
                  </div>
                </>
              )}
            </span>
          </div>
        )}
      </div>

      <Segmented options={SEGMENTS} value={segment} onChange={setSegment} ariaLabel="Filter chats" className="mb-2" />

      {pinnedRows.length > 0 && (
        <>
          <p className="px-1 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-inkSubtle">Pinned</p>
          <div className="overflow-hidden">{pinnedRows.map((chat) => renderRow(chat, { pinned: true }))}</div>
        </>
      )}

      {regularRows.length > 0 && (
        <div className={pinnedRows.length > 0 ? 'pt-2' : 'pt-3'}>{regularRows.map((chat) => renderRow(chat))}</div>
      )}

      {shownChats.length === 0 && (
        <p className="px-4 py-10 text-center text-[13px] text-inkMuted">
          {needle
            ? 'No chats match that filter.'
            : segment === 'menus' ? 'No menus here yet.' : 'No vendor chats yet.'}
        </p>
      )}

      {shownArchived.length > 0 && (
        <>
          <button
            type="button"
            aria-expanded={archivedOpen}
            onClick={() => setArchivedOpen(!archivedOpen)}
            className="mt-3 flex min-h-[44px] w-full items-center gap-1 px-1 text-[11px] font-semibold uppercase tracking-wider text-inkSubtle hover:text-inkMuted"
          >
            {archivedOpen ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            Archived
          </button>
          {archivedOpen && <div className="overflow-hidden">{shownArchived.map((chat) => renderRow(chat))}</div>}
        </>
      )}
    </div>
  );
}
