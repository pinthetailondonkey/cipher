import { create } from 'zustand';
import { scopedGet, scopedSet } from '../lib/storage';
import { markChatRead } from '../db';
import { orderState } from '../lib/orderActions';

const safeStorage = {
  getItem(key) {
    try {
      return globalThis.localStorage ? globalThis.localStorage.getItem(key) : null;
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      if (globalThis.localStorage) globalThis.localStorage.setItem(key, value);
    } catch {}
  },
};

const normalizeBookmarks = (saved) => {
  if (Array.isArray(saved)) {
    return saved.filter((item) => item && typeof item.chatId === 'string' && typeof item.msgId === 'string');
  }
  if (saved && typeof saved === 'object') {
    return Object.entries(saved).flatMap(([chatId, messageIds]) =>
      (Array.isArray(messageIds) ? messageIds : []).map((msgId) => ({ chatId, msgId }))
    );
  }
  return [];
};

function sameShallow(prev, next) {
  if (Object.is(prev, next)) return true;
  if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return false;
  if (Array.isArray(prev) || Array.isArray(next)) {
    if (!Array.isArray(prev) || !Array.isArray(next) || prev.length !== next.length) return false;
    for (let i = 0; i < prev.length; i += 1) if (!Object.is(prev[i], next[i])) return false;
    return true;
  }
  const prevKeys = Object.keys(prev);
  const nextKeys = Object.keys(next);
  if (prevKeys.length !== nextKeys.length) return false;
  for (const key of prevKeys) {
    if (!Object.prototype.hasOwnProperty.call(next, key) || !Object.is(prev[key], next[key])) return false;
  }
  return true;
}

function keepIfUnchanged(state, key, next) {
  return sameShallow(state[key], next) ? state : { [key]: next };
}

const EMPTY_LIST = [];
const EMPTY_COUNTS = {};
let reactionSource = EMPTY_LIST;
let reactionKeyCached = '';
let unreadSource = null;
let unreadTotalCached = 0;
let notifSource = null;
let notifAckSource = null;
let notifTotalCached = 0;

export function reactionSubscriptionKey(state) {
  const list = state?.view === 'group'
    ? (state.groupMessages?.[state.activeGroup?.id] || EMPTY_LIST)
    : (state?.dms?.[state.activeDm] || EMPTY_LIST);
  if (list === reactionSource) return reactionKeyCached;
  reactionSource = list;
  const ids = [];
  const start = Math.max(0, list.length - 30);
  for (let i = start; i < list.length; i += 1) {
    const id = list[i]?.id;
    if (id && !String(id).startsWith('temp')) ids.push(id);
  }
  reactionKeyCached = ids.join(',');
  return reactionKeyCached;
}

export function unreadTotalOf(state) {
  const counts = state?.unreadCounts || EMPTY_COUNTS;
  if (counts === unreadSource) return unreadTotalCached;
  unreadSource = counts;
  let sum = 0;
  for (const key of Object.keys(counts)) sum += Number(counts[key]) || 0;
  unreadTotalCached = sum;
  return sum;
}

// The bar's unread badge (founder order 2026-10-28): the bar is permanent,
// so a mute has to mean something there. Same sum as unreadTotalOf, minus
// what the user chose not to hear — a chat muted, muted forever, muted
// until a future time, or archived pulls no badge. The predicate mirrors
// ChatList's isMuted row truth line for line, so the badge and the row it
// sits over can never disagree. Memoized on the four source identities,
// like unreadTotalOf; the timed-mute check rides a coarse minute so an
// expired mute costs at most a minute of stale badge, never a rescan per
// store change. unreadTotalOf stays as-is for every other reader.
let barCountsSource = null;
let barArchivedSource = null;
let barMutedSource = null;
let barMutedUntilSource = null;
let barMinute = -1;
let barUnreadCached = 0;

export function barUnreadTotalOf(state) {
  const counts = state?.unreadCounts || EMPTY_COUNTS;
  const archived = state?.archivedChats || EMPTY_LIST;
  const muted = state?.mutedChats || EMPTY_LIST;
  const mutedUntil = state?.mutedUntil || EMPTY_COUNTS;
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  if (
    counts === barCountsSource
    && archived === barArchivedSource
    && muted === barMutedSource
    && mutedUntil === barMutedUntilSource
    && minute === barMinute
  ) return barUnreadCached;
  barCountsSource = counts;
  barArchivedSource = archived;
  barMutedSource = muted;
  barMutedUntilSource = mutedUntil;
  barMinute = minute;
  let sum = 0;
  for (const [id, count] of Object.entries(counts)) {
    if (archived.includes(id)) continue;
    const until = mutedUntil[id];
    if (muted.includes(id) || until === 'forever' || (typeof until === 'number' && until > now)) continue;
    sum += Number(count) || 0;
  }
  barUnreadCached = sum;
  return sum;
}

