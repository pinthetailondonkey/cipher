import { lazy, Suspense, useEffect } from 'react';
import { useNIP44DM } from './hooks/useNIP44DM';
import { useNIP29Group } from './hooks/useNIP29Group';
import { useReactions } from './hooks/useReactions';
import { useReputation } from './hooks/useReputation';
import { reactionSubscriptionKey, useChatStore } from './store/chatStore';
import SearchView from './components/chat/SearchView';
import MessageSearchResults from './components/chat/MessageSearchResults';
import ChatLoading from './features/chat/ChatLoading';
import ChatHome from './features/chat/ChatHome';
import ChatOverlays from './features/chat/ChatOverlays';
import { useMyGroups, useGroupDirectory } from './features/chat/useGroupDirectory';
import { useChatBootstrap } from './features/chat/useChatBootstrap';
import { useCommerce } from './features/chat/useCommerce';
import { useComposer } from './features/chat/useComposer';
import { useMessageCommands } from './features/chat/useMessageCommands';
import { usePeopleSearch } from './features/chat/usePeopleSearch';
import { bindCallTransport } from './lib/voiceCall';

const DmView = lazy(() => import('./components/chat/DmView'));
const GroupView = lazy(() => import('./components/chat/GroupView'));

const screenFallback = (
  <div className="flex h-full items-center justify-center bg-black">
    <div className="h-7 w-7 animate-spin rounded-full border-2 border-white/20 border-t-blue-500" />
  </div>
);

export default function Chat({ identity }) {
  const { sendDM, subscribeToDMs, sendTypingIndicator, fetchDMs } = useNIP44DM({ identity });
  const {
    sendGroupMessage, subscribeToGroups, pinMessage, unpinMessage, fetchPinnedMessage,
    sendGroupTypingIndicator, createGroup: createGroupHook, fetchGroupMembers,
  } = useNIP29Group({ identity });
  const { sendReaction, subscribeToReactions, subscribeToGroupReactions } = useReactions({ identity });
  const { sendVouch } = useReputation({ identity });
  const setGroups = useMyGroups(identity?.pk);
  const directory = useGroupDirectory({ identity, createGroupHook, setGroups });
  const { fetchChats } = useChatBootstrap({
    identity,
    fetchDMs,
    subscribeToDMs,
    subscribeToGroups,
    subscribeToGroupReactions,
    sendTypingIndicator,
    sendDM,
    sendGroupTypingIndicator,
    fetchGroupMembers,
    setGroups,
    fetchGroups: directory.fetchGroups,
    joinGroupById: directory.joinGroupById,
  });
  const commerce = useCommerce({
    identity,
    sendDM,
    sendGroupMessage,
    sendVouch,
    openChat: directory.openChat,
  });
  const composer = useComposer({ identity, sendDM, sendGroupMessage });
  const commands = useMessageCommands({
    identity,
    sendReaction,
    pinMessage,
    sendGroupMessage,
    sendDM,
    handleOrderAction: commerce.handleOrderAction,
    startOrderWithVendor: commerce.startOrderWithVendor,
  });
  const { handleSearch } = usePeopleSearch({ identity });

  useEffect(() => {
    bindCallTransport((pubkey, payload) => sendDM(pubkey, payload));
  }, [sendDM]);

  const reactionKey = useChatStore(reactionSubscriptionKey);

  useEffect(() => {
    const ids = reactionKey ? reactionKey.split(',').filter(Boolean) : [];
    if (!ids.length) return undefined;
    return subscribeToReactions(ids);
  }, [reactionKey, subscribeToReactions]);

  const loading = useChatStore((state) => state.loading);
  const view = useChatStore((state) => state.view);
  const activeDm = useChatStore((state) => state.activeDm);
  const activeGroup = useChatStore((state) => state.activeGroup);
  const searchResults = useChatStore((state) => state.searchResults);
  const setView = useChatStore((state) => state.setView);

  if (loading) return <ChatLoading />;

  if (view === 'list') {
    return (
      <ChatHome
        identity={identity}
        openChat={directory.openChat}
        createGroup={directory.createGroup}
        fetchChats={fetchChats}
      />
    );
  }

  if (view === 'search' && searchResults.length > 0 && searchResults[0]?.msg) {
    return <MessageSearchResults identity={identity} setView={setView} openChat={directory.openChat} />;
  }

  if (view === 'search') {
    return (
      <SearchView
        handleSearch={handleSearch}
        joinGroupById={directory.joinGroupById}
        openChat={directory.openChat}
      />
    );
  }

  const threadProps = {
    identity,
    sendMessage: composer.sendMessage,
    handleMessageAction: commands.handleMessageAction,
    handleImageUpload: composer.handleImageUpload,
    startRecording: composer.startRecording,
    stopRecording: composer.stopRecording,
    handleForwardSubmit: commands.handleForwardSubmit,
  };

  if (view === 'dm' && activeDm) {
    return (
      <Suspense fallback={screenFallback}>
        <DmView {...threadProps} />
        <ChatOverlays
          identity={identity}
          openChat={directory.openChat}
          startOrderWithVendor={commerce.startOrderWithVendor}
          handleSaveEditedProduct={commerce.handleSaveEditedProduct}
          handleBroadcastSubmit={commerce.handleBroadcastSubmit}
        />
      </Suspense>
    );
  }

  if (view === 'group' && activeGroup) {
    return (
      <Suspense fallback={screenFallback}>
        <GroupView
          {...threadProps}
          fetchGroupMembers={fetchGroupMembers}
          fetchPinnedMessage={fetchPinnedMessage}
          pinMessage={pinMessage}
          unpinMessage={unpinMessage}
        />
        <ChatOverlays
          identity={identity}
          openChat={directory.openChat}
          startOrderWithVendor={commerce.startOrderWithVendor}
          handleSaveEditedProduct={commerce.handleSaveEditedProduct}
          handleBroadcastSubmit={commerce.handleBroadcastSubmit}
        />
      </Suspense>
    );
  }

  return null;
}
