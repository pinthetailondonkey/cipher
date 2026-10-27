import { motion } from 'framer-motion';
import { Bookmark, Bell, Menu, Plus, QrCode, RefreshCw, Search } from 'lucide-react';
import Logo from '../../components/Logo';
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
  const setView = useChatStore((state) => state.setView);
  const showCreateGroup = useChatStore((state) => state.showCreateGroup);
  const setShowCreateGroup = useChatStore((state) => state.setShowCreateGroup);
  const setShowBookmarks = useChatStore((state) => state.setShowBookmarks);
  const setShowNotifCenter = useChatStore((state) => state.setShowNotifCenter);
  const setShowQRScanner = useChatStore((state) => state.setShowQRScanner);
  const setShowMenu = useChatStore((state) => state.setShowMenu);
  const notifTotal = useChatStore(notifTotalOf);

  return (
    <motion.div initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} transition={{ duration: 0.2 }} className="relative h-full min-h-0 overflow-y-auto bg-transparent pb-4 md:static">
      <ToastBanner />
      <div className="mb-2 flex items-center justify-between px-4 pt-3 md:px-3">
        <div className="flex items-center gap-3 md:gap-2">
          <button type="button" onClick={() => useChatStore.getState().setShowDrawer(true)} aria-label="Open menu" className="-ml-1 touch-target p-2 text-ink/50 hover:text-ink md:hidden"><Menu size={20} /></button>
          <Logo size={28} />
          <h2 className="text-2xl font-bold tracking-tight text-ink md:text-xl">Chats</h2>
        </div>
        <div className="flex items-center gap-1 md:gap-0.5">
          <button type="button" onClick={() => setShowBookmarks(true)} className="p-2 text-ink/50 hover:text-ink rounded-lg min-h-[44px] min-w-[44px] md:min-h-[36px] md:min-w-[36px] md:p-1.5"><Bookmark size={20} /></button>
          <button type="button" onClick={() => setShowNotifCenter(true)} className="p-2 text-ink/50 hover:text-ink rounded-lg min-h-[44px] min-w-[44px] md:min-h-[36px] md:min-w-[36px] md:p-1.5" aria-label="Notifications">
            <Bell size={20} />
            {notifTotal > 0 && <span className="absolute right-0 top-0 flex h-[14px] min-w-[14px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-accentInk md:right-0.5">{notifTotal > 99 ? '99+' : notifTotal}</span>}
          </button>
          <button type="button" onClick={() => setShowQRScanner(true)} className="p-2 text-ink/50 hover:text-ink rounded-lg min-h-[44px] min-w-[44px] md:min-h-[36px] md:min-w-[36px] md:p-1.5" aria-label="Scan QR code"><QrCode size={20} /></button>
          <button type="button" onClick={fetchChats} className="p-2 text-ink/50 hover:text-ink rounded-lg min-h-[44px] min-w-[44px] md:min-h-[36px] md:min-w-[36px] md:p-1.5"><RefreshCw size={20} /></button>
          <button type="button" onClick={() => setView('search')} className="p-2 text-ink/50 hover:text-ink rounded-lg min-h-[44px] min-w-[44px] md:min-h-[36px] md:min-w-[36px] md:p-1.5"><Search size={20} /></button>
          {/* Desktop compose: Telegram has no floating pencil anywhere — new-chat
              actions sit in the header. The phone FAB below stays < md only. */}
          <button type="button" onClick={() => setShowMenu(true)} className="hidden md:flex ml-1 h-9 w-9 items-center justify-center rounded-full bg-accent text-accentInk hover:brightness-110" aria-label="New chat"><Plus size={20} strokeWidth={2.5} /></button>
        </div>
      </div>
      <ChatList onOpenChat={openChat} />
      <CreateGroupModal isOpen={showCreateGroup} onClose={() => setShowCreateGroup(false)} createGroup={createGroup} />
      <FloatingMenu />
      <MyProfileModal identity={identity} />
    </motion.div>
  );
}
