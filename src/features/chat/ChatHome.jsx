import { motion } from 'framer-motion';
import { Bookmark, Bell, Menu, QrCode, RefreshCw } from 'lucide-react';
import ChatList from '../../components/chat/ChatList';
import CreateGroupModal from '../../components/chat/CreateGroupModal';
import FloatingMenu from '../../components/chat/FloatingMenu';
import MyProfileModal from '../../components/chat/MyProfileModal';
import { notifTotalOf, useChatStore } from '../../store/chatStore';
import ToastBanner from './ToastBanner';

export default function ChatHome({ identity, openChat, createGroup, fetchChats }) {
  // NotificationCenter, BookmarksViewer and QRScanner are NOT mounted here —
  // ChatOverlays mounts them from the same store flags, and at md both
  // parents stay live, so a second mount here stacked duplicate fixed
  // overlays and opened two QR camera streams.
  const setShowBookmarks = useChatStore((state) => state.setShowBookmarks);
  const showCreateGroup = useChatStore((state) => state.showCreateGroup);
  const setShowCreateGroup = useChatStore((state) => state.setShowCreateGroup);
  const setShowNotifCenter = useChatStore((state) => state.setShowNotifCenter);
  const setShowQRScanner = useChatStore((state) => state.setShowQRScanner);
  const notifTotal = useChatStore(notifTotalOf);

  return (
    <motion.div initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} transition={{ duration: 0.2 }} className="relative h-full min-h-0 overflow-y-auto bg-transparent pb-4 md:static">
      <ToastBanner />
      {/* The §3 header (logo chip, filter, kebab) lives inside ChatList.
          This slim row keeps the remaining doors reachable. */}
      <div className="mb-1 flex items-center justify-between px-4 pt-1 md:px-3">
        <button type="button" onClick={() => useChatStore.getState().setShowDrawer(true)} aria-label="Open menu" className="-ml-1 touch-target p-2 text-ink/50 hover:text-ink md:hidden"><Menu size={20} /></button>
        <div className="ml-auto flex gap-1 rounded-2xl border border-line bg-panel p-1 shadow-lg md:gap-0.5">
          <button type="button" onClick={() => setShowBookmarks(true)} aria-label="Bookmarks" className="min-h-[44px] min-w-[44px] p-2 text-ink/50 hover:text-ink md:min-h-[40px] md:min-w-[40px] md:p-1.5"><Bookmark size={20} /></button>
          <button type="button" onClick={() => setShowNotifCenter(true)} className="relative min-h-[44px] min-w-[44px] p-2 text-ink/50 hover:text-ink md:min-h-[40px] md:min-w-[40px] md:p-1.5" aria-label="Notifications">
            <Bell size={20} />
            {notifTotal > 0 && <span className="absolute right-0 top-0 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-accentInk md:right-0.5">{notifTotal > 99 ? '99+' : notifTotal}</span>}
          </button>
          <button type="button" onClick={() => setShowQRScanner(true)} className="min-h-[44px] min-w-[44px] p-2 text-ink/50 hover:text-ink md:min-h-[40px] md:min-w-[40px] md:p-1.5" aria-label="Scan QR code"><QrCode size={20} /></button>
          <button type="button" onClick={fetchChats} aria-label="Refresh chats" className="min-h-[44px] min-w-[44px] p-2 text-ink/50 hover:text-ink md:min-h-[40px] md:min-w-[40px] md:p-1.5"><RefreshCw size={20} /></button>
        </div>
      </div>
      <ChatList onOpenChat={openChat} />
      <CreateGroupModal isOpen={showCreateGroup} onClose={() => setShowCreateGroup(false)} createGroup={createGroup} />
      <FloatingMenu />
      <MyProfileModal identity={identity} />
    </motion.div>
  );
}
