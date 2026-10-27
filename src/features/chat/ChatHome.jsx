import { motion } from 'framer-motion';
import ChatList from '../../components/chat/ChatList';
import CreateGroupModal from '../../components/chat/CreateGroupModal';
import FloatingMenu from '../../components/chat/FloatingMenu';
import MyProfileModal from '../../components/chat/MyProfileModal';
import { useChatStore } from '../../store/chatStore';

export default function ChatHome({ identity, openChat, createGroup, fetchChats }) {
  const showCreateGroup = useChatStore((state) => state.showCreateGroup);
  const setShowCreateGroup = useChatStore((state) => state.setShowCreateGroup);

  return (
    <motion.div initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} transition={{ duration: 0.2 }} className="relative h-full min-h-0 overflow-y-auto bg-transparent pb-4 md:static">
      <ChatList onOpenChat={openChat} onRefresh={fetchChats} />
      <CreateGroupModal isOpen={showCreateGroup} onClose={() => setShowCreateGroup(false)} createGroup={createGroup} />
      <FloatingMenu />
      <MyProfileModal identity={identity} />
    </motion.div>
  );
}
