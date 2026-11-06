import { motion } from 'framer-motion';
import ChatList from '../../components/chat/ChatList';
import CreateGroupModal from '../../components/chat/CreateGroupModal';
import MyProfileModal from '../../components/chat/MyProfileModal';
import ScreenHeader from '../../components/ui/ScreenHeader';
import Discover from '../../Discover';
import Menus from '../../Menus';
import { useChatStore } from '../../store/chatStore';

// The Threads tab's list pane: the conversation list, its Menus browse, and
// the directory one door further in. The segment state is the shell's (it has
// to be — the bar steps aside for a thread, and the browse is a segment, so
// one owner keeps those two facts from disagreeing), and this pane only hands
// the pieces down: ChatList draws the header and the segments, the browse
// arrives as a node it never has to know the name of.
export default function ChatHome({
  identity,
  openChat,
  createGroup,
  fetchChats,
  segment,
  onSegmentChange,
  discoverOpen,
  onDiscoverChange,
  onGoToChat,
}) {
  const showCreateGroup = useChatStore((state) => state.showCreateGroup);
  const setShowCreateGroup = useChatStore((state) => state.setShowCreateGroup);

  return (
    <motion.div initial={{ x: -20, opacity: 0 }} animate={{ x: 0, opacity: 1 }} exit={{ x: -20, opacity: 0 }} transition={{ duration: 0.2 }} className="relative h-full min-h-0 overflow-y-auto bg-transparent scroll-pb-bar md:static">
      {discoverOpen ? (
        /* The directory is a drill-down, so it wears its own title bar with the
           one way back, and the segment row stays out of its way while it is
           open. Joining lands on the chat tab: what the account joined is a
           conversation, and that is where a person means to go next. */
        <div className="flex min-h-full flex-col">
          <ScreenHeader title="Discover" onBack={() => onDiscoverChange(false)} />
          <div className="min-h-0 flex-1">
            <Discover identity={identity} onJoined={onGoToChat} />
          </div>
        </div>
      ) : (
        <ChatList
          onOpenChat={openChat}
          onRefresh={fetchChats}
          segment={segment}
          onSegmentChange={onSegmentChange}
          onOpenDiscover={() => onDiscoverChange(true)}
              browse={<Menus />}
        />
      )}
      <CreateGroupModal isOpen={showCreateGroup} onClose={() => setShowCreateGroup(false)} createGroup={createGroup} />
      <MyProfileModal identity={identity} />
    </motion.div>
  );
}
