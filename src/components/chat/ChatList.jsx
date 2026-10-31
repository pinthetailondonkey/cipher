import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bell,
  Bookmark,
  ChevronDown,
  ChevronUp,
  Flame,
  MessageSquare,
  MoreVertical,
  QrCode,
  RefreshCw,
  Search,
  SquarePen,
  Store,
  Users,
  X,
} from 'lucide-react';
import { notifTotalOf, useChatStore } from '../../store/chatStore';
import { boundReceipts } from '../../lib/vendorReviews';
import { haptic } from '../../lib/haptics';
import { noHexName } from '../../lib/npub';
import IconButton from '../ui/IconButton';
import Logo from '../Logo';
import EmptyState from '../ui/EmptyState';
import { SkeletonList } from '../ui/Skeleton';
import ChatRow, { MenuItem } from './ChatRow';

// The segmented filter: All / Menus / Vendors. A client-side filter over the
// same list — a menu is a channel-type space; a vendor is a chat where
// commerce happened (an order crossed it, or the peer sent a product). The
// store carries no per-peer vendor flag.
const SEGMENTS = [
  { value: 'all', label: 'All' },
  { value: 'menus', label: 'Menus' },
  { value: 'vendors', label: 'Vendors' },
];

// The chat list, Telegram anatomy with the cipher skin: one 56px header
// (overflow left, "Chats" middle, compose right), the filter over the chats
// already here, the All / Menus / Vendors row, PINNED section, rows,
// archived section. The floating plus is gone: the header's compose button
// opens the same New chat screen, and the overflow carries every other door
// the old icon row and the phone drawer used to hold.
export default function ChatList({ onOpenChat, onRefresh }) {
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
  const setShowCreateGroup = useChatStore((s) => s.setShowCreateGroup);
  const setIsChannel = useChatStore((s) => s.setIsChannel);
  const setShowDeadDrop = useChatStore((s) => s.setShowDeadDrop);
  const setVendorStorefrontPubkey = useChatStore((s) => s.setVendorStorefrontPubkey);
  const togglePinChat = useChatStore((s) => s.togglePinChat);
  const setView = useChatStore((s) => s.setView);
  const setShowBookmarks = useChatStore((s) => s.setShowBookmarks);
  const setShowNotifCenter = useChatStore((s) => s.setShowNotifCenter);
  const setShowQRScanner = useChatStore((s) => s.setShowQRScanner);
  const notifTotal = useChatStore(notifTotalOf);

  const [segment, setSegment] = useState('all');
  const [query, setQuery] = useState('');
  const [revealed, setRevealed] = useState(() => new Set());
  const [menuFor, setMenuFor] = useState(null);
  const [menuPanel, setMenuPanel] = useState('main');
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  // The refresh item runs its fetch with the menu held open, because the
  // spinning arrow inside the menu is the only sign the press did anything.
  // The list itself never swaps away for a refresh: the global loader would
  // replace the whole screen, thread and all, for what is a re-read.
  const [refreshing, setRefreshing] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());
  const pressTimer = useRef(null);

  useEffect(() => {
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(tick);
  }, []);

  // A long press is the row's menu now that the three-dot button is gone:
  // the same panel the kebab used to open, with the same actions.
  const startPress = (id) => {
    cancelPress();
    pressTimer.current = window.setTimeout(() => {
      haptic('light');
      setMenuPanel('main');
      setMenuFor(id);
    }, 450);
  };
  const reveal = (id) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
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

  // The early screens (loading skeleton, empty state) render BELOW the
  // header, not instead of it: the header carries the drawer, bookmarks,
  // notifications, QR, refresh and search doors, and an empty list is the
  // moment a new account needs those doors most. Regression: the empty
  // return used to sit above the header render, which stranded those
  // buttons on exactly the screen where they matter.
  // A menu door belongs only where there is a menu behind it: a key this
  // device has bought from (a bound receipt names them the vendor) or one
  // whose product or order already arrived in the thread. The old gate read
  // the thread alone, so a vendor met through a shared link and never
  // messaged had no door at all.
  const soldTo = useMemo(() => {
    const vendors = new Set();
    try {
      for (const row of boundReceipts()) {
        const vendor = String(row?.receipt?.body?.vendor || '').toLowerCase();
        if (vendor) vendors.add(vendor);
      }
    } catch { /* no storage, no claim */ }
    return vendors;
  }, [dms]);

  const dmList = Object.entries(dms).map(([pubkey, msgs]) => {
    const profile = profiles[pubkey];
    const safeProfile = (profile && profile.name && !/^[0-9a-f]{8,64}$/i.test(profile.name))
      ? profile
      : { displayName: noHexName(profile, pubkey), picture: null, name: noHexName(profile, pubkey) };
    const commercial = msgs.some((m) => m.data?.type === 'cipher_order' || m.data?.type === 'order_request' || m.data?.type === 'product');
    const menuDoor = commercial || soldTo.has(pubkey.toLowerCase());
    return { type: 'dm', id: pubkey, lastMsg: msgs[msgs.length - 1], profile: safeProfile, vendor: commercial, menuDoor };
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
    // Every kind the thread draws an order card for reads as the same word.
    // One phrase, not one per kind: the row says a card is an order, and the
    // card and the Orders tab say what state it is in. Naming the state here
    // would be a headline this screen does not own, and would be new copy.
    const text = ['cipher_order', 'order_request', 'order_update'].includes(m.data?.type) ? 'Order'
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

  const renderRow = (chat, { pinned = false, divider = true } = {}) => (
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
      menuDoor={chat.menuDoor === true}
      isRevealed={revealed.has(chat.id)}
      menuOpen={menuFor === chat.id}
      menuPanel={menuPanel}
      divider={divider}
      onOpen={() => open(chat.type, chat.id, chat.group)}
      onReveal={() => reveal(chat.id)}
      onPressStart={() => startPress(chat.id)}
      onPressCancel={cancelPress}
      onMenuOpen={() => {
        setMenuPanel('main');
        setMenuFor(chat.id);
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

  const listHeader = (
    /* The founder's phone header, one 56px line: one overflow on the left,
       the screen's name in the middle, one compose on the right. Everything
       the old row of icons and the drawer did lives inside the overflow, so
       every door still opens and nothing crowds the title. */
    <div className="sticky top-0 z-fab -mx-4 bg-header px-4 pt-safe md:px-3">
      <div className="flex h-14 items-center gap-1">
        <span className="relative">
          <IconButton
            icon={<MoreVertical size={22} />}
            label="Chat list menu"
            aria-expanded={headerMenuOpen}
            aria-haspopup="menu"
            onClick={() => setHeaderMenuOpen(!headerMenuOpen)}
          />
          {notifTotal > 0 && (
            <span className="pointer-events-none absolute right-2 top-2 h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
          )}
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
                className="absolute left-0 top-12 z-fab w-52 overflow-hidden rounded-xl border border-lineStrong bg-panelStrong shadow-lg"
              >
                {/* The one creation menu on this screen: opening it closes
                    any row menu, and every action closes it before it
                    navigates. */}
                <MenuItem icon={<Users size={14} className="text-inkMuted" />} onClick={() => { setHeaderMenuOpen(false); setShowCreateGroup(true); }}>
                  New group
                </MenuItem>
                <MenuItem icon={<Store size={14} className="text-inkMuted" />} onClick={() => { setHeaderMenuOpen(false); setIsChannel(true); setShowCreateGroup(true); }}>
                  New menu
                </MenuItem>
                <MenuItem icon={<Flame size={14} className="text-inkMuted" />} onClick={() => { setHeaderMenuOpen(false); setShowDeadDrop(true); }}>
                  Burn note
                </MenuItem>
                <MenuItem icon={<Bookmark size={14} className="text-inkMuted" />} onClick={() => { setHeaderMenuOpen(false); setShowBookmarks(true); }}>
                  Saved messages
                </MenuItem>
                <MenuItem icon={<QrCode size={14} className="text-inkMuted" />} onClick={() => { setHeaderMenuOpen(false); setShowQRScanner(true); }}>
                  Scan QR code
                </MenuItem>
                <MenuItem icon={<Bell size={14} className="text-inkMuted" />} onClick={() => { setHeaderMenuOpen(false); setShowNotifCenter(true); }}>
                  Notifications
                </MenuItem>
                {onRefresh && (
                  <MenuItem
                    icon={<RefreshCw size={14} className={loading || refreshing ? 'animate-spin' : 'text-inkMuted'} />}
                    onClick={async () => {
                      if (refreshing) return;
                      setRefreshing(true);
                      try {
                        await onRefresh();
                      } catch {
                        // fetchChats has already said why in a toast; the
                        // press is answered either way, so the spinner stops
                        // and the menu closes whatever the fetch returned.
                      } finally {
                        setRefreshing(false);
                        setHeaderMenuOpen(false);
                      }
                    }}
                  >
                    Refresh chats
                  </MenuItem>
                )}
              </div>
            </>
          )}
        </span>
        <div className="flex min-w-0 flex-1 items-center justify-center gap-2">
          {/* The logo's one home: 28px, 8px gap, Chats only (DESIGN.md). */}
          <Logo size={28} className="shrink-0" />
          <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight text-ink">Chats</h2>
        </div>
        <IconButton
          icon={<SquarePen size={22} />}
          label="New chat"
          onClick={() => setView('search')}
        />
      </div>
      <div className="pb-2">
        <div className="flex h-11 items-center gap-2 rounded-xl border border-line bg-panel px-3">
          <Search size={16} className="shrink-0 text-inkSubtle" aria-hidden="true" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
            placeholder="Filter chats"
            aria-label="Filter chats"
            className="h-11 min-w-0 flex-1 bg-transparent text-[14px] text-ink placeholder-inkSubtle outline-none"
          />
          {query && (
            <IconButton
              icon={<X size={16} />}
              label="Clear filter"
              onClick={() => setQuery('')}
            />
          )}
        </div>
      </div>
    </div>
  );

  // The early screens (loading skeleton, empty state) render the header
  // ABOVE their body, not instead of it: the header carries the drawer,
  // bookmarks, notifications, QR, refresh and search doors, and an empty
  // list is the moment a new account needs those doors most. Regression:
  // the empty return used to sit above the header render, which stranded
  // those buttons on exactly the screen where they matter.
  if (loading) {
    return (
      <div className="px-4 pb-4">
        {listHeader}
        <SkeletonList rows={6} />
      </div>
    );
  }

  if (allChats.length === 0) {
    return (
      <div className="px-4 pb-4">
        {listHeader}
        {/* The compose button sits on this screen too, so the empty state
            adds no second door of its own. */}
        <EmptyState
          icon={<MessageSquare size={24} />}
          title="No chats yet — your first message starts the cipher"
        />
      </div>
    );
  }

  return (
    <div className="px-4 pb-4">
      {listHeader}

      {/* The founder's selection row: one 44px line, the chosen one wearing
          the accent. It replaces the card-height pill row; the value/label
          contract is the same one Segmented reads, so the filter is the
          same filter. */}
      <div role="group" aria-label="Filter chats" className="mb-2 flex h-11 items-center gap-1">
        {SEGMENTS.map((option) => {
          const active = option.value === segment;
          return (
            <button
              key={option.value}
              type="button"
              aria-pressed={active}
              onClick={() => { haptic('light'); setSegment(option.value); }}
              className={`h-9 flex-1 rounded-xl px-3 text-[13px] font-semibold transition-colors ${active ? 'bg-accent text-accentInk' : 'text-inkMuted hover:text-ink'}`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      {pinnedRows.length > 0 && (
        <>
          <p className="px-1 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-inkSubtle">Pinned</p>
          {/* No overflow clip here: a row's menu opens inside the row and
              must not be cut off by the section that holds it. */}
          <div>{pinnedRows.map((chat, i) => renderRow(chat, { pinned: true, divider: i < pinnedRows.length - 1 }))}</div>
        </>
      )}

      {regularRows.length > 0 && (
        <div className={pinnedRows.length > 0 ? 'pt-2' : 'pt-3'}>{regularRows.map((chat, i) => renderRow(chat, { divider: i < regularRows.length - 1 }))}</div>
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
          {archivedOpen && <div>{shownArchived.map((chat, i) => renderRow(chat, { divider: i < shownArchived.length - 1 }))}</div>}
        </>
      )}
    </div>
  );
}