// The Orders tab's badge (15.1). Presentation only: it re-reads the same
// orderState the order cards read, never writes, and counts what waits on
// THIS side — a buyer counts orders they asked for that are pending,
// shipped or disputed; a vendor counts only requests still pending (the
// accept is the act that unblocks them). Passive statuses never count:
// check_chain and report_issue are nudges, not duties, and counting them
// would pin the badge red forever. Memoized on the `dms` identity and the
// vendor flag, exactly like unreadTotalOf above.
let ordersSource = null;
let ordersVendor = null;
let ordersNeedActionCached = 0;
const ORDER_ROW_TYPES = ['order_request', 'cipher_order'];
const BUYER_NEEDS_ACTION = new Set(['pending', 'shipped', 'disputed']);

export function ordersNeedActionOf(state) {
  const dms = state?.dms || EMPTY_COUNTS;
  const isVendor = state?.isVendor === true;
  if (dms === ordersSource && isVendor === ordersVendor) return ordersNeedActionCached;
  ordersSource = dms;
  ordersVendor = isVendor;
  let sum = 0;
  for (const [peerPubkey, messages] of Object.entries(dms)) {
    if (!Array.isArray(messages)) continue;
    for (const message of messages) {
      if (!ORDER_ROW_TYPES.includes(message?.data?.type)) continue;
      // Buyer rows are the requests this device sent; vendor rows are the
      // ones it received. isSender is the wire's own direction flag.
      if (Boolean(message.isSender) === isVendor) continue;
      const { status } = orderState(messages, message.id, message, null, peerPubkey);
      if (isVendor ? status === 'pending' : BUYER_NEEDS_ACTION.has(status)) sum += 1;
    }
  }
  ordersNeedActionCached = sum;
  return sum;
}

export function notifTotalOf(state) {
  const counts = state?.unreadCounts || EMPTY_COUNTS;
  const ack = state?.notifAck || EMPTY_COUNTS;
  if (counts === notifSource && ack === notifAckSource) return notifTotalCached;
  notifSource = counts;
  notifAckSource = ack;
  let sum = 0;
  for (const id of Object.keys(counts)) {
    sum += Math.max(0, (Number(counts[id]) || 0) - (Number(ack[id]) || 0));
  }
  notifTotalCached = sum;
  return sum;
}

