import { motion } from 'framer-motion';
import { Bookmark, Bell, Menu, QrCode, RefreshCw, Search } from 'lucide-react';
import Logo from '../../components/Logo';
import ChatList from '../../components/chat/ChatList';
import CreateGroupModal from '../../components/chat/CreateGroupModal';
import FloatingMenu from '../../components/chat/FloatingMenu';
import MyProfileModal from '../../components/chat/MyProfileModal';
import { notifTotalOf, useChatStore } from '../../store/chatStore';

export default function ChatHome({ identity, openChat, createGroup, fetchChats }) {
  // NotificationCenter, BookmarksViewer and QRScanner are NOT mounted here —
  // ChatOverlays mounts them from the same store flags, and at md both
  // parents stay live, so a second mount here stacked duplicate fixed
  // overlays and opened two QR camera streams.
  const setView = useChatStore((state) => state.setView);
  const showCreateGroup = useChatStore((state) => state.showCreateGroup);
  const setShowCreateGroup = useChatStore((state) => state.setShowCreateGroup);
  const setShowBookmarks = useChatStore((state) => state.setShowBookmarks);
  const setShowNotifCenter = useChatStore((state) => state.setShowNotifCenter);
  const setShowQRScanner = useChatStore((state) => state.setShowQRScanner);
  const notifTotal = useChatStore(notifTotalOf);

  return (
    <motion.div initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} transition={{ duration: 0.2 }} className="relative h-full min-h-0 overflow-y-auto bg-transparent pb-4 md:static">
      <div className="mb-2 flex items-center justify-between px-4 pt-3 md:px-3">
        <div className="flex items-center gap-3 md:gap-2">
          <button type="button" onClick={() => useChatStore.getState().setShowDrawer(true)} aria-label="Open menu" className="-ml-1 touch-target p-2 text-ink/50 hover:text-ink md:hidden"><Menu size={20} /></button>
          <Logo size={28} />
          <h2 className="text-2xl font-bold tracking-tight text-ink md:text-xl">Chats</h2>
        </div>
        <div className="flex gap-1 rounded-2xl border border-line bg-panel p-1 shadow-lg md:gap-0.5">
          <button type="button" onClick={() => setShowBookmarks(true)} className="p-2 text-ink/50 hover:text-ink min-h-[44px] min-w-[44px] md:min-h-[40px] md:min-w-[40px] md:p-1.5"><Bookmark size={20} /></button>
          <button type="button" onClick={() => setShowNotifCenter(true)} className="relative p-2 text-ink/50 hover:text-ink min-h-[44px] min-w-[44px] md:min-h-[40px] md:min-w-[40px] md:p-1.5" aria-label="Notifications">
            <Bell size={20} />
            {notifTotal > 0 && <span className="absolute right-0 top-0 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-accentInk md:right-0.5">{notifTotal > 99 ? '99+' : notifTotal}</span>}
          </button>
          <button type="button" onClick={() => setShowQRScanner(true)} className="p-2 text-ink/50 hover:text-ink min-h-[44px] min-w-[44px] md:min-h-[40px] md:min-w-[40px] md:p-1.5" aria-label="Scan QR code"><QrCode size={20} /></button>
          <button type="button" onClick={fetchChats} className="p-2 text-ink/50 hover:text-ink min-h-[44px] min-w-[44px] md:min-h-[40px] md:min-w-[40px] md:p-1.5"><RefreshCw size={20} /></button>
          <button type="button" onClick={() => setView('search')} className="p-2 text-ink/50 hover:text-ink min-h-[44px] min-w-[44px] md:min-h-[40px] md:min-w-[40px] md:p-1.5"><Search size={20} /></button>
        </div>
      </div>
      <ChatList onOpenChat={openChat} />
      <CreateGroupModal isOpen={showCreateGroup} onClose={() => setShowCreateGroup(false)} createGroup={createGroup} />
      <FloatingMenu />
      <MyProfileModal identity={identity} />
    </motion.div>
  );
}
