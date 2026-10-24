import { motion } from 'framer-motion';
import { Bookmark, Bell, QrCode, RefreshCw, Search } from 'lucide-react';
import Logo from '../../components/Logo';
import ChatList from '../../components/chat/ChatList';
import CreateGroupModal from '../../components/chat/CreateGroupModal';
import FloatingMenu from '../../components/chat/FloatingMenu';
import MyProfileModal from '../../components/chat/MyProfileModal';
import BookmarksViewer from '../../components/chat/BookmarksViewer';
import NotificationCenter from '../../components/chat/NotificationCenter';
import QRScanner from '../../components/chat/QRScanner';
import { useChatStore } from '../../store/chatStore';
import ToastBanner from './ToastBanner';

export default function ChatHome({ identity, openChat, createGroup, fetchChats }) {
  const groups = useChatStore((state) => state.groups);
  const setView = useChatStore((state) => state.setView);
  const showCreateGroup = useChatStore((state) => state.showCreateGroup);
  const setShowCreateGroup = useChatStore((state) => state.setShowCreateGroup);
  const showBookmarks = useChatStore((state) => state.showBookmarks);
  const setShowBookmarks = useChatStore((state) => state.setShowBookmarks);
  const showNotifCenter = useChatStore((state) => state.showNotifCenter);
  const setShowNotifCenter = useChatStore((state) => state.setShowNotifCenter);
  const showQRScanner = useChatStore((state) => state.showQRScanner);
  const setShowQRScanner = useChatStore((state) => state.setShowQRScanner);

  const jump = (type, id) => {
    if (type === 'group') {
      const group = groups.find((item) => item.id === id);
      if (group) openChat('group', id, group);
    } else {
      openChat('dm', id);
    }
  };

  return (
    <motion.div initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} transition={{ duration: 0.2 }} className="relative min-h-0 flex-1 overflow-y-auto bg-black pb-4">
      <ToastBanner />
      <div className="mb-2 flex items-center justify-between px-4 pt-3">
        <div className="flex items-center gap-3">
          <Logo size={28} />
          <h2 className="text-2xl font-black tracking-tighter text-white">Cipher</h2>
        </div>
        <div className="flex gap-1">
          <button type="button" onClick={() => setShowBookmarks(true)} className="p-2 text-white/50 hover:text-white"><Bookmark size={20} /></button>
          <button type="button" onClick={() => setShowNotifCenter(true)} className="p-2 text-white/50 hover:text-white" aria-label="Notifications"><Bell size={20} /></button>
          <button type="button" onClick={() => setShowQRScanner(true)} className="p-2 text-white/50 hover:text-white" aria-label="Scan QR code"><QrCode size={20} /></button>
          <button type="button" onClick={fetchChats} className="p-2 text-white/50 hover:text-white"><RefreshCw size={20} /></button>
          <button type="button" onClick={() => setView('search')} className="p-2 text-white/50 hover:text-white"><Search size={20} /></button>
        </div>
      </div>
      <ChatList onOpenChat={openChat} />
      <CreateGroupModal isOpen={showCreateGroup} onClose={() => setShowCreateGroup(false)} createGroup={createGroup} />
      <FloatingMenu />
      <MyProfileModal identity={identity} />
      {showBookmarks && <BookmarksViewer onClose={() => setShowBookmarks(false)} />}
      {showNotifCenter && <NotificationCenter onClose={() => setShowNotifCenter(false)} onJump={jump} />}
      {showQRScanner && <QRScanner onClose={() => setShowQRScanner(false)} />}
    </motion.div>
  );
}
