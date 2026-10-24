import { create } from 'zustand';
import { scopedGet, scopedSet } from '../lib/storage';

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

export const useChatStore = create((set, get) => ({
  hideNotifContent: scopedGet('hide_notif_content', true),
  setHideNotifContent: (v) => { scopedSet('hide_notif_content', v); set({ hideNotifContent: v }); },

  // NAVIGATION
  view: 'list',
  activeDm: null,
  activeGroup: null,
  setView: (view) => set({ view }),
  setActiveDm: (v) => set({ activeDm: v }),
  setActiveGroup: (v) => set({ activeGroup: v }),
  openChat: (type, id, groupObj = null) => {
    if (type === 'dm') {
      set({ view: 'dm', activeDm: id, activeGroup: null, typingUsers: {}, groupTypingUsers: {} });
    } else {
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
  unreadCounts: {},
  pinnedChats: scopedGet('pinned', []),
  archivedChats: scopedGet('archived', []),
  toggleArchiveChat: (id) => set(s => {
    const next = s.archivedChats.includes(id) ? s.archivedChats.filter(x => x !== id) : [...s.archivedChats, id];
    scopedSet('archived', next);
    return { archivedChats: next };
  }),
  mutedChats: scopedGet('muted', []),
  togglePinChat: (id) => set(s => {
    const next = s.pinnedChats.includes(id) ? s.pinnedChats.filter(x => x !== id) : [...s.pinnedChats, id];
    scopedSet('pinned', next);
    return { pinnedChats: next };
  }),
  mutedUntil: scopedGet('muted_until', {}),
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

  setDms: (v) => set((s) => ({ dms: typeof v === 'function' ? v(s.dms) : v })),
  setGroups: (v) => set((s) => ({ groups: typeof v === 'function' ? v(s.groups) : v })),
  setGroupMessages: (v) => set((s) => ({ groupMessages: typeof v === 'function' ? v(s.groupMessages) : v })),
  setProfiles: (v) => set((s) => ({ profiles: typeof v === 'function' ? v(s.profiles) : v })),
  setGroupMembers: (v) => set({ groupMembers: v }),
  setPinnedMessages: (v) => set((s) => ({ pinnedMessages: typeof v === 'function' ? v(s.pinnedMessages) : v })),
  setDisappearingTimer: (chatId, duration) => set((s) => {
    const next = { ...s.disappearingTimers, [chatId]: duration };
    scopedSet('disappearing_timers', next);
    return { disappearingTimers: next };
  }),
  setUnreadCounts: (v) => set((s) => ({ unreadCounts: typeof v === 'function' ? v(s.unreadCounts) : v })),
  setReactions: (v) => set((s) => ({ reactions: typeof v === 'function' ? v(s.reactions) : v })),
  setDeletedMsgs: (v) => set({ deletedMsgs: v }),

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
  chatSearch: '',
  setChatSearch: (v) => set({ chatSearch: v }),
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

  // BULK SELECTION MODE
  selectionMode: false,
  selectedMsgs: [],
  toggleSelectionMode: () => set(s => ({ selectionMode: !s.selectionMode, selectedMsgs: [] })),
  toggleSelectedMsg: (id) => set(s => {
    const next = s.selectedMsgs.includes(id) ? s.selectedMsgs.filter(x => x !== id) : [...s.selectedMsgs, id];
    return { selectedMsgs: next };
  }),
  clearSelection: () => set({ selectionMode: false, selectedMsgs: [] }),

  // JOIN REQUESTS
  joinRequests: scopedGet('join_requests', {}),
  addJoinRequest: (groupId, pubkey) => set(s => {
    const next = { ...s.joinRequests };
    if (!next[groupId]) next[groupId] = [];
    if (!next[groupId].includes(pubkey)) next[groupId].push(pubkey);
    scopedSet('join_requests', next);
    return { joinRequests: next };
  }),
  removeJoinRequest: (groupId, pubkey) => set(s => {
    const next = { ...s.joinRequests };
    if (next[groupId]) {
      next[groupId] = next[groupId].filter(p => p !== pubkey);
      if (next[groupId].length === 0) delete next[groupId];
    }
    scopedSet('join_requests', next);
    return { joinRequests: next };
  }),

  // UI MODALS
  postListingGroup: null,
  setPostListingGroup: (v) => set({ postListingGroup: v }),

  showMenu: false,
  showCreateGroup: false,
  showGroupInfo: false,
  showMyProfile: false,
  showAddProduct: false,
  selectedMessage: null,
  profilePubkey: null,
  checkoutProduct: null,
  setShowMenu: (v) => set({ showMenu: v }),
  setShowCreateGroup: (v) => set({ showCreateGroup: v }),
  setShowGroupInfo: (v) => set({ showGroupInfo: v }),
  setShowMyProfile: (v) => set({ showMyProfile: v }),
  setShowAddProduct: (v) => set({ showAddProduct: v }),
  setSelectedMessage: (v) => set({ selectedMessage: v }),
  setProfilePubkey: (v) => set({ profilePubkey: v }),
  setCheckoutProduct: (v) => set({ checkoutProduct: v }),

  // CHAT UI STATE — migrated from Chat.jsx useState (Step 4)
  reviewTarget: null,
  setReviewTarget: (v) => set({ reviewTarget: v }),
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
  showFullEmoji: false,
  setShowFullEmoji: (v) => set({ showFullEmoji: v }),
  replyText: '',
  setReplyText: (v) => set({ replyText: v }),
  forwardingMsg: null,
  setForwardingMsg: (v) => set({ forwardingMsg: v }),
  showForwardModal: false,
  setShowForwardModal: (v) => set({ showForwardModal: v }),
  showEmojiPicker: false,
  setShowEmojiPicker: (v) => set({ showEmojiPicker: v }),

  // INPUT
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
  myName: '',
  myUsername: '',
  myAbout: '',
  setMyName: (v) => set({ myName: v }),
  setMyUsername: (v) => set({ myUsername: v }),
  setMyAbout: (v) => set({ myAbout: v }),

  // PRODUCTS
  myProducts: scopedGet('my_products', []),
  newProduct: { name: '', priceUsd: '', image: '' },
  setMyProducts: (v) => {
    const products = typeof v === 'function' ? v(get().myProducts) : v;
    set({ myProducts: products });
    scopedSet('my_products', products);
  },
  setNewProduct: (v) => set({ newProduct: v }),

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
    pinnedChats: scopedGet('pinned', []),
    archivedChats: scopedGet('archived', []),
    mutedChats: scopedGet('muted', []),
    mutedUntil: scopedGet('muted_until', {}),
    blockedUsers: scopedGet('blocked', []),
    bookmarks: normalizeBookmarks(scopedGet('bookmarks', [])),
    messageEdits: scopedGet('msg_edits', {}),
    disappearingTimers: scopedGet('disappearing_timers', {}),
    joinRequests: scopedGet('join_requests', {}),
    isVendor: scopedGet('is_vendor', false) === true,
    myProducts: scopedGet('my_products', []),
  }),

  // TOAST
  toast: null,
  setToast: (toast) => {
    set({ toast });
    if (toast) setTimeout(() => set({ toast: null }), 3000);
  },
}));