export const useChatStore = create((set) => ({
  // NAVIGATION
  view: 'list',
  activeDm: null,
  activeGroup: null,
  setView: (view) => set({ view }),
  setActiveDm: (v) => set({ activeDm: v }),
  setActiveGroup: (v) => set({ activeGroup: v }),
  openChat: (type, id, groupObj = null) => {
    // Opening a chat reads it. The marker is written to the database, or the
    // count comes back after a reload; the count on screen drops with it.
    const chatId = type === 'dm' ? id : (groupObj?.id ?? id);
    if (chatId) {
      markChatRead(chatId);
      set((s) => (s.unreadCounts?.[chatId] ? { unreadCounts: { ...s.unreadCounts, [chatId]: 0 } } : {}));
    }
    if (type === 'dm') {
      set({ view: 'dm', activeDm: id, activeGroup: null, typingUsers: {}, groupTypingUsers: {} });
    } else {
      // A group whose join the relay has not confirmed opens as its waiting
      // state, not as its chat: Chat.jsx draws the waiting panel for a
      // pending row instead of GroupView, so none of the group reads mount.
      set({ view: 'group', activeGroup: groupObj, activeDm: null, typingUsers: {}, groupTypingUsers: {} });
    }
  },
  closeChat: () => set({ view: 'list', activeDm: null, activeGroup: null }),

  // DATA
  dms: {},
  groups: [],
  groupMessages: {},
  profiles: {},
  groupMembers: [],
  pinnedMessages: {},
  disappearingTimers: scopedGet('disappearing_timers', {}),
  unreadCounts: scopedGet('unread', {}),
  notifAck: scopedGet('notif_ack', {}),
  archivedChats: scopedGet('archived', []),
  toggleArchiveChat: (id) => set(s => {
    const next = s.archivedChats.includes(id) ? s.archivedChats.filter(x => x !== id) : [...s.archivedChats, id];
    scopedSet('archived', next);
    return { archivedChats: next };
  }),
  mutedChats: scopedGet('muted', []),
  mutedUntil: scopedGet('muted_until', {}),
  // PIN (presentation state, no relay traffic): which chats the list floats
  // to the top under its PINNED heading. Chat-id list, scoped + persisted.
  pinnedChats: scopedGet('pinned', []),
  togglePinChat: (id) => set(s => {
    const next = s.pinnedChats.includes(id)
      ? s.pinnedChats.filter(x => x !== id)
      : [id, ...s.pinnedChats];
    scopedSet('pinned', next);
    return { pinnedChats: next };
  }),
  setMuteDuration: (id, durationMs) => set(s => {
    const next = { ...s.mutedUntil };
    if (durationMs === 0) {
      delete next[id];
    } else if (durationMs === -1) {
      next[id] = 'forever';
    } else {
      next[id] = Date.now() + durationMs;
    }
    scopedSet('muted_until', next);
    return { mutedUntil: next };
  }),
  toggleMuteChat: (id) => set(s => {
    const next = s.mutedChats.includes(id) ? s.mutedChats.filter(x => x !== id) : [...s.mutedChats, id];
    scopedSet('muted', next);
    return { mutedChats: next };
  }),
  reactions: {},
  deletedMsgs: new Set(),

  setDms: (v) => set((s) => keepIfUnchanged(s, 'dms', typeof v === 'function' ? v(s.dms) : v)),
  setGroups: (v) => set((s) => {
    const next = typeof v === 'function' ? v(s.groups) : v;
    const prev = Array.isArray(s.groups) ? s.groups : [];
    const incoming = Array.isArray(next) ? next : [];
    const same = prev.length === incoming.length && prev.every((group, index) => {
      const other = incoming[index];
      return group === other || (
        group?.id === other?.id
        && group?.name === other?.name
        && group?.about === other?.about
        && group?.picture === other?.picture
        && group?.creator === other?.creator
        && !!group?.isChannel === !!other?.isChannel
      );
    });
    return same ? s : { groups: incoming };
  }),
  setGroupMessages: (v) => set((s) => keepIfUnchanged(s, 'groupMessages', typeof v === 'function' ? v(s.groupMessages) : v)),
  setProfiles: (v) => set((s) => keepIfUnchanged(s, 'profiles', typeof v === 'function' ? v(s.profiles) : v)),
  setGroupMembers: (v) => set((s) => ({ groupMembers: typeof v === 'function' ? v(Array.isArray(s.groupMembers) ? s.groupMembers : []) : v })),
  setPinnedMessages: (v) => set((s) => ({ pinnedMessages: typeof v === 'function' ? v(s.pinnedMessages) : v })),
  setDisappearingTimer: (chatId, duration) => set((s) => {
    const next = { ...s.disappearingTimers, [chatId]: duration };
    scopedSet('disappearing_timers', next);
    return { disappearingTimers: next };
  }),
  setUnreadCounts: (v) => set((s) => {
    const next = typeof v === 'function' ? v(s.unreadCounts) : v;
    const counts = next && typeof next === 'object' ? next : {};
    scopedSet('unread', counts);
    return { unreadCounts: counts };
  }),
  ackNotifications: () => set((s) => {
    const ack = { ...s.notifAck };
    for (const [id, count] of Object.entries(s.unreadCounts || {})) ack[id] = Number(count) || 0;
    scopedSet('notif_ack', ack);
    return { notifAck: ack };
  }),
  clearNotificationAck: () => {
    scopedSet('notif_ack', {});
    set({ notifAck: {} });
  },
  setReactions: (v) => set((s) => ({ reactions: typeof v === 'function' ? v(s.reactions) : v })),
  setDeletedMsgs: (v) => set((s) => {
    const current = s.deletedMsgs instanceof Set ? s.deletedMsgs : new Set();
    const next = typeof v === 'function' ? v(current) : v;
    return { deletedMsgs: next instanceof Set ? next : new Set(next || []) };
  }),

  // TYPING
  typingUsers: {},
  groupTypingUsers: {},
  setTypingUsers: (v) => set((s) => ({ typingUsers: typeof v === 'function' ? v(s.typingUsers) : v })),
  setGroupTypingUsers: (v) => set((s) => ({ groupTypingUsers: typeof v === 'function' ? v(s.groupTypingUsers) : v })),

  // BLOCKED USERS
  blockedUsers: scopedGet('blocked', []),
  toggleBlockUser: (pubkey) => set(s => {
    const next = s.blockedUsers.includes(pubkey) ? s.blockedUsers.filter(x => x !== pubkey) : [...s.blockedUsers, pubkey];
    scopedSet('blocked', next);
    return { blockedUsers: next };
  }),

  // SEARCH
  searchQuery: '',
  searchResults: [],
  isSearching: false,
  setSearchQuery: (v) => set({ searchQuery: v }),
  setSearchResults: (v) => set({ searchResults: v }),
  setIsSearching: (v) => set({ isSearching: v }),

  // ROLE
  isVendor: scopedGet('is_vendor', false) === true,
  setIsVendor: (v) => {
    scopedSet('is_vendor', v);
    set({ isVendor: v });
  },

  // MESSAGE EDIT HISTORY
  messageEdits: scopedGet('msg_edits', {}),
  addMessageEdit: (msgId, editData) => set(s => {
    const next = { ...s.messageEdits };
    if (!next[msgId]) next[msgId] = [];
    next[msgId].push({ ...editData, timestamp: Date.now() });
    scopedSet('msg_edits', next);
    return { messageEdits: next };
  }),

  // BOOKMARKS
  bookmarks: normalizeBookmarks(scopedGet('bookmarks', [])),
  toggleBookmark: (chatId, msgId) => set(s => {
    const bookmarks = normalizeBookmarks(s.bookmarks);
    const exists = bookmarks.some((item) => item.chatId === chatId && item.msgId === msgId);
    const next = exists
      ? bookmarks.filter((item) => item.chatId !== chatId || item.msgId !== msgId)
      : [...bookmarks, { chatId, msgId }];
    scopedSet('bookmarks', next);
    return { bookmarks: next };
  }),
  isBookmarked: (chatId, msgId) => {
    const s = useChatStore.getState();
    return normalizeBookmarks(s.bookmarks).some((item) => item.chatId === chatId && item.msgId === msgId);
  },

  showMenu: false,
  showCreateGroup: false,
  showDeadDrop: false,
  showGroupInfo: false,
  showMyProfile: false,
  showTutorial: false,
  selectedMessage: null,
  profilePubkey: null,
  checkoutProduct: null,
  setShowMenu: (v) => set({ showMenu: v }),
  setShowCreateGroup: (v) => set({ showCreateGroup: v }),
  setShowDeadDrop: (v) => set({ showDeadDrop: v }),
  setShowGroupInfo: (v) => set({ showGroupInfo: v }),
  setShowMyProfile: (v) => set({ showMyProfile: v }),
  setShowTutorial: (v) => set({ showTutorial: v }),
  setSelectedMessage: (v) => set({ selectedMessage: v }),
  setProfilePubkey: (v) => set({ profilePubkey: v }),
  setCheckoutProduct: (v) => set({ checkoutProduct: v }),
  vendorStorefrontPubkey: null,
  setVendorStorefrontPubkey: (v) => set({ vendorStorefrontPubkey: v }),
  editingProduct: null,
  setEditingProduct: (v) => set({ editingProduct: v }),
  broadcastProduct: null,
  setBroadcastProduct: (v) => set({ broadcastProduct: v }),
  showQRScanner: false,
  setShowQRScanner: (v) => set({ showQRScanner: v }),
  showNotifCenter: false,
  setShowNotifCenter: (v) => set({ showNotifCenter: v }),
  showBookmarks: false,
  setShowBookmarks: (v) => set({ showBookmarks: v }),
  showDrawer: false,
  setShowDrawer: (v) => set({ showDrawer: v }),

  newMessage: '',
  newGroupName: '',
  newGroupAbout: '',
  isChannel: false,
  replyingTo: null,
  setNewMessage: (v) => set({ newMessage: v }),
  setNewGroupName: (v) => set({ newGroupName: v }),
  setNewGroupAbout: (v) => set({ newGroupAbout: v }),
  setIsChannel: (v) => set({ isChannel: v }),
  setReplyingTo: (v) => set({ replyingTo: v }),

  // PROFILE EDITOR
  myUsername: '',
  setMyUsername: (v) => set({ myUsername: v }),

  // LOADING
  panicWipeEnabled: safeStorage.getItem('cipher_panic_wipe') === 'true',
  loading: true,
  uploadingImage: false,
  isRecording: false,
  setLoading: (v) => set({ loading: v }),
  setPanicWipeEnabled: (v) => {
    safeStorage.setItem('cipher_panic_wipe', String(v));
    set({ panicWipeEnabled: v });
  },
  setUploadingImage: (v) => set({ uploadingImage: v }),
  setIsRecording: (v) => set({ isRecording: v }),

  // GLOBAL DIALOG
  dialog: null,
  openDialog: (config) => set({ dialog: config }),
  closeDialog: () => set({ dialog: null }),

  reload: () => set({
    archivedChats: scopedGet('archived', []),
    mutedChats: scopedGet('muted', []),
    mutedUntil: scopedGet('muted_until', {}),
    pinnedChats: scopedGet('pinned', []),
    blockedUsers: scopedGet('blocked', []),
    bookmarks: normalizeBookmarks(scopedGet('bookmarks', [])),
    messageEdits: scopedGet('msg_edits', {}),
    disappearingTimers: scopedGet('disappearing_timers', {}),
    unreadCounts: scopedGet('unread', {}),
    notifAck: scopedGet('notif_ack', {}),
    isVendor: scopedGet('is_vendor', false) === true,
  }),

  // TOAST
  toast: null,
  setToast: (toast) => {
    set({ toast });
    if (toast) setTimeout(() => set({ toast: null }), 3000);
  },
}));
